#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
const timeoutMs = Number(process.env.V3_BUDDHA_E2E_TIMEOUT_MS ?? 150000);
const baseline = JSON.parse(readFileSync(join(rootDir, "public", "v3-fixtures", "buddha-baseline.json"), "utf8"));

const modelUrl = process.env.V3_BUDDHA_MODEL_URL
  ?? (baseline.model.preferredCamInput === "stl" ? baseline.model.stlUrl : baseline.model.glbUrl);

const settings = {
  lengthMm: baseline.targetMachine.stock.lengthMm,
  diameterMm: baseline.targetMachine.stock.diameterMm,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: baseline.targetMachine.stock.diameterMm,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: baseline.targetMachine.process.depthMm,
  reliefAngleDeg: 360,
  contrast: 1.45,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 180,
  meshV: 120,
  spindleRpm: baseline.targetMachine.process.spindleRpm,
  feedRate: baseline.targetMachine.process.feedRateMmMin,
  safeZ: baseline.targetMachine.process.safeZMm,
  leftHoldMm: baseline.targetMachine.stock.leftHoldMm,
  rightHoldMm: baseline.targetMachine.stock.rightHoldMm,
  endTransitionMm: baseline.targetMachine.stock.endTransitionMm,
  toolDiameter: baseline.targetMachine.toolDiameterMm,
  stepoverDeg: 5,
  stepoverMm: baseline.targetMachine.process.stepoverMm,
  toolProfileId: baseline.targetMachine.toolProfileId,
  materialProfileId: "olive-core",
  machineProfileId: baseline.targetMachine.machineProfileId,
  camMode: "rotaryWrap",
  rotaryOutputAxis: baseline.targetMachine.rotaryOutputAxis,
  rotaryWrapPerRevolutionMm: baseline.targetMachine.rotaryWrapPerRevolutionMm,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.16,
  stockAllowance: baseline.targetMachine.process.stockAllowanceMm,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  const startedAt = Date.now();
  await getJson("/api/health");

  assert(baseline.productionBoundary.allowProductionNc === false, "buddha fixture baseline must not unlock production");
  assert(baseline.targetMachine.controllerClass === "3axis-controller-with-rotary-fixture", "fixture controller class mismatch");
  assert(baseline.targetMachine.rotaryOutputAxis === "Y", "fixture must target Y rotary fixture");
  assert(baseline.targetMachine.toolProfileId === "vflat-4mm-25deg", "fixture tool profile mismatch");

  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto",
    label: "buddha-v3-e2e"
  });
  assert(created.id, "created Buddha E2E job missing id");

  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `Buddha E2E job did not complete: ${job.status}`);
  assert(job.result?.summary?.points > 8000, `Buddha E2E point count too low: ${job.result?.summary?.points ?? "missing"}`);
  assert(job.result?.summary?.machineControllerProfile?.controllerClass === "3axis-controller-with-rotary-fixture", "Buddha E2E machine profile class mismatch");
  assert(job.result.summary.machineControllerProfile.rotary?.outputAxis === "Y", "Buddha E2E must use Y rotary output");
  assert(job.result.summary.toolSetupSheet?.tool?.toolProfileId === "vflat-4mm-25deg", "Buddha E2E tool setup should use 4mm 25deg flat-tip cutter");
  assert(job.result.summary.toolSetupSheet.tool.angleDeg === 25, "Buddha E2E tool setup should capture 25deg angle");
  assert(job.result.summary.toolSetupSheet.tool.flatTipMm === 0.4, "Buddha E2E tool setup should capture 0.4mm flat tip");
  assert(job.result.summary.productionGate?.allowProductionNc === false, "Buddha E2E must keep production NC locked");
  assert(job.result.summary.deliveryManifest?.allowAirRun === true, "Buddha E2E should allow air-run package");

  const meshQuality = await getArtifactJson(job.id, "mesh-quality.json");
  assert(meshQuality.verdict === "ready", `Buddha mesh should be ready, got ${meshQuality.verdict}`);
  assert(meshQuality.boundaryEdges === 0, "Buddha mesh should not have boundary edges");
  assert(meshQuality.nonManifoldEdges === 0, "Buddha mesh should not have non-manifold edges");
  assert(meshQuality.triangleCount === baseline.model.stlTriangles, `Buddha triangle count mismatch: ${meshQuality.triangleCount}`);

  const ncStatic = await getArtifactJson(job.id, "nc-static-analysis.json");
  assert(ncStatic.level === "ready", `Buddha NC static analysis expected ready, got ${ncStatic.level}`);
  const machineProgram = findProgram(ncStatic, "toolpath.nc");
  assert(machineProgram.axisCounts.x > 0, "Buddha toolpath should move X length axis");
  assert(machineProgram.axisCounts.y > 0, "Buddha toolpath should move Y rotary fixture axis");
  assert(machineProgram.axisCounts.a === 0, "Buddha wrapY toolpath must not emit A axis");
  assert(machineProgram.markers.spindleStartCount > 0, "Buddha toolpath should include spindle start");
  assert(machineProgram.markers.hasPreviewOnlyMarker === false, "Buddha machine toolpath must not be preview-only");

  const rotaryPreview = await getArtifactJson(job.id, "rotary-wrap-preview-report.json");
  assert(rotaryPreview.level === "ready", `Buddha rotary preview expected ready, got ${rotaryPreview.level}`);
  assert(rotaryPreview.coordinateMapping?.rotaryAxis === "Y", "Buddha rotary preview should map rotary axis to Y");
  assert(rotaryPreview.metrics?.machineCoverage >= 0.99, `Buddha machine coverage too low: ${rotaryPreview.metrics?.machineCoverage}`);
  assert(rotaryPreview.axisRanges?.machineNc?.a?.count === 0, "Buddha rotary preview should not see A axis in machine NC");

  const postprocessTrace = await getArtifactJson(job.id, "postprocess-trace-report.json");
  assert(postprocessTrace.level === "ready", `Buddha postprocess trace expected ready, got ${postprocessTrace.level}`);
  assert(postprocessTrace.coordinateMapping?.rotaryAxis === "Y", "Buddha postprocess trace should map rotary axis to Y");
  assert(postprocessTrace.metrics?.fitRate >= 0.999, `Buddha postprocess fit rate too low: ${postprocessTrace.metrics?.fitRate}`);
  assert(postprocessTrace.metrics?.missingMoves === 0, "Buddha postprocess trace should not miss moves");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.machineCompatibility?.controllerClass === "3axis-controller-with-rotary-fixture", "Buddha package index should state target controller class");
  assert(packageIndex.machineCompatibility?.lengthAxis === "X", "Buddha package index should state X length axis");
  assert(packageIndex.machineCompatibility?.rotaryAxis === "Y", "Buddha package index should state Y rotary fixture axis");
  assert(packageIndex.machineCompatibility?.depthAxis === "Z", "Buddha package index should state Z depth axis");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "operator-download-checklist.md"), "Buddha package readFirst missing download checklist");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "postprocess-trace-report.json"), "Buddha package readFirst missing postprocess trace");
  assert(packageIndex.productionEvidenceDossier?.missingEvidenceCount > 0, "Buddha package should still expose missing production evidence");

  const deliveryManifest = await getArtifactJson(job.id, "delivery-manifest.json");
  const toolpathFile = deliveryManifest.files?.find((file) => file.filename === "toolpath.nc");
  const camoticsPreviewFile = deliveryManifest.files?.find((file) => file.filename === "camotics-preview.nc");
  assert(toolpathFile?.machineUse?.requiresGate === true, "Buddha toolpath.nc should require production/trial gate");
  assert(camoticsPreviewFile?.machineUse?.allowedOnMachine === false, "Buddha CAMotics preview must be never-machine");
  assert(deliveryManifest.files?.some((file) => file.filename === "air-run.nc" && file.machineUse?.class === "air-run-no-cut"), "Buddha delivery manifest missing air-run");
  assert(deliveryManifest.files?.some((file) => file.filename === "rotary-calibration-airrun.nc" && file.machineUse?.class === "air-run-no-cut"), "Buddha delivery manifest missing rotary calibration air-run");

  const trialPackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/trial-package`);
  assert(trialPackage.bytes[0] === 0x50 && trialPackage.bytes[1] === 0x4b, "Buddha trial package should be ZIP");
  const trialNames = listZipFilenames(trialPackage.bytes);
  assert(trialNames.some((name) => name.endsWith("/operator-runbook.md")), "Buddha trial package missing operator runbook");
  assert(trialNames.some((name) => name.endsWith("/operator-download-checklist.md")), "Buddha trial package missing download checklist");
  assert(trialNames.some((name) => name.endsWith("/air-run.nc")), "Buddha trial package missing air-run.nc");
  assert(trialNames.some((name) => name.endsWith("/rotary-calibration-airrun.nc")), "Buddha trial package missing rotary calibration air-run");
  assert(!trialNames.some((name) => name.endsWith("/camotics-preview.nc")), "Buddha trial package must exclude CAMotics preview NC");

  const lockedProduction = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedProduction.allowProductionNc === false, "Buddha production package should remain locked");

  const checklist = await getArtifactText(job.id, "operator-download-checklist.md");
  assert(checklist.includes("X=长度方向，Y=旋转夹具，Z=刀深/安全高度"), "Buddha checklist should state exact axis mapping");
  assert(checklist.includes("camotics-preview.nc"), "Buddha checklist should mention never-machine CAMotics preview");

  console.log(JSON.stringify({
    ok: true,
    fixtureId: baseline.id,
    jobId: job.id,
    modelUrl,
    resultEngine: job.result.engine,
    selectedEngine: job.selectedEngine,
    points: job.result.summary.points,
    meshTriangles: meshQuality.triangleCount,
    machineAxes: machineProgram.axisCounts,
    rotaryCoverage: rotaryPreview.metrics.machineCoverage,
    postprocessFitRate: postprocessTrace.metrics.fitRate,
    trialPackageFiles: trialNames.length,
    productionAllowed: lockedProduction.allowProductionNc
  }, null, 2));
}

function findProgram(report, filename) {
  const program = report.programs?.find((item) => item.filename === filename);
  assert(program, `missing ${filename}`);
  return program;
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (["completed", "failed", "canceled"].includes(job.status)) return job;
    await sleep(1000);
  }
  throw new Error(`Buddha E2E job ${jobId} timed out after ${timeoutMs}ms`);
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

async function getBinary(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(response.ok, `binary ${path} failed: ${response.status}`);
  return { bytes, contentType: response.headers.get("content-type") };
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function getJsonAllowingStatus(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.status === expectedStatus, `expected ${expectedStatus} for ${path}, got ${response.status}: ${data.error ?? ""}`);
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

function listZipFilenames(bytes) {
  const buffer = Buffer.from(bytes);
  const names = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + filenameLength;
    names.push(buffer.subarray(nameStart, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + compressedSize;
  }
  return names;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
