#!/usr/bin/env node
import { createHash } from "node:crypto";

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
  await getJson("/api/health");

  const startedAt = Date.now();
  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  assert(created.id, "created job missing id");
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const validationReport = createValidationReportFixture();
  const validationReportSha256 = createHash("sha256").update(JSON.stringify(validationReport, null, 2)).digest("hex");
  const nativeCamImport = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-bundle.zip",
    acceptanceZipDataUrl: toZipDataUrl({
      "native-cam-real-output-acceptance.json": JSON.stringify(createAcceptanceFixture(validationReportSha256), null, 2),
      "v3-external-adapter-validation.json": JSON.stringify(validationReport, null, 2)
    })
  });
  assert(nativeCamImport.level === "ready", `native CAM acceptance should be ready, got ${nativeCamImport.level}`);
  assert(nativeCamImport.sourceReportBindingStatus === "matched", "native CAM acceptance should bind to adapter validation report");
  assert(nativeCamImport.apiArtifacts?.zipBundle?.includes("imported-native-cam-real-output-bundle.zip"), "native CAM import should preserve source ZIP");

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewSha256 = sha256(previewText);
  const previewMotionProfile = createPreviewMotionProfile(previewText);
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const runPackageSha256 = sha256(runPackageText);

  const camoticsImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, previewSha256, previewMotionProfile, runPackageSha256), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(), null, 2),
      "camotics-preview.png": "closed-loop-fixture-camotics-png",
      "camotics-material-removal.stl": "solid closed_loop_material\nendsolid closed_loop_material\n"
    })
  });
  assert(camoticsImport.ok === true, `CAMotics import should pass: ${camoticsImport.adapterReport?.error ?? "unknown"}`);
  assert(camoticsImport.simulationEvidence?.level === "material-removal-verified", `expected material-removal-verified, got ${camoticsImport.simulationEvidence?.level}`);
  assert(camoticsImport.simulationEvidence?.productionUnlockEligible === true, "CAMotics import should be production evidence eligible");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  const dossier = reloaded.result?.summary?.productionEvidenceDossier;
  assert(dossier?.schema === "hediao3d.production-evidence-dossier.v1", "job summary missing production evidence dossier");
  assert(dossier.evidenceItems?.some((item) => item.id === "material-removal-simulation" && item.status === "pass"), "material-removal evidence should pass after CAMotics ZIP import");
  assert(dossier.crossChecks?.realMaterialRemovalVerified === true, "dossier should mark real material removal verified");
  assert(dossier.crossChecks?.camoticsInputIdentityStatus === "matched", "CAMotics input identity should be matched");
  assert(dossier.crossChecks?.camoticsCliRunPackageBindingStatus === "matched", "CAMotics CLI package binding should be matched");
  assert(dossier.crossChecks?.camoticsMotionConsistencyStatus === "matched", "CAMotics motion consistency should be matched");
  assert(dossier.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "production package must remain locked without field acceptance and real external handoff");
  assert(dossier.status !== "production-evidence-complete", "dossier must remain incomplete before field evidence");

  const nextActionChecklist = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/next-action-checklist.md`);
  assert(nextActionChecklist.includes("仿真证据: material-removal-verified"), "next-action checklist should show verified CAMotics evidence");
  assert(nextActionChecklist.includes("生产门禁"), "next-action checklist should keep production gate visible");

  const packageIndex = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/machining-package-index.json`);
  assert(packageIndex.productionEvidenceDossier?.crossChecks?.camoticsInputIdentityStatus === "matched", "package index should expose refreshed CAMotics cross-checks");
  assert(packageIndex.productionEvidenceDossier.crossChecks.productionReadinessAudit?.allowProductionPackage === false, "package index must keep production package locked");

  const lockedProductionPackage = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(["V3 正式生产包未解锁", "V3 正式生产包证据档案未闭环"].includes(lockedProductionPackage.error), "production package endpoint should remain locked");
  assert(lockedProductionPackage.allowProductionNc === false, "locked response should keep allowProductionNc=false");

  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.nativeCamRealOutputAcceptance?.level === "ready", "readiness should expose latest native CAM acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportBindingStatus === "matched", "readiness should expose native CAM source binding");
  assert(readiness.readinessCamoticsEvidence?.source === "latest-job-evidence-dossier", `readiness should use latest job CAMotics evidence, got ${readiness.readinessCamoticsEvidence?.source}`);
  assert(readiness.readinessCamoticsEvidence.productionEvidenceEligible === true, "readiness should mark latest job CAMotics evidence eligible");
  assert(readiness.readinessCamoticsEvidence.inputIdentityStatus === "matched", "readiness CAMotics evidence should preserve matched input identity");
  assert(readiness.latestEvidenceDossier?.jobId === job.id, "readiness should point to the refreshed closed-loop job");
  assert(readiness.latestEvidenceDossier.crossChecks?.realMaterialRemovalVerified === true, "readiness should expose verified material-removal evidence through latest job dossier");
  assert(readiness.latestEvidenceDossier.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "readiness must keep production locked until field evidence passes");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    nativeCamAcceptance: nativeCamImport.level,
    camoticsEvidence: camoticsImport.simulationEvidence.level,
    dossierStatus: dossier.status,
    productionPackageLocked: true
  }, null, 2));
}

