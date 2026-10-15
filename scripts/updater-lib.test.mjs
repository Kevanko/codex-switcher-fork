// node --test scripts/updater-lib.test.mjs — runs on every push. Pins the updater logic the release
// gate relies on, so the gate itself cannot quietly stop catching things.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INSTALL_KINDS, isNewer, pickEntry } from "./updater-lib.mjs";

const e = (file) => ({ url: `https://x/releases/download/v1.0.0/${file}`, signature: "sig" });
// The manifest shape tauri-action writes with updaterJsonPreferNsis: true.
const manifest = {
  version: "1.0.0",
  platforms: {
    "windows-x86_64": e("App_1.0.0_x64-setup.exe"),
    "windows-x86_64-nsis": e("App_1.0.0_x64-setup.exe"),
    "windows-x86_64-msi": e("App_1.0.0_x64_en-US.msi"),
    "darwin-aarch64": e("App_aarch64.app.tar.gz"),
    "darwin-aarch64-app": e("App_aarch64.app.tar.gz"),
    "darwin-x86_64": e("App_x64.app.tar.gz"),
    "darwin-x86_64-app": e("App_x64.app.tar.gz"),
    "linux-x86_64": e("App_1.0.0_amd64.AppImage"),
    "linux-x86_64-appimage": e("App_1.0.0_amd64.AppImage"),
    "linux-x86_64-deb": e("App_1.0.0_amd64.deb"),
    "linux-x86_64-rpm": e("App-1.0.0-1.x86_64.rpm"),
  },
};

test("every install kind gets its own installer type", () => {
  for (const k of INSTALL_KINDS) {
    const picked = pickEntry(manifest, k.target, k.installer);
    assert.ok(picked, `${k.target}/${k.installer}: nothing picked`);
    assert.match(picked.url, k.expect, `${k.target}/${k.installer} got ${picked.url}`);
  }
});

test("an MSI fallback for unmarked Windows builds is caught", () => {
  const bad = structuredClone(manifest);
  bad.platforms["windows-x86_64"] = e("App_1.0.0_x64_en-US.msi");
  const kind = INSTALL_KINDS.find((k) => k.target === "windows-x86_64" && k.installer === null);
  assert.doesNotMatch(pickEntry(bad, kind.target, null).url, kind.expect);
});

test("a missing per-installer key falls back like the plugin does", () => {
  const m = { platforms: { "windows-x86_64": e("a-setup.exe") } };
  assert.equal(pickEntry(m, "windows-x86_64", "nsis").key, "windows-x86_64");
  assert.equal(pickEntry(m, "linux-x86_64", "deb"), null);
});

test("semver comparison matches the updater", () => {
  assert.ok(isNewer("0.3.12", "0.3.9"));
  assert.ok(isNewer("0.10.0", "0.9.9"));
  assert.ok(isNewer("1.0.0", "1.0.0-beta"));
  assert.ok(!isNewer("0.3.9", "0.3.9"));
  assert.ok(!isNewer("0.3.9", "0.3.12"));
});

test("versions agree across package.json, tauri.conf.json and Cargo.toml", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url))).version;
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"))[1];
  assert.equal(conf, pkg);
  assert.equal(cargo, pkg);
});

test("the updater endpoint and key every old install trusts are unchanged", () => {
  // Changing either strands every existing install. If you really must, keep
  // signing with the old key too and add the new one in a separate release.
  const u = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url))).plugins.updater;
  assert.deepEqual(u.endpoints, ["https://github.com/Kevanko/codex-switcher-fork/releases/latest/download/latest.json"]);
  assert.ok(u.pubkey.endsWith("UVFINjVqdGhraDFnZ3Rwd3cK"), "updater pubkey changed");
});

test("the Windows build workflow points the plain key at the NSIS installer", () => {
  const wf = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
  assert.match(wf, /updaterJsonPreferNsis:\s*true/);
});
