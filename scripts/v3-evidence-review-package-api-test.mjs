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
  assert(job.result?.summary?.deliveryManifest?.files?.length > 0, "job missing delivery manifest");

  const evidencePackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/evidence-review-package`);
  assert((evidencePackage.contentType ?? "").includes("application/zip"), "evidence review package should be application/zip");
  assert(evidencePackage.bytes[0] === 0x50 && evidencePackage.bytes[1] === 0x4b, "evidence review package should be a ZIP file");
  assert(evidencePackage.bytes.length > 10_000, "evidence review package should contain real evidence files");

  const entries = readZipEntries(evidencePackage.bytes);
  const names = [...entries.keys()];
  assert(names.includes("hediao3d-v3-evidence/README-EVIDENCE-REVIEW.md"), "evidence package missing README");
  assert(names.includes("hediao3d-v3-evidence/evidence-review-manifest.json"), "evidence package missing manifest");
  assert(names.includes("hediao3d-v3-evidence/evidence/production-gate.json"), "evidence package missing production gate");
  assert(names.includes("hediao3d-v3-evidence/evidence/production-evidence-dossier.json"), "evidence package missing production evidence dossier");
  assert(names.includes("hediao3d-v3-evidence/evidence/package-integrity.json"), "evidence package missing package integrity");
  assert(names.includes("hediao3d-v3-evidence/evidence/postprocess-trace-report.json"), "evidence package missing postprocess trace report");
  assert(names.includes("hediao3d-v3-evidence/evidence/rotary-wrap-preview-report.json"), "evidence package missing rotary wrap preview report");
  assert(names.includes("hediao3d-v3-evidence/evidence/camotics-cli-execution-plan.json"), "evidence package missing CAMotics CLI execution plan");
  assert(!names.some((name) => name.endsWith("/toolpath.nc")), "evidence review package must not include machine NC");
  assert(!names.some((name) => name.endsWith("/air-run.nc")), "evidence review package must not include air-run NC");
  assert(!names.some((name) => name.endsWith("/rotary-calibration-airrun.nc")), "evidence review package must not include rotary calibration NC");

  const manifest = JSON.parse(entries.get("hediao3d-v3-evidence/evidence-review-manifest.json").toString("utf8"));
  assert(manifest.schema === "hediao3d.v3-evidence-review-package.v1", "manifest schema mismatch");
  assert(manifest.jobId === job.id, "manifest job id mismatch");
  assert(manifest.policy?.productionUseAllowed === false, "evidence package must not allow production use");
  assert(manifest.policy?.containsMachineNcForProduction === false, "evidence package must declare no production machine NC");
  assert(manifest.policy?.purpose === "evidence-review-only", "manifest purpose should be evidence-review-only");
  assert(manifest.runbookBoundary?.schema === "hediao3d.runbook-production-boundary.v1", "manifest should expose runbook production boundary");
  assert(manifest.runbookBoundary?.productionSafe === false, "evidence review manifest runbook boundary must keep production locked");
  assert(typeof manifest.runbookBoundary?.productionSafeReason === "string", "evidence review manifest should explain runbook production boundary");
  assert(manifest.files?.some((file) => file.filename === "production-gate.json" && /^[a-f0-9]{64}$/.test(file.sha256)), "manifest missing production gate hash");
  assert(manifest.files?.some((file) => file.filename === "package-integrity.json" && /^[a-f0-9]{64}$/.test(file.sha256)), "manifest missing package integrity hash");
  assert(manifest.missing?.includes("camotics-result.json"), "fresh job should show missing CAMotics result evidence");
  assert(manifest.productionEvidenceDossier?.missingEvidenceCount > 0, "manifest should expose production evidence gap count");
  assert(manifest.productionEvidenceDossier?.missingEvidenceTop?.some((item) => item.id === "material-removal-simulation" || item.id === "machine-acceptance"), "manifest should expose top production evidence gaps");
  assert(manifest.productionEvidenceDossier?.fieldEvidenceGaps?.some((item) => item.id === "machine-acceptance" || item.id === "trial-feedback"), "manifest should expose field evidence gaps");
  assert(manifest.productionEvidenceDossier?.productionReadinessAudit?.allowProductionPackage === false, "manifest should expose production readiness audit lock state");
  assert(manifest.productionEvidenceDossier?.productionReadinessAudit?.materialRemovalGate?.id === "material-removal-proof", "manifest should expose material-removal production audit gate");
  assert(Object.hasOwn(manifest.productionEvidenceDossier.productionReadinessAudit.materialRemovalGate, "residualProofCrossCheckStatus"), "manifest should expose material-removal residual proof cross-check status");
  assert(manifest.productionEvidenceDossier?.productionReadinessAudit?.airRunGate?.id === "air-run-proof", "manifest should expose air-run production audit gate");
  assert(manifest.productionEvidenceDossier?.productionReadinessAudit?.fieldPackageGate?.id === "field-package-proof", "manifest should expose field package production audit gate");
  assert(manifest.nextEvidence?.some((item) => item.includes("CAMotics Linux")), "manifest should guide CAMotics Linux evidence flow");

  const readme = entries.get("hediao3d-v3-evidence/README-EVIDENCE-REVIEW.md").toString("utf8");
  assert(readme.includes("HeDiao3D V3 证据审查包"), "README missing title");
  assert(readme.includes("不是安全试雕包，也不是正式生产包"), "README should state package boundary");
  assert(readme.includes("本包不应作为上机加工交付物"), "README should forbid machine delivery use");
  assert(readme.includes("camotics-result.json"), "README should list missing CAMotics result");
  assert(readme.includes("证据档案缺口"), "README should include production evidence gap section");
  assert(readme.includes("现场证据缺口"), "README should include field evidence gap section");
  assert(readme.includes("生产审计现场门禁"), "README should include production audit field gate section");
  assert(readme.includes("Runbook 审查边界"), "README should include runbook production boundary section");
  assert(readme.includes("productionSafe=false"), "README should preserve production locked runbook boundary");
  assert(readme.includes("材料去除/残料门禁:"), "README should expose material-removal gate summary");
  assert(readme.includes("proofCrossCheck="), "README should expose residual proof cross-check status");
  assert(readme.includes("离料空跑门禁:"), "README should expose air-run gate summary");
  assert(readme.includes("现场同包门禁:"), "README should expose field package binding gate summary");

  const lockedProductionPackage = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedProductionPackage.allowProductionNc === false, "production package must stay locked after evidence review download");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    zipBytes: evidencePackage.bytes.length,
    evidenceFiles: manifest.files.length,
    missingEvidence: manifest.missing.length,
    productionUseAllowed: manifest.policy.productionUseAllowed
  }, null, 2));
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await sleep(500);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms`);
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

async function getBinary(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(response.ok, `binary ${path} failed: ${response.status}`);
  return {
    bytes,
    contentType: response.headers.get("content-type")
  };
}

function readZipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const compression = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const fileNameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    assert((flags & 0x08) === 0, "ZIP data descriptor entries are not supported in this test");
    assert(compression === 0, "test ZIP reader only supports stored entries");
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
    entries.set(name, bytes.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
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
