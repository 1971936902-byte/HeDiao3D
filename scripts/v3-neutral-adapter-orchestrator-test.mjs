#!/usr/bin/env node
import { spawn } from "node:child_process";

const port = Number(process.env.V3_NEUTRAL_ADAPTER_PORT ?? 8791);
const baseUrl = `http://127.0.0.1:${port}`;
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? "/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.glb";
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);

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
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER: "true",
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "true",
      HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
      HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "true"
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
  const engines = await getJson("/api/orchestrator/engines");
  const opencamlib = engines.engines.find((engine) => engine.id === "opencamlib");
  assert(opencamlib?.available === true, "forced OpenCAMLib adapter should be available");

  const startedAt = Date.now();
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "opencamlib"
  });
  assert(created.id, "created job missing id");
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.selectedEngine === "opencamlib", `selectedEngine expected opencamlib, got ${job.selectedEngine}`);
  assert(job.result?.engine === "opencamlib", `result engine expected opencamlib, got ${job.result?.engine}`);

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `adapter report expected completed, got ${adapterReport.status}`);
  assert(adapterReport.neutralToolpathPath || adapterReport.outputs?.neutralToolpath, "adapter report missing neutral toolpath path");
  assert(adapterReport.metrics?.neutralToolpath?.schema === "hediao3d.neutral-toolpath.v1", "adapter neutral schema mismatch");

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.schema === "hediao3d.neutral-toolpath.v1", "neutral toolpath artifact schema mismatch");
  assert(Array.isArray(neutralToolpath.points) && neutralToolpath.points.length === 30, "neutral toolpath point count mismatch");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.source === "external-adapter", "job should use external adapter source");
  assert(toolpathSummary.postProcessorName?.includes("neutral"), "toolpath summary should identify neutral adapter postprocess");

  const toolpath = await getArtifactText(job.id, "toolpath.nc");
  assert(toolpath.includes("ROTARY_WRAP_AXIS=Y"), "postprocessed NC missing Y rotary marker");
  assert(toolpath.includes("OpenCAMLib neutral adapter"), "postprocessed NC should name neutral adapter source");
  assert(/\bY\d/.test(toolpath), "postprocessed NC should include Y rotary-wrap motion");
  assert(!/\bA-?\d/.test(toolpath), "Y rotary-wrap NC should not contain A-axis motion");

  const analysis = await getArtifactJson(job.id, "nc-static-analysis.json");
  assert(analysis.level === "ready", `neutral adapter NC analysis expected ready, got ${analysis.level}: ${analysis.summary}`);
  const machine = analysis.programs.find((program) => program.filename === "toolpath.nc");
  assert(machine?.axisCounts?.y > 0, "neutral adapter machine NC should contain Y motion");
  assert(machine?.axisCounts?.a === 0, "neutral adapter machine NC should not contain A motion");

  const camoticsReport = await getArtifactJson(job.id, "camotics-adapter-report.json");
  assert(camoticsReport.status === "completed", `CAMotics adapter expected completed, got ${camoticsReport.status}`);
  assert(camoticsReport.simulationResultPath || camoticsReport.outputs?.simulationResult, "CAMotics adapter missing simulation result path");
  const camoticsResult = await getArtifactJson(job.id, "camotics-result.json");
  assert(camoticsResult.schema === "hediao3d.camotics-result.v1", "CAMotics result schema mismatch");
  assert(camoticsResult.synthetic === true, "CAMotics result should be synthetic in this contract test");
  assert(camoticsResult.metrics?.motionLineCount > 0, "CAMotics result should include motion line metrics");
  const simulationSummary = await getArtifactJson(job.id, "simulation-summary.json");
  assert(simulationSummary.engine === "camotics-synthetic", `simulation summary expected camotics-synthetic, got ${simulationSummary.engine}`);
  assert(simulationSummary.camoticsAdapter?.status === "completed", "simulation summary missing completed CAMotics adapter status");
  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowProductionNc === false, "synthetic CAMotics handoff must not unlock production NC");
  assert(productionGate.allowTrialNc === true, "synthetic CAMotics handoff should still allow trial NC when other blockers are clear");
  assert(productionGate.simulationEvidence?.level === "handoff-only", `expected handoff-only simulation evidence, got ${productionGate.simulationEvidence?.level}`);
  assert(productionGate.simulationEvidence?.productionUnlockEligible === false, "synthetic simulation evidence must not be production eligible");
  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.filesByPurpose?.simulationOnly?.some((file) => file.filename === "camotics-result.json"), "package index missing camotics-result.json");
  assert(packageIndex.simulationEvidence?.level === "handoff-only", "package index missing handoff-only simulation evidence");
  assert(packageIndex.camotics?.productionUnlockEligible === false, "package index should keep CAMotics production unlock false for synthetic result");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    source: toolpathSummary.source,
    neutralPoints: neutralToolpath.points.length,
    simulationEngine: simulationSummary.engine,
    simulationEvidence: productionGate.simulationEvidence.level,
    camoticsMotionLines: camoticsResult.metrics.motionLineCount,
    production: productionGate.allowProductionNc,
    trial: productionGate.allowTrialNc,
    ncLevel: analysis.level,
    machineAxes: machine.axisCounts
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server && !server.killed) server.kill();
  });
