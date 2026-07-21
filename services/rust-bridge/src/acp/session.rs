use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use agent_client_protocol::schema::v1::{SessionId, SessionNotification};
use tokio::sync::{Mutex, OwnedMutexGuard};
use uuid::Uuid;

use super::events::{
    canonical_event_channel, CanonicalEvent, CanonicalEventReceiver, CanonicalEventSender,
    MessageRole,
};
use super::snapshot::SessionSnapshot;

#[derive(Debug, Clone)]
pub struct ReceivedSessionNotification {
    pub notification: SessionNotification,
    pub operation: Option<(String, String, u64)>,
    pub reconstruction: bool,
}

impl From<SessionNotification> for ReceivedSessionNotification {
    fn from(notification: SessionNotification) -> Self {
        Self {
            notification,
            operation: None,
            reconstruction: true,
        }
    }
}

#[derive(Clone)]
pub struct AcpSession {
    instance_id: Uuid,
    inner: Arc<Mutex<SessionState>>,
    operation_lock: Arc<Mutex<()>>,
    events: CanonicalEventSender,
    event_receiver: Arc<Mutex<Option<CanonicalEventReceiver>>>,
    #[cfg(test)]
    notification_delivery_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
}

struct SessionState {
    snapshot: SessionSnapshot,
    reconstruction_backup: Option<SessionSnapshot>,
    next_generation: u64,
    generation_state: GenerationState,
    message_ids: HashMap<(Option<u64>, MessageRole), String>,
    notification_receipts: VecDeque<RoutedSessionNotification>,
    notification_draining: bool,
}

