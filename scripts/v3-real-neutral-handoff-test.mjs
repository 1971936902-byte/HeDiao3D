#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_REAL_NEUTRAL_HANDOFF_PORT ?? 8792);
const baseUrl = `http://127.0.0.1:${port}`;
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? "/meshy-results/material01-meshy.glb";
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-real-neutral-handoff-"));
const neutralCommandPath = join(fixtureDir, "write-opencamlib-neutral-fixture.mjs");
const camoticsFixturePath = join(fixtureDir, "camotics-real-result-fixture.json");

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: 15,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: 1.25,
  reliefAngleDeg: 360,
  contrast: 1.45,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  endTransitionMm: 1.2,
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
  meshAxisReverse: false,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "rotary-y-wrap"
};

let server;

async function main() {
  writeNeutralCommand(neutralCommandPath);
  writeCamoticsFixture(camoticsFixturePath);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER: "true",
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON: JSON.stringify([process.execPath, neutralCommandPath]),
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
    engine: "opencamlib"
  });
  const job = await waitForJob(created.id, Date.now());
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.selectedEngine === "opencamlib", `selectedEngine expected opencamlib, got ${job.selectedEngine}`);
  assert(job.result?.engine === "opencamlib", `result engine expected opencamlib, got ${job.result?.engine}`);

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `adapter report expected completed, got ${adapterReport.status}`);
  assert(adapterReport.metrics?.neutralToolpath?.generatedByExternalCommand === true, "adapter should run external neutral command");
  assert(adapterReport.metrics?.neutralToolpath?.imported === false, "external command output should not be classified as imported fixture");
  assert(adapterReport.metrics?.neutralToolpath?.synthetic === false, "adapter neutral output must not be synthetic");

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
  assert(neutralToolpath.synthetic === false, "neutral fixture should remain non-synthetic after import");
  assert(neutralToolpath.generatedByExternalCommand === true, "neutral output should record external command generation");
  assert(Array.isArray(neutralToolpath.points) && neutralToolpath.points.length === 36, "neutral point count mismatch");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.source === "external-adapter", "toolpath should come from external adapter");
  assert(toolpathSummary.engine === "opencamlib", "toolpath summary engine should be opencamlib");

  const toolpath = await getArtifactText(job.id, "toolpath.nc");
  assert(toolpath.includes("OpenCAMLib neutral adapter"), "NC should name OpenCAMLib neutral adapter");
  assert(toolpath.includes("ROTARY_WRAP_AXIS=Y"), "NC should contain Y rotary marker");
  assert(/\bY\d/.test(toolpath), "NC should contain Y rotary-wrap moves");
  assert(!/\bA-?\d/.test(toolpath), "Y rotary-wrap NC should not contain A moves");

  const camoticsReport = await getArtifactJson(job.id, "camotics-adapter-report.json");
  assert(camoticsReport.status === "completed", `CAMotics adapter expected completed, got ${camoticsReport.status}`);
  assert(camoticsReport.metrics?.imported === true, "CAMotics adapter should import non-synthetic result");
  assert(camoticsReport.metrics?.synthetic === false, "CAMotics adapter result must not be synthetic");

  const camoticsResult = await getArtifactJson(job.id, "camotics-result.json");
  assert(camoticsResult.schema === "hediao3d.camotics-result.v1", "CAMotics result schema mismatch");
  assert(camoticsResult.synthetic === false, "CAMotics result should be non-synthetic");

  const simulationSummary = await getArtifactJson(job.id, "simulation-summary.json");
  assert(simulationSummary.engine === "camotics", `simulation expected camotics, got ${simulationSummary.engine}`);
  assert(simulationSummary.camoticsAdapter?.synthetic === false, "simulation summary should mark non-synthetic CAMotics result");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.simulationEvidence?.level === "material-removal-verified", `expected material-removal-verified evidence, got ${productionGate.simulationEvidence?.level}`);
  assert(productionGate.simulationEvidence?.productionUnlockEligible === true, "non-synthetic CAMotics evidence should be production unlock eligible");
  assert(productionGate.allowTrialNc === true, "real neutral handoff should allow trial NC when static gates pass");
  assert(productionGate.allowProductionNc === false, "fixture handoff must not unlock production while Native CAM readiness/model review warnings remain");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.simulationEvidence?.level === "material-removal-verified", "package index should expose material-removal evidence");
  assert(packageIndex.camotics?.productionUnlockEligible === true, "package index should mark real CAMotics evidence eligible");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    source: toolpathSummary.source,
    neutralPoints: neutralToolpath.points.length,
    generatedByExternalCommand: adapterReport.metrics.neutralToolpath.generatedByExternalCommand,
    simulationEngine: simulationSummary.engine,
    simulationEvidence: productionGate.simulationEvidence.level,
    production: productionGate.allowProductionNc,
    trial: productionGate.allowTrialNc,
    packageLevel: productionGate.level
  }, null, 2));
}

function writeNeutralCommand(filePath) {
  writeFileSync(filePath, `import { readFileSync, writeFileSync } from "node:fs";

const [, , jobPath, planPath, outputPath] = process.argv;
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const settings = job.settings ?? {};
const safeZ = Number(settings.safeZ ?? 22);
const points = [];
for (const angle of [0, 60, 120, 180, 240, 300]) {
  for (let col = 0; col < 6; col += 1) {
    const t = col / 5;
    const x = -19 + 38 * t;
    const ridge = 1 - Math.abs(0.5 - t) * 1.6;
    const depth = 0.35 + Math.max(0, ridge) * 0.75 + (angle === 180 ? 0.08 : 0);
    points.push({
      x: round(x, 4),
      a: angle,
      z: round(safeZ - depth, 4),
      depth: round(depth, 4),
      source: "external-command-neutral-fixture"
    });
  }
}
writeFileSync(outputPath, JSON.stringify({
  schema: "hediao3d.neutral-toolpath.v1",
  engine: "opencamlib",
  synthetic: false,
  createdBy: "v3-real-neutral-handoff-test external command",
  coordinate: {
    lengthAxis: "X",
    rotaryAxis: settings.rotaryOutputAxis ?? "Y",
    depthAxis: "Z",
    rotaryUnit: "degree"
  },
  estimatedMinutes: 1.2,
  points,
  planEcho: {
    schema: plan.schema,
    recommendedPrimary: plan.sampling?.recommendedPrimary
  }
}, null, 2));

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
`);
}

function writeCamoticsFixture(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    synthetic: false,
    status: "completed",
    riskLevel: "ready",
    summary: "Imported non-synthetic CAMotics fixture for Orchestrator material-removal evidence contract.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      motionLineCount: 42
    },
    metrics: {
      motionLineCount: 42,
      zMin: -1.18,
      zMax: 22,
      fitRate: 99.1,
      missCount: 0,
      estimatedMinutes: 1.2
    },
    artifacts: {
      screenshot: null,
      materialMesh: null,
      note: "Fixture represents an externally produced CAMotics result; it validates import classification, not visual simulation fidelity."
    }
  }, null, 2));
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

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server && !server.killed) server.kill();
    rmSync(fixtureDir, { recursive: true, force: true });
  });
