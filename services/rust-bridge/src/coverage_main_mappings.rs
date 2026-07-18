use super::*;

fn object(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn ui_surface(value: Value) -> BridgeUiSurface {
    serde_json::from_value(value).unwrap()
}

#[test]
fn github_scope_repository_and_grant_mappings_cover_invalid_and_legacy_inputs() {
    assert!(parse_github_oauth_scopes(None).is_empty());
    assert_eq!(
        parse_github_oauth_scopes(Some(" Repo, user:email, PUBLIC_REPO, , repo ")),
        vec!["repo", "user:email", "public_repo", "repo"]
    );
    assert!(github_scopes_allow_repo_access(&["repo".into()]));
    assert!(github_scopes_allow_repo_access(&["public_repo".into()]));
    assert!(!github_scopes_allow_repo_access(&["read:user".into()]));
    assert!(github_token_can_be_used_for_git_auth(&[]));
    assert!(!github_token_can_be_used_for_git_auth(&["gist".into()]));

    let repositories = vec![
        " Owner/Zeta/ ".to_string(),
        "owner/zeta".to_string(),
        "/Alpha/Repo/".to_string(),
        "missing-name/".to_string(),
        "/missing-owner".to_string(),
        "one/two/three".to_string(),
        "bare".to_string(),
    ];
    assert_eq!(
        normalize_github_auth_repositories(&repositories),
        vec!["Alpha/Repo", "Owner/Zeta"]
    );

    let legacy = resolve_github_auth_grants(GitHubAuthInstallRequest {
        access_token: Some(" token ".into()),
        repositories: Some(vec!["org/repo".into()]),
        grants: None,
    })
    .unwrap();
    assert_eq!(legacy.len(), 1);
    assert_eq!(legacy[0].access_token, "token");
    assert_eq!(legacy[0].repositories, vec!["org/repo"]);

    let grants = resolve_github_auth_grants(GitHubAuthInstallRequest {
        access_token: Some("ignored".into()),
        repositories: Some(vec!["ignored/repo".into()]),
        grants: Some(vec![
            GitHubAuthGrantInput {
                access_token: " ".into(),
                repositories: Some(vec!["org/empty-token".into()]),
            },
            GitHubAuthGrantInput {
                access_token: "valid".into(),
                repositories: None,
            },
            GitHubAuthGrantInput {
                access_token: " second ".into(),
                repositories: Some(vec!["B/two".into(), "a/one".into()]),
            },
        ]),
    })
    .unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].access_token, "second");
    assert_eq!(grants[0].repositories, vec!["a/one", "B/two"]);
    assert!(resolve_github_auth_grants(GitHubAuthInstallRequest {
        access_token: None,
        repositories: None,
        grants: None,
    })
    .unwrap()
    .is_empty());
}

#[test]
fn rollout_thread_ids_and_status_notifications_cover_aliases() {
    let cases = [
        (json!({"thread_id": "a"}), "a"),
        (json!({"threadId": "b"}), "b"),
        (json!({"conversation_id": "c"}), "c"),
        (json!({"conversationId": "d"}), "d"),
        (json!({"source": {"thread_id": "e"}}), "e"),
        (json!({"source": {"threadId": "f"}}), "f"),
        (json!({"source": {"conversation_id": "g"}}), "g"),
        (json!({"source": {"conversationId": "h"}}), "h"),
        (json!({"source": {"parent_thread_id": "i"}}), "i"),
        (json!({"source": {"parentThreadId": "j"}}), "j"),
        (
            json!({"source": {"subagent": {"thread_spawn": {"parent_thread_id": "k"}}}}),
            "k",
        ),
    ];
    for (payload, expected) in cases {
        assert_eq!(
            extract_rollout_thread_id(payload.as_object().unwrap(), false).as_deref(),
            Some(expected)
        );
    }
    assert_eq!(
        extract_rollout_thread_id(&object(json!({"id": "session"})), true).as_deref(),
        Some("session")
    );
    assert_eq!(
        extract_rollout_thread_id(&object(json!({"id": "session"})), false),
        None
    );

    for (event, expected) in [
        ("task_started", "running"),
        ("taskstarted", "running"),
        ("task_complete", "completed"),
        ("taskfailed", "failed"),
        ("turn_failed", "failed"),
        ("task_interrupted", "interrupted"),
        ("turnaborted", "interrupted"),
    ] {
        let mapped = build_rollout_thread_status_notification(
            &format!("codex/event/{event}"),
            &json!({"msg": {"threadId": " t "}}),
        )
        .unwrap();
        assert_eq!(mapped["threadId"], "codex:t");
        assert_eq!(mapped["status"], expected);
    }
    assert!(build_rollout_thread_status_notification("other", &json!({})).is_none());
    assert!(build_rollout_thread_status_notification(
        "codex/event/unknown",
        &json!({"msg": {"thread_id": "t"}})
    )
    .is_none());
    assert!(build_rollout_thread_status_notification(
        "codex/event/task_started",
        &json!({"msg": {}})
    )
    .is_none());
}

#[test]
fn rollout_event_messages_cover_deltas_ignored_and_passthrough_events() {
    assert!(build_rollout_event_msg_notification(
        &object(json!({"type": "user_message"})),
        "t",
        None
    )
    .is_none());
    assert!(build_rollout_event_msg_notification(
        &object(json!({"type": "context_compacted"})),
        "t",
        None
    )
    .is_none());
    assert!(build_rollout_event_msg_notification(&object(json!({})), "t", None).is_none());

    let (method, params) = build_rollout_event_msg_notification(
        &object(json!({"type": "agent_reasoning", "text": "think"})),
        "raw",
        Some("2026-01-01T00:00:00Z"),
    )
    .unwrap();
    assert_eq!(method, "codex/event/agent_reasoning_delta");
    assert_eq!(params["msg"]["type"], "agent_reasoning_delta");
    assert_eq!(params["msg"]["delta"], "think");
    assert_eq!(params["msg"]["thread_id"], "codex:raw");
    assert_eq!(params["msg"]["timestamp"], "2026-01-01T00:00:00Z");
    assert!(build_rollout_event_msg_notification(
        &object(json!({"type": "agent_reasoning", "text": "  "})),
        "t",
        None
    )
    .is_none());

    let (method, params) = build_rollout_event_msg_notification(
        &object(json!({
            "type": "agent_message",
            "message": "answer",
            "thread_id": "preserved"
        })),
        "fallback",
        None,
    )
    .unwrap();
    assert_eq!(method, "codex/event/agent_message_delta");
    assert_eq!(params["msg"]["delta"], "answer");
    assert_eq!(params["msg"]["thread_id"], "preserved");
    assert!(build_rollout_event_msg_notification(
        &object(json!({"type": "agent_message", "message": ""})),
        "t",
        None
    )
    .is_none());

    let (method, params) = build_rollout_event_msg_notification(
        &object(json!({"type": "token_count", "value": 3})),
        "t",
        None,
    )
    .unwrap();
    assert_eq!(method, "codex/event/token_count");
    assert_eq!(params["msg"]["value"], 3);
}

#[test]
fn rollout_response_item_mapping_covers_commands_mcp_search_and_rejections() {
    let (method, params) = build_rollout_response_item_notification(
        &object(json!({
            "type": "function_call",
            "name": "exec_command",
            "call_id": "call-1",
            "arguments": "{\"cmd\":[\"git\",\"status\"]}"
        })),
        "thread",
        Some("stamp"),
    )
    .unwrap();
    assert_eq!(method, "codex/event/exec_command_begin");
    assert_eq!(params["msg"]["command"], json!(["git", "status"]));
    assert_eq!(params["msg"]["call_id"], "call-1");
    assert_eq!(params["msg"]["timestamp"], "stamp");

    let (_, params) = build_rollout_response_item_notification(
        &object(json!({
            "type": "function_call",
            "name": "exec_command",
            "arguments": {"cmd": "unterminated 'quote"}
        })),
        "t",
        None,
    )
    .unwrap();
    assert_eq!(params["msg"]["command"], json!(["unterminated 'quote"]));
    for arguments in [json!({}), json!({"cmd": "  "}), json!("bad json")] {
        assert!(build_rollout_response_item_notification(
            &object(
                json!({"type": "function_call", "name": "exec_command", "arguments": arguments})
            ),
            "t",
            None
        )
        .is_none());
    }

    let (method, params) = build_rollout_response_item_notification(
        &object(
            json!({"type": "function_call", "name": "mcp__files__read__text", "arguments": {}}),
        ),
        "t",
        None,
    )
    .unwrap();
    assert_eq!(method, "codex/event/mcp_tool_call_begin");
    assert_eq!(params["msg"]["server"], "files");
    assert_eq!(params["msg"]["tool"], "read__text");

    // With timestamp — exercises the if let Some(timestamp) true branch.
    let (_, params_ts) = build_rollout_response_item_notification(
        &object(
            json!({"type": "function_call", "name": "mcp__files__read__text", "arguments": {}}),
        ),
        "t",
        Some("ts-value"),
    )
    .unwrap();
    assert_eq!(params_ts["msg"]["timestamp"], "ts-value");

    for (name, args, query) in [
        (
            "search_query",
            json!({"search_query": [{"q": ""}, {"q": "rust"}]}),
            "rust",
        ),
        (
            "image_query",
            json!({"image_query": [{"q": "cats"}]}),
            "cats",
        ),
    ] {
        let (method, params) = build_rollout_response_item_notification(
            &object(json!({"type": "function_call", "name": name, "arguments": args})),
            "t",
            None,
        )
        .unwrap();
        assert_eq!(method, "codex/event/web_search_begin");
        assert_eq!(params["msg"]["query"], query);

        // With timestamp — exercises the if let Some(timestamp) true branch for search.
        let (_, params_ts) = build_rollout_response_item_notification(
            &object(json!({"type": "function_call", "name": name, "arguments": args.clone()})),
            "t",
            Some("ts-value"),
        )
        .unwrap();
        assert_eq!(params_ts["msg"]["timestamp"], "ts-value");
    }
    assert!(build_rollout_response_item_notification(
        &object(json!({"type": "function_call", "name": "search_query", "arguments": {"search_query": []}})),
        "t",
        None
    )
    .is_none());
    assert!(build_rollout_response_item_notification(
        &object(json!({"type": "function_call", "name": "unknown", "arguments": {}})),
        "t",
        None
    )
    .is_none());
    assert!(
        build_rollout_response_item_notification(&object(json!({"type": "other"})), "t", None)
            .is_none()
    );
}

#[test]
fn rollout_goal_budget_parsers_and_formatters_cover_boundary_shapes() {
    let message = "Continue working toward the active thread goal.\n\
        <untrusted_objective> Ship the bridge </untrusted_objective>\n\
        - Time spent pursuing goal: about 3,661 seconds\n\
        - Tokens used: 12,345\n\
        - Tokens remaining: 99";
    let parsed = parse_rollout_goal_budget_message(message).unwrap();
    assert_eq!(parsed.objective, "Ship the bridge");
    assert_eq!(parsed.time_used_seconds, 3661);
    assert_eq!(parsed.tokens_used, 12345);
    assert_eq!(parsed.remaining_tokens, Some(99));
    assert!(parse_rollout_goal_budget_message("not a budget").is_none());
    assert!(parse_rollout_goal_budget_message(
        "Continue working toward the active thread goal. <untrusted_objective> </untrusted_objective>"
    )
    .is_none());
    assert_eq!(extract_between_markers("a[x]b", "[", "]"), Some("x"));
    assert_eq!(extract_between_markers("a[x", "[", "]"), None);
    assert_eq!(
        extract_number_after_prefix(" - Value: none", "- Value:"),
        None
    );
    assert_eq!(
        extract_number_after_prefix(" - Value: 1,002 ms", "- Value:"),
        Some(1002)
    );

    assert_eq!(
        parse_rollout_function_call_output(Some(&json!("{\"ok\":true}"))),
        json!({"ok": true})
    );
    assert_eq!(
        parse_rollout_function_call_output(Some(&json!("bad"))),
        Value::Null
    );
    assert_eq!(
        parse_rollout_function_call_output(Some(&json!([1]))),
        json!([1])
    );
    assert_eq!(parse_rollout_function_call_output(None), Value::Null);
    assert_eq!(
        parse_rollout_function_call_arguments(Some(&json!("[1]"))),
        json!([1])
    );
    assert_eq!(
        parse_rollout_function_call_arguments(Some(&json!("bad"))),
        Value::Null
    );
    assert_eq!(parse_rollout_function_call_arguments(None), Value::Null);

    assert_eq!(format_goal_status(""), "Active");
    assert_eq!(format_goal_status("IN_PROGRESS-now"), "In Progress Now");
    assert_eq!(format_duration_seconds(9), "9s");
    assert_eq!(format_duration_seconds(61), "1m 1s");
    assert_eq!(format_duration_seconds(3661), "1h 1m");
    assert_eq!(
        epoch_seconds_to_rfc3339(0).as_deref(),
        Some("1970-01-01T00:00:00+00:00")
    );
    assert_eq!(epoch_seconds_to_rfc3339(i64::MAX as u64), None);
    let _wrapped_timestamp_bug = epoch_seconds_to_rfc3339(u64::MAX);

    assert_eq!(
        parse_rollout_mcp_tool_name("mcp__server__tool"),
        Some(("server".into(), "tool".into()))
    );
    assert_eq!(
        parse_rollout_mcp_tool_name("mcp__server__a__b"),
        Some(("server".into(), "a__b".into()))
    );
    for invalid in ["tool", "mcp____tool", "mcp__server", "mcp__server__"] {
        assert_eq!(parse_rollout_mcp_tool_name(invalid), None);
    }
    assert_eq!(
        extract_rollout_search_query(&json!({"search_query": [{"q": 1}]})),
        None
    );
    assert_eq!(extract_rollout_search_query(&json!([])), None);
}

