#!/usr/bin/env node
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
  await getJson("/api/health");

  const invalid = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    acceptance: {
      schema: "hediao3d.invalid.v1",
      adapters: []
    },
    sourceName: "invalid-native-cam-real-output-acceptance.json"
  }, false);
  assert(invalid.status === 400, `invalid schema should be rejected, got ${invalid.status}`);
  assert(String(invalid.data.error ?? "").includes("schema"), "invalid schema response should explain schema mismatch");

  const adapterValidation = await postJson("/api/orchestrator/adapter-validation", { native: false });
  assert(adapterValidation.handoffClassificationAudit?.unsafeCount >= 1, "safe-default adapter validation should provide unsafe handoff audit for consistency check");

  const validationReport = createValidationReportFixture();
  const validationReportSha256 = createHash("sha256").update(JSON.stringify(validationReport, null, 2)).digest("hex");
  const mismatch = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance.json",
    validationReport,
    acceptance: createAcceptanceFixture("f".repeat(64))
  }, false);
  assert(mismatch.status === 400, `source report hash mismatch should be rejected, got ${mismatch.status}`);
  assert(String(mismatch.data.error ?? "").includes("哈希不匹配"), "mismatch response should explain source report hash mismatch");

  const imported = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256)
  });
  assert(imported.schema === "hediao3d.native-cam-real-output-acceptance.v1", "imported acceptance schema mismatch");
  assert(imported.level === "ready", `imported acceptance level mismatch: ${imported.level}`);
  assert(imported.productionCandidateCount === 1, "imported acceptance should report one production candidate");
  assert(imported.unsafeCount === 0, "imported acceptance should report zero unsafe outputs");
  assert(imported.sourceReportBindingStatus === "matched", "imported acceptance should bind to supplied validation report");
  assert(imported.targetMachineBoundaryStatus?.status === "matched", "imported acceptance should match target machine boundary");
  assert(imported.sourceReportSha256 === validationReportSha256, "imported acceptance should expose source report hash");
  assert(imported.sourceReportHandoffAudit?.productionCandidateCount === 1, "imported acceptance should expose source report production candidate audit");
  assert(imported.sourceReportHandoffAudit?.unsafeCount === 0, "imported acceptance should expose source report unsafe audit");
  assert(imported.contactValidationStatus?.status === "ready", "imported acceptance should expose ready strict contact validation");
  assert(imported.contactValidationStatus?.pathCoverage?.status === "ready", "imported acceptance should expose ready path coverage status");
  assert(imported.contactValidationStatus?.protectedZones?.status === "ready", "imported acceptance should expose ready protected-zone status");
  assert(imported.contactValidation?.checkCount >= 9, "imported acceptance should expose contact validation check count");
  assert(imported.contactValidation?.pathCoverage?.status === "ready", "imported acceptance should expose contact validation path coverage summary");
  assert(imported.contactValidation?.protectedZones?.status === "ready", "imported acceptance should expose contact validation protected-zone summary");
  assert(imported.apiArtifacts?.json?.includes("native-cam-real-output-acceptance.json"), "imported acceptance should expose JSON artifact");

  const artifact = await getJson(imported.apiArtifacts.json);
  assert(artifact.importSource?.sourceName === "native-cam-real-output-acceptance.json", "artifact should preserve import source name");
  assert(artifact.adapters?.some((adapter) => adapter.classification === "production-candidate"), "artifact should preserve production-candidate classification");
  assert(artifact.sourceReportBinding?.status === "matched", "artifact should preserve source report binding");
  assert(artifact.targetMachineBoundaryStatus?.status === "matched", "artifact should preserve target machine boundary status");
  assert(artifact.contactValidationStatus?.status === "ready", "artifact should preserve strict contact validation status");
  assert(artifact.contactValidationStatus?.pathCoverage?.status === "ready", "artifact should preserve path coverage status");
  assert(artifact.contactValidationStatus?.protectedZones?.status === "ready", "artifact should preserve protected-zone status");
  assert(artifact.sourceReportSnapshot?.handoffClassificationAudit?.productionCandidateCount === 1, "artifact should preserve source report handoff audit snapshot");

  const lowCoverageContactValidation = createContactValidationFixture({
    level: "critical",
    productionCandidateEligible: false,
    failedCheckCount: 1,
    errors: ["contact-path-coverage-x failed"],
    checks: createContactValidationChecks().map((check) => (
      check.id === "contact-path-coverage-x"
        ? { ...check, status: "fail", summary: "xCoverageRatio=0.72", reported: 0.72, expected: ">=0.98" }
        : check
    ))
  });
  const lowCoverage = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-low-coverage.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, { contactValidation: lowCoverageContactValidation })
  });
  assert(lowCoverage.level === "critical", "low OpenCAMLib path coverage should remain critical");
  assert(lowCoverage.contactValidationStatus?.pathCoverage?.status === "review", "low path coverage should be exposed as review status");
  assert(lowCoverage.contactValidationStatus?.pathCoverage?.x?.status === "fail", "low path coverage should expose failing X coverage check");

  const missingContact = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-missing-contact.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, { includeContactValidation: false })
  });
  assert(missingContact.level === "critical", "production-candidate acceptance without strict contact validation should be critical");
  assert(missingContact.contactValidationStatus?.status === "missing", "missing contact validation should expose missing status");
  assert(missingContact.blockers?.some((item) => /strict contact/i.test(item)), "missing contact validation should add a blocker");

  const missingBoundary = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-missing-boundary.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, { includeTargetMachineBoundary: false })
  });
  assert(missingBoundary.level === "review", "missing target machine boundary should downgrade ready acceptance to review");
  assert(missingBoundary.targetMachineBoundaryStatus?.status === "missing", "missing boundary import should expose missing status");

  const aAxisBoundary = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-a-axis-boundary.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, {
      targetMachineBoundary: {
        ...createTargetMachineBoundaryFixture(),
        postProcessor: "wrapA",
        rotaryOutputAxis: "A"
      }
    })
  });
  assert(aAxisBoundary.level === "review", "A-axis target boundary should not be accepted as ready for Y-rotary fixture");
  assert(aAxisBoundary.targetMachineBoundaryStatus?.status === "mismatch", "A-axis target boundary should expose mismatch status");
  assert(aAxisBoundary.targetMachineBoundaryStatus?.mismatches?.some((item) => /rotaryOutputAxis/.test(item)), "A-axis mismatch should name rotaryOutputAxis");

  const wrongToolBoundary = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-wrong-tool-boundary.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, {
      targetMachineBoundary: {
        ...createTargetMachineBoundaryFixture(),
        rotaryWrapPerRevolutionMm: 80,
        tool: {
          toolProfileId: "vbit-3mm-20deg",
          diameterMm: 3,
          angleDeg: 20,
          tip: "point"
        }
      }
    })
  });
  assert(wrongToolBoundary.level === "review", "wrong rotary calibration/tool boundary should not be accepted as ready");
  assert(wrongToolBoundary.targetMachineBoundaryStatus?.status === "mismatch", "wrong tool boundary should expose mismatch status");
  assert(wrongToolBoundary.targetMachineBoundaryStatus?.mismatches?.some((item) => /rotaryWrapPerRevolutionMm/.test(item)), "wrong boundary should name wrap distance mismatch");
  assert(wrongToolBoundary.targetMachineBoundaryStatus?.mismatches?.some((item) => /toolDiameterMm/.test(item)), "wrong boundary should name tool diameter mismatch");

  const nativeCamRealOutputBundleDataUrl = toZipDataUrl({
    "native-cam-real-output-acceptance.json": JSON.stringify(createAcceptanceFixture(validationReportSha256, { includeContactValidation: false }), null, 2),
    "v3-external-adapter-validation.json": JSON.stringify(validationReport, null, 2),
    "opencamlib-contact-output-validation.json": JSON.stringify(createContactValidationFixture(), null, 2),
    "opencamlib-runner-readiness.json": JSON.stringify(createRunnerReadinessFixture(), null, 2),
    "opencamlib-real-candidate-run.json": JSON.stringify(createRealCandidateFixture(), null, 2)
  });
  const zipImported = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-bundle.zip",
    acceptanceZipDataUrl: nativeCamRealOutputBundleDataUrl
  });
  assert(zipImported.schema === "hediao3d.native-cam-real-output-acceptance.v1", "zip imported acceptance schema mismatch");
  assert(zipImported.sourceReportBindingStatus === "matched", "zip imported acceptance should bind validation report");
  assert(zipImported.targetMachineBoundaryStatus?.status === "matched", "zip import should preserve matched target boundary");
  assert(zipImported.contactValidationStatus?.status === "ready", "zip import should preserve ready contact validation");
  assert(zipImported.contactValidationStatus?.pathCoverage?.status === "ready", "zip import should preserve ready path coverage");
  assert(zipImported.contactValidationStatus?.protectedZones?.status === "ready", "zip import should preserve ready protected zones");
  assert(zipImported.runnerReadinessStatus?.status === "blocked", "zip import should expose blocked runner readiness status");
  assert(zipImported.runnerReadiness?.firstBlocker === "real-drop-cutter-not-implemented", "zip import should preserve runner readiness blocker summary");
  assert(zipImported.openCamLibRealCandidateStatus?.status === "blocked", "zip import should expose blocked OpenCAMLib real candidate status");
  assert(zipImported.openCamLibRealCandidateStatus?.contactValidationPathCoverage?.status === "ready", "zip import should expose real candidate contact path coverage status");
  assert(zipImported.openCamLibRealCandidateStatus?.protectedZones?.status === "ready", "zip import should expose real candidate protected-zone status");
  assert(zipImported.openCamLibRealCandidate?.firstBlocking === "opencamlib-production-candidate-not-proven", "zip import should preserve real candidate blocker summary");
  assert(zipImported.openCamLibRealCandidate?.contactValidationPathCoverage?.status === "ready", "zip import should preserve real candidate path coverage summary");
  assert(zipImported.openCamLibRealCandidate?.protectedZones?.status === "ready", "zip import should preserve real candidate protected-zone summary");
  assert(zipImported.openCamLibRealCandidate?.candidateMachineFit?.level === "ok", "zip import should preserve real candidate machine-fit summary");
  assert(zipImported.openCamLibRealCandidate?.materialRemovalReadiness?.readyForMaterialRemovalSimulation === true, "zip import should preserve real candidate material-removal readiness");
  assert(zipImported.openCamLibRealCandidate?.candidatePackageBlockedReason === "OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence.", "zip import should preserve candidate package blocked reason");
  assert(zipImported.apiArtifacts?.zipBundle?.includes("imported-native-cam-real-output-bundle.zip"), "zip import should expose source bundle artifact");
  const zipArtifact = await getJson(zipImported.apiArtifacts.json);
  assert(zipArtifact.importSource?.zipBundle === "imported-native-cam-real-output-bundle.zip", "zip import artifact should preserve source bundle filename");
  assert(zipArtifact.contactValidation?.pathCoverage?.status === "ready", "zip import artifact should preserve contact path coverage summary");
  assert(zipArtifact.contactValidation?.protectedZones?.status === "ready", "zip import artifact should preserve protected-zone summary");
  assert(zipArtifact.runnerReadiness?.sha256, "zip import artifact should preserve runner readiness sha256");
  assert(zipArtifact.runnerReadinessStatus?.summary?.includes("OpenCAMLib runner readiness"), "zip import artifact should preserve runner readiness status summary");
  assert(zipArtifact.openCamLibRealCandidate?.sha256, "zip import artifact should preserve OpenCAMLib real candidate sha256");
  assert(zipArtifact.openCamLibRealCandidate?.contactValidationPathCoverage?.status === "ready", "zip import artifact should preserve OpenCAMLib real candidate path coverage summary");
  assert(zipArtifact.openCamLibRealCandidate?.protectedZones?.status === "ready", "zip import artifact should preserve OpenCAMLib real candidate protected-zone summary");
  assert(zipArtifact.openCamLibRealCandidate?.candidateMachineFit?.targetMachine?.rotaryOutputAxis === "Y", "zip import artifact should preserve OpenCAMLib real candidate machine-fit");
  assert(zipArtifact.openCamLibRealCandidate?.materialRemovalReadiness?.productionResidualEvidenceReady === false, "zip import artifact should preserve OpenCAMLib material-removal production boundary");
  assert(zipArtifact.openCamLibRealCandidateStatus?.summary?.includes("OpenCAMLib one-command real candidate"), "zip import artifact should preserve OpenCAMLib real candidate status summary");
  const zipImportReport = await getJson(zipImported.apiArtifacts.importJson);
  assert(zipImportReport.zipBundle === "imported-native-cam-real-output-bundle.zip", "zip import report should preserve source bundle filename");
  assert(zipImportReport.runnerReadinessStatus?.status === "blocked", "zip import report should preserve runner readiness status");
  assert(zipImportReport.openCamLibRealCandidateStatus?.status === "blocked", "zip import report should preserve OpenCAMLib real candidate status");

  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.nativeCamRealOutputAcceptance, "readiness should include imported native CAM real output acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.id === zipImported.id, "readiness should pick latest imported acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.level === "ready", "readiness should preserve acceptance level");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportBindingStatus === "matched", "readiness should expose matched source report binding");
  assert(readiness.nativeCamRealOutputAcceptance.targetMachineBoundaryStatus?.status === "matched", "readiness should expose matched target machine boundary");
  assert(readiness.nativeCamRealOutputAcceptance.contactValidationStatus?.status === "ready", "readiness should expose ready strict contact validation");
  assert(readiness.nativeCamRealOutputAcceptance.contactValidationStatus?.pathCoverage?.status === "ready", "readiness should expose ready path coverage status");
  assert(readiness.nativeCamRealOutputAcceptance.contactValidationStatus?.protectedZones?.status === "ready", "readiness should expose ready protected-zone status");
  assert(readiness.nativeCamRealOutputAcceptance.runnerReadinessStatus?.status === "blocked", "readiness should expose imported OpenCAMLib runner readiness status");
  assert(readiness.nativeCamRealOutputAcceptance.runnerReadiness?.blockerCount === 1, "readiness should expose imported OpenCAMLib runner readiness summary");
  assert(readiness.nativeCamRealOutputAcceptance.openCamLibRealCandidateStatus?.status === "blocked", "readiness should expose imported OpenCAMLib real candidate status");
  assert(readiness.nativeCamRealOutputAcceptance.openCamLibRealCandidateStatus?.contactValidationPathCoverage?.status === "ready", "readiness should expose imported real candidate path coverage");
  assert(readiness.nativeCamRealOutputAcceptance.openCamLibRealCandidateStatus?.protectedZones?.status === "ready", "readiness should expose imported real candidate protected zones");
  assert(readiness.nativeCamRealOutputAcceptance.openCamLibRealCandidate?.blockingCount === 1, "readiness should expose imported OpenCAMLib real candidate summary");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportHandoffAudit?.productionCandidateCount === 1, "readiness should expose bound source report handoff audit");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportHandoffAudit?.unsafeCount === 0, "readiness should expose clean bound source report handoff audit");
  assert(readiness.acceptancePlan?.steps?.some((step) => step.id === "native-cam-real-output-acceptance"), "readiness plan should include real output acceptance step");
  assert(!readiness.gates?.blockers?.some((item) => /真实输出验收为 ready.*handoff 审计仍不一致/.test(item)), "readiness should not compare matched real-output acceptance against a later unrelated adapter audit");
  const camLayer = readiness.goalAudit?.layers?.find((layer) => layer.id === "cam-engine-layer");
  assert(camLayer?.evidence?.some((item) => /bound-native-source-report/.test(item)), "CAM layer should use bound source report handoff audit when available");
  assert(readiness.gates?.allowProductionNc === false, "native CAM real-output import alone must not unlock production NC");
  if (readiness.postprocessHandoffReadiness?.source !== "latest-job-evidence-dossier") {
    assert(readiness.postprocessHandoffReadiness?.status === "blocked", `readiness should block production candidate CAM evidence without neutral postprocess handoff, got ${readiness.postprocessHandoffReadiness?.status}`);
    assert(readiness.gates?.blockers?.some((item) => /Y\/A 旋转夹具后处理/.test(item)), "readiness should explain missing self-developed rotary fixture postprocess handoff");
  }
  const hasEligibleCamoticsEvidence = Boolean(
    readiness.readinessCamoticsEvidence?.productionEvidenceEligible
    || readiness.camoticsImport?.productionEvidenceEligible
  );
  if (!hasEligibleCamoticsEvidence) {
    assert(readiness.gates?.blockers?.some((item) => /真实 CAM 生产候选证据.*CAMotics/.test(item)), "readiness should block production candidate CAM evidence without eligible CAMotics material-removal evidence");
  }

  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  const job = await waitForJob(created.id);
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  const unifiedZipImported = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-evidence-bundle`, {
    sourceName: "native-cam-real-output-bundle.zip",
    bundleDataUrl: nativeCamRealOutputBundleDataUrl
  });
  assert(unifiedZipImported.schema === "hediao3d.native-cam-real-output-acceptance.v1", "unified Linux CAM evidence endpoint should route Native CAM bundle to acceptance import");
  assert(unifiedZipImported.sourceReportBindingStatus === "matched", "unified Native CAM bundle import should bind validation report");
  assert(unifiedZipImported.targetMachineBoundaryStatus?.status === "matched", "unified Native CAM bundle import should preserve target machine boundary");
  assert(unifiedZipImported.contactValidationStatus?.status === "ready", "unified Native CAM bundle import should preserve contact validation");
  assert(unifiedZipImported.apiArtifacts?.zipBundle?.includes("imported-native-cam-real-output-bundle.zip"), "unified Native CAM bundle import should expose source bundle artifact");
  const prepared = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-cli-package`, {});
  assert(prepared.ok === true, "CAMotics package prepare should refresh job-local Native CAM snapshot");
  const snapshot = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/native-cam-real-output-snapshot.json`);
  assert(snapshot.schema === "hediao3d.native-cam-real-output-snapshot.v1", "job-local Native CAM snapshot schema mismatch");
  assert(snapshot.acceptance?.id === unifiedZipImported.id, "job-local Native CAM snapshot should bind latest imported acceptance id");
  assert(snapshot.gateHints?.canSupportProductionCandidateReview === true, "job-local Native CAM snapshot should expose production candidate review support");
  const reloadedJob = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloadedJob.result?.summary?.productionEvidenceDossier?.evidenceItems?.some((item) => item.id === "native-cam-real-output-snapshot" && item.status === "pass"), "job evidence dossier should include passing Native CAM snapshot item");
  assert(reloadedJob.result.summary.productionEvidenceDossier.crossChecks?.nativeCamRealOutputSnapshot?.acceptanceId === unifiedZipImported.id, "job evidence dossier should expose Native CAM snapshot acceptance id");
  assert(reloadedJob.result.summary.deliveryManifest.files?.some((file) => file.filename === "native-cam-real-output-snapshot.json" && file.exists), "delivery manifest should expose Native CAM snapshot");
  assert(reloadedJob.result.summary.packageIntegrity.files?.some((file) => file.filename === "native-cam-real-output-snapshot.json" && file.sha256), "package integrity should hash Native CAM snapshot");

  console.log(JSON.stringify({
    ok: true,
    importId: unifiedZipImported.id,
    readinessId: readiness.id,
    level: readiness.nativeCamRealOutputAcceptance.level,
    candidates: readiness.nativeCamRealOutputAcceptance.productionCandidateCount,
    jobId: job.id
  }, null, 2));
}

function createValidationReportFixture() {
  return {
    schema: "hediao3d.external-adapter-validation.v1",
    createdAt: new Date().toISOString(),
    outputRoot: "public/orchestrator-adapter-validation/native-real-output-test",
    useNativeCommands: true,
    handoffClassificationAudit: {
      productionCandidateCount: 1,
      unsafeCount: 0,
      missingCount: 0
    },
    adapters: [
      {
        id: "opencamlib",
        handoffEvidence: {
          classification: "production-candidate",
          productionCandidate: true
        }
      }
    ]
  };
}

function createAcceptanceFixture(sourceReportSha256, options = {}) {
  const includeTargetMachineBoundary = options.includeTargetMachineBoundary !== false;
  const includeContactValidation = options.includeContactValidation !== false;
  const contactValidation = options.contactValidation ?? createContactValidationFixture();
  const targetMachineBoundary = options.targetMachineBoundary ?? createTargetMachineBoundaryFixture();
  return {
    schema: "hediao3d.native-cam-real-output-acceptance.v1",
    createdAt: new Date().toISOString(),
    sourceReport: "public/orchestrator-adapter-validation/native-real-output-test/v3-external-adapter-validation.json",
    sourceReportIdentity: {
      filename: "v3-external-adapter-validation.json",
      path: "public/orchestrator-adapter-validation/native-real-output-test/v3-external-adapter-validation.json",
      sha256: sourceReportSha256,
      schema: "hediao3d.external-adapter-validation.v1"
    },
    level: "ready",
    strict: true,
    expectProductionCandidate: true,
    ...(includeTargetMachineBoundary ? { targetMachineBoundary } : {}),
    ...(includeContactValidation ? { contactValidation } : {}),
    productionCandidateCount: 1,
    unsafeCount: 0,
    missingCount: 0,
    blockers: [],
    warnings: [],
    nextActions: ["将真实输出继续送入 neutral-toolpath、CAMotics 和机床空跑验收。"],
    adapters: [
      {
        id: "opencamlib",
        status: "completed",
        classification: "production-candidate",
        productionCandidate: true,
        fixture: false,
        synthetic: false,
        previewScaffold: false,
        generatedByExternalCommand: true
      }
    ]
  };
}

function createContactValidationFixture(overrides = {}) {
  const checks = createContactValidationChecks();
  return {
    schema: "hediao3d.opencamlib-contact-output-validation.v1",
    createdAt: new Date().toISOString(),
    level: "ready",
    strict: true,
    expectProductionCandidate: true,
    productionCandidateEligible: true,
    checks,
    protectedZones: createProtectedZonesFixture(),
    errors: [],
    warnings: [],
    ...overrides
  };
}

function createContactValidationChecks() {
  return [
    "neutral-schema",
    "neutral-points",
    "neutral-not-synthetic",
    "neutral-not-fixture",
    "neutral-not-preview",
    "contact-schema",
    "quality-postprocessEligible",
    "quality-productionCandidate",
    "quality-not-preview",
    "contact-algorithm-real",
    "contact-tool-diameter",
    "contact-tool-angle",
    "contact-tool-flat-tip",
    "contact-sampling-hit-rate",
    "contact-sampling-point-count",
    "contact-sampling-step-ratio",
    "contact-path-coverage-x",
    "contact-path-coverage-cross",
    "protected-zones-present",
    "protected-zones-no-violations",
    "protected-zones-sampled-bounds",
    "contact-residual-gouge",
    "contact-residual-undercut",
    "identity-neutral",
    "identity-plan",
    "identity-model"
  ].map((id) => ({ id, status: "pass", summary: `${id} pass` }));
}

function createProtectedZonesFixture() {
  return {
    schema: "hediao3d.opencamlib-protected-zones-summary.v1",
    required: true,
    status: "ready",
    ready: true,
    enabled: true,
    leftHoldMm: 2,
    rightHoldMm: 2,
    endTransitionMm: 1.2,
    safeMinX: -16.8,
    safeMaxX: 16.8,
    sampledMinX: -16.8,
    sampledMaxX: 16.8,
    violationCount: 0,
    summary: "OpenCAMLib protected end-zone checks passed."
  };
}

function createRunnerReadinessFixture() {
  return {
    schema: "hediao3d.opencamlib-runner-readiness-report.v1",
    createdAt: new Date().toISOString(),
    status: "blocked",
    level: "blocked",
    selectedModule: "opencamlib",
    dropCutterReady: false,
    blockers: ["real-drop-cutter-not-implemented"],
    warnings: ["heightfield preview is not production CAM"],
    probe: {
      selectedModule: "opencamlib",
      dropCutterReady: false
    },
    contactSpike: {
      status: "blocked"
    }
  };
}

function createRealCandidateFixture() {
  return {
    schema: "hediao3d.opencamlib-real-candidate-run.v1",
    createdAt: new Date().toISOString(),
    ok: false,
    level: "blocked",
    productionLocked: true,
    contactValidation: {
      level: "ready",
      evidenceClass: "production-candidate",
      productionCandidateEligible: true,
      pathCoverage: {
        schema: "hediao3d.opencamlib-contact-path-coverage-summary.v1",
        required: true,
        status: "ready",
        ready: true,
        x: { id: "contact-path-coverage-x", status: "pass", summary: "xCoverageRatio=1" },
        cross: { id: "contact-path-coverage-cross", status: "pass", summary: "crossCoverageRatio=1" },
        summary: "OpenCAMLib path coverage checks passed."
      },
      protectedZones: createProtectedZonesFixture()
    },
    openCamLibContactReport: {
      schema: "hediao3d.opencamlib-cutter-contact-report.v1",
      mode: "opencamlib-path-drop-cutter-experimental",
      candidateMachineFit: {
        schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
        level: "ok",
        summary: "Fixture contact matches the target rotary-Y machine boundary.",
        targetMachine: {
          controllerClass: "3axis-controller-with-rotary-fixture",
          rotaryOutputAxis: "Y",
          wrapPerRevolutionMm: 100,
          toolProfileId: "vflat-4mm-25deg"
        },
        coverage: {
          pointCount: 3,
          finitePointCount: 3,
          xSpanMm: 20,
          rotarySampleCount: 3,
          rotarySpanDeg: 360,
          expectedRotaryCoverageDeg: 360,
          rotaryCoverageRatio: 1,
          depthMax: 0.8
        },
        riskCounts: {
          holdZonePointCount: 0,
          deepPointCount: 0,
          invalidPointCount: 0,
          missingRotaryCount: 0
        },
        checks: {
          rotaryCoordinatePresent: true,
          protectedZoneClean: true,
          depthWithinLimit: true
        }
      },
      materialRemovalReadiness: {
        schema: "hediao3d.opencamlib-material-removal-readiness.v1",
        level: "ready-for-camotics-or-equivalent",
        readyForMaterialRemovalSimulation: true,
        productionResidualEvidenceReady: false,
        missingForProduction: ["measured or swept-volume validated residual material metrics"],
        summary: "Fixture is ready for engineering material-removal simulation but not production residual evidence."
      }
    },
    candidatePackage: {
      level: "critical",
      readyForImport: false,
      blockedReason: "OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence."
    },
    blocking: ["opencamlib-production-candidate-not-proven"]
  };
}

function createTargetMachineBoundaryFixture() {
  return {
    schema: "hediao3d.target-machine-boundary.v1",
    controllerClass: "3axis-controller-with-rotary-fixture",
    machineProfileId: "desktop-3axis-rotary-y",
    camMode: "rotaryWrap",
    postProcessor: "wrapY",
    axisMapping: {
      X: "length-mm",
      Y: "rotary-fixture-linearized-angle-or-wrap-mm",
      Z: "tool-depth-and-safe-height"
    },
    rotaryOutputAxis: "Y",
    rotaryWrapPerRevolutionMm: 100,
    lengthAxis: "X",
    depthAxis: "Z",
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      angleDeg: 25,
      tip: "flat"
    },
    requiredPostprocessOwner: "HeDiao3D"
  };
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

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function waitForJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function postJson(path, body, expectOk = true) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (expectOk) assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return expectOk ? data : { status: response.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
