#!/usr/bin/env bash
# Build vgrep + Mojo sidecar, install to ~/.vgrep/bin, and add to PATH.
#
# Re-run any time to upgrade — this overwrites the binaries in place but
# leaves the model cache (~/.vgrep/models) and shell-rc PATH block alone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VGREP_HOME="${VGREP_HOME:-$HOME/.vgrep}"
BIN_DIR="$VGREP_HOME/bin"
MODEL_DIR="$VGREP_HOME/models"
MANIFEST="$REPO_ROOT/packages/core-mojo/pixi.toml"

# ── deps ──────────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 not found in PATH" >&2; exit 1; }; }
need bun

PIXI="${PIXI:-}"
if [ -z "$PIXI" ]; then
  if [ -x "$HOME/.pixi/bin/pixi" ]; then
    PIXI="$HOME/.pixi/bin/pixi"
  elif command -v pixi >/dev/null 2>&1; then
    PIXI="$(command -v pixi)"
  else
    echo "error: pixi not found. install from https://pixi.sh/" >&2
    exit 1
  fi
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)         TARGET=darwin-arm64 ;;
  Darwin-x86_64)        TARGET=darwin-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  Linux-x86_64)         TARGET=linux-x64 ;;
  *) echo "error: unsupported platform $(uname -sm)" >&2; exit 1 ;;
esac

mkdir -p "$BIN_DIR" "$MODEL_DIR"

# ── build ─────────────────────────────────────────────────────────────
echo "→ building Mojo sidecar"
"$PIXI" run --manifest-path "$MANIFEST" build >/dev/null
install -m 0755 "$REPO_ROOT/packages/core-mojo/dist/vgrep-core" "$BIN_DIR/vgrep-core"

echo "→ building CLI ($TARGET)"
(cd "$REPO_ROOT/packages/cli" && bun run "build:$TARGET" >/dev/null)
install -m 0755 "$REPO_ROOT/packages/cli/dist/vgrep-$TARGET" "$BIN_DIR/vgrep"

# ── install manifest ──────────────────────────────────────────────────
# The compiled CLI reads this to find the sidecar + the pixi env that
# hosts its Python deps (sentence-transformers, tree_sitter, sqlite3).
cat >"$VGREP_HOME/install.json" <<EOF
{
  "version": "0.1.0",
  "sidecarBinary": "$BIN_DIR/vgrep-core",
  "pixi": "$PIXI",
  "pixiManifest": "$MANIFEST",
  "modelDir": "$MODEL_DIR",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── PATH wiring ───────────────────────────────────────────────────────
add_path_block() {
  local rc="$1"
  [ -e "$rc" ] || touch "$rc"
  if grep -Fq '# vgrep:path' "$rc"; then return 0; fi
  printf '\n# vgrep:path\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$rc"
  echo "  + PATH added to $rc"
}

case "$(basename "${SHELL:-bash}")" in
  zsh)  add_path_block "$HOME/.zshrc" ;;
  bash) add_path_block "$HOME/.bashrc"; add_path_block "$HOME/.bash_profile" ;;
  fish)
    fish_conf="$HOME/.config/fish/conf.d/vgrep.fish"
    mkdir -p "$(dirname "$fish_conf")"
    if [ ! -e "$fish_conf" ]; then
      printf '# vgrep:path\nset -gx PATH %s $PATH\n' "$BIN_DIR" >"$fish_conf"
      echo "  + PATH added to $fish_conf"
    fi
    ;;
  *) echo "  ! unknown shell ($SHELL); add $BIN_DIR to PATH manually" ;;
esac

echo
echo "✓ installed: $BIN_DIR/vgrep"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  open a new shell, or run:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
