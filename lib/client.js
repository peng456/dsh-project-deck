// dsh-pagent client half: 在 DSH 界面里嵌入个人 Agent 控制台（pagent 面板）。
// 面板本体是独立进程（~/.person-agent/bin/panel.py，http://127.0.0.1:9199），
// 这里用 iframe 内嵌，避免在插件里重复实现一遍 UI。
window.__ModuleLoader__.load({
  id: 'dsh-pagent',
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

    // 自定义深链：#pagent-session=<id>（DSH 本身没有 URL scheme / 会话路由，
    // 所以由插件读 hash 后自己跳；链接对普通浏览器也可用）
    function readDeepLink() {
      try {
        const hash = String(window.location.hash || '')
        const m = hash.match(/pagent-session=([^&]+)/)
        if (m) return { kind: 'session', value: decodeURIComponent(m[1]) }
        const p = hash.match(/pagent-project=([^&]+)/)
        if (p) return { kind: 'project', value: decodeURIComponent(p[1]) }
        return null
      } catch { return null }
    }

    function clearDeepLink() {
      try {
        if (/pagent-session=/.test(window.location.hash)) {
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
        try { uw.openSession(sessionId); return true } catch (e) { console.warn('[dsh-pagent] uiWorkspace.openSession 失败', e) }
      }
      const sessions = optionalService(ctx, 'sessions')
      if (sessions && typeof sessions.open === 'function') {
        try { sessions.open(sessionId); return true } catch (e) { console.warn('[dsh-pagent] sessions.open 失败', e) }
      }
      console.warn('[dsh-pagent] 没有可用的会话导航服务（uiWorkspace / sessions 都不可用）')
      return false
    }

    const css = `
.pagent-fab{position:fixed;left:16px;bottom:18px;z-index:120;display:flex;align-items:center;justify-content:center;
  width:46px;height:46px;border-radius:50%;border:1px solid rgba(53,208,186,.45);cursor:pointer;
  background:linear-gradient(180deg,#12303a,#0f1e1d);color:#7ce7da;font-size:20px;line-height:1;
  box-shadow:0 10px 24px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.2);transition:filter .12s,transform .12s;
  font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:0}
.pagent-fab:hover{filter:brightness(1.12);transform:translateY(-1px)}
.pagent-fab:active{transform:translateY(0)}
.pagent-mask{position:fixed;inset:0;z-index:130;background:rgba(4,8,12,.62);display:flex;align-items:center;justify-content:center;padding:24px}
.pagent-box{width:min(1180px,94vw);height:min(860px,88vh);background:#0b0f14;border:1px solid #1f2a37;border-radius:14px;
  display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.pagent-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1f2a37;
  background:#0f151d;color:#e6edf3;font:600 13px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif}
.pagent-head .dot{width:8px;height:8px;border-radius:50%;background:#3ddc97;box-shadow:0 0 8px rgba(61,220,151,.7)}
.pagent-head .sp{flex:1}
.pagent-head a,.pagent-head button{color:#8b98a5;background:none;border:1px solid #1f2a37;border-radius:7px;
  padding:4px 10px;font-size:12px;cursor:pointer;text-decoration:none;font-family:inherit}
.pagent-head a:hover,.pagent-head button:hover{color:#e6edf3;border-color:#2bb8a5}
.pagent-frame{flex:1;width:100%;border:0;background:#0b0f14}
.pagent-tip{padding:8px 14px;color:#6f7d8a;font:11px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;border-top:1px solid #1a232d}
`

    if (typeof document !== 'undefined' && !document.getElementById('dsh-pagent-style')) {
      const style = document.createElement('style')
      style.id = 'dsh-pagent-style'
      style.textContent = css
      document.head.appendChild(style)
    }

    function Panel(props) {
      const appCtx = props && props.appCtx
      const [open, setOpen] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const frameRef = React.useRef(null)

      // 面板（iframe，127.0.0.1:9199）点「最近会话」时 postMessage 过来，在这里跳到对应会话
      React.useEffect(() => {
        const onMessage = (e) => {
          if (e.origin !== PANEL) return
          const data = e.data || {}
          if (data.type === 'dsh-pagent:open-project') {
            openProjectWith(appCtx, { root: String(data.root || ''), sessionId: data.sessionId ? String(data.sessionId) : null })
              .then((ok) => {
                console.log('[dsh-pagent] open-project', data.project, 'ok=', ok)
                try {
                  const frame = document.querySelector('iframe.pagent-frame')
                  if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'dsh-pagent:open-result', ok, project: data.project }, PANEL)
                  }
                } catch (err) { /* 忽略 */ }
                if (ok) setOpen(false)
              })
            return
          }
          if (data.type !== 'dsh-pagent:open-session' || !data.sessionId) return
          const ok = openSessionWith(appCtx, String(data.sessionId))
          console.log('[dsh-pagent] open-session request', data.sessionId, 'ok=', ok)
          try {
            const frame = document.querySelector('iframe.pagent-frame')
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({ type: 'dsh-pagent:open-result', ok, sessionId: data.sessionId }, PANEL)
            }
          } catch (e) { console.warn('[dsh-pagent] 回传结果失败', e) }
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
          className: 'pagent-fab',
          title: '个人 Agent 控制台（项目 / 播报 / 节点）',
          onClick: openPanel,
        }, '\u{1F4CB}'),
        open
          ? h('div', { className: 'pagent-mask', onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) } },
              h('div', { className: 'pagent-box' },
                h('div', { className: 'pagent-head' },
                  h('span', { className: 'dot' }),
                  h('span', null, '个人 Agent 控制台'),
                  h('span', { className: 'sp' }),
                  h('a', { href: PANEL, target: '_blank', rel: 'noreferrer' }, '新窗口'),
                  h('button', { onClick: () => setOpen(false) }, '关闭'),
                ),
                h('iframe', {
                  ref: frameRef,
                  className: 'pagent-frame',
                  src: PANEL,
                  title: 'pagent panel',
                  onLoad: () => setLoaded(true),
                }),
                h('div', { className: 'pagent-tip' },
                  loaded
                    ? '面板由 ~/.person-agent/bin/panel.py 提供（127.0.0.1:9199）'
                    : '正在连接面板… 若长时间空白，请在终端运行 pagent status 检查服务是否在跑',
                ),
              ),
            )
          : null,
      )
    }

    exports.name = 'dsh-pagent'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) {
        console.error('[dsh-pagent] slots 服务不可用')
        return
      }
      // 深链：支持 #pagent-session=<id>（会话）与 #pagent-project=<路径>（项目→开会话）。
      // 刚加载时会话列表还没拉回来，直接 open 会被丢掉，所以要等就绪后重试。
      let deepLinkTimer = null
      const finishDeepLink = (label) => {
        clearDeepLink()
        console.log('[dsh-pagent] deep link opened', label)
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
            else console.warn('[dsh-pagent] deep link 放弃：workspace 创建/打开失败', target.value)
          })
          return
        }
        if (attempt >= 50) {
          console.warn('[dsh-pagent] deep link 放弃：会话未出现在列表里', target.value)
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
        { name: 'shell.overlay', id: 'pagent-panel', order: 6, label: '个人 Agent' },
        (props) => h(Panel, Object.assign({}, props, { appCtx: ctx })),
      ))
      console.log('[dsh-pagent] client ready')
    }
    return module.exports
  },
})
