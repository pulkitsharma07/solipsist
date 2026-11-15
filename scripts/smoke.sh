#!/usr/bin/env bash
# The release's smoke test of one built archive, on the system it is for:
#
#   bash scripts/smoke.sh dist/release/solipsist-darwin-arm64.tar.gz 0.2.0
#
# Unpacks it, checks `--version` says that version, starts the binary in a folder with a planted bunfig.toml preload
# (which must not run), loads the page and every script and stylesheet it names and the pages list, then stops it
# and checks no process is left. Run by the release workflow on each system (`smoke` in release.yml); bash, so it
# runs the same on Linux, macOS and Windows' Git Bash.
set -euo pipefail

archive=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
version=$2
port=${SMOKE_PORT:-47123}

work=$(mktemp -d)
pid=""
fail() {
  echo "::error::$*"
  [ -f "$work/server.out" ] && { echo "--- the server said:"; cat "$work/server.out"; }
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  exit 1
}

cd "$work"
case "$archive" in
  *.zip)
    exe=solipsist.exe
    if command -v unzip > /dev/null; then unzip -q "$archive"
    else powershell -NoProfile -Command "Expand-Archive -Path '$archive' -DestinationPath '$work'"; fi
    ;;
  *) exe=solipsist; tar -xzf "$archive" ;;
esac
folder=""
for d in "$work"/solipsist-*/; do folder=$d; break; done
bin=${folder%/}/$exe
[ -f "$bin" ] || fail "no $exe in $(basename "$archive")"

line=$("$bin" --version) || fail "--version failed: $line"
echo "$line"
case "$line" in "solipsist $version ("*) ;; *) fail "--version says '$line', expected $version" ;; esac

mkdir docs && echo "# hi" > docs/a.md && cd docs
# The folder is the writer's, maybe anyone's: a preload in its bunfig.toml must not run.
printf 'preload = ["./planted.ts"]\n' > bunfig.toml
echo 'require("fs").writeFileSync("planted-ran", "")' > planted.ts
"$bin" --version > /dev/null
[ ! -e planted-ran ] || fail "the binary ran the folder's bunfig.toml preload"

PORT=$port SOLIPSIST_TUI=0 "$bin" > "$work/server.out" 2>&1 &
pid=$!
up=""
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "localhost:$port/")" = 200 ]; then up=1; break; fi
  sleep 1
done
[ -n "$up" ] || fail "the page never answered on port $port"
html=$(curl -fsS "localhost:$port/") || fail "the page failed"
for asset in $(echo "$html" | grep -oE '(src|href)="[^"]+\.(js|css)"' | sed -E 's/.*="(.*)"/\1/'); do
  curl -fsS -o /dev/null "localhost:$port$asset" || fail "$asset failed"
done
curl -fsS "localhost:$port/api/pages" > /dev/null || fail "/api/pages failed"

kill "$pid"; wait "$pid" 2>/dev/null || true
pid=""
sleep 1
if command -v pgrep > /dev/null; then
  if pgrep -f "$work" > /dev/null; then fail "a process was left behind"; fi
elif command -v tasklist > /dev/null; then
  if tasklist | grep -qi "^$exe"; then fail "a process was left behind"; fi
fi
echo "smoke: $(basename "$archive") is fine"
