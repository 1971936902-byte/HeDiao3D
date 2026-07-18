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

  const zipResult = createRunbookResultFixture(readiness, true);
  const rawPassingImported = await postJson("/api/orchestrator/readiness/runbook-result", {
    sourceName: "v3-acceptance-runbook-result.json",
    result: zipResult
  });
  assert(rawPassingImported.ok === true, "raw all-pass runbook result should be ok");
  assert(rawPassingImported.linuxEvidence?.status === "missing-zip", "raw all-pass runbook result should report missing Linux evidence ZIP");
  assert(rawPassingImported.productionSafe === false, "raw all-pass runbook result without Linux evidence must not be production-safe");

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
  assert(zipImported.productionSafe === true, "zip imported all-pass result should be production-safe as a runbook result");
  assert(zipImported.linuxEvidence?.status === "ready-for-review", `zip import should expose Linux evidence, got ${zipImported.linuxEvidence?.status}`);
  assert(zipImported.linuxEvidence?.requiredFoundCount === 2, "zip import should count required Linux evidence files");
  assert(zipImported.apiArtifacts?.linuxEvidence?.endsWith("v3-acceptance-runbook-linux-evidence.json"), "zip import should expose Linux evidence artifact");
  assert(zipImported.apiArtifacts?.zipBundle?.endsWith("imported-v3-acceptance-runbook-result-bundle.zip"), "zip import should expose preserved source bundle");
  const linuxEvidenceArtifact = await getJson(zipImported.apiArtifacts.linuxEvidence);
  assert(linuxEvidenceArtifact.schema === "hediao3d.v3-runbook-linux-evidence.v1", "Linux evidence artifact schema mismatch");
  assert(linuxEvidenceArtifact.evidenceChain?.schema === "hediao3d.native-cam-linux-evidence-chain.v1", "Linux evidence should expose closed-loop evidence chain");
  assert(linuxEvidenceArtifact.evidenceChain?.crossChecks?.materialRemovalBoundToUpstreamCam === true, "Linux evidence chain should preserve CAMotics upstream binding");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.contactPathCoverage?.status === "ready", "Linux evidence chain should preserve OpenCAMLib path coverage summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.protectedZones?.status === "ready", "Linux evidence chain should preserve OpenCAMLib protected-zone summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.protectedZonesReady === true, "Linux evidence chain should expose ready protected-zone flag");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackageBlockedReason === null, "Linux evidence chain should preserve candidate package blocked reason");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.filename === "opencamlib-candidate-package-validation.json", "Linux evidence chain should preserve candidate package validation file summary");
  assert(linuxEvidenceArtifact.evidenceChain?.openCamLib?.candidatePackage?.level === "ready", "Linux evidence chain should preserve candidate package validation level");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageValidationBound === true, "Linux evidence chain should preserve CAMotics binding to candidate package validation");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageBundleBound === true, "Linux evidence chain should preserve CAMotics binding to candidate package bundle");
  assert(linuxEvidenceArtifact.evidenceChain?.camotics?.upstreamEvidence?.matchedCount === 4, "Linux evidence chain should preserve CAMotics upstream matched file count");
  assert(linuxEvidenceArtifact.evidenceChain?.crossChecks?.candidatePackageStep === "pass", "Linux evidence chain should preserve candidate package validation step");
  assert(linuxEvidenceArtifact.files?.some((file) => file.filename === "native-cam-closed-loop-check.json" && file.status === "imported"), "Linux evidence should preserve closed-loop check");
  assert(linuxEvidenceArtifact.files?.some((file) => file.filename === "camotics-result-local-validation.json" && file.status === "imported"), "Linux evidence should preserve CAMotics validation");

  const latest = await getJson("/api/orchestrator/readiness/runbook-result/latest");
  assert(latest.latest?.readinessReportId === readiness.id, "latest runbook result should point to imported readiness id");
  assert(latest.latest.identityValid === true, "latest runbook result should remain identity-valid");
  assert(latest.latest.ok === true, "latest runbook result should be the zip all-pass import");
  assert(latest.latest.linuxEvidence?.status === "ready-for-review", "latest runbook result should preserve Linux evidence summary");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidenceStatus === "matched", "latest runbook result should summarize CAMotics upstream evidence status");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.contactPathCoverage?.status === "ready", "latest runbook result should summarize OpenCAMLib path coverage");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.protectedZones?.status === "ready", "latest runbook result should summarize OpenCAMLib protected zones");
  assert(latest.latest.linuxEvidence?.evidenceChain?.openCamLib?.candidatePackage?.exists === true, "latest runbook result should summarize OpenCAMLib candidate package file");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageValidationBound === true, "latest runbook result should summarize CAMotics candidate package validation binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageBundleBound === true, "latest runbook result should summarize CAMotics candidate package bundle binding");
  assert(latest.latest.linuxEvidence?.evidenceChain?.crossChecks?.candidatePackageStep === "pass", "latest runbook result should summarize OpenCAMLib candidate package validation step");

  const readinessAfterImport = await postJson("/api/orchestrator/readiness", {});
  assert(readinessAfterImport.runbookResult?.readinessReportId === readiness.id, "readiness should include latest imported runbook result");
  assert(readinessAfterImport.runbookResult?.identityValid === true, "readiness should see identity-valid runbook result");
  assert(readinessAfterImport.runbookResult?.productionSafe === true, "readiness should preserve runbook productionSafe flag");
  assert(readinessAfterImport.gates.allowProductionNc === false, "runbook import alone must not unlock production NC");

  console.log(JSON.stringify({
    ok: true,
    readinessId: readiness.id,
    failedImport: imported.failedCount,
    zipImportOk: zipImported.ok,
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
      candidatePackage: {
        filename: "opencamlib-candidate-package-validation.json",
        exists: true,
        schema: "hediao3d.opencamlib-candidate-package-validation.v1",
        level: "ready",
        status: null,
        ok: null,
        sha256: "candidate-package-fixture-sha"
      }
    },
    camotics: {
      productionEvidenceEligible: true,
      upstreamEvidenceRequired: true,
      upstreamEvidenceStatus: "matched",
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
      materialRemovalBoundToUpstreamCam: true
    },
    blocking: []
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
