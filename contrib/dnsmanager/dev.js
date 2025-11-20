#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const extraClientArgs = process.argv.slice(2);

const children = [];

function start(name, args) {
  const child = spawn(npmCmd, args, {
    stdio: "inherit",
    cwd: projectRoot,
  });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 0);
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("server", ["run", "dev", "--prefix", "server"]);

const clientCommand = ["run", "dev", "--prefix", "client"];
if (extraClientArgs.length) {
  clientCommand.push("--", ...extraClientArgs);
}
start("client", clientCommand);
