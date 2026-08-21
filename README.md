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
3. 列表含多个实例（如 A/B 在 S1、C 在 S2）→ 调 `unity_pool_bind(instance="ProjB@bbbb2222")` 把本会话目标实例锁定为 B；**每次绑定都返回该服务的最新 MCP 工具列表 `tools`**（含 name/description/inputSchema，同服务重复绑定也重拉保持新鲜，拉取失败回退缓存并附 `toolsError`），可直接据此调用；随时调 `unity_pool_status` 也可查看本会话已绑服务的工具名速查（`tools: {count, names}`）；
4. 之后所有 MCP 操作走 `unity_mcp(tool=..., params=...)`——插件自动把本会话的 MCP 会话激活到 B（助手无感），转发 tools/call；**请求的工具不在已知列表时自动重拉 tools/list**（Unity 可运行时注册/注销自定义工具、manage_tools 可开关工具组）；**工具名不存在时错误信息会附带当前可用工具名列表（含相似工具名提示）**，从中选正确的名称重试即可，不要盲猜；查 Unity 编辑器状态（截图/选中项/Console 等）用 `unity_pool_state`（状态携带开关默认全关，需先开启）；
5. **（v0.5.0）绑定后该服务工具自动注册为原生工具 `umcp_<工具名>`**——模型上下文直接可见完整工具清单（含参数），可直接原生调用（等价 `unity_mcp` 转发；未绑定会话调用报「未锁定目标实例」，先 bind 即可）；`umcp_*` 与 `unity_mcp` 等价并存（unity_mcp 仍是通用代理兜底，任意工具名可调）。
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
    # ---- 原生工具注册（v0.5.0，Claude 式工具清单）----
    nativeToolsEnabled: true   # 绑定成功后把该服务的 MCP 工具动态注册为原生工具（umcp_<工具名>），模型上下文直接可见可调
    nativeToolSchema: compact  # 参数 schema 形态：compact=基础标量类型+description、复杂参数不展开（省上下文，默认）；full=完整 inputSchema（与 Claude 注册 MCP 工具一致，参数校验最全但上下文开销大）
    # ---- 状态携带（v0.4.0，默认全关）----
    stateEnabled: false           # 总开关：每次发出指令时在上下文携带 Unity 状态快照
    stateGameScreenshot: false    # Game 视图截图（PNG 落盘 stateDir，上下文给路径）
    stateSceneScreenshot: false   # Scene 视图截图
    stateSelection: false         # Hierarchy/Project 当前选中项
    stateUiSnapshot: false        # 选中物体 ui-snapshot 结构快照（需实例注册 ui_snapshot 工具）
    stateSerialized: false        # 选中物体序列化字段内容（防超长截断）
    stateConsoleAll: false        # Console 全文（最近 stateConsoleCount 条）
    stateConsoleSelected: false   # Console 当前选中条目内容
    stateRefreshMs: 3000          # 状态采集间隔（ms）
    stateScreenshotMaxRes: 640    # 截图最长边分辨率（px）
    stateDir: '~/.dsh/unity-pool-state' # 截图 PNG 落盘目录
    stateMaxChars: 8000           # 通用文本项（选中项/序列化字段）最大字符数
    stateSnapshotMaxChars: 4000   # ui-snapshot 最大字符数
    stateConsoleMaxChars: 6000    # Console 文本最大字符数
    stateConsoleCount: 50         # Console 全文读取条数
