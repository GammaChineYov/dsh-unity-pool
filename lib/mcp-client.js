// dsh-unity-pool — MCP streamable-HTTP 客户端（薄封装）。
//
// 按 MCP 规范走 mcp-for-unity 的 HTTP 端点：
//  - initialize 拿 Mcp-Session-Id（每个实例一个 session，服务端按 session 隔离 active instance）；
//  - resources/read(mcpforunity://instances) 发现已连接的 Unity 编辑器；
//  - tools/call(set_active_instance) 设置本 session 的目标实例；
//  - tools/call(<任意工具>) 代理转发。
// 响应兼容纯 JSON 与 SSE（text/event-stream）。同一 client 内部调用串行（服务端单进程）。

const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT_MS = 30000

/**
 * 解析 MCP 响应体。SSE 可能含多条 data 帧：
 *  - 服务端通知（notifications/message 等，无请求 id）——跳过；
 *  - 请求响应帧（jsonrpc + id）——取 id 与 reqId 匹配的；
 *  - 无 id 匹配时回退最后一条有 id 的帧。
 */
function parseBody(ct, text, reqId) {
  if (ct.includes('text/event-stream')) {
    let lastWithId = null
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l.startsWith('data: ')) continue
      const data = l.slice(6).trim()
      if (!data) continue
      let msg
      try { msg = JSON.parse(data) } catch { continue }
      if (!msg || typeof msg !== 'object') continue
      if (msg.id !== undefined) {
        lastWithId = msg
        if (reqId === undefined || msg.id === reqId) return msg
      }
      // 无 id 的通知帧（notifications/*）跳过
    }
    if (lastWithId) return lastWithId
    throw new Error('SSE 响应中没有请求响应帧')
  }
  const t = text.trim()
  if (!t) throw new Error('空响应')
  return JSON.parse(t)
}

export class McpHttpClient {
  constructor(url, opts = {}) {
    this.url = url
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this.logger = opts.logger || null
    this.sessionId = null
    this.protocolVersion = null
    // 实例绑定与「MCP 会话」同生共死（v0.5.7）：
    //   activeInstance 只是服务端 session-scoped state 的本地镜像；服务端会话一旦丢失
    //   （服务重启 / 会话被清理 / Unity Domain Reload 后重建），镜像就变成陈旧值，
    //   后续调用会误判「已在本会话激活过」而跳过 set_active_instance → 多实例并存时
    //   被官方守卫拦死（这正是 v0.5.6 及之前 unity_mcp 全线失败、且 set_active_instance
    //   看起来"成功"却无效的根因）。改为「镜像值 + 记下它属于哪个 session」两段式存储。
    this._activeInstance = null
    this._activeInstanceSession = null
    // 每调用路由：把绑定实例作为 unity_instance 参数随每次 tools/call 一起发，
    // 由服务端 middleware 在**本次调用**上直接解析，不依赖 session state。
    this.pinnedInstance = null
    this.supportsPerCallInstance = true // 老服务端不认识 unity_instance 时自动降级
    this._nextId = 1
    this._chain = Promise.resolve()
    this._insideSerial = false
  }

  /** 本会话（MCP session）在服务端激活的目标实例。会话被重建/失效后镜像自动作废（返回 null），
   *  使调用方必然重新激活，不再出现「本地以为已激活、服务端其实没有」的静默错路由。 */
  get activeInstance() {
    return (this._activeInstance !== null && this._activeInstanceSession === this.sessionId)
      ? this._activeInstance : null
  }

  set activeInstance(value) {
    this._activeInstance = (value === undefined || value === null) ? null : value
    this._activeInstanceSession = this._activeInstance === null ? null : this.sessionId
  }

  log(level, msg) {
    try { this.logger?.[level]?.('[unity-pool] ' + msg) } catch { /* ignore */ }
  }

  /** 串行执行（同 client 的调用保持顺序，符合 mcp-for-unity 单进程语义）。 */
  _serial(fn) {
    // 重入保护：若已处于本链任务内部（如 ensureInit 在 call 的串行任务里被调用），
    // 直接内联执行——外层链已保证串行，嵌套 _serial 会与自身互等造成死锁。
    if (this._insideSerial) {
      return Promise.resolve().then(fn)
    }
    const run = this._chain.then(() => {
      this._insideSerial = true
      try {
        return fn()
      } finally {
        this._insideSerial = false
      }
    })
    this._chain = run.catch(() => {})
    return run
  }

