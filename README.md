# Vibe Usage (Windows, 完全脱机版)

Windows 托盘应用，自动追踪 AI 编程工具的 Token 用量和费用。**完全本地运行：数据保存在本机（`~/.vibe-usage/usage.json`），无需账号，不上传任何内容。**

> 本仓库是 [vibe-cafe/vibe-usage-windows](https://github.com/vibe-cafe/vibe-usage-windows) 的脱机改造版：移除了 vibecafe.ai 登录/上传/仪表盘，用量统计与费用估算全部在本地完成（内置脱机版 CLI）。上游 macOS 版 [vibe-usage-app](https://github.com/vibe-cafe/vibe-usage-app) 未做脱机适配。

## 下载

从 [Releases](https://github.com/zhywzs/vibe-usage-windows-offline/releases/latest) 下载 `VibeUsage-x.y.z-Windows-Setup.exe` 并运行（per-user 安装，无需管理员权限；缺少 WebView2 时安装器会自动下载）。

## 使用

1. 打开 Vibe Usage，点击「开始使用」— 应用立即从本地日志做首次统计（无需登录、无需联网）
2. 之后每 30 分钟自动更新，也可手动「更新数据」

数据与 CLI 共享 `%USERPROFILE%\.vibe-usage\usage.json`，可与脱机版 `vibe-usage` CLI 共存。

## 功能

- 系统托盘常驻，点击托盘图标打开用量面板
- **完全离线**：解析本地工具日志 → 聚合 30 分钟 bucket → 本地存储，无任何上传
- 费用为本地估算（内置 LiteLLM 社区价格表快照，最多每 7 天静默刷新一次；离线环境自动回退快照）
- 设置页可查看价格表状态（来源/更新时间/已用模型覆盖率）并手动刷新，刷新失败会显示具体原因
- 后台每 30 分钟自动统计，也可手动「更新数据」
- 弹出窗口查看费用、总 Token、缓存 Token、趋势图表
- **订阅配额监控**：可分别显示 Codex / Claude Code 的 5 小时 / 7 天 token 配额，悬停查看消耗 vs 时间对比（读取本地文件，不上传）
- 支持今天 / 24H / 7D / 30D / 90D / 自定义日期，以及终端 / 工具 / 模型 / 项目筛选
- 可在托盘图标显示今日费用和 Token 数
- 内置脱机版 [vibe-usage](https://github.com/zhywzs/vibe-usage-offline) CLI（vibe-cafe/vibe-usage 的脱机 fork）与 Node 运行时，开箱即用，无需安装 Node.js
- 支持开机自启动、单实例、应用内检查更新

## 系统要求

- Windows 10 21H2+ / Windows 11，x64
- 无其他前置依赖（CLI 与 Node 22 运行时随应用捆绑）

## 从源码构建

```powershell
git clone https://github.com/zhywzs/vibe-usage-windows-offline.git
cd vibe-usage-windows
# 脱机 CLI 在同级目录（或用 --from-tarball 指定打包产物）
git clone https://github.com/zhywzs/vibe-usage-offline.git ../vibe-usage

# 首次：安装工具链 (Node 22 / Rust 1.88 / VS Build Tools)
pwsh -File scripts/setup-windows-build-env.ps1

pnpm install
pnpm run release:windows       # 产出 VibeUsage-<version>-Windows-Setup.exe + latest.json
```

代码签名构建可通过环境变量提供证书：

- `WINDOWS_CODESIGN_PFX_BASE64` + `WINDOWS_CODESIGN_PFX_PASSWORD`：Base64 编码的 PFX 证书及密码
- `WINDOWS_CODESIGN_CERT_THUMBPRINT`：已安装到证书库的代码签名证书 thumbprint
- `WINDOWS_CODESIGN_TIMESTAMP_URL`：可选，默认 `http://timestamp.digicert.com`

开发调试：

```powershell
node scripts/vendor-cli.mjs    # 准备内置脱机 CLI（一次即可）
pnpm tauri dev
```

## 测试

```bash
pnpm test                # 前端单测（formatters/aggregate/modelFamilies + 脱机契约守护）
cargo test --workspace   # Rust 单测（config/codex 配额/claude 配额/statusline hook/托盘字体渲染）
```

## 架构

```
前端 (React + Tailwind, WebView2)
  └─ invoke / events
Rust (Tauri 2)
  ├─ tray / panel        托盘 + 标准主窗口（显示/聚焦/隐藏到托盘）
  ├─ usage_reader        spawn node <内置CLI> usage → 本地 store JSON（替代旧 usage HTTP）
  ├─ sync_engine         spawn node <内置CLI> sync（120s 超时、CREATE_NO_WINDOW）
  ├─ scheduler           30 分钟定时统计 + 24h 应用更新检查
  ├─ rate_limit          Codex rollout JSONL / Claude statusline 捕获文件（纯本地）
  ├─ statusline_hook     写入 ~/.claude/settings.json 的 Node 包装器（自愈/备份/还原）
  └─ updater             latest.json + SHA-256 校验 + NSIS 静默升级（仅应用自身更新）
内置资源
  ├─ resources/cli       vendored 脱机版 @vibe-cafe/vibe-usage（含 Windows 补丁, scripts/vendor-cli.mjs）
  └─ resources/node      node.exe 22 LTS（scripts/fetch-node.mjs, 构建时下载）
```

网络行为（仅两处，均可选）：

1. **价格表刷新**：内置 CLI 最多每 7 天拉取一次 LiteLLM 价格表（估算费用用），失败静默回退本地快照
2. **应用更新检查**：检查 GitHub Releases 的 `latest.json`（应用自身升级，与用量数据无关）

用量数据的解析、聚合、存储、查询 **全部在本地**，绝不上传。

## 相关项目

- [vibe-usage-offline](https://github.com/zhywzs/vibe-usage-offline) — 命令行统计工具（脱机版，vibe-cafe/vibe-usage 的 fork）
- [vibe-usage-windows 上游](https://github.com/vibe-cafe/vibe-usage-windows) — 原在线版 Windows 应用

## License

MIT
