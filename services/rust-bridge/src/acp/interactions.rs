use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction,
    ElicitationAction, ElicitationContentValue, ElicitationMode, ElicitationPropertySchema,
    ElicitationSchema, ElicitationScope, MultiSelectItems, PermissionOptionKind,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, ToolCallStatus, ToolKind,
};
use agent_client_protocol::Responder;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::events::CanonicalEvent;
use super::session::SessionRegistry;

const MAX_PENDING_GLOBAL: usize = 128;
const MAX_PENDING_PER_SESSION: usize = 16;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InteractionError {
    #[error("unknown ACP interaction request: {0}")]
    UnknownRequest(String),
    #[error("permission option was not advertised: {0}")]
    InvalidPermissionOption(String),
    #[error("permission request has no advertised reject option: {0}")]
    NoRejectOption(String),
    #[error("elicitation response does not match the requested schema: {0}")]
    InvalidElicitation(String),
    #[error("ACP interaction response failed: {0}")]
    Response(String),
    #[error("ACP interaction request belongs to another thread: {0}")]
    WrongOwner(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOptionSummary {
    pub id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPermissionSummary {
    pub agent_id: String,
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: ToolKind,
    pub status: ToolCallStatus,
    pub options: Vec<PermissionOptionSummary>,
    pub requested_at: String,
    pub requested_order: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElicitationFieldKind {
    String,
    Integer,
    Number,
    Boolean,
    StringArray,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElicitationFieldSummary {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub kind: ElicitationFieldKind,
    pub required: bool,
    pub sensitive: bool,
    pub options: Vec<(String, String)>,
    pub default: Option<ElicitationContentValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingElicitationSummary {
    pub agent_id: String,
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub tool_call_id: Option<String>,
    pub message: String,
    pub fields: Vec<ElicitationFieldSummary>,
    pub requested_at: String,
    pub requested_order: u64,
}

#[derive(Clone)]
pub struct InteractionRegistry {
    inner: Arc<Mutex<InteractionState>>,
    sessions: SessionRegistry,
    max_global: usize,
    max_per_session: usize,
}

#[derive(Default)]
struct InteractionState {
    next_order: u64,
    session_epochs: HashMap<SessionId, u64>,
    permissions: HashMap<String, PermissionEntry>,
    elicitations: HashMap<String, ElicitationEntry>,
}

struct PermissionEntry {
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
    summary: PendingPermissionSummary,
    session_id: SessionId,
    generation: u64,
    _session_lease: super::session::SessionLease,
    #[cfg(test)]
    fail_cancel_response: bool,
}

struct ElicitationEntry {
    schema: ElicitationSchema,
    responder: Responder<CreateElicitationResponse>,
    summary: PendingElicitationSummary,
    session_id: SessionId,
    generation: u64,
    _session_lease: super::session::SessionLease,
    #[cfg(test)]
    fail_cancel_response: bool,
}

impl InteractionRegistry {
    fn bump_epoch(state: &mut InteractionState, session_id: &SessionId) -> u64 {
        let epoch = state.session_epochs.entry(session_id.clone()).or_default();
        *epoch = epoch.saturating_add(1);
        *epoch
    }

    pub fn new(sessions: SessionRegistry) -> Self {
        Self::with_limits(sessions, MAX_PENDING_GLOBAL, MAX_PENDING_PER_SESSION)
    }

    fn with_limits(sessions: SessionRegistry, max_global: usize, max_per_session: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InteractionState::default())),
            sessions,
            max_global,
            max_per_session,
        }
    }

    pub async fn register_permission(
        &self,
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let cancellation = responder.cancellation();
        let Some(session_lease) = self.sessions.lease(&request.session_id).await else {
            return responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        };
        let session = session_lease.session().clone();
        let mut state = self.inner.lock().await;
        let Some(generation) = session.active_interaction_generation().await else {
            drop(state);
            return responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        };
        let snapshot = session.snapshot().await;
        let thread_id = snapshot.thread_id;
        let turn_id = snapshot.active_source_turn_id.unwrap_or_default();
        let agent_id = snapshot.agent_id;
        if self.at_capacity(&state, Some(&request.session_id)) {
            drop(state);
            return responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }
        let (request_id, requested_order) = allocate(&mut state, &agent_id, &thread_id);
        Self::bump_epoch(&mut state, &request.session_id);
        let summary = permission_summary(
            &request_id,
            requested_order,
            agent_id,
            thread_id,
            turn_id,
            &request,
        );
        state.permissions.insert(
            request_id.clone(),
            PermissionEntry {
                session_id: request.session_id.clone(),
                request,
                responder,
                summary: summary.clone(),
                generation,
                _session_lease: session_lease,
                #[cfg(test)]
                fail_cancel_response: false,
            },
        );
        drop(state);
        emit_permission(&session, &summary, true, None).await;
        let registry = self.clone();
        tokio::spawn(async move {
            cancellation.cancelled().await;
            registry.cancel_permission_from_peer(&request_id).await;
        });
        Ok(())
    }

    pub async fn register_elicitation(
        &self,
        request: CreateElicitationRequest,
        responder: Responder<CreateElicitationResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        if matches!(request.scope(), ElicitationScope::Request(_)) {
            return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        }
        let cancellation = responder.cancellation();
        let session_id = match request.scope() {
            ElicitationScope::Session(scope) => self
                .sessions
                .lease(&scope.session_id)
                .await
                .map(|lease| (scope.session_id.clone(), lease)),
            _ => None,
        };
        let Some((session_id, session_lease)) = session_id else {
            return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        };
        let ElicitationMode::Form(form) = &request.mode else {
            return responder.respond_with_error(
                agent_client_protocol::Error::method_not_found()
                    .data("only form elicitation is supported"),
            );
        };
        let schema = form.requested_schema.clone();
        let mut state = self.inner.lock().await;
        let session = session_lease.session().clone();
        let Some(generation) = session.active_interaction_generation().await else {
            drop(state);
            return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        };
        let snapshot = session.snapshot().await;
        let agent_id = snapshot.agent_id;
        let thread_id = snapshot.thread_id;
        let turn_id = snapshot.active_source_turn_id.unwrap_or_default();
        if self.at_capacity(&state, Some(&session_id)) {
            drop(state);
            return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        }
        let (request_id, requested_order) = allocate(&mut state, &agent_id, &thread_id);
        Self::bump_epoch(&mut state, &session_id);
        let summary = elicitation_summary(
            &request_id,
            requested_order,
            agent_id,
            thread_id,
            turn_id,
            &request,
        );
        state.elicitations.insert(
            request_id.clone(),
            ElicitationEntry {
                schema,
                responder,
                summary: summary.clone(),
                session_id: session_id.clone(),
                generation,
                _session_lease: session_lease,
                #[cfg(test)]
                fail_cancel_response: false,
            },
        );
        drop(state);
        if let Some(session) = self.sessions.get(&session_id).await {
            emit_elicitation(&session, &summary, true, None).await;
        }
        let registry = self.clone();
        tokio::spawn(async move {
            cancellation.cancelled().await;
            registry.cancel_elicitation_from_peer(&request_id).await;
        });
        Ok(())
    }

    pub async fn pending_permissions(&self) -> Vec<PendingPermissionSummary> {
        let state = self.inner.lock().await;
        let mut summaries: Vec<_> = state
            .permissions
            .values()
            .map(|entry| entry.summary.clone())
            .collect();
        summaries.sort_by_key(|summary| summary.requested_order);
        summaries
    }

    pub async fn pending_elicitations(&self) -> Vec<PendingElicitationSummary> {
        let state = self.inner.lock().await;
        let mut summaries: Vec<_> = state
            .elicitations
            .values()
            .map(|entry| entry.summary.clone())
            .collect();
        summaries.sort_by_key(|summary| summary.requested_order);
        summaries
    }

    pub async fn resolve_permission(
        &self,
        thread_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), InteractionError> {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state
                .permissions
                .get(request_id)
                .ok_or_else(|| InteractionError::UnknownRequest(request_id.to_string()))?;
            if entry.summary.thread_id != thread_id {
                return Err(InteractionError::WrongOwner(request_id.to_string()));
            }
            if !entry
                .request
                .options
                .iter()
                .any(|option| option.option_id.0.as_ref() == option_id)
            {
                return Err(InteractionError::InvalidPermissionOption(
                    option_id.to_string(),
                ));
            }
            let entry = state.permissions.remove(request_id).expect("entry exists");
            Self::bump_epoch(&mut state, &entry.session_id);
            entry
        };
        let outcome = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option_id.to_string(),
        ));
        let summary = entry.summary.clone();
        let session_id = entry.session_id.clone();
        let response = entry
            .responder
            .respond(RequestPermissionResponse::new(outcome))
            .map_err(response_error);
        self.emit_permission_resolved(&session_id, &summary, option_id)
            .await;
        response
    }

    pub async fn cancel_permission(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), InteractionError> {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state
                .permissions
                .get(request_id)
                .ok_or_else(|| InteractionError::UnknownRequest(request_id.to_string()))?;
            if entry.summary.thread_id != thread_id {
                return Err(InteractionError::WrongOwner(request_id.to_string()));
            }
            let entry = state.permissions.remove(request_id).expect("entry exists");
            Self::bump_epoch(&mut state, &entry.session_id);
            entry
        };
        let summary = entry.summary.clone();
        let session_id = entry.session_id.clone();
        let response = entry
            .responder
            .respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ))
            .map_err(response_error);
        self.emit_permission_resolved(&session_id, &summary, "cancelled")
            .await;
        response
    }

    pub async fn accept_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        values: BTreeMap<String, ElicitationContentValue>,
    ) -> Result<(), InteractionError> {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state
                .elicitations
                .get(request_id)
                .ok_or_else(|| InteractionError::UnknownRequest(request_id.to_string()))?;
            if entry.summary.thread_id != thread_id {
                return Err(InteractionError::WrongOwner(request_id.to_string()));
            }
            validate_elicitation(&entry.schema, &values)?;
            let entry = state.elicitations.remove(request_id).expect("entry exists");
            Self::bump_epoch(&mut state, &entry.session_id);
            entry
        };
        let summary = entry.summary.clone();
        let session_id = entry.session_id.clone();
        let response = entry
            .responder
            .respond(CreateElicitationResponse::new(ElicitationAction::Accept(
                ElicitationAcceptAction::new().content(values),
            )))
            .map_err(response_error);
        self.emit_elicitation_resolved(&session_id, &summary, "accepted")
            .await;
        response
    }

    pub async fn decline_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), InteractionError> {
        self.finish_elicitation(
            thread_id,
            request_id,
            ElicitationAction::Decline,
            "declined",
        )
        .await
    }

    pub async fn cancel_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), InteractionError> {
        self.finish_elicitation(
            thread_id,
            request_id,
            ElicitationAction::Cancel,
            "cancelled",
        )
        .await
    }

    pub async fn cancel_session(
        &self,
        session_id: &SessionId,
    ) -> (Option<u64>, Vec<InteractionError>) {
        let mut state = self.inner.lock().await;
        let generation = match self.sessions.get(session_id).await {
            Some(session) => session.mark_cancelling().await,
            None => None,
        };
        let permissions = state
            .permissions
            .extract_if(|_, entry| {
                &entry.session_id == session_id && generation == Some(entry.generation)
            })
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        let elicitations = state
            .elicitations
            .extract_if(|_, entry| {
                &entry.session_id == session_id && generation == Some(entry.generation)
            })
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        if !permissions.is_empty() || !elicitations.is_empty() {
            Self::bump_epoch(&mut state, session_id);
        }
        drop(state);
        let mut errors = Vec::new();
        for entry in permissions {
            let summary = entry.summary.clone();
            #[cfg(test)]
            let response = if entry.fail_cancel_response {
                Err(InteractionError::Response(
                    "injected permission cancellation failure".to_string(),
                ))
            } else {
                entry
                    .responder
                    .respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ))
                    .map_err(response_error)
            };
            #[cfg(not(test))]
            let response = entry
                .responder
                .respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
                .map_err(response_error);
            if let Err(error) = response {
                errors.push(error);
            }
            self.emit_permission_resolved(session_id, &summary, "cancelled")
                .await;
        }
        for entry in elicitations {
            let summary = entry.summary.clone();
            #[cfg(test)]
            let response = if entry.fail_cancel_response {
                Err(InteractionError::Response(
                    "injected elicitation cancellation failure".to_string(),
                ))
            } else {
                entry
                    .responder
                    .respond(CreateElicitationResponse::new(ElicitationAction::Cancel))
                    .map_err(response_error)
            };
            #[cfg(not(test))]
            let response = entry
                .responder
                .respond(CreateElicitationResponse::new(ElicitationAction::Cancel))
                .map_err(response_error);
            if let Err(error) = response {
                errors.push(error);
            }
            self.emit_elicitation_resolved(session_id, &summary, "cancelled")
                .await;
        }
        if !errors.is_empty() {
            if let Some(session) = self.sessions.get(session_id).await {
                let snapshot = session.snapshot().await;
                session
                    .emit(CanonicalEvent::Ignored {
                        agent_id: snapshot.agent_id,
                        thread_id: Some(snapshot.thread_id),
                        kind: "interaction_cancel_response_failed".to_string(),
                    })
                    .await;
            }
        }
        (generation, errors)
    }

    #[cfg(test)]
    pub async fn inject_cancel_response_failures(
        &self,
        session_id: &SessionId,
        permission: bool,
        elicitation: bool,
    ) {
        let mut state = self.inner.lock().await;
        for entry in state
            .permissions
            .values_mut()
            .filter(|entry| &entry.session_id == session_id)
        {
            entry.fail_cancel_response = permission;
        }
        for entry in state
            .elicitations
            .values_mut()
            .filter(|entry| &entry.session_id == session_id)
        {
            entry.fail_cancel_response = elicitation;
        }
    }

    #[cfg(test)]
    pub async fn cancel_permissions_for_session(
        &self,
        session_id: &SessionId,
    ) -> Result<(), InteractionError> {
        let permissions = {
            let state = self.inner.lock().await;
            state
                .permissions
                .iter()
                .filter(|(_, entry)| &entry.request.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        for id in permissions {
            let thread_id = self
                .inner
                .lock()
                .await
                .permissions
                .get(&id)
                .map(|entry| entry.summary.thread_id.clone());
            let Some(thread_id) = thread_id else { continue };
            match self.cancel_permission(&thread_id, &id).await {
                Ok(()) | Err(InteractionError::UnknownRequest(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub async fn prepare_steer(&self, session_id: &SessionId) -> Result<u64, InteractionError> {
        let (permissions, elicitations, epoch) = {
            let mut state = self.inner.lock().await;
            let plans = state
                .permissions
                .iter()
                .filter(|(_, entry)| &entry.request.session_id == session_id)
                .map(|(id, entry)| {
                    let reject =
                        entry
                            .request
                            .options
                            .iter()
                            .find(|option| option.kind == PermissionOptionKind::RejectOnce)
                            .or_else(|| {
                                entry.request.options.iter().find(|option| {
                                    option.kind == PermissionOptionKind::RejectAlways
                                })
                            })
                            .map(|option| option.option_id.to_string())
                            .ok_or_else(|| InteractionError::NoRejectOption(id.clone()))?;
                    Ok((id.clone(), reject))
                })
                .collect::<Result<Vec<_>, InteractionError>>()?;
            let elicitation_ids = state
                .elicitations
                .iter()
                .filter(|(_, entry)| &entry.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let permissions = plans
                .into_iter()
                .filter_map(|(id, option_id)| {
                    state
                        .permissions
                        .remove(&id)
                        .map(|entry| (entry, option_id))
                })
                .collect::<Vec<_>>();
            let elicitations = elicitation_ids
                .into_iter()
                .filter_map(|id| state.elicitations.remove(&id))
                .collect::<Vec<_>>();
            if !permissions.is_empty() || !elicitations.is_empty() {
                Self::bump_epoch(&mut state, session_id);
            }
            let epoch = state
                .session_epochs
                .get(session_id)
                .copied()
                .unwrap_or_default();
            (permissions, elicitations, epoch)
        };
        for (entry, option_id) in permissions {
            let summary = entry.summary.clone();
            let response = entry.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    option_id.clone(),
                )),
            ));
            self.emit_permission_resolved(session_id, &summary, &option_id)
                .await;
            if let Err(error) = response {
                return Err(response_error(error));
            }
        }
        for entry in elicitations {
            let summary = entry.summary.clone();
            let response = entry
                .responder
                .respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
            self.emit_elicitation_resolved(session_id, &summary, "cancelled")
                .await;
            if let Err(error) = response {
                return Err(response_error(error));
            }
        }
        Ok(epoch)
    }

    pub async fn verify_steer_epoch(&self, session_id: &SessionId, epoch: u64) -> bool {
        let state = self.inner.lock().await;
        state
            .session_epochs
            .get(session_id)
            .copied()
            .unwrap_or_default()
            == epoch
            && !state
                .permissions
                .values()
                .any(|entry| &entry.session_id == session_id)
            && !state
                .elicitations
                .values()
                .any(|entry| &entry.session_id == session_id)
    }

    pub async fn with_verified_steer_epoch<T>(
        &self,
        session_id: &SessionId,
        epoch: u64,
        send: impl FnOnce() -> T,
    ) -> Option<T> {
        let state = self.inner.lock().await;
        let valid = state
            .session_epochs
            .get(session_id)
            .copied()
            .unwrap_or_default()
            == epoch
            && !state
                .permissions
                .values()
                .any(|entry| &entry.session_id == session_id)
            && !state
                .elicitations
                .values()
                .any(|entry| &entry.session_id == session_id);
        valid.then(send)
    }

    pub async fn drain(&self) {
        let (permissions, elicitations) = {
            let mut state = self.inner.lock().await;
            let permissions = std::mem::take(&mut state.permissions);
            let elicitations = std::mem::take(&mut state.elicitations);
            for entry in permissions.values() {
                Self::bump_epoch(&mut state, &entry.session_id);
            }
            for entry in elicitations.values() {
                Self::bump_epoch(&mut state, &entry.session_id);
            }
            (permissions, elicitations)
        };
        for (_, entry) in permissions {
            let _ = entry.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
            self.emit_permission_resolved(&entry.session_id, &entry.summary, "cancelled")
                .await;
        }
        for (_, entry) in elicitations {
            let summary = entry.summary.clone();
            let session_id = entry.session_id.clone();
            let _ = entry
                .responder
                .respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
            self.emit_elicitation_resolved(&session_id, &summary, "cancelled")
                .await;
        }
    }

    fn at_capacity(&self, state: &InteractionState, session_id: Option<&SessionId>) -> bool {
        let total = state.permissions.len() + state.elicitations.len();
        if total >= self.max_global {
            return true;
        }
        let Some(session_id) = session_id else {
            return false;
        };
        let session_total = state
            .permissions
            .values()
            .filter(|entry| &entry.request.session_id == session_id)
            .count()
            + state
                .elicitations
                .values()
                .filter(|entry| &entry.session_id == session_id)
                .count();
        session_total >= self.max_per_session
    }

    async fn finish_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        action: ElicitationAction,
        resolution: &str,
    ) -> Result<(), InteractionError> {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state
                .elicitations
                .get(request_id)
                .ok_or_else(|| InteractionError::UnknownRequest(request_id.to_string()))?;
            if entry.summary.thread_id != thread_id {
                return Err(InteractionError::WrongOwner(request_id.to_string()));
            }
            let entry = state.elicitations.remove(request_id).expect("entry exists");
            Self::bump_epoch(&mut state, &entry.session_id);
            entry
        };
        let summary = entry.summary.clone();
        let session_id = entry.session_id.clone();
        let response = entry
            .responder
            .respond(CreateElicitationResponse::new(action))
            .map_err(response_error);
        self.emit_elicitation_resolved(&session_id, &summary, resolution)
            .await;
        response
    }

    async fn cancel_permission_from_peer(&self, request_id: &str) {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state.permissions.remove(request_id);
            if let Some(entry) = &entry {
                Self::bump_epoch(&mut state, &entry.session_id);
            }
            entry
        };
        if let Some(entry) = entry {
            let _ = entry.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
            self.emit_permission_resolved(&entry.session_id, &entry.summary, "request_cancelled")
                .await;
        }
    }

    async fn cancel_elicitation_from_peer(&self, request_id: &str) {
        let entry = {
            let mut state = self.inner.lock().await;
            let entry = state.elicitations.remove(request_id);
            if let Some(entry) = &entry {
                Self::bump_epoch(&mut state, &entry.session_id);
            }
            entry
        };
        if let Some(entry) = entry {
            let summary = entry.summary.clone();
            let session_id = entry.session_id.clone();
            let _ = entry
                .responder
                .respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
            self.emit_elicitation_resolved(&session_id, &summary, "request_cancelled")
                .await;
        }
    }

    async fn emit_permission_resolved(
        &self,
        session_id: &SessionId,
        summary: &PendingPermissionSummary,
        outcome: &str,
    ) {
        if let Some(session) = self.sessions.get(session_id).await {
            emit_permission(&session, summary, false, Some(outcome)).await;
        }
    }

    async fn emit_elicitation_resolved(
        &self,
        session_id: &SessionId,
        summary: &PendingElicitationSummary,
        action: &str,
    ) {
        if let Some(session) = self.sessions.get(session_id).await {
            emit_elicitation(&session, summary, false, Some(action)).await;
        }
    }
}