  async _request(method, params, { id, timeoutMs } = {}) {
    const reqId = id ?? this._nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, ...(params === undefined ? {} : { params }) })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const tm = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    // ★ 超时必须覆盖「整个请求 + 响应体读取」：
    // streamable HTTP 的响应可能是 SSE 流（保活/长连接/非 MCP 服务只发头不收尾），
    // 若在 fetch 拿到响应头后就 clearTimeout，res.text() 会永久挂起 → 本 client 的串行链被
    // 一个永不 settle 的任务占住 → probe / listInstances / unity_pool_scan 等所有后续调用
    // 全部排队等死（2026-09-09「unity_pool_scan 卡死」根因）。
    // 因此 timer 一直活到 body 读完（或解析/抛错）为止，由 finally 统一清理。
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, tm)
    if (timer.unref) timer.unref()
    try {
      let res
      try {
        res = await fetch(this.url, { method: 'POST', headers, body, signal: ctrl.signal })
      } catch (err) {
        const reason = (timedOut || err?.name === 'AbortError') ? 'timeout(' + tm + 'ms)' : String(err?.message ?? err)
        throw new Error('MCP 请求失败(' + this.url + '): ' + reason)
      }
      const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id')
      if (sid) this.sessionId = sid
      const ct = res.headers.get('content-type') || ''
      let text
      try {
        // abort 会同时中断响应体读取（undici 语义），保证这里不会永久挂起
        text = await res.text()
      } catch (err) {
        const reason = (timedOut || err?.name === 'AbortError') ? 'timeout(' + tm + 'ms，响应体未结束)' : String(err?.message ?? err)
        throw new Error('MCP 响应读取失败(' + this.url + '): ' + reason)
      }
      let msg
      try {
        msg = parseBody(ct, text, reqId)
      } catch (err) {
        throw new Error('MCP 响应解析失败(' + this.url + '): ' + String(err?.message ?? err) + ' | http=' + res.status + ' | body=' + text.slice(0, 300))
      }
      if (res.status >= 400 && !msg?.jsonrpc) {
        throw new Error('MCP HTTP ' + res.status + ' (' + this.url + '): ' + text.slice(0, 300))
      }
      if (msg?.error) {
        const e = msg.error
        const err = new Error('MCP RPC 错误 ' + (e.code ?? '?') + ': ' + (e.message ?? 'unknown') + (e.data !== undefined ? ' | ' + JSON.stringify(e.data) : ''))
        // 会话失效（服务重启/会话被清理）：重置本地会话状态，使后续 ensureInit 自动重建会话
        if (e.code === -32600 || /session not found/i.test(String(e.message ?? ''))) {
          err.sessionInvalid = true
          this.sessionId = null
          this._initialized = false
          this.activeInstance = null // v0.5.7：会话丢了，实例选择镜像一并作废（否则旧会话的"已激活"会骗过调用方）
        }
        throw err
      }
      if (msg?.id !== reqId && method !== 'notifications/initialized') {
        // 某些实现可能回 echo；id 不匹配时仍取 result（宽松）
      }
      return msg
    } finally {
      clearTimeout(timer)
    }
  }

  /** 执行 initialize → notifications/initialized 序列（不经 _serial；调用方需已处于串行链内，或由 ensureInit 包一层）。 */
  async _doInit() {
    if (this._initialized) return
    const res = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-unity-pool', version: '0.5.7' },
    })
    this.protocolVersion = res?.result?.protocolVersion ?? null
    this.sessionId = this.sessionId ?? null
    try {
      await this._request('notifications/initialized', undefined)
    } catch { /* 部分实现不回 notifications 响应，忽略 */ }
    this._initialized = true
    this.log('info', 'MCP 会话已建立 ' + this.url + ' session=' + String(this.sessionId))
  }

  /** 建立会话：initialize → notifications/initialized。幂等（会话失效时由 _request 重置状态，下次自动重建）。 */
  async ensureInit() {
    if (this.sessionId !== null && this._initialized) return
    return this._serial(() => this._doInit())
  }

  /** 通用 JSON-RPC 调用（需先 ensureInit）。会话失效（-32600 Session not found）时自动重建会话并重试一次。 */
  call(method, params, opts = {}) {
    const timeoutMs = opts && opts.timeoutMs
    return this._serial(async () => {
      await this.ensureInit()
      try {
        const msg = await this._request(method, params, { timeoutMs })
        return msg?.result
      } catch (err) {
        // 服务端会话已失效（服务重启/会话被清理）：_request 已重置 sessionId/_initialized，
        // 这里直接内联 _doInit 重建（不走 _serial——本任务已在串行链内，再排队会自等死锁）
        if (err && err.sessionInvalid && !this._recovering) {
          this._recovering = true
          try {
            await this._doInit()
            const msg = await this._request(method, params, { timeoutMs })
            return msg?.result
          } finally {
            this._recovering = false
          }
        }
        throw err
      }
    })
  }

  /** 读 mcpforunity://instances：返回实例列表（含 id/name/hash 等）。 */
  async listInstances() {
    const result = await this.call('resources/read', { uri: 'mcpforunity://instances' })
    const contents = (result && result.contents) || []
    let text = ''
    for (const c of contents) {
      if (c?.type === 'text' && typeof c.text === 'string') { text = c.text; break }
      if (typeof c?.text === 'string') { text = c.text; break }
    }
    if (!text) return []
    let parsed
    try { parsed = JSON.parse(text) } catch { return [] }
    if (!parsed || parsed.success === false) return []
    const list = Array.isArray(parsed.instances) ? parsed.instances : []
    return list.map(i => ({
      id: String(i.id ?? ''),
      name: String(i.name ?? i.id ?? ''),
      hash: String(i.hash ?? ''),
      ...(i.unity_version ? { unityVersion: String(i.unity_version) } : {}),
      ...(i.connected_at ? { connectedAt: i.connected_at } : {}),
    })).filter(i => i.id)
  }

  /** 设置本 session 的目标实例（Name@hash 或 hash 前缀）。记录到 activeInstance。 */
  async setActive(instance, opts = {}) {
    const result = await this.call('tools/call', {
      name: 'set_active_instance',
      arguments: { instance: String(instance) },
    }, opts)
    const info = extractToolText(result)
    let parsed = null
    try { parsed = JSON.parse(info) } catch { /* 非 JSON 文案 */ }
    if (parsed && parsed.success === false) {
      throw new Error('set_active_instance 失败: ' + (parsed.error ?? info))
    }
    this.activeInstance = parsed?.data?.instance ?? String(instance)
    return { activeInstance: this.activeInstance, message: parsed?.message ?? info }
  }

  /**
   * 读 mcpforunity://custom-tools：本会话「当前激活实例」注册的项目自定义工具名列表
   * （官方 mcp-for-unity 暴露的工程级自定义工具注册表；老服务端没有该资源 → 返回 null）。
   * 结果缓存到 this.customToolNames / this.customToolsAt，供工具排序（自定义优先）使用。
   */
  async listCustomTools() {
    const result = await this.call('resources/read', { uri: 'mcpforunity://custom-tools' })
    const contents = (result && result.contents) || []
    let text = ''
    for (const c of contents) { if (c && typeof c.text === 'string') { text = c.text; break } }
    if (!text) return null
    let parsed
    try { parsed = JSON.parse(text) } catch { return null }
    const list = parsed && parsed.data && Array.isArray(parsed.data.tools) ? parsed.data.tools : null
    if (!list) return null
    const names = list.map(t => String((t && t.name) || '')).filter(Boolean)
    this.customToolNames = names
    this.customToolsAt = Date.now()
    return names
  }

  /** 读 tools/list：返回服务端工具列表（含 name/description/inputSchema，MCP 标准形状）；结果缓存到 this.tools（动态工具集合的最新快照）。 */
  async listTools() {
    const result = await this.call('tools/list', {})
    const tools = Array.isArray(result?.tools) ? result.tools : []
    this.tools = tools
    return tools
  }

  /**
   * 组装本次调用的 arguments：带上 unity_instance（每调用路由，v0.5.7）。
   * - 只对普通工具加；set_active_instance 本身就是选实例的，加了会自相矛盾。
   * - 调用方已显式传 unity_instance 时尊重调用方。
   * - 老服务端（不认识该参数）由 callTool 的降级路径兜底。
   */
  _withInstanceArg(name, args, instance) {
    if (!instance || !this.supportsPerCallInstance) return args
    if (name === 'set_active_instance') return args
    const base = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {}
    if (base.unity_instance === undefined) base.unity_instance = String(instance)
    return base
  }

  /** 单次 tools/call（不含每调用路由装配）。 */
  _rawCallTool(name, args, opts = {}) {
    return this.call('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) }, opts)
  }

  /** 代理任意 MCP 工具调用。返回 {content, structuredContent, isError, text}。
   *  v0.5.7：随调用携带 unity_instance —— 服务端 middleware 在**这一次调用**上直接解析实例，
   *  不依赖 session-scoped state，因此「服务重启/会话被清理/多会话并发」都能稳定路由到绑定实例。 */
  async callTool(name, args, opts = {}) {
    const instance = (opts && opts.instance !== undefined && opts.instance !== null)
      ? String(opts.instance)
      : this.pinnedInstance
    let result
    try {
      result = await this._rawCallTool(name, this._withInstanceArg(name, args, instance), opts)
    } catch (err) {
      if (instance && this.supportsPerCallInstance && looksLikeUnsupportedInstanceArg(String(err?.message ?? err))) {
        this.supportsPerCallInstance = false
        this.log('warn', '服务端不认识 unity_instance（每调用路由）→ 本次起降级为只用会话状态路由：' + name)
        result = await this._rawCallTool(name, args, opts)
      } else {
        throw err
      }
    }
    if (instance && this.supportsPerCallInstance && looksLikeUnsupportedInstanceArg(extractToolText(result))) {
      this.supportsPerCallInstance = false
      this.log('warn', '服务端不认识 unity_instance（每调用路由）→ 本次起降级为只用会话状态路由：' + name)
      result = await this._rawCallTool(name, args, opts)
    }
    return {
      isError: Boolean(result?.isError),
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      text: extractToolText(result),
    }
  }

  close() {
    // streamable HTTP 无显式关闭；释放引用即可
    this.sessionId = null
    this._initialized = false
    this.activeInstance = null
  }
}

