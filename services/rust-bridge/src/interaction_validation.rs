use crate::*;

pub(super) fn parse_internal_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;

    if let Some(number) = value.as_u64() {
        return Some(number);
    }

    if let Some(number) = value.as_i64() {
        if number >= 0 {
            return Some(number as u64);
        }
    }

    if let Some(raw) = value.as_str() {
        return raw.parse::<u64>().ok();
    }

    None
}

pub(super) fn read_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

pub(super) fn read_non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn required_push_id(params: &Value, field: &str) -> Result<String, BridgeError> {
    let value = read_string(params.get(field))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::invalid_params(&format!("{field} is required")))?;
    if value.len() > PUSH_ID_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "push_identity_bytes",
            PUSH_ID_MAX_BYTES,
            value.len(),
        ));
    }
    Ok(value)
}

pub(super) fn read_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

pub(super) fn validate_bridge_ui_surface(surface: &BridgeUiSurface) -> Result<(), BridgeError> {
    let encoded_bytes = serde_json::to_vec(surface)
        .map_err(|error| BridgeError::invalid_params(&format!("invalid UI surface: {error}")))?
        .len();
    if encoded_bytes > UI_SURFACE_MAX_BYTES {
        return Err(BridgeError::resource_limit(
            "ui_surface_bytes",
            UI_SURFACE_MAX_BYTES,
            encoded_bytes,
        ));
    }
    if surface.blocks.len() > UI_SURFACE_MAX_BLOCKS {
        return Err(BridgeError::resource_limit(
            "ui_surface_blocks",
            UI_SURFACE_MAX_BLOCKS,
            surface.blocks.len(),
        ));
    }
    if surface.actions.len() > UI_SURFACE_MAX_ACTIONS {
        return Err(BridgeError::resource_limit(
            "ui_surface_actions",
            UI_SURFACE_MAX_ACTIONS,
            surface.actions.len(),
        ));
    }
    if surface.id.trim().is_empty() {
        return Err(BridgeError::invalid_params("id must not be empty"));
    }
    if surface.thread_id.trim().is_empty() {
        return Err(BridgeError::invalid_params("threadId must not be empty"));
    }
    if surface.title.trim().is_empty() {
        return Err(BridgeError::invalid_params("title must not be empty"));
    }

    for block in &surface.blocks {
        validate_bridge_ui_block(block)?;
    }
    for action in &surface.actions {
        if action.id.trim().is_empty() {
            return Err(BridgeError::invalid_params("action id must not be empty"));
        }
        if action.label.trim().is_empty() {
            return Err(BridgeError::invalid_params(
                "action label must not be empty",
            ));
        }
    }

    Ok(())
}

pub(super) fn validate_bridge_ui_block(block: &BridgeUiBlock) -> Result<(), BridgeError> {
    let text_bytes = match block {
        BridgeUiBlock::Text { text } => text.len(),
        BridgeUiBlock::Markdown { markdown } => markdown.len(),
        BridgeUiBlock::Code { text, .. } => text.len(),
        _ => 0,
    };
    if text_bytes > UI_SURFACE_MAX_TEXT_BYTES {
        return Err(BridgeError::resource_limit(
            "ui_surface_text_bytes",
            UI_SURFACE_MAX_TEXT_BYTES,
            text_bytes,
        ));
    }
    match block {
        BridgeUiBlock::Text { text } if text.trim().is_empty() => {
            Err(BridgeError::invalid_params("text block must not be empty"))
        }
        BridgeUiBlock::Markdown { markdown } if markdown.trim().is_empty() => Err(
            BridgeError::invalid_params("markdown block must not be empty"),
        ),
        BridgeUiBlock::Checklist { items } if items.is_empty() => Err(BridgeError::invalid_params(
            "checklist block must contain at least one item",
        )),
        BridgeUiBlock::Checklist { items } => {
            if items.len() > UI_SURFACE_MAX_ITEMS_PER_BLOCK {
                return Err(BridgeError::resource_limit(
                    "ui_surface_block_items",
                    UI_SURFACE_MAX_ITEMS_PER_BLOCK,
                    items.len(),
                ));
            }
            if items.iter().any(|item| item.label.trim().is_empty()) {
                return Err(BridgeError::invalid_params(
                    "checklist item label must not be empty",
                ));
            }
            Ok(())
        }
        BridgeUiBlock::KeyValue { items } if items.is_empty() => Err(BridgeError::invalid_params(
            "keyValue block must contain at least one item",
        )),
        BridgeUiBlock::KeyValue { items } => {
            if items.len() > UI_SURFACE_MAX_ITEMS_PER_BLOCK {
                return Err(BridgeError::resource_limit(
                    "ui_surface_block_items",
                    UI_SURFACE_MAX_ITEMS_PER_BLOCK,
                    items.len(),
                ));
            }
            if items
                .iter()
                .any(|item| item.label.trim().is_empty() || item.value.trim().is_empty())
            {
                return Err(BridgeError::invalid_params(
                    "keyValue item label and value must not be empty",
                ));
            }
            Ok(())
        }
        BridgeUiBlock::Code { text, .. } if text.trim().is_empty() => {
            Err(BridgeError::invalid_params("code block must not be empty"))
        }
        BridgeUiBlock::Progress {
            label, value, max, ..
        } => {
            if label.trim().is_empty() {
                return Err(BridgeError::invalid_params(
                    "progress label must not be empty",
                ));
            }
            if !value.is_finite() || !max.is_finite() || *max <= 0.0 || *value < 0.0 {
                return Err(BridgeError::invalid_params(
                    "progress value must be finite and max must be greater than zero",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(super) fn contains_disallowed_control_chars(value: &str) -> bool {
    value
        .chars()
        .any(|char| matches!(char, ';' | '|' | '&' | '<' | '>' | '`'))
}

pub(super) fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub(super) fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }

    normalized
}