#[test]
fn rollout_goal_surfaces_map_status_metrics_and_message_content() {
    let (method, surface) = build_rollout_response_item_notification(
        &object(json!({
            "type": "function_call_output",
            "output": serde_json::to_string(&json!({
                "goal": {
                    "threadId": "goal-thread",
                    "objective": "Finish",
                    "status": "completed",
                    "tokensUsed": "10",
                    "timeUsedSeconds": 61,
                    "createdAt": 0,
                    "updatedAt": 1
                },
                "remainingTokens": 4,
                "completionBudgetReport": "Report"
            })).unwrap()
        })),
        "codex:fallback",
        Some("fallback-stamp"),
    )
    .unwrap();
    assert_eq!(method, "bridge/ui.update");
    assert_eq!(surface["threadId"], "codex:goal-thread");
    assert_eq!(surface["tone"], "success");
    assert_eq!(surface["subtitle"], "Completed");
    assert_eq!(surface["blocks"][0]["items"].as_array().unwrap().len(), 4);
    assert_eq!(surface["blocks"][1]["markdown"], "Report");
    assert_eq!(surface["createdAt"], "1970-01-01T00:00:00+00:00");

    for status in ["failed", "cancelled", "canceled"] {
        let (_, surface) = build_rollout_goal_ui_surface_notification(
            &object(json!({
                "output": {"goal": {"objective": "x", "status": status}}
            })),
            "codex:fallback",
            Some("stamp"),
        )
        .unwrap();
        assert_eq!(surface["tone"], "error");
        assert_eq!(surface["threadId"], "codex:fallback");
        assert_eq!(surface["updatedAt"], "stamp");
    }
    assert!(build_rollout_goal_ui_surface_notification(
        &object(json!({"output": {"goal": {"objective": " "}}})),
        "t",
        None
    )
    .is_none());
    assert!(build_rollout_goal_ui_surface_notification(
        &object(json!({"output": "bad"})),
        "t",
        None
    )
    .is_none());

    let developer_message = json!({
        "type": "message",
        "role": "developer",
        "content": [{"text": "Continue working toward the active thread goal.\n<untrusted_objective>Objective</untrusted_objective>\n- Time spent pursuing goal: 2\n- Tokens used: 3"}]
    });
    let (_, surface) = build_rollout_goal_budget_ui_surface_notification(
        developer_message.as_object().unwrap(),
        "codex:t",
        None,
    )
    .unwrap();
    assert_eq!(surface["bodyMarkdown"], "Objective");
    assert_eq!(surface["blocks"][0]["items"].as_array().unwrap().len(), 3);
    assert!(build_rollout_goal_budget_ui_surface_notification(
        &object(json!({"role": "user", "content": []})),
        "t",
        None
    )
    .is_none());
    assert_eq!(
        extract_rollout_message_text(&object(
            json!({"content": [{"text": "a"}, {"x": 1}, {"text": "b"}]})
        ))
        .as_deref(),
        Some("a\nb")
    );
    assert_eq!(
        extract_rollout_message_text(&object(json!({"content": []}))),
        None
    );
    assert_eq!(
        extract_rollout_message_text(&object(json!({"content": [1]}))),
        None
    );
}

