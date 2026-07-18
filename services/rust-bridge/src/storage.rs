use std::path::Path;

use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

fn private_open_options(create_new: bool) -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).create_new(create_new);
    if !create_new {
        options.truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    options
}

pub(crate) async fn write_private_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = private_open_options(true).open(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await
}

pub(crate) async fn atomic_write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "storage path has no parent",
        )
    })?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = async {
        write_private_new(&temporary, bytes).await?;
        fs::rename(&temporary, path).await?;
        #[cfg(unix)]
        fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{atomic_write_private, write_private_new};
    use std::fs;
    use uuid::Uuid;

    #[tokio::test]
    async fn private_new_is_collision_safe_and_atomic_write_replaces() {
        let dir = std::env::temp_dir().join(format!("clawdex-storage-{}", Uuid::new_v4()));
        fs::create_dir(&dir).expect("create test directory");
        let path = dir.join("state.json");
        write_private_new(&path, b"one")
            .await
            .expect("initial write");
        assert!(write_private_new(&path, b"collision").await.is_err());
        atomic_write_private(&path, b"two")
            .await
            .expect("atomic replace");
        assert_eq!(fs::read(&path).expect("read state"), b"two");
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&path).unwrap().permissions())
                & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(dir);
    }
}
