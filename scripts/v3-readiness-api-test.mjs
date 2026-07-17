#!/usr/bin/env node

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";

async function main() {
  await getJson("/api/health");

  const adapterValidation = await postJson("/api/orchestrator/adapter-validation", { native: false });
  assert(adapterValidation.handoffClassificationAudit?.schema === "hediao3d.adapter-handoff-classification-audit.v1", "pre-readiness adapter validation missing handoff audit");
  assert(adapterValidation.handoffClassificationAudit.unsafeCount >= 1, "safe-default adapter validation should produce unsafe handoff audit entries");

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
  assert(full.acceptancePlan.steps.some((step) => step.id === "native-cam-readiness" && step.evidence?.includes("native-cam-server-bootstrap.sh")), "acceptance plan missing native CAM bootstrap evidence");
  assert(full.acceptancePlan.steps.some((step) => step.id === "native-cam-readiness" && step.evidence?.includes("native-cam-env.template")), "acceptance plan missing native CAM env template evidence");
  assert(full.acceptancePlan.steps.some((step) => step.id === "native-cam-readiness" && step.evidence?.includes("native-cam-acceptance-checklist.md")), "acceptance plan missing native CAM checklist evidence");
  assert(full.acceptancePlan.steps.some((step) => step.id === "native-cam-readiness" && step.evidence?.includes("linux-cam-closed-loop-handoff.md")), "acceptance plan missing Linux CAM closed-loop handoff evidence");
  assert(full.acceptancePlan.steps.some((step) => step.id === "native-cam-real-output-acceptance" && step.evidence?.includes("native-cam-real-output-acceptance.json")), "acceptance plan missing native CAM real output acceptance step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "cam-server-config"), "acceptance plan missing CAM server config step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "external-neutral-handoff"), "acceptance plan missing external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "external-real-neutral-handoff"), "acceptance plan missing real neutral handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "freecad-external-gcode-handoff"), "acceptance plan missing FreeCAD external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "blendercam-external-gcode-handoff"), "acceptance plan missing BlenderCAM external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "opencamlib-external-neutral-handoff"), "acceptance plan missing OpenCAMLib external handoff step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "opencamlib-neutral-import"), "acceptance plan missing OpenCAMLib neutral import step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "camotics-result-import"), "acceptance plan missing CAMotics import step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "camotics-cli-package" && step.evidence?.includes("camotics-cli-run-package.json")), "acceptance plan missing CAMotics CLI package step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "trial-feedback" && step.evidence?.includes("trial-feedback-log.json")), "acceptance plan missing trial feedback evidence step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "machine-acceptance" && step.evidence?.includes("machine-acceptance-log.json")), "acceptance plan missing machine acceptance evidence step");
  assert(full.acceptancePlan.steps.some((step) => step.id === "production-evidence-dossier"), "acceptance plan missing production evidence dossier step");
  const evidenceStep = full.acceptancePlan.steps.find((step) => step.id === "production-evidence-dossier");
  assert(evidenceStep?.detail && /camoticsInput=/.test(evidenceStep.detail), "evidence dossier step detail should include CAMotics input cross check");
  assert(evidenceStep?.detail && /machine=/.test(evidenceStep.detail), "evidence dossier step detail should include machine acceptance cross check");
  assert(evidenceStep?.detail && /productionAudit=/.test(evidenceStep.detail), "evidence dossier step detail should include production audit status");
  assert(full.externalCamHandoffs?.schema === "hediao3d.external-cam-handoffs.v1", "full readiness artifact missing external CAM handoff summary");
  assert(full.externalCamHandoffs.requiredEngines.includes("freecad"), "external CAM handoff summary missing FreeCAD");
  assert(full.externalCamHandoffs.requiredEngines.includes("blendercam"), "external CAM handoff summary missing BlenderCAM");
  assert(full.externalCamHandoffs.requiredEngines.includes("opencamlib"), "external CAM handoff summary missing OpenCAMLib");
  assert(Object.hasOwn(full, "latestTrialFeedback"), "full readiness artifact missing latest trial feedback field");
  assert(Object.hasOwn(full, "latestMachineAcceptance"), "full readiness artifact missing latest machine acceptance field");
  assert(Object.hasOwn(full, "nativeCamRealOutputAcceptance"), "full readiness artifact missing native CAM real output acceptance field");
  assert(full.adapterValidation?.handoffClassificationAudit?.schema === "hediao3d.adapter-handoff-classification-audit.v1", "full readiness artifact missing adapter handoff audit");
  assert(full.adapterValidation.handoffClassificationAudit.unsafeCount >= 1, "readiness should preserve unsafe handoff audit count");
  const adapterStep = full.acceptancePlan.steps.find((step) => step.id === "adapter-validation");
  assert(adapterStep?.status === "blocked", `adapter validation step should be blocked when handoff audit is unsafe, got ${adapterStep?.status}`);
  assert(/unsafe=/.test(adapterStep.detail), "adapter validation step detail should include unsafe handoff count");
  assert(/contactBound=/.test(adapterStep.detail), "adapter validation step detail should include contact binding count");
  const camoticsStep = full.acceptancePlan.steps.find((step) => step.id === "camotics-result-import");
  assert(camoticsStep?.detail && /input=/.test(camoticsStep.detail), "camotics import step detail should include input identity status");
  assert(camoticsStep?.detail && /motion=/.test(camoticsStep.detail), "camotics import step detail should include motion consistency status");
  assert(camoticsStep?.detail && /machine=/.test(camoticsStep.detail), "camotics import step detail should include machine context status");

  const markdownArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.markdown}`);
  assert(markdownArtifact.ok, `readiness markdown artifact failed: ${markdownArtifact.status}`);
  const markdown = await markdownArtifact.text();
  assert(markdown.includes("V3 Readiness Report"), "readiness markdown missing heading");
  assert(markdown.includes("CAM server config"), "readiness markdown missing CAM server config summary");
  assert(markdown.includes("Native CAM server package"), "readiness markdown missing native CAM server package summary");
  assert(markdown.includes("Native CAM real output acceptance"), "readiness markdown missing native CAM real output acceptance summary");
  assert(markdown.includes("CAMotics readiness evidence"), "readiness markdown missing CAMotics readiness evidence summary");
  assert(markdown.includes("Adapter Handoff Audit"), "readiness markdown missing adapter handoff audit section");
  assert(markdown.includes("Postprocess handoff"), "readiness markdown missing postprocess handoff summary");
  assert(markdown.includes("Latest trial feedback"), "readiness markdown missing trial feedback summary");
  assert(markdown.includes("Latest machine acceptance"), "readiness markdown missing machine acceptance summary");
  assert(markdown.includes("Production evidence dossier"), "readiness markdown missing evidence dossier summary");
  assert(markdown.includes("Evidence cross checks"), "readiness markdown missing evidence cross-check summary");
  assert(markdown.includes("camoticsInput="), "readiness markdown missing CAMotics input cross-check status");
  assert(markdown.includes("productionAudit="), "readiness markdown missing production audit cross-check status");

  const camServerConfigArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.camServerConfig}`);
  assert(camServerConfigArtifact.ok, `CAM server config artifact failed: ${camServerConfigArtifact.status}`);
  const camServerConfig = await camServerConfigArtifact.json();
  assert(camServerConfig.schema === "hediao3d.cam-server-config.v1", "CAM server config artifact schema mismatch");
  assert(camServerConfig.environment?.ENABLE_EXTERNAL_CAM_ADAPTERS, "CAM server config missing external adapter env");
  assert(camServerConfig.deploymentValidation?.schema === "hediao3d.cam-server-deployment-validation.v1", "CAM server config missing deployment validation plan");
  assert(camServerConfig.deploymentValidation.stages?.some((stage) => stage.id === "external-handoff-smoke"), "CAM server deployment validation missing external handoff stage");
  assert(camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff?.includes("HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT"), "CAM server deployment validation missing fixture-off policy");
  assert(camServerConfig.deploymentValidation.productionUnlockRequires?.some((item) => /CAMotics/i.test(item)), "CAM server deployment validation missing CAMotics production requirement");

  const runbookArtifact = await fetch(`${baseUrl}${latest.latest.apiArtifacts.runbook}`);
  assert(runbookArtifact.ok, `readiness runbook artifact failed: ${runbookArtifact.status}`);
  const runbook = await runbookArtifact.text();
  assert(runbook.includes("HeDiao3D V3 deployment acceptance runbook"), "readiness runbook missing heading");
  assert(runbook.includes("npm run test:v3:native-cam"), "readiness runbook missing native CAM command");
  assert(runbook.includes("native-cam-server-bootstrap.sh"), "readiness runbook missing native CAM bootstrap evidence");
  assert(runbook.includes("native-cam-env.template"), "readiness runbook missing native CAM env template evidence");
  assert(runbook.includes("native-cam-acceptance-checklist.md"), "readiness runbook missing native CAM checklist evidence");
  assert(runbook.includes("native-cam-real-output-acceptance.json"), "readiness runbook missing native CAM real output acceptance evidence");
  assert(runbook.includes("bash native-cam-real-output-check.sh"), "readiness runbook missing native CAM real output acceptance command");
  assert(runbook.includes("cam-server-config.json"), "readiness runbook missing CAM server config evidence");
  assert(runbook.includes("V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters"), "readiness runbook missing CAM server config native adapter command");
  assert(runbook.includes("npm run test:v3:neutral-adapter"), "readiness runbook missing neutral handoff command");
  assert(runbook.includes("npm run test:v3:real-neutral-handoff"), "readiness runbook missing real neutral handoff command");
  assert(runbook.includes("npm run test:v3:freecad-external-handoff"), "readiness runbook missing FreeCAD external handoff command");
  assert(runbook.includes("npm run test:v3:blendercam-external-handoff"), "readiness runbook missing BlenderCAM external handoff command");
  assert(runbook.includes("npm run test:v3:closed-neutral-handoff"), "readiness runbook missing OpenCAMLib external handoff command");
  assert(runbook.includes("npm run test:v3:neutral-import"), "readiness runbook missing neutral import command");
  assert(runbook.includes("npm run test:v3:camotics-import"), "readiness runbook missing CAMotics import command");
  assert(runbook.includes("npm run test:v3:camotics-cli-package-api"), "readiness runbook missing CAMotics CLI package command");
  assert(runbook.includes("production-evidence-dossier"), "readiness runbook missing evidence dossier step");
  assert(runbook.includes("rotary-calibration-airrun.nc"), "readiness runbook missing rotary calibration air-run evidence");
  assert(runbook.includes("package-integrity.json"), "readiness runbook missing package integrity evidence");
  assert(runbook.includes("RESULT_JSON"), "readiness runbook missing machine-readable result path");
  assert(runbook.includes("RESULT_BUNDLE_ZIP"), "readiness runbook missing uploadable result bundle path");
  assert(runbook.includes("v3-acceptance-runbook-result-bundle.zip"), "readiness runbook missing result bundle filename");
  assert(runbook.includes("README-RUNBOOK-RESULT.md"), "readiness runbook bundle missing README");
  assert(runbook.includes("Upload this ZIP in the HeDiao3D V3 readiness runbook-result import panel."), "readiness runbook missing result upload instruction");
  assert(runbook.includes("hediao3d.v3-acceptance-runbook-result.v1"), "readiness runbook missing result schema");
  assert(runbook.includes("RESULT_READINESS_ID"), "readiness runbook missing readiness identity binding");
  assert(runbook.includes("readinessReportId"), "readiness runbook missing readiness report id result field");
  assert(runbook.includes("blockingFailedCount"), "readiness runbook missing blocking failure result field");
  assert(runbook.includes("productionSafe"), "readiness runbook missing production safety result field");

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
  const nativeCamStep = report.acceptancePlan.steps.find((step) => step.id === "native-cam-readiness");
  assert(nativeCamStep?.evidence?.includes("native-cam-server-package.json"), `${label} native CAM step missing server package manifest evidence`);
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
    assert(report.camServerConfig.deploymentValidation?.schema === "hediao3d.cam-server-deployment-validation.v1", `${label} camServerConfig missing deployment validation summary`);
    assert(report.camServerConfig.deploymentValidation.stages?.some((stage) => stage.id === "external-handoff-smoke"), `${label} deployment validation missing external handoff stage`);
    assert(report.acceptancePlan.steps.some((step) => step.id === "cam-server-config"), `${label} acceptance plan missing CAM server config step`);
  }
  assert(Object.hasOwn(report, "runbookResult"), `${label} missing runbookResult field`);
  assert(Object.hasOwn(report, "nativeCamRealOutputAcceptance"), `${label} missing nativeCamRealOutputAcceptance field`);
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
    assert(typeof report.neutralImport.sourceBindingStatus === "string", `${label} neutralImport source binding status missing`);
  }
  assert(Object.hasOwn(report, "postprocessHandoffReadiness"), `${label} missing postprocessHandoffReadiness field`);
  if (report.postprocessHandoffReadiness) {
    assert(report.postprocessHandoffReadiness.schema === "hediao3d.v3-postprocess-handoff-readiness.v1", `${label} postprocess handoff schema mismatch`);
    assert(["ready", "review", "pending", "blocked"].includes(report.postprocessHandoffReadiness.status), `${label} postprocess handoff status mismatch`);
    assert(typeof report.postprocessHandoffReadiness.required === "boolean", `${label} postprocess handoff required flag missing`);
    assert(typeof report.postprocessHandoffReadiness.sourceBindingStatus === "string", `${label} postprocess handoff source binding status missing`);
  }
  assert(Object.hasOwn(report, "camoticsImport"), `${label} missing camoticsImport field`);
  if (report.camoticsImport) {
    assert(report.camoticsImport.schema === "hediao3d.camotics-import-contract.v1", `${label} camoticsImport schema mismatch`);
    assert(typeof report.camoticsImport.productionEvidenceEligible === "boolean", `${label} camoticsImport eligibility missing`);
    assert(typeof report.camoticsImport.inputIdentityStatus === "string", `${label} camoticsImport input identity status missing`);
  }
  assert(Object.hasOwn(report, "readinessCamoticsEvidence"), `${label} missing readinessCamoticsEvidence field`);
  if (report.readinessCamoticsEvidence) {
    assert(report.readinessCamoticsEvidence.schema === "hediao3d.readiness-camotics-evidence.v1", `${label} readinessCamoticsEvidence schema mismatch`);
    assert(typeof report.readinessCamoticsEvidence.productionEvidenceEligible === "boolean", `${label} readiness CAMotics eligibility missing`);
    assert(typeof report.readinessCamoticsEvidence.source === "string", `${label} readiness CAMotics source missing`);
    assert(typeof report.readinessCamoticsEvidence.inputIdentityStatus === "string", `${label} readiness CAMotics input status missing`);
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
  assert(report.acceptancePlan.steps.some((step) => step.id === "v3-small-loop" && step.evidence?.includes("rotary-calibration-airrun.nc")), `${label} V3 small loop missing rotary calibration evidence`);
  assert(report.acceptancePlan.steps.some((step) => step.id === "camotics-cli-package" && step.evidence?.includes("camotics-cli-run-package.json")), `${label} missing CAMotics CLI package acceptance step`);
  if (report.latestEvidenceDossier) {
    assert(report.latestEvidenceDossier.schema === "hediao3d.production-evidence-dossier.v1", `${label} evidence dossier schema mismatch`);
    assert(typeof report.latestEvidenceDossier.reviewCount === "number", `${label} evidence dossier reviewCount missing`);
    assert(report.latestEvidenceDossier.crossChecks, `${label} evidence dossier crossChecks missing`);
    assert(typeof report.latestEvidenceDossier.crossChecks.ncStaticReady === "boolean", `${label} evidence dossier NC static cross-check missing`);
    assert(typeof report.latestEvidenceDossier.crossChecks.camoticsInputIdentityStatus === "string", `${label} evidence dossier CAMotics input cross-check missing`);
    assert(Object.hasOwn(report.latestEvidenceDossier.crossChecks, "productionReadinessAudit"), `${label} evidence dossier production readiness audit missing`);
    if (report.latestEvidenceDossier.crossChecks.productionReadinessAudit) {
      assert(report.latestEvidenceDossier.crossChecks.productionReadinessAudit.schema === "hediao3d.production-readiness-audit.v1", `${label} production readiness audit schema mismatch`);
      assert(typeof report.latestEvidenceDossier.crossChecks.productionReadinessAudit.allowProductionPackage === "boolean", `${label} production readiness audit package flag missing`);
    }
    assert(report.acceptancePlan.steps.some((step) => step.id === "production-evidence-dossier"), `${label} acceptance plan missing evidence dossier step`);
  }
}

function validateRunbookResult(result, label) {
  assert(result.schema === "hediao3d.v3-acceptance-runbook-result.v1", `${label} schema mismatch`);
  assert(typeof result.ok === "boolean", `${label} ok missing`);
  assert(typeof result.failedCount === "number", `${label} failedCount missing`);
  assert(typeof result.blockingFailedCount === "number", `${label} blockingFailedCount missing`);
  assert(Array.isArray(result.failedSteps), `${label} failedSteps missing`);
  assert(typeof result.stepCount === "number", `${label} stepCount missing`);
  assert(typeof result.commandCount === "number", `${label} commandCount missing`);
  assert(typeof result.productionSafe === "boolean", `${label} productionSafe missing`);
  assert(typeof result.identityValid === "boolean", `${label} identityValid missing`);
  assert(Object.hasOwn(result, "readinessReportId"), `${label} readinessReportId missing`);
  assert(Object.hasOwn(result, "readinessCreatedAt"), `${label} readinessCreatedAt missing`);
  assert(Object.hasOwn(result, "runbookGeneratedAt"), `${label} runbookGeneratedAt missing`);
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
