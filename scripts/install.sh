#!/bin/sh
# Install Solipsist: curl -fsSL https://get.solipsist.sh | sh
#
# Downloads the release file for this system, checks it against the release's SHA256SUMS, and puts `solipsist` in
# ~/.local/bin (or $XDG_BIN_HOME, or $SOLIPSIST_INSTALL_DIR). No sudo, nothing outside that folder. Run it again to update.
#
#   SOLIPSIST_VERSION=0.2.0-beta.1  install that release (default: the latest stable one)
#   SOLIPSIST_INSTALL_DIR=<dir>     install there
#   SOLIPSIST_BASE_URL=<url>        fetch the files from here instead of GitHub Releases (a mirror, or a test)
#
# Exit codes: 1 unsupported system or download failed, 2 checksum mismatch, 3 the installed binary doesn't run.
#
# Everything is inside main(), called on the last line: piped into sh, a download cut off part way defines functions
# and runs nothing, instead of running the half that arrived.
set -eu

REPO="pulkitsharma07/solipsist"

say() { printf '%s\n' "$*"; }
die() { code=$1; shift; printf 'solipsist install: %s\n' "$*" >&2; exit "$code"; }

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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die 1 "sha256sum or shasum is needed to check the download"; fi
}

main() {
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
  dir=${SOLIPSIST_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/solipsist-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading Solipsist for $target…"
  fetch "$base/$asset" "$tmp/$asset" || die 1 "could not download $base/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die 1 "could not download $base/SHA256SUMS"

  want=$(grep "  $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)
  [ -n "$want" ] || die 1 "$asset is not in the release's SHA256SUMS"
  got=$(sha256_of "$tmp/$asset")
  [ "$got" = "$want" ] || die 2 "checksum mismatch for $asset (expected $want, got $got): nothing installed"

  tar -xzf "$tmp/$asset" -C "$tmp"
  bin=$(find "$tmp" -type f -name solipsist -path "*/solipsist-*/solipsist" | head -n 1)
  [ -n "$bin" ] || die 1 "the download has no solipsist binary in it"
  chmod +x "$bin"
  version=$("$bin" --version 2>&1) || die 3 "the downloaded binary doesn't run: $version"

  mkdir -p "$dir"
  # Copy beside the target, then rename over it: replacing a binary that is running is safe this way.
  cp "$bin" "$dir/.solipsist.new.$$"
  mv -f "$dir/.solipsist.new.$$" "$dir/solipsist"

  say "Installed: $version"
  say "  $dir/solipsist"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *)
      say ""
      say "$dir is not on your PATH. Add it:"
      say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile   # then open a new terminal"
      ;;
  esac
  say ""
  say "Run it in a folder of markdown files:  solipsist"
  say "To uninstall:  rm $dir/solipsist   (your pages are never touched)"
}

main "$@"
