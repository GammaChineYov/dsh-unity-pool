# dsh-unity-pool v2 — 会话级 Unity 服务池 + 实例级 MCP 代理

DSH 插件：解决「同一 DSH 终端（web）里多个会话各连各的 Unity 实例」的问题。

**核心思路**：mcp-for-unity 的 HTTP 模式把「当前激活实例」按 **MCP-Session-Id 隔离**——插件为每个 DSH 会话维护独立的 MCP 会话（独立 session id），
再通过 `unity_mcp` 代理在调用前自动 `set_active_instance` 到本会话锁定的目标实例。因此**同一服务上不同会话可以同时 target 不同实例，互不干扰，无需全局切换/排队**。

## 与官方 Unity MCP 的关系

- 官方 Unity MCP（CoplayDev/unity-mcp）= 能力层：把 Unity 编辑器翻译成 MCP 工具/资源；
- 本插件 = 调度层：服务池发现 + 实例发现 + 会话目标实例锁定 + MCP 调用代理；
- 两者叠加：官方负责「能干 Unity 的活」，插件负责「这个会话连哪个实例」。

## 数据模型

```
服务（Service）＝ 一个 mcp-for-unity server（一个端口，如 8080）
  └ 实例（Instance）＝ 一个已连接的 Unity 编辑器（Name@hash，如 ProjA@aaaa1111）
会话锁定（Binding）＝ sessionId → { serviceId, instanceId }
MCP 会话（Session）＝ 每 DSH 会话 × 服务 一个独立 Mcp-Session-Id（active 实例按 session 隔离）
```

## 工作流（对应需求流程）

1. 会话被告知要处理的服务（8080/8081）或目标工程 → 调 `unity_pool_status`；
2. 目标实例不在列表 → `unity_pool_scan`（服务重探 + 实例重读 + 扫描 scanPorts 端口段发现新服务）→ 再 `unity_pool_status`；
3. 列表含多个实例（如 A/B 在 S1、C 在 S2）→ 调 `unity_pool_bind(instance="ProjB@bbbb2222")` 把本会话目标实例锁定为 B；**首次绑定（或切换到另一服务）时返回结果附带该服务的 MCP 工具列表 `tools`**（含 name/description/inputSchema），可直接据此调用；
4. 之后所有 MCP 操作走 `unity_mcp(tool=..., params=...)`——插件自动把本会话的 MCP 会话激活到 B（助手无感），转发 tools/call；**请求的工具不在已知列表时自动重拉 tools/list**（Unity 可运行时注册/注销自定义工具、manage_tools 可开关工具组）；
5. 另一个会话锁 A 并行工作：per MCP-Session-Id 隔离，两会话各自 target 各自实例，互不干扰；
6. 用完 `unity_pool_unbind` 释放。

> 归档自动解绑 + 通知：实例被归档（Unity 关闭/下线/服务离线）时插件自动解绑该实例的会话，
> 并在下一轮请求向被解绑会话注入一段中文通知（时间/实例/原因 + 重新 bind 指引，官方
> `systemPrompt.context` 机制，仅该会话可见），agent 无需主动碰工具就能感知绑定已失效。

> 关于「切换/排队」：官方 HTTP 模式 active 实例按 session 隔离（见 `test_multi_user_session_isolation.py`），
> 所以不需要「服务级全局切换 + 互斥等待」。同一实例被多会话并发调用时由 Unity 侧单线程排队（官方文档所述，性能排队而非错误）。

## 架构

```
浏览器端（client）                          Node 宿主（host）
conversation.session.header.utilities       UnityPool（服务池+实例缓存+会话绑定+探活）
  └ Unity 胶囊+面板 ──fetch──>  /unity-pool/api/*（回环）
                                ├ unity_pool_status / unity_pool_scan / unity_pool_bind
                                ├ unity_mcp（代理）──> McpHttpClient（per-session MCP 会话）
                                │                          └ set_active_instance + tools/call
                                └ unity_pool_unbind
                                      持久化：~/.dsh/unity-pool-state.json
```

- 宿主 `lib/index.js`：cordis 插件，`inject: ['tools','webServer','systemPrompt']`；
- MCP 客户端 `lib/mcp-client.js`：streamable-HTTP 薄封装（initialize / resources/read / tools/call，SSE+JSON，per-client 串行）；
- 客户端 `lib/client.js`：`conversation.session.header.utilities` 槽（id `unity-pool`，order 110）。

