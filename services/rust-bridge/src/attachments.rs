use std::path::{Path, PathBuf};

use axum::extract::Multipart;
use serde::Serialize;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

use crate::{
    decode_engine_qualified_id, path_policy::PathPolicy, resource_limits::ATTACHMENT_MAX_BYTES,
    BridgeError,
};

const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";
pub(crate) const ATTACHMENT_MULTIPART_MAX_BYTES: usize = ATTACHMENT_MAX_BYTES + 64 * 1024;
const ATTACHMENT_METADATA_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentUploadResponse {
    pub(crate) path: String,
    pub(crate) file_name: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) size_bytes: usize,
    pub(crate) kind: String,
}

pub(crate) async fn save_multipart_attachment(
    mut multipart: Multipart,
    path_policy: &PathPolicy,
) -> Result<AttachmentUploadResponse, BridgeError> {
    let temporary_dir = path_policy
        .resolve_root_owned_directory(&PathBuf::from(MOBILE_ATTACHMENTS_DIR).join(".tmp"))?;
    secure_directory(&temporary_dir).await?;
    let temporary_path = temporary_dir.join(format!("{}.upload", Uuid::new_v4()));
    let mut temporary_file: Option<fs::File> = None;
    let mut uploaded_size = 0usize;
    let mut field_file_name = None;
    let mut file_name = None;
    let mut mime_type = None;
    let mut thread_id = None;
    let mut kind = None;

    let result = async {
        while let Some(mut field) = multipart.next_field().await.map_err(|error| {
            BridgeError::invalid_params(&format!("invalid multipart upload: {error}"))
        })? {
            let name = field.name().unwrap_or_default().to_string();
            if name == "file" {
                if temporary_file.is_some() {
                    return Err(BridgeError::invalid_params(
                        "exactly one file field is required",
                    ));
                }
                field_file_name = field.file_name().map(str::to_string);
                mime_type = field.content_type().map(str::to_string);
                let mut file = private_new_file(&temporary_path).await?;
                while let Some(chunk) = field.chunk().await.map_err(|error| {
                    BridgeError::invalid_params(&format!("invalid file field: {error}"))
                })? {
                    append_bounded_chunk(&mut file, &mut uploaded_size, &chunk).await?;
                }
                temporary_file = Some(file);
                continue;
            }

            let value = read_bounded_text_field(&mut field).await?;
            match name.as_str() {
                "fileName" => file_name = non_empty(value),
                "mimeType" => mime_type = non_empty(value),
                "threadId" => thread_id = non_empty(value),
                "kind" => kind = non_empty(value),
                _ => return Err(BridgeError::invalid_params("unsupported multipart field")),
            }
        }

        let file = temporary_file
            .take()
            .ok_or_else(|| BridgeError::invalid_params("file field is required"))?;
        if uploaded_size == 0 {
            return Err(BridgeError::invalid_params("attachment payload is empty"));
        }
        file.sync_all()
            .await
            .map_err(|error| BridgeError::server(&format!("failed to sync attachment: {error}")))?;
        drop(file);

        let normalized_kind = normalize_attachment_kind(kind.as_deref(), mime_type.as_deref());
        let final_file_name = build_attachment_file_name(
            file_name.as_deref().or(field_file_name.as_deref()),
            mime_type.as_deref(),
            normalized_kind,
        );
        let mut attachment_relative = PathBuf::from(MOBILE_ATTACHMENTS_DIR);
        if let Some(thread_id) = thread_id.as_deref() {
            let normalized_thread = sanitize_path_segment(&decode_engine_qualified_id(thread_id));
            if !normalized_thread.is_empty() {
                attachment_relative = attachment_relative.join(normalized_thread);
            }
        }
        let attachment_dir = path_policy.resolve_root_owned_directory(&attachment_relative)?;
        let target_path = attachment_dir.join(format!("{}-{final_file_name}", Uuid::new_v4()));
        fs::rename(&temporary_path, &target_path)
            .await
            .map_err(|error| {
                BridgeError::server(&format!("failed to finalize attachment: {error}"))
            })?;

        Ok(AttachmentUploadResponse {
            path: target_path.to_string_lossy().to_string(),
            file_name: final_file_name,
            mime_type,
            size_bytes: uploaded_size,
            kind: normalized_kind.to_string(),
        })
    }
    .await;

    if result.is_err() {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path).await;
    }
    result
}

async fn private_new_file(path: &Path) -> Result<fs::File, BridgeError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await.map_err(|error| {
        BridgeError::server(&format!(
            "failed to create attachment staging file: {error}"
        ))
    })
}

async fn append_bounded_chunk(
    file: &mut fs::File,
    uploaded_size: &mut usize,
    chunk: &[u8],
) -> Result<(), BridgeError> {
    let next_size = uploaded_size.saturating_add(chunk.len());
    if next_size > ATTACHMENT_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "attachment_bytes",
            ATTACHMENT_MAX_BYTES,
            next_size,
        ));
    }
    file.write_all(chunk)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to stage attachment: {error}")))?;
    *uploaded_size = next_size;
    Ok(())
}

async fn secure_directory(path: &Path) -> Result<(), BridgeError> {
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .await
        .map_err(|error| {
            BridgeError::server(&format!(
                "failed to secure attachment staging directory: {error}"
            ))
        })?;
    Ok(())
}

