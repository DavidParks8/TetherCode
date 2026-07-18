use crate::*;

#[derive(Debug, Clone)]
pub(super) struct GitHubViewer {
    pub(super) login: String,
    pub(super) scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedGitHubAuthGrant {
    pub(super) access_token: String,
    pub(super) repositories: Vec<String>,
}

pub(super) async fn install_github_git_auth(
    _state: &Arc<AppState>,
    request: GitHubAuthInstallRequest,
) -> Result<GitHubAuthInstallResponse, BridgeError> {
    let resolved_grants = resolve_github_auth_grants(request)?;
    if resolved_grants.is_empty() {
        return Err(BridgeError::invalid_params(
            "At least one GitHub auth grant is required",
        ));
    }

    let mut login = None;
    let mut scopes = Vec::new();
    if let Some(first_grant) = resolved_grants.first() {
        if let Ok(viewer) = fetch_github_viewer(&first_grant.access_token).await {
            if !github_token_can_be_used_for_git_auth(&viewer.scopes) {
                return Err(BridgeError::forbidden(
                    "github_repo_scope_required",
                    "GitHub repository access is required. Sign in again from the app and approve the required repository access.",
                ));
            }
            login = Some(viewer.login);
            scopes = viewer.scopes;
        }
    }

    let credentials_file = resolve_github_credentials_file_path()?;
    ensure_private_parent_dir(&credentials_file).await?;
    write_github_credentials_file(&credentials_file, &resolved_grants).await?;

    Ok(GitHubAuthInstallResponse {
        installed: true,
        host: GITHUB_HOST.to_string(),
        login,
        scopes,
        credential_file: credentials_file.to_string_lossy().to_string(),
        grants_installed: resolved_grants.len(),
    })
}

pub(super) fn resolve_github_auth_grants(
    request: GitHubAuthInstallRequest,
) -> Result<Vec<ResolvedGitHubAuthGrant>, BridgeError> {
    let raw_grants = if let Some(grants) = request.grants {
        grants
    } else if let Some(access_token) = request.access_token {
        vec![GitHubAuthGrantInput {
            access_token,
            repositories: request.repositories,
        }]
    } else {
        Vec::new()
    };

    let mut grants = Vec::new();
    for grant in raw_grants {
        let access_token = grant.access_token.trim().to_string();
        if access_token.is_empty() {
            continue;
        }

        let repositories =
            normalize_github_auth_repositories(grant.repositories.as_deref().unwrap_or(&[]));
        if repositories.is_empty() {
            continue;
        }

        grants.push(ResolvedGitHubAuthGrant {
            access_token,
            repositories,
        });
    }

    Ok(grants)
}

pub(super) async fn fetch_github_viewer(access_token: &str) -> Result<GitHubViewer, BridgeError> {
    let trimmed = access_token.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("accessToken must not be empty"));
    }

    let http = HttpClient::builder()
        .user_agent("clawdex-rust-bridge")
        .build()
        .map_err(|error| {
            BridgeError::server(&format!("failed to build GitHub auth client: {error}"))
        })?;
    let response = http
        .get(format!("{GITHUB_API_URL}/user"))
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", GITHUB_API_VERSION)
        .bearer_auth(trimmed)
        .send()
        .await
        .map_err(|error| BridgeError::server(&format!("GitHub auth check failed: {error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let message = if let Ok(value) = serde_json::from_str::<Value>(&body) {
            read_string(value.get("message"))
                .unwrap_or_else(|| format!("GitHub auth check failed ({status})"))
        } else {
            format!("GitHub auth check failed ({status})")
        };
        return Err(BridgeError::server(&message));
    }

    let scopes = parse_github_oauth_scopes(
        response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok()),
    );
    let payload = response.json::<Value>().await.map_err(|error| {
        BridgeError::server(&format!("failed to parse GitHub user response: {error}"))
    })?;
    let login = read_string(payload.get("login"))
        .ok_or_else(|| BridgeError::server("GitHub auth check returned an invalid user payload"))?;

    Ok(GitHubViewer { login, scopes })
}

pub(super) fn parse_github_oauth_scopes(header: Option<&str>) -> Vec<String> {
    header
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

pub(super) fn github_scopes_allow_repo_access(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == "repo" || scope == "public_repo")
}

pub(super) fn github_token_can_be_used_for_git_auth(scopes: &[String]) -> bool {
    scopes.is_empty() || github_scopes_allow_repo_access(scopes)
}

pub(super) fn normalize_github_auth_repositories(repositories: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for repository in repositories {
        let trimmed = repository.trim().trim_matches('/');
        let Some((owner, name)) = trimmed.split_once('/') else {
            continue;
        };
        if owner.is_empty() || name.is_empty() || name.contains('/') {
            continue;
        }

        let key = format!(
            "{}/{}",
            owner.to_ascii_lowercase(),
            name.to_ascii_lowercase()
        );
        if seen.insert(key) {
            normalized.push(format!("{owner}/{name}"));
        }
    }

    normalized.sort_unstable_by_key(|repository| repository.to_ascii_lowercase());
    normalized
}

pub(super) fn resolve_github_credentials_dir_path() -> Result<PathBuf, BridgeError> {
    let home = read_non_empty_env("HOME")
        .ok_or_else(|| BridgeError::server("HOME is not set; cannot install GitHub auth"))?;
    Ok(PathBuf::from(home).join(GITHUB_CREDENTIALS_DIR_NAME))
}

pub(super) fn resolve_github_credentials_file_path() -> Result<PathBuf, BridgeError> {
    Ok(resolve_github_credentials_dir_path()?.join(GITHUB_CREDENTIALS_FILE_NAME))
}

pub(super) async fn ensure_private_parent_dir(path: &Path) -> Result<(), BridgeError> {
    let Some(parent) = path.parent() else {
        return Err(BridgeError::server(
            "failed to resolve GitHub credential directory",
        ));
    };
    fs::create_dir_all(parent).await.map_err(|error| {
        BridgeError::server(&format!("failed to create GitHub auth directory: {error}"))
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| {
                BridgeError::server(&format!(
                    "failed to secure GitHub auth directory permissions: {error}"
                ))
            })?;
    }
    Ok(())
}

pub(super) async fn write_github_credentials_file(
    credentials_file: &Path,
    grants: &[ResolvedGitHubAuthGrant],
) -> Result<(), BridgeError> {
    let mut content = String::new();
    for grant in grants {
        for repository in &grant.repositories {
            content.push_str(&format!(
                "https://x-access-token:{}@{GITHUB_HOST}/{repository}\n",
                grant.access_token
            ));
            content.push_str(&format!(
                "https://x-access-token:{}@{GITHUB_HOST}/{repository}.git\n",
                grant.access_token
            ));
        }
    }

    storage::atomic_write_private(credentials_file, content.as_bytes())
        .await
        .map_err(|error| {
            BridgeError::server(&format!("failed to write GitHub credentials: {error}"))
        })?;
    Ok(())
}
