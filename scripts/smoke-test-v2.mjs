// dsh-unity-pool v2 集成测试：mock mcp-for-unity server（per MCP-Session-Id active 隔离）。
import http from 'node:http'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const PLUGIN = process.env.UNITY_POOL_LIB
  ? 'file:///' + process.env.UNITY_POOL_LIB.replace(/\\/g, '/')
  : 'file:///' + path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-unity-pool', 'lib', 'index.js').replace(/\\/g, '/')
const mod = await import(PLUGIN)
const { UnityPool, createPool, apply, Config } = mod

let failures = 0
function check(name, cond, detail) {
  if (cond) { console.log('  ✔ ' + name) }
  else { failures++; console.log('  ✘ ' + name + (detail ? '  → ' + String(detail).slice(0, 400) : '')) }
}

// ---------- mock mcp-for-unity server ----------
function makeMcpServer(instances, opts = {}) {
  // instances: [{id, name, hash}]; opts.failToolsList: true 时 tools/list 报错
  const sessions = new Map() // sessionId -> { active: string|null }
  const calls = []           // {sessionId, active, tool, args}
  let nextSession = 1
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    let msg
    try { msg = JSON.parse(body) } catch { res.writeHead(400); res.end('{}'); return }
    const sid = req.headers['mcp-session-id'] || null
    const method = msg.method
    if (method === 'initialize') {
      const mySid = 'sess-' + (nextSession++)
      sessions.set(mySid, { active: null })
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': mySid })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock-mcp-for-unity', version: '1.0' } } }))
      return
    }
    if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
    if (!sid || !sessions.has(sid)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'unknown session' } }))
      return
    }
    const st = sessions.get(sid)
    let result
    if (method === 'tools/list' && opts.failToolsList) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'tools/list boom' } }))
      return
    }
    if (method === 'tools/list') {
      result = {
        tools: [
          { name: 'manage_scene', description: '场景操作（get_hierarchy 等）', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
          { name: 'manage_gameobject', description: 'GameObject 操作', inputSchema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' } } } },
          { name: 'read_console', description: '读控制台', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
        ],
      }
    } else if (method === 'resources/read' && msg.params && msg.params.uri === 'mcpforunity://instances') {
      result = {
        contents: [{ type: 'text', text: JSON.stringify({ success: true, transport: 'http', instance_count: instances.length, instances }) }],
      }
    } else if (method === 'tools/call') {
      const name = msg.params.name
      const args = msg.params.arguments || {}
      if (name === 'set_active_instance') {
        const target = String(args.instance || '')
        const found = instances.find(i => i.id === target || i.hash.startsWith(target))
        if (!found) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'instance not found: ' + target + '; available: ' + instances.map(i => i.id).join(',') }) }] }
        } else {
          st.active = found.id
          result = { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Active instance set to ' + found.id, data: { instance: found.id, session_id: sid } }) }] }
        }
      } else {
        calls.push({ sessionId: sid, active: st.active, tool: name, args })
        if (!st.active) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no active instance; available: ' + instances.map(i => i.id).join(',') }) }] }
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, active: st.active, tool: name, args }) }] }
        }
      }
    } else {
      result = { content: [{ type: 'text', text: '{}' }] }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
  return { server, sessions, calls, listen: () => new Promise(r => server.listen(0, '127.0.0.1', r)), port: () => server.address().port, close: () => server.close() }
}

const s1 = makeMcpServer([
  { id: 'ProjA@aaaa1111', name: 'ProjA', hash: 'aaaa1111' },
  { id: 'ProjB@bbbb2222', name: 'ProjB', hash: 'bbbb2222' },
])
const s2 = makeMcpServer([
  { id: 'ProjC@cccc3333', name: 'ProjC', hash: 'cccc3333' },
])
await s1.listen()
await s2.listen()

