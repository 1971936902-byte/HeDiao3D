#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const run = await postJson("/api/orchestrator/native-cam", { strict: false });
  validateSummary(run, "POST /api/orchestrator/native-cam");
  assert(run.summary.requiredCount === 4, `expected 4 native CAM checks, got ${run.summary.requiredCount}`);
  assert(run.summary.capabilityMatrix?.length === 4, "native CAM summary should expose four capability matrix entries");
  assert(run.summary.integrationStrategy?.schema === "hediao3d.opensource-cam-integration-strategy.v1", "native CAM summary should expose open-source CAM integration strategy");
  assert(run.summary.integrationStrategy.recommendedStack?.some((item) => item.id === "freecad" && item.handoff?.includes("Orchestrator")), "integration strategy should include FreeCAD handoff");
  assert(run.summary.integrationStrategy.recommendedStack?.some((item) => item.id === "opencamlib" && item.handoff?.includes("neutral-toolpath")), "integration strategy should include OpenCAMLib neutral handoff");
  assert(run.summary.integrationStrategy.recommendedStack?.some((item) => item.id === "camotics" && item.role === "material-removal-simulation"), "integration strategy should include CAMotics simulation role");
  assert(run.summary.integrationStrategy.productionBoundary?.some((item) => item.includes("三轴控制器+Y轴旋转夹具")), "integration strategy should preserve rotary fixture production boundary");
  assert(run.summary.capabilityMatrix.some((item) => item.id === "opencamlib" && item.supportedWorkflows?.includes("drop-cutter")), "OpenCAMLib capability matrix should expose drop-cutter workflow");
  assert(run.summary.capabilityMatrix.some((item) => item.id === "camotics" && item.category === "simulation"), "CAMotics capability matrix should mark simulation role");
  assert(run.apiArtifacts?.bootstrap?.endsWith("native-cam-server-bootstrap.sh"), "native CAM summary should expose bootstrap artifact");
  assert(run.apiArtifacts?.envTemplate?.endsWith("native-cam-env.template"), "native CAM summary should expose env template artifact");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-acceptance-checklist.md"), "native CAM summary should expose server package files");
  assert(run.checks.some((check) => check.id === "freecad" && check.capabilities?.outputFormats?.includes("gcode")), "FreeCAD public check should expose G-code capability");
  assert(run.checks.some((check) => check.id === "opencamlib" && check.capabilities?.outputFormats?.includes("neutral-toolpath")), "OpenCAMLib public check should expose neutral toolpath capability");

  const latest = await getJson("/api/orchestrator/native-cam/latest");
  assert(latest.latest, "latest native CAM check missing");
  validateSummary(latest.latest, "GET /api/orchestrator/native-cam/latest");
  assert(latest.latest.summary.capabilityMatrix?.length === 4, "latest native CAM summary should preserve capability matrix");
  assert(latest.latest.summary.integrationStrategy?.recommendedStack?.length >= 4, "latest native CAM summary should preserve integration strategy");
  assert(Array.isArray(latest.checks), "checks history missing");
  assert(JSON.stringify(latest.latest).length < 50000, "latest native CAM summary is too large");

  const artifactResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(artifactResponse.ok, `native CAM JSON artifact failed: ${artifactResponse.status}`);
  const artifact = await artifactResponse.json();
  assert(artifact.schema === "hediao3d.linux-native-cam-check.v1", "full native CAM artifact schema mismatch");
  assert(Array.isArray(artifact.checks), "full native CAM artifact missing checks[]");
  assert(artifact.summary?.capabilityMatrix?.some((item) => item.id === "blendercam" && item.supportedWorkflows.includes("artistic-relief")), "full artifact should include BlenderCAM capability matrix");
  assert(artifact.summary?.integrationStrategy?.rolloutStages?.some((item) => item.includes("Linux CAM 服务器")), "full artifact should include rollout stages");
  assert(artifact.artifacts?.schema === "hediao3d.native-cam-server-package.v1", "full artifact should include native CAM server package manifest");
  assert(artifact.artifacts.files?.some((file) => file.filename === "native-cam-server-bootstrap.sh"), "full artifact should include bootstrap package entry");
  assert(artifact.checks.some((check) => check.id === "camotics" && check.capabilities?.notEnoughFor?.includes("刀路生成")), "full artifact should state CAMotics does not generate toolpaths");

  const markdownResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownResponse.ok, `native CAM markdown artifact failed: ${markdownResponse.status}`);
  const markdown = await markdownResponse.text();
  assert(markdown.includes("Linux Native CAM Readiness"), "native CAM markdown missing heading");
  assert(markdown.includes("Integration Strategy"), "native CAM markdown missing integration strategy");

  const bootstrap = await fetchText(latest.latest.apiArtifacts.bootstrap);
  assert(bootstrap.includes("DRY_RUN"), "native CAM bootstrap should be dry-run guarded");
  assert(bootstrap.includes("npm run test:v3:native-cam"), "native CAM bootstrap should include validation command");
  const envTemplate = await fetchText(latest.latest.apiArtifacts.envTemplate);
  assert(envTemplate.includes("ENABLE_EXTERNAL_CAM_ADAPTERS=false"), "native CAM env template should keep adapters disabled by default");
  assert(envTemplate.includes("HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT=false"), "native CAM env template should forbid synthetic CAMotics by default");
  const checklist = await fetchText(latest.latest.apiArtifacts.checklist);
  assert(checklist.includes("Production Boundary"), "native CAM checklist should include production boundary");
  const packageManifest = await getJson(latest.latest.apiArtifacts.packageManifest);
  assert(packageManifest.schema === "hediao3d.native-cam-server-package.v1", "native CAM package manifest schema mismatch");

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
  assert(Array.isArray(summary.summary.capabilityMatrix), `${label} missing capability matrix`);
  assert(summary.summary.integrationStrategy, `${label} missing integration strategy`);
  assert(Array.isArray(summary.checks), `${label} missing checks[]`);
  assert(summary.apiArtifacts?.json, `${label} missing JSON artifact`);
  assert(summary.apiArtifacts?.markdown, `${label} missing Markdown artifact`);
  assert(summary.apiArtifacts?.bootstrap, `${label} missing bootstrap artifact`);
  assert(summary.apiArtifacts?.envTemplate, `${label} missing env template artifact`);
  assert(summary.apiArtifacts?.checklist, `${label} missing checklist artifact`);
  assert(summary.apiArtifacts?.packageManifest, `${label} missing package manifest artifact`);
  assert(summary.packageArtifacts?.schema === "hediao3d.native-cam-server-package.v1", `${label} missing packageArtifacts summary`);
  const firstCheck = summary.checks[0] ?? {};
  assert(!("outputRoot" in firstCheck), `${label} leaked detailed check outputRoot`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function fetchText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  assert(response.ok, `${path} failed: ${response.status}`);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
