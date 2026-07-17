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

  const runbookResult = await getJson("/api/orchestrator/readiness/runbook-result/latest");
  assert(Object.hasOwn(runbookResult, "latest"), "runbook result latest field missing");
  if (runbookResult.latest) {
    validateRunbookResult(runbookResult.latest, "GET /api/orchestrator/readiness/runbook-result/latest");
  }

  const jsonArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.json}`);
  assert(jsonArtifact.ok, `readiness JSON artifact failed: ${jsonArtifact.status}`);
  const full = await jsonArtifact.json();
  assert(full.schema === "hediao3d.v3-readiness-report.v1", "full readiness artifact schema mismatch");
  assert(full.diagnostics, "full readiness artifact missing diagnostics");
  assert(full.gates, "full readiness artifact missing gates");
  assert(full.camServerConfig?.schema === "hediao3d.cam-server-config.v1", "full readiness artifact missing CAM server config");
  assert(full.camServerConfig.adapters?.some((adapter) => adapter.id === full.camServerConfig.selectedEngine), "CAM server config missing selected adapter");
  assert(full.acceptancePlan?.schema === "hediao3d.v3-deployment-acceptance-plan.v1", "full readiness artifact missing acceptance plan");
  assert(full.acceptancePlan.steps.length >= 9, "acceptance plan should include deployment steps");
  assert(full.acceptancePlan.steps.some((step) => step.id === "cam-server-config"), "acceptance plan missing CAM server config step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "external-neutral-handoff"), "acceptance plan missing external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "external-real-neutral-handoff"), "acceptance plan missing real neutral handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "freecad-external-gcode-handoff"), "acceptance plan missing FreeCAD external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "blendercam-external-gcode-handoff"), "acceptance plan missing BlenderCAM external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "opencamlib-external-neutral-handoff"), "acceptance plan missing OpenCAMLib external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "opencamlib-neutral-import"), "acceptance plan missing OpenCAMLib neutral import step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "camotics-result-import"), "acceptance plan missing CAMotics import step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "production-evidence-dossier"), "acceptance plan missing production evidence dossier step");
  assert(full.externalCamHandoffs?.schema === "hediao3d.external-cam-handoffs.v1", "full readiness artifact missing external CAM handoff summary");
  assert(full.externalCamHandoffs.requiredEngines.includes("freecad"), "external CAM handoff summary missing FreeCAD");
  assert(full.externalCamHandoffs.requiredEngines.includes("blendercam"), "external CAM handoff summary missing BlenderCAM");
  assert(full.externalCamHandoffs.requiredEngines.includes("opencamlib"), "external CAM handoff summary missing OpenCAMLib");
  assert(Object.hasOwn(full, "latestTrialFeedback"), "full readiness artifact missing latest trial feedback field");
  assert(Object.hasOwn(full, "latestMachineAcceptance"), "full readiness artifact missing latest machine acceptance field");

  const markdownArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownArtifact.ok, `readiness markdown artifact failed: ${markdownArtifact.status}`);
  const markdown = await markdownArtifact.text();
  assert(markdown.includes("V3 Readiness Report"), "readiness markdown missing heading");
  assert(markdown.includes("CAM server config"), "readiness markdown missing CAM server config summary");
  assert(markdown.includes("Latest trial feedback"), "readiness markdown missing trial feedback summary");
  assert(markdown.includes("Latest machine acceptance"), "readiness markdown missing machine acceptance summary");
  assert(markdown.includes("Production evidence dossier"), "readiness markdown missing evidence dossier summary");

  const camServerConfigArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.camServerConfig}`);
  assert(camServerConfigArtifact.ok, `CAM server config artifact failed: ${camServerConfigArtifact.status}`);
  const camServerConfig = await camServerConfigArtifact.json();
  assert(camServerConfig.schema === "hediao3d.cam-server-config.v1", "CAM server config artifact schema mismatch");
  assert(camServerConfig.environment?.ENABLE_EXTERNAL_CAM_ADAPTERS, "CAM server config missing external adapter env");

  const runbookArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.runbook}`);
  assert(runbookArtifact.ok, `readiness runbook artifact failed: ${runbookArtifact.status}`);
  const runbook = await runbookArtifact.text();
  assert(runbook.includes("HeDiao3D V3 deployment acceptance runbook"), "readiness runbook missing heading");
  assert(runbook.includes("npm run test:v3:native-cam"), "readiness runbook missing native CAM command");
  assert(runbook.includes("cam-server-config.json"), "readiness runbook missing CAM server config evidence");
  assert(runbook.includes("V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters"), "readiness runbook missing CAM server config native adapter command");
  assert(runbook.includes("npm run test:v3:neutral-adapter"), "readiness runbook missing neutral handoff command");
  assert(runbook.includes("npm run test:v3:real-neutral-handoff"), "readiness runbook missing real neutral handoff command");
  assert(runbook.includes("npm run test:v3:freecad-external-handoff"), "readiness runbook missing FreeCAD external handoff command");
  assert(runbook.includes("npm run test:v3:blendercam-external-handoff"), "readiness runbook missing BlenderCAM external handoff command");
  assert(runbook.includes("npm run test:v3:closed-neutral-handoff"), "readiness runbook missing OpenCAMLib external handoff command");
  assert(runbook.includes("npm run test:v3:neutral-import"), "readiness runbook missing neutral import command");
  assert(runbook.includes("npm run test:v3:camotics-import"), "readiness runbook missing CAMotics import command");
  assert(runbook.includes("production-evidence-dossier"), "readiness runbook missing evidence dossier step");
  assert(runbook.includes("RESULT_JSON"), "readiness runbook missing machine-readable result path");
  assert(runbook.includes("hediao3d.v3-acceptance-runbook-result.v1"), "readiness runbook missing result schema");

  console.log(JSON.stringify({
    ok: true,
    reportId: report.id,
    level: report.level,
    acceptance: `${report.acceptancePlan.completed}/${report.acceptancePlan.total}`,
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
  assert(report.acceptancePlan?.schema === "hediao3d.v3-deployment-acceptance-plan.v1", `${label} missing acceptancePlan`);
  assert(Array.isArray(report.acceptancePlan.steps), `${label} acceptancePlan.steps missing`);
  assert(report.acceptancePlan.steps.some((step) => step.command && step.evidence?.length), `${label} acceptance steps missing command/evidence`);
  assert(report.acceptancePlan.steps.find((step) => step.id === "orchestrator-diagnostics")?.status !== "pending", `${label} orchestrator base check should not be pending when only external CAM is missing`);
  if (report.nativeCam?.level === "missing") {
    assert(report.acceptancePlan.nextStep?.id === "native-cam-readiness", `${label} next step should be native CAM readiness when native engines are missing`);
  }
  assert(["production-ready", "trial-only", "blocked"].includes(report.level), `${label} unexpected level ${report.level}`);
  assert(Array.isArray(report.gates.blockers), `${label} gates.blockers missing`);
  assert(Array.isArray(report.gates.warnings), `${label} gates.warnings missing`);
  assert(Array.isArray(report.gates.nextActions), `${label} gates.nextActions missing`);
  assert(report.apiArtifacts?.json, `${label} missing JSON artifact`);
  assert(report.apiArtifacts?.markdown, `${label} missing Markdown artifact`);
  assert(report.apiArtifacts?.runbook, `${label} missing runbook artifact`);
  assert(report.apiArtifacts?.camServerConfig, `${label} missing CAM server config artifact`);
  assert(Object.hasOwn(report, "camServerConfig"), `${label} missing camServerConfig field`);
  if (report.camServerConfig) {
    assert(report.camServerConfig.schema === "hediao3d.cam-server-config.v1", `${label} camServerConfig schema mismatch`);
    assert(Array.isArray(report.camServerConfig.missingRequired), `${label} camServerConfig missing required list`);
    assert(report.acceptancePlan.steps.some((step) => step.id === "cam-server-config"), `${label} acceptance plan missing CAM server config step`);
  }
  assert(Object.hasOwn(report, "runbookResult"), `${label} missing runbookResult field`);
  if (report.runbookResult) validateRunbookResult(report.runbookResult, `${label} runbookResult`);
  assert(Object.hasOwn(report, "externalHandoff"), `${label} missing externalHandoff field`);
  if (report.externalHandoff) {
    assert(report.externalHandoff.id, `${label} externalHandoff missing id`);
    assert(report.externalHandoff.source === "external-adapter", `${label} externalHandoff source mismatch`);
  }
  assert(Object.hasOwn(report, "externalCamHandoffs"), `${label} missing externalCamHandoffs field`);
  if (report.externalCamHandoffs) {
    assert(report.externalCamHandoffs.schema === "hediao3d.external-cam-handoffs.v1", `${label} externalCamHandoffs schema mismatch`);
    assert(Array.isArray(report.externalCamHandoffs.requiredEngines), `${label} externalCamHandoffs requiredEngines missing`);
    assert(report.externalCamHandoffs.byEngine && typeof report.externalCamHandoffs.byEngine === "object", `${label} externalCamHandoffs byEngine missing`);
  }
  assert(Object.hasOwn(report, "neutralImport"), `${label} missing neutralImport field`);
  if (report.neutralImport) {
    assert(report.neutralImport.schema === "hediao3d.neutral-import-contract.v1", `${label} neutralImport schema mismatch`);
    assert(typeof report.neutralImport.postprocessEligible === "boolean", `${label} neutralImport eligibility missing`);
  }
  assert(Object.hasOwn(report, "camoticsImport"), `${label} missing camoticsImport field`);
  if (report.camoticsImport) {
    assert(report.camoticsImport.schema === "hediao3d.camotics-import-contract.v1", `${label} camoticsImport schema mismatch`);
    assert(typeof report.camoticsImport.productionEvidenceEligible === "boolean", `${label} camoticsImport eligibility missing`);
  }
  assert(Object.hasOwn(report, "latestTrialFeedback"), `${label} missing latestTrialFeedback field`);
  if (report.latestTrialFeedback) {
    assert(report.latestTrialFeedback.schema === "hediao3d.trial-feedback-log.v1", `${label} latestTrialFeedback schema mismatch`);
    assert(typeof report.latestTrialFeedback.recordCount === "number", `${label} latestTrialFeedback count missing`);
  }
  assert(Object.hasOwn(report, "latestMachineAcceptance"), `${label} missing latestMachineAcceptance field`);
  if (report.latestMachineAcceptance) {
    assert(report.latestMachineAcceptance.schema === "hediao3d.machine-acceptance-log.v1", `${label} latestMachineAcceptance schema mismatch`);
    assert(typeof report.latestMachineAcceptance.recordCount === "number", `${label} latestMachineAcceptance count missing`);
  }
  assert(Object.hasOwn(report, "latestEvidenceDossier"), `${label} missing latestEvidenceDossier field`);
  if (report.latestEvidenceDossier) {
    assert(report.latestEvidenceDossier.schema === "hediao3d.production-evidence-dossier.v1", `${label} evidence dossier schema mismatch`);
    assert(typeof report.latestEvidenceDossier.reviewCount === "number", `${label} evidence dossier reviewCount missing`);
    assert(report.acceptancePlan.steps.some((step) => step.id === "production-evidence-dossier"), `${label} acceptance plan missing evidence dossier step`);
  }
}

function validateRunbookResult(result, label) {
  assert(result.schema === "hediao3d.v3-acceptance-runbook-result.v1", `${label} schema mismatch`);
  assert(typeof result.ok === "boolean", `${label} ok missing`);
  assert(typeof result.failedCount === "number", `${label} failedCount missing`);
  assert(Array.isArray(result.failedSteps), `${label} failedSteps missing`);
  assert(typeof result.stepCount === "number", `${label} stepCount missing`);
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
