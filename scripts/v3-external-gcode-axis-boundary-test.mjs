#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_EXTERNAL_GCODE_AXIS_PORT ?? 8798);
const baseUrl = `http://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-external-gcode-axis-"));
const importedModelPath = resolve("public", "imported-models", `v3-axis-boundary-${Date.now()}.stl`);
const modelUrl = `/imported-models/${importedModelPath.split(/[\\/]/).pop()}`;
const proofRunnerPath = join(fixtureDir, "freecad-a-axis-runner.py");

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  depthMm: 1.25,
  meshU: 80,
  meshV: 60,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  toolDiameter: 4,
  stepoverMm: 0.28,
  stepoverDeg: 5,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

let server;

async function main() {
  writeClosedReliefStl(importedModelPath);
  writeBadAxisRunner(proofRunnerPath);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_FREECAD_ADAPTER: "true",
      HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", proofRunnerPath])
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stdout.write(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stderr.write(chunk);
  });

  await waitForHealth();
  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "freecad" });
  const job = await waitForJob(created.id, Date.now());
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const validation = await getArtifactJson(job.id, "external-gcode-import-validation.json");
  assert(validation.status === "critical", `A-axis wrapY G-code must be critical, got ${validation.status}`);
  assert(validation.productionCandidate === false, "A-axis wrapY G-code must not be production candidate");
  assert(validation.gcodeMachineBoundary?.status === "critical", `expected critical G-code boundary, got ${validation.gcodeMachineBoundary?.status}`);
  assert((validation.gcodeMachineBoundary?.actual?.axisCounts?.A ?? 0) > 0, "A-axis word count should be captured");
  assert(validation.criticalIssues?.some((item) => /A-axis|A 轴|A轴/i.test(item)), "critical issues should explain forbidden A-axis words");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowTrialNc === false, "A-axis mismatch must block trial NC");
  assert(productionGate.allowProductionNc === false, "A-axis mismatch must block production NC");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    gcodeValidation: validation.status,
    gcodeBoundary: validation.gcodeMachineBoundary.status,
    aAxisCount: validation.gcodeMachineBoundary.actual.axisCounts.A,
    trial: productionGate.allowTrialNc,
    production: productionGate.allowProductionNc
  }, null, 2));
}

function writeBadAxisRunner(filePath) {
  writeFileSync(filePath, `#!/usr/bin/env python3
import hashlib
import json
import sys
from pathlib import Path

job_path = Path(sys.argv[-3])
plan_path = Path(sys.argv[-2])
output_path = Path(sys.argv[-1])
job = json.loads(job_path.read_text(encoding="utf-8"))
model_path = Path(str(job.get("modelPath") or ""))
settings = job.get("settings") or {}
output_path.parent.mkdir(parents=True, exist_ok=True)
safe_z = float(settings.get("safeZ") or 22)
feed = int(float(settings.get("feedRate") or 180))
gcode = "\\n".join([
    "(HeDiao3D FreeCAD proof-backed output with forbidden A axis)",
    f"(JOB_ID={job.get('jobId')})",
    "(ROTARY_WRAP_AXIS=Y ROTARY_WRAP_PER_REV_MM=100.000000 LENGTH_AXIS=X)",
    "G21",
    "G90",
    f"G0 X0.0000 Y0.0000 Z{safe_z:.4f}",
    f"G1 X6.0000 Y0.0000 Z-0.3500 F{feed}",
    f"G1 X12.0000 A10.0000 Z-0.5500 F{feed}",
    f"G0 Z{safe_z:.4f}",
    "M5",
    "M30",
    "",
])
output_path.write_text(gcode, encoding="utf-8")
proof = {
    "schema": "hediao3d.freecad-cam-output-report.v1",
    "engine": "freecad",
    "jobId": job.get("jobId"),
    "gcodeSha256": hashlib.sha256(gcode.encode("utf-8")).hexdigest(),
    "modelSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
    "planSha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
    "postprocessOwner": "HeDiao3D",
    "machineBoundary": {
        "machineBoundary": "wrapY",
        "controllerClass": "3axis-controller-with-rotary-fixture",
        "camMode": "rotaryWrap",
        "rotaryOutputAxis": "Y",
        "rotaryWrapPerRevolutionMm": 100,
        "lengthAxis": "X",
        "depthAxis": "Z"
    },
    "tool": {
        "toolProfileId": "vflat-4mm-25deg",
        "diameterMm": 4,
        "angleDeg": 25,
        "tip": "flat"
    },
    "quality": {
        "productionCandidate": True,
        "postprocessEligible": True,
        "fixture": False,
        "previewScaffold": False
    }
}
Path(str(output_path) + ".cam-proof.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"ok": True, "engine": "freecad", "proof": True, "badAxis": "A"}))
`);
}

function writeClosedReliefStl(filePath) {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
  const facets = [];
  const nx = 20;
  const ny = 16;
  const length = 38;
  const width = 15;
  const baseZ = -8;
  const top = (i, j) => {
    const x = (length * i) / nx;
    const y = (width * j) / ny;
    const u = i / nx;
    const v = j / ny;
    return [round(x), round(y), round(0.1 + Math.sin(Math.PI * u) * Math.sin(Math.PI * v))];
  };
  const bottom = (i, j) => [round((length * i) / nx), round((width * j) / ny), baseZ];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      addQuad(facets, top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
      addQuad(facets, bottom(i + 1, j), bottom(i, j), bottom(i, j + 1), bottom(i + 1, j + 1));
    }
  }
  writeFileSync(filePath, `solid axis_boundary\\n${facets.join("")}endsolid axis_boundary\\n`);
}

function addQuad(facets, a, b, c, d) {
  addFacet(facets, a, b, c);
  addFacet(facets, a, c, d);
}

function addFacet(facets, a, b, c) {
  facets.push(`  facet normal 0 0 1
    outer loop
      vertex ${a[0]} ${a[1]} ${a[2]}
      vertex ${b[0]} ${b[1]} ${b[2]}
      vertex ${c[0]} ${c[1]} ${c[2]}
    endloop
  endfacet
`);
}

function round(value) {
  return Number(value.toFixed(6));
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    try {
      await getJson("/api/health");
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`server did not become healthy on ${baseUrl}`);
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await sleep(1000);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms`);
}

async function getArtifactJson(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok || response.status === 202, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server && !server.killed) server.kill();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(importedModelPath, { force: true });
  });