fn allocate(state: &mut InteractionState, agent_id: &str, thread_id: &str) -> (String, u64) {
    state.next_order += 1;
    (
        format!(
            "acp-interaction:{}:{}:{}",
            agent_id,
            thread_id,
            Uuid::new_v4()
        ),
        state.next_order,
    )
}

fn permission_summary(
    request_id: &str,
    requested_order: u64,
    agent_id: String,
    thread_id: String,
    turn_id: String,
    request: &RequestPermissionRequest,
) -> PendingPermissionSummary {
    PendingPermissionSummary {
        agent_id,
        request_id: request_id.to_string(),
        thread_id,
        turn_id,
        tool_call_id: request.tool_call.tool_call_id.to_string(),
        title: request.tool_call.fields.title.clone().unwrap_or_default(),
        kind: request.tool_call.fields.kind.unwrap_or(ToolKind::Other),
        status: request
            .tool_call
            .fields
            .status
            .unwrap_or(ToolCallStatus::Pending),
        options: request
            .options
            .iter()
            .map(|option| PermissionOptionSummary {
                id: option.option_id.to_string(),
                name: option.name.clone(),
                kind: option.kind,
            })
            .collect(),
        requested_at: chrono::Utc::now().to_rfc3339(),
        requested_order,
    }
}