function createValidationReportFixture() {
  return {
    schema: "hediao3d.external-adapter-validation.v1",
    createdAt: new Date().toISOString(),
    outputRoot: "public/orchestrator-adapter-validation/evidence-closed-loop",
    useNativeCommands: true,
    handoffClassificationAudit: {
      productionCandidateCount: 1,
      unsafeCount: 0,
      missingCount: 0
    },
    adapters: [
      {
        id: "opencamlib",
        handoffEvidence: {
          classification: "production-candidate",
          productionCandidate: true
        }
      }
    ]
  };
}

function createAcceptanceFixture(sourceReportSha256) {
  return {
    schema: "hediao3d.native-cam-real-output-acceptance.v1",
    createdAt: new Date().toISOString(),
    sourceReport: "public/orchestrator-adapter-validation/evidence-closed-loop/v3-external-adapter-validation.json",
    sourceReportIdentity: {
      filename: "v3-external-adapter-validation.json",
      path: "public/orchestrator-adapter-validation/evidence-closed-loop/v3-external-adapter-validation.json",
      sha256: sourceReportSha256,
      schema: "hediao3d.external-adapter-validation.v1"
    },
    level: "ready",
    strict: true,
    expectProductionCandidate: true,
    productionCandidateCount: 1,
    unsafeCount: 0,
    missingCount: 0,
    blockers: [],
    warnings: [],
    nextActions: ["继续导入 neutral-toolpath、CAMotics 真实材料去除和现场同包验收。"],
    adapters: [
      {
        id: "opencamlib",
        status: "completed",
        classification: "production-candidate",
        productionCandidate: true,
        fixture: false,
        synthetic: false,
        previewScaffold: false,
        generatedByExternalCommand: true
      }
    ]
  };
}

function createCamoticsResult(jobId, preferredGcodeSha256, motionProfile, runPackageSha256) {
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId,
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "Closed-loop imported CAMotics material-removal result fixture.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      preferredGcodeSha256,
      camoticsCliRunPackage: "camotics-cli-run-package.json",
      camoticsCliRunPackageSha256: runPackageSha256,
      machineContext: motionProfile.machineContext
    },
    metrics: {
      motionLineCount: motionProfile.motionLineCount,
      zMin: motionProfile.zMin,
      zMax: motionProfile.zMax,
      materialRemovedMm3: 9.6
    }
  };
}

function createLocalValidation() {
  return {
    schema: "hediao3d.camotics-result-local-validation.v1",
    createdAt: new Date().toISOString(),
    ok: true,
    productionEvidenceEligible: true,
    resultPath: "camotics-result.json",
    checks: [
      { id: "result-file", ok: true, severity: "info", message: "closed-loop fixture" },
      { id: "run-package-hash", ok: true, severity: "info", message: "closed-loop fixture" },
      { id: "material-removal-artifacts", ok: true, severity: "info", message: "closed-loop fixture" }
    ],
    missing: [],
    summary: "CAMotics local validation passed: result is eligible to be imported as material-removal evidence."
  };
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

function toZipDataUrl(files) {
  return `data:application/zip;base64,${createStoredZip(files).toString("base64")}`;
}

function createStoredZip(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(String(content), "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, data);
  }
  return Buffer.concat(chunks);
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
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function getJsonAllowingStatus(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.status === expectedStatus, `${path} expected ${expectedStatus}, got ${response.status}`);
  return data;
}

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  assert(response.ok, `${path} failed: ${response.status} ${text}`);
  return text;
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
