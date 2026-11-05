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
.deck-fab{position:fixed;right:18px;bottom:112px;left:auto;z-index:120;position:fixed;pointer-events:auto;touch-action:none;cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;
  width:46px;height:46px;border-radius:50%;border:1px solid rgba(53,208,186,.45);cursor:pointer;
  background:linear-gradient(180deg,#12303a,#0f1e1d);color:#7ce7da;font-size:20px;line-height:1;
  box-shadow:0 10px 24px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.2);transition:filter .12s,transform .12s;
  font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:0}
.deck-fab:hover{filter:brightness(1.12);transform:translateY(-1px)}
.deck-fab:active{cursor:grabbing}
.deck-fab svg{display:block}
.deck-fab .deck-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;
  background:#ef5b5b;color:#fff;font-size:10px;line-height:16px;text-align:center;font-weight:700;box-shadow:0 0 0 2px #0b0f14}
.deck-fab.ai-on{box-shadow:0 0 0 2px rgba(53,208,186,.55),0 10px 24px rgba(0,0,0,.35)}
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
      const [summary, setSummary] = React.useState({ auto: 0, assist: 0, pending: 0 })
      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch('http://127.0.0.1:9199/api/state', { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => {
              if (!alive) return
              const ps = d.projects || []
              setSummary({
                auto: ps.filter((p) => p.autonomy && p.autonomy.mode === 'auto').length,
                assist: ps.filter((p) => p.autonomy && p.autonomy.mode === 'assist').length,
                pending: (d.approvals || []).length,
              })
            })
            .catch(() => {})
        }
        load()
        const t = setInterval(load, 60000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const dragState = React.useRef(null)
      const movedRef = React.useRef(false)

      const clamp = (x, y) => ({
        x: Math.max(6, Math.min(x, window.innerWidth - 54)),
        y: Math.max(6, Math.min(y, window.innerHeight - 54)),
      })

      // 用 window 级监听，避免指针移出按钮就丢事件（之前只能按住按钮原地挪）
      React.useEffect(() => {
        const onMove = (e) => {
          const d = dragState.current
          if (!d) return
          if (!d.moved && (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3)) d.moved = true
          setPos(clamp(e.clientX - d.dx, e.clientY - d.dy))
        }
        const onUp = () => {
          const d = dragState.current
          if (!d) return
          dragState.current = null
          movedRef.current = d.moved
          setPos((cur) => { if (cur) { try { localStorage.setItem('deck-fab-pos', JSON.stringify(cur)) } catch {} } return cur })
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('mousemove', onMove, true)
        window.addEventListener('mouseup', onUp, true)
        return () => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
          window.removeEventListener('mousemove', onMove, true)
          window.removeEventListener('mouseup', onUp, true)
        }
      }, [])

      const fabStyle = pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' } : undefined

      const onDragStart = (e) => {
        const r = e.currentTarget.getBoundingClientRect()
        dragState.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false }
        movedRef.current = false
        if (!pos) setPos({ x: r.left, y: r.top })
        if (e.preventDefault) e.preventDefault()
      }

      // 面板里也能改图标位置（拖拽失效时的兜底）
      React.useEffect(() => {
        const onPos = (e) => {
          if (e.origin !== PANEL) return
          const d = e.data || {}
          if (d.type !== 'deck:set-fab-pos') return
          const W = window.innerWidth, H = window.innerHeight
          const spots = {
            'right-bottom': { x: W - 60, y: H - 160 },
            'left-bottom': { x: 16, y: H - 160 },
            'right-top': { x: W - 60, y: 84 },
            'center-right': { x: W - 60, y: Math.round(H / 2) },
            default: { x: W - 60, y: H - 160 },
          }
          const next = spots[d.pos] || spots.default
          setPos(clamp(next.x, next.y))
          try { localStorage.setItem('deck-fab-pos', JSON.stringify(clamp(next.x, next.y))) } catch {}
        }
        window.addEventListener('message', onPos)
        return () => window.removeEventListener('message', onPos)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const openPanel = () => { setLoaded(false); setOpen(true) }

      return h(React.Fragment, null,
        h('button', {
          className: 'deck-fab' + (summary.auto > 0 ? ' ai-on' : ''),
          style: fabStyle,
          title: '项目甲板 · AI 项目管理与自动推进（可拖动 v4）'
            + (summary.auto ? `｜auto ${summary.auto}` : '')
            + (summary.pending ? `｜待你拍板 ${summary.pending}` : ''),
          onPointerDown: onDragStart,
          onMouseDown: onDragStart,
          onClick: () => { if (!movedRef.current) openPanel(); movedRef.current = false },
          onDragStart: (e) => e.preventDefault(),
        },
          h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: '#7ce7da', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
            // 项目看板：三列（项目/阶段/任务）
            h('rect', { x: 3.2, y: 7, width: 5, height: 12.5, rx: 1.4 }),
            h('rect', { x: 9.6, y: 7, width: 5, height: 9, rx: 1.4 }),
            h('rect', { x: 16, y: 7, width: 5, height: 12.5, rx: 1.4 }),
            // AI 火花（右上角）
            h('path', { d: 'M19.2 2.4l.85 2.05 2.05.85-2.05.85-.85 2.05-.85-2.05-2.05-.85 2.05-.85z', fill: '#7ce7da', stroke: 'none' }),
          ),
          summary.pending > 0 ? h('span', { className: 'deck-badge' }, String(summary.pending)) : null,
        ),
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

    // 崩溃兜底：任何渲染错误都不让图标凭空消失
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', {
            title: String(this.state.err && this.state.err.message || this.state.err),
            style: { position: 'fixed', right: 12, bottom: 100, zIndex: 121, background: '#2a1518',
                     color: '#ffb3b3', padding: '5px 9px', borderRadius: 8, fontSize: 11,
                     border: '1px solid #4a2226', cursor: 'pointer', pointerEvents: 'auto' },
            onClick: () => this.setState({ err: null }),
          }, '项目甲板加载失败（点我重试）')
        }
        return this.props.children
      }
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
        (props) => h(Boundary, null, h(Panel, Object.assign({}, props, { appCtx: ctx }))),
      ))
      console.log('[dsh-project-deck] client ready')
    }
    return module.exports
  },
})
