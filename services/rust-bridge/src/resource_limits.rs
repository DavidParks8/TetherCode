pub(crate) const ATTACHMENT_MAX_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const LOCAL_IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;

pub(crate) const GIT_DIFF_MAX_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const GIT_STATUS_MAX_BYTES: usize = 512 * 1024;
pub(crate) const GIT_STATUS_MAX_FILES: usize = 2_000;
pub(crate) const GIT_COMMAND_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub(crate) const PREVIEW_REQUEST_MAX_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const PREVIEW_BUFFERED_RESPONSE_MAX_BYTES: usize = 4 * 1024 * 1024;

pub(crate) const QUEUE_MAX_ITEMS_PER_THREAD: usize = 100;
pub(crate) const QUEUE_MAX_CONTENT_BYTES: usize = 64 * 1024;
pub(crate) const QUEUE_MAX_ITEM_BYTES: usize = 256 * 1024;
pub(crate) const QUEUE_MAX_BYTES_PER_THREAD: usize = 1024 * 1024;

pub(crate) const PUSH_REGISTRY_MAX_DEVICES: usize = 64;
pub(crate) const PUSH_TOKEN_MAX_BYTES: usize = 512;
pub(crate) const PUSH_ID_MAX_BYTES: usize = 128;
pub(crate) const PUSH_PLATFORM_MAX_BYTES: usize = 32;
pub(crate) const PUSH_DEVICE_NAME_MAX_BYTES: usize = 128;
pub(crate) const PUSH_REGISTRY_MAX_BYTES: usize = 128 * 1024;
pub(crate) const PUSH_PREVIEW_MAX_THREADS: usize = 256;
pub(crate) const PUSH_PREVIEW_MAX_BYTES: usize = 8_000;

pub(crate) const UI_SURFACE_MAX_BYTES: usize = 256 * 1024;
pub(crate) const UI_SURFACE_MAX_BLOCKS: usize = 50;
pub(crate) const UI_SURFACE_MAX_ACTIONS: usize = 20;
pub(crate) const UI_SURFACE_MAX_ITEMS_PER_BLOCK: usize = 100;
pub(crate) const UI_SURFACE_MAX_TEXT_BYTES: usize = 64 * 1024;

pub(crate) const NOTIFICATION_MAX_BYTES: usize = 256 * 1024;
pub(crate) const REPLAY_MAX_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const REPLAY_RESPONSE_MAX_BYTES: usize = 4 * 1024 * 1024;

pub(crate) const FILESYSTEM_LIST_MAX_ENTRIES: usize = 1_000;

pub(crate) fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut boundary = max_bytes.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    (value[..boundary].to_string(), true)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::truncate_utf8_bytes;

    #[test]
    fn truncates_at_utf8_boundary() {
        assert_eq!(truncate_utf8_bytes("é", 0), (String::new(), true));
        assert_eq!(truncate_utf8_bytes("é", 1), (String::new(), true));
        assert_eq!(truncate_utf8_bytes("aéz", 2), ("a".to_string(), true));
        assert_eq!(truncate_utf8_bytes("aéz", 3), ("aé".to_string(), true));
        assert_eq!(truncate_utf8_bytes("aéz", 4), ("aéz".to_string(), false));
    }
}
