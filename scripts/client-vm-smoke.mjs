// dsh-unity-pool client bundle VM 冒烟：结构 + 共享状态源（pub-sub store）两处开关同步逻辑。
// 背景（v0.4.1）：头部「Unity」面板与输入条 dock 曾各自本地 state + 各自拉取/轮询 → 不同步；
// 现在两处组件都从模块级 store 读、切换成功后写 store 广播 → 一处切换两处即时同步。
// 本脚本在 VM 里加载 lib/client.js（ModuleLoader + mock React + mock fetch + mock slots），
// 渲染两个组件，模拟「dock 切总开关 → 面板即时变；面板切子开关 → dock 即时变」。
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LIB = process.env.UNITY_POOL_CLIENT_LIB
  ? process.env.UNITY_POOL_CLIENT_LIB
  : path.join(os.homedir(), 'dsh-unity-pool', 'lib', 'client.js')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log('  OK ' + name)
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 400) : '')) }
}

const code = fs.readFileSync(LIB, 'utf8')

// ---------- mock 环境 ----------
const hookCtx = new Map() // component fn -> { cursor, states, effects }
function makeReact() {
  const React = {
    createElement: function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      const p = Object.assign({}, props || {})
      if (children.length > 0) p.children = children.length === 1 ? children[0] : children
      return { type, props: p }
    },
  }
  React.useState = function (initial) {
    const ctx = currentHookCtx
    const i = ctx.cursor++
    if (i >= ctx.states.length) ctx.states.push(initial)
    const set = function (v) {
      ctx.states[i] = typeof v === 'function' ? v(ctx.states[i]) : v
      ctx.updated = true
    }
    return [ctx.states[i], set]
  }
  React.useEffect = function (fn) { currentHookCtx.effects.push(fn) }
  React.useCallback = function (fn) { return fn }
  React.useRef = function (initial) {
    // wrapRef（useRef(null)，面板定位）需要 getBoundingClientRect；reqSeq（useRef(0)）等数值 ref 用真实初始值（++ 才有意义）
    if (initial === undefined || initial === null) return { current: { getBoundingClientRect: () => ({ right: 400, bottom: 300 }) } }
    return { current: initial }
  }
  return React
}

let currentHookCtx = null
function render(comp, props) {
  let ctx = hookCtx.get(comp)
  if (!ctx) { ctx = { cursor: 0, states: [], effects: [], updated: false }; hookCtx.set(comp, ctx) }
  ctx.cursor = 0
  ctx.updated = false
  currentHookCtx = ctx
  const tree = comp(props)
  currentHookCtx = null
  return { tree, ctx }
}

// 渲染 → 手动跑全部已收集 effects → 等微任务；重复 rounds 轮（effect 里的 setState 会派生新 effect）
async function settle(comp, props, rounds = 3) {
  let tree = null
  for (let i = 0; i < rounds; i++) {
    const r = render(comp, props)
    tree = r.tree
    r.ctx.effects.forEach(fn => { try { fn() } catch (e) {} })
    await new Promise(r2 => setTimeout(r2, 0))
  }
  return tree
}

function collect(tree, pred, out) {
  if (Array.isArray(tree)) { tree.forEach(c => collect(c, pred, out)); return out }
  if (!tree || typeof tree !== 'object') return out
  if (pred(tree)) out.push(tree)
  const ch = tree.props && tree.props.children
  if (Array.isArray(ch)) ch.forEach(c => collect(c, pred, out))
  else collect(ch, pred, out)
  return out
}
function inputs(tree) { return collect(tree, n => n.type === 'input', []) }
function buttons(tree) { return collect(tree, n => n.type === 'button', []) }
function clickables(tree) { return collect(tree, n => typeof n.props.onClick === 'function', []) }

