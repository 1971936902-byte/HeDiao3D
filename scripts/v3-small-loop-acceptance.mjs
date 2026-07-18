import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const steps = [
  {
    id: "frontend-build",
    label: "Frontend production build",
    command: [process.execPath, join("node_modules", "vite", "bin", "vite.js"), "build"]
  },
  {
    id: "buddha-fixture",
    label: "Fixed Buddha 3D regression fixture",
    command: [process.execPath, join("scripts", "v3-buddha-fixture-baseline-test.mjs")]
  },
  {
    id: "buddha-e2e",
    label: "Buddha 3D model to rotary-Y safe trial package E2E",
    command: [process.execPath, join("scripts", "v3-buddha-e2e-api-test.mjs")]
  },
  {
    id: "focused-ui-contract",
    label: "V3 focused operator UI contract",
    command: [process.execPath, join("scripts", "v3-focused-ui-contract-test.mjs")]
  },
  {
    id: "frontend-operator-e2e",
    label: "V3 frontend operator browser E2E",
    command: [process.execPath, join("scripts", "v3-frontend-operator-e2e.mjs")]
  },
  {
    id: "frontend-import-model-e2e",
    label: "V3 frontend imported model browser E2E",
    command: [process.execPath, join("scripts", "v3-frontend-operator-e2e.mjs"), "--import-model"]
  },
  {
    id: "v3-smoke",
    label: "V3 orchestrator smoke loop",
    command: [process.execPath, join("scripts", "v3-smoke-test.mjs")]
  },
  {
    id: "obj-model-import",
    label: "OBJ model import to CAM loop",
    command: [process.execPath, join("scripts", "v3-obj-model-import-api-test.mjs")]
  },
  {
    id: "manufacturing-setup",
    label: "Manufacturing setup report and gate",
    command: [process.execPath, join("scripts", "v3-manufacturing-setup-report-test.mjs")]
  },
  {
    id: "postprocess-regression",
    label: "3-axis rotary-Y postprocess regression",
    command: [process.execPath, join("scripts", "v3-postprocess-regression-test.mjs")]
  },
  {
    id: "readiness-api",
    label: "V3 readiness gate API",
    command: [process.execPath, join("scripts", "v3-readiness-api-test.mjs")]
  },
  {
    id: "readiness-runbook-result-import",
    label: "V3 readiness runbook result import",
    command: [process.execPath, join("scripts", "v3-readiness-runbook-result-import-api-test.mjs")]
  },
  {
    id: "native-cam-api",
    label: "Native CAM server package API",
    command: [process.execPath, join("scripts", "v3-native-cam-api-test.mjs")]
  },
  {
    id: "native-cam-package-self-check",
    label: "Native CAM server package self-check",
    command: [process.execPath, join("scripts", "v3-native-cam-server-package-self-check-test.mjs")]
  },
  {
    id: "opencamlib-small-loop",
    label: "OpenCAMLib neutral toolpath small loop",
    command: [process.execPath, join("scripts", "v3-real-neutral-handoff-test.mjs")]
  },
  {
    id: "opencamlib-contact-validate",
    label: "OpenCAMLib contact output validator",
    command: [process.execPath, join("scripts", "v3-opencamlib-contact-output-validate-test.mjs")]
  },
  {
    id: "opencamlib-probe",
    label: "OpenCAMLib runtime capability probe",
    command: [process.execPath, join("scripts", "v3-opencamlib-probe-test.mjs")]
  },
  {
    id: "opencamlib-contact-spike",
    label: "OpenCAMLib real contact spike gate",
    command: [process.execPath, join("scripts", "v3-opencamlib-contact-spike-test.mjs")]
  },
  {
    id: "opencamlib-candidate-package",
    label: "OpenCAMLib candidate package preflight",
    command: [process.execPath, join("scripts", "v3-opencamlib-candidate-package-validate-test.mjs")]
  },
  {
    id: "rotary-heightfield-runner",
    label: "Rotary wrap heightfield runner loop",
    command: [process.execPath, join("scripts", "v3-rotary-heightfield-runner-test.mjs")]
  },
  {
    id: "rotary-neutral-handoff",
    label: "OpenCAMLib rotary neutral handoff loop",
    command: [process.execPath, join("scripts", "v3-rotary-neutral-handoff-test.mjs")]
  },
  {
    id: "camotics-cli-package-api",
    label: "CAMotics Linux package API",
    command: [process.execPath, join("scripts", "v3-camotics-cli-package-api-test.mjs")]
  },
  {
    id: "camotics-material-validate",
    label: "CAMotics material-removal validator",
    command: [process.execPath, join("scripts", "v3-camotics-material-removal-validate-test.mjs")]
  },
  {
    id: "camotics-result-api",
    label: "CAMotics result import API",
    command: [process.execPath, join("scripts", "v3-camotics-result-api-test.mjs")]
  },
  {
    id: "machine-acceptance-api",
    label: "Machine acceptance and air-run evidence API",
    command: [process.execPath, join("scripts", "v3-machine-acceptance-api-test.mjs")]
  },
  {
    id: "evidence-closed-loop",
    label: "Native CAM + CAMotics evidence closed loop",
    command: [process.execPath, join("scripts", "v3-evidence-closed-loop-test.mjs")]
  },
  {
    id: "production-package-unlock",
    label: "Production package unlock closed loop",
    command: [process.execPath, join("scripts", "v3-production-package-unlock-test.mjs")]
  }
];

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

