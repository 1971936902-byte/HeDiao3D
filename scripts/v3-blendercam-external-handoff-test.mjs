#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_BLENDERCAM_HANDOFF_PORT ?? 8795);
const baseUrl = `http://127.0.0.1:${port}`;
const importedModelName = `v3-blendercam-external-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = `/imported-models/${importedModelName}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-blendercam-external-handoff-"));
const camoticsFixturePath = join(fixtureDir, "camotics-blendercam-result-fixture.json");
const runnerPath = resolve("adapters", "blendercam", "blendercam_runner.py");

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: 15,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: 1.25,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  toolDiameter: 4,
  stepoverDeg: 5,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-rotary-y-wrap",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "rotary-y-wrap"
};

let server;

async function main() {
  writeClosedReliefStl(importedModelPath);
  writeCamoticsFixture(camoticsFixturePath);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_BLENDERCAM_ADAPTER: "true",
      HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", runnerPath]),
      HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT: "true",
      HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
      HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
      HEDIAO3D_CAMOTICS_RESULT_JSON: camoticsFixturePath
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
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "blendercam"
  });
  const job = await waitForJob(created.id, Date.now());
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.selectedEngine === "blendercam", `selectedEngine expected blendercam, got ${job.selectedEngine}`);
  assert(job.result?.engine === "blendercam", `result engine expected blendercam, got ${job.result?.engine}`);

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `adapter report expected completed, got ${adapterReport.status}`);
  assert(adapterReport.gcodePath, "adapter report should expose gcodePath");
  assert(adapterReport.metrics?.gcode?.status === "generated", "adapter metrics should mark G-code generated");
  assert(adapterReport.metrics?.externalCommand?.exitCode === 0, "external command should exit cleanly");

  const toolpath = await getArtifactText(job.id, "toolpath.nc");
  assert(toolpath.includes("HeDiao3D BlenderCAM external runner fixture"), "toolpath should come from BlenderCAM external runner");
  assert(/\bG1\b/.test(toolpath), "toolpath should contain G1 motion");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.engine === "blendercam", "toolpath summary engine should be blendercam");
  assert(toolpathSummary.source === "external-adapter", "toolpath should come from external adapter");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowAirRun === true, "BlenderCAM external G-code should allow air-run");
  assert(productionGate.allowTrialNc === true, `BlenderCAM external G-code should allow trial NC; blockers: ${(productionGate.blockers ?? []).join("; ")}`);
  assert(productionGate.allowProductionNc === false, "fixture BlenderCAM output must not unlock production NC");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    source: toolpathSummary.source,
    gcode: adapterReport.metrics.gcode.status,
    production: productionGate.allowProductionNc,
    trial: productionGate.allowTrialNc,
    airRun: productionGate.allowAirRun,
    packageLevel: productionGate.level
  }, null, 2));
}

function writeCamoticsFixture(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    synthetic: false,
    status: "completed",
    riskLevel: "ready",
    summary: "Imported non-synthetic CAMotics fixture for BlenderCAM external G-code handoff.",
    metrics: {
      motionLineCount: 18,
      zMin: -1.2,
      zMax: 22,
      materialRemovedMm3: 6.3,
      fitRate: 99.0,
      missCount: 0,
      estimatedMinutes: 1.1
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl",
      note: "Fixture validates Orchestrator ingestion of BlenderCAM external G-code."
    }
  }, null, 2));
}

function writeClosedReliefStl(filePath) {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
  const nx = 40;
  const ny = 30;
  const length = 38;
  const width = 15;
  const baseZ = -13.2;
  const facets = [];
  const top = (i, j) => {
    const x = (length * i) / nx;
    const y = (width * j) / ny;
    const u = i / nx;
    const v = j / ny;
    const dome = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const ripple = 0.16 * Math.sin(Math.PI * 3 * u) * Math.sin(Math.PI * 2 * v);
    return [round(x), round(y), round(0.25 + dome + ripple)];
  };
  const bottom = (i, j) => [round((length * i) / nx), round((width * j) / ny), baseZ];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      addQuad(facets, top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
      addQuad(facets, bottom(i + 1, j), bottom(i, j), bottom(i, j + 1), bottom(i + 1, j + 1));
    }
  }
  for (let i = 0; i < nx; i += 1) {
    addQuad(facets, bottom(i, 0), bottom(i + 1, 0), top(i + 1, 0), top(i, 0));
    addQuad(facets, bottom(i + 1, ny), bottom(i, ny), top(i, ny), top(i + 1, ny));
  }
  for (let j = 0; j < ny; j += 1) {
    addQuad(facets, bottom(0, j + 1), bottom(0, j), top(0, j), top(0, j + 1));
    addQuad(facets, bottom(nx, j), bottom(nx, j + 1), top(nx, j + 1), top(nx, j));
  }
  writeFileSync(filePath, `solid blendercam_closed_relief\n${facets.join("")}endsolid blendercam_closed_relief\n`);
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

async function getArtifactText(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const text = await response.text();
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${text}`);
  return text;
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
