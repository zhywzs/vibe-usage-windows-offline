//! Local usage reader — the offline replacement for the old vibecafe.ai
//! usage endpoint. Spawns the vendored CLI's `usage` command
//! (`node <resources>/cli/bin/vibe-usage.js usage …`), which reads
//! ~/.vibe-usage/usage.json, estimates costs from the bundled price table,
//! and emits the same JSON shape the dashboard used to receive.

use crate::process_utils;
use crate::state::AppCtx;
use serde::Deserialize;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use vibe_core::runtime::{self, Runtime};

pub const USAGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UsageQuery {
    Days { days: u32 },
    From { from_iso: String },
    Custom { from_date: String, to_date: String },
}

impl UsageQuery {
    fn cli_args(&self) -> Vec<String> {
        match self {
            UsageQuery::Days { days } => vec!["--days".into(), days.to_string()],
            UsageQuery::From { from_iso } => vec!["--from".into(), from_iso.clone()],
            UsageQuery::Custom { from_date, to_date } => vec![
                "--from-date".into(),
                from_date.clone(),
                "--to-date".into(),
                to_date.clone(),
            ],
        }
    }
}

/// Query local usage via the vendored CLI. Returns the parsed JSON payload
/// (buckets/sessions/hasAnyData) verbatim for the frontend.
pub async fn fetch_usage(app: &AppHandle, query: &UsageQuery) -> Result<Value, String> {
    let cli = crate::services::sync_engine::cli_entry(app)
        .ok_or_else(|| "未找到内置 CLI 资源".to_string())?;
    let rt = detect_runtime_for_usage(app).ok_or_else(|| {
        "未检测到可用的 Node.js 运行时，请安装 Node.js 22+".to_string()
    })?;
    let cli_dir = cli.parent().ok_or_else(|| "内置 CLI 路径无效".to_string())?.to_path_buf();
    let cli_file = cli
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "内置 CLI 路径无效".to_string())?
        .to_string();

    let mut cmd = tokio::process::Command::new(&rt.path);
    cmd.current_dir(&cli_dir)
        .arg(&cli_file)
        .arg("usage")
        .args(query.cli_args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(dir) = rt.path.parent() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}{sep}{path}", dir.display()));
    }
    let ctx = app.state::<AppCtx>();
    cmd.env("VIBE_USAGE_CONFIG_DIR", ctx.config.config_dir.clone());
    cmd.env("VIBE_USAGE_STORE_DIR", ctx.config.config_dir.clone());
    if crate::state::IS_DEV {
        cmd.env("VIBE_USAGE_DEV", "1");
    }
    // The weekly price-table refresh is best-effort in the CLI; the proxy
    // bridge keeps it working on proxied networks. Usage itself stays local.
    if std::env::var("HTTPS_PROXY").is_err() && std::env::var("https_proxy").is_err() {
        if let Some(proxy) = process_utils::system_proxy_url() {
            cmd.env("HTTPS_PROXY", &proxy);
            cmd.env("HTTP_PROXY", &proxy);
        }
    }
    cmd.env("NODE_USE_ENV_PROXY", "1");
    process_utils::hide_tokio_command_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("查询本地用量失败: {e}"))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let io_task = async {
        use tokio::io::AsyncReadExt;
        let mut out = String::new();
        let mut err = String::new();
        if let Some(mut p) = stdout_pipe {
            let _ = p.read_to_string(&mut out).await;
        }
        if let Some(mut p) = stderr_pipe {
            let _ = p.read_to_string(&mut err).await;
        }
        (out, err)
    };

    let combined = tokio::select! {
        res = async {
            let (io, status) = tokio::join!(io_task, child.wait());
            (io, status)
        } => res,
        _ = tokio::time::sleep(USAGE_TIMEOUT) => {
            process_utils::kill_child_tree(&mut child);
            return Err("查询本地用量超时".into());
        }
    };

    let ((stdout, stderr), status) = combined;
    let status = status.map_err(|e| format!("查询本地用量失败: {e}"))?;
    if !status.success() {
        let msg = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let first = msg.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("查询本地用量失败: {first}"));
    }

    // The CLI may print dim warnings on stderr; stdout must be pure JSON.
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("本地用量数据异常: {e}"))
}

fn detect_runtime_for_usage(app: &AppHandle) -> Option<Runtime> {
    let bundled = crate::services::sync_engine::bundled_node(app);
    runtime::detect(bundled, probe_node_version)
}

fn probe_node_version(path: &std::path::Path) -> Option<(u32, u32, u32)> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("-v").stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    process_utils::hide_command_window(&mut cmd);
    let out = cmd.output().ok()?;
    runtime::parse_node_version(&String::from_utf8_lossy(&out.stdout))
}
