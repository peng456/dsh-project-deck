// dsh-project-deck client half: 在 DSH 界面里嵌入项目甲板 Project Deck（deck 面板）。
// 面板本体是独立进程（~/.project-deck/bin/panel.py，http://127.0.0.1:9199），
// 这里用 iframe 内嵌，避免在插件里重复实现一遍 UI。
window.__ModuleLoader__.load({
  id: 'dsh-project-deck',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const PANEL = 'http://127.0.0.1:9199'

    // 兼容读取可选服务（uiWorkspace 在 0.1.6+，旧版回退 sessions）
    function optionalService(ctx, name) {
      try {
        const value = ctx && ctx.get ? ctx.get(name) : undefined
        if (value != null) return value
      } catch { /* get 异常时继续属性访问 */ }
      try { return (ctx && ctx[name]) || null } catch { return null }
    }

    // 自定义深链：#deck-session=<id>（DSH 本身没有 URL scheme / 会话路由，
    // 所以由插件读 hash 后自己跳；链接对普通浏览器也可用）
    function readDeepLink() {
      try {
        const hash = String(window.location.hash || '')
        const m = hash.match(/deck-session=([^&]+)/)
        if (m) return { kind: 'session', value: decodeURIComponent(m[1]) }
        const p = hash.match(/deck-project=([^&]+)/)
        if (p) return { kind: 'project', value: decodeURIComponent(p[1]) }
        return null
      } catch { return null }
    }

    function clearDeepLink() {
      try {
        if (/deck-session=/.test(window.location.hash)) {
          history.replaceState(null, '', window.location.pathname + window.location.search)
        }
      } catch { /* 忽略 */ }
    }

    function sessionKnown(ctx, sessionId) {
      const sessions = optionalService(ctx, 'sessions')
      if (!sessions) return false
      try {
        const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null
        if (snap && snap.byId && snap.byId[sessionId]) return true
        if (sessions.binding && sessions.binding(sessionId)) return true
      } catch { /* 忽略 */ }
      return false
    }

    function findWorkspaceByPath(ctx, root) {
      const ws = optionalService(ctx, 'workspaces')
      try {
        const snap = ws && ws.list ? ws.list.getSnapshot() : null
        const items = (snap && snap.items) || []
        return items.find((w) => w.path === root) || null
      } catch { return null }
    }

    function openProjectWith(ctx, payload) {
      const uw = optionalService(ctx, 'uiWorkspace')
      if (!uw) return Promise.resolve(false)
      if (payload.sessionId && sessionKnown(ctx, payload.sessionId)) {
        return Promise.resolve(openSessionWith(ctx, payload.sessionId))
      }
      // 没有会话：找到 workspace（没有就创建），再开会话
      const existing = findWorkspaceByPath(ctx, payload.root)
      const ensureWorkspace = existing
        ? Promise.resolve(existing)
        : (optionalService(ctx, 'workspaces') && optionalService(ctx, 'workspaces').create
            ? optionalService(ctx, 'workspaces').create({ path: payload.root }).catch(() => null)
            : Promise.resolve(null))
      return ensureWorkspace.then((ws) => {
        const wid = ws && ws.workspaceId
        if (!wid || typeof uw.openWorkspace !== 'function') return false
        return uw.openWorkspace(wid).then(() => true).catch(() => false)
      })
    }

    function openSessionWith(ctx, sessionId) {
      const uw = optionalService(ctx, 'uiWorkspace')
      if (uw && typeof uw.openSession === 'function') {
        try { uw.openSession(sessionId); return true } catch (e) { console.warn('[dsh-project-deck] uiWorkspace.openSession 失败', e) }
      }
      const sessions = optionalService(ctx, 'sessions')
      if (sessions && typeof sessions.open === 'function') {
        try { sessions.open(sessionId); return true } catch (e) { console.warn('[dsh-project-deck] sessions.open 失败', e) }
      }
      console.warn('[dsh-project-deck] 没有可用的会话导航服务（uiWorkspace / sessions 都不可用）')
      return false
    }

    const css = `
.deck-fab{position:fixed;left:16px;bottom:18px;z-index:120;pointer-events:auto;touch-action:none;cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;
  width:46px;height:46px;border-radius:50%;border:1px solid rgba(53,208,186,.45);cursor:pointer;
  background:linear-gradient(180deg,#12303a,#0f1e1d);color:#7ce7da;font-size:20px;line-height:1;
  box-shadow:0 10px 24px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.2);transition:filter .12s,transform .12s;
  font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:0}
.deck-fab:hover{filter:brightness(1.12);transform:translateY(-1px)}
.deck-fab:active{cursor:grabbing}
.deck-fab:active{transform:translateY(0)}
.deck-mask{position:fixed;inset:0;z-index:130;background:rgba(4,8,12,.62);display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.deck-box{width:min(1180px,94vw);height:min(860px,88vh);background:#0b0f14;border:1px solid #1f2a37;border-radius:14px;
  display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.deck-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1f2a37;
  background:#0f151d;color:#e6edf3;font:600 13px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif}
.deck-head .dot{width:8px;height:8px;border-radius:50%;background:#3ddc97;box-shadow:0 0 8px rgba(61,220,151,.7)}
.deck-head .sp{flex:1}
.deck-head a,.deck-head button{color:#8b98a5;background:none;border:1px solid #1f2a37;border-radius:7px;
  padding:4px 10px;font-size:12px;cursor:pointer;text-decoration:none;font-family:inherit}
.deck-head a:hover,.deck-head button:hover{color:#e6edf3;border-color:#2bb8a5}
.deck-frame{flex:1;width:100%;border:0;background:#0b0f14}
.deck-tip{padding:8px 14px;color:#6f7d8a;font:11px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;border-top:1px solid #1a232d}
`

    if (typeof document !== 'undefined' && !document.getElementById('dsh-project-deck-style')) {
      const style = document.createElement('style')
      style.id = 'dsh-project-deck-style'
      style.textContent = css
      document.head.appendChild(style)
    }

    function Panel(props) {
      const appCtx = props && props.appCtx
      const [open, setOpen] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const frameRef = React.useRef(null)

      // 悬浮按钮可拖到页面任意位置（位置持久化）
      const [pos, setPos] = React.useState(() => {
        try { const v = JSON.parse(localStorage.getItem('deck-fab-pos') || 'null'); return v && typeof v.x === 'number' ? v : null } catch { return null }
      })
      const drag = React.useRef(null)
      const moved = React.useRef(false)

      const clamp = (x, y) => ({
        x: Math.max(6, Math.min(x, window.innerWidth - 54)),
        y: Math.max(6, Math.min(y, window.innerHeight - 54)),
      })

      const onPointerDown = (e) => {
        drag.current = { dx: e.clientX - (pos ? pos.x : 16), dy: e.clientY - (pos ? pos.y : window.innerHeight - 64) }
        moved.current = false
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onPointerMove = (e) => {
        if (!drag.current) return
        const nx = e.clientX - drag.current.dx
        const ny = e.clientY - drag.current.dy
        if (Math.abs(nx - (pos ? pos.x : 16)) > 4 || !pos) moved.current = true
        setPos(clamp(nx, ny))
      }
      const onPointerUp = (e) => {
        if (!drag.current) return
        drag.current = null
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
        setPos((cur) => {
          if (cur) { try { localStorage.setItem('deck-fab-pos', JSON.stringify(cur)) } catch {} }
          return cur
        })
      }
      const fabStyle = pos
        ? { left: pos.x + 'px', top: pos.y + 'px', bottom: 'auto', right: 'auto' }
        : undefined

      // 面板（iframe，127.0.0.1:9199）点「最近会话」时 postMessage 过来，在这里跳到对应会话
      React.useEffect(() => {
        const onMessage = (e) => {
          if (e.origin !== PANEL) return
          const data = e.data || {}
          if (data.type === 'dsh-project-deck:open-project') {
            openProjectWith(appCtx, { root: String(data.root || ''), sessionId: data.sessionId ? String(data.sessionId) : null })
              .then((ok) => {
                console.log('[dsh-project-deck] open-project', data.project, 'ok=', ok)
                try {
                  const frame = document.querySelector('iframe.deck-frame')
                  if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'dsh-project-deck:open-result', ok, project: data.project }, PANEL)
                  }
                } catch (err) { /* 忽略 */ }
                if (ok) setOpen(false)
              })
            return
          }
          if (data.type !== 'dsh-project-deck:open-session' || !data.sessionId) return
          const ok = openSessionWith(appCtx, String(data.sessionId))
          console.log('[dsh-project-deck] open-session request', data.sessionId, 'ok=', ok)
          try {
            const frame = document.querySelector('iframe.deck-frame')
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({ type: 'dsh-project-deck:open-result', ok, sessionId: data.sessionId }, PANEL)
            }
          } catch (e) { console.warn('[dsh-project-deck] 回传结果失败', e) }
          if (ok) setOpen(false)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [appCtx])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const openPanel = () => { setLoaded(false); setOpen(true) }

      return h(React.Fragment, null,
        h('button', {
          className: 'deck-fab',
          title: '项目甲板 Project Deck（项目 / 播报 / 节点）',
          onClick: openPanel,
        }, '\u{1F4CB}'),
        open
          ? h('div', { className: 'deck-mask', onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) } },
              h('div', { className: 'deck-box' },
                h('div', { className: 'deck-head' },
                  h('span', { className: 'dot' }),
                  h('span', null, '项目甲板 Project Deck'),
                  h('span', { className: 'sp' }),
                  h('a', { href: PANEL, target: '_blank', rel: 'noreferrer' }, '新窗口'),
                  h('button', { onClick: () => setOpen(false) }, '关闭'),
                ),
                h('iframe', {
                  ref: frameRef,
                  className: 'deck-frame',
                  src: PANEL,
                  title: 'deck panel',
                  onLoad: () => setLoaded(true),
                }),
                h('div', { className: 'deck-tip' },
                  loaded
                    ? '面板由 ~/.project-deck/bin/panel.py 提供（127.0.0.1:9199）'
                    : '正在连接面板… 若长时间空白，请在终端运行 deck status 检查服务是否在跑',
                ),
              ),
            )
          : null,
      )
    }

    exports.name = 'dsh-project-deck'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) {
        console.error('[dsh-project-deck] slots 服务不可用')
        return
      }
      // 深链：支持 #deck-session=<id>（会话）与 #deck-project=<路径>（项目→开会话）。
      // 刚加载时会话列表还没拉回来，直接 open 会被丢掉，所以要等就绪后重试。
      let deepLinkTimer = null
      const finishDeepLink = (label) => {
        clearDeepLink()
        console.log('[dsh-project-deck] deep link opened', label)
      }
      const tryDeepLink = (target, attempt) => {
        const cur = readDeepLink()
        if (!cur || cur.kind !== target.kind || cur.value !== target.value) return
        if (target.kind === 'session') {
          if (sessionKnown(ctx, target.value)) {
            if (openSessionWith(ctx, target.value)) { finishDeepLink(target.value); return }
          }
        } else {
          openProjectWith(ctx, { root: target.value, sessionId: null }).then((ok) => {
            if (ok) finishDeepLink(target.value)
            else if (attempt < 50) deepLinkTimer = setTimeout(() => tryDeepLink(target, attempt + 1), 400)
            else console.warn('[dsh-project-deck] deep link 放弃：workspace 创建/打开失败', target.value)
          })
          return
        }
        if (attempt >= 50) {
          console.warn('[dsh-project-deck] deep link 放弃：会话未出现在列表里', target.value)
          return
        }
        deepLinkTimer = setTimeout(() => tryDeepLink(target, attempt + 1), 400)
      }
      const onDeepLink = () => {
        const target = readDeepLink()
        if (!target) return
        if (deepLinkTimer) clearTimeout(deepLinkTimer)
        tryDeepLink(target, 0)
      }
      onDeepLink()
      window.addEventListener('hashchange', onDeepLink)

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'deck-panel', order: 6, label: '项目甲板' },
        (props) => h(Panel, Object.assign({}, props, { appCtx: ctx })),
      ))
      console.log('[dsh-project-deck] client ready')
    }
    return module.exports
  },
})