async function main() {
  const port = await getFreePort();
  const apiBase = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      API_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverExited = false;
  server.on("exit", () => {
    serverExited = true;
  });
  server.stdout.on("data", (chunk) => process.stdout.write(prefixLines("api", chunk)));
  server.stderr.on("data", (chunk) => process.stderr.write(prefixLines("api", chunk)));

  const results = [];
  try {
    await waitForHealth(apiBase, () => serverExited);
    console.log(`[acceptance] API ready at ${apiBase}`);

    for (const step of steps) {
      const startedAt = Date.now();
      console.log(`[acceptance] start ${step.id}: ${step.label}`);
      const result = await runStep(step, apiBase);
      const durationMs = Date.now() - startedAt;
      results.push({ id: step.id, status: result.status, durationMs });
      if (result.status !== 0) {
        throw new Error(`${step.id} failed with exit code ${result.status}`);
      }
      console.log(`[acceptance] pass ${step.id} (${(durationMs / 1000).toFixed(1)}s)`);
    }

    console.log(JSON.stringify({
      ok: true,
      schema: "hediao3d.v3-small-loop-acceptance.v1",
      apiBase,
      stepCount: results.length,
      results
    }, null, 2));
  } finally {
    await stopServer(server);
  }
}

async function runStep(step, apiBase) {
  const child = spawn(step.command[0], step.command.slice(1), {
    cwd: rootDir,
    env: {
      ...process.env,
      V3_API_BASE: apiBase
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(step.id, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(step.id, chunk)));
  const [status] = await once(child, "exit");
  return { status };
}

async function waitForHealth(apiBase, hasExited) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (hasExited()) throw new Error("API server exited before health check passed.");
    try {
      const response = await fetch(`${apiBase}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the server starts listening.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for API health at ${apiBase}`);
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  server.close();
  await once(server, "close");
  if (!port) throw new Error("Could not allocate a local API port.");
  return port;
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode) return;
  server.kill("SIGINT");
  const stopped = once(server, "exit").then(() => true);
  const timedOut = delay(2_000).then(() => false);
  if (!(await Promise.race([stopped, timedOut]))) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(1_000)]);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part) => part === "\n" || part === "\r\n" || part.length === 0 ? part : `[${label}] ${part}`)
    .join("");
}
