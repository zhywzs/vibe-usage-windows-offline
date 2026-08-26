// Header — port of PopoverView.headerBar (offline: dashboard links removed).

import { api } from "../lib/api";
import { useAppState } from "../state/AppStateContext";

export function HeaderBar() {
  const { status } = useAppState();

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[15px] font-bold text-white">Vibe Usage</span>
        {status?.isDev && (
          <span
            className="rounded-[3px] px-1 py-px font-mono text-[10px] font-bold text-orange-400"
            style={{ background: "rgba(251,146,60,0.15)" }}
          >
            DEBUG
          </span>
        )}
      </div>

      <div className="grow" />

      <button className="header-btn" onClick={() => void api.openSettingsWindow()} style={btnStyle}>
        设置
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#808080",
  padding: "4px 8px",
  background: "rgba(255,255,255,0.12)",
  borderRadius: 4,
  border: "0.5px solid rgba(255,255,255,0.18)",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  lineHeight: 1.2,
};
