#!/usr/bin/env node
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("usage: run-with-env.mjs <command> [args...]\n");
  process.exit(2);
}

const child = spawn(command, args, {
  env: process.env,
  shell: false,
  stdio: "inherit",
});

child.once("error", () => {
  process.stderr.write(`command could not be started: ${command}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
