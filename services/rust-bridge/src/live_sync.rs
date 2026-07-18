use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use tokio::fs;

use crate::read_non_empty_env;

const ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES: usize = 64;
pub(crate) const ROLLOUT_LIVE_SYNC_MAX_FILE_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 2);

pub(crate) fn resolve_codex_sessions_root() -> Option<PathBuf> {
    if let Some(codex_home) = read_non_empty_env("CODEX_HOME") {
        let root = PathBuf::from(codex_home).join("sessions");
        if root.is_dir() {
            return Some(root);
        }
    }

    let home = read_non_empty_env("HOME")?;
    let root = PathBuf::from(home).join(".codex").join("sessions");
    root.is_dir().then_some(root)
}

pub(crate) async fn discover_recent_rollout_files(
    root: &Path,
) -> Result<Vec<PathBuf>, std::io::Error> {
    let now = SystemTime::now();
    let mut stack = vec![root.to_path_buf()];
    let mut matches = Vec::<(PathBuf, SystemTime)>::new();

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() || !is_rollout_file_path(&path) {
                continue;
            }

            let modified = metadata.modified().unwrap_or(now);
            if now
                .duration_since(modified)
                .unwrap_or_else(|_| Duration::from_secs(0))
                > ROLLOUT_LIVE_SYNC_MAX_FILE_AGE
            {
                continue;
            }
            matches.push((path, modified));
        }
    }

    matches.sort_by(|left, right| right.1.cmp(&left.1));
    matches.truncate(ROLLOUT_LIVE_SYNC_MAX_TRACKED_FILES);
    Ok(matches.into_iter().map(|(path, _)| path).collect())
}

fn is_rollout_file_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

pub(crate) fn hash_rollout_line(line: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

pub(crate) fn should_run_rollout_discovery_tick(tick: u64, interval_ticks: u64) -> bool {
    interval_ticks <= 1 || tick == 1 || tick % interval_ticks == 0
}

pub(crate) fn rollout_originator_allowed(originator: Option<&str>) -> bool {
    match originator {
        Some(value) => {
            let normalized = value.to_ascii_lowercase();
            normalized.contains("codex") || normalized.contains("clawdex")
        }
        None => true,
    }
}
