use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::{os::fd::OwnedFd, sync::Arc};

#[cfg(unix)]
use rustix::fs::{self as unix_fs, Mode, OFlags};

use crate::BridgeError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathKind {
    Any,
    Directory,
    File,
}

#[derive(Debug, Clone)]
pub(crate) struct PathPolicy {
    root: PathBuf,
    allow_outside_root: bool,
    #[cfg(unix)]
    root_fd: Arc<OwnedFd>,
}

#[derive(Debug)]
pub(crate) struct SecureDirectory {
    #[cfg(unix)]
    fd: OwnedFd,
}

impl SecureDirectory {
    pub(crate) fn create_file(&self, name: &str) -> Result<std::fs::File, BridgeError> {
        #[cfg(not(unix))]
        {
            let _ = name;
            return Err(BridgeError::server(
                "secure attachment storage is unavailable on this platform",
            ));
        }
        #[cfg(unix)]
        {
            validate_child_name(name)?;
            let fd = unix_fs::openat(
                &self.fd,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|error| {
                BridgeError::server(&format!("failed to create secure file: {error}"))
            })?;
            Ok(fd.into())
        }
    }

    pub(crate) fn rename_to(
        &self,
        source_name: &str,
        target: &Self,
        target_name: &str,
    ) -> Result<(), BridgeError> {
        #[cfg(not(unix))]
        {
            let _ = (source_name, target, target_name);
            return Err(BridgeError::server(
                "secure attachment storage is unavailable on this platform",
            ));
        }
        #[cfg(unix)]
        {
            validate_child_name(source_name)?;
            validate_child_name(target_name)?;
            unix_fs::renameat(&self.fd, source_name, &target.fd, target_name).map_err(|error| {
                BridgeError::server(&format!("failed to finalize secure file: {error}"))
            })?;
            unix_fs::fsync(&self.fd).map_err(|error| {
                BridgeError::server(&format!("failed to sync staging directory: {error}"))
            })?;
            unix_fs::fsync(&target.fd).map_err(|error| {
                BridgeError::server(&format!("failed to sync secure directory: {error}"))
            })?;
            Ok(())
        }
    }

    pub(crate) fn remove_file(&self, name: &str) {
        #[cfg(not(unix))]
        let _ = name;
        #[cfg(unix)]
        if validate_child_name(name).is_ok() {
            let _ = unix_fs::unlinkat(&self.fd, name, unix_fs::AtFlags::empty());
        }
    }
}

