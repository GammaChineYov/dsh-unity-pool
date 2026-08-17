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
})

const DEFAULT_CONNECT_HINT = '调用 unity_mcp(tool=..., params=...) 代理 MCP 工具调用；插件自动确保本会话目标实例激活。'

function normalizeUrl(url) {
  const s = String(url ?? '').trim()
  if (!s) return s
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : 'http://' + s
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
    }))
    this.bindings = Object.create(null) // sessionId -> { serviceId, instanceId, boundAt }
    this.sessionClients = new Map()     // sessionId -> { serviceId, client: McpHttpClient }
    this.discoveryClients = new Map()   // serviceId -> McpHttpClient（探测/实例发现用）
    this.probeTimer = null
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
    } catch (err) {
      service.alive = false
      service.lastError = String((err && err.name === 'AbortError') ? 'timeout' : (err?.message ?? err))
      service.instances = []
      return
    }
    // 实例发现（best-effort）：读 mcpforunity://instances
    try {
      const client = this.discoveryClient(service)
      const instances = await client.listInstances()
      service.instances = instances
      service.discoveredAt = Date.now()
    } catch (err) {
      service.lastError = 'instances: ' + String(err?.message ?? err)
      service.instances = []
    }
  }

  async probe() {
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
      const candidate = { id: 'scan-' + (index++), name: 'Scan-' + port, url, alive: false, aliveAt: 0, lastError: null, instances: [], discoveredAt: 0 }
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
  }

  stop() {
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null }
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
   * 会话首次绑定时（此前未锁定过）额外拉取目标服务上的 MCP 工具列表（tools/list）随结果返回，
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

    const isFirstBind = !this.bindings[sessionId]
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
    // 首次绑定：拉取目标服务上的 MCP 工具列表（best-effort，失败不阻断绑定）
    if (isFirstBind) {
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
    return result
  }

  unbind(sessionId) {
    const had = this.bindings[sessionId]
    if (had) {
      delete this.bindings[sessionId]
      this._save()
    }
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
      },
      connectHint: this.cfg.connectHint || DEFAULT_CONNECT_HINT,
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
    const res = await client.callTool(tool, params)
    return {
      success: !res.isError,
      activeInstance: instance,
      tool,
      text: res.text,
      ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
      ...(res.isError ? { isError: true } : {}),
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
        '3. 用 unity_pool_bind(instance="Name@hash" 或 hash 前缀) 把本会话目标实例锁定为指定实例（一个会话只锁定一个实例）；首次绑定时返回结果附带该服务的 MCP 工具列表（tools 字段），可据此直接 unity_mcp 调用。',
        '4. 之后所有 MCP 操作统一走 unity_mcp(tool="<mcp工具名>", params={...}) 代理——',
        '   插件会自动把本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），再转发调用，助手无感。',
        '5. 不再使用时调 unity_pool_unbind 释放（关闭本会话的 MCP 会话）。',
        '规则：并行多 Unity 终端开发时，不同会话必须锁定不同实例（enforceExclusive 默认开启）；',
        '同一服务上不同实例可被不同会话同时使用；同一实例被多会话并发调用时由 Unity 侧排队。',
        '</unity_pool_guide>',
      ].join('\n'),
    })
  } catch (err) {
    ctx.logger?.warn?.('[unity-pool] 系统提示注册失败: ' + String(err?.message ?? err))
  }

  // ---- Agent 工具 ----
  try {
    ctx.tools.register(defineTool({
      name: 'unity_pool_status',
      description: '查看 Unity 服务池状态：每个服务（mcp-for-unity server）的存活状态与已连接的 Unity 实例列表（实例 id 为 Name@hash，含 name/hash/是否本会话激活 active）、本会话当前锁定的目标实例、分配规则与连接提示。需要连接 Unity 前先调用本工具。',
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
      description: '把本会话的目标实例锁定为一个 Unity 实例（一个会话只锁定一个实例）。传 instance（Name@hash 或 hash 前缀）锁定指定实例；传 serviceId 则锁定该服务上第一个实例；都不传则自动分配一个未被其他会话锁定的实例。enforceExclusive 下同一实例默认不能被第二个会话锁定，确有需要可传 force=true。返回锁定结果与状态视图；会话首次绑定时额外附带该服务上的 MCP 工具列表（tools 字段，含 name/description/inputSchema），可据此直接 unity_mcp 调用。',
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
      description: '代理调用本会话目标实例上的 MCP 工具（先通过本插件）：调用前自动确保本会话的 MCP 会话激活到目标实例（per MCP-Session-Id 隔离，其他会话用其他实例互不干扰），然后转发 tools/call 并返回结果。tool 为 mcp-for-unity 工具名（如 manage_scene、manage_gameobject、manage_camera、read_console 等）；请求的工具不在已知列表时插件会自动重拉 tools/list 再转发（官方工具集合可动态增减）。params 为该工具参数对象。本工具前需先用 unity_pool_bind 锁定目标实例。',
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
            } })
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