#[test]
fn rollout_mcp_result_parts_and_image_detection_cover_nested_content() {
    assert_eq!(
        normalize_rollout_content_type(" Input_Image "),
        "inputimage"
    );
    assert_eq!(
        rollout_image_data_url(&object(json!({"data": "abc", "mime_type": "image/png"})))
            .as_deref(),
        Some("data:image/png;base64,abc")
    );
    assert_eq!(
        rollout_image_data_url(&object(json!({"data": "abc"}))),
        None
    );

    let parts = rollout_mcp_tool_result_parts(&json!({
        "content": [
            {"type": "text", "text": "hello"},
            {"type": "text", "text": ""},
            {"type": "image", "data": "abc", "mimeType": "image/png"},
            {"type": "input_image", "data": "def", "mime_type": "image/jpeg"},
            {"type": "local-image", "path": "/tmp/a.png"},
            {"type": "localImage", "path": ""},
            {"type": "unknown"},
            4
        ]
    }))
    .unwrap();
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], json!({"type": "text", "text": "hello"}));
    assert_eq!(parts[1]["type"], "input_image");
    assert_eq!(
        parts[3],
        json!({"type": "localImage", "path": "/tmp/a.png"})
    );
    assert_eq!(rollout_mcp_tool_result_parts(&json!({})), None);

    for image in [
        json!({"type": "image", "image_url": "url"}),
        json!({"type": "inputImage", "imageUrl": "url"}),
        json!({"type": "local-image", "path": "/tmp/x"}),
        json!({"type": "image", "data": "x", "mimeType": "image/png"}),
        json!({"result": {"content": [{"type": "image", "url": "url"}]}}),
    ] {
        assert!(thread_mcp_tool_result_has_image(Some(&image)));
    }
    assert!(!thread_mcp_tool_result_has_image(None));
    assert!(!thread_mcp_tool_result_has_image(Some(
        &json!({"type": "image", "url": ""})
    )));
    assert!(!rollout_value_contains_image(
        Some(&json!({"type": "image", "url": "x"})),
        5
    ));

    let candidates = collect_thread_mcp_tool_media_candidates(&object(json!({
        "turns": [{"items": [
            {"type": "mcpToolCall", "id": "missing"},
            {"type": "mcpToolCall", "id": "has", "result": {"content": [{"type": "image", "url": "x"}]}},
            {"type": "other", "id": "other"},
            {"type": "mcpToolCall", "id": ""},
            1
        ]}, 2, {}]
    })));
    assert_eq!(candidates, HashSet::from(["missing".to_string()]));

    let mut thread = object(json!({
        "turns": [{"items": [
            {"type": "mcpToolCall", "id": "empty", "result": {}},
            {"type": "mcpToolCall", "id": "text", "result": {"content": [{"type": "text", "text": "old"}]}},
            {"type": "mcpToolCall", "id": "image", "result": {"content": [{"type": "image", "url": "old"}]}},
            {"type": "mcpToolCall", "id": "scalar", "result": "bad"}
        ]}]
    }));
    let enrichments = HashMap::from([
        ("empty".into(), vec![json!({"type": "text", "text": "new"})]),
        (
            "text".into(),
            vec![
                json!({"type": "text", "text": "ignored"}),
                json!({"type": "input_image", "image_url": "new"}),
            ],
        ),
        (
            "image".into(),
            vec![json!({"type": "localImage", "path": "/new"})],
        ),
        (
            "scalar".into(),
            vec![json!({"type": "text", "text": "ignored"})],
        ),
    ]);
    apply_rollout_mcp_tool_result_part_enrichments(&mut thread, &enrichments);
    assert_eq!(
        thread["turns"][0]["items"][0]["result"]["content"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        thread["turns"][0]["items"][1]["result"]["content"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        thread["turns"][0]["items"][2]["result"]["content"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(thread["turns"][0]["items"][3]["result"], "bad");
}

#[test]
fn engine_id_normalization_and_routing_cover_recursive_and_precedence_paths() {
    for engine in [
        BridgeRuntimeEngine::Codex,
        BridgeRuntimeEngine::Opencode,
        BridgeRuntimeEngine::Cursor,
    ] {
        assert!(is_known_engine(engine.as_str()));
        assert_eq!(
            encode_engine_qualified_id(engine, " raw "),
            format!("{}:raw", engine.as_str())
        );
    }
    assert!(!is_known_engine("CODEX"));
    assert_eq!(
        encode_engine_qualified_id(BridgeRuntimeEngine::Codex, "opencode:id"),
        "opencode:id"
    );
    assert_eq!(
        encode_engine_qualified_id(BridgeRuntimeEngine::Codex, ""),
        ""
    );
    assert_eq!(decode_engine_qualified_id(" cursor: id "), "id");
    assert_eq!(decode_engine_qualified_id("unknown:id"), "unknown:id");
    assert_eq!(decode_engine_qualified_id("codex: "), "codex:");

    let nested = json!({
        "engine": "cursor",
        "threadId": "codex:t",
        "other": "opencode:keep",
        "nested": [{"parent_thread_id": "cursor:p", "id": "codex:not-special"}],
        "conversation_id": ["codex:a", "opencode:b", 1]
    });
    assert_eq!(
        normalize_forwarded_params(nested),
        json!({
            "threadId": "t",
            "other": "opencode:keep",
            "nested": [{"parent_thread_id": "p", "id": "codex:not-special"}],
            "conversation_id": ["a", "b", 1]
        })
    );
    assert_eq!(strip_bridge_routing_fields(json!(3)), json!(3));
    for key in [
        "threadId",
        "thread_id",
        "conversationId",
        "conversation_id",
        "parentThreadId",
        "parent_thread_id",
    ] {
        assert!(is_engine_id_field(key));
    }
    assert!(!is_engine_id_field("id"));

    let qualified = qualify_engine_ids(
        json!({"threadId": "t", "nested": [{"conversationId": "opencode:already"}], "id": "plain"}),
        BridgeRuntimeEngine::Cursor,
    );
    assert_eq!(qualified["threadId"], "cursor:t");
    assert_eq!(qualified["nested"][0]["conversationId"], "opencode:already");
    assert_eq!(qualified["id"], "plain");

    assert_eq!(
        route_engine_from_params(Some(&json!({"threadId": "opencode:t", "engine": "cursor"}))),
        Some(BridgeRuntimeEngine::Opencode)
    );
    assert_eq!(
        route_engine_from_params(Some(&json!({"thread_id": "plain", "engine": " CURSOR "}))),
        Some(BridgeRuntimeEngine::Cursor)
    );
    assert_eq!(
        route_engine_from_params(Some(&json!({"conversationId": "agent-123"}))),
        Some(BridgeRuntimeEngine::Cursor)
    );
    assert_eq!(
        route_engine_from_params(Some(&json!({"parentThreadId": "plain"}))),
        None
    );
    assert_eq!(route_engine_from_params(Some(&json!([]))), None);
    assert_eq!(route_engine_from_params(None), None);
    assert_eq!(
        parse_engine_qualified_id(" codex: x "),
        Some((BridgeRuntimeEngine::Codex, "x".into()))
    );
    assert_eq!(parse_engine_qualified_id("unknown:x"), None);
    assert_eq!(parse_engine_qualified_id("codex:"), None);
    assert_eq!(
        infer_unqualified_thread_engine(" agent-x "),
        Some(BridgeRuntimeEngine::Cursor)
    );
    assert_eq!(infer_unqualified_thread_engine("x"), None);
}

#[test]
fn app_server_result_normalization_covers_thread_container_shapes_and_errors() {
    let listed = normalize_forwarded_result(
        "thread/list",
        json!({"data": ["one", {"id": "two", "threadId": "child"}, 4], "nextCursor": "next"}),
        BridgeRuntimeEngine::Opencode,
    );
    assert_eq!(listed["data"][0], "opencode:one");
    assert_eq!(listed["data"][1]["id"], "opencode:two");
    assert_eq!(listed["data"][1]["threadId"], "opencode:child");
    assert_eq!(listed["data"][1]["engine"], "opencode");
    assert_eq!(listed["data"][2], 4);
    assert_eq!(
        normalize_thread_list_result(json!([]), BridgeRuntimeEngine::Codex),
        json!([])
    );
    assert_eq!(
        normalize_thread_list_result(json!({"data": 1}), BridgeRuntimeEngine::Codex),
        json!({"data": 1})
    );

    let loaded = normalize_forwarded_result(
        "thread/loaded/list",
        json!({"data": ["a", 2, "cursor:c"]}),
        BridgeRuntimeEngine::Codex,
    );
    assert_eq!(loaded["data"], json!(["codex:a", 2, "cursor:c"]));
    assert_eq!(
        normalize_loaded_thread_ids_result(json!(1), BridgeRuntimeEngine::Codex),
        json!(1)
    );

    for method in ["thread/read", "thread/start", "thread/fork"] {
        let normalized = normalize_forwarded_result(
            method,
            json!({"thread": {"id": "t"}}),
            BridgeRuntimeEngine::Cursor,
        );
        assert_eq!(normalized["thread"]["id"], "cursor:t");
        assert_eq!(normalized["thread"]["engine"], "cursor");
    }
    let direct = normalize_forwarded_notification(
        "thread/updated",
        json!({"id": "t", "turns": []}),
        BridgeRuntimeEngine::Codex,
    );
    assert_eq!(direct["id"], "codex:t");
    assert_eq!(direct["engine"], "codex");
    let other = normalize_forwarded_notification(
        "item/completed",
        json!({"threadId": "t"}),
        BridgeRuntimeEngine::Codex,
    );
    assert_eq!(other["threadId"], "codex:t");

    assert!(is_transient_app_server_thread_read_error(
        "thread/read",
        "Failed to read thread: THREAD-STORE INTERNAL ERROR: rollout abc is empty"
    ));
    assert!(!is_transient_app_server_thread_read_error(
        "thread/list",
        "failed to read thread thread-store internal error rollout is empty"
    ));
    assert!(!is_transient_app_server_thread_read_error(
        "thread/read",
        "rollout is empty"
    ));
    assert!(is_dual_engine_aggregate_method("thread/list"));
    assert!(is_dual_engine_aggregate_method("thread/loaded/list"));
    assert!(!is_dual_engine_aggregate_method("thread/read"));

    assert_eq!(
        normalize_thread_payload_container(json!(1), BridgeRuntimeEngine::Codex),
        json!(1)
    );
    assert_eq!(
        normalize_thread_payload_container(json!({"other": 1}), BridgeRuntimeEngine::Codex),
        json!({"other": 1})
    );
    assert!(looks_like_thread_record(&object(json!({"cwd": "/tmp"}))));
    assert!(!looks_like_thread_record(&object(json!({"other": 1}))));
}

#[test]
fn thread_list_cursor_and_merge_mappings_cover_single_multi_and_invalid_values() {
    assert!(extract_thread_list_entries(&json!({})).is_empty());
    assert_eq!(
        extract_thread_list_entries(&json!({"data": [1]})),
        vec![json!(1)]
    );
    assert_eq!(
        extract_thread_list_cursor(Some(&json!({"cursor": "x"}))).as_deref(),
        Some("x")
    );
    assert_eq!(
        extract_thread_list_cursor(Some(&json!({"cursor": 1}))),
        None
    );
    assert_eq!(
        thread_list_params_with_cursor(Some(&json!({"limit": 2, "cursor": "old"})), Some(" next ")),
        json!({"limit": 2, "cursor": "next"})
    );
    assert_eq!(
        thread_list_params_with_cursor(None, Some(" ")),
        json!({"cursor": null})
    );
    assert_eq!(
        extract_next_cursor(&json!({"nextCursor": "n"})).as_deref(),
        Some("n")
    );
    assert_eq!(
        extract_backwards_cursor(&json!({"backwardsCursor": "b"})).as_deref(),
        Some("b")
    );

    assert_eq!(encode_bridge_thread_list_cursor(&[]), None);
    assert_eq!(
        encode_bridge_thread_list_cursor(&[(BridgeRuntimeEngine::Codex, " ".into())]),
        None
    );
    let encoded = encode_bridge_thread_list_cursor(&[
        (BridgeRuntimeEngine::Codex, " c ".into()),
        (BridgeRuntimeEngine::Opencode, "o".into()),
    ])
    .unwrap();
    let decoded = decode_bridge_thread_list_cursor(&encoded).unwrap();
    assert_eq!(
        decoded.get(&BridgeRuntimeEngine::Codex).map(String::as_str),
        Some("c")
    );
    assert_eq!(
        decoded
            .get(&BridgeRuntimeEngine::Opencode)
            .map(String::as_str),
        Some("o")
    );
    for invalid in ["", "other:abc", "bridge:not-base64", "bridge:e30"] {
        assert_eq!(decode_bridge_thread_list_cursor(invalid), None);
    }
    let partially_valid = format!(
        "bridge:{}",
        general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({"codex": "ok", "bad": "x", "cursor": ""})).unwrap())
    );
    assert_eq!(
        decode_bridge_thread_list_cursor(&partially_valid)
            .unwrap()
            .len(),
        1
    );

    let single = merge_thread_list_results(vec![(
        BridgeRuntimeEngine::Codex,
        json!({"data": [{"id": "b", "updatedAt": 1}, {"id": "a", "updatedAt": 2}], "nextCursor": "n", "backwardsCursor": "b"}),
    )]);
    assert_eq!(single["data"][0]["id"], "codex:a");
    assert_eq!(single["nextCursor"], "n");
    assert_eq!(single["backwardsCursor"], "b");

    let merged = merge_thread_list_results(vec![
        (
            BridgeRuntimeEngine::Codex,
            json!({"data": [{"id": "z", "updatedAt": 3}], "nextCursor": "c"}),
        ),
        (
            BridgeRuntimeEngine::Opencode,
            json!({"data": [{"id": "a", "updatedAt": "3"}], "nextCursor": "o"}),
        ),
    ]);
    assert_eq!(merged["data"][0]["id"], "codex:z");
    assert!(merged["nextCursor"]
        .as_str()
        .unwrap()
        .starts_with("bridge:"));
    assert!(merged["backwardsCursor"].is_null());

    let loaded = merge_loaded_thread_ids_results(vec![
        (BridgeRuntimeEngine::Codex, json!({"data": ["z", "a"]})),
        (BridgeRuntimeEngine::Codex, json!({"data": ["a"]})),
        (BridgeRuntimeEngine::Cursor, json!({"data": ["a", 1]})),
    ]);
    assert_eq!(loaded["data"], json!(["codex:a", "codex:z", "cursor:a"]));
    assert!(extract_loaded_thread_ids(&json!({})).is_empty());
}

#[test]
fn stream_and_small_helper_normalizers_cover_defaults_clamps_and_errors() {
    assert_eq!(
        thread_list_stream_request_params(false, 7)["sourceKinds"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        thread_list_stream_request_params(true, 7)["sourceKinds"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(thread_list_stream_request_params(true, 7)["limit"], 7);
    assert_eq!(
        normalize_thread_list_stream_limits(Some(vec![0, 1, 1, usize::MAX])),
        vec![1, THREAD_LIST_STREAM_MAX_LIMIT]
    );
    assert_eq!(
        normalize_thread_list_stream_limits(Some(vec![])),
        THREAD_LIST_STREAM_DEFAULT_LIMITS
    );
    assert_eq!(
        normalize_thread_list_stream_limits(None),
        THREAD_LIST_STREAM_DEFAULT_LIMITS
    );
    assert_eq!(
        normalize_thread_list_stream_id(Some(" id ".into()), 4),
        "id"
    );
    assert!(normalize_thread_list_stream_id(Some(" ".into()), 4).starts_with("thread-list-4-"));
    assert_eq!(thread_list_stream_key(9, " id "), "9:id");

    assert_eq!(sanitize_client_metadata(None, "fallback", 3), "fallback");
    assert_eq!(
        sanitize_client_metadata(Some(" \nabcde\t "), "fallback", 3),
        "abc"
    );
    assert_eq!(
        sanitize_client_metadata(Some("\n\t"), "fallback", 3),
        "fallback"
    );
    assert_eq!(html_escape("<&>\""), "&lt;&amp;&gt;&quot;");
    assert!(is_unspecified_bind_host("0.0.0.0"));
    assert!(is_unspecified_bind_host("::"));
    assert!(!is_unspecified_bind_host("127.0.0.1"));
    assert_eq!(format_host_for_url("::1"), "[::1]");
    assert_eq!(format_host_for_url("[::1]"), "[::1]");
    assert_eq!(format_host_for_url("localhost"), "localhost");

    let limited = queue_operation_error("resource_limit:items:2:3".into());
    assert_eq!(limited.code, -32602);
    assert_eq!(limited.data.unwrap()["resource"], "items");
    for malformed in ["plain", "resource_limit:x:no:3", "resource_limit:x:1"] {
        let error = queue_operation_error(malformed.into());
        assert_eq!(error.code, -32000);
    }
    assert_eq!(
        normalize_path(Path::new("/a/./b/../c")),
        PathBuf::from("/a/c")
    );
    assert!(!contains_disallowed_control_chars("safe value"));
    for character in [';', '|', '&', '<', '>', '`'] {
        assert!(contains_disallowed_control_chars(&character.to_string()));
    }
}

#[test]
fn opencode_model_helpers_cover_selectors_variants_defaults_and_flattening() {
    for (raw, provider, model) in [(" p/m ", "p", "m"), ("p:m", "p", "m"), ("p|m", "p", "m")] {
        assert_eq!(
            parse_opencode_model_selector(raw),
            Some((provider.into(), model.into()))
        );
    }
    for invalid in ["", "p", "/m", "p/", " / "] {
        assert_eq!(parse_opencode_model_selector(invalid), None);
    }

    assert_eq!(opencode_model_description(&object(json!({}))), None);
    assert_eq!(
        opencode_model_description(&object(json!({"family": "GPT", "status": "active"})))
            .as_deref(),
        Some("GPT")
    );
    assert_eq!(
        opencode_model_description(&object(
            json!({"family": "GPT", "status": "beta", "limit": {"context": 128000}})
        ))
        .as_deref(),
        Some("GPT \u{b7} beta \u{b7} 128000 ctx")
    );
    for (raw, expected) in [
        ("NONE", Some("none")),
        ("minimal", Some("minimal")),
        ("low", Some("low")),
        ("medium", Some("medium")),
        ("high", Some("high")),
        ("max", Some("xhigh")),
        ("xhigh", Some("xhigh")),
        ("other", None),
    ] {
        assert_eq!(normalize_reasoning_effort_name(raw), expected);
    }

    assert_eq!(
        opencode_variant_effort("custom", Some(&object(json!({"reasoningEffort": "low"})))),
        Some("low")
    );
    assert_eq!(opencode_variant_effort("high", None), Some("high"));
    assert_eq!(
        opencode_variant_effort("custom", Some(&object(json!({"thinking": {}})))),
        Some("high")
    );
    assert_eq!(opencode_variant_effort("custom", None), None);
    assert_eq!(
        opencode_variant_description("max", "xhigh", None).as_deref(),
        Some("Max thinking budget")
    );
    assert_eq!(
        opencode_variant_description(
            "custom",
            "high",
            Some(&object(json!({"thinking": {"budgetTokens": 42}})))
        )
        .as_deref(),
        Some("42 thinking tokens")
    );
    assert_eq!(opencode_variant_description("HIGH", "high", None), None);
    assert_eq!(
        opencode_variant_description("custom", "high", None).as_deref(),
        Some("Uses the custom variant")
    );

    let model = object(json!({"variants": {
        "max": {},
        "low": {},
        "duplicate-low": {"reasoningEffort": "low"},
        "think": {"thinking": {"budgetTokens": 10}},
        "invalid": {}
    }}));
    let efforts = opencode_reasoning_effort_options(&model);
    assert_eq!(
        efforts
            .iter()
            .map(|entry| entry["effort"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["low", "high", "xhigh"]
    );
    assert!(opencode_reasoning_effort_options(&object(json!({}))).is_empty());

    let configured = json!({
        "providers": [
            {"id": "z", "name": "Zulu", "models": {"m2": {"name": "Two"}}},
            {"id": "p", "name": "Alpha", "models": {
                "m1": {"name": "One", "family": "fam", "variants": {"LowSpecial": {"reasoningEffort": "low"}, "max": {}}},
                "m0": {"name": "Zero"}
            }},
            {"id": "", "models": {}},
            {"id": "bad"}
        ],
        "default": {"p": "m1", "z": "missing"}
    });
    let catalog = json!({"connected": ["p", 1]});
    assert_eq!(
        opencode_connected_provider_ids(Some(&catalog)),
        HashSet::from(["p".into()])
    );
    assert!(opencode_connected_provider_ids(None).is_empty());
    assert_eq!(
        opencode_default_model_selector(
            &configured,
            Some(&catalog),
            Some(&json!({"model": "z/m2"}))
        ),
        Some(("z".into(), "m2".into()))
    );
    assert_eq!(
        opencode_default_model_selector(&configured, Some(&catalog), None),
        Some(("p".into(), "m1".into()))
    );
    assert_eq!(
        opencode_default_model_selector(&json!({"providers": []}), None, None),
        None
    );

    assert_eq!(
        opencode_variant_for_effort(&configured, "p", "m1", "LOW"),
        Some("LowSpecial".into())
    );
    assert_eq!(
        opencode_variant_for_effort(&configured, "p", "m1", "max"),
        Some("max".into())
    );
    assert_eq!(
        opencode_variant_for_effort(&configured, "p", "m1", "bad"),
        None
    );
    assert_eq!(
        opencode_variant_for_effort(&configured, "missing", "m1", "low"),
        None
    );

    let options = opencode_flatten_model_options(&configured, Some(&catalog), None);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0]["id"], "p/m1");
    assert_eq!(options[0]["isDefault"], true);
    assert_eq!(options[0]["connected"], true);
    assert_eq!(options[1]["id"], "p/m0");
    assert!(opencode_flatten_model_options(&json!([]), None, None).is_empty());
    assert!(opencode_flatten_model_options(&json!({}), None, None).is_empty());
}

#[test]
fn opencode_prompt_tool_and_result_mappings_cover_all_item_kinds() {
    let temp = std::env::temp_dir();
    let image = temp.join("coverage-image.jpg");
    let mention = temp.join("coverage-file.txt");
    let parts = opencode_prompt_parts_from_turn_input(&[
        json!({"type": "text", "text": "hello"}),
        json!({"type": "text", "text": ""}),
        json!({"type": "mention", "path": mention.to_string_lossy()}),
        json!({"type": "localImage", "path": image.to_string_lossy()}),
        json!({"type": "localImage", "path": ""}),
        json!({"type": "unknown"}),
        json!(1),
    ]);
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0], json!({"type": "text", "text": "hello"}));
    assert_eq!(parts[1]["type"], "file");
    assert_eq!(parts[1]["mime"], "text/plain");
    assert_eq!(parts[2]["mime"], "image/jpeg");

    assert_eq!(opencode_permission_kind(Some("file_write")), "fileChange");
    assert_eq!(opencode_permission_kind(Some("PATCH")), "fileChange");
    assert_eq!(opencode_permission_kind(Some("delete-file")), "fileChange");
    assert_eq!(opencode_permission_kind(Some("bash")), "commandExecution");
    assert_eq!(opencode_tool_status_for_item("pending"), "running");
    assert_eq!(opencode_tool_status_for_item("running"), "running");
    assert_eq!(opencode_tool_status_for_item("error"), "failed");
    assert_eq!(opencode_tool_status_for_item("done"), "completed");

    let pending = object(
        json!({"id": "x", "tool": "bash", "state": {"status": "pending", "input": {"cmd": ["git", "status"]}}}),
    );
    let (method, item) = opencode_tool_part_bridge_event(&pending).unwrap();
    assert_eq!(method, "item/started");
    assert_eq!(item["type"], "commandExecution");
    assert_eq!(item["command"], "git status");
    assert_eq!(item["status"], "running");

    let completed = object(
        json!({"id": "x", "tool": "bash", "state": {"status": "completed", "input": {"command": "pwd"}, "output": "out", "exitCode": "2"}}),
    );
    let (method, item) = opencode_tool_part_bridge_event(&completed).unwrap();
    assert_eq!(method, "item/completed");
    assert_eq!(item["aggregatedOutput"], "out");
    assert_eq!(item["exitCode"], 2);

    let mcp = opencode_tool_part_item(
        &object(json!({"tool": "mcp__server__tool", "state": {"output": {"ok": true}, "error": "oops"}})),
        "failed",
    )
    .unwrap();
    assert_eq!(mcp["type"], "mcpToolCall");
    assert_eq!(mcp["server"], "server");
    assert_eq!(mcp["result"], json!({"ok": true}));
    assert_eq!(mcp["error"], "oops");

    let edit = opencode_tool_part_item(
        &object(json!({"id": "e", "tool": "edit", "state": {"error": "bad"}})),
        "failed",
    )
    .unwrap();
    assert_eq!(edit["type"], "fileChange");
    assert_eq!(edit["error"], "bad");
    assert!(opencode_tool_part_item(&object(json!({"state": {}})), "completed").is_none());
    assert!(opencode_tool_part_bridge_event(&object(json!({"tool": "x"}))).is_none());

    let state = object(json!({"output": null, "error": null}));
    let metadata = object(
        json!({"result": {"ok": 1}, "error": "metadata error", "stdout": "stdout", "exit_code": 7}),
    );
    assert_eq!(
        opencode_tool_result_value(&state, Some(&metadata)),
        json!({"ok": 1})
    );
    assert_eq!(
        opencode_tool_error_value(&state, Some(&metadata)),
        "metadata error"
    );
    assert_eq!(
        opencode_tool_output_text(&state, Some(&metadata)).as_deref(),
        Some("stdout")
    );
    assert_eq!(opencode_tool_exit_code(&state, Some(&metadata)), Some(7));
    assert_eq!(
        opencode_tool_result_value(&object(json!({})), None),
        Value::Null
    );
    assert_eq!(
        opencode_tool_error_value(&object(json!({})), None),
        Value::Null
    );
    assert_eq!(opencode_tool_output_text(&object(json!({})), None), None);
}

#[test]
fn opencode_message_mapping_covers_user_assistant_tools_errors_and_active_sessions() {
    assert_eq!(opencode_part_key("s", "p"), "s:p");
    assert!(opencode_status_is_active(Some("busy")));
    assert!(opencode_status_is_active(Some("retry")));
    assert!(!opencode_status_is_active(Some("idle")));
    assert_eq!(
        opencode_agent_for_collaboration_mode(Some(&json!(" PLAN "))),
        Some("plan")
    );
    assert_eq!(
        opencode_agent_for_collaboration_mode(Some(&json!({"mode": "default"}))),
        Some("build")
    );
    assert_eq!(
        opencode_agent_for_collaboration_mode(Some(&json!({"mode": "other"}))),
        None
    );
    assert_eq!(opencode_agent_for_collaboration_mode(None), None);

    let file_url = Url::from_file_path("/tmp/file.txt").unwrap().to_string();
    let image_url = Url::from_file_path("/tmp/image.png").unwrap().to_string();
    let user = object(json!({"parts": [
        {"type": "text", "text": "question"},
        {"type": "file", "url": file_url, "mime": "text/plain"},
        {"type": "file", "url": image_url, "mime": "image/png"},
        {"type": "file", "url": "https://example.com/file", "mime": "text/plain"},
        {"type": "unknown"}, 1
    ]}));
    let user_content = opencode_user_content_items(&user);
    assert_eq!(user_content.len(), 3);
    assert_eq!(user_content[1]["type"], "mention");
    assert_eq!(user_content[2]["type"], "localImage");
    let user_text = opencode_user_message_text(&user).unwrap();
    assert!(user_text.contains("question"));
    assert!(user_text.contains("[file: /tmp/file.txt]"));
    assert!(user_text.contains("[local image: /tmp/image.png]"));
    assert_eq!(opencode_file_url_to_path("https://example.com"), None);
    assert_eq!(
        opencode_user_message_text(&object(json!({"parts": []}))),
        None
    );

    let assistant = object(json!({"parts": [
        {"id": "text", "type": "text", "text": "answer"},
        {"id": "reason", "type": "reasoning", "text": "thought"},
        {"id": "tool", "type": "tool", "tool": "bash", "state": {"status": "completed", "input": {"cmd": "pwd"}}},
        {"type": "text", "text": " "}, {"type": "other"}, 1
    ]}));
    let assistant_items = opencode_assistant_message_items(&assistant);
    assert_eq!(assistant_items.len(), 3);
    assert_eq!(assistant_items[0]["type"], "agentMessage");
    assert_eq!(assistant_items[1]["type"], "reasoning");
    assert_eq!(assistant_items[2]["type"], "commandExecution");
    assert_eq!(
        opencode_assistant_message_text(&assistant).as_deref(),
        Some("answer")
    );
    assert_eq!(
        opencode_assistant_message_text(&object(
            json!({"parts": [{"type": "reasoning", "text": "why"}]})
        ))
        .as_deref(),
        Some("why")
    );
    assert_eq!(
        opencode_assistant_message_text(&object(json!({"parts": []}))),
        None
    );

    let messages = json!([
        {"info": {"id": "u1", "role": "user"}, "parts": [{"type": "text", "text": "question"}]},
        {"info": {"id": "a1", "role": "assistant", "parentID": "u1"}, "parts": assistant["parts"].clone()},
        {"info": {"id": "u2", "role": "user"}, "parts": []},
        {"info": {"id": "a2", "role": "assistant", "parentID": "u2", "error": {"message": "failed"}}, "parts": []},
        {"info": {"id": "orphan", "role": "assistant", "parentID": "missing"}, "parts": []},
        {"info": {"role": "system"}},
        1
    ]);
    assert_eq!(
        opencode_latest_user_message_id(&messages).as_deref(),
        Some("u2")
    );
    assert_eq!(opencode_latest_user_message_id(&json!({})), None);
    let turns = opencode_messages_to_turns("session", &messages, Some("idle"), None);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["status"], "completed");
    assert_eq!(turns[1]["status"], "failed");
    assert_eq!(turns[1]["items"][0]["text"], "failed");

    let active =
        opencode_messages_to_turns("session", &messages, Some("busy"), Some("active-turn"));
    assert_eq!(active.last().unwrap()["status"], "in_progress");
    assert_eq!(active.last().unwrap()["id"], "active-turn");
    assert_eq!(
        opencode_messages_to_turns("session", &json!([]), Some("retry"), None),
        vec![json!({"id": "session", "status": "in_progress", "items": []})]
    );
    assert!(opencode_messages_to_turns("session", &json!({}), None, None).is_empty());
    assert_eq!(
        opencode_thread_preview_from_messages(&messages).as_deref(),
        Some("answer")
    );
    assert_eq!(opencode_thread_preview_from_messages(&json!([])), None);
}

#[test]
fn status_preview_and_turn_helpers_cover_nested_and_fallback_statuses() {
    assert_eq!(to_preview_like(" a\n b\t c "), "a b c");
    let long = "x".repeat(181);
    assert_eq!(to_preview_like(&long).len(), 180);
    assert!(to_preview_like(&long).ends_with("..."));
    assert_eq!(
        normalize_thread_status_label(Some(&json!(" In_Progress-now "))).as_deref(),
        Some("inprogressnow")
    );
    assert_eq!(normalize_thread_status_label(Some(&json!("---"))), None);
    assert_eq!(normalize_thread_status_label(Some(&json!(1))), None);

    let thread = json!({"turns": [
        {"id": "done", "status": "completed"},
        {"id": "active", "status": "in_progress"},
        {"id": "newest", "status": "running"}
    ]});
    assert_eq!(
        read_active_turn_id_from_thread(&thread).as_deref(),
        Some("newest")
    );
    assert!(thread_has_running_turn(&thread));
    for status in [
        json!("queued"),
        json!({"type": "pending"}),
        json!("running"),
    ] {
        assert!(thread_has_running_turn(
            &json!({"status": status, "turns": []})
        ));
    }
    assert!(!thread_has_running_turn(
        &json!({"status": "completed", "turns": []})
    ));
    assert!(!thread_has_running_turn(&json!(1)));

    assert_eq!(
        read_notification_turn_id(&json!({"turnId": " a "})).as_deref(),
        Some("a")
    );
    assert_eq!(
        read_notification_turn_id(&json!({"turn_id": "b"})).as_deref(),
        Some("b")
    );
    assert_eq!(
        read_notification_turn_id(&json!({"turn": {"id": "c"}})).as_deref(),
        Some("c")
    );
    assert_eq!(read_notification_turn_id(&json!({"turnId": " "})), None);
}

#[test]
fn approvals_canonicalize_modern_legacy_and_amendment_decisions() {
    let scalar_cases = [
        ("accept", "accept", "approved"),
        ("approved", "accept", "approved"),
        (
            "acceptForSession",
            "acceptForSession",
            "approved_for_session",
        ),
        (
            "approved_for_session",
            "acceptForSession",
            "approved_for_session",
        ),
        ("decline", "decline", "denied"),
        ("denied", "decline", "denied"),
        ("cancel", "cancel", "abort"),
        ("abort", "cancel", "abort"),
    ];
    for (raw, modern, legacy) in scalar_cases {
        let value = json!(raw);
        assert!(is_valid_approval_decision(&value));
        assert_eq!(
            approval_decision_to_response_value(&value, ApprovalResponseFormat::Modern),
            Some(json!(modern))
        );
        assert_eq!(
            approval_decision_to_response_value(&value, ApprovalResponseFormat::Legacy),
            Some(json!(legacy))
        );
    }

    let modern_amendment =
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["git", "status"]}});
    assert_eq!(
        approval_decision_to_response_value(&modern_amendment, ApprovalResponseFormat::Legacy),
        Some(
            json!({"approved_execpolicy_amendment": {"proposed_execpolicy_amendment": ["git", "status"]}})
        )
    );
    let legacy_amendment = json!({"approved_execpolicy_amendment": {"proposed_execpolicy_amendment": ["npm", "test"]}});
    assert_eq!(
        approval_decision_to_response_value(&legacy_amendment, ApprovalResponseFormat::Modern),
        Some(json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["npm", "test"]}}))
    );
    for invalid in [
        json!("yes"),
        json!(1),
        json!({}),
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": []}}),
        json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": [1]}}),
    ] {
        assert!(!is_valid_approval_decision(&invalid));
        assert_eq!(
            approval_decision_to_response_value(&invalid, ApprovalResponseFormat::Modern),
            None
        );
    }
}

