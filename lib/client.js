// dsh-unity-pool — browser half（v3：全行内样式，零全局副作用）。
//
// 注册到会话头部 utilities 槽（conversation.session.header.utilities）：
// 「Unity」状态胶囊，点击展开贴近按钮的浮窗（无遮罩、toggle 开关）。
// v0.4.0 UX：另注册输入框上方 dock 槽（conversation.input.dock）——
// 「Unity 状态携带」快速开关条（总开关 + 7 项子开关），贴近输入框、随时按需开/关。
// 所有样式使用 React 行内 style（不再注入 <style> 标签）——
// 此前全局 <style> 注入被实测会影响其它插件（折叠条样式失效），行内样式物理隔离。
window.__ModuleLoader__.load({
  id: 'dsh-unity-pool',
  factory: function (require) {
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    // ---- 行内样式（与 --dsw-* 主题变量一致的 fallback 值） ----
    var S = {
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 999, background: 'transparent', color: 'var(--dsw-alias-label-secondary,#999)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: 1.8, whiteSpace: 'nowrap', position: 'relative' },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
      panel: { position: 'fixed', zIndex: 2000, maxWidth: '92vw', maxHeight: '70vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,#1f1f1f)', border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,.4)', padding: '10px 12px', font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)', textAlign: 'left' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l1,#88888866)' },
      ttl: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary,inherit)' },
      close: { font: 'inherit', fontSize: 14, lineHeight: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer' },
      svc: { marginTop: 6, padding: '4px 6px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#ffffff0a)' },
      svcHead: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--dsw-alias-label-secondary,#bbb)', padding: '2px 0' },
      svcName: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      svcUrl: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#888)', flex: '0 0 auto' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6, margin: '1px 0' },
      nm: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary,inherit)' },
      sub: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#888)', flex: '0 0 auto' },
      badge: { fontSize: 10, padding: '1px 5px', borderRadius: 999, flex: '0 0 auto' },
      btn: { flex: '0 0 auto', font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer' },
      btnDisabled: { opacity: 0.4, cursor: 'default' },
      actions: { display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 2px' },
      hint: { marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1,#88888866)', color: 'var(--dsw-alias-label-tertiary,#888)', fontSize: 11, wordBreak: 'break-all' },
      empty: { color: 'var(--dsw-alias-label-tertiary,#888)', padding: '8px 4px', fontSize: 11 },
      sub1: { color: 'var(--dsw-alias-label-secondary,#999)', fontSize: 11, marginBottom: 4 },
      err: { color: '#e5484d', fontSize: 11, marginTop: 4 },
      caret: { fontSize: 9, opacity: 0.7 },
      activeBadge: { background: 'var(--dsw-alias-state-success-primary,#16a34a)', color: '#fff' },
      busyBadge: { background: 'var(--dsw-alias-state-warning-primary,#f5a623)', color: '#111' },
      stateRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6, margin: '1px 0' },
      stateRowDisabled: { opacity: 0.45 },
      stateHint: { marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--dsw-alias-border-l1,#88888855)', color: 'var(--dsw-alias-label-tertiary,#888)', fontSize: 10, wordBreak: 'break-all' },
      toggleWrap: { position: 'relative', display: 'inline-block', width: 30, height: 16, flex: '0 0 auto', cursor: 'pointer' },
      toggleInput: { position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: 'pointer' },
      // 轨道关/开色为写死值（不用主题变量）：与 DSH 浅色(#ffffff)/深色(#232324)主题背景的 HSV 距离均 ≥30
      // （2026-08-20 用户要求；原 #ffffff1f 半透明白在深色下仅差 ~10，开关几乎不可见）
      toggleTrack: { position: 'absolute', inset: 0, borderRadius: 999, background: '#888888', transition: 'background .15s' },
      toggleTrackOn: { background: '#22c55e' },
      toggleKnob: { position: 'absolute', top: 2, left: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left .15s' },
      dockWrap: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 10, color: 'var(--dsw-alias-label-secondary,#999)', padding: '1px 0', maxWidth: '100%', boxSizing: 'border-box' },
      dockLbl: { display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-label-tertiary,#888)', whiteSpace: 'nowrap', fontSize: 10 },
      dockChip: { flex: '0 1 auto', font: 'inherit', fontSize: 10, lineHeight: 1.7, padding: '0 6px', borderRadius: 999, border: '1px solid #888888', background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background .15s, color .15s' },
      dockChipOn: { background: '#22c55e', borderColor: '#22c55e', color: '#fff' },
      dockDisabled: { opacity: 0.45, cursor: 'default', pointerEvents: 'none' },
    }

    function apiUrl(path, sessionId) {
      return path + '?sessionId=' + encodeURIComponent(sessionId || '')
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    // ---- 客户端共享状态源（v0.4.1）----
    // 背景：头部「Unity」面板与输入条 dock 两处开关曾各自 useState + 各自拉取/轮询
    // （面板不轮询、dock 5s 轮询），一边切换另一边最多延迟 5s，表现为「开关不同步」。
    // 现在：模块级轻量 pub-sub store（按 sessionId 分槽）——两处组件都从 store 读，
    // 任何一处切换成功后立即写 store 广播，两处即时同步；5s 轮询仅作兜底
    // （外部变化：其它标签页 / HTTP /api/state-switch 直改）。
    var stateStore = { data: {}, seq: 0, switchSeq: 0, listeners: [] }
    function storeGet(sessionId) {
      var v = stateStore.data[sessionId]
      return v ? { state: v.state, binding: v.binding, bound: !!v.binding } : null
    }
    /** 写入共享状态；state/binding 传 undefined 表示保留旧值（仅更新另一项时用），
     *  state 传 null 表示清空、binding 传 null 表示清除（解绑）。 */
    function storeSet(sessionId, state, binding) {
      var prev = stateStore.data[sessionId] || {}
      stateStore.data[sessionId] = {
        state: state === undefined ? prev.state : state,
        binding: binding === undefined ? prev.binding : binding,
      }
      stateStore.seq++
      var ls = stateStore.listeners.slice()
      for (var i = 0; i < ls.length; i++) { try { ls[i]() } catch (e) {} }
    }
    /** 从 view（/api/status 或 /api/state 的 view）提取精简绑定信息；未绑定返回 null。 */
    function extractBinding(view) {
      var b = view && view.binding
      if (!b || !b.instance) return null
      var svc = Array.isArray(view.services) ? view.services.find(function (s) { return s.id === b.serviceId }) : null
      return {
        serviceId: b.serviceId,
        instanceId: b.instanceId || (b.instance && b.instance.id),
        instanceName: b.instance.name || b.instance.id,
        serviceName: (svc && svc.name) || (b.service && b.service.name) || b.serviceId,
        alive: svc ? svc.alive !== false : true,
      }
    }
    function storeSubscribe(fn) {
      stateStore.listeners.push(fn)
      return function () {
        var i = stateStore.listeners.indexOf(fn)
        if (i >= 0) stateStore.listeners.splice(i, 1)
      }
    }
    /** 拉取 /api/state 写入 store。switchSeq 过期保护：仅用户切换（storeSwitch）会使在途旧快照失效，
     *  其它入口的刷新（refresh/storeLoad 的 storeSet）不互相干扰——否则两组件挂载/轮询竞争时
     *  dock 首次加载会因 seq 被刷新超越而永远不渲染（2026-08-20 实测「开关消失」根因）。
     *  注意：/api/state 响应 value = {sessionId, cache, view}，state 在 view.state（曾误读 v.state
     *  导致每次轮询把 store 写成 null、dock 开关"过一会自己灭"——2026-08-20 实测根因）。 */
    function storeLoad(sessionId) {
      var my = stateStore.switchSeq
      return fetch(apiUrl('/unity-pool/api/state', sessionId)).then(function (r) { return r.json() }).then(function (res) {
        if (!(res && res.ok === true && res.value)) return null
        var view = res.value.view || {}
        if (stateStore.switchSeq === my) {
          storeSet(sessionId, view.state || null, extractBinding(view))
          return res.value
        }
        // 切换后旧快照不覆盖：返回 store 当前值（stale 标记），组件照样完成首次加载
        return storeGet(sessionId) ? { ok: true, stale: true } : null
      }).catch(function () { return null })
    }
    /** 切换开关：state-switch 返回服务端确认后的最新状态，直接写入并广播（权威）；并递增 switchSeq 使在途旧快照失效。 */
    function storeSwitch(sessionId, key, checked) {
      return postJson('/unity-pool/api/state-switch', { sessionId: sessionId, key: key, value: checked }).then(function (res) {
        if (res && res.ok === true && res.value && res.value.state) {
          storeSet(sessionId, res.value.state)
          stateStore.switchSeq++
          return res.value.state
        }
        return null
      })
    }
    /** 组件订阅 store：变化时强制重渲染，读到的即最新共享状态（等效单向绑定）。 */
    function useStoreState(sessionId) {
      var t = useState(0)
      var force = t[1]
      useEffect(function () { return storeSubscribe(function () { force(function (n) { return n + 1 }) }) }, [sessionId])
      return storeGet(sessionId)
    }

    function UnityPoolUtility(props) {
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      var wrapRef = useRef(null)
      var [state, setState] = useState({ phase: 'loading', data: null, open: false, error: null, pos: null })
      // 共享状态源订阅（v0.4.1）：输入条/面板任一处切换开关，本组件即时重渲染，两处始终同源
      var storeState = useStoreState(sessionId)

      // 加载 /api/status（seq 过期保护：绑定/解绑/新轮询后丢弃在途旧响应，避免回退旧锁定态）
      var reqSeq = useRef(0)
      var refresh = useCallback(function () {
        if (!sessionId) { setState({ phase: 'done', data: null, open: false, error: null }); return }
        var my = ++reqSeq.current
        var sw = stateStore.switchSeq // 发起时的切换序号：期间有用户切换则旧快照不覆盖 store 的 state
        fetch(apiUrl('/unity-pool/api/status', sessionId))
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (my !== reqSeq.current) return
            if (res && res.ok === true) {
              if (stateStore.switchSeq === sw) {
                // 期间无用户切换：正常写入 state + binding
                storeSet(sessionId, res.value.state || null, extractBinding(res.value))
              } else {
                // 期间有用户切换（开关刚被改）：旧快照的 state 不覆盖（只更新 binding），
                // 否则轮询响应晚到会把用户刚开的开关“打回关”（2026-08-20 实测）
                storeSet(sessionId, undefined, extractBinding(res.value))
              }
              setState(function (s) { return { phase: 'done', data: res.value, error: null, open: s.open, pos: s.pos } })
            } else {
              setState(function (s) { return { phase: 'done', data: s.data, error: ((res && res.error && res.error.message) || 'status failed'), open: s.open, pos: s.pos } })
            }
          })
          .catch(function () {
            if (my !== reqSeq.current) return
            setState(function (s) { return { phase: 'done', data: null, error: 'host api unavailable', open: s.open, pos: s.pos } })
          })
      }, [sessionId])

      // 挂载拉一次 + 每 5s 轻轮询（v0.4.1：agent 工具/其它标签页/面板按钮的绑定、解绑变化自动反映到胶囊，无需手动刷新）
      useEffect(function () {
        if (!sessionId) return
        refresh()
        var timer = setInterval(refresh, 5000)
        return function () { clearInterval(timer) }
      }, [refresh])

      function toggle() {
        // 打开弹窗时强制重拉一次，保证与输入条开关实时同步（弹窗不轮询）
        if (!state.open) refresh()
        setState(function (s) { return { ...s, open: !s.open } })
      }

      // 打开时计算一次贴近按钮的位置
      useEffect(function () {
        if (!state.open) return
        function measurePos() {
          var chip = wrapRef.current
          if (!chip) return null
          var r = chip.getBoundingClientRect()
          var width = 440
          var left = r.right - width
          if (left < 8) left = 8
          return { top: r.bottom + 6, left: left, width: width }
        }
        setState(function (s) { return { ...s, pos: measurePos() } })
      }, [state.open])

      function post(path, body, then, onError) {
        if (!sessionId) return
        var my = ++reqSeq.current // 使在途轮询响应过期，避免旧快照回退本次绑定/解绑
        var sw = stateStore.switchSeq // 期间有用户切换则响应里的旧 state 不覆盖 store
        postJson(path, Object.assign({ sessionId: sessionId }, body || {})).then(function (res) {
          if (my !== reqSeq.current) return
          if (res && res.ok === true) {
            // view 里的状态与绑定信息同步进共享 store（v0.4.1）
            if (stateStore.switchSeq === sw) {
              storeSet(sessionId, (res.value.view && res.value.view.state) || null, extractBinding(res.value.view))
            } else {
              storeSet(sessionId, undefined, extractBinding(res.value.view))
            }
            setState(function (s) { return { ...s, data: res.value.view, error: null, open: true } })
            if (then) then(res.value)
          } else {
            var msg = ((res && res.error && res.error.message) || 'failed')
            setState(function (s) { return { ...s, error: msg } })
            if (onError) onError(msg)
          }
        })
      }
      function lock(instanceId) {
        // 普通绑定；若实例已被其它会话锁定（并行开发场景），自动以 force=true 重试一次
        post('/unity-pool/api/bind', { instance: instanceId, force: false }, null, function (msg) {
          if (!/已被会话/.test(msg)) return
          setState(function (s) { return { ...s, error: msg + ' → 自动以强制模式并行锁定…' } })
          post('/unity-pool/api/bind', { instance: instanceId, force: true }, null, function (msg2) {
            setState(function (s) { return { ...s, error: '强制锁定失败：' + msg2 } })
          })
        })
      }
      function unlock() { post('/unity-pool/api/unbind', {}) }
      function scan() { post('/unity-pool/api/scan', {}) }
      // 状态携带开关（v0.4.0）：运行时切换，不重启；走共享 store（v0.4.1 两处即时同步）
      function toggleState(key, checked) {
        if (!sessionId) return
        storeSwitch(sessionId, key, checked).then(function (state) {
          if (state) {
            setState(function (s) { return { ...s, data: Object.assign({}, s.data, { state: state }), error: null } })
          } else {
            setState(function (s) { return { ...s, error: 'state switch failed' } })
          }
        })
      }

      if (!sessionId || state.phase === 'loading') return null
      var data = state.data
      // 开关状态优先取共享 store（与输入条同源），无 store 数据时回退 status 快照（v0.4.1）
      if (data && storeState && storeState.state) {
        data = Object.assign({}, data, { state: storeState.state })
      }
      var close = function () { setState(function (s) { return { ...s, open: false } }) }

      var dotColor = '#888'
      var chipLabel = 'Unity'
      // 绑定态优先取共享 store（agent 工具/其它入口的变化经轮询同步进来），无则回退本组件快照（v0.4.1）
      var chipBinding = (storeState && storeState.binding) || (data && data.binding) || null
      if (chipBinding) {
        if (storeState && storeState.binding) {
          chipLabel = storeState.binding.instanceName
          dotColor = storeState.binding.alive ? '#30a46c' : '#e5484d'
        } else if (data) {
          chipLabel = data.binding.instance.name
          var svc = data.services && data.services.find(function (s) { return s.id === data.binding.serviceId })
          dotColor = (svc && svc.alive === false) ? '#e5484d' : '#30a46c'
        }
      }

      return h('div', { ref: wrapRef, style: S.chip, onClick: toggle, title: 'Unity 服务池：点击展开/收起' },
        h('span', { style: Object.assign({ background: dotColor }, S.dot) }),
        h('span', null, chipLabel),
        state.open && state.pos && h('div', { style: Object.assign({ top: state.pos.top, left: state.pos.left, width: state.pos.width }, S.panel), onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.head },
            h('span', { style: S.ttl }, 'Unity 服务池（本会话）'),
            h('button', { style: S.close, onClick: close, title: '关闭' }, '✕')
          ),
          renderPanel(data, state.error, lock, unlock, scan, refresh, toggleState)
        )
      )
    }

    // 状态携带开关项定义（v0.4.0，key → 中文名）
    var STATE_SWITCHES = [
      { key: 'stateGameScreenshot', label: 'Game 截图' },
      { key: 'stateSceneScreenshot', label: 'Scene 截图' },
      { key: 'stateSelection', label: '当前选中项' },
      { key: 'stateUiSnapshot', label: 'ui-snapshot' },
      { key: 'stateSerialized', label: '序列化字段' },
      { key: 'stateConsoleAll', label: 'Console 全文' },
      { key: 'stateConsoleSelected', label: 'Console 选中' },
    ]

    function renderStateSection(data, toggleState) {
      var st = data && data.state
      if (!st) return null
      var enabled = st.enabled === true
      var cache = st.cache
      var entries = (cache && Array.isArray(cache.entries)) ? cache.entries : null
      var cacheLine = entries
        ? '上次采集 ' + new Date(cache.at).toLocaleTimeString('zh-CN', { hour12: false }) + '：' + entries.map(function (e) { return e.label + (e.ok ? '✓' : '✗') }).join(' ')
        : '未采集（绑定后自动采集）'
      var rows = [h('div', { key: 'master', style: S.stateRow },
        h('span', { style: S.nm }, '总开关（每次指令携带状态）'),
        h('label', { style: S.toggleWrap },
          h('input', { type: 'checkbox', checked: enabled, onChange: function (e) { toggleState('stateEnabled', e.target.checked) }, style: S.toggleInput }),
          h('span', { style: Object.assign({}, S.toggleTrack, enabled ? S.toggleTrackOn : null) }),
          h('span', { style: Object.assign({}, S.toggleKnob, enabled ? { left: 16 } : null) })
        )
      )]
      STATE_SWITCHES.forEach(function (sw) {
        var on = st.switches && st.switches[sw.key] === true
        rows.push(h('div', { key: sw.key, style: Object.assign({}, S.stateRow, !enabled ? S.stateRowDisabled : null) },
          h('span', { style: S.nm }, sw.label),
          h('label', { style: S.toggleWrap },
            h('input', { type: 'checkbox', checked: on, disabled: !enabled, onChange: function (e) { toggleState(sw.key, e.target.checked) }, style: S.toggleInput }),
            h('span', { style: Object.assign({}, S.toggleTrack, on ? S.toggleTrackOn : null) }),
            h('span', { style: Object.assign({}, S.toggleKnob, on ? { left: 16 } : null) })
          )
        ))
      })
      return h('div', { style: S.svc },
        h('div', { style: S.svcHead },
          h('span', null, '状态携带（默认关）'),
          h('span', { style: S.sub }, '每轮指令注入 Unity 状态')
        ),
        rows,
        h('div', { style: S.stateHint }, cacheLine)
      )
    }

    // 输入框上方 Dock 条（v0.4.0 UX）：状态携带快速开关，贴近输入框、按需开/关。
    // 挂 conversation.input.dock（list，session 作用域），props.sessionId 由标准 props 提供。
    // 紧凑短标签（按 key 映射，避免把整条撑出会话内容区；完整名称在悬浮提示/头部面板）。
    var DOCK_SWITCH_LABELS = {
      stateGameScreenshot: 'Game',
      stateSceneScreenshot: 'Scene',
      stateSelection: '选中',
      stateUiSnapshot: '快照',
      stateSerialized: '序列化',
      stateConsoleAll: 'Console全',
      stateConsoleSelected: 'Console选',
    }
    function UnityPoolStateDock(props) {
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      var [st, setSt] = useState({ loaded: false })
      // 共享状态源（v0.4.1）：开关值与绑定态都从 store 读，任一处切换即时同步
      var storeState = useStoreState(sessionId)
      var stVal = storeState || { state: null, bound: false }

      // 挂载拉一次 + 每 5s 轻量轮询兜底（外部变化：其它标签页/HTTP 直改）；
      // 切换本身走 storeSwitch 即时广播，不依赖轮询。storeLoad 内部有 seq 过期保护，
      // 切换前发出的在途旧快照不会覆盖新状态（不再需要组件级 reqSeq）。
      useEffect(function () {
        if (!sessionId) { setSt({ loaded: true }); return }
        var stopped = false
        function load() {
          storeLoad(sessionId).then(function (v) {
            if (stopped || !v) return
            setSt(function (s) { return s.loaded ? s : { loaded: true } })
          })
        }
        load()
        var timer = setInterval(load, 5000)
        return function () { stopped = true; clearInterval(timer) }
      }, [sessionId])

      if (!st.loaded || !sessionId) return null
      var state = stVal.state
      var enabled = !!(state && state.enabled === true)
      var switches = (state && state.switches) || {}
      var cache = state && state.cache
      var bound = stVal.bound === true

      function switchIt(key, checked) {
        if (!sessionId) return
        storeSwitch(sessionId, key, checked) // 成功即广播；本组件经 store 订阅自动重渲染
      }

      var cacheText = '未采集'
      if (cache && cache.at) {
        var entries = Array.isArray(cache.entries) ? cache.entries : []
        var okCount = entries.filter(function (e) { return e.ok === true }).length
        cacheText = '采集于 ' + new Date(cache.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' · ' + entries.length + ' 项，成功 ' + okCount + ' 项'
      }

      var subDisabled = !bound || !enabled
      var chipCells = STATE_SWITCHES.map(function (sw) {
        var on = enabled && switches[sw.key] === true
        var short = DOCK_SWITCH_LABELS[sw.key] || sw.label
        var style = Object.assign({}, S.dockChip, on ? S.dockChipOn : null, subDisabled ? S.dockDisabled : null)
        return h('button', {
          key: sw.key,
          type: 'button',
          style: style,
          title: sw.label + (on ? '（开）' : '（关）') + (bound ? '' : '，未绑定 Unity 实例'),
          disabled: !bound,
          onClick: function () { switchIt(sw.key, !on) },
        }, short)
      })

      return h('div', { style: S.dockWrap, title: 'Unity 状态携带：每次发出指令自动注入勾选项；当前' + (enabled ? '开' : '关') + '。' + cacheText + '。截图落盘本地，正文只带文件路径' },
        h('span', { style: S.dockLbl },
          h('span', null, 'Unity'),
          h('label', { style: S.toggleWrap, title: bound ? (enabled ? '总开关：每次指令携带状态（开）' : '总开关：不携带状态（关）') : '先绑定 Unity 实例再开启' },
            h('input', { type: 'checkbox', checked: enabled, disabled: !bound, onChange: function (e) { switchIt('stateEnabled', e.target.checked) }, style: S.toggleInput }),
            h('span', { style: Object.assign({}, S.toggleTrack, enabled ? S.toggleTrackOn : null) }),
            h('span', { style: Object.assign({}, S.toggleKnob, enabled ? { left: 16 } : null) })
          ),
          h('span', null, bound ? '状态携带' : '未绑定 Unity')
        ),
        chipCells
      )
    }

    function renderPanel(data, error, lock, unlock, scan, refresh, toggleState) {
      var binding = data && data.binding
      var current = binding && binding.instance ? binding.instance : null
      var curSvc = binding && binding.service ? binding.service : null

      var svcBlocks = []
      if (data && Array.isArray(data.services)) {
        data.services.forEach(function (s) {
          var rows = []
          if (Array.isArray(s.instances)) {
            s.instances.forEach(function (inst) {
              var active = inst.active === true
              rows.push(
                h('div', { key: s.id + ':' + inst.id, style: S.row },
                  h('span', { style: Object.assign({ background: active ? '#30a46c' : s.alive === false ? '#e5484d' : '#888' }, S.dot) }),
                  h('span', { style: S.nm, title: inst.id + ' (' + inst.hash + ')' }, inst.name),
                  h('span', { style: S.sub }, inst.hash),
                  active && h('span', { style: Object.assign({}, S.badge, S.activeBadge) }, '本会话'),
                  h('button', {
                    style: active ? Object.assign({}, S.btn, S.btnDisabled) : S.btn,
                    disabled: active,
                    onClick: function () { lock(inst.id) },
                  }, active ? '已锁定' : '锁定')
                )
              )
            })
          }
          if (!rows.length && s.alive === false) {
            rows.push(h('div', { key: s.id + ':off', style: S.empty }, '服务离线'))
          } else if (!rows.length) {
            rows.push(h('div', { key: s.id + ':none', style: S.empty }, '暂无实例（点「扫描」发现）'))
          }
          svcBlocks.push(
            h('div', { key: s.id, style: S.svc },
              h('div', { style: S.svcHead },
                h('span', { style: Object.assign({ background: s.alive === false ? '#e5484d' : '#30a46c' }, S.dot) }),
                h('span', { style: S.svcName }, s.name),
                h('span', { style: S.svcUrl }, String(s.url || '').replace(/^https?:\/\//, ''))
              ),
              rows
            )
          )
        })
      }

      return h('div', null,
        h('div', { style: S.sub1 },
          current
            ? '已锁定：' + current.name + ' @ ' + (curSvc ? curSvc.name : binding.serviceId)
            : '未锁定实例（unity_pool_bind 或点下方「锁定」）'
        ),
        svcBlocks,
        renderStateSection(data, toggleState),
        error && h('div', { style: S.err }, error),
        h('div', { style: S.actions },
          current && h('button', { style: S.btn, onClick: unlock }, '解绑'),
          h('button', { style: S.btn, onClick: scan }, '扫描'),
          h('button', { style: S.btn, onClick: refresh }, '刷新')
        ),
        data && data.connectHint ? h('div', { style: S.hint, title: data.connectHint }, '提示：' + data.connectHint) : null
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        // 零全局副作用：不注入 <style>，全部行内样式
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'unity-pool', order: 110, label: 'Unity' },
            UnityPoolUtility
          )
        })
        // 输入框上方快速开关条（v0.4.0 UX）
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            { name: 'conversation.input.dock', id: 'unity-pool', order: 90, label: 'Unity 状态携带' },
            UnityPoolStateDock
          )
        })
      },
    }
  },
})
