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

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewSha256 = createHash("sha256").update(previewText).digest("hex");
  const previewMotionProfile = createPreviewMotionProfile(previewText);
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const runPackage = JSON.parse(runPackageText);
  const runPackageSha256 = createHash("sha256").update(runPackageText).digest("hex");
  const resultTemplate = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-template.json`);
  assert(resultTemplate.inputs?.camoticsCliRunPackageSha256 === runPackageSha256, "CAMotics result template should bind to the current CLI run package hash");
  const completeImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(job.id, previewSha256, previewMotionProfile, runPackageSha256, undefined, runPackage.upstreamCamEvidence),
    localValidation: createLocalValidation(true),
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
  assert(completeImport.adapterReport?.localValidation?.productionEvidenceEligible === true, "adapter report should expose passing local validation");
  assert(completeImport.simulationEvidence?.level === "material-removal-verified", `expected material-removal-verified, got ${completeImport.simulationEvidence?.level}`);
  assert(completeImport.simulationEvidence?.productionUnlockEligible === true, "complete CAMotics import should be production evidence eligible");
  assert(completeImport.productionUnlockMatrix?.rows?.some((row) => row.id === "simulation-evidence" && row.status === "pass"), "unlock matrix should mark simulation row pass");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.simulation?.engine === "camotics", "job summary should expose camotics simulation");
  assert(reloaded.result.summary.productionGate.simulationEvidence.productionUnlockEligible === true, "job summary production gate should expose imported evidence");
  assert(reloaded.result.summary.productionEvidenceDossier?.evidenceItems?.some((item) => item.id === "material-removal-simulation" && item.status === "pass"), "job summary evidence dossier should expose passing material-removal item");
  assert(reloaded.result.summary.productionEvidenceDossier?.crossChecks?.camoticsInputIdentityStatus === "matched", "evidence dossier should expose matched CAMotics input identity");
  assert(reloaded.result.summary.productionEvidenceDossier?.crossChecks?.camoticsCliRunPackageBindingStatus === "matched", "evidence dossier should expose matched CAMotics CLI package binding");
  assert(reloaded.result.summary.productionEvidenceDossier?.crossChecks?.camoticsMotionConsistencyStatus === "matched", "evidence dossier should expose matched CAMotics motion consistency");
  assert(reloaded.result.summary.productionEvidenceDossier?.crossChecks?.camoticsMachineContextStatus === "matched", "evidence dossier should expose matched CAMotics machine context");
  assert(reloaded.result.summary.machiningPackageIndex?.camotics?.inputIdentityStatus === "matched", "package index should expose CAMotics input identity");
  assert(reloaded.result.summary.machiningPackageIndex?.camotics?.cliRunPackageBindingStatus === "matched", "package index should expose CAMotics CLI package binding");
  assert(reloaded.result.summary.machiningPackageIndex?.camotics?.motionConsistencyStatus === "matched", "package index should expose CAMotics motion consistency");
  assert(reloaded.result.summary.machiningPackageIndex?.camotics?.machineContextStatus === "matched", "package index should expose CAMotics machine context");
  assert(reloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "camotics-result.json" && file.exists), "delivery manifest should expose camotics result");
  assert(reloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "camotics-result-local-validation.json" && file.exists), "delivery manifest should expose local validation report");
  assert(reloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "camotics-result-import.json" && file.exists), "delivery manifest should expose CAMotics import audit");
  assert(reloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "camotics-result.json" && file.sha256), "package integrity should hash camotics result");
  assert(reloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "camotics-result-local-validation.json" && file.sha256), "package integrity should hash local validation report");
  assert(reloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "camotics-result-import.json" && file.sha256), "package integrity should hash CAMotics import audit");
  assert(reloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "next-action-checklist.md" && file.sha256), "package integrity should hash refreshed next action checklist");
  const resultArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result.json`);
  const localValidationArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-local-validation.json`);
  const importAuditArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-import.json`);
  const nextActionChecklist = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/next-action-checklist.md`);
  assert(localValidationArtifact.productionEvidenceEligible === true, "local validation artifact should preserve production evidence eligibility");
  assert(localValidationArtifact.importedVia === "api-camotics-result", "local validation artifact should record API import");
  assert(importAuditArtifact.schema === "hediao3d.camotics-result-import-audit.v1", "import audit schema mismatch");
  assert(importAuditArtifact.binding?.preferredGcode?.status === "matched", "import audit should bind preferred G-code hash");
  assert(importAuditArtifact.binding?.camoticsCliRunPackage?.status === "matched", "import audit should bind CAMotics run package hash");
  assert(importAuditArtifact.localValidation?.productionEvidenceEligible === true, "import audit should summarize local validation");
  assert(nextActionChecklist.includes("## 证据状态"), "next action checklist should be refreshed with evidence status");
  assert(nextActionChecklist.includes("仿真证据: material-removal-verified"), "next action checklist should show imported CAMotics evidence level");
  assert(resultArtifact.evidenceQuality?.inputIdentity?.status === "matched", "camotics result input identity should match");
  assert(resultArtifact.evidenceQuality?.inputIdentity?.job?.status === "matched", "camotics result should bind to current job id");
  assert(resultArtifact.evidenceQuality?.inputIdentity?.cliRunPackage?.status === "matched", "camotics result should bind to current CLI run package");
  assert(["matched", "not-required"].includes(resultArtifact.evidenceQuality?.upstreamCamEvidence?.status), "camotics result should expose upstream CAM evidence binding status");
  assert(resultArtifact.evidenceQuality?.motionConsistency?.status === "matched", "camotics result motion profile should match");
  assert(resultArtifact.evidenceQuality?.machineContext?.status === "matched", "camotics result machine context should match");
  assert(resultArtifact.artifactEvidence?.files?.screenshot?.sha256, "camotics result should hash screenshot artifact");
  assert(resultArtifact.artifactEvidence?.files?.materialMesh?.sha256, "camotics result should hash material mesh artifact");

  const zipResultText = JSON.stringify(createCamoticsResult(job.id, previewSha256, previewMotionProfile, runPackageSha256, undefined, runPackage.upstreamCamEvidence), null, 2);
  const zipLocalValidationText = JSON.stringify(createLocalValidation(true), null, 2);
  const zipScreenshotText = "zip-fixture-camotics-png";
  const zipMaterialText = "solid zip_material\nendsolid zip_material\n";
  const zipImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": zipResultText,
      "camotics-result-local-validation.json": zipLocalValidationText,
      "camotics-result-bundle-manifest.json": JSON.stringify(createBundleManifest({
        jobId: job.id,
        preferredGcodeSha256: previewSha256,
        motionProfile: previewMotionProfile,
        runPackageSha256,
        files: {
          "camotics-result.json": zipResultText,
          "camotics-result-local-validation.json": zipLocalValidationText,
          "camotics-preview.png": zipScreenshotText,
          "camotics-material-removal.stl": zipMaterialText
        }
      }), null, 2),
      "camotics-preview.png": zipScreenshotText,
      "camotics-material-removal.stl": zipMaterialText
    })
  });
  assert(zipImport.ok === true, "zip import should succeed");
  assert(zipImport.adapterReport?.importBundle?.zipBundle === "imported-camotics-result-bundle.zip", "zip import should preserve source bundle artifact");
  assert(zipImport.adapterReport?.importBundle?.importAudit === "camotics-result-import.json", "zip import should expose import audit artifact");
  assert(zipImport.adapterReport?.localValidation?.productionEvidenceEligible === true, "zip import should expose local validation");
  assert(zipImport.simulationEvidence?.productionUnlockEligible === true, "zip import should remain production evidence eligible");
  const zipReloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(zipReloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "imported-camotics-result-bundle.zip" && file.exists), "delivery manifest should expose imported CAMotics zip bundle");
  assert(zipReloaded.result.summary.deliveryManifest.files?.some((file) => file.filename === "camotics-result-import.json" && file.exists), "delivery manifest should keep exposing CAMotics import audit after zip import");
  assert(zipReloaded.result.summary.packageIntegrity.files?.some((file) => file.filename === "imported-camotics-result-bundle.zip" && file.sha256), "package integrity should hash imported CAMotics zip bundle");
  const zipImportAuditArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-import.json`);
  assert(zipImportAuditArtifact.zipBundle === "imported-camotics-result-bundle.zip", "zip import audit should record source bundle");
  assert(zipImportAuditArtifact.zipEntries?.some((entry) => /camotics-result\.json$/.test(entry.name)), "zip import audit should record result entry");
  assert(zipImportAuditArtifact.zipManifest?.schema === "hediao3d.camotics-result-bundle-manifest.v1", "zip import audit should record result bundle manifest");
  assert(zipImportAuditArtifact.zipManifest?.jobId === job.id, "zip import audit should expose manifest job id");
  assert(zipImportAuditArtifact.zipManifest?.safetyLocks?.productionUnlockFromBundle === false, "zip manifest should keep production unlock locked");
  assert(zipImportAuditArtifact.zipManifest?.integrity?.status === "matched", "zip manifest integrity should match for generated bundle");

  const badManifestImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": zipResultText,
      "camotics-result-local-validation.json": zipLocalValidationText,
      "camotics-result-bundle-manifest.json": JSON.stringify(createBundleManifest({
        jobId: job.id,
        preferredGcodeSha256: previewSha256,
        motionProfile: previewMotionProfile,
        runPackageSha256,
        files: {
          "camotics-result.json": "tampered-manifest-hash",
          "camotics-result-local-validation.json": zipLocalValidationText,
          "camotics-preview.png": zipScreenshotText
        }
      }), null, 2),
      "camotics-preview.png": zipScreenshotText,
      "camotics-material-removal.stl": zipMaterialText
    })
  });
  assert(badManifestImport.ok === true, "bad manifest import should still be recorded for audit");
  assert(badManifestImport.simulationEvidence?.productionUnlockEligible === false, "bad manifest integrity must not be production eligible");
  const badManifestArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result.json`);
  assert(badManifestArtifact.evidenceQuality?.missing?.includes("bundleManifestIntegrity"), "bad manifest should become evidence quality missing item");
  const badManifestAudit = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-import.json`);
  assert(badManifestAudit.zipManifest?.integrity?.status === "mismatch", "bad manifest audit should record mismatch");

  const mismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(job.id, "0".repeat(64), previewMotionProfile, runPackageSha256, undefined, runPackage.upstreamCamEvidence),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(mismatchImport.ok === true, "mismatched import should complete as review evidence");
  assert(mismatchImport.simulationEvidence?.level === "material-removal-incomplete", `expected incomplete evidence, got ${mismatchImport.simulationEvidence?.level}`);
  assert(mismatchImport.simulationEvidence?.productionUnlockEligible === false, "hash mismatch must not be production eligible");

  const runPackageMismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(job.id, previewSha256, previewMotionProfile, "1".repeat(64), undefined, runPackage.upstreamCamEvidence),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(runPackageMismatchImport.ok === true, "run package mismatch import should complete as review evidence");
  assert(runPackageMismatchImport.simulationEvidence?.productionUnlockEligible === false, "run package hash mismatch must not be production eligible");
  assert(runPackageMismatchImport.productionEvidenceDossier.evidenceItems?.some((item) => item.id === "material-removal-simulation" && item.status !== "pass"), "run package mismatch must not pass material-removal evidence");

  const motionMismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(job.id, previewSha256, {
      ...previewMotionProfile,
      motionLineCount: Math.max(0, previewMotionProfile.motionLineCount - 100),
      zMin: previewMotionProfile.zMin + 0.5
    }, runPackageSha256, undefined, runPackage.upstreamCamEvidence),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(motionMismatchImport.ok === true, "motion mismatch import should complete as review evidence");
  assert(motionMismatchImport.simulationEvidence?.productionUnlockEligible === false, "motion mismatch must not be production eligible");

  const machineContextMismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult(job.id, previewSha256, previewMotionProfile, runPackageSha256, {
      ...previewMotionProfile.machineContext,
      rotaryWrapAxis: "X"
    }, runPackage.upstreamCamEvidence),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(machineContextMismatchImport.ok === true, "machine context mismatch import should complete as review evidence");
  assert(machineContextMismatchImport.simulationEvidence?.productionUnlockEligible === false, "machine context mismatch must not be production eligible");

  const jobMismatchImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    result: createCamoticsResult("wrong-job-id", previewSha256, previewMotionProfile, runPackageSha256, undefined, runPackage.upstreamCamEvidence),
    screenshotDataUrl: toDataUrl("fake-camotics-png"),
    materialMeshText: "solid material\nendsolid material\n"
  });
  assert(jobMismatchImport.ok === true, "job mismatch import should complete as review evidence");
  assert(jobMismatchImport.simulationEvidence?.productionUnlockEligible === false, "job mismatch must not be production eligible");
  const jobMismatchArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result.json`);
  assert(jobMismatchArtifact.evidenceQuality?.inputIdentity?.job?.status === "mismatch", "job mismatch should be reported in CAMotics evidence quality");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    completeEvidence: completeImport.simulationEvidence.level,
    mismatchEvidence: mismatchImport.simulationEvidence.level,
    runPackageMismatchEvidence: runPackageMismatchImport.simulationEvidence.level,
    motionMismatchEvidence: motionMismatchImport.simulationEvidence.level
  }, null, 2));
}

function createCamoticsResult(jobId, preferredGcodeSha256, motionProfile, runPackageSha256, machineContext = motionProfile.machineContext, upstreamCamEvidence = null) {
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId,
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "API-imported CAMotics material-removal result fixture.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      preferredGcodeSha256,
      camoticsCliRunPackage: "camotics-cli-run-package.json",
      camoticsCliRunPackageSha256: runPackageSha256,
      machineContext,
      upstreamCamEvidence
    },
    metrics: {
      motionLineCount: motionProfile.motionLineCount,
      zMin: motionProfile.zMin,
      zMax: motionProfile.zMax,
      materialRemovedMm3: 8.4
    }
  };
}

function createLocalValidation(ok) {
  return {
    schema: "hediao3d.camotics-result-local-validation.v1",
    createdAt: new Date().toISOString(),
    ok,
    productionEvidenceEligible: ok,
    resultPath: "camotics-result.json",
    checks: [
      { id: "result-file", ok: true, severity: "info", message: "fixture" },
      { id: "run-package-hash", ok, severity: ok ? "info" : "critical", message: "fixture" }
    ],
    missing: ok ? [] : ["run-package-hash"],
    summary: ok ? "CAMotics local validation passed: result is eligible to be imported as material-removal evidence." : "CAMotics local validation failed: run-package-hash"
  };
}

function createBundleManifest({ jobId, preferredGcodeSha256, motionProfile, runPackageSha256, files }) {
  return {
    schema: "hediao3d.camotics-result-bundle-manifest.v1",
    createdAt: new Date().toISOString(),
    generator: "v3-camotics-result-api-test",
    purpose: "Uploadable CAMotics fixture bundle for API import test.",
    jobId,
    result: {
      schema: "hediao3d.camotics-result.v1",
      synthetic: false,
      riskLevel: "ready",
      preferredGcodeSha256,
      camoticsCliRunPackageSha256: runPackageSha256,
      machineContext: motionProfile.machineContext
    },
    localValidation: {
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      missing: []
    },
    files: Object.entries(files).map(([filename, content]) => ({
      filename,
      role: filename === "camotics-result.json"
        ? "material-removal-result"
        : filename === "camotics-result-local-validation.json"
          ? "local-validation"
          : filename.endsWith(".stl")
            ? "material-removal-mesh"
            : "visual-evidence",
      sizeBytes: Buffer.from(String(content)).byteLength,
      sha256: createHash("sha256").update(String(content)).digest("hex")
    })),
    safetyLocks: {
      productionUnlockFromBundle: false,
      requiresServerImportAudit: true,
      requiresReadinessRegeneration: true,
      note: "Fixture bundle does not unlock production by itself."
    }
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

function toDataUrl(text) {
  return `data:application/octet-stream;base64,${Buffer.from(text).toString("base64")}`;
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
