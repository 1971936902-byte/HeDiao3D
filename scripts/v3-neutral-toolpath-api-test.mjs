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

  const imported = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/neutral-toolpath`, {
    engine: "opencamlib",
    neutralToolpath: {
      schema: "hediao3d.neutral-toolpath.v1",
      engine: "opencamlib",
      synthetic: false,
      coordinate: {
        lengthAxis: "X",
        rotaryAxis: "Y",
        depthAxis: "Z",
        rotaryUnit: "degree"
      },
      estimatedMinutes: 1.5,
      points: [
        { x: -15, a: 0, z: 21.7, depth: 0.3 },
        { x: -7.5, a: 45, z: 21.45, depth: 0.55 },
        { x: 0, a: 90, z: 21.1, depth: 0.9 },
        { x: 7.5, a: 180, z: 21.35, depth: 0.65 },
        { x: 15, a: 270, z: 21.65, depth: 0.35 }
      ]
    }
  });
  assert(imported.ok === true, "neutral toolpath import should succeed");
  assert(imported.validation?.schema === "hediao3d.neutral-toolpath-import-validation.v1", "neutral import response missing validation report");
  assert(imported.validation.postprocessEligible === true, "valid neutral import should be postprocess eligible");
  assert(imported.validation.sourceBinding?.status === "bound", "neutral import should bind submitted/imported/postprocess artifacts");
  assert(imported.validation.sourceBinding.importedArtifact?.matchesSubmitted === true, "imported neutral artifact should match submitted payload hash");
  assert(imported.validation.sourceBinding.sourceSnapshot?.matchesPostprocessArtifact === true, "source snapshot should match postprocess neutral artifact hash");
  assert(imported.validation.machineFit?.schema === "hediao3d.neutral-toolpath-machine-fit.v1", "neutral import should include machine-fit report");
  assert(imported.validation.machineFit.targetMachine?.controllerClass === "3axis-controller-with-rotary-fixture", "machine-fit should identify rotary fixture controller class");
  assert(imported.validation.machineFit.targetMachine?.axisMapping?.includes("Y=旋转夹具"), "machine-fit should preserve Y rotary axis mapping");
  assert(imported.validation.machineFit.coverage?.rotarySpanDeg > 0, "machine-fit should compute rotary angle coverage");
  assert(imported.validation.machineFit.stockEnvelope?.safeLeftX > -19, "machine-fit should account for left hold/end transition");
  assert(imported.toolpathSummary?.source === "external-adapter", "toolpath summary should mark external adapter source");

  const rejectedSynthetic = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/neutral-toolpath`, {
    engine: "opencamlib",
    neutralToolpath: {
      schema: "hediao3d.neutral-toolpath.v1",
      engine: "opencamlib",
      synthetic: true,
      coordinate: {
        lengthAxis: "X",
        rotaryAxis: "Y",
        depthAxis: "Z",
        rotaryUnit: "degree"
      },
      points: [
        { x: 0, a: 0, z: 21.8, depth: 0.2 }
      ]
    }
  }, false);
  assert(rejectedSynthetic.status === 400, `synthetic neutral import should be rejected, got ${rejectedSynthetic.status}`);
  assert(rejectedSynthetic.data.validation?.postprocessEligible === false, "rejected neutral import should include failed validation");
  assert(rejectedSynthetic.data.validation?.classification?.synthetic === true, "rejected neutral import should classify synthetic input");

  const gcode = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/toolpath.nc`);
  assert(gcode.includes("ROTARY_WRAP_AXIS=Y"), "postprocessed NC should declare Y rotary wrap axis");
  assert(/\bY-?\d/.test(gcode), "postprocessed NC should include Y-axis rotary moves");
  assert(!/\bA-?\d/.test(gcode), "Y-wrap postprocess should not emit A-axis moves");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  const summary = reloaded.result?.summary ?? {};
  assert(summary.toolpathSummary?.source === "external-adapter", "reloaded job should expose external-adapter summary");
  assert(summary.camHandoffQuality?.level !== "internal-fallback", "CAM handoff should no longer be internal fallback");
  assert(summary.camHandoffQuality?.sourceSnapshot?.kind === "neutral-toolpath", "CAM handoff should snapshot neutral toolpath");
  assert(summary.neutralToolpathImportValidation?.schema === "hediao3d.neutral-toolpath-import-validation.v1", "reloaded job should expose neutral import validation");
  assert(summary.neutralToolpathImportValidation.postprocessEligible === true, "reloaded neutral validation should be eligible");
  assert(summary.neutralToolpathImportValidation.sourceBinding?.status === "bound", "reloaded neutral validation should expose source binding");
  assert(summary.neutralToolpathImportValidation.machineFit?.targetMachine?.rotaryOutputAxis === "Y", "reloaded neutral validation should expose machine-fit rotary axis");
  assert(summary.neutralToolpathImportValidation.machineFit?.riskCounts?.holdZonePointCount === 0, "sample neutral path should avoid hold zones");
  assert(summary.neutralToolpathImportValidation.sourceBinding?.postprocessArtifact?.sha256 === summary.toolpathSummary.externalSourceSnapshot.sha256, "neutral source binding should match toolpath source snapshot hash");
  assert(summary.productionUnlockMatrix?.rows?.some((row) => row.id === "neutral-toolpath-import-validation" && row.status === "pass"), "unlock matrix should include passing neutral import validation row");
  assert(summary.productionUnlockMatrix.rows.some((row) => row.id === "neutral-toolpath-import-validation" && String(row.summary).includes("sourceBinding=bound")), "unlock matrix neutral row should consume source binding");
  assert(summary.productionEvidenceDossier?.evidenceItems?.some((item) => item.id === "neutral-toolpath-import-validation" && item.status === "pass"), "evidence dossier should include passing neutral import validation item");
  assert(summary.productionEvidenceDossier.evidenceItems.some((item) => item.id === "neutral-toolpath-import-validation" && String(item.summary).includes("sourceBinding=bound")), "evidence dossier neutral item should consume source binding");
  assert(summary.deliveryManifest?.files?.some((file) => file.filename === "neutral-toolpath.json" && file.exists), "delivery manifest should include neutral-toolpath.json");
  assert(summary.deliveryManifest?.files?.some((file) => file.filename === "imported-neutral-toolpath.json" && file.exists), "delivery manifest should include imported-neutral-toolpath.json");
  assert(summary.deliveryManifest?.files?.some((file) => file.filename === "neutral-toolpath-import-validation.json" && file.exists), "delivery manifest should include neutral import validation");
  assert(summary.packageIntegrity?.files?.some((file) => file.filename === "neutral-toolpath.json" && file.sha256), "package integrity should hash neutral-toolpath.json");
  assert(summary.packageIntegrity?.files?.some((file) => file.filename === "neutral-toolpath-import-validation.json" && file.sha256), "package integrity should hash neutral import validation");
  assert(summary.productionGate?.allowProductionNc !== true, "neutral import alone must not unlock production NC");
  assert(summary.productionGate?.checks?.neutralSourceBindingStatus === "bound", "production gate should expose bound neutral source status");

  const neutralArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/neutral-toolpath.json`);
  assert(neutralArtifact.importedFromApi === true, "neutral artifact should be marked as API import");
  assert(neutralArtifact.points?.length === 5, "neutral artifact should preserve source points");
  const validationArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/neutral-toolpath-import-validation.json`);
  assert(validationArtifact.sourceBinding?.sourceSnapshot?.matchesPostprocessArtifact === true, "validation artifact should preserve postprocess source binding");
  assert(validationArtifact.machineFit?.coverage?.xCoverageRatio > 0.5, "validation artifact should preserve machine-fit coverage");
  const adapterReport = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/adapter-report.json`);
  assert(adapterReport.metrics?.neutralToolpath?.sourceBinding?.status === "bound", "adapter report should preserve neutral source binding");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    points: summary.toolpathSummary.points,
    productionAllowed: summary.productionGate.allowProductionNc
  }, null, 2));
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

async function postJson(path, body, expectOk) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (expectOk !== false && !response.ok) throw new Error(data.error ?? `${response.status} ${path}`);
  return expectOk === false ? { status: response.status, data } : data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