impl PathPolicy {
    pub(crate) fn new(root: PathBuf, allow_outside_root: bool) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err(format!(
                "BRIDGE_WORKDIR must be an absolute path (got: {})",
                root.to_string_lossy()
            ));
        }
        let root = std::fs::canonicalize(&root).map_err(|error| {
            format!(
                "BRIDGE_WORKDIR is invalid or inaccessible ({}): {error}",
                root.to_string_lossy()
            )
        })?;
        if !root.is_dir() {
            return Err(format!(
                "BRIDGE_WORKDIR must point to a directory (got: {})",
                root.to_string_lossy()
            ));
        }
        #[cfg(unix)]
        let root_fd = unix_fs::open(
            &root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("failed to retain BRIDGE_WORKDIR descriptor: {error}"))?;
        Ok(Self {
            root,
            allow_outside_root,
            #[cfg(unix)]
            root_fd: Arc::new(root_fd),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn resolve_cwd(&self, raw: Option<&str>) -> Result<PathBuf, BridgeError> {
        let raw = raw.map(str::trim).filter(|value| !value.is_empty());
        self.resolve_existing_from(self.root(), raw.unwrap_or("."), PathKind::Directory)
    }

    pub(crate) fn resolve_existing(
        &self,
        raw: &str,
        kind: PathKind,
    ) -> Result<PathBuf, BridgeError> {
        self.resolve_existing_from(self.root(), raw, kind)
    }

    pub(crate) fn resolve_existing_from(
        &self,
        base: &Path,
        raw: &str,
        kind: PathKind,
    ) -> Result<PathBuf, BridgeError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(BridgeError::invalid_params("path must not be empty"));
        }
        let requested = PathBuf::from(trimmed);
        let candidate = if requested.is_absolute() {
            requested
        } else {
            base.join(requested)
        };
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "path is invalid or inaccessible ({}): {error}",
                candidate.to_string_lossy()
            ))
        })?;
        self.enforce_scope(&canonical, false)?;

        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "failed to inspect path ({}): {error}",
                canonical.to_string_lossy()
            ))
        })?;
        let valid_kind = match kind {
            PathKind::Any => true,
            PathKind::Directory => metadata.is_dir(),
            PathKind::File => metadata.is_file(),
        };
        if !valid_kind {
            let expected = match kind {
                PathKind::Any => unreachable!("existing paths satisfy PathKind::Any"),
                PathKind::Directory => "a directory",
                PathKind::File => "a file",
            };
            return Err(BridgeError::invalid_params(&format!(
                "path must point to {expected}"
            )));
        }
        Ok(canonical)
    }

    #[cfg(test)]
    pub(crate) fn resolve_root_owned_directory(
        &self,
        relative: &Path,
    ) -> Result<PathBuf, BridgeError> {
        let target = self.resolve_root_owned_target(relative)?;
        std::fs::create_dir_all(&target).map_err(|error| {
            BridgeError::server(&format!("failed to create root-owned directory: {error}"))
        })?;
        let canonical = std::fs::canonicalize(&target).map_err(|error| {
            BridgeError::server(&format!("failed to resolve root-owned directory: {error}"))
        })?;
        self.enforce_scope(&canonical, true)?;
        if !canonical.is_dir() {
            return Err(BridgeError::invalid_params(
                "root-owned path must point to a directory",
            ));
        }
        Ok(canonical)
    }

    #[cfg(test)]
    pub(crate) fn resolve_root_owned_target(
        &self,
        relative: &Path,
    ) -> Result<PathBuf, BridgeError> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(BridgeError::invalid_params(
                "root-owned path must be a relative child path",
            ));
        }

        let target = self.root.join(relative);
        let mut ancestor = target.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| {
                BridgeError::invalid_params("root-owned path has no existing ancestor")
            })?;
        }
        let canonical_ancestor = std::fs::canonicalize(ancestor).map_err(|error| {
            BridgeError::invalid_params(&format!(
                "root-owned path is invalid or inaccessible: {error}"
            ))
        })?;
        self.enforce_scope(&canonical_ancestor, true)?;
        let suffix = target
            .strip_prefix(ancestor)
            .map_err(|_| BridgeError::invalid_params("failed to resolve root-owned path suffix"))?;
        Ok(canonical_ancestor.join(suffix))
    }

    #[cfg(unix)]
    pub(crate) fn open_regular_file_beneath(
        &self,
        raw: &str,
    ) -> Result<(std::fs::File, PathBuf), BridgeError> {
        self.open_regular_file_beneath_with(raw, || {})
    }

    #[cfg(unix)]
    fn open_regular_file_beneath_with(
        &self,
        raw: &str,
        before_final_open: impl FnOnce(),
    ) -> Result<(std::fs::File, PathBuf), BridgeError> {
        let relative = self.secure_relative_path(raw)?;
        let mut components = relative.components().peekable();
        let mut directory = rustix::io::dup(&*self.root_fd).map_err(|error| {
            BridgeError::server(&format!("failed to duplicate root descriptor: {error}"))
        })?;
        let mut final_name = None;
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                return Err(BridgeError::invalid_params(
                    "path must stay beneath BRIDGE_WORKDIR",
                ));
            };
            if components.peek().is_none() {
                final_name = Some(name.to_os_string());
                break;
            }
            directory = unix_fs::openat(
                &directory,
                name,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| {
                BridgeError::invalid_params(&format!(
                    "path component is unsafe or inaccessible: {error}"
                ))
            })?;
        }
        let final_name =
            final_name.ok_or_else(|| BridgeError::invalid_params("path must point to a file"))?;
        before_final_open();
        let fd = unix_fs::openat(
            &directory,
            &final_name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| {
            BridgeError::invalid_params(&format!("file is unsafe or inaccessible: {error}"))
        })?;
        let file: std::fs::File = fd.into();
        let metadata = file.metadata().map_err(|error| {
            BridgeError::invalid_params(&format!("failed to inspect opened file: {error}"))
        })?;
        if !metadata.is_file() {
            return Err(BridgeError::invalid_params(
                "path must point to a regular file",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(BridgeError::invalid_params(
                    "hard-linked files are not permitted",
                ));
            }
        }
        Ok((file, self.root.join(relative)))
    }

    #[cfg(not(unix))]
    pub(crate) fn open_regular_file_beneath(
        &self,
        _raw: &str,
    ) -> Result<(std::fs::File, PathBuf), BridgeError> {
        Err(BridgeError::server(
            "secure local file access is unavailable on this platform",
        ))
    }

    #[cfg(unix)]
    pub(crate) fn secure_root_owned_directory(
        &self,
        relative: &Path,
    ) -> Result<SecureDirectory, BridgeError> {
        validate_relative_components(relative)?;
        let mut directory = rustix::io::dup(&*self.root_fd).map_err(|error| {
            BridgeError::server(&format!("failed to duplicate root descriptor: {error}"))
        })?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                unreachable!()
            };
            match unix_fs::mkdirat(&directory, name, Mode::from_raw_mode(0o700)) {
                Ok(()) => unix_fs::fsync(&directory).map_err(|error| {
                    BridgeError::server(&format!("failed to sync secure parent directory: {error}"))
                })?,
                Err(rustix::io::Errno::EXIST) => {}
                Err(error) => {
                    return Err(BridgeError::server(&format!(
                        "failed to create secure directory: {error}"
                    )))
                }
            }
            directory = unix_fs::openat(
                &directory,
                name,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| {
                BridgeError::invalid_params(&format!("directory component is unsafe: {error}"))
            })?;
            unix_fs::fchmod(&directory, Mode::from_raw_mode(0o700)).map_err(|error| {
                BridgeError::server(&format!("failed to secure directory permissions: {error}"))
            })?;
        }
        Ok(SecureDirectory { fd: directory })
    }

    #[cfg(unix)]
    pub(crate) fn rename_root_owned_file(
        &self,
        source: &SecureDirectory,
        source_name: &str,
        target_relative: &Path,
        target_name: &str,
    ) -> Result<PathBuf, BridgeError> {
        self.rename_root_owned_file_with(source, source_name, target_relative, target_name, || {})
    }

    #[cfg(unix)]
    fn rename_root_owned_file_with(
        &self,
        source: &SecureDirectory,
        source_name: &str,
        target_relative: &Path,
        target_name: &str,
        before_target_open: impl FnOnce(),
    ) -> Result<PathBuf, BridgeError> {
        before_target_open();
        let target = self.secure_root_owned_directory(target_relative)?;
        source.rename_to(source_name, &target, target_name)?;
        Ok(self.root.join(target_relative).join(target_name))
    }

    #[cfg(not(unix))]
    pub(crate) fn secure_root_owned_directory(
        &self,
        _relative: &Path,
    ) -> Result<SecureDirectory, BridgeError> {
        Err(BridgeError::server(
            "secure attachment storage is unavailable on this platform",
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn rename_root_owned_file(
        &self,
        _source: &SecureDirectory,
        _source_name: &str,
        _target_relative: &Path,
        _target_name: &str,
    ) -> Result<PathBuf, BridgeError> {
        Err(BridgeError::server(
            "secure attachment storage is unavailable on this platform",
        ))
    }

    fn secure_relative_path(&self, raw: &str) -> Result<PathBuf, BridgeError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(BridgeError::invalid_params("path must not be empty"));
        }
        let requested = Path::new(trimmed);
        let relative = if requested.is_absolute() {
            requested
                .strip_prefix(&self.root)
                .map_err(|_| BridgeError::invalid_params("path must stay beneath BRIDGE_WORKDIR"))?
        } else {
            requested
        };
        validate_relative_components(relative)?;
        Ok(relative.to_path_buf())
    }

    pub(crate) fn parent_for_browsing(&self, path: &Path) -> Option<PathBuf> {
        if !self.allow_outside_root && path == self.root {
            return None;
        }
        path.parent().map(Path::to_path_buf)
    }

    fn enforce_scope(&self, canonical: &Path, root_owned: bool) -> Result<(), BridgeError> {
        if (root_owned || !self.allow_outside_root) && !canonical.starts_with(&self.root) {
            return Err(BridgeError::invalid_params(
                "path must stay within BRIDGE_WORKDIR",
            ));
        }
        Ok(())
    }
}

