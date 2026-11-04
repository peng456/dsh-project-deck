# dsh-pagent

**A personal project control panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

Turn a pile of repos, directories and half-finished ideas into a project registry with a live dashboard, a 4-hour WeChat progress report (text + chart image), automatic discovery of new projects, and multi-machine scanning.

```
┌────────────── DSH Desktop ──────────────┐
│  📋 个人 Agent  ← floating button        │
│   └── overlay panel (127.0.0.1:9199)    │
│                                         │
│  tools: pagent_status / list / scan /   │
│         nodes / report                  │
└───────────────┬─────────────────────────┘
                │ iframe + postMessage
┌───────────────▼─────────────────────────┐
│  backend: pagent CLI + panel server     │
│  · registry.json  · 4h scheduler        │
│  · WeChat push (wxpush / ServerChan)    │
│  · discovery + multi-node ingestion     │
└───────────────┬─────────────────────────┘
                │ HTTP (token)
        phones / laptops / servers
```

## Features

- **Project registry** — one JSON file, alias-aware, `pagent list / add / rm`.
- **Dashboard** — cards per project (git state, activity, next action), search & filter, detail modal (recent sessions, git log, board goals, memory excerpt), one click to open the project's latest DSH session.
- **4-hour reports** — Markdown text + a rendered board image, pushed to WeChat; changed projects first, unchanged ones collapsed into one line; quiet hours (default 00:30–06:30) are respected.
- **Progress that actually moves** — per report it recomputes git commits since last run, uncommitted files, new/updated sessions, board goals, and reads `next_action` from the project's persisted STATE.
- **Auto-discovery** — scans DSH workspaces, git repos and marker files; scores candidates, auto-registers high-confidence ones, and lets you ignore the rest (7 days / forever).
- **Multi-node scanning** — a tiny read-only scanner pushes each machine's project list to the coordinator (`/api/node-scan`, per-node token). Python, Node and PowerShell versions included.
- **DSH integration** — floating overlay inside the app, five `pagent_*` tools, custom `#pagent-session=<id>` deep link to jump to a session.

## Requirements

- DSH Desktop or `dsh web` (the plugin half is a normal DSH bundle).
- **Python 3.9+** for the backend (no third-party packages).
- Optional: Google Chrome (headless screenshots for the report image), `wxpush` or ServerChan for WeChat delivery.

## Install

### 1. Backend

```bash
git clone https://github.com/peng456/dsh-pagent.git
cd dsh-pagent
./install.sh          # copies backend to ~/.person-agent, starts scheduler + panel (macOS launchd)
```

`install.sh` prints the panel URL (`http://127.0.0.1:9199`).

### 2. Plugin

From GitHub (no build step — `lib/` is committed):

```bash
dsh plugin --profile desktop add github:peng456/dsh-pagent
```

Or in the Desktop app: **Plugins** page → install `github:peng456/dsh-pagent`.
Manual fallback: copy this repo into `~/.dsh/profiles/desktop/node_modules/dsh-pagent`
and add `"dsh-pagent"` to `dsh.profile.bundles` in the profile's `package.json`.

Restart DSH. A 📋 button appears bottom-left; `Cmd+R` reloads the client half.

> npm publishing is not done yet — the package name `dsh-pagent` is reserved but no release exists.

## Usage

```bash
pagent add my-project --root ~/code/my-project --kind code --note "what it is"
pagent list
pagent status                 # channel, next run, quiet hours
pagent report                 # send now (text + image if enabled)
pagent image                  # board image only
pagent scan                   # discovery candidates
pagent scan --add             # auto-register high-confidence ones
pagent nodes add --id phone --name "My phone" --platform android
```

Backend state lives in `~/.person-agent/`:

```
registry.json config.json report-state.json channel-state.json scan-ignore.json nodes.json
reports.jsonl last-report.txt graphics/ logs/ nodes/
```

## Configuration (`config.json`)

| key | meaning |
|---|---|
| `report.intervalHours` | report period (default 4) |
| `report.format` | `markdown` or `plain` |
| `report.image` | attach the board image |
| `report.maxChars` | report length cap |
| `scan.intervalHours` | discovery period (default 12) |
| `scan.threshold` | auto-register score (default 70) |
| `scan.roots` / `scan.depth` | where to scan |
| `schedule.quiet` | `{"from":"00:30","to":"06:30"}` — no reports/scans in this window |
| `panel.allowLanRead` | let phones read the panel over LAN (no password by design) |

## Multi-node scanning

On each machine:

```bash
# Python
python3 pagent-node push --server http://<coordinator>:9199 --token <token> --id <node-id>
python3 pagent-node loop --interval 21600        # every 6h, quiet hours aware

# Node.js
node pagent-node.js loop --server ... --token ... --id ...

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File pagent-node.ps1 -Server http://<coordinator>:9199 -Token <token> -Id my-win
```

Nodes are read-only: they report directory names, marker files and the last git commit. No file content is uploaded.

## Security notes

- The panel binds `0.0.0.0` so phones can read it; **read APIs are open on the LAN by design**, write APIs stay loopback-only, and `POST /api/node-scan` always requires the per-node token.
- WeChat delivery uses the unofficial iLink bot protocol through a local `wxpush` service; its `context_token` expires after a few hours of inactivity — the scheduler then skips instead of queueing duplicates and resumes automatically once you message the bot.
- Never commit `nodes.json`, `config.json` or `~/.wxpush/state.json` (tokens live there).

## License

MIT