// fetch mock：按 URL 返回（同步 resolve 的 promise）
const MOCK_SESSION = 'sess-M'
const STATE_OFF = { enabled: false, switches: { stateEnabled: false, stateGameScreenshot: false, stateSceneScreenshot: false, stateSelection: false, stateUiSnapshot: false, stateSerialized: false, stateConsoleAll: false, stateConsoleSelected: false }, refreshMs: 3000, maxChars: 8000, cache: null }
const STATE_ON = { enabled: true, switches: { stateEnabled: true, stateGameScreenshot: true, stateSceneScreenshot: false, stateSelection: false, stateUiSnapshot: false, stateSerialized: false, stateConsoleAll: false, stateConsoleSelected: false }, refreshMs: 3000, maxChars: 8000, cache: { at: Date.now(), instanceId: 'ProjX@aaaa1111', entries: [{ key: 'stateGameScreenshot', label: 'Game 截图', ok: true, file: 'C:/tmp/1.png' }] } }
let serverState = JSON.parse(JSON.stringify(STATE_OFF))
const fetched = []
let staleStatus = false // 下一次 /api/status 返回"请求发出时"的旧快照（延迟 30ms），模拟轮询响应晚于用户切换
// viewOf.binding 可变：模拟宿主侧绑定/解绑（面板锁定按钮 / agent 工具 / 其它标签页）
// ProjY 模拟被其它会话占用：普通 bind 409，force 才成功
const viewOf = { binding: { serviceId: 'S1', instance: { name: 'ProjX', id: 'ProjX@aaaa1111' } }, state: () => JSON.parse(JSON.stringify(serverState)) }
function servicesOf() {
  const bi = viewOf.binding && viewOf.binding.instance && viewOf.binding.instance.id
  return [{
    id: 'S1', name: '服务1', alive: true,
    instances: [
      { id: 'ProjX@aaaa1111', name: 'ProjX', hash: 'aaaa1111', active: bi === 'ProjX@aaaa1111' },
      { id: 'ProjY@oooo2222', name: 'ProjY', hash: 'oooo2222', active: bi === 'ProjY@oooo2222' },
    ],
  }]
}
function mockFetch(url, opts) {
  fetched.push(url)
  if (typeof url === 'string' && url.includes('/unity-pool/api/state-switch')) {
    const body = JSON.parse((opts && opts.body) || '{}')
    if (body.key === 'stateEnabled') {
      serverState.enabled = body.value
      if (body.value === false) serverState.switches.stateEnabled = false
    } else {
      serverState.switches[body.key] = body.value
    }
    const v = { sessionId: MOCK_SESSION, state: JSON.parse(JSON.stringify(serverState)), view: { binding: viewOf.binding, services: servicesOf() } }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: v }) })
  }
  if (typeof url === 'string' && url.includes('/unity-pool/api/bind')) {
    const body = JSON.parse((opts && opts.body) || '{}')
    const inst = String(body.instance || '')
    if (inst === 'ProjY@oooo2222' && !body.force) {
      // 模拟实例被其它会话锁定：普通绑定 409
      return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: { message: '实例 [ProjY@oooo2222] 已被会话 sess-OTHER 锁定（并行开发请锁定不同实例；确认后可传 force=true）' } }) })
    }
    viewOf.binding = { serviceId: 'S1', instance: { name: inst.startsWith('ProjY') ? 'ProjY' : 'ProjX', id: inst } }
    const v = { sessionId: MOCK_SESSION, view: { binding: viewOf.binding, services: servicesOf(), state: JSON.parse(JSON.stringify(serverState)) } }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: v }) })
  }
  if (typeof url === 'string' && url.includes('/unity-pool/api/unbind')) {
    viewOf.binding = null
    const v = { sessionId: MOCK_SESSION, view: { binding: null, services: servicesOf(), state: JSON.parse(JSON.stringify(serverState)) } }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: v }) })
  }
  if (typeof url === 'string' && url.includes('/unity-pool/api/state')) {
    // 与真实宿主一致：value = {sessionId, cache, view}（state 在 view.state，无顶层 state）
    const v = { sessionId: MOCK_SESSION, cache: null, view: { binding: viewOf.binding, services: servicesOf(), state: JSON.parse(JSON.stringify(serverState)) } }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: v }) })
  }
  if (typeof url === 'string' && url.includes('/unity-pool/api/status') && staleStatus) {
    staleStatus = false
    const old = JSON.parse(JSON.stringify(STATE_OFF)) // 请求发出时的旧状态快照
    return new Promise(res => setTimeout(() => res({ json: () => Promise.resolve({ ok: true, value: { sessionId: MOCK_SESSION, binding: viewOf.binding, services: servicesOf(), state: old } }) }), 30))
  }
  if (typeof url === 'string' && url.includes('/unity-pool/api/status')) {
    const v = { sessionId: MOCK_SESSION, binding: viewOf.binding, services: servicesOf(), state: JSON.parse(JSON.stringify(serverState)) }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: v }) })
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: { message: 'no mock for ' + url } }) })
}
const sandbox = {
  window: { __ModuleLoader__: { load: (x) => { mod = x } } },
  fetch: mockFetch,
  setInterval: () => 0,
  clearInterval: () => {},
  console,
}
let mod = null
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
check('bundle 加载并注册到 ModuleLoader', Boolean(mod) && typeof mod.factory === 'function', String(mod))

