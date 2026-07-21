use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::Serialize;

mod config;
mod platform_setup;
mod setup;
mod supervisor;

use config::{validate_workspace, BridgeRuntimeConfig, RuntimePaths};
use platform_setup::NetworkMode;
use setup::{discover_agent_executable, setup_workspace, SetupRequest};
use supervisor::{BridgeSnapshot, BridgeState, BridgeSupervisor};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResponse<T: Serialize> {
    ok: bool,
    result: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorSnapshot {
    state: String,
    headline: String,
    detail: String,
    bridge_url: Option<String>,
    uptime_sec: Option<u64>,
    connected_clients: usize,
    ready_agents: usize,
    total_agents: usize,
    recent_error_count: usize,
    managed_process: bool,
    workspace: PathBuf,
    pairing_payload: Option<String>,
    log_path: PathBuf,
}

fn main() {
    if let Err(error) = run() {
        let response = serde_json::json!({
            "ok": false,
            "error": format!("{error:#}"),
        });
        eprintln!("{}", serde_json::to_string(&response).unwrap());
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let human = take_flag(&mut args, "--human");
    let command = args
        .first()
        .cloned()
        .unwrap_or_else(|| "status".to_string());
    if !args.is_empty() {
        args.remove(0);
    }

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }
    if matches!(command.as_str(), "version" | "--version" | "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let workspace = workspace_arg(&mut args)?;
    match command.as_str() {
        "status" => {
            ensure_no_args(&args)?;
            let supervisor = supervisor(workspace)?;
            emit(operator_snapshot(&supervisor, supervisor.snapshot()), human)
        }
        "start" => {
            ensure_no_args(&args)?;
            let supervisor = supervisor(workspace)?;
            let snapshot = supervisor.start()?;
            emit(operator_snapshot(&supervisor, snapshot), human)
        }
        "stop" => {
            ensure_no_args(&args)?;
            let supervisor = supervisor(workspace)?;
            let snapshot = supervisor.stop()?;
            emit(operator_snapshot(&supervisor, snapshot), human)
        }
        "restart" => {
            ensure_no_args(&args)?;
            let supervisor = supervisor(workspace)?;
            let snapshot = supervisor.restart()?;
            emit(operator_snapshot(&supervisor, snapshot), human)
        }
        "setup" => run_setup(workspace, args, human),
        "discover-agent" => {
            let agent_id = option(&mut args, "--agent-id").unwrap_or_else(|| "opencode".into());
            ensure_no_args(&args)?;
            let executable = discover_agent_executable(&agent_id).with_context(|| {
                format!("{agent_id} is not installed in a standard executable path")
            })?;
            emit(
                serde_json::json!({ "agentId": agent_id, "executable": executable }),
                human,
            )
        }
        _ => bail!("unknown command '{command}'; run 'tethercode help'"),
    }
}

fn run_setup(workspace: PathBuf, mut args: Vec<String>, human: bool) -> Result<()> {
    let network_mode = option(&mut args, "--network").unwrap_or_else(|| "tailscale".into());
    let mode = match network_mode.as_str() {
        "local" => NetworkMode::Local,
        "tailscale" => NetworkMode::Tailscale,
        _ => bail!("--network must be local or tailscale"),
    };
    let host = option(&mut args, "--host")
        .map(Ok)
        .unwrap_or_else(|| platform_setup::resolve_bridge_host(mode, None))?;
    let bridge_port = option(&mut args, "--port")
        .map(|value| {
            value
                .parse::<u16>()
                .context("--port must be a valid TCP port")
        })
        .transpose()?
        .unwrap_or(8787);
    let agent_id = option(&mut args, "--agent-id").unwrap_or_else(|| "opencode".into());
    let display_name = option(&mut args, "--display-name").unwrap_or_else(|| agent_id.clone());
    let executable = option(&mut args, "--agent-executable")
        .map(PathBuf::from)
        .or_else(|| discover_agent_executable(&agent_id))
        .with_context(|| format!("{agent_id} is not installed; pass --agent-executable"))?;
    let agent_args = option(&mut args, "--agent-args")
        .map(|value| split_args(&value))
        .unwrap_or_else(|| default_agent_args(&agent_id));
    ensure_no_args(&args)?;

    let result = setup_workspace(SetupRequest {
        workspace,
        network_mode,
        bridge_host: host,
        bridge_port,
        agent_id,
        display_name,
        executable,
        argv: agent_args,
    })?;
    emit(result, human)
}

fn supervisor(workspace: PathBuf) -> Result<BridgeSupervisor> {
    Ok(BridgeSupervisor::new(
        validate_workspace(&workspace)?,
        RuntimePaths::discover()?,
    ))
}

fn operator_snapshot(supervisor: &BridgeSupervisor, snapshot: BridgeSnapshot) -> OperatorSnapshot {
    let pairing_payload = BridgeRuntimeConfig::load(supervisor.workspace())
        .ok()
        .and_then(|config| config.pairing_payload().ok());
    OperatorSnapshot {
        state: state_name(&snapshot.state).to_string(),
        headline: snapshot.headline,
        detail: snapshot.detail,
        bridge_url: snapshot.url,
        uptime_sec: snapshot.uptime_sec,
        connected_clients: snapshot.connected_clients,
        ready_agents: snapshot.ready_agents,
        total_agents: snapshot.total_agents,
        recent_error_count: snapshot.recent_error_count,
        managed_process: snapshot.managed_process,
        workspace: supervisor.workspace().to_path_buf(),
        pairing_payload,
        log_path: supervisor.log_path(),
    }
}

fn state_name(state: &BridgeState) -> &'static str {
    match state {
        BridgeState::NeedsSetup => "needsSetup",
        BridgeState::Stopped => "stopped",
        BridgeState::Running => "running",
        BridgeState::Degraded => "degraded",
        BridgeState::Unhealthy => "unhealthy",
        BridgeState::Inaccessible => "inaccessible",
        BridgeState::Error => "error",
    }
}

fn emit<T: Serialize>(value: T, human: bool) -> Result<()> {
    if human {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "{}",
            serde_json::to_string(&CommandResponse {
                ok: true,
                result: value
            })?
        );
    }
    Ok(())
}

