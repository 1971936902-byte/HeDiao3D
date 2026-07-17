#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

async function main() {
  const startedAt = Date.now();
  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  assert(created.id, "created job missing id");
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewSha256 = createHash("sha256").update(previewText).digest("hex");
  const previewMotionProfile = createPreviewMotionProfile(previewText);

  const prepared = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-cli-package`, {});
  assert(prepared.ok === true, `CAMotics CLI package should be ready, got ${prepared.status}`);
  assert(prepared.report?.safetyLocks?.productionUnlockFromPreparePackage === false, "prepare package must not unlock production");
  assert(prepared.report?.preferredGcodeIdentity?.sha256 === previewSha256, "API report preview hash mismatch");
  assert(prepared.report?.preferredGcodeIdentity?.motionProfile?.motionLineCount === previewMotionProfile.motionLineCount, "API report motion count mismatch");

  const runPackage = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  assert(runPackage.schema === "hediao3d.camotics-cli-run-package.v1", "run package schema mismatch");
  assert(runPackage.status === "ready-for-linux-camotics", `run package status mismatch: ${runPackage.status}`);
  assert(runPackage.preferredGcodeIdentity?.sha256 === previewSha256, "run package preview hash mismatch");
  assert(runPackage.preferredGcodeIdentity?.motionProfile?.zMin === previewMotionProfile.zMin, "run package zMin mismatch");
  assert(runPackage.preferredGcodeIdentity?.motionProfile?.zMax === previewMotionProfile.zMax, "run package zMax mismatch");
  assert(runPackage.safetyLocks?.productionUnlockFromPreparePackage === false, "run package must keep production locked");
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const runPackageSha256 = createHash("sha256").update(runPackageText).digest("hex");

  const template = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-template.json`);
  assert(template.schema === "hediao3d.camotics-result.v1", "result template schema mismatch");
  assert(template.inputs?.preferredGcodeSha256 === previewSha256, "result template should include preview hash");
  assert(template.inputs?.camoticsCliRunPackageSha256 === runPackageSha256, "result template should bind to current CLI run package hash");
  assert(template.inputs?.machineContext?.rotaryWrapAxis === "Y", "result template should bind Y rotary machine context");
  assert(template.inputs?.machineContext?.rotaryWrapPerRevolutionMm === 100, "result template should bind rotary wrap distance");
  assert(template.metrics?.materialRemovedMm3 === null, "result template must require real material volume");

  const runScript = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-linux-run.sh`);
  assert(runScript.includes("camotics"), "Linux run script should mention camotics command");
  assert(runScript.includes(previewSha256), "Linux run script should echo expected SHA-256");
  const operatorChecklist = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-linux-operator-checklist.md`);
  assert(operatorChecklist.includes("HeDiao3D CAMotics Linux 操作清单"), "operator checklist missing heading");
  assert(operatorChecklist.includes(previewSha256), "operator checklist should bind preferred G-code hash");
  assert(operatorChecklist.includes(runPackageSha256), "operator checklist should bind run package hash");
  assert(operatorChecklist.includes("inputs.machineContext.rotaryWrapAxis"), "operator checklist should require machine context");
  assert(operatorChecklist.includes("productionEvidenceEligible=true"), "operator checklist should require production evidence validation");
  const validatorScript = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-validate.js`);
  assert(validatorScript.includes("hediao3d.camotics-result-local-validation.v1"), "validator should emit local validation schema");
  assert(validatorScript.includes("camotics-result-bundle.zip"), "validator should write uploadable CAMotics result bundle");
  assert(validatorScript.includes("README-CAMOTICS-RESULT.md"), "validator bundle should include README");
  assert(validatorScript.includes("machine-context"), "validator should check machine context");
  assert(validatorScript.includes(runPackageSha256), "validator should bind to current run package hash");
  assert(validatorScript.includes(previewSha256), "validator should bind to current preview G-code hash");
  runLocalValidatorFixture({
    jobId: job.id,
    validatorScript,
    previewSha256,
    runPackageSha256,
    previewMotionProfile
  });

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.camoticsCliPackage?.artifact === "camotics-cli-run-package.json", "job summary missing CLI package");
  assert(reloaded.result?.summary?.camoticsCliPackage?.operatorChecklist === "camotics-linux-operator-checklist.md", "job summary missing operator checklist");
  assert(reloaded.result?.summary?.camoticsCliPackage?.productionUnlockEligible === false, "summary must keep production unlock false");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-cli-run-package.json" && file.exists), "delivery manifest missing run package");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-linux-operator-checklist.md" && file.exists), "delivery manifest missing operator checklist");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-result-validate.js" && file.exists), "delivery manifest missing result validator");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-cli-run-package.json" && file.sha256), "package integrity missing run package hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-linux-run.sh" && file.sha256), "package integrity missing run script hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-result-validate.js" && file.sha256), "package integrity missing result validator hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-linux-operator-checklist.md" && file.sha256), "package integrity missing operator checklist hash");

  const linuxPackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-linux-package`);
  assert(linuxPackage.bytes[0] === 0x50 && linuxPackage.bytes[1] === 0x4b, "CAMotics Linux package should be a ZIP file");
  assert((linuxPackage.contentType ?? "").includes("application/zip"), "CAMotics Linux package should use application/zip content type");
  const linuxZipNames = listZipFilenames(linuxPackage.bytes);
  assert(linuxZipNames.includes("hediao3d-v3-camotics/README-CAMOTICS.md"), "CAMotics Linux package missing README");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/camotics-linux-package-manifest.json"), "CAMotics Linux package missing manifest");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/inputs/camotics-preview.nc"), "CAMotics Linux package missing preview NC");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-linux-run.sh"), "CAMotics Linux package missing run script");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-result-validate.js"), "CAMotics Linux package missing result validator");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-linux-operator-checklist.md"), "CAMotics Linux package missing operator checklist");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-result-template.json"), "CAMotics Linux package missing result template");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    status: prepared.status,
    motionProfile: runPackage.preferredGcodeIdentity.motionProfile,
    productionUnlockEligible: reloaded.result.summary.camoticsCliPackage.productionUnlockEligible
  }, null, 2));
}

