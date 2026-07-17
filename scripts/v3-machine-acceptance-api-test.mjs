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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  const initialPackageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  const integrityEvidenceFiles = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc", "camotics-preview.nc"].map((filename) => {
    const file = initialPackageIntegrity.files?.find((item) => item.filename === filename);
    return {
      filename,
      sha256: file?.sha256 ?? null,
      verified: Boolean(file?.sha256),
      machineUseClass: file?.machineUse?.class ?? null
    };
  });

  const mismatchedEvidenceFiles = integrityEvidenceFiles.map((file) => file.filename === "toolpath.nc"
    ? { ...file, sha256: "0".repeat(64), note: "Intentional mismatch for negative binding test." }
    : file);
  const rejectedAcceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "machine-acceptance-api-test-mismatch",
    outcome: "success",
    operator: "API test operator",
    machineSerial: "desktop-rotary-y-wrap-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: false,
    downloadIntegrity: {
      packageIntegrityReviewed: true,
      operatorChecklistReviewed: true,
      neverMachineConfirmed: true,
      files: mismatchedEvidenceFiles
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "All package reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "Submitted hash should be rejected because it does not match package-integrity.json." },
      { id: "camotics-preview", passed: true, evidenceNote: "Preview checked for bounds and Z range." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration air-run completed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Dry run completed with spindle off and safe Z." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial completed at reduced feed." }
    ],
    notes: "Machine acceptance API negative test: mismatched toolpath hash must not pass."
  });

  assert(rejectedAcceptance.record.allRequiredPassed === false, "mismatched hash acceptance must not pass required steps");
  assert(rejectedAcceptance.record.downloadIntegrity?.packageBinding?.status === "mismatch", "mismatched hash should create package binding mismatch");
  assert(rejectedAcceptance.record.downloadIntegrity.packageBinding.files?.some((file) => file.filename === "toolpath.nc" && file.issues.includes("sha256-mismatch")), "toolpath hash mismatch should be reported");
  assert(rejectedAcceptance.record.steps?.some((step) => step.id === "verify-download-integrity" && step.status === "failed"), "download integrity step should fail on hash mismatch");
  assert(rejectedAcceptance.productionEvidenceDossier.evidenceItems?.some((item) => item.id === "machine-acceptance" && item.status !== "pass"), "mismatched acceptance must not pass dossier machine evidence");

  const acceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "machine-acceptance-api-test",
    outcome: "success",
    operator: "API test operator",
    machineSerial: "desktop-rotary-y-wrap-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: false,
    downloadIntegrity: {
      packageIntegrityReviewed: true,
      operatorChecklistReviewed: true,
      neverMachineConfirmed: true,
      files: integrityEvidenceFiles
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "All package reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "SHA-256 for machine candidate and air-run files verified." },
      { id: "camotics-preview", passed: true, evidenceNote: "Preview checked for bounds and Z range." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration air-run completed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Dry run completed with spindle off and safe Z." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial completed at reduced feed." }
    ],
    attachments: ["air-run-photo.jpg", "soft-trial-photo.jpg"],
    notes: "Machine acceptance API test: required trial-only steps passed."
  });

  assert(acceptance.ok === true, "machine acceptance API did not return ok");
  assert(acceptance.record?.schema === "hediao3d.machine-acceptance-record.v1", "record schema mismatch");
  assert(acceptance.record.allRequiredPassed === true, "record should mark required steps passed");
  assert(acceptance.record.downloadIntegrity?.allRequiredHashesVerified === true, "record should mark required hashes verified");
  assert(acceptance.record.downloadIntegrity?.neverMachineConfirmed === true, "record should confirm never-machine files");
  assert(acceptance.record.downloadIntegrity?.packageBinding?.status === "matched", "record should bind hashes to current package integrity");
  assert(acceptance.record.downloadIntegrity.packageBinding.files?.every((file) => file.status === "matched"), "all bound package files should match");
  assert(acceptance.record.steps?.some((step) => step.id === "verify-download-integrity" && step.status === "pass"), "download integrity step should pass");
  assert(acceptance.record.steps?.some((step) => step.id === "air-run" && step.status === "pass"), "air-run step should pass");
  assert(acceptance.log?.recordCount >= 1, "machine acceptance log count missing");
  assert(acceptance.productionEvidenceDossier?.schema === "hediao3d.production-evidence-dossier.v1", "response missing production evidence dossier");
  assert(acceptance.productionEvidenceDossier.crossChecks?.machineAcceptanceRecords >= 1, "evidence dossier should count machine acceptance records");
  assert(acceptance.productionEvidenceDossier.evidenceItems?.some((item) => item.id === "machine-acceptance" && item.status === "pass"), "machine acceptance evidence item should pass");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.machineAcceptanceLog?.schema === "hediao3d.machine-acceptance-log.v1", "job summary missing machine acceptance log");
  assert(reloaded.result.summary.machineAcceptanceLog.recordCount >= 2, "job summary machine acceptance count missing");
  assert(reloaded.result.summary.machineAcceptanceLog.allRequiredPassed === true, "job summary should mark required steps passed");
  assert(reloaded.result.summary.machineAcceptanceLog.downloadIntegrityBound === "matched", "job summary should expose package integrity binding");

  const recordArtifact = await getArtifactJson(job.id, "machine-acceptance-record.json");
  assert(recordArtifact.id === acceptance.record.id, "record artifact id mismatch");
  assert(recordArtifact.attachments?.includes("air-run-photo.jpg"), "record should preserve attachment file names");
  assert(!("photoUrl" in recordArtifact), "record artifact must not store photo data URLs");

  const logArtifact = await getArtifactJson(job.id, "machine-acceptance-log.json");
  assert(logArtifact.records?.some((record) => record.id === acceptance.record.id), "log artifact missing record");
  const dossierArtifact = await getArtifactJson(job.id, "production-evidence-dossier.json");
  assert(dossierArtifact.evidenceItems?.some((item) => item.id === "machine-acceptance" && item.summary.includes("机床验收记录")), "dossier missing machine acceptance evidence item");
  assert(dossierArtifact.crossChecks?.machineAcceptancePassed === true, "dossier should mark machine acceptance passed");
  assert(dossierArtifact.crossChecks?.machineAcceptanceIntegrityBound === true, "dossier should mark machine acceptance package binding passed");
  const deliveryManifest = await getArtifactJson(job.id, "delivery-manifest.json");
  assert(deliveryManifest.files?.some((file) => file.filename === "machine-acceptance-record.json" && file.downloadable), "delivery manifest should expose machine acceptance record");
  assert(deliveryManifest.files?.some((file) => file.filename === "machine-acceptance-log.json" && file.downloadable), "delivery manifest should expose machine acceptance log");
  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  assert(packageIntegrity.files?.some((file) => file.filename === "machine-acceptance-record.json" && file.sha256), "package integrity missing machine acceptance record hash");
  assert(packageIntegrity.files?.some((file) => file.filename === "machine-acceptance-log.json" && file.sha256), "package integrity missing machine acceptance log hash");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    recordId: acceptance.record.id,
    recordCount: acceptance.log.recordCount,
    requiredSteps: acceptance.record.requiredStepCount,
    passedRequired: acceptance.record.passedRequiredCount
  }, null, 2));
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
