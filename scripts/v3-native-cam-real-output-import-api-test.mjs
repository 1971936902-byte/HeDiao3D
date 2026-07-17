#!/usr/bin/env node

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

  const imported = await postJson("/api/orchestrator/native-cam/real-output-acceptance", {
    sourceName: "native-cam-real-output-acceptance.json",
    acceptance: createAcceptanceFixture()
  });
  assert(imported.schema === "hediao3d.native-cam-real-output-acceptance.v1", "imported acceptance schema mismatch");
  assert(imported.level === "ready", `imported acceptance level mismatch: ${imported.level}`);
  assert(imported.productionCandidateCount === 1, "imported acceptance should report one production candidate");
  assert(imported.unsafeCount === 0, "imported acceptance should report zero unsafe outputs");
  assert(imported.apiArtifacts?.json?.includes("native-cam-real-output-acceptance.json"), "imported acceptance should expose JSON artifact");

  const artifact = await getJson(imported.apiArtifacts.json);
  assert(artifact.importSource?.sourceName === "native-cam-real-output-acceptance.json", "artifact should preserve import source name");
  assert(artifact.adapters?.some((adapter) => adapter.classification === "production-candidate"), "artifact should preserve production-candidate classification");

  const readiness = await postJson("/api/orchestrator/readiness", {});
  assert(readiness.nativeCamRealOutputAcceptance, "readiness should include imported native CAM real output acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.id === imported.id, "readiness should pick latest imported acceptance");
  assert(readiness.nativeCamRealOutputAcceptance.level === "ready", "readiness should preserve acceptance level");
  assert(readiness.acceptancePlan?.steps?.some((step) => step.id === "native-cam-real-output-acceptance"), "readiness plan should include real output acceptance step");
  assert(readiness.gates?.blockers?.some((item) => /真实输出验收为 ready.*handoff 审计仍不一致/.test(item)), "readiness should block inconsistent real-output acceptance and adapter handoff audit");

  console.log(JSON.stringify({
    ok: true,
    importId: imported.id,
    readinessId: readiness.id,
    level: readiness.nativeCamRealOutputAcceptance.level,
    candidates: readiness.nativeCamRealOutputAcceptance.productionCandidateCount
  }, null, 2));
}

function createAcceptanceFixture() {
  return {
    schema: "hediao3d.native-cam-real-output-acceptance.v1",
    createdAt: new Date().toISOString(),
    sourceReport: "public/orchestrator-adapter-validation/native-real-output-test/v3-external-adapter-validation.json",
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
