#!/bin/sh
# Install Solipsist: curl -fsSL https://solipsist.sh/install | sh
#
# Downloads the release file for this system, checks it against the release's SHA256SUMS, and puts `solipsist` where
# the writer picks. In a terminal it asks: just for them (~/.local/bin, or $XDG_BIN_HOME; no sudo, the default), for
# everyone (/usr/local/bin, with sudo if it needs it), or this folder only (./solipsist). Without a terminal (piped
# into a log, CI) it asks nothing and installs just for them. Run it again to update.
#
#   SOLIPSIST_VERSION=0.2.0-beta.1  install that release (default: the latest stable one)
#   SOLIPSIST_INSTALL_DIR=<dir>     install there, without asking
#   SOLIPSIST_BASE_URL=<url>        fetch the files from here instead of GitHub Releases (a mirror, or a test)
#   NO_COLOR=1                      no colour
#
# Exit codes: 1 unsupported system, download failed or nowhere to install, 2 checksum mismatch, 3 the installed binary
# doesn't run, 130 interrupted.
#
# Everything is inside main(), called on the last line: piped into sh, a download cut off part way defines functions
# and runs nothing, instead of running the half that arrived.
#
# macOS runs this with bash 3.2, which reads the bytes of a non-ASCII character right after `$name` as part of the
# name: write `${name}` before one (a test checks).
set -eu

REPO="pulkitsharma07/solipsist"
DOCS="https://solipsist.sh/docs"

# ------------------------------------------------------------------------------------------------ output

# fancy: stdout is a terminal (spinner, colour). interactive: also a terminal to read answers from, since piped into
# sh our stdin is the script itself.
fancy=0
interactive=0
B="" D="" G="" R="" C="" N=""
spinning=""

setup_output() {
  if [ -t 1 ]; then fancy=1; fi
  if [ "$fancy" = 1 ] && (: </dev/tty) 2>/dev/null; then interactive=1; fi
  if [ "$fancy" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    B=$(printf '\033[1m') D=$(printf '\033[2m') G=$(printf '\033[32m') R=$(printf '\033[31m') C=$(printf '\033[36m') N=$(printf '\033[0m')
  fi
}

say() { printf '%s\n' "$*"; }
# A finished step: a green tick and its line.
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
clear_line() { if [ "$fancy" = 1 ]; then printf '\r\033[K'; fi; }
die() {
  code=$1; shift
  clear_line
  if [ "$fancy" = 1 ]; then printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2
  else printf 'solipsist install: %s\n' "$*" >&2; fi
  exit "$code"
}
# A path as the writer would type it: ~ for their home.
tilde() {
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}
ask() { printf '%s' "$1"; answer=""; read -r answer </dev/tty || answer=""; }

cleanup() {
  if [ -n "$spinning" ]; then kill "$spinning" 2>/dev/null || true; fi
  if [ "$fancy" = 1 ]; then printf '\033[?25h'; fi
  if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
}

# ------------------------------------------------------------------------------------------------ the system

# The release's name for this system: darwin-arm64, darwin-x64, linux-x64, linux-arm64.
detect() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die 1 "unsupported system: $os/$arch (macOS and Linux only; on Windows use install.ps1)" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) die 1 "unsupported system: $os/$arch" ;;
  esac
  # A terminal running under Rosetta reports x86_64 on an Apple Silicon Mac: install the native one.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
  if [ "$os" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
    die 1 "unsupported system: Linux with musl (Alpine). The Linux build needs glibc."
  fi
  printf '%s-%s' "$os" "$arch"
}

# ------------------------------------------------------------------------------------------------ downloading

# fetch <url> <file>. From GitHub (no SOLIPSIST_BASE_URL) only over HTTPS, redirects included: curl and wget would
# otherwise follow a redirect to plain http.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ "$https_only" = 1 ]; then curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"
    else curl -fsSL "$1" -o "$2"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$https_only" = 1 ]; then wget -q --https-only "$1" -O "$2"
    else wget -q "$1" -O "$2"; fi
  else die 1 "curl or wget is needed"; fi
}

