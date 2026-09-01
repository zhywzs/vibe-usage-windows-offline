//! Local CLI bridge — the offline replacement for the old vibecafe.ai
//! endpoints. Spawns the vendored CLI (`node <resources>/cli/bin/vibe-usage.js`)
//! and returns parsed JSON:
//!   usage  <args>   → local store buckets/sessions (+ estimatedCost)
//!   prices <args>   → price-table status (source/freshness/coverage)

use crate::process_utils;
use crate::state::AppCtx;
use serde::Deserialize;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use vibe_core::runtime::{self, Runtime};

pub const CLI_TIMEOUT: Duration = Duration::from_secs(30);

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
    let mut args = vec!["usage".to_string()];
    args.extend(query.cli_args());
    run_cli_json(app, &args, "查询本地用量失败").await
}

/// Price-table status via the vendored CLI's `prices` command. `force`
/// triggers a real refresh attempt whose outcome (ok or error) is reported
/// instead of swallowed, so the settings view can show why a manual refresh
/// failed while the fallback table keeps serving.
pub async fn fetch_pricing_status(app: &AppHandle, force: bool) -> Result<Value, String> {
    let mut args = vec!["prices".to_string()];
    if force {
        args.push("--refresh".to_string());
    }
    run_cli_json(app, &args, "查询价格表失败").await
}

/// Set (add or partially override) a custom model price. Either `avg_per_m`
/// (one price for every token category, volume-billing style) or any of the
/// detailed per-field values, in `currency` per million tokens (default USD).
/// Returns the updated pricing status JSON.
#[allow(clippy::too_many_arguments)]
pub async fn set_custom_price(
    app: &AppHandle,
    model: &str,
    avg_per_m: Option<f64>,
    input_per_m: Option<f64>,
    output_per_m: Option<f64>,
    cache_read_per_m: Option<f64>,
    currency: Option<&str>,
) -> Result<Value, String> {
    let mut args = vec!["prices".to_string(), "set".to_string(), model.to_string()];
    let has_avg = avg_per_m.is_some();
    let has_detailed = input_per_m.is_some() || output_per_m.is_some() || cache_read_per_m.is_some();
    if has_avg && has_detailed {
        return Err("--avg 不能与详细价格同时使用".into());
    }
    for (flag, value) in [
        ("--avg", avg_per_m),
        ("--input", input_per_m),
        ("--output", output_per_m),
        ("--cache-read", cache_read_per_m),
    ] {
        if let Some(v) = value {
            if !v.is_finite() || v < 0.0 {
                return Err("价格必须为非负数字（每百万 tokens）".into());
            }
            args.push(flag.to_string());
            args.push(format!("{v}"));
        }
    }
    if let Some(code) = currency {
        let code = code.trim();
        if !code.is_empty() {
            args.push("--currency".to_string());
            args.push(code.to_string());
        }
    }
    run_cli_json(app, &args, "设置自定义价格失败").await
}

/// Remove a custom model price. Returns the updated pricing status JSON.
pub async fn unset_custom_price(app: &AppHandle, model: &str) -> Result<Value, String> {
    let args = vec!["prices".to_string(), "unset".to_string(), model.to_string()];
    run_cli_json(app, &args, "删除自定义价格失败").await
}

/// Show/set the display currency (`prices currency [CODE]`).
pub async fn set_display_currency(app: &AppHandle, code: &str) -> Result<Value, String> {
    let args = vec!["prices".to_string(), "currency".to_string(), code.to_string()];
    run_cli_json(app, &args, "设置显示货币失败").await
}

/// Set a currency exchange rate (`prices rate <CODE> <perUSD>`).
pub async fn set_currency_rate(app: &AppHandle, code: &str, per_usd: f64) -> Result<Value, String> {
    if !per_usd.is_finite() || per_usd <= 0.0 {
        return Err("汇率必须为正数字（1 USD = ? 该货币）".into());
    }
    let args = vec![
        "prices".to_string(),
        "rate".to_string(),
        code.to_string(),
        format!("{per_usd}"),
    ];
    run_cli_json(app, &args, "设置汇率失败").await
}

async fn run_cli_json(app: &AppHandle, args: &[String], context: &str) -> Result<Value, String> {
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
        .args(args)
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

    let mut child = cmd.spawn().map_err(|e| format!("{context}: {e}"))?;
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
        _ = tokio::time::sleep(CLI_TIMEOUT) => {
            process_utils::kill_child_tree(&mut child);
            return Err(format!("{context}超时"));
        }
    };

    let ((stdout, stderr), status) = combined;
    let status = status.map_err(|e| format!("{context}: {e}"))?;
    if !status.success() {
        let msg = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let first = msg.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("{context}: {first}"));
    }

    // The CLI may print dim warnings on stderr; stdout must be pure JSON.
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("{context}: 数据异常 ({e})"))
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
