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
  await getJson("/api/health");

  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "auto"
  });
  assert(created.id, "created job missing id");

  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const analysis = await getArtifactJson(job.id, "nc-static-analysis.json");
  assert(analysis.level === "ready", `NC static analysis expected ready, got ${analysis.level}: ${analysis.summary}`);
  assert(Array.isArray(analysis.programs) && analysis.programs.length === 4, "expected four NC programs in static analysis");

  const machine = findProgram(analysis, "toolpath.nc");
  assert(machine.role === "machine", "toolpath.nc role mismatch");
  assert(machine.markers.hasRotaryHeader, "toolpath.nc missing ROTARY_WRAP_AXIS marker");
  assert(machine.markers.hasLengthAxisHeader, "toolpath.nc missing LENGTH_AXIS marker");
  assert(machine.axisCounts.x > 0, "toolpath.nc missing X length motion");
  assert(machine.axisCounts.y > 0, "toolpath.nc missing Y rotary-wrap motion");
  assert(machine.axisCounts.a === 0, "wrapY toolpath should not emit A axis");
  assert(machine.axisCounts.z > 0, "toolpath.nc missing Z motion");
  assert(machine.markers.spindleStartCount > 0, "toolpath.nc missing spindle start");
  assert(machine.markers.hasPreviewOnlyMarker === false, "toolpath.nc must not be marked as preview only");

  const airRun = findProgram(analysis, "air-run.nc");
  assert(airRun.role === "air-run", "air-run.nc role mismatch");
  assert(airRun.markers.hasAirRunMarker, "air-run.nc missing AIR RUN marker");
  assert(airRun.markers.spindleStartCount === 0, "air-run.nc must not start spindle");
  assert(Math.abs(Number(airRun.zRange.min) - settings.safeZ) < 0.001, `air-run.nc min Z expected ${settings.safeZ}, got ${airRun.zRange.min}`);
  assert(Math.abs(Number(airRun.zRange.max) - settings.safeZ) < 0.001, `air-run.nc max Z expected ${settings.safeZ}, got ${airRun.zRange.max}`);

  const rotaryCalibration = findProgram(analysis, "rotary-calibration-airrun.nc");
  assert(rotaryCalibration.role === "air-run", "rotary calibration role mismatch");
  assert(rotaryCalibration.markers.hasAirRunMarker, "rotary calibration missing AIR RUN marker");
  assert(rotaryCalibration.markers.hasRotaryHeader, "rotary calibration missing ROTARY_WRAP_AXIS marker");
  assert(rotaryCalibration.axisCounts.y > 0, "rotary calibration should move Y rotary fixture");
  assert(rotaryCalibration.axisCounts.a === 0, "Y rotary calibration should not emit A axis");
  assert(rotaryCalibration.markers.spindleStartCount === 0, "rotary calibration must not start spindle");
  assert(Math.abs(Number(rotaryCalibration.zRange.min) - settings.safeZ) < 0.001, `rotary calibration min Z expected ${settings.safeZ}, got ${rotaryCalibration.zRange.min}`);
  assert(Math.abs(Number(rotaryCalibration.zRange.max) - settings.safeZ) < 0.001, `rotary calibration max Z expected ${settings.safeZ}, got ${rotaryCalibration.zRange.max}`);

  const rotaryCalibrationText = await getArtifactText(job.id, "rotary-calibration-airrun.nc");
  assert(rotaryCalibrationText.includes("ROTARY CALIBRATION"), "rotary calibration header missing purpose");
  assert(rotaryCalibrationText.includes("calibration 360.0 deg"), "rotary calibration should include 360 degree move");

  const preview = findProgram(analysis, "camotics-preview.nc");
  assert(preview.role === "simulation-only", "camotics-preview.nc role mismatch");
  assert(preview.markers.hasPreviewOnlyMarker, "camotics-preview.nc missing NOT FOR MACHINE marker");
  assert(preview.markers.spindleStartCount === 0, "camotics-preview.nc must not start spindle");
  assert(Number(preview.zRange.min) < 0, "camotics-preview.nc should use negative cutting Z");
  assert(Number(preview.zRange.max) > 0, "camotics-preview.nc should include positive safe Z");

  const previewText = await getArtifactText(job.id, "camotics-preview.nc");
  assert(previewText.includes("CAMOTICS PREVIEW ONLY - not for machine"), "camotics-preview.nc header missing not-for-machine warning");
  assert(previewText.includes("Coordinate: X/Y unwrapped stock"), "camotics-preview.nc header missing unwrapped coordinate note");

  const camoticsPlan = await getArtifactJson(job.id, "camotics-simulation-plan.json");
  assert(camoticsPlan.schema === "hediao3d.camotics-simulation-plan.v1", "CAMotics simulation plan schema mismatch");
  assert(camoticsPlan.inputs?.preferredGcode === "camotics-preview.nc", "CAMotics plan preferred G-code mismatch");
  assert(camoticsPlan.projectTemplate?.schema === "hediao3d.camotics-project-template.v1", "CAMotics project template missing from plan");
  const camoticsCliPlan = await getArtifactJson(job.id, "camotics-cli-execution-plan.json");
  assert(camoticsCliPlan.schema === "hediao3d.camotics-cli-execution-plan.v1", "CAMotics CLI execution plan schema mismatch");
  assert(camoticsCliPlan.inputs?.preferredGcode === "camotics-preview.nc", "CAMotics CLI plan preferred G-code mismatch");
  assert(camoticsCliPlan.safetyLocks?.productionUnlockFromCliPlan === false, "CAMotics CLI plan must not unlock production by itself");
  assert(camoticsCliPlan.resultContract?.requiredFields?.includes("inputs.preferredGcodeSha256"), "CAMotics CLI plan should require input hash");
  assert(camoticsCliPlan.commandCandidates?.some((command) => command.id === "cli-wrapper"), "CAMotics CLI plan should include wrapper handoff command");

  const rotaryWrapPreview = await getArtifactJson(job.id, "rotary-wrap-preview-report.json");
  assert(rotaryWrapPreview.schema === "hediao3d.rotary-wrap-preview-report.v1", "rotary wrap preview report schema mismatch");
  assert(rotaryWrapPreview.coordinateMapping?.rotaryAxis === "Y", "rotary wrap preview should use Y output axis");
  assert(rotaryWrapPreview.coordinateMapping?.rotaryOutputMode === "linearized-rotary-axis", "Y wrap preview should be linearized");
  assert(rotaryWrapPreview.coordinateMapping?.expectedLinearSpanMm === settings.rotaryWrapPerRevolutionMm, "360 degree wrap should equal one wrap revolution distance");
  assert(rotaryWrapPreview.metrics?.machineCoverage >= 0.99, `machine rotary coverage should be near full, got ${rotaryWrapPreview.metrics?.machineCoverage}`);
  assert(rotaryWrapPreview.metrics?.pointCoverage >= 0.99, `point rotary coverage should be near full, got ${rotaryWrapPreview.metrics?.pointCoverage}`);
  assert(rotaryWrapPreview.metrics?.linearizationErrorRate <= 0.01, `linearization error should be low, got ${rotaryWrapPreview.metrics?.linearizationErrorRate}`);
  assert(rotaryWrapPreview.axisRanges?.machineNc?.y?.span >= settings.rotaryWrapPerRevolutionMm - 0.01, "machine NC Y span should cover one rotary revolution");
  assert(rotaryWrapPreview.axisRanges?.machineNc?.a?.count === 0, "wrapY machine NC should not contain A axis values");
  assert(rotaryWrapPreview.axisRanges?.camoticsPreviewNc?.z?.min < 0, "CAMotics preview should include negative cutting Z");

  const postprocessTrace = await getArtifactJson(job.id, "postprocess-trace-report.json");
  assert(postprocessTrace.schema === "hediao3d.postprocess-trace-report.v1", "postprocess trace schema mismatch");
  assert(postprocessTrace.level === "ready", `postprocess trace expected ready, got ${postprocessTrace.level}: ${postprocessTrace.summary}`);
  assert(postprocessTrace.coordinateMapping?.rotaryAxis === "Y", "postprocess trace should use Y rotary axis");
  assert(postprocessTrace.coordinateMapping?.rotaryOutputMode === "linearized-rotary-axis", "postprocess trace should describe Y as linearized rotary");
  assert(postprocessTrace.machineNc?.cuttingMoveCount === postprocessTrace.source?.pointCount, "postprocess trace move count should match source points");
  assert(postprocessTrace.metrics?.fitRate >= 0.999, `postprocess trace fit rate too low: ${postprocessTrace.metrics?.fitRate}`);
  assert(postprocessTrace.metrics?.missingMoves === 0, "postprocess trace should not miss source moves");
  assert(postprocessTrace.metrics?.extraMoves === 0, "postprocess trace should not include extra cutting moves");
  assert((postprocessTrace.metrics?.maxAbs?.lengthMm ?? 1) <= 0.01, "postprocess trace length deviation too high");
  assert((postprocessTrace.metrics?.maxAbs?.rotaryMachine ?? 1) <= 0.01, "postprocess trace rotary deviation too high");
  assert((postprocessTrace.metrics?.maxAbs?.zMm ?? 1) <= 0.01, "postprocess trace Z deviation too high");

  const dialect = await getArtifactJson(job.id, "controller-dialect-report.json");
  assert(dialect.level === "ready", `controller dialect expected ready, got ${dialect.level}: ${dialect.summary}`);
  assert(dialect.dialect.profileArtifact === "machine-controller-profile.json", "controller dialect report should reference machine-controller-profile.json");
  const machineDialect = findProgram(dialect, "toolpath.nc");
  assert(machineDialect.unsupportedCommands.length === 0, `toolpath.nc has unsupported commands: ${machineDialect.unsupportedCommands.join(", ")}`);
  assert(machineDialect.unsupportedWords.length === 0, `toolpath.nc has unsupported words: ${machineDialect.unsupportedWords.join(", ")}`);
  assert((machineDialect.wordCounts?.Y ?? 0) > 0, "toolpath.nc dialect report missing Y motion");
  assert((machineDialect.wordCounts?.A ?? 0) === 0, "toolpath.nc dialect report should not contain A axis for wrapY");
  const rotaryDialect = findProgram(dialect, "rotary-calibration-airrun.nc");
  assert(rotaryDialect.unsupportedCommands.length === 0, `rotary calibration has unsupported commands: ${rotaryDialect.unsupportedCommands.join(", ")}`);
  assert(rotaryDialect.unsupportedWords.length === 0, `rotary calibration has unsupported words: ${rotaryDialect.unsupportedWords.join(", ")}`);

  const profile = await getArtifactJson(job.id, "machine-controller-profile.json");
  assert(profile.schema === "hediao3d.machine-controller-profile.v1", "machine controller profile schema mismatch");
  assert(profile.controllerClass === "3axis-controller-with-rotary-fixture", "machine controller profile class mismatch");
  assert(profile.axisMapping?.lengthAxis === "X", "machine controller profile should map X to length");
  assert(profile.axisMapping?.depthAxis === "Z", "machine controller profile should map Z to depth");
  assert(profile.rotary?.outputAxis === "Y", "machine controller profile should map Y to rotary fixture");
  assert(profile.rotary?.wrapPerRevolutionMm === settings.rotaryWrapPerRevolutionMm, "machine controller wrap distance mismatch");
  assert(profile.dialect?.allowedWords?.includes("Y"), "machine controller profile should allow Y word");
  assert(profile.dialect?.forbiddenWords?.includes("A"), "Y rotary machine profile should forbid A word");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.checks?.postprocessTraceLevel === "ready", "production gate should include ready postprocess trace level");
  assert(productionGate.checks?.postprocessTraceFitRate >= 0.999, "production gate should expose postprocess trace fit rate");

  const unlockMatrix = await getArtifactJson(job.id, "production-unlock-matrix.json");
  assert(unlockMatrix.rows?.some((row) => row.id === "postprocess-trace" && row.status === "pass"), "unlock matrix missing pass postprocess trace row");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.postprocessTrace?.level === "ready", "package index should expose postprocess trace summary");
  assert(packageIndex.productionEvidenceDossier?.crossChecks, "package index should expose production evidence cross checks");
  assert(packageIndex.productionEvidenceDossier.crossChecks.ncStaticReady === true, "package index cross checks should mark NC static analysis ready");
  assert(packageIndex.productionEvidenceDossier.crossChecks.controllerDialectReady === true, "package index cross checks should mark controller dialect ready");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "postprocess-trace-report.json"), "readFirst should include postprocess trace report");

  const manifest = await getArtifactJson(job.id, "delivery-manifest.json");
  assert(manifest.files?.some((file) => file.filename === "postprocess-trace-report.json" && file.downloadable === true), "delivery manifest missing postprocess trace report");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    level: analysis.level,
    dialect: dialect.level,
    postprocessTrace: postprocessTrace.level,
    machineControllerProfile: profile.id,
    rotaryWrapPreview: rotaryWrapPreview.level,
    machineAxes: machine.axisCounts,
    airRunZ: airRun.zRange,
    rotaryCalibrationZ: rotaryCalibration.zRange,
    previewZ: preview.zRange
  }, null, 2));
}

function findProgram(analysis, filename) {
  const program = analysis.programs.find((item) => item.filename === filename);
  assert(program, `missing ${filename} in NC static analysis`);
  return program;
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

async function getArtifactText(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const text = await response.text();
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${text}`);
  return text;
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
