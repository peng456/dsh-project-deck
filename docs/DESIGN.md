# Design notes

## Why a plugin + a backend

DSH plugins are Node bundles loaded by the host; the panel needs a long-lived process
that can render charts, send WeChat messages and survive restarts. So the plugin stays
thin (tools + overlay iframe) and the backend owns scheduling, rendering and delivery.
The two halves talk over `http://127.0.0.1:9199` (loopback only for writes).

## Project model

A project is a working directory plus optional memory. The registry (`registry.json`)
is the single source of truth:

```jsonc
{ "id": "my-app", "name": "My App", "root": "/Users/me/my-app", "kind": "code",
  "status": "active", "priority": 60, "aliases": ["my-app"], "note": "…",
  "memory": { "project": "my-app", "slug": "my-app" }, "sessions": ["session-…"] }
```

`memory` points at a persisted STATE in `~/.ai` (shared with other CLIs); `sessions`
holds manually bound session ids that live in another DSH workspace.

## Report pipeline

```
daemon (every 30s)
  ├─ quiet hours? sleep
  ├─ discovery due? scan → auto-register ≥ threshold → remember candidates
  └─ report due? build → push text → render PNG (headless Chrome) → push image
```

"Progress" is computed from deltas against the previous report: git commits since last
run, uncommitted files, session ids added/changed (snapshot kept in `report-state.json`),
board goal counts, and `next_action` parsed from the persisted STATE.

## Delivery channel

`wxpush` (iLink bot) is the default: HTTP `POST /send`, exit code 0 = delivered.
iLink's `context_token` expires after a few hours of inactivity; the scheduler tracks
consecutive failures, stops queueing duplicates, and resumes automatically once the
token hash changes (i.e. the user messaged the bot). ServerChan can be used instead.

## Node scanning

Each node runs a read-only scanner and pushes JSON to `POST /api/node-scan` with its own
token. Snapshots land in `nodes/<id>.json` and are merged into discovery as candidates
tagged with their node. Nodes never pull from the coordinator.
