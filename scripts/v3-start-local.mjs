#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const apiPort = await findOpenPort(Number(process.env.API_PORT ?? 8787));
const vitePort = await findOpenPort(Number(process.env.VITE_PORT ?? 5173));
const npmCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

const children = [];

console.log("HeDiao3D V3 local dev");
console.log(`API:   http://${host}:${apiPort}`);
console.log(`UI:    http://${host}:${vitePort}`);
if (apiPort !== Number(process.env.API_PORT ?? 8787)) {
  console.log(`API_PORT ${process.env.API_PORT ?? 8787} is busy; using ${apiPort}.`);
}
if (vitePort !== Number(process.env.VITE_PORT ?? 5173)) {
  console.log(`VITE_PORT ${process.env.VITE_PORT ?? 5173} is busy; using ${vitePort}.`);
}
console.log("");

try {
  start("api", "node", ["server.mjs"], {
    ...process.env,
    API_PORT: String(apiPort)
  });

  start("ui", npmCommand, [...npmArgs, "run", "dev", "--", "--host", host, "--port", String(vitePort), "--strictPort"], {
    ...process.env,
    API_PORT: String(apiPort),
    VITE_PORT: String(vitePort),
    VITE_API_PROXY_TARGET: `http://${host}:${apiPort}`
  });
} catch (error) {
  shutdown();
  throw error;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
});

function start(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  children.push(child);

  child.stdout.on("data", (chunk) => writePrefixed(label, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(label, chunk));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${label}] exited with ${signal ?? code}`);
    shutdown();
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(0), 150).unref();
}

function writePrefixed(label, chunk) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) console.log(`[${label}] ${line}`);
  }
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No open port found from ${startPort} to ${startPort + 49}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
