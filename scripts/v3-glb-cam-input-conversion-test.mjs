#!/usr/bin/env node
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_GLB_CAM_INPUT_PORT ?? 8795);
const baseUrl = `http://127.0.0.1:${port}`;
const modelUrl = process.env.V3_GLB_CAM_INPUT_MODEL_URL ?? "/meshy-results/material01-meshy.glb";
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
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "4",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "6",
      ORCHESTRATOR_CAM_STL_MAX_TRIANGLES: "20000"
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

  const repairExecution = await getArtifactJson(job.id, "repair-execution.json");
  assert(repairExecution.camSourceConversion?.status === "completed", `GLB conversion should complete, got ${repairExecution.camSourceConversion?.status}`);
  assert(repairExecution.camSourceConversion.targetPath?.endsWith("cam-source-converted.stl"), "conversion target should be cam-source-converted.stl");
  assert(repairExecution.camSourceConversion.stats?.exportedTriangleCount <= 20000, `converted STL should honor triangle cap, got ${repairExecution.camSourceConversion.stats?.exportedTriangleCount}`);
  assert(repairExecution.camSourceConversion.stats?.originalTriangleCount > repairExecution.camSourceConversion.stats?.exportedTriangleCount, "conversion should decimate high-poly GLB for CAM input");
  assert(repairExecution.camSourceConversion.stats?.decimated === true, "conversion stats should mark decimation");
  assert(repairExecution.camSourceConversion.stats?.strategy === "uniform-plus-curvature", `conversion should use curvature-aware sampling, got ${repairExecution.camSourceConversion.stats?.strategy}`);
  assert(repairExecution.camSourceConversion.stats?.curvatureKeptCount > 0, "conversion should preserve high-curvature triangles");
  assert(repairExecution.outputs?.some((candidate) => candidate.id === "camSourceConvertedStl" && candidate.exists), "repair outputs should expose converted STL candidate");

  const camInputPlan = await getArtifactJson(job.id, "cam-input-plan.json");
  assert(camInputPlan.modelSelection?.selectedModelId === "camSourceConvertedStl", `CAM input should select converted STL, got ${camInputPlan.modelSelection?.selectedModelId}`);
  assert(camInputPlan.selectedModelPath?.endsWith("cam-source-converted.stl"), "CAM selected model path should point to converted STL");

  const adapterJob = await getArtifactJson(job.id, "job.json");
  assert(String(adapterJob.modelPath).endsWith("cam-source-converted.stl"), `adapter job should use converted STL, got ${adapterJob.modelPath}`);

  const kernelPlan = await getArtifactJson(job.id, "opencamlib-kernel-plan.json");
  assert(String(kernelPlan.model?.path).endsWith("cam-source-converted.stl"), "OpenCAMLib plan should use converted STL");
  assert(kernelPlan.model?.format === "stl", `OpenCAMLib model format should be stl, got ${kernelPlan.model?.format}`);

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `OpenCAMLib adapter should complete with converted STL, got ${adapterReport.status}: ${adapterReport.error}`);
  assert(adapterReport.metrics?.neutralToolpath?.autoRunner === true, "OpenCAMLib adapter should use bundled preview runner");
  assert(adapterReport.metrics?.neutralToolpath?.previewScaffold === true, "converted GLB handoff should remain preview scaffold");
  assert(adapterReport.metrics?.neutralToolpath?.pointCount === 24, `OpenCAMLib preview should emit 24 neutral points, got ${adapterReport.metrics?.neutralToolpath?.pointCount}`);

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.experimentalHeightfield === true, "neutral toolpath should come from the STL heightfield preview runner");
  assert(neutralToolpath.runner?.heightfield?.cutterEnvelope === true, "neutral toolpath should use cutter envelope preview sampling");
  assert(neutralToolpath.runner?.heightfield?.cutterRadiusMm > 0, "neutral toolpath should report a cutter radius");
  assert(neutralToolpath.points?.some((point) => point.contactSamples > 1), "neutral toolpath should include multi-sample cutter contacts");

  const convertedStl = await getArtifactText(job.id, "cam-source-converted.stl");
  assert(convertedStl.startsWith("solid hediao3d_cam_source_converted"), "converted STL should be ASCII STL");
  assert(convertedStl.includes("facet normal"), "converted STL should contain facets");
  assert(convertedStl.length < 15000000, `converted STL should be capped for CAM handoff, got ${convertedStl.length} bytes`);

  const deliveryManifest = await getArtifactJson(job.id, "delivery-manifest.json");
  assert(deliveryManifest.files?.some((file) => file.filename === "cam-source-converted.stl" && file.exists), "delivery manifest should include converted CAM STL");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedModel: camInputPlan.modelSelection.selectedModelId,
    adapterStatus: adapterReport.status,
    convertedBytes: convertedStl.length,
    neutralPoints: adapterReport.metrics.neutralToolpath.pointCount
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
    rmSync("public/orchestrator-jobs", { recursive: true, force: true });
  });
