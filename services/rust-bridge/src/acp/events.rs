use agent_client_protocol::schema::v1::{StopReason, ToolCallStatus, ToolKind};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::bridge_protocol::{PendingApproval, PendingUserInputRequest};

#[derive(Clone)]
pub struct CanonicalEventSender {
    sender: mpsc::Sender<CanonicalMailboxItem>,
}

pub struct CanonicalEventReceiver {
    receiver: mpsc::Receiver<CanonicalMailboxItem>,
}

enum CanonicalMailboxItem {
    Event(Box<CanonicalEvent>),
    Flush(oneshot::Sender<()>),
}

pub fn canonical_event_channel(capacity: usize) -> (CanonicalEventSender, CanonicalEventReceiver) {
    let (sender, receiver) = mpsc::channel(capacity);
    (
        CanonicalEventSender { sender },
        CanonicalEventReceiver { receiver },
    )
}

impl CanonicalEventSender {
    pub async fn send(&self, event: CanonicalEvent) -> Result<(), ()> {
        self.sender
            .send(CanonicalMailboxItem::Event(Box::new(event)))
            .await
            .map_err(|_| ())
    }

    pub async fn flush(&self) -> Result<(), ()> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(CanonicalMailboxItem::Flush(sender))
            .await
            .map_err(|_| ())?;
        receiver.await.map_err(|_| ())
    }
}

impl CanonicalEventReceiver {
    pub async fn recv(&mut self) -> Option<CanonicalEvent> {
        loop {
            match self.receiver.recv().await? {
                CanonicalMailboxItem::Event(event) => return Some(*event),
                CanonicalMailboxItem::Flush(sender) => {
                    let _ = sender.send(());
                }
            }
        }
    }

    #[cfg(test)]
    pub fn try_recv(&mut self) -> Result<CanonicalEvent, mpsc::error::TryRecvError> {
        loop {
            match self.receiver.try_recv()? {
                CanonicalMailboxItem::Event(event) => return Ok(*event),
                CanonicalMailboxItem::Flush(sender) => {
                    let _ = sender.send(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ignored(kind: &str) -> CanonicalEvent {
        CanonicalEvent::Ignored {
            agent_id: "agent".into(),
            thread_id: None,
            kind: kind.into(),
        }
    }

    #[tokio::test]
    async fn mailbox_flushes_in_order_and_reports_closed_endpoints() {
        let (sender, mut receiver) = canonical_event_channel(2);
        sender.send(ignored("before")).await.expect("send event");
        let flush = {
            let sender = sender.clone();
            tokio::spawn(async move { sender.flush().await })
        };
        assert!(
            matches!(receiver.recv().await, Some(CanonicalEvent::Ignored { kind, .. }) if kind == "before")
        );
        let receive_after_flush = {
            let mut receiver = receiver;
            tokio::spawn(async move {
                let event = receiver.recv().await;
                (receiver, event)
            })
        };
        tokio::task::yield_now().await;
        assert!(flush.await.expect("flush task").is_ok());
        sender
            .send(ignored("after"))
            .await
            .expect("send after flush");
        let (receiver, event) = receive_after_flush.await.expect("receiver task");
        assert!(matches!(event, Some(CanonicalEvent::Ignored { kind, .. }) if kind == "after"));
        drop(receiver);
        assert!(sender.send(ignored("closed")).await.is_err());
        assert!(sender.flush().await.is_err());

        let (sender, mut receiver) = canonical_event_channel(1);
        drop(sender);
        assert!(receiver.recv().await.is_none());
        assert!(receiver.try_recv().is_err());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "eventType", rename_all = "camelCase")]
pub enum CanonicalEvent {
    RunStarted {
        agent_id: String,
        thread_id: String,
        run_id: String,
        source_turn_id: String,
        generation: u64,
    },
    RunFinished {
        agent_id: String,
        thread_id: String,
        run_id: String,
        source_turn_id: String,
        generation: u64,
        stop_reason: StopReason,
    },
    RunFailed {
        agent_id: String,
        thread_id: String,
        run_id: String,
        source_turn_id: String,
        generation: u64,
        message: String,
    },
    MessageChunk {
        agent_id: String,
        thread_id: String,
        run_id: Option<String>,
        source_turn_id: Option<String>,
        generation: Option<u64>,
        role: MessageRole,
        message_id: String,
        content: String,
        content_block: Option<serde_json::Value>,
    },
    Tool {
        agent_id: String,
        thread_id: String,
        run_id: Option<String>,
        source_turn_id: Option<String>,
        generation: Option<u64>,
        tool_call_id: String,
        kind: ToolKind,
        status: ToolCallStatus,
        title: String,
        content: FieldUpdate<String>,
        structured_content: FieldUpdate<Vec<serde_json::Value>>,
        locations: FieldUpdate<Vec<serde_json::Value>>,
    },
    Plan {
        agent_id: String,
        thread_id: String,
        entries: Vec<PlanEntry>,
    },
    Usage {
        agent_id: String,
        thread_id: String,
        used: u64,
        size: u64,
        cost: Option<String>,
    },
    Mode {
        agent_id: String,
        thread_id: String,
        id: String,
    },
    Config {
        agent_id: String,
        thread_id: String,
        entries: Vec<ConfigEntry>,
    },
    SessionInfo {
        agent_id: String,
        thread_id: String,
        title: FieldUpdate,
        updated_at: FieldUpdate,
    },
    Commands {
        agent_id: String,
        thread_id: String,
        commands: Vec<CommandEntry>,
    },
    PermissionRequested {
        approval: PendingApproval,
    },
    PermissionResolved {
        agent_id: String,
        thread_id: String,
        request_id: String,
        outcome: String,
    },
    ElicitationRequested {
        request: PendingUserInputRequest,
    },
    ElicitationResolved {
        agent_id: String,
        thread_id: String,
        request_id: String,
        action: String,
    },
    Ignored {
        agent_id: String,
        thread_id: Option<String>,
        kind: String,
    },
}

impl CanonicalEvent {
    pub fn thread_id(&self) -> Option<&str> {
        match self {
            Self::RunStarted { thread_id, .. }
            | Self::RunFinished { thread_id, .. }
            | Self::RunFailed { thread_id, .. }
            | Self::MessageChunk { thread_id, .. }
            | Self::Tool { thread_id, .. }
            | Self::Plan { thread_id, .. }
            | Self::Usage { thread_id, .. }
            | Self::Mode { thread_id, .. }
            | Self::Config { thread_id, .. }
            | Self::SessionInfo { thread_id, .. }
            | Self::Commands { thread_id, .. }
            | Self::PermissionRequested {
                approval: PendingApproval { thread_id, .. },
            }
            | Self::PermissionResolved { thread_id, .. }
            | Self::ElicitationRequested {
                request: PendingUserInputRequest { thread_id, .. },
            }
            | Self::ElicitationResolved { thread_id, .. } => Some(thread_id),
            Self::Ignored { thread_id, .. } => thread_id.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Agent,
    Thought,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldUpdate<T = String> {
    Unchanged,
    Clear,
    Set(T),
    Append(T),
}