#[test]
fn user_input_and_scalar_parsers_cover_strict_and_permissive_forms() {
    assert_eq!(parse_internal_id(Some(&json!(4))), Some(4));
    assert_eq!(parse_internal_id(Some(&json!("5"))), Some(5));
    assert_eq!(parse_internal_id(Some(&json!(-1))), None);
    assert_eq!(parse_internal_id(Some(&json!(1.5))), None);
    assert_eq!(parse_internal_id(None), None);
    assert_eq!(read_string(Some(&json!("x"))).as_deref(), Some("x"));
    assert_eq!(read_string(Some(&json!(1))), None);
    assert_eq!(read_bool(Some(&json!(true))), Some(true));
    assert_eq!(read_bool(Some(&json!("true"))), None);

    assert_eq!(
        parse_string_array_strict(Some(&json!(["a", "b"]))),
        Some(vec!["a".into(), "b".into()])
    );
    assert_eq!(parse_string_array_strict(Some(&json!([]))), None);
    assert_eq!(parse_string_array_strict(Some(&json!(["a", 1]))), None);
    assert_eq!(parse_string_array_strict(Some(&json!("a"))), None);
    assert_eq!(
        read_shell_command(Some(&json!("git status"))).as_deref(),
        Some("git status")
    );
    assert_eq!(
        read_shell_command(Some(&json!(["git", "status"]))).as_deref(),
        Some("git status")
    );
    assert_eq!(read_shell_command(Some(&json!([]))), None);
    assert_eq!(
        parse_execpolicy_amendment(Some(&json!(["a"]))),
        Some(vec!["a".into()])
    );
    assert_eq!(
        parse_execpolicy_amendment(Some(&json!({"execpolicy_amendment": ["b"]}))),
        Some(vec!["b".into()])
    );
    assert_eq!(parse_execpolicy_amendment(Some(&json!({}))), None);

    let questions = parse_user_input_questions(Some(&json!([
        {"id": "q", "header": "Header", "question": "Question?", "isOther": true, "isSecret": true,
         "options": [{"label": "A", "description": "Desc"}, {"label": "B"}, {"description": "missing"}, 1]},
        {"id": "missing"},
        1
    ])));
    assert_eq!(questions.len(), 1);
    assert!(questions[0].is_other);
    assert!(questions[0].is_secret);
    let options = questions[0].options.as_ref().unwrap();
    assert_eq!(options.len(), 2);
    assert_eq!(options[1].description, "");
    assert!(parse_user_input_questions(None).is_empty());
    assert!(parse_user_input_questions(Some(&json!({}))).is_empty());

    let valid = HashMap::from([(
        "q".into(),
        UserInputAnswerPayload {
            answers: vec!["yes".into()],
        },
    )]);
    assert!(is_valid_user_input_answers(&valid));
    assert!(is_valid_user_input_answers(&HashMap::new()));
    assert!(!is_valid_user_input_answers(&HashMap::from([(
        " ".into(),
        UserInputAnswerPayload {
            answers: vec!["yes".into()]
        }
    )])));
    assert!(!is_valid_user_input_answers(&HashMap::from([(
        "q".into(),
        UserInputAnswerPayload { answers: vec![] }
    )])));
    assert!(!is_valid_user_input_answers(&HashMap::from([(
        "q".into(),
        UserInputAnswerPayload {
            answers: vec![" ".into()]
        }
    )])));

    assert_eq!(
        required_push_id(&json!({"id": " value "}), "id").unwrap(),
        "value"
    );
    assert_eq!(required_push_id(&json!({}), "id").unwrap_err().code, -32602);
    assert_eq!(
        required_push_id(&json!({"id": "x".repeat(PUSH_ID_MAX_BYTES + 1)}), "id")
            .unwrap_err()
            .data
            .unwrap()["error"],
        "resource_limit_exceeded"
    );
}