// ---------- 加载 factory ----------
const React = makeReact()
const registrations = []
const slotsMock = {
  inject: (slot, fn) => { fn() },
  register: (opts, Comp) => { registrations.push({ opts, Comp }); return { opts, Comp } },
}
const bundle = mod.factory((name) => { if (name === 'react') return React; return undefined })
check('factory 返回 apply + inject', Boolean(bundle) && typeof bundle.apply === 'function' && Array.isArray(bundle.inject))
bundle.apply({ slots: slotsMock })
const ut = registrations.find(r => r.opts.name === 'conversation.session.header.utilities')
const dock = registrations.find(r => r.opts.name === 'conversation.input.dock')
check('注册头部面板槽（order 110）', Boolean(ut) && ut.opts.id === 'unity-pool' && ut.opts.order === 110)
check('注册输入条 dock 槽（order 90）', Boolean(dock) && dock.opts.id === 'unity-pool' && dock.opts.order === 90)

// ---------- 渲染两处组件（绑定态：sess-M） ----------
const props = { sessionId: MOCK_SESSION }
const dockTree = await settle(dock.Comp, props)
const dockInputs = inputs(dockTree)
check('dock 首次加载后渲染出总开关（第一个 input 为 master）', dockInputs.length >= 1, 'inputs=' + dockInputs.length)
check('dock 总开关初始为关（服务端默认全关）', dockInputs[0].props.checked === false, JSON.stringify(dockInputs[0] && dockInputs[0].props))

let utTree = await settle(ut.Comp, props)
// 打开面板（点击 chip）：open=true → effect 设 pos → 面板渲染
const chip = clickables(utTree).find(n => n.type === 'div')
check('面板 chip 可点击', Boolean(chip), 'clickables=' + clickables(utTree).length)
chip.props.onClick()
utTree = await settle(ut.Comp, props)
const panelInputs = inputs(utTree)
check('面板打开后渲染出开关区（8 个 input：master + 7 子项）', panelInputs.length === 8, 'inputs=' + panelInputs.length)
check('面板总开关初始为关（与 dock 同源）', panelInputs[0].props.checked === false, JSON.stringify(panelInputs[0] && panelInputs[0].props))

// ---------- 核心：一处切换 → 两处即时同步 ----------
// dock 切总开关开
const before = fetched.length
dockInputs[0].props.onChange({ target: { checked: true } })
await new Promise(r => setTimeout(r, 0))
check('dock 切总开关开：走了 state-switch', fetched.slice(before).some(u => u.includes('/state-switch')), fetched.slice(before).join(','))
const dockTree2 = await settle(dock.Comp, props)
check('dock 自身总开关变开', inputs(dockTree2)[0].props.checked === true, JSON.stringify(inputs(dockTree2)[0] && inputs(dockTree2)[0].props))
const utTree2 = await settle(ut.Comp, props)
const ut2 = inputs(utTree2)
check('★ 面板总开关即时同步为开（无需轮询/重开面板）', ut2.length === 8 && ut2[0].props.checked === true, JSON.stringify(ut2[0] && ut2[0].props))
const dockTree2Game = buttons(dockTree2).find(b => b.props && b.props.title && /Game 截图/.test(String(b.props.title || '')))
check('★ 面板 Game 截图子开关与 dock 芯片一致（服务端未开 → 两边都关）', ut2[1].props.checked === false && /（关）/.test(dockTree2Game.props.title || ''), JSON.stringify(ut2[1] && ut2[1].props))

// 面板切 Game 截图关（面板 input[1]）
ut2[1].props.onChange({ target: { checked: false } })
await new Promise(r => setTimeout(r, 0))
const dockTree3 = await settle(dock.Comp, props)
const dockGame = buttons(dockTree3).find(b => b.props && b.props.title && /Game 截图/.test(String(b.props.title || '')))
const utTree3 = await settle(ut.Comp, props)
const ut3 = inputs(utTree3)
check('★ 面板切 Game 截图关：dock 芯片即时同步（标题含（关））', Boolean(dockGame) && /（关）/.test(dockGame.props.title || ''), dockGame && dockGame.props.title)
check('面板自身 Game 截图变关', ut3[1].props.checked === false, JSON.stringify(ut3[1] && ut3[1].props))

