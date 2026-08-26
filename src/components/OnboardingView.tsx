// Unconfigured / first-run view — offline onboarding.
// No account, no login: "开始使用" runs the first local import and the
// dashboard appears as soon as the CLI has captured a hostname.

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, onSyncState } from "../lib/api";
import { useAppState } from "../state/AppStateContext";

export function OnboardingView() {
  const state = useAppState();
  const [initializing, setInitializing] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const busyRef = useRef(false);
  busyRef.current = initializing;

  useEffect(() => {
    const sub = onSyncState(async (s) => {
      if (!busyRef.current) return;
      if (s.status === "success") {
        setInitializing(false);
        setSetupError(null);
        await state.markConfigured();
      } else if (s.status === "error") {
        setInitializing(false);
        setSetupError(s.message ?? "初始化失败");
      }
    });
    return () => {
      void sub.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startInitialImport = async () => {
    setSetupError(null);
    setInitializing(true);
    try {
      await api.triggerSync();
    } catch (err) {
      setInitializing(false);
      setSetupError(`启动本地统计失败：${String(err)}`);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-4 pb-2 pt-3">
        <span className="text-[15px] font-bold text-white">Vibe Usage</span>
        {state.status?.isDev && (
          <span
            className="rounded-[3px] px-1 py-px font-mono text-[10px] font-bold text-orange-400"
            style={{ background: "rgba(251,146,60,0.15)" }}
          >
            DEBUG
          </span>
        )}
      </div>
      <div className="h-px bg-card-border" />

      <div className="flex flex-col gap-4 p-4">
        <div
          className="flex items-start gap-2 rounded-card border border-card-border px-2.5 py-2"
          style={{ background: "#0F0F0F" }}
        >
          <ShieldCheck size={12} color="#808080" className="mt-0.5 shrink-0" />
          <span className="text-xs" style={{ color: "#B3B3B3" }}>
            完全本地统计：数据保存在本机（~/.vibe-usage），无需账号，不上传任何内容
          </span>
        </div>

        <div className="flex flex-col gap-1 text-xs" style={{ color: "#8C8C8C" }}>
          <span>· 自动检测已安装的 AI 编程工具（Claude Code、Codex、Grok 等）</span>
          <span>· 从本地日志统计 Token 用量与费用（本地价格表估算）</span>
          <span>· 后台每 30 分钟自动更新</span>
        </div>

        {setupError && <div className="text-xs text-red-500">{setupError}</div>}

        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-white py-2 text-[13px] font-medium text-black disabled:opacity-80"
          disabled={initializing}
          onClick={() => void startInitialImport()}
        >
          {initializing && <div className="spinner spinner-dark h-3 w-3" />}
          {initializing ? "正在统计本地数据…" : "开始使用"}
        </button>
      </div>
    </div>
  );
}
