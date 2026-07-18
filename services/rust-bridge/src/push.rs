use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

use crate::{now_iso, read_bool, read_string};

const PUSH_REGISTRY_FILE_NAME: &str = ".clawdex-push-registry.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushEventPreferences {
    #[serde(default = "default_true")]
    pub(crate) turn_completed: bool,
    #[serde(default = "default_true")]
    pub(crate) approval_requested: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PushEventPreferences {
    fn default() -> Self {
        Self {
            turn_completed: true,
            approval_requested: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushDeviceRegistration {
    pub(crate) token: String,
    #[serde(default)]
    pub(crate) platform: String,
    #[serde(default)]
    pub(crate) device_name: String,
    #[serde(default)]
    pub(crate) events: PushEventPreferences,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushRegistry {
    #[serde(default)]
    pub(crate) devices: Vec<PushDeviceRegistration>,
}

pub(crate) struct PushRegistryStore {
    registry: RwLock<PushRegistry>,
    path: PathBuf,
}

impl PushRegistryStore {
    pub(crate) async fn load(workdir: &Path) -> Self {
        let path = workdir.join(PUSH_REGISTRY_FILE_NAME);
        let registry = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => serde_json::from_str::<PushRegistry>(&contents).unwrap_or_default(),
            Err(_) => PushRegistry::default(),
        };
        Self {
            registry: RwLock::new(registry),
            path,
        }
    }

    pub(crate) async fn snapshot(&self) -> PushRegistry {
        self.registry.read().await.clone()
    }

    pub(crate) async fn register(
        &self,
        token: String,
        platform: String,
        device_name: String,
        events: PushEventPreferences,
    ) -> usize {
        let now = now_iso();
        let count = {
            let mut registry = self.registry.write().await;
            if let Some(existing) = registry
                .devices
                .iter_mut()
                .find(|device| device.token == token)
            {
                existing.platform = platform;
                existing.device_name = device_name;
                existing.events = events;
                existing.updated_at = now;
            } else {
                registry.devices.push(PushDeviceRegistration {
                    token,
                    platform,
                    device_name,
                    events,
                    created_at: now.clone(),
                    updated_at: now,
                });
            }
            registry.devices.len()
        };
        self.persist().await;
        count
    }

    pub(crate) async fn unregister(&self, token: &str) -> bool {
        let removed = {
            let mut registry = self.registry.write().await;
            let before = registry.devices.len();
            registry.devices.retain(|device| device.token != token);
            registry.devices.len() != before
        };
        if removed {
            self.persist().await;
        }
        removed
    }

    async fn persist(&self) {
        let snapshot = self.snapshot().await;
        match serde_json::to_string_pretty(&snapshot) {
            Ok(contents) => {
                if let Err(error) = tokio::fs::write(&self.path, contents).await {
                    eprintln!("failed to persist push registry: {error}");
                }
            }
            Err(error) => eprintln!("failed to serialize push registry: {error}"),
        }
    }
}

pub(crate) fn parse_push_event_preferences(value: Option<&Value>) -> PushEventPreferences {
    let defaults = PushEventPreferences::default();
    match value {
        Some(object) => PushEventPreferences {
            turn_completed: read_bool(object.get("turnCompleted"))
                .unwrap_or(defaults.turn_completed),
            approval_requested: read_bool(object.get("approvalRequested"))
                .unwrap_or(defaults.approval_requested),
        },
        None => defaults,
    }
}

pub(crate) fn push_thread_is_top_level(thread_read_result: &Value) -> bool {
    let thread = thread_read_result
        .get("thread")
        .unwrap_or(thread_read_result);
    let Some(source) = thread.get("source") else {
        return false;
    };

    if let Some(source) = source.as_str() {
        return push_source_kind_is_top_level(source);
    }

    let Some(source) = source.as_object() else {
        return false;
    };
    if source.contains_key("subAgent")
        || source.contains_key("subagent")
        || value_contains_thread_parent(&Value::Object(source.clone()))
    {
        return false;
    }

    read_string(source.get("kind"))
        .or_else(|| read_string(source.get("type")))
        .is_some_and(|kind| push_source_kind_is_top_level(&kind))
}

fn push_source_kind_is_top_level(source: &str) -> bool {
    matches!(
        source.trim().to_ascii_lowercase().as_str(),
        "cli" | "vscode" | "exec" | "appserver" | "unknown" | "cursorsdk"
    )
}

fn value_contains_thread_parent(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (matches!(
                key.as_str(),
                "parentThreadId" | "parent_thread_id" | "parentID"
            ) && read_string(Some(value)).is_some_and(|parent| !parent.trim().is_empty()))
                || value_contains_thread_parent(value)
        }),
        Value::Array(values) => values.iter().any(value_contains_thread_parent),
        _ => false,
    }
}

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", truncated.trim_end())
}

pub(crate) fn token_suffix(token: &str) -> String {
    let visible: String = token.chars().rev().take(6).collect::<String>();
    visible.chars().rev().collect()
}
