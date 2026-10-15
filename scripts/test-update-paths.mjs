// For EVERY published release, replay what its in-app updater would do with
// the candidate manifest — and fail if any of them would not end up on it.
//
//   node scripts/test-update-paths.mjs [latest.json url|path] [--assets-dir D]
//
// Per old version it checks: the endpoint it polls is ours, the candidate is a
// newer semver, the manifest entry it would pick exists and is the right
// installer for how it was installed (NSIS gets setup.exe, MSI gets .msi —
// anything else leaves a second copy behind), and that file's signature
// verifies with the pubkey THAT version ships. Files are downloaded once.
//
// Versions signed with a retired key can never verify a new release; they are
// listed in RETIRED_KEYS and reported, not silently passed. A NEW key change
// fails the test: it would strand every existing install.
import { readFileSync } from "node:fs";
import { INSTALL_KINDS, fileName, isNewer, pickEntry, verifySignature } from "./updater-lib.mjs";

// Key ids (hex) of pubkeys no longer used for signing, with the last version on each.
// Those installs need one manual reinstall; nothing a release can do fixes them.
const RETIRED_KEYS = {
  "3efa29d100df2cc5": "≤ 0.2.14 (key rotated in 0.2.15)",
};

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const ourEndpoints = conf.plugins.updater.endpoints;
const ourKey = conf.plugins.updater.pubkey;
const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(ourEndpoints[0])?.[1];
if (!repo) throw new Error(`cannot derive the GitHub repo from ${ourEndpoints[0]}`);

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const assetsDir = opt("--assets-dir");
const source = args.find((a) => !a.startsWith("--") && a !== assetsDir) ?? ourEndpoints[0];
const manifest = JSON.parse(/^https?:/.test(source) ? await (await fetch(source)).text() : readFileSync(source, "utf8"));

const gh = { headers: process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {} };
async function getJson(url) {
  const res = await fetch(url, gh);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const releases = [];
for (let page = 1; ; page++) {
  const batch = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`);
  releases.push(...batch.filter((r) => !r.draft));
  if (batch.length < 100) break;
}

const files = new Map(); // url -> Buffer
async function file(url) {
  if (!files.has(url)) {
    if (assetsDir) files.set(url, readFileSync(`${assetsDir}/${fileName(url)}`));
    else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (${res.status}) ${url}`);
      files.set(url, Buffer.from(await res.arrayBuffer()));
    }
  }
  return files.get(url);
}

const keyIdHex = (pub) => Buffer.from(Buffer.from(pub, "base64").toString("utf8").split(/\r?\n/)[1], "base64").subarray(2, 10).toString("hex");
const failures = [];
const stranded = [];
let checkedPaths = 0;

for (const rel of releases) {
  const tag = rel.tag_name;
  let old;
  try {
    old = await getJson(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/src-tauri/tauri.conf.json`);
  } catch (e) {
    failures.push(`${tag}: cannot read its tauri.conf.json (${e.message})`);
    continue;
  }
  const version = old.version ?? old.package?.version;
  if (!isNewer(manifest.version, version)) continue; // the candidate itself, or newer
  const updater = old.plugins?.updater;
  if (!updater?.pubkey || !updater?.endpoints?.length) {
    stranded.push(`${tag}: ships without an updater`);
    continue;
  }
  if (!updater.endpoints.some((e) => ourEndpoints.includes(e))) {
    failures.push(`${tag}: polls ${updater.endpoints.join(", ")}, which this release does not publish to`);
    continue;
  }
  if (updater.pubkey !== ourKey) {
    const retired = RETIRED_KEYS[keyIdHex(updater.pubkey)];
    if (retired) {
      stranded.push(`${tag}: trusts a retired key (${retired}); needs one manual reinstall`);
      continue;
    }
    failures.push(`${tag}: trusts a different updater key — every install of it would stop updating`);
    continue;
  }

  for (const kind of INSTALL_KINDS) {
    const label = `${tag} [${kind.target}${kind.installer ? "/" + kind.installer : ""}]`;
    const entry = pickEntry(manifest, kind.target, kind.installer);
    if (!entry) {
      failures.push(`${label}: no manifest entry it would pick`);
      continue;
    }
    const name = fileName(entry.url);
    if (!kind.expect.test(name)) {
      failures.push(`${label}: would install ${name} (via "${entry.key}") — wrong installer type`);
      continue;
    }
    try {
      verifySignature(await file(entry.url), entry.signature, updater.pubkey);
    } catch (e) {
      failures.push(`${label}: ${name}: ${e.message}`);
      continue;
    }
    checkedPaths++;
  }
}

for (const s of stranded) console.log(`! ${s}`);
for (const f of failures) console.error(`✗ ${f}`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} update path(s) to ${manifest.version} are broken — do not publish.`);
  process.exit(1);
}
console.log(`✓ ${checkedPaths} update paths from ${releases.length} releases reach ${manifest.version} with a valid signature`);
