#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    future::Future,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, FromRequest, FromRequestParts, Multipart, Query, Request, State,
    },
    http::{
        header::{
            CACHE_CONTROL, CONNECTION, CONTENT_ENCODING, CONTENT_TYPE, COOKIE, HOST, LOCATION,
            ORIGIN, REFERER, REFERRER_POLICY, SET_COOKIE, UPGRADE, VARY,
        },
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client as HttpClient, Method as HttpMethod, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use services::{GitService, TerminalService, UpdateService};
#[cfg(test)]
use tokio::sync::oneshot;
use tokio::{
    fs,
    io::AsyncReadExt,
    sync::{mpsc, watch, Mutex, Notify, OwnedSemaphorePermit, RwLock, Semaphore},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as UpstreamWsMessage},
};
use uuid::Uuid;

mod acp;
mod agui;
#[allow(clippy::all)]
mod agui_generated;
mod attachments;
mod config;
mod health;
mod observability;
mod path_policy;
mod preview;
mod protocol_constants;
mod push;
mod replay;
mod resource_limits;
mod rpc;
mod services;
mod storage;

use attachments::{
    infer_image_content_type_from_path, save_multipart_attachment, ATTACHMENT_MULTIPART_MAX_BYTES,
};
use config::BridgeConfig;
use health::{
    bridge_status, BridgeDeviceConnection, BridgeOperationalStatus, BridgeStatus, QueueStatus,
};
use observability::OperationalMetrics;
use path_policy::{PathKind, PathPolicy};
use preview::{
    normalize_browser_preview_target_url, BrowserPreviewResolvedSession, BrowserPreviewService,
    BROWSER_PREVIEW_SESSION_TTL,
};
use push::{
    parse_push_event_preferences, token_suffix, truncate_chars, PushEventPreferences,
    PushRegistryStore,
};
use replay::NotificationReplay;
use resource_limits::{
    FILESYSTEM_LIST_MAX_ENTRIES, LOCAL_IMAGE_MAX_BYTES, NOTIFICATION_MAX_BYTES,
    PREVIEW_BUFFERED_RESPONSE_MAX_BYTES, PREVIEW_REQUEST_MAX_BYTES, PUSH_DEVICE_NAME_MAX_BYTES,
    PUSH_ID_MAX_BYTES, PUSH_PLATFORM_MAX_BYTES, PUSH_PREVIEW_MAX_BYTES, PUSH_PREVIEW_MAX_THREADS,
    PUSH_TOKEN_MAX_BYTES, QUEUE_MAX_BYTES_PER_THREAD, QUEUE_MAX_CONTENT_BYTES,
    QUEUE_MAX_ITEMS_PER_THREAD, QUEUE_MAX_ITEM_BYTES, REPLAY_MAX_BYTES, REPLAY_RESPONSE_MAX_BYTES,
    UI_SURFACE_MAX_ACTIONS, UI_SURFACE_MAX_BLOCKS, UI_SURFACE_MAX_BYTES,
    UI_SURFACE_MAX_ITEMS_PER_BLOCK, UI_SURFACE_MAX_TEXT_BYTES,
};
use rpc::{is_forwarded_method, parse_client_request_id, parse_request, RpcRequestParseError};

mod app_state;
mod bridge_protocol;
mod client_hub;
mod github_auth;
mod http_routes;
mod interaction_validation;
mod pairing;
mod preview_proxy;
mod push_delivery;
mod queue_service;
mod runtime_backend;
mod websocket_transport;
mod workspace_auth;

use agui::*;
use app_state::*;
use bridge_protocol::*;
use client_hub::*;
use github_auth::*;
use http_routes::*;
use interaction_validation::*;
use pairing::*;
use preview_proxy::*;
use protocol_constants::*;
use push_delivery::*;
use runtime_backend::*;
use websocket_transport::*;
use workspace_auth::*;

