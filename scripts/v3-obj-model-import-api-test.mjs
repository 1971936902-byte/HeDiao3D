const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: 15,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: 1.0,
  reliefAngleDeg: 360,
  contrast: 1.2,
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
  stepoverDeg: 12,
  stepoverMm: 0.5,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "x",
  meshAxisReverse: false,
  maxCutDepth: 0.35,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  await getJson("/api/health");
  const imported = await postJson("/api/mesh/import", {
    filename: "obj-backend-cam-fixture.obj",
    dataUrl: `data:model/obj;base64,${Buffer.from(createObjFixture(), "utf8").toString("base64")}`
  });
  assert(imported.format === "obj", `expected obj import format, got ${imported.format}`);
  assert(/\.obj$/i.test(imported.camModelUrl), `camModelUrl should point to OBJ, got ${imported.camModelUrl}`);

  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl: imported.camModelUrl,
    settings,
    engine: "internal-mesh-cam"
  });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.result?.toolpath?.points?.length > 0, "OBJ-backed job should produce toolpath points");
  assert(job.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "toolpath.nc"), "delivery manifest should include toolpath.nc");

  const toolpath = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/toolpath.nc`);
  assert(toolpath.includes("POST: ROTARY WRAP Y-AXIS"), "OBJ-backed NC should use Y-axis rotary wrap postprocessor");
  assert(toolpath.includes("ROTARY_WRAP_AXIS=Y"), "OBJ-backed NC should declare Y rotary wrap axis");

  console.log(JSON.stringify({
    ok: true,
    modelUrl: imported.camModelUrl,
    jobId: job.id,
    points: job.result.summary.points,
    postProcessor: job.result.summary.postProcessorName
  }, null, 2));
}

function createObjFixture() {
  return [
    "# HeDiao3D OBJ backend CAM fixture",
    "v -1.0 -0.55 -0.65",
    "v 1.0 -0.55 -0.65",
    "v 1.0 0.55 -0.65",
    "v -1.0 0.55 -0.65",
    "v -1.0 -0.55 0.65",
    "v 1.0 -0.55 0.65",
    "v 1.0 0.55 0.65",
    "v -1.0 0.55 0.65",
    "v 0.0 0.0 1.05",
    "f 1 2 3 4",
    "f 5 8 7 6",
    "f 1 5 6 2",
    "f 2 6 7 3",
    "f 3 7 8 4",
    "f 4 8 5 1",
    "f 5 9 6",
    "f 6 9 7",
    "f 7 9 8",
    "f 8 9 5",
    ""
  ].join("\n");
}

async function waitForJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (["completed", "failed", "canceled"].includes(job.status)) return job;
    await delay(500);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
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