## 安装

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-unity-pool" -Target "C:\Users\PC\dsh-unity-pool" -Force
New-Item -ItemType Junction -Path "C:\Users\PC\dsh-unity-pool\node_modules" -Target "C:\Users\PC\.dsh\profiles\node_modules" -Force
```

- `~/.dsh/profiles/web/package.json`：`dependencies` 加 `"dsh-unity-pool": "link:C:/Users/PC/dsh-unity-pool"`，`dsh.profile.bundles` 加 `"dsh-unity-pool"`（无 BOM）；
- `~/.dsh/profiles/web/cordis.patch.yml` 加配置段（见下）；
- **重启 `dsh web` 生效**；验证 `dsh --profile web --dump-config | grep unity-pool`。

## 配置（cordis.patch.yml）

```yaml
- id: unity-pool
  config:
    services:                 # 服务池：每个 mcp-for-unity server 一个条目
      - id: unity-e-line
        name: 'E线-8080'
        url: 'http://127.0.0.1:8080/mcp'
      - id: unity-8081
        name: 'Unity-8081'
        url: 'http://127.0.0.1:8081/mcp'
    probeIntervalMs: 8000     # 探活+实例发现间隔（ms）
    probeTimeoutMs: 3000      # 单次 MCP 请求超时（ms）
    scanPorts: [8080, 8081, 8082, 8083, 8084, 8090]   # unity_pool_scan 自动扫描的端口段
    autoAssign: true          # 未指定实例时自动分配未被其他会话锁定的实例
    enforceExclusive: true    # 同一实例默认不能被第二个会话锁定
    connectHint: '调用 unity_mcp(tool=..., params=...) 代理 MCP 工具调用'
    busyWaitEnabled: true     # unity_mcp 调用前探测 Unity 忙状态（编译/刷新/进度条）并自动等待
    busyMaxWaitMs: 10000      # 忙时等待总时长上限（ms），默认 10 秒
    busyWaitIntervalMs: 500   # 忙时等待的探测间隔（ms）
    autoUnbindOnArchive: true # 实例被归档（从池中消失/服务离线）时自动解绑绑定该实例的会话
    unbindOfflineStreak: 2    # 服务离线连续探测次数达到该值才视为归档并自动解绑（防瞬时抖动）
    notifyUnbindOnArchive: true # 归档自动解绑后，向被解绑的会话注入运行时通知（systemPrompt.context，下一轮 request 自动感知）
