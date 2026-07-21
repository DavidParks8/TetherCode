use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

use reqwest::Url;

use crate::resource_limits::{
    truncate_utf8_bytes, GIT_DIFF_MAX_BYTES, GIT_STATUS_MAX_BYTES, GIT_STATUS_MAX_FILES,
};
use crate::{
    normalize_path, path_policy::PathPolicy, BridgeError, GitBranchSummary, GitBranchesResponse,
    GitCloneResponse, GitCommitResponse, GitDiffResponse, GitHistoryCommit, GitHistoryResponse,
    GitPushResponse, GitStageAllResponse, GitStageResponse, GitStatusEntry, GitStatusResponse,
    GitSwitchResponse, GitUnstageAllResponse, GitUnstageResponse,
};

use super::TerminalService;

#[derive(Clone)]
pub(crate) struct GitService {
    terminal: Arc<TerminalService>,
    path_policy: Arc<PathPolicy>,
    global_config_paths: Arc<Vec<PathBuf>>,
    inspect_standard_config: bool,
}

impl GitService {
    pub(crate) fn new(terminal: Arc<TerminalService>, path_policy: Arc<PathPolicy>) -> Self {
        Self {
            terminal,
            path_policy,
            global_config_paths: Arc::new(global_git_config_paths()),
            inspect_standard_config: true,
        }
    }

    #[cfg(test)]
    fn with_global_config_paths(mut self, paths: Vec<PathBuf>) -> Self {
        self.global_config_paths = Arc::new(paths);
        self.inspect_standard_config = false;
        self
    }

    fn resolve_repo_path(&self, raw_cwd: Option<&str>) -> Result<PathBuf, BridgeError> {
        self.path_policy.resolve_cwd(raw_cwd)
    }

    async fn resolve_and_validate_git_path(
        &self,
        raw_cwd: Option<&str>,
        require_repository: bool,
    ) -> Result<PathBuf, BridgeError> {
        let repo_path = self.resolve_repo_path(raw_cwd)?;
        self.validate_repository_helpers(&repo_path).await?;
        if require_repository {
            self.run_git_stdout(
                &repo_path,
                &["rev-parse", "--git-dir"],
                "git repository configuration inspection failed",
            )
            .await?;
        }
        Ok(repo_path)
    }

