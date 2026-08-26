// Settings window — port of Views/SettingsView.swift (grouped Form, 420px
// content in a 460×620 window). macOS's "在 Dock 中显示" has no Windows
// equivalent (no Dock) and is intentionally omitted.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { api, onSyncState } from "./lib/api";
import { AppSettings, AppStatus, PricingStatus, SyncState } from "./lib/types";
import { formatRelativeTime } from "./lib/formatters";

export function SettingsApp() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle" });
  const [autoStart, setAutoStart] = useState(false);

  const [pricing, setPricing] = useState<PricingStatus | null>(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingMessage, setPricingMessage] = useState<string | null>(null);
  const [pricingMessageIsError, setPricingMessageIsError] = useState(false);

  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextStatus, nextSettings, nextSyncState, nextAutoStart, nextPricing] =
      await Promise.allSettled([
        api.getAppStatus(),
        api.getSettings(),
        api.getSyncState(),
        api.getLaunchAtLogin(),
        api.getPricingStatus(false),
      ]);

    if (nextStatus.status === "fulfilled") setStatus(nextStatus.value);
    if (nextSettings.status === "fulfilled") setSettings(nextSettings.value);
    if (nextSyncState.status === "fulfilled") setSyncState(nextSyncState.value);
    if (nextAutoStart.status === "fulfilled") setAutoStart(nextAutoStart.value);
    if (nextPricing.status === "fulfilled") setPricing(nextPricing.value);
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    void reload();
    const subs = [
      onSyncState(setSyncState),
    ];
    return () => {
      for (const p of subs) void p.then((un) => un());
    };
  }, [reload]);

  const patchSettings = (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void api.setSettings(next);
  };

  const toggleCodexQuota = (enabled: boolean) => {
    setQuotaError(null);
    patchSettings({ codexRateLimitEnabled: enabled });
  };

  const toggleClaudeQuota = async (enabled: boolean) => {
    if (!settings) return;
    setQuotaError(null);
    if (!enabled) {
      patchSettings({ claudeRateLimitEnabled: false });
      return;
    }

    setSettings({ ...settings, claudeRateLimitEnabled: true });
    try {
      await api.enableClaudeRateLimit();
      await reload();
    } catch (err) {
      setSettings({ ...settings, claudeRateLimitEnabled: false });
      setQuotaError(String(err));
    }
  };

  const toggleAutoStart = (enabled: boolean) => {
    setAutoStart(enabled);
    void api.setLaunchAtLogin(enabled);
  };

  const resetConfig = async () => {
    setShowResetConfirm(false);
    await api.resetConfig();
    await reload();
  };

  const checkUpdate = async () => {
    setUpdateMessage("检查中…");
    try {
      const info = await api.checkForUpdate();
      setUpdateMessage(info ? `发现新版本 ${info.version}` : "已是最新版本");
    } catch (err) {
      setUpdateMessage(`检查失败: ${String(err)}`);
    }
  };

  const refreshPricing = async () => {
    setPricingBusy(true);
    setPricingMessage(null);
    try {
      const next = await api.getPricingStatus(true);
      setPricing(next);
      if (next.refresh.ok) {
        setPricingMessageIsError(false);
        setPricingMessage(`已更新 · ${next.modelCount} 个模型`);
      } else {
        setPricingMessageIsError(true);
        setPricingMessage(
          `刷新失败: ${next.refresh.error ?? "未知错误"}（当前使用${pricingSourceLabel(next.source)}）`,
        );
      }
    } catch (err) {
      setPricingMessageIsError(true);
      setPricingMessage(`刷新失败: ${String(err)}`);
    } finally {
      setPricingBusy(false);
    }
  };

  return (
    <div
      className="h-screen overflow-hidden font-sans text-[13px]"
      style={{ background: "#1C1C1E", color: "#E8E8E8" }}
    >
      <div className="no-scrollbar mx-auto flex h-full max-w-[430px] flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* 同步 */}
        <Section title="同步">
          <Row label="模式">
            <span className="text-xs" style={{ color: "#808080" }}>
              完全本地 · 数据不上传
            </span>
          </Row>
          <Row label="状态">
            <span className="flex items-center gap-1 text-xs" style={{ color: "#B0B0B0" }}>
              {syncState.status === "syncing" ? (
                <>
                  <div className="spinner h-3 w-3" /> 同步中...
                </>
              ) : syncState.status === "error" ? (
                <>
                  <AlertCircle size={13} color="#EF4444" />
                  <span className="max-w-[260px] truncate">{syncState.message ?? "错误"}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} color="#34C759" />
                  {syncState.status === "success" ? "同步成功" : "正常"}
                </>
              )}
            </span>
          </Row>
          {syncState.lastSyncAt && (
            <Row label="上次同步">
              <span className="text-xs" style={{ color: "#9E9E9E" }}>
                {formatRelativeTime(new Date(syncState.lastSyncAt))}
              </span>
            </Row>
          )}
          <Row label="数据位置">
            <span
              className="max-w-[220px] truncate font-mono text-xs"
              style={{ color: "#9E9E9E" }}
              title={status?.storePath}
            >
              {status?.storePath ?? ""}
            </span>
          </Row>
        </Section>

        {/* 价格表 */}
        <Section title="价格表" footer="费用由本地价格表估算；无价格的模型仅统计 tokens，不计入费用">
          <Row label="来源">
            <span
              className="text-xs"
              style={{ color: pricing?.source === "refreshed" ? "#34C759" : "#B0B0B0" }}
            >
              {pricing ? pricingSourceLabel(pricing.source) : "…"}
            </span>
          </Row>
          <Row label="更新时间">
            <span className="text-xs" style={{ color: "#9E9E9E" }}>
              {pricing
                ? `${formatRelativeTime(new Date(pricing.fetchedAt))} · ${pricing.modelCount} 个模型`
                : ""}
            </span>
          </Row>
          {pricing && pricing.coverage.usedModelCount > 0 && (
            <Row label="模型覆盖">
              <span
                className="max-w-[220px] text-right text-xs"
                style={{ color: "#9E9E9E" }}
                title={
                  pricing.coverage.unpricedModels.length > 0
                    ? `无价格: ${pricing.coverage.unpricedModels.join(", ")}`
                    : "已使用的模型均有价格"
                }
              >
                {pricing.coverage.pricedModels.length}/{pricing.coverage.usedModelCount} 已覆盖
              </span>
            </Row>
          )}
          <Row label="网络刷新">
            <div className="flex items-center gap-2">
              {pricingMessage && (
                <span
                  className="max-w-[230px] text-xs"
                  style={{ color: pricingMessageIsError ? "#EF4444" : "#9E9E9E" }}
                >
                  {pricingMessage}
                </span>
              )}
              <SmallButton
                disabled={pricingBusy || !!pricing?.offline}
                onClick={() => void refreshPricing()}
              >
                {pricingBusy ? "刷新中…" : "立即刷新"}
              </SmallButton>
            </div>
          </Row>
          {pricing?.offline && (
            <div className="px-3 py-2 text-[11px]" style={{ color: "#737373" }}>
              离线模式已启用（VIBE_USAGE_OFFLINE=1），网络刷新被禁用
            </div>
          )}
          {pricing && pricing.coverage.unpricedModels.length > 0 && (
            <div className="break-words px-3 py-2 text-[11px]" style={{ color: "#737373" }}>
              无价格数据（不计入费用）: {unpricedSummary(pricing)}
            </div>
          )}
        </Section>

        {/* 订阅配额 */}
        <Section title="订阅配额">
          <Row label="显示 Codex 订阅配额">
            <Toggle
              checked={settings?.codexRateLimitEnabled ?? true}
              onChange={toggleCodexQuota}
            />
          </Row>
          <Row label="显示 Claude Code 订阅配额">
            <Toggle
              checked={settings?.claudeRateLimitEnabled ?? false}
              onChange={(v) => void toggleClaudeQuota(v)}
            />
          </Row>
          {quotaError && (
            <div className="px-3 py-2 text-xs text-red-400" style={{ borderColor: "#3A3A3C" }}>
              {quotaError}
            </div>
          )}
        </Section>

        {/* 托盘 (macOS: 菜单栏) */}
        <Section title="托盘" footer="完整费用和 Token 用量显示在托盘悬停提示中">
          <Row label="托盘显示费用">
            <Toggle
              checked={settings?.showCostInTray ?? true}
              onChange={(v) => patchSettings({ showCostInTray: v })}
            />
          </Row>
          <Row label="托盘显示 Token">
            <Toggle
              checked={settings?.showTokensInTray ?? false}
              onChange={(v) => patchSettings({ showTokensInTray: v })}
            />
          </Row>
        </Section>

        {/* 通用 */}
        <Section title="通用">
          <Row label="开机自启动">
            <Toggle checked={autoStart} onChange={toggleAutoStart} />
          </Row>
        </Section>

        {/* 关于 */}
        <Section title="关于">
          <Row label="版本">
            <span className="text-xs" style={{ color: "#9E9E9E" }}>
              {status?.version ?? ""}
            </span>
          </Row>
          <Row label="检查更新">
            <div className="flex items-center gap-2">
              {updateMessage && (
                <span className="text-xs" style={{ color: "#9E9E9E" }}>
                  {updateMessage}
                </span>
              )}
              <SmallButton onClick={() => void checkUpdate()}>检查更新</SmallButton>
            </div>
          </Row>
        </Section>

        {/* Danger zone */}
        <Section>
          {!showResetConfirm ? (
            <Row label="">
              <button className="text-[13px] text-red-400" onClick={() => setShowResetConfirm(true)}>
                重置本地数据
              </button>
            </Row>
          ) : (
            <div className="flex flex-col gap-2 px-3 py-2.5">
              <span className="text-xs" style={{ color: "#B0B0B0" }}>
                确定要重置本地数据吗？将删除已统计的用量并立即从本地日志重新统计（不会删除工具日志）。
              </span>
              <div className="flex justify-end gap-2">
                <SmallButton onClick={() => setShowResetConfirm(false)}>取消</SmallButton>
                <button
                  className="rounded-md bg-red-500 px-3 py-1 text-xs font-medium text-white"
                  onClick={() => void resetConfig()}
                >
                  重置
                </button>
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {title && (
        <span className="px-2 text-xs font-medium" style={{ color: "#8C8C8C" }}>
          {title}
        </span>
      )}
      <div
        className="flex flex-col divide-y rounded-[10px]"
        style={{ background: "#2A2A2C", borderColor: "#3A3A3C" }}
      >
        {children}
      </div>
      {footer && (
        <span className="px-2 text-[11px]" style={{ color: "#737373" }}>
          {footer}
        </span>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-[38px] items-center justify-between gap-3 px-3 py-1.5"
      style={{ borderColor: "#3A3A3C" }}
    >
      <span className="shrink-0 text-[13px]">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-150"
      style={{ background: checked ? "#34C759" : "#48484A" }}
    >
      <span
        className="absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all duration-150"
        style={{ left: checked ? 18 : 2 }}
      />
    </button>
  );
}

function SmallButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
      style={{ background: "#48484A", color: "#E8E8E8" }}
    >
      {children}
    </button>
  );
}

function pricingSourceLabel(source: PricingStatus["source"]): string {
  switch (source) {
    case "refreshed":
      return "最新价格表";
    case "cache":
      return "本地缓存";
    case "snapshot":
      return "内置快照";
  }
}

function unpricedSummary(pricing: PricingStatus): string {
  const models = pricing.coverage.unpricedModels;
  const shown = models.slice(0, 6);
  const extra = models.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` 等 ${extra} 个` : "");
}
