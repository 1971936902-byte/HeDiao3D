#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? "/meshy-results/material01-meshy.glb";
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);

const baseSettings = {
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
  meshU: 90,
  meshV: 60,
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
  const reviewCase = await runCase({ ...baseSettings, maxCutDepth: 0.45 }, "review");
  assert(reviewCase.report.level === "review", `expected review manufacturing report, got ${reviewCase.report.level}`);
  assert(reviewCase.report.checks.some((item) => item.id === "max-cut-depth" && item.status === "review"), "0.45mm olive-core cut should be a material review item");
  assert(reviewCase.gate.checks?.manufacturingSetupLevel === "review", "production gate should expose manufacturing review level");
  assert(reviewCase.gate.allowTrialNc === true, "review manufacturing setup should still allow trial NC when no blockers exist");
  assert(reviewCase.manifest.files?.some((file) => file.filename === "manufacturing-setup-report.json"), "delivery manifest missing manufacturing setup report");
  assert(reviewCase.packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "manufacturing-setup-report.json"), "package index readFirst missing manufacturing setup report");
  assert(reviewCase.unlockMatrix.rows?.some((row) => row.id === "manufacturing-setup" && row.status === "review"), "unlock matrix should contain manufacturing setup review row");
  assert(reviewCase.dossier.evidenceItems?.some((item) => item.id === "manufacturing-setup" && item.status === "review"), "evidence dossier should contain manufacturing setup review item");

  const blockedCase = await runCase({ ...baseSettings, maxCutDepth: 0.7 }, "blocked");
  assert(blockedCase.report.level === "critical", `expected critical manufacturing report, got ${blockedCase.report.level}`);
  assert(blockedCase.report.checks.some((item) => item.id === "max-cut-depth" && item.status === "critical"), "0.70mm olive-core cut should be critical");
  assert(blockedCase.gate.level === "blocked", `unsafe manufacturing setup should block production gate, got ${blockedCase.gate.level}`);
  assert(blockedCase.gate.allowTrialNc === false, "critical manufacturing setup should block trial NC");
  assert(blockedCase.gate.blockers?.some((item) => item.includes("制造参数")), "production gate blockers should name manufacturing setup");
  assert(blockedCase.unlockMatrix.rows?.some((row) => row.id === "manufacturing-setup" && row.status === "block"), "unlock matrix should contain manufacturing setup block row");

  console.log(JSON.stringify({
    ok: true,
    reviewJobId: reviewCase.job.id,
    blockedJobId: blockedCase.job.id,
    reviewLevel: reviewCase.report.level,
    blockedLevel: blockedCase.report.level,
    reviewGate: reviewCase.gate.level,
    blockedGate: blockedCase.gate.level
  }, null, 2));
}

async function runCase(settings, label) {
  const startedAt = Date.now();
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `${label} job did not complete: ${job.status}`);
  return {
    job,
    report: await getArtifactJson(job.id, "manufacturing-setup-report.json"),
    gate: await getArtifactJson(job.id, "production-gate.json"),
    manifest: await getArtifactJson(job.id, "delivery-manifest.json"),
    packageIndex: await getArtifactJson(job.id, "machining-package-index.json"),
    unlockMatrix: await getArtifactJson(job.id, "production-unlock-matrix.json"),
    dossier: await getArtifactJson(job.id, "production-evidence-dossier.json")
  };
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (["completed", "failed", "canceled"].includes(job.status)) return job;
    await sleep(500);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms`);
}

async function getArtifactJson(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${data.error ?? ""}`);
  return data;
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
