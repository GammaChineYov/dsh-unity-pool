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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
    { name: 'manage_scene', description: '场景操作（get_hierarchy 等）', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
    { name: 'manage_gameobject', description: 'GameObject 操作', inputSchema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' }, filter: { type: 'object', properties: { name: { type: 'string' } } } } } },
    { name: 'read_console', description: '读控制台', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
  ]
  let listCalls = 0
  let nextSession = 1
  let offlineFlag = false      // setOffline(true)：模拟服务离线（所有请求 503）
  let failInstancesFlag = false // setFailInstances(true)：模拟实例发现失败（resources/read 报错）
  let failToolsListFlag = opts.failToolsList === true // setFailToolsList(v)：运行时切换 tools/list 失败
  // 选中项返回（真实场景：场景内 GameObject 的 InstanceID 为负数——插件解析必须支持负号）
  let selectionResult = 'count=1\n- Cube | type=GameObject | id=-101 | path=Root/Cube' // setSelectionResult(v)：切换选中项
  let snapshotFile = null // setSnapshotFile(v)：ui_snapshot 返回 absolutePath → 走快照地图模式
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
    if (method === 'tools/list' && failToolsListFlag) {
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
    } else if (method === 'resources/read' && msg.params && /^mcpforunity:\/\/scene\/gameobject\/-?\d+\/components$/.test(msg.params.uri)) {
      // 选中物体序列化字段（v0.4.0 状态携带）；场景 GameObject 的 InstanceID 为负数
      result = {
        contents: [{ type: 'text', text: JSON.stringify({
          success: true, message: null, error: null,
          data: {
            gameObjectID: 101, gameObjectName: 'Cube',
            components: [
              { typeName: 'UnityEngine.Transform', instanceID: 102, properties: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, localScale: { x: 1, y: 1, z: 1 }, m_ConstrainProportionsScale: false, m_Children: [], m_Father: null } },
              { typeName: 'UnityEngine.BoxCollider', instanceID: 103, properties: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, isTrigger: false, m_Material: null } },
            ],
          },
        }) }],
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
        probes.push({ sessionId: sid, active: st.active })
        const code = String(args.code || '')
        // v0.4.0 状态携带：Selection 读取代码 → 回显选中项（id 为负数=场景 GameObject）
        if (code.includes('UnityEditor.Selection.objects')) {
          result = { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Code executed successfully.', data: { result: selectionResult, compiler: 'roslyn' } }) }] }
        } else if (code.includes('ConsoleWindow')) {
          result = { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Code executed successfully.', data: { result: 'selectedRow=3\nACTIVE_TEXT:\n[传输>>] mock console selected entry (at Assets/Test.cs:10)', compiler: 'roslyn' } }) }] }
        } else {
          // 忙状态探测：按 busyPattern 消费（true=忙, false=空闲, 'error'=探测报错），耗尽后默认空闲
          const b = busyPattern.length > 0 ? busyPattern.shift() : false
          if (b === 'error') {
            result = { isError: true, content: [{ type: 'text', text: 'execute_code boom' }] }
          } else {
            result = { content: [{ type: 'text', text: b ? 'c=1;u=1;p=2' : 'c=0;u=0;p=0' }] }
          }
        }
      } else {
        calls.push({ sessionId: sid, active: st.active, tool: name, args })
        if (!st.active) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no active instance; available: ' + instances.map(i => i.id).join(',') }) }] }
        } else if (opts.failTool && name === opts.failTool) {
          result = { isError: true, content: [{ type: 'text', text: 'tool boom: ' + name }] }
        } else if (name === 'ui_snapshot') {
          // v0.4.0 状态携带：ui-snapshot 快照（自定义工具，LBTools 风格返回）
          const summary = { nodeCount: 6, refCount: 2, backrefCount: 2, rootCount: 1, cached: false, libraryPath: 'Library/LBTools/UISnapshots/mock.json', markdownPath: 'Library/LBTools/UISnapshots/mock.md' }
          if (snapshotFile) summary.absolutePath = snapshotFile // 地图模式：指向可解析的 Library JSON
          result = {
            content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'UI snapshot - 6 nodes, 2 refs', error: null, data: { summary, roots: [{ instanceID: 101 }], text: '# UI Snapshot: 6 nodes, 2 refs, 2 backrefs\r\nRoots: [101]\r\nTree:\r\n- [101] Cube (Transform,BoxCollider) R:2 B:2 (inactive) rect:[0,0,10,10]\r\n  - [102] Template (Image,ScrollRect) R:2 B:1 (inactive) rect:[0,0,0,0]\r\n    - [104] Viewport (Image,Mask) R:1 B:1 (inactive) rect:[0,0,0,0]\r\n      - [105] Content R:0 B:1 (inactive) rect:[0,0,0,0]\r\n  - [106] Template (Image,ScrollRect) R:2 B:1 (inactive) rect:[0,0,0,0]\r\n    - [107] Viewport (Image,Mask) R:1 B:1 (inactive) rect:[0,0,0,0]\r\n      - [108] Content R:0 B:1 (inactive) rect:[0,0,0,0]\r\n  - [110] label_0_0 R:0 B:0 (inactive) rect:[0,0,0,0]\r\n    - [111] Icon (Image) R:0 B:0 (inactive) rect:[0,0,0,0]\r\n    - [112] Text (Text) R:1 B:0 (inactive) rect:[0,0,0,0]\r\n  - [113] label_0_1 R:0 B:0 (inactive) rect:[0,0,0,0]\r\n    - [114] Icon (Image) R:0 B:0 (inactive) rect:[0,0,0,0]\r\n    - [115] Text (Text) R:1 B:0 (inactive) rect:[0,0,0,0]\r\nRefs (outgoing):\r\n[101] Cube.Comp.fieldA -> [103] TargetA (Material)\r\n[101] Cube.Comp.fieldB -> [109] TargetB\r\n[101] Cube.Comp.fieldC -> [111] TargetC\r\n[101] Cube.Comp.fieldC -> [111] TargetC\r\nBackrefs (incoming, 快照内):\r\n[102] <- [101] Cube.Comp.fieldA\r\n[102] <- [104] Viewport.Image.m_Sprite' } }) }],
          }
        } else if (name === 'read_console' && args.action === 'get') {
          // v0.4.0 状态携带：Console 全文
          result = {
            content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Retrieved 3 log entries.', data: ['mock console line 1', 'mock console line 2', 'mock console line 3'] }) }],
          }
        } else if (name === 'manage_camera' && args.action === 'screenshot') {
          // 模拟官方 manage_camera include_image=true 的 ImageContent 块
          result = {
            content: [
              { type: 'text', text: JSON.stringify({ success: true, data: { width: 640, height: 480, imageWidth: 320, imageHeight: 180 } }) },
              { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png' },
            ],
          }
        } else if (!tools.some(t => t.name === name)) {
          // 模拟官方服务端：工具不在 tools/list 里 → Unknown tool
          result = { isError: true, content: [{ type: 'text', text: "Unknown tool: '" + name + "'" }] }
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
    setFailToolsList(v) { failToolsListFlag = v },
    setSelectionResult(v) { selectionResult = v },
    setSnapshotFile(v) { snapshotFile = v },
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

// 再次绑定（同服务换实例）：每次绑定都返回最新工具列表（同服务也重拉，保持动态工具集合新鲜）
const s1ListCallsRepeat = s1.listCalls()
const bX2 = await pool.bind('sess-X', { instance: 'ProjB@bbbb2222', force: true })
check('sess-X 重复绑定（换实例）仍返回工具列表', bX2.instanceId === 'ProjB@bbbb2222' && Array.isArray(bX2.tools) && bX2.toolsCount >= 4 && bX2.tools.some(t => t.name === 'manage_scene'), JSON.stringify(bX2).slice(0, 200))
check('sess-X 重复绑定触发重拉（listCalls +1）', s1.listCalls() === s1ListCallsRepeat + 1, 'listCalls=' + s1.listCalls())
// 解绑后重新绑定 → 又一次完整拉取工具列表
await pool.unbind('sess-X')
const bX3 = await pool.bind('sess-X', { instance: 'ProjA@aaaa1111', force: true })
check('解绑后重新绑定再次返回工具列表', Array.isArray(bX3.tools) && bX3.toolsCount >= 3 && bX3.tools.some(t => t.name === 'manage_scene') && bX3.instanceId === 'ProjA@aaaa1111', JSON.stringify(bX3.tools).slice(0, 200))
// 跨服务切换（S1 → S2）：工具集可能不同 → 重新拉取工具列表
const s2ListCallsBefore = s2.listCalls()
const bX4 = await pool.bind('sess-X', { instance: 'ProjC@cccc3333', force: true })
check('跨服务重绑定返回工具列表', Array.isArray(bX4.tools) && bX4.toolsCount >= 3 && bX4.serviceId === 'S2' && bX4.tools.some(t => t.name === 'manage_scene'), JSON.stringify(bX4).slice(0, 200))
check('跨服务重绑定触发 S2 重拉（listCalls +1）', s2.listCalls() === s2ListCallsBefore + 1, 's2 listCalls=' + s2.listCalls())

// view：已绑定会话带工具名速查（tools: {count, names}）；未绑定为 null
const vTools = pool.view('sess-X').tools
check('view：已绑定会话带工具名速查', vTools && vTools.serviceId === 'S2' && vTools.count >= 4 && vTools.names.includes('manage_scene'), JSON.stringify(vTools))
check('view：未绑定会话 tools 为 null', pool.view('sess-NO').tools === null, JSON.stringify(pool.view('sess-NO').tools))

// ---------- Unknown tool 错误附可用工具名列表 + 相似工具提示 ----------
const s1u = makeMcpServer([{ id: 'ProjU@uuuu9999', name: 'ProjU', hash: 'uuuu9999' }])
await s1u.listen()
const poolU = createPool(ctx, {
  services: [{ id: 'SU', name: '服务U', url: 'http://127.0.0.1:' + s1u.port() + '/mcp' }],
  dataFile: dataFile + '.u',
  probeIntervalMs: 5000,
})
await poolU.probe()
await poolU.bind('sess-U')
const unk = await poolU.proxyMcp('sess-U', 'read_editor_state', {})
check('未知工具：错误附可用工具名列表', unk.success === false && /Unknown tool: 'read_editor_state'/.test(unk.text) && /可用工具（4 个）：execute_code, manage_scene, manage_gameobject, read_console/.test(unk.text), unk.text.slice(0, 300))
check('未知工具：附编辑器状态工具指引（unity_pool_state）', /unity_pool_state/.test(unk.text), unk.text.slice(0, 300))
const unk2 = await poolU.proxyMcp('sess-U', 'manage_scen', {})
check('未知工具：相似工具提示命中（manage_scen → manage_scene）', unk2.success === false && /相似工具：manage_scene/.test(unk2.text), unk2.text.slice(0, 300))
poolU.stop()

// ---------- apply() 装配 ----------
const routes = []
const registered = []
const disposed = [] // v0.5.0：记录 tools.register 返回的 disposer 被调用（模拟 DSH 注销）
const sections = []
const promptContexts = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  inject(services, fn) { fn({ effect: fakeCtx.effect, webServer: fakeCtx.webServer }) },
  tools: { register(def) { registered.push(def); return () => { disposed.push(def.name) } } },
  systemPrompt: { section(s) { sections.push(s) }, context(c) { promptContexts.push(c) } },
  webServer: { register(route) { routes.push(route); return () => {} } },
}
apply(fakeCtx, { services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' }], dataFile: dataFile + '.apply', probeIntervalMs: 5000 })
check('apply：注册 6 个工具', registered.length === 6 && ['unity_pool_status','unity_pool_scan','unity_pool_bind','unity_mcp','unity_pool_unbind','unity_pool_state'].every(n => registered.some(t => t.name === n)), registered.map(t => t.name).join(','))
check('apply：系统提示段含 unity_mcp', sections.some(s => s.name === 'unity-pool' && /unity_mcp/.test(s.text)))
check('apply：HTTP 路由注册', routes.length === 1 && routes[0].path === '/unity-pool/api')

// 工具执行：先 scan（apply 池探活+实例发现），再 bind + unity_mcp 链路
await registered.find(t => t.name === 'unity_pool_scan').execute({}, { agent: { id: 'sess-T' } })
const bindTool = registered.find(t => t.name === 'unity_pool_bind')
const bindRes = await bindTool.execute({ instance: 'ProjB@bbbb2222' }, { agent: { id: 'sess-T' } })
check('工具 unity_pool_bind 锁定 ProjB', bindRes.instanceId === 'ProjB@bbbb2222')
check('工具 unity_pool_bind 绑定附带工具列表', Array.isArray(bindRes.tools) && bindRes.toolsCount >= 3 && bindRes.tools.some(t => t.name === 'manage_scene'), JSON.stringify(bindRes.tools).slice(0, 200))

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

// ---------- v0.5.0 原生工具注册（umcp_*，Claude 式工具清单） ----------
// apply 池的 bind（上面）已触发 syncNativeTools → fakeCtx.tools.register 收到 umcp_* 工具
const umcpScene = registered.find(t => t.name === 'umcp_manage_scene')
check('v0.5.0：绑定后注册原生工具 umcp_manage_scene', Boolean(umcpScene), registered.map(t => t.name).join(','))
check('v0.5.0：umcp 描述含服务与原工具名', Boolean(umcpScene) && /S1/.test(umcpScene.description) && /manage_scene/.test(umcpScene.description), umcpScene && umcpScene.description)
check('v0.5.0：compact schema 基础标量保留类型', Boolean(umcpScene) && umcpScene.parameters.properties && umcpScene.parameters.properties.action && umcpScene.parameters.properties.action.type === 'string' && typeof umcpScene.parameters.properties.action.description === 'string', JSON.stringify(umcpScene && umcpScene.parameters))
{
  // compact：复杂嵌套参数降级（不展开嵌套子 schema，参数由 Unity 侧裁决）
  const umcpGo = registered.find(t => t.name === 'umcp_manage_gameobject')
  check('v0.5.0：compact schema 复杂参数不展开嵌套', Boolean(umcpGo) && umcpGo.parameters.properties.filter && umcpGo.parameters.properties.filter.properties === undefined && typeof umcpGo.parameters.properties.filter.description === 'string', JSON.stringify(umcpGo && umcpGo.parameters.properties.filter))
}
// 未绑定会话调 umcp_* → proxyMcp 报「未锁定目标实例」
let unboundErr = null
try { await umcpScene.execute({ action: 'get_hierarchy' }, { agent: { id: 'sess-UNBOUND' } }) } catch (e) { unboundErr = e.message }
check('v0.5.0：未绑定会话调 umcp_* 报未锁定', /未锁定目标实例/.test(unboundErr || ''), unboundErr)
// 已绑定会话（sess-T 绑 ProjB）调 umcp_manage_scene → 成功且 active=ProjB
const umcpRes = await umcpScene.execute({ action: 'get_hierarchy' }, { agent: { id: 'sess-T' } })
check('v0.5.0：已绑定会话调 umcp_manage_scene 成功 active=ProjB', umcpRes.success === true && umcpRes.activeInstance === 'ProjB@bbbb2222', JSON.stringify(umcpRes).slice(0, 200))
// view.nativeTools 摘要
{
  const res4 = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/status?sessionId=sess-T'), res4)
  const pb4 = JSON.parse(res4._out.body)
  check('v0.5.0：view.nativeTools 含 S1 摘要', Array.isArray(pb4.value.nativeTools) && pb4.value.nativeTools.some(n => n.serviceId === 'S1' && n.count >= 4), JSON.stringify(pb4.value.nativeTools))
  check('v0.5.0：view.rules 暴露 nativeToolsEnabled/Schema', pb4.value.rules.nativeToolsEnabled === true && pb4.value.rules.nativeToolSchema === 'compact', JSON.stringify(pb4.value.rules))
}
// full schema（nativeToolSchema: full）
{
  const regF = []
  const ctxF = { logger: { info() {}, warn() {}, error() {} }, tools: { register(def) { regF.push(def); return () => {} } } }
  const poolF = createPool(ctxF, {
    services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' }],
    dataFile: dataFile + '.full',
    probeIntervalMs: 5000,
    nativeToolSchema: 'full',
  })
  await poolF.probe()
  await poolF.bind('sess-F')
  const umcpFull = regF.find(t => t.name === 'umcp_manage_scene')
  check('v0.5.0：full schema 参数带完整类型', Boolean(umcpFull) && umcpFull.parameters.properties && umcpFull.parameters.properties.action && umcpFull.parameters.properties.action.type === 'string', JSON.stringify(umcpFull && umcpFull.parameters))
  check('v0.5.0：full schema 必填进顶层 required 数组', Boolean(umcpFull) && Array.isArray(umcpFull.parameters.required) && umcpFull.parameters.required.includes('action'), JSON.stringify(umcpFull && umcpFull.parameters.required))
  {
    // full：复杂嵌套参数展开为 object 子 schema
    const umcpFullGo = regF.find(t => t.name === 'umcp_manage_gameobject')
    check('v0.5.0：full schema 复杂参数展开 object', Boolean(umcpFullGo) && umcpFullGo.parameters.properties.filter && umcpFullGo.parameters.properties.filter.type === 'object' && umcpFullGo.parameters.properties.filter.properties.name.type === 'string', JSON.stringify(umcpFullGo && umcpFullGo.parameters.properties.filter))
  }
  const beforeDispose = regF.length
  poolF.stop()
  check('v0.5.0：stop() 注销全部原生工具（disposer 均被调用）', poolF.nativeDisposers.size === 0 && poolF.nativeToolOwner.size === 0, 'regs=' + poolF.nativeDisposers.size + ' owner=' + poolF.nativeToolOwner.size)
}
// 同名刷新 + 跨服务同名接管（S1/S2 都有 manage_scene；S2 绑定后接管 umcp_manage_scene）
{
  const reg2 = []
  const dis2 = []
  const ctx2 = { logger: { info() {}, warn() {}, error() {} }, tools: { register(def) { reg2.push(def); return () => { dis2.push(def.name) } } } }
  const pool2b = createPool(ctx2, {
    services: [
      { id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' },
      { id: 'S2', name: '服务2', url: 'http://127.0.0.1:' + s2.port() + '/mcp' },
    ],
    dataFile: dataFile + '.owner',
    probeIntervalMs: 5000,
  })
  await pool2b.probe()
  await pool2b.bind('sess-A1', { instance: 'ProjA@aaaa1111' }) // S1 → 注册 umcp_*
  const firstSceneRegs = reg2.filter(t => t.name === 'umcp_manage_scene').length
  check('v0.5.0：绑 S1 注册 umcp_manage_scene', firstSceneRegs === 1, 'regs=' + firstSceneRegs)
  await pool2b.bind('sess-A2', { instance: 'ProjC@cccc3333' }) // S2 → 接管同名
  const secondSceneRegs = reg2.filter(t => t.name === 'umcp_manage_scene').length
  check('v0.5.0：绑 S2 后 umcp_manage_scene 重新注册（接管）', secondSceneRegs === 2, 'regs=' + secondSceneRegs)
  check('v0.5.0：接管时旧注册被注销（disposer 调用）', dis2.includes('umcp_manage_scene'), dis2.join(','))
  check('v0.5.0：nativeToolOwner 指向 S2', pool2b.nativeToolOwner.get('umcp_manage_scene') === 'S2', pool2b.nativeToolOwner.get('umcp_manage_scene'))
  // 解绑收敛（v0.5.0）：服务不再被任何会话绑定 → 注销该服务 umcp_*；仍有会话绑定 → 保留
  pool2b.unbind('sess-A1')   // S1 无其他会话 → 注销 S1
  check('v0.5.0：解绑后无会话绑定该服务 → 注销原生工具', pool2b.nativeDisposers.size === 1 && !pool2b.nativeDisposers.has('S1'), 'size=' + pool2b.nativeDisposers.size + ' S1=' + pool2b.nativeDisposers.has('S1'))
  pool2b.unbind('sess-A2')   // S2 无其他会话 → 注销 S2
  check('v0.5.0：全部解绑后注册清空', pool2b.nativeDisposers.size === 0 && pool2b.nativeToolOwner.size === 0, 'size=' + pool2b.nativeDisposers.size)
  pool2b.stop()
  check('v0.5.0：stop 后全量注销（幂等）', pool2b.nativeDisposers.size === 0 && pool2b.nativeToolOwner.size === 0)
}
// 同服务多会话：一个解绑不注销（另一会话仍绑定）
{
  const reg3 = []
  const ctx3 = { logger: { info() {}, warn() {}, error() {} }, tools: { register(def) { reg3.push(def); return () => {} } } }
  const pool3 = createPool(ctx3, {
    services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' }],
    dataFile: dataFile + '.samed',
    probeIntervalMs: 5000,
  })
  await pool3.probe()
  await pool3.bind('sess-U1', { instance: 'ProjA@aaaa1111' })
  await pool3.bind('sess-U2', { instance: 'ProjB@bbbb2222' }) // 同服务第二会话
  check('v0.5.0：同服务两会话各自注册正常', reg3.filter(t => t.name === 'umcp_manage_scene').length === 2, 'regs=' + reg3.length)
  pool3.unbind('sess-U1')
  check('v0.5.0：同服务另一会话仍绑定 → 不注销', pool3.nativeDisposers.size === 1 && pool3.nativeDisposers.has('S1'), 'size=' + pool3.nativeDisposers.size)
  pool3.unbind('sess-U2')
  check('v0.5.0：同服务最后一个会话解绑 → 注销', pool3.nativeDisposers.size === 0, 'size=' + pool3.nativeDisposers.size)
  pool3.stop()
}
// 禁用 nativeToolsEnabled 时不注册
{
  const regD = []
  const ctxD = { logger: { info() {}, warn() {}, error() {} }, tools: { register(def) { regD.push(def); return () => {} } } }
  const poolD = createPool(ctxD, {
    services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + s1.port() + '/mcp' }],
    dataFile: dataFile + '.dis',
    probeIntervalMs: 5000,
    nativeToolsEnabled: false,
  })
  await poolD.probe()
  await poolD.bind('sess-D')
  check('v0.5.0：nativeToolsEnabled=false 不注册 umcp_*', regD.filter(t => t.name.startsWith('umcp_')).length === 0, regD.map(t => t.name).join(','))
  poolD.stop()
}

// ---------- 归档语义（v0.5.1 设计修正）：实例掉线/域重载对已绑定会话无感，仅「会话归档」才解绑 ----------
// 归档 = 会话被归档（DSH session/disposed）；实例掉线不做 probe 主动解绑、也不注入通知。
// 这里用 apply 池验证：实例从列表消失 + 探测 → 绑定保持；调用时实例不可用 → 返回失败原因（不抛出）。
{
  const res2 = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/config'), res2)
  const pb2 = JSON.parse(res2._out.body)
  check('HTTP /api/config 返回 callReconnectTimeoutMs', pb2.ok === true && typeof pb2.value.callReconnectTimeoutMs === 'number')
  check('HTTP /api/config 不再暴露 notifyUnbindOnArchive（不注入通知）', pb2.ok === true && pb2.value.notifyUnbindOnArchive === undefined)
}
// 实例掉线：移除 ProjB（模拟 Unity 域重载/关闭窗口）→ probe(scan) → 绑定保持（实例掉线对运行时会话无感）
const idxProjB = s1.instancesRef.findIndex(i => i.id === 'ProjB@bbbb2222')
if (idxProjB >= 0) s1.instancesRef.splice(idxProjB, 1)
await registered.find(t => t.name === 'unity_pool_scan').execute({}, { agent: { id: 'sess-T' } })
{
  const res3 = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/status?sessionId=sess-T'), res3)
  const pb3 = JSON.parse(res3._out.body)
  check('实例掉线 + 探测：绑定保持（probe 不主动解绑）', pb3.ok === true && pb3.value.binding && pb3.value.binding.instanceId === 'ProjB@bbbb2222', JSON.stringify(pb3.value.binding))
}
// （调用时实例离线 → 返回失败原因的覆盖见下面 poolR 场景——apply 池 activeInstance 已缓存且 mock 不模拟 WebSocket 断连，此处不重复验证）
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

// ---------- tools/list 失败回退缓存（重复绑定仍带上次成功的列表） ----------
const s10 = makeMcpServer([{ id: 'ProjK@kkkk0001', name: 'ProjK', hash: 'kkkk0001' }])
await s10.listen()
const pool10 = createPool(ctx, {
  services: [{ id: 'S10', name: '服务10', url: 'http://127.0.0.1:' + s10.port() + '/mcp' }],
  dataFile: dataFile + '.s10',
  probeIntervalMs: 5000,
})
await pool10.probe()
const b10a = await pool10.bind('sess-K')
check('首次绑定成功拉取工具列表', Array.isArray(b10a.tools) && b10a.toolsCount === 4, JSON.stringify(b10a.tools).slice(0, 100))
s10.setFailToolsList(true)
const b10b = await pool10.bind('sess-K', { force: true })
check('tools/list 失败回退缓存列表 + toolsError', Array.isArray(b10b.tools) && b10b.toolsCount === 4 && /tools\/list boom/.test(b10b.toolsError || ''), JSON.stringify(b10b).slice(0, 250))
pool10.stop()

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

// ---------- 归档语义（v0.5.1）：实例掉线/域重载对绑定会话无感，仅「会话归档」才解绑 ----------
// 实例掉线/服务离线 → probe 不主动解绑（绑定保持）；真正的实例离线只在调用时由 proxyMcp
// 自动重连并在超时后返回失败原因；唯一自动解绑入口 = 会话归档（session/disposed → _onSessionDisposed）。
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
})
await poolA.probe()
await poolA.bind('sess-K', { instance: 'ProjK@kkkk1111' })
await poolA.bind('sess-L', { instance: 'ProjL@llll2222' })
check('绑定：sess-K → ProjK、sess-L → ProjL', poolA.bindingOf('sess-K')?.instanceId === 'ProjK@kkkk1111' && poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
// 实例掉线：移除 ProjK → probe → 不解绑（实例掉线对运行时会话无感）
instA.splice(0, 1)
await poolA.probe()
check('实例掉线 + 探测：sess-K 保持绑定（不主动解绑）', poolA.bindingOf('sess-K')?.instanceId === 'ProjK@kkkk1111', JSON.stringify(poolA.bindingOf('sess-K')))
check('实例掉线：view 显示实例消失（列表仅剩 ProjL）', poolA.view('sess-K').services[0].instances.length === 1 && poolA.view('sess-K').services[0].instances[0].id === 'ProjL@llll2222')
// 再移除 ProjL → probe → 仍不解绑
instA.splice(0, 1)
await poolA.probe()
check('实例全部掉线 + 探测：sess-L 仍绑定（不主动解绑）', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222', JSON.stringify(poolA.bindingOf('sess-L')))
// 服务离线 → probe → 仍不解绑（服务离线对已绑定会话无感）
sA.setOffline(true)
await poolA.probe()
check('服务离线 + 探测：sess-L 仍绑定（不主动解绑）', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222', JSON.stringify(poolA.bindingOf('sess-L')))
sA.setOffline(false)
// 发现失败（instancesValid=false）：保留上次列表，仍不解绑
sA.setFailInstances(true)
await poolA.probe()
check('发现失败：instancesValid=false', poolA.serviceById('SA').instancesValid === false)
check('发现失败：不误解绑', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
sA.setFailInstances(false)
// 会话归档（session/disposed）→ 自动解绑该会话锁定的实例（唯一自动解绑入口）
poolA._onSessionDisposed({ id: 'sess-K' })
check('会话归档：sess-K 被自动解绑', poolA.bindingOf('sess-K') === null, JSON.stringify(poolA.bindingOf('sess-K')))
check('会话归档：sess-L 不受影响', poolA.bindingOf('sess-L')?.instanceId === 'ProjL@llll2222')
check('view.rules 反映 autoUnbindOnArchive + callReconnectTimeoutMs', (() => { const rv = poolA.view('sess-L').rules; return rv.autoUnbindOnArchive === true && typeof rv.callReconnectTimeoutMs === 'number' })())
poolA.stop()
sA.close()

// autoUnbindOnArchive=false：会话归档不解绑
const instB = [{ id: 'ProjM@mmmm3333', name: 'ProjM', hash: 'mmmm3333' }]
const sB = makeMcpServer(instB)
await sB.listen()
const poolB = createPool(ctx, {
  services: [{ id: 'SB', name: '服务B', url: 'http://127.0.0.1:' + sB.port() + '/mcp' }],
  dataFile: dataFile + '.sB',
  probeIntervalMs: 5000,
  autoUnbindOnArchive: false,
})
await poolB.probe()
await poolB.bind('sess-M', { instance: 'ProjM@mmmm3333' })
poolB._onSessionDisposed({ id: 'sess-M' })
check('autoUnbindOnArchive=false：会话归档不解绑', poolB.bindingOf('sess-M')?.instanceId === 'ProjM@mmmm3333', JSON.stringify(poolB.bindingOf('sess-M')))
check('autoUnbindOnArchive=false：view.rules 反映 false', poolB.view('sess-M').rules.autoUnbindOnArchive === false)
poolB.stop()
sB.close()

// 调用时实例离线：返回失败原因（不抛出），重连后调用成功（无感）
const instR = [{ id: 'ProjX@xxxx7777', name: 'ProjX', hash: 'xxxx7777' }]
const sR = makeMcpServer(instR)
await sR.listen()
const poolR = createPool(ctx, {
  services: [{ id: 'SR', name: '服务R', url: 'http://127.0.0.1:' + sR.port() + '/mcp' }],
  dataFile: dataFile + '.sR',
  probeIntervalMs: 5000,
  callReconnectTimeoutMs: 2000, // 缩短真实等待
})
await poolR.probe()
await poolR.bind('sess-X', { instance: 'ProjX@xxxx7777' })
check('绑定：sess-X → ProjX', poolR.bindingOf('sess-X')?.instanceId === 'ProjX@xxxx7777')
// 实例掉线 → 调用返回失败原因（不抛出）
instR.splice(0, 1)
let threwR = null
let rOut = null
try { rOut = await poolR.proxyMcp('sess-X', 'manage_scene', { action: 'get_hierarchy' }) } catch (e) { threwR = e.message }
check('调用时实例离线：返回失败原因（不抛出）', threwR === null && rOut && rOut.success === false && /实例不可用|重连超时|离线/.test(rOut.text || ''), JSON.stringify({ threwR, text: rOut && rOut.text }).slice(0, 300))
// 实例重连（恢复列表）+ 探测 → 再次调用成功（实例掉线对运行时会话无感）
instR.push({ id: 'ProjX@xxxx7777', name: 'ProjX', hash: 'xxxx7777' })
await poolR.probe()
const rOut2 = await poolR.proxyMcp('sess-X', 'manage_scene', { action: 'get_hierarchy' })
check('实例重连后调用成功（无感）', rOut2 && rOut2.success === true && rOut2.activeInstance === 'ProjX@xxxx7777', JSON.stringify(rOut2).slice(0, 200))
// view.rules 反映 callReconnectTimeoutMs
check('view.rules 反映 callReconnectTimeoutMs', (() => { const rv = poolR.view('sess-X').rules; return rv.callReconnectTimeoutMs === 2000 })())
poolR.stop()
sR.close()

// 供后续状态携带默认值检查使用的默认池
const poolA2 = createPool(ctx, {
  services: [{ id: 'SA', name: '服务A', url: 'http://127.0.0.1:9/mcp' }],
  dataFile: dataFile + '.sA2',
  probeIntervalMs: 5000,
})
// 默认全关：不显式传 state* → enabled=false，stateCarryEnabled=false，context 注入空串
check('状态携带：默认 stateEnabled=false', poolA2.cfg.stateEnabled === false)
check('状态携带：默认所有子开关 false', ['stateGameScreenshot','stateSceneScreenshot','stateSelection','stateUiSnapshot','stateSerialized','stateConsoleAll','stateConsoleSelected'].every(k => poolA2.cfg[k] === false), JSON.stringify(poolA2.cfg))
check('状态携带：stateCarryEnabled=false（全关）', poolA2.stateCarryEnabled('any') === false)
check('状态携带：context 注入空串（默认关）', poolA2.stateContextText('any') === '')

// 开启全部开关的池：mock S1 已支持 manage_camera 截图 / ui_snapshot / read_console / execute_code(Selection/Console) / components 资源
const sState = makeMcpServer([{ id: 'ProjM@mmmm3333', name: 'ProjM', hash: 'mmmm3333' }])
await sState.listen()
const stateDir = path.join(dir, 'state-carry')
const poolState = createPool(ctx, {
  services: [{ id: 'SS', name: '服务S', url: 'http://127.0.0.1:' + sState.port() + '/mcp' }],
  dataFile: dataFile + '.state',
  probeIntervalMs: 5000,
  stateEnabled: true,
  stateGameScreenshot: true,
  stateSceneScreenshot: true,
  stateSelection: true,
  stateUiSnapshot: true,
  stateSerialized: true,
  stateConsoleAll: true,
  stateConsoleSelected: true,
  stateRefreshMs: 5000,
  stateScreenshotMaxRes: 320,
  stateDir,
  stateMaxChars: 8000,
  stateSnapshotMaxChars: 4000,
  stateConsoleMaxChars: 6000,
  stateConsoleCount: 50,
})
await poolState.probe()
await poolState.bind('sess-S')
check('状态携带：绑定后 stateCarryEnabled=true', poolState.stateCarryEnabled('sess-S') === true)

// collectState 全项采集（bind 已触发过一次后台采集，轮询等其落定；再显式采一次刷新）
for (let i = 0; i < 60 && !poolState.stateCaches.has('sess-S'); i++) await new Promise(r => setTimeout(r, 50))
let cacheS = await poolState.collectState('sess-S')
if (!cacheS) { // 上轮采集仍持锁（并发极低，几乎不会走到）；再等一轮
  for (let i = 0; i < 60 && poolState._stateCollecting; i++) await new Promise(r => setTimeout(r, 50))
  cacheS = await poolState.collectState('sess-S')
}
check('状态携带：collectState 返回缓存', Boolean(cacheS) && Array.isArray(cacheS.entries) && cacheS.entries.length >= 7, JSON.stringify(cacheS && cacheS.entries && cacheS.entries.map(e => e.key)).slice(0, 300))
const byKey = Object.fromEntries((cacheS?.entries || []).map(e => [e.key, e]))
check('状态携带：Game 截图成功且落盘', byKey.gameShot && byKey.gameShot.ok === true && byKey.gameShot.file && byKey.gameShot.file.endsWith('game.png'), JSON.stringify(byKey.gameShot))
check('状态携带：Scene 截图成功且落盘', byKey.sceneShot && byKey.sceneShot.ok === true && byKey.sceneShot.file && byKey.sceneShot.file.endsWith('scene.png'), JSON.stringify(byKey.sceneShot))
check('状态携带：选中项包含 Cube', byKey.selection && byKey.selection.ok === true && /Cube/.test(byKey.selection.text), JSON.stringify(byKey.selection).slice(0, 200))
check('状态携带：ui-snapshot 含节点树', byKey.uiSnapshot && byKey.uiSnapshot.ok === true && /UI Snapshot/.test(byKey.uiSnapshot.text || ''), JSON.stringify(byKey.uiSnapshot).slice(0, 200))
check('状态携带：ui-snapshot 含引用明细（Refs/Backrefs 可见）', byKey.uiSnapshot && /Refs \(outgoing\):/.test(byKey.uiSnapshot.text || '') && /Cube\.Comp\.fieldA/.test(byKey.uiSnapshot.text || '') && /Backrefs \(incoming/.test(byKey.uiSnapshot.text || ''), JSON.stringify(byKey.uiSnapshot).slice(0, 300))
// v0.4.1 规则压缩（2026-08-20 用户要求提信息密度）：树去 rect、(inactive) 聚合、重复子树占位、Refs 同源聚合
const snapTxt = (byKey.uiSnapshot && byKey.uiSnapshot.text) || ''
check('压缩：树已去掉 rect 坐标', !/rect:\[/.test(snapTxt), snapTxt.slice(0, 200))
check('压缩：未激活聚合（头部声明，行内无 (inactive)）', /inactive 标记已省略/.test(snapTxt) && !/\(inactive\)/.test(snapTxt), snapTxt.slice(0, 200))
check('压缩：重复子树聚合占位（Template 只保留一份）', /重复子树/.test(snapTxt), snapTxt.slice(0, 300))
check('压缩：名字数字归一聚合（label_0_1 同构被占位，label_0_0 保留）', /label_0_0/.test(snapTxt) && !/label_0_1/.test(snapTxt), snapTxt.slice(0, 300))
check('压缩：Refs 同源聚合（fieldB 不再重复来源前缀）', /fieldB -> \[109\] TargetB/.test(snapTxt) && !/\[101\] Cube\.Comp\.fieldB/.test(snapTxt), snapTxt.slice(0, 400))
check('压缩：Refs 连续相同行合并 ×N（fieldC ×2）', /fieldC -> \[111\] TargetC ×2/.test(snapTxt), snapTxt.slice(0, 400))
check('压缩：Backrefs 同目标合并为逗号列表', /\[102\] <- \[101\] Cube\.Comp\.fieldA, \[104\] Viewport\.Image\.m_Sprite/.test(snapTxt), snapTxt.slice(0, 400))
// ui_snapshot 必须包含未激活物体（选中项常是隐藏 UI 面板；false 会返回 0 nodes 空快照——2026-08-20 实测）
const snapCall = sState.calls.find(c => c.tool === 'ui_snapshot')
check('状态携带：ui_snapshot 调用含 include_inactive=true', Boolean(snapCall) && snapCall.args.include_inactive === true, JSON.stringify(snapCall && snapCall.args))
check('状态携带：ui_snapshot 调用含 names_in_refs=true（引用带名字）', Boolean(snapCall) && snapCall.args.names_in_refs === true, JSON.stringify(snapCall && snapCall.args))
check('状态携带：ui_snapshot 缓存优先（force_refresh=false，不再每次全量重扫）', Boolean(snapCall) && snapCall.args.force_refresh === false, JSON.stringify(snapCall && snapCall.args))
check('状态携带：序列化字段含组件与字段数', byKey.serialized && byKey.serialized.ok === true && /BoxCollider/.test(byKey.serialized.text || '') && /组件数 2/.test(byKey.serialized.text || ''), JSON.stringify(byKey.serialized).slice(0, 200))
check('状态携带：Console 全文含 mock 日志', byKey.consoleAll && byKey.consoleAll.ok === true && /mock console line 1/.test(byKey.consoleAll.text || ''), JSON.stringify(byKey.consoleAll).slice(0, 200))
check('状态携带：Console 选中条目含 ACTIVE_TEXT', byKey.consoleSelected && byKey.consoleSelected.ok === true && /ACTIVE_TEXT/.test(byKey.consoleSelected.text || ''), JSON.stringify(byKey.consoleSelected).slice(0, 200))

// ---- 快照地图模式（v0.4.1）：Library JSON 生成分层地图（概览/分支/业务引用/锚点/定位） ----
const mapFile = path.join(dir, 'snap-map.json')
await fsp.writeFile(mapFile, JSON.stringify({
  version: '1.0', generatedAt: new Date().toISOString(),
  roots: [101],
  nodes: [
    { id: 101, name: '设备健康度', parentId: 0, path: '外部Canvas/设备健康度', active: true, components: [] },
    { id: 102, name: 'Btn详情', parentId: 101, path: '外部Canvas/设备健康度/Btn详情', active: true, components: ['Image', 'Button'] },
    { id: 103, name: 'BarChart', parentId: 101, path: '外部Canvas/设备健康度/BarChart', active: true, components: ['BarChart', 'TSViewPanel'] },
    { id: 104, name: 'painter_0', parentId: 103, path: '外部Canvas/设备健康度/BarChart/painter_0', active: true, components: ['Painter'] },
    { id: 105, name: 'painter_1', parentId: 103, path: '外部Canvas/设备健康度/BarChart/painter_1', active: true, components: ['Painter'] },
    { id: 106, name: 'popup', parentId: 101, path: '外部Canvas/设备健康度/popup', active: true, components: ['HealthPopupController'] },
    { id: 107, name: 'text', parentId: 106, path: '外部Canvas/设备健康度/popup/text', active: true, components: ['Text'] },
  ],
  refs: [
    { sourceId: 103, sourceComponent: 'BarChart', field: 'm_Font', targetId: 200, targetType: 'Font', targetKind: 'Asset', targetGoId: 0 },
    { sourceId: 103, sourceComponent: 'BarChart', field: 'm_Font', targetId: 200, targetType: 'Font', targetKind: 'Asset', targetGoId: 0 },
    { sourceId: 103, sourceComponent: 'BarChart', field: 'm_Font', targetId: 200, targetType: 'Font', targetKind: 'Asset', targetGoId: 0 },
    { sourceId: 106, sourceComponent: 'HealthPopupController', field: 'barNotifier', targetId: 108, targetType: 'GameObject', targetKind: 'GameObject', targetGoId: 108 },
    { sourceId: 106, sourceComponent: 'HealthPopupController', field: 'btnClose', targetId: 102, targetType: 'GameObject', targetKind: 'GameObject', targetGoId: 102 },
    { sourceId: 102, sourceComponent: 'Button', field: 'm_OnClick[0]', targetId: 106, targetType: 'GameObject', targetKind: 'GameObject', targetGoId: 106, method: 'SetActive' },
  ],
}, null, 2))
sState.setSnapshotFile(mapFile)
for (let i = 0; i < 60 && poolState._stateCollecting; i++) await new Promise(r => setTimeout(r, 50))
let cacheMap = await poolState.collectState('sess-S')
if (!cacheMap) { for (let i = 0; i < 60 && poolState._stateCollecting; i++) await new Promise(r => setTimeout(r, 50)); cacheMap = await poolState.collectState('sess-S') }
const mapTxt = ((cacheMap?.entries || []).find(e => e.key === 'uiSnapshot') || {}).text || ''
check('地图：注入为分层地图（头/根/分支/业务引用/锚点/定位）', /UI Snapshot 地图/.test(mapTxt) && /根: \[101\]设备健康度/.test(mapTxt) && /分支/.test(mapTxt) && /业务引用/.test(mapTxt) && /锚点/.test(mapTxt) && /定位: /.test(mapTxt), mapTxt.slice(0, 300))
check('地图：分支索引含节点数与自定义组件', /BarChart \[3 节点 R:3\]/.test(mapTxt) && /BarChart,Painter,TSViewPanel/.test(mapTxt), mapTxt.slice(0, 400))
check('地图：业务引用含自定义字段与 m_OnClick', /HealthPopupController\.barNotifier/.test(mapTxt) && /m_OnClick\[0\]/.test(mapTxt), mapTxt.slice(0, 500))
check('地图：资源/自引用噪音聚合（m_Font ×3 不逐条）', /资源\/自引用聚合/.test(mapTxt) && /BarChart\.m_Font ×3/.test(mapTxt) && !/m_Font -> /.test(mapTxt), mapTxt.slice(0, 600))
check('地图：锚点含高价值/自定义组件节点', /\[103\] BarChart/.test(mapTxt) && /\[106\] popup/.test(mapTxt), mapTxt.slice(0, 600))
sState.setSnapshotFile(null)

// ---- 忙时跳过采集（v0.4.1，2026-08-20 用户第 3 次遇到「Unity 反复读条」）：Unity 编译/读条期间不采集 ----
const sBusy = makeMcpServer([{ id: 'ProjB2@bbbb3333', name: 'ProjB2', hash: 'bbbb3333' }], { busyPattern: [true, true, false] })
await sBusy.listen()
const poolBusy = createPool(ctx, {
  services: [{ id: 'SB', name: '服务B', url: 'http://127.0.0.1:' + sBusy.port() + '/mcp' }],
  dataFile: dataFile + '.busy',
  probeIntervalMs: 5000,
  stateEnabled: true,
  stateSelection: true,
})
await poolBusy.probe()
await poolBusy.bind('sess-B')
await new Promise(r => setTimeout(r, 200)) // 等 bind 触发的异步采集（消耗 busyPattern[0]=true → 跳过）
for (let i = 0; i < 60 && poolBusy._stateCollecting; i++) await new Promise(r2 => setTimeout(r2, 50))
const busyCache = await poolBusy.collectState('sess-B')
check('忙时跳过：Unity 读条期间 collectState 返回 null（不采集，保留旧缓存）', busyCache === null, JSON.stringify(busyCache))
const busyCache2 = await poolBusy.collectState('sess-B')
check('忙时跳过：读条结束（busyPattern 耗尽）后采集恢复', busyCache2 === null || Array.isArray(busyCache2.entries), JSON.stringify(busyCache2))
poolBusy.stop(); sBusy.close()
fsp.rm(dataFile + '.busy', { force: true }).catch(() => {})

// 截图 PNG 实际落盘且是合法 PNG
const fsState = await import('node:fs')
const gamePng = byKey.gameShot && byKey.gameShot.file ? byKey.gameShot.file : path.join(stateDir, 'sess-S', 'game.png')
const pngBuf = fsState.readFileSync(gamePng)
check('状态携带：截图文件为合法 PNG（魔数）', pngBuf.length > 8 && pngBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', pngBuf.length + ' bytes')

// stateContextText：缓存注入文本（同步，含截图路径）
const ctxText = poolState.stateContextText('sess-S')
check('状态携带：context 文本含 unity_pool_state 标记', ctxText.includes('<unity_pool_state>') && ctxText.includes('</unity_pool_state>'))
check('状态携带：context 文本含 Game 截图路径与 read_image 提示', /Game 视图截图/.test(ctxText) && /read_image/.test(ctxText), ctxText.slice(0, 300))
check('状态携带：context 文本含选中项/序列化/Console 各段', /当前选中项/.test(ctxText) && /选中物体序列化字段/.test(ctxText) && /Console 全文/.test(ctxText) && /Console 选中条目/.test(ctxText), ctxText.slice(0, 400))

// 截图按需采集（v0.4.1）：后台轮询跳过截图（截图闪 Unity 窗口/任务栏提醒）；完整采集才含截图。
// 注意：stateContextText 可能已触发异步截图补采（截图过期时），这里再显式做一轮完整采集拿含截图的缓存。
const cacheSkip = await poolState.collectState('sess-S', { skipScreenshots: true })
const byKeySkip = Object.fromEntries((cacheSkip?.entries || []).map(e => [e.key, e]))
check('截图按需采集：skipScreenshots 轮询不含截图条目', Boolean(cacheSkip) && !byKeySkip.gameShot && !byKeySkip.sceneShot && byKeySkip.selection && byKeySkip.consoleAll, 'keys=' + Object.keys(byKeySkip).join(','))
check('截图按需采集：view.state 含 screenshotStaleMs', poolState.view('sess-S').state.screenshotStaleMs === 10000, JSON.stringify(poolState.view('sess-S').state.screenshotStaleMs))
// 完整采集（含截图）恢复缓存，供后续断言使用
await new Promise(r => setTimeout(r, 100))
let cacheFull = await poolState.collectState('sess-S')
if (!cacheFull) { for (let i = 0; i < 60 && poolState._stateCollecting; i++) await new Promise(r => setTimeout(r, 50)); cacheFull = await poolState.collectState('sess-S') }
check('截图按需采集：完整采集恢复截图条目', Boolean(cacheFull) && cacheFull.entries.some(e => e.key === 'gameShot' && e.ok), JSON.stringify(cacheFull && cacheFull.entries.map(e => e.key)))

// 防超长：stateMaxChars=40 → 选中项被截断并标注
const poolTiny = createPool(ctx, {
  services: [{ id: 'ST', name: '服务T', url: 'http://127.0.0.1:' + sState.port() + '/mcp' }],
  dataFile: dataFile + '.tiny',
  probeIntervalMs: 5000,
  stateEnabled: true,
  stateSelection: true,
  stateMaxChars: 40,
})
await poolTiny.probe()
await poolTiny.bind('sess-T2')
for (let i = 0; i < 60 && !poolTiny.stateCaches.has('sess-T2'); i++) await new Promise(r => setTimeout(r, 50))
let cacheTiny = await poolTiny.collectState('sess-T2')
if (!cacheTiny) {
  for (let i = 0; i < 60 && poolTiny._stateCollecting; i++) await new Promise(r => setTimeout(r, 50))
  cacheTiny = await poolTiny.collectState('sess-T2')
}
const tinySel = cacheTiny.entries.find(e => e.key === 'selection')
check('防超长：stateMaxChars=40 截断并标注', tinySel.ok === true && /已截断/.test(tinySel.text || '') && tinySel.text.length < 120, JSON.stringify(tinySel).slice(0, 200))
check('防超长：context 注入截断文本', /已截断/.test(poolTiny.stateContextText('sess-T2')))

// 运行时开关切换（state-switch 同款方法；v0.4.2 按会话独立，签名带 sessionId）
check('状态开关：setStateSwitch 关闭总开关后 context 空串', (poolTiny.setStateSwitch('sess-T2', 'stateEnabled', false), poolTiny.stateContextText('sess-T2') === ''))
check('状态开关：setStateSwitch 重新开启', (poolTiny.setStateSwitch('sess-T2', 'stateEnabled', true), poolTiny.stateContextText('sess-T2') !== ''))
check('状态开关：setStateSwitch 未知 key 拒绝', (() => { try { poolTiny.setStateSwitch('sess-T2', 'nope', true); return false } catch { return true } })())
check('状态开关：setStateSwitch 缺 sessionId 拒绝', (() => { try { poolTiny.setStateSwitch('', 'stateEnabled', true); return false } catch { return true } })())
check('状态开关：switchLog 记录写入流水（含会话）', Array.isArray(poolTiny.stateSwitchLog) && poolTiny.stateSwitchLog.some(e => e.key === 'stateEnabled' && e.value === true && e.sessionId === 'sess-T2') && poolTiny.stateSwitchLog.length <= 40)
// v0.4.2 per-session：sess-T2 关闭总开关不影响其他会话（sess-T 的 cfg 默认层与 per-session 层）
check('状态开关：per-session 隔离——T2 关总开关不影响 T', (poolTiny.setStateSwitch('sess-T2', 'stateEnabled', false), poolTiny.getStateSwitches('sess-T2').stateEnabled === false && poolTiny.stateCarryEnabled('sess-T') === true))
check('状态开关：per-session 隔离——T 切 selection 只影响自己（T2 的 stateEnabled 仍 false、selection 走 cfg 默认）', (poolTiny.setStateSwitch('sess-T', 'stateSelection', true), poolTiny.getStateSwitches('sess-T').stateSelection === true && poolTiny.getStateSwitches('sess-T2').stateEnabled === false && poolTiny.getStateSwitches('sess-T2').stateSelection === true))

// 单项失败不阻断：ui_snapshot 工具未注册（调用失败）→ 该项 error，其余照常
const sNoSnap = makeMcpServer([{ id: 'ProjN@nnnn4444', name: 'ProjN', hash: 'nnnn4444' }], { failTool: 'ui_snapshot' })
await sNoSnap.listen()
const poolNoSnap = createPool(ctx, {
  services: [{ id: 'SN', name: '服务N', url: 'http://127.0.0.1:' + sNoSnap.port() + '/mcp' }],
  dataFile: dataFile + '.nosnap',
  probeIntervalMs: 5000,
  stateEnabled: true,
  stateSelection: true,
  stateUiSnapshot: true,
})
await poolNoSnap.probe()
await poolNoSnap.bind('sess-N')
for (let i = 0; i < 60 && !poolNoSnap.stateCaches.has('sess-N'); i++) await new Promise(r => setTimeout(r, 50))
let cacheN = await poolNoSnap.collectState('sess-N')
if (!cacheN) {
  for (let i = 0; i < 60 && poolNoSnap._stateCollecting; i++) await new Promise(r => setTimeout(r, 50))
  cacheN = await poolNoSnap.collectState('sess-N')
}
const nSnap = cacheN.entries.find(e => e.key === 'uiSnapshot')
const nSel = cacheN.entries.find(e => e.key === 'selection')
check('单项失败不阻断：ui-snapshot 采集失败标注', nSnap && nSnap.ok === false && /tool boom/.test(nSnap.error || ''), JSON.stringify(nSnap))
check('单项失败不阻断：失败项进 context 文本', /采集失败/.test(poolNoSnap.stateContextText('sess-N')))
check('单项失败不阻断：选中项仍成功', nSel && nSel.ok === true, JSON.stringify(nSel))

// 选中项非 GameObject（如 Project 资产）：失败信息必须附带选中项摘要（注入块直接可见“选中了什么”）
sNoSnap.setSelectionResult('count=1\n- SomeTexture | type=Texture2D')
await new Promise(r => setTimeout(r, 100))
let cacheN2 = await poolNoSnap.collectState('sess-N')
if (!cacheN2) {
  for (let i = 0; i < 60 && poolNoSnap._stateCollecting; i++) await new Promise(r => setTimeout(r, 50))
  cacheN2 = await poolNoSnap.collectState('sess-N')
}
const nSnap2 = cacheN2.entries.find(e => e.key === 'uiSnapshot')
check('非 GameObject 选中项：失败信息附带选中项摘要', nSnap2 && nSnap2.ok === false && /选中项：/.test(nSnap2.error || '') && /SomeTexture/.test(nSnap2.error || ''), JSON.stringify(nSnap2))

// 未绑定会话：collectState 返回 null
check('状态携带：未绑定会话采集返回 null', (await poolState.collectState('sess-UNBOUND')) === null)

// apply() 装配：注册 unity-pool:state context + unity_pool_state 工具 + HTTP API
const stateCtx = promptContexts.find(c => c.name === 'unity-pool:state')
check('apply：注册状态 context（text 为函数）', Boolean(stateCtx) && typeof stateCtx.text === 'function')
check('apply：注册 unity_pool_state 工具', registered.some(t => t.name === 'unity_pool_state'))
check('apply：默认关时状态 context 注入空串', stateCtx.text({ agent: { id: 'sess-T', session: { id: 'sess-T' } } }) === '')
// HTTP /api/config 返回 state 字段
{
  const res = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/config'), res)
  const pb = JSON.parse(res._out.body)
  check('HTTP /api/config 返回 state 开关', pb.ok === true && pb.value.state && pb.value.state.enabled === false && pb.value.state.selection === false)
}
// HTTP /api/state 返回缓存
{
  const res = fakeRes()
  await handler(fakeReq('GET', '/unity-pool/api/state?sessionId=sess-T'), res)
  const pb = JSON.parse(res._out.body)
  check('HTTP GET /api/state 返回 cache/view', pb.ok === true && pb.value.view && typeof pb.value.sessionId === 'string')
}

// ---------- v0.4.0 UX：每回合状态只注入一次（同回合共享同一 turn 信号） ----------
{
  // fakeRes 变体：end() 时 resolve，用于异步 POST 断言
  function pRes() {
    const out = { status: 0, body: '' }
    let resolveEnd
    const done = new Promise(r => { resolveEnd = r })
    const res = { writeHead(s) { out.status = s; return this }, end(b) { out.body = String(b); resolveEnd(out); return this }, _out: out }
    return { res, done }
  }
  async function postJson(url, body) {
    const { res, done } = pRes()
    const req = fakeReq('POST', url, body)
    handler(req, res) // 先挂 readJson 监听，再发 data/end
    req._emit('data', Buffer.from(JSON.stringify(body)))
    req._emit('end')
    await done
    return JSON.parse(res._out.body)
  }
  // 归档测试把 sess-T 解绑了，且池未重新探测（ProjB 不在缓存），改绑仍在列表的 ProjA
  const rebind = await bindTool.execute({ instance: 'ProjA@aaaa1111' }, { agent: { id: 'sess-T' } })
  check('状态注入：重新绑定 sess-T', rebind.instanceId === 'ProjA@aaaa1111')
  const rA = await postJson('/unity-pool/api/state-switch', { sessionId: 'sess-T', key: 'stateEnabled', value: true })
  const rB = await postJson('/unity-pool/api/state-switch', { sessionId: 'sess-T', key: 'stateSelection', value: true })
  check('状态开关：HTTP 切换总开关+子项成功', rA.ok === true && rB.ok === true && rB.value.state.enabled === true && rB.value.state.switches.stateSelection === true)
  // 等采集缓存就绪（轮询 GET，不在注入路径上记录信号）
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    const res = fakeRes()
    await handler(fakeReq('GET', '/unity-pool/api/state?sessionId=sess-T'), res)
    const pb = JSON.parse(res._out.body)
    ready = !!(pb.value && pb.value.view && pb.value.view.state && pb.value.view.state.cache
      && Array.isArray(pb.value.view.state.cache.entries) && pb.value.view.state.cache.entries.length > 0)
    if (!ready) await new Promise(res2 => setTimeout(res2, 50))
  }
  check('状态注入：采集缓存就绪', ready)
  const mkAgent = function (turn) {
    return { agent: { id: 'sess-T', session: { id: 'sess-T', events: turn > 0 ? [{ type: 'turn/start', data: { turn } }] : [] } } }
  }
  // v0.4.1：注入策略改为「每步返回相同状态块文本」（不再 stateInjectOnce 每回合一次）——
  // 去重交给宿主整段 runtime-context 去重（内容未变不注入）；这里断言：任何 step 调用都返回完整状态块
  const once1 = stateCtx.text(mkAgent(5))
  const once2 = stateCtx.text(mkAgent(5))
  check('状态注入：任意 request 携带状态块', once1.includes('<unity_pool_state>') && once1.includes('Unity 状态（'))
  check('状态注入：同回合后续 request 返回相同状态块（供宿主整段去重）', once2 === once1 && once2.includes('<unity_pool_state>'))
  check('状态注入：状态块不含采集时间戳（避免每 3s 变化破坏宿主去重）', !/采集于/.test(once1))
  check('状态注入：stateTurnOf 读 turn/start 回合号', poolState.stateTurnOf({ session: { events: [{ type: 'turn/start', data: { turn: 9 } }] } }) === 9)
  check('状态注入：stateTurnOf 无 events 返回 -1', poolState.stateTurnOf({ session: {} }) === -1)
  check('状态注入：stateTurnOf 空事件表返回 0', poolState.stateTurnOf({ session: { events: [] } }) === 0)

  // v0.4.1 回合缓存（2026-08-20 用户纠正设计）：同回合内 Unity 状态变化不得改变注入文本——
  // 用户反复选中物体检查时，回合内每步都返回首步的同一份状态块 → 宿主整段去重零注入；新回合才重新生成。
  // 注：状态注入走 apply 池（sess-T 绑定在 apply 池，其服务是 s1）；无后台轮询（v0.4.1），
  // 换选中后通过 /api/state-refresh 手动触发采集更新缓存（模拟消息驱动采集）。
  s1.setSelectionResult('count=1\n- OtherCube | type=GameObject | id=-202 | path=Root/Other')
  const rRefresh = await postJson('/unity-pool/api/state-refresh', { sessionId: 'sess-T' })
  check('状态注入：state-refresh 手动触发采集成功', rRefresh.ok === true && rRefresh.value && rRefresh.value.cache, JSON.stringify(rRefresh).slice(0, 200))
  const once5 = stateCtx.text(mkAgent(5)) // 同回合（turn 5）→ 必须返回首步缓存（回合号单调，回头访问旧回合）
  check('状态注入：★ 同回合内状态变化不改变注入文本（回合缓存，不再每步注入）', once5 === once1, once5 === once1 ? 'same' : 'CHANGED: ' + once5.slice(0, 120))
  const once6 = stateCtx.text(mkAgent(7)) // 新回合 → 重新生成并携带最新状态
  check('状态注入：新回合重新生成（携带最新状态 OtherCube）', once6 !== once1 && /OtherCube/.test(once6), once6.slice(0, 160))
  const once3 = stateCtx.text(mkAgent(6)) // 另一新回合 → 同样携带最新状态
  const once4 = stateCtx.text(mkAgent(0)) // 无回合号 → 每次重新生成
  check('状态注入：新回合同样返回状态块', once3.includes('<unity_pool_state>'))
  check('状态注入：无回合号同样返回状态块', once4.includes('<unity_pool_state>'))

  // 状态开关持久化（v0.4.1 起；v0.4.2 按会话）：setStateSwitch 写入 dataFile 的
  // stateSwitchesBySession[sessionId]，重建 pool 后该会话恢复上次设置（含"关"）；其他会话不受影响
  await postJson('/unity-pool/api/state-switch', { sessionId: 'sess-T', key: 'stateSelection', value: false })
  await postJson('/unity-pool/api/state-switch', { sessionId: 'sess-T', key: 'stateConsoleAll', value: true })
  await postJson('/unity-pool/api/state-switch', { sessionId: 'sess-T', key: 'stateEnabled', value: false }) // 还原总开关（持久化里应为 false）
  const stateFileRaw = JSON.parse(await fsp.readFile(dataFile + '.apply', 'utf8'))
  const storedSw = stateFileRaw.stateSwitchesBySession && stateFileRaw.stateSwitchesBySession['sess-T']
  check('状态持久化：dataFile 按会话存 stateSwitchesBySession[sess-T] 且为最新值', storedSw
    && storedSw.stateEnabled === false && storedSw.stateConsoleAll === true
    && storedSw.stateSelection === false, JSON.stringify(stateFileRaw.stateSwitchesBySession))
  const poolReborn = createPool(ctx, {
    services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + sState.port() + '/mcp' }],
    dataFile: dataFile + '.apply',
    probeIntervalMs: 5000,
    stateEnabled: true, // 配置默认开着，但 sess-T 的 per-session 持久化（false）应覆盖它
  })
  const rebornSw = poolReborn.getStateSwitches('sess-T')
  const rebornOther = poolReborn.getStateSwitches('sess-OTHER')
  check('状态持久化：重建后 sess-T 恢复上次开关状态（覆盖配置默认）',
    rebornSw.stateEnabled === false && rebornSw.stateConsoleAll === true && rebornSw.stateSelection === false,
    JSON.stringify(rebornSw))
  check('状态持久化：cfg 配置默认层不被覆盖（stateEnabled 仍 true）', poolReborn.cfg.stateEnabled === true,
    JSON.stringify({ enabled: poolReborn.cfg.stateEnabled }))
  check('状态持久化：其他会话不受 sess-T 的 per-session 设置影响（走配置默认）',
    rebornOther.stateEnabled === true && rebornOther.stateConsoleAll === false && rebornOther.stateSelection === false,
    JSON.stringify(rebornOther))
  poolReborn.stop()

  // v0.4.2 迁移兼容：旧版全局平铺 stateSwitches（v0.4.1 及之前）作为 base（全局默认层）生效，per-session 覆盖它
  {
    const legacyFile = dataFile + '.legacy'
    await fsp.writeFile(legacyFile, JSON.stringify({ bindings: {}, stateSwitches: { stateEnabled: true, stateUiSnapshot: true, stateSelection: false } }), 'utf8')
    const poolLegacy = createPool(ctx, {
      services: [{ id: 'S1', name: '服务1', url: 'http://127.0.0.1:' + sState.port() + '/mcp' }],
      dataFile: legacyFile,
      probeIntervalMs: 5000,
    })
    const lg = poolLegacy.getStateSwitches('sess-X')
    check('迁移：旧全局平铺 stateSwitches 作为 base 生效', lg.stateEnabled === true && lg.stateUiSnapshot === true && lg.stateSelection === false, JSON.stringify(lg))
    poolLegacy.setStateSwitch('sess-X', 'stateUiSnapshot', false)
    const lg2 = poolLegacy.getStateSwitches('sess-X')
    const lgOther = poolLegacy.getStateSwitches('sess-Y')
    check('迁移：per-session 覆盖 base，其他会话仍吃 base', lg2.stateUiSnapshot === false && lgOther.stateUiSnapshot === true, JSON.stringify({ x: lg2, y: lgOther }))
    poolLegacy.stop()
    fsp.rm(legacyFile, { force: true }).catch(() => {})
  }
}

poolState.stop(); poolTiny.stop(); poolNoSnap.stop()
sState.close(); sNoSnap.close()
fsp.rm(stateDir, { recursive: true, force: true }).catch(() => {})
fsp.rm(dataFile + '.state', { force: true }).catch(() => {})
fsp.rm(dataFile + '.tiny', { force: true }).catch(() => {})
fsp.rm(dataFile + '.nosnap', { force: true }).catch(() => {})

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