async fn read_bounded_text_field(
    field: &mut axum::extract::multipart::Field<'_>,
) -> Result<String, BridgeError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|error| {
        BridgeError::invalid_params(&format!("invalid multipart field: {error}"))
    })? {
        if bytes.len().saturating_add(chunk.len()) > ATTACHMENT_METADATA_MAX_BYTES {
            return Err(BridgeError::resource_limit(
                "attachment_metadata_bytes",
                ATTACHMENT_METADATA_MAX_BYTES,
                bytes.len().saturating_add(chunk.len()),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| BridgeError::invalid_params("multipart metadata must be UTF-8"))
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn normalize_attachment_kind(
    kind: Option<&str>,
    mime_type: Option<&str>,
) -> &'static str {
    let normalized = kind
        .map(str::trim)
        .map(str::to_lowercase)
        .unwrap_or_default();
    if normalized == "image" {
        return "image";
    }
    if normalized == "file" {
        return "file";
    }
    if mime_type.is_some_and(|mime| mime.trim().to_ascii_lowercase().starts_with("image/")) {
        return "image";
    }
    "file"
}

pub(crate) fn build_attachment_file_name(
    raw_name: Option<&str>,
    raw_mime_type: Option<&str>,
    kind: &str,
) -> String {
    let requested_name = raw_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if kind == "image" {
                "image".to_string()
            } else {
                "attachment".to_string()
            }
        });
    let mut sanitized = sanitize_filename(&requested_name);
    if !sanitized.contains('.') {
        if let Some(extension) = infer_extension_from_mime(raw_mime_type) {
            sanitized.push('.');
            sanitized.push_str(extension);
        }
    }
    sanitized
}

pub(crate) fn sanitize_filename(value: &str) -> String {
    let basename = value
        .split(['/', '\\'])
        .filter(|segment| !segment.trim().is_empty())
        .next_back()
        .unwrap_or("attachment");
    let mut cleaned = basename
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    if cleaned.len() > 96 {
        cleaned.truncate(96);
    }
    cleaned
}

pub(crate) fn sanitize_path_segment(value: &str) -> String {
    let mut cleaned = value
        .trim()
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned = cleaned.trim_matches('_').to_string();
    if cleaned.len() > 64 {
        cleaned.truncate(64);
    }
    cleaned
}

pub(crate) fn infer_extension_from_mime(raw_mime_type: Option<&str>) -> Option<&'static str> {
    let mime = raw_mime_type?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "text/plain" => Some("txt"),
        "application/json" => Some("json"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

pub(crate) fn infer_image_content_type_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.trim().to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_bounded_chunk, build_attachment_file_name, normalize_attachment_kind,
        private_new_file, secure_directory, MOBILE_ATTACHMENTS_DIR,
    };
    use crate::path_policy::PathPolicy;
    use crate::resource_limits::ATTACHMENT_MAX_BYTES;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("clawdex-attachments-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn metadata_normalization_is_safe() {
        assert_eq!(normalize_attachment_kind(Some("image"), None), "image");
        assert_eq!(normalize_attachment_kind(None, Some("text/plain")), "file");
        assert_eq!(
            build_attachment_file_name(Some("../unsafe name"), Some("image/jpeg"), "image"),
            "unsafe_name.jpg"
        );
    }

    #[tokio::test]
    async fn staging_is_private_bounded_and_atomically_finalized() {
        let temp = TestDir::new();
        let staging_dir = temp.0.join("staging");
        fs::create_dir(&staging_dir).expect("create staging directory");
        secure_directory(&staging_dir)
            .await
            .expect("secure staging");
        let temporary_path = staging_dir.join("attachment.upload");
        let final_path = staging_dir.join("attachment.txt");
        let mut file = private_new_file(&temporary_path)
            .await
            .expect("create private file");
        let mut size = 0;
        append_bounded_chunk(&mut file, &mut size, &vec![0; ATTACHMENT_MAX_BYTES])
            .await
            .expect("accept exact limit");
        let error = append_bounded_chunk(&mut file, &mut size, &[1])
            .await
            .expect_err("reject over limit");
        assert_eq!(error.code, -32602);
        assert_eq!(size, ATTACHMENT_MAX_BYTES);
        file.sync_all().await.expect("sync staging file");
        drop(file);
        tokio::fs::rename(&temporary_path, &final_path)
            .await
            .expect("atomic finalization");
        assert!(!temporary_path.exists());
        assert_eq!(
            fs::metadata(&final_path).unwrap().len(),
            ATTACHMENT_MAX_BYTES as u64
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&staging_dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn staging_directory_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        symlink(&outside, root.join(MOBILE_ATTACHMENTS_DIR)).expect("create attachment symlink");
        let policy = PathPolicy::new(root, true).expect("create policy");

        let error = policy
            .resolve_root_owned_directory(&PathBuf::from(MOBILE_ATTACHMENTS_DIR).join(".tmp"))
            .expect_err("reject attachment symlink escape");
        assert_eq!(error.code, -32602);
        assert!(fs::read_dir(outside)
            .expect("read outside")
            .next()
            .is_none());
    }
}
