#!/usr/bin/env bash
# Shown each time the user attaches to the Codespace.
clear
cat << 'BANNER'

  Welcome to your Claude workspace
  ----------------------------------

  To start Claude Code, just type:

      claude

  The first time, it will open a browser tab to log in
  to your Anthropic account (Pro/Max/Team/API credits).

  Useful commands inside Claude Code:
    /help    -  list all commands
    /init    -  generate a CLAUDE.md for this project
    /exit    -  quit Claude Code

  Need help? https://code.claude.com/docs

BANNER
