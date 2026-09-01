//! Tauri commands — the app's entire invoke surface (see src/lib/api.ts).

use crate::services::usage_reader::{self, UsageQuery};
use crate::services::{auto_launch, rate_limits, sync_engine, updater};
use crate::state::{AppCtx, AppSettings, SyncState, UpdateInfo};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use vibe_core::ProviderRateLimit;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    configured: bool,
    version: String,
    is_dev: bool,
    runtime_available: bool,
    /// Path of the local usage store (shown in settings; data never leaves it).
    store_path: String,
    hostname: Option<String>,
}

#[tauri::command]
pub fn get_app_status(app: AppHandle) -> AppStatus {
    let ctx = app.state::<AppCtx>();
    let config = ctx.config.load();
    AppStatus {
        configured: ctx.config.is_configured(),
        version: app.package_info().version.to_string(),
        is_dev: crate::state::IS_DEV,
        runtime_available: sync_engine::detect_runtime(&app).is_some(),
        store_path: ctx
            .config
            .store_path()
            .to_string_lossy()
            .into_owned(),
        hostname: config.as_ref().and_then(|c| c.hostname.clone()),
    }
}

#[tauri::command]
pub async fn fetch_usage(app: AppHandle, query: UsageQuery) -> Result<Value, String> {
    usage_reader::fetch_usage(&app, &query).await
}

// -- Pricing ----------------------------------------------------------------------

/// Price-table status from the vendored CLI (`prices` command): active layer
/// (snapshot/cache/refreshed), freshness, model coverage, and — with
/// `force` — the outcome of a manual refresh attempt.
#[tauri::command]
pub async fn get_pricing_status(app: AppHandle, force: bool) -> Result<Value, String> {
    usage_reader::fetch_pricing_status(&app, force).await
}

// -- Custom prices ---------------------------------------------------------------

/// Add or partially override a custom model price. Either an average price
/// (one price for all token categories) or per-field values, in the given
/// currency (default USD) per million tokens. Returns the updated status.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_custom_price(
    app: AppHandle,
    model: String,
    avg_per_m: Option<f64>,
    input_per_m: Option<f64>,
    output_per_m: Option<f64>,
    cache_read_per_m: Option<f64>,
    currency: Option<String>,
) -> Result<Value, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    usage_reader::set_custom_price(
        &app,
        &model,
        avg_per_m,
        input_per_m,
        output_per_m,
        cache_read_per_m,
        currency.as_deref(),
    )
    .await
}

/// Remove a custom model price. Returns the updated pricing status.
#[tauri::command]
pub async fn remove_custom_price(app: AppHandle, model: String) -> Result<Value, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    usage_reader::unset_custom_price(&app, &model).await
}

/// Pull community model prices (merges into custom prices; local entries
/// win unless `force`). Returns the updated pricing status.
#[tauri::command]
pub async fn pull_community_prices(app: AppHandle, force: bool) -> Result<Value, String> {
    usage_reader::pull_community_prices(&app, force).await
}

/// Set the display currency (summary/dashboard rendering). Returns the
/// updated pricing status.
#[tauri::command]
pub async fn set_display_currency(app: AppHandle, currency: String) -> Result<Value, String> {
    let code = currency.trim().to_string();
    if code.is_empty() {
        return Err("货币代码不能为空".into());
    }
    usage_reader::set_display_currency(&app, &code).await
}

/// Set a currency exchange rate (1 USD = ? CODE). Returns the updated
/// pricing status.
#[tauri::command]
pub async fn set_currency_rate(
    app: AppHandle,
    currency: String,
    per_usd: f64,
) -> Result<Value, String> {
    let code = currency.trim().to_string();
    if code.is_empty() {
        return Err("货币代码不能为空".into());
    }
    usage_reader::set_currency_rate(&app, &code, per_usd).await
}

// -- Sync ---------------------------------------------------------------------

#[tauri::command]
pub fn trigger_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        sync_engine::run_sync(app).await;
    });
}

#[tauri::command]
pub fn get_sync_state(app: AppHandle) -> SyncState {
    app.state::<AppCtx>().sync_state.lock().unwrap().clone()
}

// -- Rate limits ----------------------------------------------------------------

#[tauri::command]
pub async fn get_rate_limits(app: AppHandle, force: bool) -> Vec<ProviderRateLimit> {
    rate_limits::get_rate_limits(&app, force).await
}

#[tauri::command]
pub async fn enable_claude_rate_limit(app: AppHandle) -> Result<Vec<ProviderRateLimit>, String> {
    rate_limits::enable_claude(&app).await
}

// -- Settings -------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppSettings {
    app.state::<AppCtx>().settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: AppSettings) {
    let claude_was_enabled = {
        let ctx = app.state::<AppCtx>();
        let mut current = ctx.settings.lock().unwrap();
        let was = current.claude_rate_limit_enabled;
        *current = settings.clone();
        was
    };
    let ctx = app.state::<AppCtx>();
    ctx.save_settings();

    // Disabling Claude capture restores the user's original statusline.
    if claude_was_enabled && !settings.claude_rate_limit_enabled {
        let _ = rate_limits::statusline_hook(&app).uninstall();
    }
    let _ = app.emit("settings-updated", &settings);
    crate::tray::update_tray(&app);
}

#[tauri::command]
pub fn get_launch_at_login() -> Result<bool, String> {
    auto_launch::get()
}

#[tauri::command]
pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    auto_launch::set(enabled)
}

/// 重置: delete config + local usage store, then rebuild from raw tool logs
/// right away (offline — no relink step). Keeps the Codex parser cache.
#[tauri::command]
pub fn reset_config(app: AppHandle) -> Result<(), String> {
    let ctx = app.state::<AppCtx>();
    ctx.config.reset().map_err(|e| e.to_string())?;
    *ctx.tray_stats.lock().unwrap() = None;
    crate::tray::update_tray(&app);
    // Rebuild immediately so the dashboard doesn't sit empty until the next
    // 30-minute tick.
    tauri::async_runtime::spawn(async move {
        sync_engine::run_sync(app).await;
    });
    Ok(())
}

// -- Shell / windows ---------------------------------------------------------------

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅允许打开 http(s) 链接".into());
    }
    crate::process_utils::shell_open(&url)
}

pub fn open_settings_impl(app: &AppHandle) {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return;
    }
    // The packaged app declares a hidden settings window in tauri.conf.json so
    // WebView has loaded before the tray menu asks to show it. Keep this as a
    // recovery path in case the window was closed by the platform.
    // Keep the app URL query-free here: packaged asset loading treats the
    // whole string as an app resource path on some WebView/Tauri versions.
    let result = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html".into()),
    )
        .title("Vibe Usage 设置")
        .inner_size(460.0, 620.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .build();
    if let Err(e) = result {
        log::error!("settings window: {e}");
    }
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    open_settings_impl(&app);
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    crate::panel::hide_now(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// -- Tray ------------------------------------------------------------------------

/// Pushed by the frontend after each fetch/range change: cost + tokens for
/// the ACTIVE time range (no filters) — mirrors menuBarCost/menuBarTokens.
#[tauri::command]
pub fn update_tray_stats(app: AppHandle, cost: f64, tokens: i64) {
    {
        let ctx = app.state::<AppCtx>();
        *ctx.tray_stats.lock().unwrap() = Some((cost, tokens));
    }
    crate::tray::update_tray(&app);
}

// -- Updates -----------------------------------------------------------------------

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    updater::check(&app).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}
