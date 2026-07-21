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