fn elicitation_summary(
    request_id: &str,
    requested_order: u64,
    agent_id: String,
    thread_id: String,
    turn_id: String,
    request: &CreateElicitationRequest,
) -> PendingElicitationSummary {
    let tool_call_id = match request.scope() {
        ElicitationScope::Session(scope) => scope.tool_call_id.as_ref().map(ToString::to_string),
        _ => None,
    };
    let fields = match &request.mode {
        ElicitationMode::Form(form) => form
            .requested_schema
            .properties
            .iter()
            .map(|(name, schema)| field_summary(name, schema, &form.requested_schema))
            .collect(),
        _ => Vec::new(),
    };
    PendingElicitationSummary {
        agent_id,
        request_id: request_id.to_string(),
        thread_id,
        turn_id,
        tool_call_id,
        message: request.message.clone(),
        fields,
        requested_at: chrono::Utc::now().to_rfc3339(),
        requested_order,
    }
}

fn field_summary(
    name: &str,
    property: &ElicitationPropertySchema,
    schema: &ElicitationSchema,
) -> ElicitationFieldSummary {
    let required = schema
        .required
        .as_ref()
        .is_some_and(|required| required.iter().any(|field| field == name));
    let (title, description, kind, options, default, meta) = match property {
        ElicitationPropertySchema::String(value) => (
            value.title.clone(),
            value.description.clone(),
            ElicitationFieldKind::String,
            value
                .one_of
                .as_ref()
                .map(|options| {
                    options
                        .iter()
                        .map(|option| (option.value.clone(), option.title.clone()))
                        .collect()
                })
                .or_else(|| {
                    value.enum_values.as_ref().map(|options| {
                        options
                            .iter()
                            .map(|option| (option.clone(), option.clone()))
                            .collect()
                    })
                })
                .unwrap_or_default(),
            value.default.clone().map(ElicitationContentValue::String),
            value.meta.as_ref(),
        ),
        ElicitationPropertySchema::Integer(value) => (
            value.title.clone(),
            value.description.clone(),
            ElicitationFieldKind::Integer,
            Vec::new(),
            value.default.map(ElicitationContentValue::Integer),
            value.meta.as_ref(),
        ),
        ElicitationPropertySchema::Number(value) => (
            value.title.clone(),
            value.description.clone(),
            ElicitationFieldKind::Number,
            Vec::new(),
            value.default.map(ElicitationContentValue::Number),
            value.meta.as_ref(),
        ),
        ElicitationPropertySchema::Boolean(value) => (
            value.title.clone(),
            value.description.clone(),
            ElicitationFieldKind::Boolean,
            Vec::new(),
            value.default.map(ElicitationContentValue::Boolean),
            value.meta.as_ref(),
        ),
        ElicitationPropertySchema::Array(value) => {
            let options = match &value.items {
                MultiSelectItems::String(items) => items
                    .values
                    .iter()
                    .map(|option| (option.clone(), option.clone()))
                    .collect(),
                MultiSelectItems::Titled(items) => items
                    .options
                    .iter()
                    .map(|option| (option.value.clone(), option.title.clone()))
                    .collect(),
                _ => Vec::new(),
            };
            (
                value.title.clone(),
                value.description.clone(),
                ElicitationFieldKind::StringArray,
                options,
                value
                    .default
                    .clone()
                    .map(ElicitationContentValue::StringArray),
                value.meta.as_ref(),
            )
        }
        _ => (
            None,
            None,
            ElicitationFieldKind::Unsupported,
            Vec::new(),
            None,
            None,
        ),
    };
    let sensitive = is_sensitive(name, title.as_deref(), description.as_deref(), meta);
    ElicitationFieldSummary {
        name: name.to_string(),
        title,
        description,
        kind,
        required,
        sensitive,
        options,
        default: (!sensitive).then_some(default).flatten(),
    }
}

