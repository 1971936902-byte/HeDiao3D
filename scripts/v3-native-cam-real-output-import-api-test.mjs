#!/usr/bin/env node
import { createHash } from "node:crypto";

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

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
  assert(imported.apiArtifacts?.json?.includes("native-cam-real-output-acceptance.json"), "imported acceptance should expose JSON artifact");

  const artifact = await getJson(imported.apiArtifacts.json);
  assert(artifact.importSource?.sourceName === "native-cam-real-output-acceptance.json", "artifact should preserve import source name");
  assert(artifact.adapters?.some((adapter) => adapter.classification === "production-candidate"), "artifact should preserve production-candidate classification");
  assert(artifact.sourceReportBinding?.status === "matched", "artifact should preserve source report binding");
  assert(artifact.targetMachineBoundaryStatus?.status === "matched", "artifact should preserve target machine boundary status");
  assert(artifact.sourceReportSnapshot?.handoffClassificationAudit?.productionCandidateCount === 1, "artifact should preserve source report handoff audit snapshot");

  const missingBoundary = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance-missing-boundary.json",
    validationReport,
    acceptance: createAcceptanceFixture(validationReportSha256, { includeTargetMachineBoundary: false })
  });
  assert(missingBoundary.level === "review", "missing target machine boundary should downgrade ready acceptance to review");
  assert(missingBoundary.targetMachineBoundaryStatus?.status === "missing", "missing boundary import should expose missing status");

  const zipImported = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-bundle.zip",
    acceptanceZipDataUrl: toZipDataUrl({
      "native-cam-real-output-acceptance.json": JSON.stringify(createAcceptanceFixture(validationReportSha256), null, 2),
      "v3-external-adapter-validation.json": JSON.stringify(validationReport, null, 2)
    })
  });
  assert(zipImported.schema === "hediao3d.native-cam-real-output-acceptance.v1", "zip imported acceptance schema mismatch");
  assert(zipImported.sourceReportBindingStatus === "matched", "zip imported acceptance should bind validation report");
  assert(zipImported.targetMachineBoundaryStatus?.status === "matched", "zip import should preserve matched target boundary");
  assert(zipImported.apiArtifacts?.zipBundle?.includes("imported-native-cam-real-output-bundle.zip"), "zip import should expose source bundle artifact");
  const zipArtifact = await getJson(zipImported.apiArtifacts.json);
  assert(zipArtifact.importSource?.zipBundle === "imported-native-cam-real-output-bundle.zip", "zip import artifact should preserve source bundle filename");
  const zipImportReport = await getJson(zipImported.apiArtifacts.importJson);
  assert(zipImportReport.zipBundle === "imported-native-cam-real-output-bundle.zip", "zip import report should preserve source bundle filename");

  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.nativeCamRealOutputAcceptance, "readiness should include imported native CAM real output acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.id === zipImported.id, "readiness should pick latest imported acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.level === "ready", "readiness should preserve acceptance level");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportBindingStatus === "matched", "readiness should expose matched source report binding");
  assert(readiness.nativeCamRealOutputAcceptance.targetMachineBoundaryStatus?.status === "matched", "readiness should expose matched target machine boundary");
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

  console.log(JSON.stringify({
    ok: true,
    importId: zipImported.id,
    readinessId: readiness.id,
    level: readiness.nativeCamRealOutputAcceptance.level,
    candidates: readiness.nativeCamRealOutputAcceptance.productionCandidateCount
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
    ...(includeTargetMachineBoundary ? { targetMachineBoundary: createTargetMachineBoundaryFixture() } : {}),
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