    pub(crate) async fn get_status(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStatusResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "status".to_string(),
            "--short".to_string(),
            "--branch".to_string(),
            "-uall".to_string(),
        ];
        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(&git_failure_message(
                &result.stderr,
                &result.stdout,
                "git status failed",
            )));
        }

        let lines = result
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();

        let porcelain_entries = self.get_porcelain_status_entries(&repo_path).await?;

        let branch = lines
            .iter()
            .find_map(|line| parse_status_branch(line))
            .unwrap_or_else(|| "unknown".to_string());

        let clean = porcelain_entries.is_empty();
        let total_files = porcelain_entries.len();
        let mut files = porcelain_entries;
        let mut used_bytes = 0usize;
        let mut returned_files = Vec::new();
        for entry in files.drain(..).take(GIT_STATUS_MAX_FILES) {
            let entry_bytes = serde_json::to_vec(&entry)
                .expect("GitStatusEntry serialization must succeed")
                .len();
            if used_bytes.saturating_add(entry_bytes) > GIT_STATUS_MAX_BYTES {
                break;
            }
            used_bytes += entry_bytes;
            returned_files.push(entry);
        }
        let (raw, raw_truncated) = truncate_utf8_bytes(&result.stdout, GIT_STATUS_MAX_BYTES);
        let truncated = raw_truncated || returned_files.len() < total_files;
        let returned_file_count = returned_files.len();

        Ok(GitStatusResponse {
            branch,
            clean,
            raw,
            files: returned_files,
            cwd: repo_path.to_string_lossy().to_string(),
            truncated,
            total_files,
            omitted_files: total_files.saturating_sub(returned_file_count),
            max_files: GIT_STATUS_MAX_FILES,
            max_bytes: GIT_STATUS_MAX_BYTES,
        })
    }

    pub(crate) async fn get_diff(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitDiffResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let entries = self.get_porcelain_status_entries(&repo_path).await?;
        let total_entries = entries.len();
        let mut sections = Vec::new();
        let mut stopped_early = false;

        for (entry_index, entry) in entries.into_iter().enumerate() {
            if entry.untracked {
                let untracked_patch = self
                    .run_git_diff_command(
                        &repo_path,
                        &[
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            "--no-index",
                            "--",
                            "/dev/null",
                            entry.path.as_str(),
                        ],
                        true,
                        "git diff for untracked file failed",
                    )
                    .await?;
                if !untracked_patch.trim().is_empty() {
                    sections.push(untracked_patch);
                }
                if sections.iter().map(String::len).sum::<usize>() >= GIT_DIFF_MAX_BYTES {
                    stopped_early = entry_index + 1 < total_entries;
                    break;
                }
                continue;
            }

            let tracked_patch = self
                .run_git_diff_command(
                    &repo_path,
                    &[
                        "diff",
                        "--no-color",
                        "--no-ext-diff",
                        "--patch",
                        "HEAD",
                        "--",
                        entry.path.as_str(),
                    ],
                    false,
                    "git diff HEAD for file failed",
                )
                .await;
            match tracked_patch {
                Ok(output) => {
                    if !output.trim().is_empty() {
                        sections.push(output);
                    }
                }
                Err(_) => {
                    // Repositories without HEAD (e.g. first commit) need per-file fallback.
                    let staged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &[
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "--patch",
                                "--cached",
                                "--",
                                entry.path.as_str(),
                            ],
                            false,
                            "git diff --cached for file failed",
                        )
                        .await?;
                    if !staged_patch.trim().is_empty() {
                        sections.push(staged_patch);
                    }

                    let unstaged_patch = self
                        .run_git_diff_command(
                            &repo_path,
                            &[
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "--patch",
                                "--",
                                entry.path.as_str(),
                            ],
                            false,
                            "git diff for file failed",
                        )
                        .await?;
                    if !unstaged_patch.trim().is_empty() {
                        sections.push(unstaged_patch);
                    }
                }
            }
            if sections.iter().map(String::len).sum::<usize>() >= GIT_DIFF_MAX_BYTES {
                stopped_early = entry_index + 1 < total_entries;
                break;
            }
        }

        let diff_output = sections
            .into_iter()
            .filter(|section| !section.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        let measured_bytes = diff_output.len();
        let (diff, text_truncated) = truncate_utf8_bytes(&diff_output, GIT_DIFF_MAX_BYTES);
        let truncated = text_truncated || stopped_early;
        let original_bytes = if stopped_early {
            measured_bytes.max(GIT_DIFF_MAX_BYTES + 1)
        } else {
            measured_bytes
        };
        let returned_bytes = diff.len();
        Ok(GitDiffResponse {
            diff,
            cwd: repo_path.to_string_lossy().to_string(),
            truncated,
            original_bytes,
            returned_bytes,
            max_bytes: GIT_DIFF_MAX_BYTES,
        })
    }

    pub(crate) async fn get_history(
        &self,
        raw_cwd: Option<&str>,
        limit: Option<usize>,
    ) -> Result<GitHistoryResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let history_limit = limit.unwrap_or(12).clamp(1, 30);
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "log".to_string(),
            "--first-parent".to_string(),
            "--decorate=short".to_string(),
            "--date=iso-strict".to_string(),
            format!("--max-count={history_limit}"),
            "--pretty=format:%H\x1f%h\x1f%an\x1f%aI\x1f%D\x1f%s\x1e".to_string(),
            "HEAD".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(&git_failure_message(
                &result.stderr,
                &result.stdout,
                "git log failed",
            )));
        }

        Ok(GitHistoryResponse {
            commits: parse_git_history(&result.stdout),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn get_branches(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitBranchesResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        self.get_branches_at_path(&repo_path).await
    }

    async fn get_branches_at_path(
        &self,
        repo_path: &Path,
    ) -> Result<GitBranchesResponse, BridgeError> {
        let output = self
            .run_git_stdout(
                repo_path,
                &[
                    "branch",
                    "--all",
                    "--format=%(HEAD)\x1f%(refname)\x1f%(refname:short)",
                ],
                "git branch failed",
            )
            .await?;
        let branches = parse_git_branches(&output);
        let current = branches
            .iter()
            .find(|branch| branch.current)
            .map(|branch| branch.name.clone());

        Ok(GitBranchesResponse {
            branches,
            current,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn switch_branch(
        &self,
        branch: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitSwitchResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let target = normalize_git_branch_target(&branch)?;
        let known_branches = self.get_branches_at_path(&repo_path).await?.branches;
        let switch_target = resolve_switch_target(&target, &known_branches);
        let mut args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "switch".to_string(),
        ];
        if switch_target.track_remote {
            args.push("--track".to_string());
        }
        args.push(switch_target.name);

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitSwitchResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            switched: result.code == Some(0),
            branch: target,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn clone_repo(
        &self,
        repository_url: &str,
        raw_parent_path: Option<&str>,
        directory_name: &str,
    ) -> Result<GitCloneResponse, BridgeError> {
        let parent_path = self
            .resolve_and_validate_git_path(raw_parent_path, false)
            .await?;
        self.validate_credentialed_transport(&parent_path).await?;
        let repository_url = validate_remote_url(repository_url)?;
        let normalized_directory_name = resolve_clone_directory_name(directory_name)?;
        let destination_path = normalize_path(&parent_path.join(&normalized_directory_name));
        if destination_path.exists() {
            return Err(BridgeError::invalid_params(
                "destination path already exists",
            ));
        }

        let args = vec![
            "clone".to_string(),
            "--".to_string(),
            repository_url.clone(),
            normalized_directory_name,
        ];

        let result = self
            .terminal
            .execute_git(&args, parent_path.clone(), None)
            .await?;

        Ok(GitCloneResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            cloned: result.code == Some(0),
            cwd: destination_path.to_string_lossy().to_string(),
            url: repository_url,
        })
    }

    pub(crate) async fn stage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitStageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn stage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitStageAllResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "add".to_string(),
            "-A".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitStageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            staged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_file(
        &self,
        path: &str,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let relative_path = resolve_repo_relative_path(path, &repo_path)?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            relative_path.clone(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            path: relative_path,
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn unstage_all(
        &self,
        raw_cwd: Option<&str>,
    ) -> Result<GitUnstageAllResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "reset".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            ".".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitUnstageAllResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            unstaged: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn commit(
        &self,
        message: String,
        raw_cwd: Option<&str>,
    ) -> Result<GitCommitResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "commit".to_string(),
            "-m".to_string(),
            message,
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitCommitResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            committed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn push(&self, raw_cwd: Option<&str>) -> Result<GitPushResponse, BridgeError> {
        let repo_path = self.resolve_and_validate_git_path(raw_cwd, true).await?;
        self.validate_credentialed_transport(&repo_path).await?;
        self.validate_repository_remotes(&repo_path).await?;
        let status_output = self
            .run_git_stdout(
                &repo_path,
                &["status", "--short", "--branch", "--untracked-files=no"],
                "git status failed",
            )
            .await?;
        let has_upstream = parse_status_has_upstream(&status_output);

        let mut args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "push".to_string(),
        ];
        if !has_upstream {
            let Some(remote_name) = self.resolve_default_remote_name(&repo_path).await? else {
                return Ok(GitPushResponse {
                    code: Some(1),
                    stdout: String::new(),
                    stderr: "No git remote configured for publishing this branch.".to_string(),
                    pushed: false,
                    cwd: repo_path.to_string_lossy().to_string(),
                });
            };
            validate_remote_name(&remote_name)?;
            args.push("--set-upstream".to_string());
            args.push("--".to_string());
            args.push(remote_name);
            args.push("HEAD".to_string());
        }

        let result = self
            .terminal
            .execute_git(&args, repo_path.clone(), None)
            .await?;

        Ok(GitPushResponse {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            pushed: result.code == Some(0),
            cwd: repo_path.to_string_lossy().to_string(),
        })
    }

    async fn get_porcelain_status_entries(
        &self,
        repo_path: &Path,
    ) -> Result<Vec<GitStatusEntry>, BridgeError> {
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "--branch".to_string(),
            "-uall".to_string(),
            "-z".to_string(),
        ];

        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(&git_failure_message(
                &result.stderr,
                &result.stdout,
                "git status --porcelain failed",
            )));
        }

        parse_porcelain_status_entries(&result.stdout)
    }

    async fn run_git_diff_command(
        &self,
        repo_path: &Path,
        command: &[&str],
        allow_exit_code_one: bool,
        fallback_message: &str,
    ) -> Result<String, BridgeError> {
        let mut args = vec!["-C".to_string(), repo_path.to_string_lossy().to_string()];
        args.extend(command.iter().map(|segment| (*segment).to_string()));

        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;

        let code = result.code.unwrap_or(-1);
        let is_allowed = code == 0 || (allow_exit_code_one && code == 1);
        if !is_allowed {
            return Err(BridgeError::server(&git_failure_message(
                &result.stderr,
                &result.stdout,
                fallback_message,
            )));
        }

        Ok(result.stdout)
    }

    async fn run_git_stdout(
        &self,
        repo_path: &Path,
        command: &[&str],
        fallback_message: &str,
    ) -> Result<String, BridgeError> {
        let mut args = vec!["-C".to_string(), repo_path.to_string_lossy().to_string()];
        args.extend(command.iter().map(|segment| (*segment).to_string()));

        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;

        if result.code != Some(0) {
            return Err(BridgeError::server(&git_failure_message(
                &result.stderr,
                &result.stdout,
                fallback_message,
            )));
        }

        Ok(result.stdout)
    }

    async fn resolve_default_remote_name(
        &self,
        repo_path: &Path,
    ) -> Result<Option<String>, BridgeError> {
        let output = self
            .run_git_stdout(repo_path, &["remote"], "git remote failed")
            .await?;
        Ok(select_default_remote_name(&output))
    }

    async fn validate_repository_remotes(&self, repo_path: &Path) -> Result<(), BridgeError> {
        let remote_names = self
            .run_git_stdout(repo_path, &["remote"], "git remote inspection failed")
            .await?;
        for name in remote_names
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            validate_remote_name(name)?;
            let remotes = self
                .run_git_stdout(
                    repo_path,
                    &["remote", "get-url", "--all", "--push", name],
                    "git remote inspection failed",
                )
                .await?;
            for remote in remotes
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                validate_remote_url(remote)?;
            }
        }

        Ok(())
    }

    async fn validate_repository_helpers(&self, repo_path: &Path) -> Result<(), BridgeError> {
        self.validate_repository_config_source(repo_path, &[])
            .await?;
        if !self.inspect_standard_config {
            for global_config in self.global_config_paths.iter() {
                if global_config.is_file() {
                    self.validate_repository_config_source(
                        repo_path,
                        &[
                            "--file".to_string(),
                            global_config.to_string_lossy().to_string(),
                        ],
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    async fn validate_repository_config_source(
        &self,
        repo_path: &Path,
        source_args: &[String],
    ) -> Result<(), BridgeError> {
        let args = [
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "config".to_string(),
        ]
        .into_iter()
        .chain(source_args.iter().cloned())
        .chain([
            "--includes".to_string(),
            "--show-origin".to_string(),
            "--show-scope".to_string(),
            "--null".to_string(),
            "--list".to_string(),
        ])
        .collect::<Vec<_>>();
        let result = self
            .terminal
            .inspect_git_config(&args, repo_path.to_path_buf(), self.inspect_standard_config)
            .await?;
        match result.code {
            Some(0) => validate_effective_git_config(&result.stdout),
            _ => Err(BridgeError::server(
                "git repository configuration inspection failed",
            )),
        }
    }

    async fn validate_credentialed_transport(&self, repo_path: &Path) -> Result<(), BridgeError> {
        validate_credential_environment()?;
        for global_config in self.global_config_paths.iter() {
            if global_config.is_file() {
                let source_args = vec![
                    "--file".to_string(),
                    global_config.to_string_lossy().to_string(),
                ];
                self.validate_transport_config_source(repo_path, &source_args)
                    .await?;
            }
        }
        self.validate_transport_config_source(repo_path, &[]).await
    }

    async fn validate_transport_config_source(
        &self,
        repo_path: &Path,
        source_args: &[String],
    ) -> Result<(), BridgeError> {
        let args = vec![
            "-C".to_string(),
            repo_path.to_string_lossy().to_string(),
            "config".to_string(),
        ];
        let args = args
            .into_iter()
            .chain(source_args.iter().cloned())
            .chain([
            "--includes".to_string(),
            "--show-origin".to_string(),
            "--null".to_string(),
            "--get-regexp".to_string(),
            r"^(http\..*|https\..*|remote\..*\.proxy|core\.gitproxy|credential\..*helper|url\..*\.insteadof)$".to_string(),
            ])
            .collect::<Vec<_>>();
        let result = self
            .terminal
            .execute_git(&args, repo_path.to_path_buf(), None)
            .await?;
        match result.code {
            Some(0) => validate_transport_config_output(&result.stdout),
            Some(1) => Ok(()),
            _ => Err(BridgeError::server(
                "git transport configuration inspection failed",
            )),
        }
    }
}

fn global_git_config_paths() -> Vec<PathBuf> {
    global_git_config_paths_from(
        std::env::var_os("HOME"),
        std::env::var_os("XDG_CONFIG_HOME"),
    )
}

fn global_git_config_paths_from(home: Option<OsString>, xdg: Option<OsString>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home.map(PathBuf::from) {
        paths.push(home.join(".gitconfig"));
        if xdg.is_none() {
            paths.push(home.join(".config/git/config"));
        }
    }
    if let Some(xdg) = xdg.map(PathBuf::from) {
        paths.push(xdg.join("git/config"));
    }
    paths
}

const UNSAFE_GIT_ENVIRONMENT: &[&str] = &[
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_VALUE_0",
    "GIT_HTTP_PROXY_AUTHMETHOD",
    "GIT_PROXY_COMMAND",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_SSL_CERT",
    "GIT_SSL_CIPHER_LIST",
    "GIT_SSL_KEY",
    "GIT_SSL_NO_VERIFY",
    "CURL_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
];

fn validate_credential_environment() -> Result<(), BridgeError> {
    validate_credential_environment_with(|name| std::env::var_os(name).is_some())
}

fn validate_credential_environment_with(is_set: impl Fn(&str) -> bool) -> Result<(), BridgeError> {
    if UNSAFE_GIT_ENVIRONMENT.iter().any(|name| is_set(name)) {
        return Err(BridgeError::forbidden(
            "unsafe_git_environment",
            "Credentialed Git operations do not permit process-level proxy or TLS overrides.",
        ));
    }
    Ok(())
}

fn validate_transport_config_output(raw: &str) -> Result<(), BridgeError> {
    let mut fields = raw.split('\0').filter(|entry| !entry.is_empty());
    while let Some(origin) = fields.next() {
        let setting = fields.next().ok_or_else(|| {
            BridgeError::server("git transport configuration output was malformed")
        })?;
        if origin.trim() == "command line:" {
            continue;
        }
        let (key, value) = setting
            .split_once('\n')
            .or_else(|| setting.split_once(' '))
            .unwrap_or((setting, ""));
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        let allowed = key == "http.sslverify" && value.eq_ignore_ascii_case("true");
        if !allowed {
            return Err(BridgeError::forbidden(
                "unsafe_git_configuration",
                "Credentialed Git operations reject proxy, TLS, credential-helper, and URL-rewrite overrides.",
            ));
        }
    }
    Ok(())
}

fn validate_effective_git_config(raw: &str) -> Result<(), BridgeError> {
    let fields = raw.split('\0').collect::<Vec<_>>();
    let records = fields.strip_suffix(&[""]).unwrap_or(&fields);
    if records.len() % 3 != 0 {
        return Err(BridgeError::server(
            "git repository configuration output was malformed",
        ));
    }

    for record in records.chunks_exact(3) {
        let origin = record[1].trim();
        let (key, value) = record[2].split_once('\n').ok_or_else(|| {
            BridgeError::server("git repository configuration output was malformed")
        })?;
        if origin == "command line:" {
            continue;
        }

        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        let executable = key == "core.hookspath"
            || key == "core.fsmonitor"
            || key == "core.sshcommand"
            || key == "core.editor"
            || key == "sequence.editor"
            || (key.starts_with("credential.") && key.ends_with("helper"))
            || (key.starts_with("filter.")
                && [".clean", ".smudge", ".process"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix)))
            || (key.starts_with("diff.")
                && [".command", ".textconv"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix)))
            || (key.starts_with("merge.") && key.ends_with(".driver"))
            || (key.starts_with("alias.") && value.starts_with('!'));
        let unsafe_transport = (key.starts_with("http.")
            && !(key == "http.sslverify" && value.eq_ignore_ascii_case("true")))
            || key.starts_with("https.")
            || key == "core.gitproxy"
            || key.starts_with("protocol.")
            || (key.starts_with("remote.") && (key.ends_with(".proxy") || key.ends_with(".vcs")))
            || (key.starts_with("url.") && key.ends_with(".insteadof"));
        let unsafe_include = (key == "include.path" || key.starts_with("includeif."))
            && !included_config_was_inspected(origin, value, records);
        if executable || unsafe_transport || unsafe_include {
            return Err(BridgeError::forbidden(
                "unsafe_git_configuration",
                "Git configuration contains executable helpers, unsafe includes, or transport overrides.",
            ));
        }
    }
    Ok(())
}

fn included_config_was_inspected(origin: &str, value: &str, records: &[&str]) -> bool {
    let Some(origin_path) = origin.strip_prefix("file:") else {
        return false;
    };
    let include_path = Path::new(value);
    let resolved = if include_path.is_absolute() {
        include_path.to_path_buf()
    } else {
        Path::new(origin_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(include_path)
    };
    let Ok(canonical) = resolved.canonicalize() else {
        return false;
    };
    records.chunks_exact(3).any(|record| {
        record[1]
            .strip_prefix("file:")
            .and_then(|path| Path::new(path).canonicalize().ok())
            .is_some_and(|inspected| inspected == canonical)
    })
}

fn validate_remote_url(raw: &str) -> Result<String, BridgeError> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|_| BridgeError::invalid_params("Git remotes must use an explicit HTTPS URL"))?;
    if parsed.scheme() != "https"
        || parsed.host_str().map(str::is_empty).unwrap_or(true)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(BridgeError::forbidden(
            "unsafe_git_remote",
            "Git remotes must use HTTPS without embedded credentials or fragments.",
        ));
    }
    Ok(trimmed.to_string())
}

