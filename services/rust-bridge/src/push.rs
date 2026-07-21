use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::{
    now_iso, read_bool,
    resource_limits::{
        PUSH_DEVICE_NAME_MAX_BYTES, PUSH_ID_MAX_BYTES, PUSH_PLATFORM_MAX_BYTES,
        PUSH_REGISTRY_MAX_BYTES, PUSH_REGISTRY_MAX_DEVICES, PUSH_TOKEN_MAX_BYTES,
    },
    storage::atomic_write_private,
    BridgeError,
};

const PUSH_REGISTRY_FILE_NAME: &str = ".tethercode-push-registry.json";

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
    pub(crate) profile_id: String,
    pub(crate) registration_id: String,
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
    persist_lock: Mutex<()>,
    path: PathBuf,
}

impl PushRegistryStore {
    pub(crate) async fn load(workdir: &Path) -> Self {
        let path = workdir.join(PUSH_REGISTRY_FILE_NAME);
        let registry = match tokio::fs::read(&path).await {
            Ok(contents) if contents.len() <= PUSH_REGISTRY_MAX_BYTES => {
                serde_json::from_slice::<PushRegistry>(&contents)
                    .map(|mut registry| {
                        registry.devices.retain(|device| {
                            !device.token.is_empty()
                                && !device.profile_id.is_empty()
                                && !device.registration_id.is_empty()
                                && device.profile_id.len() <= PUSH_ID_MAX_BYTES
                                && device.registration_id.len() <= PUSH_ID_MAX_BYTES
                                && device.token.len() <= PUSH_TOKEN_MAX_BYTES
                                && device.platform.len() <= PUSH_PLATFORM_MAX_BYTES
                                && device.device_name.len() <= PUSH_DEVICE_NAME_MAX_BYTES
                        });
                        registry.devices.truncate(PUSH_REGISTRY_MAX_DEVICES);
                        registry
                    })
                    .unwrap_or_default()
            }
            Err(_) => PushRegistry::default(),
            Ok(_) => PushRegistry::default(),
        };
        Self {
            registry: RwLock::new(registry),
            persist_lock: Mutex::new(()),
            path,
        }
    }

    pub(crate) async fn snapshot(&self) -> PushRegistry {
        self.registry.read().await.clone()
    }

    pub(crate) async fn register(
        &self,
        profile_id: String,
        registration_id: String,
        token: String,
        platform: String,
        device_name: String,
        events: PushEventPreferences,
    ) -> Result<usize, BridgeError> {
        let _persist_guard = self.persist_lock.lock().await;
        let now = now_iso();
        let mut registry = self.registry.write().await;
        let mut candidate = registry.clone();
        if let Some(existing) = candidate
            .devices
            .iter_mut()
            .find(|device| device.registration_id == registration_id)
        {
            if existing.profile_id != profile_id {
                return Err(BridgeError::invalid_params(
                    "registrationId is already bound to another profileId",
                ));
            }
            existing.token = token.clone();
            existing.platform = platform;
            existing.device_name = device_name;
            existing.events = events;
            existing.updated_at = now;
        } else {
            if candidate.devices.len() >= PUSH_REGISTRY_MAX_DEVICES {
                return Err(BridgeError::resource_limit(
                    "push_registry_devices",
                    PUSH_REGISTRY_MAX_DEVICES,
                    candidate.devices.len() + 1,
                ));
            }
            candidate.devices.push(PushDeviceRegistration {
                profile_id,
                registration_id: registration_id.clone(),
                token: token.clone(),
                platform,
                device_name,
                events,
                created_at: now.clone(),
                updated_at: now,
            });
        }
        candidate
            .devices
            .retain(|device| device.registration_id == registration_id || device.token != token);
        let count = candidate.devices.len();
        self.persist_snapshot(&candidate).await?;
        *registry = candidate;
        Ok(count)
    }

    pub(crate) async fn unregister(
        &self,
        profile_id: &str,
        registration_id: &str,
    ) -> Result<bool, BridgeError> {
        let _persist_guard = self.persist_lock.lock().await;
        let mut registry = self.registry.write().await;
        let mut candidate = registry.clone();
        let before = candidate.devices.len();
        candidate.devices.retain(|device| {
            device.profile_id != profile_id || device.registration_id != registration_id
        });
        let removed = candidate.devices.len() != before;
        if !removed {
            return Ok(false);
        }
        self.persist_snapshot(&candidate).await?;
        *registry = candidate;
        Ok(true)
    }