// dock 芯片点击 → 再开 → 面板即时变开
dockGame.props.onClick()
await new Promise(r => setTimeout(r, 0))
const utTree4 = await settle(ut.Comp, props)
const ut4 = inputs(utTree4)
check('★ dock 芯片点开 Game 截图：面板即时变开', ut4[1].props.checked === true, JSON.stringify(ut4[1] && ut4[1].props))

// 其他会话：store 按 sessionId 隔离，渲染不崩
const otherTree = await settle(ut.Comp, { sessionId: 'sess-other' }, 2)
check('其他会话渲染不崩（store 按 sessionId 隔离）', otherTree !== null, String(otherTree))

// ---------- 绑定态同步：胶囊 chip 的锁定状态（v0.4.1） ----------
// chip 辅助：找 chip（div.onClick），取第二个 span（label 文本）与第一个 span（dot 颜色）
function chipOf(tree) {
  const chipEl = clickables(tree).find(n => n.type === 'div')
  if (!chipEl) return null
  const spans = collect(chipEl, n => n.type === 'span', [])
  const dot = spans[0] && spans[0].props && spans[0].props.style && spans[0].props.style.background
  const label = spans[1] && spans[1].props.children
  return { dot, label }
}
// 初始（mock 已绑定 ProjX）：轮询已把绑定信息写入 store → chip 显示实例名
const c0 = chipOf(await settle(ut.Comp, props))
check('胶囊初始显示绑定实例名（ProjX）', c0 && c0.label === 'ProjX' && c0.dot === '#30a46c', JSON.stringify(c0))

// 模拟外部解绑（agent 工具 / 其它标签页）：改 mock 后触发一次轮询（settle 重跑 effects → load）
viewOf.binding = null
const c1 = chipOf(await settle(ut.Comp, props, 2))
check('★ 外部解绑后胶囊自动变回 Unity（无需手动刷新）', c1 && c1.label === 'Unity' && c1.dot === '#888', JSON.stringify(c1))
const dockUnbound = await settle(dock.Comp, props, 2)
const dockLbl = collect(dockUnbound, n => n.type === 'span' && n.props.children === '未绑定 Unity，绑定后生效', [])
check('★ 解绑后 dock 文本同步为「未绑定 Unity，绑定后生效」', dockLbl.length >= 1, 'spans=' + collect(dockUnbound, n => n.type === 'span', []).map(s => s.props.children).join('|'))
// v0.4.2：未绑定也可切开关（预配置，绑定后生效）——总开关 checkbox 不再 disabled:!bound
const dockUnboundInputs = collect(dockUnbound, n => n.type === 'input' && n.props.type === 'checkbox', [])
check('★ 未绑定 dock 总开关可切（不再 disabled）', dockUnboundInputs.length >= 1 && dockUnboundInputs.every(i => i.props.disabled !== true), 'inputs=' + dockUnboundInputs.map(i => String(i.props.disabled)).join(','))

// 模拟外部绑定：改回后轮询感知 → chip 恢复实例名
viewOf.binding = { serviceId: 'S1', instance: { name: 'ProjX', id: 'ProjX@aaaa1111' } }
const c2 = chipOf(await settle(ut.Comp, props, 2))
check('★ 外部绑定后胶囊自动恢复实例名', c2 && c2.label === 'ProjX' && c2.dot === '#30a46c', JSON.stringify(c2))

// 面板内点「锁定」→ post bind 响应 → 立即更新（不等轮询）
// 面板在之前流程已打开；先解绑 mock，重渲染后实例行显示「锁定」按钮
viewOf.binding = null
let utTreeB = await settle(ut.Comp, props, 2)
const lockBtn = buttons(utTreeB).find(b => b.props.children === '锁定')
check('未绑定后面板显示「锁定」按钮', Boolean(lockBtn), 'buttons=' + buttons(utTreeB).map(b => b.props.children).join(','))
const beforeBind = fetched.length
lockBtn.props.onClick()
await new Promise(r => setTimeout(r, 0))
const c3 = chipOf(await settle(ut.Comp, props, 2))
check('★ 面板点「锁定」后胶囊即时显示实例名（不等轮询）', c3 && c3.label === 'ProjX' && c3.dot === '#30a46c' && fetched.slice(beforeBind).some(u => u.includes('/api/bind')), JSON.stringify(c3))
const utTreeC = await settle(ut.Comp, props)
const lockBtn2 = buttons(utTreeC).find(b => b.props.children === '已锁定')
check('面板内实例行变为「已锁定」', Boolean(lockBtn2), 'buttons=' + buttons(utTreeC).map(b => b.props.children).join(','))

