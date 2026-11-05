#!/usr/bin/env python3
"""项目甲板 管理面板 —— 本地 Web 控制台。

  python3 ~/.project-deck/bin/panel.py        # 默认 127.0.0.1:9199
  DECK_PANEL_HOST=0.0.0.0 DECK_PANEL_PORT=9199 python3 panel.py

数据全部来自 ~/.project-deck（registry / config / report-state / 播报历史），
与 deck CLI、launchd 守护进程共用同一份真相，不另存一份。
"""
import glob
import http.server
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse

BASE = os.path.expanduser(os.environ.get('DECK_HOME', '~/.project-deck'))
DECK_BIN = os.environ.get('DECK_BIN') or os.path.join(BASE, 'bin', 'deck')
if not os.path.exists(DECK_BIN):
    DECK_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'deck')
PAGENT = DECK_BIN
HTML = os.path.join(BASE, 'panel.html')
if not os.path.exists(HTML):
    HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'panel.html')
PORT = int(os.environ.get('DECK_PANEL_PORT', '9199'))
HOST = os.environ.get('DECK_PANEL_HOST', '127.0.0.1')

KINDS = {'code': '代码', 'content': '内容', 'ops': '运维', 'life': '生活', 'research': '研究'}
STATUSES = {'active': '活跃', 'paused': '暂停', 'blocked': '阻塞', 'archived': '归档'}


