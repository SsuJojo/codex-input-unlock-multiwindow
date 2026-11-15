# 技术说明：为什么必须多窗口注入

本文记录本分叉相对上游的核心差异与依据，供维护者参考。

## 1. 每个窗口都是独立的 CDP target

Codex Desktop（Electron，内部代号 Owl）中：

- 主窗口外壳（BrowserWindow）与其中的应用标签页（WebContentsView）各自拥有独立的 `webContents`，对应独立的 CDP `page` target；
- `Ctrl+Alt+C` 全局热键弹出的"小窗"是一个独立的 BrowserWindow（路由 `/hotkey-window`，无 `desktopSurface` 参数）；
- 独立弹出（detached）窗口同样是独立 target。

每个 target 都是独立的 JS realm：各自的 React root、各自的 TanStack Query `QueryClient`、各自的 `rate-limit-status` 缓存。**在一个 target 里改写额度数据，对其他 target 完全不可见。**

实测（`26.1106.6628.0`）同时存在 4 个 `app://` page target；只注入主窗口时，小窗内 `rate_limit_upsell` 完整保留、发送按钮持续锁定。

## 2. 上游行为与本分叉的修复

上游 `discoverTargets` 只返回排名最高的一个 target。本分叉：

- `targetRank()`：`type==="page"` 且 URL 为 `app://` 才参与；`app://-/index.html`（主外壳）rank=100，其余 `app://` 页面 rank=80，其余跳过；
- `discoverTargets()` 返回**全部**合格 target；单个 target 的 `webSocketDebuggerUrl` 校验失败只跳过该 target（stderr 记录 `[skip <id>]`），不阻塞其他窗口；
- 主循环为每个 target 维护独立 worker（`Map<targetId, worker>`），注入失败自动重试，target 消失后 worker 在 ≤2s 内退出；
- worker 通过 `Page.addScriptToEvaluateOnNewDocument`（`runImmediately` 回退）预注册补丁 + 立即 evaluate 一次，兼顾"注入后立刻可用"与"刷新/新文档后自动生效"；
- 监听每个 session 的 `Runtime.executionContextsCleared`，reload 后由主循环重新注入；
- `writeJsonAtomic` 使用唯一临时文件名 + 失败降级为 stderr 告警：多 worker 并发汇报不再互相覆盖临时文件，磁盘写满（ENOSPC）也不会终止守护进程。

## 3. 额度横幅的来源与清除

"额度已用完"横幅与发送封锁由不同字段驱动：

- 发送封锁：`rate_limit.allowed === false` / `limit_reached === true`，以及 `blocked_features` 中的发送类条目；
- 横幅/upsell：`rate_limit_upsell`（含 `banner_type`、文案、`reset_at`、CTA）、`model_picker_upsell`。

`quota-net-patch.cjs`（VERSION 3）对三种传输（`Response` 构造器、`fetch`/XHR、TanStack Query 缓存与发布点）统一执行载荷改写：

| 字段 | 改写 |
| :--- | :--- |
| `rate_limit.allowed` / `limit_reached` | `true` / `false` |
| `rate_limit_reached_type` | `null` |
| `additional_rate_limits[].rate_limit.allowed` | `true` |
| `blocked_features` | 移除发送类条目（保留 `image_gen`） |
| `premium_exhausted_at` | `null` |
| `rate_limit_upsell` / `model_picker_upsell` / `rate_limit_upsell`（query 层） | `null` |

`self-test-net` 用样例载荷验证上述改写全部生效。

## 4. 运行时参数（supervisor）

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `--port` | 必填 | CDP 调试端口（仅接受回环地址的 websocket URL） |
| `--net-patch` | 必填其一 | 注入用网络补丁脚本路径 |
| `--gate` | 必填其一 | 可选断点兜底脚本路径 |
| `--status` | 必填 | 状态 JSON 输出路径 |
| `--startup-timeout` | 60s | 首个 target 就绪前的超时 |
| `--poll-interval` | 1000ms | target 发现轮询间隔 |
| `--legacy-gate` | off | 启用旧版断点兜底 |
| `--self-test` / `--self-test-net` | — | 离线自检（gate 定位 / 补丁改写） |

状态 JSON 中 `state` 取值：`waiting-for-codex` → `injecting` → `ready`（或 `failed`）；`targetCount`/`readyCount`/`targets[]` 为本分叉新增的聚合字段，旧版读取器只关心 `state`，向后兼容。