// 面板内点「解绑」（底部 actions 区按钮）→ 胶囊即时变回
const beforeUnbind = fetched.length
const unbindBtn = buttons(utTreeC).find(b => b.props.children === '解绑')
check('面板显示「解绑」按钮', Boolean(unbindBtn), 'buttons=' + buttons(utTreeC).map(b => b.props.children).join(','))
unbindBtn.props.onClick()
await new Promise(r => setTimeout(r, 0))
const c4 = chipOf(await settle(ut.Comp, props, 2))
check('★ 面板点「解绑」后胶囊即时变回 Unity', c4 && c4.label === 'Unity' && c4.dot === '#888' && fetched.slice(beforeUnbind).some(u => u.includes('/api/unbind')), JSON.stringify(c4))

// ---------- 并行锁定：实例被其它会话占用时自动 force 重试（v0.4.1） ----------
// 当前未绑定（上条已解绑）；ProjY 被 sess-OTHER 占用：点 ProjY 行的「锁定」
// → 普通 bind 409（"已被会话锁定"）→ 自动 force=true 重试 → 绑定成功
const utTreeF = await settle(ut.Comp, props, 2)
const lockBtns = buttons(utTreeF).filter(b => b.props.children === '锁定')
check('未绑定后面板显示两个「锁定」按钮（ProjX/ProjY 行）', lockBtns.length === 2, 'buttons=' + lockBtns.length)
const beforeForce = fetched.length
lockBtns[1].props.onClick() // ProjY（被占用）
await new Promise(r => setTimeout(r, 0))
const bindCalls = fetched.slice(beforeForce).filter(u => u.includes('/api/bind'))
check('★ 并行锁定：先普通 bind 失败后自动 force 重试（两次 bind 调用）', bindCalls.length === 2, JSON.stringify(bindCalls))
const c5 = chipOf(await settle(ut.Comp, props, 2))
check('★ 并行锁定：胶囊即时显示 ProjY（force 成功）', c5 && c5.label === 'ProjY' && c5.dot === '#30a46c', JSON.stringify(c5))
const utTreeG = await settle(ut.Comp, props)
const lockedRows = buttons(utTreeG).filter(b => b.props.children === '已锁定')
check('面板 ProjY 行变为「已锁定」', lockedRows.length >= 1, 'locked=' + lockedRows.length)

// ---------- 旧轮询快照不覆盖新切换（v0.4.1 修复：开关"过一会自己关掉"） ----------
// 场景：胶囊轮询 /api/status 在用户切换前发出、响应在切换后到达（快照为旧 state）——
// 旧快照不得把用户刚开的开关打回关（storeSet 带 switchSeq 保护 + state 保留语义）。
// 前置：把总开关关掉（serverState.enabled=false）
const dockClose = await settle(dock.Comp, props, 1)
inputs(dockClose)[0].props.onChange({ target: { checked: false } })
await new Promise(r => setTimeout(r, 0))
// refresh 在切换前发出（延迟 30ms 返回旧快照 STATE_OFF），随后用户切总开关开
staleStatus = true
const rr = render(ut.Comp, props)
rr.ctx.effects.forEach(fn => { try { fn() } catch (e) {} }) // refresh 发出（30ms 后回旧快照）
inputs(dockClose)[0].props.onChange({ target: { checked: true } }) // 用户切换：storeSwitch（同步响应）→ store=true + switchSeq+1
await new Promise(r => setTimeout(r, 60)) // 等旧快照响应到达并被 refresh 处理
const dAfter = await settle(dock.Comp, props, 1)
check('★ 旧轮询快照晚到不覆盖新切换：dock 总开关保持开', inputs(dAfter)[0].props.checked === true, JSON.stringify(inputs(dAfter)[0] && inputs(dAfter)[0].props))
const utAfter = await settle(ut.Comp, props, 1)
check('★ 旧轮询快照晚到不覆盖新切换：面板总开关保持开', inputs(utAfter).length === 8 && inputs(utAfter)[0].props.checked === true, JSON.stringify(inputs(utAfter)[0] && inputs(utAfter)[0].props))


console.log(failures === 0 ? '\nALL PASS' : '\nFAILED: ' + failures)
process.exit(failures === 0 ? 0 : 1)