    pub(crate) async fn unregister_token(&self, token: &str) -> Result<bool, BridgeError> {
        let _persist_guard = self.persist_lock.lock().await;
        let mut registry = self.registry.write().await;
        let mut candidate = registry.clone();
        let before = candidate.devices.len();
        candidate.devices.retain(|device| device.token != token);
        if candidate.devices.len() == before {
            return Ok(false);
        }
        self.persist_snapshot(&candidate).await?;
        *registry = candidate;
        Ok(true)
    }

    async fn persist_snapshot(&self, snapshot: &PushRegistry) -> Result<(), BridgeError> {
        let contents = serde_json::to_vec_pretty(snapshot).map_err(|error| {
            BridgeError::server(&format!("failed to serialize push registry: {error}"))
        })?;
        if contents.len() > PUSH_REGISTRY_MAX_BYTES {
            return Err(BridgeError::resource_limit(
                "push_registry_bytes",
                PUSH_REGISTRY_MAX_BYTES,
                contents.len(),
            ));
        }
        atomic_write_private(&self.path, &contents)
            .await
            .map_err(|error| {
                BridgeError::server(&format!("failed to persist push registry: {error}"))
            })
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

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let truncated: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", truncated.trim_end())
}

pub(crate) fn token_suffix(token: &str) -> String {
    let visible: String = token.chars().rev().take(6).collect::<String>();
    visible.chars().rev().collect()
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("tethercode-push-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create temporary directory");
        path
    }

    fn registration(profile: &str, id: &str, token: &str) -> PushDeviceRegistration {
        PushDeviceRegistration {
            profile_id: profile.to_string(),
            registration_id: id.to_string(),
            token: token.to_string(),
            platform: "ios".to_string(),
            device_name: "phone".to_string(),
            events: PushEventPreferences::default(),
            created_at: "created".to_string(),
            updated_at: "updated".to_string(),
        }
    }

    async fn register(
        store: &PushRegistryStore,
        profile: &str,
        id: &str,
        token: &str,
    ) -> Result<usize, BridgeError> {
        store
            .register(
                profile.to_string(),
                id.to_string(),
                token.to_string(),
                "ios".to_string(),
                "phone".to_string(),
                PushEventPreferences::default(),
            )
            .await
    }

