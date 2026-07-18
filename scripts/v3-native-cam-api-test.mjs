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
  assert(run.targetMachineBoundary?.machineProfileId === "desktop-3axis-rotary-y", "native CAM summary should expose target machine boundary");
  assert(run.targetMachineBoundary?.tool?.toolProfileId === "vflat-4mm-25deg", "native CAM target boundary should expose 4mm 25deg tool");
  assert(run.summary.executionPlan?.schema === "hediao3d.opensource-cam-execution-plan.v1", "native CAM summary should expose open-source CAM execution plan");
  assert(run.summary.executionPlan.stages?.some((stage) => stage.id === "opencamlib-neutral-core" && stage.output.includes("neutral-toolpath")), "execution plan should include OpenCAMLib neutral core stage");
  assert(run.summary.executionPlan.stages?.some((stage) => stage.id === "camotics-material-removal" && stage.productionBoundary.includes("synthetic")), "execution plan should include CAMotics production lock");
  assert(run.summary.capabilityMatrix.some((item) => item.id === "opencamlib" && item.supportedWorkflows?.includes("drop-cutter")), "OpenCAMLib capability matrix should expose drop-cutter workflow");
  assert(run.summary.capabilityMatrix.some((item) => item.id === "camotics" && item.category === "simulation"), "CAMotics capability matrix should mark simulation role");
  assert(run.apiArtifacts?.bootstrap?.endsWith("native-cam-server-bootstrap.sh"), "native CAM summary should expose bootstrap artifact");
  assert(run.apiArtifacts?.envTemplate?.endsWith("native-cam-env.template"), "native CAM summary should expose env template artifact");
  assert(run.apiArtifacts?.closedLoopHandoff?.endsWith("linux-cam-closed-loop-handoff.md"), "native CAM summary should expose closed-loop handoff artifact");
  assert(run.apiArtifacts?.realOutputCheck?.endsWith("native-cam-real-output-check.sh"), "native CAM summary should expose real output check artifact");
  assert(run.apiArtifacts?.packageSelfCheck?.endsWith("native-cam-server-package-self-check.mjs"), "native CAM summary should expose package self-check artifact");
  assert(run.apiArtifacts?.closedLoopCheck?.endsWith("native-cam-closed-loop-check.mjs"), "native CAM summary should expose closed-loop check artifact");
  assert(run.apiArtifacts?.packageZip?.endsWith("server-package.zip"), "native CAM summary should expose server package zip artifact");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-acceptance-checklist.md"), "native CAM summary should expose server package files");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-real-output-check.sh"), "native CAM summary should expose real output check package file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-server-package-self-check.mjs"), "native CAM summary should expose package self-check file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-closed-loop-check.mjs"), "native CAM summary should expose closed-loop check package file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "opencamlib-contact-output-validate.mjs"), "native CAM summary should expose OpenCAMLib contact validator package file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "camotics-material-removal-validate.mjs"), "native CAM summary should expose CAMotics material-removal validator package file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "linux-cam-closed-loop-handoff.md"), "native CAM summary should expose closed-loop handoff package file");
  assert(run.packageArtifacts?.files?.some((file) => file.filename === "native-cam-server-package.json"), "native CAM summary should expose package manifest file");
  assert(run.checks.some((check) => check.id === "freecad" && check.capabilities?.outputFormats?.includes("gcode")), "FreeCAD public check should expose G-code capability");
  assert(run.checks.some((check) => check.id === "opencamlib" && check.capabilities?.outputFormats?.includes("neutral-toolpath")), "OpenCAMLib public check should expose neutral toolpath capability");

  const latest = await getJson("/api/orchestrator/native-cam/latest");
  assert(latest.latest, "latest native CAM check missing");
  validateSummary(latest.latest, "GET /api/orchestrator/native-cam/latest");
  assert(latest.latest.summary.capabilityMatrix?.length === 4, "latest native CAM summary should preserve capability matrix");
  assert(latest.latest.summary.integrationStrategy?.recommendedStack?.length >= 4, "latest native CAM summary should preserve integration strategy");
  assert(latest.latest.summary.executionPlan?.stages?.length === 4, "latest native CAM summary should preserve execution plan");
  assert(Array.isArray(latest.checks), "checks history missing");
  assert(JSON.stringify(latest.latest).length < 50000, "latest native CAM summary is too large");

  const artifactResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(artifactResponse.ok, `native CAM JSON artifact failed: ${artifactResponse.status}`);
  const artifact = await artifactResponse.json();
  assert(artifact.schema === "hediao3d.linux-native-cam-check.v1", "full native CAM artifact schema mismatch");
  assert(Array.isArray(artifact.checks), "full native CAM artifact missing checks[]");
  assert(artifact.summary?.capabilityMatrix?.some((item) => item.id === "blendercam" && item.supportedWorkflows.includes("artistic-relief")), "full artifact should include BlenderCAM capability matrix");
  assert(artifact.summary?.integrationStrategy?.rolloutStages?.some((item) => item.includes("Linux CAM 服务器")), "full artifact should include rollout stages");
  assert(artifact.summary?.executionPlan?.productionLocks?.some((item) => item.includes("production-candidate")), "full artifact should include execution production locks");
  assert(artifact.artifacts?.schema === "hediao3d.native-cam-server-package.v1", "full artifact should include native CAM server package manifest");
  assert(artifact.artifacts.files?.some((file) => file.filename === "native-cam-server-bootstrap.sh"), "full artifact should include bootstrap package entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "native-cam-real-output-check.sh"), "full artifact should include real output check package entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "native-cam-server-package-self-check.mjs"), "full artifact should include package self-check entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "native-cam-closed-loop-check.mjs"), "full artifact should include closed-loop check package entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "opencamlib-contact-output-validate.mjs"), "full artifact should include OpenCAMLib contact validator package entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "camotics-material-removal-validate.mjs"), "full artifact should include CAMotics material-removal validator package entry");
  assert(artifact.artifacts.files?.some((file) => file.filename === "linux-cam-closed-loop-handoff.md"), "full artifact should include closed-loop handoff package entry");
  assert(artifact.checks.some((check) => check.id === "camotics" && check.capabilities?.notEnoughFor?.includes("刀路生成")), "full artifact should state CAMotics does not generate toolpaths");

  const markdownResponse = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownResponse.ok, `native CAM markdown artifact failed: ${markdownResponse.status}`);
  const markdown = await markdownResponse.text();
  assert(markdown.includes("Linux Native CAM Readiness"), "native CAM markdown missing heading");
  assert(markdown.includes("Integration Strategy"), "native CAM markdown missing integration strategy");

  const bootstrap = await fetchText(latest.latest.apiArtifacts.bootstrap);
  assert(bootstrap.includes("DRY_RUN"), "native CAM bootstrap should be dry-run guarded");
  assert(bootstrap.includes("npm run test:v3:native-cam"), "native CAM bootstrap should include validation command");
  assert(bootstrap.includes("npm run test:v3:freecad-proof-handoff"), "native CAM bootstrap should include proof-backed FreeCAD validation command");
  const envTemplate = await fetchText(latest.latest.apiArtifacts.envTemplate);
  assert(envTemplate.includes("ENABLE_EXTERNAL_CAM_ADAPTERS=false"), "native CAM env template should keep adapters disabled by default");
  assert(envTemplate.includes("HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT=false"), "native CAM env template should forbid synthetic CAMotics by default");
  const checklist = await fetchText(latest.latest.apiArtifacts.checklist);
  assert(checklist.includes("Production Boundary"), "native CAM checklist should include production boundary");
  assert(checklist.includes("Open Source CAM Execution Plan"), "native CAM checklist should include execution plan");
  assert(checklist.includes("OpenCAMLib 曲面接触"), "native CAM checklist should include OpenCAMLib execution stage");
  assert(checklist.includes("native-cam-real-output-check.sh"), "native CAM checklist should include real output check command");
  assert(checklist.includes("native-cam-server-package-self-check.mjs"), "native CAM checklist should include package self-check command");
  assert(checklist.includes("npm run test:v3:freecad-proof-handoff"), "native CAM checklist should include proof-backed FreeCAD handoff command");
  assert(checklist.includes("camotics-material-removal-validate.mjs"), "native CAM checklist should include CAMotics material-removal validator command");
  const closedLoopHandoff = await fetchText(latest.latest.apiArtifacts.closedLoopHandoff);
  assert(closedLoopHandoff.includes("Linux CAM 闭环交接说明"), "closed-loop handoff should have Chinese heading");
  assert(closedLoopHandoff.includes("native-cam-real-output-bundle.zip"), "closed-loop handoff should include Native CAM upload bundle");
  assert(closedLoopHandoff.includes("native-cam-server-package-self-check.mjs"), "closed-loop handoff should include package self-check");
  assert(closedLoopHandoff.includes("native-cam-closed-loop-check.mjs"), "closed-loop handoff should include one-command closed-loop check");
  assert(closedLoopHandoff.includes("camotics-result-bundle.zip"), "closed-loop handoff should include CAMotics result bundle");
  assert(closedLoopHandoff.includes("camotics-material-removal-validate.mjs"), "closed-loop handoff should include CAMotics material-removal validator");
  assert(closedLoopHandoff.includes("readinessCamoticsEvidence"), "closed-loop handoff should mention readiness CAMotics evidence");
  assert(closedLoopHandoff.includes("三轴控制器 + Y轴旋转夹具"), "closed-loop handoff should preserve target machine boundary");
  const realOutputCheck = await fetchText(latest.latest.apiArtifacts.realOutputCheck);
  assert(realOutputCheck.includes("handoffEvidence"), "real output check should parse handoffEvidence");
  assert(realOutputCheck.includes("production-candidate"), "real output check should require production-candidate output");
  assert(realOutputCheck.includes("native-cam-real-output-acceptance.json"), "real output check should write machine-readable acceptance report");
  assert(realOutputCheck.includes("native-cam-real-output-bundle.zip"), "real output check should write uploadable ZIP bundle");
  assert(realOutputCheck.includes("target-machine-boundary.json"), "real output check should write target machine boundary artifact");
  assert(realOutputCheck.includes("targetMachineBoundary"), "real output check should include target machine boundary in acceptance report");
  assert(realOutputCheck.includes("README-NATIVE-CAM-REAL-OUTPUT.md"), "real output check bundle should include README");
  assert(realOutputCheck.includes("hediao3d.native-cam-real-output-acceptance.v1"), "real output check should write acceptance schema");
  assert(realOutputCheck.includes("V3_ADAPTER_USE_NATIVE_COMMANDS=true"), "real output check should run native adapter validation");
  assert(realOutputCheck.includes("npm run test:v3:freecad-proof-handoff"), "real output check should run proof-backed FreeCAD handoff validation");
  const selfCheck = await fetchText(latest.latest.apiArtifacts.packageSelfCheck);
  assert(selfCheck.includes("hediao3d.native-cam-server-package-self-check.v1"), "package self-check should emit schema");
  assert(selfCheck.includes("desktop-3axis-rotary-y"), "package self-check should validate target machine profile");
  assert(selfCheck.includes("camotics-result-bundle.zip"), "package self-check should validate CAMotics result bundle support");
  assert(selfCheck.includes("native-cam-closed-loop-check.mjs"), "package self-check should validate closed-loop check support");
  const closedLoopCheck = await fetchText(latest.latest.apiArtifacts.closedLoopCheck);
  assert(closedLoopCheck.includes("hediao3d.native-cam-closed-loop-check.v1"), "closed-loop check should emit schema");
  assert(closedLoopCheck.includes("productionLocked: true"), "closed-loop check should preserve production lock");
  const packageManifest = await getJson(latest.latest.apiArtifacts.packageManifest);
  assert(packageManifest.schema === "hediao3d.native-cam-server-package.v1", "native CAM package manifest schema mismatch");
  assert(packageManifest.files?.some((file) => file.filename === "native-cam-real-output-check.sh"), "native CAM package manifest missing real output check");
  assert(packageManifest.files?.some((file) => file.filename === "native-cam-server-package-self-check.mjs"), "native CAM package manifest missing package self-check");
  assert(packageManifest.files?.some((file) => file.filename === "native-cam-closed-loop-check.mjs"), "native CAM package manifest missing closed-loop check");
  assert(packageManifest.files?.some((file) => file.filename === "native-cam-diagnostics-bundle.mjs"), "native CAM package manifest missing diagnostics bundle");
  assert(packageManifest.files?.some((file) => file.filename === "opencamlib-probe.py"), "native CAM package manifest missing OpenCAMLib runtime probe");
  assert(packageManifest.files?.some((file) => file.filename === "opencamlib-contact-spike.py"), "native CAM package manifest missing OpenCAMLib contact spike");
  assert(packageManifest.files?.some((file) => file.filename === "opencamlib-contact-output-validate.mjs"), "native CAM package manifest missing OpenCAMLib contact validator");
  assert(packageManifest.files?.some((file) => file.filename === "camotics-material-removal-validate.mjs"), "native CAM package manifest missing CAMotics material-removal validator");
  assert(packageManifest.commands?.some((command) => command.includes("opencamlib-probe.py")), "native CAM package manifest should include OpenCAMLib runtime probe command");
  assert(packageManifest.commands?.some((command) => command.includes("opencamlib-contact-spike.py")), "native CAM package manifest should include OpenCAMLib contact spike command");
  assert(packageManifest.commands?.some((command) => command.includes("opencamlib-contact-output-validate.mjs")), "native CAM package manifest should include contact validator command");
  assert(packageManifest.commands?.some((command) => command.includes("native-cam-server-package-self-check.mjs")), "native CAM package manifest should include package self-check command");
  assert(packageManifest.commands?.some((command) => command.includes("native-cam-closed-loop-check.mjs")), "native CAM package manifest should include closed-loop check command");
  assert(packageManifest.commands?.some((command) => command.includes("native-cam-diagnostics-bundle.mjs")), "native CAM package manifest should include diagnostics bundle command");
  assert(packageManifest.commands?.some((command) => command.includes("camotics-material-removal-validate.mjs")), "native CAM package manifest should include CAMotics material-removal validator command");
  assert(packageManifest.files?.some((file) => file.filename === "linux-cam-closed-loop-handoff.md"), "native CAM package manifest missing closed-loop handoff");
  assert(packageManifest.targetMachineBoundary?.machineProfileId === "desktop-3axis-rotary-y", "native CAM package manifest missing target machine boundary");
  const packageZip = await getBinary(latest.latest.apiArtifacts.packageZip);
  assert((packageZip.contentType ?? "").includes("application/zip"), "native CAM server package should use application/zip content type");
  assert(packageZip.bytes[0] === 0x50 && packageZip.bytes[1] === 0x4b, "native CAM server package should be a ZIP file");
  const zipNames = listZipFilenames(packageZip.bytes);
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-server-bootstrap.sh"), "native CAM zip missing bootstrap");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-env.template"), "native CAM zip missing env template");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-acceptance-checklist.md"), "native CAM zip missing checklist");
  assert(zipNames.includes("hediao3d-native-cam-server/linux-cam-closed-loop-handoff.md"), "native CAM zip missing closed-loop handoff");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-real-output-check.sh"), "native CAM zip missing real output check");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-server-package-self-check.mjs"), "native CAM zip missing package self-check");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-closed-loop-check.mjs"), "native CAM zip missing closed-loop check");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-diagnostics-bundle.mjs"), "native CAM zip missing diagnostics bundle");
  assert(zipNames.includes("hediao3d-native-cam-server/opencamlib-probe.py"), "native CAM zip missing OpenCAMLib runtime probe");
  assert(zipNames.includes("hediao3d-native-cam-server/opencamlib-contact-spike.py"), "native CAM zip missing OpenCAMLib contact spike");
  assert(zipNames.includes("hediao3d-native-cam-server/opencamlib-contact-output-validate.mjs"), "native CAM zip missing OpenCAMLib contact validator");
  assert(zipNames.includes("hediao3d-native-cam-server/camotics-material-removal-validate.mjs"), "native CAM zip missing CAMotics material-removal validator");
  assert(zipNames.includes("hediao3d-native-cam-server/native-cam-server-package.json"), "native CAM zip missing package manifest");
  assert(zipNames.includes("hediao3d-native-cam-server/README-NATIVE-CAM.md"), "native CAM zip missing README");
  const readme = await readZipText(packageZip.bytes, "hediao3d-native-cam-server/README-NATIVE-CAM.md");
  assert(readme.includes("native-cam-server-package-self-check.mjs"), "native CAM ZIP README should instruct package self-check");
  assert(readme.includes("native-cam-diagnostics-bundle.mjs"), "native CAM ZIP README should instruct diagnostics bundle");
  assert(readme.includes("opencamlib-contact-spike.py"), "native CAM ZIP README should instruct contact spike");
  assert(readme.includes("native-cam-closed-loop-check.mjs"), "native CAM ZIP README should instruct closed-loop check");

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
  assert(summary.summary.executionPlan?.schema === "hediao3d.opensource-cam-execution-plan.v1", `${label} missing execution plan`);
  assert(Array.isArray(summary.checks), `${label} missing checks[]`);
  assert(summary.apiArtifacts?.json, `${label} missing JSON artifact`);
  assert(summary.apiArtifacts?.markdown, `${label} missing Markdown artifact`);
  assert(summary.apiArtifacts?.bootstrap, `${label} missing bootstrap artifact`);
  assert(summary.apiArtifacts?.envTemplate, `${label} missing env template artifact`);
  assert(summary.apiArtifacts?.closedLoopHandoff, `${label} missing closed-loop handoff artifact`);
  assert(summary.apiArtifacts?.checklist, `${label} missing checklist artifact`);
  assert(summary.apiArtifacts?.realOutputCheck, `${label} missing real output check artifact`);
  assert(summary.apiArtifacts?.packageSelfCheck, `${label} missing package self-check artifact`);
  assert(summary.apiArtifacts?.packageManifest, `${label} missing package manifest artifact`);
  assert(summary.apiArtifacts?.packageZip, `${label} missing package zip artifact`);
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

async function getBinary(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(response.ok, `${path} failed: ${response.status}`);
  return {
    bytes,
    contentType: response.headers.get("content-type")
  };
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

function listZipFilenames(bytes) {
  const names = [];
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = readUInt32LE(bytes, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compressedSize = readUInt32LE(bytes, offset + 18);
    const nameLength = readUInt16LE(bytes, offset + 26);
    const extraLength = readUInt16LE(bytes, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    names.push(new TextDecoder().decode(bytes.slice(nameStart, nameEnd)));
    offset = nameEnd + extraLength + compressedSize;
  }
  return names;
}

async function readZipText(bytes, filename) {
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = readUInt32LE(bytes, offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compressedSize = readUInt32LE(bytes, offset + 18);
    const nameLength = readUInt16LE(bytes, offset + 26);
    const extraLength = readUInt16LE(bytes, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (name === filename) return new TextDecoder().decode(bytes.slice(dataStart, dataEnd));
    offset = dataEnd;
  }
  throw new Error(`ZIP entry not found: ${filename}`);
}

function readUInt16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
