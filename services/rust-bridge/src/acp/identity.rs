use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

const VERSION: &str = "v1";
const MAX_COMPONENT_BYTES: usize = 1_024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("invalid bridge ACP identity")]
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionId {
    pub agent_id: String,
    pub acp_session_id: String,
}

impl AgentSessionId {
    pub fn new(
        agent_id: impl Into<String>,
        acp_session_id: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        let identity = Self {
            agent_id: agent_id.into(),
            acp_session_id: acp_session_id.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn encode(&self) -> String {
        format!(
            "{VERSION}.{}.{}",
            URL_SAFE_NO_PAD.encode(&self.agent_id),
            URL_SAFE_NO_PAD.encode(&self.acp_session_id)
        )
    }

    pub fn decode(value: &str) -> Result<Self, IdentityError> {
        let mut parts = value.split('.');
        if parts.next() != Some(VERSION) {
            return Err(IdentityError::Invalid);
        }
        let agent_id = decode_component(parts.next())?;
        let acp_session_id = decode_component(parts.next())?;
        if parts.next().is_some() {
            return Err(IdentityError::Invalid);
        }
        Self::new(agent_id, acp_session_id)
    }

    fn validate(&self) -> Result<(), IdentityError> {
        if self.agent_id.is_empty()
            || self.agent_id.len() > MAX_COMPONENT_BYTES
            || !self
                .agent_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || self.acp_session_id.is_empty()
            || self.acp_session_id.len() > MAX_COMPONENT_BYTES
            || self.acp_session_id.contains('\0')
        {
            return Err(IdentityError::Invalid);
        }
        Ok(())
    }
}

fn decode_component(value: Option<&str>) -> Result<String, IdentityError> {
    let value = value.ok_or(IdentityError::Invalid)?;
    if value.is_empty() || value.len() > MAX_COMPONENT_BYTES * 2 {
        return Err(IdentityError::Invalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| IdentityError::Invalid)?;
    String::from_utf8(bytes).map_err(|_| IdentityError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_session_identity_round_trips() {
        let id = AgentSessionId::new("registry-agent", "session/with spaces:opaque").unwrap();
        assert_eq!(AgentSessionId::decode(&id.encode()).unwrap(), id);
    }

    #[test]
    fn identity_rejects_invalid_encodings() {
        for value in [
            "v0.YQ.Yg",
            "v1..Yg",
            "v1.YQ.Yg.extra",
            "v1.%%%%.Yg",
            "v1.YQ",
            "v1._w.Yg",
        ] {
            assert!(AgentSessionId::decode(value).is_err(), "{value}");
        }
        let oversized = "a".repeat(MAX_COMPONENT_BYTES * 2 + 1);
        assert!(AgentSessionId::decode(&format!("v1.{oversized}.Yg")).is_err());
    }

    #[test]
    fn identity_rejects_invalid_components_at_every_boundary() {
        for (agent_id, session_id) in [
            ("", "session"),
            ("bad/agent", "session"),
            (&"a".repeat(MAX_COMPONENT_BYTES + 1), "session"),
            ("agent", ""),
            ("agent", "bad\0session"),
            ("agent", &"s".repeat(MAX_COMPONENT_BYTES + 1)),
        ] {
            assert!(AgentSessionId::new(agent_id, session_id).is_err());
        }
    }
}
