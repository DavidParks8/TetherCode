use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    decode_engine_qualified_id, path_policy::PathPolicy, resource_limits::ATTACHMENT_MAX_BYTES,
    storage::write_private_new, BridgeError,
};

const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentUploadRequest {
    pub(crate) data_base64: String,
    pub(crate) file_name: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentUploadResponse {
    path: String,
    file_name: String,
    mime_type: Option<String>,
    size_bytes: usize,
    kind: String,
}

pub(crate) async fn save_uploaded_attachment(
    request: AttachmentUploadRequest,
    path_policy: &PathPolicy,
) -> Result<AttachmentUploadResponse, BridgeError> {
    let encoded = request.data_base64.trim();
    if encoded.is_empty() {
        return Err(BridgeError::invalid_params("dataBase64 must not be empty"));
    }

    let estimated_size = estimate_base64_decoded_size(encoded)?;
    if estimated_size > ATTACHMENT_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "attachment_bytes",
            ATTACHMENT_MAX_BYTES,
            estimated_size,
        ));
    }

    let bytes = decode_base64_payload(encoded)?;
    if bytes.is_empty() {
        return Err(BridgeError::invalid_params("attachment payload is empty"));
    }

    if bytes.len() > ATTACHMENT_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "attachment_bytes",
            ATTACHMENT_MAX_BYTES,
            bytes.len(),
        ));
    }

    let normalized_kind =
        normalize_attachment_kind(request.kind.as_deref(), request.mime_type.as_deref());
    let file_name = build_attachment_file_name(
        request.file_name.as_deref(),
        request.mime_type.as_deref(),
        normalized_kind,
    );

    let mut attachment_relative = PathBuf::from(MOBILE_ATTACHMENTS_DIR);
    if let Some(thread_id) = request.thread_id.as_deref() {
        let normalized_thread = sanitize_path_segment(&decode_engine_qualified_id(thread_id));
        if !normalized_thread.is_empty() {
            attachment_relative = attachment_relative.join(normalized_thread);
        }
    }

    let attachment_dir = path_policy.resolve_root_owned_directory(&attachment_relative)?;

    let unique_name = format!("{}-{file_name}", Uuid::new_v4());
    let target_path = attachment_dir.join(unique_name);

    write_private_new(&target_path, &bytes)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to persist attachment: {error}")))?;

    Ok(AttachmentUploadResponse {
        path: target_path.to_string_lossy().to_string(),
        file_name,
        mime_type: request
            .mime_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        size_bytes: bytes.len(),
        kind: normalized_kind.to_string(),
    })
}

fn extract_base64_payload(raw: &str) -> Result<&str, BridgeError> {
    let payload = raw
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(raw)
        .trim();
    if payload.is_empty() {
        return Err(BridgeError::invalid_params(
            "dataBase64 must contain base64 payload",
        ));
    }
    Ok(payload)
}

pub(crate) fn estimate_base64_decoded_size(raw: &str) -> Result<usize, BridgeError> {
    let payload = extract_base64_payload(raw)?;
    let encoded_len = payload.len();
    let padding = payload
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);
    let block_count = (encoded_len + 3) / 4;
    Ok(block_count.saturating_mul(3).saturating_sub(padding))
}

pub(crate) fn decode_base64_payload(raw: &str) -> Result<Vec<u8>, BridgeError> {
    let payload = extract_base64_payload(raw)?;
    general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE.decode(payload))
        .map_err(|error| {
            BridgeError::invalid_params(&format!("invalid base64 attachment payload: {error}"))
        })
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
        estimate_base64_decoded_size, save_uploaded_attachment, AttachmentUploadRequest,
        MOBILE_ATTACHMENTS_DIR,
    };
    use crate::path_policy::PathPolicy;
    use crate::resource_limits::ATTACHMENT_MAX_BYTES;
    use base64::{engine::general_purpose, Engine as _};
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

    fn upload_request() -> AttachmentUploadRequest {
        AttachmentUploadRequest {
            data_base64: general_purpose::STANDARD.encode(b"attachment contents"),
            file_name: Some("note.txt".to_string()),
            mime_type: Some("text/plain".to_string()),
            thread_id: Some("codex:thread/one".to_string()),
            kind: Some("file".to_string()),
        }
    }

    #[test]
    fn base64_estimate_distinguishes_exact_and_over_limit_boundaries() {
        let exact_encoded_len = ATTACHMENT_MAX_BYTES.div_ceil(3) * 4;
        let exact_padding = (3 - ATTACHMENT_MAX_BYTES % 3) % 3;
        let mut exact = "A".repeat(exact_encoded_len);
        for index in 0..exact_padding {
            exact.replace_range(exact.len() - index - 1..exact.len() - index, "=");
        }
        assert_eq!(
            estimate_base64_decoded_size(&exact).unwrap(),
            ATTACHMENT_MAX_BYTES
        );
        assert!(estimate_base64_decoded_size(&(exact + "AAAA")).unwrap() > ATTACHMENT_MAX_BYTES);
    }

    #[tokio::test]
    async fn upload_stays_in_canonical_root_owned_storage() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).expect("create root");
        let policy = PathPolicy::new(root.clone(), true).expect("create policy");

        let uploaded = save_uploaded_attachment(upload_request(), &policy)
            .await
            .expect("save attachment");
        let canonical = fs::canonicalize(uploaded.path).expect("canonical uploaded path");
        assert!(canonical.starts_with(fs::canonicalize(root).expect("canonical root")));
        assert_eq!(
            fs::read(canonical).expect("read attachment"),
            b"attachment contents"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn upload_rejects_attachment_directory_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        symlink(&outside, root.join(MOBILE_ATTACHMENTS_DIR)).expect("create attachment symlink");
        let policy = PathPolicy::new(root, true).expect("create policy");

        let error = save_uploaded_attachment(upload_request(), &policy)
            .await
            .expect_err("reject attachment symlink escape");
        assert_eq!(error.code, -32602);
        assert!(fs::read_dir(outside)
            .expect("read outside")
            .next()
            .is_none());
    }
}
