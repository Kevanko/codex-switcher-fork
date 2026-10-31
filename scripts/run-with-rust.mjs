import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node scripts/run-with-rust.mjs <command> [...args]");
  process.exit(1);
}

const exe = process.platform === "win32" ? "cargo.exe" : "cargo";
const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
// rustup's default home, a custom CARGO_HOME, or whatever is already on PATH
// (hosted runners differ) - the first place that really has cargo wins.
const candidates = [
  process.env.CARGO_HOME && path.join(process.env.CARGO_HOME, "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
  ...pathDirs,
].filter(Boolean);
const cargoBinDir = candidates.find((dir) => existsSync(path.join(dir, exe)));

if (!cargoBinDir) {
  console.error("Error: cargo not found (CARGO_HOME, ~/.cargo/bin, PATH). Install Rust via rustup: https://rustup.rs");
  process.exit(1);
}

const env = {
  ...process.env,
  PATH: `${cargoBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
};

const child = spawn(command, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start ${command}:`, error.message);
  process.exit(1);
});