#[test]
fn ui_surface_validation_covers_valid_blocks_and_all_rejection_families() {
    let valid = ui_surface(json!({
        "id": "surface",
        "threadId": "thread",
        "presentation": "workflowCard",
        "title": "Title",
        "blocks": [
            {"type": "text", "text": "text"},
            {"type": "markdown", "markdown": "md"},
            {"type": "code", "text": "code", "language": "rust"},
            {"type": "checklist", "items": [{"label": "item", "status": "completed"}]},
            {"type": "keyValue", "items": [{"label": "key", "value": "value"}]},
            {"type": "progress", "label": "work", "value": 1.0, "max": 2.0}
        ],
        "actions": [{"id": "ok", "label": "OK", "style": "primary"}]
    }));
    validate_bridge_ui_surface(&valid).unwrap();

    for (field, message) in [
        ("id", "id must not be empty"),
        ("threadId", "threadId must not be empty"),
        ("title", "title must not be empty"),
    ] {
        let mut value = serde_json::to_value(&valid).unwrap();
        value[field] = json!(" ");
        assert_eq!(
            validate_bridge_ui_surface(&ui_surface(value))
                .unwrap_err()
                .message,
            message
        );
    }
    for action in [
        json!({"id": "", "label": "x"}),
        json!({"id": "x", "label": ""}),
    ] {
        let mut value = serde_json::to_value(&valid).unwrap();
        value["actions"] = json!([action]);
        assert_eq!(
            validate_bridge_ui_surface(&ui_surface(value))
                .unwrap_err()
                .code,
            -32602
        );
    }

    let invalid_blocks = [
        json!({"type": "text", "text": ""}),
        json!({"type": "markdown", "markdown": " "}),
        json!({"type": "code", "text": ""}),
        json!({"type": "checklist", "items": []}),
        json!({"type": "checklist", "items": [{"label": ""}]}),
        json!({"type": "keyValue", "items": []}),
        json!({"type": "keyValue", "items": [{"label": "", "value": "v"}]}),
        json!({"type": "keyValue", "items": [{"label": "k", "value": ""}]}),
        json!({"type": "progress", "label": "", "value": 0.0, "max": 1.0}),
        json!({"type": "progress", "label": "p", "value": -1.0, "max": 1.0}),
        json!({"type": "progress", "label": "p", "value": 0.0, "max": 0.0}),
    ];
    for block in invalid_blocks {
        let mut value = serde_json::to_value(&valid).unwrap();
        value["blocks"] = json!([block]);
        assert_eq!(
            validate_bridge_ui_surface(&ui_surface(value))
                .unwrap_err()
                .code,
            -32602
        );
    }

    let long = BridgeUiBlock::Text {
        text: "x".repeat(UI_SURFACE_MAX_TEXT_BYTES + 1),
    };
    assert_eq!(
        validate_bridge_ui_block(&long).unwrap_err().data.unwrap()["resource"],
        "ui_surface_text_bytes"
    );
    let too_many_checklist = BridgeUiBlock::Checklist {
        items: (0..=UI_SURFACE_MAX_ITEMS_PER_BLOCK)
            .map(|_| BridgeUiChecklistItem {
                label: "x".into(),
                status: None,
                detail: None,
            })
            .collect(),
    };
    assert_eq!(
        validate_bridge_ui_block(&too_many_checklist)
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_block_items"
    );
    let too_many_key_values = BridgeUiBlock::KeyValue {
        items: (0..=UI_SURFACE_MAX_ITEMS_PER_BLOCK)
            .map(|_| BridgeUiKeyValueItem {
                label: "x".into(),
                value: "y".into(),
            })
            .collect(),
    };
    assert_eq!(
        validate_bridge_ui_block(&too_many_key_values)
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_block_items"
    );

    let mut too_many_blocks = serde_json::to_value(&valid).unwrap();
    too_many_blocks["blocks"] = json!((0..=UI_SURFACE_MAX_BLOCKS)
        .map(|_| json!({"type": "text", "text": "x"}))
        .collect::<Vec<_>>());
    assert_eq!(
        validate_bridge_ui_surface(&ui_surface(too_many_blocks))
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_blocks"
    );
    let mut too_many_actions = serde_json::to_value(&valid).unwrap();
    too_many_actions["actions"] = json!((0..=UI_SURFACE_MAX_ACTIONS)
        .map(|index| json!({"id": index.to_string(), "label": "x"}))
        .collect::<Vec<_>>());
    assert_eq!(
        validate_bridge_ui_surface(&ui_surface(too_many_actions))
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_actions"
    );

    let mut too_large = serde_json::to_value(&valid).unwrap();
    too_large["bodyMarkdown"] = json!("x".repeat(UI_SURFACE_MAX_BYTES));
    assert_eq!(
        validate_bridge_ui_surface(&ui_surface(too_large))
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_bytes"
    );
}

#[test]
fn chatgpt_auth_token_mapping_rejects_every_malformed_shape() {
    let expected = BridgeChatGptAuthBundle {
        access_token: "access".into(),
        account_id: "account".into(),
        plan_type: Some("plus".into()),
    };
    assert_eq!(
        extract_chatgpt_auth_tokens_from_account_login_start(Some(&json!({
            "type": "chatgptAuthTokens",
            "accessToken": " access ",
            "chatgptAccountId": " account ",
            "chatgptPlanType": " plus "
        }))),
        Some(expected)
    );
    assert_eq!(
        extract_chatgpt_auth_tokens_from_account_login_start(Some(&json!({
            "type": "chatgptAuthTokens",
            "accessToken": "access",
            "chatgptAccountId": "account",
            "chatgptPlanType": " "
        })))
        .unwrap()
        .plan_type,
        None
    );

    for malformed in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"type": 1}),
        json!({"type": "other", "accessToken": "access", "chatgptAccountId": "account"}),
        json!({"type": "chatgptAuthTokens"}),
        json!({"type": "chatgptAuthTokens", "accessToken": 1, "chatgptAccountId": "account"}),
        json!({"type": "chatgptAuthTokens", "accessToken": "access", "chatgptAccountId": 1}),
        json!({"type": "chatgptAuthTokens", "accessToken": " ", "chatgptAccountId": "account"}),
        json!({"type": "chatgptAuthTokens", "accessToken": "access", "chatgptAccountId": " "}),
    ] {
        assert_eq!(
            extract_chatgpt_auth_tokens_from_account_login_start(Some(&malformed)),
            None,
            "accepted {malformed}"
        );
    }
    assert_eq!(
        extract_chatgpt_auth_tokens_from_account_login_start(None),
        None
    );
}

