use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserPreviewCreateRequest {
    pub(super) target_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserPreviewCloseRequest {
    pub(super) session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexAuthCallbackForwardRequest {
    pub(super) callback_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct CursorApiKeyInfo {
    pub(super) api_key_name: String,
    pub(super) created_at: String,
    pub(super) user_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum CursorCredentialSource {
    Env,
}

#[derive(Debug, Clone)]
pub(super) struct CursorRuntimeCredential {
    pub(super) api_key: String,
    pub(super) source: CursorCredentialSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CursorCredentialStatus {
    pub(super) configured: bool,
    pub(super) valid: Option<bool>,
    pub(super) source: Option<CursorCredentialSource>,
    pub(super) api_key_name: Option<String>,
    pub(super) user_email: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) enabled: bool,
    pub(super) runtime_available: bool,
    pub(super) active: bool,
    pub(super) error: Option<String>,
}

pub(super) async fn start_cursor_app_server_from_config(
    config: &Arc<BridgeConfig>,
    hub: Arc<ClientHub>,
    metrics: Arc<OperationalMetrics>,
) -> Result<Arc<AppServerBridge>, String> {
    let credential = resolve_cursor_runtime_credential()
        .await
        .map_err(|error| error.message)?;
    AppServerBridge::start_cursor(
        &config.cursor_app_server_bin,
        &credential.api_key,
        &config.workdir,
        hub,
        metrics,
    )
    .await
}

pub(super) async fn resolve_cursor_runtime_credential(
) -> Result<CursorRuntimeCredential, BridgeError> {
    if let Some(api_key) = read_non_empty_env("CURSOR_API_KEY") {
        return Ok(CursorRuntimeCredential {
            api_key,
            source: CursorCredentialSource::Env,
        });
    }

    Err(BridgeError::server(
        "CURSOR_API_KEY is required for Cursor; run clawdex init with Cursor selected to save it in .env.secure",
    ))
}

pub(super) async fn read_cursor_credential_status(
    state: &Arc<AppState>,
) -> Result<CursorCredentialStatus, BridgeError> {
    let enabled = state
        .config
        .enabled_engines
        .contains(&BridgeRuntimeEngine::Cursor);
    let active = state.backend.engine() == BridgeRuntimeEngine::Cursor;
    let runtime_available = state.backend.cursor_backend().is_some();

    let credential = match resolve_cursor_runtime_credential().await {
        Ok(credential) => credential,
        Err(error) => {
            return Ok(CursorCredentialStatus {
                configured: false,
                valid: None,
                source: None,
                api_key_name: None,
                user_email: None,
                created_at: None,
                enabled,
                runtime_available,
                active,
                error: Some(error.message),
            });
        }
    };

    match validate_cursor_api_key(&credential.api_key).await {
        Ok(info) => Ok(CursorCredentialStatus {
            configured: true,
            valid: Some(true),
            source: Some(credential.source),
            api_key_name: Some(info.api_key_name),
            user_email: info.user_email,
            created_at: Some(info.created_at),
            enabled,
            runtime_available,
            active,
            error: None,
        }),
        Err(error) => Ok(CursorCredentialStatus {
            configured: true,
            valid: Some(false),
            source: Some(credential.source),
            api_key_name: None,
            user_email: None,
            created_at: None,
            enabled,
            runtime_available,
            active,
            error: Some(error.message),
        }),
    }
}

pub(super) async fn validate_cursor_api_key(
    api_key: &str,
) -> Result<CursorApiKeyInfo, BridgeError> {
    let response = HttpClient::new()
        .get(format!("{CURSOR_API_BASE_URL}/v0/me"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| {
            BridgeError::server(&format!("failed to validate Cursor API key: {error}"))
        })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(BridgeError::server("Cursor API key was rejected by Cursor"));
    }
    if !status.is_success() {
        return Err(BridgeError::server(&format!(
            "Cursor API key validation failed with HTTP {status}"
        )));
    }

    response
        .json::<CursorApiKeyInfo>()
        .await
        .map_err(|error| BridgeError::server(&format!("invalid Cursor API key response: {error}")))
}
