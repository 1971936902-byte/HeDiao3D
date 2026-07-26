#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");
  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.schema === "hediao3d.v3-readiness-report.v1", "readiness schema mismatch");
  assert(readiness.id, "readiness missing id");

  const invalid = await postJsonAllowingStatus("/api/orchestrator/readiness/runbook-result", {
    schema: "wrong",
    readinessReportId: readiness.id
  }, 400);
  assert(/schema/.test(invalid.error ?? ""), "invalid runbook result should fail on schema");

  const failedResult = createRunbookResultFixture(readiness, false);
  const imported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result.json",
    result: failedResult
  });
  assert(imported.schema === "hediao3d.v3-acceptance-runbook-result.v1", "imported runbook result schema mismatch");
  assert(imported.readinessReportId === readiness.id, "imported runbook result readiness id mismatch");
  assert(imported.identityValid === true, "imported runbook result should be identity-valid");
  assert(imported.ok === false, "failed runbook fixture should not be ok");
  assert(imported.failedCount === 1, "failed runbook fixture should report one failed step");
  assert(imported.blockingFailedCount === 1, "failed runbook fixture should report one blocking failure");
  assert(imported.productionSafe === false, "failed runbook fixture should not be production-safe");
  assert(imported.apiArtifacts?.json?.endsWith("v3-acceptance-runbook-result.json"), "imported runbook result should expose JSON artifact");
  assert(imported.apiArtifacts?.importJson?.endsWith("v3-acceptance-runbook-result-import.json"), "imported runbook result should expose import artifact");

  const importedArtifact = await getJson(imported.apiArtifacts.json);
  assert(importedArtifact.importSource?.route === "/api/orchestrator/readiness/runbook-result", "artifact should preserve import route");
  const importArtifact = await getJson(imported.apiArtifacts.importJson);
  assert(importArtifact.schema === "hediao3d.v3-acceptance-runbook-result-import.v1", "import artifact schema mismatch");
  assert(importArtifact.blockingFailedCount === 1, "import artifact should preserve blocking failure count");
  assert(importArtifact.runbookReviewSafe === false, "import artifact should preserve failed review-safe state");
  assert(typeof importArtifact.productionSafeReason === "string", "import artifact should explain production-safe boundary");

  const zipResult = createRunbookResultFixture(readiness, true);
  const rawPassingImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result.json",
    result: zipResult
  });
  assert(rawPassingImported.ok === true, "raw all-pass runbook result should be ok");
  assert(rawPassingImported.linuxEvidence?.status === "missing-zip", "raw all-pass runbook result should report missing Linux evidence ZIP");
  assert(rawPassingImported.runbookReviewSafe === false, "raw all-pass runbook result without Linux evidence must not be review-safe");
  assert(rawPassingImported.productionSafe === false, "raw all-pass runbook result without Linux evidence must not be production-safe");

  const duplicateRunbookResultZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "nested/v3-acceptance-runbook-result.json", content: JSON.stringify({
      ...zipResult,
      ok: false,
      productionSafe: false,
      failedCount: 1
    }, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const duplicateRunbookResultImport = await postJsonAllowingStatus("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${duplicateRunbookResultZipBytes.toString("base64")}`
  }, 400);
  assert(/多个 v3-acceptance-runbook-result\.json/.test(duplicateRunbookResultImport.error ?? ""), "duplicate runbook result JSON should be rejected");

  const contradictoryRunbookResult = {
    ...zipResult,
    ok: false,
    exitCode: 1,
    failedCount: 1,
    blockingFailedCount: 0,
    productionSafe: true,
    failedSteps: [
      { id: "nonblocking-fixture", title: "Nonblocking fixture failed", exitCode: 1, blocksProduction: false }
    ],
    steps: [
      ...(zipResult.steps ?? []),
      { id: "nonblocking-fixture", title: "Nonblocking fixture failed", exitCode: 1, ok: false, blocksProduction: false }
    ]
  };
  const contradictoryRunbookZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(contradictoryRunbookResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const contradictoryRunbookImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${contradictoryRunbookZipBytes.toString("base64")}`
  });
  assert(contradictoryRunbookImported.ok === false, "contradictory runbook fixture should preserve ok=false");
  assert(contradictoryRunbookImported.failedCount === 1, "contradictory runbook fixture should preserve failed count");
  assert(contradictoryRunbookImported.blockingFailedCount === 0, "contradictory runbook fixture should preserve nonblocking failure boundary");
  assert(contradictoryRunbookImported.productionSafe === false, "ok=false/failedCount>0 must override claimed productionSafe=true");

  const hiddenFailedStepRunbookResult = {
    ...zipResult,
    ok: true,
    exitCode: 0,
    failedCount: 0,
    blockingFailedCount: 0,
    productionSafe: true,
    failedSteps: [],
    steps: [
      ...(zipResult.steps ?? []),
      { id: "hidden-failed-step", title: "Hidden failed step", exitCode: 1, ok: false, blocksProduction: false }
    ]
  };
  const hiddenFailedStepZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(hiddenFailedStepRunbookResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const hiddenFailedStepImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${hiddenFailedStepZipBytes.toString("base64")}`
  });
  assert(hiddenFailedStepImported.ok === true, "hidden failed step fixture should preserve ok=true");
  assert(hiddenFailedStepImported.failedCount === 0, "hidden failed step fixture should preserve failedCount=0");
  assert(hiddenFailedStepImported.productionSafe === false, "steps[].ok=false must override claimed productionSafe=true even when failedCount=0");

  const invalidLocalValidationZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: false,
      level: "review",
      summary: "Fixture validation is not production evidence eligible."
    }, null, 2) }
  ]);
  const invalidLocalValidationImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${invalidLocalValidationZipBytes.toString("base64")}`
  });
  assert(invalidLocalValidationImported.ok === true, "runbook result can be ok even when Linux local validation is not eligible");
  assert(invalidLocalValidationImported.productionSafe === false, "invalid Linux local validation must prevent productionSafe runbook summary");
  assert(invalidLocalValidationImported.linuxEvidence?.status === "invalid-linux-evidence", `invalid local validation should mark Linux evidence invalid, got ${invalidLocalValidationImported.linuxEvidence?.status}`);
  assert(invalidLocalValidationImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "camotics-result-local-validation" && issue.status === "not-production-eligible"), "invalid local validation should be reported as a Linux evidence validation issue");

  const residualClaimWithoutProofZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready",
      residualValidation: {
        status: "ready",
        productionResidualEvidenceReady: true,
        measured: true,
        validationBasis: "swept-volume-validated",
        maxGougeMm: 0.01,
        maxUndercutMm: 0.02
      }
    }, null, 2) }
  ]);
  const residualClaimWithoutProofImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${residualClaimWithoutProofZipBytes.toString("base64")}`
  });
  assert(residualClaimWithoutProofImported.ok === true, "runbook result can be ok even when local residual proof chain is missing");
  assert(residualClaimWithoutProofImported.productionSafe === false, "local residual claim without proof chain must prevent productionSafe runbook summary");
  assert(residualClaimWithoutProofImported.linuxEvidence?.status === "invalid-linux-evidence", `missing residual proof chain should mark Linux evidence invalid, got ${residualClaimWithoutProofImported.linuxEvidence?.status}`);
  assert(residualClaimWithoutProofImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "camotics-residual-proof-chain" && issue.status === "missing-residual-proof-chain"), "missing residual proof chain should be reported as a Linux evidence validation issue");

  const failedClosedLoopZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: false,
      productionLocked: true,
      evidenceChain: {
        ...createClosedLoopEvidenceChainFixture(),
        status: "ready-or-awaiting-inputs"
      },
      steps: [
        { id: "native-cam-real-output", ok: false, summary: "Fixture Native CAM closed-loop check failed." }
      ]
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const failedClosedLoopImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${failedClosedLoopZipBytes.toString("base64")}`
  });
  assert(failedClosedLoopImported.ok === true, "runbook result can be ok even when Native CAM closed-loop JSON reports a failed local check");
  assert(failedClosedLoopImported.productionSafe === false, "failed Native CAM closed-loop check must prevent productionSafe runbook summary");
  assert(failedClosedLoopImported.linuxEvidence?.status === "invalid-linux-evidence", `failed closed-loop check should mark Linux evidence invalid, got ${failedClosedLoopImported.linuxEvidence?.status}`);
  assert(failedClosedLoopImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "native-cam-closed-loop-check" && issue.status === "not-ok"), "failed closed-loop check should be reported as a Linux evidence validation issue");

  const missingEvidenceChainZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const missingEvidenceChainImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${missingEvidenceChainZipBytes.toString("base64")}`
  });
  assert(missingEvidenceChainImported.ok === true, "runbook result can be ok even when closed-loop evidenceChain is missing");
  assert(missingEvidenceChainImported.productionSafe === false, "missing closed-loop evidenceChain must prevent productionSafe runbook summary");
  assert(missingEvidenceChainImported.linuxEvidence?.status === "invalid-linux-evidence", `missing evidenceChain should mark Linux evidence invalid, got ${missingEvidenceChainImported.linuxEvidence?.status}`);
  assert(missingEvidenceChainImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "native-cam-closed-loop-evidence-chain" && issue.status === "missing-evidence-chain"), "missing closed-loop evidenceChain should be reported as a Linux evidence validation issue");

  const evidenceChainSchemaMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: {
        ...createClosedLoopEvidenceChainFixture(),
        schema: "wrong.native-cam-linux-evidence-chain.v1"
      },
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const evidenceChainSchemaMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${evidenceChainSchemaMismatchZipBytes.toString("base64")}`
  });
  assert(evidenceChainSchemaMismatchImported.ok === true, "runbook result can be ok even when closed-loop evidenceChain schema is wrong");
  assert(evidenceChainSchemaMismatchImported.productionSafe === false, "closed-loop evidenceChain schema mismatch must prevent productionSafe runbook summary");
  assert(evidenceChainSchemaMismatchImported.linuxEvidence?.status === "invalid-linux-evidence", `evidenceChain schema mismatch should mark Linux evidence invalid, got ${evidenceChainSchemaMismatchImported.linuxEvidence?.status}`);
  assert(evidenceChainSchemaMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "native-cam-closed-loop-evidence-chain" && issue.status === "schema-mismatch"), "closed-loop evidenceChain schema mismatch should be reported");

  const failedEvidenceChainStatusZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: {
        ...createClosedLoopEvidenceChainFixture(),
        status: "failed"
      },
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const failedEvidenceChainStatusImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${failedEvidenceChainStatusZipBytes.toString("base64")}`
  });
  assert(failedEvidenceChainStatusImported.ok === true, "runbook result can be ok even when evidenceChain status is not ready");
  assert(failedEvidenceChainStatusImported.productionSafe === false, "non-ready evidenceChain status must prevent productionSafe runbook summary");
  assert(failedEvidenceChainStatusImported.linuxEvidence?.status === "blocked-evidence-chain", `non-ready evidenceChain should block Linux evidence, got ${failedEvidenceChainStatusImported.linuxEvidence?.status}`);
  assert(failedEvidenceChainStatusImported.linuxEvidence?.evidenceChain?.status === "failed", "non-ready evidenceChain status should be preserved for audit");

  const unboundUpstreamEvidenceChain = createClosedLoopEvidenceChainFixture();
  unboundUpstreamEvidenceChain.crossChecks = {
    ...unboundUpstreamEvidenceChain.crossChecks,
    materialRemovalBoundToUpstreamCam: false
  };
  const unboundUpstreamZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: unboundUpstreamEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const unboundUpstreamImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${unboundUpstreamZipBytes.toString("base64")}`
  });
  assert(unboundUpstreamImported.ok === true, "runbook result can be ok even when CAMotics is not bound to upstream CAM");
  assert(unboundUpstreamImported.productionSafe === false, "missing CAMotics upstream binding must prevent productionSafe runbook summary");
  assert(unboundUpstreamImported.linuxEvidence?.status === "blocked-evidence-chain", `unbound upstream evidence should block Linux evidence, got ${unboundUpstreamImported.linuxEvidence?.status}`);
  assert(unboundUpstreamImported.linuxEvidence?.evidenceChain?.crossChecks?.materialRemovalBoundToUpstreamCam === false, "unbound upstream evidence should be preserved for audit");
  assert(unboundUpstreamImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "cross-check-not-ready" && issue.field === "materialRemovalBoundToUpstreamCam" && issue.actual === false), "unbound upstream evidence should expose the failing cross-check issue");

  const machineBoundaryMismatchEvidenceChain = createClosedLoopEvidenceChainFixture();
  machineBoundaryMismatchEvidenceChain.nativeCam = {
    ...machineBoundaryMismatchEvidenceChain.nativeCam,
    targetMachineBoundaryStatus: "mismatch"
  };
  const machineBoundaryMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: machineBoundaryMismatchEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const machineBoundaryMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${machineBoundaryMismatchZipBytes.toString("base64")}`
  });
  assert(machineBoundaryMismatchImported.ok === true, "runbook result can be ok even when Native CAM target machine boundary is mismatched");
  assert(machineBoundaryMismatchImported.productionSafe === false, "Native CAM target machine mismatch must prevent productionSafe runbook summary");
  assert(machineBoundaryMismatchImported.linuxEvidence?.status === "blocked-evidence-chain", `machine boundary mismatch should block Linux evidence, got ${machineBoundaryMismatchImported.linuxEvidence?.status}`);
  assert(machineBoundaryMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "nativeCam.targetMachineBoundaryStatus" && issue.actual === "mismatch"), "machine boundary mismatch should expose the failing component issue");

  const nativeCamComponentMismatchEvidenceChain = createClosedLoopEvidenceChainFixture();
  nativeCamComponentMismatchEvidenceChain.nativeCam = {
    ...nativeCamComponentMismatchEvidenceChain.nativeCam,
    productionCandidateCount: 0,
    sourceReportBindingStatus: "missing",
    contactValidationStatus: "review"
  };
  const nativeCamComponentMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: nativeCamComponentMismatchEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const nativeCamComponentMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${nativeCamComponentMismatchZipBytes.toString("base64")}`
  });
  assert(nativeCamComponentMismatchImported.ok === true, "runbook result can be ok even when Native CAM component summaries are not ready");
  assert(nativeCamComponentMismatchImported.productionSafe === false, "Native CAM component mismatches must prevent productionSafe runbook summary");
  assert(nativeCamComponentMismatchImported.linuxEvidence?.status === "blocked-evidence-chain", `Native CAM component mismatch should block Linux evidence, got ${nativeCamComponentMismatchImported.linuxEvidence?.status}`);
  assert(nativeCamComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "nativeCam.sourceReportBindingStatus" && issue.actual === "missing"), "Native CAM source binding mismatch should be exposed");
  assert(nativeCamComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "nativeCam.contactValidationStatus" && issue.actual === "review"), "Native CAM contact validation mismatch should be exposed");
  assert(nativeCamComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "nativeCam.productionCandidateCount" && issue.actual === false), "Native CAM missing production candidate should be exposed");

  const openCamLibComponentMismatchEvidenceChain = createClosedLoopEvidenceChainFixture();
  openCamLibComponentMismatchEvidenceChain.openCamLib = {
    ...openCamLibComponentMismatchEvidenceChain.openCamLib,
    realCandidateReady: false,
    contactPathCoverage: {
      ...(openCamLibComponentMismatchEvidenceChain.openCamLib.contactPathCoverage ?? {}),
      ready: false,
      status: "review"
    },
    protectedZonesReady: false,
    candidatePackageReadyForImport: false
  };
  const openCamLibComponentMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: openCamLibComponentMismatchEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const openCamLibComponentMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${openCamLibComponentMismatchZipBytes.toString("base64")}`
  });
  assert(openCamLibComponentMismatchImported.ok === true, "runbook result can be ok even when OpenCAMLib component summaries are not ready");
  assert(openCamLibComponentMismatchImported.productionSafe === false, "OpenCAMLib component mismatches must prevent productionSafe runbook summary");
  assert(openCamLibComponentMismatchImported.linuxEvidence?.status === "blocked-evidence-chain", `OpenCAMLib component mismatch should block Linux evidence, got ${openCamLibComponentMismatchImported.linuxEvidence?.status}`);
  assert(openCamLibComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.realCandidateReady" && issue.actual === false), "OpenCAMLib real candidate mismatch should be exposed");
  assert(openCamLibComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.contactPathCoverage.ready" && issue.actual === false), "OpenCAMLib path coverage mismatch should be exposed");
  assert(openCamLibComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.protectedZonesReady" && issue.actual === false), "OpenCAMLib protected zones mismatch should be exposed");
  assert(openCamLibComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.candidatePackageReadyForImport" && issue.actual === false), "OpenCAMLib candidate package import mismatch should be exposed");

  const openCamLibPromotionBlockedEvidenceChain = createClosedLoopEvidenceChainFixture();
  openCamLibPromotionBlockedEvidenceChain.openCamLib = {
    ...openCamLibPromotionBlockedEvidenceChain.openCamLib,
    productionCandidatePromotion: {
      ...openCamLibPromotionBlockedEvidenceChain.openCamLib.productionCandidatePromotion,
      status: "blocked",
      productionCandidateReady: false,
      blockingCount: 1,
      firstBlockingCriterion: {
        id: "experimental-real-api-boundary",
        layer: "runtime-boundary",
        status: "fail",
        summary: "experimental-real-api still blocks production candidate promotion"
      }
    }
  };
  const openCamLibPromotionBlockedZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: openCamLibPromotionBlockedEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const openCamLibPromotionBlockedImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${openCamLibPromotionBlockedZipBytes.toString("base64")}`
  });
  assert(openCamLibPromotionBlockedImported.ok === true, "runbook result can be ok even when OpenCAMLib promotion audit is blocked");
  assert(openCamLibPromotionBlockedImported.productionSafe === false, "OpenCAMLib promotion blockers must prevent productionSafe runbook summary");
  assert(openCamLibPromotionBlockedImported.linuxEvidence?.status === "blocked-evidence-chain", `OpenCAMLib promotion blocker should block Linux evidence, got ${openCamLibPromotionBlockedImported.linuxEvidence?.status}`);
  assert(openCamLibPromotionBlockedImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.productionCandidatePromotion.productionCandidateReady" && issue.actual === false), "OpenCAMLib promotion blocker should be exposed");

  const openCamLibUnlockClaimEvidenceChain = createClosedLoopEvidenceChainFixture();
  openCamLibUnlockClaimEvidenceChain.openCamLib = {
    ...openCamLibUnlockClaimEvidenceChain.openCamLib,
    productionGapReview: {
      ...openCamLibUnlockClaimEvidenceChain.openCamLib.productionGapReview,
      productionUnlockReady: true
    }
  };
  const openCamLibUnlockClaimZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: openCamLibUnlockClaimEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const openCamLibUnlockClaimImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${openCamLibUnlockClaimZipBytes.toString("base64")}`
  });
  assert(openCamLibUnlockClaimImported.ok === true, "runbook result can be ok even when OpenCAMLib gap review claims production unlock");
  assert(openCamLibUnlockClaimImported.productionSafe === false, "OpenCAMLib production gap review must not make runbook production-safe by itself");
  assert(openCamLibUnlockClaimImported.linuxEvidence?.status === "blocked-evidence-chain", `OpenCAMLib unlock claim should block Linux evidence, got ${openCamLibUnlockClaimImported.linuxEvidence?.status}`);
  assert(openCamLibUnlockClaimImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.productionGapReview.productionUnlockReady" && issue.actual === true), "OpenCAMLib production unlock claim should be exposed");

  const downstreamPlanUnlockClaimEvidenceChain = createClosedLoopEvidenceChainFixture();
  downstreamPlanUnlockClaimEvidenceChain.openCamLib = {
    ...downstreamPlanUnlockClaimEvidenceChain.openCamLib,
    downstreamEvidencePlan: {
      ...downstreamPlanUnlockClaimEvidenceChain.openCamLib.downstreamEvidencePlan,
      productionUnlockReady: true,
      unsafeResidualClaim: true
    }
  };
  const downstreamPlanUnlockClaimZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: downstreamPlanUnlockClaimEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const downstreamPlanUnlockClaimImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${downstreamPlanUnlockClaimZipBytes.toString("base64")}`
  });
  assert(downstreamPlanUnlockClaimImported.ok === true, "runbook result can be ok even when OpenCAMLib downstream plan claims production unlock");
  assert(downstreamPlanUnlockClaimImported.productionSafe === false, "OpenCAMLib downstream evidence plan must not make runbook production-safe by itself");
  assert(downstreamPlanUnlockClaimImported.linuxEvidence?.status === "blocked-evidence-chain", `OpenCAMLib downstream plan unlock claim should block Linux evidence, got ${downstreamPlanUnlockClaimImported.linuxEvidence?.status}`);
  assert(downstreamPlanUnlockClaimImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.downstreamEvidencePlan.productionUnlockReady" && issue.actual === true), "OpenCAMLib downstream production unlock claim should be exposed");
  assert(downstreamPlanUnlockClaimImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.downstreamEvidencePlan.unsafeResidualClaim" && issue.actual === true), "OpenCAMLib downstream unsafe residual claim should be exposed");

  const machineFitComponentMismatchEvidenceChain = createClosedLoopEvidenceChainFixture();
  machineFitComponentMismatchEvidenceChain.openCamLib = {
    ...machineFitComponentMismatchEvidenceChain.openCamLib,
    candidateMachineFit: {
      ...machineFitComponentMismatchEvidenceChain.openCamLib.candidateMachineFit,
      level: "critical",
      riskCounts: {
        ...(machineFitComponentMismatchEvidenceChain.openCamLib.candidateMachineFit.riskCounts ?? {}),
        holdZonePointCount: 2,
        deepPointCount: 1,
        invalidPointCount: 1,
        missingRotaryCount: 3
      },
      checks: {
        ...(machineFitComponentMismatchEvidenceChain.openCamLib.candidateMachineFit.checks ?? {}),
        rotaryCoordinatePresent: false,
        protectedZoneClean: false,
        depthWithinLimit: false
      }
    }
  };
  const machineFitComponentMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: machineFitComponentMismatchEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const machineFitComponentMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${machineFitComponentMismatchZipBytes.toString("base64")}`
  });
  assert(machineFitComponentMismatchImported.ok === true, "runbook result can be ok even when OpenCAMLib machine fit is not ready");
  assert(machineFitComponentMismatchImported.productionSafe === false, "OpenCAMLib machine fit mismatches must prevent productionSafe runbook summary");
  assert(machineFitComponentMismatchImported.linuxEvidence?.status === "blocked-evidence-chain", `machine fit mismatch should block Linux evidence, got ${machineFitComponentMismatchImported.linuxEvidence?.status}`);
  assert(machineFitComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.candidateMachineFit.level" && issue.actual === "critical"), "OpenCAMLib machine fit level mismatch should be exposed");
  assert(machineFitComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.candidateMachineFit.checks.rotaryCoordinatePresent" && issue.actual === false), "OpenCAMLib missing rotary coordinate should be exposed");
  assert(machineFitComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.candidateMachineFit.checks.protectedZoneClean" && issue.actual === false), "OpenCAMLib protected-zone machine fit mismatch should be exposed");
  assert(machineFitComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "openCamLib.candidateMachineFit.riskCounts.missingRotaryCount" && issue.actual === 3), "OpenCAMLib missing rotary risk count should be exposed");

  const camoticsComponentMismatchEvidenceChain = createClosedLoopEvidenceChainFixture();
  camoticsComponentMismatchEvidenceChain.camotics = {
    ...camoticsComponentMismatchEvidenceChain.camotics,
    productionEvidenceEligible: false,
    upstreamEvidenceStatus: "mismatch",
    upstreamMaterialReadinessStatus: "review",
    upstreamMaterialReadyForSimulation: false,
    upstreamMaterialUnsafeProductionClaim: true,
    upstreamEvidence: {
      ...camoticsComponentMismatchEvidenceChain.camotics.upstreamEvidence,
      candidatePackageValidationBound: false,
      candidatePackageBundleBound: false,
      materialRemovalReadiness: {
        ...camoticsComponentMismatchEvidenceChain.camotics.upstreamEvidence.materialRemovalReadiness,
        status: "mismatch",
        unsafeProductionClaim: true
      }
    }
  };
  const camoticsComponentMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: camoticsComponentMismatchEvidenceChain,
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const camoticsComponentMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${camoticsComponentMismatchZipBytes.toString("base64")}`
  });
  assert(camoticsComponentMismatchImported.ok === true, "runbook result can be ok even when CAMotics component summaries are not ready");
  assert(camoticsComponentMismatchImported.productionSafe === false, "CAMotics component mismatches must prevent productionSafe runbook summary");
  assert(camoticsComponentMismatchImported.linuxEvidence?.status === "blocked-evidence-chain", `CAMotics component mismatch should block Linux evidence, got ${camoticsComponentMismatchImported.linuxEvidence?.status}`);
  assert(camoticsComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "camotics.productionEvidenceEligible" && issue.actual === false), "CAMotics production evidence eligibility mismatch should be exposed");
  assert(camoticsComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "camotics.upstreamEvidenceStatus" && issue.actual === "mismatch"), "CAMotics upstream evidence mismatch should be exposed");
  assert(camoticsComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "camotics.upstreamMaterialUnsafeProductionClaim" && issue.actual === true), "CAMotics unsafe production claim should be exposed");
  assert(camoticsComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "camotics.upstreamEvidence.candidatePackageValidationBound" && issue.actual === false), "CAMotics candidate package validation binding mismatch should be exposed");
  assert(camoticsComponentMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.status === "component-not-ready" && issue.field === "camotics.upstreamEvidence.materialRemovalReadiness.unsafeProductionClaim" && issue.actual === true), "CAMotics material readiness unsafe production claim should be exposed");

  const schemaMismatchZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "wrong.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "wrong.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const schemaMismatchImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${schemaMismatchZipBytes.toString("base64")}`
  });
  assert(schemaMismatchImported.ok === true, "runbook result can be ok even when Linux evidence file schemas are wrong");
  assert(schemaMismatchImported.productionSafe === false, "Linux evidence schema mismatch must prevent productionSafe runbook summary");
  assert(schemaMismatchImported.linuxEvidence?.status === "invalid-linux-evidence", `schema mismatch should mark Linux evidence invalid, got ${schemaMismatchImported.linuxEvidence?.status}`);
  assert(schemaMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "native-cam-closed-loop-check" && issue.status === "schema-mismatch"), "closed-loop schema mismatch should be reported");
  assert(schemaMismatchImported.linuxEvidence?.validationIssues?.some((issue) => issue.id === "camotics-result-local-validation" && issue.status === "schema-mismatch"), "CAMotics local validation schema mismatch should be reported");

  const duplicateEvidenceZipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "nested/native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: false,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: [{ id: "duplicate-shadow", ok: false }]
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) }
  ]);
  const duplicateEvidenceImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${duplicateEvidenceZipBytes.toString("base64")}`
  });
  assert(duplicateEvidenceImported.ok === true, "runbook result can be ok even when Linux evidence ZIP has duplicate basenames");
  assert(duplicateEvidenceImported.productionSafe === false, "duplicate Linux evidence basenames must prevent productionSafe runbook summary");
  assert(duplicateEvidenceImported.linuxEvidence?.status === "invalid-linux-evidence", `duplicate evidence should mark Linux evidence invalid, got ${duplicateEvidenceImported.linuxEvidence?.status}`);
  assert(duplicateEvidenceImported.linuxEvidence?.validationIssues?.some((issue) => issue.filename === "native-cam-closed-loop-check.json" && issue.status === "duplicate-basename"), "duplicate closed-loop evidence filename should be reported");
  assert(duplicateEvidenceImported.linuxEvidence?.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && file.duplicateCount === 2), "duplicate evidence summary should expose duplicate count");

  const zipBytes = createZip([
    { name: "v3-acceptance-runbook-result.json", content: JSON.stringify(zipResult, null, 2) },
    { name: "native-cam-closed-loop-check.json", content: JSON.stringify({
      schema: "hediao3d.native-cam-closed-loop-check.v1",
      ok: true,
      productionLocked: true,
      evidenceChain: createClosedLoopEvidenceChainFixture(),
      steps: []
    }, null, 2) },
    { name: "camotics-result-local-validation.json", content: JSON.stringify({
      schema: "hediao3d.camotics-result-local-validation.v1",
      ok: true,
      productionEvidenceEligible: true,
      level: "ready"
    }, null, 2) },
    { name: "README-RUNBOOK-RESULT.md", content: "HeDiao3D V3 runbook result bundle\n" }
  ]);
  const zipImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result-bundle.zip",
    resultZipDataUrl: `data:application/zip;base64,${zipBytes.toString("base64")}`
  });
  assert(zipImported.ok === true, "zip imported runbook result should be ok");
  assert(zipImported.identityValid === true, "zip imported runbook result should be identity-valid");
  assert(zipImported.runbookReviewSafe === true, "zip imported all-pass result should be review-safe as Linux evidence");
  assert(zipImported.productionSafe === false, "zip imported all-pass result must not be production-safe until production unlock evidence is complete");
  assert(/review-safe|review evidence|production remains locked/i.test(zipImported.productionSafeReason ?? ""), "zip imported result should explain review-safe vs production-safe boundary");
  assert(zipImported.linuxEvidence?.status === "ready-for-review", `zip import should expose Linux evidence, got ${zipImported.linuxEvidence?.status}`);
  assert(zipImported.linuxEvidence?.requiredFoundCount === 2, "zip import should count required Linux evidence files");
  assert(zipImported.apiArtifacts?.linuxEvidence?.endsWith("v3-acceptance-runbook-linux-evidence.json"), "zip import should expose Linux evidence artifact");
  assert(zipImported.apiArtifacts?.zipBundle?.endsWith("imported-v3-acceptance-runbook-result-bundle.zip"), "zip import should expose preserved source bundle");
  const linuxEvidenceArtifact = await getJson(zipImported.apiArtifacts.linuxEvidence);
  assert(linuxEvidenceArtifact.schema === "hediao3d.v3-runbook-linux-evidence.v1", "Linux evidence artifact schema mismatch");
  const closedLoopEvidenceFile = linuxEvidenceArtifact.files?.find((file) => file.filename === "native-cam-closed-loop-check.json");
  const camoticsValidationEvidenceFile = linuxEvidenceArtifact.files?.find((file) => file.filename === "camotics-result-local-validation.json");
  assert(/^[a-f0-9]{64}$/.test(closedLoopEvidenceFile?.sha256 ?? ""), "Linux evidence should hash closed-loop check JSON");
  assert(/^[a-f0-9]{64}$/.test(camoticsValidationEvidenceFile?.sha256 ?? ""), "Linux evidence should hash CAMotics local validation JSON");
  assert(linuxEvidenceArtifact.evidenceChain?.schema === "hediao3d.native-cam-linux-evidence-chain.v1", "Linux evidence should expose closed-loop evidence chain");
  assert(linuxEvidenceArtifact.evidenceChain?.crossChecks?.materialRemovalBoundToUpstreamCam === true, "Linux evidence chain should preserve CAMotics upstream binding");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.contactPathCoverage?.status === "ready", "Linux evidence chain should preserve OpenCAMLib path coverage summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.protectedZones?.status === "ready", "Linux evidence chain should preserve OpenCAMLib protected-zone summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.protectedZonesReady === true, "Linux evidence chain should expose ready protected-zone flag");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackageBlockedReason === null, "Linux evidence chain should preserve candidate package blocked reason");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionCandidatePromotion?.status === "production-candidate-ready", "Linux evidence chain should preserve OpenCAMLib promotion audit");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionCandidatePromotion?.productionUnlockReady === false, "Linux evidence chain should preserve promotion production lock");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionGapReview?.schema === "hediao3d.opencamlib-production-gap-review.v1", "Linux evidence chain should preserve OpenCAMLib production gap review");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionGapReview?.productionCandidateReady === true, "Linux evidence chain should preserve production gap review candidate readiness");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionGapReview?.downstreamProductionEvidenceReady === false, "Linux evidence chain should preserve downstream production evidence boundary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.productionGapReview?.productionUnlockReady === false, "Linux evidence chain should preserve production unlock boundary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.downstreamEvidencePlan?.schema === "hediao3d.opencamlib-downstream-evidence-plan.v1", "Linux evidence chain should preserve OpenCAMLib downstream evidence plan");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.downstreamEvidencePlan?.productionUnlockReady === false, "Linux evidence chain should preserve downstream evidence production lock");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.downstreamEvidencePlan?.gates?.some((gate) => gate.id === "air-run-evidence" && gate.status === "needs-field-evidence"), "Linux evidence chain should preserve downstream air-run gate");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.filename === "opencamlib-candidate-package-validation.json", "Linux evidence chain should preserve candidate package validation file summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.level === "ready", "Linux evidence chain should preserve candidate package validation level");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.generatedArtifacts?.status === "matched", "Linux evidence chain should preserve OpenCAMLib candidate package generated-artifact status");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.generatedArtifacts?.bundleShaMatches === true, "Linux evidence chain should preserve OpenCAMLib candidate package bundle generated-artifact match");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.materialRemovalReadiness?.unsafeProductionClaim === false, "Linux evidence chain should preserve OpenCAMLib unsafe residual claim flag");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.materialRemovalReadiness?.residualProofSource?.ready === true, "Linux evidence chain should preserve OpenCAMLib bound residual proof source");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidateMachineFit?.level === "ok", "Linux evidence chain should preserve OpenCAMLib candidate machine-fit level");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidateMachineFit?.targetMachine?.rotaryOutputAxis === "Y", "Linux evidence chain should preserve machine-fit rotary axis");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidateMachineFit?.coverage?.rotarySpanDeg === 360, "Linux evidence chain should preserve machine-fit rotary coverage");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageValidationBound === true, "Linux evidence chain should preserve CAMotics binding to candidate package validation");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageBundleBound === true, "Linux evidence chain should preserve CAMotics binding to candidate package bundle");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackage?.status === "matched", "Linux evidence chain should preserve CAMotics candidate package generated-artifact status");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackage?.bundleShaMatches === true, "Linux evidence chain should preserve CAMotics candidate package bundle generated-artifact match");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamMaterialReadinessStatus === "matched", "Linux evidence chain should preserve CAMotics upstream material readiness status");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamMaterialReadyForSimulation === true, "Linux evidence chain should preserve CAMotics upstream material simulation readiness");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamMaterialResidualEvidenceReady === false, "Linux evidence chain should preserve residual production boundary");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.status === "matched", "Linux evidence chain should preserve material readiness detail");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.unsafeProductionClaim === false, "Linux evidence chain should preserve CAMotics upstream unsafe residual claim flag");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.residualProofSource?.ready === true, "Linux evidence chain should preserve CAMotics upstream residual proof source");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.matchedCount === 4, "Linux evidence chain should preserve CAMotics upstream matched file count");
  assert(linuxEvidenceArtifact.evidenceChain?.crossChecks?.camoticsUpstreamMaterialReadinessMatched === true, "Linux evidence chain should preserve material readiness cross-check");
  assert(linuxEvidenceArtifact.evidenceChain?.crossChecks?.candidatePackageStep === "pass", "Linux evidence chain should preserve candidate package validation step");
  assert(linuxEvidenceArtifact.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && file.status === "imported"), "Linux evidence should preserve closed-loop check");
  assert(linuxEvidenceArtifact.files?.some((file) => file.filename === "camotics-result-local-validation.json" && file.status === "imported"), "Linux evidence should preserve CAMotics validation");
  const zipImportAudit = await getJson(zipImported.apiArtifacts.importJson);
  assert(zipImportAudit.linuxEvidence?.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && /^[a-f0-9]{64}$/.test(file.sha256 ?? "")), "runbook import audit should hash closed-loop check JSON");
  assert(zipImportAudit.linuxEvidence?.files?.some((file) => file.filename === "camotics-result-local-validation.json" && /^[a-f0-9]{64}$/.test(file.sha256 ?? "")), "runbook import audit should hash CAMotics local validation JSON");

  const latest = await getJson("/api/orchestrator/readiness/runbook-result/latest");
  assert(latest.latest?.readinessReportId === readiness.id, "latest runbook result should point to imported readiness id");
  assert(latest.latest.identityValid === true, "latest runbook result should remain identity-valid");
  assert(latest.latest.ok === true, "latest runbook result should be the zip all-pass import");
  assert(latest.latest.runbookReviewSafe === true, "latest runbook result should preserve review-safe Linux evidence status");
  assert(latest.latest.productionSafe === false, "latest runbook result should preserve production lock boundary");
  assert(/review-safe|review evidence|production remains locked/i.test(latest.latest.productionSafeReason ?? ""), "latest runbook result should explain production lock boundary");
  assert(latest.latest.linuxEvidence?.status === "ready-for-review", "latest runbook result should preserve Linux evidence summary");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidenceStatus === "matched", "latest runbook result should summarize CAMotics upstream evidence status");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.contactPathCoverage?.status === "ready", "latest runbook result should summarize OpenCAMLib path coverage");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.protectedZones?.status === "ready", "latest runbook result should summarize OpenCAMLib protected zones");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.candidatePackage?.exists === true, "latest runbook result should summarize OpenCAMLib candidate package file");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.candidatePackage?.generatedArtifacts?.bundleShaMatches === true, "latest runbook result should summarize OpenCAMLib candidate package generated-artifact binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.materialRemovalReadiness?.unsafeProductionClaim === false, "latest runbook result should summarize OpenCAMLib unsafe residual claim flag");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.materialRemovalReadiness?.residualProofSource?.ready === true, "latest runbook result should summarize OpenCAMLib residual proof source");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.productionCandidatePromotion?.productionCandidateReady === true, "latest runbook result should summarize OpenCAMLib promotion audit");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.productionGapReview?.productionCandidateReady === true, "latest runbook result should summarize OpenCAMLib production gap review");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.productionGapReview?.downstreamProductionEvidenceReady === false, "latest runbook result should preserve downstream production evidence boundary");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.productionGapReview?.productionUnlockReady === false, "latest runbook result should preserve production unlock boundary");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.downstreamEvidencePlan?.status === "candidate-ready-material-removal-required", "latest runbook result should summarize downstream evidence plan status");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.downstreamEvidencePlan?.productionUnlockReady === false, "latest runbook result should preserve downstream evidence production lock");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.candidateMachineFit?.level === "ok", "latest runbook result should summarize OpenCAMLib candidate machine-fit");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.candidateMachineFit?.riskCounts?.missingRotaryCount === 0, "latest runbook result should summarize machine-fit risk counts");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageValidationBound === true, "latest runbook result should summarize CAMotics candidate package validation binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageBundleBound === true, "latest runbook result should summarize CAMotics candidate package bundle binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.candidatePackage?.bundleShaMatches === true, "latest runbook result should summarize CAMotics candidate package generated-artifact binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamMaterialReadinessStatus === "matched", "latest runbook result should summarize CAMotics material readiness");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamMaterialReadyForSimulation === true, "latest runbook result should summarize material simulation readiness");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.status === "matched", "latest runbook result should summarize material readiness detail");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.unsafeProductionClaim === false, "latest runbook result should summarize material readiness unsafe claim flag");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.residualProofSource?.ready === true, "latest runbook result should summarize upstream residual proof source");
  assert(latest.latest.linuxEvidence?.evidenceChain?.crossChecks?.candidatePackageStep === "pass", "latest runbook result should summarize OpenCAMLib candidate package validation step");
  assert(latest.latest.linuxEvidence?.evidenceChain?.crossChecks?.camoticsUpstreamMaterialReadinessMatched === true, "latest runbook result should summarize material readiness cross-check");
  assert(latest.latest.linuxEvidence?.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && file.sha256 === closedLoopEvidenceFile.sha256), "latest runbook result should preserve closed-loop file hash");
  assert(latest.latest.linuxEvidence?.files?.some((file) => file.filename === "camotics-result-local-validation.json" && file.sha256 === camoticsValidationEvidenceFile.sha256), "latest runbook result should preserve CAMotics local validation file hash");

  const readinessAfterImport = await postJson("/api/orchestrator/readiness", {});
  assert(readinessAfterImport.runbookResult?.readinessReportId === readiness.id, "readiness should include latest imported runbook result");
  assert(readinessAfterImport.runbookResult?.identityValid === true, "readiness should see identity-valid runbook result");
  assert(readinessAfterImport.runbookResult?.runbookReviewSafe === true, "readiness should preserve runbook review-safe flag");
  assert(readinessAfterImport.runbookResult?.productionSafe === false, "readiness should preserve production lock boundary from runbook result");
  assert(/review-safe|review evidence|production remains locked/i.test(readinessAfterImport.runbookResult?.productionSafeReason ?? ""), "readiness should preserve production-safe explanation");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.openCamLib?.candidatePackage?.generatedArtifacts?.bundleShaMatches === true, "readiness should preserve OpenCAMLib candidate package generated-artifact binding");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.openCamLib?.materialRemovalReadiness?.unsafeProductionClaim === false, "readiness should preserve OpenCAMLib unsafe residual claim flag");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.openCamLib?.materialRemovalReadiness?.residualProofSource?.ready === true, "readiness should preserve OpenCAMLib residual proof source");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.openCamLib?.productionGapReview?.productionUnlockReady === false, "readiness should preserve production unlock boundary from Linux evidence");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.openCamLib?.downstreamEvidencePlan?.productionUnlockReady === false, "readiness should preserve downstream evidence production lock from Linux evidence");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.camotics?.upstreamMaterialReadinessStatus === "matched", "readiness should preserve runbook material readiness status");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.evidenceChain?.camotics?.upstreamMaterialReadyForSimulation === true, "readiness should preserve runbook material simulation readiness");
  assert(readinessAfterImport.runbookResult?.linuxEvidence?.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && file.sha256 === closedLoopEvidenceFile.sha256), "readiness should preserve runbook closed-loop file hash");
  assert(readinessAfterImport.gates.allowProductionNc === false, "runbook import alone must not unlock production NC");

  console.log(JSON.stringify({
    ok: true,
    readinessId: readiness.id,
    failedImport: imported.failedCount,
    zipImportOk: zipImported.ok,
    latestReviewSafe: latest.latest.runbookReviewSafe,
    latestProductionSafe: latest.latest.productionSafe,
    readinessLevel: readinessAfterImport.level,
    production: readinessAfterImport.gates.allowProductionNc
  }, null, 2));
}

function createClosedLoopEvidenceChainFixture() {
  return {
    schema: "hediao3d.native-cam-linux-evidence-chain.v1",
    status: "ready-or-awaiting-inputs",
    nativeCam: {
      level: "ready",
      productionCandidateCount: 1,
      sourceReportBindingStatus: "matched",
      targetMachineBoundaryStatus: "matched",
      contactValidationStatus: "ready"
    },
    openCamLib: {
      realCandidateKnown: true,
      realCandidateReady: true,
      productionLocked: true,
      firstBlocking: null,
      contactPathCoverage: {
        schema: "hediao3d.opencamlib-contact-path-coverage-summary.v1",
        required: true,
        status: "ready",
        ready: true,
        x: { id: "contact-path-coverage-x", status: "pass", summary: "xCoverageRatio=1" },
        cross: { id: "contact-path-coverage-cross", status: "pass", summary: "crossCoverageRatio=1" },
        summary: "OpenCAMLib path coverage checks passed."
      },
      protectedZones: {
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
      },
      protectedZonesReady: true,
      candidatePackageLevel: "ready",
      candidatePackageReadyForImport: true,
      candidatePackageBlockedReason: null,
      productionCandidatePromotion: {
        schema: "hediao3d.opencamlib-production-candidate-promotion.v1",
        status: "production-candidate-ready",
        productionCandidateReady: true,
        productionUnlockReady: false,
        evidenceClass: "production-candidate",
        criterionCount: 22,
        passedCount: 22,
        blockingCount: 0,
        firstBlockingCriterion: null,
        nextActions: ["Continue material-removal and field validation."],
        productionBoundary: "This promotion audit never unlocks production NC by itself."
      },
      productionGapReview: {
        schema: "hediao3d.opencamlib-production-gap-review.v1",
        level: "candidate-ready-for-downstream-evidence",
        productionCandidateReady: true,
        downstreamProductionEvidenceReady: false,
        productionUnlockReady: false,
        criticalCount: 0,
        reviewCount: 0,
        productionBlockerCount: 1,
        gapCount: 1,
        topGaps: [
          {
            id: "production-residual-not-closed",
            layer: "residual-gouge",
            severity: "production-blocker",
            status: "needs-downstream-evidence",
            summary: "Residual/gouge production evidence is not closed."
          }
        ],
        nextActions: ["Continue CAMotics/material-removal plus field validation."],
        productionBoundary: "This review never unlocks production NC by itself."
      },
      downstreamEvidencePlan: {
        schema: "hediao3d.opencamlib-downstream-evidence-plan.v1",
        status: "candidate-ready-material-removal-required",
        productionUnlockReady: false,
        candidateReady: true,
        materialSimulationReady: true,
        residualClosed: false,
        unsafeResidualClaim: false,
        gateCount: 4,
        openGateCount: 3,
        gates: [
          {
            id: "opencamlib-candidate-import",
            title: "OpenCAMLib production-candidate import",
            status: "pass",
            summary: "Candidate can enter HeDiao3D import review."
          },
          {
            id: "material-removal-simulation",
            title: "CAMotics/equivalent material-removal simulation",
            status: "ready-to-run",
            summary: "Material-removal simulation is ready to run."
          },
          {
            id: "residual-gouge-validation",
            title: "Measured or swept-volume residual/gouge validation",
            status: "needs-evidence",
            summary: "Residual proof remains open."
          },
          {
            id: "air-run-evidence",
            title: "Rotary calibration and full air-run evidence",
            status: "needs-field-evidence",
            summary: "Field air-run evidence remains open."
          }
        ],
        nextUploads: ["native-cam-real-output-bundle.zip", "camotics-result-bundle.zip", "air-run evidence"],
        productionBoundary: "This plan does not unlock production NC by itself."
      },
      candidatePackage: {
        filename: "opencamlib-candidate-package-validation.json",
        exists: true,
        schema: "hediao3d.opencamlib-candidate-package-validation.v1",
        level: "ready",
        status: null,
        ok: null,
        sha256: "candidate-package-fixture-sha",
        readyForImport: true,
        generatedArtifacts: {
          schema: "hediao3d.opencamlib-candidate-generated-artifacts-summary.v1",
          status: "matched",
          bundleShaMatches: true,
          validationReportContentSha256: "candidate-package-report-content-sha",
          candidatePackageBundleSha256: "candidate-package-bundle-sha",
          actualBundleSha256: "candidate-package-bundle-sha",
          bundleExists: true,
          summary: "OpenCAMLib candidate package report is bound to the local candidate package bundle sha256."
        }
      },
      materialRemovalReadiness: {
        schema: "hediao3d.opencamlib-material-removal-readiness.v1",
        level: "ready-for-camotics-or-equivalent",
        readyForMaterialRemovalSimulation: true,
        productionResidualEvidenceReady: false,
        unsafeProductionClaim: false,
        residualProofSource: createResidualProofSourceFixture(),
        missingForProduction: ["residual-stock-map", "verified-material-removal-volume"],
        summary: "Fixture OpenCAMLib candidate can feed downstream material-removal simulation, but production residual evidence remains open."
      },
      candidateMachineFit: {
        schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
        level: "ok",
        summary: "neutral output matches the target rotary-Y machine boundary for pre-import review.",
        targetMachine: {
          controllerClass: "3axis-controller-with-rotary-fixture",
          rotaryOutputAxis: "Y",
          wrapPerRevolutionMm: 100,
          toolProfileId: "vflat-4mm-25deg"
        },
        coverage: {
          pointCount: 231,
          finitePointCount: 231,
          xSpanMm: 20,
          rotarySampleCount: 33,
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
      }
    },
    camotics: {
      productionEvidenceEligible: true,
      upstreamEvidenceRequired: true,
      upstreamEvidenceStatus: "matched",
      upstreamMaterialReadinessStatus: "matched",
      upstreamMaterialReadyForSimulation: true,
      upstreamMaterialResidualEvidenceReady: false,
      upstreamEvidence: {
        required: true,
        status: "matched",
        source: "camotics-result-local-validation.json",
        expectedCount: 4,
        importedCount: 4,
        matchedCount: 4,
        mismatchCount: 0,
        candidatePackageValidationBound: true,
        candidatePackageBundleBound: true,
        candidatePackage: {
          schema: "hediao3d.opencamlib-candidate-package-summary.v1",
          status: "matched",
          level: "ready",
          readyForImport: true,
          productionCandidateReady: true,
          bundleShaMatches: true,
          validationReportContentSha256: "candidate-package-report-content-sha",
          candidatePackageBundleSha256: "candidate-package-bundle-sha",
          actualBundleSha256: "candidate-package-bundle-sha",
          summary: "Fixture OpenCAMLib candidate package report and bundle generated-artifact identity match."
        },
        materialRemovalReadiness: {
          required: true,
          status: "matched",
          level: "ready-for-camotics-or-equivalent",
          readyForMaterialRemovalSimulation: true,
          productionResidualEvidenceReady: false,
          unsafeProductionClaim: false,
          residualProofSource: createResidualProofSourceFixture(),
          missingForProduction: ["residual-stock-map", "verified-material-removal-volume"],
          summary: "Fixture upstream material readiness is ready for CAMotics/equivalent simulation."
        },
        files: [
          { key: "opencamlibRealCandidateRun", filename: "opencamlib-real-candidate-run.json", matched: true, expectedSha256: "real-candidate-sha", importedSha256: "real-candidate-sha" },
          { key: "opencamlibContactValidation", filename: "opencamlib-contact-output-validation.json", matched: true, expectedSha256: "contact-validation-sha", importedSha256: "contact-validation-sha" },
          { key: "opencamlibCandidatePackageValidation", filename: "opencamlib-candidate-package-validation.json", matched: true, expectedSha256: "candidate-package-validation-sha", importedSha256: "candidate-package-validation-sha" },
          { key: "opencamlibCandidatePackageBundle", filename: "opencamlib-candidate-package-bundle.zip", matched: true, expectedSha256: "candidate-package-bundle-sha", importedSha256: "candidate-package-bundle-sha" }
        ]
      }
    },
    crossChecks: {
      nativeRealOutputStep: "pass",
      camoticsValidationStep: "pass",
      candidatePackageStep: "pass",
      camoticsUpstreamEvidenceMatched: true,
      camoticsUpstreamMaterialReadinessMatched: true,
      materialRemovalBoundToUpstreamCam: true
    },
    blocking: []
  };
}

function createResidualProofSourceFixture() {
  return {
    schema: "hediao3d.opencamlib-bound-residual-proof-source.v1",
    status: "bound",
    ready: true,
    proofStatus: "production-residual-proof-bound",
    localValidationOk: true,
    productionResidualEvidenceReady: true,
    unsafeProductionClaim: false,
    upstreamStatus: "matched",
    upstreamCandidatePackageStatus: "matched"
  };
}

function createRunbookResultFixture(readiness, passing) {
  const readinessCreatedAt = readiness.createdAt;
  const runbookGeneratedAt = readiness.createdAt;
  const createdAt = new Date(Date.parse(readiness.createdAt) + 1000).toISOString();
  const steps = [
    {
      id: "native-cam-readiness",
      title: "Native CAM 环境验收",
      statusAtReport: "blocked",
      blocksProduction: true,
      evidence: ["native-cam-readiness.json"],
      command: "npm run test:v3:native-cam",
      exitCode: passing ? 0 : 1,
      ok: passing
    },
    {
      id: "v3-small-loop",
      title: "V3 小闭环",
      statusAtReport: "review",
      blocksProduction: false,
      evidence: ["production-gate.json"],
      command: "npm run test:v3",
      exitCode: 0,
      ok: true
    }
  ];
  const failed = steps.filter((step) => !step.ok);
  const blockingFailed = failed.filter((step) => step.blocksProduction);
  return {
    schema: "hediao3d.v3-acceptance-runbook-result.v1",
    readinessReportId: readiness.id,
    readinessCreatedAt,
    runbookGeneratedAt,
    createdAt,
    levelAtReport: readiness.level,
    acceptanceAtReport: `${readiness.acceptancePlan?.completed ?? 0}/${readiness.acceptancePlan?.total ?? 0}`,
    commandCount: steps.length,
    blockingStepCountAtReport: steps.filter((step) => step.blocksProduction).length,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      apiBase: baseUrl
    },
    exitCode: failed.length ? 1 : 0,
    ok: failed.length === 0,
    failedCount: failed.length,
    blockingFailedCount: blockingFailed.length,
    productionSafe: failed.length === 0 && blockingFailed.length === 0,
    failedSteps: failed.map((step) => ({
      id: step.id,
      title: step.title,
      exitCode: step.exitCode,
      blocksProduction: step.blocksProduction
    })),
    steps
  };
}

function createZip(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes
    ]);
    chunks.push(localHeader, data);
    const centralHeader = Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes
    ]);
    centralDirectory.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralSize),
    uint32(centralOffset),
    uint16(0)
  ]);
  return Buffer.concat([...chunks, ...centralDirectory, endRecord]);
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff, 0);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function postJsonAllowingStatus(path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.status === expectedStatus, `${path} expected ${expectedStatus}, got ${response.status}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