#[test]
fn preview_viewport_parsers_cover_boundaries_defaults_and_malformed_values() {
    for (raw, expected) in [
        (" MOBILE ", Some(PreviewViewportPreset::Mobile)),
        ("Desktop", Some(PreviewViewportPreset::Desktop)),
        ("tablet", None),
        ("", None),
    ] {
        assert_eq!(parse_preview_viewport_preset(raw), expected);
    }
    for (raw, expected) in [
        (" DESKTOP ", Some(PreviewShellMode::Desktop)),
        ("Overview", Some(PreviewShellMode::Overview)),
        ("mobile", None),
        ("", None),
    ] {
        assert_eq!(parse_preview_shell_mode(raw), expected);
    }
    for (raw, expected) in [
        (None, None),
        (Some(""), None),
        (Some("abc"), None),
        (Some("319"), None),
        (Some(" 320 "), Some(320)),
        (Some("4096"), Some(4096)),
        (Some("4097"), None),
        (Some("-1"), None),
    ] {
        assert_eq!(normalize_preview_viewport_dimension(raw), expected);
    }

    assert_eq!(
        build_preview_viewport_config(None, Some(800), Some(600)),
        None
    );
    let mobile =
        build_preview_viewport_config(Some(PreviewViewportPreset::Mobile), Some(800), Some(600))
            .unwrap();
    assert_eq!(mobile.as_cookie_value(), "mobile");
    assert_eq!(mobile.viewport_meta_content(), None);

    let desktop_cases = [
        (None, None, "desktop"),
        (Some(800), None, "desktop:800"),
        (Some(800), Some(600), "desktop:800:600"),
        (None, Some(600), "desktop"),
    ];
    for (width, height, cookie) in desktop_cases {
        let viewport =
            build_preview_viewport_config(Some(PreviewViewportPreset::Desktop), width, height)
                .unwrap();
        assert_eq!(viewport.as_cookie_value(), cookie);
        let meta = viewport.viewport_meta_content().unwrap();
        assert!(meta.contains(&format!(
            "width={}",
            width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH)
        )));
        if let Some(height) =
            height.or_else(|| width.is_none().then_some(DEFAULT_PREVIEW_DESKTOP_HEIGHT))
        {
            assert!(meta.contains(&format!("height={height}")));
        } else {
            assert!(!meta.contains("height="));
        }
    }

    for (raw, expected) in [
        ("mobile", Some("mobile")),
        ("desktop", Some("desktop")),
        ("desktop:320", Some("desktop:320")),
        ("desktop:4096:320", Some("desktop:4096:320")),
        ("", None),
        ("tablet", None),
    ] {
        assert_eq!(
            parse_preview_viewport_cookie(raw).map(PreviewViewportConfig::as_cookie_value),
            expected.map(str::to_string)
        );
    }
}

#[test]
fn preview_bootstrap_and_cookie_parsers_cover_each_query_and_cookie_branch() {
    let cases = [
        ("/", None, None, None, None, false, "/"),
        (
            "/p?sid=s&st=t",
            Some("s"),
            Some("t"),
            None,
            None,
            false,
            "/p",
        ),
        (
            "/p?vp=mobile&vw=100&vh=bad&shell=desktop&frame=1&keep=a%20b",
            None,
            None,
            Some("mobile"),
            Some(PreviewShellMode::Desktop),
            true,
            "/p?vp=mobile&vw=100&vh=bad&shell=desktop&keep=a+b",
        ),
        (
            "/p?vp=desktop&vw=800&vh=600&shell=overview&frame=0",
            None,
            None,
            Some("desktop:800:600"),
            Some(PreviewShellMode::Overview),
            false,
            "/p?vp=desktop&vw=800&vh=600&shell=overview",
        ),
        (
            "/p?vp=invalid&shell=invalid&x=1",
            None,
            None,
            None,
            None,
            false,
            "/p?vp=invalid&shell=invalid&x=1",
        ),
    ];
    for (raw, sid, token, viewport, shell, frame, sanitized) in cases {
        let uri: Uri = raw.parse().unwrap();
        let parsed = parse_preview_bootstrap_params(&uri);
        assert_eq!(parsed.session_id.as_deref(), sid);
        assert_eq!(parsed.bootstrap_token.as_deref(), token);
        assert_eq!(
            parsed
                .viewport
                .map(PreviewViewportConfig::as_cookie_value)
                .as_deref(),
            viewport
        );
        assert_eq!(parsed.shell_mode, shell);
        assert_eq!(parsed.raw_frame, frame);
        assert_eq!(parsed.sanitized_path_and_query, sanitized);
    }

    let mut headers = HeaderMap::new();
    assert_eq!(read_cookie_value(&headers, "wanted"), None);
    headers.insert(
        COOKIE,
        HeaderValue::from_static("flag; wanted= ; other=1; wanted = value=with=equals"),
    );
    assert_eq!(
        read_cookie_value(&headers, "wanted").as_deref(),
        Some("value=with=equals")
    );
    assert_eq!(read_cookie_value(&headers, "missing"), None);
    headers.insert(COOKIE, HeaderValue::from_bytes(&[0xff]).unwrap());
    assert_eq!(read_cookie_value(&headers, "wanted"), None);

    let mut response = Response::new(Body::empty());
    append_preview_bootstrap_headers(&mut response, None, None, false);
    assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 0);
    append_preview_bootstrap_headers(
        &mut response,
        Some("token"),
        build_preview_viewport_config(Some(PreviewViewportPreset::Desktop), None, None),
        true,
    );
    let cookies = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(cookies.len(), 2);
    assert!(cookies[0].contains("; Secure"));
    assert!(cookies[1].contains("=desktop;"));
    assert!(build_preview_cookie_header("bad\nvalue", false).is_err());
}

#[test]
fn preview_frame_html_and_header_rewriters_cover_all_pure_paths() {
    for (input, expected) in [
        ("/", "/?frame=1"),
        ("/p?keep=1", "/p?keep=1&frame=1"),
        (
            "/p?sid=s&st=t&shell=overview&frame=0&keep=1",
            "/p?keep=1&frame=1",
        ),
        (":bad", ":bad?frame=1"),
        (":bad?x=1", ":bad?x=1&frame=1"),
    ] {
        assert_eq!(build_preview_shell_frame_src(input, None, None), expected);
    }
    assert_eq!(
        build_preview_shell_request_key(Some("session"), None).as_deref(),
        Some("session")
    );
    assert_eq!(build_preview_shell_request_key(None, Some("ignored")), None);

    for (document, expected_fragment) in [
        (
            "<html><head data-x='1'>body</head></html>",
            "<head data-x='1'><x>",
        ),
        ("<html></head><body>x</body></html>", "<x></head>"),
        ("<body>x</body>", "<x><body>"),
    ] {
        assert!(inject_preview_head_markup(document, "<x>").contains(expected_fragment));
    }
    assert_eq!(inject_preview_head_markup("<head", "<x>"), "<x><head");

    for document in [
        "<head><meta name=viewport content=old></head>",
        "<head><meta NAME = \"viewport\" content=old></head>",
        "<head><meta name='other'><meta name=viewport></head>",
    ] {
        let rewritten = inject_preview_viewport_meta(document, "width=900");
        assert!(rewritten.contains("content=\"width=900\""));
    }
    let unterminated = inject_preview_viewport_meta("<head><meta name=viewport", "width=900");
    assert!(unterminated.contains("<meta name=\"viewport\" content=\"width=900\">"));

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("TEXT/HTML"));
    headers.insert(CONTENT_ENCODING, HeaderValue::from_static(" "));
    assert!(should_rewrite_preview_html_response(&headers));
    headers.insert(CONTENT_ENCODING, HeaderValue::from_bytes(&[0xff]).unwrap());
    assert!(should_rewrite_preview_html_response(&headers));

    for name in [
        "host",
        "connection",
        "upgrade",
        "content-length",
        "accept-encoding",
        "transfer-encoding",
        "proxy-connection",
    ] {
        assert!(should_skip_preview_request_header(name));
    }
    for name in [
        "host",
        "connection",
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "content-length",
        "transfer-encoding",
        "proxy-connection",
    ] {
        assert!(should_skip_preview_websocket_request_header(name));
    }
    for name in [
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        assert!(should_skip_preview_response_header(name));
    }
    assert!(!should_skip_preview_websocket_request_header("x-app"));
    assert!(!should_skip_preview_response_header("content-type"));
}

