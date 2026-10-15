// Shared by verify-updater.mjs and test-update-paths.mjs: the exact checks the
// in-app updater (tauri-plugin-updater 2.10) performs, so a test that passes here
// means a real client would accept the update.
import { createHash, createPublicKey, verify } from "node:crypto";

// minisign files: "untrusted comment: ...\n<base64 payload>\n[trusted comment: ...\n<base64 global sig>\n]"
const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);

/** Parse a Tauri updater pubkey (base64 minisign public key file). */
export function parsePubkey(pubkeyB64) {
  const raw = Buffer.from(lines(pubkeyB64)[1], "base64"); // "Ed" | keyid(8) | key(32)
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10, 42)]),
      format: "der",
      type: "spki",
    }),
  };
}

/** Throws unless `data` is signed by `pubkeyB64` (Tauri uses prehashed "ED" signatures). */
export function verifySignature(data, signatureB64, pubkeyB64) {
  const pub = parsePubkey(pubkeyB64);
  const [, sigLine, trustedLine, globalLine] = lines(signatureB64);
  const sig = Buffer.from(sigLine, "base64");
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(pub.keyId)) throw new Error("signed with a different key than the app's pubkey");
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  const sigBytes = sig.subarray(10, 74);
  if (!verify(null, message, pub.key, sigBytes)) throw new Error("file signature does not verify");
  const trusted = Buffer.from(trustedLine.replace(/^trusted comment: /, ""));
  if (!verify(null, Buffer.concat([sigBytes, trusted]), pub.key, Buffer.from(globalLine, "base64"))) {
    throw new Error("trusted comment signature does not verify");
  }
}

/** semver "a > b" for x.y.z[-pre] — the comparison the updater uses by default. */
export function isNewer(a, b) {
  const parse = (v) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { n: core.split(".").map(Number), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 1.0.0 > 1.0.0-beta
  if (!y.pre) return false;
  return x.pre > y.pre;
}

/**
 * Which manifest entry a client picks: `{os}-{arch}-{installer}` first, then
 * `{os}-{arch}` (tauri-plugin-updater `get_urls`). `installer` is null for a
 * binary that carries no bundle-type marker.
 */
export function pickEntry(manifest, target, installer) {
  const keys = installer ? [`${target}-${installer}`, target] : [target];
  for (const key of keys) {
    const e = manifest.platforms?.[key];
    if (e?.url && e?.signature) return { key, ...e };
  }
  return null;
}

/** The file type each kind of install must receive — anything else installs a second copy. */
export const INSTALL_KINDS = [
  { target: "windows-x86_64", installer: "nsis", expect: /-setup\.exe$/ },
  { target: "windows-x86_64", installer: "msi", expect: /\.msi$/ },
  // A build without a bundle marker. NSIS: per-user, needs no admin rights.
  { target: "windows-x86_64", installer: null, expect: /-setup\.exe$/ },
  { target: "darwin-aarch64", installer: "app", expect: /\.app\.tar\.gz$/ },
  { target: "darwin-x86_64", installer: "app", expect: /\.app\.tar\.gz$/ },
  { target: "linux-x86_64", installer: "appimage", expect: /\.AppImage$/ },
  { target: "linux-x86_64", installer: "deb", expect: /\.deb$/ },
  { target: "linux-x86_64", installer: "rpm", expect: /\.rpm$/ },
  { target: "linux-x86_64", installer: null, expect: /\.AppImage$/ },
];

export const fileName = (url) => decodeURIComponent(url.split("/").pop() ?? "");
