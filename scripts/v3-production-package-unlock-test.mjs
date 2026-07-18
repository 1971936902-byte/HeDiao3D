#!/usr/bin/env node
import { createHash } from "node:crypto";

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
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
  stepoverDeg: 3,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.16,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  await getJson("/api/health");

  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const lockedBeforeEvidence = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedBeforeEvidence.allowProductionNc === false, "production package must start locked");

  const candidateNeutral = createCandidateNeutral();
  const imported = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/neutral-toolpath`, {
    sourceName: "production-package-candidate-neutral.json",
    engine: "opencamlib",
    neutralToolpath: candidateNeutral
  });
  assert(imported.validation?.handoffEvidence?.classification === "production-candidate", "strict contact neutral should classify as production-candidate");
  assert(imported.validation?.cutterContactReport?.inputIdentityBinding?.status === "bound", "strict contact neutral should bind contact identity");

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewMotionProfile = createPreviewMotionProfile(previewText);
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const camoticsImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, sha256(previewText), previewMotionProfile, sha256(runPackageText)), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(), null, 2),
      "camotics-preview.png": "production-package-unlock-fixture-png",
      "camotics-material-removal.stl": "solid production_package_unlock\nendsolid production_package_unlock\n"
    })
  });
  assert(camoticsImport.simulationEvidence?.productionUnlockEligible === true, "CAMotics evidence should be production eligible");

  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  const downloadIntegrity = createDownloadIntegrityEvidence(packageIntegrity);
  const feedback = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/trial-feedback`, {
    id: "production-package-unlock-feedback",
    outcome: "success",
    phase: "soft-trial",
    machineName: "三轴控制器+Y轴旋转夹具",
    toolName: "4mm 25度平底尖刀",
    materialName: "软料试雕",
    actualMinutes: 1.2,
    issues: [],
    notes: "Production package unlock test: successful package-bound trial.",
    downloadIntegrity,
    settings
  });
  assert(feedback.productionEvidenceDossier?.crossChecks?.trialFeedbackPassed === true, "trial feedback should pass and bind package integrity");

  const acceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "production-package-unlock-machine-acceptance",
    outcome: "success",
    operator: "V3 production package test",
    machineSerial: "desktop-3axis-rotary-y-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: true,
    downloadIntegrity,
    rotaryCalibration: {
      directionOk: true,
      measuredQuarterTurnDeg: 90,
      measuredHalfTurnDeg: 180,
      measuredFullTurnDeg: 360,
      backlashDeg: 0.2,
      measuredWrapPerRevolutionMm: settings.rotaryWrapPerRevolutionMm
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "Reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "Machine files verified against package-integrity.json." },
      { id: "camotics-preview", passed: true, evidenceNote: "Material-removal result reviewed." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration passed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Full dry run passed with spindle off." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial passed." }
    ]
  });
  assert(acceptance.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === true, "complete evidence should allow production package");
  assert(acceptance.productionEvidenceDossier?.status === "production-evidence-complete", "dossier should become production-evidence-complete");

  const productionPackage = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`);
  const packageBuffer = Buffer.from(await productionPackage.arrayBuffer());
  assert(productionPackage.ok, `production package should download after complete evidence, got ${productionPackage.status}`);
  assert((productionPackage.headers.get("content-type") ?? "").includes("application/zip"), "production package should be a zip");
  assert(packageBuffer.length > 1000, "production package zip should contain artifacts");
  const packageText = packageBuffer.toString("utf8");
  assert(packageText.includes("hediao3d.v3-production-package.v1"), "production package should include manifest schema");
  assert(packageText.includes("toolpath.nc"), "production package should include toolpath.nc manifest entry");
  assert(!/hediao3d-v3-production\/[^/\0]+\/camotics-preview\.nc/.test(packageText), "production package must exclude simulation-only camotics-preview.nc file");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  const dossier = await getArtifactJson(job.id, "production-evidence-dossier.json");
  assert(reloaded.result?.summary?.productionEvidenceDossier?.status === "production-evidence-complete", "job summary should expose complete production evidence");
  assert(dossier.crossChecks?.fieldEvidencePackageBinding?.status === "matched", "field evidence should bind the same package hashes");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    dossierStatus: dossier.status,
    productionPackageBytes: packageBuffer.length,
    productionAllowed: true
  }, null, 2));
}

function createCandidateNeutral() {
  const points = [];
  for (const a of [0, 90, 180, 270, 360]) {
    for (let index = 0; index < 25; index += 1) {
      const t = index / 24;
      const x = -17 + t * 34;
      const wave = Math.sin(t * Math.PI) * (0.18 + 0.04 * Math.cos((a / 180) * Math.PI));
      const depth = 0.42 + wave;
      points.push({
        x: Number(x.toFixed(4)),
        a,
        z: Number((22 - depth).toFixed(4)),
        depth: Number(depth.toFixed(4))
      });
    }
  }
  const neutral = {
    schema: "hediao3d.neutral-toolpath.v1",
    engine: "opencamlib",
    synthetic: false,
    fixture: false,
    generatedByExternalCommand: true,
    coordinate: {
      lengthAxis: "X",
      rotaryAxis: "Y",
      depthAxis: "Z",
      rotaryUnit: "degree"
    },
    estimatedMinutes: 1.4,
    points
  };
  const neutralHash = sha256Json(neutral);
  neutral.cutterContactReport = {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    mode: "opencamlib-drop-cutter-contact",
    inputIdentity: {
      neutralToolpathWithoutContactReportSha256: neutralHash,
      sourceNeutralToolpathSha256: neutralHash
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    contactSampling: {
      algorithm: "opencamlib-drop-cutter-contact",
      pointCount: neutral.points.length,
      contactPointCount: neutral.points.length,
      hitRate: 1,
      stepToCutterRatio: 0.18,
      pathCoverage: {
        schema: "hediao3d.opencamlib-path-dropcutter-coverage.v1",
        xCoverageRatio: 1,
        crossCoverageRatio: 1,
        sampledXSpanMm: 24,
        sampledCrossSpanMm: 360,
        modelXSpanMm: 24,
        modelCrossSpanMm: 360
      }
    },
    residualMaterial: {
      measured: true,
      validationBasis: "swept-volume-validated-fixture",
      maxGougeMm: 0.01,
      maxUndercutMm: 0.03,
      residualVolumeMm3: 0.4
    },
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    protectedZones: {
      schema: "hediao3d.opencamlib-protected-zones.v1",
      enabled: true,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      safeMinX: -12,
      safeMaxX: 12,
      sampledMinX: -12,
      sampledMaxX: 12,
      violationCount: 0,
      violations: []
    },
    quality: {
      level: "validated-contact",
      previewScaffold: false,
      postprocessEligible: true,
      productionCandidate: true,
      summary: "Production package unlock fixture representing strict OpenCAMLib cutter contact."
    }
  };
  return neutral;
}

function createCamoticsResult(jobId, preferredGcodeSha256, motionProfile, runPackageSha256) {
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId,
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "Production package unlock fixture material-removal result.",
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
      materialRemovedMm3: 8.8
    }
  };
}

function createLocalValidation() {
  return {
    schema: "hediao3d.camotics-result-local-validation.v1",
    createdAt: new Date().toISOString(),
    ok: true,
    productionEvidenceEligible: true,
    checks: [
      { id: "result-file", ok: true, severity: "info", message: "fixture" },
      { id: "run-package-hash", ok: true, severity: "info", message: "fixture" },
      { id: "material-removal-artifacts", ok: true, severity: "info", message: "fixture" }
    ],
    missing: [],
    summary: "CAMotics local validation passed."
  };
}

function createDownloadIntegrityEvidence(packageIntegrity) {
  const keyFiles = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc", "camotics-preview.nc"];
  return {
    packageIntegrityReviewed: true,
    operatorChecklistReviewed: true,
    neverMachineConfirmed: true,
    files: keyFiles.map((filename) => {
      const file = packageIntegrity.files?.find((item) => item.filename === filename);
      return {
        filename,
        sha256: file?.sha256 ?? null,
        verified: Boolean(file?.sha256),
        machineUseClass: file?.machineUse?.class ?? null
      };
    })
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

async function waitForJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (["completed", "failed", "canceled"].includes(job.status)) return job;
    await delay(500);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function getArtifactJson(jobId, filename) {
  return getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
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

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value, null, 2)).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
