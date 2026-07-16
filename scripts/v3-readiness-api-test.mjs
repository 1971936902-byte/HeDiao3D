#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const report = await postJson("/api/orchestrator/readiness", {});
  validateReadiness(report, "POST /api/orchestrator/readiness");

  const latest = await getJson("/api/orchestrator/readiness/latest");
  assert(latest.latest, "latest readiness report missing");
  validateReadiness(latest.latest, "GET /api/orchestrator/readiness/latest");
  assert(Array.isArray(latest.reports), "readiness report history missing");
  assert(JSON.stringify(latest.latest).length < 50000, "latest readiness summary is too large");

  const jsonArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(jsonArtifact.ok, `readiness JSON artifact failed: ${jsonArtifact.status}`);
  const full = await jsonArtifact.json();
  assert(full.schema === "hediao3d.v3-readiness-report.v1", "full readiness artifact schema mismatch");
  assert(full.diagnostics, "full readiness artifact missing diagnostics");
  assert(full.gates, "full readiness artifact missing gates");

  const markdownArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownArtifact.ok, `readiness markdown artifact failed: ${markdownArtifact.status}`);
  const markdown = await markdownArtifact.text();
  assert(markdown.includes("V3 Readiness Report"), "readiness markdown missing heading");

  console.log(JSON.stringify({
    ok: true,
    reportId: report.id,
    level: report.level,
    production: report.gates.allowProductionNc,
    trial: report.gates.allowTrialNc,
    airRun: report.gates.allowAirRun,
    latestBytes: JSON.stringify(latest.latest).length
  }, null, 2));
}

function validateReadiness(report, label) {
  assert(report.id, `${label} missing id`);
  assert(report.schema === "hediao3d.v3-readiness-report.v1", `${label} schema mismatch`);
  assert(report.gates, `${label} missing gates`);
  assert(["production-ready", "trial-only", "blocked"].includes(report.level), `${label} unexpected level ${report.level}`);
  assert(Array.isArray(report.gates.blockers), `${label} gates.blockers missing`);
  assert(Array.isArray(report.gates.warnings), `${label} gates.warnings missing`);
  assert(Array.isArray(report.gates.nextActions), `${label} gates.nextActions missing`);
  assert(report.apiArtifacts?.json, `${label} missing JSON artifact`);
  assert(report.apiArtifacts?.markdown, `${label} missing Markdown artifact`);
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
