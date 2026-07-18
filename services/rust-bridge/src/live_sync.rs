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

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::{env, fs as std_fs};
    use uuid::Uuid;

    #[test]
    fn session_root_resolution_covers_preference_and_fallbacks() {
        let root = env::temp_dir().join(format!("clawdex-live-sync-{}", Uuid::new_v4()));
        let codex_sessions = root.join("codex").join("sessions");
        let home_sessions = root.join("home").join(".codex").join("sessions");
        std_fs::create_dir_all(&codex_sessions).unwrap();
        std_fs::create_dir_all(&home_sessions).unwrap();
        let previous_codex = env::var_os("CODEX_HOME");
        let previous_home = env::var_os("HOME");

        env::set_var("CODEX_HOME", root.join("codex"));
        env::set_var("HOME", root.join("home"));
        assert_eq!(resolve_codex_sessions_root(), Some(codex_sessions));
        env::set_var("CODEX_HOME", root.join("missing"));
        assert_eq!(resolve_codex_sessions_root(), Some(home_sessions));
        env::remove_var("CODEX_HOME");
        env::set_var("HOME", root.join("missing-home"));
        assert_eq!(resolve_codex_sessions_root(), None);
        env::remove_var("HOME");
        assert_eq!(resolve_codex_sessions_root(), None);

        match previous_codex {
            Some(value) => env::set_var("CODEX_HOME", value),
            None => env::remove_var("CODEX_HOME"),
        }
        match previous_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        let _ = std_fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn discovery_handles_missing_root_and_non_directory_errors() {
        let root = env::temp_dir().join(format!("clawdex-live-sync-{}", Uuid::new_v4()));
        assert!(discover_recent_rollout_files(&root)
            .await
            .unwrap()
            .is_empty());
        std_fs::write(&root, "not a directory").unwrap();
        assert!(discover_recent_rollout_files(&root).await.is_err());
        let _ = std_fs::remove_file(root);
    }
}
