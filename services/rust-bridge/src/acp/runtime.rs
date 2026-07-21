use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, CreateElicitationRequest,
    ElicitationCapabilities, ElicitationContentValue, ElicitationFormCapabilities,
    InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    RequestPermissionRequest, ResumeSessionRequest, ResumeSessionResponse, SessionId,
    SessionNotification,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Client, ConnectTo, JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};

use super::config::{ResolvedAgentManifest, RuntimeManifestError};
use super::events::CanonicalEvent;
use super::interactions::{
    InteractionError, InteractionRegistry, PendingElicitationSummary, PendingPermissionSummary,
};
use super::session::{AcpSession, ReconstructionError, SessionRegistry, SessionRouteError};

const COMMAND_BUFFER: usize = 64;
pub const STEER_METHOD: &str = "_tethercode.dev/session/steer";
const STEER_EXTENSION_VERSION: u64 = 1;
const MAX_EXTENSION_METADATA_BYTES: usize = 4 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SteerExtensionMetadata {
    #[serde(rename = "tethercode.dev")]
    tethercode_dev: SteerExtension,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SteerExtension {
    version: u64,
    capabilities: SteerCapabilities,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SteerCapabilities {
    #[serde(rename = "sessionSteer")]
    session_steer: SessionSteerCapability,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionSteerCapability {
    method: String,
    version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonRpcRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[request(method = "_tethercode.dev/session/steer", response = SteerResponse)]
pub struct SteerRequest {
    pub session_id: SessionId,
    pub expected_run_id: String,
    pub expected_source_turn_id: String,
    pub prompt_generation: u64,
    pub prompt: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteerResponse {
    pub accepted: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AcpRuntimeError {
    #[error(transparent)]
    Manifest(#[from] RuntimeManifestError),
    #[error("ACP initialization timed out")]
    InitializeTimeout,
    #[error("ACP connection closed: {0}")]
    Connection(String),
    #[error("ACP connection task ended unexpectedly")]
    ConnectionTaskEnded,
    #[error("ACP command queue is closed")]
    CommandQueueClosed,
    #[error("ACP command response was dropped")]
    CommandResponseDropped,
    #[error("ACP request timed out")]
    RequestTimeout,
    #[error("ACP client request cancelled")]
    RequestCancelled,
    #[error("ACP operation is unsupported: {0}")]
    Unsupported(&'static str),
    #[error("unknown ACP session: {0}")]
    UnknownSession(String),
    #[error("ACP session already has an active prompt")]
    SessionBusy,
    #[error(transparent)]
    SessionRoute(#[from] SessionRouteError),
    #[error(transparent)]
    Interaction(#[from] InteractionError),
}

#[derive(Clone)]
pub struct RequestCancellation {
    sender: watch::Sender<bool>,
}

impl Default for RequestCancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

impl RequestCancellation {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        while !*receiver.borrow_and_update() {
            receiver
                .changed()
                .await
                .expect("request cancellation sender remains alive");
        }
    }
}

#[derive(Debug, Clone)]
pub struct NegotiatedInitialize {
    pub response: InitializeResponse,
}

impl NegotiatedInitialize {
    pub fn supports_session_list(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .list
            .is_some()
    }

    pub fn supports_session_load(&self) -> bool {
        self.response.agent_capabilities.load_session
    }

    pub fn supports_session_resume(&self) -> bool {
        self.response
            .agent_capabilities
            .session_capabilities
            .resume
            .is_some()
    }

    pub fn supports_session_steer(&self) -> bool {
        let Some(meta) = self.response.meta.as_ref() else {
            return false;
        };
        if serde_json::to_vec(meta).map_or(true, |bytes| bytes.len() > MAX_EXTENSION_METADATA_BYTES)
        {
            return false;
        }
        let Ok(metadata) =
            serde_json::to_value(meta).and_then(serde_json::from_value::<SteerExtensionMetadata>)
        else {
            return false;
        };
        metadata.tethercode_dev.version == STEER_EXTENSION_VERSION
            && metadata.tethercode_dev.capabilities.session_steer.method == STEER_METHOD
            && metadata.tethercode_dev.capabilities.session_steer.version == STEER_EXTENSION_VERSION
    }
}

#[derive(Clone)]
pub struct AcpConnection {
    #[cfg(test)]
    agent_id: Arc<str>,
    commands: mpsc::Sender<Command>,
    negotiated: Arc<NegotiatedInitialize>,
    shutdown: watch::Sender<bool>,
    failure: watch::Receiver<Option<String>>,
    sessions: SessionRegistry,
    interactions: InteractionRegistry,
    requested_shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptAdmission {
    pub run_id: String,
    pub source_turn_id: String,
    pub generation: u64,
}

async fn finish_cancel_attempt(
    session: Option<AcpSession>,
    generation: Option<u64>,
    result: &Result<(), AcpRuntimeError>,
) {
    let (Err(error), Some(session), Some(generation)) = (result, session, generation) else {
        return;
    };
    let Some((run_id, source_turn_id, active_generation)) = session.operation().await else {
        return;
    };
    if active_generation == generation {
        session
            .fail_generation(run_id, source_turn_id, generation, error.to_string())
            .await;
    }
}

impl AcpConnection {
    pub async fn start(
        manifest: &ResolvedAgentManifest,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        initialize_timeout: Duration,
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError> {
        Self::start_transport(
            manifest.agent_id.clone(),
            manifest.acp_agent(approved_roots, host_environment)?,
            initialize_timeout,
        )
        .await
    }

    pub(super) async fn start_transport<T>(
        agent_id: String,
        transport: T,
        initialize_timeout: Duration,
    ) -> Result<(Self, NegotiatedInitialize), AcpRuntimeError>
    where
        T: ConnectTo<Client> + Send + 'static,
    {
        #[cfg(test)]
        let connection_agent_id: Arc<str> = Arc::from(agent_id.clone());
        let (ready_tx, mut ready_rx) = mpsc::channel(1);
        let (commands, mut command_rx) = mpsc::channel::<Command>(COMMAND_BUFFER);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (failure_tx, failure) = watch::channel(None);
        let sessions = SessionRegistry::default();
        let interactions = InteractionRegistry::new(sessions.clone());
        let actor_sessions = sessions.clone();
        let actor_interactions = interactions.clone();
        let requested_shutdown = Arc::new(AtomicBool::new(false));
        let actor_requested_shutdown = requested_shutdown.clone();
        tokio::spawn(async move {
            let ready_for_initialize = ready_tx.clone();
            let notification_sessions = actor_sessions.clone();
            let notification_agent_id = agent_id.clone();
            let connection_sessions = actor_sessions.clone();
            let command_interactions = actor_interactions.clone();
            let permission_interactions = actor_interactions.clone();
            let elicitation_interactions = actor_interactions.clone();
            let result = Client
                .builder()
                .on_receive_notification(
                    async move |notification: SessionNotification, _| {
                        notification_sessions
                            .route(&notification_agent_id, notification)
                            .await
                            .map_err(|error| {
                                agent_client_protocol::util::internal_error(error.to_string())
                            })?;
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _| {
                        permission_interactions
                            .register_permission(request, responder)
                            .await
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: CreateElicitationRequest, responder, _| {
                        elicitation_interactions
                            .register_elicitation(request, responder)
                            .await
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(transport, async move |connection| {
                let capabilities = ClientCapabilities::new().elicitation(
                    ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                );
                let response = tokio::time::timeout(
                    initialize_timeout,
                    connection.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities)).block_task(),
                )
                .await
                .map_err(|_| agent_client_protocol::util::internal_error("ACP initialization timed out"))??;
                let negotiated = NegotiatedInitialize { response };
                let _ = ready_for_initialize.send(Ok(negotiated.clone())).await;
                loop {
                    tokio::select! {
                        changed = shutdown_rx.changed() => {
                            changed.map_err(|_| agent_client_protocol::util::internal_error("ACP shutdown channel closed"))?;
                            break;
                        }
                        command = command_rx.recv() => match command {
                            Some(command) => command.dispatch(&connection, initialize_timeout, &agent_id, &connection_sessions, &command_interactions).await,
                            None => break,
                        },
                    }
                }
                Ok(())
            }).await;
            actor_interactions.drain().await;
            if let Err(error) = result {
                let message = error.to_string();
                let _ = ready_tx
                    .send(Err(AcpRuntimeError::Connection(message.clone())))
                    .await;
                if !actor_requested_shutdown.load(Ordering::SeqCst) {
                    let _ = failure_tx.send(Some(message.clone()));
                    for session in actor_sessions.all().await {
                        session.fail_active(message.clone()).await;
                    }
                }
            }
        });
        match tokio::time::timeout(initialize_timeout, ready_rx.recv()).await {
            Ok(Some(Ok(negotiated))) => Ok((
                Self {
                    #[cfg(test)]
                    agent_id: connection_agent_id,
                    commands,
                    negotiated: Arc::new(negotiated.clone()),
                    shutdown,
                    failure,
                    sessions,
                    interactions,
                    requested_shutdown,
                },
                negotiated,
            )),
            Ok(Some(Err(error))) => Err(error),
            Ok(None) => Err(AcpRuntimeError::ConnectionTaskEnded),
            Err(_) => Err(AcpRuntimeError::InitializeTimeout),
        }
    }

    pub fn negotiated(&self) -> &NegotiatedInitialize {
        &self.negotiated
    }

    pub fn failure_message(&self) -> Option<String> {
        self.failure.borrow().clone()
    }

    #[cfg(test)]
    pub async fn new_session(
        &self,
        request: NewSessionRequest,
    ) -> Result<NewSessionResponse, AcpRuntimeError> {
        self.new_session_with_cancellation(request, RequestCancellation::default())
            .await
    }

    pub async fn new_session_with_cancellation(
        &self,
        request: NewSessionRequest,
        cancellation: RequestCancellation,
    ) -> Result<NewSessionResponse, AcpRuntimeError> {
        let reservation = self.sessions.reserve().await?;
        let result = self
            .call(|response| Command::NewSession {
                request,
                cancellation,
                reservation,
                response,
            })
            .await;
        self.sessions.release_reservation(reservation).await;
        result
    }

    pub async fn list_sessions(
        &self,
        request: ListSessionsRequest,
    ) -> Result<ListSessionsResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_list() {
            return Err(AcpRuntimeError::Unsupported("session/list"));
        }
        self.call(|response| Command::ListSessions { request, response })
            .await
    }

    pub async fn load_session(
        &self,
        request: LoadSessionRequest,
    ) -> Result<LoadSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_load() {
            return Err(AcpRuntimeError::Unsupported("session/load"));
        }
        self.call(|response| Command::LoadSession { request, response })
            .await
    }

    pub async fn resume_session(
        &self,
        request: ResumeSessionRequest,
    ) -> Result<ResumeSessionResponse, AcpRuntimeError> {
        if !self.negotiated.supports_session_resume() {
            return Err(AcpRuntimeError::Unsupported("session/resume"));
        }
        self.call(|response| Command::ResumeSession { request, response })
            .await
    }

    pub async fn prompt(
        &self,
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
    ) -> Result<PromptAdmission, AcpRuntimeError> {
        if self.sessions.get(&request.session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(
                request.session_id.to_string(),
            ));
        }
        self.call(|response| Command::Prompt {
            request,
            run_id,
            source_turn_id,
            response,
        })
        .await
    }

    pub async fn cancel(
        &self,
        session_id: agent_client_protocol::schema::v1::SessionId,
    ) -> Result<(), AcpRuntimeError> {
        if self.sessions.get(&session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        let (generation, interaction_errors) = self.interactions.cancel_session(&session_id).await;
        for error in interaction_errors {
            eprintln!("ACP interaction cancellation response failed: {error}");
        }
        let session = self.sessions.get(&session_id).await;
        let result = self
            .call(|response| Command::Cancel {
                session_id: session_id.clone(),
                response,
            })
            .await;
        finish_cancel_attempt(session, generation, &result).await;
        result
    }

    pub async fn cancel_turn(
        &self,
        session_id: agent_client_protocol::schema::v1::SessionId,
        expected_source_turn_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        let session = self
            .sessions
            .get(&session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        if session.snapshot().await.active_source_turn_id.as_deref()
            != Some(expected_source_turn_id)
        {
            return Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation",
            ));
        }
        self.cancel(session_id).await
    }

    pub async fn pending_permissions(&self) -> Vec<PendingPermissionSummary> {
        self.interactions.pending_permissions().await
    }

    pub async fn resolve_permission(
        &self,
        thread_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .resolve_permission(thread_id, request_id, option_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_permission(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .cancel_permission(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn pending_elicitations(&self) -> Vec<PendingElicitationSummary> {
        self.interactions.pending_elicitations().await
    }

    pub async fn accept_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        values: BTreeMap<String, ElicitationContentValue>,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .accept_elicitation(thread_id, request_id, values)
            .await?;
        Ok(())
    }

    pub async fn decline_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .decline_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.interactions
            .cancel_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn prepare_steer(
        &self,
        session_id: &agent_client_protocol::schema::v1::SessionId,
    ) -> Result<u64, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self.interactions.prepare_steer(session_id).await?)
    }

    pub async fn verify_steer_epoch(
        &self,
        session_id: &agent_client_protocol::schema::v1::SessionId,
        epoch: u64,
    ) -> Result<bool, AcpRuntimeError> {
        if self.sessions.get(session_id).await.is_none() {
            return Err(AcpRuntimeError::UnknownSession(session_id.to_string()));
        }
        Ok(self
            .interactions
            .verify_steer_epoch(session_id, epoch)
            .await)
    }

    pub async fn steer(
        &self,
        request: SteerRequest,
        interaction_epoch: u64,
    ) -> Result<(), AcpRuntimeError> {
        if !self.negotiated.supports_session_steer() {
            return Err(AcpRuntimeError::Unsupported(STEER_METHOD));
        }
        let session = self
            .sessions
            .get(&request.session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(request.session_id.to_string()))?;
        let snapshot = session.snapshot().await;
        if snapshot.active_run_id.as_deref() != Some(request.expected_run_id.as_str())
            || snapshot.active_source_turn_id.as_deref()
                != Some(request.expected_source_turn_id.as_str())
            || snapshot.active_generation != Some(request.prompt_generation)
        {
            return Err(AcpRuntimeError::Unsupported("stale steer correlation"));
        }
        let response = self
            .call(|response| Command::Steer {
                request,
                interaction_epoch,
                response,
            })
            .await?;
        if !response.accepted {
            return Err(AcpRuntimeError::Unsupported("steer was not accepted"));
        }
        Ok(())
    }

    pub async fn session(
        &self,
        session_id: &agent_client_protocol::schema::v1::SessionId,
    ) -> Option<AcpSession> {
        self.sessions.get(session_id).await
    }

    #[cfg(test)]
    pub async fn ensure_session(
        &self,
        session_id: agent_client_protocol::schema::v1::SessionId,
    ) -> Result<AcpSession, AcpRuntimeError> {
        self.sessions
            .register(&self.agent_id, session_id)
            .await
            .map_err(Into::into)
    }

    #[cfg(test)]
    pub async fn evict_session(&self, session_id: &agent_client_protocol::schema::v1::SessionId) {
        self.sessions.remove(session_id).await;
    }

    pub async fn loaded_sessions(&self) -> Vec<AcpSession> {
        let mut loaded = Vec::new();
        for session in self.sessions.all().await {
            if !session.snapshot().await.history_reconstruction {
                loaded.push(session);
            }
        }
        loaded
    }

    async fn call<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, AcpRuntimeError>>) -> Command,
    ) -> Result<T, AcpRuntimeError> {
        if let Some(message) = self.failure.borrow().clone() {
            return Err(AcpRuntimeError::Connection(message));
        }
        let (response_tx, mut response_rx) = oneshot::channel();
        self.commands
            .send(make(response_tx))
            .await
            .map_err(|_| AcpRuntimeError::CommandQueueClosed)?;
        let mut failure = self.failure.clone();
        tokio::select! {
            response = &mut response_rx => response.map_err(|_| AcpRuntimeError::CommandResponseDropped)?,
            changed = failure.changed() => {
                changed.map_err(|_| AcpRuntimeError::ConnectionTaskEnded)?;
                Err(AcpRuntimeError::Connection(failure.borrow().clone().unwrap_or_else(|| "connection closed".to_string())))
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), AcpRuntimeError> {
        self.requested_shutdown.store(true, Ordering::SeqCst);
        self.interactions.drain().await;
        for session in self.sessions.all().await {
            session
                .fail_active("ACP connection shut down".to_string())
                .await;
        }
        self.shutdown
            .send(true)
            .map_err(|_| AcpRuntimeError::ConnectionTaskEnded)
    }
}

enum Command {
    NewSession {
        request: NewSessionRequest,
        cancellation: RequestCancellation,
        reservation: u64,
        response: oneshot::Sender<Result<NewSessionResponse, AcpRuntimeError>>,
    },
    ListSessions {
        request: ListSessionsRequest,
        response: oneshot::Sender<Result<ListSessionsResponse, AcpRuntimeError>>,
    },
    LoadSession {
        request: LoadSessionRequest,
        response: oneshot::Sender<Result<LoadSessionResponse, AcpRuntimeError>>,
    },
    ResumeSession {
        request: ResumeSessionRequest,
        response: oneshot::Sender<Result<ResumeSessionResponse, AcpRuntimeError>>,
    },
    Prompt {
        request: PromptRequest,
        run_id: String,
        source_turn_id: String,
        response: oneshot::Sender<Result<PromptAdmission, AcpRuntimeError>>,
    },
    Cancel {
        session_id: agent_client_protocol::schema::v1::SessionId,
        response: oneshot::Sender<Result<(), AcpRuntimeError>>,
    },
    Steer {
        request: SteerRequest,
        interaction_epoch: u64,
        response: oneshot::Sender<Result<SteerResponse, AcpRuntimeError>>,
    },
}

impl Command {
    async fn dispatch(
        self,
        connection: &agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
        request_timeout: Duration,
        agent_id: &str,
        sessions: &SessionRegistry,
        interactions: &InteractionRegistry,
    ) {
        macro_rules! dispatch_ordinary {
            ($request:expr, $cancellation:expr, $response:expr, $after:expr) => {{
                let sent = connection.send_request($request);
                let cancellation = $cancellation;
                let sessions = sessions.clone();
                let agent_id = agent_id.to_string();
                let _ = connection.spawn(async move {
                    let mut request = Box::pin(sent.block_task());
                    let result = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => Err(AcpRuntimeError::RequestCancelled),
                        result = tokio::time::timeout(request_timeout, &mut request) => match result {
                            Ok(Ok(value)) => Ok(value),
                            Ok(Err(error)) => Err(AcpRuntimeError::Connection(error.to_string())),
                            Err(_) => Err(AcpRuntimeError::RequestTimeout),
                        }
                    };
                    drop(request);
                    let result = $after(result, sessions, agent_id).await;
                    let _ = $response.send(result);
                    Ok(())
                });
            }};
        }
        match self {
            Self::NewSession {
                request,
                cancellation,
                reservation,
                response,
            } => dispatch_ordinary!(
                request,
                cancellation,
                response,
                |result: Result<NewSessionResponse, AcpRuntimeError>,
                 sessions: SessionRegistry,
                 agent_id: String| async move {
                    if let Ok(value) = &result {
                        sessions
                            .register_reserved(&agent_id, value.session_id.clone(), reservation)
                            .await?;
                    } else {
                        sessions.release_reservation(reservation).await;
                    }
                    result
                }
            ),
            Self::ListSessions { request, response } => dispatch_ordinary!(
                request,
                RequestCancellation::default(),
                response,
                |result: Result<ListSessionsResponse, AcpRuntimeError>,
                 _: SessionRegistry,
                 _: String| async move { result }
            ),
            Self::LoadSession { request, response } => {
                let session_id = request.session_id.clone();
                let session = sessions
                    .register_with_freshness(agent_id, request.session_id.clone())
                    .await
                    .map_err(AcpRuntimeError::from);
                let Ok((session, fresh)) = session else {
                    let _ = response.send(session.map(|_| LoadSessionResponse::new()));
                    return;
                };
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let reconstruction = if fresh {
                    Ok(session.begin_initial_reconstruction().await)
                } else {
                    session.begin_reconstruction().await
                };
                let reconstruction = match reconstruction {
                    Ok(reconstruction) => reconstruction,
                    Err(ReconstructionError::Busy | ReconstructionError::Cancelled) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<LoadSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        let succeeded = result.is_ok();
                        reconstruction.finish(succeeded).await;
                        drop(session_lease);
                        if fresh && !succeeded {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
            }
            Self::ResumeSession { request, response } => {
                let session_id = request.session_id.clone();
                let session = sessions
                    .register_with_freshness(agent_id, request.session_id.clone())
                    .await
                    .map_err(AcpRuntimeError::from);
                let Ok((session, fresh)) = session else {
                    let _ = response.send(session.map(|_| ResumeSessionResponse::new()));
                    return;
                };
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let reconstruction = if fresh {
                    Ok(session.begin_initial_reconstruction().await)
                } else {
                    session.begin_reconstruction().await
                };
                let reconstruction = match reconstruction {
                    Ok(reconstruction) => reconstruction,
                    Err(ReconstructionError::Busy | ReconstructionError::Cancelled) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                dispatch_ordinary!(
                    request,
                    RequestCancellation::default(),
                    response,
                    move |result: Result<ResumeSessionResponse, AcpRuntimeError>,
                          sessions: SessionRegistry,
                          _: String| async move {
                        let succeeded = result.is_ok();
                        reconstruction.finish(succeeded).await;
                        drop(session_lease);
                        if fresh && !succeeded {
                            sessions.remove(&session_id).await;
                        }
                        result
                    }
                );
            }
            Self::Prompt {
                request,
                run_id,
                source_turn_id,
                response,
            } => {
                let Some(session_lease) = sessions.lease(&request.session_id).await else {
                    let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                    return;
                };
                let session = session_lease.session().clone();
                let admission = match session
                    .admit_prompt(run_id.clone(), source_turn_id.clone())
                    .await
                {
                    Ok((generation, _)) => PromptAdmission {
                        run_id,
                        source_turn_id,
                        generation,
                    },
                    Err(_) => {
                        let _ = response.send(Err(AcpRuntimeError::SessionBusy));
                        return;
                    }
                };
                drop(session_lease);
                let snapshot = session.snapshot().await;
                let message_id =
                    format!("{}::user::{}", snapshot.thread_id, admission.source_turn_id);
                for block in &request.prompt {
                    let (content, content_block) = match block {
                        ContentBlock::Text(text) => (text.text.clone(), None),
                        block => (String::new(), serde_json::to_value(block).ok()),
                    };
                    session
                        .emit(CanonicalEvent::MessageChunk {
                            agent_id: snapshot.agent_id.clone(),
                            thread_id: snapshot.thread_id.clone(),
                            run_id: Some(admission.run_id.clone()),
                            source_turn_id: Some(admission.source_turn_id.clone()),
                            generation: Some(admission.generation),
                            role: super::events::MessageRole::User,
                            message_id: message_id.clone(),
                            content,
                            content_block,
                        })
                        .await;
                }
                let callback_session = session.clone();
                let callback_admission = admission.clone();
                let registration = connection.send_request(request).on_receiving_result(
                    move |result| async move {
                        let snapshot = callback_session.snapshot().await;
                        let event = match result {
                            Ok(prompt) => CanonicalEvent::RunFinished {
                                agent_id: snapshot.agent_id,
                                thread_id: snapshot.thread_id,
                                run_id: callback_admission.run_id,
                                source_turn_id: callback_admission.source_turn_id,
                                generation: callback_admission.generation,
                                stop_reason: prompt.stop_reason,
                            },
                            Err(error) => CanonicalEvent::RunFailed {
                                agent_id: snapshot.agent_id,
                                thread_id: snapshot.thread_id,
                                run_id: callback_admission.run_id,
                                source_turn_id: callback_admission.source_turn_id,
                                generation: callback_admission.generation,
                                message: error.to_string(),
                            },
                        };
                        callback_session.emit(event).await;
                        Ok(())
                    },
                );
                match registration {
                    Ok(()) => {
                        let _ = response.send(Ok(admission));
                    }
                    Err(error) => {
                        session.fail_active(error.to_string()).await;
                        let _ = response.send(Err(AcpRuntimeError::Connection(error.to_string())));
                    }
                }
            }
            Self::Cancel {
                session_id,
                response,
            } => {
                let result = connection
                    .send_notification(CancelNotification::new(session_id))
                    .map_err(|error| AcpRuntimeError::Connection(error.to_string()));
                let _ = response.send(result);
            }
            Self::Steer {
                request,
                interaction_epoch,
                response,
            } => {
                let session_id = request.session_id.clone();
                let sent = interactions
                    .with_verified_steer_epoch(&session_id, interaction_epoch, || {
                        connection.send_request(request)
                    })
                    .await;
                let Some(sent) = sent else {
                    let _ =
                        response.send(Err(AcpRuntimeError::Unsupported("stale interaction epoch")));
                    return;
                };
                let _ = connection.spawn(async move {
                    let result =
                        match tokio::time::timeout(request_timeout, sent.block_task()).await {
                            Ok(Ok(value)) => Ok(value),
                            Ok(Err(error)) => Err(AcpRuntimeError::Connection(error.to_string())),
                            Err(_) => Err(AcpRuntimeError::RequestTimeout),
                        };
                    let _ = response.send(result);
                    Ok(())
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex as StdMutex;

    use agent_client_protocol::schema::v1::{
        AgentCapabilities, BooleanPropertySchema, CreateElicitationResponse, ElicitationAction,
        ElicitationFormMode, ElicitationRequestScope, ElicitationSchema, ElicitationSessionScope,
        IntegerPropertySchema, ListSessionsResponse, LoadSessionResponse,
        MultiSelectPropertySchema, NewSessionResponse, NumberPropertySchema, PermissionOption,
        PermissionOptionKind, PromptResponse, RequestPermissionOutcome, RequestPermissionResponse,
        ResumeSessionResponse, SessionCapabilities, SessionInfo, SessionListCapabilities,
        SessionResumeCapabilities, SessionUpdate, StopReason, StringPropertySchema, ToolCallStatus,
        ToolCallUpdate, ToolCallUpdateFields, ToolKind,
    };
    use agent_client_protocol::{Agent, Client, ConnectTo, Responder};

    #[derive(Clone)]
    enum TestInteraction {
        Permission(RequestPermissionRequest, bool),
        Elicitation(CreateElicitationRequest, bool),
    }

    enum ObservedInteraction {
        Permission(Result<RequestPermissionResponse, String>),
        Elicitation(Result<CreateElicitationResponse, String>),
    }

    struct PendingInteractionFixture {
        connection: AcpConnection,
        events: crate::acp::events::CanonicalEventReceiver,
        session_id: agent_client_protocol::schema::v1::SessionId,
        observed: mpsc::UnboundedReceiver<ObservedInteraction>,
        prompt_responder: Arc<StdMutex<Option<Responder<PromptResponse>>>>,
    }

    fn interaction_agent(
        interaction: TestInteraction,
        observed: mpsc::UnboundedSender<ObservedInteraction>,
        prompt_responder: Arc<StdMutex<Option<Responder<PromptResponse>>>>,
    ) -> impl ConnectTo<Client> {
        Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: PromptRequest, responder, connection| {
                    *prompt_responder.lock().expect("prompt responder lock") = Some(responder);
                    match interaction.clone() {
                        TestInteraction::Permission(request, cancel_from_agent) => {
                            let sent = connection.send_request(request);
                            if cancel_from_agent {
                                sent.cancel()?;
                            }
                            sent.on_receiving_result({
                                let observed = observed.clone();
                                async move |result| {
                                    let _ = observed.send(ObservedInteraction::Permission(
                                        result.map_err(|error| error.to_string()),
                                    ));
                                    Ok(())
                                }
                            })?;
                        }
                        TestInteraction::Elicitation(request, cancel_from_agent) => {
                            let sent = connection.send_request(request);
                            if cancel_from_agent {
                                sent.cancel()?;
                            }
                            sent.on_receiving_result({
                                let observed = observed.clone();
                                async move |result| {
                                    let _ = observed.send(ObservedInteraction::Elicitation(
                                        result.map_err(|error| error.to_string()),
                                    ));
                                    Ok(())
                                }
                            })?;
                        }
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            )
    }

    async fn start_pending_interaction_for_agent(
        agent_id: &str,
        interaction: TestInteraction,
    ) -> PendingInteractionFixture {
        let (observed_tx, observed) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None));
        let agent = interaction_agent(interaction, observed_tx, prompt_responder.clone());
        let (connection, _) =
            AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
                .await
                .expect("interaction agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "interaction-run".to_string(),
                "interaction-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        PendingInteractionFixture {
            connection,
            events,
            session_id: created.session_id,
            observed,
            prompt_responder,
        }
    }

    async fn start_pending_interaction(interaction: TestInteraction) -> PendingInteractionFixture {
        start_pending_interaction_for_agent("test-agent", interaction).await
    }

    fn permission_request(options: Vec<PermissionOption>) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "interaction-session",
            ToolCallUpdate::new(
                "tool-1",
                ToolCallUpdateFields::new()
                    .title("Write file")
                    .kind(ToolKind::Edit)
                    .status(ToolCallStatus::Pending),
            ),
            options,
        )
    }

    fn permission_options() -> Vec<PermissionOption> {
        vec![
            PermissionOption::new("allow-once", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject-once", "Reject", PermissionOptionKind::RejectOnce),
        ]
    }

    async fn requested_event(
        events: &mut crate::acp::events::CanonicalEventReceiver,
        permission: bool,
    ) {
        loop {
            let event = events.recv().await.expect("interaction event");
            if permission && matches!(event, CanonicalEvent::PermissionRequested { .. }) {
                return;
            }
            if !permission && matches!(event, CanonicalEvent::ElicitationRequested { .. }) {
                return;
            }
        }
    }

    async fn resolved_event(
        events: &mut crate::acp::events::CanonicalEventReceiver,
        permission: bool,
    ) -> CanonicalEvent {
        loop {
            let event = events.recv().await.expect("interaction resolution event");
            if permission && matches!(event, CanonicalEvent::PermissionResolved { .. }) {
                return event;
            }
            if !permission && matches!(event, CanonicalEvent::ElicitationResolved { .. }) {
                return event;
            }
        }
    }

    async fn finish_fixture(fixture: &PendingInteractionFixture) {
        if let Some(responder) = fixture
            .prompt_responder
            .lock()
            .expect("prompt responder lock")
            .take()
        {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        fixture.connection.shutdown().await.expect("shutdown");
    }

    fn initialized(capabilities: AgentCapabilities) -> InitializeResponse {
        InitializeResponse::new(ProtocolVersion::V1).agent_capabilities(capabilities)
    }

    fn steer_meta() -> agent_client_protocol::schema::v1::Meta {
        serde_json::from_value(serde_json::json!({
            "tethercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionSteer": {
                        "method": "_tethercode.dev/session/steer",
                        "version": 1
                    }
                }
            }
        }))
        .expect("valid extension metadata")
    }

    fn update(value: serde_json::Value) -> SessionUpdate {
        serde_json::from_value(value).expect("valid typed session update fixture")
    }

    fn assert_connection_failure<T>(result: Result<T, AcpRuntimeError>) {
        assert!(matches!(result, Err(AcpRuntimeError::Connection(_))));
    }

    #[test]
    fn steer_negotiation_rejects_absent_malformed_and_oversized_metadata() {
        let absent = NegotiatedInitialize {
            response: initialized(AgentCapabilities::new()),
        };
        assert!(!absent.supports_session_steer());

        for value in [
            serde_json::json!({"tethercode.dev": true}),
            serde_json::json!({"tethercode.dev": {"version": "1", "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}}}),
            serde_json::json!({"tethercode.dev": {"version": 2, "capabilities": {}}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": []}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": true}}}),
            serde_json::json!({"tethercode.dev": {"version": 2, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": "wrong", "version": 1}}}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 2}}}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1, "extra": true}}}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}, "extra": true}}),
            serde_json::json!({"tethercode.dev": {"version": 1, "capabilities": {"sessionSteer": {"method": STEER_METHOD, "version": 1}}}, "extra": true}),
        ] {
            let mut response = initialized(AgentCapabilities::new());
            response.meta = serde_json::from_value(value).ok();
            assert!(!NegotiatedInitialize { response }.supports_session_steer());
        }

        let mut response = initialized(AgentCapabilities::new());
        response.meta = Some(steer_meta());
        assert!(NegotiatedInitialize { response }.supports_session_steer());

        let mut oversized = steer_meta();
        oversized.insert("padding".to_string(), serde_json::json!("x".repeat(5_000)));
        let mut response = initialized(AgentCapabilities::new());
        response.meta = Some(oversized);
        assert!(!NegotiatedInitialize { response }.supports_session_steer());

        let mut response = initialized(AgentCapabilities::new());
        response.meta = serde_json::from_value(serde_json::json!({
            "tethercode.dev": {
                "version": 1,
                "capabilities": {
                    "sessionSteer": {
                        "method": STEER_METHOD,
                        "version": 1
                    }
                },
                "padding": "x".repeat(5_000)
            }
        }))
        .ok();
        assert!(!NegotiatedInitialize { response }.supports_session_steer());
    }

    #[tokio::test]
    async fn typed_steer_preserves_prompt_and_live_correlation_until_agent_ack() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel::<SteerRequest>();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let timed_out_steer_responder = Arc::new(StdMutex::new(None::<Responder<SteerResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    let mut response = initialized(AgentCapabilities::new());
                    response.meta = Some(steer_meta());
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("steer-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let timed_out_steer_responder = timed_out_steer_responder.clone();
                    async move |request: SteerRequest, responder, _| {
                        let should_timeout = request.prompt.iter().any(
                            |block| matches!(block, ContentBlock::Text(text) if text.text == "timeout"),
                        );
                        let accepted = !request.prompt.iter().any(
                            |block| matches!(block, ContentBlock::Text(text) if text.text == "reject"),
                        );
                        let _ = observed_tx.send(request);
                        if should_timeout {
                            *timed_out_steer_responder
                                .lock()
                                .expect("steer responder lock") = Some(responder);
                            Ok(())
                        } else {
                            responder.respond(SteerResponse { accepted })
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, negotiated) = AcpConnection::start_transport(
            "typed-steer-agent".to_string(),
            agent,
            Duration::from_millis(100),
        )
        .await
        .expect("agent starts");
        assert!(negotiated.supports_session_steer());
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let admission = connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["initial".into()]),
                "run-7".to_string(),
                "turn-7".to_string(),
            )
            .await
            .expect("prompt admitted");
        let prompt = vec![
            ContentBlock::from("preserve this guidance"),
            ContentBlock::Image(agent_client_protocol::schema::v1::ImageContent::new(
                "aGVsbG8=",
                "image/png",
            )),
            ContentBlock::ResourceLink(agent_client_protocol::schema::v1::ResourceLink::new(
                "source.rs",
                "/repo/source.rs",
            )),
        ];
        let unknown_session = connection
            .steer(
                SteerRequest {
                    session_id: SessionId::new("missing"),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            unknown_session,
            AcpRuntimeError::UnknownSession(_)
        ));
        let stale_run = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: "stale-run".to_string(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_run,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        let stale_turn = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: "stale-turn".to_string(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_turn,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        let stale_generation = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation + 1,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            stale_generation,
            AcpRuntimeError::Unsupported("stale steer correlation")
        ));
        connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: prompt.clone(),
                },
                0,
            )
            .await
            .expect("typed steer acknowledged");
        let observed = observed_rx.recv().await.expect("steer observed");
        assert_eq!(observed.session_id, created.session_id);
        assert_eq!(observed.expected_run_id, "run-7");
        assert_eq!(observed.expected_source_turn_id, "turn-7");
        assert_eq!(observed.prompt_generation, admission.generation);
        assert_eq!(observed.prompt, prompt);
        let rejected = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: vec![ContentBlock::from("reject")],
                },
                0,
            )
            .await
            .expect_err("false acknowledgment must fail");
        assert!(matches!(
            rejected,
            AcpRuntimeError::Unsupported("steer was not accepted")
        ));
        let rejected_request = observed_rx.recv().await.expect("rejected steer observed");
        assert_eq!(rejected_request.expected_run_id, admission.run_id);
        assert_eq!(
            rejected_request.expected_source_turn_id,
            admission.source_turn_id
        );
        assert_eq!(rejected_request.prompt_generation, admission.generation);
        let timed_out = connection
            .steer(
                SteerRequest {
                    session_id: created.session_id.clone(),
                    expected_run_id: admission.run_id.clone(),
                    expected_source_turn_id: admission.source_turn_id.clone(),
                    prompt_generation: admission.generation,
                    prompt: vec![ContentBlock::from("timeout")],
                },
                0,
            )
            .await
            .expect_err("unacknowledged steer must time out");
        assert!(matches!(timed_out, AcpRuntimeError::RequestTimeout));
        let timed_out_request = observed_rx.recv().await.expect("timed out steer observed");
        assert_eq!(timed_out_request.expected_run_id, admission.run_id);
        drop(
            timed_out_steer_responder
                .lock()
                .expect("steer responder lock")
                .take(),
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::EndTurn))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn permission_requires_an_exact_advertised_option_without_consuming_on_error() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].thread_id,
            "v1.dGVzdC1hZ2VudA.aW50ZXJhY3Rpb24tc2Vzc2lvbg"
        );
        assert_eq!(pending[0].tool_call_id, "tool-1");
        assert_eq!(pending[0].title, "Write file");
        assert_eq!(pending[0].kind, ToolKind::Edit);
        assert_eq!(pending[0].status, ToolCallStatus::Pending);
        assert_eq!(pending[0].options[0].id, "allow-once");
        assert!(matches!(
            fixture
                .connection
                .resolve_permission("wrong-thread", &pending[0].request_id, "allow-once")
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        assert!(matches!(
            fixture
                .connection
                .cancel_permission("wrong-thread", &pending[0].request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .resolve_permission(&pending[0].thread_id, &pending[0].request_id, "allow")
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::InvalidPermissionOption(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        fixture
            .connection
            .resolve_permission(&pending[0].thread_id, &pending[0].request_id, "allow-once")
            .await
            .expect("exact option resolves");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed permission response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("allow-once")
            )
        );
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { request_id, .. } if request_id == pending[0].request_id
        ));
        assert!(fixture.events.try_recv().is_err());
        assert!(matches!(
            fixture
                .connection
                .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::UnknownRequest(_)
            ))
        ));
        let (generation, errors) = fixture
            .connection
            .interactions
            .cancel_session(&SessionId::new("empty-session"))
            .await;
        assert_eq!(generation, None);
        assert!(errors.is_empty());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn simultaneous_two_agent_interactions_are_unique_and_never_cross_route() {
        let mut alpha_permission = start_pending_interaction_for_agent(
            "alpha-agent",
            TestInteraction::Permission(permission_request(permission_options()), false),
        )
        .await;
        let mut beta_permission = start_pending_interaction_for_agent(
            "beta-agent",
            TestInteraction::Permission(permission_request(permission_options()), false),
        )
        .await;
        requested_event(&mut alpha_permission.events, true).await;
        requested_event(&mut beta_permission.events, true).await;
        let alpha_pending = alpha_permission.connection.pending_permissions().await;
        let beta_pending = beta_permission.connection.pending_permissions().await;
        assert_ne!(alpha_pending[0].request_id, beta_pending[0].request_id);
        assert_ne!(alpha_pending[0].agent_id, beta_pending[0].agent_id);
        alpha_permission
            .connection
            .cancel_permission(&alpha_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect_err("beta permission is not routable through alpha");
        beta_permission
            .connection
            .cancel_permission(&beta_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect_err("alpha permission is not routable through beta");
        alpha_permission
            .connection
            .cancel_permission(&alpha_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect("alpha permission resolves");
        beta_permission
            .connection
            .cancel_permission(&beta_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect("beta permission resolves");
        alpha_permission
            .observed
            .recv()
            .await
            .expect("alpha permission response");
        beta_permission
            .observed
            .recv()
            .await
            .expect("beta permission response");
        finish_fixture(&alpha_permission).await;
        finish_fixture(&beta_permission).await;

        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut alpha_elicitation = start_pending_interaction_for_agent(
            "alpha-agent",
            TestInteraction::Elicitation(request.clone(), false),
        )
        .await;
        let mut beta_elicitation = start_pending_interaction_for_agent(
            "beta-agent",
            TestInteraction::Elicitation(request, false),
        )
        .await;
        requested_event(&mut alpha_elicitation.events, false).await;
        requested_event(&mut beta_elicitation.events, false).await;
        let alpha_pending = alpha_elicitation.connection.pending_elicitations().await;
        let beta_pending = beta_elicitation.connection.pending_elicitations().await;
        assert_ne!(alpha_pending[0].request_id, beta_pending[0].request_id);
        assert_ne!(alpha_pending[0].agent_id, beta_pending[0].agent_id);
        alpha_elicitation
            .connection
            .cancel_elicitation(&alpha_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect_err("beta elicitation is not routable through alpha");
        beta_elicitation
            .connection
            .cancel_elicitation(&beta_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect_err("alpha elicitation is not routable through beta");
        alpha_elicitation
            .connection
            .cancel_elicitation(&alpha_pending[0].thread_id, &alpha_pending[0].request_id)
            .await
            .expect("alpha elicitation resolves");
        beta_elicitation
            .connection
            .cancel_elicitation(&beta_pending[0].thread_id, &beta_pending[0].request_id)
            .await
            .expect("beta elicitation resolves");
        alpha_elicitation
            .observed
            .recv()
            .await
            .expect("alpha elicitation response");
        beta_elicitation
            .observed
            .recv()
            .await
            .expect("beta elicitation response");
        finish_fixture(&alpha_elicitation).await;
        finish_fixture(&beta_elicitation).await;
    }

    #[tokio::test]
    async fn permission_can_be_cancelled_by_client_or_request_cancellation_race() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        let request_id = pending[0].request_id.clone();
        fixture
            .connection
            .cancel_permission(&pending[0].thread_id, &request_id)
            .await
            .expect("permission cancelled");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed cancellation").outcome,
            RequestPermissionOutcome::Cancelled
        );
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { request_id: resolved, .. } if resolved == request_id
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let pending = fixture.connection.pending_permissions().await;
        fixture
            .connection
            .sessions
            .remove(&fixture.session_id)
            .await;
        fixture
            .connection
            .cancel_permission(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("permission resolves after session removal");
        fixture.observed.recv().await.expect("permission response");
        assert!(fixture.connection.pending_permissions().await.is_empty());
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            true,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("watcher returns typed cancellation").outcome,
            RequestPermissionOutcome::Cancelled
        );
        assert!(fixture.connection.pending_permissions().await.is_empty());
        assert!(matches!(
            resolved_event(&mut fixture.events, true).await,
            CanonicalEvent::PermissionResolved { .. }
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn absent_and_request_scoped_interactions_cancel_without_pending_leaks() {
        let mut missing_permission = permission_request(permission_options());
        missing_permission.session_id = "missing-session".into();
        let mut fixture =
            start_pending_interaction(TestInteraction::Permission(missing_permission, false)).await;
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(result.unwrap().outcome, RequestPermissionOutcome::Cancelled);
        assert!(fixture.connection.pending_permissions().await.is_empty());
        finish_fixture(&fixture).await;

        let missing_elicitation = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("missing-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Missing",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(missing_elicitation, false))
                .await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(result.unwrap().action, ElicitationAction::Cancel));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;

        let request_scoped = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationRequestScope::new(42),
                ElicitationSchema::new().string("value", true),
            ),
            "Request value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request_scoped, false)).await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(result.unwrap().action, ElicitationAction::Cancel));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        while let Ok(event) = fixture.events.try_recv() {
            assert!(!matches!(
                event,
                CanonicalEvent::ElicitationRequested { .. }
            ));
        }
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn form_elicitation_accepts_all_typed_values_and_redacts_secret_defaults() {
        let secret = StringPropertySchema::new()
            .title("API token")
            .default_value("must-not-leak");
        let schema = ElicitationSchema::new()
            .property("name", StringPropertySchema::new().min_length(2), true)
            .property(
                "count",
                IntegerPropertySchema::new().minimum(1).maximum(5),
                true,
            )
            .property(
                "ratio",
                NumberPropertySchema::new().minimum(0.0).maximum(1.0),
                true,
            )
            .property("enabled", BooleanPropertySchema::new(), true)
            .property(
                "tags",
                MultiSelectPropertySchema::new(vec!["one".to_string(), "two".to_string()]),
                true,
            )
            .property("token", secret, false);
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("interaction-session"), schema),
            "Provide values",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        assert_eq!(pending.len(), 1);
        let token = pending[0]
            .fields
            .iter()
            .find(|field| field.name == "token")
            .unwrap();
        assert!(token.sensitive);
        assert_eq!(token.default, None);
        let values = BTreeMap::from([
            (
                "name".to_string(),
                ElicitationContentValue::String("Ada".to_string()),
            ),
            ("count".to_string(), ElicitationContentValue::Integer(3)),
            ("ratio".to_string(), ElicitationContentValue::Number(0.5)),
            (
                "enabled".to_string(),
                ElicitationContentValue::Boolean(true),
            ),
            (
                "tags".to_string(),
                ElicitationContentValue::StringArray(vec!["one".to_string()]),
            ),
            (
                "token".to_string(),
                ElicitationContentValue::String("entered-secret".to_string()),
            ),
        ]);
        fixture
            .connection
            .accept_elicitation(&pending[0].thread_id, &pending[0].request_id, values)
            .await
            .expect("typed values accepted");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        let ElicitationAction::Accept(action) = result.expect("typed elicitation").action else {
            panic!("accept action expected");
        };
        assert_eq!(action.content.unwrap().len(), 6);
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn elicitation_validation_failure_preserves_responder_then_declines() {
        let schema = ElicitationSchema::new().property(
            "count",
            IntegerPropertySchema::new().minimum(1).maximum(2),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("interaction-session"), schema),
            "Count",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        assert!(matches!(
            fixture
                .connection
                .accept_elicitation("wrong-thread", &request_id, BTreeMap::new())
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .decline_elicitation("wrong-thread", &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .cancel_elicitation("wrong-thread", &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(InteractionError::WrongOwner(
                _
            )))
        ));
        assert!(matches!(
            fixture
                .connection
                .accept_elicitation(
                    &thread_id,
                    &request_id,
                    BTreeMap::from([(
                        "count".to_string(),
                        ElicitationContentValue::String("wrong".to_string())
                    )]),
                )
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::InvalidElicitation(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_elicitations().await.len(), 1);
        fixture
            .connection
            .decline_elicitation(&thread_id, &request_id)
            .await
            .expect("decline succeeds");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed decline").action,
            ElicitationAction::Decline
        ));
        assert!(matches!(
            fixture
                .connection
                .cancel_elicitation(&thread_id, &request_id)
                .await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::UnknownRequest(_)
            ))
        ));
        fixture
            .connection
            .decline_elicitation(&thread_id, &request_id)
            .await
            .expect_err("removed elicitation stays unknown");
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn semantic_session_cancel_responds_before_cancel_notification() {
        let (order_tx, mut order_rx) = mpsc::unbounded_channel::<&'static str>();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("ordered-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let order_tx = order_tx.clone();
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        let mut request = permission_request(permission_options());
                        request.session_id = "ordered-session".into();
                        connection.send_request(request).on_receiving_result({
                            let response_order = order_tx.clone();
                            async move |result| {
                                assert_eq!(result?.outcome, RequestPermissionOutcome::Cancelled);
                                let _ = response_order.send("permission");
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |request: CancelNotification, connection| {
                    let _ = order_tx.send("cancel");
                    connection.send_notification(SessionNotification::new(
                        request.session_id,
                        update(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "late"},
                            "messageId": "late-cancelled-generation"
                        })),
                    ))?;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        assert!(matches!(
            connection
                .cancel_turn("missing-session".into(), "ordered-turn")
                .await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "ordered-run".to_string(),
                "ordered-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        requested_event(&mut events, true).await;
        assert!(matches!(
            connection
                .cancel_turn(created.session_id.clone(), "completed-turn")
                .await,
            Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation"
            ))
        ));
        assert_eq!(
            session.operation().await,
            Some(("ordered-run".into(), "ordered-turn".into(), 1))
        );
        assert!(order_rx.try_recv().is_err());
        connection
            .cancel_turn(created.session_id.clone(), "ordered-turn")
            .await
            .expect("matching turn cancels");
        assert_eq!(order_rx.recv().await, Some("permission"));
        assert_eq!(order_rx.recv().await, Some("cancel"));
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new(created.session_id.clone(), vec!["blocked".into()]),
                    "blocked-run".into(),
                    "blocked-turn".into(),
                )
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        loop {
            let snapshot = session.snapshot().await;
            if snapshot
                .messages
                .iter()
                .any(|message| message.id == "late-cancelled-generation")
            {
                assert_eq!(snapshot.active_generation, Some(1));
                break;
            }
            tokio::task::yield_now().await;
        }
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        loop {
            if session.snapshot().await.active_generation.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            connection
                .cancel_turn(created.session_id.clone(), "ordered-turn")
                .await,
            Err(AcpRuntimeError::Unsupported(
                "stale turn interrupt correlation"
            ))
        ));
        let next = connection
            .prompt(
                PromptRequest::new(created.session_id, vec!["next".into()]),
                "next-run".into(),
                "next-turn".into(),
            )
            .await
            .expect("next prompt admitted after matching terminal callback");
        assert_eq!(next.generation, 2);
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn load_and_resume_reject_active_and_cancelling_without_snapshot_loss() {
        let reconstruction_calls = Arc::new(AtomicUsize::new(0));
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(
                        AgentCapabilities::new()
                            .load_session(true)
                            .session_capabilities(
                                SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
                            ),
                    ))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let reconstruction_calls = reconstruction_calls.clone();
                    async move |_request: LoadSessionRequest, responder, _| {
                        reconstruction_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let reconstruction_calls = reconstruction_calls.clone();
                    async move |_request: ResumeSessionRequest, responder, _| {
                        reconstruction_calls.fetch_add(1, AtomicOrdering::SeqCst);
                        responder.respond(ResumeSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "restore-race-agent".into(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .expect("agent starts");
        let session_id = SessionId::new("restore-race");
        let session = connection
            .ensure_session(session_id.clone())
            .await
            .expect("session capacity");
        connection
            .prompt(
                PromptRequest::new(session_id.clone(), vec!["active".into()]),
                "active-run".into(),
                "active-turn".into(),
            )
            .await
            .expect("prompt admitted first");
        let before = session.snapshot().await;
        for result in [
            connection
                .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            connection
                .resume_session(ResumeSessionRequest::new(session_id.clone(), "/tmp"))
                .await
                .map(|_| LoadSessionResponse::new()),
        ] {
            assert!(matches!(result, Err(AcpRuntimeError::SessionBusy)));
        }
        connection.cancel(session_id.clone()).await.unwrap();
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new(session_id.clone(), "/tmp"))
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));
        assert_eq!(reconstruction_calls.load(AtomicOrdering::SeqCst), 0);
        let after = session.snapshot().await;
        assert_eq!(after.active_run_id, before.active_run_id);
        assert_eq!(after.active_source_turn_id, before.active_source_turn_id);
        assert_eq!(after.active_generation, before.active_generation);
        assert_eq!(after.messages.len(), before.messages.len());
        prompt_responder
            .lock()
            .expect("prompt lock")
            .take()
            .unwrap()
            .respond(PromptResponse::new(StopReason::Cancelled))
            .unwrap();
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn restore_first_commit_and_rollback_release_waiting_prompt() {
        for commit in [true, false] {
            let (restore_seen_tx, restore_seen_rx) = oneshot::channel();
            let restore_seen_tx = Arc::new(StdMutex::new(Some(restore_seen_tx)));
            let (release_tx, release_rx) = oneshot::channel();
            let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
            let agent = Agent
                .builder()
                .on_receive_request(
                    async |_request: InitializeRequest, responder, _| {
                        responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    {
                        let restore_seen_tx = restore_seen_tx.clone();
                        let release_rx = release_rx.clone();
                        async move |_request: LoadSessionRequest, responder, _| {
                            if let Some(sender) = restore_seen_tx.lock().unwrap().take() {
                                let _ = sender.send(());
                            }
                            let receiver = release_rx.lock().unwrap().take().unwrap();
                            let _ = receiver.await;
                            if commit {
                                responder.respond(LoadSessionResponse::new())
                            } else {
                                responder.respond_with_error(
                                    agent_client_protocol::Error::internal_error(),
                                )
                            }
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async |_request: PromptRequest, responder, _| {
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    },
                    agent_client_protocol::on_receive_request!(),
                );
            let (connection, _) = AcpConnection::start_transport(
                "restore-first-agent".into(),
                agent,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
            let session_id = SessionId::new(if commit {
                "restore-commit"
            } else {
                "restore-rollback"
            });
            connection
                .ensure_session(session_id.clone())
                .await
                .expect("session capacity");
            let restore_connection = connection.clone();
            let restore_session_id = session_id.clone();
            let restore = tokio::spawn(async move {
                restore_connection
                    .load_session(LoadSessionRequest::new(restore_session_id, "/tmp"))
                    .await
            });
            restore_seen_rx.await.unwrap();
            let prompt_connection = connection.clone();
            let prompt_session_id = session_id.clone();
            let prompt = tokio::spawn(async move {
                prompt_connection
                    .prompt(
                        PromptRequest::new(prompt_session_id, vec!["after restore".into()]),
                        "post-restore-run".into(),
                        "post-restore-turn".into(),
                    )
                    .await
            });
            tokio::task::yield_now().await;
            assert!(!prompt.is_finished());
            release_tx.send(()).unwrap();
            assert_eq!(restore.await.unwrap().is_ok(), commit);
            assert_eq!(prompt.await.unwrap().unwrap().generation, 1);
            connection.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn interactions_arriving_after_cancel_mark_are_typed_cancelled_without_pending_leaks() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("late-interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, _| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |_request: CancelNotification, connection| {
                    let mut permission = permission_request(permission_options());
                    permission.session_id = "late-interaction-session".into();
                    connection.send_request(permission).on_receiving_result({
                        let outcomes_tx = outcomes_tx.clone();
                        async move |result| {
                            let cancelled =
                                matches!(result?.outcome, RequestPermissionOutcome::Cancelled);
                            let _ = outcomes_tx.send(("permission", cancelled));
                            Ok(())
                        }
                    })?;
                    let elicitation = CreateElicitationRequest::new(
                        ElicitationFormMode::new(
                            ElicitationSessionScope::new("late-interaction-session"),
                            ElicitationSchema::new().string("value", true),
                        ),
                        "Value",
                    );
                    connection.send_request(elicitation).on_receiving_result({
                        let outcomes_tx = outcomes_tx.clone();
                        async move |result| {
                            let cancelled = matches!(result?.action, ElicitationAction::Cancel);
                            let _ = outcomes_tx.send(("elicitation", cancelled));
                            Ok(())
                        }
                    })?;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "late-run".into(),
                "late-turn".into(),
            )
            .await
            .expect("prompt admitted");
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel completes");
        let mut outcomes = vec![
            outcomes_rx.recv().await.expect("first typed outcome"),
            outcomes_rx.recv().await.expect("second typed outcome"),
        ];
        outcomes.sort_unstable();
        assert_eq!(outcomes, vec![("elicitation", true), ("permission", true)]);
        assert!(connection.pending_permissions().await.is_empty());
        assert!(connection.pending_elicitations().await.is_empty());
        assert!(
            outcomes_rx.try_recv().is_err(),
            "each request resolves once"
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn cancel_send_failure_fails_old_generation_once_and_reopens_admission() {
        let session = AcpSession::new("agent".into(), "cancel-failure".into());
        let mut events = session.take_events().await.unwrap();
        session
            .admit_prompt("old-run".into(), "old-turn".into())
            .await
            .unwrap();
        let generation = session.mark_cancelling().await;
        let failure = Err(AcpRuntimeError::Connection("cancel send failed".into()));
        finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        let mut failures = 0;
        while let Ok(event) = events.try_recv() {
            if let CanonicalEvent::RunFailed {
                run_id, generation, ..
            } = event
            {
                assert_eq!(run_id, "old-run");
                assert_eq!(generation, 1);
                failures += 1;
            }
        }
        assert_eq!(failures, 1);
        let admission = session
            .admit_prompt("new-run".into(), "new-turn".into())
            .await
            .expect("failure terminalization reopens admission");
        assert_eq!(admission.0, 2);
    }

    #[tokio::test]
    async fn cancel_atomically_drains_permission_and_elicitation_for_active_generation() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("combined-interaction-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        let mut permission = permission_request(permission_options());
                        permission.session_id = "combined-interaction-session".into();
                        connection.send_request(permission).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx.send(matches!(
                                    result?.outcome,
                                    RequestPermissionOutcome::Cancelled
                                ));
                                Ok(())
                            }
                        })?;
                        let elicitation = CreateElicitationRequest::new(
                            ElicitationFormMode::new(
                                ElicitationSessionScope::new("combined-interaction-session"),
                                ElicitationSchema::new().string("value", true),
                            ),
                            "Value",
                        );
                        connection.send_request(elicitation).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx
                                    .send(matches!(result?.action, ElicitationAction::Cancel));
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["interact".into()]),
                "combined-run".into(),
                "combined-turn".into(),
            )
            .await
            .expect("prompt admitted");
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 1
                && connection.pending_elicitations().await.len() == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(connection.pending_permissions().await.len(), 1);
        assert_eq!(connection.pending_elicitations().await.len(), 1);
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel completes");
        assert!(outcomes_rx.recv().await.expect("first cancellation"));
        assert!(outcomes_rx.recv().await.expect("second cancellation"));
        assert!(connection.pending_permissions().await.is_empty());
        assert!(connection.pending_elicitations().await.is_empty());
        assert!(
            outcomes_rx.try_recv().is_err(),
            "each request resolves once"
        );
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    async fn assert_cancel_response_failures_do_not_block_cancel(
        fail_permission: bool,
        fail_elicitation: bool,
        fail_cancel_send: bool,
    ) {
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let cancel_tx = Arc::new(StdMutex::new(Some(cancel_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("cancel-failure-matrix"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt responder") = Some(responder);
                        let mut permission = permission_request(permission_options());
                        permission.session_id = "cancel-failure-matrix".into();
                        connection.send_request(permission).detach();
                        connection
                            .send_request(CreateElicitationRequest::new(
                                ElicitationFormMode::new(
                                    ElicitationSessionScope::new("cancel-failure-matrix"),
                                    ElicitationSchema::new().string("value", true),
                                ),
                                "Value",
                            ))
                            .detach();
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let cancel_tx = cancel_tx.clone();
                    async move |_request: CancelNotification, _| {
                        if let Some(cancel_tx) = cancel_tx.lock().expect("cancel sender").take() {
                            let _ = cancel_tx.send(());
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".into(), agent, Duration::from_secs(1))
                .await
                .unwrap();
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.unwrap();
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["cancel".into()]),
                "matrix-run".into(),
                "matrix-turn".into(),
            )
            .await
            .unwrap();
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 1
                && connection.pending_elicitations().await.len() == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection
            .interactions
            .inject_cancel_response_failures(&created.session_id, fail_permission, fail_elicitation)
            .await;
        if fail_cancel_send {
            let (generation, errors) = connection
                .interactions
                .cancel_session(&created.session_id)
                .await;
            assert_eq!(errors.len(), 2);
            let failure = Err(AcpRuntimeError::Connection("cancel send failed".into()));
            finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
            finish_cancel_attempt(Some(session.clone()), generation, &failure).await;
        } else {
            connection.cancel(created.session_id.clone()).await.unwrap();
            cancel_rx.await.expect("ACP cancel notification sent");
        }
        if fail_cancel_send {
            let mut failures = 0;
            while let Ok(event) = events.try_recv() {
                if matches!(event, CanonicalEvent::RunFailed { generation: 1, .. }) {
                    failures += 1;
                }
            }
            assert_eq!(failures, 1);
            let admission = session
                .admit_prompt("matrix-run-2".into(), "matrix-turn-2".into())
                .await
                .expect("cancel-send failure reopens prompt admission");
            assert_eq!(admission.0, 2);
            connection.shutdown().await.unwrap();
            return;
        }
        assert_eq!(
            session.operation().await,
            Some(("matrix-run".into(), "matrix-turn".into(), 1))
        );
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new(created.session_id.clone(), vec!["blocked".into()]),
                    "blocked-run".into(),
                    "blocked-turn".into(),
                )
                .await,
            Err(AcpRuntimeError::SessionBusy)
        ));

        let mut permission_resolved = 0;
        let mut elicitation_resolved = 0;
        let mut diagnostics = 0;
        while permission_resolved == 0 || elicitation_resolved == 0 || diagnostics == 0 {
            match events.recv().await.expect("canonical cancellation event") {
                CanonicalEvent::PermissionResolved { .. } => permission_resolved += 1,
                CanonicalEvent::ElicitationResolved { .. } => elicitation_resolved += 1,
                CanonicalEvent::Ignored { kind, .. }
                    if kind == "interaction_cancel_response_failed" =>
                {
                    diagnostics += 1
                }
                _ => {}
            }
        }
        assert_eq!(
            (permission_resolved, elicitation_resolved, diagnostics),
            (1, 1, 1)
        );
        prompt_responder
            .lock()
            .expect("prompt responder")
            .take()
            .unwrap()
            .respond(PromptResponse::new(StopReason::Cancelled))
            .unwrap();
        loop {
            if session.operation().await.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn cancel_responder_failure_matrix_still_sends_cancel_and_terminalizes() {
        for (fail_permission, fail_elicitation) in [(true, false), (false, true), (true, true)] {
            assert_cancel_response_failures_do_not_block_cancel(
                fail_permission,
                fail_elicitation,
                false,
            )
            .await;
        }
        assert_cancel_response_failures_do_not_block_cancel(true, true, true).await;
    }

    #[tokio::test]
    async fn cancel_drains_only_the_matching_session_generation() {
        let next_session = Arc::new(AtomicUsize::new(0));
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responders = Arc::new(StdMutex::new(Vec::<Responder<PromptResponse>>::new()));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let next_session = next_session.clone();
                    async move |_request: NewSessionRequest, responder, _| {
                        let index = next_session.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                        responder.respond(NewSessionResponse::new(format!("isolated-{index}")))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responders = prompt_responders.clone();
                    async move |request: PromptRequest, responder, connection| {
                        prompt_responders
                            .lock()
                            .expect("prompt responders")
                            .push(responder);
                        let session_id = request.session_id.clone();
                        let mut permission = permission_request(permission_options());
                        permission.session_id = session_id.clone();
                        connection.send_request(permission).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            let session_id = session_id.clone();
                            async move |result| {
                                let _ = outcomes_tx.send((
                                    session_id.to_string(),
                                    "permission",
                                    matches!(result?.outcome, RequestPermissionOutcome::Cancelled),
                                ));
                                Ok(())
                            }
                        })?;
                        let elicitation = CreateElicitationRequest::new(
                            ElicitationFormMode::new(
                                ElicitationSessionScope::new(session_id.clone()),
                                ElicitationSchema::new().string("value", true),
                            ),
                            "Value",
                        );
                        connection.send_request(elicitation).on_receiving_result({
                            let outcomes_tx = outcomes_tx.clone();
                            async move |result| {
                                let _ = outcomes_tx.send((
                                    session_id.to_string(),
                                    "elicitation",
                                    matches!(result?.action, ElicitationAction::Cancel),
                                ));
                                Ok(())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let first = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("first session");
        let second = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("second session");
        for session_id in [&first.session_id, &second.session_id] {
            connection
                .prompt(
                    PromptRequest::new(session_id.clone(), vec!["interact".into()]),
                    format!("run-{session_id}"),
                    format!("turn-{session_id}"),
                )
                .await
                .expect("prompt admitted");
        }
        for _ in 0..100 {
            if connection.pending_permissions().await.len() == 2
                && connection.pending_elicitations().await.len() == 2
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        connection
            .cancel(first.session_id.clone())
            .await
            .expect("first session cancelled");
        assert_eq!(connection.pending_permissions().await.len(), 1);
        assert_eq!(connection.pending_elicitations().await.len(), 1);
        for _ in 0..2 {
            let (session_id, _, cancelled) = outcomes_rx.recv().await.expect("first outcome");
            assert_eq!(session_id, first.session_id.to_string());
            assert!(cancelled);
        }
        connection.shutdown().await.expect("shutdown");
        for _ in 0..2 {
            let (session_id, _, cancelled) = outcomes_rx.recv().await.expect("second outcome");
            assert_eq!(session_id, second.session_id.to_string());
            assert!(cancelled);
        }
        for responder in prompt_responders
            .lock()
            .expect("prompt responders")
            .drain(..)
        {
            let _ = responder.respond(PromptResponse::new(StopReason::Cancelled));
        }
    }

    #[tokio::test]
    async fn steer_preparation_prefers_reject_once_and_fails_without_reject() {
        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        fixture
            .connection
            .prepare_steer(&fixture.session_id)
            .await
            .expect("reject option prepares steer");
        let ObservedInteraction::Permission(result) = fixture.observed.recv().await.unwrap() else {
            panic!("permission response expected");
        };
        assert_eq!(
            result.expect("typed response").outcome,
            RequestPermissionOutcome::Selected(
                agent_client_protocol::schema::v1::SelectedPermissionOutcome::new("reject-once")
            )
        );
        finish_fixture(&fixture).await;

        let mut fixture = start_pending_interaction(TestInteraction::Permission(
            permission_request(vec![PermissionOption::new(
                "allow-once",
                "Allow",
                PermissionOptionKind::AllowOnce,
            )]),
            false,
        ))
        .await;
        requested_event(&mut fixture.events, true).await;
        assert!(matches!(
            fixture.connection.prepare_steer(&fixture.session_id).await,
            Err(AcpRuntimeError::Interaction(
                InteractionError::NoRejectOption(_)
            ))
        ));
        assert_eq!(fixture.connection.pending_permissions().await.len(), 1);
        fixture
            .connection
            .interactions
            .cancel_permissions_for_session(&fixture.session_id)
            .await
            .expect("cleanup permission");
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn steer_preparation_cancels_elicitation_with_typed_action() {
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        fixture
            .connection
            .prepare_steer(&fixture.session_id)
            .await
            .expect("elicitation cancelled for steer");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed response").action,
            ElicitationAction::Cancel
        ));
        finish_fixture(&fixture).await;
    }

    #[tokio::test]
    async fn steer_preparation_converges_with_manual_interaction_resolution_races() {
        let mut permission = start_pending_interaction(TestInteraction::Permission(
            permission_request(permission_options()),
            false,
        ))
        .await;
        requested_event(&mut permission.events, true).await;
        let pending = permission.connection.pending_permissions().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        let (prepare, manual) = tokio::join!(
            permission.connection.prepare_steer(&permission.session_id),
            permission
                .connection
                .resolve_permission(&thread_id, &request_id, "reject-once"),
        );
        assert!(prepare.is_ok());
        assert!(
            manual.is_ok()
                || matches!(
                    manual,
                    Err(AcpRuntimeError::Interaction(
                        InteractionError::UnknownRequest(_)
                    ))
                )
        );
        assert!(permission.connection.pending_permissions().await.is_empty());
        finish_fixture(&permission).await;

        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut elicitation =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut elicitation.events, false).await;
        let pending = elicitation.connection.pending_elicitations().await;
        let request_id = pending[0].request_id.clone();
        let thread_id = pending[0].thread_id.clone();
        let (prepare, manual) = tokio::join!(
            elicitation
                .connection
                .prepare_steer(&elicitation.session_id),
            elicitation
                .connection
                .cancel_elicitation(&thread_id, &request_id),
        );
        assert!(prepare.is_ok());
        assert!(
            manual.is_ok()
                || matches!(
                    manual,
                    Err(AcpRuntimeError::Interaction(
                        InteractionError::UnknownRequest(_)
                    ))
                )
        );
        assert!(elicitation
            .connection
            .pending_elicitations()
            .await
            .is_empty());
        finish_fixture(&elicitation).await;
    }

    #[tokio::test]
    async fn elicitation_request_cancellation_and_shutdown_return_typed_cancel() {
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(
                ElicitationSessionScope::new("interaction-session"),
                ElicitationSchema::new().string("value", true),
            ),
            "Value",
        );
        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request.clone(), true)).await;
        requested_event(&mut fixture.events, false).await;
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed watcher cancellation").action,
            ElicitationAction::Cancel
        ));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        assert!(matches!(
            resolved_event(&mut fixture.events, false).await,
            CanonicalEvent::ElicitationResolved { .. }
        ));
        assert!(fixture.events.try_recv().is_err());
        finish_fixture(&fixture).await;

        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request.clone(), false)).await;
        requested_event(&mut fixture.events, false).await;
        let pending = fixture.connection.pending_elicitations().await;
        fixture
            .connection
            .sessions
            .remove(&fixture.session_id)
            .await;
        fixture
            .connection
            .cancel_elicitation(&pending[0].thread_id, &pending[0].request_id)
            .await
            .expect("elicitation resolves after session removal");
        fixture.observed.recv().await.expect("elicitation response");
        assert!(fixture.connection.pending_elicitations().await.is_empty());
        finish_fixture(&fixture).await;

        let mut fixture =
            start_pending_interaction(TestInteraction::Elicitation(request, false)).await;
        requested_event(&mut fixture.events, false).await;
        assert_eq!(fixture.connection.pending_elicitations().await.len(), 1);
        fixture
            .connection
            .shutdown()
            .await
            .expect("shutdown drains");
        let ObservedInteraction::Elicitation(result) = fixture.observed.recv().await.unwrap()
        else {
            panic!("elicitation response expected");
        };
        assert!(matches!(
            result.expect("typed shutdown cancellation").action,
            ElicitationAction::Cancel
        ));
        assert!(fixture.connection.pending_elicitations().await.is_empty());
    }

    #[tokio::test]
    async fn interaction_capacity_rejects_excess_without_leaking_responders() {
        let (outcomes_tx, mut outcomes_rx) = mpsc::unbounded_channel();
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("capacity-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let prompt_responder = prompt_responder.clone();
                    async move |_request: PromptRequest, responder, connection| {
                        *prompt_responder.lock().expect("prompt lock") = Some(responder);
                        for index in 0..17 {
                            let mut request = permission_request(permission_options());
                            request.session_id = "capacity-session".into();
                            request.tool_call.tool_call_id = format!("tool-{index}").into();
                            connection.send_request(request).on_receiving_result({
                                let outcomes_tx = outcomes_tx.clone();
                                async move |result| {
                                    let _ =
                                        outcomes_tx.send(result.map(|response| response.outcome));
                                    Ok(())
                                }
                            })?;
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["capacity".into()]),
                "capacity-run".to_string(),
                "capacity-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        for _ in 0..16 {
            requested_event(&mut events, true).await;
        }
        assert_eq!(connection.pending_permissions().await.len(), 16);
        let first = outcomes_rx.recv().await.expect("excess request response");
        assert_eq!(
            first.expect("typed capacity response"),
            RequestPermissionOutcome::Cancelled
        );
        connection
            .interactions
            .cancel_permissions_for_session(&created.session_id)
            .await
            .expect("pending permissions drained");
        for _ in 0..16 {
            assert_eq!(
                outcomes_rx
                    .recv()
                    .await
                    .expect("pending response")
                    .expect("typed cancellation"),
                RequestPermissionOutcome::Cancelled
            );
        }
        assert!(connection.pending_permissions().await.is_empty());
        if let Some(responder) = prompt_responder.lock().expect("prompt lock").take() {
            responder
                .respond(PromptResponse::new(StopReason::Cancelled))
                .expect("prompt response");
        }
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn load_reconstruction_auto_cancels_interactions_without_live_request() {
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let outcome_tx = Arc::new(StdMutex::new(Some(outcome_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let outcome_tx = outcome_tx.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        let mut permission = permission_request(permission_options());
                        permission.session_id = request.session_id;
                        connection.send_request(permission).on_receiving_result({
                            let outcome_tx = outcome_tx.clone();
                            async move |result| {
                                if let Some(sender) =
                                    outcome_tx.lock().expect("outcome lock").take()
                                {
                                    let _ = sender.send(result.map(|response| response.outcome));
                                }
                                responder.respond(LoadSessionResponse::new())
                            }
                        })?;
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let session_id = agent_client_protocol::schema::v1::SessionId::new("reconstructed");
        let session = connection
            .sessions
            .register("test-agent", session_id.clone())
            .await
            .expect("session capacity");
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .load_session(LoadSessionRequest::new(session_id, "/tmp"))
            .await
            .expect("load completes");
        assert_eq!(
            outcome_rx
                .await
                .expect("interaction response")
                .expect("typed cancellation"),
            RequestPermissionOutcome::Cancelled
        );
        assert!(connection.pending_permissions().await.is_empty());
        assert!(
            events.try_recv().is_err(),
            "no live interaction event emitted"
        );
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn typed_load_replaces_previous_projection_and_rolls_back_failure() {
        let load_count = Arc::new(AtomicUsize::new(0));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new().load_session(true)))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let load_count = load_count.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        let index = load_count.fetch_add(1, AtomicOrdering::SeqCst);
                        let message_id = match index {
                            0 => "first",
                            1 => "second",
                            _ => "failed",
                        };
                        connection.send_notification(SessionNotification::new(
                            request.session_id,
                            update(serde_json::json!({
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": message_id},
                                "messageId": message_id
                            })),
                        ))?;
                        if index == 2 {
                            responder
                                .respond_with_error(agent_client_protocol::Error::internal_error())
                        } else {
                            responder.respond(LoadSessionResponse::new())
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("load-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("load agent starts");
        let session_id = SessionId::new("load-session");

        connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .expect("first load");
        connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .expect("second load");
        let session = connection
            .session(&session_id)
            .await
            .expect("loaded session");
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "second");

        assert!(connection
            .load_session(LoadSessionRequest::new(session_id.clone(), "/tmp"))
            .await
            .is_err());
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "second");
        assert!(!snapshot.history_reconstruction);
        connection.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn connection_failure_drains_pending_interactions() {
        let (release_tx, release_rx) = oneshot::channel();
        let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    let capabilities = AgentCapabilities::new()
                        .load_session(true)
                        .session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .resume(SessionResumeCapabilities::new()),
                        );
                    responder.respond(initialized(capabilities))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("failure-session"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let release_rx = release_rx.clone();
                    async move |_request: PromptRequest, _responder, connection| {
                        let mut request = permission_request(permission_options());
                        request.session_id = "failure-session".into();
                        connection
                            .send_request(request)
                            .on_receiving_result(async |_result| Ok(()))?;
                        let receiver = release_rx.lock().expect("release lock").take();
                        if let Some(receiver) = receiver {
                            connection.spawn(async move {
                                let _ = receiver.await;
                                Err::<(), _>(agent_client_protocol::util::internal_error(
                                    "forced failure",
                                ))
                            })?;
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection.session(&created.session_id).await.unwrap();
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id, vec!["fail".into()]),
                "failure-run".to_string(),
                "failure-turn".to_string(),
            )
            .await
            .expect("prompt admitted");
        requested_event(&mut events, true).await;
        assert_eq!(connection.pending_permissions().await.len(), 1);
        release_tx.send(()).expect("release failure");
        let mut failure = connection.failure.clone();
        loop {
            if failure.borrow().is_some() {
                break;
            }
            failure.changed().await.expect("failure signal");
        }
        assert!(connection.pending_permissions().await.is_empty());

        let late_session_id = SessionId::new("late-session");
        connection
            .ensure_session(late_session_id.clone())
            .await
            .expect("session capacity");
        assert_eq!(connection.loaded_sessions().await.len(), 2);
        assert_connection_failure(connection.new_session(NewSessionRequest::new("/tmp")).await);
        assert_connection_failure(connection.list_sessions(ListSessionsRequest::new()).await);
        assert_connection_failure(
            connection
                .load_session(LoadSessionRequest::new("load-after-failure", "/tmp"))
                .await,
        );
        assert_connection_failure(
            connection
                .resume_session(ResumeSessionRequest::new("resume-after-failure", "/tmp"))
                .await,
        );
        assert_connection_failure(
            connection
                .prompt(
                    PromptRequest::new(late_session_id.clone(), vec!["late".into()]),
                    "late-run".to_string(),
                    "late-turn".to_string(),
                )
                .await,
        );
        assert_connection_failure(connection.cancel(late_session_id).await);
    }

    #[tokio::test]
    async fn initialize_advertises_minimal_capabilities_and_gates_list() {
        let (initialize_tx, initialize_rx) = oneshot::channel();
        let initialize_tx = Arc::new(StdMutex::new(Some(initialize_tx)));
        let agent = Agent.builder().on_receive_request(
            {
                let initialize_tx = initialize_tx.clone();
                async move |request: InitializeRequest, responder, _| {
                    if let Some(sender) = initialize_tx.lock().expect("initialize lock").take() {
                        let _ = sender.send(request.clone());
                    }
                    responder.respond(initialized(AgentCapabilities::new()))
                }
            },
            agent_client_protocol::on_receive_request!(),
        );
        let (connection, negotiated) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("typed agent initializes");
        let request = initialize_rx.await.expect("initialize captured");
        assert_eq!(negotiated.response.protocol_version, ProtocolVersion::V1);
        assert!(!request.client_capabilities.fs.read_text_file);
        assert!(!request.client_capabilities.fs.write_text_file);
        assert!(!request.client_capabilities.terminal);
        let elicitation = request
            .client_capabilities
            .elicitation
            .expect("form elicitation advertised");
        assert!(elicitation.form.is_some());
        assert!(elicitation.url.is_none());
        assert!(matches!(
            connection.list_sessions(ListSessionsRequest::new()).await,
            Err(AcpRuntimeError::Unsupported("session/list"))
        ));
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new("missing", "/tmp"))
                .await,
            Err(AcpRuntimeError::Unsupported("session/load"))
        ));
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new("missing", "/tmp"))
                .await,
            Err(AcpRuntimeError::Unsupported("session/resume"))
        ));
        assert!(matches!(
            connection
                .prompt(
                    PromptRequest::new("missing", vec!["hello".into()]),
                    "run".to_string(),
                    "turn".to_string(),
                )
                .await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection.cancel(SessionId::new("missing")).await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection.prepare_steer(&SessionId::new("missing")).await,
            Err(AcpRuntimeError::UnknownSession(_))
        ));
        assert!(matches!(
            connection
                .steer(
                    SteerRequest {
                        session_id: SessionId::new("missing"),
                        expected_run_id: "run".to_string(),
                        expected_source_turn_id: "turn".to_string(),
                        prompt_generation: 1,
                        prompt: vec!["hello".into()],
                    },
                    0
                )
                .await,
            Err(AcpRuntimeError::Unsupported(STEER_METHOD))
        ));
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn ordinary_command_failures_preserve_typed_state() {
        let agent = Agent
            .builder()
            .on_receive_request(
                async |request: InitializeRequest, responder, _| {
                    let capabilities = AgentCapabilities::new()
                        .load_session(true)
                        .session_capabilities(
                            SessionCapabilities::new()
                                .list(SessionListCapabilities::new())
                                .resume(SessionResumeCapabilities::new()),
                        );
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: ListSessionsRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: LoadSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: ResumeSessionRequest, responder, _| {
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found())
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "failure-agent".to_string(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .expect("failure agent starts");
        assert!(matches!(
            connection.new_session(NewSessionRequest::new("/tmp")).await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(matches!(
            connection.list_sessions(ListSessionsRequest::new()).await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(matches!(
            connection
                .load_session(LoadSessionRequest::new("load-session", "/tmp"))
                .await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(connection
            .session(&SessionId::new("load-session"))
            .await
            .is_none());
        assert!(matches!(
            connection
                .resume_session(ResumeSessionRequest::new("resume-session", "/tmp"))
                .await,
            Err(AcpRuntimeError::Connection(_))
        ));
        assert!(connection
            .session(&SessionId::new("resume-session"))
            .await
            .is_none());
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn prompt_admission_does_not_block_list_or_cancel() {
        let prompt_responder = Arc::new(StdMutex::new(None::<Responder<PromptResponse>>));
        let (prompt_seen_tx, prompt_seen_rx) = oneshot::channel();
        let prompt_seen_tx = Arc::new(StdMutex::new(Some(prompt_seen_tx)));
        let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel();
        let cancel_seen_tx = Arc::new(StdMutex::new(Some(cancel_seen_tx)));
        let agent = Agent.builder()
            .on_receive_request(async |request: InitializeRequest, responder, _| {
                let capabilities = AgentCapabilities::new().load_session(true).session_capabilities(
                    SessionCapabilities::new().list(SessionListCapabilities::new()).resume(SessionResumeCapabilities::new()),
                );
                responder.respond(InitializeResponse::new(request.protocol_version).agent_capabilities(capabilities))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: NewSessionRequest, responder, _| {
                responder.respond(NewSessionResponse::new("session-1"))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ListSessionsRequest, responder, _| {
                responder.respond(ListSessionsResponse::new(vec![SessionInfo::new("session-1", "/tmp")]))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request({
                let prompt_responder = prompt_responder.clone();
                let prompt_seen_tx = prompt_seen_tx.clone();
                async move |request: PromptRequest, responder, connection| {
                    for value in [
                        serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"active-tool","title":"Run","kind":"execute","status":"in_progress"}),
                        serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"active-tool","title":"Run","kind":"execute","status":"in_progress"}),
                        serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"active-tool","status":"completed"}),
                        serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"active-tool","status":"completed"}),
                    ] { connection.send_notification(SessionNotification::new(request.session_id.clone(), update(value)))?; }
                    *prompt_responder.lock().expect("prompt responder lock") = Some(responder);
                    if let Some(sender) = prompt_seen_tx.lock().expect("prompt seen lock").take() { let _ = sender.send(()); }
                    Ok(())
                }
            }, agent_client_protocol::on_receive_request!())
            .on_receive_notification({
                let cancel_seen_tx = cancel_seen_tx.clone();
                async move |_cancel: CancelNotification, _| {
                    if let Some(sender) = cancel_seen_tx.lock().expect("cancel lock").take() { let _ = sender.send(()); }
                    Ok(())
                }
            }, agent_client_protocol::on_receive_notification!());

        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("new session");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered before return");
        let mut events = session.take_events().await.expect("session event receiver");
        let admission = tokio::time::timeout(
            Duration::from_secs(1),
            connection.prompt(
                PromptRequest::new(created.session_id.clone(), vec!["hello".into()]),
                "run-1".to_string(),
                "turn-1".to_string(),
            ),
        )
        .await
        .expect("prompt admission does not wait for response")
        .expect("prompt admitted");
        assert_eq!(admission.generation, 1);
        prompt_seen_rx.await.expect("agent received prompt");
        let listed = tokio::time::timeout(
            Duration::from_secs(1),
            connection.list_sessions(ListSessionsRequest::new()),
        )
        .await
        .expect("list remains processable")
        .expect("list succeeds");
        assert_eq!(listed.sessions.len(), 1);
        assert!(
            session.snapshot().await.active_tool_ids.is_empty(),
            "duplicate terminal updates clear the active tool exactly once"
        );
        connection
            .cancel(created.session_id.clone())
            .await
            .expect("cancel notification sent");
        cancel_seen_rx.await.expect("agent received cancel");
        prompt_responder
            .lock()
            .expect("prompt responder lock")
            .take()
            .expect("pending prompt responder")
            .respond(PromptResponse::new(StopReason::Cancelled))
            .expect("prompt responds");
        loop {
            if let CanonicalEvent::RunFinished { stop_reason, .. } =
                events.recv().await.expect("terminal event")
            {
                assert_eq!(stop_reason, StopReason::Cancelled);
                break;
            }
        }
        assert!(session.snapshot().await.active_generation.is_none());
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn cancelling_typed_new_session_cancels_agent_future_without_mutation() {
        let signal = RequestCancellation::default();
        assert!(!signal.is_cancelled());
        let waiter = {
            let signal = signal.clone();
            tokio::spawn(async move { signal.cancelled().await })
        };
        signal.cancel();
        waiter.await.unwrap();
        assert!(signal.is_cancelled());
        signal.cancelled().await;

        let attempts = Arc::new(AtomicUsize::new(0));
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let cancelled_tx = Arc::new(StdMutex::new(Some(cancelled_tx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let attempts = attempts.clone();
                    let cancelled_tx = cancelled_tx.clone();
                    move |_: NewSessionRequest, responder: Responder<NewSessionResponse>, _| {
                        let attempts = attempts.clone();
                        let cancelled_tx = cancelled_tx.clone();
                        async move {
                            if attempts.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                                tokio::spawn(async move {
                                    responder.cancellation().cancelled().await;
                                    if let Some(sender) =
                                        cancelled_tx.lock().expect("cancelled sender lock").take()
                                    {
                                        let _ = sender.send(());
                                    }
                                });
                                Ok(())
                            } else {
                                responder.respond(NewSessionResponse::new("independent-session"))
                            }
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) = AcpConnection::start_transport(
            "cancellation-agent".into(),
            agent,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let cancellation = RequestCancellation::default();
        let request = {
            let connection = connection.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                connection
                    .new_session_with_cancellation(NewSessionRequest::new("/tmp"), cancellation)
                    .await
            })
        };
        while attempts.load(AtomicOrdering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        cancellation.cancel();
        assert!(matches!(
            request.await.unwrap(),
            Err(AcpRuntimeError::RequestCancelled)
        ));
        tokio::time::timeout(Duration::from_secs(1), cancelled_rx)
            .await
            .expect("agent request future cancelled")
            .expect("cancellation signal delivered");
        assert!(connection.loaded_sessions().await.is_empty());

        let independent = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("independent request remains usable");
        assert_eq!(independent.session_id.to_string(), "independent-session");
        assert_eq!(connection.loaded_sessions().await.len(), 1);
        connection.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn load_reconstructs_all_update_families_and_resume_registers_sessions() {
        let next_session = Arc::new(AtomicUsize::new(0));
        let agent = Agent.builder()
            .on_receive_request(async |_request: InitializeRequest, responder, _| {
                responder.respond(initialized(AgentCapabilities::new().load_session(true).session_capabilities(
                    SessionCapabilities::new().list(SessionListCapabilities::new()).resume(SessionResumeCapabilities::new()),
                )))
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request({
                let next_session = next_session.clone();
                async move |_request: NewSessionRequest, responder, _| {
                    let number = next_session.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    responder.respond(NewSessionResponse::new(format!("session-{number}")))
                }
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |request: LoadSessionRequest, responder, connection| {
                for index in 0..140 {
                    connection.send_notification(SessionNotification::new(request.session_id.clone(), update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"},"messageId":format!("bounded-{index}")}))))?;
                }
                let values = vec![
                    serde_json::json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"user"}}),
                    serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}),
                    serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}),
                    serde_json::json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}),
                    serde_json::json!({"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read","kind":"read","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"partial"}}]}),
                    serde_json::json!({"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"done"}}]}),
                    serde_json::json!({"sessionUpdate":"plan","entries":[{"content":"Ship","priority":"high","status":"in_progress"}]}),
                    serde_json::json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Review changes"}]}),
                    serde_json::json!({"sessionUpdate":"current_mode_update","currentModeId":"plan"}),
                    serde_json::json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"fast","name":"Fast","type":"boolean","currentValue":true}]}),
                    serde_json::json!({"sessionUpdate":"session_info_update","title":"Loaded","updatedAt":"2026-07-19T00:00:00Z"}),
                    serde_json::json!({"sessionUpdate":"usage_update","used":42,"size":100,"cost":{"amount":1.25,"currency":"USD"}}),
                ];
                for value in values { connection.send_notification(SessionNotification::new(request.session_id.clone(), update(value)))?; }
                responder.respond(LoadSessionResponse::new())
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ResumeSessionRequest, responder, _| {
                responder.respond(ResumeSessionResponse::new())
            }, agent_client_protocol::on_receive_request!())
            .on_receive_request(async |_request: ListSessionsRequest, responder, connection| {
                connection.send_notification(SessionNotification::new("session-1", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"one"},"messageId":"one"}))))?;
                connection.send_notification(SessionNotification::new("session-2", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"two"},"messageId":"two"}))))?;
                connection.send_notification(SessionNotification::new("late-session", update(serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"buffered"},"messageId":"late"}))))?;
                responder.respond(ListSessionsResponse::new(vec![]))
            }, agent_client_protocol::on_receive_request!());

        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let first = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("first session");
        let first_session = connection
            .session(&first.session_id)
            .await
            .expect("first registered");
        let mut live_events = first_session
            .take_events()
            .await
            .expect("session event receiver");
        connection
            .load_session(LoadSessionRequest::new(first.session_id.clone(), "/tmp"))
            .await
            .expect("load succeeds");
        assert!(
            live_events.try_recv().is_err(),
            "load replay is not broadcast live"
        );
        let snapshot = first_session.snapshot().await;
        assert!(!snapshot.history_reconstruction);
        assert_eq!(snapshot.messages.len(), 128);
        assert!(snapshot.messages.iter().any(|message| message.parts
            == vec![serde_json::json!({
                "type": "text",
                "text": "hello world",
            })]));
        assert_eq!(
            snapshot.tools["tool-1"].status,
            agent_client_protocol::schema::v1::ToolCallStatus::Completed
        );
        assert_eq!(snapshot.plan[0].content, "Ship");
        assert_eq!(snapshot.commands[0].name, "review");
        assert_eq!(snapshot.mode_id.as_deref(), Some("plan"));
        assert_eq!(snapshot.config[0].value, "true");
        assert_eq!(snapshot.title.as_deref(), Some("Loaded"));
        assert_eq!(snapshot.updated_at.as_deref(), Some("2026-07-19T00:00:00Z"));
        assert_eq!(snapshot.usage_used, Some(42));
        assert_eq!(snapshot.usage_size, Some(100));
        assert_eq!(snapshot.usage_cost.as_deref(), Some("1.25 USD"));

        let second = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("second session");
        connection
            .resume_session(ResumeSessionRequest::new(second.session_id.clone(), "/tmp"))
            .await
            .expect("resume succeeds");
        let second_session = connection
            .session(&second.session_id)
            .await
            .expect("resumed session registered");
        connection
            .list_sessions(ListSessionsRequest::new())
            .await
            .expect("interleaved notifications sent");
        assert!(first_session
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "one"));
        assert!(second_session
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "two"));
        connection
            .resume_session(ResumeSessionRequest::new("late-session", "/tmp"))
            .await
            .expect("late session resumes");
        let late_id = agent_client_protocol::schema::v1::SessionId::new("late-session");
        assert!(connection
            .session(&late_id)
            .await
            .expect("late session registered")
            .snapshot()
            .await
            .messages
            .iter()
            .any(|message| message.id == "late"));
        connection.shutdown().await.expect("connection shuts down");
    }

    #[tokio::test]
    async fn connection_loss_while_cancelling_fails_generation_exactly_once() {
        let (release_tx, release_rx) = oneshot::channel();
        let release_rx = Arc::new(StdMutex::new(Some(release_rx)));
        let agent = Agent
            .builder()
            .on_receive_request(
                async |_request: InitializeRequest, responder, _| {
                    responder.respond(initialized(AgentCapabilities::new()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new("session-loss"))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let release_rx = release_rx.clone();
                    async move |_request: PromptRequest, _responder, _| {
                        let receiver = { release_rx.lock().expect("release lock").take() };
                        if let Some(receiver) = receiver {
                            let _ = receiver.await;
                        }
                        Err::<(), _>(agent_client_protocol::util::internal_error(
                            "agent connection lost",
                        ))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        let (connection, _) =
            AcpConnection::start_transport("test-agent".to_string(), agent, Duration::from_secs(1))
                .await
                .expect("agent starts");
        let created = connection
            .new_session(NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let session = connection
            .session(&created.session_id)
            .await
            .expect("session registered");
        let mut events = session.take_events().await.expect("session event receiver");
        connection
            .prompt(
                PromptRequest::new(created.session_id.clone(), vec!["fail".into()]),
                "run-loss".to_string(),
                "turn-loss".to_string(),
            )
            .await
            .expect("prompt admitted");
        connection
            .cancel(created.session_id)
            .await
            .expect("cancel accepted before connection loss");
        assert!(matches!(
            session.begin_reconstruction().await,
            Err(ReconstructionError::Cancelled)
        ));
        release_tx.send(()).expect("release agent failure");
        let terminal = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let CanonicalEvent::RunFailed { run_id, .. } =
                    events.recv().await.expect("failure event")
                {
                    break run_id;
                }
            }
        })
        .await
        .expect("connection failure fans out");
        assert_eq!(terminal, "run-loss");
        assert!(session.snapshot().await.active_generation.is_none());
        tokio::task::yield_now().await;
        assert!(
            events.try_recv().is_err(),
            "old generation fails exactly once"
        );
    }
}