```

**开关位置（方便按需切换）**：客户端在会话头部「Unity」胶囊（点开面板末段）与**输入框上方**（`conversation.input.dock` 槽，聊天输入框正上方一条）各有一组状态携带开关（总开关 + 7 项子开关），运行时点击即切（走 `POST /api/state-switch`，无需重启）；**开关按会话独立（v0.4.2）**——每个会话自己的开关（`stateSwitchesBySession` 按 sessionId 持久化，重启后本会话恢复上次设置），切换只影响本会话的采集/注入；**未绑定 Unity 也可切换**（预配置，灰显提示「未绑定 Unity，绑定后生效」，绑定后立即生效；子开关在总开关关闭时禁用）；开启总开关后每次发出指令自动注入最近一次快照——需要传状态的指令前开一下、不需要时关掉即可。旧版全局平铺 `stateSwitches` 自动迁移为全局默认层（所有会话的未覆盖项继承它）。

**两处 UI 同源（v0.4.1）**：头部胶囊、输入条 dock 的开关与绑定状态共用客户端共享状态源（模块级 pub-sub store，按 sessionId 分槽）——任一入口切换/绑定/解绑立即广播，另一入口即时同步；胶囊另有 5s 轻轮询兜底（agent 工具调用 `unity_pool_bind`/`unity_pool_unbind`、其它标签页的变化 ≤5s 自动反映到胶囊，无需手动刷新）。

## Agent 工具

| 工具 | 作用 |
|------|------|
| `unity_pool_status` | 服务池 → 每服务实例列表（Name@hash/hash/是否本会话激活 + instancesValid/offlineStreak）+ 本会话锁定 + 最近归档自动解绑 lastAutoUnbind；**已绑定时附带该服务最新工具名速查 `tools: {count, names}`** |
| `unity_pool_scan` | 服务重探 + 实例重读 + 扫描端口段发现新服务 |
| `unity_pool_bind` | 锁定本会话目标实例（instance=Name@hash/hash 前缀 / serviceId / 自动分配；force 覆盖排他）；**每次绑定都返回该服务最新 MCP 工具列表 `tools`（name/description/inputSchema）+ `toolsCount`**（同服务重复绑定也重拉保持新鲜；拉取失败回退上次缓存并附 `toolsError`，不阻断绑定）；**绑定后该服务工具自动注册为原生工具 `umcp_<工具名>`（v0.5.0）**——模型上下文直接可见全部工具名/描述/参数并原生调用（等价 `unity_mcp` 转发，未绑定会话调用报「未锁定目标实例」）；**注意：工具列表为服务级并集**（同服务多工程实例的自定义工具合并列出，个别工具可能不属于当前实例，调用失败即说明该实例未注册） |
| `unity_mcp` | 代理 MCP 工具调用（自动 set_active_instance 到目标实例 → tools/call 转发）；**工具不在缓存列表时自动重拉 tools/list**；**工具名不存在时错误信息附带当前可用工具名列表（含相似工具名提示）**，选正确名称重试即可；**Unity 编译/刷新期间自动等待**（忙时探测最长 `busyMaxWaitMs`，默认 10s；可 `busyWaitEnabled:false` 关闭）；**调用失败返回附带编辑器状态 `editorState`**（isCompiling/isUpdating/progressCount，便于判断是否忙碌所致）；返回 `text`（image/audio/resource 内容块以 `[image: ...]` 占位，不静默丢弃） |
| `unity_pool_unbind` | 释放锁定 + 关闭本会话 MCP 会话 |
| `unity_pool_state` | 查看/刷新本会话的 Unity 状态携带快照（v0.4.0）：立即采集一次并按开关返回各项状态（截图文件路径/选中项/序列化字段/Console）+ view.state（开关值与缓存摘要）；`refresh:false` 只读缓存 |

`unity_mcp` 参数：`tool`（mcp-for-unity 工具名，如 manage_scene / manage_gameobject / manage_camera / read_console）、`params`（工具参数对象）、`instance`（可选临时覆盖）。

## HTTP API（回环，仅 127.0.0.1/localhost）

- `GET /unity-pool/api/status?sessionId=<id>` —— 服务/实例/绑定视图；
- `GET /unity-pool/api/config` —— 池配置与提示；
- `POST /unity-pool/api/scan` `{sessionId}` —— 重探+扫描；
- `POST /unity-pool/api/bind` `{sessionId, instance?, serviceId?, force?}` —— 锁定目标实例（每次绑定都返回附带 `tools`）；
- `POST /unity-pool/api/unbind` `{sessionId}` —— 释放。
- `GET /unity-pool/api/state?sessionId=<id>` —— 当前状态携带缓存与视图；
- `POST /unity-pool/api/state-refresh` `{sessionId}` —— 立即重新采集一次状态；
- `POST /unity-pool/api/state-switch` `{sessionId, key, value}` —— 运行时切换状态开关（key: stateEnabled / stateGameScreenshot / stateSceneScreenshot / stateSelection / stateUiSnapshot / stateSerialized / stateConsoleAll / stateConsoleSelected，无需重启）。

## 测试

```powershell
node "C:\Users\Landrom\dsh-unity-pool\scripts\smoke-test-v2.mjs"   # 186 项：mock mcp-for-unity ×2 + 实例发现/会话锁定/排他/会话隔离/代理转发/动态工具重拉/跨服务重拉/重复绑定带工具/未知工具错误附工具名+相似提示/view 工具名速查/tools 失败回退缓存/图片占位/53 工具全量对照/scan/持久化/工具/HTTP/忙时等待/失败附状态/探测失败保守等待/归档自动解绑/归档解绑动态通知/状态携带（默认全关/全项采集/截图落盘/防超长/开关切换/单项失败/context 注入/HTTP）+ 状态开关 per-session（隔离/持久化/迁移/缺 sessionId 拒绝）+ v0.5.0 原生工具注册（绑定注册 umcp_*/compact 标量保留+复杂不展开/full 完整 schema/未绑定报错/已绑定转发成功/view.nativeTools 摘要/stop 注销/跨服务同名接管/解绑不注销/nativeToolsEnabled=false 禁用）（UNITY_POOL_LIB 环境变量可指向被测 lib）
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
- `0.4.0` **状态携带（每次发出指令携带 Unity 状态）**：总开关 `stateEnabled` + 7 项子开关（`stateGameScreenshot`/`stateSceneScreenshot`/`stateSelection`/`stateUiSnapshot`/`stateSerialized`/`stateConsoleAll`/`stateConsoleSelected`），**默认全关**；后台采集器（`stateRefreshMs` 周期）对已绑定会话采集开启项到缓存——game/scene 视图截图（`manage_camera` include_image，base64 解码 PNG 落盘 `stateDir/<sessionId>/`，上下文给文件路径），当前选中项（`execute_code` 读 `UnityEditor.Selection`），选中物体 ui-snapshot（`ui_snapshot` 工具）与序列化字段（`mcpforunity://.../components` 资源，均防超长截断 `stateMaxChars`），Console 全文（`read_console`）与 Console 选中条目（反射 `ConsoleWindow.m_ActiveText`）；注册 `systemPrompt.context('unity-pool:state')` 同步注入每轮 request；新增 `unity_pool_state` 工具 + HTTP `/api/state`、`/api/state-refresh`、`/api/state-switch`；view.state / HTTP /api/config 同步返回；测试扩到 117 项。
- `0.4.0（UX 补充）` **开关贴近输入框**：新增客户端 `conversation.input.dock` 槽注册（输入框正上方一条：总开关 + 7 项子开关，**紧凑短标签** Game/Scene/选中/快照/序列化/Console全/Console选，采集摘要移入悬浮提示，防溢出会话内容区），未绑定实例自动灰态；会话头部「Unity」胶囊面板内的开关区保留（两处同源，任意切换即时生效，页面刷新即可加载，无需重启 web）。
- `0.4.0（注入治理）` **状态只在用户发消息时携带一次**：`unity-pool:state` context 改为**每回合只注入一次**——按会话**回合号去重**（`stateTurnOf` 从 `agent.session.events` 读最近 `turn/start`，agent-loop 每轮用户输入回合号 +1）：回合首个 request 注入最新快照，同回合后续工具循环 request 不再重复注入（避免一轮会话内同一状态块被反复塞进上下文 5~6 次）；下次发消息（回合号 +1）自动携带最新快照；无回合号（无法去重）保持原行为。客户端配套：轮询失败/非 ok **保留上次开关状态**（瞬时网络抖动不再把开关“关掉”）；头部「Unity」弹窗**打开时强制重拉**（与输入条开关实时同步，不再显示旧快照）。测试扩到 126 项全过。
- `0.4.1` **工具列表随时可得 + 未知工具错误自描述 + 客户端两处开关同源**（源于「重命名健康度构成面板多文本组件」会话复盘：二次绑定拿不到列表 → Agent 盲猜 `read_editor_state` → Unknown tool 空转；用户实测头部面板与输入条 dock 两处开关不同步）：① `unity_pool_bind` **每次绑定都返回该服务最新 `tools`**（同服务重复绑定也重拉 tools/list 保持动态工具集合新鲜；拉取失败回退上次缓存并附 `toolsError`）；② `unity_pool_status`/view 新增**工具名速查 `tools: {serviceId, count, names}`**（未绑定为 null）；③ `unity_mcp` 收到 **Unknown tool 错误时自动附带当前可用工具名列表 + 相似工具名提示（Levenshtein）+ unity_pool_state 指引**；④ 系统提示指南/工具描述/README 同步（含「查编辑器状态用 unity_pool_state，不要猜 MCP 工具名」）；⑤ **客户端共享状态源**：头部「Unity」面板与输入条 dock 不再各自 useState + 各自轮询（面板不轮询、dock 5s 轮询 → 一边切换另一边最多延迟 5s、面板要重开才刷新），改为模块级 pub-sub store（按 sessionId 分槽，两处组件订阅同源）——任何一处切换成功立即写 store 广播、两处即时同步，5s 轮询仅作外部变化兜底，store 级 `switchSeq` 过期保护（仅用户切换递增；读取刷新互不干扰——避免「两组件轮询竞争使 dock 首次加载永远失败、开关条消失」的实测事故）防止在途旧快照覆盖新切换；⑥ **胶囊绑定态自动同步**：store 扩展存精简绑定信息（{serviceId, instanceId, instanceName, serviceName, alive}），胶囊 chip 的名字/颜色优先从 store 读；胶囊增加 5s 轻轮询（带 seq 过期保护）——agent 工具调用 bind/unbind、其它标签页的变化 ≤5s 自动反映，面板内点锁定/解绑即时更新；⑦ **面板锁定并行化**：「锁定」按钮普通绑定失败且错误含「已被会话锁定」时**自动以 force=true 重试一次**（并行开发是插件设计常态），成功即锁定、失败才提示「强制锁定失败」；⑧ **旧轮询快照不覆盖新切换**（修复「开关过一会自己关掉」）：`refresh`/`post` 响应里的 state 写入 store 前检查 `switchSeq`（请求发出期间若有用户切换则旧快照只更新 binding、不覆盖 state；`storeSet` 的 state/binding 参数支持 undefined=保留）。测试：host smoke **131 项全过** + client VM 冒烟扩到 **30 项全过**（`scripts/client-vm-smoke.mjs`：dock 切总开关 → 面板即时变、面板切子开关 → dock 芯片即时变、外部解绑 → 胶囊自动变回 Unity、外部绑定 → 胶囊自动恢复实例名、dock「未绑定 Unity」文本同步、面板点锁定/解绑 → 胶囊即时变、**并行锁定（被占用实例自动 force 重试）**、**旧轮询快照晚到不覆盖新切换**、sessionId 隔离）。
- `0.4.2` **状态开关按会话独立 + 未绑定可切**（用户指出「开关全会话共享，却只有绑定会话能控制 → 不成交互闭环」）：① **开关 per-session**：`stateSwitchesBySession` 按 sessionId 持久化（`{ [sessionId]: {key: bool} }`，含"关"），生效值 = 配置默认 ← 旧全局层 ← 本会话覆盖；`stateCarryEnabled`/`collectState`/`stateContextText`/注入/`view.state` 全部按会话读开关——每个会话的「控制 → 采集 → 注入 → 感知」全链路闭环，互不干扰；`/api/state-switch` 的 sessionId 改为必填（缺省 400）；`/api/config` 返回全局默认层（配置 + 旧全局 base）；② **旧版全局平铺 `stateSwitches` 自动迁移**为全局默认层（base），未切换过的会话继承它，升级不丢设置；③ **未绑定 Unity 可切开关**（预配置）：dock 总开关/子项不再 `disabled:!bound`，未绑定灰显提示「未绑定 Unity，绑定后生效」，绑定后立即生效；子开关仍受总开关 gate（总关时禁用）；头部面板本来就可切，补文案「开关按会话记忆」；④ 诊断 `switchLog` 记录 sessionId。测试：host smoke 扩到 **166 项全过** + client VM 冒烟扩到 **31 项全过**（含 per-session 隔离、未绑定可切断言）。
- `0.5.0` **原生工具注册（Claude 式工具清单）**（源于「将车身总拼岛迁移A岛界面任务」会话复盘：code 预设下模型只能经 `run_code` 调 `tools.*`，绑定脚本打印子集且字段取错 → 上下文没有工具清单 → 盲猜 `find_objects` → Unknown tool 空转；Claude 侧是 MCP `tools/list` 全量原生注入，天然有清单）：① 绑定成功后把该服务的 MCP 工具**动态注册为 DSH 原生工具 `umcp_<工具名>`**——模型上下文直接可见全部工具名/描述/参数并原生调用（`execute` 统一转发 `proxyMcp`，未绑定报错/实例激活/忙等待/未知工具提示全复用）；code 预设的 `tools:sdk` 声明 / native 预设的工具 schema 都会列出；② 配置 `nativeToolsEnabled`（默认开）/ `nativeToolSchema`（`compact` 默认：基础标量类型 + description、复杂/嵌套参数不展开省上下文；`full`：完整 inputSchema 逐级映射，与 Claude 注册 MCP 工具一致）；③ 注册键=服务（`syncNativeTools` 先注销旧注册再全量重注册），跨服务同名工具后绑定者接管，**解绑收敛**（服务不再被任何会话绑定时注销该服务 `umcp_*`，手动解绑与归档自动解绑共用；仍有会话绑定则保留），`stop()` 全量注销（`tools.register` 返回的 disposer）；④ 工具集合动态变化（Unity 注册/注销、`manage_tools` 开关）在 bind / `unity_mcp` 重拉 `tools/list` 时同步刷新；⑤ `view.nativeTools` 按服务返回已注册摘要（count/names），view.rules 暴露开关与形态。**边界与成本（实测）**：compact 57 工具 ≈ 14K tokens/轮、full ≈ 20K tokens/轮（固定输入，DeepSeek 缓存友好）；工具数受「跨服务同名接管」限制为并集（不会 57×服务数）；同服务多会话并发绑定/解绑安全（注册同步幂等、路由按会话绑定不交叉）；未绑定会话可见 `umcp_*` 但调用报「未锁定」；首次绑定 tools/list 拉取失败时本次不注册（回退缓存，下次成功绑定/重拉自动注册）。测试：host smoke 扩到 **190 项全过**（+18：绑定注册/compact 标量保留+复杂不展开/full 完整 schema+顶层 required/未绑定报错/已绑定转发/HTTP nativeTools 摘要/stop 注销/跨服务同名接管/解绑收敛×3/同服务两会话并发绑定解绑/禁用不注册）。