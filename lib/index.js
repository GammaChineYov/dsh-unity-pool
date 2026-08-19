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
// v0.3.8（2026-08-18）归档自动解绑：
//  - 每次 probe() 完成后检查绑定：实例不在最新发现列表（instance-archived）/ 服务连续离线达阈值
//    （service-offline，unbindOfflineStreak 默认 2，防瞬时抖动）/ 服务配置不存在（service-removed）
//    → 自动 unbind 释放会话（删除绑定 + 关闭 MCP 会话 + 持久化），避免会话停留在已归档实例上；
//  - 实例发现失败（instancesValid=false）保留上次列表不清空，不据此判归档（发现失败≠实例消失）；
//  - 新增配置 autoUnbindOnArchive（默认 true）/ unbindOfflineStreak（默认 2）；view 暴露
//    instancesValid / offlineStreak / lastAutoUnbind；HTTP /api/config 同步返回。
//
// v0.3.9（2026-08-18）归档解绑动态通知：
//  - 注册 systemPrompt.context('unity-pool:archive')（text 为函数，每次 agent request 前求值——
//    官方机制，sandbox-policy 同款）；自动解绑后只向被解绑的会话注入中文通知（时间/实例/原因 +
//    重新 bind 指引），其他会话注入空串；下一轮 request 自动感知，无需碰 unity_mcp 才报错；
//  - 新增配置 notifyUnbindOnArchive（默认 true）；view.rules / HTTP /api/config 同步返回。
//    关闭 busyWaitEnabled 可跳过忙时等待（仅失败时补一次探测附状态）。
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
  /** 同一实例默认不能被两个会话锁定；force=true 覆盖。 */
  enforceExclusive: z.boolean().default(true),
  /** 连接提示：agent 如何用绑定服务+实例工作（unity_mcp 代理即连接方式）。 */
  connectHint: z.string().default(''),
  /** unity_mcp 调用前是否探测 Unity 编辑器忙状态并等待（编译/刷新期间自动等待，最长 busyMaxWaitMs）。 */
  busyWaitEnabled: z.boolean().default(true),
  /** 忙时等待总时长上限（毫秒），默认 10 秒。 */
  busyMaxWaitMs: z.number().default(10000),
  /** 忙时等待的探测间隔（毫秒）。 */
  busyWaitIntervalMs: z.number().default(500),
  /** 实例被归档（从池中消失/服务离线）时自动解绑绑定该实例的会话（默认开启）。 */
  autoUnbindOnArchive: z.boolean().default(true),
  /** 服务离线连续探测次数达到该值才视为归档并自动解绑（防瞬时抖动误伤；最小 1）。 */
  unbindOfflineStreak: z.number().default(2),
  /** 归档自动解绑后，向被解绑的会话注入运行时通知（systemPrompt.context，官方机制），下一轮 agent request 自动感知。 */
  notifyUnbindOnArchive: z.boolean().default(true),

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
  /** ui-snapshot 快照最大字符数（额外传给 ui_snapshot 的 max_chars）。 */
  stateSnapshotMaxChars: z.number().default(4000),
  /** Console 文本（全文/选中）最大字符数。 */
  stateConsoleMaxChars: z.number().default(6000),
  /** Console 全文读取条数。 */
  stateConsoleCount: z.number().default(50),
})

const DEFAULT_CONNECT_HINT = '调用 unity_mcp(tool=..., params=...) 代理 MCP 工具调用；插件自动确保本会话目标实例激活。'