#[tokio::main]
async fn main() {
    let config = match BridgeConfig::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    if !config.auth_enabled && config.allow_insecure_no_auth {
        eprintln!(
            "bridge auth is disabled by BRIDGE_ALLOW_INSECURE_NO_AUTH=true (local development only)"
        );
    }
    if config.allow_query_token_auth {
        eprintln!(
            "query-token auth is enabled (BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true); prefer Authorization headers instead"
        );
    }

    let metrics = Arc::new(OperationalMetrics::new());
    let hub = Arc::new(ClientHub::new());
    let (bind_addr, listener, backend) =
        match bind_then_start_backend(&config.host, config.port, || {
            RuntimeBackend::start(&config, hub.clone(), metrics.clone())
        })
        .await
        {
            Ok(started) => started,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
    let path_policy = Arc::new(
        PathPolicy::new(config.workdir.clone(), config.allow_outside_root_cwd)
            .expect("validated bridge path policy"),
    );

    let terminal = Arc::new(TerminalService::new(
        path_policy.clone(),
        config.terminal_exec_policies.clone(),
    ));
    let git = Arc::new(GitService::new(terminal.clone(), path_policy.clone()));
    let updater = Arc::new(UpdateService::discover());
    let preview = Arc::new(BrowserPreviewService::new(
        config.port,
        config.preview_port,
        config.preview_connect_url.clone(),
        config.connect_url.clone(),
    ));
    let queue = BridgeQueueService::new(backend.clone(), hub.clone());

    let project_label = config
        .workdir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Clawdex".to_string());
    let push = PushService::load(&config.workdir, project_label, metrics.clone()).await;
    push.spawn_event_loop_with_queue(&hub, backend.clone(), Some(queue.clone()));

    let state = Arc::new(AppState {
        config: config.clone(),
        path_policy,
        started_at: Instant::now(),
        hub,
        backend,
        queue,
        thread_create_results: Arc::new(Mutex::new(HashMap::new())),
        thread_create_order: Arc::new(Mutex::new(VecDeque::new())),
        thread_create_actor: Arc::new(Mutex::new(())),
        approval_resolution_results: Arc::new(Mutex::new(HashMap::new())),
        approval_resolution_order: Arc::new(Mutex::new(VecDeque::new())),
        approval_resolution_actor: Arc::new(Mutex::new(())),
        thread_list_streams: Arc::new(Mutex::new(HashMap::new())),
        terminal,
        git,
        updater,
        preview,
        push,
        ws_global_in_flight: Arc::new(Semaphore::new(config.ws_limits.global_in_flight)),
        metrics,
    });

    let app = build_bridge_router(state.clone());
    let preview_app = build_preview_router(state.clone());

    let preview_bind_addr = format!("{}:{}", config.preview_host, config.preview_port);
    let preview_listener = match tokio::net::TcpListener::bind(&preview_bind_addr).await {
        Ok(listener) => {
            state.preview.set_available(true);
            Some(listener)
        }
        Err(error) => {
            eprintln!("browser preview disabled: failed to bind {preview_bind_addr}: {error}");
            None
        }
    };

    println!("rust-bridge listening on {bind_addr}");
    if preview_listener.is_some() {
        println!("browser preview listening on {preview_bind_addr}");
    }
    if let Some(connect_url) = bridge_access_url(&config) {
        let bind_url = format!(
            "http://{}:{}",
            format_host_for_url(&config.host),
            config.port
        );
        if connect_url != bind_url {
            println!("bridge connect URL: {connect_url}");
        }
    }
    maybe_print_pairing_qr(&config);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let preview_task = preview_listener.map(|listener| {
        let mut preview_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let serve_result = axum::serve(listener, preview_app)
                .with_graceful_shutdown(async move {
                    wait_for_shutdown_trigger(&mut preview_shutdown_rx).await;
                })
                .await;
            if let Err(error) = serve_result {
                eprintln!("browser preview server error: {error}");
            }
        })
    });
    let shutdown_backend = state.backend.clone();
    let shutdown_signal_tx = shutdown_tx.clone();
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let signal = wait_for_shutdown_signal().await;
            eprintln!("shutdown signal received ({signal}), terminating managed backends");
            let _ = shutdown_signal_tx.send(true);
            shutdown_backend.shutdown().await;
        })
        .await;

    let _ = shutdown_tx.send(true);
    state.backend.shutdown().await;
    if let Some(task) = preview_task {
        let _ = task.await;
    }

    if let Err(error) = serve_result {
        eprintln!("server error: {error}");
        std::process::exit(1);
    }
}

async fn bind_then_start_backend<T, Start, StartFuture>(
    host: &str,
    port: u16,
    start_backend: Start,
) -> Result<(String, tokio::net::TcpListener, T), String>
where
    Start: FnOnce() -> StartFuture,
    StartFuture: Future<Output = Result<T, String>>,
{
    let bind_addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|error| format!("failed to bind {bind_addr}: {error}"))?;
    let backend = start_backend().await?;
    Ok((bind_addr, listener, backend))
}