fn validate_relative_components(path: &Path) -> Result<(), BridgeError> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BridgeError::invalid_params(
            "path must be a relative child beneath BRIDGE_WORKDIR",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_child_name(name: &str) -> Result<(), BridgeError> {
    validate_relative_components(Path::new(name))?;
    if Path::new(name).components().count() != 1 {
        return Err(BridgeError::invalid_params(
            "file name must be one path component",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{PathKind, PathPolicy};
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("tethercode-path-policy-{}", Uuid::new_v4()));
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
    fn canonicalizes_relative_and_absolute_existing_paths() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested directory");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");

        assert_eq!(
            policy
                .resolve_existing("nested/.", PathKind::Directory)
                .expect("resolve relative path"),
            fs::canonicalize(&nested).expect("canonical nested path")
        );
        assert_eq!(
            policy
                .resolve_existing(nested.to_str().expect("utf-8 path"), PathKind::Directory)
                .expect("resolve absolute path"),
            fs::canonicalize(&nested).expect("canonical nested path")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_when_outside_root_is_disabled() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, root.join("escape")).expect("create escape symlink");
        let policy = PathPolicy::new(root, false).expect("create policy");

        let error = policy
            .resolve_cwd(Some("escape"))
            .expect_err("reject symlink escape");
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("BRIDGE_WORKDIR"));
    }

    #[cfg(unix)]
    #[test]
    fn allows_canonical_outside_path_only_when_configured() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, root.join("escape")).expect("create escape symlink");
        let policy = PathPolicy::new(root, true).expect("create policy");

        assert_eq!(
            policy.resolve_cwd(Some("escape")).expect("allow outside"),
            fs::canonicalize(outside).expect("canonical outside")
        );
    }

    #[cfg(unix)]
    #[test]
    fn root_owned_storage_rejects_symlink_even_when_outside_is_allowed() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, root.join("attachments")).expect("create escape symlink");
        let policy = PathPolicy::new(root, true).expect("create policy");

        let error = policy
            .resolve_root_owned_directory(PathBuf::from("attachments/thread").as_path())
            .expect_err("reject root-owned symlink escape");
        assert_eq!(error.code, -32602);
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_open_rejects_final_component_symlink_swap() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside.txt");
        fs::create_dir_all(root.join("images")).expect("create image directory");
        fs::write(root.join("images/image.png"), b"inside").expect("write inside image");
        fs::write(&outside, b"outside-secret").expect("write outside file");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");

        let error = policy
            .open_regular_file_beneath_with("images/image.png", || {
                fs::remove_file(root.join("images/image.png")).expect("remove inside image");
                symlink(&outside, root.join("images/image.png")).expect("swap image to symlink");
            })
            .expect_err("reject swapped symlink");

        assert_eq!(error.code, -32602);
    }

    #[cfg(unix)]
    #[test]
    fn retained_directories_prevent_attachment_rename_escape() {
        use std::io::Write;
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");
        let staging = policy
            .secure_root_owned_directory(PathBuf::from("attachments/.tmp").as_path())
            .expect("open staging directory");
        policy
            .secure_root_owned_directory(PathBuf::from("attachments/thread").as_path())
            .expect("open target directory");
        staging
            .create_file("upload.tmp")
            .expect("create staged file")
            .write_all(b"inside")
            .expect("write staged file");

        let detached = outside.join("detached-thread");
        let error = policy
            .rename_root_owned_file_with(
                &staging,
                "upload.tmp",
                PathBuf::from("attachments/thread").as_path(),
                "saved.txt",
                || {
                    fs::rename(root.join("attachments/thread"), &detached)
                        .expect("move target outside root");
                    symlink(&outside, root.join("attachments/thread"))
                        .expect("swap target to symlink");
                },
            )
            .expect_err("reject swapped target directory");

        assert_eq!(error.code, -32602);
        assert!(!outside.join("saved.txt").exists());
        assert!(!detached.join("saved.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_api_covers_valid_invalid_and_cleanup_paths() {
        use std::io::{Read, Write};

        let temp = TestDir::new();
        let root = temp.0.join("root");
        fs::create_dir_all(root.join("images")).expect("create image directory");
        fs::write(root.join("images/image.png"), b"image").expect("write image");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");

        for requested in [
            "images/image.png".to_string(),
            policy
                .root()
                .join("images/image.png")
                .to_string_lossy()
                .to_string(),
        ] {
            let (mut file, path) = policy
                .open_regular_file_beneath(&requested)
                .expect("open secure image");
            let mut contents = Vec::new();
            file.read_to_end(&mut contents).expect("read secure image");
            assert_eq!(contents, b"image");
            assert_eq!(path, policy.root().join("images/image.png"));
        }

        for requested in ["", ".", "../outside", "/tmp/outside", "images"] {
            assert!(
                policy.open_regular_file_beneath(requested).is_err(),
                "accepted {requested:?}"
            );
        }

        fs::hard_link(
            root.join("images/image.png"),
            root.join("images/image-hardlink.png"),
        )
        .expect("create hardlink");
        assert!(policy
            .open_regular_file_beneath("images/image-hardlink.png")
            .is_err());

        for invalid in [PathBuf::new(), PathBuf::from("../bad"), root.clone()] {
            assert!(policy.secure_root_owned_directory(&invalid).is_err());
        }
        fs::write(root.join("blocked"), b"file").expect("write blocking file");
        assert!(policy
            .secure_root_owned_directory(PathBuf::from("blocked/child").as_path())
            .is_err());

        let staging = policy
            .secure_root_owned_directory(PathBuf::from("storage/.tmp").as_path())
            .expect("create staging");
        policy
            .secure_root_owned_directory(PathBuf::from("storage/.tmp").as_path())
            .expect("reopen existing staging");
        for name in ["", "../bad", "nested/bad"] {
            assert!(staging.create_file(name).is_err(), "accepted {name:?}");
        }
        let mut staged = staging.create_file("upload.tmp").expect("create upload");
        staged.write_all(b"payload").expect("write upload");
        staged.sync_all().expect("sync upload");
        drop(staged);
        assert!(staging.create_file("upload.tmp").is_err());
        staging.remove_file("../ignored");

        let final_directory = policy
            .secure_root_owned_directory(PathBuf::from("storage/final").as_path())
            .expect("create final directory");
        assert!(staging
            .rename_to("../bad", &final_directory, "saved.txt")
            .is_err());
        assert!(staging
            .rename_to("upload.tmp", &final_directory, "nested/bad")
            .is_err());

        let saved = policy
            .rename_root_owned_file(
                &staging,
                "upload.tmp",
                PathBuf::from("storage/final").as_path(),
                "saved.txt",
            )
            .expect("finalize upload");
        assert_eq!(fs::read(saved).expect("read finalized upload"), b"payload");
        assert!(policy
            .rename_root_owned_file(
                &staging,
                "missing.tmp",
                PathBuf::from("storage/final").as_path(),
                "missing.txt",
            )
            .is_err());
        let cleanup = staging.create_file("cleanup.tmp").expect("create cleanup");
        drop(cleanup);
        staging.remove_file("cleanup.tmp");
        assert!(!root.join("storage/.tmp/cleanup.tmp").exists());
    }

    #[test]
    fn constructor_rejects_relative_missing_and_file_roots() {
        let temp = TestDir::new();
        assert!(PathPolicy::new(PathBuf::from("relative"), false).is_err());
        assert!(PathPolicy::new(temp.0.join("missing"), false).is_err());

        let file = temp.0.join("file");
        fs::write(&file, b"contents").expect("write root file");
        assert!(PathPolicy::new(file, false).is_err());
    }

    #[test]
    fn resolves_default_cwd_and_checks_all_path_kinds() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).expect("create root");
        let file = root.join("file.txt");
        fs::write(&file, b"contents").expect("write file");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");

        assert_eq!(
            policy.resolve_cwd(None).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            policy.resolve_cwd(Some("  ")).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert_eq!(
            policy.resolve_existing("file.txt", PathKind::Any).unwrap(),
            fs::canonicalize(&file).unwrap()
        );
        assert!(policy.resolve_existing("file.txt", PathKind::File).is_ok());
        assert!(policy
            .resolve_existing("file.txt", PathKind::Directory)
            .is_err());
        assert!(policy.resolve_existing(".", PathKind::File).is_err());
        assert!(policy.resolve_existing(" ", PathKind::Any).is_err());
        assert!(policy.resolve_existing("missing", PathKind::Any).is_err());
    }

    #[test]
    fn root_owned_targets_and_browsing_enforce_boundaries() {
        let temp = TestDir::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).expect("create root");
        let policy = PathPolicy::new(root.clone(), false).expect("create policy");

        assert!(policy.resolve_root_owned_target(&root).is_err());
        assert!(policy
            .resolve_root_owned_target(PathBuf::from("a/../b").as_path())
            .is_err());
        assert_eq!(
            policy
                .resolve_root_owned_target(PathBuf::from("a/b").as_path())
                .unwrap(),
            fs::canonicalize(&root).unwrap().join("a/b")
        );

        let file = root.join("owned-file");
        fs::write(&file, b"contents").expect("write owned file");
        assert!(policy
            .resolve_root_owned_directory(PathBuf::from("owned-file").as_path())
            .is_err());
        assert_eq!(policy.parent_for_browsing(policy.root()), None);
        assert_eq!(
            policy.parent_for_browsing(&policy.root().join("child")),
            Some(policy.root().to_path_buf())
        );

        let outside_policy = PathPolicy::new(root, true).expect("create outside policy");
        assert_eq!(
            outside_policy.parent_for_browsing(outside_policy.root()),
            outside_policy.root().parent().map(PathBuf::from)
        );
    }
}
