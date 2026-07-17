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
  assert(imported.sourceReportSha256 === validationReportSha256, "imported acceptance should expose source report hash");
  assert(imported.apiArtifacts?.json?.includes("native-cam-real-output-acceptance.json"), "imported acceptance should expose JSON artifact");

  const artifact = await getJson(imported.apiArtifacts.json);
  assert(artifact.importSource?.sourceName === "native-cam-real-output-acceptance.json", "artifact should preserve import source name");
  assert(artifact.adapters?.some((adapter) => adapter.classification === "production-candidate"), "artifact should preserve production-candidate classification");
  assert(artifact.sourceReportBinding?.status === "matched", "artifact should preserve source report binding");

  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.nativeCamRealOutputAcceptance, "readiness should include imported native CAM real output acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.id === imported.id, "readiness should pick latest imported acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.level === "ready", "readiness should preserve acceptance level");
  assert(readiness.nativeCamRealOutputAcceptance.sourceReportBindingStatus === "matched", "readiness should expose matched source report binding");
  assert(readiness.acceptancePlan?.steps?.some((step) => step.id === "native-cam-real-output-acceptance"), "readiness plan should include real output acceptance step");
  assert(readiness.gates?.blockers?.some((item) => /真实输出验收为 ready.*handoff 审计仍不一致/.test(item)), "readiness should block inconsistent real-output acceptance and adapter handoff audit");
  assert(readiness.postprocessHandoffReadiness?.status === "blocked", `readiness should block production candidate CAM evidence without neutral postprocess handoff, got ${readiness.postprocessHandoffReadiness?.status}`);
  assert(readiness.gates?.blockers?.some((item) => /Y\/A 旋转夹具后处理/.test(item)), "readiness should explain missing self-developed rotary fixture postprocess handoff");
  if (!readiness.camoticsImport || !readiness.camoticsImport.productionEvidenceEligible) {
    assert(readiness.gates?.blockers?.some((item) => /真实 CAM 生产候选证据.*CAMotics/.test(item)), "readiness should block production candidate CAM evidence without eligible CAMotics material-removal evidence");
  }

  console.log(JSON.stringify({
    ok: true,
    importId: imported.id,
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

function createAcceptanceFixture(sourceReportSha256) {
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