fn git_failure_message(stderr: &str, stdout: &str, fallback: &str) -> String {
    if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        fallback.to_string()
    }
}

fn validate_remote_name(raw: &str) -> Result<(), BridgeError> {
    if raw.is_empty()
        || raw.starts_with('-')
        || !raw
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-' | '/'))
    {
        return Err(BridgeError::forbidden(
            "unsafe_git_remote",
            "Git remote names must not contain option or control syntax.",
        ));
    }
    Ok(())
}

fn parse_porcelain_status_entries(raw: &str) -> Result<Vec<GitStatusEntry>, BridgeError> {
    let tokens = raw
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0usize;
    let mut entries = Vec::new();

    while index < tokens.len() {
        let token = tokens[index];
        index += 1;

        if token.starts_with("## ") {
            continue;
        }

        let mut chars = token.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');
        let path = token.chars().skip(3).collect::<String>();
        if path.is_empty() {
            continue;
        }

        let mut original_path = None;
        if matches!(index_status, 'R' | 'C') && index < tokens.len() {
            let original = tokens[index].to_string();
            index += 1;
            original_path = Some(original);
        }

        let untracked = index_status == '?' && worktree_status == '?';
        let staged = !matches!(index_status, ' ' | '?');
        let unstaged = untracked || worktree_status != ' ';

        entries.push(GitStatusEntry {
            path,
            original_path,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            staged,
            unstaged,
            untracked,
        });
    }

    Ok(entries)
}

fn parse_status_has_upstream(raw: &str) -> bool {
    raw.lines()
        .map(str::trim)
        .find(|line| line.starts_with("## "))
        .map(|line| line.contains("..."))
        .unwrap_or(false)
}

fn parse_status_branch(line: &str) -> Option<String> {
    let status = line.strip_prefix("## ")?;
    let branch = status
        .strip_prefix("No commits yet on ")
        .or_else(|| status.strip_prefix("Initial commit on "))
        .unwrap_or(status)
        .split("...")
        .next()
        .expect("split always yields a first segment")
        .trim();
    (!branch.is_empty()).then(|| branch.to_string())
}

