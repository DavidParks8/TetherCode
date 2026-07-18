use std::path::{Component, Path, PathBuf};

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
        Ok(Self {
            root,
            allow_outside_root,
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
                PathKind::Any => "an existing path",
                PathKind::Directory => "a directory",
                PathKind::File => "a file",
            };
            return Err(BridgeError::invalid_params(&format!(
                "path must point to {expected}"
            )));
        }
        Ok(canonical)
    }

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

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{PathKind, PathPolicy};
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("clawdex-path-policy-{}", Uuid::new_v4()));
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