fn workspace_arg(args: &mut Vec<String>) -> Result<PathBuf> {
    let workspace = option(args, "--workspace")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("TETHERCODE_WORKSPACE_ROOT").map(PathBuf::from))
        .unwrap_or(std::env::current_dir()?);
    Ok(workspace)
}

fn option(args: &mut Vec<String>, name: &str) -> Option<String> {
    let index = args.iter().position(|argument| argument == name)?;
    if index + 1 >= args.len() {
        return None;
    }
    args.remove(index);
    Some(args.remove(index))
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    if let Some(index) = args.iter().position(|argument| argument == name) {
        args.remove(index);
        true
    } else {
        false
    }
}

fn ensure_no_args(args: &[String]) -> Result<()> {
    if let Some(argument) = args.first() {
        bail!("unexpected argument '{argument}'");
    }
    Ok(())
}

fn default_agent_args(agent_id: &str) -> Vec<String> {
    match agent_id {
        "opencode" => vec!["acp".to_string()],
        _ => Vec::new(),
    }
}

fn split_args(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn print_help() {
    println!(
        "TetherCode operator\n\n\
Usage: tethercode <command> [--workspace PATH] [--human]\n\n\
Commands:\n\
  status\n\
  start\n\
  stop\n\
  restart\n\
  setup --host HOST [--network local|tailscale] [--port 8787]\n\
        [--agent-id opencode] [--agent-executable PATH] [--agent-args 'acp']\n\
  discover-agent [--agent-id opencode]\n\
  version\n"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_options_and_default_agent_args() {
        let mut args = vec!["--workspace".into(), "/tmp/project".into(), "tail".into()];
        assert_eq!(
            option(&mut args, "--workspace").as_deref(),
            Some("/tmp/project")
        );
        assert_eq!(args, vec!["tail"]);
        assert_eq!(default_agent_args("opencode"), vec!["acp"]);
    }
}
