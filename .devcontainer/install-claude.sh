#!/usr/bin/env bash
# ============================================================
#  Runs ONCE when the Codespace is first created.
#  Installs Claude Code so it's ready when the user opens a terminal.
# ============================================================

set -e

echo ""
echo "=========================================="
echo "  Setting up Claude Code..."
echo "=========================================="

# Install Claude Code (official installer for Linux)
curl -fsSL https://claude.ai/install.sh | bash

# Make sure ~/.local/bin is on PATH for future shells
if ! grep -q 'HOME/.local/bin' ~/.bashrc 2>/dev/null; then
    echo '' >> ~/.bashrc
    echo '# Added by Claude Launcher' >> ~/.bashrc
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

# Add it to this current session too (used during postCreate)
export PATH="$HOME/.local/bin:$PATH"

# Verify
if command -v claude >/dev/null 2>&1; then
    echo ""
    echo "  Claude Code installed: $(claude --version 2>&1 | head -n1)"
else
    echo ""
    echo "  WARNING: claude not on PATH yet. Open a new terminal."
fi

echo ""
echo "  Setup complete. Open a terminal and type 'claude' to begin."
echo "=========================================="