    #[tokio::test]
    async fn load_handles_missing_malformed_oversized_and_filtered_registries() {
        let dir = temp_dir();
        let store = PushRegistryStore::load(&dir).await;
        assert!(store.snapshot().await.devices.is_empty());

        let path = dir.join(PUSH_REGISTRY_FILE_NAME);
        fs::write(&path, b"not json").unwrap();
        assert!(PushRegistryStore::load(&dir)
            .await
            .snapshot()
            .await
            .devices
            .is_empty());

        fs::write(&path, vec![b'x'; PUSH_REGISTRY_MAX_BYTES + 1]).unwrap();
        assert!(PushRegistryStore::load(&dir)
            .await
            .snapshot()
            .await
            .devices
            .is_empty());

        let mut devices = vec![registration("profile", "valid", "token")];
        let mut invalid = registration("profile", "empty-token", "");
        devices.push(invalid);
        invalid = registration("", "empty-profile", "token-2");
        devices.push(invalid);
        invalid = registration("profile", "", "token-3");
        devices.push(invalid);
        invalid = registration(
            &"p".repeat(PUSH_ID_MAX_BYTES + 1),
            "long-profile",
            "token-4",
        );
        devices.push(invalid);
        invalid = registration("profile", &"r".repeat(PUSH_ID_MAX_BYTES + 1), "token-5");
        devices.push(invalid);
        invalid = registration(
            "profile",
            "long-token",
            &"t".repeat(PUSH_TOKEN_MAX_BYTES + 1),
        );
        devices.push(invalid);
        invalid = registration("profile", "long-platform", "token-6");
        invalid.platform = "p".repeat(PUSH_PLATFORM_MAX_BYTES + 1);
        devices.push(invalid);
        invalid = registration("profile", "long-name", "token-7");
        invalid.device_name = "n".repeat(PUSH_DEVICE_NAME_MAX_BYTES + 1);
        devices.push(invalid);
        for index in 0..PUSH_REGISTRY_MAX_DEVICES {
            devices.push(registration(
                "profile",
                &format!("extra-{index}"),
                &format!("token-extra-{index}"),
            ));
        }
        fs::write(
            &path,
            serde_json::to_vec(&PushRegistry { devices }).unwrap(),
        )
        .unwrap();
        let loaded = PushRegistryStore::load(&dir).await.snapshot().await;
        assert_eq!(loaded.devices.len(), PUSH_REGISTRY_MAX_DEVICES);
        assert_eq!(loaded.devices[0].registration_id, "valid");
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn register_updates_deduplicates_and_rejects_conflicts_and_limits() {
        let dir = temp_dir();
        let store = PushRegistryStore::load(&dir).await;
        assert_eq!(register(&store, "one", "first", "shared").await.unwrap(), 1);
        assert_eq!(
            register(&store, "one", "second", "shared").await.unwrap(),
            1
        );
        assert_eq!(store.snapshot().await.devices[0].registration_id, "second");

        assert_eq!(
            register(&store, "one", "second", "updated").await.unwrap(),
            1
        );
        let snapshot = store.snapshot().await;
        assert_eq!(snapshot.devices[0].token, "updated");
        assert!(register(&store, "other", "second", "nope").await.is_err());

        let mut full = Vec::new();
        for index in 0..PUSH_REGISTRY_MAX_DEVICES {
            full.push(registration(
                "profile",
                &format!("id-{index}"),
                &format!("token-{index}"),
            ));
        }
        *store.registry.write().await = PushRegistry { devices: full };
        assert!(register(&store, "profile", "overflow", "overflow")
            .await
            .is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unregister_operations_persist_and_leave_state_unchanged_on_failure() {
        let dir = temp_dir();
        let store = PushRegistryStore::load(&dir).await;
        register(&store, "profile", "one", "token-one")
            .await
            .unwrap();
        register(&store, "profile", "two", "token-two")
            .await
            .unwrap();
        assert!(!store.unregister("other", "one").await.unwrap());
        assert!(store.unregister("profile", "one").await.unwrap());
        assert!(!store.unregister_token("missing").await.unwrap());
        assert!(store.unregister_token("token-two").await.unwrap());
        assert!(PushRegistryStore::load(&dir)
            .await
            .snapshot()
            .await
            .devices
            .is_empty());

        let missing = dir.join("missing");
        let broken = PushRegistryStore::load(&missing).await;
        assert!(register(&broken, "profile", "id", "token").await.is_err());
        assert!(broken.snapshot().await.devices.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn persistence_rejects_an_oversized_snapshot() {
        let dir = temp_dir();
        let store = PushRegistryStore::load(&dir).await;
        let snapshot = PushRegistry {
            devices: vec![registration(
                "profile",
                "id",
                &"x".repeat(PUSH_REGISTRY_MAX_BYTES),
            )],
        };
        assert!(store.persist_snapshot(&snapshot).await.is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn preferences_use_defaults_for_missing_or_invalid_values() {
        let defaults = parse_push_event_preferences(None);
        assert!(defaults.turn_completed && defaults.approval_requested);
        let parsed = parse_push_event_preferences(Some(&json!({
            "turnCompleted": false,
            "approvalRequested": "invalid"
        })));
        assert!(!parsed.turn_completed && parsed.approval_requested);
    }

    #[test]
    fn truncation_and_suffix_are_unicode_safe_at_boundaries() {
        assert_eq!(truncate_chars("short", 5), "short");
        assert_eq!(truncate_chars("abc", 0), "");
        assert_eq!(truncate_chars("ab  cd", 4), "ab…");
        assert_eq!(truncate_chars("éclair", 3), "éc…");
        assert_eq!(token_suffix("abc"), "abc");
        assert_eq!(token_suffix("token-123456"), "123456");
        assert_eq!(token_suffix("abé日文xyz"), "é日文xyz");
    }
}