function createPreviewMotionProfile(gcodeText) {
  const motionLines = String(gcodeText ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line));
  const zValues = motionLines
    .map((line) => {
      const match = line.match(/\bZ\s*(-?\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : NaN;
    })
    .filter(Number.isFinite);
  return {
    motionLineCount: motionLines.length,
    zMin: Math.min(...zValues),
    zMax: Math.max(...zValues),
    machineContext: createMachineContextFromGcode(gcodeText)
  };
}

function createMachineContextFromGcode(gcodeText) {
  const text = String(gcodeText ?? "");
  const axis = matchHeader(text, "ROTARY_WRAP_AXIS");
  const perRev = Number(matchHeader(text, "ROTARY_WRAP_PER_REV_MM"));
  const lengthAxis = matchHeader(text, "LENGTH_AXIS");
  return {
    schema: "hediao3d.camotics-machine-context.v1",
    camMode: axis ? "rotaryWrap" : "3axis",
    rotaryWrapAxis: axis ? axis.toUpperCase() : null,
    rotaryOutputAxis: axis ? axis.toUpperCase() : null,
    rotaryWrapPerRevolutionMm: Number.isFinite(perRev) ? perRev : null,
    lengthAxis: lengthAxis ? lengthAxis.toUpperCase() : "X",
    simulationInterpretation: axis ? "linearized-rotary-wrap-as-3axis" : "plain-3axis"
  };
}

function matchHeader(text, key) {
  const match = String(text ?? "").match(new RegExp(`${key}\\s*=\\s*([^\\s)]+)`, "i"));
  return match ? match[1] : null;
}

function runLocalValidatorFixture({ jobId, validatorScript, previewSha256, runPackageSha256, previewMotionProfile }) {
  const dir = join(tmpdir(), `hediao3d-camotics-validator-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const validatorPath = join(dir, "camotics-result-validate.js");
    const resultPath = join(dir, "camotics-result.json");
    writeFileSync(validatorPath, validatorScript, "utf8");
    writeFileSync(join(dir, "camotics-preview.png"), "fixture-screenshot", "utf8");
    writeFileSync(join(dir, "camotics-material-removal.stl"), "solid fixture\nendsolid fixture\n", "utf8");
    writeFileSync(resultPath, JSON.stringify({
      schema: "hediao3d.camotics-result.v1",
      jobId,
      engine: "camotics",
      status: "completed",
      synthetic: false,
      riskLevel: "ready",
      summary: "Local validator fixture for CAMotics run package.",
      inputs: {
        preferredGcode: "camotics-preview.nc",
        preferredGcodeSha256: previewSha256,
        camoticsCliRunPackage: "camotics-cli-run-package.json",
        camoticsCliRunPackageSha256: runPackageSha256,
        machineContext: previewMotionProfile.machineContext
      },
      metrics: {
        motionLineCount: previewMotionProfile.motionLineCount,
        zMin: previewMotionProfile.zMin,
        zMax: previewMotionProfile.zMax,
        materialRemovedMm3: 3.2
      },
      artifacts: {
        screenshot: "camotics-preview.png",
        materialMesh: "camotics-material-removal.stl"
      }
    }, null, 2), "utf8");
    const run = spawnSync(process.execPath, [validatorPath, resultPath], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true
    });
    assert(!run.error, `validator spawn failed: ${run.error?.message}`);
    assert(run.status === 0, `validator should pass fixture, exited ${run.status}: ${run.stderr || run.stdout}`);
    const report = JSON.parse(run.stdout);
    assert(report.ok === true, "validator report should be ok");
    assert(report.productionEvidenceEligible === true, "validator should mark passing fixture as production evidence eligible");
    assert(Array.isArray(report.missing) && report.missing.length === 0, "passing validator should not list missing checks");
    assert(/eligible to be imported/.test(report.summary), "passing validator should include import-ready summary");
    assert(report.checks?.some((check) => check.id === "run-package-hash" && check.ok), "validator should check run package hash");
    assert(report.checks?.some((check) => check.id === "visual-or-material-artifact" && check.ok), "validator should check visual/material artifact");
    const bundlePath = join(dir, "camotics-result-bundle.zip");
    assert(existsSync(bundlePath), "validator should write camotics-result-bundle.zip for passing fixture");
    const bundleNames = listZipFilenames(readFileSync(bundlePath));
    assert(bundleNames.includes("camotics-result.json"), "CAMotics result bundle missing result JSON");
    assert(bundleNames.includes("camotics-result-local-validation.json"), "CAMotics result bundle missing local validation");
    assert(bundleNames.includes("camotics-preview.png"), "CAMotics result bundle missing screenshot");
    assert(bundleNames.includes("camotics-material-removal.stl"), "CAMotics result bundle missing material mesh");
    assert(bundleNames.includes("README-CAMOTICS-RESULT.md"), "CAMotics result bundle missing README");

    writeFileSync(resultPath, JSON.stringify({
      schema: "hediao3d.camotics-result.v1",
      jobId,
      engine: "camotics",
      status: "completed",
      synthetic: false,
      riskLevel: "ready",
      inputs: {
        preferredGcodeSha256: previewSha256,
        camoticsCliRunPackageSha256: "bad-hash",
        machineContext: {
          ...previewMotionProfile.machineContext,
          rotaryWrapAxis: "X"
        }
      },
      metrics: {
        motionLineCount: previewMotionProfile.motionLineCount,
        zMin: previewMotionProfile.zMin,
        zMax: previewMotionProfile.zMax,
        materialRemovedMm3: 3.2
      },
      artifacts: {
        screenshot: "missing-preview.png",
        materialMesh: "missing-material-removal.stl"
      }
    }, null, 2), "utf8");
    const failedRun = spawnSync(process.execPath, [validatorPath, resultPath], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true
    });
    assert(failedRun.status !== 0, "validator should reject incomplete fixture");
    const failedReport = JSON.parse(failedRun.stdout);
    assert(failedReport.ok === false, "failed validator report should not be ok");
    assert(failedReport.productionEvidenceEligible === false, "failed validator should not be production evidence eligible");
    assert(failedReport.missing?.includes("run-package-hash"), "failed validator should list run-package-hash");
    assert(failedReport.missing?.includes("machine-context"), "failed validator should list machine-context");
    assert(failedReport.missing?.includes("visual-or-material-artifact"), "failed validator should list missing artifact evidence");
    assert(/failed/.test(failedReport.summary), "failed validator should include failed summary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${path}`);
  return data;
}

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status} ${path}`);
  return text;
}

async function getBinary(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(buffer.toString("utf8") || `${response.status} ${path}`);
  return {
    bytes: buffer,
    contentType: response.headers.get("content-type")
  };
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${path}`);
  return data;
}

function listZipFilenames(bytes) {
  const names = [];
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const compressedSize = bytes.readUInt32LE(offset + 18);
      const fileNameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLength;
      names.push(bytes.subarray(nameStart, nameEnd).toString("utf8"));
      offset = nameEnd + extraLength + compressedSize;
      continue;
    }
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    offset += 1;
  }
  return names;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