// ---------- 池 ----------
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-pool-v2-'))
const dataFile = path.join(dir, 'state.json')
const ctx = { logger: { info() {}, warn() {}, error() {} } }
const pool = createPool(ctx, {
  services: [
    { id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' },
    { id: 'S2', name: '服务2', url: 'http://127.0.0.1:' + s2.port() + '/mcp' },
  ],
  dataFile,
  probeIntervalMs: 5000,
  probeTimeoutMs: 3000,
  scanPorts: [],
})
await pool.probe()

check('S1 在线', pool.serviceById('S1').alive === true)
check('S1 发现 2 实例', pool.serviceById('S1').instances.length === 2)
check('S2 在线', pool.serviceById('S2').alive === true)
check('S2 发现 1 实例', pool.serviceById('S2').instances.length === 1)

// ---------- 会话锁定目标实例 ----------
const bX = await pool.bind('sess-X') // 自动分配 → ProjA@aaaa1111 (S1 第一个，无占用)
check('sess-X 自动分配 → ProjA', bX.instanceId === 'ProjA@aaaa1111', JSON.stringify(bX))
check('sess-X 首次绑定返回工具列表', Array.isArray(bX.tools) && bX.toolsCount === 3 && bX.tools.some(t => t.name === 'manage_scene' && typeof t.inputSchema === 'object'), JSON.stringify(bX.tools).slice(0, 200))
const bY = await pool.bind('sess-Y') // 自动分配 → ProjB@bbbb2222 (ProjA 被占)
check('sess-Y 自动分配 → ProjB', bY.instanceId === 'ProjB@bbbb2222', JSON.stringify(bY))
check('sess-Y 首次绑定返回工具列表', Array.isArray(bY.tools) && bY.toolsCount === 3, JSON.stringify(bY.tools).slice(0, 200))
const bZ = await pool.bind('sess-Z') // 自动分配 → ProjC@cccc3333 (S2)
check('sess-Z 自动分配 → ProjC', bZ.instanceId === 'ProjC@cccc3333', JSON.stringify(bZ))
check('sess-Z 首次绑定返回工具列表（S2 服务）', Array.isArray(bZ.tools) && bZ.toolsCount === 3, JSON.stringify(bZ.tools).slice(0, 200))

let conflict = null
try { await pool.bind('sess-W', { instance: 'ProjA@aaaa1111' }) } catch (e) { conflict = e.message }
check('排他：sess-W 锁 ProjA 被拒', /锁定/.test(conflict || ''), conflict)

const vX = pool.view('sess-X')
const s1v = vX.services.find(s => s.id === 'S1')
check('view：ProjA 在本会话 active', s1v.instances.find(i => i.id === 'ProjA@aaaa1111').active === true)
check('view：ProjB 非本会话 active', s1v.instances.find(i => i.id === 'ProjB@bbbb2222').active === false)

// ---------- unity_mcp 代理：会话隔离 ----------
// sess-X 调 manage_scene → 自动 setActive(ProjA)
const r1 = await pool.proxyMcp('sess-X', 'manage_scene', { action: 'get_hierarchy' })
check('sess-X unity_mcp 成功且 active=ProjA', r1.success === true && r1.activeInstance === 'ProjA@aaaa1111', JSON.stringify(r1).slice(0, 300))

// sess-Y 调 manage_scene → 自动 setActive(ProjB)
const r2 = await pool.proxyMcp('sess-Y', 'manage_scene', { action: 'get_hierarchy' })
check('sess-Y unity_mcp 成功且 active=ProjB', r2.success === true && r2.activeInstance === 'ProjB@bbbb2222', JSON.stringify(r2).slice(0, 300))

// 同一服务上两个会话各自独立 session（per MCP-Session-Id 隔离）
// 注意：S1 的 sessions 里还含 discovery client 的会话（active=null），过滤掉
const activeOnS1 = [...s1.sessions.values()].filter(s => s.active).map(s => s.active)
check('S1 上两个独立 MCP 会话，active 互不干扰（A 与 B 并存）',
  activeOnS1.includes('ProjA@aaaa1111') && activeOnS1.includes('ProjB@bbbb2222') && activeOnS1.length === 2,
  JSON.stringify(activeOnS1))

// mock 记录的调用：sess-X 的会话 active=ProjA，sess-Y 的会话 active=ProjB
const callX = s1.calls.find(c => c.active === 'ProjA@aaaa1111')
const callY = s1.calls.find(c => c.active === 'ProjB@bbbb2222')
check('mock 收到两个路由到不同实例的调用', Boolean(callX) && Boolean(callY))
check('mock 调用透传工具名与参数', callX.tool === 'manage_scene' && callX.args.action === 'get_hierarchy')

// 再次调用复用同一 session（不重复 setActive 也无需新 session）
const callsBefore = s1.calls.length
await pool.proxyMcp('sess-X', 'manage_gameobject', { action: 'create', name: 'Cube' })
check('sess-X 第二次调用走同一 MCP 会话', s1.calls.length === callsBefore + 1)
check('sess-X 第二次调用 active 仍为 ProjA', s1.calls[s1.calls.length - 1].active === 'ProjA@aaaa1111')

// 未绑定会话调用 unity_mcp → 报错
let noBind = null
try { await pool.proxyMcp('sess-NO', 'manage_scene', {}) } catch (e) { noBind = e.message }
check('未锁定实例调用 unity_mcp 被拒', /unity_pool_bind/.test(noBind || ''), noBind)

// ---------- scan ----------
const s3 = makeMcpServer([{ id: 'ProjD@dddd4444', name: 'ProjD', hash: 'dddd4444' }])
await s3.listen()
pool.cfg.scanPorts = [s3.port()]
const found = await pool.scan()
check('scan 发现新服务并纳入池', found.length === 1 && pool.services.some(s => s.instances.some(i => i.id === 'ProjD@dddd4444')), JSON.stringify(found))

// ---------- 持久化 ----------
const pool2 = createPool(ctx, {
  services: [
    { id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' },
    { id: 'S2', name: '服务2', url: 'http://127.0.0.1:' + s2.port() + '/mcp' },
  ],
  dataFile,
  probeIntervalMs: 5000,
})
check('持久化：重启后 sess-X→ProjA、sess-Y→ProjB、sess-Z→ProjC',
  pool2.bindingOf('sess-X')?.instanceId === 'ProjA@aaaa1111' &&
  pool2.bindingOf('sess-Y')?.instanceId === 'ProjB@bbbb2222' &&
  pool2.bindingOf('sess-Z')?.instanceId === 'ProjC@cccc3333')

// 再次绑定（已有绑定）不重复拉取工具列表（force 绕过排他，验证仅首次拉取）
const bX2 = await pool.bind('sess-X', { instance: 'ProjB@bbbb2222', force: true })
check('sess-X 重复绑定（换实例）不返回工具列表', bX2.instanceId === 'ProjB@bbbb2222' && bX2.tools === undefined, JSON.stringify(bX2).slice(0, 200))
// 解绑后重新绑定 = 该会话的又一次首次绑定 → 重新拉取工具列表
await pool.unbind('sess-X')
const bX3 = await pool.bind('sess-X', { instance: 'ProjA@aaaa1111', force: true })
check('解绑后重新绑定再次返回工具列表', Array.isArray(bX3.tools) && bX3.toolsCount === 3 && bX3.instanceId === 'ProjA@aaaa1111', JSON.stringify(bX3.tools).slice(0, 200))

// ---------- apply() 装配 ----------
const routes = []
const registered = []
const sections = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  inject(services, fn) { fn({ effect: fakeCtx.effect, webServer: fakeCtx.webServer }) },
  tools: { register(def) { registered.push(def) } },
  systemPrompt: { section(s) { sections.push(s) } },
  webServer: { register(route) { routes.push(route); return () => {} } },
}
apply(fakeCtx, { services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' }], dataFile: dataFile + '.apply', probeIntervalMs: 5000 })
check('apply：注册 5 个工具', registered.length === 5 && ['unity_pool_status','unity_pool_scan','unity_pool_bind','unity_mcp','unity_pool_unbind'].every(n => registered.some(t => t.name === n)), registered.map(t => t.name).join(','))
check('apply：系统提示段含 unity_mcp', sections.some(s => s.name === 'unity-pool' && /unity_mcp/.test(s.text)))
check('apply：HTTP 路由注册', routes.length === 1 && routes[0].path === '/unity-pool/api')

// 工具执行：先 scan（apply 池探活+实例发现），再 bind + unity_mcp 链路
await registered.find(t => t.name === 'unity_pool_scan').execute({}, { agent: { id: 'sess-T' } })
const bindTool = registered.find(t => t.name === 'unity_pool_bind')
const bindRes = await bindTool.execute({ instance: 'ProjB@bbbb2222' }, { agent: { id: 'sess-T' } })
check('工具 unity_pool_bind 锁定 ProjB', bindRes.instanceId === 'ProjB@bbbb2222')
check('工具 unity_pool_bind 首次绑定附带工具列表', Array.isArray(bindRes.tools) && bindRes.toolsCount === 3 && bindRes.tools[0].name === 'manage_scene', JSON.stringify(bindRes.tools).slice(0, 200))

const mcpTool = registered.find(t => t.name === 'unity_mcp')
const mcpRes = await mcpTool.execute({ tool: 'manage_camera', params: { action: 'screenshot' } }, { agent: { id: 'sess-T' } })
check('工具 unity_mcp 代理成功 active=ProjB', mcpRes.success === true && mcpRes.activeInstance === 'ProjB@bbbb2222', JSON.stringify(mcpRes).slice(0, 300))

// HTTP API
const handler = routes[0].handler
function fakeRes() { const out = { status: 0, body: '' }; return { writeHead(s) { out.status = s; return this }, end(b) { out.body = String(b) }, _out: out } }
function fakeReq(method, url, body) {
  const handlers = {}
  const req = { method, url, headers: { host: '127.0.0.1:3080' }, on(ev, fn) { handlers[ev] = fn }, destroy() {} }
  req._emit = (ev, arg) => { if (handlers[ev]) handlers[ev](arg) }
  req._body = body
  return req
}
{
  const res = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/status?sessionId=sess-T'), res)
  const pb = JSON.parse(res._out.body)
  check('HTTP GET /status：带实例列表', pb.ok === true && Array.isArray(pb.value.services[0].instances) && pb.value.binding.instanceId === 'ProjB@bbbb2222')
}
{
  const res = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/config'), res)
  const pb = JSON.parse(res._out.body)
  check('HTTP GET /config：ok', pb.ok === true && typeof pb.value.connectHint === 'string')
}
{
  // 回环守卫
  const res = fakeRes()
  await handler({ method: 'GET', url: '/unity-pool/api/status', headers: { host: 'evil.example.com' }, on() {} }, res)
  check('HTTP 非回环被拒(403)', res._out.status === 403)
}

// ---------- tools/list 失败不阻断绑定 ----------
const s4 = makeMcpServer([{ id: 'ProjE@eeee5555', name: 'ProjE', hash: 'eeee5555' }], { failToolsList: true })
await s4.listen()
const pool4 = createPool(ctx, {
  services: [{ id: 'S4', name: '服务4', url: 'http://127.0.0.1:' + s4.port() + '/mcp' }],
  dataFile: dataFile + '.s4',
  probeIntervalMs: 5000,
})
await pool4.probe()
const b4 = await pool4.bind('sess-E')
check('tools/list 失败时绑定仍成功', b4.instanceId === 'ProjE@eeee5555', JSON.stringify(b4))
check('tools/list 失败附带 toolsError', Array.isArray(b4.tools) && b4.toolsCount === 0 && /tools\/list boom/.test(b4.toolsError || ''), JSON.stringify(b4.toolsError))
pool4.stop()

s1.close(); s2.close(); s3.close(); s4.close()
fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
fsp.rm(dataFile + '.apply', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s4', { force: true }).catch(() => {})
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)