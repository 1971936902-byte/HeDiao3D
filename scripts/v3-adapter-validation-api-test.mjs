#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const run = await postJson("/api/orchestrator/adapter-validation", { native: false });
  validatePublicSummary(run, "POST /api/orchestrator/adapter-validation");
  assert(run.overall.generatedPlans === 4, `expected 4 generated plans, got ${run.overall.generatedPlans}`);
  assert(run.overall.failed === 0, `expected 0 failed adapters, got ${run.overall.failed}`);
  assert(run.nativeReadiness?.schema === "hediao3d.native-cam-readiness.v1", "POST summary missing native readiness report");
  assert(run.nativeReadiness.requiredCount === 4, `expected 4 native readiness adapters, got ${run.nativeReadiness.requiredCount}`);
  assert(run.productionGuardrails?.schema === "hediao3d.external-adapter-production-guardrails.v1", "POST summary missing production guardrails");
  assert(run.productionGuardrails.readyForProduction === false, "adapter validation guardrails must not mark production ready");
  assert(run.productionGuardrails.requiredCount >= 4, "adapter validation guardrails missing required checks");
  assert(run.handoffClassificationAudit?.schema === "hediao3d.adapter-handoff-classification-audit.v1", "POST summary missing handoff classification audit");
  assert(run.handoffClassificationAudit.readyForProduction === false, "handoff audit must not mark production ready");
  assert(run.handoffClassificationAudit.adapters?.length === 4, `expected 4 audited adapters, got ${run.handoffClassificationAudit.adapters?.length}`);
  assert(run.handoffClassificationAudit.productionCandidateCount === 0, "safe-default validation must not report production candidates");
  assert(run.handoffClassificationAudit.unsafeCount === 4, `safe-default validation should mark all adapters unsafe, got ${run.handoffClassificationAudit.unsafeCount}`);

  const latest = await getJson("/api/orchestrator/adapter-validation/latest");
  assert(latest.latest, "latest validation missing");
  validatePublicSummary(latest.latest, "GET /api/orchestrator/adapter-validation/latest");
  assert(Array.isArray(latest.validations), "validations list missing");
  assert(latest.validations.length > 0, "validations list empty");
  assert(JSON.stringify(latest.latest).length < 50000, "latest summary is too large for frontend polling");

  const artifactResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(artifactResponse.ok, `validation JSON artifact failed: ${artifactResponse.status}`);
  const artifact = await artifactResponse.json();
  assert(Array.isArray(artifact.adapters), "full validation artifact missing adapters");
  assert(artifact.adapters.some((adapter) => adapter.workDir), "full artifact should keep detailed adapter data");
  assert(artifact.nativeReadiness?.schema === "hediao3d.native-cam-readiness.v1", "full artifact missing native readiness report");
  assert(artifact.handoffClassificationAudit?.schema === "hediao3d.adapter-handoff-classification-audit.v1", "full artifact missing handoff classification audit");
  assert(artifact.handoffClassificationAudit.adapters?.every((adapter) => typeof adapter.classification === "string"), "full artifact audit adapters missing classifications");
  assert(artifact.productionGuardrails?.required?.some((item) => item.id === "camotics-input-identity"), "full artifact missing CAMotics input identity guardrail");
  assert(artifact.productionGuardrails?.required?.some((item) => item.evidence?.includes("rotary-calibration-airrun.nc")), "full artifact missing rotary calibration evidence guardrail");

  console.log(JSON.stringify({
    ok: true,
    validationId: run.id,
    generatedPlans: run.overall.generatedPlans,
    failed: run.overall.failed,
    nativeReady: `${run.nativeReadiness.readyCount}/${run.nativeReadiness.requiredCount}`,
    latestBytes: JSON.stringify(latest.latest).length
  }, null, 2));
}

function validatePublicSummary(summary, label) {
  assert(summary.id, `${label} missing id`);
  assert(summary.overall, `${label} missing overall`);
  assert(Array.isArray(summary.adapters), `${label} missing adapters[]`);
  assert(summary.apiArtifacts?.json, `${label} missing JSON artifact link`);
  assert(summary.apiArtifacts?.markdown, `${label} missing Markdown artifact link`);
  assert(summary.nativeReadiness?.schema === "hediao3d.native-cam-readiness.v1", `${label} missing nativeReadiness`);
  assert(Array.isArray(summary.nativeReadiness.adapters), `${label} nativeReadiness missing adapters[]`);
  assert(summary.productionGuardrails?.schema === "hediao3d.external-adapter-production-guardrails.v1", `${label} missing productionGuardrails`);
  assert(summary.productionGuardrails.readyForProduction === false, `${label} guardrails should not be production ready`);
  assert(summary.handoffClassificationAudit?.schema === "hediao3d.adapter-handoff-classification-audit.v1", `${label} missing handoffClassificationAudit`);
  assert(summary.handoffClassificationAudit.readyForProduction === false, `${label} handoff audit should not be production ready`);
  assert(!("workDir" in summary), `${label} leaked full validation workDir`);
  for (const adapter of summary.adapters) {
    assert(adapter.id, `${label} adapter missing id`);
    assert(adapter.plan && typeof adapter.plan.generated === "boolean", `${label} adapter missing plan summary`);
    assert(!("workDir" in adapter), `${label} leaked adapter workDir`);
    assert(!("jobPath" in adapter), `${label} leaked adapter jobPath`);
    assert(!("resultPath" in adapter), `${label} leaked adapter resultPath`);
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