struct RoutedSessionNotification {
    agent_id: String,
    received: ReceivedSessionNotification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationState {
    Terminal,
    Active(u64),
    Cancelling(u64),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReconstructionError {
    #[error("ACP session already has an active prompt")]
    Busy,
    #[error("ACP session prompt is being cancelled")]
    Cancelled,
}

impl AcpSession {
    pub fn new(agent_id: String, thread_id: String) -> Self {
        Self::with_event_capacity(agent_id, thread_id, 256)
    }

    fn with_event_capacity(agent_id: String, thread_id: String, capacity: usize) -> Self {
        let (events, event_receiver) = canonical_event_channel(capacity);
        Self {
            instance_id: Uuid::new_v4(),
            inner: Arc::new(Mutex::new(SessionState {
                snapshot: SessionSnapshot::new(agent_id, thread_id),
                reconstruction_backup: None,
                next_generation: 0,
                generation_state: GenerationState::Terminal,
                message_ids: HashMap::new(),
                notification_receipts: VecDeque::new(),
                notification_draining: false,
            })),
            operation_lock: Arc::new(Mutex::new(())),
            events,
            event_receiver: Arc::new(Mutex::new(Some(event_receiver))),
            #[cfg(test)]
            notification_delivery_barrier: Arc::new(Mutex::new(None)),
        }
    }

    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }
    pub async fn begin_reconstruction(
        &self,
    ) -> Result<ReconstructionTransaction, ReconstructionError> {
        let guard = self.operation_lock.clone().lock_owned().await;
        let mut state = self.inner.lock().await;
        match state.generation_state {
            GenerationState::Active(_) => return Err(ReconstructionError::Busy),
            GenerationState::Cancelling(_) => return Err(ReconstructionError::Cancelled),
            GenerationState::Terminal => {}
        }
        debug_assert!(state.reconstruction_backup.is_none());
        let mut fresh = SessionSnapshot::new(
            state.snapshot.agent_id.clone(),
            state.snapshot.thread_id.clone(),
        );
        fresh.history_reconstruction = true;
        state.reconstruction_backup = Some(std::mem::replace(&mut state.snapshot, fresh));
        state.message_ids.clear();
        Ok(ReconstructionTransaction {
            session: self.clone(),
            _guard: guard,
        })
    }
    pub async fn begin_initial_reconstruction(&self) -> ReconstructionTransaction {
        let guard = self.operation_lock.clone().lock_owned().await;
        let mut state = self.inner.lock().await;
        debug_assert!(state.reconstruction_backup.is_none());
        let previous = SessionSnapshot::new(
            state.snapshot.agent_id.clone(),
            state.snapshot.thread_id.clone(),
        );
        state.snapshot.history_reconstruction = true;
        state.reconstruction_backup = Some(previous);
        ReconstructionTransaction {
            session: self.clone(),
            _guard: guard,
        }
    }
    async fn finish_reconstruction(&self, commit: bool) {
        let mut state = self.inner.lock().await;
        let Some(previous) = state.reconstruction_backup.take() else {
            return;
        };
        if commit {
            state.snapshot.history_reconstruction = false;
        } else {
            state.snapshot = previous;
        }
    }
    pub async fn admit_prompt(
        &self,
        run_id: String,
        source_turn_id: String,
    ) -> Result<(u64, CanonicalEvent), &'static str> {
        let _operation = self.operation_lock.lock().await;
        let mut state = self.inner.lock().await;
        if matches!(
            state.generation_state,
            GenerationState::Active(_) | GenerationState::Cancelling(_)
        ) {
            return Err("ACP session already has an active prompt");
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        let event = CanonicalEvent::RunStarted {
            agent_id: state.snapshot.agent_id.clone(),
            thread_id: state.snapshot.thread_id.clone(),
            run_id,
            source_turn_id,
            generation,
        };
        state.snapshot.apply(&event);
        state.generation_state = GenerationState::Active(generation);
        drop(state);
        if self.events.send(event.clone()).await.is_err() {
            eprintln!("ACP session canonical event mailbox closed during prompt admission");
        }
        Ok((generation, event))
    }
    pub async fn operation(&self) -> Option<(String, String, u64)> {
        let state = self.inner.lock().await;
        Some((
            state.snapshot.active_run_id.clone()?,
            state.snapshot.active_source_turn_id.clone()?,
            state.snapshot.active_generation?,
        ))
    }
    #[cfg(test)]
    pub async fn message_id(&self, role: MessageRole, supplied: Option<String>) -> String {
        let generation = self.inner.lock().await.snapshot.active_generation;
        self.message_id_for_generation(role, supplied, generation)
            .await
    }

    pub async fn message_id_for_generation(
        &self,
        role: MessageRole,
        supplied: Option<String>,
        generation: Option<u64>,
    ) -> String {
        let mut state = self.inner.lock().await;
        if let Some(id) = supplied {
            return id;
        }
        let key = (generation, role);
        if let Some(id) = state.message_ids.get(&key) {
            return id.clone();
        }
        let generation =
            generation.map_or_else(|| "history".to_string(), |value| value.to_string());
        let id = format!("{}:{generation}:{role:?}", state.snapshot.thread_id);
        state.message_ids.insert(key, id.clone());
        id
    }
    pub async fn emit(&self, event: CanonicalEvent) {
        let mut state = self.inner.lock().await;
        match &event {
            CanonicalEvent::RunFinished { generation, .. }
            | CanonicalEvent::RunFailed { generation, .. }
                if matches!(
                    state.generation_state,
                    GenerationState::Active(active) | GenerationState::Cancelling(active)
                        if active == *generation
                ) =>
            {
                state.generation_state = GenerationState::Terminal;
            }
            CanonicalEvent::RunFinished { .. } | CanonicalEvent::RunFailed { .. } => return,
            _ => {}
        }
        state.snapshot.apply(&event);
        let live = !state.snapshot.history_reconstruction;
        drop(state);
        if live && self.events.send(event).await.is_err() {
            eprintln!("ACP session canonical event mailbox closed during event delivery");
        }
    }
    pub async fn fail_active(&self, message: String) {
        let Some((run_id, source_turn_id, generation)) = self.operation().await else {
            return;
        };
        self.fail_generation(run_id, source_turn_id, generation, message)
            .await;
    }

    pub async fn fail_generation(
        &self,
        run_id: String,
        source_turn_id: String,
        generation: u64,
        message: String,
    ) {
        let snapshot = self.snapshot().await;
        self.emit(CanonicalEvent::RunFailed {
            agent_id: snapshot.agent_id,
            thread_id: snapshot.thread_id,
            run_id,
            source_turn_id,
            generation,
            message,
        })
        .await;
    }
    pub async fn take_events(&self) -> Option<CanonicalEventReceiver> {
        self.event_receiver.lock().await.take()
    }
    pub async fn flush_events(&self) {
        let _ = self.events.flush().await;
    }
    pub async fn snapshot(&self) -> SessionSnapshot {
        self.inner.lock().await.snapshot.clone()
    }

    pub async fn active_interaction_generation(&self) -> Option<u64> {
        let state = self.inner.lock().await;
        match state.generation_state {
            GenerationState::Active(generation) if !state.snapshot.history_reconstruction => {
                Some(generation)
            }
            _ => None,
        }
    }

    pub async fn is_evictable(&self) -> bool {
        let state = self.inner.lock().await;
        state.generation_state == GenerationState::Terminal
            && state.reconstruction_backup.is_none()
            && !state.snapshot.history_reconstruction
            && !state.notification_draining
            && state.notification_receipts.is_empty()
    }

    fn try_eviction_guard(&self) -> Option<OwnedMutexGuard<()>> {
        self.operation_lock.clone().try_lock_owned().ok()
    }

    pub async fn mark_cancelling(&self) -> Option<u64> {
        let mut state = self.inner.lock().await;
        let GenerationState::Active(generation) = state.generation_state else {
            return None;
        };
        state.generation_state = GenerationState::Cancelling(generation);
        Some(generation)
    }

    async fn route_notification(&self, agent_id: &str, notification: SessionNotification) {
        let received = self.capture_notification(notification).await;
        self.route_received_notifications(agent_id, std::iter::once(received))
            .await;
    }

    async fn capture_notification(
        &self,
        notification: SessionNotification,
    ) -> ReceivedSessionNotification {
        let state = self.inner.lock().await;
        let operation = match (
            state.snapshot.active_run_id.clone(),
            state.snapshot.active_source_turn_id.clone(),
            state.snapshot.active_generation,
        ) {
            (Some(run_id), Some(source_turn_id), Some(generation)) => {
                Some((run_id, source_turn_id, generation))
            }
            _ => None,
        };
        ReceivedSessionNotification {
            notification,
            operation,
            reconstruction: state.snapshot.history_reconstruction,
        }
    }

    async fn route_reconstruction_notifications(
        &self,
        agent_id: &str,
        notifications: impl IntoIterator<Item = ReceivedSessionNotification>,
    ) {
        self.route_received_notifications(agent_id, notifications)
            .await;
    }

    async fn route_received_notifications(
        &self,
        agent_id: &str,
        notifications: impl IntoIterator<Item = ReceivedSessionNotification>,
    ) {
        let mut state = self.inner.lock().await;
        for received in notifications {
            state
                .notification_receipts
                .push_back(RoutedSessionNotification {
                    agent_id: agent_id.to_string(),
                    received,
                });
        }
        if state.notification_draining {
            return;
        }
        state.notification_draining = true;
        drop(state);
        self.drain_notifications().await;
    }

    async fn drain_notifications(&self) {
        loop {
            let routed = {
                let mut state = self.inner.lock().await;
                match state.notification_receipts.pop_front() {
                    Some(routed) => routed,
                    None => {
                        state.notification_draining = false;
                        return;
                    }
                }
            };
            #[cfg(test)]
            if let Some(barrier) = self.notification_delivery_barrier.lock().await.take() {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }
            super::handlers::handle_session_notification(&routed.agent_id, self, routed.received)
                .await;
        }
    }

    #[cfg(test)]
    async fn pause_next_notification_delivery(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.notification_delivery_barrier.lock().await = Some(barrier.clone());
        barrier
    }
}

pub struct ReconstructionTransaction {
    session: AcpSession,
    _guard: OwnedMutexGuard<()>,
}

impl ReconstructionTransaction {
    pub async fn finish(self, commit: bool) {
        self.session.finish_reconstruction(commit).await;
    }
}

const PENDING_NOTIFICATION_CAPACITY: usize = 4096;
const LIVE_SESSION_CAPACITY: usize = 256;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionRouteError {
    #[error("ACP pre-registration notification journal overflowed at {0} entries")]
    JournalOverflow(usize),
    #[error("ACP live session capacity reached at {0} protected sessions")]
    Capacity(usize),
}

#[derive(Default)]
struct RegistryState {
    sessions: HashMap<SessionId, RegistryEntry>,
    pending_notifications: HashMap<SessionId, VecDeque<ReceivedSessionNotification>>,
    pending_notification_count: usize,
    next_access: u64,
    reservations: HashSet<u64>,
    next_reservation: u64,
}

enum RegistryEntry {
    Registering {
        session: AcpSession,
        journal: VecDeque<ReceivedSessionNotification>,
        ready: tokio::sync::watch::Receiver<bool>,
    },
    Live {
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    },
    Evicting {
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    },
}

pub struct SessionLease {
    session: AcpSession,
    leases: Arc<AtomicUsize>,
}

impl SessionLease {
    pub fn session(&self) -> &AcpSession {
        &self.session
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.leases.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
#[derive(Clone)]
struct RegistrationBarrier {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[derive(Clone)]
pub struct SessionRegistry {
    inner: Arc<Mutex<RegistryState>>,
    capacity: usize,
    #[cfg(test)]
    registration_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
    #[cfg(test)]
    eviction_barrier: Arc<Mutex<Option<RegistrationBarrier>>>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::with_capacity(LIVE_SESSION_CAPACITY)
    }
}

impl SessionRegistry {
    #[cfg(test)]
    pub async fn register(
        &self,
        agent_id: &str,
        session_id: SessionId,
    ) -> Result<AcpSession, SessionRouteError> {
        self.register_with_freshness(agent_id, session_id)
            .await
            .map(|(session, _)| session)
    }

    pub async fn reserve(&self) -> Result<u64, SessionRouteError> {
        let mut rejected_evictions = HashSet::new();
        loop {
            let mut state = self.inner.lock().await;
            if state
                .sessions
                .len()
                .saturating_add(state.reservations.len())
                < self.capacity
            {
                let reservation = state.next_reservation;
                state.next_reservation = state.next_reservation.saturating_add(1);
                state.reservations.insert(reservation);
                return Ok(reservation);
            }
            let candidate = state
                .sessions
                .iter()
                .filter_map(|(id, entry)| match entry {
                    RegistryEntry::Live {
                        session,
                        last_access,
                        leases,
                    } if leases.load(Ordering::Acquire) == 0
                        && !rejected_evictions.contains(id) =>
                    {
                        Some((id.clone(), session.clone(), *last_access, leases.clone()))
                    }
                    _ => None,
                })
                .min_by_key(|(_, _, last_access, _)| *last_access);
            let Some((session_id, session, last_access, leases)) = candidate else {
                return Err(SessionRouteError::Capacity(self.capacity));
            };
            state.sessions.insert(
                session_id.clone(),
                RegistryEntry::Evicting {
                    session: session.clone(),
                    last_access,
                    leases: leases.clone(),
                },
            );
            drop(state);
            let Some(_operation) = session.try_eviction_guard() else {
                self.restore_eviction(&session_id, session, last_access, leases)
                    .await;
                rejected_evictions.insert(session_id);
                continue;
            };
            let mut state = self.inner.lock().await;
            let still_evicting = matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Evicting { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            );
            if still_evicting
                && leases.load(Ordering::Acquire) == 0
                && !state.pending_notifications.contains_key(&session_id)
                && session.is_evictable().await
            {
                state.sessions.remove(&session_id);
                continue;
            }
            drop(state);
            self.restore_eviction(&session_id, session, last_access, leases)
                .await;
            rejected_evictions.insert(session_id);
        }
    }

    pub async fn release_reservation(&self, reservation: u64) {
        self.inner.lock().await.reservations.remove(&reservation);
    }

    pub async fn register_reserved(
        &self,
        agent_id: &str,
        session_id: SessionId,
        reservation: u64,
    ) -> Result<AcpSession, SessionRouteError> {
        let result = self
            .register_with_freshness_reserved(agent_id, session_id, Some(reservation))
            .await
            .map(|(session, _)| session);
        self.release_reservation(reservation).await;
        result
    }

    async fn restore_eviction(
        &self,
        session_id: &SessionId,
        session: AcpSession,
        last_access: u64,
        leases: Arc<AtomicUsize>,
    ) {
        let journal = {
            let mut state = self.inner.lock().await;
            if !matches!(
                state.sessions.get(session_id),
                Some(RegistryEntry::Evicting { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            ) {
                return;
            }
            let journal = state
                .pending_notifications
                .remove(session_id)
                .unwrap_or_default();
            state.pending_notification_count = state
                .pending_notification_count
                .checked_sub(journal.len())
                .expect("pending notification count tracks every journal entry");
            state.sessions.insert(
                session_id.clone(),
                RegistryEntry::Live {
                    session: session.clone(),
                    last_access,
                    leases,
                },
            );
            journal
        };
        session
            .route_received_notifications(&session.snapshot().await.agent_id, journal)
            .await;
    }

    fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState::default())),
            capacity,
            #[cfg(test)]
            registration_barrier: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            eviction_barrier: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn register_with_freshness(
        &self,
        agent_id: &str,
        session_id: SessionId,
    ) -> Result<(AcpSession, bool), SessionRouteError> {
        self.register_with_freshness_reserved(agent_id, session_id, None)
            .await
    }

    async fn register_with_freshness_reserved(
        &self,
        agent_id: &str,
        session_id: SessionId,
        reservation: Option<u64>,
    ) -> Result<(AcpSession, bool), SessionRouteError> {
        let mut rejected_evictions = HashSet::new();
        let mut state = loop {
            let mut state = self.inner.lock().await;
            if reservation.is_some_and(|reservation| !state.reservations.contains(&reservation)) {
                return Err(SessionRouteError::Capacity(self.capacity));
            }
            if state.sessions.contains_key(&session_id) {
                if let Some(reservation) = reservation {
                    state.reservations.remove(&reservation);
                }
                let entry = state
                    .sessions
                    .get(&session_id)
                    .expect("checked session remains present");
                match entry {
                    RegistryEntry::Live { session, .. } => return Ok((session.clone(), false)),
                    RegistryEntry::Registering { session, ready, .. } => {
                        let session = session.clone();
                        let mut ready = ready.clone();
                        drop(state);
                        while !*ready.borrow_and_update() {
                            ready
                                .changed()
                                .await
                                .expect("registration sender remains alive with its entry");
                        }
                        return Ok((session, false));
                    }
                    RegistryEntry::Evicting {
                        session,
                        last_access,
                        leases,
                    } => {
                        let session = session.clone();
                        let last_access = *last_access;
                        let leases = leases.clone();
                        drop(state);
                        self.restore_eviction(&session_id, session.clone(), last_access, leases)
                            .await;
                        return Ok((session, false));
                    }
                }
            }
            let occupied = state
                .sessions
                .len()
                .saturating_add(state.reservations.len());
            let own_reservation = usize::from(reservation.is_some());
            if occupied.saturating_sub(own_reservation) < self.capacity {
                break state;
            }
            let candidates = state
                .sessions
                .iter()
                .filter_map(|(id, entry)| match entry {
                    RegistryEntry::Live {
                        session,
                        last_access,
                        leases,
                    } if leases.load(Ordering::Acquire) == 0
                        && !rejected_evictions.contains(id) =>
                    {
                        Some((id.clone(), session.clone(), *last_access, leases.clone()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            let mut evict = None;
            for candidate in candidates {
                if evict
                    .as_ref()
                    .is_none_or(|(_, _, oldest, _)| candidate.2 < *oldest)
                {
                    evict = Some(candidate);
                }
            }
            let Some((evicted_id, evicted_session, last_access, leases)) = evict else {
                return Err(SessionRouteError::Capacity(self.capacity));
            };
            state.sessions.insert(
                evicted_id.clone(),
                RegistryEntry::Evicting {
                    session: evicted_session.clone(),
                    last_access,
                    leases: leases.clone(),
                },
            );
            drop(state);

            #[cfg(test)]
            if let Some(barrier) = self.eviction_barrier.lock().await.take() {
                barrier.reached.notify_one();
                barrier.release.notified().await;
            }

            let Some(_operation) = evicted_session.try_eviction_guard() else {
                self.restore_eviction(&evicted_id, evicted_session, last_access, leases)
                    .await;
                rejected_evictions.insert(evicted_id);
                continue;
            };
            let mut state = self.inner.lock().await;
            let still_evicting = matches!(
                state.sessions.get(&evicted_id),
                Some(RegistryEntry::Evicting { session, .. })
                    if Arc::ptr_eq(&session.inner, &evicted_session.inner)
            );
            if still_evicting
                && leases.load(Ordering::Acquire) == 0
                && !state.pending_notifications.contains_key(&evicted_id)
                && evicted_session.is_evictable().await
            {
                state.sessions.remove(&evicted_id);
                state.pending_notifications.remove(&evicted_id);
                continue;
            }
            if still_evicting {
                drop(state);
                self.restore_eviction(&evicted_id, evicted_session, last_access, leases)
                    .await;
            }
            rejected_evictions.insert(evicted_id);
        };
        let identity = super::identity::AgentSessionId::new(agent_id, session_id.to_string())
            .expect("SDK session ID is bounded by transport");
        let session = AcpSession::new(agent_id.to_string(), identity.encode());
        if state.pending_notifications.contains_key(&session_id) {
            session.inner.lock().await.snapshot.history_reconstruction = true;
        }
        let journal = state
            .pending_notifications
            .remove(&session_id)
            .unwrap_or_default();
        let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
        if let Some(reservation) = reservation {
            state.reservations.remove(&reservation);
        }
        state.sessions.insert(
            session_id.clone(),
            RegistryEntry::Registering {
                session: session.clone(),
                journal,
                ready: ready_rx,
            },
        );
        drop(state);

        #[cfg(test)]
        if let Some(barrier) = self.registration_barrier.lock().await.take() {
            barrier.reached.notify_one();
            barrier.release.notified().await;
        }

        loop {
            let notification = {
                let mut state = self.inner.lock().await;
                let Some(RegistryEntry::Registering { journal, .. }) =
                    state.sessions.get_mut(&session_id)
                else {
                    return Ok((session, false));
                };
                if let Some(notification) = journal.pop_front() {
                    state.pending_notification_count =
                        state.pending_notification_count.saturating_sub(1);
                    Some(notification)
                } else {
                    session.inner.lock().await.snapshot.history_reconstruction = false;
                    let last_access = state.next_access;
                    state.next_access = state.next_access.saturating_add(1);
                    state.sessions.insert(
                        session_id.clone(),
                        RegistryEntry::Live {
                            session: session.clone(),
                            last_access,
                            leases: Arc::new(AtomicUsize::new(0)),
                        },
                    );
                    let _ = ready_tx.send(true);
                    None
                }
            };
            let Some(notification) = notification else {
                break;
            };
            session
                .route_reconstruction_notifications(agent_id, std::iter::once(notification))
                .await;
        }
        Ok((session, true))
    }
    pub async fn get(&self, session_id: &SessionId) -> Option<AcpSession> {
        let mut state = self.inner.lock().await;
        let last_access = state.next_access;
        state.next_access = state.next_access.saturating_add(1);
        let RegistryEntry::Live {
            session,
            last_access: seen,
            ..
        } = state.sessions.get_mut(session_id)?
        else {
            return None;
        };
        *seen = last_access;
        Some(session.clone())
    }

    pub async fn lease(&self, session_id: &SessionId) -> Option<SessionLease> {
        let mut state = self.inner.lock().await;
        let last_access = state.next_access;
        state.next_access = state.next_access.saturating_add(1);
        let RegistryEntry::Live {
            session,
            last_access: seen,
            leases,
        } = state.sessions.get_mut(session_id)?
        else {
            return None;
        };
        *seen = last_access;
        leases.fetch_add(1, Ordering::AcqRel);
        Some(SessionLease {
            session: session.clone(),
            leases: leases.clone(),
        })
    }
    pub async fn all(&self) -> Vec<AcpSession> {
        self.inner
            .lock()
            .await
            .sessions
            .values()
            .filter_map(|entry| match entry {
                RegistryEntry::Live { session, .. } => Some(session.clone()),
                RegistryEntry::Registering { .. } | RegistryEntry::Evicting { .. } => None,
            })
            .collect()
    }
    pub async fn remove(&self, session_id: &SessionId) {
        self.inner.lock().await.sessions.remove(session_id);
    }
    pub async fn route(
        &self,
        agent_id: &str,
        notification: SessionNotification,
    ) -> Result<(), SessionRouteError> {
        let mut state = self.inner.lock().await;
        if let Some(RegistryEntry::Live {
            session, leases, ..
        }) = state.sessions.get(&notification.session_id)
        {
            let session = session.clone();
            let leases = leases.clone();
            leases.fetch_add(1, Ordering::AcqRel);
            drop(state);
            session.route_notification(agent_id, notification).await;
            leases.fetch_sub(1, Ordering::AcqRel);
            return Ok(());
        }
        if let Some(RegistryEntry::Evicting { session, .. }) =
            state.sessions.get(&notification.session_id)
        {
            let session = session.clone();
            drop(state);
            let received = session.capture_notification(notification).await;
            let session_id = received.notification.session_id.clone();
            let mut state = self.inner.lock().await;
            if matches!(
                state.sessions.get(&session_id),
                Some(RegistryEntry::Live { session: current, .. })
                    if Arc::ptr_eq(&current.inner, &session.inner)
            ) {
                drop(state);
                session
                    .route_received_notifications(agent_id, std::iter::once(received))
                    .await;
                return Ok(());
            }
            if state.pending_notification_count >= PENDING_NOTIFICATION_CAPACITY {
                return Err(SessionRouteError::JournalOverflow(
                    PENDING_NOTIFICATION_CAPACITY,
                ));
            }
            state
                .pending_notifications
                .entry(session_id)
                .or_default()
                .push_back(received);
            state.pending_notification_count += 1;
            return Ok(());
        }
        if state.pending_notification_count >= PENDING_NOTIFICATION_CAPACITY {
            return Err(SessionRouteError::JournalOverflow(
                PENDING_NOTIFICATION_CAPACITY,
            ));
        }
        if let Some(RegistryEntry::Registering { journal, .. }) =
            state.sessions.get_mut(&notification.session_id)
        {
            journal.push_back(ReceivedSessionNotification {
                notification,
                operation: None,
                reconstruction: true,
            });
            state.pending_notification_count += 1;
            return Ok(());
        }
        let session_id = notification.session_id.clone();
        state
            .pending_notifications
            .entry(session_id)
            .or_default()
            .push_back(ReceivedSessionNotification {
                notification,
                operation: None,
                reconstruction: true,
            });
        state.pending_notification_count += 1;
        Ok(())
    }

    #[cfg(test)]
    async fn pause_next_registration(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.registration_barrier.lock().await = Some(barrier.clone());
        barrier
    }

    #[cfg(test)]
    async fn pause_next_eviction(&self) -> RegistrationBarrier {
        let barrier = RegistrationBarrier {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        *self.eviction_barrier.lock().await = Some(barrier.clone());
        barrier
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification(session_id: &str, message_id: &str) -> SessionNotification {
        SessionNotification::new(
            session_id.to_string(),
            serde_json::from_value(serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "content"},
                "messageId": message_id
            }))
            .expect("valid notification"),
        )
    }

    #[tokio::test]
    async fn session_tracks_prompt_reconstruction_messages_and_failure() {
        let session = AcpSession::new("agent".to_string(), "thread".to_string());
        assert_eq!(session.operation().await, None);
        session.fail_active("ignored".to_string()).await;

        let mut events = session.take_events().await.expect("event receiver");
        let reconstruction = session.begin_reconstruction().await.unwrap();
        session
            .emit(CanonicalEvent::Ignored {
                agent_id: "agent".to_string(),
                thread_id: Some("thread".to_string()),
                kind: "history".to_string(),
            })
            .await;
        assert!(events.try_recv().is_err());
        assert_eq!(
            session.message_id(MessageRole::Agent, None).await,
            "thread:history:Agent"
        );
        reconstruction.finish(true).await;

        let (generation, _) = session
            .admit_prompt("run".to_string(), "turn".to_string())
            .await
            .expect("prompt admitted");
        assert_eq!(generation, 1);
        assert!(session
            .admit_prompt("other-run".to_string(), "other-turn".to_string())
            .await
            .is_err());
        assert_eq!(
            session.operation().await,
            Some(("run".to_string(), "turn".to_string(), 1))
        );
        assert_eq!(
            session
                .message_id(MessageRole::Agent, Some("supplied".to_string()))
                .await,
            "supplied"
        );
        let generated = session.message_id(MessageRole::Thought, None).await;
        assert_eq!(generated, "thread:1:Thought");
        assert_eq!(
            session.message_id(MessageRole::Thought, None).await,
            generated
        );

        session.fail_active("failed".to_string()).await;
        assert_eq!(session.operation().await, None);
        assert!(matches!(
            events.recv().await.unwrap(),
            CanonicalEvent::RunStarted { .. }
        ));
        assert!(matches!(
            events.recv().await.unwrap(),
            CanonicalEvent::RunFailed { .. }
        ));
    }

    #[tokio::test]
    async fn bounded_event_mailbox_backpressures_and_preserves_terminal_order() {
        let session = AcpSession::with_event_capacity("agent".into(), "thread".into(), 1);
        let mut events = session.take_events().await.expect("event receiver");
        session
            .admit_prompt("run".into(), "turn".into())
            .await
            .expect("prompt admitted");

        let producer = {
            let session = session.clone();
            tokio::spawn(async move {
                session
                    .emit(CanonicalEvent::RunFinished {
                        agent_id: "agent".into(),
                        thread_id: "thread".into(),
                        run_id: "run".into(),
                        source_turn_id: "turn".into(),
                        generation: 1,
                        stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
                    })
                    .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::RunStarted { .. })
        ));
        producer.await.expect("producer completes after drain");
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::RunFinished { .. })
        ));
        assert_eq!(session.snapshot().await.active_run_id, None);

        let closed = AcpSession::with_event_capacity("agent".into(), "closed".into(), 1);
        drop(closed.take_events().await.expect("closed receiver"));
        closed
            .admit_prompt("closed-run".into(), "closed-turn".into())
            .await
            .expect("snapshot still admits after receiver closure");
        closed
            .emit(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some("closed".into()),
                kind: "closed".into(),
            })
            .await;
    }

    #[tokio::test]
    async fn registry_routes_all_accepted_notifications_and_fails_overflow_explicitly() {
        let registry = SessionRegistry::default();
        registry
            .route("agent", notification("late", "late-message"))
            .await
            .unwrap();
        let late = registry
            .register("agent", SessionId::new("late"))
            .await
            .expect("session capacity");
        assert_eq!(late.snapshot().await.messages[0].id, "late-message");
        let same = registry
            .register("agent", SessionId::new("late"))
            .await
            .expect("session capacity");
        assert_eq!(
            same.snapshot().await.thread_id,
            late.snapshot().await.thread_id
        );
        registry
            .route("agent", notification("late", "live-message"))
            .await
            .unwrap();
        assert_eq!(late.snapshot().await.messages.len(), 2);
        assert_eq!(registry.all().await.len(), 1);
        assert!(registry.get(&SessionId::new("missing")).await.is_none());

        for index in 0..PENDING_NOTIFICATION_CAPACITY {
            registry
                .route(
                    "agent",
                    notification("pressure", &format!("message-{index}")),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            registry
                .route("agent", notification("pressure", "overflow"))
                .await,
            Err(SessionRouteError::JournalOverflow(
                PENDING_NOTIFICATION_CAPACITY
            ))
        );
        let register = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("pressure"))
                    .await
                    .expect("session capacity")
            })
        };
        let pressure = register.await.expect("registration completes");
        let mut events = pressure.take_events().await.expect("pressure receiver");
        assert!(events.try_recv().is_err());
        let snapshot = pressure.snapshot().await;
        assert_eq!(snapshot.messages.len(), 128);
        for (index, message) in snapshot.messages.iter().enumerate() {
            assert_eq!(
                message.id,
                format!(
                    "message-{}",
                    PENDING_NOTIFICATION_CAPACITY - snapshot.messages.len() + index
                )
            );
        }
    }

