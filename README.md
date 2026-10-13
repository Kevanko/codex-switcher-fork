<div align="center">

# Codex Switcher

**One switcher for your Codex, Claude Code and Z.ai accounts.**
Hit a limit — switch to the next account in one click and keep coding.

**English** · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/Kevanko/codex-switcher-fork?style=flat-square&color=3b82f6)](https://github.com/Kevanko/codex-switcher-fork/releases/latest)
![Platforms](https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-10131a?style=flat-square)

![Codex Switcher](screenshots/codex-switcher.gif)

</div>

## Quick start

1. Download the installer from the [latest release](https://github.com/Kevanko/codex-switcher-fork/releases/latest):
   - Windows — `*_x64-setup.exe`
   - macOS — `*_aarch64.dmg` (Apple Silicon) or `*_x64.dmg`
   - Linux — `.AppImage`, `.deb` or `.rpm`
2. Add accounts on the tab you need:
   - **Codex** — sign in with ChatGPT, or import `~/.codex/auth.json`.
   - **Claude** — log in with `claude`, then press **Add account** (or import `~/.claude/.credentials.json`).
   - **Claude CLI** — long-lived tokens from `claude setup-token`.
   - **Z.ai** — snapshots of your ZCode sign-ins.
3. Click an account → **Switch**. Codex and ZCode restart by themselves; restart Claude Code yourself.

The app updates itself from GitHub releases.

## What you get

| | Codex | Claude |
| --- | :---: | :---: |
| 5-hour and weekly limits with reset timers | ✓ | ✓ |
| One-click switch | ✓ | ✓ |
| Switch from the tray | ✓ | — |
| Plan badges (Plus / Pro / Team, Pro / Max) | ✓ | ✓ |

Plus: encrypted backup (`.cswf`), one toggle to hide all emails, RU/EN, light/dark theme. MCP connector logins in `.credentials.json` stay intact when you switch Claude accounts.

![Screenshot](screenshots/app-dark.png)

## Build from source

Needs Node.js 20+, pnpm and Rust stable.

```bash
git clone https://github.com/Kevanko/codex-switcher-fork.git
cd codex-switcher-fork
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # installers → src-tauri/target/release/bundle/
```

Release: `pnpm release:patch -- --push` — bumps the version everywhere and pushes a tag; GitHub Actions builds the rest.

## Disclaimer

Unofficial project, not affiliated with OpenAI, Anthropic or Z.ai. Use only with accounts you own; it does not add quota and is not meant for account sharing.