#[test]
fn preview_proxy_target_url_cookie_and_upgrade_mappings_cover_malformed_inputs() {
    let session = Url::parse("https://127.0.0.1:3443/base").unwrap();
    let token = encode_preview_proxy_origin_token("http://localhost:3000/path?q=1#fragment");
    let proxied = resolve_preview_request_target(
        &session,
        &format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{token}/nested?q=2"),
    )
    .unwrap();
    assert_eq!(proxied.target_url.as_str(), "http://localhost:3000/path");
    assert_eq!(proxied.path_and_query, "/nested?q=2");
    assert_eq!(
        proxied.proxy_path_prefix.as_deref(),
        Some(format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{token}").as_str())
    );
    let root = resolve_preview_request_target(
        &session,
        &format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{token}"),
    )
    .unwrap();
    assert_eq!(root.path_and_query, "/");
    for malformed in ["!", "_w", &general_purpose::URL_SAFE_NO_PAD.encode([0xff])] {
        assert!(decode_preview_proxy_origin_token(malformed).is_err());
    }

    assert_eq!(
        build_preview_upstream_url(&session, "/next?q=1", false)
            .unwrap()
            .as_str(),
        "https://127.0.0.1:3443/next?q=1"
    );
    assert_eq!(
        build_preview_upstream_url(&session, "/next", true)
            .unwrap()
            .scheme(),
        "wss"
    );
    assert!(build_preview_upstream_url(&session, ":bad", false).is_err());

    let upgrade_headers = |connection: Option<&'static str>, upgrade: Option<&'static str>| {
        let mut headers = HeaderMap::new();
        if let Some(value) = connection {
            headers.insert(CONNECTION, HeaderValue::from_static(value));
        }
        if let Some(value) = upgrade {
            headers.insert(UPGRADE, HeaderValue::from_static(value));
        }
        headers
    };
    assert!(!is_websocket_upgrade_request(
        &Method::POST,
        &upgrade_headers(Some("upgrade"), Some("websocket"))
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        &upgrade_headers(None, Some("websocket"))
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        &upgrade_headers(Some("keep-alive"), Some("websocket"))
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        &upgrade_headers(Some("upgrade"), None)
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        &upgrade_headers(Some("upgrade"), Some("h2c"))
    ));

    assert_eq!(
        filter_preview_cookie_header(&HeaderValue::from_static("flag; app=1; broken")).unwrap(),
        "app=1"
    );
    assert!(filter_preview_cookie_header(&HeaderValue::from_bytes(&[0xff]).unwrap()).is_none());
    assert_eq!(
        rewrite_preview_set_cookie_header(
            &HeaderValue::from_static("a=b; Domain=localhost; ; HttpOnly"),
            Some("/proxy")
        )
        .unwrap(),
        "a=b; HttpOnly; Path=/proxy/"
    );
    assert_eq!(
        rewrite_preview_set_cookie_header(
            &HeaderValue::from_static("a=b; Path=/x; SameSite=Lax"),
            Some("/proxy")
        )
        .unwrap(),
        "a=b; Path=/proxy/x; SameSite=Lax"
    );
    assert!(
        rewrite_preview_set_cookie_header(&HeaderValue::from_bytes(&[0xff]).unwrap(), None)
            .is_none()
    );
}

#[test]
fn preview_request_location_and_vary_rewriters_cover_same_origin_and_invalid_values() {
    let target = Url::parse("http://127.0.0.1:3000/base").unwrap();
    assert_eq!(
        rewrite_preview_request_header("origin", &HeaderValue::from_static("ignored"), &target)
            .unwrap(),
        target_origin_string(&target)
    );
    assert_eq!(
        rewrite_preview_request_header(
            "referer",
            &HeaderValue::from_static("http://preview.test/path?sid=s&keep=1&st=t#f"),
            &target
        )
        .unwrap()
        .to_str()
        .unwrap(),
        "http://127.0.0.1:3000/path?keep=1#f"
    );
    assert!(rewrite_preview_request_header(
        "referer",
        &HeaderValue::from_static("not a url"),
        &target
    )
    .is_none());
    assert_eq!(
        rewrite_preview_request_header("x-app", &HeaderValue::from_static("v"), &target).unwrap(),
        "v"
    );

    assert_eq!(
        rewrite_preview_location_header(
            &HeaderValue::from_static("../next?q=1#f"),
            &Url::parse("http://127.0.0.1:3000/a/b").unwrap(),
            Some("preview.test"),
            Some("/proxy")
        )
        .unwrap(),
        "http://preview.test/proxy/next?q=1#f"
    );
    for different in [
        "https://127.0.0.1:3000/x",
        "http://localhost:3000/x",
        "http://127.0.0.1:3001/x",
    ] {
        let header = HeaderValue::from_str(different).unwrap();
        assert_eq!(
            rewrite_preview_location_header(&header, &target, Some("preview.test"), None).unwrap(),
            header
        );
    }
    assert!(rewrite_preview_location_header(
        &HeaderValue::from_bytes(&[0xff]).unwrap(),
        &target,
        Some("preview.test"),
        None
    )
    .is_none());

    let mut vary = HeaderMap::new();
    vary.insert(VARY, HeaderValue::from_bytes(&[0xff]).unwrap());
    append_vary_header_value(&mut vary, "Cookie");
    assert_eq!(vary[VARY], "Cookie");
}

#[test]
fn engine_and_thread_normalizers_cover_short_circuit_and_malformed_shapes() {
    for (raw, decoded) in [
        ("codex:a:b", "a:b"),
        ("opencode:x", "x"),
        ("cursor:y", "y"),
        ("cursor: ", "cursor:"),
        ("unknown:x", "unknown:x"),
        ("plain", "plain"),
    ] {
        assert_eq!(decode_engine_qualified_id(raw), decoded);
    }
    for (raw, encoded) in [
        ("codex:a", "codex:a"),
        ("opencode:a", "opencode:a"),
        ("cursor:a", "cursor:a"),
        ("cursor: ", "codex:cursor:"),
        ("unknown:a", "codex:unknown:a"),
    ] {
        assert_eq!(
            encode_engine_qualified_id(BridgeRuntimeEngine::Codex, raw),
            encoded
        );
    }

    assert_eq!(
        normalize_forwarded_ids(json!(["codex:a", {"threadId": "codex:b"}])),
        json!(["codex:a", {"threadId": "b"}])
    );
    assert_eq!(
        qualify_engine_ids(json!(["a", {"threadId": "b"}]), BridgeRuntimeEngine::Cursor),
        json!(["a", {"threadId": "cursor:b"}])
    );
    assert_eq!(
        normalize_forwarded_notification("item/x", json!(1), BridgeRuntimeEngine::Codex),
        json!(1)
    );
    assert_eq!(
        normalize_forwarded_result(
            "other",
            json!({"threadId": "t"}),
            BridgeRuntimeEngine::Opencode
        )["threadId"],
        "opencode:t"
    );

    for message in [
        "thread-store internal error rollout is empty",
        "failed to read thread rollout is empty",
        "failed to read thread thread-store internal error is empty",
        "failed to read thread thread-store internal error rollout",
    ] {
        assert!(!is_transient_app_server_thread_read_error(
            "thread/read",
            message
        ));
    }

    assert_eq!(
        normalize_thread_list_result(json!({"data": [null]}), BridgeRuntimeEngine::Codex)["data"],
        json!([null])
    );
    assert_eq!(
        normalize_loaded_thread_ids_result(
            json!({"data": [null, "x"]}),
            BridgeRuntimeEngine::Cursor
        )["data"],
        json!([null, "cursor:x"])
    );
    assert_eq!(
        normalize_thread_record(json!(1), BridgeRuntimeEngine::Codex),
        json!(1)
    );
    for key in ["id", "turns", "updatedAt", "createdAt", "cwd"] {
        assert!(looks_like_thread_record(&object(json!({key: null}))));
    }
    assert!(extract_loaded_thread_ids(&json!({"data": [1, "a", null]})) == vec!["a"]);
    assert_eq!(
        merge_thread_list_results(vec![]),
        json!({"data": [], "nextCursor": null, "backwardsCursor": null})
    );
}

#[test]
fn rollout_image_detection_and_result_parsing_cover_recursive_keys_and_file_noise() {
    for key in [
        "content",
        "contents",
        "items",
        "item",
        "result",
        "results",
        "output",
        "data",
        "structuredContent",
        "structured_content",
        "_meta",
        "meta",
    ] {
        assert!(rollout_value_contains_image(
            Some(&json!({key: {"type": "image", "url": "x"}})),
            0
        ));
    }
    for image in [
        json!({"type": "image", "image_url": "x"}),
        json!({"type": "image", "imageUrl": "x"}),
        json!({"type": "image", "url": "x"}),
        json!({"type": "localImage", "path": "x"}),
        json!({"type": "input_image", "data": "x", "mime_type": "image/png"}),
    ] {
        assert!(rollout_value_contains_image(Some(&image), 0));
    }
    for malformed in [
        json!(1),
        json!({"type": "image"}),
        json!({"type": "image", "url": " "}),
        json!({"type": "text", "url": "x"}),
        json!({"unknown": {"type": "image", "url": "x"}}),
    ] {
        assert!(!rollout_value_contains_image(Some(&malformed), 0));
    }

    assert_eq!(
        rollout_mcp_tool_result_parts(&json!({"content": []})),
        Some(vec![])
    );
    assert_eq!(rollout_mcp_tool_result_parts(&json!({"content": 1})), None);
    assert_eq!(
        rollout_image_data_url(&object(json!({"data": "x", "mimeType": "image/png"}))).as_deref(),
        Some("data:image/png;base64,x")
    );
    assert_eq!(
        rollout_image_data_url(&object(json!({"data": 1, "mimeType": "image/png"}))),
        None
    );

    let path = std::env::temp_dir().join(format!("clawdex-rollout-map-{}.jsonl", Uuid::new_v4()));
    let records = [
        "not json".to_string(),
        json!(1).to_string(),
        json!({"type": "other"}).to_string(),
        json!({"type": "event_msg", "payload": 1}).to_string(),
        json!({"type": "event_msg", "payload": {"type": "other"}}).to_string(),
        json!({"type": "event_msg", "payload": {"type": "mcp_tool_call_end", "call_id": "other", "result": {"Ok": {"content": []}}}}).to_string(),
        json!({"type": "event_msg", "payload": {"type": "mcp_tool_call_end", "call_id": "wanted", "result": {"Ok": {"content": [{"type": "text", "text": "ok"}]}}}}).to_string(),
    ];
    std::fs::write(&path, records.join("\n")).unwrap();
    let parsed = read_rollout_mcp_tool_result_parts_by_call_id(
        &path,
        &HashSet::from(["wanted".to_string()]),
    );
    assert_eq!(
        parsed["wanted"],
        vec![json!({"type": "text", "text": "ok"})]
    );
    std::fs::remove_file(path).unwrap();
    assert!(read_rollout_mcp_tool_result_parts_by_call_id(
        Path::new("/definitely/missing"),
        &HashSet::from(["wanted".to_string()])
    )
    .is_empty());
}

#[test]
fn opencode_model_tool_and_message_mappings_cover_remaining_fallbacks() {
    for permission in [None, Some("bash"), Some("read")] {
        assert_eq!(opencode_permission_kind(permission), "commandExecution");
    }
    for permission in ["write", "EDIT", "apply_patch", "delete-file"] {
        assert_eq!(opencode_permission_kind(Some(permission)), "fileChange");
    }
    assert_eq!(
        opencode_variant_effort(
            "medium",
            Some(&object(json!({"reasoningEffort": "invalid"})))
        ),
        Some("medium")
    );
    assert_eq!(
        opencode_variant_effort(
            "custom",
            Some(&object(
                json!({"reasoningEffort": "invalid", "thinking": null})
            ))
        ),
        Some("high")
    );

    let providers = json!({
        "providers": [
            1,
            {"id": "", "models": {}},
            {"id": "disconnected", "models": {"m": {}}},
            {"id": "connected", "models": {"z": null, "b": {}, "a": {}}, "name": ""},
            {"id": "missing-models"}
        ],
        "default": {"connected": "missing"}
    });
    let catalog = json!({"connected": ["connected"]});
    assert_eq!(
        opencode_default_model_selector(&providers, Some(&catalog), None),
        Some(("connected".into(), "a".into()))
    );
    let options = opencode_flatten_model_options(&providers, Some(&catalog), None);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0]["providerName"], "");
    assert_eq!(options[0]["displayName"], "a");
    assert!(opencode_flatten_model_options(&json!({"providers": 1}), None, None).is_empty());

    assert_eq!(
        opencode_tool_input_command(&object(json!({"cmd": 1, "command": ["git", "status"]})))
            .as_deref(),
        Some("git status")
    );
    assert_eq!(opencode_tool_input_command(&object(json!({}))), None);
    assert_eq!(
        opencode_tool_part_bridge_event(&object(json!({
            "tool": "bash",
            "state": {"status": "error", "error": "failed"}
        })))
        .unwrap()
        .0,
        "item/completed"
    );
    for part in [
        json!({}),
        json!({"state": {}}),
        json!({"state": {"status": 1}}),
    ] {
        assert!(opencode_tool_part_bridge_event(&object(part)).is_none());
    }

    let state = object(json!({"output": "state", "error": "state-error", "exitCode": "4"}));
    let metadata = object(
        json!({"output": "metadata", "stdout": "out", "stderr": "err", "exitCode": 5, "exit_code": 6}),
    );
    assert_eq!(opencode_tool_result_value(&state, Some(&metadata)), "state");
    assert_eq!(
        opencode_tool_error_value(&state, Some(&metadata)),
        "state-error"
    );
    assert_eq!(
        opencode_tool_output_text(&state, Some(&metadata)).as_deref(),
        Some("state")
    );
    assert_eq!(opencode_tool_exit_code(&state, Some(&metadata)), Some(4));
    assert_eq!(
        opencode_tool_output_text(&object(json!({})), Some(&object(json!({"stderr": "err"}))))
            .as_deref(),
        Some("err")
    );
    assert_eq!(opencode_tool_exit_code(&object(json!({})), None), None);

    assert!(opencode_assistant_message_items(&object(json!({}))).is_empty());
    assert!(opencode_user_content_items(&object(json!({}))).is_empty());
    let messages = json!([
        1,
        {},
        {"info": {}},
        {"info": {"role": "assistant"}},
        {"info": {"role": "assistant", "parentID": "missing"}},
        {"info": {"role": "user", "id": "u"}, "parts": []},
        {"info": {"role": "assistant", "parentID": "u"}, "parts": [{"type": "tool", "tool": "bash", "state": {}}]}
    ]);
    let turns = opencode_messages_to_turns("s", &messages, None, None);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["status"], "completed");
}

#[test]
fn scalar_status_question_and_ui_parsers_cover_remaining_condition_sides() {
    assert_eq!(
        sanitize_client_metadata(Some("abc"), "fallback", 0),
        "fallback"
    );
    assert_eq!(format_goal_status("___---"), "Active");
    assert_eq!(format_duration_seconds(3600), "1h 0m");
    assert_eq!(format_duration_seconds(60), "1m 0s");
    assert_eq!(parse_internal_id(Some(&json!(0))), Some(0));
    assert_eq!(parse_internal_id(Some(&json!(u64::MAX))), Some(u64::MAX));
    assert_eq!(parse_internal_id(Some(&json!("-1"))), None);
    assert_eq!(parse_internal_id(Some(&json!(true))), None);
    assert_eq!(read_shell_command(Some(&json!(1))), None);
    assert_eq!(parse_execpolicy_amendment(None), None);

    let malformed = json!([
        1,
        {},
        {"id": "id"},
        {"id": "id", "header": "header"},
        {"id": "id", "header": "header", "question": 1},
        {"id": "ok", "header": "header", "question": "question", "isOther": "true", "options": 1}
    ]);
    let questions = parse_user_input_questions(Some(&malformed));
    assert_eq!(questions.len(), 1);
    assert!(!questions[0].is_other);
    assert!(!questions[0].is_secret);
    assert!(questions[0].options.is_none());

    assert_eq!(read_active_turn_id_from_thread(&json!({"turns": []})), None);
    assert_eq!(
        read_active_turn_id_from_thread(&json!({"turns": [{"status": "running"}]})),
        None
    );
    assert_eq!(
        read_active_turn_id_from_thread(&json!({"turns": [{"id": "x", "status": "done"}]})),
        None
    );
    assert!(!thread_has_running_turn(
        &json!({"status": {"type": "idle"}, "turns": []})
    ));
    assert_eq!(read_notification_turn_id(&json!({})), None);

    for (value, max) in [
        (f64::NAN, 1.0),
        (f64::INFINITY, 1.0),
        (0.0, f64::NAN),
        (0.0, f64::INFINITY),
        (0.0, -1.0),
    ] {
        let block = BridgeUiBlock::Progress {
            label: "progress".into(),
            value,
            max,
            detail: None,
        };
        assert_eq!(validate_bridge_ui_block(&block).unwrap_err().code, -32602);
    }
    validate_bridge_ui_block(&BridgeUiBlock::Progress {
        label: "progress".into(),
        value: 2.0,
        max: 1.0,
        detail: None,
    })
    .unwrap();
}

