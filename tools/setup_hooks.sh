#!/bin/sh
# Setup git hooks for prview-rs
# Run once after cloning or via `make git-hooks`
#
# Contract: git hooks in this repo are fast push/commit guards only. No hook
# compiles the crate or runs a heavy gate (`cargo check`, `cargo clippy`,
# `cargo test`, `cargo build`, `prview gate`). Quality proof lives in required
# CI and in an explicitly invoked `make check` / `prview gate`.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

echo "Installing git hooks..."

mkdir -p "$REPO_ROOT/.git/hooks"

# Create symlinks
ln -sf "$REPO_ROOT/tools/githooks/pre-commit" "$REPO_ROOT/.git/hooks/pre-commit"

# Drop the pre-push symlink installed by earlier versions of this script: it
# ran `prview gate` on every push. Only a symlink pointing into tools/githooks
# is removed, so a pre-push hook a developer installed themselves survives.
STALE_PRE_PUSH="$REPO_ROOT/.git/hooks/pre-push"
if [ -L "$STALE_PRE_PUSH" ]; then
  STALE_TARGET=$(readlink "$STALE_PRE_PUSH")
  case "$STALE_TARGET" in
    */tools/githooks/* | tools/githooks/*)
      rm -f "$STALE_PRE_PUSH"
      echo "Removed the stale pre-push gate hook symlink."
      ;;
  esac
fi

# Make sure they're executable
chmod +x tools/githooks/pre-commit

echo "Git hooks installed:"
echo "  - pre-commit -> rustfmt --check on staged Rust files (no compilation)"
echo
echo "No pre-push hook is installed here: 'prview gate' runs in CI and on demand."
echo "Downstream repos can opt in to a pre-push gate; see docs/gate-playbook.md."
echo
echo "Done!"
