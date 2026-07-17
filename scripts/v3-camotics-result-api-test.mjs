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
  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  assert(created.id, "created job missing id");
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewSha256 = createHash("sha256").update(previewText).digest("hex");
  const completeImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(previewSha256),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: [
      "solid camotics_material_removal",
      "  facet normal 0 0 1",
      "    outer loop",
      "      vertex 0 0 0",
      "      vertex 1 0 0",
      "      vertex 0 1 0",
      "    endloop",
      "  endfacet",
      "endsolid camotics_material_removal",
      ""
    ].join("\n")
  });
  assert(completeImport.ok === true, `complete import should succeed: ${completeImport.adapterReport?.error}`);
  assert(completeImport.simulationEvidence?.level === "material-removal-verified", `expected material-removal-verified, got ${completeImport.simulationEvidence?.level}`);
  assert(completeImport.simulationEvidence?.productionUnlockEligible === true, "complete CAMotics import should be production evidence eligible");
  assert(completeImport.productionUnlockMatrix?.rows?.some((row) => row.id === "simulation-evidence" && row.status === "pass"), "unlock matrix should mark simulation row pass");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.simulation?.engine === "camotics", "job summary should expose camotics simulation");
  assert(reloaded.result.summary.productionGate.simulationEvidence.productionUnlockEligible === true, "job summary production gate should expose imported evidence");
  assert(reloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "camotics-result.json" && file.exists), "delivery manifest should expose camotics result");
  assert(reloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "camotics-result.json" && file.sha256), "package integrity should hash camotics result");
  const resultArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result.json`);
  assert(resultArtifact.evidenceQuality?.inputIdentity?.status === "matched", "camotics result input identity should match");
  assert(resultArtifact.artifactEvidence?.files?.screenshot?.sha256, "camotics result should hash screenshot artifact");
  assert(resultArtifact.artifactEvidence?.files?.materialMesh?.sha256, "camotics result should hash material mesh artifact");

  const mismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult("0".repeat(64)),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(mismatchImport.ok === true, "mismatched import should complete as review evidence");
  assert(mismatchImport.simulationEvidence?.level === "material-removal-incomplete", `expected incomplete evidence, got ${mismatchImport.simulationEvidence?.level}`);
  assert(mismatchImport.simulationEvidence?.productionUnlockEligible === false, "hash mismatch must not be production eligible");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    completeEvidence: completeImport.simulationEvidence.level,
    mismatchEvidence: mismatchImport.simulationEvidence.level
  }, null, 2));
}

function createCamoticsResult(preferredGcodeSha256) {
  return {
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "API-imported CAMotics material-removal result fixture.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      preferredGcodeSha256
    },
    metrics: {
      motionLineCount: 18,
      zMin: -1.25,
      zMax: 22,
      materialRemovedMm3: 8.4
    }
  };
}

function toDataUrl(text) {
  return `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
