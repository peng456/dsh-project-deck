#!/usr/bin/env bash
# dsh-pagent installer: copies the backend to ~/.person-agent, initialises config,
# and (on macOS) registers two launchd jobs: the report scheduler and the panel server.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${PAGENT_HOME:-$HOME/.person-agent}"
PY="${PAGENT_PYTHON:-python3}"
PORT="${PAGENT_PANEL_PORT:-9199}"

mkdir -p "$BASE/bin" "$BASE/logs" "$BASE/graphics"
cp "$REPO/backend/pagent" "$REPO/backend/panel.py" "$BASE/bin/"
cp "$REPO/backend/pagent-node" "$REPO/backend/pagent-node.js" "$REPO/backend/pagent-node.ps1" "$BASE/bin/"
cp "$REPO/backend/panel.html" "$BASE/panel.html"
chmod +x "$BASE"/bin/pagent "$BASE"/bin/pagent-node

if [ ! -f "$BASE/config.json" ]; then
  cat > "$BASE/config.json" <<JSON
{
  "version": 1,
  "report": { "enabled": true, "intervalHours": 4, "format": "markdown", "image": true, "maxChars": 1200 },
  "scan": { "enabled": true, "autoAdd": true, "intervalHours": 12, "threshold": 70, "depth": 1,
            "roots": ["~/Desktop", "~"] },
  "schedule": { "quiet": { "from": "00:30", "to": "06:30" } },
  "panel": { "allowLanRead": true }
}
JSON
  echo "created $BASE/config.json"
fi
[ -f "$BASE/registry.json" ] || echo '{"version":1,"projects":[]}' > "$BASE/registry.json"

# convenience symlink
mkdir -p "$HOME/bin"
ln -sf "$BASE/bin/pagent" "$HOME/bin/pagent"

if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  write_job() { # label, args...
    local label="$1"; shift
    cat > "$HOME/Library/LaunchAgents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$1</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$BASE/logs/$label.out.log</string>
  <key>StandardErrorPath</key><string>$BASE/logs/$label.err.log</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null || true
  }
  write_job "com.pagent.report" "<string>$PY</string><string>$BASE/bin/pagent</string><string>daemon</string>"
  write_job "com.pagent.panel" "<string>$PY</string><string>$BASE/bin/panel.py</string>"
  echo "launchd jobs loaded: com.pagent.report, com.pagent.panel"
else
  echo "Start the backend manually:"
  echo "  PAGENT_PANEL_PORT=$PORT python3 $BASE/bin/panel.py &"
  echo "  python3 $BASE/bin/pagent daemon &"
fi

echo
echo "panel:   http://127.0.0.1:$PORT"
echo "cli:     ~/bin/pagent status"
echo "plugin:  install this repo into your DSH profile (see README) and restart DSH"
