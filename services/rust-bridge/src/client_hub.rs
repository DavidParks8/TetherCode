use crate::acp::events::CanonicalEvent;
use crate::*;

pub(super) struct ClientHub {
    pub(super) next_client_id: AtomicU64,
    pub(super) next_event_id: AtomicU64,
    pub(super) next_canonical_event_id: AtomicU64,
    pub(super) stream_id: String,
    pub(super) clients: RwLock<HashMap<u64, mpsc::Sender<Message>>>,
    pub(super) client_infos: RwLock<HashMap<u64, BridgeDeviceConnection>>,
    pub(super) notification_replay: NotificationReplay,
    pub(super) canonical_subscribers: std::sync::Mutex<Vec<mpsc::Sender<CanonicalHubEvent>>>,
    pub(super) client_queue_drops: AtomicU64,
    pub(super) notification_emit_lock: Mutex<()>,
    pub(super) ag_ui_projector: Mutex<AgUiProjector>,
}

#[derive(Debug, Clone)]
pub(super) struct ClientConnectionMetadata {
    pub(super) client_type: String,
    pub(super) client_name: String,
}

impl Default for ClientConnectionMetadata {
    fn default() -> Self {
        Self {
            client_type: "unknown".to_string(),
            client_name: "Unknown device".to_string(),
        }
    }
}

