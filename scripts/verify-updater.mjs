// Verifies what the in-app updater will see, with the same public key the app ships.
//
//   node scripts/verify-updater.mjs [latest.json url|path] [--expect-version X] [--assets-dir D]
//       Checks every platform entry: signed by our key, file downloads, signature valid.
//       --assets-dir reads the files from D (a downloaded draft release) instead of the URLs.
//   node scripts/verify-updater.mjs --file <path> --sig <path.sig>
//       Checks one locally signed file (`tauri signer sign`) against the app's pubkey.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const updater = conf.plugins?.updater;
if (!updater?.pubkey || !updater?.endpoints?.length) fail("tauri.conf.json has no updater pubkey/endpoint");

// minisign files: "untrusted comment: ...\n<base64 payload>\n[trusted comment: ...\n<base64 global sig>\n]"
const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);

const pubRaw = Buffer.from(lines(updater.pubkey)[1], "base64"); // "Ed" | keyid(8) | key(32)
const pubKeyId = pubRaw.subarray(2, 10);
const pubKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw.subarray(10, 42)]),
  format: "der",
  type: "spki",
});

/** Throws unless `data` is signed by our key (Tauri uses prehashed "ED" signatures). */
export function verifySignature(data, signatureB64) {
  const [, sigLine, trustedLine, globalLine] = lines(signatureB64);
  const sig = Buffer.from(sigLine, "base64");
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(pubKeyId)) throw new Error("signed with a different key than the app's pubkey");
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  const sigBytes = sig.subarray(10, 74);
  if (!verify(null, message, pubKey, sigBytes)) throw new Error("file signature does not verify");
  const trusted = Buffer.from(trustedLine.replace(/^trusted comment: /, ""));
  if (!verify(null, Buffer.concat([sigBytes, trusted]), pubKey, Buffer.from(globalLine, "base64"))) {
    throw new Error("trusted comment signature does not verify");
  }
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (opt("--file")) {
  try {
    verifySignature(readFileSync(opt("--file")), readFileSync(opt("--sig"), "utf8"));
  } catch (err) {
    fail(`${opt("--file")}: ${err.message}`);
  }
  console.log("✓ signing key matches the updater pubkey");
  process.exit(0);
}

const optValues = [opt("--expect-version"), opt("--assets-dir")];
const source = args.find((a) => !a.startsWith("--") && !optValues.includes(a)) ?? updater.endpoints[0];
const assetsDir = opt("--assets-dir");
const manifest = JSON.parse(
  /^https?:/.test(source) ? await (await fetch(source)).text() : readFileSync(source, "utf8"),
);

if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? "")) fail(`bad version "${manifest.version}"`);
const expected = opt("--expect-version");
if (expected && manifest.version !== expected.replace(/^v/, "")) {
  fail(`latest.json is ${manifest.version}, expected ${expected}`);
}

// Every OS we ship must be reachable by the updater, or those users silently stop updating.
for (const key of ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"]) {
  if (!manifest.platforms?.[key]) fail(`latest.json has no "${key}" entry`);
}

const checked = new Map(); // same file is listed under several keys
for (const [key, { url, signature }] of Object.entries(manifest.platforms)) {
  // Tag URLs, or /releases/latest/download/ (what tauri-action writes for a draft
  // built by id) — the latter resolves to this release once it is published.
  const name = decodeURIComponent(url?.split("/").pop() ?? "");
  const pinned = url?.includes(`/v${manifest.version}/`) || url?.includes(`/${manifest.version}/`);
  const latest = url?.includes("/releases/latest/download/");
  // macOS bundles carry no version in their file name.
  const thisVersion = name.includes(manifest.version) || name.endsWith(".app.tar.gz");
  if (!pinned && !(latest && thisVersion)) {
    fail(`${key}: url does not point at ${manifest.version}: ${url}`);
  }
  if (!checked.has(url + signature)) {
    let data;
    if (assetsDir) {
      try {
        data = readFileSync(`${assetsDir}/${name}`);
      } catch {
        fail(`${key}: release has no asset named ${name}`);
      }
    } else {
      const res = await fetch(url);
      if (!res.ok) fail(`${key}: download failed (${res.status}) ${url}`);
      data = Buffer.from(await res.arrayBuffer());
    }
    try {
      verifySignature(data, signature);
    } catch (err) {
      fail(`${key}: ${err.message}`);
    }
    checked.set(url + signature, true);
  }
  console.log(`✓ ${key}`);
}
console.log(`✓ updater manifest ${manifest.version} is valid (${checked.size} files verified)`);
