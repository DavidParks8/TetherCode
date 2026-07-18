use crate::*;

#[derive(Debug)]
pub(super) struct BridgeError {
    pub(super) code: i64,
    pub(super) message: String,
    pub(super) data: Option<Value>,
}

impl BridgeError {
    pub(super) fn method_not_found(message: &str) -> Self {
        Self {
            code: -32601,
            message: message.to_string(),
            data: None,
        }
    }

    pub(super) fn invalid_params(message: &str) -> Self {
        Self {
            code: -32602,
            message: message.to_string(),
            data: None,
        }
    }

    pub(super) fn resource_limit(resource: &str, limit: usize, actual: usize) -> Self {
        Self {
            code: -32602,
            message: format!("{resource} exceeds limit of {limit}"),
            data: Some(json!({
                "error": "resource_limit_exceeded",
                "resource": resource,
                "limit": limit,
                "actual": actual,
            })),
        }
    }

    pub(super) fn server(message: &str) -> Self {
        Self {
            code: -32000,
            message: message.to_string(),
            data: None,
        }
    }

    pub(super) fn forbidden(error: &str, message: &str) -> Self {
        Self {
            code: -32003,
            message: message.to_string(),
            data: Some(json!({ "error": error })),
        }
    }
}

pub(super) fn queue_operation_error(error: String) -> BridgeError {
    let mut parts = error.split(':');
    if parts.next() == Some("resource_limit") {
        if let (Some(resource), Some(limit), Some(actual)) =
            (parts.next(), parts.next(), parts.next())
        {
            if let (Ok(limit), Ok(actual)) = (limit.parse::<usize>(), actual.parse::<usize>()) {
                return BridgeError::resource_limit(resource, limit, actual);
            }
        }
    }
    BridgeError::server(&error)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalExecRequest {
    pub(super) command: String,
    pub(super) cwd: Option<String>,
    pub(super) timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalExecResponse {
    pub(super) command: String,
    pub(super) cwd: String,
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) timed_out: bool,
    pub(super) duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeUpdateStartRequest {
    pub(super) version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GitStatusResponse {
    pub(super) branch: String,
    pub(super) clean: bool,
    pub(super) raw: String,
    pub(super) files: Vec<GitStatusEntry>,
    pub(super) cwd: String,
    pub(super) truncated: bool,
    pub(super) total_files: usize,
    pub(super) omitted_files: usize,
    pub(super) max_files: usize,
    pub(super) max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitStatusEntry {
    pub(super) path: String,
    pub(super) original_path: Option<String>,
    pub(super) index_status: String,
    pub(super) worktree_status: String,
    pub(super) staged: bool,
    pub(super) unstaged: bool,
    pub(super) untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GitDiffResponse {
    pub(super) diff: String,
    pub(super) cwd: String,
    pub(super) truncated: bool,
    pub(super) original_bytes: usize,
    pub(super) returned_bytes: usize,
    pub(super) max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHistoryCommit {
    pub(super) hash: String,
    pub(super) short_hash: String,
    pub(super) subject: String,
    pub(super) author_name: String,
    pub(super) authored_at: String,
    pub(super) ref_names: Vec<String>,
    pub(super) is_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GitHistoryResponse {
    pub(super) commits: Vec<GitHistoryCommit>,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitBranchSummary {
    pub(super) name: String,
    pub(super) remote: bool,
    pub(super) current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitBranchesResponse {
    pub(super) branches: Vec<GitBranchSummary>,
    pub(super) current: Option<String>,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCloneResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) cloned: bool,
    pub(super) cwd: String,
    pub(super) url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitStageResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) staged: bool,
    pub(super) path: String,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitStageAllResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) staged: bool,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitUnstageResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) unstaged: bool,
    pub(super) path: String,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitUnstageAllResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) unstaged: bool,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GitCommitResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) committed: bool,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitSwitchResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) switched: bool,
    pub(super) branch: String,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GitPushResponse {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) pushed: bool,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitQueryRequest {
    pub(super) cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubAuthInstallRequest {
    pub(super) access_token: Option<String>,
    pub(super) repositories: Option<Vec<String>>,
    pub(super) grants: Option<Vec<GitHubAuthGrantInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubAuthGrantInput {
    pub(super) access_token: String,
    pub(super) repositories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubAuthInstallResponse {
    pub(super) installed: bool,
    pub(super) host: String,
    pub(super) login: Option<String>,
    pub(super) scopes: Vec<String>,
    pub(super) credential_file: String,
    pub(super) grants_installed: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHistoryRequest {
    pub(super) cwd: Option<String>,
    pub(super) limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCloneRequest {
    pub(super) url: String,
    pub(super) parent_path: Option<String>,
    pub(super) directory_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitFileRequest {
    pub(super) path: String,
    pub(super) cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EventReplayRequest {
    pub(super) after_event_id: Option<u64>,
    pub(super) limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadListStreamStartRequest {
    pub(super) stream_id: Option<String>,
    pub(super) include_sub_agents: Option<bool>,
    pub(super) limits: Option<Vec<usize>>,
    pub(super) delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadListStreamCancelRequest {
    pub(super) stream_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCommitRequest {
    pub(super) message: String,
    pub(super) cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitSwitchRequest {
    pub(super) branch: String,
    pub(super) cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceListRequest {
    pub(super) limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceSummary {
    pub(super) path: String,
    pub(super) chat_count: usize,
    pub(super) updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceListResponse {
    pub(super) bridge_root: String,
    pub(super) allow_outside_root_cwd: bool,
    pub(super) workspaces: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSystemListRequest {
    pub(super) path: Option<String>,
    pub(super) include_hidden: Option<bool>,
    pub(super) directories_only: Option<bool>,
    pub(super) include_git_repo: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSystemEntry {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) kind: String,
    pub(super) hidden: bool,
    pub(super) selectable: bool,
    pub(super) is_git_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSystemListResponse {
    pub(super) bridge_root: String,
    pub(super) path: String,
    pub(super) parent_path: Option<String>,
    pub(super) entries: Vec<FileSystemEntry>,
    pub(super) truncated: bool,
    pub(super) total_entries: usize,
    pub(super) omitted_entries: usize,
    pub(super) max_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingApproval {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) item_id: String,
    pub(super) requested_at: String,
    pub(super) reason: Option<String>,
    pub(super) command: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) grant_root: Option<String>,
    pub(super) proposed_execpolicy_amendment: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveApprovalRequest {
    pub(super) id: String,
    pub(super) decision: Value,
    pub(super) resolution_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserInputAnswerPayload {
    pub(super) answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveUserInputRequest {
    pub(super) id: String,
    pub(super) answers: HashMap<String, UserInputAnswerPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingUserInputRequest {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) item_id: String,
    pub(super) requested_at: String,
    pub(super) questions: Vec<PendingUserInputQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingUserInputQuestion {
    pub(super) id: String,
    pub(super) header: String,
    pub(super) question: String,
    pub(super) is_other: bool,
    pub(super) is_secret: bool,
    pub(super) options: Option<Vec<PendingUserInputQuestionOption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingUserInputQuestionOption {
    pub(super) label: String,
    pub(super) description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeUiSurface {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: Option<String>,
    pub(super) kind: Option<String>,
    pub(super) presentation: BridgeUiPresentation,
    pub(super) tone: Option<BridgeUiTone>,
    pub(super) title: String,
    pub(super) subtitle: Option<String>,
    pub(super) body_markdown: Option<String>,
    #[serde(default)]
    pub(super) blocks: Vec<BridgeUiBlock>,
    #[serde(default)]
    pub(super) actions: Vec<BridgeUiAction>,
    pub(super) dismissible: Option<bool>,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BridgeUiPresentation {
    WorkflowCard,
    Modal,
    Banner,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BridgeUiTone {
    Neutral,
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum BridgeUiBlock {
    Text {
        text: String,
    },
    Markdown {
        markdown: String,
    },
    Checklist {
        items: Vec<BridgeUiChecklistItem>,
    },
    KeyValue {
        items: Vec<BridgeUiKeyValueItem>,
    },
    Code {
        text: String,
        language: Option<String>,
    },
    Progress {
        label: String,
        value: f64,
        max: f64,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeUiChecklistItem {
    pub(super) label: String,
    pub(super) status: Option<BridgeUiChecklistStatus>,
    pub(super) detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BridgeUiChecklistStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeUiKeyValueItem {
    pub(super) label: String,
    pub(super) value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeUiAction {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) style: Option<BridgeUiActionStyle>,
    pub(super) dismisses_surface: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum BridgeUiActionStyle {
    Primary,
    Secondary,
    Destructive,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveBridgeUiSurfaceRequest {
    pub(super) id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: Option<String>,
    pub(super) action_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DismissBridgeUiSurfaceRequest {
    pub(super) id: String,
    pub(super) thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadCreateRequest {
    pub(super) submission_id: String,
    pub(super) thread_start: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadCreateResponse {
    pub(super) submission_id: String,
    pub(super) thread: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueReadRequest {
    pub(super) thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueSendRequest {
    pub(super) thread_id: String,
    pub(super) submission_id: String,
    pub(super) content: String,
    pub(super) turn_start: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueSteerRequest {
    pub(super) thread_id: String,
    pub(super) item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueCancelRequest {
    pub(super) thread_id: String,
    pub(super) item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeQueuedMessage {
    pub(super) id: String,
    pub(super) created_at: String,
    pub(super) content: String,
}

#[derive(Debug, Clone)]
pub(super) struct BridgeQueuedMessageEntry {
    pub(super) id: String,
    pub(super) created_at: String,
    pub(super) content: String,
    pub(super) turn_start: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueError {
    pub(super) message: String,
    pub(super) operation: String,
    pub(super) at: String,
    pub(super) item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueState {
    pub(super) thread_id: String,
    pub(super) items: Vec<BridgeQueuedMessage>,
    pub(super) last_error: Option<BridgeThreadQueueError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum BridgeThreadQueueDisposition {
    Queued,
    Sent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueSendResponse {
    pub(super) submission_id: String,
    pub(super) disposition: BridgeThreadQueueDisposition,
    pub(super) queue: BridgeThreadQueueState,
    pub(super) turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeThreadQueueActionResponse {
    pub(super) ok: bool,
    pub(super) queue: BridgeThreadQueueState,
}

#[derive(Debug, Default)]
pub(super) struct BridgeThreadQueueRuntime {
    pub(super) items: VecDeque<BridgeQueuedMessageEntry>,
    pub(super) active_turn_id: Option<String>,
    pub(super) thread_running: bool,
    pub(super) turn_start_in_flight: bool,
    pub(super) action_in_flight_item_id: Option<String>,
    pub(super) pending_approval_ids: HashSet<String>,
    pub(super) pending_user_input_ids: HashSet<String>,
    pub(super) pending_completion_event_ids: Vec<u64>,
    pub(super) last_error: Option<BridgeThreadQueueError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum QueueCompletionDisposition {
    Final,
    Continued,
}

pub(super) struct BridgeQueueService {
    pub(super) backend: Arc<RuntimeBackend>,
    pub(super) hub: Arc<ClientHub>,
    pub(super) threads: Arc<RwLock<HashMap<String, BridgeThreadQueueRuntime>>>,
    pub(super) thread_actors: Arc<RwLock<HashMap<String, Arc<Mutex<()>>>>>,
    pub(super) completion_dispositions: Arc<Mutex<HashMap<u64, QueueCompletionDisposition>>>,
    pub(super) completion_disposition_notify: Arc<Notify>,
    pub(super) submission_results: Arc<Mutex<HashMap<String, BridgeThreadQueueSendResponse>>>,
    pub(super) submission_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) next_queue_item_id: AtomicU64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RpcQuery {
    pub(super) token: Option<String>,
    pub(super) client_type: Option<String>,
    pub(super) client_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct LocalImageQuery {
    pub(super) path: String,
    pub(super) token: Option<String>,
}