impl ClientConnectionMetadata {
    pub(super) fn from_query(query: &RpcQuery) -> Self {
        Self {
            client_type: sanitize_client_metadata(query.client_type.as_deref(), "unknown", 32),
            client_name: sanitize_client_metadata(
                query.client_name.as_deref(),
                "Unknown device",
                64,
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct CanonicalHubEvent {
    pub(super) event_id: u64,
    pub(super) event: CanonicalEvent,
}

pub(super) struct HubReplaySnapshot {
    pub(super) events: Vec<Value>,
    pub(super) has_more: bool,
    pub(super) returned_bytes: usize,
    pub(super) earliest_event_id: Option<u64>,
    pub(super) latest_event_id: u64,
}

impl ClientHub {
    pub(super) fn new() -> Self {
        Self::with_replay_capacity(NOTIFICATION_REPLAY_BUFFER_SIZE)
    }

    pub(super) fn with_replay_capacity(replay_capacity: usize) -> Self {
        Self {
            next_client_id: AtomicU64::new(1),
            next_event_id: AtomicU64::new(1),
            next_canonical_event_id: AtomicU64::new(1),
            stream_id: Uuid::new_v4().to_string(),
            clients: RwLock::new(HashMap::new()),
            client_infos: RwLock::new(HashMap::new()),
            notification_replay: NotificationReplay::new(replay_capacity, REPLAY_MAX_BYTES),
            canonical_subscribers: std::sync::Mutex::new(Vec::new()),
            client_queue_drops: AtomicU64::new(0),
            notification_emit_lock: Mutex::new(()),
            ag_ui_projector: Mutex::new(AgUiProjector::default()),
        }
    }

    pub(super) fn subscribe_canonical_events(&self) -> mpsc::Receiver<CanonicalHubEvent> {
        let (sender, receiver) = mpsc::channel(INTERNAL_NOTIFICATION_CHANNEL_CAPACITY);
        self.canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .push(sender);
        receiver
    }

    pub(super) fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub(super) fn connection_state_payload(&self) -> Value {
        json!({
            "method": "bridge/connection/state",
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "streamId": self.stream_id,
            "params": {
                "status": "connected",
                "at": now_iso(),
            }
        })
    }

    pub(super) async fn add_client_with_metadata(
        &self,
        tx: mpsc::Sender<Message>,
        metadata: ClientConnectionMetadata,
    ) -> u64 {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        let now = now_iso();
        self.clients.write().await.insert(id, tx);
        self.client_infos.write().await.insert(
            id,
            BridgeDeviceConnection {
                client_id: id,
                client_type: metadata.client_type,
                client_name: metadata.client_name,
                connected_at: now.clone(),
                last_seen_at: now,
            },
        );
        id
    }

    pub(super) async fn remove_client(&self, client_id: u64) {
        self.clients.write().await.remove(&client_id);
        self.client_infos.write().await.remove(&client_id);
    }

    pub(super) async fn mark_client_seen(&self, client_id: u64) {
        let mut clients = self.client_infos.write().await;
        if let Some(client) = clients.get_mut(&client_id) {
            client.last_seen_at = now_iso();
        }
    }

    pub(super) async fn client_connections(&self) -> Vec<BridgeDeviceConnection> {
        let mut clients = self
            .client_infos
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        clients.sort_by_key(|client| client.client_id);
        clients
    }

    pub(super) async fn send_json(&self, client_id: u64, value: Value) {
        let text = serde_json::to_string(&value).expect("JSON Value is serializable");

        let tx = {
            let clients = self.clients.read().await;
            clients.get(&client_id).cloned()
        };
        let Some(tx) = tx else {
            return;
        };

        let message = Message::Text(text.into());
        let should_remove = match tx.try_send(message) {
            Ok(()) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => true,
            Err(mpsc::error::TrySendError::Full(message)) => {
                match timeout(Duration::from_millis(250), tx.send(message)).await {
                    Ok(Ok(())) => false,
                    Ok(Err(_)) | Err(_) => true,
                }
            }
        };

        if should_remove {
            self.remove_client(client_id).await;
        }
    }

    pub(super) async fn broadcast_json(&self, value: Value) {
        let text = serde_json::to_string(&value).expect("JSON Value is serializable");

        let mut stale_clients = Vec::new();
        {
            let clients = self.clients.read().await;
            for (client_id, tx) in clients.iter() {
                match tx.try_send(Message::Text(text.clone().into())) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        stale_clients.push(*client_id);
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // Keep the client and rely on replay to catch up dropped notifications.
                        self.client_queue_drops.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }

        {
            let mut clients = self.clients.write().await;
            for client_id in &stale_clients {
                clients.remove(client_id);
            }
        }
        {
            let mut client_infos = self.client_infos.write().await;
            for client_id in stale_clients {
                client_infos.remove(&client_id);
            }
        }
    }

    pub(super) async fn broadcast_notification(&self, method: &str, params: Value) {
        let _emit_guard = self.notification_emit_lock.lock().await;
        self.broadcast_external_notification(method, params).await;
    }

    pub(super) async fn broadcast_canonical_event(&self, event: &CanonicalEvent) {
        let _emit_guard = self.notification_emit_lock.lock().await;
        let event_id = self.next_canonical_event_id.fetch_add(1, Ordering::Relaxed);
        let canonical = CanonicalHubEvent {
            event_id,
            event: event.clone(),
        };
        let subscribers = self
            .canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .clone();
        for subscriber in subscribers {
            let _ = subscriber.send(canonical.clone()).await;
        }
        self.canonical_subscribers
            .lock()
            .expect("canonical subscriber lock")
            .retain(|subscriber| !subscriber.is_closed());
        let projection = self.ag_ui_projector.lock().await.project_canonical(event);
        for envelope in projection.events {
            let params = serde_json::to_value(envelope).unwrap_or(Value::Null);
            self.broadcast_external_notification(AG_UI_EVENT_METHOD, params)
                .await;
        }
        for (method, params) in projection.controls {
            self.broadcast_external_notification(method, params).await;
        }
    }

    async fn broadcast_external_notification(&self, method: &str, params: Value) -> u64 {
        let event_id = self.next_event_id.fetch_add(1, Ordering::Relaxed);
        let mut payload = json!({
            "method": method,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "streamId": self.stream_id,
            "eventId": event_id,
            "params": params
        });
        let mut payload_bytes = serde_json::to_vec(&payload)
            .map(|value| value.len())
            .unwrap_or(0);
        if payload_bytes > NOTIFICATION_MAX_BYTES {
            payload = json!({
                "method": "bridge/notification.truncated",
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "streamId": self.stream_id,
                "eventId": event_id,
                "params": {
                    "originalMethod": method,
                    "truncated": true,
                    "originalBytes": payload_bytes,
                    "maxBytes": NOTIFICATION_MAX_BYTES,
                }
            });
            payload_bytes = serde_json::to_vec(&payload)
                .map(|value| value.len())
                .unwrap_or(0);
        }
        self.notification_replay
            .push(event_id, payload.clone(), payload_bytes)
            .await;
        self.broadcast_json(payload).await;
        event_id
    }

    pub(super) async fn replay_snapshot(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> HubReplaySnapshot {
        let _emit_guard = self.notification_emit_lock.lock().await;
        let (events, has_more, returned_bytes) = self
            .notification_replay
            .since(after_event_id, limit, REPLAY_RESPONSE_MAX_BYTES)
            .await;
        HubReplaySnapshot {
            events,
            has_more,
            returned_bytes,
            earliest_event_id: self.notification_replay.earliest_event_id().await,
            latest_event_id: self.latest_event_id(),
        }
    }

    #[cfg(test)]
    pub(super) async fn replay_since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> (Vec<Value>, bool, usize) {
        self.notification_replay
            .since(after_event_id, limit, REPLAY_RESPONSE_MAX_BYTES)
            .await
    }

    pub(super) fn latest_event_id(&self) -> u64 {
        self.next_event_id.load(Ordering::Relaxed).saturating_sub(1)
    }

    pub(super) async fn replay_status(&self) -> replay::ReplayStatus {
        self.notification_replay
            .status(self.client_queue_drops.load(Ordering::Relaxed))
            .await
    }
}

#[cfg(test)]
mod canonical_mailbox_tests {
    use super::*;

    #[tokio::test]
    async fn hub_mailbox_backpressures_and_preserves_run_finished_order() {
        let hub = Arc::new(ClientHub::new());
        let mut events = hub.subscribe_canonical_events();
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some("thread".into()),
                kind: format!("filler-{index}"),
            })
            .await;
        }
        let producer = {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
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
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            let event = events.recv().await.expect("canonical event");
            assert_eq!(event.event_id, index as u64 + 1);
            assert!(matches!(
                event.event,
                CanonicalEvent::Ignored { kind, .. } if kind == format!("filler-{index}")
            ));
        }
        producer.await.expect("terminal producer");
        let terminal = events.recv().await.expect("terminal event");
        assert_eq!(
            terminal.event_id,
            INTERNAL_NOTIFICATION_CHANNEL_CAPACITY as u64 + 1
        );
        assert!(matches!(terminal.event, CanonicalEvent::RunFinished { .. }));
    }

    #[tokio::test]
    async fn hub_removes_closed_canonical_subscriber() {
        let hub = ClientHub::new();
        let receiver = hub.subscribe_canonical_events();
        drop(receiver);
        hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: "closed".into(),
        })
        .await;
        assert!(hub
            .canonical_subscribers
            .lock()
            .expect("subscriber lock")
            .is_empty());
    }

    #[tokio::test]
    async fn hub_client_and_replay_paths_cover_presence_close_and_truncation() {
        let hub = ClientHub::with_replay_capacity(4);
        let (sender, mut receiver) = mpsc::channel(1);
        let client_id = hub
            .add_client_with_metadata(sender, ClientConnectionMetadata::default())
            .await;
        hub.mark_client_seen(client_id).await;
        hub.mark_client_seen(client_id + 1).await;
        assert_eq!(hub.client_connections().await.len(), 1);

        hub.send_json(client_id, json!({"ok": true})).await;
        assert!(receiver.recv().await.is_some());
        drop(receiver);
        hub.send_json(client_id, json!({"closed": true})).await;
        assert!(hub.client_connections().await.is_empty());
        hub.send_json(client_id, json!({"missing": true})).await;
        hub.remove_client(client_id + 1).await;

        let (full_sender, _full_receiver) = mpsc::channel(1);
        let full_id = hub
            .add_client_with_metadata(full_sender, ClientConnectionMetadata::default())
            .await;
        hub.send_json(full_id, json!({"first": true})).await;
        hub.broadcast_json(json!({"dropped": true})).await;
        assert_eq!(hub.client_queue_drops.load(Ordering::Relaxed), 1);

        hub.send_json(full_id, json!({"timeout": true})).await;
        assert!(!hub.clients.read().await.contains_key(&full_id));

        let (closed_sender, closed_receiver) = mpsc::channel(1);
        let closed_id = hub
            .add_client_with_metadata(closed_sender, ClientConnectionMetadata::default())
            .await;
        drop(closed_receiver);
        hub.broadcast_json(json!({"closed": true})).await;
        assert!(!hub.clients.read().await.contains_key(&closed_id));
        assert!(!hub.client_infos.read().await.contains_key(&closed_id));

        hub.broadcast_notification(
            "bridge/test",
            json!({"large": "x".repeat(NOTIFICATION_MAX_BYTES)}),
        )
        .await;
        let (events, _, _) = hub.replay_since(None, 4).await;
        assert_eq!(events[0]["method"], "bridge/notification.truncated");
        let status = hub.replay_status().await;
        assert_eq!(status.latest_event_id, Some(1));
    }
}
