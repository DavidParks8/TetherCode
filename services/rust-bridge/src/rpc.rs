use serde_json::Value;

#[derive(Debug)]
pub(crate) enum RpcRequestParseError {
    InvalidJson(String),
    InvalidPayload,
    MissingMethod { id: Value },
    Notification,
}

#[derive(Debug)]
pub(crate) struct RpcRequest {
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Option<Value>,
}

pub(crate) fn parse_request(text: &str) -> Result<RpcRequest, RpcRequestParseError> {
    let parsed = serde_json::from_str::<Value>(text)
        .map_err(|error| RpcRequestParseError::InvalidJson(error.to_string()))?;
    let object = parsed
        .as_object()
        .ok_or(RpcRequestParseError::InvalidPayload)?;
    let id = object.get("id").cloned();
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcRequestParseError::MissingMethod {
            id: id.clone().unwrap_or(Value::Null),
        })?;
    let Some(id) = id else {
        return Err(RpcRequestParseError::Notification);
    };
    Ok(RpcRequest {
        id,
        method: method.to_string(),
        params: object.get("params").cloned(),
    })
}

pub(crate) fn parse_client_request_id(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(Value::Null)
}

pub(crate) fn is_forwarded_method(method: &str) -> bool {
    matches!(
        method,
        "account/login/cancel"
            | "account/login/start"
            | "account/logout"
            | "account/rateLimits/read"
            | "account/read"
            | "agent/list"
            | "app/list"
            | "collaborationMode/list"
            | "config/batchWrite"
            | "config/mcpServer/reload"
            | "config/read"
            | "config/value/write"
            | "configRequirements/read"
            | "experimentalFeature/list"
            | "feedback/upload"
            | "fuzzyFileSearch/sessionStart"
            | "fuzzyFileSearch/sessionStop"
            | "fuzzyFileSearch/sessionUpdate"
            | "mcpServer/oauth/login"
            | "mcpServerStatus/list"
            | "mock/experimentalMethod"
            | "model/list"
            | "review/start"
            | "skills/config/write"
            | "skills/list"
            | "skills/remote/export"
            | "skills/remote/list"
            | "thread/archive"
            | "thread/backgroundTerminals/clean"
            | "thread/compact/start"
            | "thread/fork"
            | "thread/list"
            | "thread/loaded/list"
            | "thread/name/set"
            | "thread/read"
            | "thread/resume"
            | "thread/rollback"
            | "thread/start"
            | "thread/unarchive"
            | "turn/interrupt"
            | "turn/start"
            | "turn/steer"
    )
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_requests_with_all_id_and_params_shapes() {
        let request =
            parse_request(r#"{"id":7,"method":"thread/read","params":{"id":"t"}}"#).unwrap();
        assert_eq!(request.id, json!(7));
        assert_eq!(request.method, "thread/read");
        assert_eq!(request.params, Some(json!({ "id": "t" })));

        let request = parse_request(r#"{"id":null,"method":"account/read"}"#).unwrap();
        assert_eq!(request.id, Value::Null);
        assert!(request.params.is_none());
    }

    #[test]
    fn classifies_each_parse_failure_without_losing_an_id() {
        match parse_request("{").unwrap_err() {
            RpcRequestParseError::InvalidJson(message) => assert!(!message.is_empty()),
            _ => panic!("expected invalid JSON"),
        }
        assert!(matches!(
            parse_request("[]"),
            Err(RpcRequestParseError::InvalidPayload)
        ));
        match parse_request(r#"{"id":"client"}"#).unwrap_err() {
            RpcRequestParseError::MissingMethod { id } => assert_eq!(id, json!("client")),
            _ => panic!("expected missing method"),
        }
        match parse_request(r#"{"method":3}"#).unwrap_err() {
            RpcRequestParseError::MissingMethod { id } => assert_eq!(id, Value::Null),
            _ => panic!("expected missing method"),
        }
        assert!(matches!(
            parse_request(r#"{"method":"event"}"#),
            Err(RpcRequestParseError::Notification)
        ));
    }

    #[test]
    fn client_id_recovery_and_forwarding_are_conservative() {
        assert_eq!(parse_client_request_id(r#"{"id":"abc"}"#), json!("abc"));
        assert_eq!(parse_client_request_id(r#"{"method":"x"}"#), Value::Null);
        assert_eq!(parse_client_request_id("not json"), Value::Null);
        assert!(is_forwarded_method("thread/read"));
        assert!(is_forwarded_method("turn/start"));
        assert!(!is_forwarded_method("bridge/status/read"));
        assert!(!is_forwarded_method("thread/read/extra"));
    }
}