def load_deck():
    from importlib.machinery import SourceFileLoader
    loader = SourceFileLoader('deck', PAGENT)
    spec = importlib.util.spec_from_loader('deck', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


P = load_deck()


# ── 数据汇总 ────────────────────────────────────────────────
def wechat_view():
    d = P.delivery_cfg()
    if d['type'] == 'ilink':
        P.wechat_check_login() if P.wechat_state().get('qr_ticket') else None
        return {'mode': 'ilink', **P.wechat_status()}
    st = P.delivery_status()
    return {'mode': d['type'], **st}


def wechat_poller():
    while True:
        try:
            if P.delivery_cfg()['type'] == 'ilink' and P.wechat_state().get('bot_token'):
                P.wechat_poll_once(50)
            else:
                time.sleep(4)
        except Exception:
            time.sleep(5)


def wechat_state():
    st = P.delivery_status()
    return {'ok': bool(st.get('ok')), 'raw': st.get('detail', ''),
            'code': 0 if st.get('ok') else 2, 'type': st.get('type'),
            'pending': st.get('pending', 0)}


def project_view(p):
    info = P.collect(p)
    return {
        'id': p['id'], 'name': p.get('name', p['id']),
        'kind': p.get('kind', 'code'), 'kindLabel': KINDS.get(p.get('kind', 'code'), p.get('kind')),
        'status': p.get('status', 'active'),
        'statusLabel': STATUSES.get(p.get('status', 'active'), p.get('status')),
        'priority': p.get('priority', 50), 'root': p.get('root', ''),
        'note': p.get('note', ''), 'next': info['next'] or p.get('note') or None,
        'exists': info['exists'], 'memory': info['memory'],
        'activity': info['activity'], 'activityText': P.rel_time(info['activity']),
        'git': info['git'], 'board': info['board'],
        'autonomy': P.autonomy_of(p),
        'sessions': project_sessions(p.get('root', ''), p.get('sessions') or []),
        'boundSessions': p.get('sessions') or [],
    }


def snapshot():
    cfg = P.load_json(P.CONFIG, {})
    reg = P.load_json(P.REGISTRY, {'projects': []})
    st = P.load_json(P.STATE, {})
    rep = cfg.get('report', {})
    last = st.get('last_run') or 0
    interval = float(rep.get('intervalHours', 4))
    history = []
    if os.path.exists(P.HISTORY):
        try:
            lines = open(P.HISTORY, encoding='utf-8', errors='replace').read().strip().splitlines()[-8:]
            for line in lines:
                try:
                    h = json.loads(line)
                    history.append({'at': h.get('at', 0), 'exit': h.get('exit', -1),
                                    'text': h.get('text', '')})
                except json.JSONDecodeError:
                    continue
        except OSError:
            pass
    history.reverse()
    projects = [project_view(p) for p in reg.get('projects', [])]
    projects.sort(key=lambda p: (-p['priority'], p['id']))
    return {
        'now': time.time(),
        'config': {'intervalHours': interval, 'enabled': rep.get('enabled', True),
                   'maxChars': rep.get('maxChars', 1200),
                   'format': rep.get('format', 'markdown'),
                   'image': bool(rep.get('image', False)),
                   'web': cfg.get('web', {}).get('baseUrl', 'http://127.0.0.1:43120'),
                   'delivery': P.delivery_cfg(cfg),
                   'scan': cfg.get('scan', {})},
        'daemon': {'running': bool(P.daemon_status()), 'pid': P.daemon_status() or 0,
                   'lastRun': last, 'nextRun': (last + interval * 3600) if last else 0},
        'wechat': dict(wechat_state(),
                       stale=P.channel_stale(),
                       fails=P.channel_state().get('fails', 0),
                       lastError=P.channel_state().get('lastError', '')),
        'counts': {
            'total': len(projects),
            'active': sum(1 for p in projects if p['status'] == 'active'),
            'blocked': sum(1 for p in projects if p['status'] == 'blocked'),
            'recent': sum(1 for p in projects if p['activity'] and time.time() - p['activity'] < 6 * 3600),
            'noMemory': sum(1 for p in projects if not p['memory']),
        },
        'projects': projects,
        'history': history,
        'nodes': nodes_view(),
        'approvals': [x for x in P.load_approvals().get('items', []) if x.get('status') == 'pending'],
        'decisions': decisions_view(10),
    }


def nodes_view():
    nodes = P.load_nodes().get('nodes', [])
    out = []
    for n in nodes:
        snap = P.load_json(os.path.join(P.NODE_SNAPS, n['id'] + '.json'), None)
        out.append({
            'id': n['id'], 'name': n.get('name', n['id']), 'platform': n.get('platform', ''),
            'address': n.get('address', ''), 'lastSeen': n.get('lastSeen'),
            'runtimes': n.get('runtimes', ''), 'note': n.get('note', ''),
            'scannedAt': min(snap.get('scanned_at'), time.time()) if snap else None,
            'projects': len(snap.get('projects', [])) if snap else 0,
            'online': bool(n.get('local')) or bool(snap and time.time() - snap.get('scanned_at', 0) < 86400),
        })
    return out


def latest_image():
    files = sorted(glob.glob(os.path.join(BASE, 'graphics', 'board-*.png')))
    return files[-1] if files else None


def send_image_now(dry=False):
    cfg = P.load_json(P.CONFIG, {})
    png = P.render_image(cfg)
    if dry:
        return {'code': 0, 'message': '仅渲染（未发送）',
                'url': '/api/image/latest?t=' + str(int(time.time()))}
    reg = P.load_json(P.REGISTRY, {'projects': []})
    n = len([p for p in reg.get('projects', []) if p.get('status') != 'archived'])
    caption = f'项目播报 · {n} 个项目 · ' + time.strftime('%m-%d %H:%M')
    code, msg = P.send_wechat_image(png, caption)
    return {'code': code, 'message': msg,
            'url': '/api/image/latest?t=' + str(int(time.time()))}


SESSION_ROOT = os.path.join(os.path.expanduser('~'), '.dsh', 'sessions')
PROJCACHE_ROOT = os.path.join(os.path.expanduser('~'), '.dsh', 'storages',
                              'session_projcache', 'sessions')
SESSION_CACHE = os.path.join(BASE, 'sessions-cache.json')
INDEX_CACHE_VERSION = 2   # 缓存结构版本；旧版（按日志文件路径做键）遇到即重建
DISPLAY_CHARS = 120       # 列表 / 提示行展示用的首条消息长度
PROMPT_CHARS = 600        # 索引里保留的首条消息正文长度（供搜索与归类）
_INDEX_LOCK = threading.Lock()   # 预热线程与 HTTP 请求会并发调 session_index，串行化扫描与落盘
INDEX_MEMO_TTL = 2.0             # 一次快照会按项目重复调 9 次索引，短 TTL 内存缓存合并成一次扫描
_INDEX_MEMO = {'at': 0.0, 'data': {}}
_WORKSPACE_STORE = os.path.join(os.path.expanduser('~'), '.dsh', 'storages', 'workspace.json')


def project_key(cwd):
    """与 DSH 的 projectKey() 同算法：分隔符→'-'，非安全字符→~XXXX，前后加 --。"""
    out, sep = [], False
    for ch in cwd:
        code = ord(ch)
        if ch in '/\\:':
            if not sep:
                out.append('-')
            sep = True
        elif ch != '~' and (ch.isalnum() or ch in '._-') and code < 128:
            out.append(ch)
            sep = False
        else:
            out.append('~%04X' % code)
            sep = False
    s = ''.join(out).lstrip('-') or 'root'
    return '--' + s[:251] + '--'


def _squash(text):
    """把多行消息压成单行空白，便于列表展示与关键字搜索。"""
    return re.sub(r'\s+', ' ', text or '').strip()


def _session_log(session_dir):
    """返回 (权威日志路径, 最近活跃 mtime)。

    DSH 迁移后 session.v3.jsonl.zstd 是权威副本，未迁移的老会话只有
    session.jsonl.zstd；新代码不能只认前者，否则老会话永远进不了索引。
    """
    v3 = os.path.join(session_dir, 'session.v3.jsonl.zstd')
    legacy = os.path.join(session_dir, 'session.jsonl.zstd')
    logs = [p for p in (v3, legacy) if os.path.exists(p)]
    if not logs:
        return None, 0
    at = 0
    for p in logs:
        try:
            at = max(at, os.path.getmtime(p))
        except OSError:
            pass
    return logs[0], at


def _pc_value(rows, key):
    row = rows.get(key)
    return row.get('val') if isinstance(row, dict) else None


def _read_projcache(sid):
    """读 DSH 的 projection cache（物化索引）：标题、首条消息全文、cwd。

    DSH 已把每个会话的 title / titleInput / cwd 折叠好落在
    ~/.dsh/storages/session_projcache/sessions/<id>.json，读它比逐个解压
    日志便宜得多。文件不存在或暂时读不出（写入中 / 损坏）返回 {}。
    """
    path = os.path.join(PROJCACHE_ROOT, sid + '.json')
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {}
    rec = raw.get('record') or {}
    ident = rec.get('identity') or {}
    rows = rec.get('rows') or {}
    first = ''
    ti = _pc_value(rows, 'titleInput')
    if isinstance(ti, dict):
        first = (ti.get('first') or {}).get('text') or ''
    title = _pc_value(rows, 'title') or ''
    if not title and not first and not ident.get('cwd'):
        return {}
    return {'cwd': ident.get('cwd') or '', 'createdAt': ident.get('createdAt') or 0,
            'title': title, 'first': first}


def _read_session_head(path):
    """兜底：只解开头几十行，拿会话头与首条用户消息（不解压整个日志）。"""
    try:
        proc = subprocess.Popen(['zstd', '-dc', path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    raw = b''
    try:
        while raw.count(b'\n') < 25 and len(raw) < 200000:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            raw += chunk
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        proc.wait(timeout=5)
    head, first = None, ''
    for line in raw.splitlines()[:25]:
        try:
            j = json.loads(line)
        except Exception:
            continue
        if j.get('type') == 'session' and head is None:
            head = j
        elif j.get('type') == 'user/message' and not first:
            content = (j.get('data') or {}).get('content') or []
            first = ' '.join(c.get('text', '') for c in content if isinstance(c, dict))
        if head is not None and first:
            break
    if head is None:
        return None
    return {'id': head.get('id'), 'cwd': head.get('cwd'), 'createdAt': head.get('createdAt'),
            'first': first}


def _public_record(ent):
    """缓存条目去掉签名后的对外记录。"""
    return {k: ent.get(k) for k in ('id', 'ws', 'at', 'cwd', 'createdAt',
                                    'title', 'first', 'prompt')}


def _lookup(idx, sid):
    """按会话 id 查索引；兼容历史绑定的 header id（如 im-connect 的 im:… 会话）。"""
    rec = idx.get(sid)
    if rec:
        return rec
    for rec in idx.values():
        if rec.get('id') == sid:
            return rec
    return None


def session_index(refresh=False, fresh=False):
    """会话索引入口：进程内串行化（预热线程与并发请求共用一份缓存文件）。

    面板一次刷新会按项目重复调用本函数，用短 TTL 的内存快照合并成一次磁盘扫描；
    `fresh=True` 绕过内存快照（会话选择器用，保证刚建的会话立刻可见）。
    调用方只读，不要修改返回的 dict。
    """
    with _INDEX_LOCK:
        now = time.time()
        if (not refresh and not fresh and _INDEX_MEMO['at']
                and now - _INDEX_MEMO['at'] < INDEX_MEMO_TTL):
            return _INDEX_MEMO['data']
        data = _index_sessions(refresh)
        _INDEX_MEMO['at'] = now
        _INDEX_MEMO['data'] = data
        return data


def _index_sessions(refresh=False):
    """扫描全部会话目录，返回 {id: {id, cwd, at, createdAt, title, first, prompt, ws}}。

    标题与首条消息优先取自 DSH 的 session_projcache（物化索引，不必解压日志）；
    只有缓存缺失时才回退到「只解头部」的日志读取。按日志与缓存文件的 mtime/size
    做签名缓存，未变化的会话不重复解析，已消失的会话从索引里清掉。
    """
    entries = {}
    if not refresh:
        raw = P.load_json(SESSION_CACHE, {})
        if isinstance(raw, dict) and raw.get('v') == INDEX_CACHE_VERSION:
            entries = raw.get('entries') or {}
    out, seen, changed = {}, set(), False
    if not os.path.isdir(SESSION_ROOT):
        return {}
    for ws in os.listdir(SESSION_ROOT):
        wsd = os.path.join(SESSION_ROOT, ws)
        if not os.path.isdir(wsd):
            continue
        for sid in os.listdir(wsd):
            sd = os.path.join(wsd, sid)
            if not os.path.isdir(sd):
                continue
            log, at = _session_log(sd)
            if not log:
                continue
            try:
                lst = os.stat(log)
            except OSError:
                continue
            seen.add(sid)
            try:
                pst = os.stat(os.path.join(PROJCACHE_ROOT, sid + '.json'))
                pc_sig = (pst.st_mtime, pst.st_size)
            except OSError:
                pc_sig = (0, 0)
            sig = [lst.st_mtime, lst.st_size, pc_sig[0], pc_sig[1]]
            ent = entries.get(sid)
            if isinstance(ent, dict) and ent.get('sig') == sig:
                out[sid] = _public_record(ent)
                continue
            pc = _read_projcache(sid)
            head = None
            # 只有 title 不够：mesh 任务会话的标题是插件写死的「Mesh 任务 t-xxx」，
            # titleInput 里没有符合条件的首条消息，正文得回日志头部补。
            if not pc.get('cwd') or not pc.get('first'):
                head = _read_session_head(log)
                if head and head.get('id') and head['id'] != sid:
                    # 目录名是编码后的 projectKey（im-connect 会话就是这样），
                    # projcache 以真实 session id 落盘，再按 header id 试一次。
                    alt = _read_projcache(head['id'])
                    if alt.get('title') or alt.get('first'):
                        pc = alt
            if not pc and not head:
                continue
            rec = {'id': sid, 'ws': ws, 'at': at,
                   'cwd': pc.get('cwd') or (head or {}).get('cwd') or '',
                   'createdAt': pc.get('createdAt') or (head or {}).get('createdAt') or 0,
                   'title': _squash(pc.get('title')),
                   'prompt': _squash(pc.get('first') or (head or {}).get('first'))[:PROMPT_CHARS]}
            rec['first'] = rec['prompt'][:DISPLAY_CHARS]
            out[sid] = dict(rec)
            if pc_sig != (0, 0) and not pc:
                changed = True      # 缓存文件在却读不出（写入中 / 损坏）：这次不落缓存，下次重试
                continue
            entries[sid] = dict(rec, sig=sig)
            changed = True
    for sid in list(entries):
        if sid not in seen:
            del entries[sid]
            changed = True
    if changed:
        P.save_json(SESSION_CACHE, {'v': INDEX_CACHE_VERSION, 'entries': entries})
    return out


def project_sessions(root, bound=None, limit=12):
    """cwd 匹配的会话 + 手工绑定的会话，合并去重后按最近活跃排序。"""
    idx = session_index()
    seen, out = set(), []
    for s in _cwd_sessions(root, limit=200):
        if s['id'] in seen:
            continue
        seen.add(s['id'])
        meta = _lookup(idx, s['id']) or {}
        out.append({'id': s['id'], 'at': s['at'], 'bound': False,
                    'title': meta.get('title', ''), 'first': meta.get('first', ''),
                    'cwd': meta.get('cwd', '')})
    for sid in (bound or []):
        if sid in seen:
            continue
        m = _lookup(idx, sid)
        if not m:
            continue
        seen.add(sid)
        out.append({'id': m.get('id') or sid, 'at': m['at'], 'bound': True,
                    'title': m.get('title', ''), 'first': m.get('first', ''),
                    'cwd': m.get('cwd', '')})
    out.sort(key=lambda x: -x['at'])
    return out[:limit]


def _cwd_sessions(root, limit=12):
    """按 projectKey 找到该项目的会话目录，按最近修改时间倒序。"""
    if not root:
        return []
    d = os.path.join(SESSION_ROOT, project_key(os.path.realpath(root)))
    if not os.path.isdir(d):
        return []
    out = []
    try:
        names = os.listdir(d)
    except OSError:
        return []
    for name in names:
        sd = os.path.join(d, name)
        if not os.path.isdir(sd):
            continue
        # 目录名就是会话 id（session-<uuid> / mesh-<uuid> / 裸 uuid 都见过），
        # 必须原样传给 uiWorkspace.openSession，不能剥前缀。
        log, latest = _session_log(sd)
        if not log:
            continue
        if latest:
            out.append({'id': name, 'at': latest})
    out.sort(key=lambda x: -x['at'])
    return out[:limit]


def goal_list(root):
    gdir = os.path.join(root, '.dsh-graph', 'goals')
    out = []
    if not os.path.isdir(gdir):
        return out
    for name in sorted(os.listdir(gdir)):
        f = os.path.join(gdir, name, 'goal.md')
        if not os.path.isfile(f):
            continue
        try:
            head = open(f, encoding='utf-8', errors='replace').read(3000)
        except OSError:
            continue
        title = re.search(r'^\s+title:\s*["\']?(.+?)["\']?\s*$', head, re.M)
        status = re.search(r'^\s+status:\s*["\']?([a-z_]+)', head, re.M)
        out.append({'id': name, 'title': (title.group(1) if title else name)[:60],
                    'status': status.group(1) if status else 'unknown'})
    return out[:12]


def git_log(root, n=5):
    try:
        r = subprocess.run(['git', '-C', root, 'log', '-' + str(n), '--format=%h%x1f%ar%x1f%s'],
                           capture_output=True, text=True, timeout=6)
        if r.returncode != 0:
            return []
        rows = []
        for line in r.stdout.strip().splitlines():
            parts = line.split('\x1f', 2)
            if len(parts) == 3:
                rows.append({'sha': parts[0], 'when': parts[1], 'subject': parts[2][:90]})
        return rows
    except (OSError, subprocess.SubprocessError):
        return []


def project_detail(pid):
    reg = P.load_json(P.REGISTRY, {'projects': []})
    proj = next((p for p in reg['projects'] if p['id'] == pid), None)
    if not proj:
        raise ValueError('项目不存在')
    view = project_view(proj)
    root = proj.get('root', '')
    detail = {'project': view, 'gitLog': git_log(root) if os.path.isdir(root) else [],
              'goals': goal_list(root) if os.path.isdir(root) else [], 'state': None}
    sf = P.state_file(proj)
    if sf and os.path.exists(sf):
        try:
            text = open(sf, encoding='utf-8', errors='replace').read(4000)
        except OSError:
            text = ''
        nxt, st = P.parse_state(sf)
        detail['state'] = {'path': sf, 'next': nxt, 'status': st,
                           'size': os.path.getsize(sf), 'excerpt': text[:2000]}
    return detail


def image_history(limit=8):
    files = sorted(glob.glob(os.path.join(BASE, 'graphics', 'board-*.png')), reverse=True)[:limit]
    return [{'name': os.path.basename(f), 'at': os.path.getmtime(f),
             'url': '/api/image/file?name=' + urllib.parse.quote(os.path.basename(f))} for f in files]


def scan_view():
    st = P.load_json(P.SCAN_STATE, {})
    return {'lastRun': st.get('lastRun'), 'added': st.get('added', []),
            'candidateCount': len(st.get('candidates', []))}


def scan_candidates():
    return P.discover(P.load_json(P.CONFIG, {}))


def run_scan():
    cfg = P.load_json(P.CONFIG, {})
    res = P.auto_scan(cfg)
    return {'added': res.get('added', []), 'candidates': P.discover(cfg), 'state': snapshot()}


def add_candidates(paths):
    cfg = P.load_json(P.CONFIG, {})
    cands = {c['path']: c for c in P.discover(cfg)}
    added, errors = [], []
    for path in paths:
        c = cands.get(path)
        if not c:
            errors.append(f'{path} 已失效')
            continue
        try:
            add_project({'id': c['id'], 'name': c['name'], 'root': c['path'],
                         'kind': c['kind'], 'priority': 40,
                         'note': '自动发现：' + '；'.join(c['reasons'][:3])})
            added.append(c['id'])
        except ValueError as e:
            errors.append(str(e))
    return {'added': added, 'errors': errors, 'candidates': P.discover(cfg), 'state': snapshot()}


# ── 写操作 ──────────────────────────────────────────────────
def set_config(payload):
    cfg = P.load_json(P.CONFIG, {})
    rep = cfg.setdefault('report', {})
    if 'intervalHours' in payload:
        try:
            h = float(payload['intervalHours'])
        except (TypeError, ValueError):
            raise ValueError('间隔必须是数字')
        if not (0 < h <= 720):
            raise ValueError('间隔需在 0 到 720 小时之间')
        rep['intervalHours'] = h
    if 'enabled' in payload:
        rep['enabled'] = bool(payload['enabled'])
    if 'maxChars' in payload:
        rep['maxChars'] = int(payload['maxChars'])
    if 'image' in payload:
        rep['image'] = bool(payload['image'])
    if 'delivery' in payload and isinstance(payload['delivery'], dict):
        dl = rep.setdefault('delivery', {})
        for k in ('type', 'url', 'key', 'webhook', 'command'):
            if k in payload['delivery']:
                dl[k] = payload['delivery'][k]
    if 'scan' in payload and isinstance(payload['scan'], dict):
        sc = cfg.setdefault('scan', {})
        for k in ('enabled', 'autoAdd'):
            if k in payload['scan']:
                sc[k] = bool(payload['scan'][k])
        for k in ('intervalHours', 'threshold', 'depth'):
            if k in payload['scan']:
                try:
                    sc[k] = float(payload['scan'][k]) if k == 'intervalHours' else int(payload['scan'][k])
                except (TypeError, ValueError):
                    raise ValueError(k + ' 必须是数字')
        if 'roots' in payload['scan']:
            roots = payload['scan']['roots']
            if isinstance(roots, str):
                roots = [x.strip() for x in roots.splitlines() if x.strip()]
            sc['roots'] = [str(x) for x in roots][:12]
    if 'format' in payload:
        if payload['format'] not in ('markdown', 'plain'):
            raise ValueError('版式只支持 markdown / plain')
        rep['format'] = payload['format']
    P.save_json(P.CONFIG, cfg)
    P.log(f'[panel] config interval={rep.get("intervalHours")} enabled={rep.get("enabled")}')
    return snapshot()


def bind_session(payload):
    pid = payload.get('project')
    sid = str(payload.get('sessionId') or '').strip()
    if not pid or not sid:
        raise ValueError('project 与 sessionId 必填')
    reg = P.load_json(P.REGISTRY, {'projects': []})
    proj = next((x for x in reg['projects'] if x['id'] == pid), None)
    if not proj:
        raise ValueError('项目不存在')
    idx = session_index()
    rec = _lookup(idx, sid)
    if not rec:
        raise ValueError('会话不存在（索引里没有这个 id）')
    sid = rec.get('id') or sid      # 统一落成索引里的规范 id（目录名）
    cur = list(proj.get('sessions') or [])
    if payload.get('bind', True):
        if sid not in cur:
            cur.append(sid)
    else:
        cur = [x for x in cur if x != sid]
    proj['sessions'] = cur
    P.save_json(P.REGISTRY, reg)
    P.log(f'[panel] bind session {sid} -> {pid} ({len(cur)})')
    return snapshot()


def set_autonomy(project, mode, max_per_day=None):
    if mode not in ('off', 'assist', 'auto'):
        raise ValueError('mode 只能是 off / assist / auto')
    reg = P.load_json(P.REGISTRY, {'projects': []})
    proj = next((x for x in reg['projects'] if x['id'] == project), None)
    if not proj:
        raise ValueError('项目不存在')
    a = P.autonomy_of(proj)
    a['mode'] = mode
    if max_per_day is not None:
        a['maxPerDay'] = int(max_per_day)
    proj['autonomy'] = a
    P.save_json(P.REGISTRY, reg)
    P.log(f'[panel] autonomy {project} -> {mode}')
    return snapshot()


def resolve_approval(approval_id, action, choice=''):
    it = P.resolve_approval(approval_id, action, choice)
    if not it:
        raise ValueError('待批项不存在或已处理')
    return {'item': it, 'state': snapshot()}


def decisions_view(limit=20):
    rows = []
    if os.path.exists(P.DECISIONS):
        for line in open(P.DECISIONS):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows[-limit:][::-1]


def ignore_candidate(path, days):
    if not path:
        raise ValueError('缺少 path')
    ig = P.load_ignore()
    days = int(days)
    if days <= 0:
        if path not in ig['blocked']:
            ig['blocked'].append(path)
        ig.get('ignore', {}).pop(path, None)
    else:
        ig.setdefault('ignore', {})[path] = time.time() + days * 86400
    P.save_json(P.SCAN_IGNORE, ig)
    P.log(f'[scan] 忽略候选 {path} ({days} 天)')
    return {'candidates': P.discover(P.load_json(P.CONFIG, {})), 'state': snapshot()}


def all_sessions(q='', limit=300):
    idx = session_index(fresh=True)   # 选择器要立刻看到刚建的会话，不吃内存快照
    rows = list(idx.values())
    if q:
        ql = q.lower()
        rows = [r for r in rows
                if ql in (r.get('title') or '').lower()
                or ql in (r.get('prompt') or r.get('first') or '').lower()
                or ql in (r.get('cwd') or '').lower()]
    rows.sort(key=lambda r: -r['at'])
    return rows[:limit]


def add_project(payload):
    pid = str(payload.get('id', '')).strip()
    root = os.path.realpath(os.path.expanduser(str(payload.get('root', '')).strip()))
    if not pid or not root:
        raise ValueError('id 与 root 必填')
    if not os.path.isdir(root):
        raise ValueError(f'目录不存在: {root}')
    reg = P.load_json(P.REGISTRY, {'projects': []})
    for p in reg['projects']:
        if p['id'] == pid:
            raise ValueError(f'项目 {pid} 已存在')
        if os.path.realpath(p.get('root', '')) == root:
            raise ValueError(f'该目录已绑定项目 {p["id"]}')
    reg['projects'].append({
        'id': pid, 'name': payload.get('name') or pid, 'aliases': [pid],
        'kind': payload.get('kind', 'code'), 'status': payload.get('status', 'active'),
        'priority': int(payload.get('priority', 50)), 'root': root,
        'memory': None, 'note': payload.get('note', ''),
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    })
    P.save_json(P.REGISTRY, reg)
    P.log(f'[panel] add project {pid} -> {root}')
    return snapshot()


def update_project(payload):
    pid = payload.get('id')
    reg = P.load_json(P.REGISTRY, {'projects': []})
    for p in reg['projects']:
        if p['id'] != pid:
            continue
        for key in ('name', 'note', 'kind', 'status'):
            if key in payload:
                p[key] = payload[key]
        if 'aliases' in payload and isinstance(payload['aliases'], list):
            p['aliases'] = [str(a).strip() for a in payload['aliases'] if str(a).strip()][:20]
        if 'priority' in payload:
            p['priority'] = int(payload['priority'])
        P.save_json(P.REGISTRY, reg)
        P.log(f'[panel] update project {pid}: ' + ', '.join(k for k in payload if k != 'id'))
        return snapshot()
    raise ValueError(f'没有项目 {pid}')


def remove_project(payload):
    pid = payload.get('id')
    reg = P.load_json(P.REGISTRY, {'projects': []})
    before = len(reg['projects'])
    reg['projects'] = [p for p in reg['projects'] if p['id'] != pid]
    if len(reg['projects']) == before:
        raise ValueError(f'没有项目 {pid}')
    P.save_json(P.REGISTRY, reg)
    P.log(f'[panel] remove project {pid}')
    return snapshot()


def send_report():
    code, text, msg = P.do_report_with_image(P.load_json(P.CONFIG, {}), quiet=True)
    st = P.load_json(P.STATE, {})
    st['last_run'] = time.time()
    P.save_json(P.STATE, st)
    return {'code': code, 'message': msg, 'text': text, 'state': snapshot()}


# ── HTTP ────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'deck-panel/1.0'

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _html(self, path):
        try:
            body = open(path, 'rb').read()
        except OSError:
            self._json({'ok': False, 'error': 'panel.html 缺失'}, 500)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local(self):
        if self.client_address[0] in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            return True
        cfg = P.load_json(P.CONFIG, {})
        return bool((cfg.get('panel') or {}).get('allowLanRead'))

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._local() and path not in ('/api/node/scanner.py', '/api/node/scanner.js', '/api/node/scanner.ps1'):
            return self._json({'ok': False, 'error': 'forbidden'}, 403)
        if path in ('/', '/index.html'):
            return self._html(HTML)
        if path == '/api/wechat':
            return self._json({'ok': True, 'wechat': wechat_view()})
        if path == '/api/wechat/qr.png':
            fp = P.WECHAT_QR
            if not os.path.isfile(fp):
                return self._json({'ok': False, 'error': '二维码尚未生成'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/icons':
            fp = os.path.join(BASE, 'icons.html')
            if not os.path.isfile(fp):
                return self._json({'ok': False, 'error': 'icons.html 不存在'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ('/api/node/scanner.py', '/api/node/scanner.js', '/api/node/scanner.ps1'):
            pass
        if path == '/api/state':
            try:
                return self._json(snapshot())
            except Exception as e:
                return self._json({'ok': False, 'error': repr(e)}, 500)
        if path == '/api/all-sessions':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return self._json({'ok': True, 'sessions': all_sessions(qs.get('q', [''])[0], int(qs.get('limit', ['300'])[0]))})
        if path == '/api/sessions':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pid = qs.get('id', [''])[0]
            reg = P.load_json(P.REGISTRY, {'projects': []})
            proj = next((x for x in reg['projects'] if x['id'] == pid), None)
            if not proj:
                return self._json({'ok': False, 'error': '项目不存在'}, 404)
            return self._json({'ok': True, 'id': pid, 'sessions': project_sessions(proj.get('root', ''), 20)})
        if path == '/api/decisions':
            return self._json({'ok': True, 'decisions': decisions_view(30)})
        if path == '/api/approvals':
            return self._json({'ok': True, 'items': [x for x in P.load_approvals().get('items', []) if x.get('status') == 'pending']})
        if path == '/api/nodes':
            return self._json({'ok': True, 'nodes': nodes_view()})
        if path == '/api/node/scanner.ps1':
            fp = os.path.join(BASE, 'bin', 'deck-node.ps1')
            if not os.path.isfile(fp):
                return self._json({'ok': False, 'error': 'scanner 不存在'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/api/node/scanner.js':
            fp = os.path.join(BASE, 'bin', 'deck-node.js')
            if not os.path.isfile(fp):
                return self._json({'ok': False, 'error': 'scanner 不存在'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/api/node/scanner.py':
            fp = os.path.join(BASE, 'bin', 'deck-node')
            if not os.path.isfile(fp):
                return self._json({'ok': False, 'error': 'scanner 不存在'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/api/project':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self._json({'ok': True, 'detail': project_detail(qs.get('id', [''])[0])})
            except ValueError as e:
                return self._json({'ok': False, 'error': str(e)}, 404)
        if path == '/api/image/history':
            return self._json({'ok': True, 'images': image_history()})
        if path == '/api/image/file':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = os.path.basename(qs.get('name', [''])[0])
            fp = os.path.join(BASE, 'graphics', name)
            if not name.endswith('.png') or not os.path.isfile(fp):
                return self._json({'ok': False, 'error': '图片不存在'}, 404)
            body = open(fp, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/api/image/latest':
            f = latest_image()
            if not f:
                return self._json({'ok': False, 'error': '还没有图片'}, 404)
            body = open(f, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/api/scan':
            try:
                return self._json({'ok': True, 'candidates': scan_candidates(), **scan_view()})
            except Exception as e:
                return self._json({'ok': False, 'error': repr(e)}, 500)
        return self._json({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._local() and path != '/api/node-scan':
            return self._json({'ok': False, 'error': 'forbidden'}, 403)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            payload = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self._json({'ok': False, 'error': '请求体不是合法 JSON'}, 400)

        try:
            if path == '/api/wechat/login':
                P.wechat_start_login()
                return self._json({'ok': True, 'wechat': wechat_view()})
            if path == '/api/wechat/logout':
                P.save_wechat_state({})
                return self._json({'ok': True, 'wechat': wechat_view()})
            if path == '/api/autonomy':
                return self._json({'ok': True, 'state': set_autonomy(payload.get('project'), payload.get('mode'), payload.get('maxPerDay'))})
            if path == '/api/approval':
                return self._json({'ok': True, **resolve_approval(payload.get('id'), payload.get('action'), payload.get('choice') or '')})
            if path == '/api/scan/ignore':
                return self._json({'ok': True, **ignore_candidate(payload.get('path'), payload.get('days', 7))})
            if path == '/api/bind':
                return self._json({'ok': True, 'state': bind_session(payload)})
            if path == '/api/node-scan':
                try:
                    snap = P.save_node_scan(payload)
                    return self._json({'ok': True, 'node': snap['node'],
                                       'received': len(snap.get('projects', []))})
                except ValueError as e:
                    return self._json({'ok': False, 'error': str(e)}, 400)
            if path == '/api/image':
                return self._json({'ok': True, **send_image_now(dry=bool(payload.get('dry')))})
            if path == '/api/report':
                return self._json({'ok': True, **send_report()})
            if path == '/api/config':
                return self._json({'ok': True, 'state': set_config(payload)})
            if path == '/api/scan':
                action = payload.get('action')
                if action == 'run':
                    return self._json({'ok': True, **run_scan()})
                if action == 'add':
                    return self._json({'ok': True, **add_candidates(payload.get('paths') or [])})
                return self._json({'ok': False, 'error': '未知 action'}, 400)
            if path == '/api/project':
                action = payload.get('action')
                if action == 'add':
                    return self._json({'ok': True, 'state': add_project(payload)})
                if action == 'update':
                    return self._json({'ok': True, 'state': update_project(payload)})
                if action == 'remove':
                    return self._json({'ok': True, 'state': remove_project(payload)})
                return self._json({'ok': False, 'error': '未知 action'}, 400)
        except ValueError as e:
            return self._json({'ok': False, 'error': str(e)}, 400)
        except Exception as e:
            P.log(f'[panel] error {path}: {e!r}')
            return self._json({'ok': False, 'error': repr(e)}, 500)
        return self._json({'ok': False, 'error': 'not found'}, 404)


def main():
    import threading
    threading.Thread(target=lambda: session_index(), daemon=True).start()  # 预热会话索引
    threading.Thread(target=wechat_poller, daemon=True).start()  # 微信内置通道轮询
    httpd = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    P.log(f'[panel] listening http://{HOST}:{PORT}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
