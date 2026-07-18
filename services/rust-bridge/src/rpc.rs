use serde_json::Value;

#[derive(Debug)]
pub(crate) enum RpcRequestParseError {
    InvalidJson(String),
    InvalidPayload,
    MissingMethod { id: Value },
    Notification,
}

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
