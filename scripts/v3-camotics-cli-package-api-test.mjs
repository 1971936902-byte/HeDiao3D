#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const baseUrl = process.env.V3_API_BASE ?? "http://127.0.0.1:8787";
const modelUrl = process.env.V3_SMOKE_MODEL_URL ?? "/meshy-results/019f6a05-c78b-7c70-b07f-ea857a54bea5.glb";
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankLeftMidDiameterMm: 14.6,
  blankCenterDiameterMm: 15,
  blankRightMidDiameterMm: 14.6,
  blankRightDiameterMm: 13.8,
  depthMm: 1.25,
  reliefAngleDeg: 360,
  contrast: 1.45,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  endTransitionMm: 1.2,
  toolDiameter: 4,
  stepoverDeg: 5,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  const startedAt = Date.now();
  const created = await postJson("/api/orchestrator/jobs", { modelUrl, settings, engine: "auto" });
  assert(created.id, "created job missing id");
  const job = await waitForJob(created.id, startedAt);
  assert(job.status === "completed", `job did not complete: ${job.status}`);

  const previewText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-preview.nc`);
  const previewSha256 = createHash("sha256").update(previewText).digest("hex");
  const previewMotionProfile = createPreviewMotionProfile(previewText);
  const candidatePackageValidationText = JSON.stringify({
    schema: "hediao3d.opencamlib-candidate-package-validation.v1",
    level: "ready",
    handoffContract: { status: "ready-for-hediao3d-import" },
    contactValidation: { level: "ready", evidenceClass: "production-candidate", checkCount: 27 },
    artifactManifest: { readyForImport: true, evidenceClass: "production-candidate" },
    machineFit: {
      schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
      level: "ok",
      targetMachine: { controllerClass: "3axis-controller-with-rotary-fixture", rotaryOutputAxis: "Y", wrapPerRevolutionMm: 100, toolProfileId: "vflat-4mm-25deg" },
      coverage: { pointCount: 231, rotarySpanDeg: 360, expectedRotaryCoverageDeg: 360, rotaryCoverageRatio: 1, depthMax: 0.8 },
      riskCounts: { holdZonePointCount: 0, deepPointCount: 0, invalidPointCount: 0, missingRotaryCount: 0 }
    }
  }, null, 2);
  const candidatePackageBundleText = "PK fixture candidate package bundle";
  const nativeSnapshotText = JSON.stringify({
    schema: "hediao3d.native-cam-real-output-snapshot.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    source: "test-fixture",
    productionUnlockEligible: false,
    acceptance: { id: "native-cam-snapshot-fixture", level: "ready" },
    gateHints: {
      level: "ready",
      sourceReportBindingStatus: "matched",
      targetMachineBoundaryStatus: "matched",
      contactValidationStatus: "ready",
      productionCandidateCount: 1,
      canSupportProductionCandidateReview: true
    }
  }, null, 2);
  const jobDir = join(process.cwd(), "public", "orchestrator-jobs", job.id);
  writeFileSync(join(jobDir, "native-cam-real-output-snapshot.json"), nativeSnapshotText, "utf8");
  writeFileSync(join(jobDir, "opencamlib-candidate-package-validation.json"), candidatePackageValidationText, "utf8");
  writeFileSync(join(jobDir, "opencamlib-candidate-package-bundle.zip"), candidatePackageBundleText, "utf8");
  let nativeSnapshotSha = createHash("sha256").update(nativeSnapshotText).digest("hex");
  const candidatePackageValidationSha = createHash("sha256").update(candidatePackageValidationText).digest("hex");
  const candidatePackageBundleSha = createHash("sha256").update(candidatePackageBundleText).digest("hex");

  const prepared = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-cli-package`, {});
  assert(prepared.ok === true, `CAMotics CLI package should be ready, got ${prepared.status}`);
  assert(prepared.report?.safetyLocks?.productionUnlockFromPreparePackage === false, "prepare package must not unlock production");
  assert(prepared.report?.preferredGcodeIdentity?.sha256 === previewSha256, "API report preview hash mismatch");
  assert(prepared.report?.preferredGcodeIdentity?.motionProfile?.motionLineCount === previewMotionProfile.motionLineCount, "API report motion count mismatch");
  assert(prepared.productionClosureAudit?.schema === "hediao3d.production-closure-audit.v1", "prepare package response missing production closure audit");
  assert(prepared.productionClosureAudit.steps?.some((step) => step.id === "camotics-material-removal"), "prepare package closure audit should include CAMotics material-removal step");
  const actualNativeSnapshotText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/native-cam-real-output-snapshot.json`);
  nativeSnapshotSha = createHash("sha256").update(actualNativeSnapshotText).digest("hex");

  const runPackage = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  assert(runPackage.schema === "hediao3d.camotics-cli-run-package.v1", "run package schema mismatch");
  assert(runPackage.status === "ready-for-linux-camotics", `run package status mismatch: ${runPackage.status}`);
  assert(runPackage.preferredGcodeIdentity?.sha256 === previewSha256, "run package preview hash mismatch");
  assert(runPackage.preferredGcodeIdentity?.motionProfile?.zMin === previewMotionProfile.zMin, "run package zMin mismatch");
  assert(runPackage.preferredGcodeIdentity?.motionProfile?.zMax === previewMotionProfile.zMax, "run package zMax mismatch");
  assert(runPackage.upstreamCamEvidence?.schema === "hediao3d.camotics-upstream-cam-evidence.v1", "run package should expose upstream CAM evidence binding");
  assert(runPackage.upstreamCamEvidence?.nativeCamRealOutputSnapshot?.schema === "hediao3d.native-cam-real-output-snapshot.v1", "run package should summarize job-local Native CAM snapshot");
  assert(runPackage.upstreamCamEvidence?.nativeCamRealOutputSnapshot?.productionUnlockEligible === false, "Native CAM snapshot summary must not unlock production");
  assert(runPackage.upstreamCamEvidence?.candidateMachineFit?.level === "ok", "run package should carry OpenCAMLib candidate machine-fit");
  assert(runPackage.upstreamCamEvidence?.candidateMachineFit?.targetMachine?.rotaryOutputAxis === "Y", "run package should carry machine-fit rotary axis");
  assert(runPackage.upstreamCamEvidence?.files?.some((file) => file.key === "nativeCamRealOutputSnapshot" && file.exists && file.sha256 === nativeSnapshotSha), "run package should hash-bind job-local Native CAM snapshot");
  assert(runPackage.upstreamCamEvidence?.files?.some((file) => file.key === "opencamlibCandidatePackageValidation" && file.exists && file.sha256 === candidatePackageValidationSha), "run package should hash-bind OpenCAMLib candidate package validation");
  assert(runPackage.upstreamCamEvidence?.files?.some((file) => file.key === "opencamlibCandidatePackageBundle" && file.exists && file.sha256 === candidatePackageBundleSha), "run package should hash-bind OpenCAMLib candidate package bundle");
  assert(runPackage.safetyLocks?.productionUnlockFromPreparePackage === false, "run package must keep production locked");
  const runPackageText = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-cli-run-package.json`);
  const runPackageSha256 = createHash("sha256").update(runPackageText).digest("hex");

  const template = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-template.json`);
  assert(template.schema === "hediao3d.camotics-result.v1", "result template schema mismatch");
  assert(template.inputs?.preferredGcodeSha256 === previewSha256, "result template should include preview hash");
  assert(template.inputs?.camoticsCliRunPackageSha256 === runPackageSha256, "result template should bind to current CLI run package hash");
  assert(template.inputs?.machineContext?.rotaryWrapAxis === "Y", "result template should bind Y rotary machine context");
  assert(template.inputs?.machineContext?.rotaryWrapPerRevolutionMm === 100, "result template should bind rotary wrap distance");
  assert(template.inputs?.upstreamCamEvidence?.schema === "hediao3d.camotics-upstream-cam-evidence.v1", "result template should include upstream CAM evidence binding");
  assert(template.inputs?.upstreamCamEvidence?.nativeCamRealOutputSnapshot?.schema === "hediao3d.native-cam-real-output-snapshot.v1", "result template should carry Native CAM snapshot summary");
  assert(template.inputs?.upstreamCamEvidence?.files?.some((file) => file.key === "nativeCamRealOutputSnapshot" && file.sha256 === nativeSnapshotSha), "result template should carry Native CAM snapshot evidence hash");
  assert(template.inputs?.upstreamCamEvidence?.candidateMachineFit?.level === "ok", "result template should carry candidate machine-fit evidence");
  assert(template.inputs?.upstreamCamEvidence?.files?.some((file) => file.key === "opencamlibCandidatePackageValidation" && file.sha256 === candidatePackageValidationSha), "result template should carry candidate package validation evidence hash");
  assert(template.inputs?.upstreamCamEvidence?.files?.some((file) => file.key === "opencamlibCandidatePackageBundle" && file.sha256 === candidatePackageBundleSha), "result template should carry candidate package bundle evidence hash");
  assert(template.metrics?.materialRemovedMm3 === null, "result template must require real material volume");

  const runScript = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-linux-run.sh`);
  assert(runScript.includes("camotics"), "Linux run script should mention camotics command");
  assert(runScript.includes(previewSha256), "Linux run script should echo expected SHA-256");
  const operatorChecklist = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-linux-operator-checklist.md`);
  assert(operatorChecklist.includes("HeDiao3D CAMotics Linux 操作清单"), "operator checklist missing heading");
  assert(operatorChecklist.includes(previewSha256), "operator checklist should bind preferred G-code hash");
  assert(operatorChecklist.includes(runPackageSha256), "operator checklist should bind run package hash");
  assert(operatorChecklist.includes("inputs.machineContext.rotaryWrapAxis"), "operator checklist should require machine context");
  assert(operatorChecklist.includes("productionEvidenceEligible=true"), "operator checklist should require production evidence validation");
  const validatorScript = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-result-validate.js`);
  assert(validatorScript.includes("hediao3d.camotics-result-local-validation.v1"), "validator should emit local validation schema");
  assert(validatorScript.includes("camotics-result-bundle.zip"), "validator should write uploadable CAMotics result bundle");
  assert(validatorScript.includes("README-CAMOTICS-RESULT.md"), "validator bundle should include README");
  assert(validatorScript.includes("machine-context"), "validator should check machine context");
  assert(validatorScript.includes(runPackageSha256), "validator should bind to current run package hash");
  assert(validatorScript.includes(previewSha256), "validator should bind to current preview G-code hash");
  assert(validatorScript.includes("nativeCamRealOutputSnapshot"), "validator should bind CAMotics results to job-local Native CAM snapshot evidence");
  assert(validatorScript.includes("opencamlibCandidatePackageValidation"), "validator should bind CAMotics results to candidate package validation evidence");
  assert(validatorScript.includes("opencamlibCandidatePackageBundle"), "validator should bind CAMotics results to candidate package bundle evidence");
  runLocalValidatorFixture({
    jobId: job.id,
    validatorScript,
    previewSha256,
    runPackageSha256,
    previewMotionProfile,
    upstreamCamEvidence: runPackage.upstreamCamEvidence
  });

  const preflight = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-execution-preflight`, {});
  assert(preflight.report?.schema === "hediao3d.camotics-execution-preflight.v1", "preflight report schema mismatch");
  assert(preflight.report?.productionUnlockEligible === false, "preflight must not unlock production");
  assert(preflight.report?.package?.preferredGcodeSha256 === previewSha256, "preflight should bind preferred G-code hash");
  assert(preflight.report?.files?.runPackageExists === true, "preflight should see run package");
  assert(preflight.report?.files?.validatorExists === true, "preflight should see result validator");
  assert(Array.isArray(preflight.report?.nextActions), "preflight should expose next actions");
  assert(preflight.productionClosureAudit?.schema === "hediao3d.production-closure-audit.v1", "preflight response missing production closure audit");
  assert(preflight.productionClosureAudit.steps?.some((step) => step.id === "camotics-material-removal"), "preflight closure audit should include CAMotics material-removal step");
  const preflightMarkdown = await getText(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/camotics-execution-preflight.md`);
  assert(preflightMarkdown.includes("HeDiao3D CAMotics Execution Preflight"), "preflight markdown missing heading");

  const reloaded = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloaded.result?.summary?.camoticsCliPackage?.artifact === "camotics-cli-run-package.json", "job summary missing CLI package");
  assert(reloaded.result?.summary?.camoticsCliPackage?.operatorChecklist === "camotics-linux-operator-checklist.md", "job summary missing operator checklist");
  assert(reloaded.result?.summary?.camoticsCliPackage?.productionUnlockEligible === false, "summary must keep production unlock false");
  assert(reloaded.result?.summary?.camoticsExecutionPreflight?.artifact === "camotics-execution-preflight.json", "job summary missing CAMotics execution preflight");
  assert(reloaded.result?.summary?.productionClosureAudit?.schema === "hediao3d.production-closure-audit.v1", "job summary missing production closure audit after CAMotics prepare/preflight");
  assert(reloaded.result.summary.productionClosureAudit.steps?.some((step) => step.id === "camotics-material-removal"), "job summary closure audit should include CAMotics material-removal step");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-cli-run-package.json" && file.exists), "delivery manifest missing run package");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-linux-operator-checklist.md" && file.exists), "delivery manifest missing operator checklist");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-result-validate.js" && file.exists), "delivery manifest missing result validator");
  assert(reloaded.result?.summary?.deliveryManifest?.files?.some((file) => file.filename === "camotics-execution-preflight.json" && file.exists), "delivery manifest missing execution preflight");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-cli-run-package.json" && file.sha256), "package integrity missing run package hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-linux-run.sh" && file.sha256), "package integrity missing run script hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-result-validate.js" && file.sha256), "package integrity missing result validator hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-linux-operator-checklist.md" && file.sha256), "package integrity missing operator checklist hash");
  assert(reloaded.result?.summary?.packageIntegrity?.files?.some((file) => file.filename === "camotics-execution-preflight.json" && file.sha256), "package integrity missing execution preflight hash");

  const linuxPackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/camotics-linux-package`);
  assert(linuxPackage.bytes[0] === 0x50 && linuxPackage.bytes[1] === 0x4b, "CAMotics Linux package should be a ZIP file");
  assert((linuxPackage.contentType ?? "").includes("application/zip"), "CAMotics Linux package should use application/zip content type");
  const linuxZipNames = listZipFilenames(linuxPackage.bytes);
  assert(linuxZipNames.includes("hediao3d-v3-camotics/README-CAMOTICS.md"), "CAMotics Linux package missing README");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/camotics-linux-package-manifest.json"), "CAMotics Linux package missing manifest");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/inputs/camotics-preview.nc"), "CAMotics Linux package missing preview NC");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-linux-run.sh"), "CAMotics Linux package missing run script");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-result-validate.js"), "CAMotics Linux package missing result validator");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-linux-operator-checklist.md"), "CAMotics Linux package missing operator checklist");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/references/camotics-execution-preflight.json"), "CAMotics Linux package missing execution preflight report");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/references/native-cam-real-output-snapshot.json"), "CAMotics Linux package missing Native CAM snapshot reference");
  assert(linuxZipNames.includes("hediao3d-v3-camotics/run/camotics-result-template.json"), "CAMotics Linux package missing result template");
  const camoticsLinuxManifest = JSON.parse(readStoredZipEntry(linuxPackage.bytes, "hediao3d-v3-camotics/camotics-linux-package-manifest.json"));
  assert(camoticsLinuxManifest.runPackage?.upstreamCamEvidence?.files?.some((file) => file.key === "nativeCamRealOutputSnapshot" && file.sha256 === nativeSnapshotSha), "CAMotics Linux manifest should expose Native CAM snapshot evidence hash");

  const openCamLibInputsPackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/opencamlib-candidate-inputs.zip`);
  assert(openCamLibInputsPackage.bytes[0] === 0x50 && openCamLibInputsPackage.bytes[1] === 0x4b, "OpenCAMLib candidate input package should be a ZIP file");
  assert((openCamLibInputsPackage.contentType ?? "").includes("application/zip"), "OpenCAMLib candidate input package should use application/zip content type");
  const openCamLibInputZipNames = listZipFilenames(openCamLibInputsPackage.bytes);
  assert(openCamLibInputZipNames.includes("hediao3d-opencamlib-candidate-inputs/job.json"), "OpenCAMLib input ZIP missing job.json");
  assert(openCamLibInputZipNames.includes("hediao3d-opencamlib-candidate-inputs/opencamlib-kernel-plan.json"), "OpenCAMLib input ZIP missing kernel plan");
  assert(openCamLibInputZipNames.includes("hediao3d-opencamlib-candidate-inputs/repaired-model.stl"), "OpenCAMLib input ZIP missing STL model");
  assert(openCamLibInputZipNames.includes("hediao3d-opencamlib-candidate-inputs/opencamlib-candidate-input-manifest.json"), "OpenCAMLib input ZIP missing manifest");
  assert(openCamLibInputZipNames.includes("hediao3d-opencamlib-candidate-inputs/README-OPENCAMLIB-CANDIDATE.md"), "OpenCAMLib input ZIP missing README");

  const linuxCamJobPackage = await getBinary(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-job-package`);
  assert(linuxCamJobPackage.bytes[0] === 0x50 && linuxCamJobPackage.bytes[1] === 0x4b, "Linux CAM job package should be a ZIP file");
  assert((linuxCamJobPackage.contentType ?? "").includes("application/zip"), "Linux CAM job package should use application/zip content type");
  const linuxCamJobZipNames = listZipFilenames(linuxCamJobPackage.bytes);
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/README-LINUX-CAM-JOB.md"), "Linux CAM job package missing README");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/linux-cam-job-package-manifest.json"), "Linux CAM job package missing manifest");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/run-linux-cam-job.sh"), "Linux CAM job package missing one-command run script");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/validate-linux-cam-job.mjs"), "Linux CAM job package missing local validation script");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/native-cam/opencamlib-candidate-inputs/job.json"), "Linux CAM job package missing OpenCAMLib job spec");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/native-cam/opencamlib-candidate-inputs/opencamlib-kernel-plan.json"), "Linux CAM job package missing OpenCAMLib kernel plan");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/native-cam/opencamlib-candidate-inputs/repaired-model.stl"), "Linux CAM job package missing OpenCAMLib STL input");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/camotics/inputs/camotics-preview.nc"), "Linux CAM job package missing CAMotics preview NC");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/camotics/run/camotics-linux-run.sh"), "Linux CAM job package missing CAMotics run script");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/camotics/run/camotics-result-validate.js"), "Linux CAM job package missing CAMotics validator");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/references/linux-cam-closed-loop-handoff.md"), "Linux CAM job package missing closed-loop handoff reference");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/references/package-integrity.json"), "Linux CAM job package missing package integrity reference");
  assert(linuxCamJobZipNames.includes("hediao3d-v3-linux-cam-job/references/native-cam-real-output-snapshot.json"), "Linux CAM job package missing Native CAM snapshot reference");
  const linuxCamJobManifest = JSON.parse(readStoredZipEntry(linuxCamJobPackage.bytes, "hediao3d-v3-linux-cam-job/linux-cam-job-package-manifest.json"));
  assert(linuxCamJobManifest.camotics?.runPackage?.upstreamCamEvidence?.files?.some((file) => file.key === "nativeCamRealOutputSnapshot" && file.sha256 === nativeSnapshotSha), "Linux CAM job manifest should expose Native CAM snapshot evidence hash");
  assert(linuxCamJobManifest.references?.some((file) => file.name === "hediao3d-v3-linux-cam-job/references/native-cam-real-output-snapshot.json" && file.sha256 === nativeSnapshotSha), "Linux CAM job manifest should hash Native CAM snapshot reference");
  const linuxCamJobValidator = readStoredZipEntry(linuxCamJobPackage.bytes, "hediao3d-v3-linux-cam-job/validate-linux-cam-job.mjs");
  assert(linuxCamJobValidator.includes("hediao3d.v3-linux-cam-job-local-validation.v1"), "Linux CAM job validator missing local validation schema");
  assert(linuxCamJobValidator.includes("hediao3d.v3-linux-cam-job-evidence-status.v1"), "Linux CAM job validator missing evidence status schema");
  assert(linuxCamJobValidator.includes("hediao3d.v3-linux-cam-job-upload-plan.v1"), "Linux CAM job validator missing upload plan schema");
  assert(linuxCamJobValidator.includes("/api/orchestrator/native-cam/real-output-acceptance"), "Linux CAM job validator should name Native CAM upload endpoint");
  assert(linuxCamJobValidator.includes(`/api/orchestrator/jobs/${"${manifest.jobId}"}/camotics-result`) || linuxCamJobValidator.includes("camotics-result"), "Linux CAM job validator should name CAMotics job upload endpoint");
  assert(linuxCamJobValidator.includes("ready-for-upload") && linuxCamJobValidator.includes("missingUploads"), "Linux CAM job validator should summarize upload readiness");
  assert(linuxCamJobValidator.includes("present-hash-matched"), "Linux CAM job validator should verify manifest file hashes");
  assert(linuxCamJobValidator.includes("native-cam-real-output-bundle.zip") && linuxCamJobValidator.includes("camotics-result-bundle.zip"), "Linux CAM job validator should name expected upload bundles");
  const linuxCamJobExtractDir = join(tmpdir(), `hediao3d-linux-cam-job-${job.id}`);
  rmSync(linuxCamJobExtractDir, { recursive: true, force: true });
  mkdirSync(linuxCamJobExtractDir, { recursive: true });
  extractStoredZip(linuxCamJobPackage.bytes, linuxCamJobExtractDir);
  const linuxCamJobRoot = join(linuxCamJobExtractDir, "hediao3d-v3-linux-cam-job");
  const localValidationRun = spawnSync(process.execPath, ["validate-linux-cam-job.mjs", "."], {
    cwd: linuxCamJobRoot,
    encoding: "utf8"
  });
  assert(localValidationRun.status === 0, `Linux CAM job local validator failed: ${localValidationRun.stderr || localValidationRun.stdout}`);
  const localValidation = JSON.parse(readFileSync(join(linuxCamJobRoot, "linux-cam-job-local-validation.json"), "utf8"));
  assert(localValidation.schema === "hediao3d.v3-linux-cam-job-local-validation.v1", "Linux CAM job local validation schema mismatch");
  assert(localValidation.level === "waiting-for-linux-evidence", `Linux CAM job local validation should wait for real evidence, got ${localValidation.level}`);
  assert(localValidation.packageIntegrityOk === true, "Linux CAM job local validation should verify manifest hashes");
  assert(localValidation.evidenceStatus?.phase === "waiting-for-linux-evidence", "Linux CAM job local validation should expose evidence waiting phase");
  assert(localValidation.evidenceStatus?.packageIntegrityOk === true, "Linux CAM job evidence status should preserve package integrity");
  assert(localValidation.evidenceStatus?.nativeCamBundle === "missing", "Linux CAM job evidence status should require Native CAM bundle");
  assert(localValidation.evidenceStatus?.camoticsBundle === "missing", "Linux CAM job evidence status should require CAMotics bundle");
  assert(localValidation.evidenceStatus?.missingUploads?.includes("native-cam-real-output-bundle.zip"), "Linux CAM job evidence status should list Native CAM upload");
  assert(localValidation.evidenceStatus?.missingUploads?.includes("camotics-result-bundle.zip"), "Linux CAM job evidence status should list CAMotics upload");
  assert(localValidation.uploadPlan?.readyForUpload === false, "Linux CAM job upload plan should start waiting");
  assert(localValidation.uploadPlan?.readyCount === 0, "Linux CAM job upload plan should start with no ready bundles");
  assert(localValidation.uploadPlan?.items?.some((item) => item.id === "native-cam-real-output" && item.endpoint === "/api/orchestrator/native-cam/real-output-acceptance" && item.status === "missing"), "Linux CAM job upload plan should include missing Native CAM upload target");
  assert(localValidation.uploadPlan?.items?.some((item) => item.id === "camotics-material-removal" && item.endpoint === `/api/orchestrator/jobs/${job.id}/camotics-result` && item.status === "missing"), "Linux CAM job upload plan should include missing CAMotics upload target");
  assert(Array.isArray(localValidation.hashMismatches) && localValidation.hashMismatches.length === 0, "Linux CAM job local validation should not report hash mismatches");
  assert(localValidation.productionUnlockEligible === false, "Linux CAM job local validation must not unlock production");
  assert(localValidation.expectedUploads?.nativeCam === "native-cam-real-output-bundle.zip", "Linux CAM job local validation missing Native CAM expected upload");
  assert(localValidation.expectedUploads?.camotics === "camotics-result-bundle.zip", "Linux CAM job local validation missing CAMotics expected upload");

  writeFileSync(join(linuxCamJobRoot, "native-cam-real-output-bundle.zip"), "PK fixture native cam upload bundle", "utf8");
  writeFileSync(join(linuxCamJobRoot, "camotics-result-bundle.zip"), "PK fixture camotics upload bundle", "utf8");
  const readyValidationRun = spawnSync(process.execPath, ["validate-linux-cam-job.mjs", "."], {
    cwd: linuxCamJobRoot,
    encoding: "utf8"
  });
  assert(readyValidationRun.status === 0, `Linux CAM job ready validator failed: ${readyValidationRun.stderr || readyValidationRun.stdout}`);
  const readyValidation = JSON.parse(readFileSync(join(linuxCamJobRoot, "linux-cam-job-local-validation.json"), "utf8"));
  assert(readyValidation.level === "ready-for-v3-upload", `Linux CAM job local validation should become upload-ready, got ${readyValidation.level}`);
  assert(readyValidation.evidenceStatus?.phase === "ready-for-upload", "Linux CAM job evidence status should become ready-for-upload");
  assert(readyValidation.evidenceStatus?.readyForUpload === true, "Linux CAM job evidence status should mark readyForUpload");
  assert(readyValidation.evidenceStatus?.nativeCamBundle === "present", "Linux CAM job evidence status should see Native CAM bundle");
  assert(readyValidation.evidenceStatus?.camoticsBundle === "present", "Linux CAM job evidence status should see CAMotics bundle");
  assert(Array.isArray(readyValidation.evidenceStatus?.missingUploads) && readyValidation.evidenceStatus.missingUploads.length === 0, "ready Linux CAM job evidence status should not list missing uploads");
  assert(readyValidation.uploadPlan?.readyForUpload === true, "ready Linux CAM job upload plan should be upload-ready");
  assert(readyValidation.uploadPlan?.readyCount === 2, "ready Linux CAM job upload plan should count both bundles");
  assert(readyValidation.uploadPlan?.items?.every((item) => item.status === "present"), "ready Linux CAM job upload plan should mark all items present");
  assert(readyValidation.productionUnlockEligible === false, "ready-for-upload Linux CAM job validation must still not unlock production");

  const importedLinuxCamJobValidation = await postJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/linux-cam-job-validation`, {
    validation: readyValidation,
    sourceName: "linux-cam-job-local-validation.json"
  });
  assert(importedLinuxCamJobValidation.ok === true, "Linux CAM job validation import should succeed");
  assert(importedLinuxCamJobValidation.productionUnlockEligible === false, "Linux CAM job validation import must not unlock production");
  assert(importedLinuxCamJobValidation.validation?.level === "ready-for-v3-upload", "Linux CAM job validation import should preserve ready-for-upload level");
  assert(importedLinuxCamJobValidation.validation?.evidenceStatus?.phase === "ready-for-upload", "Linux CAM job validation import should preserve ready evidence phase");
  assert(importedLinuxCamJobValidation.validation?.uploadPlan?.readyForUpload === true, "Linux CAM job validation import should preserve upload plan");
  assert(importedLinuxCamJobValidation.artifacts?.validation?.endsWith("linux-cam-job-local-validation.json"), "Linux CAM job validation import should expose validation artifact");
  assert(importedLinuxCamJobValidation.productionClosureAudit?.schema === "hediao3d.production-closure-audit.v1", "Linux CAM job validation response missing production closure audit");
  assert(importedLinuxCamJobValidation.productionClosureAudit.steps?.some((step) => step.id === "native-cam-real-output"), "Linux CAM job validation closure audit should include external CAM step");
  const reloadedAfterLinuxCamJobValidation = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}`);
  assert(reloadedAfterLinuxCamJobValidation.result?.summary?.linuxCamJobValidation?.level === "ready-for-v3-upload", "job summary should expose upload-ready Linux CAM job validation");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.linuxCamJobValidation.evidenceStatus?.nativeCamBundle === "present", "job summary should expose Linux CAM job evidence status");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.linuxCamJobValidation.uploadPlan?.readyCount === 2, "job summary should expose Linux CAM job upload plan");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.linuxCamJobValidation.productionUnlockEligible === false, "job summary Linux CAM job validation must not unlock production");
  assert(reloadedAfterLinuxCamJobValidation.result?.summary?.productionClosureAudit?.schema === "hediao3d.production-closure-audit.v1", "job summary missing production closure audit after Linux CAM job validation import");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.productionClosureAudit.steps?.some((step) => step.id === "native-cam-real-output"), "job summary closure audit should include external CAM step after Linux validation import");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.deliveryManifest.files?.some((file) => file.filename === "linux-cam-job-local-validation.json" && file.exists), "delivery manifest should expose Linux CAM job local validation");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.deliveryManifest.files?.some((file) => file.filename === "linux-cam-job-validation-import.json" && file.exists), "delivery manifest should expose Linux CAM job validation import audit");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.packageIntegrity.files?.some((file) => file.filename === "linux-cam-job-local-validation.json" && file.sha256), "package integrity should hash Linux CAM job local validation");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.packageIntegrity.files?.some((file) => file.filename === "linux-cam-job-validation-import.json" && file.sha256), "package integrity should hash Linux CAM job validation import audit");
  assert(reloadedAfterLinuxCamJobValidation.result.summary.packageIntegrity.files?.some((file) => file.filename === "production-closure-audit.json" && file.sha256), "package integrity should hash production closure audit after Linux validation import");
  const importedLinuxCamJobValidationArtifact = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/linux-cam-job-local-validation.json`);
  assert(importedLinuxCamJobValidationArtifact.importedVia === "api-linux-cam-job-validation", "Linux CAM job validation artifact should record API import");
  const importedLinuxCamJobValidationAudit = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(job.id)}/artifacts/linux-cam-job-validation-import.json`);
  assert(importedLinuxCamJobValidationAudit.evidenceStatus?.camoticsBundle === "present", "Linux CAM job validation audit should expose evidence status");
  assert(importedLinuxCamJobValidationAudit.uploadPlan?.readyForUpload === true, "Linux CAM job validation audit should expose upload plan");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    status: prepared.status,
    motionProfile: runPackage.preferredGcodeIdentity.motionProfile,
    productionUnlockEligible: reloaded.result.summary.camoticsCliPackage.productionUnlockEligible
  }, null, 2));
}

function createPreviewMotionProfile(gcodeText) {
  const motionLines = String(gcodeText ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line));
  const zValues = motionLines
    .map((line) => {
      const match = line.match(/\bZ\s*(-?\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : NaN;
    })
    .filter(Number.isFinite);
  return {
    motionLineCount: motionLines.length,
    zMin: Math.min(...zValues),
    zMax: Math.max(...zValues),
    machineContext: createMachineContextFromGcode(gcodeText)
  };
}

function createMachineContextFromGcode(gcodeText) {
  const text = String(gcodeText ?? "");
  const axis = matchHeader(text, "ROTARY_WRAP_AXIS");
  const perRev = Number(matchHeader(text, "ROTARY_WRAP_PER_REV_MM"));
  const lengthAxis = matchHeader(text, "LENGTH_AXIS");
  return {
    schema: "hediao3d.camotics-machine-context.v1",
    camMode: axis ? "rotaryWrap" : "3axis",
    rotaryWrapAxis: axis ? axis.toUpperCase() : null,
    rotaryOutputAxis: axis ? axis.toUpperCase() : null,
    rotaryWrapPerRevolutionMm: Number.isFinite(perRev) ? perRev : null,
    lengthAxis: lengthAxis ? lengthAxis.toUpperCase() : "X",
    simulationInterpretation: axis ? "linearized-rotary-wrap-as-3axis" : "plain-3axis"
  };
}

function matchHeader(text, key) {
  const match = String(text ?? "").match(new RegExp(`${key}\\s*=\\s*([^\\s)]+)`, "i"));
  return match ? match[1] : null;
}

function runLocalValidatorFixture({ jobId, validatorScript, previewSha256, runPackageSha256, previewMotionProfile, upstreamCamEvidence }) {
  const dir = join(tmpdir(), `hediao3d-camotics-validator-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const validatorPath = join(dir, "camotics-result-validate.js");
    const resultPath = join(dir, "camotics-result.json");
    writeFileSync(validatorPath, validatorScript, "utf8");
    writeFileSync(join(dir, "camotics-preview.png"), "fixture-screenshot", "utf8");
    writeFileSync(join(dir, "camotics-material-removal.stl"), "solid fixture\nendsolid fixture\n", "utf8");
    writeFileSync(resultPath, JSON.stringify({
      schema: "hediao3d.camotics-result.v1",
      jobId,
      engine: "camotics",
      status: "completed",
      synthetic: false,
      riskLevel: "ready",
      summary: "Local validator fixture for CAMotics run package.",
      inputs: {
        preferredGcode: "camotics-preview.nc",
        preferredGcodeSha256: previewSha256,
        camoticsCliRunPackage: "camotics-cli-run-package.json",
        camoticsCliRunPackageSha256: runPackageSha256,
        machineContext: previewMotionProfile.machineContext,
        upstreamCamEvidence
      },
      metrics: {
        motionLineCount: previewMotionProfile.motionLineCount,
        zMin: previewMotionProfile.zMin,
        zMax: previewMotionProfile.zMax,
        materialRemovedMm3: 3.2
      },
      artifacts: {
        screenshot: "camotics-preview.png",
        materialMesh: "camotics-material-removal.stl"
      }
    }, null, 2), "utf8");
    const run = spawnSync(process.execPath, [validatorPath, resultPath], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true
    });
    assert(!run.error, `validator spawn failed: ${run.error?.message}`);
    assert(run.status === 0, `validator should pass fixture, exited ${run.status}: ${run.stderr || run.stdout}`);
    const report = JSON.parse(run.stdout);
    assert(report.ok === true, "validator report should be ok");
    assert(report.productionEvidenceEligible === true, "validator should mark passing fixture as production evidence eligible");
    assert(Array.isArray(report.missing) && report.missing.length === 0, "passing validator should not list missing checks");
    assert(/eligible to be imported/.test(report.summary), "passing validator should include import-ready summary");
    assert(report.checks?.some((check) => check.id === "run-package-hash" && check.ok), "validator should check run package hash");
    assert(report.checks?.some((check) => check.id === "visual-or-material-artifact" && check.ok), "validator should check visual/material artifact");
    const bundlePath = join(dir, "camotics-result-bundle.zip");
    assert(existsSync(bundlePath), "validator should write camotics-result-bundle.zip for passing fixture");
    const bundleNames = listZipFilenames(readFileSync(bundlePath));
    assert(bundleNames.includes("camotics-result.json"), "CAMotics result bundle missing result JSON");
    assert(bundleNames.includes("camotics-result-local-validation.json"), "CAMotics result bundle missing local validation");
    assert(bundleNames.includes("camotics-result-bundle-manifest.json"), "CAMotics result bundle missing bundle manifest");
    assert(bundleNames.includes("camotics-preview.png"), "CAMotics result bundle missing screenshot");
    assert(bundleNames.includes("camotics-material-removal.stl"), "CAMotics result bundle missing material mesh");
    assert(bundleNames.includes("README-CAMOTICS-RESULT.md"), "CAMotics result bundle missing README");

    writeFileSync(resultPath, JSON.stringify({
      schema: "hediao3d.camotics-result.v1",
      jobId,
      engine: "camotics",
      status: "completed",
      synthetic: false,
      riskLevel: "ready",
      inputs: {
        preferredGcodeSha256: previewSha256,
        camoticsCliRunPackageSha256: "bad-hash",
        machineContext: {
          ...previewMotionProfile.machineContext,
          rotaryWrapAxis: "X"
        }
      },
      metrics: {
        motionLineCount: previewMotionProfile.motionLineCount,
        zMin: previewMotionProfile.zMin,
        zMax: previewMotionProfile.zMax,
        materialRemovedMm3: 3.2
      },
      artifacts: {
        screenshot: "missing-preview.png",
        materialMesh: "missing-material-removal.stl"
      }
    }, null, 2), "utf8");
    const failedRun = spawnSync(process.execPath, [validatorPath, resultPath], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true
    });
    assert(failedRun.status !== 0, "validator should reject incomplete fixture");
    const failedReport = JSON.parse(failedRun.stdout);
    assert(failedReport.ok === false, "failed validator report should not be ok");
    assert(failedReport.productionEvidenceEligible === false, "failed validator should not be production evidence eligible");
    assert(failedReport.missing?.includes("run-package-hash"), "failed validator should list run-package-hash");
    assert(failedReport.missing?.includes("machine-context"), "failed validator should list machine-context");
    assert(failedReport.missing?.includes("visual-or-material-artifact"), "failed validator should list missing artifact evidence");
    assert(/failed/.test(failedReport.summary), "failed validator should include failed summary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${path}`);
  return data;
}

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status} ${path}`);
  return text;
}

async function getBinary(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(buffer.toString("utf8") || `${response.status} ${path}`);
  return {
    bytes: buffer,
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
  if (!response.ok) throw new Error(data.error ?? `${response.status} ${path}`);
  return data;
}

function listZipFilenames(bytes) {
  const names = [];
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const compressedSize = bytes.readUInt32LE(offset + 18);
      const fileNameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLength;
      names.push(bytes.subarray(nameStart, nameEnd).toString("utf8"));
      offset = nameEnd + extraLength + compressedSize;
      continue;
    }
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    offset += 1;
  }
  return names;
}

function readStoredZipEntry(bytes, wantedName) {
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const compressedSize = bytes.readUInt32LE(offset + 18);
      const fileNameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLength;
      const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
      const dataStart = nameEnd + extraLength;
      const dataEnd = dataStart + compressedSize;
      if (name === wantedName) return bytes.subarray(dataStart, dataEnd).toString("utf8");
      offset = dataEnd;
      continue;
    }
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    offset += 1;
  }
  throw new Error(`ZIP entry not found: ${wantedName}`);
}

function extractStoredZip(bytes, targetDir) {
  let offset = 0;
  while (offset < bytes.length - 4) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const compressedSize = bytes.readUInt32LE(offset + 18);
      const fileNameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLength;
      const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
      const dataStart = nameEnd + extraLength;
      const dataEnd = dataStart + compressedSize;
      const normalized = name.replace(/\\/g, "/");
      assert(!normalized.includes("..") && !normalized.startsWith("/"), `unsafe ZIP entry path: ${name}`);
      if (!normalized.endsWith("/")) {
        const outputPath = join(targetDir, ...normalized.split("/"));
        mkdirSync(join(outputPath, ".."), { recursive: true });
        writeFileSync(outputPath, bytes.subarray(dataStart, dataEnd));
      }
      offset = dataEnd;
      continue;
    }
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    offset += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
