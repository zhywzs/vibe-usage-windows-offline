// Settings window — port of Views/SettingsView.swift (grouped Form, 420px
// content in a 460×620 window). macOS's "在 Dock 中显示" has no Windows
// equivalent (no Dock) and is intentionally omitted.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { api, onSyncState } from "./lib/api";
import { AppSettings, AppStatus, CustomPriceEntry, PricingStatus, SyncState } from "./lib/types";
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
  const [priceEditor, setPriceEditor] = useState<{
    origModel: string | null;
    model: string;
    mode: "avg" | "detailed";
    currency: string;
    avg: string;
    input: string;
    output: string;
    cacheRead: string;
  } | null>(null);
  const [priceEditError, setPriceEditError] = useState<string | null>(null);
  const [priceBusy, setPriceBusy] = useState(false);
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [rateEditError, setRateEditError] = useState<string | null>(null);

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

  const saveCustomPrice = async () => {
    if (!priceEditor) return;
    setPriceEditError(null);
    const model = priceEditor.model.trim();
    if (!model) {
      setPriceEditError("模型名不能为空");
      return;
    }
    const parseField = (raw: string, label: string): number | null => {
      const t = raw.trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${label}价格无效: ${t}`);
      return n;
    };
    let avg: number | null = null;
    let input: number | null = null;
    let output: number | null = null;
    let cacheRead: number | null = null;
    try {
      if (priceEditor.mode === "avg") {
        avg = parseField(priceEditor.avg, "平均");
      } else {
        input = parseField(priceEditor.input, "输入");
        output = parseField(priceEditor.output, "输出");
        cacheRead = parseField(priceEditor.cacheRead, "缓存读");
      }
    } catch (err) {
      setPriceEditError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (avg === null && input === null && output === null && cacheRead === null) {
      setPriceEditError(priceEditor.mode === "avg" ? "请填写平均价格" : "至少填写一个价格");
      return;
    }
    setPriceBusy(true);
    try {
      const next = await api.setCustomPrice(model, {
        avgPerM: avg,
        inputPerM: input,
        outputPerM: output,
        cacheReadPerM: cacheRead,
        currency: priceEditor.currency,
      });
      setPricing(next);
      setPriceEditor(null);
      setPricingMessageIsError(false);
      setPricingMessage(`已保存 ${model} 的自定义价格`);
    } catch (err) {
      setPriceEditError(String(err));
    } finally {
      setPriceBusy(false);
    }
  };

  const setDisplayCurrency = async (code: string) => {
    if (!pricing || code === pricing.currency.code) return;
    setPricingBusy(true);
    setPricingMessage(null);
    try {
      const next = await api.setDisplayCurrency(code);
      setPricing(next);
      setPricingMessageIsError(false);
      setPricingMessage(`显示货币已切换为 ${code}`);
    } catch (err) {
      setPricingMessageIsError(true);
      setPricingMessage(String(err));
    } finally {
      setPricingBusy(false);
    }
  };

  const saveCurrencyRate = async (code: string, raw: string) => {
    setRateEditError(null);
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n <= 0) {
      setRateEditError(`汇率无效: ${raw}（应为正数字，含义 1 USD = ? ${code}）`);
      return;
    }
    setPricingBusy(true);
    setPricingMessage(null);
    try {
      const next = await api.setCurrencyRate(code, n);
      setPricing(next);
      setRateDraft(null);
      setPricingMessageIsError(false);
      setPricingMessage(`已设置 1 USD = ${n} ${code}`);
    } catch (err) {
      setRateEditError(String(err));
    } finally {
      setPricingBusy(false);
    }
  };

  const removeCustomPrice = async (model: string) => {
    setPricingMessage(null);
    setPricingBusy(true);
    try {
      const next = await api.removeCustomPrice(model);
      setPricing(next);
      setPricingMessageIsError(false);
      setPricingMessage(`已删除 ${model} 的自定义价格`);
    } catch (err) {
      setPricingMessageIsError(true);
      setPricingMessage(String(err));
    } finally {
      setPricingBusy(false);
    }
  };

  const pullCommunityPrices = async () => {
    setPricingMessage(null);
    setPricingBusy(true);
    try {
      const next = await api.pullCommunityPrices(false);
      setPricing(next);
      const p = next.pull;
      if (p) {
        setPricingMessageIsError(false);
        const parts = [`新增 ${p.added}`];
        if (p.skipped > 0) parts.push(`跳过 ${p.skipped}（本地已设置）`);
        if (p.overwritten > 0) parts.push(`覆盖 ${p.overwritten}`);
        setPricingMessage(`社区价格已导入：${parts.join(" · ")}，共 ${p.total} 项`);
      }
    } catch (err) {
      setPricingMessageIsError(true);
      setPricingMessage(`导入失败: ${String(err)}`);
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

          {/* 自定义价格 */}
          <Row label="自定义价格">
            <div className="flex items-center gap-2">
              {pricing && pricing.custom.length > 0 && (
                <span className="text-xs" style={{ color: "#9E9E9E" }}>
                  {pricing.custom.length} 项
                </span>
              )}
              <SmallButton
                disabled={pricingBusy || !!pricing?.offline}
                title="从本项目的 GitHub Release 拉取社区维护的模型价格（中文区常用模型），合并到本地——已设置的价格不会被覆盖"
                onClick={() => void pullCommunityPrices()}
              >
                {pricingBusy ? "导入中…" : "导入社区价格"}
              </SmallButton>
              <SmallButton
                onClick={() =>
                  setPriceEditor({
                    origModel: null,
                    model: "",
                    mode: "avg",
                    currency: pricing?.currency.code ?? "USD",
                    avg: "",
                    input: "",
                    output: "",
                    cacheRead: "",
                  })
                }
              >
                添加
              </SmallButton>
            </div>
          </Row>
          {pricing?.custom.map((entry) => (
            <div
              key={entry.model}
              className="flex min-h-[38px] items-center justify-between gap-3 px-3 py-1.5"
              style={{ borderColor: "#3A3A3C" }}
            >
              <span
                className="min-w-0 truncate font-mono text-xs"
                style={{ color: "#E8E8E8" }}
                title={entry.model}
              >
                {entry.model}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className="text-xs"
                  style={{ color: "#9E9E9E" }}
                  title={customEntryTitle(entry)}
                >
                  {entry.mode === "avg"
                    ? `均价 ${fmtPrice(entry.avgPerM, entry.currency)}`
                    : `${fmtPrice(entry.inputPerM, entry.currency)} / ${fmtPrice(entry.outputPerM, entry.currency)}`}
                </span>
                <SmallButton
                  onClick={() =>
                    setPriceEditor({
                      origModel: entry.model,
                      model: entry.model,
                      mode: entry.mode,
                      currency: entry.currency,
                      avg: entry.avgPerM?.toString() ?? "",
                      input: entry.inputPerM?.toString() ?? "",
                      output: entry.outputPerM?.toString() ?? "",
                      cacheRead: entry.cacheReadPerM?.toString() ?? "",
                    })
                  }
                >
                  编辑
                </SmallButton>
                <SmallButton onClick={() => void removeCustomPrice(entry.model)}>删除</SmallButton>
              </div>
            </div>
          ))}
          {priceEditor && (
            <div className="flex flex-col gap-2 px-3 py-2.5" style={{ background: "#1C1C1E" }}>
              <div className="flex gap-2">
                <input
                  value={priceEditor.model}
                  disabled={!!priceEditor.origModel}
                  placeholder="模型名，如 glm-5.3"
                  onChange={(e) => setPriceEditor({ ...priceEditor, model: e.target.value })}
                  className="min-w-0 grow rounded-md px-2 py-1 font-mono text-xs outline-none"
                  style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
                />
                <select
                  value={priceEditor.currency}
                  onChange={(e) => setPriceEditor({ ...priceEditor, currency: e.target.value })}
                  className="rounded-md px-1.5 py-1 text-xs outline-none"
                  style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
                >
                  {CURRENCY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-1.5">
                {(
                  [
                    ["平均价", "avg"],
                    ["分项", "detailed"],
                  ] as const
                ).map(([label, mode]) => (
                  <button
                    key={mode}
                    onClick={() => setPriceEditor({ ...priceEditor, mode })}
                    className="rounded-md px-2.5 py-1 text-xs"
                    style={{
                      background: priceEditor.mode === mode ? "#5A5A5C" : "#2A2A2C",
                      color: priceEditor.mode === mode ? "#E8E8E8" : "#9E9E9E",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {priceEditor.mode === "avg" ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px]" style={{ color: "#8C8C8C" }}>
                    平均价格 {priceEditor.currency}/M tokens（所有类型 token 统一计价）
                  </span>
                  <input
                    value={priceEditor.avg}
                    placeholder="—"
                    onChange={(e) => setPriceEditor({ ...priceEditor, avg: e.target.value })}
                    className="rounded-md px-2 py-1 text-xs outline-none"
                    style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
                  />
                </label>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ["输入", "input"],
                      ["输出", "output"],
                      ["缓存读", "cacheRead"],
                    ] as const
                  ).map(([label, field]) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className="text-[10px]" style={{ color: "#8C8C8C" }}>
                        {label} {priceEditor.currency}/M
                      </span>
                      <input
                        value={priceEditor[field]}
                        placeholder="—"
                        onChange={(e) => setPriceEditor({ ...priceEditor, [field]: e.target.value })}
                        className="rounded-md px-2 py-1 text-xs outline-none"
                        style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <span className="text-[10px]" style={{ color: "#737373" }}>
                单位: {priceEditor.currency}/百万 tokens。平均价对所有 token 统一计价；分项模式留空的字段沿用价格表原值（新模型则视为 0）。
                {priceEditor.currency !== "USD" &&
                  ` 当前汇率 1 USD = ${pricing?.rates[priceEditor.currency] ?? "?"} ${priceEditor.currency}`}
              </span>
              {priceEditError && <span className="text-xs text-red-400">{priceEditError}</span>}
              <div className="flex justify-end gap-2">
                <SmallButton
                  onClick={() => {
                    setPriceEditor(null);
                    setPriceEditError(null);
                  }}
                >
                  取消
                </SmallButton>
                <button
                  disabled={priceBusy}
                  onClick={() => void saveCustomPrice()}
                  className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
                >
                  {priceBusy ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          )}

          {/* 显示货币与汇率 */}
          <Row label="显示货币">
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: "#9E9E9E" }}>
                {pricing ? `${pricing.currency.symbol} ${pricing.currency.code}` : ""}
              </span>
              <select
                value={pricing?.currency.code ?? "USD"}
                disabled={!pricing}
                onChange={(e) => void setDisplayCurrency(e.target.value)}
                className="rounded-md px-1.5 py-1 text-xs outline-none"
                style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </Row>
          {pricing && pricing.currency.code !== "USD" && (
            <Row label={`汇率 (1 USD = ? ${pricing.currency.code})`}>
              <div className="flex items-center gap-2">
                <input
                  value={rateDraft ?? String(pricing.currency.rate)}
                  placeholder={String(pricing.currency.rate)}
                  onChange={(e) => setRateDraft(e.target.value)}
                  className="w-24 rounded-md px-2 py-1 text-xs outline-none"
                  style={{ background: "#0F0F0F", color: "#E8E8E8", border: "1px solid #3A3A3C" }}
                />
                <SmallButton
                  disabled={pricingBusy || rateDraft === null}
                  onClick={() => void saveCurrencyRate(pricing.currency.code, rateDraft ?? "")}
                >
                  保存汇率
                </SmallButton>
              </div>
            </Row>
          )}
          {rateEditError && (
            <div className="px-3 py-2 text-xs text-red-400">{rateEditError}</div>
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
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[11px]"
              style={{ color: "#737373" }}
            >
              <span>无价格数据（不计入费用），点击设置:</span>
              {pricing.coverage.unpricedModels.map((m) => (
                <button
                  key={m}
                  className="font-mono underline"
                  style={{ color: "#8C8C8C" }}
                  onClick={() =>
                    setPriceEditor({
                      origModel: null,
                      model: m,
                      mode: "avg",
                      currency: pricing.currency.code,
                      avg: "",
                      input: "",
                      output: "",
                      cacheRead: "",
                    })
                  }
                >
                  {m}
                </button>
              ))}
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
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
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

const CURRENCY_OPTIONS = ["USD", "CNY", "EUR", "JPY", "GBP", "HKD", "KRW", "TWD"];

function fmtPrice(v: number | null | undefined, currency: string): string {
  return v == null ? "—" : `${v} ${currency}/M`;
}

function customEntryTitle(entry: CustomPriceEntry): string {
  if (entry.mode === "avg") {
    return `平均价 ${fmtPrice(entry.avgPerM, entry.currency)}（所有 token 统一计价）`;
  }
  return `输入 ${fmtPrice(entry.inputPerM, entry.currency)} · 输出 ${fmtPrice(entry.outputPerM, entry.currency)} · 缓存读 ${fmtPrice(entry.cacheReadPerM, entry.currency)}`;
}