fn is_sensitive(
    name: &str,
    title: Option<&str>,
    description: Option<&str>,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> bool {
    if meta.is_some_and(|meta| {
        ["secret", "sensitive", "isSecret", "isSensitive"]
            .iter()
            .any(|key| meta.get(*key).and_then(serde_json::Value::as_bool) == Some(true))
    }) {
        return true;
    }
    [Some(name), title, description]
        .into_iter()
        .flatten()
        .any(|value| {
            let value = value.to_ascii_lowercase();
            ["secret", "password", "passphrase", "token", "api key"]
                .iter()
                .any(|marker| value.contains(marker))
        })
}

fn validate_elicitation(
    schema: &ElicitationSchema,
    values: &BTreeMap<String, ElicitationContentValue>,
) -> Result<(), InteractionError> {
    if let Some(required) = &schema.required {
        for name in required {
            if !values.contains_key(name) {
                return invalid(format!("missing required field {name}"));
            }
        }
    }
    for (name, value) in values {
        let property = schema
            .properties
            .get(name)
            .ok_or_else(|| InteractionError::InvalidElicitation(format!("unknown field {name}")))?;
        validate_value(name, property, value)?;
    }
    Ok(())
}

fn validate_value(
    name: &str,
    property: &ElicitationPropertySchema,
    value: &ElicitationContentValue,
) -> Result<(), InteractionError> {
    match (property, value) {
        (ElicitationPropertySchema::String(schema), ElicitationContentValue::String(value)) => {
            let length = value.chars().count() as u32;
            if schema.min_length.is_some_and(|min| length < min)
                || schema.max_length.is_some_and(|max| length > max)
                || schema
                    .enum_values
                    .as_ref()
                    .is_some_and(|options| !options.contains(value))
                || schema
                    .one_of
                    .as_ref()
                    .is_some_and(|options| !options.iter().any(|option| option.value == *value))
                || schema.pattern.as_ref().is_some_and(|pattern| {
                    regex::Regex::new(pattern)
                        .map(|pattern| !pattern.is_match(value))
                        .unwrap_or(true)
                })
                || schema.format.is_some_and(|format| match format {
                    agent_client_protocol::schema::v1::StringFormat::Email => !valid_email(value),
                    agent_client_protocol::schema::v1::StringFormat::Uri => {
                        reqwest::Url::parse(value).is_err()
                    }
                    agent_client_protocol::schema::v1::StringFormat::Date => {
                        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
                    }
                    agent_client_protocol::schema::v1::StringFormat::DateTime => {
                        chrono::DateTime::parse_from_rfc3339(value).is_err()
                    }
                    _ => true,
                })
            {
                return invalid(format!("invalid string field {name}"));
            }
        }
        (ElicitationPropertySchema::Integer(schema), ElicitationContentValue::Integer(value)) => {
            if schema.minimum.is_some_and(|min| *value < min)
                || schema.maximum.is_some_and(|max| *value > max)
            {
                return invalid(format!("integer field {name} is out of range"));
            }
        }
        (ElicitationPropertySchema::Number(schema), ElicitationContentValue::Number(value)) => {
            if !value.is_finite()
                || schema.minimum.is_some_and(|min| *value < min)
                || schema.maximum.is_some_and(|max| *value > max)
            {
                return invalid(format!("number field {name} is out of range"));
            }
        }
        (ElicitationPropertySchema::Boolean(_), ElicitationContentValue::Boolean(_)) => {}
        (
            ElicitationPropertySchema::Array(schema),
            ElicitationContentValue::StringArray(values),
        ) => {
            let length = values.len() as u64;
            let valid_options = match &schema.items {
                MultiSelectItems::String(items) => Some(items.values.as_slice()),
                MultiSelectItems::Titled(items) => {
                    if values
                        .iter()
                        .all(|value| items.options.iter().any(|option| option.value == *value))
                    {
                        None
                    } else {
                        return invalid(format!("array field {name} has an invalid option"));
                    }
                }
                _ => return invalid(format!("array field {name} has unsupported items")),
            };
            if schema.min_items.is_some_and(|min| length < min)
                || schema.max_items.is_some_and(|max| length > max)
                || valid_options
                    .is_some_and(|options| values.iter().any(|value| !options.contains(value)))
            {
                return invalid(format!("invalid array field {name}"));
            }
        }
        _ => return invalid(format!("field {name} has the wrong type")),
    }
    Ok(())
}

fn valid_email(value: &str) -> bool {
    value.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
    })
}

