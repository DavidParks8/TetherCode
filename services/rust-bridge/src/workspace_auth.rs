use crate::*;

pub(super) async fn list_workspace_roots(
    state: &Arc<AppState>,
    request: WorkspaceListRequest,
) -> Result<WorkspaceListResponse, BridgeError> {
    let limit = request.limit.unwrap_or(200).clamp(1, 1000);
    let result = state
        .backend
        .request_internal(
            "thread/list",
            Some(json!({
                "cursor": Value::Null,
                "limit": limit,
                "sortKey": "updated_at",
                "modelProviders": Value::Null,
                "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"],
                "archived": false,
                "cwd": Value::Null,
            })),
        )
        .await
        .map_err(|error| BridgeError::server(&error))?;

    let entries = result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut workspaces_by_path: HashMap<String, (usize, u64)> = HashMap::new();

    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };

        let Some(raw_cwd) = read_string(object.get("cwd")) else {
            continue;
        };

        let Ok(canonical_path) = state
            .path_policy
            .resolve_existing(raw_cwd.as_str(), PathKind::Directory)
        else {
            continue;
        };

        let workspace_path = path_to_string(&canonical_path);
        let updated_at = parse_internal_id(object.get("updatedAt")).unwrap_or(0);
        let workspace_entry = workspaces_by_path
            .entry(workspace_path)
            .or_insert((0, updated_at));
        workspace_entry.0 += 1;
        workspace_entry.1 = workspace_entry.1.max(updated_at);
    }

    let mut workspaces = workspaces_by_path
        .into_iter()
        .map(|(path, (chat_count, updated_at))| {
            (
                WorkspaceSummary {
                    path,
                    chat_count,
                    updated_at: (updated_at > 0).then_some(updated_at),
                },
                updated_at,
            )
        })
        .collect::<Vec<_>>();

    workspaces.sort_by(|(left, left_updated_at), (right, right_updated_at)| {
        right_updated_at
            .cmp(left_updated_at)
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(WorkspaceListResponse {
        bridge_root: path_to_string(&state.config.workdir),
        allow_outside_root_cwd: state.config.allow_outside_root_cwd,
        workspaces: workspaces
            .into_iter()
            .map(|(workspace, _)| workspace)
            .collect(),
    })
}

pub(super) async fn list_filesystem_entries(
    state: &Arc<AppState>,
    request: FileSystemListRequest,
) -> Result<FileSystemListResponse, BridgeError> {
    let include_hidden = request.include_hidden.unwrap_or(false);
    let directories_only = request.directories_only.unwrap_or(true);
    let include_git_repo = request.include_git_repo.unwrap_or(false);
    let current_path = state.path_policy.resolve_cwd(request.path.as_deref())?;

    let mut read_dir = fs::read_dir(&current_path)
        .await
        .map_err(|error| BridgeError::server(&format!("failed to read directory: {error}")))?;
    let mut entries = Vec::new();
    let mut total_entries = 0usize;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|error| BridgeError::server(&format!("failed to read directory entry: {error}")))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }

        let hidden = name.starts_with('.');
        if hidden && !include_hidden {
            continue;
        }

        let entry_kind = if directories_only {
            PathKind::Directory
        } else {
            PathKind::Any
        };
        let entry_path =
            match resolve_filesystem_entry(&state.path_policy, &entry.path(), entry_kind) {
                Ok(path) => path,
                Err(_) => continue,
            };
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        let is_directory = if file_type.is_dir() {
            true
        } else if file_type.is_symlink() {
            fs::metadata(&entry_path)
                .await
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
        } else {
            false
        };
        if directories_only && !is_directory {
            continue;
        }

        let kind = if is_directory { "directory" } else { "file" }.to_string();
        let is_git_repo = if include_git_repo && is_directory {
            fs::metadata(entry_path.join(".git")).await.is_ok()
        } else {
            false
        };

        total_entries += 1;
        if entries.len() < FILESYSTEM_LIST_MAX_ENTRIES {
            entries.push(FileSystemEntry {
                name,
                path: path_to_string(&entry_path),
                kind,
                hidden,
                selectable: is_directory,
                is_git_repo,
            });
        }
    }

    entries.sort_by(|left, right| {
        right.selectable.cmp(&left.selectable).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        })
    });
    let truncated = total_entries > FILESYSTEM_LIST_MAX_ENTRIES;

    let parent_path = state
        .path_policy
        .parent_for_browsing(&current_path)
        .as_deref()
        .map(path_to_string);

    Ok(FileSystemListResponse {
        bridge_root: path_to_string(&state.config.workdir),
        path: path_to_string(&current_path),
        parent_path,
        entries,
        truncated,
        total_entries,
        omitted_entries: total_entries.saturating_sub(FILESYSTEM_LIST_MAX_ENTRIES),
        max_entries: FILESYSTEM_LIST_MAX_ENTRIES,
    })
}

pub(super) fn resolve_filesystem_entry(
    path_policy: &PathPolicy,
    path: &Path,
    kind: PathKind,
) -> Result<PathBuf, BridgeError> {
    path_policy.resolve_existing(path.to_string_lossy().as_ref(), kind)
}

pub(super) fn bridge_chatgpt_auth_cache() -> &'static StdRwLock<Option<BridgeChatGptAuthBundle>> {
    static CACHE: OnceLock<StdRwLock<Option<BridgeChatGptAuthBundle>>> = OnceLock::new();
    CACHE.get_or_init(|| StdRwLock::new(None))
}