```

## Agent 工具

| 工具 | 作用 |
|------|------|
| `unity_pool_status` | 服务池 → 每服务实例列表（Name@hash/hash/是否本会话激活 + instancesValid/offlineStreak）+ 本会话锁定 + 最近归档自动解绑 lastAutoUnbind |
| `unity_pool_scan` | 服务重探 + 实例重读 + 扫描端口段发现新服务 |
| `unity_pool_bind` | 锁定本会话目标实例（instance=Name@hash/hash 前缀 / serviceId / 自动分配；force 覆盖排他）；**首次绑定或跨服务切换时返回该服务 MCP 工具列表 `tools`（name/description/inputSchema）+ `toolsCount`**，拉取失败附 `toolsError` 不阻断绑定；**注意：工具列表为服务级并集**（同服务多工程实例的自定义工具合并列出，个别工具可能不属于当前实例，调用失败即说明该实例未注册） |
| `unity_mcp` | 代理 MCP 工具调用（自动 set_active_instance 到目标实例 → tools/call 转发）；**工具不在缓存列表时自动重拉 tools/list**；**Unity 编译/刷新期间自动等待**（忙时探测最长 `busyMaxWaitMs`，默认 10s；可 `busyWaitEnabled:false` 关闭）；**调用失败返回附带编辑器状态 `editorState`**（isCompiling/isUpdating/progressCount，便于判断是否忙碌所致）；返回 `text`（image/audio/resource 内容块以 `[image: ...]` 占位，不静默丢弃） |
| `unity_pool_unbind` | 释放锁定 + 关闭本会话 MCP 会话 |

`unity_mcp` 参数：`tool`（mcp-for-unity 工具名，如 manage_scene / manage_gameobject / manage_camera / read_console）、`params`（工具参数对象）、`instance`（可选临时覆盖）。

## HTTP API（回环，仅 127.0.0.1/localhost）

- `GET /unity-pool/api/status?sessionId=<id>` —— 服务/实例/绑定视图；
- `GET /unity-pool/api/config` —— 池配置与提示；
- `POST /unity-pool/api/scan` `{sessionId}` —— 重探+扫描；
- `POST /unity-pool/api/bind` `{sessionId, instance?, serviceId?, force?}` —— 锁定目标实例（首次绑定/跨服务切换时返回附带 `tools`）；
- `POST /unity-pool/api/unbind` `{sessionId}` —— 释放。

## 测试

```powershell
node "C:\Users\Landrom\dsh-unity-pool\scripts\smoke-test-v2.mjs"   # 82 项：mock mcp-for-unity ×2 + 实例发现/会话锁定/排他/会话隔离/代理转发/动态工具重拉/跨服务重拉/图片占位/53 工具全量对照/scan/持久化/工具/HTTP/忙时等待/失败附状态/探测失败保守等待/归档自动解绑/归档解绑动态通知（UNITY_POOL_LIB 环境变量可指向被测 lib）
```

## 变更日志

- `0.1.0` v1：会话→服务绑定 + 探活 + 面板；
- `0.2.0` v2：实例级——实例发现、会话目标实例锁定、`unity_mcp` 代理（per MCP-Session-Id 隔离）、`unity_pool_scan`；
- `0.3.0` v3：客户端**全行内样式**（不再注入全局 `<style>`，避免影响其它客户端插件样式；弹窗改为贴近按钮、无遮罩、toggle 开关）。
- `0.3.1` **首次绑定返回工具列表**：`unity_pool_bind` 改为 async，会话首次绑定时（此前未锁定过）自动拉取目标服务上的 MCP 工具列表（`tools/list`），随结果返回 `tools`（含 name/description/inputSchema）与 `toolsCount`；拉取失败不阻断绑定（附 `toolsError`）。
- `0.3.2` **动态工具集合对齐 + 内容占位**：① 轻量一致性——`unity_mcp` 请求的工具不在缓存列表时自动重拉一次 `tools/list` 再转发（官方工具集合动态增减：Unity 自定义工具注册/`manage_tools` 组开关），重拉失败不阻断；② `image/audio/resource` 内容块不再静默丢弃，text 输出以 `[image: image/png, 内容已丢弃（文本通道）]` 占位（与官方 dsh-mcp-client 桥行为一致，对应 `manage_camera include_image=true` 场景）。
- `0.3.3` **跨服务切换重拉工具列表 + 描述同步**：`unity_pool_bind` 在会话切换到另一服务（serviceId 变化）时同样重拉 `tools/list` 随结果返回（不同 mcp-for-unity server 工具集可能不同）；工具描述、系统提示指南、README（工作流/工具表/HTTP API）同步说明首次绑定/跨服务返回 tools、动态重拉、图片占位。
- `0.3.4` **服务级并集说明**：工具列表为服务级并集（同服务多工程实例的自定义工具合并列出）——工具描述、系统提示指南、README 补充说明，避免把其他工程实例的自定义工具误当作当前实例可用（导包迁移任务双工程同服务场景实测）。
- `0.3.7` **忙时等待 + 失败附状态**：① `unity_mcp` 转发前用 `execute_code` 探测 Unity 编辑器忙状态（isCompiling/isUpdating/Progress），忙则按 `busyWaitIntervalMs` 间隔重试，总时长不超过 `busyMaxWaitMs`（默认 10s）；探测失败视为"可能忙"（域重载窗口 execute_code 可能不可用）保守等待后继续；② 调用最终失败（isError）时把最近一次探测状态附到返回 `editorState`；关闭 `busyWaitEnabled` 可跳过忙时等待（仅失败时补一次探测附状态）。真实服务联调验证通过（失败返回带 `editorState: isCompiling=0,isUpdating=0,progressCount=0`）。
- `0.3.8` **归档自动解绑**：每次探活（probe）完成后检查会话绑定——绑定实例不在最新发现列表（`instance-archived`）、服务连续离线达阈值（`service-offline`，`unbindOfflineStreak` 默认 2 防瞬时抖动）、服务配置不存在（`service-removed`）时自动解绑该会话（删除绑定 + 关闭 MCP 会话 + 持久化），避免会话停留在已归档实例上；实例发现失败（`instancesValid=false`）保留上次列表不清空、不据此判归档（发现失败≠实例消失）；新增配置 `autoUnbindOnArchive`（默认 true）/ `unbindOfflineStreak`（默认 2），view 暴露 `instancesValid`/`offlineStreak`/`lastAutoUnbind`，HTTP /api/config 同步返回；测试扩到 76 项。
- `0.3.9` **归档解绑动态通知**：注册 `systemPrompt.context('unity-pool:archive')`（text 为函数，每次 agent request 前求值——官方机制，sandbox-policy 同款）；自动解绑后只向被解绑的会话注入中文通知（时间/实例/原因 + 重新 bind 指引），其他会话注入空串，下一轮 request 自动感知，无需碰 `unity_mcp` 才撞上「未锁定」报错；新增配置 `notifyUnbindOnArchive`（默认 true），view.rules / HTTP /api/config 同步返回；测试扩到 82 项。