use crate::*;

pub(super) enum RuntimeBackendRef<'a> {
    Codex(Arc<AppServerBridge>),
    Opencode(&'a Arc<OpencodeBackend>),
    Cursor(Arc<AppServerBridge>),
}

pub(super) struct ClientHub {
    pub(super) next_client_id: AtomicU64,
    pub(super) next_event_id: AtomicU64,
    pub(super) stream_id: String,
    pub(super) clients: RwLock<HashMap<u64, mpsc::Sender<Message>>>,
    pub(super) client_infos: RwLock<HashMap<u64, BridgeDeviceConnection>>,
    pub(super) notification_replay: NotificationReplay,
    pub(super) notification_tx: broadcast::Sender<HubNotification>,
    pub(super) client_queue_drops: AtomicU64,
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

#[derive(Clone)]
pub(super) struct HubNotification {
    pub(super) event_id: u64,
    pub(super) method: String,
    pub(super) params: Value,
}

impl ClientHub {
    pub(super) fn new() -> Self {
        Self::with_replay_capacity(NOTIFICATION_REPLAY_BUFFER_SIZE)
    }

    pub(super) fn with_replay_capacity(replay_capacity: usize) -> Self {
        let (notification_tx, _) =
            broadcast::channel::<HubNotification>(INTERNAL_NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            next_client_id: AtomicU64::new(1),
            next_event_id: AtomicU64::new(1),
            stream_id: Uuid::new_v4().to_string(),
            clients: RwLock::new(HashMap::new()),
            client_infos: RwLock::new(HashMap::new()),
            notification_replay: NotificationReplay::new(replay_capacity, REPLAY_MAX_BYTES),
            notification_tx,
            client_queue_drops: AtomicU64::new(0),
        }
    }

    pub(super) fn subscribe_notifications(&self) -> broadcast::Receiver<HubNotification> {
        self.notification_tx.subscribe()
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

    #[cfg(test)]
    pub(super) async fn add_client(&self, tx: mpsc::Sender<Message>) -> u64 {
        self.add_client_with_metadata(tx, ClientConnectionMetadata::default())
            .await
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
        let text = match serde_json::to_string(&value) {
            Ok(v) => v,
            Err(error) => {
                eprintln!("failed to serialize websocket payload: {error}");
                return;
            }
        };

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
        let text = match serde_json::to_string(&value) {
            Ok(v) => v,
            Err(error) => {
                eprintln!("failed to serialize broadcast payload: {error}");
                return;
            }
        };

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

        if !stale_clients.is_empty() {
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
    }

    pub(super) async fn broadcast_notification(&self, method: &str, params: Value) {
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
        let params = payload.get("params").cloned().unwrap_or(Value::Null);

        self.notification_replay
            .push(event_id, payload.clone(), payload_bytes)
            .await;
        let _ = self.notification_tx.send(HubNotification {
            event_id,
            method: method.to_string(),
            params,
        });
        self.broadcast_json(payload).await;
    }

    pub(super) async fn replay_since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> (Vec<Value>, bool, usize) {
        self.notification_replay
            .since(after_event_id, limit, REPLAY_RESPONSE_MAX_BYTES)
            .await
    }

    pub(super) async fn earliest_event_id(&self) -> Option<u64> {
        self.notification_replay.earliest_event_id().await
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