#[cfg(test)]
pub(super) fn bridge_chatgpt_auth_cache_path_override() -> &'static StdRwLock<Option<PathBuf>> {
    static OVERRIDE: OnceLock<StdRwLock<Option<PathBuf>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| StdRwLock::new(None))
}

#[cfg(test)]
pub(super) fn set_bridge_chatgpt_auth_cache_path_override(path: Option<PathBuf>) {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache_path_override().write() {
        *guard = path;
    }
}

#[cfg(test)]
pub(super) struct TestBridgeChatGptAuthCacheScope {
    _guard: std::sync::MutexGuard<'static, ()>,
    temp_dir: PathBuf,
    cache_path: PathBuf,
}

#[cfg(test)]
impl TestBridgeChatGptAuthCacheScope {
    pub(super) fn new() -> Self {
        static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        let guard = LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let temp_dir = env::temp_dir().join(format!(
            "clawdex-bridge-chatgpt-auth-test-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create auth cache test directory");
        let cache_path = temp_dir.join(BRIDGE_CHATGPT_AUTH_CACHE_FILE_NAME);

        // Select the isolated path before clearing the process-global in-memory cache.
        set_bridge_chatgpt_auth_cache_path_override(Some(cache_path.clone()));
        clear_cached_bridge_chatgpt_auth();

        Self {
            _guard: guard,
            temp_dir,
            cache_path,
        }
    }

    pub(super) fn cache_path(&self) -> &Path {
        &self.cache_path
    }
}

#[cfg(test)]
impl Drop for TestBridgeChatGptAuthCacheScope {
    fn drop(&mut self) {
        clear_cached_bridge_chatgpt_auth();
        set_bridge_chatgpt_auth_cache_path_override(None);
        let _ = std::fs::remove_dir_all(&self.temp_dir);
    }
}

pub(super) fn resolve_bridge_chatgpt_auth_cache_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Ok(guard) = bridge_chatgpt_auth_cache_path_override().read() {
        if let Some(path) = guard.clone() {
            return Some(path);
        }
    }

    let home = read_non_empty_env("HOME").map(PathBuf::from)?;
    Some(
        home.join(GITHUB_CREDENTIALS_DIR_NAME)
            .join(BRIDGE_CHATGPT_AUTH_CACHE_FILE_NAME),
    )
}

pub(super) fn load_persisted_bridge_chatgpt_auth() -> Option<BridgeChatGptAuthBundle> {
    let path = resolve_bridge_chatgpt_auth_cache_path()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BridgeChatGptAuthBundle>(&contents).ok()
}

pub(super) fn read_cached_bridge_chatgpt_auth() -> Option<BridgeChatGptAuthBundle> {
    if let Ok(guard) = bridge_chatgpt_auth_cache().read() {
        if let Some(auth) = guard.clone() {
            return Some(auth);
        }
    }

    let persisted = load_persisted_bridge_chatgpt_auth()?;
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = Some(persisted.clone());
    }
    Some(persisted)
}

pub(super) fn cache_bridge_chatgpt_auth(auth: BridgeChatGptAuthBundle) {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = Some(auth.clone());
    }

    if let Some(path) = resolve_bridge_chatgpt_auth_cache_path() {
        if let Ok(payload) = serde_json::to_vec_pretty(&auth) {
            let _ = write_private_bridge_chatgpt_auth_cache(&path, &payload);
        }
    }
}

pub(super) fn write_private_bridge_chatgpt_auth_cache(
    path: &Path,
    payload: &[u8],
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }

    std::fs::write(path, payload)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

pub(super) fn clear_cached_bridge_chatgpt_auth() {
    if let Ok(mut guard) = bridge_chatgpt_auth_cache().write() {
        *guard = None;
    }

    if let Some(path) = resolve_bridge_chatgpt_auth_cache_path() {
        let _ = std::fs::remove_file(path);
    }
}

pub(super) fn resolve_bridge_chatgpt_auth_bundle_for_refresh() -> Option<BridgeChatGptAuthBundle> {
    let access_token = read_non_empty_env("BRIDGE_CHATGPT_ACCESS_TOKEN");
    let account_id = read_non_empty_env("BRIDGE_CHATGPT_ACCOUNT_ID");
    if let (Some(access_token), Some(account_id)) = (access_token, account_id) {
        return Some(BridgeChatGptAuthBundle {
            access_token,
            account_id,
            plan_type: read_non_empty_env("BRIDGE_CHATGPT_PLAN_TYPE"),
        });
    }

    read_cached_bridge_chatgpt_auth()
}

pub(super) fn extract_chatgpt_auth_tokens_from_account_login_start(
    params: Option<&Value>,
) -> Option<BridgeChatGptAuthBundle> {
    let params = params?.as_object()?;
    let login_type = params.get("type")?.as_str()?.trim();
    if login_type != "chatgptAuthTokens" {
        return None;
    }

    let access_token = params.get("accessToken")?.as_str()?.trim();
    let account_id = params.get("chatgptAccountId")?.as_str()?.trim();
    if access_token.is_empty() || account_id.is_empty() {
        return None;
    }

    let plan_type = params
        .get("chatgptPlanType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Some(BridgeChatGptAuthBundle {
        access_token: access_token.to_string(),
        account_id: account_id.to_string(),
        plan_type,
    })
}