    #[tokio::test]
    async fn registry_evicts_oldest_idle_and_can_reload_it() {
        let registry = SessionRegistry::with_capacity(2);
        let first_id = SessionId::new("first");
        let second_id = SessionId::new("second");
        let third_id = SessionId::new("third");
        registry
            .register("agent", first_id.clone())
            .await
            .expect("first session");
        registry
            .register("agent", second_id.clone())
            .await
            .expect("second session");
        registry
            .route("agent", notification("pending-eviction", "queued"))
            .await
            .unwrap();
        assert!(registry.get(&second_id).await.is_some());
        let second_again = registry
            .register("agent", second_id.clone())
            .await
            .expect("existing live session");
        assert_eq!(
            second_again.snapshot().await.thread_id,
            registry
                .get(&second_id)
                .await
                .unwrap()
                .snapshot()
                .await
                .thread_id
        );

        registry
            .register("agent", third_id.clone())
            .await
            .expect("oldest idle is evicted");
        assert!(registry.get(&first_id).await.is_none());
        assert!(registry.get(&second_id).await.is_some());
        assert!(registry.get(&third_id).await.is_some());
        assert_eq!(registry.all().await.len(), 2);

        registry
            .register("agent", first_id.clone())
            .await
            .expect("evicted durable identity can be reconstructed later");
        assert!(registry.get(&first_id).await.is_some());
        assert_eq!(registry.all().await.len(), 2);
    }

