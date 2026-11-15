# Codex Input Unlock — Multi-Window Edition

Windows 版 Codex Desktop / ChatGPT Desktop 的**外部运行时输入解锁工具**（多窗口增强版）。

当你同时登录了官方账号并配置第三方 API Provider，官方账号额度耗尽时，客户端前端会把输入框和发送按钮整体锁死，还会在窗口顶部挂一条"额度已用完"的促销横幅——此时即使切换到可用的 API 模型也无法发送，只能退出重登纯 API 模式。

本项目基于 [1zero224/codex-input-unlock](https://github.com/1zero224/codex-input-unlock)（MIT），通过 Chrome DevTools Protocol (CDP) 在渲染层把额度数据改写为"可用"，**解除本地前端的发送封锁，并移除额度横幅**，全程不修改官方安装包。

> 相比上游的关键增强：Codex Desktop 的每个窗口（主窗口、`Ctrl+Alt+C` 全局热键小窗、独立弹出窗口）都是独立的 CDP page target，各有独立的 React Query 缓存。上游监督器只 attach 排名最高的一个 target，导致小窗/弹窗内额度状态未被改写、发送按钮依然锁定。本版**轮询发现并注入所有 `app://` 页面 target**，新窗口出现后数秒内自动补注入，页面刷新后也会自动重新注入。

---

## 功能

- 解除输入框 / 发送按钮的额度封锁（`rate_limit.allowed`、`limit_reached` 等）
- 移除"额度已用完"横幅与 upsell 弹层（`rate_limit_upsell`、`model_picker_upsell` 置空）
- **多窗口**：主窗口 + 全局热键小窗 + 独立弹窗全部覆盖
- **增量注入**：运行中新开的窗口自动被发现并注入，无需重启
- **刷新自愈**：页面 reload 后自动重新注入
- 健壮性：状态文件原子写入（多 target 并发安全、磁盘满不致命）、单个畸形 target 不阻塞其他窗口

## 工作原理

```text
PowerShell 控制器 (codex-input-unlock.ps1)
  ├─ 定位官方 Store 包，分配随机 TCP 调试端口
  └─ 冷启动 Node.js CDP 守护进程 + 带调试参数的客户端
                        │
                        ▼
CDP 守护进程 (cdp-supervisor.mjs + quota-net-patch.cjs)
  ├─ 每秒轮询 /json，发现所有 app:// page target（主窗口 rank=100，其余 rank=80）
  ├─ 为每个 target 建立 worker：注入网络层补丁 + 注入前预注册（新文档立即可用）
  │    ├─ 挂钩 Response / fetch / XMLHttpRequest
  │    ├─ 挂钩 TanStack Query（rate-limit-status）覆盖 push 通道与旧缓存
  │    └─ 额度载荷改写：allowed=true、limit_reached=false、upsell 置空、
  │       清除发送类 blocked_features（图片生成额度保留）
  ├─ 每 2s 探测补丁存活，失败自动重连重注入
  └─ 聚合所有 target 状态写入 status JSON（原子写）
```

## 环境要求

- Windows 10 / 11 (x64 / ARM64)
- Microsoft Store 版 Codex Desktop 或 ChatGPT Desktop
- PowerShell 7+ (`pwsh`) 与 Node.js 22+

## 快速上手

### 使用前配置

在 `~/.codex/config.toml` 中配置好可用的第三方 Provider。若需保留官方账号登录状态，在对应 Provider 配置中设置：

```toml
requires_openai_auth = true
```

并在 Codex Desktop 中登录官方账号。

### 1. 安装

在源码目录打开 PowerShell 7：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\codex-input-unlock.ps1' -Action Install
```

安装会将运行文件复制到 `%LOCALAPPDATA%\OpenAI\CodexInputUnlock`，并在开始菜单创建 **Codex Input Unlock** 快捷方式。

### 2. 启动

> 启动前请**完全退出**正在运行的 Codex Desktop（包括托盘图标）；启动器检测到客户端仍在运行会等待而不是强杀。

- **方式 A（推荐）**：开始菜单点击 **Codex Input Unlock**
- **方式 B（命令行）**：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
  -Action Launch
```

> 直接点击官方原生图标启动不带调试参数，不会加载解锁逻辑。

### 3. 验证

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
  -Action Verify
```

`RuntimeReady : True` 表示守护进程就绪、网络层补丁已挂载。也可以查看状态 JSON（`%LOCALAPPDATA%\OpenAI\CodexInputUnlock\state\` 下最新的 `launcher-status-*.json`）：`targetCount` / `readyCount` 反映已发现和已就绪的窗口数。

## 自检（无需 Codex）

```powershell
node cdp-supervisor.mjs --self-test-net --net-patch quota-net-patch.cjs
# 期望输出 {"ok":true,...}，验证补丁对"额度耗尽"样例载荷的改写效果
```

## 常用命令

| Action | 说明 |
| :--- | :--- |
| `-Action Diagnose` | 诊断环境依赖、已安装包状态与文件完整性 |
| `-Action Install` | 安装运行文件到 `%LOCALAPPDATA%` 并创建开始菜单快捷方式 |
| `-Action Launch` | 冷启动客户端 + CDP 守护进程 |
| `-Action Verify` | 检查守护进程存活、CDP 连通性与注入状态 |
| `-Action Inspect` | 输出网络监听、进程树与最近日志的详细诊断 JSON |
| `-Action Uninstall` | 移除运行文件与快捷方式 |

## 已知边界

- 逐轮对话内已渲染的"已达上限"提示存在于会话状态中，网络补丁无法回溯移除。
- 客户端大版本更新可能改变 bundle 结构；网络层补丁基于字段名改写，通常仍可用，极端情况需等适配。
- 需要经由本工具启动客户端（带 `--remote-debugging-*` 参数）；原生图标启动不生效。

## 免责声明

本项目仅供本地自动化研究/辅助使用，与 OpenAI 无关、亦不受 OpenAI 认可。请自行评估与 OpenAI 服务条款的合规性，使用风险自负。

## 致谢与许可

基于 [1zero224/codex-input-unlock](https://github.com/1zero224/codex-input-unlock)（MIT）分叉增强，详见 [ATTRIBUTION.md](ATTRIBUTION.md)。本项目同样以 [MIT License](LICENSE) 发布。
