use std::path::Path;

#[cfg(test)]
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

#[cfg(test)]
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

#[cfg(test)]
pub(crate) async fn write_private_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = private_open_options(true).open(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await
}

pub(crate) async fn atomic_write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    atomic_write_private_with(path, bytes, |_| Ok(()), |_| Ok(())).await
}

async fn atomic_write_private_with<BeforePublish, BeforeParentSync>(
    path: &Path,
    bytes: &[u8],
    before_publish: BeforePublish,
    before_parent_sync: BeforeParentSync,
) -> std::io::Result<()>
where
    BeforePublish: FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
    BeforeParentSync: FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
{
    let parent = path
        .parent()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "storage path has no parent",
            )
        })?
        .to_path_buf();
    let file_name = path
        .file_name()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "storage path has no file name",
            )
        })?
        .to_os_string();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        atomic_write_private_blocking(
            &parent,
            &file_name,
            &bytes,
            before_publish,
            before_parent_sync,
        )
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(unix)]
fn atomic_write_private_blocking<BeforePublish, BeforeParentSync>(
    parent: &Path,
    file_name: &std::ffi::OsStr,
    bytes: &[u8],
    before_publish: BeforePublish,
    before_parent_sync: BeforeParentSync,
) -> std::io::Result<()>
where
    BeforePublish: FnOnce(&Path) -> std::io::Result<()>,
    BeforeParentSync: FnOnce(&Path) -> std::io::Result<()>,
{
    use rustix::fs::{open, openat, renameat, unlinkat, AtFlags, Mode, OFlags};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let parent_fd = open(
        parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )?;
    let parent_file = std::fs::File::from(parent_fd);
    let temporary_name = format!(".{}.{}.tmp", file_name.to_string_lossy(), Uuid::new_v4());
    let temporary_path = parent.join(&temporary_name);
    let result = (|| {
        let temporary_fd = openat(
            &parent_file,
            &temporary_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        let mut temporary_file = std::fs::File::from(temporary_fd);
        temporary_file.write_all(bytes)?;
        temporary_file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        before_publish(&temporary_path)?;
        temporary_file.sync_all()?;
        renameat(&parent_file, &temporary_name, &parent_file, file_name)?;
        before_parent_sync(parent)?;
        parent_file.sync_all()
    })();
    if result.is_err() {
        let _ = unlinkat(&parent_file, &temporary_name, AtFlags::empty());
    }
    result
}

#[cfg(not(unix))]
fn atomic_write_private_blocking<BeforePublish, BeforeParentSync>(
    parent: &Path,
    file_name: &std::ffi::OsStr,
    bytes: &[u8],
    before_publish: BeforePublish,
    before_parent_sync: BeforeParentSync,
) -> std::io::Result<()>
where
    BeforePublish: FnOnce(&Path) -> std::io::Result<()>,
    BeforeParentSync: FnOnce(&Path) -> std::io::Result<()>,
{
    use std::io::Write;

    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        before_publish(&temporary)?;
        file.sync_all()?;
        std::fs::rename(&temporary, parent.join(file_name))?;
        before_parent_sync(parent)?;
        std::fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{
        atomic_write_private, atomic_write_private_with, private_open_options, write_private_new,
    };
    use std::fs;
    use uuid::Uuid;

    #[tokio::test]
    async fn private_new_is_collision_safe_and_atomic_write_replaces() {
        let dir = std::env::temp_dir().join(format!("tethercode-storage-{}", Uuid::new_v4()));
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

    #[tokio::test]
    async fn truncate_mode_replaces_contents_and_failed_atomic_write_cleans_up() {
        let dir =
            std::env::temp_dir().join(format!("tethercode-storage-errors-{}", Uuid::new_v4()));
        fs::create_dir(&dir).expect("create test directory");
        let path = dir.join("state");
        fs::write(&path, b"long contents").expect("seed file");
        let mut file = private_open_options(false)
            .open(&path)
            .await
            .expect("open truncate mode");
        use tokio::io::AsyncWriteExt;
        file.write_all(b"x").await.expect("write replacement");
        file.sync_all().await.expect("sync replacement");
        drop(file);
        assert_eq!(fs::read(&path).unwrap(), b"x");

        let missing_parent = dir.join("missing").join("state");
        assert!(atomic_write_private(&missing_parent, b"value")
            .await
            .is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn atomic_write_secures_before_publish_and_propagates_parent_sync_failure() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("tethercode-storage-durable-{}", Uuid::new_v4()));
        fs::create_dir(&dir).expect("create test directory");
        let path = dir.join("state.json");
        fs::write(&path, b"old").expect("seed state");
        atomic_write_private_with(
            &path,
            b"new",
            |temporary| {
                assert_eq!(fs::metadata(temporary)?.permissions().mode() & 0o777, 0o600);
                Ok(())
            },
            |_| Err(std::io::Error::other("injected parent sync failure")),
        )
        .await
        .expect_err("parent sync failure must propagate");
        assert_eq!(fs::read(&path).expect("reopen replacement"), b"new");
        assert_eq!(
            fs::read_dir(&dir)
                .expect("list storage directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        let _ = fs::remove_dir_all(dir);
    }
}