fn invalid<T>(message: String) -> Result<T, InteractionError> {
    Err(InteractionError::InvalidElicitation(message))
}

fn response_error(error: agent_client_protocol::Error) -> InteractionError {
    InteractionError::Response(error.to_string())
}

async fn emit_permission(
    session: &super::session::AcpSession,
    summary: &PendingPermissionSummary,
    requested: bool,
    outcome: Option<&str>,
) {
    let snapshot = session.snapshot().await;
    let event = if requested {
        CanonicalEvent::PermissionRequested {
            approval: summary.clone().into(),
        }
    } else {
        CanonicalEvent::PermissionResolved {
            agent_id: snapshot.agent_id,
            thread_id: summary.thread_id.clone(),
            request_id: summary.request_id.clone(),
            outcome: outcome.unwrap_or("resolved").to_string(),
        }
    };
    session.emit(event).await;
}

async fn emit_elicitation(
    session: &super::session::AcpSession,
    summary: &PendingElicitationSummary,
    requested: bool,
    action: Option<&str>,
) {
    let snapshot = session.snapshot().await;
    let event = if requested {
        CanonicalEvent::ElicitationRequested {
            request: summary.clone().into(),
        }
    } else {
        CanonicalEvent::ElicitationResolved {
            agent_id: snapshot.agent_id,
            thread_id: snapshot.thread_id,
            request_id: summary.request_id.clone(),
            action: action.unwrap_or("resolved").to_string(),
        }
    };
    session.emit(event).await;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn steer_epoch_verification_accepts_only_current_stable_epoch() {
        let registry = InteractionRegistry::new(SessionRegistry::default());
        let session_id = SessionId::new("epoch-session");
        assert!(!registry.at_capacity(&InteractionState::default(), None));
        let zero_capacity = InteractionRegistry::with_limits(SessionRegistry::default(), 0, 0);
        assert!(zero_capacity.at_capacity(&InteractionState::default(), None));
        let zero_session_capacity =
            InteractionRegistry::with_limits(SessionRegistry::default(), 1, 0);
        assert!(zero_session_capacity.at_capacity(&InteractionState::default(), Some(&session_id)));
        assert!(registry.verify_steer_epoch(&session_id, 0).await);
        {
            let mut state = registry.inner.lock().await;
            assert_eq!(InteractionRegistry::bump_epoch(&mut state, &session_id), 1);
        }
        assert!(registry.verify_steer_epoch(&session_id, 1).await);
        assert!(!registry.verify_steer_epoch(&session_id, 0).await);
        assert_eq!(
            registry
                .with_verified_steer_epoch(&session_id, 1, || "sent")
                .await,
            Some("sent")
        );
        assert_eq!(
            registry
                .with_verified_steer_epoch(&session_id, 0, || "not-sent")
                .await,
            None
        );
    }

    fn property(value: serde_json::Value) -> ElicitationPropertySchema {
        serde_json::from_value(value).expect("valid elicitation property")
    }

    fn schema(properties: BTreeMap<String, ElicitationPropertySchema>) -> ElicitationSchema {
        let mut schema = ElicitationSchema::new();
        schema.properties = properties;
        schema
    }

    fn assert_invalid(schema: &ElicitationSchema, name: &str, value: ElicitationContentValue) {
        assert!(matches!(
            validate_elicitation(schema, &BTreeMap::from([(name.to_string(), value)])),
            Err(InteractionError::InvalidElicitation(_))
        ));
    }

    #[test]
    fn elicitation_validation_rejects_missing_unknown_and_wrong_type_fields() {
        let mut requested = schema(BTreeMap::from([(
            "name".to_string(),
            property(json!({"type": "string"})),
        )]));
        requested.required = Some(vec!["name".to_string()]);
        assert!(matches!(
            validate_elicitation(&requested, &BTreeMap::new()),
            Err(InteractionError::InvalidElicitation(message)) if message.contains("missing required")
        ));
        assert!(matches!(
            validate_elicitation(
                &requested,
                &BTreeMap::from([
                    (
                        "name".to_string(),
                        ElicitationContentValue::String("value".to_string()),
                    ),
                    (
                        "other".to_string(),
                        ElicitationContentValue::String("value".to_string()),
                    ),
                ]),
            ),
            Err(InteractionError::InvalidElicitation(message)) if message.contains("unknown field")
        ));
        assert_invalid(&requested, "name", ElicitationContentValue::Boolean(true));
    }

    #[test]
    fn elicitation_validation_covers_string_constraints_and_formats() {
        let constrained = schema(BTreeMap::from([(
            "value".to_string(),
            property(json!({
                "type": "string",
                "minLength": 2,
                "maxLength": 4,
                "enum": ["okay", "yes"],
                "oneOf": [{"const": "okay", "title": "Okay"}],
                "pattern": "^[a-z]+$"
            })),
        )]));
        for value in ["x", "large", "yes", "NOPE"] {
            assert_invalid(
                &constrained,
                "value",
                ElicitationContentValue::String(value.to_string()),
            );
        }
        assert!(validate_elicitation(
            &constrained,
            &BTreeMap::from([(
                "value".to_string(),
                ElicitationContentValue::String("okay".to_string()),
            )]),
        )
        .is_ok());

        let invalid_pattern = schema(BTreeMap::from([(
            "value".to_string(),
            property(json!({"type": "string", "pattern": "["})),
        )]));
        assert_invalid(
            &invalid_pattern,
            "value",
            ElicitationContentValue::String("anything".to_string()),
        );

        for (format, invalid_value, valid_value) in [
            ("email", "missing-at", "person@example.com"),
            ("uri", "not a uri", "https://example.com/path"),
            ("date", "2026-99-99", "2026-07-19"),
            ("date-time", "yesterday", "2026-07-19T12:30:00Z"),
        ] {
            let formatted = schema(BTreeMap::from([(
                "value".to_string(),
                property(json!({"type": "string", "format": format})),
            )]));
            assert_invalid(
                &formatted,
                "value",
                ElicitationContentValue::String(invalid_value.to_string()),
            );
            assert!(validate_elicitation(
                &formatted,
                &BTreeMap::from([(
                    "value".to_string(),
                    ElicitationContentValue::String(valid_value.to_string()),
                )]),
            )
            .is_ok());
        }
        for invalid_email in ["@example.com", "person@example", "person@example."] {
            assert!(!valid_email(invalid_email));
        }
        assert!(valid_email("person@example.com"));
    }

    #[test]
    fn elicitation_validation_covers_numeric_boolean_and_array_constraints() {
        let requested = schema(BTreeMap::from([
            (
                "integer".to_string(),
                property(json!({"type": "integer", "minimum": 2, "maximum": 4})),
            ),
            (
                "number".to_string(),
                property(json!({"type": "number", "minimum": 1.5, "maximum": 2.5})),
            ),
            ("enabled".to_string(), property(json!({"type": "boolean"}))),
            (
                "plain".to_string(),
                property(json!({
                    "type": "array",
                    "items": {"type": "string", "enum": ["one", "two"]},
                    "minItems": 1,
                    "maxItems": 2
                })),
            ),
            (
                "titled".to_string(),
                property(json!({
                    "type": "array",
                    "items": {"anyOf": [{"const": "one", "title": "One"}]}
                })),
            ),
            (
                "future".to_string(),
                property(json!({"type": "array", "items": {"type": "future"}})),
            ),
        ]));

        for value in [1, 5] {
            assert_invalid(
                &requested,
                "integer",
                ElicitationContentValue::Integer(value),
            );
        }
        for value in [1.0, 3.0, f64::NAN] {
            assert_invalid(&requested, "number", ElicitationContentValue::Number(value));
        }
        assert_invalid(
            &requested,
            "plain",
            ElicitationContentValue::StringArray(Vec::new()),
        );
        assert_invalid(
            &requested,
            "plain",
            ElicitationContentValue::StringArray(vec!["one".to_string(); 3]),
        );
        assert_invalid(
            &requested,
            "plain",
            ElicitationContentValue::StringArray(vec!["other".to_string()]),
        );
        assert_invalid(
            &requested,
            "titled",
            ElicitationContentValue::StringArray(vec!["other".to_string()]),
        );
        assert_invalid(
            &requested,
            "future",
            ElicitationContentValue::StringArray(vec!["one".to_string()]),
        );

        assert!(validate_elicitation(
            &requested,
            &BTreeMap::from([
                ("integer".to_string(), ElicitationContentValue::Integer(3)),
                ("number".to_string(), ElicitationContentValue::Number(2.0)),
                (
                    "enabled".to_string(),
                    ElicitationContentValue::Boolean(true)
                ),
                (
                    "plain".to_string(),
                    ElicitationContentValue::StringArray(vec!["one".to_string()]),
                ),
                (
                    "titled".to_string(),
                    ElicitationContentValue::StringArray(vec!["one".to_string()]),
                ),
            ]),
        )
        .is_ok());
    }

    #[test]
    fn elicitation_field_summaries_cover_all_kinds_options_defaults_and_secrets() {
        let requested = schema(BTreeMap::from([
            (
                "choice".to_string(),
                property(json!({
                    "type": "string",
                    "title": "Choice",
                    "description": "Select one",
                    "oneOf": [{"const": "a", "title": "Alpha"}],
                    "default": "a"
                })),
            ),
            (
                "plain".to_string(),
                property(json!({"type": "string", "enum": ["a"], "default": "a"})),
            ),
            (
                "count".to_string(),
                property(json!({"type": "integer", "default": 2})),
            ),
            (
                "ratio".to_string(),
                property(json!({"type": "number", "default": 1.5})),
            ),
            (
                "enabled".to_string(),
                property(json!({"type": "boolean", "default": true})),
            ),
            (
                "tags".to_string(),
                property(json!({
                    "type": "array",
                    "items": {"type": "string", "enum": ["a"]},
                    "default": ["a"]
                })),
            ),
            (
                "labels".to_string(),
                property(json!({
                    "type": "array",
                    "items": {"anyOf": [{"const": "a", "title": "Alpha"}]}
                })),
            ),
            ("future".to_string(), property(json!({"type": "future"}))),
            (
                "password".to_string(),
                property(json!({"type": "string", "default": "hidden"})),
            ),
            (
                "metadata".to_string(),
                property(json!({"type": "string", "_meta": {"isSensitive": true}})),
            ),
        ]));
        let mut requested = requested;
        requested.required = Some(vec!["choice".to_string()]);

        let summaries = requested
            .properties
            .iter()
            .map(|(name, property)| field_summary(name, property, &requested))
            .collect::<Vec<_>>();
        assert!(summaries.iter().any(|field| {
            field.name == "choice"
                && field.required
                && field.options == vec![("a".to_string(), "Alpha".to_string())]
                && field.default == Some(ElicitationContentValue::String("a".to_string()))
        }));
        assert!(summaries
            .iter()
            .any(|field| field.name == "plain" && field.options[0].0 == "a"));
        assert!(summaries
            .iter()
            .any(|field| field.kind == ElicitationFieldKind::Integer));
        assert!(summaries
            .iter()
            .any(|field| field.kind == ElicitationFieldKind::Number));
        assert!(summaries
            .iter()
            .any(|field| field.kind == ElicitationFieldKind::Boolean));
        assert_eq!(
            summaries
                .iter()
                .filter(|field| field.kind == ElicitationFieldKind::StringArray)
                .count(),
            2
        );
        assert!(summaries
            .iter()
            .any(|field| field.kind == ElicitationFieldKind::Unsupported));
        for name in ["password", "metadata"] {
            let field = summaries.iter().find(|field| field.name == name).unwrap();
            assert!(field.sensitive);
            assert_eq!(field.default, None);
        }
        assert!(is_sensitive("field", Some("API Key"), None, None));
        assert!(is_sensitive(
            "field",
            None,
            Some("Access token used by the service"),
            None,
        ));
        assert!(!is_sensitive("field", Some("Display name"), None, None));
    }
}
