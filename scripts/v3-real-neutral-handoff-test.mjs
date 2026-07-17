#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_REAL_NEUTRAL_HANDOFF_PORT ?? 8792);
const baseUrl = `http://127.0.0.1:${port}`;
const importedModelName = `v3-real-neutral-heightfield-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? `/imported-models/${importedModelName}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-real-neutral-handoff-"));
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
  writeImportedHeightfieldModel(importedModelPath);
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
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "6",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "8",
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
  assert(adapterReport.metrics?.neutralToolpath?.autoRunner === true, "adapter should use bundled heightfield runner automatically");
  assert(adapterReport.metrics?.neutralToolpath?.heightfieldPreview === true, "adapter should classify heightfield preview output");
  assert(adapterReport.metrics?.neutralToolpath?.previewScaffold === true, "adapter should classify preview scaffold output");
  assert(adapterReport.metrics?.neutralToolpath?.cutterContactReport?.inputIdentityBinding?.status === "bound", "heightfield contact report should bind to neutral output hash");
  assert(adapterReport.metrics?.neutralToolpath?.imported === false, "external command output should not be classified as imported fixture");
  assert(adapterReport.metrics?.neutralToolpath?.synthetic === false, "adapter neutral output must not be synthetic");

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
  assert(neutralToolpath.synthetic === false, "neutral fixture should remain non-synthetic after import");
  assert(neutralToolpath.generatedByExternalCommand === true, "neutral output should record external command generation");
  assert(neutralToolpath.experimentalHeightfield === true, "neutral output should mark heightfield mode");
  assert(Array.isArray(neutralToolpath.points) && neutralToolpath.points.length === 48, "neutral point count mismatch");
  assert(neutralToolpath.runner?.heightfield?.missCount === 0, "heightfield runner should sample the full test STL");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.source === "external-adapter", "toolpath should come from external adapter");
  assert(toolpathSummary.engine === "opencamlib", "toolpath summary engine should be opencamlib");
  assert(toolpathSummary.externalSourceSnapshot?.kind === "neutral-toolpath", "toolpath summary should snapshot neutral source");
  assert(/^[a-f0-9]{64}$/.test(toolpathSummary.externalSourceSnapshot.sha256 ?? ""), "neutral source snapshot should include SHA-256");
  assert(toolpathSummary.externalSourceSnapshot.neutral?.pointCount === neutralToolpath.points.length, "neutral source snapshot point count mismatch");
  assert(toolpathSummary.externalSourceSnapshot.neutral?.generatedByExternalCommand === true, "neutral source snapshot should record external command generation");
  assert(toolpathSummary.externalSourceSnapshot.neutral?.runner?.heightfieldMode === true, "neutral source snapshot should classify heightfield output");
  assert(toolpathSummary.externalSourceSnapshot.neutral?.runner?.previewScaffold === true, "neutral source snapshot should classify heightfield preview scaffold");

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
  assert(camoticsResult.evidenceQuality?.inputIdentity?.status === "missing-imported-hash", `fixture should be missing imported hash, got ${camoticsResult.evidenceQuality?.inputIdentity?.status}`);
  assert(camoticsResult.evidenceQuality?.productionEvidenceEligible === false, "fixture without G-code identity hash must not be production eligible");

  const simulationSummary = await getArtifactJson(job.id, "simulation-summary.json");
  assert(simulationSummary.engine === "camotics", `simulation expected camotics, got ${simulationSummary.engine}`);
  assert(simulationSummary.camoticsAdapter?.synthetic === false, "simulation summary should mark non-synthetic CAMotics result");

  const camHandoffQuality = await getArtifactJson(job.id, "cam-handoff-quality.json");
  assert(camHandoffQuality.sourceSnapshot?.kind === "neutral-toolpath", "CAM handoff quality should include neutral source snapshot");
  assert(camHandoffQuality.sourceSnapshot?.sha256 === toolpathSummary.externalSourceSnapshot.sha256, "CAM handoff snapshot hash should match toolpath summary");
  assert(camHandoffQuality.previewScaffold === true, "CAM handoff quality should mark heightfield preview scaffold");
  assert((camHandoffQuality.warningIssues ?? []).some((item) => /preview|scaffold|预览|刀具接触/i.test(item)), "CAM handoff quality should warn about preview scaffold output");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.simulationEvidence?.level === "material-removal-incomplete", `expected material-removal-incomplete evidence, got ${productionGate.simulationEvidence?.level}`);
  assert(productionGate.simulationEvidence?.productionUnlockEligible === false, "non-synthetic CAMotics fixture without hash must not be production unlock eligible");
  assert(productionGate.allowAirRun === true, "real neutral handoff should allow air-run when NC static gates pass");
  assert(productionGate.allowTrialNc === false, "open two-triangle test STL must not unlock trial NC");
  assert(productionGate.allowProductionNc === false, "heightfield handoff must not unlock production while Native CAM/model gates remain");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.simulationEvidence?.level === "material-removal-incomplete", "package index should expose incomplete material-removal evidence");
  assert(packageIndex.camotics?.productionUnlockEligible === false, "package index should not mark hashless fixture eligible");

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
    summary: "Imported non-synthetic CAMotics fixture for Orchestrator material-removal evidence contract.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      motionLineCount: 42
    },
    metrics: {
      motionLineCount: 42,
      zMin: -1.18,
      zMax: 22,
      materialRemovedMm3: 4.6,
      fitRate: 99.1,
      missCount: 0,
      estimatedMinutes: 1.2
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl",
      note: "Fixture represents an externally produced CAMotics result; it validates import classification, not visual simulation fidelity."
    }
  }, null, 2));
}

function writeImportedHeightfieldModel(filePath) {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
  writeFileSync(filePath, `solid heightfield
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 38 0 1
      vertex 0 15 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 38 0 1
      vertex 38 15 1
      vertex 0 15 0
    endloop
  endfacet
endsolid heightfield
`);
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
