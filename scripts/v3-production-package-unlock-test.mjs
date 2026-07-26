#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  stepoverDeg: 3,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.16,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  await getJson("/api/health");

  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const lockedBeforeEvidence = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedBeforeEvidence.allowProductionNc === false, "production package must start locked");
  assert(lockedBeforeEvidence.operatorGuidance?.safeTrialPackageUrl?.includes(`/api/orchestrator/jobs/${job.id}/safe-trial-package`), "locked package should expose safe trial package URL before evidence is complete");
  assert(lockedBeforeEvidence.operatorGuidance?.evidenceReviewPackageUrl?.includes(`/api/orchestrator/jobs/${job.id}/evidence-review-package`), "locked package should expose evidence review package URL before evidence is complete");
  assert(lockedBeforeEvidence.operatorGuidance?.productionPackageUrl?.includes(`/api/orchestrator/jobs/${job.id}/production-package`), "locked package should expose production package recheck URL before evidence is complete");
  assert(lockedBeforeEvidence.operatorGuidance?.runbookBoundary?.schema === "hediao3d.runbook-production-boundary.v1", "locked package should expose runbook production boundary");
  assert(lockedBeforeEvidence.operatorGuidance?.runbookBoundary?.productionSafe === false, "locked package runbook boundary must not claim production safety");
  assert(typeof lockedBeforeEvidence.operatorGuidance?.runbookBoundary?.productionSafeReason === "string", "locked package runbook boundary should explain production lock");

  const wrongToolNeutral = createCandidateNeutral({
    tool: {
      toolProfileId: "vbit-3mm-20deg",
      diameterMm: 3,
      flatTipMm: 0,
      angleDeg: 20
    }
  });
  const wrongToolImport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/neutral-toolpath`, {
    sourceName: "production-package-wrong-tool-neutral.json",
    engine: "opencamlib",
    neutralToolpath: wrongToolNeutral
  });
  assert(wrongToolImport.validation?.cutterContactReport?.strictEvidence?.status === "review", "wrong tool contact report should fail strict evidence");
  assert(wrongToolImport.validation?.cutterContactReport?.strictEvidence?.checks?.some((check) => check.id === "contact-tool-diameter" && check.status === "fail"), "wrong tool should fail diameter check");
  assert(wrongToolImport.validation?.handoffEvidence?.classification !== "production-candidate", "wrong tool neutral must not classify as production-candidate");

  const candidateNeutral = createCandidateNeutral();
  const imported = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/neutral-toolpath`, {
    sourceName: "production-package-candidate-neutral.json",
    engine: "opencamlib",
    neutralToolpath: candidateNeutral
  });
  assert(imported.validation?.handoffEvidence?.classification === "production-candidate", "strict contact neutral should classify as production-candidate");
  assert(imported.validation?.cutterContactReport?.inputIdentityBinding?.status === "bound", "strict contact neutral should bind contact identity");

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewMotionProfile = createPreviewMotionProfile(previewText);
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const camoticsWithoutResidual = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, sha256(previewText), previewMotionProfile, sha256(runPackageText), { includeResidualValidation: false }), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(), null, 2),
      "camotics-preview.png": "production-package-unlock-fixture-png",
      "camotics-material-removal.stl": "solid production_package_unlock\nendsolid production_package_unlock\n"
    })
  });
  assert(camoticsWithoutResidual.simulationEvidence?.productionUnlockEligible === true, "CAMotics evidence should be material-removal eligible before residual closure");
  assert(camoticsWithoutResidual.simulationEvidence?.residualClosureReview?.productionResidualEvidenceReady === false, "CAMotics evidence without residualValidation must not close residual production evidence");

  const packageIntegrity = await getArtifactJson(job.id, "package-integrity.json");
  const downloadIntegrity = createDownloadIntegrityEvidence(packageIntegrity);
  const feedback = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/trial-feedback`, {
    id: "production-package-unlock-feedback",
    outcome: "success",
    phase: "soft-trial",
    machineName: "三轴控制器+Y轴旋转夹具",
    toolName: "4mm 25度平底尖刀",
    materialName: "软料试雕",
    actualMinutes: 1.2,
    issues: [],
    notes: "Production package unlock test: successful package-bound trial.",
    photoName: "production-package-soft-trial.jpg",
    photoAttached: true,
    downloadIntegrity,
    settings
  });
  assert(feedback.productionEvidenceDossier?.crossChecks?.trialFeedbackPassed === true, "trial feedback should pass and bind package integrity");

  const acceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "production-package-unlock-machine-acceptance",
    outcome: "success",
    operator: "V3 production package test",
    machineSerial: "desktop-3axis-rotary-y-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: true,
    downloadIntegrity,
    rotaryCalibration: {
      directionOk: true,
      measuredQuarterTurnDeg: 90,
      measuredHalfTurnDeg: 180,
      measuredFullTurnDeg: 360,
      backlashDeg: 0.2,
      measuredWrapPerRevolutionMm: settings.rotaryWrapPerRevolutionMm
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "Reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "Machine files verified against package-integrity.json." },
      { id: "camotics-preview", passed: true, evidenceNote: "Material-removal result reviewed." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration passed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Full dry run passed with spindle off." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial passed." }
    ],
    attachments: ["production-air-run-photo.jpg", "production-soft-trial-photo.jpg"]
  });
  assert(acceptance.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "field evidence without residualValidation must not allow production package");
  assert(acceptance.productionEvidenceDossier?.crossChecks?.fieldEvidenceProofChain?.schema === "hediao3d.field-evidence-proof-chain.v1", "field evidence should create a proof chain");
  assert(acceptance.productionEvidenceDossier.crossChecks.fieldEvidenceCompleteness?.status === "pass", "field evidence should require complete operator/photo/runtime evidence");
  assert(acceptance.productionEvidenceDossier.crossChecks.fieldEvidenceProofChain.fieldCompletenessStatus === "pass", "field proof chain should preserve field completeness status");
  assert(acceptance.productionEvidenceDossier.crossChecks.fieldEvidenceProofChain.status === "production-field-evidence-bound", "package-bound air-run/trial/acceptance should close field proof chain");
  assert(acceptance.productionEvidenceDossier.crossChecks.productionReadinessAudit?.gates?.some((gate) => gate.id === "field-package-proof" && gate.fieldEvidenceProofChain?.productionFieldEvidenceReady === true), "production audit should preserve ready field proof chain");
  assert(acceptance.productionEvidenceDossier?.status !== "production-evidence-complete", "dossier without residualValidation must stay incomplete");
  const lockedWithoutResidual = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  const lockedMaterialRemovalGate = lockedWithoutResidual.productionReadinessAudit?.gates?.find((gate) => gate.id === "material-removal-proof");
  assert(lockedMaterialRemovalGate?.status === "review", "locked production package should identify residual material-removal proof as review");
  assert(/残料|过切|residual|gouge/i.test(lockedMaterialRemovalGate?.summary ?? ""), "locked material-removal gate should mention residual/gouge evidence gap");
  assert(lockedWithoutResidual.operatorGuidance?.materialRemovalGate?.id === "material-removal-proof", "locked guidance should expose material-removal gate summary");
  assert(lockedWithoutResidual.operatorGuidance?.materialRemovalGate?.status === "review", "locked guidance material-removal gate should stay in review without residualValidation");
  assert(lockedWithoutResidual.operatorGuidance?.materialRemovalGate?.residualEvidenceRequired === true, "locked guidance should require residual/gouge evidence");
  assert(lockedWithoutResidual.operatorGuidance?.materialRemovalGate?.nextActions?.some((item) => /residualValidation|maxGouge|maxUndercut|残料|过切/i.test(item)), "locked guidance should tell operator to close residualValidation metrics");

  const camoticsWithUnprovenResidual = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, sha256(previewText), previewMotionProfile, sha256(runPackageText), { includeResidualValidation: true }), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(), null, 2),
      "camotics-preview.png": "production-package-unlock-fixture-png-with-unproven-residual",
      "camotics-material-removal.stl": "solid production_package_unlock_unproven_residual\nendsolid production_package_unlock_unproven_residual\n"
    })
  });
  assert(camoticsWithUnprovenResidual.simulationEvidence?.residualClosureReview?.productionResidualEvidenceReady === false, "result residualValidation without local proof must not close residual production evidence");
  assert(camoticsWithUnprovenResidual.simulationEvidence?.residualClosureReview?.residualValidation?.localValidationBinding?.status === "missing-local-residual-validation", "residual closure should expose missing local residual proof");
  assert(camoticsWithUnprovenResidual.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "unproven residualValidation must keep production package locked");
  const unprovenResidualGate = camoticsWithUnprovenResidual.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.gates?.find((gate) => gate.id === "material-removal-proof");
  assert(unprovenResidualGate?.residualLocalValidationBindingStatus === "missing-local-residual-validation", "production audit should expose missing local residual validation binding");
  assert(/local-validation|camotics-result-local-validation|残料校验/i.test(unprovenResidualGate?.summary ?? ""), "production audit should explain missing local residual validation proof");
  const lockedWithUnprovenResidual = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedWithUnprovenResidual.operatorGuidance?.materialRemovalGate?.residualLocalValidationBindingStatus === "missing-local-residual-validation", "locked guidance should expose residual local validation binding status");
  assert(lockedWithUnprovenResidual.operatorGuidance?.materialRemovalGate?.nextActions?.some((item) => /camotics-result-validate|local-validation|残料校验/i.test(item)), "locked guidance should tell operator to regenerate local residual proof");

  const residualValidation = createResidualValidation();
  const localResidualMissingBasis = {
    ...residualValidation,
    validationBasis: undefined
  };
  const camoticsWithMismatchedLocalResidual = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, sha256(previewText), previewMotionProfile, sha256(runPackageText), { residualValidation }), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(localResidualMissingBasis), null, 2),
      "camotics-preview.png": "production-package-unlock-fixture-png-with-mismatched-local-residual",
      "camotics-material-removal.stl": "solid production_package_unlock_mismatched_local_residual\nendsolid production_package_unlock_mismatched_local_residual\n"
    })
  });
  assert(camoticsWithMismatchedLocalResidual.simulationEvidence?.residualClosureReview?.productionResidualEvidenceReady === false, "local residual proof without matching basis must not close production residual evidence");
  assert(camoticsWithMismatchedLocalResidual.simulationEvidence?.residualClosureReview?.residualValidation?.localValidationBinding?.status === "local-residual-mismatch", "residual closure should expose local residual basis mismatch");
  assert(camoticsWithMismatchedLocalResidual.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "local residual mismatch must keep production package locked");
  const lockedWithMismatchedLocalResidual = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedWithMismatchedLocalResidual.operatorGuidance?.materialRemovalGate?.residualLocalValidationBindingStatus === "local-residual-mismatch", "locked guidance should expose residual local mismatch status");

  const camoticsWithResidual = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-result`, {
    resultZipDataUrl: toZipDataUrl({
      "camotics-result.json": JSON.stringify(createCamoticsResult(job.id, sha256(previewText), previewMotionProfile, sha256(runPackageText), { residualValidation }), null, 2),
      "camotics-result-local-validation.json": JSON.stringify(createLocalValidation(residualValidation), null, 2),
      "camotics-preview.png": "production-package-unlock-fixture-png-with-residual",
      "camotics-material-removal.stl": "solid production_package_unlock_residual\nendsolid production_package_unlock_residual\n"
    })
  });
  assert(camoticsWithResidual.simulationEvidence?.residualClosureReview?.productionResidualEvidenceReady === true, "CAMotics evidence with residualValidation should close residual production evidence");
  assert(camoticsWithResidual.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === true, "complete evidence with residualValidation should allow production package");
  assert(camoticsWithResidual.productionEvidenceDossier?.status === "production-evidence-complete", "dossier should become production-evidence-complete after residualValidation");

  const dossierAfterResidual = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const importedResidualProofChain = dossierAfterResidual.crossChecks?.productionReadinessAudit?.gates
    ?.find((gate) => gate.id === "material-removal-proof")
    ?.residualProofCrossCheck?.importAudit?.residualProofChain;
  assert(importedResidualProofChain?.schema === "hediao3d.camotics-residual-proof-chain.v1", "production audit should expose imported CAMotics residual proof chain");
  assert(dossierAfterResidual.crossChecks.productionReadinessAudit.gates
    ?.find((gate) => gate.id === "material-removal-proof")
    ?.residualProofCrossCheck?.status === "partial", "direct CAMotics import should be a partial proof cross-check before Linux upload report exists");

  const initialUploadReport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-evidence-upload-report`, {
    sourceName: "linux-cam-evidence-upload-report-initial-proof.json",
    report: createLinuxUploadReport({ residualProofChain: importedResidualProofChain })
  });
  assert(initialUploadReport.ok === true, "initial matching upload report fixture should import");
  const dossierAfterInitialProof = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const initialMaterialGate = dossierAfterInitialProof.crossChecks?.productionReadinessAudit?.gates
    ?.find((gate) => gate.id === "material-removal-proof");
  assert(initialMaterialGate?.residualProofCrossCheck?.status === "matched", "initial upload/import proof chains should match before production package download");
  assert(dossierAfterInitialProof.crossChecks.productionReadinessAudit.allowProductionPackage === true, "matching upload/import proof chains should keep production audit allowed");

  const productionPackage = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`);
  const packageBuffer = Buffer.from(await productionPackage.arrayBuffer());
  assert(productionPackage.ok, `production package should download after complete evidence, got ${productionPackage.status}`);
  assert((productionPackage.headers.get("content-type") ?? "").includes("application/zip"), "production package should be a zip");
  assert(packageBuffer.length > 1000, "production package zip should contain artifacts");
  const packageText = packageBuffer.toString("utf8");
  assert(packageText.includes("hediao3d.v3-production-package.v1"), "production package should include manifest schema");
  assert(packageText.includes("hediao3d.production-package-evidence-proofs.v1"), "production package manifest should include evidence proof schema");
  assert(packageText.includes('"complete": true'), "production package evidence proofs should be complete");
  assert(packageText.includes("toolpath.nc"), "production package should include toolpath.nc manifest entry");
  assert(packageText.includes("production-evidence-dossier.json"), "production package should include production evidence dossier");
  assert(packageText.includes("field-evidence-proof-chain.json"), "production package should include field proof chain");
  assert(packageText.includes("camotics-result-local-validation.json"), "production package should include CAMotics local residual proof");
  assert(packageText.includes("camotics-result-import.json"), "production package should include CAMotics import proof");
  assert(packageText.includes("linux-cam-evidence-upload-report.json"), "production package should include Linux upload proof");
  assert(packageText.includes("linux-cam-evidence-upload-report-import.json"), "production package should include Linux upload import proof");
  assert(packageText.includes("evidenceProofs.complete=true"), "production package README should expose complete evidence proofs");
  assert(!/hediao3d-v3-production\/[^/\0]+\/camotics-preview\.nc/.test(packageText), "production package must exclude simulation-only camotics-preview.nc file");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  const dossier = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const fieldProofChainArtifact = await getArtifactJson(job.id, "field-evidence-proof-chain.json");
  assert(reloaded.result?.summary?.productionEvidenceDossier?.status === "production-evidence-complete", "job summary should expose complete production evidence");
  assert(dossier.crossChecks?.fieldEvidencePackageBinding?.status === "matched", "field evidence should bind the same package hashes");
  assert(dossier.crossChecks?.fieldEvidenceProofChain?.status === "production-field-evidence-bound", "dossier should preserve production-bound field proof chain");
  assert(dossier.productionReadinessAudit?.fieldPackageGate?.fieldProofChainStatus === "production-field-evidence-bound", "dossier summary should expose field proof chain status");
  assert(fieldProofChainArtifact.schema === "hediao3d.field-evidence-proof-chain.v1", "field proof chain artifact schema mismatch");
  assert(fieldProofChainArtifact.status === "production-field-evidence-bound", "field proof chain artifact should preserve production-bound status");
  assert(fieldProofChainArtifact.sourceDossier === "production-evidence-dossier.json", "field proof chain artifact should reference source dossier");
  const deliveryManifestAfterComplete = await getArtifactJson(job.id, "delivery-manifest.json");
  const packageIntegrityAfterComplete = await getArtifactJson(job.id, "package-integrity.json");
  assert(deliveryManifestAfterComplete.files?.some((file) => file.filename === "field-evidence-proof-chain.json" && file.downloadable), "delivery manifest should expose field proof chain artifact");
  assert(packageIntegrityAfterComplete.files?.some((file) => file.filename === "field-evidence-proof-chain.json" && /^[a-f0-9]{64}$/.test(file.sha256 ?? "")), "package integrity should hash field proof chain artifact");

  const mismatchedUploadReport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-evidence-upload-report`, {
    sourceName: "linux-cam-evidence-upload-report-mismatched-proof.json",
    report: createLinuxUploadReport({
      residualProofChain: {
        ...importedResidualProofChain,
        status: "tampered-proof"
      }
    })
  });
  assert(mismatchedUploadReport.ok === true, "mismatched upload report fixture should import");
  const dossierAfterProofMismatch = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const mismatchedMaterialGate = dossierAfterProofMismatch.crossChecks?.productionReadinessAudit?.gates
    ?.find((gate) => gate.id === "material-removal-proof");
  assert(mismatchedMaterialGate?.residualProofCrossCheck?.status === "mismatch", "production audit should detect upload/import residual proof mismatch");
  assert(mismatchedMaterialGate.status === "review", "residual proof mismatch should keep material-removal gate in review");
  assert(dossierAfterProofMismatch.crossChecks.productionReadinessAudit.allowProductionPackage === false, "residual proof mismatch must relock production audit");
  const lockedWithProofMismatch = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(lockedWithProofMismatch.operatorGuidance?.materialRemovalGate?.residualProofCrossCheckStatus === "mismatch", "locked guidance should expose residual proof cross-check mismatch");

  const restoredUploadReport = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-evidence-upload-report`, {
    sourceName: "linux-cam-evidence-upload-report-restored-proof.json",
    report: createLinuxUploadReport({ residualProofChain: importedResidualProofChain })
  });
  assert(restoredUploadReport.ok === true, "restored upload report fixture should import");
  const dossierAfterProofRestore = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const restoredMaterialGate = dossierAfterProofRestore.crossChecks?.productionReadinessAudit?.gates
    ?.find((gate) => gate.id === "material-removal-proof");
  assert(restoredMaterialGate?.residualProofCrossCheck?.status === "matched", "matching upload report should restore residual proof cross-check");
  assert(dossierAfterProofRestore.crossChecks.productionReadinessAudit.allowProductionPackage === true, "matching upload/import proof chains should restore production audit");

  const manifestPath = join(process.cwd(), "public", "orchestrator-jobs", job.id, "delivery-manifest.json");
  const originalManifestText = readFileSync(manifestPath, "utf8");
  try {
    const staleManifest = JSON.parse(originalManifestText);
    staleManifest.files = staleManifest.files?.filter((file) => file.filename !== "field-evidence-proof-chain.json") ?? [];
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2));
    const missingProofPackage = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 409);
    assert(missingProofPackage.evidenceProofs?.complete === false, "production package should mark evidence proofs incomplete");
    assert(missingProofPackage.missingEvidenceProofs?.includes("field-evidence-proof-chain.json"), "production package should report missing field proof chain");
  } finally {
    writeFileSync(manifestPath, originalManifestText);
  }

  try {
    const staleManifest = JSON.parse(originalManifestText);
    staleManifest.files = staleManifest.files?.filter((file) => file.filename !== "linux-cam-evidence-upload-report.json") ?? [];
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2));
    const missingUploadProofPackage = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 409);
    assert(missingUploadProofPackage.evidenceProofs?.complete === false, "production package should mark upload proof incomplete");
    assert(missingUploadProofPackage.missingEvidenceProofs?.includes("linux-cam-evidence-upload-report.json"), "production package should report missing Linux upload proof");
  } finally {
    writeFileSync(manifestPath, originalManifestText);
  }

  const mismatchedLatestMachineIntegrity = {
    ...createDownloadIntegrityEvidence(packageIntegrity),
    files: createDownloadIntegrityEvidence(packageIntegrity).files.map((file) => file.filename === "air-run.nc"
      ? { ...file, sha256: "1".repeat(64), verified: true }
      : file)
  };
  const mismatchedLatestAcceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "production-package-unlock-machine-acceptance-latest-mismatch",
    outcome: "success",
    operator: "V3 production package test",
    machineSerial: "desktop-3axis-rotary-y-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: true,
    downloadIntegrity: mismatchedLatestMachineIntegrity,
    rotaryCalibration: {
      directionOk: true,
      measuredQuarterTurnDeg: 90,
      measuredHalfTurnDeg: 180,
      measuredFullTurnDeg: 360,
      backlashDeg: 0.2,
      measuredWrapPerRevolutionMm: settings.rotaryWrapPerRevolutionMm
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "Reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "Machine files were intentionally mismatched for regression." },
      { id: "camotics-preview", passed: true, evidenceNote: "Material-removal result reviewed." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration passed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Full dry run passed with spindle off." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial passed." }
    ]
  });
  assert(mismatchedLatestAcceptance.record.downloadIntegrity?.packageBinding?.status === "mismatch", "latest mismatched machine acceptance should record package binding mismatch");
  assert(mismatchedLatestAcceptance.productionEvidenceDossier?.crossChecks?.machineAcceptancePassed === false, "latest mismatched machine acceptance must revoke machine acceptance pass");
  assert(mismatchedLatestAcceptance.productionEvidenceDossier?.crossChecks?.airRunPassed === false, "latest mismatched air-run hash must revoke air-run proof");
  assert(mismatchedLatestAcceptance.productionEvidenceDossier?.crossChecks?.fieldEvidenceProofChain?.status === "field-evidence-binding-mismatch", "latest mismatched machine acceptance should mark field proof chain mismatched");
  assert(mismatchedLatestAcceptance.productionEvidenceDossier.crossChecks.fieldEvidenceProofChain.mismatchedFiles?.some((file) => file.filename === "air-run.nc"), "field proof chain should expose mismatched air-run file");
  assert(mismatchedLatestAcceptance.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "latest mismatched machine acceptance must relock production audit");
  const relockedAfterMachineMismatch = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(relockedAfterMachineMismatch.productionReadinessAudit?.allowProductionPackage === false, "production package must relock when latest machine acceptance is not package-bound");
  assert(relockedAfterMachineMismatch.productionReadinessAudit?.gates?.some((gate) => gate.id === "air-run-proof" && gate.status === "review"), "relocked production package should identify air-run proof as review");
  assert(relockedAfterMachineMismatch.productionReadinessAudit?.gates?.some((gate) => gate.id === "field-package-proof" && gate.status === "review"), "relocked production package should identify field package proof as review after machine mismatch");
  assert(relockedAfterMachineMismatch.operatorGuidance?.airRunGate?.packageBindingStatus === "mismatch", "locked guidance should expose mismatched air-run package binding");
  assert(relockedAfterMachineMismatch.operatorGuidance?.airRunGate?.failedChecks?.some((check) => check.id === "air-run-hash" && check.status === "failed"), "locked guidance should expose failed air-run hash check");
  assert(relockedAfterMachineMismatch.operatorGuidance?.fieldEvidenceGate?.machineBindingStatus === "mismatch", "locked guidance should expose machine acceptance binding mismatch");
  assert(relockedAfterMachineMismatch.operatorGuidance?.fieldEvidenceGate?.proofChainStatus === "field-evidence-binding-mismatch", "locked guidance should expose field proof chain mismatch");
  const closureAfterMachineMismatch = await getArtifactJson(job.id, "production-closure-audit.json");
  const airRunClosureStep = closureAfterMachineMismatch.steps?.find((step) => step.id === "air-run-and-rotary-calibration");
  const fieldClosureStep = closureAfterMachineMismatch.steps?.find((step) => step.id === "trial-feedback-and-acceptance");
  assert(airRunClosureStep?.airRunEvidence?.packageBindingStatus === "mismatch", "closure audit should preserve mismatched air-run package binding");
  assert(airRunClosureStep?.airRunEvidence?.checks?.some((check) => check.id === "air-run-hash" && check.status === "failed"), "closure audit should preserve failed air-run hash check");
  assert(fieldClosureStep?.fieldEvidencePackageBinding?.machineBindingStatus === "mismatch", "closure audit should preserve machine acceptance binding mismatch");
  const closureMarkdownAfterMachineMismatch = await getArtifactText(job.id, "production-closure-audit.md");
  assert(closureMarkdownAfterMachineMismatch.includes("离料空跑证据: failed / 同包绑定 mismatch"), "closure audit markdown should expose failed air-run binding");
  assert(closureMarkdownAfterMachineMismatch.includes("现场同包绑定: review / 机床验收 mismatch"), "closure audit markdown should expose field binding mismatch");

  const restoredAcceptance = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/machine-acceptance`, {
    id: "production-package-unlock-machine-acceptance-restored",
    outcome: "success",
    operator: "V3 production package test",
    machineSerial: "desktop-3axis-rotary-y-test",
    fixtureType: "三轴控制器 + Y轴旋转夹具",
    materialBatch: "soft-trial-block",
    programName: "toolpath.nc",
    airRunOk: true,
    softTrialOk: true,
    formalTrialOk: true,
    downloadIntegrity,
    rotaryCalibration: {
      directionOk: true,
      measuredQuarterTurnDeg: 90,
      measuredHalfTurnDeg: 180,
      measuredFullTurnDeg: 360,
      backlashDeg: 0.2,
      measuredWrapPerRevolutionMm: settings.rotaryWrapPerRevolutionMm
    },
    steps: [
      { id: "read-package", passed: true, evidenceNote: "Reports reviewed." },
      { id: "verify-download-integrity", passed: true, evidenceNote: "Machine files verified against package-integrity.json." },
      { id: "camotics-preview", passed: true, evidenceNote: "Material-removal result reviewed." },
      { id: "rotary-calibration-airrun", passed: true, evidenceNote: "Rotary calibration passed at safe Z." },
      { id: "air-run", passed: true, evidenceNote: "Full dry run passed with spindle off." },
      { id: "soft-material-trial", passed: true, evidenceNote: "Soft material trial passed." }
    ],
    attachments: ["production-air-run-restored-photo.jpg", "production-soft-trial-restored-photo.jpg"]
  });
  assert(restoredAcceptance.productionEvidenceDossier?.crossChecks?.machineAcceptancePassed === true, "restored package-bound machine acceptance should pass again");
  assert(restoredAcceptance.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === true, "restored package-bound machine acceptance should re-enable production audit before feedback mismatch test");

  const mismatchedLatestDownloadIntegrity = {
    ...createDownloadIntegrityEvidence(packageIntegrity),
    files: createDownloadIntegrityEvidence(packageIntegrity).files.map((file) => file.filename === "toolpath.nc"
      ? { ...file, sha256: "0".repeat(64), verified: true }
      : file)
  };
  const mismatchedLatestFeedback = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/trial-feedback`, {
    id: "production-package-unlock-feedback-latest-mismatch",
    outcome: "success",
    phase: "soft-trial",
    machineName: "三轴控制器+Y轴旋转夹具",
    toolName: "4mm 25度平底尖刀",
    materialName: "软料试雕",
    actualMinutes: 1.2,
    issues: [],
    notes: "Latest field feedback intentionally uses a mismatched toolpath hash and must relock production.",
    downloadIntegrity: mismatchedLatestDownloadIntegrity,
    settings
  });
  assert(mismatchedLatestFeedback.record.downloadIntegrity?.packageBinding?.status === "mismatch", "latest mismatched trial feedback should record package binding mismatch");
  assert(mismatchedLatestFeedback.productionEvidenceDossier?.crossChecks?.trialFeedbackPassed === false, "latest mismatched trial feedback must revoke trial feedback pass");
  assert(mismatchedLatestFeedback.productionEvidenceDossier?.crossChecks?.fieldEvidenceProofChain?.status === "field-evidence-binding-mismatch", "latest mismatched trial feedback should mark field proof chain mismatched");
  assert(mismatchedLatestFeedback.productionEvidenceDossier?.crossChecks?.productionReadinessAudit?.allowProductionPackage === false, "latest mismatched trial feedback must relock production audit");
  const relockedAfterLatestMismatch = await getJsonAllowingStatus(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/production-package`, 423);
  assert(relockedAfterLatestMismatch.productionReadinessAudit?.allowProductionPackage === false, "production package must relock when latest trial feedback is not package-bound");
  assert(relockedAfterLatestMismatch.productionReadinessAudit?.gates?.some((gate) => gate.id === "field-package-proof" && gate.status === "review"), "relocked production package should identify field package proof as review");
  assert(relockedAfterLatestMismatch.operatorGuidance?.fieldEvidenceGate?.trialBindingStatus === "mismatch", "locked guidance should expose trial feedback binding mismatch");
  assert(relockedAfterLatestMismatch.operatorGuidance?.fieldEvidenceGate?.mismatchedFiles?.some((file) => file.filename === "toolpath.nc" && file.issues.includes("trial-binding-not-matched")), "locked guidance should expose mismatched trial-feedback file");
  const dossierAfterMismatch = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const fieldProofChainAfterMismatch = await getArtifactJson(job.id, "field-evidence-proof-chain.json");
  assert(dossierAfterMismatch.status !== "production-evidence-complete", "latest mismatched field evidence should make dossier incomplete again");
  assert(fieldProofChainAfterMismatch.status === "field-evidence-binding-mismatch", "field proof chain artifact should refresh after latest field mismatch");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    residualGateLockedWithoutResidual: true,
    residualGateStatusWithoutResidual: lockedMaterialRemovalGate.status,
    dossierStatus: dossier.status,
    productionPackageBytes: packageBuffer.length,
    productionAllowed: true,
    productionRelockedAfterLatestMismatch: true
  }, null, 2));
}

function createCandidateNeutral(options = {}) {
  const points = [];
  for (const a of [0, 90, 180, 270, 360]) {
    for (let index = 0; index < 25; index += 1) {
      const t = index / 24;
      const x = -17 + t * 34;
      const wave = Math.sin(t * Math.PI) * (0.18 + 0.04 * Math.cos((a / 180) * Math.PI));
      const depth = 0.42 + wave;
      points.push({
        x: Number(x.toFixed(4)),
        a,
        z: Number((22 - depth).toFixed(4)),
        depth: Number(depth.toFixed(4))
      });
    }
  }
  const neutral = {
    schema: "hediao3d.neutral-toolpath.v1",
    engine: "opencamlib",
    synthetic: false,
    fixture: false,
    generatedByExternalCommand: true,
    coordinate: {
      lengthAxis: "X",
      rotaryAxis: "Y",
      depthAxis: "Z",
      rotaryUnit: "degree"
    },
    estimatedMinutes: 1.4,
    points
  };
  const neutralHash = sha256Json(neutral);
  const tool = options.tool ?? {
    toolProfileId: "vflat-4mm-25deg",
    diameterMm: 4,
    flatTipMm: 0.4,
    angleDeg: 25
  };
  neutral.cutterContactReport = {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    mode: "opencamlib-drop-cutter-contact",
    inputIdentity: {
      neutralToolpathWithoutContactReportSha256: neutralHash,
      sourceNeutralToolpathSha256: neutralHash
    },
    tool,
    contactSampling: {
      algorithm: "opencamlib-drop-cutter-contact",
      pointCount: neutral.points.length,
      contactPointCount: neutral.points.length,
      hitRate: 1,
      stepToCutterRatio: 0.18,
      pathCoverage: {
        schema: "hediao3d.opencamlib-path-dropcutter-coverage.v1",
        xCoverageRatio: 1,
        crossCoverageRatio: 1,
        sampledXSpanMm: 24,
        sampledCrossSpanMm: 360,
        modelXSpanMm: 24,
        modelCrossSpanMm: 360
      }
    },
    residualMaterial: {
      measured: true,
      validationBasis: "swept-volume-validated-fixture",
      maxGougeMm: 0.01,
      maxUndercutMm: 0.03,
      residualVolumeMm3: 0.4
    },
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    protectedZones: {
      schema: "hediao3d.opencamlib-protected-zones.v1",
      enabled: true,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      safeMinX: -12,
      safeMaxX: 12,
      sampledMinX: -12,
      sampledMaxX: 12,
      violationCount: 0,
      violations: []
    },
    quality: {
      level: "validated-contact",
      previewScaffold: false,
      postprocessEligible: true,
      productionCandidate: true,
      summary: "Production package unlock fixture representing strict OpenCAMLib cutter contact."
    }
  };
  return neutral;
}

function createCamoticsResult(jobId, preferredGcodeSha256, motionProfile, runPackageSha256, options = {}) {
  const includeResidualValidation = options.includeResidualValidation !== false;
  const residualValidation = options.residualValidation ?? (includeResidualValidation ? createResidualValidation() : null);
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId,
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "Production package unlock fixture material-removal result.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      preferredGcodeSha256,
      camoticsCliRunPackage: "camotics-cli-run-package.json",
      camoticsCliRunPackageSha256: runPackageSha256,
      machineContext: motionProfile.machineContext
    },
    metrics: {
      motionLineCount: motionProfile.motionLineCount,
      zMin: motionProfile.zMin,
      zMax: motionProfile.zMax,
      materialRemovedMm3: 8.8
    },
    ...(residualValidation ? { residualValidation } : {})
  };
}

function createResidualValidation() {
  return {
    schema: "hediao3d.residual-validation.v1",
    status: "ready",
    productionResidualEvidenceReady: true,
    present: true,
    measured: false,
    validationBasis: "swept-volume-validated",
    evidenceClass: "material-removal-validated",
    maxGougeMm: 0.012,
    maxUndercutMm: 0.035,
    maxResidualStockMm: 0.06,
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    checks: [
      { id: "residual-basis", status: "pass", summary: "Fixture residual basis is swept-volume validated." },
      { id: "max-gouge", status: "pass", summary: "Fixture gouge is within tolerance." },
      { id: "max-undercut", status: "pass", summary: "Fixture undercut is within tolerance." }
    ],
    topBlockers: [],
    summary: "Production package unlock fixture residual/gouge evidence is within tolerance."
  };
}

function createLocalValidation(residualValidation = null) {
  const residualProofChain = createResidualProofChainFixture(residualValidation);
  return {
    schema: "hediao3d.camotics-result-local-validation.v1",
    createdAt: new Date().toISOString(),
    ok: true,
    productionEvidenceEligible: true,
    ...(residualValidation ? { residualValidation } : {}),
    residualProofChain,
    checks: [
      { id: "result-file", ok: true, severity: "info", message: "fixture" },
      { id: "run-package-hash", ok: true, severity: "info", message: "fixture" },
      { id: "material-removal-artifacts", ok: true, severity: "info", message: "fixture" }
    ],
    missing: [],
    summary: "CAMotics local validation passed."
  };
}

function createResidualProofChainFixture(residualValidation = null) {
  const ready = Boolean(residualValidation?.productionResidualEvidenceReady);
  return {
    schema: "hediao3d.camotics-residual-proof-chain.v1",
    status: ready ? "production-residual-proof-bound" : "missing-residual-proof",
    productionResidualEvidenceReady: ready,
    unsafeProductionClaim: false,
    residualValidationStatus: residualValidation?.status ?? (ready ? "ready" : "missing"),
    summary: ready
      ? "Fixture local validation binds measured/swept-volume residual proof."
      : "Fixture local validation has no production residual proof."
  };
}

function createLinuxUploadReport({ residualProofChain }) {
  return {
    schema: "hediao3d.v3-linux-cam-evidence-upload-report.v1",
    createdAt: new Date().toISOString(),
    dryRun: false,
    phase: "uploaded",
    productionUnlockEligible: false,
    completedCount: 0,
    failedUpload: null,
    localValidationSummary: {
      camoticsLocalValidationStatus: "ready",
      candidatePackageStatus: "matched",
      residualProofChain
    },
    summary: "Production package unlock fixture upload report for residual proof cross-check."
  };
}

function createDownloadIntegrityEvidence(packageIntegrity) {
  const keyFiles = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc", "camotics-preview.nc"];
  return {
    packageIntegrityReviewed: true,
    operatorChecklistReviewed: true,
    neverMachineConfirmed: true,
    files: keyFiles.map((filename) => {
      const file = packageIntegrity.files?.find((item) => item.filename === filename);
      return {
        filename,
        sha256: file?.sha256 ?? null,
        verified: Boolean(file?.sha256),
        machineUseClass: file?.machineUse?.class ?? null
      };
    })
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

async function getArtifactText(jobId, filename) {
  return getText(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
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
  assert(response.status === expectedStatus, `${path} expected ${expectedStatus}, got ${response.status}`);
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

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value, null, 2)).digest("hex");
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
