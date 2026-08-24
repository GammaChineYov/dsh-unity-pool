// dsh-unity-pool v2 — 会话级 Unity 服务池 + 实例级 MCP 代理。
//
// v2 相对 v1 的核心升级（实例级）：
//  - 每个服务（mcp-for-unity server）上可挂多个 Unity 编辑器实例（PluginHub session，Name@hash）；
//  - 插件从每个服务读 mcpforunity://instances 发现实例，并缓存到服务条目；
//  - 会话绑定的目标从「服务」细化为「实例」：sessionId → {serviceId, instanceId}；
//  - unity_mcp 代理工具：调用前确保本会话的 MCP session（per MCP-Session-Id）active=目标实例
//    （官方 HTTP 模式 active 按 session 隔离，两个会话可同时 target 不同实例，互不干扰），
//    然后转发 tools/call；同一服务上不同会话各自维护独立 MCP 会话，无需全局切换/排队；
//  - unity_pool_scan：触发服务重探 + 实例重读（自动扫描扫描端口段 scanPorts）。
//
// v0.3.7（2026-08-18）忙时等待 + 失败附状态：
//  - unity_mcp 转发前用 execute_code 探测 Unity 编辑器忙状态（isCompiling/isUpdating/Progress），
//    忙（编译/刷新/进度条）则按 busyWaitIntervalMs 间隔重试，总时长不超过 busyMaxWaitMs（默认 10s）；
//    探测失败视为"可能忙"（域重载窗口 execute_code 可能不可用）保守等待后继续；
//  - 调用最终失败（isError）时把最近一次探测状态附到返回 editorState，供调用方判断是否 busy 所致；
//
// v0.3.8→v0.5.1（2026-08-22 设计修正）归档语义：归档 = 会话归档（DSH session/disposed）。
//  - 实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑，也不注入通知；
//    真正的实例离线只在「调用时」由 unity_mcp/umcp_* 自动重连并在超时后才返回失败原因。
//  - 唯一自动解绑入口：订阅 session/disposed → 清理该会话锁定的实例（autoUnbindOnArchive 默认开启）；
//  - 调用时实例离线：给足 callReconnectTimeoutMs（默认 20s）让官方服务端的会话重连等待完成，
//    超过才判定实例离线并返回失败原因（不再抛出，调用方可直接看到停机信息）。
//
// v0.4.0（2026-08-19）状态携带（每次发出指令携带 Unity 状态）：
//  - 总开关 stateEnabled + 7 项子开关（stateGameScreenshot/stateSceneScreenshot/stateSelection/
//    stateUiSnapshot/stateSerialized/stateConsoleAll/stateConsoleSelected），默认全关；
//  - 后台采集器（startStateTimer，stateRefreshMs 周期）对已绑定会话采集开启项到 stateCaches：
//    game/scene 视图截图（manage_camera include_image，PNG 落盘 stateDir/<sessionId>/）、
//    当前选中项（execute_code 读 Selection）、选中物体 ui-snapshot 与序列化字段
//    （mcpforunity://.../components 资源，均防超长截断）、Console 全文（read_console）与
//    Console 选中条目（反射 ConsoleWindow.m_ActiveText）；
//  - 注册 systemPrompt.context('unity-pool:state')（text 为同步函数，每次 agent request 前求值，
//    读取最近一次采集快照注入上下文；截图给文件路径供 read_image 查看）；
//  - 新增 unity_pool_state 工具（查看/强制刷新快照）；HTTP /api/state、/api/state-refresh、
//    /api/state-switch（运行时切换开关）；view.state / HTTP /api/config 同步返回开关与参数。
//
// v0.5.0（2026-08-21）原生工具注册（Claude 式工具清单）：
//  - 背景：会话「将车身总拼岛迁移A岛界面任务」复盘——code 预设下模型只能经 run_code 调 tools.*，
//    绑定脚本打印子集且字段取错（res.tools?.toolsCount，实际 tools 是顶层数组）→ 模型上下文没有
//    Unity MCP 工具清单 → 盲猜 find_objects → Unknown tool 空转。Claude 侧是 MCP tools/list 全量
//    原生注入，天然有清单；DSH 走 unity_mcp 单工具代理 + 清单靠返回文本，code 模式下再叠打印子集。
//  - 方案：绑定成功后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），模型上下文
//    直接可见全部工具名/描述/参数并原生调用（execute 统一转发 proxyMcp，未绑定报错/实例激活/
//    忙等待/未知工具提示全复用）。code 预设的 tools:sdk 声明 / native 预设的工具 schema 都会列出。
//  - 配置：nativeToolsEnabled（默认开）/ nativeToolSchema（compact 省上下文默认 / full 完整 schema）；
//    注册键=服务（syncNativeTools 先清后注），跨服务同名后绑定者接管，stop() 全量注销；
//    工具集合动态变化（Unity 注册/注销、manage_tools）在 bind/重拉 tools/list 时同步刷新。
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { McpHttpClient } from './mcp-client.js'

export const name = 'unity-pool'
export const inject = ['tools', 'webServer', 'systemPrompt']

export const Config = z.object({
  /** 服务池条目：每个 mcp-for-unity server 一个服务（id 唯一、url 为 MCP 端点）。 */
  services: z.array(z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
  })).default([
    { id: 'unity-8080', name: 'Unity 8080', url: 'http://127.0.0.1:8080/mcp' },
  ]),
  /** 会话绑定持久化文件。 */
  dataFile: z.string().default(path.join(homedir(), '.dsh', 'unity-pool-state.json')),
  /** 服务存活探测 + 实例发现间隔（毫秒）。 */
  probeIntervalMs: z.number().default(10000),
  /** 单次 MCP 请求超时（毫秒）。 */
  probeTimeoutMs: z.number().default(3000),
  /** unity_pool_scan 时额外探测的端口段（自动扫描；空则不扫）。 */
  scanPorts: z.array(z.number()).default([8080, 8081, 8082, 8083, 8084, 8090]),
  /** 会话首次查询/绑定未指定实例时，自动分配一个可用实例。 */
  autoAssign: z.boolean().default(true),
  /** 并行开发同一实例是正常用法：force 默认 true（默认可并行绑定，不拒绝）。
   *  enforceExclusive 仅在「显式传 force=false」时才生效：同一实例已被其他会话绑定时拒绝并行绑定。 */
  enforceExclusive: z.boolean().default(true),
  /** 连接提示：agent 如何用绑定服务+实例工作（unity_mcp 代理即连接方式）。 */
  connectHint: z.string().default(''),
  /** unity_mcp 调用前是否探测 Unity 编辑器忙状态并等待（编译/刷新期间自动等待，最长 busyMaxWaitMs）。 */
  busyWaitEnabled: z.boolean().default(true),
  /** 忙时等待总时长上限（毫秒），默认 10 秒。 */
  busyMaxWaitMs: z.number().default(10000),
  /** 忙时等待的探测间隔（毫秒）。 */
  busyWaitIntervalMs: z.number().default(500),
  /** 会话归档（DSH session/disposed）时自动解绑该会话锁定的实例（默认开启）。
   *  【设计语义】实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑，也不注入通知；
   *  真正的实例离线只在「调用时」由 unity_mcp/umcp_* 自动重连并在超时后返回失败原因（见 callReconnectTimeoutMs）。 */
  autoUnbindOnArchive: z.boolean().default(true),
  /** 调用时实例离线的重连/等待时长（毫秒，默认 20s）：unity_mcp/umcp_* 路由到实例时，若实例处于
   *  域重载/掉线窗口，给足超时让官方 mcp-for-unity 服务端的会话重连等待（默认 20s）完成；
   *  超过该时长仍未连接则判定实例离线，返回调用失败原因。 */
  callReconnectTimeoutMs: z.number().default(20000),

  // ---- 状态携带（v0.4.0）----
  // 总开关 + 每项单独开关，默认全关。开启后每次 agent 指令前把对应项注入运行时上下文：
  //  game/scene 视图截图（PNG 落盘 stateDir）、当前选中项、选中物体 ui-snapshot 与序列化字段、
  //  Console 全文与选中条目。截图在上下文里给文件路径（模型可按需 read_image 查看）。
  /** 状态携带总开关：开启后采集并注入下述各项状态（默认关）。 */
  stateEnabled: z.boolean().default(false),
  /** Game 视图截图。 */
  stateGameScreenshot: z.boolean().default(false),
  /** Scene 视图截图。 */
  stateSceneScreenshot: z.boolean().default(false),
  /** Hierarchy / Project 视图当前选中项（名称/类型/instanceID/路径/资产路径）。 */
  stateSelection: z.boolean().default(false),
  /** 选中物体（GameObject）的 ui-snapshot 结构快照（需实例注册了 ui_snapshot 工具，如 LBTools）。 */
  stateUiSnapshot: z.boolean().default(false),
  /** 选中物体的序列化字段内容（components 资源，按 stateMaxChars 截断防超长）。 */
  stateSerialized: z.boolean().default(false),
  /** Console 全文（最近 stateConsoleCount 条，按 stateConsoleMaxChars 截断）。 */
  stateConsoleAll: z.boolean().default(false),
  /** Console 当前选中条目内容（反射 ConsoleWindow，按 stateConsoleMaxChars 截断）。 */
  stateConsoleSelected: z.boolean().default(false),
  /** 状态采集间隔（毫秒）：后台对已绑定会话按开启项周期采集，写入缓存供每轮注入。 */
  stateRefreshMs: z.number().default(3000),
  /** 截图最长边分辨率上限（像素），控制 PNG 体积（默认 640）。 */
  stateScreenshotMaxRes: z.number().default(640),
  /** 状态产物（截图 PNG）落盘目录，每会话一个子目录；缺省 ~/.dsh/unity-pool-state。 */
  stateDir: z.string().default(path.join(homedir(), '.dsh', 'unity-pool-state')),
  /** 通用文本项（选中项/序列化字段）最大字符数，超出截断并标注（防超长）。 */
  stateMaxChars: z.number().default(8000),
  /** ui-snapshot 快照最大字符数（按树/引用/被引用预算分配，保证引用明细可见；默认 8000）。 */
  stateSnapshotMaxChars: z.number().default(8000),
  /** Console 文本（全文/选中）最大字符数。 */
  stateConsoleMaxChars: z.number().default(6000),
  /** Console 全文读取条数。 */
  stateConsoleCount: z.number().default(50),
  /** 截图按需刷新节流（毫秒，默认 10s）：截图会让 Unity 窗口闪烁/任务栏提醒，
   *  不参与后台 3s 轮询；改为注入（发消息）时发现截图过期（距上次截图 ≥ 本值）才异步补采一次。 */
  screenshotStaleMs: z.number().default(10000),

  // ---- 原生工具注册（v0.5.0，2026-08-21）----
  // 绑定后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），
  // 模型上下文直接可见工具清单并可原生调用（Claude 式体验），不再依赖 bind 返回文本。
  // 根因（2026-08-21 会话「将车身总拼岛迁移A岛界面任务」复盘）：code 预设下模型只能经
  // run_code 调 tools.*，绑定脚本打印子集且字段取错 → 上下文没有工具清单 → 盲猜 find_objects。
  // 原生注册后 code 预设的 tools:sdk 声明 / native 预设的工具 schema 都会列出全部工具。
  /** 绑定成功后把该服务的 MCP 工具动态注册为原生工具（umcp_<tool>），默认开启。 */
  nativeToolsEnabled: z.boolean().default(true),
  /** 原生工具参数 schema 形态：compact=只带参数名+description（省上下文，参数不校验，由 Unity 侧 pydantic 裁决，默认）；
   *  full=完整 inputSchema（与 Claude 注册 MCP 工具一致，参数校验最全但上下文开销大）。 */
  nativeToolSchema: z.string().default('compact'),
})

const DEFAULT_CONNECT_HINT = '调用 unity_mcp(tool=..., params=...) 代理 MCP 工具调用；插件自动确保本会话目标实例激活。'

