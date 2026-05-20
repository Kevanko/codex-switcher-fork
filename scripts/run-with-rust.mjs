import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node scripts/run-with-rust.mjs <command> [...args]");
  process.exit(1);
}

const cargoBinDir = path.join(os.homedir(), ".cargo", "bin");
const cargoExe = path.join(cargoBinDir, process.platform === "win32" ? "cargo.exe" : "cargo");

if (!existsSync(cargoExe)) {
  console.error("Error: cargo not found in ~/.cargo/bin. Install Rust via rustup: https://rustup.rs");
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