/**
 * 服务端「实例选择守卫」特征（MCPForUnity 侧）：
 * 会话没选实例 / 多实例歧义时，官方会返回这类文案或 reason=instance_selection_required。
 * 看到它就说明路由没生效——必须显式重选或如实报错，绝不能当成正常结果。
 */
export function looksLikeInstanceSelectionRequired(text) {
  const t = String(text ?? '')
  if (!t) return false
  return /instance_selection_required/.test(t)
    || /Multiple Unity instances are connected/i.test(t)
    || /Unity instance selection is required/i.test(t)
    || /No active Unity instance/i.test(t)
    || /Multiple Unity instances are connected and none is selected/i.test(t)
}

/** 老服务端把多余的 arguments 当作非法输入时的特征（用于 unity_instance 每调用路由的自动降级）。 */
export function looksLikeUnsupportedInstanceArg(text) {
  const t = String(text ?? '')
  if (!/unity_instance/.test(t)) return false
  return /unexpected|unrecognized|extra (argument|property)|unknown (argument|keyword)|invalid|validation|not permitted|additional propert/i.test(t)
}

function extractToolText(result) {
  const content = (result && result.content) || []
  const parts = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image: ' + (b.mimeType || 'unknown') + ', 内容已丢弃（文本通道）]')
    else if (b.type === 'audio') parts.push('[audio: ' + (b.mimeType || 'unknown') + ', 内容已丢弃（文本通道）]')
    else if (b.type === 'resource' || b.type === 'resource_link') parts.push('[resource: 内容已丢弃（文本通道）]')
    else parts.push('[unsupported content type: ' + String(b.type ?? 'unknown') + ']')
  }
  return parts.join('\n')
}

export function extractToolTextPublic(result) { return extractToolText(result) }