function normalizeUrl(url) {
  const s = String(url ?? '').trim()
  if (!s) return s
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : 'http://' + s
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 状态携带开关键（持久化与 setStateSwitch 共用）。 */
const STATE_SWITCH_KEYS = ['stateEnabled', 'stateGameScreenshot', 'stateSceneScreenshot', 'stateSelection', 'stateUiSnapshot', 'stateSerialized', 'stateConsoleAll', 'stateConsoleSelected']

// Console 选中条目反射代码。
// 2026-08-20 实测（Unity 2022.3.62f2c1）：m_ActiveText 只在「双击激活」条目时更新，单击选中读不到——
// 改用 m_LastActiveEntryIndex（单击选中即更新）+ LogEntries.GetEntryInternal（internal，需遍历 GetMethods
// 查找；GetMethod(name, types) 对 internal 类型+ByRef 参数匹配不到）读选中行 message（含完整文本与堆栈）。
const CONSOLE_SELECTED_CODE = [
  'var sb=new System.Text.StringBuilder();',
  'try{',
  '  var asm=typeof(UnityEditor.EditorWindow).Assembly;',
  '  var cwType=asm.GetType("UnityEditor.ConsoleWindow");',
  '  if(cwType==null){sb.Append("NO_CONSOLE_WINDOW");return sb.ToString();}',
  '  var wins=UnityEngine.Resources.FindObjectsOfTypeAll(cwType);',
  '  if(wins==null||wins.Length==0){sb.Append("NO_CONSOLE_WINDOW");return sb.ToString();}',
  '  var cw=wins[0];',
  '  var flags=System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic;',
  '  var fIdx=cwType.GetField("m_LastActiveEntryIndex",flags);',
  '  var idx=fIdx!=null?(int)fIdx.GetValue(cw):-1;',
  '  if(idx<0){sb.Append("(Console 未选中任何条目)");return sb.ToString();}',
  '  var leType=asm.GetType("UnityEditor.LogEntries");',
  '  var entryType=asm.GetType("UnityEditor.LogEntry");',
  '  if(leType==null||entryType==null){sb.Append("(LogEntries 类型不可用)");return sb.ToString();}',
  '  var bf=System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.Public|System.Reflection.BindingFlags.NonPublic;',
  '  System.Reflection.MethodInfo getM=null;',
  '  foreach(var m in leType.GetMethods(bf)){if(m.Name=="GetEntryInternal"){getM=m;break;}}',
  '  if(getM==null){sb.Append("(GetEntryInternal 不可用)");return sb.ToString();}',
  '  try{leType.GetMethod("StartGettingEntries",bf).Invoke(null,null);}catch{}',
  '  var entry=System.Activator.CreateInstance(entryType);',
  '  var args=new object[]{idx,entry};',
  '  bool ok=false;',
  '  try{ok=(bool)getM.Invoke(null,args);}catch{}',
  '  entry=args[1];',
  '  if(ok&&entry!=null){',
  '    var msgF=entryType.GetField("message");',
  '    var fileF=entryType.GetField("file");',
  '    var lineF=entryType.GetField("line");',
  '    var txt=msgF!=null?(string)msgF.GetValue(entry):null;',
  '    var file=fileF!=null?(string)fileF.GetValue(entry):null;',
  '    var line=lineF!=null?(int)lineF.GetValue(entry):0;',
  '    if(!string.IsNullOrEmpty(txt)){',
  '      sb.Append(txt.Length>6000?txt.Substring(0,6000):txt);',
  '      if(!string.IsNullOrEmpty(file)){sb.Append(System.Environment.NewLine).Append("(at ").Append(file).Append(":").Append(line).Append(")");}',
  '    }else{sb.Append("(条目文本为空)");}',
  '  }else{sb.Append("(Console 未选中任何条目)");}',
  '  try{leType.GetMethod("EndGettingEntries",bf).Invoke(null,null);}catch{}',
  '}catch(System.Exception ex){sb.Append("ERR: ").Append(ex.GetType().Name).Append(": ").Append(ex.Message);}',
  'return sb.ToString();',
].join('')

function formatProp(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Unity 内置组件白名单（不在白名单的组件视为业务/自定义组件，快照地图优先呈现）。 */
const BUILTIN_COMPONENTS = new Set([
  'Transform', 'RectTransform', 'CanvasRenderer', 'Canvas', 'CanvasGroup', 'GraphicRaycaster', 'CanvasScaler',
  'Image', 'RawImage', 'Text', 'TextMeshProUGUI', 'TextMeshPro', 'Button', 'Dropdown', 'ScrollRect', 'Scrollbar',
  'Mask', 'RectMask2D', 'Toggle', 'ToggleGroup', 'Slider', 'InputField', 'TMP_InputField', 'EventTrigger',
  'VerticalLayoutGroup', 'HorizontalLayoutGroup', 'GridLayoutGroup', 'LayoutElement', 'ContentSizeFitter',
  'AspectRatioFitter', 'Outline', 'Shadow', 'Graphic', 'Selectable', 'MonoBehaviour', 'Behaviour', 'Component',
  'UIMask', 'RectTransformUtility',
])

/** 引用噪音字段（资源/自引用类，地图模式聚合为计数而非逐条）。 */
const NOISE_REF_FIELDS = new Set([
  'm_Sprite', 'm_Font', 'm_Material', 'm_Image', 'm_TargetGraphic', 'm_HighlightedSprite', 'm_DisabledSprite',
  'm_PressedSprite', 'm_SelectedSprite', 'mainTexture', 'm_Texture', 'overrideSprite', 'm_Color', 'm_RaycastTarget',
  'm_Maskable', 'm_Content', 'm_Viewport', 'm_VerticalScrollbar', 'm_HorizontalScrollbar', 'm_HandleRect',
])

/**
 * 快照地图模式（v0.4.1，2026-08-20 用户设计指导：超大快照违背「一次快照+少量工具调用」初衷）：
 * 不再平铺截断树，而是基于 Library JSON 生成**分层地图**——概览 / 分支索引 / 业务引用 / 锚点索引 / 定位指引。
 * Agent 用地图定位（id/名字），再以 1~2 次定向工具调用（ui_snapshot(ids)/components）取局部细节，
 * 从而以最小上下文 + 最少探路式思考找到答案。
 */
function buildUiSnapshotMap(snap, maxChars) {
  const budget = Math.max(400, Number(maxChars) > 0 ? Number(maxChars) : 8000)
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : []
  const refs = Array.isArray(snap.refs) ? snap.refs : []
  if (nodes.length === 0) return ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  for (const n of nodes) {
    const p = n.parentId
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(n)
  }
  const refsBySource = new Map()
  for (const r of refs) {
    if (!refsBySource.has(r.sourceId)) refsBySource.set(r.sourceId, [])
    refsBySource.get(r.sourceId).push(r)
  }
  const backCount = new Map()
  for (const r of refs) {
    const t = r.targetGoId ?? r.targetId
    if (t !== undefined && t !== null) backCount.set(t, (backCount.get(t) || 0) + 1)
  }

  // 子树信息：{size, outRefs, backRefs, custom:Set, depth}
  const infoMap = new Map()
  const info = (id) => {
    if (infoMap.has(id)) return infoMap.get(id)
    const kids = childrenOf.get(id) || []
    let size = 1
    let outRefs = 0
    const custom = new Set()
    for (const k of kids) {
      const ki = info(k.id)
      size += ki.size
      outRefs += ki.outRefs
      for (const c of ki.custom) custom.add(c)
    }
    const n = byId.get(id)
    if (n && Array.isArray(n.components)) {
      for (const c of n.components) if (!BUILTIN_COMPONENTS.has(c)) custom.add(c)
    }
    outRefs += (refsBySource.get(id) || []).length
    const r = { size, outRefs, custom }
    infoMap.set(id, r)
    return r
  }
  for (const n of nodes) info(n.id)

  const roots = (Array.isArray(snap.roots) ? snap.roots : []).map(r => byId.get(r)).filter(Boolean)
  const rootNames = roots.map(r => '[' + r.id + ']' + (r.name || '')).join(' / ') || '（无根）'
  // 被引用数：JSON 无 backrefs 数组，从 refs 的目标去重统计（2026-08-20 地图模式修正）
  const backTotal = new Set(refs.map(r => r.targetGoId ?? r.targetId).filter(v => v !== undefined && v !== null)).size

  // ---- 段1：概览 + 根 + 分支索引 ----
  const s1 = []
  s1.push('# UI Snapshot 地图：' + nodes.length + ' 节点 / ' + refs.length + ' 引用 / ' + backTotal + ' 被引用')
  s1.push('根: ' + rootNames)
  const topIds = roots.length > 0 ? (childrenOf.get(roots[0].id) || []).map(k => k.id) : (childrenOf.get(null) || []).map(k => k.id)
  const topNodes = topIds.map(id => byId.get(id)).filter(Boolean)
  if (topNodes.length > 0) {
    s1.push('\n分支（名称 | 节点数 | 出引用 R | 自定义组件）:')
    const ranked = topNodes.map(n => {
      const i = info(n.id)
      return { n, size: i.size, out: i.outRefs, custom: [...i.custom].sort() }
    }).sort((a, b) => b.size - a.size)
    for (const t of ranked.slice(0, 14)) {
      const customTxt = t.custom.length > 0 ? ' | ' + t.custom.join(',') : ''
      s1.push('- [' + t.n.id + '] ' + (t.n.name || '?') + ' [' + t.size + ' 节点 R:' + t.out + ']' + customTxt)
    }
    if (ranked.length > 14) s1.push('… 还有 ' + (ranked.length - 14) + ' 个分支')
  }

  // ---- 段2：业务引用（噪音优先聚合计数；自定义组件字段全量；Unity 关键行为字段保留） ----
  const s2 = []
  const bizRefs = []
  const noiseCount = new Map() // 噪音聚合：component.field -> count
  for (const r of refs) {
    const comp = r.sourceComponent || ''
    const field = r.field || ''
    const isNoise = NOISE_REF_FIELDS.has(field) || r.targetKind === 'Asset' || (field.startsWith('m_') && !/m_OnClick/.test(field))
    if (isNoise) {
      noiseCount.set(comp + '.' + field, (noiseCount.get(comp + '.' + field) || 0) + 1)
    } else {
      const isCustom = !BUILTIN_COMPONENTS.has(comp)
      if (isCustom || /m_OnClick|m_Template|m_CaptionText|m_ItemText|m_Content|m_Viewport|m_VerticalScrollbar|m_HandleRect/.test(field)) {
        bizRefs.push(r)
      } else {
        noiseCount.set(comp + '.' + field, (noiseCount.get(comp + '.' + field) || 0) + 1)
      }
    }
  }
  if (bizRefs.length > 0) {
    s2.push('业务引用（组件.字段 -> 目标）:')
    const seen = new Set()
    for (const r of bizRefs) {
      const src = byId.get(r.sourceId)
      const key = (src ? src.id : r.sourceId) + '.' + (r.sourceComponent || '') + '.' + (r.field || '') + '->' + (r.targetGoId ?? r.targetId ?? '')
      if (seen.has(key)) continue
      seen.add(key)
      const tgt = r.targetGoId ?? r.targetId
      const tgtNode = tgt !== undefined && tgt !== null ? byId.get(tgt) : null
      const targetTxt = r.targetKind === 'Asset' ? (r.assetPath || 'asset')
        : tgtNode ? tgtNode.name
          : (tgt !== undefined && tgt !== null ? '[' + tgt + '](快照外)' : '?')
      pushLine(s2, '- [' + (src ? src.id : r.sourceId) + ']' + (src ? src.name : '') + '.' + (r.sourceComponent || '') + '.' + (r.field || '') + ' -> '
        + (r.method ? '[' + (tgtNode ? tgtNode.name : (tgt !== undefined && tgt !== null ? tgt + '(快照外)' : '?')) + '] : ' + r.method : ('[' + targetTxt + ']')))
    }
  }

  // ---- 段3：噪音聚合 ----
  const s3 = []
  if (noiseCount.size > 0) {
    const topNoise = [...noiseCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    s3.push('资源/自引用聚合（' + refs.length + ' 条引用中）: ' + topNoise.map(([k, v]) => k + ' ×' + v).join(', ') + (noiseCount.size > 8 ? ' …' : ''))
  }

  // ---- 段4：锚点索引（同名同热度组聚合，label/axis 系列） ----
  const s4 = []
  const anchors = nodes.filter(n => {
    const i = info(n.id)
    const nCustom = Array.isArray(n.components) ? n.components.some(c => !BUILTIN_COMPONENTS.has(c)) : false
    return i.outRefs >= 5 || (backCount.get(n.id) || 0) >= 2 || nCustom
  }).map(n => {
    const i = info(n.id)
    return { n, out: i.outRefs, back: backCount.get(n.id) || 0, custom: (n.components || []).filter(c => !BUILTIN_COMPONENTS.has(c)) }
  }).sort((a, b) => (b.out + b.back) - (a.out + a.back))
  if (anchors.length > 0) {
    s4.push('锚点（[id] 名称 (自定义组件) R:B | 定位地址簿）:')
    const groups = new Map() // name|comps|R|B -> {name, custom, out, back, ids: []}
    for (const a of anchors) {
      const key = (a.n.name || '?') + '|' + (a.custom.join(',') || '') + '|' + a.out + '|' + a.back
      if (!groups.has(key)) groups.set(key, { name: a.n.name, custom: a.custom, out: a.out, back: a.back, ids: [] })
      groups.get(key).ids.push(a.n.id)
    }
    const groupList = [...groups.values()]
    let shown = 0
    for (const g of groupList) {
      if (shown >= 30) break
      const idList = g.ids.length > 1 ? ' ×' + g.ids.length + ' ids: ' + g.ids.join(',') : ''
      pushLine(s4, '- [' + g.ids[0] + '] ' + (g.name || '?') + (g.custom.length > 0 ? ' (' + g.custom.join(',') + ')' : '') + ' R:' + g.out + ' B:' + g.back + idList)
      shown++
    }
    if (groupList.length > 30) s4.push('… 还有 ' + (groupList.length - 30) + ' 个锚点')
  }

  // ---- 段5：定位指引 ----
  const s5 = []
  s5.push('定位: 按名 find_gameobjects(名字) / 按 id ui_snapshot(ids=[id]) / 组件值 components 资源；完整快照见 Library ' + (snap.libraryPath || ''))

  // 分段预算：概览+分支 24% / 业务引用 30% / 噪音 8% / 锚点 30% / 定位 8%（大快照下各段都可见，不再整体截断吞掉锚点/定位）
  const cut = (arr, m) => {
    const s = arr.join('\n')
    return s.length <= m ? s : s.slice(0, m) + '\n…[该段超预算已截断]'
  }
  return cut(s1, Math.floor(budget * 0.24))
    + '\n' + cut(s2, Math.floor(budget * 0.30))
    + '\n' + cut(s3, Math.floor(budget * 0.08))
    + '\n' + cut(s4, Math.floor(budget * 0.30))
    + '\n' + cut(s5, Math.floor(budget * 0.08))
}

function pushLine(arr, line) { arr.push(line) }

/** 快照地图（JSON 可用时）；失败回退文本压缩模式。 */

/**
 * ui_snapshot 文本按「树 / Refs / Backrefs」三段预算分配 + 规则压缩，保证信息密度：
 *  - 树：去掉 rect 坐标（省 ~40%）；若 ≥80% 节点未激活，聚合为头部声明并去掉行内 (inactive)；
 *    相同结构的子树（如重复的 Dropdown 模板）只保留首个，后续以「重复子树」占位（2026-08-20 用户要求提密度）；
 *  - Refs：同一来源（[id]物体.组件）的连续引用只写一次来源，后续行只保留「字段 -> 目标」；
 *  - 无引用段（小快照/旧格式）原样返回。
 */
function compactUiSnapshot(text, maxChars) {
  if (typeof text !== 'string') return ''
  const budget = Math.max(400, Number(maxChars) > 0 ? Number(maxChars) : 8000)
  const refsMark = 'Refs (outgoing):'
  const backMark = 'Backrefs (incoming'
  const refsIdx = text.indexOf(refsMark)
  const backIdx = text.indexOf(backMark)
  if (refsIdx < 0) return text
  const treePart = compactUiTree(text.slice(0, refsIdx))
  const refsPart = compactUiRefs(backIdx >= 0 ? text.slice(refsIdx, backIdx) : text.slice(refsIdx))
  const backPart = compactUiBackrefs(backIdx >= 0 ? text.slice(backIdx) : '')
  const treeMax = Math.floor(budget * 0.55)
  const refsMax = Math.floor(budget * 0.30)
  const backMax = budget - treeMax - refsMax
  const cut = (s, m) => (s.length <= m ? s : s.slice(0, m) + '\n…[该段超出预算已截断]')
  return cut(treePart, treeMax) + cut(refsPart, refsMax) + cut(backPart, backMax)
}

/** 树压缩：去 rect、聚合 (inactive)（≥80% 时头部声明）、相同子树聚合（子树 ≥3 行才聚）。header 行（# UI Snapshot/Roots/Tree:）原样保留。 */
function compactUiTree(treeText) {
  const lines = treeText.split('\n').filter(l => l.trim().length > 0)
  const header = lines.filter(l => !/^\s*-/.test(l))
  const nodeLines = lines.filter(l => /^\s*-/.test(l))
  const total = nodeLines.length
  if (total === 0) return treeText
  const inact = nodeLines.filter(l => l.includes('(inactive)')).length
  // ≥80% 未激活 → 头部聚合声明并去行内标记；否则行内 (inactive) 压缩为「·」（省 ~10 字符/行，语义无损）
  const dropInactive = inact / total >= 0.8
  const dotInactive = !dropInactive && inact > 0
  const rows = nodeLines.map(l => {
    let s = l.replace(/ rect:\[[^\]]*\]\s*$/, '')
    if (dropInactive) s = s.replace(/ \(inactive\)/, '')
    else if (dotInactive) s = s.replace(/ \(inactive\)/, ' ·')
    return s
  })
  const indents = rows.map(l => (l.match(/^\s*/) || [''])[0].length)
  // 结构签名：缩进 + 去 id + **名字数字归一**（label_0_0 / label_0_1 / axis_x0 等生成器同构叶子可聚合）
  // + 子树签名——相同结构聚合（不同 id/序号允许，显示仍保留原名）；R:B 保留在签名里（保守不误聚）
  const norm = rows.map(l => l.replace(/\[-?\d+\]/g, '[id]').replace(/(\d+)/g, 'N').trim())
  const children = rows.map(() => [])
  const stack = []
  for (let i = 0; i < rows.length; i++) {
    while (stack.length && indents[stack[stack.length - 1]] >= indents[i]) stack.pop()
    if (stack.length) children[stack[stack.length - 1]].push(i)
    stack.push(i)
  }
  const sigCache = new Map()
  const sig = (i) => {
    if (sigCache.has(i)) return sigCache.get(i)
    const s = norm[i] + '{' + children[i].map(sig).join('|') + '}'
    sigCache.set(i, s)
    return s
  }
  const sizeCache = new Map()
  const size = (i) => {
    if (sizeCache.has(i)) return sizeCache.get(i)
    const n = 1 + children[i].reduce((s, c) => s + size(c), 0)
    sizeCache.set(i, n)
    return n
  }
  const seen = new Map() // sig -> 首次行号（1 起）
  const out = []
  let skipUntil = -1
  for (let i = 0; i < rows.length; i++) {
    if (i <= skipUntil) continue
    const s = sig(i)
    const first = seen.get(s)
    const sz = size(i)
    if (first !== undefined && sz >= 3) {
      out.push(' '.repeat(indents[i]) + '…[重复子树（同第 ' + first + ' 行结构），跳过 ' + (sz - 1) + ' 行]')
      skipUntil = i + sz - 1
      continue
    }
    if (first === undefined && sz >= 3) seen.set(s, i + 1)
    out.push(rows[i])
  }
  const head = dropInactive ? '（以下节点均为未激活，inactive 标记已省略）\n' : dotInactive ? '（· 表示未激活）\n' : ''
  return header.join('\n') + (header.length ? '\n' : '') + head + out.join('\n')
}

/** Refs 压缩：同一来源（[id]物体.组件）的连续引用只保留一次来源；连续完全相同行合并为 ×N（如 BarChart.m_Font 重复 22 行）。 */
function compactUiRefs(refsText) {
  const out = []
  let prevSrc = null
  let prevOut = null
  let repeat = 0
  const push = (line) => {
    if (line === prevOut) { repeat++; return }
    if (prevOut !== null) out.push(repeat > 1 ? prevOut + ' ×' + repeat : prevOut)
    prevOut = line
    repeat = 1
  }
  for (const raw of refsText.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const arrow = l.indexOf(' -> ')
    if (arrow < 0) { push(l); prevSrc = null; continue }
    const src = l.slice(0, arrow)
    const tail = l.slice(arrow + 4)
    const dot = src.lastIndexOf('.')
    const prefix = dot > 0 ? src.slice(0, dot) : null
    const field = dot > 0 ? src.slice(dot + 1) : null
    if (prefix && field && prefix === prevSrc) push('  ' + field + ' -> ' + tail)
    else { push(l); prevSrc = prefix }
  }
  if (prevOut !== null) out.push(repeat > 1 ? prevOut + ' ×' + repeat : prevOut)
  return out.join('\n')
}

/** Backrefs 压缩：同一被引用目标（[id]物体）的多条来源合并为逗号列表。 */
function compactUiBackrefs(backText) {
  const out = []
  let pending = null // { target, sources: [] }
  const flush = () => {
    if (pending) { out.push(pending.target + ' <- ' + pending.sources.join(', ')); pending = null }
  }
  for (const raw of backText.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const arr = l.indexOf(' <- ')
    if (arr < 0) { flush(); out.push(l); continue }
    const tgt = l.slice(0, arr)
    const src = l.slice(arr + 4)
    if (pending && pending.target === tgt) pending.sources.push(src)
    else { flush(); pending = { target: tgt, sources: [src] } }
  }
  flush()
  return out.join('\n')
}

// 探测代码：查 Unity 编辑器忙状态（编译/刷新/进度条）。输出 "c=<0|1>;u=<0|1>;p=<count>"。
const PROBE_CODE = [
  'var sb=new System.Text.StringBuilder();',
  'sb.Append("c=").Append(UnityEditor.EditorApplication.isCompiling?"1":"0");',
  'sb.Append(";u=").Append(UnityEditor.EditorApplication.isUpdating?"1":"0");',
  'try{sb.Append(";p=").Append(UnityEditor.Progress.GetCount());}catch{sb.Append(";p=-1");}',
  'return sb.ToString();',
].join('')

/**
 * 探测 Unity 编辑器忙状态（走 client 直调 execute_code，不经 unity_mcp 工具入口，无递归）。
 * @returns {{ok:boolean, busy:boolean, raw:string}} ok=false 表示探测本身失败（视为可能忙，保守等待）。
 */
async function probeEditorState(client) {
  try {
    const r = await client.callTool('execute_code', { action: 'execute', code: PROBE_CODE })
    if (r.isError) return { ok: false, busy: true, raw: '探测失败: ' + String(r.text ?? '').slice(0, 160) }
    const m = /c=(-?\d+);u=(-?\d+);p=(-?\d+)/.exec(String(r.text ?? ''))
    if (!m) return { ok: false, busy: true, raw: '探测结果不可解析: ' + String(r.text ?? '').slice(0, 160) }
    const busy = m[1] !== '0' || m[2] !== '0' || Number(m[3]) > 0
    return { ok: true, busy, raw: 'isCompiling=' + m[1] + ',isUpdating=' + m[2] + ',progressCount=' + m[3] }
  } catch (err) {
    return { ok: false, busy: true, raw: '探测异常: ' + String(err?.message ?? err).slice(0, 160) }
  }
}

export class UnityPool {
  constructor(ctx, cfg) {
    this.ctx = ctx
    this.cfg = {
      services: cfg.services,
      dataFile: cfg.dataFile,
      probeIntervalMs: Number(cfg.probeIntervalMs) || 10000,
      probeTimeoutMs: Number(cfg.probeTimeoutMs) || 3000,
      scanPorts: Array.isArray(cfg.scanPorts) ? cfg.scanPorts : [8080, 8081, 8082, 8083, 8084, 8090],
      autoAssign: cfg.autoAssign !== false,
      enforceExclusive: cfg.enforceExclusive !== false,
      connectHint: typeof cfg.connectHint === 'string' ? cfg.connectHint : '',
      busyWaitEnabled: cfg.busyWaitEnabled !== false,
      busyMaxWaitMs: Number(cfg.busyMaxWaitMs) > 0 ? Number(cfg.busyMaxWaitMs) : 10000,
      busyWaitIntervalMs: Number(cfg.busyWaitIntervalMs) > 0 ? Number(cfg.busyWaitIntervalMs) : 500,
      autoUnbindOnArchive: cfg.autoUnbindOnArchive !== false,
      callReconnectTimeoutMs: Number(cfg.callReconnectTimeoutMs) > 0 ? Number(cfg.callReconnectTimeoutMs) : 20000,
      // 状态携带（v0.4.0）：默认全关
      stateEnabled: cfg.stateEnabled === true,
      stateGameScreenshot: cfg.stateGameScreenshot === true,
      stateSceneScreenshot: cfg.stateSceneScreenshot === true,
      stateSelection: cfg.stateSelection === true,
      stateUiSnapshot: cfg.stateUiSnapshot === true,
      stateSerialized: cfg.stateSerialized === true,
      stateConsoleAll: cfg.stateConsoleAll === true,
      stateConsoleSelected: cfg.stateConsoleSelected === true,
      stateRefreshMs: Number(cfg.stateRefreshMs) > 0 ? Number(cfg.stateRefreshMs) : 3000,
      stateScreenshotMaxRes: Number(cfg.stateScreenshotMaxRes) > 0 ? Number(cfg.stateScreenshotMaxRes) : 640,
      stateDir: typeof cfg.stateDir === 'string' && cfg.stateDir ? cfg.stateDir : path.join(homedir(), '.dsh', 'unity-pool-state'),
      stateMaxChars: Number(cfg.stateMaxChars) > 0 ? Number(cfg.stateMaxChars) : 8000,
      stateSnapshotMaxChars: Number(cfg.stateSnapshotMaxChars) > 0 ? Number(cfg.stateSnapshotMaxChars) : 8000,
      stateConsoleMaxChars: Number(cfg.stateConsoleMaxChars) > 0 ? Number(cfg.stateConsoleMaxChars) : 6000,
      stateConsoleCount: Number(cfg.stateConsoleCount) > 0 ? Number(cfg.stateConsoleCount) : 50,
      screenshotStaleMs: Number(cfg.screenshotStaleMs) > 0 ? Number(cfg.screenshotStaleMs) : 10000,
      // 原生工具注册（v0.5.0）
      nativeToolsEnabled: cfg.nativeToolsEnabled !== false,
      nativeToolSchema: cfg.nativeToolSchema === 'full' ? 'full' : 'compact',
    }
    this.services = this.cfg.services.map(s => ({
      id: String(s.id),
      name: String(s.name || s.id),
      url: normalizeUrl(s.url),
      alive: null,
      aliveAt: 0,
      lastError: null,
      instances: [],
      discoveredAt: 0,
      instancesValid: false, // 最近一次实例发现是否成功（false=发现失败，列表可能过期，不据此判离线）
      offlineStreak: 0,      // 连续离线探测次数（在线时归零）
    }))
    this.bindings = Object.create(null) // sessionId -> { serviceId, instanceId, boundAt }
    this.sessionClients = new Map()     // sessionId -> { serviceId, client: McpHttpClient }
    this.discoveryClients = new Map()   // serviceId -> McpHttpClient（探测/实例发现用）
    this.probeTimer = null
    this.stateTimer = null              // 状态采集定时器（仅 stateEnabled 时启）
    this.stateCaches = new Map()        // sessionId -> { at, instanceId, entries: [{key,label,ok,text?,file?,error?}] }
    this._stateCollecting = false       // 采集防重入标志
    this._stateTurnMap = new Map()      // sessionId -> 最近一次已注入的回合号（每回合只注入一次状态）
    this.stateSwitchLog = []             // 开关操作流水（诊断用，最多 40 条）
    // 状态开关按会话独立（v0.4.2，2026-08-21 用户纠正「全会话共享 + 只有绑定才能控制 → 不成闭环」）：
    //   cfg.stateXxx = 配置默认层（构造后不再被运行时修改）
    //   _stateSwitchesBase = 旧版全局平铺持久化（v0.4.1 及之前），作为全局默认层迁移兼容
    //   _stateSwitchesBySession = 每会话覆盖层 { [sessionId]: { key: bool } }（含"关"，磁盘持久化）
    //   生效值 = cfg 默认 ← base ← per-session 覆盖（getStateSwitches）
    this._stateSwitchesBase = null
    this._stateSwitchesBySession = Object.create(null)
    this._load()

    // ---- 原生工具注册（v0.5.0）----
    // nativeDisposers: serviceId -> Map<umcpName, disposer>（DSH tools.register 返回的注销函数）
    // nativeToolOwner: umcpName -> serviceId（同名工具跨服务时后绑定者接管）
    this.nativeDisposers = new Map()
    this.nativeToolOwner = new Map()
    this._toolRegistry = (ctx && ctx.tools && typeof ctx.tools.register === 'function') ? ctx.tools : null

    // ---- 会话归档（session/disposed）驱动解绑（v0.5.1 设计修正）----
    // 归档的语义是「会话被归档（DSH session/disposed）」→ 清理该会话锁定的实例；
    // 实例掉线/域重载是无感的——绑定保持、不主动解绑、不注入通知，实例离线只在调用时由
    // unity_mcp/umcp_* 自动重连并在超时（callReconnectTimeoutMs）后返回失败原因。
    this._disposedUnbindDisposer = null
    if (ctx && typeof ctx.on === 'function') {
      this._disposedUnbindDisposer = ctx.on('session/disposed', (session) => this._onSessionDisposed(session))
    }
  }

  /** 会话归档（DSH session/disposed）时清理该会话锁定的实例（autoUnbindOnArchive 默认开启）。 */
  _onSessionDisposed(session) {
    if (this.cfg.autoUnbindOnArchive === false) return
    const sid = session && session.id
    if (sid && this.bindings[String(sid)]) this.unbind(String(sid))
  }

  // ---- 持久化 ----

  _load() {
    try {
      const raw = fs.readFileSync(this.cfg.dataFile, 'utf8')
      const data = JSON.parse(raw)
      const bindings = (data && typeof data.bindings === 'object' && data.bindings) || {}
      const seen = new Set(this.services.map(s => s.id))
      for (const [sid, b] of Object.entries(bindings)) {
        const bv = (b && typeof b === 'object') ? b : {}
        if (typeof bv.serviceId === 'string' && seen.has(bv.serviceId)) {
          this.bindings[sid] = {
            serviceId: bv.serviceId,
            instanceId: typeof bv.instanceId === 'string' ? bv.instanceId : null,
            boundAt: Number(bv.boundAt) || Date.now(),
          }
        }
      }
      // 状态开关持久化（v0.4.1 旧版全局平铺 → v0.4.2 按会话）：
      // 旧 stateSwitches 作为全局默认层（base，迁移兼容）；新 stateSwitchesBySession 按会话覆盖
      const sw = (data && typeof data.stateSwitches === 'object' && data.stateSwitches) || null
      this._stateSwitchesBase = sw && Object.keys(sw).length > 0 ? sw : null
      const bySession = (data && typeof data.stateSwitchesBySession === 'object' && data.stateSwitchesBySession) || null
      if (bySession) {
        for (const [sid, s] of Object.entries(bySession)) {
          if (s && typeof s === 'object') this._stateSwitchesBySession[sid] = s
        }
      }
    } catch { /* 首次运行或文件损坏 */ }
  }

  _save() {
    try {
      const file = this.cfg.dataFile
      const payload = JSON.stringify({
        bindings: this.bindings,
        stateSwitches: this._stateSwitchesBase,
        stateSwitchesBySession: this._stateSwitchesBySession,
      }, null, 2)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 持久化绑定失败: ' + String(err?.message ?? err))
    }
  }

  /**
   * 取某会话的状态携带开关（v0.4.2 按会话独立）：
   * 合并顺序 = 配置默认（cfg.stateXxx）← 旧全局持久化层（_stateSwitchesBase，迁移兼容）
   *          ← 本会话覆盖层（_stateSwitchesBySession[sessionId]，含"关"）。
   * 未切换过的会话 = 配置默认 + base（全局默认层）。
   */
  getStateSwitches(sessionId) {
    const out = {}
    for (const key of STATE_SWITCH_KEYS) out[key] = this.cfg[key] === true
    const base = this._stateSwitchesBase
    if (base && typeof base === 'object') {
      for (const key of STATE_SWITCH_KEYS) {
        if (typeof base[key] === 'boolean') out[key] = base[key]
      }
    }
    const own = this._stateSwitchesBySession[sessionId]
    if (own && typeof own === 'object') {
      for (const key of STATE_SWITCH_KEYS) {
        if (typeof own[key] === 'boolean') out[key] = own[key]
      }
    }
    return out
  }

  // ---- 服务与实例 ----

  serviceById(id) {
    return this.services.find(s => s.id === id) || null
  }

  discoveryClient(service) {
    let c = this.discoveryClients.get(service.id)
    if (!c) {
      c = new McpHttpClient(service.url, { timeoutMs: this.cfg.probeTimeoutMs, logger: this.ctx?.logger })
      this.discoveryClients.set(service.id, c)
    }
    return c
  }

  /** 单服务：探活 + 实例发现。 */
  async probeService(service) {
    if (!service.url) {
      service.alive = false
      service.lastError = 'empty url'
      return
    }
    try {
      const res = await fetch(service.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(500, this.cfg.probeTimeoutMs)),
        headers: { accept: 'application/json, text/plain, */*' },
      })
      service.alive = true
      service.aliveAt = Date.now()
      service.lastError = null
      service.offlineStreak = 0
    } catch (err) {
      service.alive = false
      service.lastError = String((err && err.name === 'AbortError') ? 'timeout' : (err?.message ?? err))
      service.offlineStreak = (service.offlineStreak || 0) + 1
      // 服务离线：实例必然不可达，清空列表（归档判定走 alive=false 分支）
      service.instances = []
      service.instancesValid = false
      return
    }
    // 实例发现（best-effort）：读 mcpforunity://instances
    try {
      const client = this.discoveryClient(service)
      const instances = await client.listInstances()
      service.instances = instances
      service.discoveredAt = Date.now()
      service.instancesValid = true
    } catch (err) {
      // 发现失败≠实例消失：保留上次成功发现的列表，标记 instancesValid=false，
      // 归档判定只在 instancesValid=true（本次发现成功）时进行，避免误判。
      service.lastError = 'instances: ' + String(err?.message ?? err)
      service.instancesValid = false
    }
  }

  async probe() {
    // 探测只负责服务存活 + 实例发现（刷新视图），不做任何自动解绑——
    // 归档的语义是「会话归档（session/disposed）」，实例掉线/域重载对已绑定会话是无感的（见 _onSessionDisposed）。
    await Promise.all(this.services.map(s => this.probeService(s)))
  }

  /** 扫描额外端口，把新发现的 MCP 服务并入池（幂等：同 url 不重复）。 */
  async scan() {
    const found = []
    const urls = new Set(this.services.map(s => s.url))
    const existingIds = new Set(this.services.map(s => s.id))
    let index = 1
    for (const port of this.cfg.scanPorts) {
      const url = 'http://127.0.0.1:' + Number(port) + '/mcp'
      if (urls.has(url)) continue
      const candidate = { id: 'scan-' + (index++), name: 'Scan-' + port, url, alive: false, aliveAt: 0, lastError: null, instances: [], discoveredAt: 0, instancesValid: false, offlineStreak: 0 }
      await this.probeService(candidate)
      if (candidate.alive) {
        const ok = await this.tryInitialize(candidate)
        if (!ok) { candidate.alive = false; candidate.lastError = 'not an MCP server' }
      }
      if (candidate.alive) {
        if (!existingIds.has(candidate.id)) {
          this.services.push(candidate)
          found.push({ id: candidate.id, name: candidate.name, url: candidate.url, instanceCount: candidate.instances.length })
        }
      }
    }
    return found
  }

  async tryInitialize(service) {
    try {
      const client = this.discoveryClient(service)
      await client.ensureInit()
      return true
    } catch { return false }
  }

  start() {
    if (this.probeTimer) return
    this.probe()
    this.probeTimer = setInterval(() => { this.probe() }, Math.max(1000, this.cfg.probeIntervalMs))
    if (this.probeTimer.unref) this.probeTimer.unref()
    this.startStateTimer()
  }

  stop() {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
    if (this._disposedUnbindDisposer) { try { this._disposedUnbindDisposer() } catch { /* ignore */ } this._disposedUnbindDisposer = null }
    this.stopStateTimer()
    this.disposeAllNativeTools()
  }

  // ---- 原生工具注册（v0.5.0，2026-08-21）----
  // 绑定后把该服务的 MCP 工具动态注册为 DSH 原生工具（umcp_<工具名>），模型上下文直接可见可调。
  // 设计：
  //  - 注册键 = 服务：syncNativeTools(serviceId) 先注销该服务旧注册，再按最新 tools/list 全量重注册；
  //  - 跨服务同名（两个 mcp-for-unity 服务都有 manage_scene）→ 后绑定者接管（先注销旧占用方同名工具）；
  //  - 解绑不注销（其他会话可能绑定同一服务）；stop() 时全量注销（ctx.tools.register 返回的 disposer）；
  //  - schema 形态：compact（默认，参数名+description，省上下文）/ full（完整 inputSchema，Claude 同款）；
  //  - execute 统一转发 pool.proxyMcp（未绑定报错/实例激活/忙等待/未知工具提示全部复用）。

  /** 已注册原生工具摘要（view 用）：按服务返回 {serviceId, count, names}。 */
  nativeToolsSummary() {
    const out = []
    for (const [serviceId, regs] of this.nativeDisposers) {
      if (!regs || regs.size === 0) continue
      out.push({
        serviceId,
        count: regs.size,
        names: [...regs.keys()].sort(),
      })
    }
    return out
  }

  /** 注销某服务的全部原生工具（旧注册；同名刷新时先清后注）。 */
  _disposeNativeServiceTools(serviceId) {
    const regs = this.nativeDisposers.get(serviceId)
    if (!regs) return
    for (const [umcpName, d] of regs) {
      try { d() } catch { /* 注销失败不影响继续 */ }
      if (this.nativeToolOwner.get(umcpName) === serviceId) this.nativeToolOwner.delete(umcpName)
    }
    this.nativeDisposers.delete(serviceId)
  }

  /** 注销全部服务的原生工具（插件 stop 时调用）。 */
  disposeAllNativeTools() {
    for (const serviceId of [...this.nativeDisposers.keys()]) {
      this._disposeNativeServiceTools(serviceId)
    }
  }

  /**
   * 按某服务最新 tools/list 同步注册原生工具（幂等：先清旧再全量重注册）。
   * tools 为 MCP 工具数组（name/description/inputSchema）；空数组 = 只清空。
   * 未启用 nativeToolsEnabled 或当前 ctx 无 tools 注册器时直接跳过。
   */
  syncNativeTools(serviceId, tools) {
    if (this.cfg.nativeToolsEnabled === false) return
    if (!this._toolRegistry) return // createPool 的测试 ctx 可能无 tools
    const list = Array.isArray(tools) ? tools : []
    this._disposeNativeServiceTools(serviceId)
    if (list.length === 0) return
    const regs = new Map()
    for (const t of list) {
      const origName = t && typeof t.name === 'string' ? t.name : null
      if (!origName) continue
      const umcpName = 'umcp_' + origName.replace(/[^A-Za-z0-9_-]/g, '_')
      // 跨服务同名接管：注销旧占用方（若有）
      const prevOwner = this.nativeToolOwner.get(umcpName)
      if (prevOwner && prevOwner !== serviceId) {
        const pold = this.nativeDisposers.get(prevOwner)
        if (pold && pold.has(umcpName)) {
          try { pold.get(umcpName)() } catch { /* ignore */ }
          pold.delete(umcpName)
        }
        this.nativeToolOwner.delete(umcpName)
      }
      try {
        const disposer = this._registerNativeTool(serviceId, umcpName, origName, t)
        regs.set(umcpName, disposer)
        this.nativeToolOwner.set(umcpName, serviceId)
      } catch (err) {
        this.ctx?.logger?.warn?.('[unity-pool] 注册原生工具 ' + umcpName + ' 失败: ' + String(err?.message ?? err))
      }
    }
    if (regs.size > 0) this.nativeDisposers.set(serviceId, regs)
  }

  /** 注册单个原生工具（umcp_<原名> → proxyMcp 转发）。返回 DSH tools.register 的 disposer。 */
  _registerNativeTool(serviceId, umcpName, origName, mcpTool) {
    const pool = this
    const full = this.cfg.nativeToolSchema === 'full'
    const rawDesc = String(mcpTool.description ?? '').trim()
    const desc = '（unity-pool 原生代理 ' + serviceId + '：Unity MCP 工具 ' + origName + '）'
      + (rawDesc ? (full ? '\n' + rawDesc : '\n' + (rawDesc.length > 300 ? rawDesc.slice(0, 300) + '…' : rawDesc)) : '')
      + ' 调用前需先用 unity_pool_bind 锁定本会话目标实例；本工具等价于 unity_mcp(tool="' + origName + '", params=...) 的直接调用。'
    const parameters = this._mcpParamsToSpec(mcpTool.inputSchema)
    return this._toolRegistry.register(defineTool({
      name: umcpName,
      description: desc,
      parameters,
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.text === 'string' ? v.text : JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        return await pool.proxyMcp(sessionId, origName, args, undefined)
      },
    }))
  }

  /** MCP inputSchema（标准 JSON Schema object root）→ DSH defineTool parameters（property map）。 */
  _mcpParamsToSpec(inputSchema) {
    if (!inputSchema || typeof inputSchema !== 'object') return {}
    const props = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {}
    const required = Array.isArray(inputSchema.required) ? new Set(inputSchema.required) : new Set()
    const spec = {}
    for (const [key, v] of Object.entries(props)) {
      if (!v || typeof v !== 'object') continue
      const p = this._mcpValueToSpec(v)
      if (!p) continue
      if (required.has(key)) p.required = true
      spec[key] = p
    }
    return spec
  }

  /** MCP 属性 JSON Schema → DSH ValueSchemaSpec。
   *  compact（默认）：基础标量类型保留（string/number/integer/boolean），复杂/嵌套（array/object/anyOf/未知）
   *    降级宽松 json（不校验，由 Unity 侧 pydantic 裁决），description 截断 —— 省上下文且不误拒合法参数；
   *  full：完整 inputSchema 逐级映射（Claude 注册 MCP 工具同款）。 */
  _mcpValueToSpec(s) {
    if (!s || typeof s !== 'object') return null
    const desc = typeof s.description === 'string' ? s.description : ''
    const extra = Array.isArray(s.enum) && s.enum.length > 0 ? ' 可选值: ' + JSON.stringify(s.enum) : ''
    const t = Array.isArray(s.type) ? s.type[0] : s.type
    if (this.cfg.nativeToolSchema !== 'full') {
      const d = (desc + extra).slice(0, 200)
      switch (t) {
        case 'string': return { type: 'string', description: d }
        case 'number': return { type: 'number', description: d }
        case 'integer': return { type: 'integer', description: d }
        case 'boolean': return { type: 'boolean', description: d }
        default: return { type: 'json', description: d }
      }
    }
    switch (t) {
      case 'string':
        return { type: 'string', description: desc, ...(Array.isArray(s.enum) ? { enum: s.enum.filter(x => typeof x === 'string') } : {}) }
      case 'number':
        return { type: 'number', description: desc }
      case 'integer':
        return { type: 'integer', description: desc }
      case 'boolean':
        return { type: 'boolean', description: desc }
      case 'array':
        return { type: 'array', items: this._mcpValueToSpec(Array.isArray(s.items) ? s.items[0] : s.items) ?? { type: 'json' }, description: desc }
      case 'object': {
        const inner = this._mcpParamsToSpec(s)
        return { type: 'object', properties: inner, additionalProperties: true, description: desc }
      }
      default:
        return { type: 'json', description: desc }
    }
  }

  // ---- 绑定（实例级） ----

  sessionsTargeting(instanceId) {
    return Object.entries(this.bindings)
      .filter(([, b]) => b.instanceId === instanceId)
      .map(([sid]) => sid)
  }

  bindingOf(sessionId) {
    const b = this.bindings[sessionId]
    if (!b) return null
    const svc = this.serviceById(b.serviceId)
    if (!svc) return null
    const inst = svc.instances.find(i => i.id === b.instanceId) || (b.instanceId ? { id: b.instanceId, name: b.instanceId, hash: '' } : null)
    return { serviceId: b.serviceId, instanceId: b.instanceId, boundAt: b.boundAt, service: svc, instance: inst }
  }

  // ---- 状态携带（v0.4.0）----

  /** 是否为本会话启用状态携带（总开关开 + 至少一项子开关开；v0.4.2 按会话读开关）。 */
  stateCarryEnabled(sessionId) {
    const sw = this.getStateSwitches(sessionId)
    if (sw.stateEnabled !== true) return false
    return sw.stateGameScreenshot || sw.stateSceneScreenshot || sw.stateSelection
      || sw.stateUiSnapshot || sw.stateSerialized || sw.stateConsoleAll
      || sw.stateConsoleSelected
  }

  /** 截断助手：超长文本截断并标注（防超长注入）。 */
  static truncate(text, maxChars, label) {
    const s = String(text ?? '')
    if (s.length <= maxChars) return s
    return s.slice(0, maxChars) + '\n…[已截断 ' + s.length + ' 字符，仅显示前 ' + maxChars + ' 字符]'
  }

  /** 会话状态目录（截图 PNG 落盘，按会话隔离）。 */
  stateDirOf(sessionId) {
    const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
    return path.join(this.cfg.stateDir, safe)
  }

  /**
   * 采集一个会话的状态快照（异步走该会话 MCP client，各开关项独立容错，单项失败不阻断整体）。
   * 结果写入 this.stateCaches[sessionId]；截图 PNG 落盘到 stateDirOf(sessionId)。
   */
  async collectState(sessionId, opts = {}) {
    if (this._stateCollecting) return null // 全局防重入：采集轮次错开，避免多会话并发打满 Unity
    this._stateCollecting = true
    try {
      const sw = this.getStateSwitches(sessionId) // v0.4.2：按会话读开关（各自控制自己的采集项）
      const binding = this.bindingOf(sessionId)
      if (!binding || !binding.serviceId) return null
      const service = this.serviceById(binding.serviceId)
      if (!service) return null
      const instance = binding.instanceId
      if (!instance) return null
      const client = this.sessionClient(sessionId, service)
      await client.ensureInit()
      if (client.activeInstance !== instance) await client.setActive(instance)

      // 忙时跳过（v0.4.1，2026-08-20 用户第 3 次遇到「Unity 反复读条」）：Unity 编译/刷新/进度条期间
      // 不采集（保留旧缓存），避免采集路径撞主线程加剧读条。此前只给 unity_mcp 代理加了忙时等待，
      // 采集路径（collectState）漏了——且 ui_snapshot force_refresh 每次全量重扫让问题放大。
      try {
        const probe = await probeEditorState(client)
        if (!probe.ok || probe.busy) return null
      } catch { return null }

      const entries = []
      const at = Date.now()

      // Game / Scene 视图截图（PNG 落盘，上下文给路径）
      const shot = async (key, label, captureSource, fileName) => {
        try {
          const res = await client.callTool('manage_camera', {
            action: 'screenshot',
            capture_source: captureSource,
            include_image: true,
            max_resolution: this.cfg.stateScreenshotMaxRes,
          })
          if (res.isError) throw new Error(res.text || 'manage_camera failed')
          const img = Array.isArray(res.content) ? res.content.find(b => b && b.type === 'image' && typeof b.data === 'string') : null
          if (!img) {
            entries.push({ key, label, ok: false, error: '截图响应没有图片块（include_image 未生效？）' })
            return
          }
          const buf = Buffer.from(img.data, 'base64')
          const dir = this.stateDirOf(sessionId)
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, fileName)
          fs.writeFileSync(file, buf)
          // updatedAt：状态块里显示「更新 HH:MM:SS」，截图刷新后文本变化 → 宿主去重重新注入
          entries.push({ key, label, ok: true, file, updatedAt: Date.now(), width: Number(res.structuredContent?.data?.imageWidth) || undefined })
        } catch (err) {
          entries.push({ key, label, ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // 当前选中项（Hierarchy / Project 统一读取 UnityEditor.Selection）
      const SELECTION_CODE = [
        'var sb=new System.Text.StringBuilder();',
        'var objs=UnityEditor.Selection.objects;',
        'sb.Append("count=").Append(objs!=null?objs.Length:0);',
        'if(objs!=null){foreach(var o in objs){',
        '  if(o==null){sb.Append(System.Environment.NewLine).Append("- null");continue;}',
        '  sb.Append(System.Environment.NewLine).Append("- ").Append(o.name).Append(" | type=").Append(o.GetType().Name);',
        '  var go=o as GameObject;',
        '  if(go!=null){sb.Append(" | id=").Append(go.GetInstanceID());',
        '    var parts=new System.Collections.Generic.List<string>();var t=go.transform;',
        '    while(t!=null){parts.Insert(0,t.name);t=t.parent;}',
        '    sb.Append(" | path=").Append(string.Join("/",parts.ToArray()));}',
        '  var p=UnityEditor.AssetDatabase.GetAssetPath(o);',
        '  if(!string.IsNullOrEmpty(p))sb.Append(" | asset=").Append(p);',
        '}}',
        'return sb.ToString();',
      ].join('')

      let selectionText = ''
      const execSelection = async () => {
        const res = await client.callTool('execute_code', { action: 'execute', code: SELECTION_CODE, safety_checks: true })
        if (res.isError) throw new Error(res.text || 'execute_code failed')
        try {
          const parsed = typeof res.structuredContent?.data?.result === 'string'
            ? res.structuredContent.data.result
            : JSON.parse(res.text).data?.result
          return String(parsed ?? res.text)
        } catch { return String(res.text) }
      }

      if (sw.stateSelection) {
        try {
          selectionText = await execSelection()
          entries.push({ key: 'selection', label: '当前选中项', ok: true, text: UnityPool.truncate(selectionText, this.cfg.stateMaxChars, '选中项') })
        } catch (err) {
          entries.push({ key: 'selection', label: '当前选中项', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      } else if (sw.stateUiSnapshot || sw.stateSerialized) {
        // ui-snapshot / 序列化字段依赖选中 GameObject：即使 selection 开关关，也内部取一次选中项
        try { selectionText = await execSelection() } catch { /* 忽略，后续项会报错 */ }
      }

      // 选中 GameObject 第一个 id（供 ui-snapshot / 序列化字段使用）。
      // 注意：场景内 GameObject 的 InstanceID 是负数（正数是资源资产），正则必须支持负号——
      // 曾用 id=(\d+) 导致场景物体永远解析失败、误报“不是 GameObject”（2026-08-20 实测）。
      const firstGoId = (() => {
        const m = /- ([^\n]+) \| type=GameObject \| id=(-?\d+)/.exec(selectionText)
        return m ? Number(m[2]) : null
      })()
      // 选中项摘要（失败注入时附带，让 Agent/用户不用读就能知道选中了什么）
      const selBriefText = selectionText && selectionText.includes('count=')
        ? UnityPool.truncate(selectionText.split('\n').slice(0, 2).join('\n'), 400, '选中项')
        : ''

      // 选中物体 ui-snapshot 快照（自定义工具，未注册则报错提示）
      if (sw.stateUiSnapshot) {
        try {
          if (!firstGoId) throw new Error(selectionText.includes('count=0') ? '当前没有选中物体' : '选中项不是 GameObject（无法做 ui-snapshot）')
          const res = await client.callTool('ui_snapshot', {
            ids: [firstGoId],
            include_children: true,
            // 必须包含未激活物体：选中项常是隐藏的 UI 面板（inactive），
            // 传 false 会把根物体整个排除、返回 0 nodes 空快照（2026-08-20 实测：健康-弹窗2（半面板）inactive）
            include_inactive: true,
            // 引用/被引用带名字（默认只显示实例ID；用户需要引用明细可读，2026-08-20）
            names_in_refs: true,
            max_nodes: 120,
            max_refs: 120,
            // 工具侧给足预算（避免工具先截断），插件再按「树/引用/被引用」预算分配保证引用部分可见
            max_chars: 20000,
            // 缓存优先（v0.4.1，2026-08-20 用户第 3 次遇到「Unity 反复读条」的根因之一）：
            // force_refresh=true 让每次采集（含 3s 轮询）都全量重建快照——8933 节点快照重扫打满主线程。
            // 工具缓存按 ids 键控：同一选中反复采集命中缓存（零重扫）；换选中 = 新 ids 自动新生成。
            force_refresh: false,
          })
          if (res.isError) throw new Error(res.text || 'ui_snapshot failed')
          let text = res.text
          let mapText = null
          try {
            const parsed = JSON.parse(res.text)
            if (parsed && typeof parsed.data?.text === 'string') text = parsed.data.text
            else if (parsed && typeof parsed.data?.summary?.nodeCount === 'number') {
              text = '节点 ' + parsed.data.summary.nodeCount + ' 个 / 引用 ' + parsed.data.summary.refCount + ' 个（完整快照见 Library ' + (parsed.data.summary.libraryPath || '') + '）'
            }
            // 快照地图模式（v0.4.1，2026-08-20 用户设计指导）：解析 Library JSON（同机绝对路径）生成
            // 分层地图（概览/分支/业务引用/锚点/定位指引）——超大快照下比平铺截断树信息密度高得多；
            // JSON 解析失败回退下方 md/data.text 压缩流程。
            if (parsed?.data?.summary?.absolutePath) {
              try {
                const jsonPath = String(parsed.data.summary.absolutePath)
                const snap = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''))
                if (Array.isArray(snap.nodes) && Array.isArray(snap.refs) && snap.nodes.length > 0) {
                  snap.libraryPath = parsed.data.summary.libraryPath || ''
                  mapText = buildUiSnapshotMap(snap, this.cfg.stateSnapshotMaxChars)
                }
              } catch { /* 读不到 JSON：走文本压缩 */ }
            }
            if (mapText === null && parsed?.data?.summary?.absolutePath) {
              // 大快照优化（2026-08-20）：工具 data.text 受 max_chars 截断（1849 节点只给前 120），
              // 读 Library 完整 markdown 补全树（md 的 Refs/Backrefs 不带物体名 → 只取 Tree 段，
              // Refs/Backrefs 仍用 data.text 带名字；strip UTF-8 BOM）。
              try {
                const mdPath = String(parsed.data.summary.absolutePath).replace(/\.json$/i, '.md')
                const md = fs.readFileSync(mdPath, 'utf8').replace(/^\uFEFF/, '')
                const mdRefs = md.indexOf('Refs (outgoing):')
                if (mdRefs > 0 && md.includes('Tree:')) {
                  const dataRefs = text.indexOf('Refs (outgoing):')
                  text = md.slice(0, mdRefs) + (dataRefs >= 0 ? text.slice(dataRefs) : md.slice(mdRefs))
                }
              } catch { /* 文件缺失/不可读：保持 data.text */ }
            }
          } catch { /* 文本原样 */ }
          // 地图模式优先；否则树/引用/被引用按预算分块压缩（曾因整体截断把引用明细全裁掉，2026-08-20）
          const finalText = mapText !== null
            ? mapText
            : compactUiSnapshot(text, this.cfg.stateSnapshotMaxChars)
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: true, text: UnityPool.truncate(finalText, this.cfg.stateSnapshotMaxChars, 'ui-snapshot') })
        } catch (err) {
          // 失败也把选中项基本信息带上（注入块直接可见“选中了什么”，而不是只有误导性报错）
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: false, error: String(err?.message ?? err).slice(0, 200) + (selBriefText ? '；选中项：' + selBriefText : '') })
        }
      }

      // 选中物体序列化字段（components 资源，防超长截断）
      if (sw.stateSerialized) {
        try {
          if (!firstGoId) throw new Error(selectionText.includes('count=0') ? '当前没有选中物体' : '选中项不是 GameObject（无法读取序列化字段）')
          const res = await client.call('resources/read', { uri: 'mcpforunity://scene/gameobject/' + firstGoId + '/components' })
          let text = ''
          for (const c of (res && res.contents) || []) {
            if (typeof c?.text === 'string') { text = c.text; break }
          }
          if (!text) throw new Error('components 资源返回空')
          // 精简：提取组件名 + 属性（过滤大字段噪音），仍受 maxChars 保护
          try {
            const parsed = JSON.parse(text)
            const comps = parsed?.data?.components || []
            const lines = comps.map(comp => {
              const props = comp?.properties || {}
              const keys = Object.keys(props)
              const brief = keys.slice(0, 24).map(k => k + '=' + formatProp(props[k])).join(', ')
              const extra = keys.length > 24 ? ' …(还有 ' + (keys.length - 24) + ' 个字段)' : ''
              return '-' + (comp.typeName || '?') + ' [' + keys.length + ' 字段]: ' + brief + extra
            })
            text = '组件数 ' + comps.length + '\n' + lines.join('\n')
          } catch { /* 保留原始 JSON 文本 */ }
          entries.push({ key: 'serialized', label: '选中物体序列化字段', ok: true, text: UnityPool.truncate(text, this.cfg.stateMaxChars, '序列化字段') })
        } catch (err) {
          entries.push({ key: 'serialized', label: '选中物体序列化字段', ok: false, error: String(err?.message ?? err).slice(0, 200) + (selBriefText ? '；选中项：' + selBriefText : '') })
        }
      }

      // Console 全文（read_console，count + 截断防超长）
      if (sw.stateConsoleAll) {
        try {
          const res = await client.callTool('read_console', {
            action: 'get',
            types: ['all'],
            count: String(this.cfg.stateConsoleCount),
            format: 'plain',
            include_stacktrace: false,
          })
          if (res.isError) throw new Error(res.text || 'read_console failed')
          let text = res.text
          try {
            const parsed = JSON.parse(res.text)
            if (Array.isArray(parsed?.data)) text = parsed.data.join('\n')
            else if (parsed?.data && typeof parsed.data === 'object') text = JSON.stringify(parsed.data)
          } catch { /* 原样 */ }
          entries.push({ key: 'consoleAll', label: 'Console 全文', ok: true, text: UnityPool.truncate(text, this.cfg.stateConsoleMaxChars, 'Console') })
        } catch (err) {
          entries.push({ key: 'consoleAll', label: 'Console 全文', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // Console 选中条目（反射 ConsoleWindow.m_ActiveText）
      if (sw.stateConsoleSelected) {
        try {
          const res = await client.callTool('execute_code', { action: 'execute', code: CONSOLE_SELECTED_CODE, safety_checks: true })
          if (res.isError) throw new Error(res.text || 'execute_code failed')
          let text = ''
          try {
            text = typeof res.structuredContent?.data?.result === 'string' ? res.structuredContent.data.result : JSON.parse(res.text).data?.result
          } catch { text = res.text }
          if (/^NO_CONSOLE_WINDOW/.test(text)) throw new Error('Console 窗口未打开')
          entries.push({ key: 'consoleSelected', label: 'Console 选中条目', ok: true, text: UnityPool.truncate(text, this.cfg.stateConsoleMaxChars, 'Console 选中') })
        } catch (err) {
          entries.push({ key: 'consoleSelected', label: 'Console 选中条目', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // 截图（最后采集，避免拖慢文本项）；opts.skipScreenshots=true（后台轮询）时跳过——
      // 截图会让 Unity 窗口闪烁/任务栏提醒，只由「开关切换 / unity_pool_state 刷新 / 注入时按需触发」采集
      if (!opts?.skipScreenshots) {
        if (sw.stateGameScreenshot) await shot('gameShot', 'Game 视图截图', 'game_view', 'game.png')
        if (sw.stateSceneScreenshot) await shot('sceneShot', 'Scene 视图截图', 'scene_view', 'scene.png')
      }

      this.stateCaches.set(sessionId, { at, instanceId: instance, entries })
      return this.stateCaches.get(sessionId)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 状态采集失败: ' + String(err?.message ?? err))
      return null
    } finally {
      this._stateCollecting = false
    }
  }

  /**
   * 取 agent 会话最近一次回合号（turn/start 事件）：agent-loop 每处理一轮
   * 用户输入就 append 一次 turn/start（packages/core/agent-loop，turn 单调递增）。
   * 返回 -1 表示拿不到回合号（无法去重）。
   */
  stateTurnOf(agent) {
    const session = agent && agent.session
    const events = session && Array.isArray(session.events) ? session.events : null
    if (!events) return -1
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
    }
    return 0
  }

  /**
   * 每回合状态只注入一次（v0.4.0 UX）：按回合号去重——同一回合（一次用户输入
   * + 其工具循环）内所有 agent request 的回合号相同：首个 request 注入并记录
   * 回合号，后续 request 回合号未变则跳过不重复注入；用户再次发消息 → 回合号
   * +1 → 自动携带最新快照。
   */
  stateInjectOnce(sessionId, turn) {
    const key = String(sessionId)
    if (turn <= 0) return true // 无法去重（无回合号），保持原行为
    const prev = this._stateTurnMap.get(key) || 0
    if (turn === prev) return false
    this._stateTurnMap.set(key, turn)
    return true
  }

  /**
   * 按回合返回状态块文本（v0.4.1 注入策略，2026-08-20 用户纠正设计）：
   * 回合首步生成并缓存文本，同回合所有 step 返回同一份——快照整段稳定 → 宿主整段去重 → 零重复注入；
   * 用户发新消息（回合号 +1）才重新生成（携带当时最新状态）并注入一次。
   * 无回合号（turn <= 0，非回合装配/子 agent）退化为每次重新生成。
   */
  stateTextForTurn(sessionId, turn) {
    const sid = String(sessionId)
    const key = turn > 0 ? turn : 0
    const cur = this._stateTurnTexts?.get(sid)
    if (cur && cur.turn === key) return cur.text
    const text = this.stateContextText(sessionId)
    // 只有有回合号才写缓存；无回合号（非回合装配）每次重新生成，且不得覆盖回合缓存
    if (turn > 0) {
      this._stateTurnTexts ??= new Map()
      this._stateTurnTexts.set(sid, { turn: key, text })
    }
    return text
  }

  /** 同步读取会话状态快照文本（context 注入用，绝不做异步 MCP 调用）。v0.4.2：按会话读开关。 */
  stateContextText(sessionId) {
    const sid = String(sessionId)
    const sw = this.getStateSwitches(sid)
    if (sw.stateEnabled !== true) return ''
    const cache = this.stateCaches.get(sid)
    if (!cache || !Array.isArray(cache.entries) || cache.entries.length === 0) return ''
    const lines = []
    for (const e of cache.entries) {
      if (e.ok) {
        if (e.file) lines.push('- [' + e.label + '] ' + e.file + (e.width ? '（宽 ' + e.width + 'px）' : '') + (e.updatedAt ? '（更新 ' + new Date(e.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '）' : '') + '（可用 read_image 工具查看）')
        else lines.push('- [' + e.label + '] ' + (e.text || '（无内容）'))
      } else {
        lines.push('- [' + e.label + '] 采集失败: ' + (e.error || 'unknown'))
      }
    }
    // 消息驱动兜底（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集」）：无后台轮询——
    // 回合首步求值发现缓存过期（距上次采集 ≥ stateRefreshMs）→ 异步补采一次（fire-and-forget），
    // 用户消息到达的事件监听（apply 注册）已先行触发，这里兜底。采集完成下轮注入带新状态。
    // 注意：不注入通用采集时间戳——它是每 3s 变化源，会让整段快照每轮变化、破坏宿主去重
    // （权限/沙箱快照被状态块拖累每轮重发，2026-08-20 实测根因）。
    const refreshMs = Math.max(1000, Number(this.cfg.stateRefreshMs) > 0 ? Number(this.cfg.stateRefreshMs) : 3000)
    if (Date.now() - (cache.at || 0) >= refreshMs) {
      this.requestStateCollect(sid)
    }
    // 截图按需刷新（v0.4.1）：截图让 Unity 窗口闪烁/任务栏提醒，不参与后台轮询；
    // 注入（发消息）时发现截图已过期（距上次截图 ≥ screenshotStaleMs）→ 异步补采一次（fire-and-forget），
    // 当前注入返回旧图，采集完成后下轮注入带新图（updatedAt 变化 → 宿主整段去重重新注入）。
    if (sw.stateGameScreenshot || sw.stateSceneScreenshot) {
      const newestShot = (cache.entries || []).reduce((m, e) => (e.ok && e.updatedAt ? Math.max(m, e.updatedAt) : m), 0)
      const stale = Number(this.cfg.screenshotStaleMs) > 0 ? Number(this.cfg.screenshotStaleMs) : 10000
      if (Date.now() - newestShot >= stale) {
        const last = this._screenshotReqAt?.get(sid) || 0
        if (Date.now() - last >= stale) {
          this._screenshotReqAt ??= new Map()
          this._screenshotReqAt.set(sid, Date.now())
          this.requestStateCollect(sid) // 完整采集（含截图）
        }
      }
    }
    return '<unity_pool_state>\nUnity 状态（' + cache.instanceId + '）：\n' + lines.join('\n') + '\n</unity_pool_state>'
  }

  /**
   * 消息驱动采集入口（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集，不需要轮询」）：
   * 不再有后台周期轮询——采集只在三类时机发生：
   *  ① 用户消息到达（apply 里监听 session/event 的 user/message，见下方注册）；
   *  ② 回合首步注入求值（stateContextText）发现缓存过期；
   *  ③ 开关切换 / bind / unity_pool_state 刷新。
   * 幂等 + 全局防重入（collectState 内部 _stateCollecting），重复触发只跑一次。
   */
  requestStateCollect(sid) {
    if (!this.stateCarryEnabled(sid)) return
    this.collectState(sid).catch(() => {})
  }

  /** 兼容旧名（不再启动周期轮询；保留函数避免外部引用失效）。 */
  startStateTimer() {
    // v0.4.1：轮询已移除（曾每 stateRefreshMs 采集一次，含 ui_snapshot force_refresh 全量重扫，
    // 大快照下让 Unity 反复读条——用户第 3 次遇到）。采集改由消息/注入/开关驱动。
  }

  /** 停止状态采集定时器（无轮询后为空操作）。 */
  stopStateTimer() {
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null }
  }

  /** 切换某会话的状态携带开关（运行时，HTTP /api/state-switch 用）。key 如 'stateEnabled' / 'stateGameScreenshot'。
   *  v0.4.2 按会话独立：写入 _stateSwitchesBySession[sessionId]（含"关"），不再改全局 cfg。 */
  setStateSwitch(sessionId, key, value) {
    const sid = String(sessionId || '')
    if (!sid) throw new Error('sessionId required（状态开关按会话独立）')
    if (!STATE_SWITCH_KEYS.includes(key)) throw new Error('未知状态开关: ' + key + '（可选: ' + STATE_SWITCH_KEYS.join(', ') + '）')
    const bool = value === true || value === 'true' || value === 1 || value === '1'
    let own = this._stateSwitchesBySession[sid]
    if (!own) { own = {}; this._stateSwitchesBySession[sid] = own }
    own[key] = bool
    // 诊断流水：记录每次开关写入（含时间戳与会话），排查“开关被莫名改回”时直接看 view.state.switchLog
    this.stateSwitchLog.push({ at: Date.now(), sessionId: sid, key, value: bool })
    if (this.stateSwitchLog.length > 40) this.stateSwitchLog.shift()
    // 采集由 HTTP 路由（stateCarryEnabled 判断）触发，不再启动周期轮询（v0.4.1）
    this._save() // 持久化开关状态（v0.4.1）：重启后恢复上次设置，而不是配置默认
    return bool
  }

  /** 全局实例查找：按 Name@hash / hash 前缀 / 服务内实例 id。 */
  findInstance(instance, serviceId) {
    const value = String(instance ?? '').trim()
    if (!value) return null
    const pool = serviceId ? [this.serviceById(serviceId)].filter(Boolean) : this.services
    if (value.includes('@')) {
      for (const s of pool) {
        const hit = s.instances.find(i => i.id === value)
        if (hit) return { service: s, instance: hit }
      }
      return null
    }
    const lower = value.toLowerCase()
    const matches = []
    for (const s of pool) {
      for (const i of s.instances) {
        if (i.hash && i.hash.toLowerCase().startsWith(lower)) matches.push({ service: s, instance: i })
      }
    }
    if (matches.length === 1) return matches[0]
    return null
  }

  /** 自动分配：优先「可用且未被其他会话锁定」的实例（存活服务优先）。 */
  autoAssign(sessionId) {
    const targeted = new Set(Object.values(this.bindings).map(b => b.instanceId).filter(Boolean))
    const list = []
    for (const s of this.services) {
      if (s.alive === false) continue
      for (const i of s.instances) {
        list.push({ service: s, instance: i, taken: targeted.has(i.id) })
      }
    }
    const free = list.find(x => !x.taken)
    const any = list[0]
    const chosen = free || any
    if (!chosen) return null
    return { serviceId: chosen.service.id, instanceId: chosen.instance.id }
  }

  /**
   * 锁定会话目标实例：sessionId → {serviceId, instanceId}。
   * 每次绑定都拉取目标服务上的 MCP 工具列表（tools/list）随结果返回
   * （同服务重复绑定也重拉，保证动态工具集合新鲜；拉取失败回退缓存并附 toolsError，不阻断绑定）。
   * @param opts {instance?, serviceId?, force?}
   */
  async bind(sessionId, opts = {}) {
    // v0.5.1：force 默认为 true —— 并行开发同一实例是正常用法，默认不被 enforceExclusive 拒绝；
    // 仅当显式传 force=false（且 enforceExclusive=true）时才拒绝并行绑定。
    const force = opts.force !== false
    const instance = opts.instance !== undefined ? String(opts.instance) : undefined
    const serviceId = opts.serviceId !== undefined ? String(opts.serviceId) : undefined

    let target
    if (instance) {
      target = this.findInstance(instance, serviceId)
      if (!target) {
        const avail = this.services.flatMap(s => s.instances.map(i => s.id + ':' + i.id))
        throw new Error('实例 [' + instance + '] 未发现（可用: ' + (avail.join(', ') || 'none') + '；可先 unity_pool_scan 重新扫描）')
      }
    } else if (serviceId) {
      const svc = this.serviceById(serviceId)
      if (!svc) throw new Error('服务 [' + serviceId + '] 不存在')
      if (svc.instances.length === 0) throw new Error('服务 [' + svc.name + '] 上暂无实例（可先 unity_pool_scan）')
      target = { service: svc, instance: svc.instances[0] }
    } else {
      const picked = this.autoAssign(sessionId)
      if (!picked) throw new Error('没有可用实例（服务池为空或全部离线/无实例；可 unity_pool_scan 扫描）')
      target = { service: this.serviceById(picked.serviceId), instance: { id: picked.instanceId, name: picked.instanceId, hash: '' } }
    }

    if (this.cfg.enforceExclusive && !force) {
      const others = this.sessionsTargeting(target.instance.id).filter(sid => sid !== sessionId)
      if (others.length > 0) {
        throw new Error('实例 [' + target.instance.id + '] 正被其他会话并行使用（enforceExclusive 默认开启；并行开发同一实例属正常用法）。如需同时绑定可传 force=true（Unity 侧会排队，非错误）')
      }
    }

    const boundAt = Date.now()
    this.bindings[sessionId] = { serviceId: target.service.id, instanceId: target.instance.id, boundAt }
    this._save()
    const result = {
      sessionId,
      serviceId: target.service.id,
      instanceId: target.instance.id,
      boundAt,
      service: { id: target.service.id, name: target.service.name, url: target.service.url },
      instance: target.instance,
    }
    // 每次绑定都附该服务的 MCP 工具列表（best-effort，失败不阻断绑定，附 toolsError）。
    // 教训（2026-08-20 会话「重命名健康度构成面板多文本组件」）：曾只在首次绑定/跨服务切换时附带，
    // 会话第二次绑定拿不到列表 → Agent 只能盲猜工具名（read_editor_state）→ Unknown tool 空转；
    // 现在每次绑定都拉最新 tools/list（同服务重复绑定也重拉，保证动态工具集合新鲜）。
    try {
      const client = this.sessionClient(sessionId, target.service)
      await client.ensureInit()
      const tools = await client.listTools()
      result.tools = tools
      result.toolsCount = tools.length
      // v0.5.0：绑定后把该服务工具动态注册为原生工具（umcp_*），模型上下文直接可见可调
      try { this.syncNativeTools(target.service.id, tools) } catch (err) {
        this.ctx?.logger?.warn?.('[unity-pool] 绑定后同步原生工具失败: ' + String(err?.message ?? err))
      }
    } catch (err) {
      // 拉取失败：回退该会话同服务已缓存的列表（若有），仍不阻断绑定
      const sc = this.sessionClients.get(sessionId)
      const cached = sc && Array.isArray(sc.client.tools) ? sc.client.tools : []
      result.tools = cached
      result.toolsCount = cached.length
      result.toolsError = String(err?.message ?? err)
    }
    // 状态携带开启时，绑定后立即采集一次（首个注入即可用）
    if (this.stateCarryEnabled(sessionId)) {
      this.collectState(sessionId).catch(() => {})
    }
    return result
  }

  unbind(sessionId) {
    const had = this.bindings[sessionId]
    if (had) {
      const serviceId = had.serviceId
      delete this.bindings[sessionId]
      this._save()
      // v0.5.0 收敛：该服务不再被任何会话绑定时，注销其原生工具（umcp_*）
      // —— 避免「绑过的服务无限累积注册」推高模型工具清单与上下文成本；
      // 手动解绑与会话归档自动解绑（_onSessionDisposed 也走本方法）共用此路径。
      if (this.cfg.nativeToolsEnabled !== false && serviceId) {
        const stillBound = Object.values(this.bindings).some(b => b.serviceId === serviceId)
        if (!stillBound) this._disposeNativeServiceTools(serviceId)
      }
    }
    if (this.stateCaches.has(sessionId)) this.stateCaches.delete(sessionId)
    if (this._stateTurnTexts) this._stateTurnTexts.delete(sessionId)
    const sc = this.sessionClients.get(sessionId)
    if (sc) {
      try { sc.client.close() } catch { /* ignore */ }
      this.sessionClients.delete(sessionId)
    }
    return { sessionId, unbound: Boolean(had) }
  }

  /** 会话专用 MCP client（惰性创建，维护独立 MCP-Session-Id）。 */
  sessionClient(sessionId, service) {
    let sc = this.sessionClients.get(sessionId)
    if (!sc || sc.serviceId !== service.id) {
      if (sc) { try { sc.client.close() } catch { /* ignore */ } }
      sc = { serviceId: service.id, client: new McpHttpClient(service.url, { timeoutMs: Math.max(5000, this.cfg.probeTimeoutMs * 3), logger: this.ctx?.logger }) }
      this.sessionClients.set(sessionId, sc)
    }
    return sc.client
  }

  /** 本会话已绑服务的工具名速查（缓存快照；未绑定或无缓存返回 null）。 */
  toolsSummary(sessionId) {
    const sc = this.sessionClients.get(sessionId)
    if (!sc || !Array.isArray(sc.client.tools) || sc.client.tools.length === 0) return null
    return {
      serviceId: sc.serviceId,
      count: sc.client.tools.length,
      names: sc.client.tools.map(t => t && t.name).filter(Boolean),
    }
  }

  /** 会话视角完整状态视图。 */
  view(sessionId) {
    const binding = this.bindingOf(sessionId)
    return {
      sessionId,
      binding,
      // 本会话已绑服务的工具名速查（bind 的 tools 字段是完整列表；这里给名字速查，随时可拿）
      tools: this.toolsSummary(sessionId),
      // v0.5.0：已注册的原生工具摘要（按服务）
      nativeTools: this.nativeToolsSummary(),
      services: this.services.map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        alive: s.alive,
        aliveAt: s.aliveAt,
        lastError: s.lastError,
        instancesValid: s.instancesValid,   // 最近一次实例发现是否成功（false=发现失败，列表可能过期）
        offlineStreak: s.offlineStreak || 0,
        instances: s.instances.map(i => ({
          id: i.id,
          name: i.name,
          hash: i.hash,
          ...(i.unityVersion ? { unityVersion: i.unityVersion } : {}),
          active: Boolean(binding && binding.serviceId === s.id && binding.instanceId === i.id),
        })),
        active: Boolean(binding && binding.serviceId === s.id),
      })),
      rules: {
        autoAssign: this.cfg.autoAssign,
        enforceExclusive: this.cfg.enforceExclusive,
        perSessionActiveInstance: true,
        autoUnbindOnArchive: this.cfg.autoUnbindOnArchive !== false,
        callReconnectTimeoutMs: this.cfg.callReconnectTimeoutMs,
        nativeToolsEnabled: this.cfg.nativeToolsEnabled !== false,
        nativeToolSchema: this.cfg.nativeToolSchema === 'full' ? 'full' : 'compact',
      },
      lastAutoUnbind: this.lastAutoUnbind || null,
      connectHint: this.cfg.connectHint || DEFAULT_CONNECT_HINT,
      state: (() => {
        const sw = this.getStateSwitches(sessionId) // v0.4.2：view 按会话返回开关
        return {
          enabled: sw.stateEnabled === true,
          switches: {
            stateEnabled: sw.stateEnabled === true,
            stateGameScreenshot: sw.stateGameScreenshot === true,
            stateSceneScreenshot: sw.stateSceneScreenshot === true,
            stateSelection: sw.stateSelection === true,
            stateUiSnapshot: sw.stateUiSnapshot === true,
            stateSerialized: sw.stateSerialized === true,
            stateConsoleAll: sw.stateConsoleAll === true,
            stateConsoleSelected: sw.stateConsoleSelected === true,
          },
          refreshMs: this.cfg.stateRefreshMs,
          maxChars: this.cfg.stateMaxChars,
          snapshotMaxChars: this.cfg.stateSnapshotMaxChars,
          consoleMaxChars: this.cfg.stateConsoleMaxChars,
          consoleCount: this.cfg.stateConsoleCount,
          screenshotMaxRes: this.cfg.stateScreenshotMaxRes,
          screenshotStaleMs: this.cfg.screenshotStaleMs,
          dir: this.cfg.stateDir,
          switchLog: (this.stateSwitchLog || []).slice(-20).map(e => ({ at: e.at, sessionId: e.sessionId, key: e.key, value: e.value })),
          cache: this.stateCaches.get(sessionId)
            ? {
                at: this.stateCaches.get(sessionId).at,
                instanceId: this.stateCaches.get(sessionId).instanceId,
                entries: (this.stateCaches.get(sessionId).entries || []).map(e => ({
                  key: e.key, label: e.label, ok: e.ok, ...(e.file ? { file: e.file } : {}), ...(e.text !== undefined ? { textLength: e.text.length } : {}), ...(e.error ? { error: e.error } : {}),
                })),
              }
            : null,
        }
      })(),
    }
  }

  /**
   * unity_mcp 代理：确保本会话 MCP session 的目标实例激活后转发工具调用。
   * @returns {{success, activeInstance, tool, text, structuredContent?, isError?}}
   */
  async proxyMcp(sessionId, tool, params, instanceOverride) {
    const binding = this.bindingOf(sessionId)
    if (!binding || !binding.serviceId) {
      throw new Error('本会话未锁定目标实例：先调用 unity_pool_bind(instance=...) 或 unity_pool_status 查看可用实例')
    }
    const service = this.serviceById(binding.serviceId)
    if (!service) throw new Error('绑定服务不存在: ' + binding.serviceId)
    const instance = instanceOverride !== undefined && String(instanceOverride) !== '' ? String(instanceOverride) : binding.instanceId
    if (!instance) throw new Error('绑定未锁定实例：请 unity_pool_bind(instance="Name@hash")')
    const client = this.sessionClient(sessionId, service)
    await client.ensureInit()
    // 调用时实例离线的重连/等待时长（默认 20s）：给足超时让官方服务端的会话重连等待完成，
    // 超过才判定实例离线并返回失败原因（见 callReconnectTimeoutMs）。
    const reconnectTimeout = Number(this.cfg.callReconnectTimeoutMs) > 0 ? Number(this.cfg.callReconnectTimeoutMs) : 20000
    if (client.activeInstance !== instance) {
      try {
        await client.setActive(instance, { timeoutMs: reconnectTimeout })
      } catch (err) {
        return { success: false, activeInstance: instance, tool, isError: true, text: '实例不可用/重连超时（' + String(err?.message ?? err) + '）。若实例在域重载或掉线中，请等待其重连后重试；若已关闭，请先 unity_pool_unbind 再 unity_pool_bind。' }
      }
    }
    if (tool === 'set_active_instance') {
      return { success: true, activeInstance: instance, tool, text: 'active instance set to ' + instance }
    }
    if (tool === 'unity_instances' || tool === 'list_instances' || tool === 'instances') {
      const list = await client.listInstances()
      return { success: true, activeInstance: instance, tool, text: JSON.stringify(list, null, 2), instances: list }
    }
    // 轻量一致性：请求的工具不在已缓存的 tools/list 里时自动重拉一次
    // （官方工具集合是动态的：Unity 可随时注册/注销自定义工具、manage_tools 开关工具组），
    // 重拉失败不阻断转发（tools/call 结果由服务端裁决）。
    const cachedTools = client.tools
    if (!Array.isArray(cachedTools) || !cachedTools.some(t => t && t.name === tool)) {
      const now = Date.now()
      if (!client.toolsListedAt || now - client.toolsListedAt > 10000) {
        try {
          await client.listTools() // 内部更新 client.tools
          client.toolsListedAt = now
          // v0.5.0：工具集合变化（Unity 动态注册/注销、manage_tools 开关）后同步原生工具注册
          try { this.syncNativeTools(binding.serviceId, client.tools) } catch { /* 同步失败不阻断转发 */ }
        } catch { /* 忽略，继续转发 */ }
      }
    }
    // 忙时等待（B）：Unity 编译/刷新/进度条期间 MCP 调用会撞主线程导致超时。
    // 转发前用 execute_code 探测，忙则按间隔重试，总时长不超过 busyMaxWaitMs（默认 10s）。
    // 探测失败视为"可能忙"（域重载窗口 execute_code 可能不可用），保守等待后继续。
    const busyWait = this.cfg.busyWaitEnabled !== false
    let lastProbe = null
    if (busyWait) {
      const maxWaitMs = Number(this.cfg.busyMaxWaitMs) > 0 ? Number(this.cfg.busyMaxWaitMs) : 10000
      const intervalMs = Number(this.cfg.busyWaitIntervalMs) > 0 ? Number(this.cfg.busyWaitIntervalMs) : 500
      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        const probe = await probeEditorState(client)
        lastProbe = probe
        if (probe.ok && !probe.busy) break   // 空闲：立即转发
        const remain = deadline - Date.now()
        if (remain <= 0) break
        await sleep(Math.min(intervalMs, remain))
      }
    }
    try {
      const res = await client.callTool(tool, params, { timeoutMs: reconnectTimeout })
      const base = {
        success: !res.isError,
        activeInstance: instance,
        tool,
        text: res.text,
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
        ...(res.isError ? { isError: true } : {}),
      }
      if (res.isError) {
        // 失败附状态（A）：把最近一次探测状态附到返回 editorState，供调用方判断是否 busy 所致
        const state = lastProbe ?? await probeEditorState(client).catch(() => null)
        if (state) base.editorState = state.raw
        // 未知工具（B）：附当前可用工具名列表 + 相似工具提示，避免 Agent 继续盲猜工具名空转
        // （教训：2026-08-20 会话「重命名健康度构成面板多文本组件」猜 read_editor_state 后原地打转）
        if (/unknown tool/i.test(res.text || '')) {
          const hint = toolsHintText(client.tools, tool)
          if (hint) base.text = (base.text || '') + '\n\n' + hint
        }
      }
      return base
    } catch (err) {
      // 实例掉线/域重载超时/服务不可达：以失败原因返回（不再抛出），调用方可直接看到停机信息。
      // 不再补一次探测（避免实例离线时 execute_code 也挂起、拖慢失败返回），只带最近一次探测状态。
      return {
        success: false,
        activeInstance: instance,
        tool,
        isError: true,
        ...(lastProbe ? { editorState: lastProbe.raw } : {}),
        text: '调用失败（实例离线/重连超时）：' + String(err?.message ?? err) + '。若实例在域重载或掉线中，请等待其重连后重试；若已关闭，请先 unity_pool_unbind 再 unity_pool_bind。',
      }
    }
  }
}

export function createPool(ctx, cfg) {
  const resolved = { ...cfg, dataFile: cfg.dataFile || path.join(homedir(), '.dsh', 'unity-pool-state.json') }
  return new UnityPool(ctx || { logger: { info() {}, warn() {} } }, resolved)
}

function requireSession(exec) {
  const agent = exec && exec.agent
  const sessionId = agent && (agent.id || (agent.session && agent.session.id))
  if (!sessionId) throw new Error('该工具需要会话上下文（Agent-backed session）')
  return String(sessionId)
}

export function apply(ctx, config) {
  const pool = new UnityPool(ctx, {
    services: (config && Array.isArray(config.services) && config.services.length > 0)
      ? config.services : [{ id: 'unity-8080', name: 'Unity 8080', url: 'http://127.0.0.1:8080/mcp' }],
    dataFile: config?.dataFile || path.join(homedir(), '.dsh', 'unity-pool-state.json'),
    probeIntervalMs: config?.probeIntervalMs,
    probeTimeoutMs: config?.probeTimeoutMs,
    scanPorts: config?.scanPorts,
    autoAssign: config?.autoAssign,
    enforceExclusive: config?.enforceExclusive,
    connectHint: config?.connectHint,
    busyWaitEnabled: config?.busyWaitEnabled,
    busyMaxWaitMs: config?.busyMaxWaitMs,
    busyWaitIntervalMs: config?.busyWaitIntervalMs,
    autoUnbindOnArchive: config?.autoUnbindOnArchive,
    callReconnectTimeoutMs: config?.callReconnectTimeoutMs,
    stateEnabled: config?.stateEnabled,
    stateGameScreenshot: config?.stateGameScreenshot,
    stateSceneScreenshot: config?.stateSceneScreenshot,
    stateSelection: config?.stateSelection,
    stateUiSnapshot: config?.stateUiSnapshot,
    stateSerialized: config?.stateSerialized,
    stateConsoleAll: config?.stateConsoleAll,
    stateConsoleSelected: config?.stateConsoleSelected,
    stateRefreshMs: config?.stateRefreshMs,
    stateScreenshotMaxRes: config?.stateScreenshotMaxRes,
    stateDir: config?.stateDir,
    stateMaxChars: config?.stateMaxChars,
    stateSnapshotMaxChars: config?.stateSnapshotMaxChars,
    stateConsoleMaxChars: config?.stateConsoleMaxChars,
    stateConsoleCount: config?.stateConsoleCount,
    screenshotStaleMs: config?.screenshotStaleMs,
    nativeToolsEnabled: config?.nativeToolsEnabled,
    nativeToolSchema: config?.nativeToolSchema,
  })
  ctx.effect(() => {
    pool.start()
    return () => pool.stop()
  }, 'unity-pool: probe')

  // ---- 系统提示 ----
  try {
    ctx.systemPrompt.section({
      name: 'unity-pool',
      order: 120,
      text: [
        '<unity_pool_guide>',
        '本机装有 Unity 服务池插件（dsh-unity-pool v2）：多个 Unity 服务（每个服务 = 一个 mcp-for-unity server）组成服务池，',
        '每个服务上可能挂多个 Unity 编辑器实例（Name@hash）。',
        '工作流：',
        '1. 需要连接 Unity 时先调 unity_pool_status 查看服务池、每个服务的实例列表（id/name/hash/是否本会话激活）。',
        '2. 若目标工程实例不在列表，调 unity_pool_scan 重新扫描（服务重探 + 实例重读 + 扫描端口段），再调 unity_pool_status。',
        '3. 用 unity_pool_bind(instance="Name@hash" 或 hash 前缀) 把本会话目标实例锁定为指定实例（一个会话只锁定一个实例）；每次绑定都会返回该服务的 MCP 工具列表（tools 字段，含名称/描述/参数 schema，同服务重复绑定也重拉保持新鲜），可据此直接 unity_mcp 调用；随时调 unity_pool_status 也可查看本会话已绑服务的最新工具名速查（tools: {count, names}）。注意：工具列表是服务级并集（同一服务上多工程实例的自定义工具会合并列出），列表里的自定义工具可能来自其他工程实例，调用失败属正常，说明该实例未注册此工具，改用官方工具即可。',
        '4. 之后所有 MCP 操作统一走 unity_mcp(tool="<mcp工具名>", params={...}) 代理——',
        '   插件会自动把本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），再转发调用，助手无感；',
        '   请求的工具不在已知列表时插件会自动重拉 tools/list（Unity 可运行时注册/注销自定义工具、manage_tools 可开关工具组）；工具名不存在时错误信息会附带当前可用工具名列表（含相似工具名提示），从中选正确的名称重试，不要盲猜；',
        '   查 Unity 编辑器状态（Game/Scene 截图、选中项、ui-snapshot、序列化字段、Console 全文/条目）用 unity_pool_state（状态携带开关默认全关，需先开启；开启后每轮指令自动注入快照），不要猜 MCP 工具名；',
        '   返回内容中的 [image: ...] 占位表示官方返回了图片块（如 manage_camera include_image=true 的截图），文本通道已丢弃图片本体，需要时改用文本摘要参数；',
        '   Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败返回会附带编辑器状态 editorState（isCompiling/isUpdating/progressCount），据此判断是否忙碌所致。',
        '4b. 【v0.5.0 原生工具】绑定成功后，该服务的 MCP 工具会**自动注册为原生工具 umcp_<工具名>**（如 umcp_find_gameobjects、umcp_manage_scene），',
        '   模型上下文直接可见完整工具清单、可直接原生调用（参数同 Unity MCP 原工具，等价 unity_mcp 转发）；',
        '   未绑定会话的 umcp_* 调用会报「未锁定目标实例」，先 unity_pool_bind 即可；',
        '   umcp_* 与 unity_mcp 等价并存（unity_mcp 仍是通用代理兜底，任意工具名可调）。',
        '5. 不再使用时调 unity_pool_unbind 释放（关闭本会话的 MCP 会话）。',
        '状态携带（可选，默认全关）：插件可在每次发出指令时把 Unity 当前状态注入到上下文（配置 stateEnabled 等开关，或面板/HTTP /api/state-switch 运行时开启）——Game/Scene 视图截图（PNG 落盘到 stateDir，上下文给文件路径，可用 read_image 查看）、Hierarchy/Project 当前选中项、选中物体 ui-snapshot 与序列化字段、Console 全文/选中条目；各项均有独立开关与防超长截断（stateMaxChars 等）。需要状态时调 unity_pool_state 立即刷新查看。',
        '自动解绑：实例掉线/域重载对已绑定会话是无感的——绑定保持，不做 probe 主动解绑、也不注入通知；只有本 DSH 会话被归档（session/disposed）时才会自动解绑该会话锁定的实例（autoUnbindOnArchive 默认开启）。真正要操作时直接 unity_mcp/umcp_* 调用：若实例在域重载/掉线中，插件会自动等待/重连（调用超时 callReconnectTimeoutMs，默认 20s，官方服务端会等实例重连），超过才判定实例离线并返回失败原因；重连成功后调用继续，无需重新 bind。',
        '规则：多个会话可以并行开发同一实例——你和别的会话绑定同一实例时，并发调用由 Unity 侧排队（性能排队而非错误），注意一下别操作太快；',
        'force 默认 true：并行开发同一实例是正常用法，绑定默认即允许并行（不被拒绝）；仅当显式传 force=false 且配置 enforceExclusive=true 时才拒绝并行绑定。',
        '</unity_pool_guide>',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 系统提示注册失败: ' + String(err?.message ?? err))
  }

  // ---- 状态携带：用户消息事件驱动采集（v0.4.1，2026-08-20 用户纠正「只在发消息的时候采集，不需要轮询」）----
  // 无后台周期轮询（曾每 stateRefreshMs 采集一次，ui_snapshot force_refresh 全量重扫让 Unity 反复读条）。
  // 用户发送真实消息 → session/event user/message（source.kind=user）→ 异步采集一次，赶在回合首步注入前更新缓存；
  // stateContextText 里另有「缓存过期」兜底触发。采集含全局防重入，多入口只跑一次。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'user/message') return
        const src = event.data && event.data.source
        if (!src || src.kind !== 'user') return // 排除系统/插件注入（快照、审批通知等）
        const sid = session && (session.id || (session.session && session.session.id))
        if (sid) pool.requestStateCollect(String(sid))
      } catch (err) {
        ctx.logger?.warn?.('[unity-pool] 消息驱动采集触发失败: ' + String(err?.message ?? err))
      }
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 消息驱动采集监听注册失败: ' + String(err?.message ?? err))
  }

  // ---- 状态携带注入（v0.4.0，官方机制 systemPrompt.context，text 同步函数每次 agent request 前求值）----
  // 采集由消息/注入/开关驱动（无后台轮询），这里同步读取注入。
  //
  // v0.4.1 注入策略（2026-08-20 用户纠正设计）：**按回合缓存状态块文本，每回合只注入一次**——
  // 曾两次走偏：
  //  ① stateInjectOnce 每回合一次 → 同回合「首步带状态块、后续步空」→ 整段快照 541/390 抖动 → 权限快照每回合重复注入；
  //  ② 去掉 stateInjectOnce、每步返回最新状态块 + 宿主整段去重 → 状态稳定时零注入，但 Unity 开发常态
  //    （用户反复选中物体检查成果，几分钟点几十次）下每步内容都变 → **每步注入无关上下文**，严重干扰任务。
  // 现在的语义：回合首步生成并缓存状态块文本，同回合所有 step 返回同一份（快照整段稳定 → 宿主去重零注入）；
  // 用户发新消息（回合号 +1）→ 重新生成（携带当时最新状态）→ 注入一次；状态未变的新回合也不注入。
  try {
    ctx.systemPrompt.context({
      name: 'unity-pool:state',
      order: 125,
      text: (context) => {
        const agent = context && context.agent
        const sessionId = agent && (agent.id || (agent.session && agent.session.id))
        if (!sessionId) return ''
        // v0.4.2：按会话读总开关（各会话自己的开关控制自己的注入）
        if (pool.getStateSwitches(sessionId).stateEnabled !== true) return ''
        try {
          return pool.stateTextForTurn(sessionId, pool.stateTurnOf(agent))
        } catch (err) {
          ctx.logger?.warn?.('[unity-pool] 状态注入求值失败: ' + String(err?.message ?? err))
          return ''
        }
      },
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 状态 context 注册失败: ' + String(err?.message ?? err))
  }

  // ---- Agent 工具 ----
  try {
    ctx.tools.register(defineTool({
      name: 'unity_pool_status',
      description: '查看 Unity 服务池状态：每个服务（mcp-for-unity server）的存活状态与已连接的 Unity 实例列表（实例 id 为 Name@hash，含 name/hash/是否本会话激活 active）、本会话当前锁定的目标实例、分配规则（autoAssign/enforceExclusive/autoUnbindOnArchive）、最近一次归档自动解绑 lastAutoUnbind。需要连接 Unity 前先调用本工具；本会话已绑定时附带该服务最新工具名速查（tools: {count, names}）。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute(_args, exec) {
        const sessionId = requireSession(exec)
        return Promise.resolve(pool.view(sessionId))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_scan',
      description: '重新扫描 Unity 服务池：对配置的服务做存活探测并重新读取每个服务上的 Unity 实例列表（mcpforunity://instances），同时探测 scanPorts 端口段以发现新的 mcp-for-unity 服务并并入池。返回本次新发现的实例与当前完整状态。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(_args, exec) {
        const sessionId = requireSession(exec)
        await pool.probe()
        const found = await pool.scan()
        return { sessionId, scannedServices: pool.services.length, newServices: found, view: pool.view(sessionId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_bind',
      description: '把本会话的目标实例锁定为一个 Unity 实例（一个会话只锁定一个实例）。传 instance（Name@hash 或 hash 前缀）锁定指定实例；传 serviceId 则锁定该服务上第一个实例；都不传则自动分配一个未被其他会话锁定的实例。返回锁定结果与状态视图；每次绑定都会返回该服务的最新 MCP 工具列表（tools 字段，含 name/description/inputSchema 与 toolsCount，同服务重复绑定也重拉保持新鲜），可据此直接 unity_mcp 调用；绑定后该服务工具还会自动注册为原生工具（umcp_<工具名>，v0.5.0），上下文直接可见可调；随时调 unity_pool_status 也可查看工具名速查。注意：工具列表为服务级并集（同服务多工程实例的自定义工具合并列出），其中部分自定义工具可能不属于当前实例，调用失败即说明该实例未注册此工具。',
      parameters: {
        instance: { type: 'string', description: '目标实例 id（Name@hash，来自 unity_pool_status）；缺省自动分配。' },
        serviceId: { type: 'string', description: '限定在指定服务内查找实例（可选）。' },
        force: { type: 'boolean', description: '实例已被其他会话绑定时是否允许并行绑定（默认 true：并行开发是正常用法，不拒绝）；显式传 false 且配置 enforceExclusive=true 时才拒绝并行。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const a = args || {}
        const result = await pool.bind(sessionId, { instance: a.instance, serviceId: a.serviceId, force: a.force })
        return { ...result, view: pool.view(sessionId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_mcp',
      description: '代理调用本会话目标实例上的 MCP 工具（先通过本插件）：调用前自动确保本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），然后转发 tools/call 并返回结果。tool 为 mcp-for-unity 工具名（如 manage_scene、manage_gameobject、manage_camera、read_console 等）；请求的工具不在已知列表时插件会自动重拉 tools/list 再转发（官方工具集合可动态增减）；工具名不存在时错误信息会附带当前可用工具名列表（含相似工具名提示），从中选取正确名称重试即可。params 为该工具参数对象。Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败时返回附带编辑器状态 editorState 便于判断是否忙碌所致。查 Unity 编辑器状态（截图/选中项/Console 等）用 unity_pool_state。本工具前需先用 unity_pool_bind 锁定目标实例。',
      parameters: {
        tool: { type: 'string', required: true, description: 'mcp-for-unity 工具名（如 manage_scene）。' },
        params: { type: 'json', description: '工具参数对象。' },
        instance: { type: 'string', description: '可选：临时覆盖目标实例（Name@hash）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: typeof v.text === 'string' ? v.text : JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const a = args || {}
        if (!a.tool) throw new Error('tool 必填（mcp-for-unity 工具名）')
        return await pool.proxyMcp(sessionId, String(a.tool), a.params, a.instance)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_unbind',
      description: '解除本会话的目标实例锁定并关闭本会话的 MCP 会话（释放实例给其他会话）。返回是否解除成功与状态视图。',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute(_args, exec) {
        const sessionId = requireSession(exec)
        const result = pool.unbind(sessionId)
        return Promise.resolve({ ...result, view: pool.view(sessionId) })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_pool_state',
      description: '查看/刷新本会话的 Unity 状态携带快照（v0.4.0）：立即采集一次并按开关返回各项状态（Game/Scene 视图截图文件路径、当前选中项、选中物体 ui-snapshot 与序列化字段、Console 全文/选中条目），同时返回 view.state（各开关当前值与缓存摘要）。状态携带总开关与各项开关默认全关（需在配置或面板开启），开启后插件还会在每次发出指令时自动注入最近一次快照到上下文。',
      parameters: {
        refresh: { type: 'boolean', description: '是否立即触发一次重新采集（默认 true）。传 false 只读当前缓存。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const refresh = args === undefined || args === null || args.refresh !== false
        if (refresh) await pool.collectState(sessionId).catch(() => null)
        return { sessionId, cache: pool.stateCaches.get(sessionId) || null, view: pool.view(sessionId) }
      },
    }))
  } catch (err) {
    ctx.logger?.error?.('[unity-pool] 工具注册失败: ' + String(err?.message ?? err))
    throw err
  }

  // ---- 回环 HTTP API ----
  try {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/unity-pool/api',
        handler: (req, res) => {
          const host = String(req.headers.host ?? '')
          const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
          if (!loopback) {
            respond(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
            return
          }
          const url = new URL(req.url || '/', 'http://' + host)
          const p = url.pathname
          if (req.method === 'GET' && (p === '/unity-pool/api/status' || p === '/unity-pool/api/status/')) {
            respond(res, 200, { ok: true, value: pool.view(url.searchParams.get('sessionId') || '') })
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/config' || p === '/unity-pool/api/config/')) {
            respond(res, 200, { ok: true, value: {
              services: pool.services.map(s => ({ id: s.id, name: s.name, url: s.url })),
              connectHint: pool.cfg.connectHint || DEFAULT_CONNECT_HINT,
              autoAssign: pool.cfg.autoAssign,
              enforceExclusive: pool.cfg.enforceExclusive,
              scanPorts: pool.cfg.scanPorts,
              busyWaitEnabled: pool.cfg.busyWaitEnabled !== false,
              busyMaxWaitMs: pool.cfg.busyMaxWaitMs,
              busyWaitIntervalMs: pool.cfg.busyWaitIntervalMs,
              autoUnbindOnArchive: pool.cfg.autoUnbindOnArchive !== false,
              callReconnectTimeoutMs: pool.cfg.callReconnectTimeoutMs,
              state: (() => {
                // v0.4.2：/api/config 无会话维度 → 返回全局默认层（配置默认 + 旧全局持久化 base）
                const sw = pool.getStateSwitches('')
                return {
                  enabled: sw.stateEnabled === true,
                  gameScreenshot: sw.stateGameScreenshot === true,
                  sceneScreenshot: sw.stateSceneScreenshot === true,
                  selection: sw.stateSelection === true,
                  uiSnapshot: sw.stateUiSnapshot === true,
                  serialized: sw.stateSerialized === true,
                  consoleAll: sw.stateConsoleAll === true,
                  consoleSelected: sw.stateConsoleSelected === true,
                  refreshMs: pool.cfg.stateRefreshMs,
                  maxChars: pool.cfg.stateMaxChars,
                  snapshotMaxChars: pool.cfg.stateSnapshotMaxChars,
                  consoleMaxChars: pool.cfg.stateConsoleMaxChars,
                  consoleCount: pool.cfg.stateConsoleCount,
                  screenshotMaxRes: pool.cfg.stateScreenshotMaxRes,
                  screenshotStaleMs: pool.cfg.screenshotStaleMs,
                  dir: pool.cfg.stateDir,
                }
              })(),
            } })
            return
          }
          if (req.method === 'GET' && (p === '/unity-pool/api/state' || p === '/unity-pool/api/state/')) {
            const sessionId = url.searchParams.get('sessionId') || ''
            const cache = pool.stateCaches.get(sessionId) || null
            respond(res, 200, { ok: true, value: { sessionId, cache, view: pool.view(sessionId) } })
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/state-refresh' || p === '/unity-pool/api/state-refresh/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              await pool.collectState(sessionId).catch(() => null)
              respond(res, 200, { ok: true, value: { sessionId, cache: pool.stateCaches.get(sessionId) || null, view: pool.view(sessionId) } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/state-switch' || p === '/unity-pool/api/state-switch/')) {
            readJson(req).then(body => {
              const sessionId = String((body && body.sessionId) || '')
              const key = String((body && body.key) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required（状态开关按会话独立，v0.4.2）' } }); return }
              if (!key) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'key required (stateEnabled / stateGameScreenshot / ...)' } }); return }
              try {
                const value = pool.setStateSwitch(sessionId, key, body.value)
                // 开启后立即采集一次（若为总开关或某项，本会话绑定中时）
                if (pool.stateCarryEnabled(sessionId)) pool.collectState(sessionId).catch(() => {})
                respond(res, 200, { ok: true, value: { sessionId, key, value, state: pool.view(sessionId).state } })
              } catch (err) {
                respond(res, 400, { ok: false, error: { code: 'bad-params', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/scan' || p === '/unity-pool/api/scan/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              await pool.probe()
              const found = await pool.scan()
              respond(res, 200, { ok: true, value: { newServices: found, view: pool.view(sessionId) } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/bind' || p === '/unity-pool/api/bind/')) {
            readJson(req).then(async body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              try {
                const result = await pool.bind(sessionId, { instance: body.instance, serviceId: body.serviceId, force: body.force })
                respond(res, 200, { ok: true, value: { ...result, view: pool.view(sessionId) } })
              } catch (err) {
                respond(res, 409, { ok: false, error: { code: 'conflict', message: String(err?.message ?? err) } })
              }
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          if (req.method === 'POST' && (p === '/unity-pool/api/unbind' || p === '/unity-pool/api/unbind/')) {
            readJson(req).then(body => {
              const sessionId = String((body && body.sessionId) || '')
              if (!sessionId) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'sessionId required' } }); return }
              const result = pool.unbind(sessionId)
              respond(res, 200, { ok: true, value: { ...result, view: pool.view(sessionId) } })
            }).catch(() => respond(res, 400, { ok: false, error: { code: 'bad-json', message: 'invalid json body' } }))
            return
          }
          respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
        },
      }), 'unity-pool: http api')
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] HTTP API 注册失败: ' + String(err?.message ?? err))
  }
}

function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

/** Levenshtein 编辑距离（不区分大小写）。 */
function levenshtein(a, b) {
  a = String(a ?? '').toLowerCase()
  b = String(b ?? '').toLowerCase()
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 与请求名最相似的若干工具名（编辑距离 ≤ 阈值，最多 limit 个）。 */
function closestToolNames(requested, names, limit = 3) {
  const req = String(requested ?? '')
  const scored = []
  for (const name of names) {
    const d = levenshtein(req, name)
    if (d <= Math.max(2, Math.floor(Math.max(req.length, name.length) / 3))) {
      scored.push({ name, d })
    }
  }
  scored.sort((a, b) => a.d - b.d || a.name.length - b.name.length)
  return scored.slice(0, limit).map(x => x.name)
}

/** Unknown tool 错误的补救文案：可用工具名列表 + 相似工具提示 + 状态工具指引。 */
function toolsHintText(tools, requested) {
  const names = Array.isArray(tools) ? tools.map(t => t && t.name).filter(Boolean) : []
  if (names.length === 0) {
    return 'Unknown tool 处理提示：当前没有可用的工具列表（tools/list 未拉取成功）。请重新调用 unity_pool_bind 获取该服务的 MCP 工具列表（tools 字段），再从中选取正确的工具名重试。'
  }
  const req = String(requested ?? '')
  const lines = [
    'Unknown tool 处理提示：工具名 [' + req + '] 不存在于当前服务。可用工具（' + names.length + ' 个）：' + names.join(', '),
  ]
  const close = closestToolNames(req, names)
  if (close.length > 0) lines.push('相似工具：' + close.join('、') + '（检查拼写后重试）')
  lines.push('需要 Unity 编辑器状态（Game/Scene 截图、选中项、ui-snapshot、序列化字段、Console 全文/条目）时用 unity_pool_state（状态携带开关默认全关，需先开启）；完整工具描述与参数 schema 见 unity_pool_bind 返回的 tools 字段。')
  return lines.join('\n')
}