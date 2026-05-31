# Codex Switcher

Unofficial desktop fork for switching between several local Codex/ChatGPT account profiles.

The app keeps account metadata and cached usage locally, writes the selected profile to the Codex auth file, and helps track the 5-hour and weekly usage windows where they are available. It is built as a Tauri desktop app for Windows, macOS, and Linux.

## What it does

- Adds accounts through ChatGPT OAuth or by importing an existing `auth.json`.
- Switches the active local Codex account and can restart active Codex processes after switching.
- Shows cached limit usage for Free, Plus, Pro, and Team-style accounts.
- Supports Russian/English UI, system/default theme selection, accent presets, and compact card density.
- Checks GitHub releases for signed app updates.
- Can minimize to the system tray and switch between available accounts from the tray menu.

## What it is not

- It is not an official OpenAI or Codex project.
- It is not meant for account sharing, resale, pooling, or bypassing terms of service.
- It does not create extra quota. It only displays locally cached usage data and switches between accounts you already own.
- The optional browser/LAN server exists for development and local debugging. The maintained user-facing build is the desktop app.

## Build from source

Prerequisites:

- Node.js 20 or newer
- pnpm
- Rust stable

```bash
git clone https://github.com/Kevanko/codex-switcher-fork.git
cd codex-switcher-fork

pnpm install
pnpm tauri dev
```

Build installers:

```bash
pnpm tauri build
```

The built bundles are written under `src-tauri/target/release/bundle/`.

## Release

The release helper keeps `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` on the same version.

```bash
pnpm version:patch
pnpm version:minor
pnpm version:major

pnpm release:patch
pnpm release:patch -- --push
```

GitHub Actions builds the release assets from tags like `v0.2.10`. The updater reads:

```text
https://github.com/Kevanko/codex-switcher-fork/releases/latest/download/latest.json
```

Before pushing a release, keep the working tree clean and make sure no local agent files, screenshots, or temporary notes are staged.

## Local data

Account storage lives in the user's local profile. The app also reads and writes the normal Codex auth location so the selected account is picked up by Codex itself.

Full backups use the app's encrypted `.cswf` format. Slim import/export is intended only for non-secret account metadata.

## Disclaimer

Use this only with accounts you personally control. You are responsible for following OpenAI's and ChatGPT's terms. This fork does not grant permission to share accounts or automate quota abuse.
