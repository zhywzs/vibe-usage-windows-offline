//! `~/.vibe-usage/config.json` IO — port of Models/Config.swift + AppConfig.swift.
//! Shared contract with the CLI: both read/write the same file.
//!
//! Offline app: there is no account or API key. "Configured" means the
//! offline CLI has run once (hostname captured) or a local usage store
//! already exists.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct VibeUsageConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_extra_home: Option<String>,
}

// The CLI writes camelCase keys; keep byte-compatible. Tolerated legacy
// fields (apiKey/apiUrl from the online era) are read but never written.
impl VibeUsageConfig {
    fn to_json(&self) -> serde_json::Value {
        let mut obj = serde_json::Map::new();
        if let Some(v) = &self.hostname {
            obj.insert("hostname".into(), v.clone().into());
        }
        if let Some(v) = &self.codex_extra_home {
            obj.insert("codexExtraHome".into(), v.clone().into());
        }
        serde_json::Value::Object(obj)
    }

    fn from_json(v: &serde_json::Value) -> Self {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        VibeUsageConfig {
            api_key: s("apiKey"),
            api_url: s("apiUrl"),
            hostname: s("hostname"),
            codex_extra_home: s("codexExtraHome"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConfigManager {
    pub config_dir: PathBuf,
    pub is_dev: bool,
}

impl ConfigManager {
    pub fn new(is_dev: bool) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            config_dir: home.join(".vibe-usage"),
            is_dev,
        }
    }

    pub fn with_dir(config_dir: PathBuf, is_dev: bool) -> Self {
        Self { config_dir, is_dev }
    }

    pub fn config_file_name(&self) -> &'static str {
        if self.is_dev {
            "config.dev.json"
        } else {
            "config.json"
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.config_dir.join(self.config_file_name())
    }

    /// Mirrors the CLI's store.js dev split (usage.dev.json under
    /// VIBE_USAGE_DEV) — reset in a dev build must never touch prod data.
    pub fn store_path(&self) -> PathBuf {
        self.config_dir
            .join(if self.is_dev { "usage.dev.json" } else { "usage.json" })
    }

    /// Offline CLI parser cache (kept across resets so a rebuild doesn't
    /// require a full raw-log rescan — mirrors the CLI's reset behavior).
    pub fn cache_dir(&self) -> PathBuf {
        self.config_dir.join("cache")
    }

    pub fn load(&self) -> Option<VibeUsageConfig> {
        let raw = fs::read_to_string(self.config_path()).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        Some(VibeUsageConfig::from_json(&value))
    }

    /// Merge-save: only fields that are `Some` are written; every other key
    /// in the existing file (including ones this app doesn't know about —
    /// the file is shared with the CLI, which may add fields) is preserved.
    /// The macOS app rewrites the file with its known-field whitelist and
    /// silently drops `hostname` — we deliberately do NOT replicate that bug.
    pub fn save(&self, config: &VibeUsageConfig) -> std::io::Result<()> {
        fs::create_dir_all(&self.config_dir)?;

        let mut root = fs::read_to_string(self.config_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| match v {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();

        if let serde_json::Value::Object(ours) = config.to_json() {
            for (k, v) in ours {
                root.insert(k, v);
            }
        }

        let data = serde_json::to_string_pretty(&serde_json::Value::Object(root))?;
        atomic_write(&self.config_path(), data.as_bytes())
    }

    /// Offline semantics: ready once the CLI has captured a hostname at
    /// init/first sync, or a local usage store already exists (e.g. the
    /// user runs the standalone CLI too).
    pub fn is_configured(&self) -> bool {
        if self.load().and_then(|c| c.hostname).is_some() {
            return true;
        }
        self.store_path().is_file()
    }

    /// 重置配置: delete config AND the local usage store so the next sync
    /// rebuilds statistics from the raw tool logs. The Codex parser cache is
    /// intentionally kept (mirrors the CLI's `reset`).
    pub fn reset(&self) -> std::io::Result<()> {
        let _ = fs::remove_file(self.config_path());
        let _ = fs::remove_file(self.store_path());
        Ok(())
    }
}

/// Atomic write: temp file + rename. On Windows `rename` fails if the target
/// exists, so remove it first (delete-then-rename, same as ATM's config.rs).
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent dir"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    fs::write(&tmp, data)?;
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_camel_case_json() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        let cfg = VibeUsageConfig {
            hostname: Some("my-pc".into()),
            codex_extra_home: None,
            api_key: None,
            api_url: None,
        };
        mgr.save(&cfg).unwrap();

        let raw = std::fs::read_to_string(mgr.config_path()).unwrap();
        assert!(raw.contains("\"hostname\""), "must write camelCase: {raw}");
        assert!(!raw.contains("apiKey"), "must not write legacy online fields");

        let loaded = mgr.load().unwrap();
        assert_eq!(loaded, cfg);
        assert!(mgr.is_configured());
    }

    #[test]
    fn reads_cli_written_config() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            mgr.config_path(),
            r#"{"hostname":"host-1","codexExtraHome":"D:\\codex2"}"#,
        )
        .unwrap();
        let cfg = mgr.load().unwrap();
        assert_eq!(cfg.hostname.as_deref(), Some("host-1"));
        assert_eq!(cfg.codex_extra_home.as_deref(), Some("D:\\codex2"));
        assert!(mgr.is_configured());
    }

    #[test]
    fn configured_when_only_the_local_store_exists() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        assert!(!mgr.is_configured());
        std::fs::write(mgr.store_path(), "{}").unwrap();
        assert!(mgr.is_configured());
    }

    #[test]
    fn save_preserves_unknown_fields() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        std::fs::create_dir_all(dir.path()).unwrap();
        // CLI wrote hostname + a hypothetical future field.
        std::fs::write(
            mgr.config_path(),
            r#"{"hostname":"cli-host","futureField":{"x":1}}"#,
        )
        .unwrap();

        // App updates hostname only.
        mgr.save(&VibeUsageConfig {
            hostname: Some("app-host".into()),
            ..Default::default()
        })
        .unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(mgr.config_path()).unwrap()).unwrap();
        assert_eq!(raw["hostname"], "app-host");
        assert_eq!(raw["futureField"]["x"], 1, "unknown fields must survive");
    }

    #[test]
    fn dev_store_path_is_split() {
        let dir = tempdir().unwrap();
        let prod = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        let dev = ConfigManager::with_dir(dir.path().to_path_buf(), true);
        assert!(prod.store_path().ends_with("usage.json"));
        assert!(dev.store_path().ends_with("usage.dev.json"));
    }

    #[test]
    fn reset_removes_config_and_store_but_keeps_cache() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), false);
        mgr.save(&VibeUsageConfig {
            hostname: Some("h".into()),
            ..Default::default()
        })
        .unwrap();
        std::fs::write(mgr.store_path(), "{}").unwrap();
        std::fs::create_dir_all(mgr.cache_dir().join("codex")).unwrap();
        mgr.reset().unwrap();
        assert!(!mgr.config_path().exists());
        assert!(!mgr.store_path().exists());
        assert!(mgr.cache_dir().join("codex").is_dir(), "parser cache must survive reset");
    }

    #[test]
    fn dev_mode_uses_dev_file() {
        let dir = tempdir().unwrap();
        let mgr = ConfigManager::with_dir(dir.path().to_path_buf(), true);
        assert_eq!(mgr.config_file_name(), "config.dev.json");
    }
}