# The size the server says <url> is, or nothing. Only for the progress bar: a failure here is no failure.
content_length() {
  if command -v curl >/dev/null 2>&1; then
    if [ "$https_only" = 1 ]; then curl --proto '=https' --tlsv1.2 -fsIL "$1" 2>/dev/null
    else curl -fsIL "$1" 2>/dev/null; fi
  else wget -q --spider -S "$1" 2>&1; fi | tr -d '\r' | awk 'tolower($1) == "content-length:" && $2 > 0 { n = $2 } END { if (n) print n }' || true
}

size_of() { if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else printf 0; fi; }
human() { awk -v b="$1" 'BEGIN { if (b < 1048576) printf "%d KB", b / 1024; else printf "%.1f MB", b / 1048576 }'; }

# download <url> <file> <label>: in a terminal, fetched in the background under a spinner and a progress bar (the
# size so far when the server doesn't say the whole); otherwise a plain fetch.
download() {
  if [ "$fancy" = 0 ]; then fetch "$1" "$2"; return; fi
  total=$(content_length "$1")
  printf '\033[?25l'
  fetch "$1" "$2" 2>"$tmp/fetch.err" &
  spinning=$!
  i=0
  while kill -0 "$spinning" 2>/dev/null; do
    case $((i % 10)) in
      0) f='⠋' ;; 1) f='⠙' ;; 2) f='⠹' ;; 3) f='⠸' ;; 4) f='⠼' ;;
      5) f='⠴' ;; 6) f='⠦' ;; 7) f='⠧' ;; 8) f='⠇' ;; *) f='⠏' ;;
    esac
    got=$(size_of "$2")
    if [ -n "$total" ]; then
      bar=$(awk -v g="$got" -v t="$total" 'BEGIN { w = 24; k = int(w * g / t); if (k > w) k = w
        s = ""; for (j = 0; j < w; j++) s = s (j < k ? "━" : "─"); printf "%s %3d%%", s, 100 * g / t }')
      printf '\r\033[K  %s%s%s %s  %s%s%s %s' "$C" "$f" "$N" "$3" "$C" "$bar" "$N" "$(human "$got")"
    else
      printf '\r\033[K  %s%s%s %s  %s%s%s' "$C" "$f" "$N" "$3" "$D" "$(human "$got")" "$N"
    fi
    i=$((i + 1))
    sleep 0.1 2>/dev/null || sleep 1
  done
  rc=0
  wait "$spinning" || rc=$?
  spinning=""
  clear_line
  printf '\033[?25h'
  return "$rc"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die 1 "sha256sum or shasum is needed to check the download"; fi
}

# ------------------------------------------------------------------------------------------------ where it goes

# Sets dir. SOLIPSIST_INSTALL_DIR wins; without a terminal it's the writer's own bin folder; in one, they pick, and
# the place they installed before is the default.
choose_dir() {
  user_dir=${XDG_BIN_HOME:-$HOME/.local/bin}
  system_dir=/usr/local/bin
  if [ -n "${SOLIPSIST_INSTALL_DIR:-}" ]; then dir=$SOLIPSIST_INSTALL_DIR; return; fi
  dir=$user_dir
  if [ "$interactive" = 0 ]; then return; fi

  pick=1
  if [ ! -x "$user_dir/solipsist" ] && [ -x "$system_dir/solipsist" ]; then pick=2; fi
  if [ -x "$PWD/solipsist" ] && [ ! -x "$user_dir/solipsist" ] && [ ! -x "$system_dir/solipsist" ]; then pick=3; fi
  mark() { if [ "$1" = "$pick" ]; then printf '%s›%s' "$C" "$N"; else printf ' '; fi; }
  here() { if [ -x "$1/solipsist" ]; then printf '%s(installed)%s' "$G" "$N"; fi; }

  say ""
  say "  ${B}Where should solipsist go?${N}"
  say ""
  printf '  %s %s1%s  Just for me    %-22s %sno sudo%s %s\n' "$(mark 1)" "$B" "$N" "$(tilde "$user_dir")" "$D" "$N" "$(here "$user_dir")"
  printf '  %s %s2%s  Everyone       %-22s %smay ask for your password%s %s\n' "$(mark 2)" "$B" "$N" "$system_dir" "$D" "$N" "$(here "$system_dir")"
  printf '  %s %s3%s  This folder    %-22s %srun it as ./solipsist%s %s\n' "$(mark 3)" "$B" "$N" "./" "$D" "$N" "$(here "$PWD")"
  say ""
  while :; do
    ask "  Choose 1-3 [$pick]: "
    case "${answer:-$pick}" in
      1) dir=$user_dir; break ;;
      2) dir=$system_dir; break ;;
      3) dir=$PWD; break ;;
      q|Q) say "  Nothing installed."; exit 0 ;;
      *) say "  ${D}Type 1, 2 or 3 (q to quit).${N}" ;;
    esac
  done
  say ""
}

