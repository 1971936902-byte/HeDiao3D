#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const run = await postJson("/api/orchestrator/native-cam", { strict: false });
  validateSummary(run, "POST /api/orchestrator/native-cam");
  assert(run.summary.requiredCount === 4, `expected 4 native CAM checks, got ${run.summary.requiredCount}`);

  const latest = await getJson("/api/orchestrator/native-cam/latest");
  assert(latest.latest, "latest native CAM check missing");
  validateSummary(latest.latest, "GET /api/orchestrator/native-cam/latest");
  assert(Array.isArray(latest.checks), "checks history missing");
  assert(JSON.stringify(latest.latest).length < 50000, "latest native CAM summary is too large");

  const artifactResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(artifactResponse.ok, `native CAM JSON artifact failed: ${artifactResponse.status}`);
  const artifact = await artifactResponse.json();
  assert(artifact.schema === "hediao3d.linux-native-cam-check.v1", "full native CAM artifact schema mismatch");
  assert(Array.isArray(artifact.checks), "full native CAM artifact missing checks[]");

  const markdownResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownResponse.ok, `native CAM markdown artifact failed: ${markdownResponse.status}`);
  const markdown = await markdownResponse.text();
  assert(markdown.includes("Linux Native CAM Readiness"), "native CAM markdown missing heading");

  console.log(JSON.stringify({
    ok: true,
    checkId: run.id,
    ready: `${run.summary.readyCount}/${run.summary.requiredCount}`,
    level: run.summary.level,
    latestBytes: JSON.stringify(latest.latest).length
  }, null, 2));
}

function validateSummary(summary, label) {
  assert(summary.id, `${label} missing id`);
  assert(summary.schema === "hediao3d.linux-native-cam-check.v1", `${label} schema mismatch`);
  assert(summary.summary, `${label} missing summary`);
  assert(Array.isArray(summary.checks), `${label} missing checks[]`);
  assert(summary.apiArtifacts?.json, `${label} missing JSON artifact`);
  assert(summary.apiArtifacts?.markdown, `${label} missing Markdown artifact`);
  const firstCheck = summary.checks[0] ?? {};
  assert(!("outputRoot" in firstCheck), `${label} leaked detailed check outputRoot`);
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
