#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_CLOSED_NEUTRAL_HANDOFF_PORT ?? 8793);
const baseUrl = `http://127.0.0.1:${port}`;
const importedModelName = `v3-closed-neutral-heightfield-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? `/imported-models/${importedModelName}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-closed-neutral-handoff-"));
const camoticsFixturePath = join(fixtureDir, "camotics-closed-result-fixture.json");
const runnerPath = resolve("adapters", "opencamlib", "opencamlib_runner.py");

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
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
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
      HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER: "true",
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", runnerPath]),
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "12",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "16",
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

  const meshQuality = await getArtifactJson(job.id, "mesh-quality.json");
  assert(meshQuality.verdict === "ready", `closed STL mesh should be ready, got ${meshQuality.verdict}`);
  assert(meshQuality.triangleCount >= 1500, `closed STL should exceed ready face threshold, got ${meshQuality.triangleCount}`);
  assert(meshQuality.boundaryEdges === 0, `closed STL should not have boundary edges, got ${meshQuality.boundaryEdges}`);
  assert(meshQuality.nonManifoldEdges === 0, `closed STL should not have non-manifold edges, got ${meshQuality.nonManifoldEdges}`);

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.generatedByExternalCommand === true, "neutral output should record external command generation");
  assert(neutralToolpath.experimentalHeightfield === true, "neutral output should mark heightfield mode");
  assert(Array.isArray(neutralToolpath.points) && neutralToolpath.points.length === 192, "neutral point count mismatch");
  assert(neutralToolpath.runner?.heightfield?.missCount === 0, "heightfield runner should sample the closed STL");
  assert(neutralToolpath.runner?.heightfield?.cutterEnvelopeReport, "neutral output should reference cutter envelope report");
  const cutterEnvelopeReport = await getArtifactJson(job.id, "opencamlib-cutter-envelope-report.json");
  assert(cutterEnvelopeReport.schema === "hediao3d.opencamlib-cutter-envelope-report.v1", "cutter envelope report schema mismatch");
  assert(cutterEnvelopeReport.sampling?.pointCount === neutralToolpath.points.length, "cutter envelope report point count mismatch");
  assert(cutterEnvelopeReport.quality?.productionCandidate === false, "preview cutter envelope report must not unlock production");

  const camInputPlan = await getArtifactJson(job.id, "cam-input-plan.json");
  assert(camInputPlan.status === "ready", `closed STL CAM input should be ready, got ${camInputPlan.status}`);
  assert(camInputPlan.gate?.allowExternalCamTrial === true, "closed STL should allow external CAM trial");
  assert(camInputPlan.gate?.allowProductionNc === true, "closed STL CAM input gate should allow production candidate");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.simulationEvidence?.level === "material-removal-incomplete", `expected material-removal-incomplete evidence, got ${productionGate.simulationEvidence?.level}`);
  assert(productionGate.checks?.postprocessTraceLevel === "ready", "production gate should include ready postprocess trace level");
  assert(productionGate.simulationEvidence?.productionUnlockEligible === false, "CAMotics result without input identity hash must not be production eligible");
  assert(productionGate.allowAirRun === true, "closed neutral handoff should allow air-run");
  assert(productionGate.allowTrialNc === true, `closed neutral handoff should allow trial NC; blockers: ${(productionGate.blockers ?? []).join("; ")}`);
  assert(productionGate.allowProductionNc === false, "heightfield preview must not unlock production NC");
  assert(productionGate.level === "trial-only", `closed neutral package should be trial-only, got ${productionGate.level}`);
  assert((productionGate.warnings ?? []).some((item) => /Native CAM|外部|adapter|heightfield|生产/i.test(item)), "production gate should explain why production remains locked");

  const postprocessTrace = await getArtifactJson(job.id, "postprocess-trace-report.json");
  assert(postprocessTrace.level === "ready", `closed neutral postprocess trace should be ready, got ${postprocessTrace.level}`);
  assert(postprocessTrace.source?.pointCount === neutralToolpath.points.length, "postprocess trace should use neutral point count");
  assert(postprocessTrace.machineNc?.cuttingMoveCount === neutralToolpath.points.length, "postprocess trace machine moves should match neutral points");
  assert(postprocessTrace.coordinateMapping?.rotaryAxis === "Y", "postprocess trace should preserve Y rotary axis");
  assert(postprocessTrace.metrics?.fitRate >= 0.999, "postprocess trace fit rate should be near 100%");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.gates?.allowTrialNc === true, "package index should expose trial NC availability");
  assert(packageIndex.gates?.allowProductionNc === false, "package index must keep production locked");
  assert(packageIndex.postprocessTrace?.level === "ready", "package index should expose ready postprocess trace");
  assert(packageIndex.filesByPurpose?.reports?.some((file) => file.filename === "opencamlib-cutter-envelope-report.json"), "package index should include cutter envelope report");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "postprocess-trace-report.json"), "package index readFirst should include postprocess trace report");
  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  assert(packageIntegrity.files?.some((file) => file.filename === "opencamlib-cutter-envelope-report.json" && file.sha256), "package integrity should hash cutter envelope report");
  assert(packageIntegrity.files?.some((file) => file.filename === "postprocess-trace-report.json" && file.sha256), "package integrity should hash postprocess trace report");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    meshVerdict: meshQuality.verdict,
    triangleCount: meshQuality.triangleCount,
    neutralPoints: neutralToolpath.points.length,
    postprocessTrace: postprocessTrace.level,
    simulationEvidence: productionGate.simulationEvidence.level,
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
    summary: "Imported non-synthetic CAMotics fixture for closed STL trial-unlock contract.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      motionLineCount: 96
    },
    metrics: {
      motionLineCount: 96,
      zMin: -1.16,
      zMax: 22,
      materialRemovedMm3: 8.4,
      fitRate: 99.4,
      missCount: 0,
      estimatedMinutes: 2.4
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl",
      note: "Fixture validates non-synthetic CAMotics evidence classification for a closed mesh handoff."
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
    const ridge = 0.18 * Math.sin(Math.PI * 4 * u) * Math.sin(Math.PI * 3 * v);
    return [round(x), round(y), round(0.25 + dome + ridge)];
  };
  const bottom = (i, j) => {
    const x = (length * i) / nx;
    const y = (width * j) / ny;
    return [round(x), round(y), baseZ];
  };
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
  writeFileSync(filePath, `solid closed_relief\n${facets.join("")}endsolid closed_relief\n`);
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
  let transientFetchFailures = 0;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
      transientFetchFailures = 0;
      if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    } catch (error) {
      transientFetchFailures += 1;
      if (transientFetchFailures > 5) throw error;
    }
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