fn parse_git_history(raw: &str) -> Vec<GitHistoryCommit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let trimmed = record.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split('\x1f');
            let hash = parts.next()?.trim().to_string();
            let short_hash = parts.next().unwrap_or_default().trim().to_string();
            let author_name = parts.next().unwrap_or_default().trim().to_string();
            let authored_at = parts.next().unwrap_or_default().trim().to_string();
            let refs_raw = parts.next().unwrap_or_default().trim().to_string();
            let subject = parts.next().unwrap_or_default().trim().to_string();

            if hash.is_empty() || short_hash.is_empty() || subject.is_empty() {
                return None;
            }

            let ref_names = refs_raw
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            let is_head = ref_names
                .iter()
                .any(|entry| entry == "HEAD" || entry.starts_with("HEAD ->"));

            Some(GitHistoryCommit {
                hash,
                short_hash,
                subject,
                author_name,
                authored_at,
                ref_names,
                is_head,
            })
        })
        .collect()
}

fn parse_git_branches(raw: &str) -> Vec<GitBranchSummary> {
    let mut seen = HashSet::new();
    let mut branches = Vec::new();

    for line in raw.lines() {
        let mut parts = line.splitn(3, '\x1f');
        let head_marker = parts.next().unwrap_or_default().trim();
        let full_ref = parts.next().unwrap_or_default().trim();
        let Some(raw_name) = parts.next() else {
            continue;
        };
        let mut name = raw_name.trim().to_string();
        if name.is_empty() || name == "HEAD" || name.contains("HEAD ->") {
            continue;
        }
        if let Some(stripped) = name.strip_prefix("remotes/") {
            name = stripped.to_string();
        }
        let remote = full_ref.starts_with("refs/remotes/");
        if name.ends_with("/HEAD") || !seen.insert(name.clone()) {
            continue;
        }

        branches.push(GitBranchSummary {
            remote,
            current: head_marker == "*",
            name,
        });
    }

    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.remote.cmp(&right.remote))
            .then_with(|| left.name.cmp(&right.name))
    });
    branches
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitSwitchTarget {
    name: String,
    track_remote: bool,
}

fn resolve_switch_target(target: &str, branches: &[GitBranchSummary]) -> GitSwitchTarget {
    let local_match = branches
        .iter()
        .find(|branch| !branch.remote && branch.name == target);
    if let Some(branch) = local_match {
        return GitSwitchTarget {
            name: branch.name.clone(),
            track_remote: false,
        };
    }

    let remote_match = branches.iter().find(|branch| {
        branch.remote
            && (branch.name == target
                || branch_remote_name(&branch.name)
                    .map(|local_name| local_name == target)
                    .unwrap_or(false))
    });

    if let Some(remote_branch) = remote_match {
        if let Some(local_name) = branch_remote_name(&remote_branch.name) {
            if branches
                .iter()
                .any(|branch| !branch.remote && branch.name == local_name)
            {
                return GitSwitchTarget {
                    name: local_name.to_string(),
                    track_remote: false,
                };
            }
        }

        return GitSwitchTarget {
            name: remote_branch.name.clone(),
            track_remote: true,
        };
    }

    GitSwitchTarget {
        name: target.to_string(),
        track_remote: false,
    }
}

fn branch_remote_name(name: &str) -> Option<&str> {
    let (remote, local_name) = name.split_once('/')?;
    if remote.is_empty() || local_name.is_empty() {
        return None;
    }
    Some(local_name)
}

fn normalize_git_branch_target(raw_branch: &str) -> Result<String, BridgeError> {
    let target = raw_branch.trim();
    if target.is_empty() {
        return Err(BridgeError::invalid_params("branch must not be empty"));
    }
    if target.starts_with('-') {
        return Err(BridgeError::invalid_params(
            "branch must not start with a dash",
        ));
    }
    if target.contains('\0') || target.contains('\n') || target.contains('\r') {
        return Err(BridgeError::invalid_params(
            "branch contains invalid characters",
        ));
    }

    Ok(target.to_string())
}

fn select_default_remote_name(raw: &str) -> Option<String> {
    let remotes = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if remotes.is_empty() {
        return None;
    }

    remotes
        .iter()
        .find(|remote| remote.eq_ignore_ascii_case("origin"))
        .copied()
        .or_else(|| remotes.first().copied())
        .map(str::to_string)
}

fn resolve_repo_relative_path(raw_path: &str, repo_path: &Path) -> Result<String, BridgeError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("path must not be empty"));
    }

    let requested = PathBuf::from(trimmed);
    if requested.is_absolute() {
        return Err(BridgeError::invalid_params(
            "path must be relative to repository",
        ));
    }

    let normalized_repo = normalize_path(repo_path);
    let normalized_target = normalize_path(&repo_path.join(&requested));
    if !normalized_target.starts_with(&normalized_repo) {
        return Err(BridgeError::invalid_params(
            "path must stay within repository root",
        ));
    }

    let relative = normalized_target
        .strip_prefix(&normalized_repo)
        .map_err(|_| BridgeError::invalid_params("path must stay within repository root"))?;
    if relative.as_os_str().is_empty() {
        return Err(BridgeError::invalid_params("path must point to a file"));
    }

    Ok(relative.to_string_lossy().to_string())
}