    #[tokio::test]
    async fn registry_protects_active_cancelling_reconstructing_and_interaction_sessions() {
        let active_registry = SessionRegistry::with_capacity(1);
        let active_id = SessionId::new("active");
        let active = active_registry
            .register("agent", active_id.clone())
            .await
            .unwrap();
        active
            .admit_prompt("run".into(), "turn".into())
            .await
            .unwrap();
        assert!(matches!(
            active_registry
                .register("agent", SessionId::new("other"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));
        active.mark_cancelling().await;
        assert!(matches!(
            active_registry
                .register("agent", SessionId::new("other"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));

        let reconstructing_registry = SessionRegistry::with_capacity(1);
        let reconstructing = reconstructing_registry
            .register("agent", SessionId::new("reconstructing"))
            .await
            .unwrap();
        let reconstruction = reconstructing.begin_reconstruction().await.unwrap();
        assert!(matches!(
            reconstructing_registry
                .register("agent", SessionId::new("other"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));
        reconstruction.finish(true).await;

        let interaction_registry = SessionRegistry::with_capacity(1);
        let interaction_id = SessionId::new("interaction");
        interaction_registry
            .register("agent", interaction_id.clone())
            .await
            .unwrap();
        let first_lease = interaction_registry.lease(&interaction_id).await.unwrap();
        let second_lease = interaction_registry.lease(&interaction_id).await.unwrap();
        assert!(matches!(
            interaction_registry
                .register("agent", SessionId::new("other"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));
        drop(first_lease);
        assert!(matches!(
            interaction_registry
                .register("agent", SessionId::new("other"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));
        drop(second_lease);
        interaction_registry
            .register("agent", SessionId::new("other"))
            .await
            .expect("released interaction permits eviction");
    }

    #[tokio::test]
    async fn duplicate_registration_cancels_in_progress_eviction_without_replacing_session() {
        let registry = SessionRegistry::with_capacity(1);
        let session_id = SessionId::new("owned");
        let original = registry
            .register("agent", session_id.clone())
            .await
            .unwrap();
        let barrier = registry.pause_next_eviction().await;
        let eviction = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("replacement"))
                    .await
            })
        };
        barrier.reached.notified().await;

        assert!(registry.get(&session_id).await.is_none());
        assert!(registry.lease(&session_id).await.is_none());
        let duplicate = registry
            .register("agent", session_id.clone())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&original.inner, &duplicate.inner));
        let restored_lease = registry
            .lease(&session_id)
            .await
            .expect("duplicate registration restores the evicting session to live");
        assert!(Arc::ptr_eq(
            &original.inner,
            &restored_lease.session().inner
        ));
        barrier.release.notify_one();
        assert!(matches!(
            eviction.await.unwrap(),
            Err(SessionRouteError::Capacity(1))
        ));
        assert!(matches!(
            registry
                .register("agent", SessionId::new("still-protected"))
                .await,
            Err(SessionRouteError::Capacity(1))
        ));
        drop(restored_lease);
        assert!(Arc::ptr_eq(
            &original.inner,
            &registry.get(&session_id).await.unwrap().inner
        ));
    }

    #[tokio::test]
    async fn eviction_restores_session_when_notification_arrives_during_guard_setup() {
        let registry = SessionRegistry::with_capacity(1);
        let session_id = SessionId::new("notified");
        let original = registry
            .register("agent", session_id.clone())
            .await
            .unwrap();
        let barrier = registry.pause_next_eviction().await;
        let eviction = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("replacement"))
                    .await
            })
        };
        barrier.reached.notified().await;

        registry
            .route("agent", notification("notified", "during-eviction"))
            .await
            .unwrap();
        registry
            .route("agent", notification("notified", "during-eviction-2"))
            .await
            .unwrap();
        barrier.release.notify_one();
        assert!(matches!(
            eviction.await.unwrap(),
            Err(SessionRouteError::Capacity(1))
        ));
        let restored = registry.get(&session_id).await.unwrap();
        assert!(Arc::ptr_eq(&original.inner, &restored.inner));
        assert_eq!(
            restored
                .snapshot()
                .await
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["during-eviction", "during-eviction-2"]
        );
        assert_eq!(registry.inner.lock().await.pending_notification_count, 0);

        for index in 0..PENDING_NOTIFICATION_CAPACITY {
            registry
                .route(
                    "agent",
                    notification("pressure-after-restore", &format!("message-{index}")),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            registry
                .route("agent", notification("pressure-after-restore", "overflow"))
                .await,
            Err(SessionRouteError::JournalOverflow(
                PENDING_NOTIFICATION_CAPACITY
            ))
        );
    }

    #[tokio::test]
    async fn stale_eviction_rollback_does_not_replace_current_session() {
        let registry = SessionRegistry::with_capacity(1);
        let session_id = SessionId::new("replaced");
        let stale = AcpSession::new("agent".to_string(), "replaced".to_string());
        let current = AcpSession::new("agent".to_string(), "replaced".to_string());
        registry.inner.lock().await.sessions.insert(
            session_id.clone(),
            RegistryEntry::Live {
                session: current.clone(),
                last_access: 2,
                leases: Arc::new(AtomicUsize::new(0)),
            },
        );

        registry
            .restore_eviction(&session_id, stale, 1, Arc::new(AtomicUsize::new(0)))
            .await;

        let retained = registry
            .get(&session_id)
            .await
            .expect("current session retained");
        assert!(Arc::ptr_eq(&current.inner, &retained.inner));

        registry.inner.lock().await.sessions.insert(
            session_id.clone(),
            RegistryEntry::Evicting {
                session: current.clone(),
                last_access: 3,
                leases: Arc::new(AtomicUsize::new(0)),
            },
        );
        registry
            .restore_eviction(
                &session_id,
                AcpSession::new("agent".to_string(), "replaced".to_string()),
                1,
                Arc::new(AtomicUsize::new(0)),
            )
            .await;

        let state = registry.inner.lock().await;
        let RegistryEntry::Evicting { session, .. } = state
            .sessions
            .get(&session_id)
            .expect("current evicting session retained")
        else {
            panic!("rollback changed the current evicting entry");
        };
        assert!(Arc::ptr_eq(&current.inner, &session.inner));
        drop(state);

        registry.inner.lock().await.pending_notification_count = PENDING_NOTIFICATION_CAPACITY;
        assert_eq!(
            registry
                .route("agent", notification("replaced", "overflow"))
                .await,
            Err(SessionRouteError::JournalOverflow(
                PENDING_NOTIFICATION_CAPACITY
            ))
        );
    }

    #[tokio::test]
    async fn eviction_restores_session_when_operation_starts_before_guard_acquisition() {
        let registry = SessionRegistry::with_capacity(1);
        let session_id = SessionId::new("active-during-eviction");
        let original = registry
            .register("agent", session_id.clone())
            .await
            .unwrap();
        let barrier = registry.pause_next_eviction().await;
        let eviction = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("replacement"))
                    .await
            })
        };
        barrier.reached.notified().await;

        original
            .admit_prompt("run".into(), "turn".into())
            .await
            .unwrap();
        barrier.release.notify_one();
        assert!(matches!(
            eviction.await.unwrap(),
            Err(SessionRouteError::Capacity(1))
        ));
        let restored = registry.get(&session_id).await.unwrap();
        assert!(Arc::ptr_eq(&original.inner, &restored.inner));
        original.fail_active("done".into()).await;
    }

    #[tokio::test]
    async fn admission_leases_block_eviction_through_prompt_and_reconstruction_setup() {
        let registry = SessionRegistry::with_capacity(1);
        let session_id = SessionId::new("leased");
        let session = registry
            .register("agent", session_id.clone())
            .await
            .unwrap();

        let prompt_lease = registry.lease(&session_id).await.unwrap();
        prompt_lease
            .session()
            .admit_prompt("run".into(), "turn".into())
            .await
            .unwrap();
        assert!(matches!(
            registry.register("agent", SessionId::new("other")).await,
            Err(SessionRouteError::Capacity(1))
        ));
        prompt_lease.session().fail_active("complete".into()).await;
        drop(prompt_lease);

        let reconstruction_lease = registry.lease(&session_id).await.unwrap();
        let reconstruction = reconstruction_lease
            .session()
            .begin_reconstruction()
            .await
            .unwrap();
        assert!(matches!(
            registry.register("agent", SessionId::new("other")).await,
            Err(SessionRouteError::Capacity(1))
        ));
        reconstruction.finish(true).await;
        drop(reconstruction_lease);

        registry
            .register("agent", SessionId::new("other"))
            .await
            .expect("released lifecycle lease permits eviction");
        assert!(registry.get(&session_id).await.is_none());
        assert_eq!(session.operation().await, None);
    }

    #[tokio::test]
    async fn registry_never_evicts_an_in_progress_registration() {
        let registry = SessionRegistry::with_capacity(1);
        let barrier = registry.pause_next_registration().await;
        let registering = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("registering"))
                    .await
            })
        };
        barrier.reached.notified().await;
        assert!(matches!(
            registry.register("agent", SessionId::new("other")).await,
            Err(SessionRouteError::Capacity(1))
        ));
        barrier.release.notify_one();
        registering.await.unwrap().unwrap();
        assert_eq!(registry.all().await.len(), 1);

        let cleanup_registry = SessionRegistry::with_capacity(1);
        let cleanup_id = SessionId::new("cleanup");
        let cleanup_barrier = cleanup_registry.pause_next_registration().await;
        let cleanup = {
            let registry = cleanup_registry.clone();
            let session_id = cleanup_id.clone();
            tokio::spawn(async move { registry.register("agent", session_id).await })
        };
        cleanup_barrier.reached.notified().await;
        cleanup_registry.remove(&cleanup_id).await;
        cleanup_barrier.release.notify_one();
        cleanup.await.unwrap().unwrap();
        assert!(cleanup_registry.all().await.is_empty());
    }

    #[tokio::test]
    async fn reservations_reject_protected_capacity_release_on_failure_and_bind_atomically() {
        let registry = SessionRegistry::with_capacity(1);
        let protected_id = SessionId::new("protected");
        let protected = registry
            .register("agent", protected_id.clone())
            .await
            .unwrap();
        protected
            .admit_prompt("run".into(), "turn".into())
            .await
            .unwrap();
        assert_eq!(
            registry.reserve().await,
            Err(SessionRouteError::Capacity(1))
        );
        protected.fail_active("complete".into()).await;

        let reservation = registry.reserve().await.unwrap();
        assert!(registry.get(&protected_id).await.is_none());
        assert_eq!(
            registry.reserve().await,
            Err(SessionRouteError::Capacity(1))
        );
        registry.release_reservation(reservation).await;

        let replacement = registry.reserve().await.unwrap();
        let bound_id = SessionId::new("bound");
        registry
            .register_reserved("agent", bound_id.clone(), replacement)
            .await
            .unwrap();
        assert!(registry.get(&bound_id).await.is_some());
        assert!(registry.inner.lock().await.reservations.is_empty());

        assert!(matches!(
            registry
                .register_reserved("agent", SessionId::new("invalid"), u64::MAX)
                .await,
            Err(SessionRouteError::Capacity(1))
        ));

        let duplicate_registry = SessionRegistry::with_capacity(2);
        let duplicate_id = SessionId::new("duplicate");
        let original = duplicate_registry
            .register("agent", duplicate_id.clone())
            .await
            .unwrap();
        let duplicate_reservation = duplicate_registry.reserve().await.unwrap();
        let duplicate = duplicate_registry
            .register_reserved("agent", duplicate_id, duplicate_reservation)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&original.inner, &duplicate.inner));
        assert!(duplicate_registry
            .inner
            .lock()
            .await
            .reservations
            .is_empty());

        let busy_registry = SessionRegistry::with_capacity(1);
        let busy_id = SessionId::new("busy");
        let busy = busy_registry
            .register("agent", busy_id.clone())
            .await
            .unwrap();
        let operation = busy.operation_lock.lock().await;
        assert_eq!(
            busy_registry.reserve().await,
            Err(SessionRouteError::Capacity(1))
        );
        drop(operation);
        assert!(Arc::ptr_eq(
            &busy.inner,
            &busy_registry.get(&busy_id).await.unwrap().inner
        ));
    }

    #[tokio::test]
    async fn registration_serializes_queued_a_before_live_b() {
        let registry = SessionRegistry::default();
        registry
            .route("agent", notification("race", "a"))
            .await
            .unwrap();
        let barrier = registry.pause_next_registration().await;
        let register = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("race"))
                    .await
                    .expect("session capacity")
            })
        };
        barrier.reached.notified().await;
        let duplicate_register = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .register("agent", SessionId::new("race"))
                    .await
                    .expect("session capacity")
            })
        };
        tokio::task::yield_now().await;
        assert!(!duplicate_register.is_finished());
        assert!(registry.all().await.is_empty());
        let routes = (0..32).map(|index| {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .route("agent", notification("race", &format!("b-{index:02}")))
                    .await
            })
        });
        for route in routes {
            route.await.expect("concurrent route completes").unwrap();
        }
        barrier.release.notify_one();
        let session = register.await.expect("registration completes");
        let duplicate = duplicate_register
            .await
            .expect("duplicate registration completes after owner");
        assert_eq!(
            duplicate.snapshot().await.thread_id,
            session.snapshot().await.thread_id
        );
        assert_eq!(registry.all().await.len(), 1);
        let snapshot = session.snapshot().await;
        let ids = snapshot
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids.first(), Some(&"a"));
        assert_eq!(ids.len(), 33);
        assert_eq!(ids.iter().filter(|id| id.starts_with("b-")).count(), 32);
    }

    #[tokio::test]
    async fn receipt_first_notification_keeps_old_operation_across_terminal_transition() {
        let registry = SessionRegistry::default();
        let session_id = SessionId::new("receipt-race");
        let session = registry
            .register("agent", session_id.clone())
            .await
            .expect("session capacity");
        let mut events = session.take_events().await.unwrap();
        session
            .admit_prompt("run-1".into(), "turn-1".into())
            .await
            .unwrap();
        let barrier = session.pause_next_notification_delivery().await;
        let state_guard = session.inner.lock().await;
        let route = {
            let registry = registry.clone();
            tokio::spawn(async move {
                registry
                    .route("agent", notification("receipt-race", "old-notification"))
                    .await
                    .unwrap();
            })
        };
        tokio::task::yield_now().await;
        assert!(!route.is_finished());
        let transition = {
            let session = session.clone();
            tokio::spawn(async move {
                session
                    .fail_generation("run-1".into(), "turn-1".into(), 1, "done".into())
                    .await;
                session
                    .admit_prompt("run-2".into(), "turn-2".into())
                    .await
                    .unwrap();
            })
        };
        tokio::task::yield_now().await;
        assert!(!transition.is_finished());
        drop(state_guard);
        barrier.reached.notified().await;
        transition.await.unwrap();
        barrier.release.notify_one();
        route.await.unwrap();

        let mut correlated = None;
        while let Ok(event) = events.try_recv() {
            if let CanonicalEvent::MessageChunk {
                message_id,
                run_id,
                source_turn_id,
                generation,
                ..
            } = event
            {
                if message_id == "old-notification" {
                    correlated = Some((run_id, source_turn_id, generation));
                }
            }
        }
        assert_eq!(
            correlated,
            Some((Some("run-1".into()), Some("turn-1".into()), Some(1)))
        );
        assert_eq!(
            session.operation().await,
            Some(("run-2".into(), "turn-2".into(), 2))
        );
    }

    #[tokio::test]
    async fn transition_first_notification_captures_new_operation() {
        let registry = SessionRegistry::default();
        let session_id = SessionId::new("transition-first");
        let session = registry
            .register("agent", session_id)
            .await
            .expect("session capacity");
        let mut events = session.take_events().await.unwrap();
        session
            .admit_prompt("run-1".into(), "turn-1".into())
            .await
            .unwrap();
        session
            .fail_generation("run-1".into(), "turn-1".into(), 1, "done".into())
            .await;
        session
            .admit_prompt("run-2".into(), "turn-2".into())
            .await
            .unwrap();

        registry
            .route(
                "agent",
                notification("transition-first", "new-notification"),
            )
            .await
            .unwrap();

        let mut correlated = None;
        while let Ok(event) = events.try_recv() {
            if let CanonicalEvent::MessageChunk {
                message_id,
                run_id,
                source_turn_id,
                generation,
                ..
            } = event
            {
                if message_id == "new-notification" {
                    correlated = Some((run_id, source_turn_id, generation));
                }
            }
        }
        assert_eq!(
            correlated,
            Some((Some("run-2".into()), Some("turn-2".into()), Some(2)))
        );
    }

    #[tokio::test]
    async fn reconstruction_replaces_stale_state_and_rolls_back_failure() {
        let session = AcpSession::new("agent".into(), "thread".into());
        session.finish_reconstruction(true).await;
        for (message_id, commit) in [("old", true), ("new", true), ("failed", false)] {
            let reconstruction = session.begin_reconstruction().await.unwrap();
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::Agent,
                    message_id: message_id.into(),
                    content: message_id.into(),
                    content_block: None,
                })
                .await;
            reconstruction.finish(commit).await;
        }
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "new");
        assert!(!snapshot.history_reconstruction);
    }

    #[tokio::test]
    async fn prompt_waits_for_reconstruction_commit_or_rollback() {
        for commit in [true, false] {
            let session = AcpSession::new("agent".into(), "thread".into());
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::Agent,
                    message_id: "old".into(),
                    content: "old".into(),
                    content_block: None,
                })
                .await;
            let reconstruction = session.begin_reconstruction().await.unwrap();
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::Agent,
                    message_id: "loaded".into(),
                    content: "loaded".into(),
                    content_block: None,
                })
                .await;
            let prompt_session = session.clone();
            let prompt = tokio::spawn(async move {
                prompt_session
                    .admit_prompt("run".into(), "turn".into())
                    .await
            });
            tokio::task::yield_now().await;
            assert!(!prompt.is_finished());
            reconstruction.finish(commit).await;
            prompt.await.expect("prompt task").expect("prompt admitted");
            let snapshot = session.snapshot().await;
            assert_eq!(snapshot.messages.len(), 1);
            assert_eq!(
                snapshot.messages[0].id,
                if commit { "loaded" } else { "old" }
            );
            assert_eq!(snapshot.active_generation, Some(1));
            assert!(!snapshot.history_reconstruction);
        }
    }

    #[tokio::test]
    async fn initial_reconstruction_commits_journal_and_rolls_back_to_empty() {
        for commit in [true, false] {
            let session = AcpSession::new("agent".into(), "thread".into());
            session
                .emit(CanonicalEvent::MessageChunk {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role: MessageRole::Agent,
                    message_id: "journal".into(),
                    content: "journal".into(),
                    content_block: None,
                })
                .await;
            let reconstruction = session.begin_initial_reconstruction().await;
            reconstruction.finish(commit).await;
            let snapshot = session.snapshot().await;
            assert_eq!(snapshot.messages.len(), usize::from(commit));
            assert!(!snapshot.history_reconstruction);
        }
    }

    #[tokio::test]
    async fn cancelling_generation_rejects_interactions_until_matching_completion() {
        let session = AcpSession::new("agent".into(), "thread".into());
        assert_eq!(session.active_interaction_generation().await, None);
        session
            .admit_prompt("run-1".into(), "turn-1".into())
            .await
            .expect("first prompt admitted");
        assert_eq!(session.active_interaction_generation().await, Some(1));
        assert_eq!(session.mark_cancelling().await, Some(1));
        assert_eq!(session.active_interaction_generation().await, None);
        assert_eq!(session.mark_cancelling().await, None);
        assert!(session
            .admit_prompt("blocked".into(), "blocked".into())
            .await
            .is_err());
        assert!(session
            .admit_prompt("still-blocked".into(), "still-blocked".into())
            .await
            .is_err());
        session
            .emit(CanonicalEvent::RunFinished {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: "run-1".into(),
                source_turn_id: "turn-1".into(),
                generation: 1,
                stop_reason: agent_client_protocol::schema::v1::StopReason::Cancelled,
            })
            .await;
        let (generation, _) = session
            .admit_prompt("run-2".into(), "turn-2".into())
            .await
            .expect("next generation admitted");
        assert_eq!(generation, 2);
    }

    #[tokio::test]
    async fn reconstruction_rejects_without_mutating_an_active_generation() {
        let session = AcpSession::new("agent".into(), "thread".into());
        session
            .admit_prompt("run".into(), "turn".into())
            .await
            .expect("prompt admitted");
        assert_eq!(session.active_interaction_generation().await, Some(1));
        let before = session.snapshot().await;
        assert_eq!(
            session.begin_reconstruction().await.err(),
            Some(ReconstructionError::Busy)
        );
        let after = session.snapshot().await;
        assert_eq!(after.active_run_id, before.active_run_id);
        assert_eq!(after.active_source_turn_id, before.active_source_turn_id);
        assert_eq!(after.active_generation, before.active_generation);
        assert_eq!(after.messages.len(), before.messages.len());
        assert_eq!(after.history_reconstruction, before.history_reconstruction);
        assert_eq!(session.active_interaction_generation().await, Some(1));
    }

    #[tokio::test]
    async fn session_noop_and_terminal_paths_preserve_generation_identity() {
        let session = AcpSession::new("agent".into(), "thread".into());
        session.finish_reconstruction(false).await;
        session.fail_active("inactive".into()).await;
        assert_eq!(
            session
                .message_id(MessageRole::Agent, Some("supplied".into()))
                .await,
            "supplied"
        );
        let generated = session.message_id(MessageRole::Agent, None).await;
        assert_eq!(generated, "thread:history:Agent");
        assert_eq!(
            session.message_id(MessageRole::Agent, None).await,
            generated
        );
        session
            .admit_prompt("run".into(), "turn".into())
            .await
            .expect("prompt admitted");
        let snapshot = session.snapshot().await;
        session
            .emit(CanonicalEvent::RunFinished {
                agent_id: snapshot.agent_id.clone(),
                thread_id: snapshot.thread_id.clone(),
                run_id: "stale".into(),
                source_turn_id: "stale".into(),
                generation: 99,
                stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
            })
            .await;
        assert_eq!(session.active_interaction_generation().await, Some(1));
        session
            .emit(CanonicalEvent::RunFinished {
                agent_id: snapshot.agent_id,
                thread_id: snapshot.thread_id,
                run_id: "run".into(),
                source_turn_id: "turn".into(),
                generation: 1,
                stop_reason: agent_client_protocol::schema::v1::StopReason::EndTurn,
            })
            .await;
        assert_eq!(session.active_interaction_generation().await, None);
        drop(session.take_events().await.expect("event receiver"));
        session
            .emit(CanonicalEvent::Plan {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                entries: Vec::new(),
            })
            .await;
        session.flush_events().await;
    }

    #[tokio::test]
    async fn prompt_admission_survives_closed_mailbox_and_empty_registry_journal() {
        let session = AcpSession::new("agent".into(), "thread".into());
        drop(session.take_events().await.expect("event receiver"));
        let (generation, _) = session
            .admit_prompt("run".into(), "turn".into())
            .await
            .expect("prompt state commits even when mailbox is closed");
        assert_eq!(generation, 1);

        let registry = SessionRegistry::default();
        let session_id = SessionId::new("empty-journal");
        let registered = registry
            .register("agent", session_id.clone())
            .await
            .expect("session capacity");
        let duplicate = registry
            .register("agent", session_id)
            .await
            .expect("session capacity");
        assert_eq!(
            registered.snapshot().await.thread_id,
            duplicate.snapshot().await.thread_id
        );
        assert_eq!(registry.all().await.len(), 1);
    }

    #[tokio::test]
    async fn overlapping_reconstructions_serialize_success_and_failure() {
        let session = AcpSession::new("agent".into(), "thread".into());
        let first = session.begin_reconstruction().await.unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "first".into(),
                content: "first".into(),
                content_block: None,
            })
            .await;
        let second_session = session.clone();
        let second = tokio::spawn(async move { second_session.begin_reconstruction().await });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        first.finish(true).await;
        let second = second.await.expect("second reconstruction starts").unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "second".into(),
                content: "second".into(),
                content_block: None,
            })
            .await;
        second.finish(false).await;
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "first");
        assert!(!snapshot.history_reconstruction);
    }

    #[tokio::test]
    async fn overlapping_failed_then_successful_reconstruction_commits_only_second() {
        let session = AcpSession::new("agent".into(), "thread".into());
        let first = session.begin_reconstruction().await.unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "failed-first".into(),
                content: "failed-first".into(),
                content_block: None,
            })
            .await;
        let second_session = session.clone();
        let second = tokio::spawn(async move { second_session.begin_reconstruction().await });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        first.finish(false).await;
        let second = second.await.expect("second reconstruction starts").unwrap();
        session
            .emit(CanonicalEvent::MessageChunk {
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::Agent,
                message_id: "successful-second".into(),
                content: "successful-second".into(),
                content_block: None,
            })
            .await;
        second.finish(true).await;
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].id, "successful-second");
        assert!(!snapshot.history_reconstruction);
    }
}