function normalizeUrl(url) {
  const s = String(url ?? '').trim()
  if (!s) return s
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : 'http://' + s
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Console 选中条目反射代码（读取 ConsoleWindow 当前选中条目的完整文本，含堆栈）。
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
  '  var fActive=cwType.GetField("m_ActiveText",flags);',
  '  if(fActive!=null){',
  '    var txt=(string)fActive.GetValue(cw);',
  '    if(!string.IsNullOrEmpty(txt))sb.Append(txt.Length>6000?txt.Substring(0,6000):txt);',
  '    else sb.Append("(Console 未选中任何条目)");',
  '  }else{sb.Append("(未找到 m_ActiveText 字段)");}',
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
      unbindOfflineStreak: Math.max(1, Number(cfg.unbindOfflineStreak) > 0 ? Number(cfg.unbindOfflineStreak) : 2),
      notifyUnbindOnArchive: cfg.notifyUnbindOnArchive !== false,
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
      stateSnapshotMaxChars: Number(cfg.stateSnapshotMaxChars) > 0 ? Number(cfg.stateSnapshotMaxChars) : 4000,
      stateConsoleMaxChars: Number(cfg.stateConsoleMaxChars) > 0 ? Number(cfg.stateConsoleMaxChars) : 6000,
      stateConsoleCount: Number(cfg.stateConsoleCount) > 0 ? Number(cfg.stateConsoleCount) : 50,
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
      instancesValid: false, // 最近一次实例发现是否成功（false=发现失败，不据此判归档）
      offlineStreak: 0,      // 连续离线探测次数（在线时归零）
    }))
    this.bindings = Object.create(null) // sessionId -> { serviceId, instanceId, boundAt }
    this.sessionClients = new Map()     // sessionId -> { serviceId, client: McpHttpClient }
    this.discoveryClients = new Map()   // serviceId -> McpHttpClient（探测/实例发现用）
    this.probeTimer = null
    this.stateTimer = null              // 状态采集定时器（仅 stateEnabled 时启）
    this.stateCaches = new Map()        // sessionId -> { at, instanceId, entries: [{key,label,ok,text?,file?,error?}] }
    this._stateCollecting = false       // 采集防重入标志
    this._load()
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
    } catch { /* 首次运行或文件损坏 */ }
  }

  _save() {
    try {
      const file = this.cfg.dataFile
      const payload = JSON.stringify({ bindings: this.bindings }, null, 2)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 持久化绑定失败: ' + String(err?.message ?? err))
    }
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
    await Promise.all(this.services.map(s => this.probeService(s)))
    this.autoUnbindArchived()
  }

  /**
   * 归档自动解绑：绑定实例从池中消失（实例不在最新发现列表 / 服务离线达阈值 / 服务配置不存在）时，
   * 自动释放该会话的绑定（删除绑定 + 关闭 MCP 会话 + 持久化），避免会话停留在已归档实例上。
   * 在每次 probe() 完成后调用；幂等。返回本次自动解绑的会话列表（[{sessionId, serviceId, instanceId, reason}]）。
   */
  autoUnbindArchived() {
    if (this.cfg.autoUnbindOnArchive === false) return []
    const now = Date.now()
    const streak = Math.max(1, Number(this.cfg.unbindOfflineStreak) > 0 ? Number(this.cfg.unbindOfflineStreak) : 2)
    const archived = []
    for (const [sid, b] of Object.entries(this.bindings)) {
      const svc = this.serviceById(b.serviceId)
      if (!svc) {
        archived.push({ sessionId: sid, serviceId: b.serviceId, instanceId: b.instanceId, reason: 'service-removed' })
        continue
      }
      if (svc.alive === false) {
        // 服务离线：只有「曾在线过且连续离线达到阈值」才视为归档（避免启动抖动/单次超时误伤）
        if (svc.aliveAt > 0 && (svc.offlineStreak || 0) >= streak) {
          archived.push({ sessionId: sid, serviceId: b.serviceId, instanceId: b.instanceId, reason: 'service-offline' })
        }
        continue
      }
      // 服务在线：仅在本次实例发现成功（列表权威）时判定实例消失
      if (svc.instancesValid && !svc.instances.some(i => i.id === b.instanceId)) {
        archived.push({ sessionId: sid, serviceId: b.serviceId, instanceId: b.instanceId, reason: 'instance-archived' })
      }
    }
    for (const a of archived) {
      this.unbind(a.sessionId)
      this.ctx?.logger?.info?.('[unity-pool] 归档自动解绑: ' + a.sessionId + ' → ' + a.instanceId + ' (' + a.reason + ')')
    }
    if (archived.length > 0) {
      this.lastAutoUnbind = { at: now, count: archived.length, items: archived }
    }
    return archived
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
    this.stopStateTimer()
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

  /** 是否为本会话启用状态携带（总开关开 + 至少一项子开关开）。 */
  stateCarryEnabled(sessionId) {
    if (this.cfg.stateEnabled !== true) return false
    return this.cfg.stateGameScreenshot || this.cfg.stateSceneScreenshot || this.cfg.stateSelection
      || this.cfg.stateUiSnapshot || this.cfg.stateSerialized || this.cfg.stateConsoleAll
      || this.cfg.stateConsoleSelected
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
  async collectState(sessionId) {
    if (this._stateCollecting) return null // 全局防重入：采集轮次错开，避免多会话并发打满 Unity
    this._stateCollecting = true
    try {
      const binding = this.bindingOf(sessionId)
      if (!binding || !binding.serviceId) return null
      const service = this.serviceById(binding.serviceId)
      if (!service) return null
      const instance = binding.instanceId
      if (!instance) return null
      const client = this.sessionClient(sessionId, service)
      await client.ensureInit()
      if (client.activeInstance !== instance) await client.setActive(instance)

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
          entries.push({ key, label, ok: true, file, width: Number(res.structuredContent?.data?.imageWidth) || undefined })
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

      if (this.cfg.stateSelection) {
        try {
          selectionText = await execSelection()
          entries.push({ key: 'selection', label: '当前选中项', ok: true, text: UnityPool.truncate(selectionText, this.cfg.stateMaxChars, '选中项') })
        } catch (err) {
          entries.push({ key: 'selection', label: '当前选中项', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      } else if (this.cfg.stateUiSnapshot || this.cfg.stateSerialized) {
        // ui-snapshot / 序列化字段依赖选中 GameObject：即使 selection 开关关，也内部取一次选中项
        try { selectionText = await execSelection() } catch { /* 忽略，后续项会报错 */ }
      }

      // 选中 GameObject 第一个 id（供 ui-snapshot / 序列化字段使用）
      const firstGoId = (() => {
        const m = /- ([^\n]+) \| type=GameObject \| id=(\d+)/.exec(selectionText)
        return m ? Number(m[2]) : null
      })()

      // 选中物体 ui-snapshot 快照（自定义工具，未注册则报错提示）
      if (this.cfg.stateUiSnapshot) {
        try {
          if (!firstGoId) throw new Error(selectionText.includes('count=0') ? '当前没有选中物体' : '选中项不是 GameObject（无法做 ui-snapshot）')
          const res = await client.callTool('ui_snapshot', {
            ids: [firstGoId],
            include_children: true,
            include_inactive: false,
            max_nodes: 120,
            max_refs: 120,
            max_chars: Math.min(this.cfg.stateSnapshotMaxChars, this.cfg.stateMaxChars),
            force_refresh: true,
          })
          if (res.isError) throw new Error(res.text || 'ui_snapshot failed')
          let text = res.text
          try {
            const parsed = JSON.parse(res.text)
            if (parsed && typeof parsed.data?.text === 'string') text = parsed.data.text
            else if (parsed && typeof parsed.data?.summary?.nodeCount === 'number') {
              text = '节点 ' + parsed.data.summary.nodeCount + ' 个 / 引用 ' + parsed.data.summary.refCount + ' 个（完整快照见 Library ' + (parsed.data.summary.libraryPath || '') + '）'
            }
          } catch { /* 文本原样 */ }
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: true, text: UnityPool.truncate(text, this.cfg.stateSnapshotMaxChars, 'ui-snapshot') })
        } catch (err) {
          entries.push({ key: 'uiSnapshot', label: '选中项 ui-snapshot', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // 选中物体序列化字段（components 资源，防超长截断）
      if (this.cfg.stateSerialized) {
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
          entries.push({ key: 'serialized', label: '选中物体序列化字段', ok: false, error: String(err?.message ?? err).slice(0, 200) })
        }
      }

      // Console 全文（read_console，count + 截断防超长）
      if (this.cfg.stateConsoleAll) {
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
      if (this.cfg.stateConsoleSelected) {
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

      // 截图（最后采集，避免拖慢文本项）
      if (this.cfg.stateGameScreenshot) await shot('gameShot', 'Game 视图截图', 'game_view', 'game.png')
      if (this.cfg.stateSceneScreenshot) await shot('sceneShot', 'Scene 视图截图', 'scene_view', 'scene.png')

      this.stateCaches.set(sessionId, { at, instanceId: instance, entries })
      return this.stateCaches.get(sessionId)
    } catch (err) {
      this.ctx?.logger?.warn?.('[unity-pool] 状态采集失败: ' + String(err?.message ?? err))
      return null
    } finally {
      this._stateCollecting = false
    }
  }

  /** 同步读取会话状态快照文本（context 注入用，绝不做异步 MCP 调用）。 */
  stateContextText(sessionId) {
    if (this.cfg.stateEnabled !== true) return ''
    const cache = this.stateCaches.get(String(sessionId))
    if (!cache || !Array.isArray(cache.entries) || cache.entries.length === 0) return ''
    const lines = []
    for (const e of cache.entries) {
      if (e.ok) {
        if (e.file) lines.push('- [' + e.label + '] ' + e.file + (e.width ? '（宽 ' + e.width + 'px）' : '') + '（可用 read_image 工具查看）')
        else lines.push('- [' + e.label + '] ' + (e.text || '（无内容）'))
      } else {
        lines.push('- [' + e.label + '] 采集失败: ' + (e.error || 'unknown'))
      }
    }
    const time = new Date(cache.at).toLocaleTimeString('zh-CN', { hour12: false })
    return '<unity_pool_state>\nUnity 状态（采集于 ' + time + '，' + cache.instanceId + '）：\n' + lines.join('\n') + '\n</unity_pool_state>'
  }

  /** 启动状态采集定时器（仅 stateEnabled 时；幂等）。 */
  startStateTimer() {
    if (this.stateTimer || this.cfg.stateEnabled !== true) return
    const interval = Math.max(1000, this.cfg.stateRefreshMs)
    this.stateTimer = setInterval(() => {
      for (const sid of Object.keys(this.bindings)) {
        if (!this.stateCarryEnabled(sid)) continue
        this.collectState(sid).catch(() => {})
      }
    }, interval)
    if (this.stateTimer.unref) this.stateTimer.unref()
    // 启动即采集一次（首个绑定会话立即可注入）
    for (const sid of Object.keys(this.bindings)) {
      if (this.stateCarryEnabled(sid)) this.collectState(sid).catch(() => {})
    }
  }

  /** 停止状态采集定时器。 */
  stopStateTimer() {
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null }
  }

  /** 切换状态携带开关（运行时，HTTP /api/state-switch 用）。key 如 'stateEnabled' / 'stateGameScreenshot'。 */
  setStateSwitch(key, value) {
    const known = ['stateEnabled', 'stateGameScreenshot', 'stateSceneScreenshot', 'stateSelection', 'stateUiSnapshot', 'stateSerialized', 'stateConsoleAll', 'stateConsoleSelected']
    if (!known.includes(key)) throw new Error('未知状态开关: ' + key + '（可选: ' + known.join(', ') + '）')
    this.cfg[key] = value === true || value === 'true' || value === 1 || value === '1'
    if (this.cfg.stateEnabled === true) this.startStateTimer()
    return this.cfg[key]
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
   * 会话首次绑定时（此前未锁定过）或切换到另一服务（serviceId 变化）时，
   * 额外拉取目标服务上的 MCP 工具列表（tools/list）随结果返回，
   * 便于立即了解该实例可用哪些工具；拉取失败不阻断绑定（toolsError 说明原因）。
   * @param opts {instance?, serviceId?, force?}
   */
  async bind(sessionId, opts = {}) {
    const force = Boolean(opts.force)
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
        throw new Error('实例 [' + target.instance.id + '] 已被会话 ' + others.join(', ') + ' 锁定（并行开发请锁定不同实例；确认后可传 force=true）')
      }
    }

    const prev = this.bindings[sessionId]
    const isFirstBind = !prev
    // 跨服务切换（不同 mcp-for-unity server）时工具集可能不同，同样需要重拉
    const isNewService = Boolean(prev && prev.serviceId !== target.service.id)
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
    // 首次绑定或跨服务切换：拉取目标服务上的 MCP 工具列表（best-effort，失败不阻断绑定）
    if (isFirstBind || isNewService) {
      try {
        const client = this.sessionClient(sessionId, target.service)
        await client.ensureInit()
        const tools = await client.listTools()
        result.tools = tools
        result.toolsCount = tools.length
      } catch (err) {
        result.tools = []
        result.toolsCount = 0
        result.toolsError = String(err?.message ?? err)
      }
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
      delete this.bindings[sessionId]
      this._save()
    }
    if (this.stateCaches.has(sessionId)) this.stateCaches.delete(sessionId)
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

  /** 会话视角完整状态视图。 */
  view(sessionId) {
    const binding = this.bindingOf(sessionId)
    return {
      sessionId,
      binding,
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
        unbindOfflineStreak: this.cfg.unbindOfflineStreak,
        notifyUnbindOnArchive: this.cfg.notifyUnbindOnArchive !== false,
      },
      lastAutoUnbind: this.lastAutoUnbind || null,
      connectHint: this.cfg.connectHint || DEFAULT_CONNECT_HINT,
      state: {
        enabled: this.cfg.stateEnabled === true,
        switches: {
          stateEnabled: this.cfg.stateEnabled === true,
          stateGameScreenshot: this.cfg.stateGameScreenshot === true,
          stateSceneScreenshot: this.cfg.stateSceneScreenshot === true,
          stateSelection: this.cfg.stateSelection === true,
          stateUiSnapshot: this.cfg.stateUiSnapshot === true,
          stateSerialized: this.cfg.stateSerialized === true,
          stateConsoleAll: this.cfg.stateConsoleAll === true,
          stateConsoleSelected: this.cfg.stateConsoleSelected === true,
        },
        refreshMs: this.cfg.stateRefreshMs,
        maxChars: this.cfg.stateMaxChars,
        snapshotMaxChars: this.cfg.stateSnapshotMaxChars,
        consoleMaxChars: this.cfg.stateConsoleMaxChars,
        consoleCount: this.cfg.stateConsoleCount,
        screenshotMaxRes: this.cfg.stateScreenshotMaxRes,
        dir: this.cfg.stateDir,
        cache: this.stateCaches.get(sessionId)
          ? {
              at: this.stateCaches.get(sessionId).at,
              instanceId: this.stateCaches.get(sessionId).instanceId,
              entries: (this.stateCaches.get(sessionId).entries || []).map(e => ({
                key: e.key, label: e.label, ok: e.ok, ...(e.file ? { file: e.file } : {}), ...(e.text !== undefined ? { textLength: e.text.length } : {}), ...(e.error ? { error: e.error } : {}),
              })),
            }
          : null,
      },
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
    if (client.activeInstance !== instance) {
      await client.setActive(instance)
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
    const res = await client.callTool(tool, params)
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
    }
    return base
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
    unbindOfflineStreak: config?.unbindOfflineStreak,
    notifyUnbindOnArchive: config?.notifyUnbindOnArchive,
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
        '3. 用 unity_pool_bind(instance="Name@hash" 或 hash 前缀) 把本会话目标实例锁定为指定实例（一个会话只锁定一个实例）；首次绑定或切换到另一服务时，返回结果附带该服务的 MCP 工具列表（tools 字段，含名称/描述/参数 schema），可据此直接 unity_mcp 调用。注意：工具列表是服务级并集（同一服务上多工程实例的自定义工具会合并列出），列表里的自定义工具可能来自其他工程实例，调用失败属正常，说明该实例未注册此工具，改用官方工具即可。',
        '4. 之后所有 MCP 操作统一走 unity_mcp(tool="<mcp工具名>", params={...}) 代理——',
        '   插件会自动把本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），再转发调用，助手无感；',
        '   请求的工具不在已知列表时插件会自动重拉 tools/list（Unity 可运行时注册/注销自定义工具、manage_tools 可开关工具组）；',
        '   返回内容中的 [image: ...] 占位表示官方返回了图片块（如 manage_camera include_image=true 的截图），文本通道已丢弃图片本体，需要时改用文本摘要参数；',
        '   Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败返回会附带编辑器状态 editorState（isCompiling/isUpdating/progressCount），据此判断是否忙碌所致。',
        '5. 不再使用时调 unity_pool_unbind 释放（关闭本会话的 MCP 会话）。',
        '状态携带（可选，默认全关）：插件可在每次发出指令时把 Unity 当前状态注入到上下文（配置 stateEnabled 等开关，或面板/HTTP /api/state-switch 运行时开启）——Game/Scene 视图截图（PNG 落盘到 stateDir，上下文给文件路径，可用 read_image 查看）、Hierarchy/Project 当前选中项、选中物体 ui-snapshot 与序列化字段、Console 全文/选中条目；各项均有独立开关与防超长截断（stateMaxChars 等）。需要状态时调 unity_pool_state 立即刷新查看。',
        '自动解绑：实例被归档（Unity 关闭/实例从池中消失/服务离线）时，插件会在下一次探测后自动解绑绑定该实例的会话（autoUnbindOnArchive 默认开启；服务离线需连续 2 次探测确认防抖动），并在下一轮请求注入解绑通知（notifyUnbindOnArchive 默认开启），无需手动处理；重新 unity_pool_bind 即可。',
        '规则：多个会话可以并行开发同一实例——你和别的会话绑定同一实例时，并发调用由 Unity 侧排队（性能排队而非错误），注意一下别操作太快；',
        'enforceExclusive 默认开启仅表示直接绑定会被拒，并行开发同一实例属正常用法，传 force=true 即可。',
        '</unity_pool_guide>',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 系统提示注册失败: ' + String(err?.message ?? err))
  }

  // ---- 归档解绑动态通知（官方机制 systemPrompt.context，text 为函数，每次 agent request 前求值）----
  // 自动解绑发生后，只给「被解绑的那个会话」注入一段中文通知，其他会话注入空串；
  // 会话下一轮 request 自动感知，无需主动碰 unity_mcp 才撞上「未锁定」报错。
  try {
    ctx.systemPrompt.context({
      name: 'unity-pool:archive',
      order: 130,
      text: (context) => {
        if (pool.cfg.notifyUnbindOnArchive === false) return ''
        if (!pool.lastAutoUnbind || pool.lastAutoUnbind.count === 0) return ''
        const agent = context && context.agent
        const sessionId = agent && (agent.id || (agent.session && agent.session.id))
        if (!sessionId) return ''
        const mine = (pool.lastAutoUnbind.items || []).filter(i => i.sessionId === String(sessionId))
        if (mine.length === 0) return ''
        const when = new Date(pool.lastAutoUnbind.at).toLocaleString('zh-CN', { hour12: false })
        const lines = mine.map(i => {
          const reasonText = i.reason === 'instance-archived' ? '实例已归档（Unity 关闭/下线）'
            : i.reason === 'service-offline' ? '服务离线'
            : i.reason === 'service-removed' ? '服务配置不存在'
            : String(i.reason || 'unknown')
          return '- ' + (i.instanceId || '') + '（' + reasonText + '）'
        }).join('\n')
        return '【Unity 服务池】' + when + ' 检测到你绑定的实例已被归档，自动解绑了本会话：\n' + lines + '\n需要继续操作请重新调用 unity_pool_bind(instance="Name@hash") 或 unity_pool_status 查看可用实例。'
      },
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 归档通知 context 注册失败: ' + String(err?.message ?? err))
  }

  // ---- 状态携带注入（v0.4.0，官方机制 systemPrompt.context，text 同步函数每次 agent request 前求值）----
  // 后台采集器（startStateTimer）周期采集已绑定会话的开启项到 stateCaches，这里同步读取注入——
  // 每次发出指令（agent request）时都携带最近的 Unity 状态快照（截图路径/选中项/序列化字段/Console）。
  // 默认全关（stateEnabled=false），需要时通过 cordis.patch.yml 配置或面板开关开启。
  try {
    ctx.systemPrompt.context({
      name: 'unity-pool:state',
      order: 125,
      text: (context) => {
        if (pool.cfg.stateEnabled !== true) return ''
        const agent = context && context.agent
        const sessionId = agent && (agent.id || (agent.session && agent.session.id))
        if (!sessionId) return ''
        try {
          return pool.stateContextText(sessionId)
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
      description: '查看 Unity 服务池状态：每个服务（mcp-for-unity server）的存活状态与已连接的 Unity 实例列表（实例 id 为 Name@hash，含 name/hash/是否本会话激活 active）、本会话当前锁定的目标实例、分配规则（autoAssign/enforceExclusive/autoUnbindOnArchive）、最近一次归档自动解绑 lastAutoUnbind。需要连接 Unity 前先调用本工具。',
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
      description: '把本会话的目标实例锁定为一个 Unity 实例（一个会话只锁定一个实例）。传 instance（Name@hash 或 hash 前缀）锁定指定实例；传 serviceId 则锁定该服务上第一个实例；都不传则自动分配一个未被其他会话锁定的实例。enforceExclusive 下同一实例默认不能被第二个会话锁定，确有需要可传 force=true。返回锁定结果与状态视图；会话首次绑定或切换到另一服务时，额外附带该服务上的 MCP 工具列表（tools 字段，含 name/description/inputSchema 与 toolsCount），可据此直接 unity_mcp 调用。注意：工具列表为服务级并集（同服务多工程实例的自定义工具合并列出），其中部分自定义工具可能不属于当前实例，调用失败即说明该实例未注册此工具。',
      parameters: {
        instance: { type: 'string', description: '目标实例 id（Name@hash，来自 unity_pool_status）；缺省自动分配。' },
        serviceId: { type: 'string', description: '限定在指定服务内查找实例（可选）。' },
        force: { type: 'boolean', description: '实例已被其他会话锁定时是否强制锁定（默认 false）。' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      async execute(args, exec) {
        const sessionId = requireSession(exec)
        const a = args || {}
        const result = await pool.bind(sessionId, { instance: a.instance, serviceId: a.serviceId, force: Boolean(a.force) })
        return { ...result, view: pool.view(sessionId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'unity_mcp',
      description: '代理调用本会话目标实例上的 MCP 工具（先通过本插件）：调用前自动确保本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），然后转发 tools/call 并返回结果。tool 为 mcp-for-unity 工具名（如 manage_scene、manage_gameobject、manage_camera、read_console 等）；请求的工具不在已知列表时插件会自动重拉 tools/list 再转发（官方工具集合可动态增减）。params 为该工具参数对象。Unity 编译/刷新期间插件会自动等待（忙时探测最长 10 秒），调用失败时返回附带编辑器状态 editorState 便于判断是否忙碌所致。本工具前需先用 unity_pool_bind 锁定目标实例。',
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
              unbindOfflineStreak: pool.cfg.unbindOfflineStreak,
              notifyUnbindOnArchive: pool.cfg.notifyUnbindOnArchive !== false,
              state: {
                enabled: pool.cfg.stateEnabled === true,
                gameScreenshot: pool.cfg.stateGameScreenshot === true,
                sceneScreenshot: pool.cfg.stateSceneScreenshot === true,
                selection: pool.cfg.stateSelection === true,
                uiSnapshot: pool.cfg.stateUiSnapshot === true,
                serialized: pool.cfg.stateSerialized === true,
                consoleAll: pool.cfg.stateConsoleAll === true,
                consoleSelected: pool.cfg.stateConsoleSelected === true,
                refreshMs: pool.cfg.stateRefreshMs,
                maxChars: pool.cfg.stateMaxChars,
                snapshotMaxChars: pool.cfg.stateSnapshotMaxChars,
                consoleMaxChars: pool.cfg.stateConsoleMaxChars,
                consoleCount: pool.cfg.stateConsoleCount,
                screenshotMaxRes: pool.cfg.stateScreenshotMaxRes,
                dir: pool.cfg.stateDir,
              },
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
              if (!key) { respond(res, 400, { ok: false, error: { code: 'bad-params', message: 'key required (stateEnabled / stateGameScreenshot / ...)' } }); return }
              try {
                const value = pool.setStateSwitch(key, body.value)
                // 开启后立即采集一次（若为总开关或某项，本会话绑定中时）
                if (sessionId && pool.stateCarryEnabled(sessionId)) pool.collectState(sessionId).catch(() => {})
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
                const result = await pool.bind(sessionId, { instance: body.instance, serviceId: body.serviceId, force: Boolean(body.force) })
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