#[tokio::test]
async fn rollout_tracking_covers_meta_state_polling_dedup_and_missing_files() {
    let root = std::env::temp_dir().join(format!("clawdex-rollout-tracking-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();

    let missing = root.join("missing.jsonl");
    assert_eq!(read_rollout_session_meta(&missing).await.unwrap(), None);
    for (name, contents) in [
        ("empty", ""),
        ("invalid", "not json\n"),
        ("scalar", "1\n"),
        ("wrong-type", r#"{"type":"event_msg","payload":{}}"#),
        ("scalar-payload", r#"{"type":"session_meta","payload":1}"#),
        ("missing-id", r#"{"type":"session_meta","payload":{}}"#),
    ] {
        let path = root.join(format!("rollout-{name}.jsonl"));
        tokio::fs::write(&path, contents).await.unwrap();
        assert_eq!(
            read_rollout_session_meta(&path).await.unwrap(),
            None,
            "{name}"
        );
    }

    let path = root.join("rollout-active.jsonl");
    tokio::fs::write(
        &path,
        concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"initial\",\"originator\":\"codex_cli_rs\"}}\n"
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        read_rollout_session_meta(&path).await.unwrap(),
        Some(("initial".to_string(), Some("codex_cli_rs".to_string())))
    );

    let mut tracked = RolloutTrackedFile::new(path.clone()).await.unwrap();
    assert!(tracked.include_for_live_sync);
    assert_eq!(tracked.thread_id.as_deref(), Some("initial"));
    assert!(tracked.remember_line_hash(1));
    assert!(!tracked.remember_line_hash(1));
    tracked.recent_line_hashes = (1..=ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY as u64).collect();
    tracked.recent_line_hash_set = tracked.recent_line_hashes.iter().copied().collect();
    assert!(tracked.remember_line_hash(ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY as u64 + 1));
    assert!(!tracked.recent_line_hash_set.contains(&1));

    for malformed in [
        "not json",
        "1",
        r#"{}"#,
        r#"{"type":1}"#,
        r#"{"type":"event_msg"}"#,
        r#"{"type":"event_msg","payload":1}"#,
    ] {
        assert!(tracked.to_notification(malformed).is_none(), "{malformed}");
    }
    tracked.include_for_live_sync = false;
    assert!(tracked
        .to_notification(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#)
        .is_none());
    assert!(tracked
        .to_notification(
            r#"{"type":"session_meta","payload":{"id":"blocked","originator":"other"}}"#
        )
        .is_none());
    assert!(!tracked.include_for_live_sync);
    assert!(tracked
        .to_notification(
            r#"{"type":"session_meta","payload":{"threadId":"live","originator":"clawdex"}}"#
        )
        .is_none());
    assert!(tracked.include_for_live_sync);
    assert_eq!(tracked.thread_id.as_deref(), Some("live"));
    assert!(tracked
        .to_notification(r#"{"type":"unknown","payload":{}}"#)
        .is_none());
    assert_eq!(
        tracked
            .to_notification(
                r#"{"type":"event_msg","timestamp":"stamp","payload":{"type":"token_count","thread_id":"updated"}}"#
            )
            .unwrap()
            .0,
        "codex/event/token_count"
    );
    assert_eq!(tracked.thread_id.as_deref(), Some("updated"));
    assert_eq!(
        tracked
            .to_notification(
                r#"{"type":"response_item","payload":{"type":"function_call","name":"mcp__server__tool","arguments":{}}}"#
            )
            .unwrap()
            .0,
        "codex/event/mcp_tool_call_begin"
    );

    let hub = Arc::new(ClientHub::new());
    let metrics = Arc::new(OperationalMetrics::new());
    let mut notifications = hub.subscribe_notifications();
    let duplicate = r#"{"type":"event_msg","payload":{"type":"task_started","thread_id":"poll"}}"#;
    let partial = r#"{"type":"event_msg","payload":{"type":"token_count","thread_id":"poll"}}"#;
    tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .unwrap()
        .write_all(format!("\n{duplicate}\n{duplicate}\n{partial}").as_bytes())
        .await
        .unwrap();
    tracked.poll(&hub, &metrics).await.unwrap();
    assert_eq!(tracked.partial_line, partial);
    tokio::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .unwrap()
        .write_all(b"\n")
        .await
        .unwrap();
    tracked.poll(&hub, &metrics).await.unwrap();
    tracked.poll(&hub, &metrics).await.unwrap();
    assert!(notifications.try_recv().is_ok());
    let snapshot = metrics.live_sync_snapshot();
    assert!(snapshot.emitted_events >= 2);
    assert!(snapshot.deduplicated_lines >= 1);

    tokio::fs::write(&path, b"\n").await.unwrap();
    tracked.poll(&hub, &metrics).await.unwrap();
    assert_eq!(tracked.offset, 1);
    tokio::fs::remove_file(&path).await.unwrap();
    assert_eq!(
        tracked.poll(&hub, &metrics).await.unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );

    let tail_path = root.join("rollout-tail.jsonl");
    let mut tail_contents = concat!(
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"tail\",\"originator\":\"codex\"}}\n"
    )
    .to_string();
    tail_contents.push_str(&"x".repeat(ROLLOUT_LIVE_SYNC_INITIAL_TAIL_BYTES as usize + 1));
    tokio::fs::write(&tail_path, tail_contents).await.unwrap();
    let mut tail = RolloutTrackedFile::new(tail_path.clone()).await.unwrap();
    assert!(tail.drop_first_partial_line);
    tail.poll(&hub, &metrics).await.unwrap();
    assert!(tail.drop_first_partial_line);
    tokio::fs::OpenOptions::new()
        .append(true)
        .open(&tail_path)
        .await
        .unwrap()
        .write_all(b"\n\n")
        .await
        .unwrap();
    tail.poll(&hub, &metrics).await.unwrap();
    assert!(!tail.drop_first_partial_line);

    let mut state = RolloutLiveSyncState::default();
    state.files.insert(missing.clone(), tracked);
    rollout_live_sync_poll_files(&hub, &mut state, &metrics)
        .await
        .unwrap();
    assert!(state.files.is_empty());

    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn rollout_discovery_covers_new_existing_and_retention_conditions() {
    let root = std::env::temp_dir().join(format!("clawdex-rollout-discovery-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let discovered = root.join("rollout-found.jsonl");
    tokio::fs::write(
        &discovered,
        r#"{"type":"session_meta","payload":{"id":"found"}}"#,
    )
    .await
    .unwrap();

    let mut state = RolloutLiveSyncState::default();
    rollout_live_sync_discover_files(&root, &mut state)
        .await
        .unwrap();
    assert!(state.files.contains_key(&discovered));
    rollout_live_sync_discover_files(&root, &mut state)
        .await
        .unwrap();
    assert_eq!(state.files.len(), 1);

    let retained = root.join("removed-but-recent.jsonl");
    state.files.insert(
        retained.clone(),
        RolloutTrackedFile {
            path: retained.clone(),
            offset: 0,
            partial_line: String::new(),
            drop_first_partial_line: false,
            thread_id: None,
            originator: None,
            include_for_live_sync: false,
            last_seen: Instant::now(),
            recent_line_hashes: VecDeque::new(),
            recent_line_hash_set: HashSet::new(),
        },
    );
    rollout_live_sync_discover_files(&root, &mut state)
        .await
        .unwrap();
    assert!(state.files.contains_key(&retained));
    state.files.get_mut(&retained).unwrap().last_seen =
        Instant::now() - ROLLOUT_LIVE_SYNC_MAX_FILE_AGE - Duration::from_secs(1);
    rollout_live_sync_discover_files(&root, &mut state)
        .await
        .unwrap();
    assert!(!state.files.contains_key(&retained));

    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[test]
fn preview_remaining_pure_branches_cover_exact_malformed_and_valid_cases() {
    for malformed in [
        "desktop:320:320:320",
        "desktop:bad",
        "desktop:320:bad",
        "desktop::bad",
        "mobile:bad",
    ] {
        assert_eq!(
            parse_preview_viewport_cookie(malformed),
            None,
            "{malformed}"
        );
    }
    assert_eq!(
        parse_preview_viewport_cookie("desktop::320")
            .unwrap()
            .as_cookie_value(),
        "desktop"
    );

    let mut viewport_headers = HeaderMap::new();
    assert_eq!(read_preview_viewport_preset(&viewport_headers), None);
    viewport_headers.insert(
        COOKIE,
        HeaderValue::from_static("clawdex_preview_vp=desktop:800:600"),
    );
    assert_eq!(
        read_preview_viewport_preset(&viewport_headers)
            .unwrap()
            .as_cookie_value(),
        "desktop:800:600"
    );

    for headers in [
        HeaderMap::new(),
        HeaderMap::from_iter([(CONTENT_TYPE, HeaderValue::from_static("application/json"))]),
        HeaderMap::from_iter([
            (
                CONTENT_TYPE,
                HeaderValue::from_static("application/xhtml+xml"),
            ),
            (CONTENT_ENCODING, HeaderValue::from_static("gzip")),
        ]),
    ] {
        assert!(!should_rewrite_preview_html_response(&headers));
    }
    let identity = HeaderMap::from_iter([
        (
            CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        ),
        (CONTENT_ENCODING, HeaderValue::from_static("identity")),
    ]);
    assert!(should_rewrite_preview_html_response(&identity));

    assert_eq!(
        rewrite_preview_html_document(&vec![b'x'; PREVIEW_BUFFERED_RESPONSE_MAX_BYTES + 1], None),
        None
    );
    assert_eq!(rewrite_preview_html_document(&[0xff], None), None);
    let unchanged_viewport = String::from_utf8(
        rewrite_preview_html_document(b"<html><head></head></html>", None).unwrap(),
    )
    .unwrap();
    assert!(unchanged_viewport.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH));
    let mobile_viewport = String::from_utf8(
        rewrite_preview_html_document(
            b"<html><head></head></html>",
            build_preview_viewport_config(Some(PreviewViewportPreset::Mobile), None, None),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!mobile_viewport.contains("name=\"viewport\""));
    let existing_script =
        format!("<script src=\"{BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH}\"></script>");
    assert_eq!(
        inject_preview_runtime_script(&existing_script),
        existing_script
    );

    let target = Url::parse("http://127.0.0.1:3000/base").unwrap();
    assert_eq!(
        resolve_preview_request_target(&target, "/plain?q=1")
            .unwrap()
            .proxy_path_prefix,
        None
    );
    assert!(
        resolve_preview_request_target(&target, &format!("{BROWSER_PREVIEW_PROXY_PREFIX}/"))
            .is_err()
    );
    assert!(resolve_preview_request_target(&target, ":bad").is_err());
    assert_eq!(
        build_preview_upstream_url(&target, "/socket", true)
            .unwrap()
            .scheme(),
        "ws"
    );

    let mut valid_upgrade = HeaderMap::new();
    valid_upgrade.insert(CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
    valid_upgrade.insert(UPGRADE, HeaderValue::from_static("WebSocket"));
    assert!(is_websocket_upgrade_request(&Method::GET, &valid_upgrade));
    valid_upgrade.insert(CONNECTION, HeaderValue::from_bytes(&[0xff]).unwrap());
    assert!(!is_websocket_upgrade_request(&Method::GET, &valid_upgrade));

    assert!(filter_preview_cookie_header(&HeaderValue::from_static(
        "clawdex_preview=a; clawdex_preview_vp=mobile; flag"
    ))
    .is_none());
    assert_eq!(
        rewrite_preview_request_header(
            "referer",
            &HeaderValue::from_static("http://preview.test/path?sid=s&st=t"),
            &target,
        )
        .unwrap(),
        "http://127.0.0.1:3000/path"
    );
    assert!(rewrite_preview_request_header(
        "referer",
        &HeaderValue::from_bytes(&[0xff]).unwrap(),
        &target,
    )
    .is_none());
    assert_eq!(
        rewrite_preview_location_header(&HeaderValue::from_static("/next"), &target, None, None,),
        None
    );
    assert!(
        rewrite_preview_set_cookie_header(&HeaderValue::from_static(" ; HttpOnly"), None).is_none()
    );
    assert_eq!(
        rewrite_preview_set_cookie_header(
            &HeaderValue::from_static("a=b; Path=relative"),
            Some("/proxy"),
        )
        .unwrap(),
        "a=b; Path=/proxy/relative"
    );
    assert_eq!(
        rewrite_preview_set_cookie_header(&HeaderValue::from_static("a=b"), None).unwrap(),
        "a=b"
    );

    let mut vary = HeaderMap::new();
    append_vary_header_value(&mut vary, " ");
    assert!(vary.get(VARY).is_none());
    vary.insert(VARY, HeaderValue::from_static("Accept-Encoding, Cookie"));
    append_vary_header_value(&mut vary, "cookie");
    assert_eq!(vary[VARY], "Accept-Encoding, Cookie");
    append_vary_header_value(&mut vary, "Origin");
    assert_eq!(vary[VARY], "Accept-Encoding, Cookie, Origin");
    assert_eq!(
        target_origin_string(&Url::parse("https://example.com/path").unwrap()),
        "https://example.com"
    );
}
