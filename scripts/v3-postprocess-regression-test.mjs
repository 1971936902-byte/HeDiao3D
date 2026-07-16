#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? "/meshy-results/material01-meshy.glb";
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

async function main() {
  const startedAt = Date.now();
  await getJson("/api/health");

  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  assert(created.id, "created job missing id");

  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const analysis = await getArtifactJson(job.id, "nc-static-analysis.json");
  assert(analysis.level === "ready", `NC static analysis expected ready, got ${analysis.level}: ${analysis.summary}`);
  assert(Array.isArray(analysis.programs) && analysis.programs.length === 3, "expected three NC programs in static analysis");

  const machine = findProgram(analysis, "toolpath.nc");
  assert(machine.role === "machine", "toolpath.nc role mismatch");
  assert(machine.markers.hasRotaryHeader, "toolpath.nc missing ROTARY_WRAP_AXIS marker");
  assert(machine.markers.hasLengthAxisHeader, "toolpath.nc missing LENGTH_AXIS marker");
  assert(machine.axisCounts.x > 0, "toolpath.nc missing X length motion");
  assert(machine.axisCounts.y > 0, "toolpath.nc missing Y rotary-wrap motion");
  assert(machine.axisCounts.a === 0, "wrapY toolpath should not emit A axis");
  assert(machine.axisCounts.z > 0, "toolpath.nc missing Z motion");
  assert(machine.markers.spindleStartCount > 0, "toolpath.nc missing spindle start");
  assert(machine.markers.hasPreviewOnlyMarker === false, "toolpath.nc must not be marked as preview only");

  const airRun = findProgram(analysis, "air-run.nc");
  assert(airRun.role === "air-run", "air-run.nc role mismatch");
  assert(airRun.markers.hasAirRunMarker, "air-run.nc missing AIR RUN marker");
  assert(airRun.markers.spindleStartCount === 0, "air-run.nc must not start spindle");
  assert(Math.abs(Number(airRun.zRange.min) - settings.safeZ) < 0.001, `air-run.nc min Z expected ${settings.safeZ}, got ${airRun.zRange.min}`);
  assert(Math.abs(Number(airRun.zRange.max) - settings.safeZ) < 0.001, `air-run.nc max Z expected ${settings.safeZ}, got ${airRun.zRange.max}`);

  const preview = findProgram(analysis, "camotics-preview.nc");
  assert(preview.role === "simulation-only", "camotics-preview.nc role mismatch");
  assert(preview.markers.hasPreviewOnlyMarker, "camotics-preview.nc missing NOT FOR MACHINE marker");
  assert(preview.markers.spindleStartCount === 0, "camotics-preview.nc must not start spindle");
  assert(Number(preview.zRange.min) < 0, "camotics-preview.nc should use negative cutting Z");
  assert(Number(preview.zRange.max) > 0, "camotics-preview.nc should include positive safe Z");

  const previewText = await getArtifactText(job.id, "camotics-preview.nc");
  assert(previewText.includes("CAMOTICS PREVIEW ONLY - not for machine"), "camotics-preview.nc header missing not-for-machine warning");
  assert(previewText.includes("Coordinate: X/Y unwrapped stock"), "camotics-preview.nc header missing unwrapped coordinate note");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    level: analysis.level,
    machineAxes: machine.axisCounts,
    airRunZ: airRun.zRange,
    previewZ: preview.zRange
  }, null, 2));
}

function findProgram(analysis, filename) {
  const program = analysis.programs.find((item) => item.filename === filename);
  assert(program, `missing ${filename} in NC static analysis`);
  return program;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
