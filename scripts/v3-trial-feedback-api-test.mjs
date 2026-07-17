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
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const feedback = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/trial-feedback`, {
    id: "trial-feedback-api-test",
    outcome: "review",
    phase: "soft-trial",
    machineName: "三轴控制器+Y轴旋转夹具",
    toolName: "4mm 25度平底尖刀",
    materialName: "软料试雕",
    estimatedMinutes: job.result.summary.estimatedMinutes,
    actualMinutes: Math.max(1, Number(job.result.summary.estimatedMinutes ?? 1) * 1.45),
    issues: ["旋转错位", "欠切"],
    notes: "API test feedback: rotary mismatch and shallow detail.",
    photoName: "trial-feedback-api-test.jpg",
    photoAttached: true,
    settings
  });

  assert(feedback.ok === true, "feedback API did not return ok");
  assert(feedback.record?.schema === "hediao3d.trial-feedback-record.v1", "record schema mismatch");
  assert(feedback.record.recommendations?.some((item) => item.includes("旋转")), "feedback should recommend rotary calibration");
  assert(feedback.log?.recordCount >= 1, "feedback log count missing");
  assert(feedback.optimizationPlan?.schema === "hediao3d.process-optimization-plan.v1", "optimization plan schema mismatch");
  assert(feedback.optimizationPlan.actions?.some((action) => action.id === "rotary-misalignment"), "optimization plan should include rotary action");
  assert(feedback.optimizationPlan.nextRunProfile?.requiresRegeneration === true, "optimization plan should require regeneration");
  assert(feedback.productionEvidenceDossier?.schema === "hediao3d.production-evidence-dossier.v1", "feedback response missing evidence dossier");
  assert(feedback.productionEvidenceDossier.crossChecks?.trialFeedbackRecords >= 1, "evidence dossier should count feedback records");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.trialFeedbackLog?.schema === "hediao3d.trial-feedback-log.v1", "job summary missing feedback log");
  assert(reloaded.result.summary.trialFeedbackLog.recordCount >= 1, "job summary feedback count missing");
  assert(reloaded.result?.summary?.processOptimizationPlan?.schema === "hediao3d.process-optimization-plan.v1", "job summary missing optimization plan");
  assert(reloaded.result.summary.processOptimizationPlan.actionCount >= 1, "job summary optimization action count missing");
  assert(reloaded.result?.summary?.productionEvidenceDossier?.schema === "hediao3d.production-evidence-dossier.v1", "job summary missing evidence dossier");

  const recordArtifact = await getArtifactJson(job.id, "trial-feedback-record.json");
  assert(recordArtifact.id === feedback.record.id, "record artifact id mismatch");
  assert(recordArtifact.photoAttached === true, "record should preserve photoAttached");
  assert(!("photoUrl" in recordArtifact), "record artifact must not store photo data URLs");

  const logArtifact = await getArtifactJson(job.id, "trial-feedback-log.json");
  assert(logArtifact.records?.some((record) => record.id === feedback.record.id), "log artifact missing record");
  const optimizationArtifact = await getArtifactJson(job.id, "process-optimization-plan.json");
  assert(optimizationArtifact.actions?.some((action) => action.id === "under-cut-detail-loss"), "optimization artifact missing under-cut action");
  assert(optimizationArtifact.nextRunProfile?.settingsPatch?.stepoverMm, "optimization artifact should suggest stepover patch");
  const dossierArtifact = await getArtifactJson(job.id, "production-evidence-dossier.json");
  assert(dossierArtifact.evidenceItems?.some((item) => item.id === "trial-feedback" && item.summary.includes("1 条")), "dossier missing feedback evidence item");
  assert(dossierArtifact.missingEvidence?.some((item) => item.id === "process-optimization"), "dossier should still require process optimization review");
  const deliveryManifest = await getArtifactJson(job.id, "delivery-manifest.json");
  assert(deliveryManifest.files?.some((file) => file.filename === "trial-feedback-record.json" && file.downloadable), "delivery manifest should expose trial feedback record");
  assert(deliveryManifest.files?.some((file) => file.filename === "trial-feedback-log.json" && file.downloadable), "delivery manifest should expose trial feedback log");
  assert(deliveryManifest.files?.some((file) => file.filename === "process-optimization-plan.json" && file.downloadable), "delivery manifest should expose optimization plan");
  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  assert(packageIntegrity.files?.some((file) => file.filename === "trial-feedback-record.json" && file.sha256), "package integrity missing feedback record hash");
  assert(packageIntegrity.files?.some((file) => file.filename === "process-optimization-plan.json" && file.sha256), "package integrity missing optimization plan hash");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    recordId: feedback.record.id,
    recordCount: feedback.log.recordCount,
    recommendationCount: feedback.record.recommendations.length,
    optimizationActions: feedback.optimizationPlan.actions.length
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