# Sets as: "" when we can write to dir, "sudo" when the writer agreed to it.
need_rights() {
  as=""
  probe=$dir
  while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
  if [ -w "$probe" ]; then return; fi
  if [ "$interactive" = 1 ] && command -v sudo >/dev/null 2>&1; then
    say "  ${D}$(tilde "$dir") isn't yours to write: sudo will ask for your password.${N}"
    as=sudo
  else
    die 1 "can't write to $dir (set SOLIPSIST_INSTALL_DIR to a folder you own)"
  fi
}

# The file a writer's shell reads at start, for the PATH line.
shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    */fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

path_line() {
  case "$1" in
    *.fish) printf 'fish_add_path %s' "$dir" ;;
    *) printf 'export PATH="%s:$PATH"' "$dir" ;;
  esac
}

# ------------------------------------------------------------------------------------------------ a model

# Whether the agent has a model to use: an OpenRouter key in the environment, or any login Pi has saved (as the app's
# piAuthSaved asks). Only read: Pi's folder is Pi's, and the installer never writes there.
has_login() {
  if [ -n "${SOLIPSIST_OPENROUTER_KEY:-}" ] || [ -n "${OPENROUTER_API_KEY:-}" ]; then return 0; fi
  pi_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
  case "$pi_dir" in "~"/*) pi_dir="$HOME/${pi_dir#"~/"}" ;; esac
  [ -f "$pi_dir/auth.json" ] && grep -q '"type"' "$pi_dir/auth.json"
}

# Says whether a model is connected, and how to connect one when it isn't.
connect_model() {
  if has_login; then
    if [ "$fancy" = 1 ]; then ok "A model is connected ${D}(an OpenRouter key, or a login saved in Pi)${N}"; fi
    return
  fi
  rc=$(shell_rc)
  say ""
  if [ "$fancy" = 1 ]; then
    say "  ${B}Connect a model${N} ${D}(the agent needs one before it can answer)${N}"
    say "    An OpenRouter key ${D}(https://openrouter.ai/keys)${N}, in $(tilde "$rc"):"
    say "      ${C}export SOLIPSIST_OPENROUTER_KEY=sk-or-...${N}"
    if command -v pi >/dev/null 2>&1; then
      say "    or a login saved in Pi: run ${C}pi${N}, then ${C}/login${N}"
    fi
    say "    ${D}More, local models too: ${DOCS}/start/connect-a-model/${N}"
  else
    say "No model connected yet. Set SOLIPSIST_OPENROUTER_KEY (export SOLIPSIST_OPENROUTER_KEY=sk-or-... in $(tilde "$rc")),"
    say "or run pi then /login. More: ${DOCS}/start/connect-a-model/"
  fi
}

# ------------------------------------------------------------------------------------------------ main

main() {
  setup_output
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  target=$(detect)
  asset="solipsist-$target.tar.gz"
  https_only=1
  if [ -n "${SOLIPSIST_BASE_URL:-}" ]; then
    base=$SOLIPSIST_BASE_URL
    https_only=0
  elif [ -n "${SOLIPSIST_VERSION:-}" ]; then
    base="https://github.com/$REPO/releases/download/v${SOLIPSIST_VERSION#v}"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi

  if [ "$fancy" = 1 ]; then
    say ""
    say "  ${B}Solipsist${N} ${D}installer · ${target}${N}"
  fi
  choose_dir

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/solipsist-install.XXXXXX")

  if [ "$fancy" = 0 ]; then say "Downloading Solipsist for ${target}…"; fi
  download "$base/$asset" "$tmp/$asset" "Downloading Solipsist for ${target}" || die 1 "could not download $base/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die 1 "could not download $base/SHA256SUMS"
  if [ "$fancy" = 1 ]; then ok "Downloaded $asset ${D}($(human "$(size_of "$tmp/$asset")"))${N}"; fi

  want=$(grep "  $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)
  [ -n "$want" ] || die 1 "$asset is not in the release's SHA256SUMS"
  got=$(sha256_of "$tmp/$asset")
  [ "$got" = "$want" ] || die 2 "checksum mismatch for $asset (expected $want, got $got): nothing installed"
  if [ "$fancy" = 1 ]; then ok "Checksum matches the release ${D}(SHA-256)${N}"; fi

  tar -xzf "$tmp/$asset" -C "$tmp"
  bin=$(find "$tmp" -type f -name solipsist -path "*/solipsist-*/solipsist" | head -n 1)
  [ -n "$bin" ] || die 1 "the download has no solipsist binary in it"
  chmod +x "$bin"
  version=$("$bin" --version 2>&1) || die 3 "the downloaded binary doesn't run: $version"

  need_rights
  $as mkdir -p "$dir"
  # Copy beside the target, then rename over it: replacing a binary that is running is safe this way.
  $as cp "$bin" "$dir/.solipsist.new.$$"
  $as chmod 755 "$dir/.solipsist.new.$$"
  $as mv -f "$dir/.solipsist.new.$$" "$dir/solipsist"

  if [ "$fancy" = 1 ]; then ok "Installed ${B}${version}${N}"; say "    ${D}$(tilde "$dir/solipsist")${N}"
  else say "Installed: $version"; say "  $dir/solipsist"; fi

  # How to start it: by name when it's on the PATH (or will be), else by where it is.
  run="solipsist"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      if [ "$dir" = "$PWD" ]; then run="./solipsist"
      else
        rc=$(shell_rc)
        line=$(path_line "$rc")
        added=0
        if [ -f "$rc" ] && grep -qF "$line" "$rc"; then
          say ""
          say "  ${D}$(tilde "$dir") is in $(tilde "$rc") already: open a new terminal to use it.${N}"
          added=1
        elif [ "$interactive" = 1 ]; then
          say ""
          ask "  $(tilde "$dir") isn't on your PATH. Add it to $(tilde "$rc")? [Y/n] "
          case "$answer" in
            ""|y|Y|yes|Yes)
              mkdir -p "$(dirname "$rc")"
              printf '\n# Added by the Solipsist installer\n%s\n' "$line" >>"$rc"
              ok "Added to $(tilde "$rc") ${D}(open a new terminal, or run: . $(tilde "$rc"))${N}"
              added=1 ;;
          esac
        fi
        if [ "$added" = 0 ]; then
          if [ "$fancy" = 1 ]; then
            run="$(tilde "$dir")/solipsist"
            say ""
            say "  $(tilde "$dir") is not on your PATH. Add it:"
            say "    ${C}echo '$line' >> $(tilde "$rc")${N}   ${D}# then open a new terminal${N}"
          else
            run="$dir/solipsist"
            say ""
            say "$dir is not on your PATH. Add it:"
            say "  echo '$line' >> $(tilde "$rc")   # then open a new terminal"
          fi
        fi
      fi
      ;;
  esac

  connect_model

  say ""
  if [ "$fancy" = 1 ]; then
    say "  ${B}Get started${N}"
    say "    cd ~/my-notes && ${C}${run}${N}      ${D}then open http://localhost:3000${N}"
    say ""
    say "  ${B}Docs${N}             ${C}${DOCS}/${N}"
    say "  ${B}Connect a model${N}  ${C}${DOCS}/start/connect-a-model/${N}"
    say "  ${B}Configuration${N}    ${C}${DOCS}/reference/configuration/${N}"
    say "  ${B}Guides${N}           ${C}${DOCS}/start/first-request/${N}"
    say ""
    say "  ${D}To update, run the install command again. To uninstall: ${as:+sudo }rm $(tilde "$dir/solipsist")"
    say "  (your pages are never touched)${N}"
    say ""
  else
    say "Run it in a folder of markdown files:  $run"
    say "Docs and configuration:  ${DOCS}/"
    say "To uninstall:  rm $dir/solipsist   (your pages are never touched)"
  fi
}

main "$@"
