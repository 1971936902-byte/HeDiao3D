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
  const startedAt = Date.now();
  const diagnostics = await getJson("/api/orchestrator/diagnostics");
  assert(diagnostics.level !== "critical", `diagnostics critical: ${diagnostics.summary}`);

  const engines = await getJson("/api/orchestrator/engines");
  assert(Array.isArray(engines.engines), "engines response missing engines[]");
  assert(engines.engines.some((engine) => engine.id === "internal-mesh-cam"), "internal mesh CAM engine missing");

  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  assert(created.id, "created job missing id");

  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.progress === 100, `job progress expected 100, got ${job.progress}`);
  assert(job.currentStage === "completed", `currentStage expected completed, got ${job.currentStage}`);
  assert(job.result?.summary?.points > 0, "job result has no toolpath points");
  assert(job.result?.summary?.productionGate?.level, "production gate missing");
  assert(job.result?.summary?.deliveryManifest?.files?.length > 0, "delivery manifest missing files");
  assert(job.result?.summary?.machineControllerProfile?.rotary?.outputAxis === "Y", "machine controller profile should use Y rotary output");
  assert(job.result?.summary?.machineAcceptanceChecklist?.schema === "hediao3d.machine-acceptance-checklist.v1", "machine acceptance checklist missing");
  assert(job.result.summary.machineAcceptanceChecklist.steps.some((step) => step.id === "air-run"), "machine acceptance checklist missing air-run step");
  assert(job.result?.summary?.packageIntegrity?.schema === "hediao3d.package-integrity.v1", "package integrity report missing");
  assert(job.result.summary.packageIntegrity.missingDownloadableCount === 0, "package integrity should not have missing downloadable files");
  assert(job.result?.summary?.toolSetupSheet?.schema === "hediao3d.tool-setup-sheet.v1", "tool setup sheet missing");
  assert(job.result.summary.toolSetupSheet.tool.angleDeg === 25, "tool setup sheet should capture 25deg V-bit angle");
  assert(job.result.summary.toolSetupSheet.tool.flatTipMm === 0.4, "tool setup sheet should capture flat tip");
  assert(job.result?.summary?.nativeCamReadiness?.schema === "hediao3d.native-cam-readiness.v1", "native CAM readiness report missing");
  assert(job.result?.summary?.ncStaticAnalysis?.level === "ready", `NC static analysis not ready: ${job.result?.summary?.ncStaticAnalysis?.summary ?? "missing"}`);
  assert(job.result?.summary?.controllerDialectReport?.level === "ready", `controller dialect report not ready: ${job.result?.summary?.controllerDialectReport?.summary ?? "missing"}`);
  assert(job.result?.summary?.camInputPlan?.schema === "hediao3d.cam-input-plan.v1", "CAM input plan schema missing");
  assert(job.result?.summary?.camInputPlan?.modelSelection?.schema === "hediao3d.cam-input-model-selection.v1", "CAM input model selection missing");
  assert(job.result?.summary?.camInputPlan?.modelSelection?.selectedModelId, "CAM input model selection did not select a model");
  assert(job.result?.summary?.camEngineSelection?.schema === "hediao3d.cam-engine-selection.v1", "CAM engine selection report missing");
  assert(job.result?.summary?.camEngineSelection?.selectedEngineName, "CAM engine selection missing selected engine name");

  const requiredArtifacts = [
    "job.json",
    "job-status.json",
    "mesh-quality.json",
    "repair-plan.json",
    "repair-execution.json",
    "cam-input-plan.json",
    "cam-engine-selection.json",
    "external-cam-recipe.json",
    "engine-diagnostics.json",
    "native-cam-readiness.json",
    "adapter-preflight.json",
    "toolpath.nc",
    "toolpath-summary.json",
    "tool-setup-sheet.json",
    "machine-controller-profile.json",
    "machine-acceptance-checklist.json",
    "nc-static-analysis.json",
    "controller-dialect-report.json",
    "simulation-summary.json",
    "camotics-input.json",
    "camotics-simulation-plan.json",
    "camotics-project-template.json",
    "camotics-run.md",
    "camotics-preview.nc",
    "air-run.nc",
    "production-gate.json",
    "postprocess-profile.json",
    "machining-package-index.json",
    "delivery-manifest.json",
    "package-integrity.json"
  ];
  for (const filename of requiredArtifacts) {
    const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(filename)}`);
    assert(response.ok, `artifact ${filename} failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength > 0, `artifact ${filename} is empty`);
  }

  const camInputPlan = await getArtifactJson(job.id, "cam-input-plan.json");
  assert(camInputPlan.modelSelection?.selectedModelPath === camInputPlan.selectedModelPath, "CAM input selected path mismatch");
  assert(camInputPlan.modelSelection?.candidates?.some((candidate) => candidate.selectedForCam), "CAM input model candidates missing selectedForCam");
  const externalCamRecipe = await getArtifactJson(job.id, "external-cam-recipe.json");
  assert(externalCamRecipe.model?.modelSelection?.selectedModelPath === camInputPlan.selectedModelPath, "external CAM recipe did not receive selected CAM input model");
  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(Array.isArray(packageIndex.filesByPurpose?.camInputs), "package index missing CAM input model group");
  assert(packageIndex.camEngineSelection?.selectedEngineName, "package index missing CAM engine selection summary");
  assert(packageIndex.machineAcceptance?.artifact === "machine-acceptance-checklist.json", "package index missing machine acceptance artifact");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "machine-acceptance-checklist.json"), "readFirst missing machine acceptance checklist");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "tool-setup-sheet.json"), "readFirst missing tool setup sheet");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "package-integrity.json"), "readFirst missing package integrity report");
  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  assert(packageIntegrity.files?.some((file) => file.filename === "toolpath.nc" && file.sha256), "package integrity missing toolpath hash");
  assert(packageIntegrity.files?.some((file) => file.filename === "tool-setup-sheet.json" && file.sha256), "package integrity missing tool setup hash");
  assert(packageIntegrity.files?.some((file) => file.filename === "package-integrity.json" && file.selfReference), "package integrity should mark self reference");
  assert(createV3SmokeReadmeProbe(job).includes("CAM选择"), "V3 package readme should include CAM engine selection");

  const list = await getJson("/api/orchestrator/jobs");
  assert(Array.isArray(list.jobs), "job list missing jobs[]");
  assert(list.jobs.some((item) => item.id === job.id), "completed job missing from history list");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    diagnostics: diagnostics.level,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    packageLevel: job.result.summary.productionGate.level,
    points: job.result.summary.points,
    elapsedMs: Date.now() - startedAt
  }, null, 2));
}

function createV3SmokeReadmeProbe(job) {
  const camInputPlan = job.result?.summary?.camInputPlan;
  const selection = camInputPlan?.modelSelection;
  return [
    `CAM输入模型: ${selection?.selectedModelId ?? camInputPlan?.selectedModelKind ?? "-"}`,
    `CAM模型角色: ${selection?.selectedModelRole ?? "-"}`,
    `CAM模型选择: ${selection?.selectionReason ?? camInputPlan?.summary ?? "-"}`,
    `CAM选择: ${job.result?.summary?.camEngineSelection?.selectedEngineName ?? "-"}`
  ].join("\n");
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
