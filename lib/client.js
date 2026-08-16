// dsh-unity-pool — browser half（v3：全行内样式，零全局副作用）。
//
// 注册到会话头部 utilities 槽（conversation.session.header.utilities）：
// 「Unity」状态胶囊，点击展开贴近按钮的浮窗（无遮罩、toggle 开关）。
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

    function UnityPoolUtility(props) {
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      var wrapRef = useRef(null)
      var [state, setState] = useState({ phase: 'loading', data: null, open: false, error: null, pos: null })

      var refresh = useCallback(function () {
        if (!sessionId) { setState({ phase: 'done', data: null, open: false, error: null }); return }
        fetch(apiUrl('/unity-pool/api/status', sessionId))
          .then(function (r) { return r.json() })
          .then(function (res) {
            if (res && res.ok === true) {
              setState(function (s) { return { phase: 'done', data: res.value, error: null, open: s.open, pos: s.pos } })
            } else {
              setState(function (s) { return { phase: 'done', data: s.data, error: ((res && res.error && res.error.message) || 'status failed'), open: s.open, pos: s.pos } })
            }
          })
          .catch(function () {
            setState(function (s) { return { phase: 'done', data: null, error: 'host api unavailable', open: s.open, pos: s.pos } })
          })
      }, [sessionId])

      // 挂载时拉一次；数据更新靠「刷新」按钮（不轮询，避免高频重渲染）
      useEffect(function () {
        refresh()
      }, [refresh])

      function toggle() { setState(function (s) { return { ...s, open: !s.open } }) }

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

      function post(path, body, then) {
        if (!sessionId) return
        postJson(path, Object.assign({ sessionId: sessionId }, body || {})).then(function (res) {
          if (res && res.ok === true) {
            setState(function (s) { return { ...s, data: res.value.view, error: null, open: true } })
            if (then) then(res.value)
          } else {
            setState(function (s) { return { ...s, error: ((res && res.error && res.error.message) || 'failed') } })
          }
        })
      }
      function lock(instanceId, force) { post('/unity-pool/api/bind', { instance: instanceId, force: Boolean(force) }) }
      function unlock() { post('/unity-pool/api/unbind', {}) }
      function scan() { post('/unity-pool/api/scan', {}) }

      if (!sessionId || state.phase === 'loading') return null
      var data = state.data
      var close = function () { setState(function (s) { return { ...s, open: false } }) }

      var dotColor = '#888'
      var chipLabel = 'Unity'
      if (data && data.binding && data.binding.instance) {
        chipLabel = data.binding.instance.name
        var svc = data.services && data.services.find(function (s) { return s.id === data.binding.serviceId })
        dotColor = (svc && svc.alive === false) ? '#e5484d' : '#30a46c'
      }

      return h('div', { ref: wrapRef, style: S.chip, onClick: toggle, title: 'Unity 服务池：点击展开/收起' },
        h('span', { style: Object.assign({ background: dotColor }, S.dot) }),
        h('span', null, chipLabel),
        state.open && state.pos && h('div', { style: Object.assign({ top: state.pos.top, left: state.pos.left, width: state.pos.width }, S.panel), onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.head },
            h('span', { style: S.ttl }, 'Unity 服务池（本会话）'),
            h('button', { style: S.close, onClick: close, title: '关闭' }, '✕')
          ),
          renderPanel(data, state.error, lock, unlock, scan, refresh)
        )
      )
    }

    function renderPanel(data, error, lock, unlock, scan, refresh) {
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
      },
    }
  },
})
