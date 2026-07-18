use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::{decode_engine_qualified_id, normalize_path, BridgeError};

const MOBILE_ATTACHMENTS_DIR: &str = ".clawdex-mobile-attachments";
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

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
    workdir: &Path,
) -> Result<AttachmentUploadResponse, BridgeError> {
    let encoded = request.data_base64.trim();
    if encoded.is_empty() {
        return Err(BridgeError::invalid_params("dataBase64 must not be empty"));
    }

    let estimated_size = estimate_base64_decoded_size(encoded)?;
    if estimated_size > MAX_ATTACHMENT_BYTES {
        return Err(BridgeError::invalid_params(&format!(
            "attachment exceeds max size of {MAX_ATTACHMENT_BYTES} bytes"
        )));
    }

    let bytes = decode_base64_payload(encoded)?;
    if bytes.is_empty() {
        return Err(BridgeError::invalid_params("attachment payload is empty"));
    }

    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(BridgeError::invalid_params(&format!(
            "attachment exceeds max size of {MAX_ATTACHMENT_BYTES} bytes"
        )));
    }

    let normalized_kind =
        normalize_attachment_kind(request.kind.as_deref(), request.mime_type.as_deref());
    let file_name = build_attachment_file_name(
        request.file_name.as_deref(),
        request.mime_type.as_deref(),
        normalized_kind,
    );

    let mut attachment_dir = workdir.join(MOBILE_ATTACHMENTS_DIR);
    if let Some(thread_id) = request.thread_id.as_deref() {
        let normalized_thread = sanitize_path_segment(&decode_engine_qualified_id(thread_id));
        if !normalized_thread.is_empty() {
            attachment_dir = attachment_dir.join(normalized_thread);
        }
    }

    fs::create_dir_all(&attachment_dir).await.map_err(|error| {
        BridgeError::server(&format!("failed to create attachment directory: {error}"))
    })?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let unique_name = format!("{timestamp}-{}-{file_name}", std::process::id());
    let target_path = attachment_dir.join(unique_name);
    let normalized_target = normalize_path(&target_path);
    if !normalized_target.starts_with(workdir) {
        return Err(BridgeError::invalid_params(
            "attachment path must stay within BRIDGE_WORKDIR",
        ));
    }

    fs::write(&normalized_target, &bytes)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to persist attachment: {error}")))?;

    Ok(AttachmentUploadResponse {
        path: normalized_target.to_string_lossy().to_string(),
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

pub(crate) fn resolve_local_image_path(raw_path: &str) -> Result<PathBuf, &'static str> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Image path is required");
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Image path must be absolute");
    }
    Ok(normalize_path(&path))
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
