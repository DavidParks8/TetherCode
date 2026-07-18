use crate::*;

pub(super) async fn send_rpc_error(
    state: &Arc<AppState>,
    client_id: u64,
    id: Value,
    code: i64,
    message: &str,
    data: Option<Value>,
) {
    let mut payload = json!({
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    });

    if let Some(data) = data {
        payload["error"]["data"] = data;
    }

    state.hub.send_json(client_id, payload).await;
}

pub(super) async fn send_overload_error(
    state: &Arc<AppState>,
    client_id: u64,
    id: Value,
    resource: &str,
    limit: usize,
) {
    send_rpc_error(
        state,
        client_id,
        id,
        RPC_SERVER_OVERLOADED,
        "Bridge request capacity is exhausted",
        Some(json!({
            "error": "overloaded",
            "resource": resource,
            "limit": limit,
            "retryable": true,
        })),
    )
    .await;
}

pub(super) fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub(super) fn is_unspecified_bind_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "0.0.0.0" | "::" | "[::]"
    )
}

pub(super) fn format_host_for_url(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.contains(':') && !trimmed.starts_with('[') && !trimmed.ends_with(']') {
        return format!("[{}]", trimmed);
    }
    trimmed.to_string()
}

pub(super) fn bridge_access_url(config: &BridgeConfig) -> Option<String> {
    if let Some(url) = config.connect_url.clone() {
        return Some(url);
    }

    if is_unspecified_bind_host(&config.host) {
        return None;
    }

    Some(format!(
        "http://{}:{}",
        format_host_for_url(&config.host),
        config.port
    ))
}

pub(super) fn build_pairing_payload(config: &BridgeConfig) -> Option<String> {
    let bridge_token = config.auth_token.clone()?;
    let bridge_url = bridge_access_url(config)?;

    Some(
        json!({
            "type": "clawdex-bridge-pair",
            "bridgeUrl": bridge_url,
            "bridgeToken": bridge_token,
        })
        .to_string(),
    )
}

pub(super) fn build_token_only_pairing_payload(config: &BridgeConfig) -> Option<String> {
    let bridge_token = config.auth_token.clone()?;

    Some(
        json!({
            "type": "clawdex-bridge-token",
            "bridgeToken": bridge_token,
        })
        .to_string(),
    )
}

pub(super) fn flush_pairing_output() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
}

pub(super) fn maybe_print_pairing_qr(config: &BridgeConfig) {
    if !config.show_pairing_qr {
        return;
    }

    if let Some(payload) = build_pairing_payload(config) {
        println!();
        println!("Bridge pairing QR (scan from mobile onboarding):");
        if let Err(error) = qr2term::print_qr(payload.as_bytes()) {
            eprintln!("failed to render pairing QR: {error}");
            flush_pairing_output();
            return;
        }
        println!("QR contains bridge URL + token for one-tap onboarding.");
        println!();
        flush_pairing_output();
        return;
    }

    let Some(payload) = build_token_only_pairing_payload(config) else {
        eprintln!("bridge token QR skipped because BRIDGE_AUTH_TOKEN is not set");
        flush_pairing_output();
        return;
    };

    println!();
    println!("Bridge token QR fallback (scan from mobile onboarding):");
    if let Err(error) = qr2term::print_qr(payload.as_bytes()) {
        eprintln!("failed to render pairing QR: {error}");
        flush_pairing_output();
        return;
    }
    println!(
        "Full pairing QR unavailable because no phone-connectable bridge URL was resolved. Enter URL manually in onboarding."
    );
    println!();
    flush_pairing_output();
}

pub(super) async fn wait_for_shutdown_trigger(shutdown_rx: &mut watch::Receiver<bool>) {
    if *shutdown_rx.borrow() {
        return;
    }

    while shutdown_rx.changed().await.is_ok() {
        if *shutdown_rx.borrow() {
            break;
        }
    }
}
