#!/usr/bin/env node
/**
 * pagent-node (Node 版) —— 多节点扫描器，功能与 pagent-node(Python) 一致。
 *
 *   node pagent-node.js scan  [--roots ~/Desktop,~] [--depth 1]
 *   node pagent-node.js push  --server http://192.168.1.3:9199 --token XXX --id hos
 *   node pagent-node.js loop  --interval 21600
 *
 * 配置也可写 ~/.pagent-node.json：{"server":...,"token":...,"id":...,"roots":[...],"depth":1}
 * 只读：不修改项目文件，只上报目录名 / 标记 / git 最近提交。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CONF = path.join(HOME, '.pagent-node.json');
const MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'setup.py',
  'go.mod', 'Cargo.toml', 'AGENTS.md', 'CLAUDE.md', '.dsh-graph', 'README.md'];
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'Library',
  'AppData', 'Downloads', '.npm', '.cache', '.Trash', 'dist', 'build', 'target', 'go', 'vendor']);
const MAX_PROJECTS = 400;

function loadConf() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; }
}

function markersOf(dir) {
  const found = [];
  let latest = 0;
  for (const m of MARKERS) {
    const p = path.join(dir, m);
    if (!fs.existsSync(p)) continue;
    found.push(m);
    if (m === '.git') continue;
    try { latest = Math.max(latest, fs.statSync(p).mtimeMs / 1000); } catch {}
  }
  return { found, latest };
}

function gitInfo(dir) {
  try {
    const out = execSync(`git -C ${JSON.stringify(dir)} log -1 --format='%ct|%h|%s'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (!out) return null;
    const [ts, sha, subj] = out.split('|');
    const dirty = execSync(`git -C ${JSON.stringify(dir)} status --porcelain`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .split('\n').filter(l => l.trim()).length;
    return { ts: parseInt(ts, 10), sha, subject: (subj || '').slice(0, 80), dirty };
  } catch { return null; }
}

function scan(roots, depth) {
  const projects = [];
  const seen = new Set();
  for (const root of roots) {
    const base = path.resolve(root.replace(/^~(?=$|\/)/, HOME));
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
    const level = [[base, 0]];
    while (level.length) {
      const [cur, d] = level.pop();
      if (d >= depth) continue;
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const sub = fs.realpathSync(path.join(cur, e.name));
        if (seen.has(sub)) continue;
        const { found, latest } = markersOf(sub);
        if (found.length) {
          seen.add(sub);
          const git = gitInfo(sub);
          projects.push({ path: sub, name: path.basename(sub), markers: found, git,
            last: latest || (git ? git.ts : 0) });
        }
        level.push([sub, d + 1]);
        if (projects.length >= MAX_PROJECTS) return projects;
      }
    }
  }
  return projects;
}

function post(server, payload) {
  const url = new URL(server.replace(/\/+$/, '') + '/api/node-scan');
  const body = Buffer.from(JSON.stringify(payload));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

async function push(conf, roots, depth) {
  const payload = {
    node: conf.id, token: conf.token, platform: `${process.platform} ${os.release()}`,
    scanned_at: Date.now() / 1000, projects: scan(roots, depth),
  };
  const r = await post(conf.server, payload);
  console.log(`[pagent-node] 上报 ${payload.projects.length} 个项目 → ${conf.server} (HTTP ${r.status}) ${r.body.slice(0, 120)}`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; } else out._.push(a);
  }
  return out;
}

(async () => {
  const conf = Object.assign(loadConf(), parseArgs(process.argv.slice(2)));
  const action = conf._[0] || 'scan';
  const roots = (Array.isArray(conf.roots) ? conf.roots : String(conf.roots || '~/Desktop,~').split(','))
    .map(s => String(s).trim()).filter(Boolean);
  const depth = parseInt(conf.depth || 1, 10);

  if (action === 'scan') {
    const projects = scan(roots, depth);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ projects }, null, 2));
    else { projects.forEach(p => console.log(`${p.markers[0]}\t${p.path}`)); console.log(`共 ${projects.length} 个项目`); }
    return;
  }
  if (!conf.server || !conf.token || !conf.id) {
    console.error('需要 --server / --token / --id（或写进 ~/.pagent-node.json）');
    process.exit(1);
  }
  if (action === 'push') { await push(conf, roots, depth); return; }
  if (action === 'loop') {
    const interval = parseInt(conf.interval || 21600, 10) * 1000;
    console.log(`[pagent-node] 每 ${interval / 1000}s 上报一次`);
    for (;;) {
      try { await push(conf, roots, depth); } catch (e) { console.log('[pagent-node] 上报失败:', e.message); }
      await new Promise(r => setTimeout(r, interval));
    }
  }
})();
