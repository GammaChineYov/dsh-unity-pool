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
  // opts.toolDefs: 初始工具定义数组（可随后 addTool 动态增删）
  // opts.busyPattern: execute_code 探测模式数组（每调用消费一个；true=忙, false=空闲, 'error'=探测返回 isError；耗尽后默认空闲）
  // opts.failTool: 指定工具名在 tools/call 时返回 isError
  const sessions = new Map() // sessionId -> { active: string|null }
  const calls = []           // {sessionId, active, tool, args}（execute_code 探测不在此列）
  const probes = []          // execute_code 探测调用记录
  const busyPattern = Array.isArray(opts.busyPattern) ? [...opts.busyPattern] : []
  const tools = opts.toolDefs ? JSON.parse(JSON.stringify(opts.toolDefs)) : [
    { name: 'execute_code', description: '执行任意 C#（忙状态探测）', inputSchema: { type: 'object', properties: { action: { type: 'string' }, code: { type: 'string' } } } },
    { name: 'manage_scene', description: '场景操作（get_hierarchy 等）', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
    { name: 'manage_gameobject', description: 'GameObject 操作', inputSchema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' } } } },
    { name: 'read_console', description: '读控制台', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
  ]
  let listCalls = 0
  let nextSession = 1
  let offlineFlag = false      // setOffline(true)：模拟服务离线（所有请求 503）
  let failInstancesFlag = false // setFailInstances(true)：模拟实例发现失败（resources/read 报错）
  const server = http.createServer(async (req, res) => {
    if (offlineFlag) {
      // 模拟服务离线 = 连接拒绝（fetch 对 HTTP 状态码不抛错，只有网络错误才抛）；
      // 必须放在读 body 之前——probe 探活是 GET 请求，JSON.parse('') 会先走 400 分支
      req.socket.destroy()
      return
    }
    let body = ''
    for await (const c of req) body += c
    let msg
    try { msg = JSON.parse(body) } catch {
      // GET 探活（无 body）：返回空 JSON，fetch 视为服务在线
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
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
      listCalls++
      result = { tools: JSON.parse(JSON.stringify(tools)) }
    } else if (method === 'resources/read' && msg.params && msg.params.uri === 'mcpforunity://instances') {
      if (failInstancesFlag) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'instances boom' } }))
        return
      }
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
      } else if (name === 'execute_code') {
        // 忙状态探测：按 busyPattern 消费（true=忙, false=空闲, 'error'=探测报错），耗尽后默认空闲
        probes.push({ sessionId: sid, active: st.active })
        const b = busyPattern.length > 0 ? busyPattern.shift() : false
        if (b === 'error') {
          result = { isError: true, content: [{ type: 'text', text: 'execute_code boom' }] }
        } else {
          result = { content: [{ type: 'text', text: b ? 'c=1;u=1;p=2' : 'c=0;u=0;p=0' }] }
        }
      } else {
        calls.push({ sessionId: sid, active: st.active, tool: name, args })
        if (!st.active) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no active instance; available: ' + instances.map(i => i.id).join(',') }) }] }
        } else if (opts.failTool && name === opts.failTool) {
          result = { isError: true, content: [{ type: 'text', text: 'tool boom: ' + name }] }
        } else if (name === 'manage_camera' && args.action === 'screenshot') {
          // 模拟官方 manage_camera include_image=true 的 ImageContent 块
          result = {
            content: [
              { type: 'text', text: JSON.stringify({ success: true, data: { width: 640, height: 480 } }) },
              { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png' },
            ],
          }
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
  return {
    server, sessions, calls, probes, tools, listCalls: () => listCalls, probeCount: () => probes.length,
    addTool(name) { if (!tools.some(t => t.name === name)) tools.push({ name, description: 'dynamic tool', inputSchema: { type: 'object', properties: {} } }) },
    setOffline(v) { offlineFlag = v },
    setFailInstances(v) { failInstancesFlag = v },
    instancesRef: instances,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', r)), port: () => server.address().port, close: () => server.close(),
  }
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
check('sess-X 首次绑定返回工具列表', Array.isArray(bX.tools) && bX.toolsCount === 4 && bX.tools.some(t => t.name === 'manage_scene' && typeof t.inputSchema === 'object'), JSON.stringify(bX.tools).slice(0, 200))
const bY = await pool.bind('sess-Y') // 自动分配 → ProjB@bbbb2222 (ProjA 被占)
check('sess-Y 自动分配 → ProjB', bY.instanceId === 'ProjB@bbbb2222', JSON.stringify(bY))
check('sess-Y 首次绑定返回工具列表', Array.isArray(bY.tools) && bY.toolsCount === 4, JSON.stringify(bY.tools).slice(0, 200))
const bZ = await pool.bind('sess-Z') // 自动分配 → ProjC@cccc3333 (S2)
check('sess-Z 自动分配 → ProjC', bZ.instanceId === 'ProjC@cccc3333', JSON.stringify(bZ))
check('sess-Z 首次绑定返回工具列表（S2 服务）', Array.isArray(bZ.tools) && bZ.toolsCount === 4, JSON.stringify(bZ.tools).slice(0, 200))

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

// ---------- 轻量一致性：缓存外工具自动重拉 tools/list ----------
const listCallsBefore = s1.listCalls()
s1.addTool('gfind') // Unity 运行时新注册的自定义工具（首次绑定时不存在）
const rg = await pool.proxyMcp('sess-X', 'gfind', { pattern: 'Cube' })
check('缓存外工具自动重拉 tools/list 后调用成功', rg.success === true && rg.tool === 'gfind', JSON.stringify(rg).slice(0, 200))
check('缓存外工具触发重拉（listCalls +1）', s1.listCalls() === listCallsBefore + 1, 'listCalls=' + s1.listCalls())

const listCallsBefore2 = s1.listCalls()
await pool.proxyMcp('sess-X', 'manage_scene', { action: 'get_hierarchy' })
check('缓存内工具不触发重拉', s1.listCalls() === listCallsBefore2, 'listCalls=' + s1.listCalls())

// ---------- 图片内容块占位（manage_camera include_image=true） ----------
const shot = await pool.proxyMcp('sess-X', 'manage_camera', { action: 'screenshot' })
check('image 内容块以占位标记出现（不静默丢弃）', /\[image: image\/png/.test(shot.text), shot.text.slice(0, 200))

// ---------- 全量 53 工具逐一经代理（对照官方 tools/list，验证无缺失） ----------
const OFFICIAL_TOOLS = ['batch_execute','debug_request_context','execute_code','execute_custom_tool','execute_menu_item','find_gameobjects','find_in_file','generate_audio','generate_image','generate_model','import_model','import_model_file','manage_animation','manage_asset','manage_build','manage_camera','manage_components','manage_editor','manage_gameobject','manage_graphics','manage_material','manage_packages','manage_physics','manage_prefabs','manage_probuilder','manage_profiler','manage_scene','refresh_unity','apply_text_edits','create_script','delete_script','validate_script','manage_script','manage_script_capabilities','get_sha','manage_scriptable_object','manage_shader','manage_texture','manage_tools','manage_ui','manage_vfx','read_console','run_tests','get_test_job','script_apply_edits','set_active_instance','unity_docs','unity_reflect','gcall','gmouse','gfind','gset','project_search']
check('官方工具名清单 53 个', OFFICIAL_TOOLS.length === 53, String(OFFICIAL_TOOLS.length))
const s5 = makeMcpServer([{ id: 'ProjF@ffff6666', name: 'ProjF', hash: 'ffff6666' }], {
  toolDefs: OFFICIAL_TOOLS.map(n => ({ name: n, description: 'official tool ' + n, inputSchema: { type: 'object', properties: { action: { type: 'string' } } } })),
})
await s5.listen()
const pool5 = createPool(ctx, {
  services: [{ id: 'S5', name: '服务5', url: 'http://127.0.0.1:' + s5.port() + '/mcp' }],
  dataFile: dataFile + '.s5',
  probeIntervalMs: 5000,
})
await pool5.probe()
await pool5.bind('sess-F')
let missing = []
for (const name of OFFICIAL_TOOLS) {
  try {
    const r = await pool5.proxyMcp('sess-F', name, { action: 'ping' })
    if (!r.success) missing.push(name + ':' + JSON.stringify(r.text).slice(0, 60))
  } catch (e) { missing.push(name + ':throw:' + String(e.message || e).slice(0, 60)) }
}
check('53 个官方工具逐一经 unity_mcp 代理全部成功（无缺失）', missing.length === 0, missing.join('; ').slice(0, 400))
pool5.stop()

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
check('解绑后重新绑定再次返回工具列表', Array.isArray(bX3.tools) && bX3.toolsCount >= 3 && bX3.tools.some(t => t.name === 'manage_scene') && bX3.instanceId === 'ProjA@aaaa1111', JSON.stringify(bX3.tools).slice(0, 200))
// 跨服务切换（S1 → S2）：工具集可能不同 → 重新拉取工具列表
const s2ListCallsBefore = s2.listCalls()
const bX4 = await pool.bind('sess-X', { instance: 'ProjC@cccc3333', force: true })
check('跨服务重绑定返回工具列表', Array.isArray(bX4.tools) && bX4.toolsCount >= 3 && bX4.serviceId === 'S2' && bX4.tools.some(t => t.name === 'manage_scene'), JSON.stringify(bX4).slice(0, 200))
check('跨服务重绑定触发 S2 重拉（listCalls +1）', s2.listCalls() === s2ListCallsBefore + 1, 's2 listCalls=' + s2.listCalls())

// ---------- apply() 装配 ----------
const routes = []
const registered = []
const sections = []
const promptContexts = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  inject(services, fn) { fn({ effect: fakeCtx.effect, webServer: fakeCtx.webServer }) },
  tools: { register(def) { registered.push(def) } },
  systemPrompt: { section(s) { sections.push(s) }, context(c) { promptContexts.push(c) } },
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
check('工具 unity_pool_bind 首次绑定附带工具列表', Array.isArray(bindRes.tools) && bindRes.toolsCount >= 3 && bindRes.tools.some(t => t.name === 'manage_scene'), JSON.stringify(bindRes.tools).slice(0, 200))

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

// ---------- v0.3.9 归档解绑动态通知（systemPrompt.context） ----------
const archiveCtx = promptContexts.find(c => c.name === 'unity-pool:archive')
check('apply：注册归档通知 context（text 为函数）', Boolean(archiveCtx) && typeof archiveCtx.text === 'function')
check('通知 context：无归档记录时注入空串', archiveCtx.text({ agent: { id: 'sess-T', session: { id: 'sess-T' } } }) === '')
{
  const res2 = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/config'), res2)
  const pb2 = JSON.parse(res2._out.body)
  check('HTTP /api/config 返回 notifyUnbindOnArchive', pb2.ok === true && pb2.value.notifyUnbindOnArchive === true)
}
// 用 apply 池触发真实归档：sess-T 已绑定 ProjB（S1 → s1）；移除 ProjB 后 scan（内部 probe）→ 自动解绑
const idxProjB = s1.instancesRef.findIndex(i => i.id === 'ProjB@bbbb2222')
if (idxProjB >= 0) s1.instancesRef.splice(idxProjB, 1)
await registered.find(t => t.name === 'unity_pool_scan').execute({}, { agent: { id: 'sess-T' } })
{
  const res3 = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/status?sessionId=sess-T'), res3)
  const pb3 = JSON.parse(res3._out.body)
  check('归档后（apply 池）：sess-T 已自动解绑', pb3.ok === true && pb3.value.binding === null, JSON.stringify(pb3.value.binding))
}
const notifT = archiveCtx.text({ agent: { id: 'sess-T', session: { id: 'sess-T' } } })
check('通知 context：归档后向被解绑会话注入中文通知', notifT.includes('【Unity 服务池】') && notifT.includes('ProjB@bbbb2222') && notifT.includes('unity_pool_bind'), notifT.slice(0, 220))
check('通知 context：其他会话注入空串', archiveCtx.text({ agent: { id: 'other-session', session: { id: 'other-session' } } }) === '')
// 恢复 s1 实例数组（保持后续独立测试互不影响）
if (idxProjB >= 0 && !s1.instancesRef.some(i => i.id === 'ProjB@bbbb2222')) s1.instancesRef.push({ id: 'ProjB@bbbb2222', name: 'ProjB', hash: 'bbbb2222' })

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

// ---------- v0.3.7 忙时等待 + 失败附状态 ----------
// 忙时等待：2 次忙探测 + 1 次空闲 → 等待后调用成功
const s6 = makeMcpServer([{ id: 'ProjG@gggg7777', name: 'ProjG', hash: 'gggg7777' }], { busyPattern: [true, true, false] })
await s6.listen()
const pool6 = createPool(ctx, {
  services: [{ id: 'S6', name: '服务6', url: 'http://127.0.0.1:' + s6.port() + '/mcp' }],
  dataFile: dataFile + '.s6',
  probeIntervalMs: 5000,
  busyWaitEnabled: true,
  busyMaxWaitMs: 2000,
  busyWaitIntervalMs: 50,
})
await pool6.probe()
await pool6.bind('sess-G')
const t0 = Date.now()
const r6 = await pool6.proxyMcp('sess-G', 'manage_scene', { action: 'get_hierarchy' })
const elapsed6 = Date.now() - t0
check('忙时等待：探测 3 次（2 忙 + 1 空闲）', s6.probeCount() === 3, 'probes=' + s6.probeCount())
check('忙时等待：等待后调用成功', r6.success === true && r6.tool === 'manage_scene', JSON.stringify(r6).slice(0, 200))
check('忙时等待：总耗时 ≥ 2×interval（约 100ms）', elapsed6 >= 60, 'elapsed=' + elapsed6)
check('忙时等待：calls 里 execute_code 不计入业务调用', s6.calls.every(c => c.tool !== 'execute_code') && s6.calls.length === 1, 'calls=' + s6.calls.length)

// 失败附状态：目标工具失败（isError）→ 返回附带 editorState
const s7 = makeMcpServer([{ id: 'ProjH@hhhh8888', name: 'ProjH', hash: 'hhhh8888' }], { failTool: 'manage_scene' })
await s7.listen()
const pool7 = createPool(ctx, {
  services: [{ id: 'S7', name: '服务7', url: 'http://127.0.0.1:' + s7.port() + '/mcp' }],
  dataFile: dataFile + '.s7',
  probeIntervalMs: 5000,
  busyWaitIntervalMs: 20,
})
await pool7.probe()
await pool7.bind('sess-H')
const r7 = await pool7.proxyMcp('sess-H', 'manage_scene', { action: 'get_hierarchy' })
check('失败附状态：isError 且带 editorState', r7.isError === true && /^isCompiling=0,isUpdating=0,progressCount=0$/.test(r7.editorState || ''), JSON.stringify(r7).slice(0, 300))

// 关闭忙时等待：不探测直接调用；失败时补一次探测附状态
const s8 = makeMcpServer([{ id: 'ProjI@iiii9999', name: 'ProjI', hash: 'iiii9999' }], { failTool: 'manage_scene' })
await s8.listen()
const pool8 = createPool(ctx, {
  services: [{ id: 'S8', name: '服务8', url: 'http://127.0.0.1:' + s8.port() + '/mcp' }],
  dataFile: dataFile + '.s8',
  probeIntervalMs: 5000,
  busyWaitEnabled: false,
})
await pool8.probe()
await pool8.bind('sess-I')
const r8ok = await pool8.proxyMcp('sess-I', 'manage_gameobject', { action: 'create', name: 'Cube' })
check('关闭忙时等待：成功调用不探测', r8ok.success === true && s8.probeCount() === 0, 'probes=' + s8.probeCount())
const r8 = await pool8.proxyMcp('sess-I', 'manage_scene', { action: 'get_hierarchy' })
check('关闭忙时等待：失败后补探测附状态', s8.probeCount() === 1 && r8.isError === true && /^isCompiling=0,isUpdating=0,progressCount=0$/.test(r8.editorState || ''), JSON.stringify(r8).slice(0, 300))

// 探测失败保守等待：探测返回 isError → 视为可能忙等待后继续；第二次探测空闲 → 调用成功
const s9 = makeMcpServer([{ id: 'ProjJ@jjjj0000', name: 'ProjJ', hash: 'jjjj0000' }], { busyPattern: ['error', false] })
await s9.listen()
const pool9 = createPool(ctx, {
  services: [{ id: 'S9', name: '服务9', url: 'http://127.0.0.1:' + s9.port() + '/mcp' }],
  dataFile: dataFile + '.s9',
  probeIntervalMs: 5000,
  busyWaitEnabled: true,
  busyMaxWaitMs: 2000,
  busyWaitIntervalMs: 50,
})
await pool9.probe()
await pool9.bind('sess-J')
const t9 = Date.now()
const r9 = await pool9.proxyMcp('sess-J', 'manage_scene', { action: 'get_hierarchy' })
const elapsed9 = Date.now() - t9
check('探测失败保守等待：探测 2 次（1 错 + 1 空闲）', s9.probeCount() === 2, 'probes=' + s9.probeCount())
check('探测失败保守等待：等待后调用成功', r9.success === true, JSON.stringify(r9).slice(0, 200))
check('探测失败保守等待：总耗时 ≥ 1×interval', elapsed9 >= 30, 'elapsed=' + elapsed9)

pool6.stop(); pool7.stop(); pool8.stop(); pool9.stop()
s6.close(); s7.close(); s8.close(); s9.close()

// ---------- v0.3.8 归档自动解绑 ----------
// 场景1：实例从池中消失（Unity 关闭/下线）→ probe 后自动解绑该实例的会话
const instA = [
  { id: 'ProjK@kkkk1111', name: 'ProjK', hash: 'kkkk1111' },
  { id: 'ProjL@llll2222', name: 'ProjL', hash: 'llll2222' },
]
const sA = makeMcpServer(instA)
await sA.listen()
const poolA = createPool(ctx, {
  services: [{ id: 'SA', name: '服务A', url: 'http://127.0.0.1:' + sA.port() + '/mcp' }],
  dataFile: dataFile + '.sA',
  probeIntervalMs: 5000,
  unbindOfflineStreak: 2,
})
await poolA.probe()
await poolA.bind('sess-K', { instance: 'ProjK@kkkk1111' })
await poolA.bind('sess-L', { instance: 'ProjL@llll2222' })
check('归档前：sess-K 绑定 ProjK', poolA.bindingOf('sess-K')?.instanceId === 'ProjK@kkkk1111')
check('归档前：sess-L 绑定 ProjL', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
instA.splice(0, 1) // ProjK 消失（Unity 关闭）
await poolA.probe()
check('实例归档后：sess-K 被自动解绑', poolA.bindingOf('sess-K') === null, JSON.stringify(poolA.bindingOf('sess-K')))
check('实例归档后：sess-L 保持绑定', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
check('实例归档后：lastAutoUnbind 记录 instance-archived', poolA.lastAutoUnbind && poolA.lastAutoUnbind.items.some(i => i.sessionId === 'sess-K' && i.reason === 'instance-archived'), JSON.stringify(poolA.lastAutoUnbind))
const viewK = poolA.view('sess-K')
check('view：解绑后 binding 为 null', viewK.binding === null)
check('view：SA instancesValid=true 且仅剩 ProjL', viewK.services[0].instancesValid === true && viewK.services[0].instances.length === 1 && viewK.services[0].instances[0].id === 'ProjL@llll2222')
check('view：rules 含 autoUnbindOnArchive/unbindOfflineStreak', viewK.rules.autoUnbindOnArchive === true && viewK.rules.unbindOfflineStreak === 2)
check('HTTP /api/config 返回 autoUnbindOnArchive', typeof poolA.cfg.autoUnbindOnArchive === 'boolean' && poolA.cfg.unbindOfflineStreak === 2)

// 场景2：实例发现失败（instancesValid=false）→ 保留旧列表、不解绑（发现失败≠实例消失）
sA.setFailInstances(true)
await poolA.probe()
check('发现失败：instancesValid=false', poolA.serviceById('SA').instancesValid === false)
check('发现失败：保留上次列表（ProjL 仍在）', poolA.serviceById('SA').instances.some(i => i.id === 'ProjL@llll2222'))
check('发现失败：不解绑 sess-L', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
sA.setFailInstances(false)

// 场景3：服务离线——连续离线达到 unbindOfflineStreak(2) 才解绑（防瞬时抖动）
sA.setOffline(true)
await poolA.probe() // 第 1 次离线：streak=1，未达阈值
check('服务离线 1 次：不解绑（防抖动）', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222', JSON.stringify(poolA.bindingOf('sess-L')))
check('服务离线 1 次：offlineStreak=1', poolA.serviceById('SA').offlineStreak === 1)
await poolA.probe() // 第 2 次离线：streak=2，达阈值 → 解绑
check('服务离线 2 次：sess-L 被自动解绑', poolA.bindingOf('sess-L') === null)
check('服务离线 2 次：lastAutoUnbind 记录 service-offline', poolA.lastAutoUnbind && poolA.lastAutoUnbind.items.some(i => i.sessionId === 'sess-L' && i.reason === 'service-offline'), JSON.stringify(poolA.lastAutoUnbind))
sA.setOffline(false)
poolA.stop()

// 场景4：autoUnbindOnArchive=false → 不解绑
const instB = [{ id: 'ProjM@mmmm3333', name: 'ProjM', hash: 'mmmm3333' }]
const sB = makeMcpServer(instB)
await sB.listen()
const poolB = createPool(ctx, {
  services: [{ id: 'SB', name: '服务B', url: 'http://127.0.0.1:' + sB.port() + '/mcp' }],
  dataFile: dataFile + '.sB',
  probeIntervalMs: 5000,
  autoUnbindOnArchive: false,
  unbindOfflineStreak: 1,
})
await poolB.probe()
await poolB.bind('sess-M', { instance: 'ProjM@mmmm3333' })
instB.splice(0, 1) // 实例消失
await poolB.probe()
check('autoUnbindOnArchive=false：实例消失不解绑', poolB.bindingOf('sess-M')?.instanceId === 'ProjM@mmmm3333', JSON.stringify(poolB.bindingOf('sess-M')))
check('autoUnbindOnArchive=false：view.rules 反映 false', poolB.view('sess-M').rules.autoUnbindOnArchive === false)
poolB.stop()
sB.close()

// 场景5：服务从未在线过（aliveAt=0）→ 服务离线不因启动抖动解绑
const instC = [{ id: 'ProjN@nnnn4444', name: 'ProjN', hash: 'nnnn4444' }]
const sC = makeMcpServer(instC)
await sC.listen()
const poolC = createPool(ctx, {
  services: [{ id: 'SC', name: '服务C', url: 'http://127.0.0.1:' + sC.port() + '/mcp' }],
  dataFile: dataFile + '.sC',
  probeIntervalMs: 5000,
  unbindOfflineStreak: 1,
})
await poolC.probe()
await poolC.bind('sess-N', { instance: 'ProjN@nnnn4444' })
// 直接离线（从未离线过 → aliveAt>0，但本次是第一次离线 streak=1 达阈值）
// 先造一次"从未在线"：手动把 aliveAt 归零模拟
poolC.serviceById('SC').aliveAt = 0
sC.setOffline(true)
await poolC.probe()
check('服务从未在线过且离线：不解绑（避免启动抖动误伤）', poolC.bindingOf('sess-N')?.instanceId === 'ProjN@nnnn4444', JSON.stringify(poolC.bindingOf('sess-N')))
sC.setOffline(false)
poolC.stop()
sC.close()

// 场景6：service-removed（服务配置不存在）→ 自动解绑
const instD = [{ id: 'ProjO@oooo5555', name: 'ProjO', hash: 'oooo5555' }]
const sD = makeMcpServer(instD)
await sD.listen()
const poolD = createPool(ctx, {
  services: [{ id: 'SD', name: '服务D', url: 'http://127.0.0.1:' + sD.port() + '/mcp' }],
  dataFile: dataFile + '.sD',
  probeIntervalMs: 5000,
  unbindOfflineStreak: 1,
})
await poolD.probe()
await poolD.bind('sess-O', { instance: 'ProjO@oooo5555' })
poolD.services = poolD.services.filter(s => s.id !== 'SD') // 配置移除
await poolD.probe()
check('service-removed：绑定被自动解绑', poolD.bindingOf('sess-O') === null)
check('service-removed：lastAutoUnbind 记录', poolD.lastAutoUnbind && poolD.lastAutoUnbind.items.some(i => i.sessionId === 'sess-O' && i.reason === 'service-removed'), JSON.stringify(poolD.lastAutoUnbind))
poolD.stop()
sD.close()

// 场景7：自动解绑持久化——重建池后不残留已归档绑定
const poolA2 = createPool(ctx, {
  services: [{ id: 'SA', name: '服务A', url: 'http://127.0.0.1:' + sA.port() + '/mcp' }],
  dataFile: dataFile + '.sA',
  probeIntervalMs: 5000,
})
await poolA2.probe()
check('持久化：重建后 sess-K/sess-L 均未残留', poolA2.bindingOf('sess-K') === null && poolA2.bindingOf('sess-L') === null)
poolA2.stop()
sA.close()

s1.close(); s2.close(); s3.close(); s4.close(); s5.close()
fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
fsp.rm(dataFile + '.apply', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s4', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s5', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s6', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s7', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s8', { force: true }).catch(() => {})
fsp.rm(dataFile + '.s9', { force: true }).catch(() => {})
fsp.rm(dataFile + '.sA', { force: true }).catch(() => {})
fsp.rm(dataFile + '.sB', { force: true }).catch(() => {})
fsp.rm(dataFile + '.sC', { force: true }).catch(() => {})
fsp.rm(dataFile + '.sD', { force: true }).catch(() => {})
console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)