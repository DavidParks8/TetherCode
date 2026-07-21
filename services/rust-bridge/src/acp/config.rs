use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use agent_client_protocol::{Client, ConnectTo, Lines};
use futures_util::{AsyncBufReadExt, AsyncWriteExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 16 * 1024;
const MAX_ENV: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 16 * 1024;
const MAX_AGENT_ID_LEN: usize = 128;
const MAX_TREE_ENTRIES: usize = 100_000;
const MAX_TREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES: usize = 4_096;
const MAX_TREE_RECEIPT_BYTES: usize = 32 * 1024 * 1024;
const HOST_ENV_ALLOWLIST: &[&str] = &["CODEX_PATH", "HOME", "PATH", "XDG_CONFIG_HOME"];
const SAFE_BASELINE_ENV: &[&str] = &["PATH", "HOME", "TMPDIR", "LANG"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RuntimeManifestError {
    #[error("agent ID is invalid")]
    InvalidAgentId,
    #[error("resolved executable path is invalid")]
    InvalidExecutable,
    #[error("resolved executable is outside an approved root")]
    ExecutableOutsideRoot,
    #[error("executable digest is invalid")]
    InvalidExecutableDigest,
    #[error("executable digest does not match the manifest")]
    ExecutableDigestMismatch,
    #[error("runtime integrity root is invalid")]
    InvalidIntegrityRoot,
    #[error("runtime installation tree digest is invalid")]
    InvalidTreeDigest,
    #[error("runtime installation tree does not match the manifest")]
    TreeDigestMismatch,
    #[error("argument {index} is invalid")]
    InvalidArgument { index: usize },
    #[error("environment entry {name} is invalid")]
    InvalidEnvironment { name: String },
    #[error("environment entry {name} is denied by the agent secret policy")]
    SecretEnvironment { name: String },
    #[error("environment reference {name} is not allowed")]
    DisallowedEnvironmentReference { name: String },
    #[error("environment reference {name} was not supplied")]
    MissingEnvironmentReference { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentManifest {
    pub agent_id: String,
    pub executable: PathBuf,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, ResolvedEnvironment>,
    pub resolved_version: String,
    pub provenance: String,
    pub verified_digest: String,
    pub integrity: RuntimeIntegrity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuntimeIntegrity {
    Executable,
    Tree { root: PathBuf, tree_sha256: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedEnvironment {
    Literal { value: String },
    HostReference { name: String },
}

impl ResolvedAgentManifest {
    pub fn validate(&self, approved_roots: &[PathBuf]) -> Result<(), RuntimeManifestError> {
        validate_agent_id(&self.agent_id)?;
        validate_text(&self.resolved_version)
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        validate_text(&self.provenance).map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if !is_sha256_digest(&self.verified_digest) {
            return Err(RuntimeManifestError::InvalidExecutableDigest);
        }
        let executable = self
            .executable
            .canonicalize()
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if let RuntimeIntegrity::Tree { root, tree_sha256 } = &self.integrity {
            if !is_sha256_digest(tree_sha256) {
                return Err(RuntimeManifestError::InvalidTreeDigest);
            }
            let canonical_root = root
                .canonicalize()
                .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if !canonical_root.is_dir()
                || !executable.starts_with(&canonical_root)
                || !approved_roots.iter().any(|approved| {
                    approved
                        .canonicalize()
                        .map(|approved| canonical_root.starts_with(approved))
                        .unwrap_or(false)
                })
            {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
        }
        if self.argv.len() > MAX_ARGS {
            return Err(RuntimeManifestError::InvalidArgument { index: MAX_ARGS });
        }
        for (index, argument) in self.argv.iter().enumerate() {
            if validate_text(argument).is_err() || argument.len() > MAX_ARG_BYTES {
                return Err(RuntimeManifestError::InvalidArgument { index });
            }
        }
        if self.environment.len() > MAX_ENV {
            return Err(RuntimeManifestError::InvalidEnvironment {
                name: "too many entries".to_string(),
            });
        }
        for (name, value) in &self.environment {
            validate_env_name(name)?;
            validate_non_secret_env_name(name)?;
            match value {
                ResolvedEnvironment::Literal { value } if validate_value(value).is_ok() => {}
                ResolvedEnvironment::Literal { .. } => {
                    return Err(RuntimeManifestError::InvalidEnvironment { name: name.clone() });
                }
                ResolvedEnvironment::HostReference { name: reference }
                    if HOST_ENV_ALLOWLIST.contains(&reference.as_str()) =>
                {
                    validate_non_secret_env_name(reference)?;
                }
                ResolvedEnvironment::HostReference { name: reference } => {
                    return Err(RuntimeManifestError::DisallowedEnvironmentReference {
                        name: reference.clone(),
                    });
                }
            }
        }

        if !executable.is_file() {
            return Err(RuntimeManifestError::InvalidExecutable);
        }
        if !approved_roots.iter().any(|root| {
            root.canonicalize()
                .map(|root| executable.starts_with(root))
                .unwrap_or(false)
        }) {
            return Err(RuntimeManifestError::ExecutableOutsideRoot);
        }
        Ok(())
    }

    pub fn acp_agent(
        &self,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
    ) -> Result<IsolatedAcpAgent, RuntimeManifestError> {
        self.validate(approved_roots)?;
        let executable = self
            .executable
            .canonicalize()
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if executable_sha256(&executable)? != self.verified_digest {
            return Err(RuntimeManifestError::ExecutableDigestMismatch);
        }
        if let RuntimeIntegrity::Tree { root, tree_sha256 } = &self.integrity {
            if installation_tree_sha256(root)? != *tree_sha256 {
                return Err(RuntimeManifestError::TreeDigestMismatch);
            }
        }
        let mut environment = SAFE_BASELINE_ENV
            .iter()
            .filter_map(|name| {
                host_environment
                    .get(*name)
                    .map(|value| ((*name).to_string(), value.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        for (name, value) in &self.environment {
            let value = match value {
                ResolvedEnvironment::Literal { value } => value.clone(),
                ResolvedEnvironment::HostReference { name: reference } => host_environment
                    .get(reference)
                    .cloned()
                    .ok_or_else(|| RuntimeManifestError::MissingEnvironmentReference {
                        name: reference.clone(),
                    })?,
            };
            environment.insert(name.clone(), value);
        }
        Ok(IsolatedAcpAgent {
            executable,
            argv: self.argv.clone(),
            environment,
        })
    }
}

pub struct IsolatedAcpAgent {
    executable: PathBuf,
    argv: Vec<String>,
    environment: BTreeMap<String, String>,
}

impl IsolatedAcpAgent {
    fn spawn_process(&self) -> std::io::Result<async_process::Child> {
        let mut command = async_process::Command::new(&self.executable);
        command
            .args(&self.argv)
            .env_clear()
            .envs(&self.environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
    }
}

impl ConnectTo<Client> for IsolatedAcpAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<agent_client_protocol::Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let mut child = self
            .spawn_process()
            .map_err(agent_client_protocol::Error::into_internal_error)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            agent_client_protocol::util::internal_error("failed to open ACP stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            agent_client_protocol::util::internal_error("failed to open ACP stdout")
        })?;
        let incoming = futures_util::io::BufReader::new(stdout).lines();
        let outgoing = futures_util::sink::unfold(stdin, async move |mut writer, line: String| {
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            Ok::<_, std::io::Error>(writer)
        });
        let protocol = agent_client_protocol::ConnectTo::<Client>::connect_to(
            Lines::new(outgoing, incoming),
            client,
        );
        futures_util::pin_mut!(protocol);
        let status = async move {
            struct ChildGuard(async_process::Child);

            impl Drop for ChildGuard {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                }
            }

            let mut guard = ChildGuard(child);
            guard.0.status().await
        };
        futures_util::pin_mut!(status);
        match futures_util::future::select(protocol, status).await {
            futures_util::future::Either::Left((result, _)) => result,
            futures_util::future::Either::Right((Ok(status), _)) if status.success() => Ok(()),
            futures_util::future::Either::Right((Ok(status), _)) => {
                Err(agent_client_protocol::util::internal_error(format!(
                    "ACP process exited with {status}"
                )))
            }
            futures_util::future::Either::Right((Err(error), _)) => {
                Err(agent_client_protocol::util::internal_error(format!(
                    "failed to wait for ACP process: {error}"
                )))
            }
        }
    }
}

fn validate_non_secret_env_name(name: &str) -> Result<(), RuntimeManifestError> {
    let upper = name.to_ascii_uppercase();
    let sensitive_segment = upper.split('_').any(|segment| {
        matches!(
            segment,
            "TOKEN"
                | "TOKENS"
                | "KEY"
                | "KEYS"
                | "SECRET"
                | "SECRETS"
                | "PASSWORD"
                | "PASSWORDS"
                | "PASSWD"
        )
    });
    let denied =
        matches!(upper.as_str(), "BRIDGE_AUTH_TOKEN" | "EXPO_ACCESS_TOKEN") || sensitive_segment;
    if denied {
        return Err(RuntimeManifestError::SecretEnvironment {
            name: name.to_string(),
        });
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn executable_sha256(path: &Path) -> Result<String, RuntimeManifestError> {
    let mut file = File::open(path).map_err(|_| RuntimeManifestError::InvalidExecutable)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|_| RuntimeManifestError::InvalidExecutable)?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

enum TreeEntry {
    Directory {
        path: String,
        mode: String,
    },
    File {
        path: String,
        mode: String,
        size: u64,
        sha256: String,
    },
    Symlink {
        path: String,
        target: String,
    },
}

impl TreeEntry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. } | Self::File { path, .. } | Self::Symlink { path, .. } => {
                path
            }
        }
    }

    fn write_canonical(&self, output: &mut Vec<u8>) -> Result<(), RuntimeManifestError> {
        let quote = |value: &str| {
            serde_json::to_string(value).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)
        };
        let line = match self {
            Self::Directory { path, mode } => format!(
                "{{\"path\":{},\"type\":\"directory\",\"mode\":{}}}\n",
                quote(path)?,
                quote(mode)?
            ),
            Self::File {
                path,
                mode,
                size,
                sha256,
            } => format!(
                "{{\"path\":{},\"type\":\"file\",\"mode\":{},\"size\":{size},\"sha256\":{}}}\n",
                quote(path)?,
                quote(mode)?,
                quote(sha256)?
            ),
            Self::Symlink { path, target } => format!(
                "{{\"path\":{},\"type\":\"symlink\",\"target\":{}}}\n",
                quote(path)?,
                quote(target)?
            ),
        };
        output.extend_from_slice(line.as_bytes());
        Ok(())
    }
}

fn normalized_tree_path(root: &Path, candidate: &Path) -> Result<String, RuntimeManifestError> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    let value = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => value
                .to_str()
                .ok_or(RuntimeManifestError::InvalidIntegrityRoot),
            _ => Err(RuntimeManifestError::InvalidIntegrityRoot),
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.len() > MAX_TREE_PATH_BYTES
    {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    Ok(value)
}

fn normalize_contained_path(
    root: &Path,
    candidate: &Path,
) -> Result<PathBuf, RuntimeManifestError> {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::ParentDir => {
                if !normalized.pop() || !normalized.starts_with(root) {
                    return Err(RuntimeManifestError::InvalidIntegrityRoot);
                }
            }
        }
    }
    if !normalized.starts_with(root) {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    Ok(normalized)
}

#[cfg(unix)]
fn tree_mode(metadata: &fs::Metadata) -> String {
    format!("0{:03o}", metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn tree_mode(_metadata: &fs::Metadata) -> String {
    "0000".to_string()
}

#[cfg(unix)]
fn is_hardlinked(metadata: &fs::Metadata) -> bool {
    metadata.nlink() != 1
}

#[cfg(windows)]
fn is_hardlinked(metadata: &fs::Metadata) -> bool {
    metadata.number_of_links() != 1
}

#[cfg(not(any(unix, windows)))]
fn is_hardlinked(_metadata: &fs::Metadata) -> bool {
    true
}

fn collect_tree_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<TreeEntry>,
    total_bytes: &mut u64,
) -> Result<(), RuntimeManifestError> {
    let mut children = fs::read_dir(directory)
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    children.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for child in children {
        let path = child.path();
        let relative = normalized_tree_path(root, &path)?;
        if relative == ".tethercode-install.json" {
            continue;
        }
        if entries.len() >= MAX_TREE_ENTRIES {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
        if metadata.is_dir() {
            entries.push(TreeEntry::Directory {
                path: relative,
                mode: tree_mode(&metadata),
            });
            collect_tree_entries(root, &path, entries, total_bytes)?;
        } else if metadata.file_type().is_symlink() {
            let raw_target =
                fs::read_link(&path).map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if raw_target.is_absolute() {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            let target_path =
                normalize_contained_path(root, &path.parent().unwrap_or(root).join(raw_target))?;
            let target = normalized_tree_path(root, &target_path)?;
            let canonical_target = path
                .canonicalize()
                .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
            if !canonical_target.starts_with(root) {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            entries.push(TreeEntry::Symlink {
                path: relative,
                target,
            });
        } else if metadata.is_file() {
            if is_hardlinked(&metadata) {
                return Err(RuntimeManifestError::InvalidIntegrityRoot);
            }
            *total_bytes = total_bytes
                .checked_add(metadata.len())
                .filter(|total| *total <= MAX_TREE_BYTES)
                .ok_or(RuntimeManifestError::InvalidIntegrityRoot)?;
            entries.push(TreeEntry::File {
                path: relative,
                mode: tree_mode(&metadata),
                size: metadata.len(),
                sha256: executable_sha256(&path)?[7..].to_string(),
            });
        } else {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
    }
    Ok(())
}

fn installation_tree_sha256(root: &Path) -> Result<String, RuntimeManifestError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| RuntimeManifestError::InvalidIntegrityRoot)?;
    if !canonical_root.is_dir() {
        return Err(RuntimeManifestError::InvalidIntegrityRoot);
    }
    let mut entries = Vec::new();
    let mut total_bytes = 0;
    collect_tree_entries(
        &canonical_root,
        &canonical_root,
        &mut entries,
        &mut total_bytes,
    )?;
    entries.sort_by(|left, right| left.path().as_bytes().cmp(right.path().as_bytes()));
    let mut receipt = Vec::new();
    for entry in entries {
        entry.write_canonical(&mut receipt)?;
        if receipt.len() > MAX_TREE_RECEIPT_BYTES {
            return Err(RuntimeManifestError::InvalidIntegrityRoot);
        }
    }
    Ok(format!("sha256:{:x}", Sha256::digest(receipt)))
}

fn validate_agent_id(agent_id: &str) -> Result<(), RuntimeManifestError> {
    if matches!(agent_id, "." | "..")
        || agent_id.is_empty()
        || agent_id.len() > MAX_AGENT_ID_LEN
        || !agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(RuntimeManifestError::InvalidAgentId);
    }
    Ok(())
}

fn validate_text(value: &str) -> Result<(), ()> {
    if value.is_empty() || value.contains('\0') {
        return Err(());
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), ()> {
    if value.len() > MAX_ENV_VALUE_BYTES {
        return Err(());
    }
    validate_text(value)
}

fn validate_env_name(name: &str) -> Result<(), RuntimeManifestError> {
    if name.is_empty()
        || !name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err(RuntimeManifestError::InvalidEnvironment {
            name: name.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_TREE_ID: AtomicU64 = AtomicU64::new(0);

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "lowercase")]
    enum FixtureTreeEntry {
        Directory {
            path: String,
            mode: String,
        },
        File {
            path: String,
            mode: String,
            size: u64,
            sha256: String,
        },
        Symlink {
            path: String,
            target: String,
        },
    }

    impl From<FixtureTreeEntry> for TreeEntry {
        fn from(value: FixtureTreeEntry) -> Self {
            match value {
                FixtureTreeEntry::Directory { path, mode } => Self::Directory { path, mode },
                FixtureTreeEntry::File {
                    path,
                    mode,
                    size,
                    sha256,
                } => Self::File {
                    path,
                    mode,
                    size,
                    sha256,
                },
                FixtureTreeEntry::Symlink { path, target } => Self::Symlink { path, target },
            }
        }
    }

    #[derive(Deserialize)]
    struct TreeFixture {
        algorithm: String,
        exclusions: Vec<String>,
        entries: Vec<FixtureTreeEntry>,
        receipt: String,
        sha256: String,
    }

    fn echo_digest() -> String {
        executable_sha256(&PathBuf::from("/bin/echo")).expect("hash /bin/echo")
    }

    fn manifest() -> ResolvedAgentManifest {
        ResolvedAgentManifest {
            agent_id: "test-agent".to_string(),
            executable: PathBuf::from("/bin/echo"),
            argv: vec![],
            environment: BTreeMap::new(),
            resolved_version: "1.0.0".to_string(),
            provenance: "local test".to_string(),
            verified_digest: echo_digest(),
            integrity: RuntimeIntegrity::Executable,
        }
    }

    fn test_tree(name: &str) -> PathBuf {
        let id = TEST_TREE_ID.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("tethercode-{name}-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create test tree");
        root
    }

    fn tree_manifest(root: &Path, executable: &Path) -> ResolvedAgentManifest {
        let mut candidate = manifest();
        candidate.executable = executable.to_path_buf();
        candidate.verified_digest = executable_sha256(executable).expect("hash executable");
        candidate.integrity = RuntimeIntegrity::Tree {
            root: root.to_path_buf(),
            tree_sha256: installation_tree_sha256(root).expect("hash installation tree"),
        };
        candidate
    }

    #[test]
    fn manifest_rejects_disallowed_environment_reference() {
        let mut manifest = manifest();
        manifest.environment = BTreeMap::from([(
            "SAFE_NAME".to_string(),
            ResolvedEnvironment::HostReference {
                name: "AWS_SECRET_ACCESS_KEY".to_string(),
            },
        )]);
        assert!(matches!(
            manifest.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::DisallowedEnvironmentReference { .. })
        ));
    }

    #[test]
    fn manifest_rejects_secret_shaped_literal_and_reference_names() {
        for name in [
            "BRIDGE_AUTH_TOKEN",
            "EXPO_ACCESS_TOKEN",
            "GITHUB_TOKEN",
            "SERVICE_SECRET",
            "DATABASE_PASSWORD",
            "SERVICE_API_KEY",
            "SIGNING_KEY",
            "TOKEN_VALUE",
        ] {
            let mut candidate = manifest();
            candidate.environment.insert(
                name.to_string(),
                ResolvedEnvironment::Literal {
                    value: "not-a-real-secret".to_string(),
                },
            );
            assert!(matches!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::SecretEnvironment { name: denied }) if denied == name
            ));
        }

        let mut candidate = manifest();
        candidate.environment.insert(
            "SAFE_NAME".to_string(),
            ResolvedEnvironment::HostReference {
                name: "BRIDGE_AUTH_TOKEN".to_string(),
            },
        );
        assert!(matches!(
            candidate.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::DisallowedEnvironmentReference { .. })
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn isolated_agent_process_receives_only_baseline_and_manifest_environment() {
        use futures_util::io::AsyncReadExt;

        let root = test_tree("isolated-environment");
        let executable = root.join("report-environment.sh");
        std::fs::write(&executable, b"#!/bin/sh\nenv | LC_ALL=C sort\n")
            .expect("write environment fixture");
        std::fs::set_permissions(
            &executable,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .expect("make fixture executable");
        let mut candidate = tree_manifest(&root, &executable);
        candidate.environment.insert(
            "AGENT_MODE".to_string(),
            ResolvedEnvironment::Literal {
                value: "fixture".to_string(),
            },
        );
        let host_environment = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("HOME".to_string(), "/tmp/fixture-home".to_string()),
            ("TMPDIR".to_string(), "/tmp/fixture-tmp".to_string()),
            ("LANG".to_string(), "C".to_string()),
            ("BRIDGE_AUTH_TOKEN".to_string(), "bridge-secret".to_string()),
            ("EXPO_ACCESS_TOKEN".to_string(), "expo-secret".to_string()),
        ]);
        let agent = candidate
            .acp_agent(std::slice::from_ref(&root), &host_environment)
            .expect("build isolated agent");
        let mut child = agent.spawn_process().expect("spawn environment fixture");
        drop(child.stdin.take());
        let mut output = String::new();
        child
            .stdout
            .take()
            .expect("fixture stdout")
            .read_to_string(&mut output)
            .await
            .expect("read fixture environment");
        assert!(child.status().await.expect("wait for fixture").success());
        assert!(output.contains("AGENT_MODE=fixture\n"));
        assert!(output.contains("HOME=/tmp/fixture-home\n"));
        assert!(output.contains("LANG=C\n"));
        assert!(output.contains("PATH=/usr/bin:/bin\n"));
        assert!(output.contains("TMPDIR=/tmp/fixture-tmp\n"));
        assert!(!output.contains("BRIDGE_AUTH_TOKEN"));
        assert!(!output.contains("EXPO_ACCESS_TOKEN"));
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn manifest_requires_explicit_host_environment_values() {
        let mut manifest = manifest();
        manifest.argv = vec!["hello".to_string()];
        manifest.environment = BTreeMap::from([(
            "PATH".to_string(),
            ResolvedEnvironment::HostReference {
                name: "PATH".to_string(),
            },
        )]);
        assert!(matches!(
            manifest.acp_agent(&[PathBuf::from("/bin")], &BTreeMap::new()),
            Err(RuntimeManifestError::MissingEnvironmentReference { .. })
        ));
    }

    #[test]
    fn manifest_validates_identity_metadata_arguments_and_environment_limits() {
        for agent_id in ["", ".", "..", &"a".repeat(MAX_AGENT_ID_LEN + 1), "bad/id"] {
            let mut candidate = manifest();
            candidate.agent_id = agent_id.to_string();
            assert_eq!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::InvalidAgentId)
            );
        }

        for (version, provenance) in [("", "source"), ("1", ""), ("1\0", "source")] {
            let mut candidate = manifest();
            candidate.resolved_version = version.to_string();
            candidate.provenance = provenance.to_string();
            assert_eq!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::InvalidExecutable)
            );
        }

        let mut too_many_args = manifest();
        too_many_args.argv = vec!["arg".to_string(); MAX_ARGS + 1];
        assert_eq!(
            too_many_args.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::InvalidArgument { index: MAX_ARGS })
        );
        for argument in [
            String::new(),
            "bad\0arg".to_string(),
            "x".repeat(MAX_ARG_BYTES + 1),
        ] {
            let mut candidate = manifest();
            candidate.argv = vec!["ok".to_string(), argument];
            assert_eq!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::InvalidArgument { index: 1 })
            );
        }

        let mut too_many_environment_entries = manifest();
        too_many_environment_entries.environment = (0..=MAX_ENV)
            .map(|index| {
                (
                    format!("VALUE_{index}"),
                    ResolvedEnvironment::Literal {
                        value: "ok".to_string(),
                    },
                )
            })
            .collect();
        assert!(matches!(
            too_many_environment_entries.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::InvalidEnvironment { name }) if name == "too many entries"
        ));

        for name in ["", "1BAD", "BAD-NAME"] {
            let mut candidate = manifest();
            candidate.environment.insert(
                name.to_string(),
                ResolvedEnvironment::Literal {
                    value: "ok".to_string(),
                },
            );
            assert!(matches!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::InvalidEnvironment { name: invalid }) if invalid == name
            ));
        }
        for value in [
            String::new(),
            "bad\0value".to_string(),
            "x".repeat(MAX_ENV_VALUE_BYTES + 1),
        ] {
            let mut candidate = manifest();
            candidate.environment.insert(
                "VALUE_1".to_string(),
                ResolvedEnvironment::Literal { value },
            );
            assert!(matches!(
                candidate.validate(&[PathBuf::from("/bin")]),
                Err(RuntimeManifestError::InvalidEnvironment { name }) if name == "VALUE_1"
            ));
        }
    }

    #[test]
    fn manifest_validates_executable_roots_and_builds_typed_agent() {
        let mut candidate = manifest();
        candidate.executable = PathBuf::from("/does/not/exist");
        assert_eq!(
            candidate.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::InvalidExecutable)
        );

        let mut candidate = manifest();
        candidate.executable = PathBuf::from("/bin");
        assert_eq!(
            candidate.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::InvalidExecutable)
        );

        let candidate = manifest();
        assert_eq!(
            candidate.validate(&[PathBuf::from("/tmp")]),
            Err(RuntimeManifestError::ExecutableOutsideRoot)
        );

        let mut candidate = manifest();
        candidate.environment = BTreeMap::from([
            (
                "LITERAL".to_string(),
                ResolvedEnvironment::Literal {
                    value: "value".to_string(),
                },
            ),
            (
                "PATH_COPY".to_string(),
                ResolvedEnvironment::HostReference {
                    name: "PATH".to_string(),
                },
            ),
        ]);
        assert!(candidate
            .acp_agent(
                &[PathBuf::from("/bin")],
                &BTreeMap::from([("PATH".to_string(), "/bin".to_string())]),
            )
            .is_ok());
    }

    #[test]
    fn manifest_rejects_invalid_missing_and_changed_executable_digests() {
        let mut invalid = manifest();
        invalid.verified_digest = "sha256:ABC".to_string();
        assert_eq!(
            invalid.validate(&[PathBuf::from("/bin")]),
            Err(RuntimeManifestError::InvalidExecutableDigest)
        );

        let root = std::env::temp_dir().join(format!("tethercode-digest-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create test root");
        let executable = root.join("agent");
        std::fs::write(&executable, b"original").expect("write executable");
        let mut changed = manifest();
        changed.executable = executable.clone();
        changed.verified_digest = executable_sha256(&executable).expect("hash executable");
        changed
            .validate(std::slice::from_ref(&root))
            .expect("valid before mutation");
        std::fs::write(&executable, b"tampered").expect("tamper executable");
        assert!(matches!(
            changed.acp_agent(std::slice::from_ref(&root), &BTreeMap::new()),
            Err(RuntimeManifestError::ExecutableDigestMismatch)
        ));
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn canonical_tree_encoding_matches_node_fixture() {
        let fixture: TreeFixture = serde_json::from_str(include_str!(
            "../../../../scripts/__tests__/fixtures/tree-receipt-v1.json"
        ))
        .expect("parse shared tree fixture");
        assert_eq!(fixture.algorithm, "tethercode-tree-v1");
        assert_eq!(fixture.exclusions, [".tethercode-install.json"]);
        let mut receipt = Vec::new();
        for entry in fixture.entries.into_iter().map(TreeEntry::from) {
            entry.write_canonical(&mut receipt).expect("encode entry");
        }
        assert_eq!(receipt, fixture.receipt.as_bytes());
        assert_eq!(format!("{:x}", Sha256::digest(receipt)), fixture.sha256);
    }

    #[test]
    fn tree_is_recomputed_immediately_before_agent_construction() {
        let root = test_tree("tree-runtime");
        let module_root = root.join("node_modules/fixture");
        std::fs::create_dir_all(&module_root).expect("create installation tree");
        let executable = module_root.join("cli.js");
        let dependency = module_root.join("dependency.js");
        std::fs::write(&executable, b"#!/usr/bin/env node\n").expect("write executable");
        std::fs::write(&dependency, b"module.exports = true;\n").expect("write dependency");
        let candidate = tree_manifest(&root, &executable);
        candidate
            .acp_agent(std::slice::from_ref(&root), &BTreeMap::new())
            .expect("valid installation tree");
        std::fs::write(&dependency, b"module.exports = false;\n").expect("tamper dependency");
        assert!(matches!(
            candidate.acp_agent(std::slice::from_ref(&root), &BTreeMap::new()),
            Err(RuntimeManifestError::TreeDigestMismatch)
        ));
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn tree_detects_added_deleted_and_transitive_files() {
        let root = test_tree("tree-mutations");
        let module_root = root.join("node_modules/fixture");
        let transitive_root = root.join("node_modules/transitive");
        std::fs::create_dir_all(&module_root).expect("create module");
        std::fs::create_dir_all(&transitive_root).expect("create transitive module");
        let executable = module_root.join("cli.js");
        let dependency = transitive_root.join("index.js");
        std::fs::write(&executable, b"#!/usr/bin/env node\n").expect("write executable");
        std::fs::write(&dependency, b"module.exports = 1;\n").expect("write dependency");
        let expected = installation_tree_sha256(&root).expect("hash original tree");

        let added = module_root.join("added.js");
        std::fs::write(&added, b"added\n").expect("add file");
        assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
        std::fs::remove_file(&added).expect("remove added file");
        assert_eq!(installation_tree_sha256(&root).unwrap(), expected);

        std::fs::remove_file(&dependency).expect("delete dependency");
        assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
        std::fs::write(&dependency, b"module.exports = 2;\n").expect("tamper dependency");
        assert_ne!(installation_tree_sha256(&root).unwrap(), expected);
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn tree_validates_typed_integrity_fields_and_root_shape() {
        let root = test_tree("tree-manifest");
        let executable = root.join("agent");
        std::fs::write(&executable, b"agent").expect("write executable");
        let mut candidate = tree_manifest(&root, &executable);

        candidate.integrity = RuntimeIntegrity::Tree {
            root: root.clone(),
            tree_sha256: "sha256:not-a-digest".to_string(),
        };
        assert_eq!(
            candidate.validate(std::slice::from_ref(&root)),
            Err(RuntimeManifestError::InvalidTreeDigest)
        );
        candidate.integrity = RuntimeIntegrity::Tree {
            root: root.clone(),
            tree_sha256: format!("invalid{:064x}", 0),
        };
        assert_eq!(
            candidate.validate(std::slice::from_ref(&root)),
            Err(RuntimeManifestError::InvalidTreeDigest)
        );

        candidate = tree_manifest(&root, &executable);
        assert_eq!(
            candidate.validate(&[root.join("missing-approved-root")]),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );

        let file_root = root.join("not-a-directory");
        std::fs::write(&file_root, b"file").expect("write invalid root");
        candidate.integrity = RuntimeIntegrity::Tree {
            root: file_root,
            tree_sha256: format!("sha256:{:064x}", 0),
        };
        assert_eq!(
            candidate.validate(std::slice::from_ref(&root)),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );

        candidate.integrity = RuntimeIntegrity::Tree {
            root: root.join("missing"),
            tree_sha256: format!("sha256:{:064x}", 0),
        };
        assert_eq!(
            candidate.validate(std::slice::from_ref(&root)),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn tree_path_helpers_reject_invalid_and_oversized_paths() {
        let root = PathBuf::from("/approved/root");
        assert_eq!(
            normalized_tree_path(&root, &root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        assert_eq!(
            normalized_tree_path(&root, Path::new("/other/file")),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        let oversized = root.join("x".repeat(MAX_TREE_PATH_BYTES + 1));
        assert_eq!(
            normalized_tree_path(&root, &oversized),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        for invalid in [root.join("nul\0path"), root.join("backslash\\path")] {
            assert_eq!(
                normalized_tree_path(&root, &invalid),
                Err(RuntimeManifestError::InvalidIntegrityRoot)
            );
        }
        assert_eq!(
            normalize_contained_path(&root, Path::new("/approved/root/a/../b")).unwrap(),
            PathBuf::from("/approved/root/b")
        );
        assert_eq!(
            normalize_contained_path(&root, Path::new("/approved/root/../../escape")),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        assert_eq!(
            normalize_contained_path(&root, Path::new("relative/path")),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        assert_eq!(
            normalize_contained_path(&root, Path::new("/../escape")),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
    }

    #[test]
    fn tree_excludes_receipt_and_rejects_file_root() {
        let root = test_tree("tree-receipt");
        let file = root.join("agent");
        std::fs::write(&file, b"agent").expect("write agent");
        let expected = installation_tree_sha256(&root).expect("hash tree");
        std::fs::write(root.join(".tethercode-install.json"), b"changed receipt")
            .expect("write excluded receipt");
        assert_eq!(installation_tree_sha256(&root).unwrap(), expected);
        assert_eq!(
            installation_tree_sha256(&file),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn tree_rejects_total_file_bytes_over_limit() {
        let root = test_tree("tree-byte-limit");
        let oversized = root.join("oversized");
        let file = std::fs::File::create(&oversized).expect("create sparse file");
        file.set_len(MAX_TREE_BYTES + 1)
            .expect("set sparse file length");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn tree_rejects_escaping_symlink_and_manifest_root_mismatch() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("tethercode-tree-link-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create tree");
        symlink("../../outside", root.join("escape")).expect("create escaping symlink");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_file(root.join("escape")).expect("remove symlink");
        let executable = root.join("agent");
        std::fs::write(&executable, b"agent").expect("write executable");
        let other = root.join("other");
        std::fs::create_dir(&other).expect("create other root");
        let mut candidate = manifest();
        candidate.executable = executable.clone();
        candidate.verified_digest = executable_sha256(&executable).expect("hash executable");
        candidate.integrity = RuntimeIntegrity::Tree {
            root: other,
            tree_sha256: format!("sha256:{:064x}", 0),
        };
        assert_eq!(
            candidate.validate(std::slice::from_ref(&root)),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn tree_accepts_contained_symlinks_and_rejects_broken_links() {
        use std::os::unix::fs::symlink;

        let root = test_tree("tree-contained-link");
        let target = root.join("target.js");
        std::fs::write(&target, b"target\n").expect("write target");
        symlink("target.js", root.join("link.js")).expect("create contained symlink");
        assert!(installation_tree_sha256(&root).is_ok());

        std::fs::remove_file(&target).expect("break symlink");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn tree_rejects_absolute_and_indirect_escaping_symlinks() {
        use std::os::unix::fs::symlink;

        let root = test_tree("tree-link-shapes");
        let outside = root.parent().expect("temporary parent").join(format!(
            "outside-{}",
            TEST_TREE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&outside, b"outside").expect("write outside target");

        symlink(&outside, root.join("absolute-link")).expect("create absolute symlink");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_file(root.join("absolute-link")).expect("remove absolute symlink");

        symlink("../outside-indirect", root.join("z-contained-name"))
            .expect("create escaping intermediate symlink");
        std::fs::rename(&outside, root.parent().unwrap().join("outside-indirect"))
            .expect("rename outside target");
        symlink("z-contained-name", root.join("indirect-link")).expect("create indirect symlink");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_dir_all(&root).expect("remove test root");
        std::fs::remove_file(root.parent().unwrap().join("outside-indirect"))
            .expect("remove outside target");
    }

    #[cfg(unix)]
    #[test]
    fn tree_hashes_modes_and_rejects_hardlinks_and_special_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = test_tree("tree-metadata");
        let file = root.join("agent");
        std::fs::write(&file, b"agent").expect("write file");
        let original = installation_tree_sha256(&root).expect("hash original mode");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");
        assert_ne!(installation_tree_sha256(&root).unwrap(), original);

        let hardlink = root.join("agent-hardlink");
        std::fs::hard_link(&file, &hardlink).expect("create hardlink");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        std::fs::remove_file(&hardlink).expect("remove hardlink");

        let socket = root.join("socket");
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("create socket");
        assert_eq!(
            installation_tree_sha256(&root),
            Err(RuntimeManifestError::InvalidIntegrityRoot)
        );
        drop(listener);
        std::fs::remove_file(&socket).expect("remove socket");

        symlink("agent", root.join("agent-link")).expect("create final symlink");
        assert!(installation_tree_sha256(&root).is_ok());
        std::fs::remove_dir_all(root).expect("remove test root");
    }
}