fn resolve_clone_directory_name(raw_name: &str) -> Result<String, BridgeError> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params(
            "directoryName must not be empty",
        ));
    }

    let requested = PathBuf::from(trimmed);
    if requested.is_absolute() {
        return Err(BridgeError::invalid_params(
            "directoryName must be a folder name, not a path",
        ));
    }

    let mut components = requested.components();
    let component = components
        .next()
        .expect("a non-empty path has at least one component");
    if components.next().is_some() {
        return Err(BridgeError::invalid_params(
            "directoryName must be a single folder name",
        ));
    }
    if !matches!(component, std::path::Component::Normal(_)) {
        return Err(BridgeError::invalid_params(
            "directoryName must be a valid folder name",
        ));
    }

    Ok(trimmed.to_string())
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{
        global_git_config_paths_from, normalize_git_branch_target, parse_git_branches,
        parse_git_history, parse_porcelain_status_entries, parse_status_branch,
        parse_status_has_upstream, resolve_clone_directory_name, resolve_repo_relative_path,
        resolve_switch_target, select_default_remote_name, validate_credential_environment_with,
        validate_effective_git_config, validate_remote_name, validate_remote_url,
        validate_transport_config_output, GitSwitchTarget,
    };
    use crate::{path_policy::PathPolicy, GitBranchSummary};
    use std::{
        collections::HashSet,
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::Arc,
    };
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("clawdex-git-{label}-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).expect("utf-8 git output")
        }

        fn init(&self) {
            self.git(&["init", "-b", "main"]);
            self.git(&["config", "user.email", "tests@example.com"]);
            self.git(&["config", "user.name", "Clawdex Tests"]);
            self.git(&["config", "commit.gpgSign", "false"]);
        }

        fn service(&self) -> super::GitService {
            let policy = Arc::new(PathPolicy::new(self.0.clone(), false).expect("create policy"));
            let terminal = Arc::new(super::TerminalService::new(policy.clone(), HashSet::new()));
            super::GitService::new(terminal, policy).with_global_config_paths(Vec::new())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn git_cwd_policy_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = std::env::temp_dir().join(format!("clawdex-git-path-{}", Uuid::new_v4()));
        let root = temp.join("root");
        let outside = temp.join("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, root.join("escape")).expect("create escape symlink");
        let policy = Arc::new(PathPolicy::new(root, false).expect("create policy"));
        let terminal = Arc::new(super::TerminalService::new(policy.clone(), HashSet::new()));
        let git = super::GitService::new(terminal, policy);

        let error = git
            .resolve_repo_path(Some("escape"))
            .expect_err("reject git symlink escape");
        assert_eq!(error.code, -32602);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn resolves_repo_relative_path_and_rejects_escape() {
        let repo = Path::new("/bridge/root/repo");
        let normalized = resolve_repo_relative_path("src/../src/main.rs", repo)
            .expect("resolve normalized relative path");
        assert_eq!(normalized, "src/main.rs");

        let error =
            resolve_repo_relative_path("../outside.txt", repo).expect_err("reject escape path");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn resolves_clone_directory_name_from_single_segment() {
        let resolved =
            resolve_clone_directory_name("my-repo").expect("resolve single directory name");
        assert_eq!(resolved, "my-repo");
    }

    #[test]
    fn rejects_nested_clone_directory_name() {
        let error = resolve_clone_directory_name("nested/repo")
            .expect_err("reject nested clone directory name");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn parses_porcelain_entries_for_rename_and_untracked() {
        let raw = "## main...origin/main\0R  new/path.ts\0old/path.ts\0?? fresh/file.ts\0";
        let entries = parse_porcelain_status_entries(raw).expect("parse status entries");
        assert_eq!(entries.len(), 2);

        let renamed = &entries[0];
        assert_eq!(renamed.path, "new/path.ts");
        assert_eq!(renamed.original_path.as_deref(), Some("old/path.ts"));
        assert_eq!(renamed.index_status, "R");
        assert_eq!(renamed.worktree_status, " ");
        assert!(renamed.staged);
        assert!(!renamed.unstaged);
        assert!(!renamed.untracked);

        let untracked = &entries[1];
        assert_eq!(untracked.path, "fresh/file.ts");
        assert_eq!(untracked.index_status, "?");
        assert_eq!(untracked.worktree_status, "?");
        assert!(!untracked.staged);
        assert!(untracked.unstaged);
        assert!(untracked.untracked);
    }

    #[test]
    fn detects_when_branch_has_upstream_tracking() {
        assert!(parse_status_has_upstream(
            "## main...origin/main [ahead 1]\n"
        ));
        assert!(!parse_status_has_upstream("## feature/local-only\n"));
        assert!(!parse_status_has_upstream("not a status header\n"));
        assert!(!parse_status_has_upstream(""));
    }

    #[test]
    fn parses_normal_unborn_and_missing_status_branches() {
        assert_eq!(
            parse_status_branch("## main...origin/main [ahead 1]").as_deref(),
            Some("main")
        );
        assert_eq!(
            parse_status_branch("## No commits yet on trunk").as_deref(),
            Some("trunk")
        );
        assert_eq!(
            parse_status_branch("## Initial commit on legacy").as_deref(),
            Some("legacy")
        );
        assert_eq!(parse_status_branch("## "), None);
        assert_eq!(parse_status_branch(" M file.txt"), None);
    }

    #[test]
    fn prefers_origin_as_default_remote() {
        assert_eq!(
            select_default_remote_name("upstream\norigin\n"),
            Some("origin".to_string())
        );
        assert_eq!(
            select_default_remote_name("backup\n"),
            Some("backup".to_string())
        );
        assert_eq!(select_default_remote_name(""), None);
    }

    #[test]
    fn accepts_only_https_remotes_without_credentials() {
        assert_eq!(
            validate_remote_url("https://github.com/example/repo.git").unwrap(),
            "https://github.com/example/repo.git"
        );
        for remote in [
            "",
            "not a url",
            "https://",
            "git@github.com:example/repo.git",
            "ssh://git@github.com/example/repo.git",
            "file:///tmp/repo",
            "ext::sh -c id",
            "https://token@github.com/example/repo.git",
            "https://user:password@github.com/example/repo.git",
            "https://github.com/example/repo.git#branch",
        ] {
            assert!(validate_remote_url(remote).is_err(), "accepted {remote}");
        }
    }

    #[test]
    fn rejects_option_like_or_control_remote_names() {
        assert!(validate_remote_name("origin").is_ok());
        assert!(validate_remote_name("team/upstream-1").is_ok());
        for name in ["--exec", "bad remote", "bad\nremote", "bad:remote", ""] {
            assert!(validate_remote_name(name).is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn rejects_unsafe_transport_configuration_entries() {
        assert!(
            validate_transport_config_output("file:.git/config\0http.sslVerify\ntrue\0").is_ok()
        );
        assert!(validate_transport_config_output(
            "command line:\0credential.helper\n!controlled-helper\0"
        )
        .is_ok());
        let insecure_proxy = format!(
            "file:.git/config\0http.https://example.com.proxy\n{}\0",
            ["http", "://proxy.invalid"].concat()
        );
        let insecure_rewrite = format!(
            "file:.git/config\0url.{}/.insteadOf\nhttps://example.com/\0",
            ["http", "://example.com"].concat()
        );
        for entry in [
            "file:.git/config\0http.sslVerify\nfalse\0".to_string(),
            insecure_proxy,
            "file:.git/config\0http.sslCAInfo\n/tmp/ca.pem\0".to_string(),
            "file:.git/config\0remote.origin.proxy\ncommand\0".to_string(),
            "file:.git/config\0core.gitProxy\ncommand\0".to_string(),
            "file:.git/config\0credential.helper\n!command\0".to_string(),
            insecure_rewrite,
        ] {
            assert!(
                validate_transport_config_output(&entry).is_err(),
                "accepted {entry:?}"
            );
        }
        assert!(validate_transport_config_output("file:.git/config\0").is_err());
    }

    #[test]
    fn parses_effective_git_configuration_fail_closed() {
        assert!(validate_effective_git_config(
            "local\0file:.git/config\0user.name\nClawdex Tests\0"
        )
        .is_ok());
        for key_value in [
            "filter.secret.clean\n/tmp/helper",
            "diff.secret.textconv\n/tmp/helper",
            "merge.secret.driver\n/tmp/helper %O %A %B",
            "core.sshCommand\n/tmp/helper",
            "credential.helper\nosxkeychain",
            "sequence.editor\n/tmp/helper",
            "alias.deploy\n!/tmp/helper",
            "protocol.file.allow\nalways",
        ] {
            let raw = format!("local\0file:.git/config\0{key_value}\0");
            assert!(
                validate_effective_git_config(&raw).is_err(),
                "accepted {key_value:?}"
            );
        }
        assert!(validate_effective_git_config("local\0file:.git/config\0user.name\0").is_err());
    }

    #[test]
    fn rejects_credentialed_git_environment_overrides() {
        assert!(validate_credential_environment_with(|_| false).is_ok());
        for variable in [
            "GIT_SSL_NO_VERIFY",
            "GIT_CONFIG_COUNT",
            "GIT_PROXY_COMMAND",
            "CURL_CA_BUNDLE",
            "HTTPS_PROXY",
            "http_proxy",
        ] {
            assert!(
                validate_credential_environment_with(|name| name == variable).is_err(),
                "accepted {variable}"
            );
        }
        assert!(
            validate_credential_environment_with(|name| { name == "GIT_CONFIG_SYSTEM" }).is_err()
        );
    }

    #[test]
    fn resolves_standard_global_git_config_paths() {
        use std::ffi::OsString;

        assert_eq!(
            global_git_config_paths_from(Some(OsString::from("/home/user")), None),
            vec![
                PathBuf::from("/home/user/.gitconfig"),
                PathBuf::from("/home/user/.config/git/config"),
            ]
        );
        assert_eq!(
            global_git_config_paths_from(
                Some(OsString::from("/home/user")),
                Some(OsString::from("/config")),
            ),
            vec![
                PathBuf::from("/home/user/.gitconfig"),
                PathBuf::from("/config/git/config"),
            ]
        );
        assert!(global_git_config_paths_from(None, None).is_empty());
        assert_eq!(
            global_git_config_paths_from(None, Some(OsString::from("/config"))),
            vec![PathBuf::from("/config/git/config")]
        );
    }

    #[test]
    fn parses_git_history_records() {
        let raw = concat!(
            "abc123\x1fabc123\x1fMohit\x1f2026-04-05T10:00:00+05:30\x1fHEAD -> feat/test, origin/feat/test\x1fAdd history card\x1e",
            "def456\x1fdef456\x1fMohit\x1f2026-04-04T09:00:00+05:30\x1forigin/main\x1fPrevious commit\x1e"
        );

        let commits = parse_git_history(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].subject, "Add history card");
        assert!(commits[0].is_head);
        assert_eq!(
            commits[0].ref_names,
            vec![
                "HEAD -> feat/test".to_string(),
                "origin/feat/test".to_string()
            ]
        );
        assert_eq!(commits[1].subject, "Previous commit");
        assert!(!commits[1].is_head);
        assert!(parse_git_history("\x1e\n\x1e").is_empty());
        assert!(parse_git_history("hash-only\x1e").is_empty());
        assert!(parse_git_history("\x1fshort\x1fauthor\x1fdate\x1frefs\x1fsubject\x1e").is_empty());
        assert!(parse_git_history("hash\x1fshort\x1fauthor\x1fdate\x1frefs\x1f\x1e").is_empty());
        assert!(parse_git_history("hash\x1f\x1fauthor\x1fdate\x1frefs\x1fsubject\x1e").is_empty());
        assert!(
            parse_git_history("hash\x1fshort\x1fauthor\x1fdate\x1fHEAD\x1fsubject\x1e")[0].is_head
        );
    }

    #[test]
    fn parses_local_and_remote_git_branches() {
        let raw = concat!(
            "*\x1frefs/heads/feature/local\x1ffeature/local\n",
            " \x1frefs/heads/main\x1fmain\n",
            " \x1frefs/remotes/origin/HEAD\x1forigin/HEAD\n",
            " \x1frefs/remotes/origin/feature/remote\x1forigin/feature/remote\n",
            " \x1frefs/remotes/origin/main\x1forigin/main\n",
        );

        let branches = parse_git_branches(raw);
        assert_eq!(branches[0].name, "feature/local");
        assert!(branches[0].current);
        assert!(!branches[0].remote);
        assert!(branches
            .iter()
            .any(|branch| branch.name == "origin/main" && branch.remote));
        assert!(!branches.iter().any(|branch| branch.name == "origin/HEAD"));

        let edge_cases = parse_git_branches(concat!(
            "malformed\n",
            " \x1frefs/heads/empty\x1f\n",
            " \x1frefs/remotes/origin/main\x1fremotes/origin/main\n",
            " \x1frefs/remotes/origin/main\x1forigin/main\n",
            " \x1frefs/remotes/origin/HEAD\x1fHEAD\n",
            " \x1frefs/remotes/origin/alias\x1forigin/HEAD -> origin/main\n",
        ));
        assert_eq!(edge_cases.len(), 1);
        assert_eq!(edge_cases[0].name, "origin/main");
        assert!(edge_cases[0].remote);
    }

    #[test]
    fn resolves_remote_branch_switch_targets() {
        let branches = vec![
            GitBranchSummary {
                name: "main".to_string(),
                remote: false,
                current: true,
            },
            GitBranchSummary {
                name: "origin/main".to_string(),
                remote: true,
                current: false,
            },
            GitBranchSummary {
                name: "origin/feature/remote".to_string(),
                remote: true,
                current: false,
            },
        ];

        assert_eq!(
            resolve_switch_target("main", &branches),
            GitSwitchTarget {
                name: "main".to_string(),
                track_remote: false,
            }
        );
        assert_eq!(
            resolve_switch_target("feature/remote", &branches),
            GitSwitchTarget {
                name: "origin/feature/remote".to_string(),
                track_remote: true,
            }
        );
        assert_eq!(
            resolve_switch_target("origin/main", &branches),
            GitSwitchTarget {
                name: "main".to_string(),
                track_remote: false,
            }
        );
        assert_eq!(
            resolve_switch_target("missing", &branches),
            GitSwitchTarget {
                name: "missing".to_string(),
                track_remote: false,
            }
        );
        assert_eq!(
            super::branch_remote_name("origin/feature/x"),
            Some("feature/x")
        );
        assert_eq!(super::branch_remote_name("origin/"), None);
        assert_eq!(super::branch_remote_name("/main"), None);
        assert_eq!(super::branch_remote_name("main"), None);
        assert_eq!(
            resolve_switch_target(
                "remote-only",
                &[GitBranchSummary {
                    name: "remote-only".to_string(),
                    remote: true,
                    current: false,
                }],
            ),
            GitSwitchTarget {
                name: "remote-only".to_string(),
                track_remote: true,
            }
        );
    }

    #[test]
    fn rejects_git_switch_option_like_branch_names() {
        assert!(normalize_git_branch_target("feature/test").is_ok());
        let error = normalize_git_branch_target("--detach").expect_err("reject option-like name");
        assert_eq!(error.code, -32602);
        for branch in ["", "  ", "bad\0name", "bad\nname", "bad\rname"] {
            assert!(
                normalize_git_branch_target(branch).is_err(),
                "accepted {branch:?}"
            );
        }
    }

    #[test]
    fn validates_repo_relative_paths_and_clone_names() {
        let repo = Path::new("/bridge/root/repo");
        for path in ["", "  ", "/absolute", ".", "src/../../outside"] {
            assert!(
                resolve_repo_relative_path(path, repo).is_err(),
                "accepted {path:?}"
            );
        }
        for name in ["", "  ", "/absolute", ".", "..", "nested/repo"] {
            assert!(
                resolve_clone_directory_name(name).is_err(),
                "accepted {name:?}"
            );
        }
        assert_eq!(resolve_clone_directory_name(" repo ").unwrap(), "repo");
    }

    #[test]
    fn parses_porcelain_edge_cases() {
        let entries = parse_porcelain_status_entries(
            "## main\0\0 X short\0C  copied\0original\0 M changed\0?? untracked\0",
        )
        .expect("parse edge cases");
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].path, "short");
        assert!(!entries[0].staged);
        assert!(entries[0].unstaged);
        assert_eq!(entries[1].original_path.as_deref(), Some("original"));
        assert!(entries[1].staged);
        assert!(entries[2].unstaged);
        assert!(entries[3].untracked);

        let missing_rename_source =
            parse_porcelain_status_entries("R  renamed\0").expect("parse rename without source");
        assert_eq!(missing_rename_source[0].original_path, None);
        assert!(parse_porcelain_status_entries("X\0").unwrap().is_empty());
    }

    #[test]
    fn selects_git_failure_message_in_priority_order() {
        assert_eq!(
            super::git_failure_message("stderr", "stdout", "fallback"),
            "stderr"
        );
        assert_eq!(
            super::git_failure_message("", "stdout", "fallback"),
            "stdout"
        );
        assert_eq!(super::git_failure_message("", "", "fallback"), "fallback");
    }

    #[tokio::test]
    async fn exercises_git_workflow_against_real_repository() {
        let repo = TestDir::new("workflow");
        repo.init();
        let service = repo.service();

        let unborn = service.get_status(None).await.expect("unborn status");
        assert_eq!(unborn.branch, "main");
        assert!(unborn.clean);
        assert_eq!(service.get_branches(None).await.unwrap().current, None);

        fs::write(repo.0.join("tracked.txt"), "first\n").expect("write tracked file");
        let staged = service
            .stage_file("tracked.txt", None)
            .await
            .expect("stage file");
        assert!(staged.staged);
        let initial_diff = service.get_diff(None).await.expect("initial diff");
        assert!(initial_diff.diff.contains("first"));
        let committed = service
            .commit("initial commit".to_string(), None)
            .await
            .expect("commit");
        assert!(committed.committed);

        fs::write(repo.0.join("tracked.txt"), "first\nsecond\n").expect("modify tracked file");
        fs::write(repo.0.join("new file.txt"), "untracked\n").expect("write untracked file");
        service
            .run_git_diff_command(
                &repo.0,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--exit-code",
                    "HEAD",
                    "--",
                    "tracked.txt",
                ],
                true,
                "git diff --exit-code failed",
            )
            .await
            .expect("allow git diff exit code one");
        let dirty = service.get_status(None).await.expect("dirty status");
        assert!(!dirty.clean);
        assert_eq!(dirty.total_files, 2);
        assert!(dirty.files.iter().any(|entry| entry.untracked));
        let diff = service.get_diff(None).await.expect("working tree diff");
        assert!(diff.diff.contains("second"));
        assert!(diff.diff.contains("untracked"));
        assert!(!diff.truncated);

        assert!(service.stage_all(None).await.expect("stage all").staged);
        assert!(
            service
                .unstage_file("tracked.txt", None)
                .await
                .expect("unstage file")
                .unstaged
        );
        assert!(
            service
                .unstage_all(None)
                .await
                .expect("unstage all")
                .unstaged
        );
        assert!(service.stage_all(None).await.expect("restage all").staged);
        assert!(
            service
                .commit("second commit".to_string(), None)
                .await
                .expect("second commit")
                .committed
        );

        let history = service.get_history(None, Some(99)).await.expect("history");
        assert_eq!(history.commits.len(), 2);
        assert_eq!(history.commits[0].subject, "second commit");
        assert!(history.commits[0].is_head);
        assert_eq!(
            service
                .get_history(None, Some(0))
                .await
                .unwrap()
                .commits
                .len(),
            1
        );

        repo.git(&["branch", "feature/local"]);
        let branches = service.get_branches(None).await.expect("branches");
        assert_eq!(branches.current.as_deref(), Some("main"));
        assert!(branches
            .branches
            .iter()
            .any(|branch| branch.name == "feature/local"));
        let switched = service
            .switch_branch("feature/local".to_string(), None)
            .await
            .expect("switch branch");
        assert!(switched.switched);
        assert_eq!(
            service.get_status(None).await.unwrap().branch,
            "feature/local"
        );

        assert!(
            !service
                .commit("nothing to commit".to_string(), None)
                .await
                .expect("empty commit result")
                .committed
        );
        assert!(
            !service
                .switch_branch("missing".to_string(), None)
                .await
                .expect("missing branch result")
                .switched
        );
    }

    #[tokio::test]
    async fn validates_repository_safety_and_push_paths() {
        let repo = TestDir::new("push");
        repo.init();
        fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
        repo.git(&["add", "file.txt"]);
        repo.git(&["commit", "-m", "initial"]);
        let service = repo.service();

        let no_remote = service.push(None).await.expect("no remote response");
        assert!(!no_remote.pushed);
        assert!(no_remote.stderr.contains("No git remote"));

        repo.git(&[
            "remote",
            "add",
            "origin",
            "https://127.0.0.1:1/example/repo.git",
        ]);
        let failed_push = service
            .push(None)
            .await
            .expect("failed network push response");
        assert!(!failed_push.pushed);
        assert!(failed_push.stderr.contains("127.0.0.1"));

        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        let upstream_push = service.push(None).await.expect("upstream push response");
        assert!(!upstream_push.pushed);

        repo.git(&["config", "http.sslVerify", "false"]);
        let unsafe_local = service
            .push(None)
            .await
            .expect_err("reject local transport override");
        assert_eq!(
            unsafe_local.data.unwrap()["error"],
            "unsafe_git_configuration"
        );
        repo.git(&["config", "--unset", "http.sslVerify"]);

        let included_config = repo.0.join("unsafe-transport.config");
        fs::write(
            &included_config,
            "[http]\n\tsslCAInfo = /tmp/untrusted-ca.pem\n",
        )
        .expect("write included config");
        repo.git(&[
            "config",
            "include.path",
            included_config.to_str().expect("utf-8 include path"),
        ]);
        let unsafe_include = service
            .push(None)
            .await
            .expect_err("reject included transport override");
        assert_eq!(unsafe_include.code, -32003);
        repo.git(&["config", "--unset", "include.path"]);

        let global_config = repo.0.join("global.gitconfig");
        fs::write(&global_config, "[core]\n\tgitProxy = command\n").expect("write global config");
        let global_service = repo.service().with_global_config_paths(vec![global_config]);
        assert_eq!(
            global_service
                .push(None)
                .await
                .expect_err("reject global transport override")
                .code,
            -32003
        );

        let missing_global_service = repo
            .service()
            .with_global_config_paths(vec![repo.0.join("missing.gitconfig")]);
        assert!(
            !missing_global_service
                .push(None)
                .await
                .expect("ignore missing global config")
                .pushed
        );

        let malformed_global = repo.0.join("malformed.gitconfig");
        fs::write(&malformed_global, "[http\nsslVerify = false\n")
            .expect("write malformed global config");
        let malformed_service = repo
            .service()
            .with_global_config_paths(vec![malformed_global]);
        assert_eq!(
            malformed_service
                .push(None)
                .await
                .expect_err("reject malformed global config")
                .code,
            -32000
        );

        repo.git(&["remote", "set-url", "origin", "file:///tmp/unsafe"]);
        let unsafe_remote = service.push(None).await.expect_err("reject unsafe remote");
        assert_eq!(unsafe_remote.code, -32003);

        repo.git(&["remote", "remove", "origin"]);
        repo.git(&["config", "core.hooksPath", "/tmp/hooks"]);
        let unsafe_config = service
            .stage_all(None)
            .await
            .expect_err("reject helper config");
        assert_eq!(unsafe_config.code, -32003);
    }

    #[tokio::test]
    async fn reports_non_repository_failures_and_clone_validation() {
        let root = TestDir::new("errors");
        let service = root.service();
        assert_eq!(service.get_status(None).await.unwrap_err().code, -32000);
        assert_eq!(
            service.get_history(None, None).await.unwrap_err().code,
            -32000
        );
        assert_eq!(service.get_branches(None).await.unwrap_err().code, -32000);
        assert_eq!(service.stage_all(None).await.unwrap_err().code, -32000);

        assert_eq!(
            service
                .clone_repo("ssh://example.com/repo", None, "repo")
                .await
                .unwrap_err()
                .code,
            -32003
        );
        fs::create_dir(root.0.join("existing")).expect("create existing destination");
        assert_eq!(
            service
                .clone_repo("https://example.com/repo.git", None, "existing")
                .await
                .unwrap_err()
                .code,
            -32602
        );
        let clone = service
            .clone_repo("https://127.0.0.1:1/repo.git", None, "new-repo")
            .await
            .expect("failed clone response");
        assert!(!clone.cloned);
    }

    #[tokio::test]
    async fn tracks_remote_branch_from_real_repository_refs() {
        let repo = TestDir::new("remote-branch");
        repo.init();
        fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
        repo.git(&["add", "file.txt"]);
        repo.git(&["commit", "-m", "initial"]);
        repo.git(&[
            "remote",
            "add",
            "origin",
            "https://example.com/example/repo.git",
        ]);
        repo.git(&["update-ref", "refs/remotes/origin/feature/remote", "HEAD"]);

        let service = repo.service();
        let branches = service.get_branches(None).await.expect("remote branches");
        assert!(branches
            .branches
            .iter()
            .any(|branch| branch.name == "origin/feature/remote" && branch.remote));
        let switched = service
            .switch_branch("feature/remote".to_string(), None)
            .await
            .expect("track remote branch");
        assert!(switched.switched);
        assert_eq!(switched.branch, "feature/remote");
    }

    #[tokio::test]
    async fn diff_covers_staged_only_new_repo_and_stderr_error_fallback() {
        let repo = TestDir::new("diff-staged");
        repo.init();
        let service = repo.service();

        // A file staged before any HEAD commit: diff falls back to --cached.
        fs::write(repo.0.join("staged.txt"), "staged content\n").expect("write staged file");
        repo.git(&["add", "staged.txt"]);
        let diff = service.get_diff(None).await.expect("staged-only diff");
        assert!(diff.diff.contains("staged content") || diff.diff.contains("staged.txt"));
        assert!(!diff.truncated);

        // Also exercise an unstaged change in the same repo.
        repo.git(&["commit", "-m", "first"]);
        fs::write(repo.0.join("staged.txt"), "changed content\n").expect("modify staged file");
        let working_diff = service.get_diff(None).await.expect("working diff");
        assert!(working_diff.diff.contains("changed"));
    }

    #[tokio::test]
    async fn validates_repository_helpers_rejects_unsafe_config_with_stderr() {
        let repo = TestDir::new("unsafe-config");
        repo.init();
        fs::write(repo.0.join("file.txt"), "x\n").expect("write file");
        repo.git(&["add", "file.txt"]);
        repo.git(&["commit", "-m", "initial"]);
        repo.git(&["config", "core.hooksPath", "/tmp/evil-hooks"]);
        let service = repo.service();

        let error = service
            .get_diff(None)
            .await
            .expect_err("reject unsafe git configuration");
        assert_eq!(error.code, -32003);
        assert!(error.data.as_ref().unwrap()["error"] == "unsafe_git_configuration");

        let malformed = TestDir::new("malformed-config");
        malformed.init();
        fs::write(
            malformed.0.join(".git/config"),
            "[core\nhooksPath = /tmp/evil\n",
        )
        .expect("write malformed local config");
        let error = malformed
            .service()
            .get_diff(None)
            .await
            .expect_err("report malformed local config");
        assert_eq!(error.code, -32000);
        assert_eq!(
            error.message,
            "git repository configuration inspection failed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn included_filter_is_rejected_before_git_add_executes_it() {
        use std::os::unix::fs::PermissionsExt;

        let repo = TestDir::new("included-filter");
        repo.init();
        let sentinel = repo.0.join("filter-ran");
        let helper = repo.0.join("filter-helper.sh");
        fs::write(
            &helper,
            format!("#!/bin/sh\ntouch '{}'\ncat\n", sentinel.display()),
        )
        .expect("write filter helper");
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700))
            .expect("make filter helper executable");
        let included = repo.0.join("included.gitconfig");
        fs::write(
            &included,
            format!("[filter \"sentinel\"]\n\tclean = {}\n", helper.display()),
        )
        .expect("write included config");
        repo.git(&[
            "config",
            "include.path",
            included.to_str().expect("utf-8 include path"),
        ]);
        fs::write(repo.0.join(".gitattributes"), "*.secret filter=sentinel\n")
            .expect("write attributes");
        fs::write(repo.0.join("payload.secret"), "secret\n").expect("write payload");

        let error = repo
            .service()
            .stage_all(None)
            .await
            .expect_err("reject included clean filter");
        assert_eq!(error.data.unwrap()["error"], "unsafe_git_configuration");
        assert!(!sentinel.exists(), "validation executed the clean filter");
    }

    #[tokio::test]
    async fn effective_config_inspects_include_if_global_includes_and_benign_entries() {
        let include_if_repo = TestDir::new("include-if-filter");
        include_if_repo.init();
        let include_if_config = include_if_repo.0.join("conditional.gitconfig");
        fs::write(
            &include_if_config,
            "[filter \"conditional\"]\n\tprocess = /tmp/conditional-filter\n",
        )
        .expect("write conditional config");
        include_if_repo.git(&[
            "config",
            &format!("includeIf.gitdir:{}/.path", include_if_repo.0.display()),
            include_if_config.to_str().expect("utf-8 include path"),
        ]);
        assert_eq!(
            include_if_repo
                .service()
                .stage_all(None)
                .await
                .expect_err("reject active includeIf filter")
                .data
                .unwrap()["error"],
            "unsafe_git_configuration"
        );

        let global_repo = TestDir::new("global-include-filter");
        global_repo.init();
        let global_included = global_repo.0.join("global-included.gitconfig");
        fs::write(
            &global_included,
            "[merge \"external\"]\n\tdriver = /tmp/merge-driver %O %A %B\n",
        )
        .expect("write global included config");
        let global_config = global_repo.0.join("global.gitconfig");
        fs::write(
            &global_config,
            format!("[include]\n\tpath = {}\n", global_included.display()),
        )
        .expect("write global config");
        assert_eq!(
            global_repo
                .service()
                .with_global_config_paths(vec![global_config])
                .stage_all(None)
                .await
                .expect_err("reject global included driver")
                .data
                .unwrap()["error"],
            "unsafe_git_configuration"
        );

        let benign_repo = TestDir::new("benign-config");
        benign_repo.init();
        let benign_included = benign_repo.0.join("benign-included.gitconfig");
        fs::write(&benign_included, "[color]\n\tui = auto\n").expect("write benign include");
        benign_repo.git(&[
            "config",
            "include.path",
            benign_included.to_str().expect("utf-8 include path"),
        ]);
        let benign_global = benign_repo.0.join("benign-global.gitconfig");
        fs::write(&benign_global, "[user]\n\tuseConfigOnly = true\n")
            .expect("write benign global config");
        benign_repo
            .service()
            .with_global_config_paths(vec![benign_global])
            .stage_all(None)
            .await
            .expect("accept benign effective config");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_operations_validate_all_effective_config_sources_without_running_helpers() {
        use std::os::unix::fs::PermissionsExt;

        async fn assert_reads_reject(service: &super::GitService, sentinel: &Path) {
            for error in [
                service.get_status(None).await.expect_err("reject status"),
                service
                    .get_history(None, None)
                    .await
                    .expect_err("reject history"),
                service
                    .get_branches(None)
                    .await
                    .expect_err("reject branches"),
                service.get_diff(None).await.expect_err("reject diff"),
            ] {
                assert_eq!(error.code, -32003);
                assert_eq!(
                    error.data.as_ref().and_then(|data| data["error"].as_str()),
                    Some("unsafe_git_configuration")
                );
                assert!(!error
                    .message
                    .contains(&sentinel.to_string_lossy().to_string()));
            }
            assert!(!sentinel.exists(), "validation executed an unsafe helper");
        }

        fn executable_filter(repo: &TestDir, name: &str) -> (PathBuf, PathBuf) {
            let sentinel = repo.0.join(format!("{name}-ran"));
            let helper = repo.0.join(format!("{name}.sh"));
            fs::write(
                &helper,
                format!("#!/bin/sh\ntouch '{}'\ncat\n", sentinel.display()),
            )
            .expect("write helper");
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o700))
                .expect("make helper executable");
            (sentinel, helper)
        }

        for source in ["local", "included", "include-if", "worktree"] {
            let repo = TestDir::new(&format!("read-{source}"));
            repo.init();
            fs::write(repo.0.join("file.txt"), "content\n").expect("write file");
            repo.git(&["add", "file.txt"]);
            repo.git(&["commit", "-m", "initial"]);
            let (sentinel, helper) = executable_filter(&repo, source);
            match source {
                "local" => {
                    repo.git(&[
                        "config",
                        "filter.local.clean",
                        helper.to_str().expect("utf-8 helper path"),
                    ]);
                }
                "included" | "include-if" => {
                    let included = repo.0.join(format!("{source}.gitconfig"));
                    fs::write(
                        &included,
                        format!("[filter \"{source}\"]\n\tclean = {}\n", helper.display()),
                    )
                    .expect("write included config");
                    let key = if source == "included" {
                        "include.path".to_string()
                    } else {
                        format!("includeIf.gitdir:{}/.path", repo.0.display())
                    };
                    repo.git(&["config", &key, included.to_str().expect("utf-8 path")]);
                }
                "worktree" => {
                    repo.git(&["config", "extensions.worktreeConfig", "true"]);
                    repo.git(&[
                        "config",
                        "--worktree",
                        "filter.worktree.clean",
                        helper.to_str().expect("utf-8 helper path"),
                    ]);
                }
                _ => unreachable!(),
            }
            assert_reads_reject(&repo.service(), &sentinel).await;
        }

        let global_repo = TestDir::new("read-global");
        global_repo.init();
        let (sentinel, helper) = executable_filter(&global_repo, "global");
        let global_config = global_repo.0.join("global.gitconfig");
        fs::write(
            &global_config,
            format!("[filter \"global\"]\n\tclean = {}\n", helper.display()),
        )
        .expect("write global config");
        assert_reads_reject(
            &global_repo
                .service()
                .with_global_config_paths(vec![global_config]),
            &sentinel,
        )
        .await;

        let benign_repo = TestDir::new("read-benign");
        benign_repo.init();
        fs::write(benign_repo.0.join("file.txt"), "content\n").expect("write file");
        benign_repo.git(&["add", "file.txt"]);
        benign_repo.git(&["commit", "-m", "initial"]);
        let benign_service = benign_repo.service();
        benign_service
            .get_status(None)
            .await
            .expect("benign status");
        benign_service
            .get_history(None, None)
            .await
            .expect("benign history");
        benign_service
            .get_branches(None)
            .await
            .expect("benign branches");
        benign_service.get_diff(None).await.expect("benign diff");
    }

    #[tokio::test]
    async fn truncates_status_after_maximum_file_count() {
        let repo = TestDir::new("status-limit");
        repo.init();
        for index in 0..=crate::resource_limits::GIT_STATUS_MAX_FILES {
            fs::write(repo.0.join(format!("file-{index:04}.txt")), "")
                .expect("write untracked file");
        }
        let status = repo
            .service()
            .get_status(None)
            .await
            .expect("limited status");
        assert!(status.truncated);
        assert_eq!(
            status.total_files,
            crate::resource_limits::GIT_STATUS_MAX_FILES + 1
        );
        assert_eq!(
            status.files.len(),
            crate::resource_limits::GIT_STATUS_MAX_FILES
        );
        assert_eq!(status.omitted_files, 1);
    }
}
