#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const node = process.execPath;
const root = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), "hediao3d-native-cam-package-self-check-"));
const nativeCamCheck = resolve("scripts", "v3-linux-native-cam-check.mjs");

try {
  const generated = spawnSync(node, [nativeCamCheck], {
    cwd: root,
    env: {
      ...process.env,
      V3_NATIVE_CAM_CHECK_DIR: workDir
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(!generated.error, `native CAM package generation failed to start: ${generated.error?.message}`);
  assert(generated.status === 0, `native CAM package generation should exit 0 in non-strict mode: ${generated.stderr || generated.stdout}`);

  const selfCheckPath = join(workDir, "native-cam-server-package-self-check.mjs");
  assert(existsSync(selfCheckPath), "generated server package missing self-check script");
  const ready = spawnSync(node, [selfCheckPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(ready.status === 0, `self-check should pass generated package: ${ready.stderr || ready.stdout}`);
  const readyReport = JSON.parse(ready.stdout);
  assert(readyReport.schema === "hediao3d.native-cam-server-package-self-check.v1", "self-check schema mismatch");
  assert(readyReport.ok === true, "self-check should be ok for generated package");
  assert(readyReport.level === "ready", "self-check level should be ready");
  assert(readyReport.checks?.some((check) => check.id === "target-rotary-output-axis" && check.status === "pass"), "self-check should verify Y rotary output axis");
  assert(readyReport.checks?.some((check) => check.id === "camotics-validator-bundle" && check.status === "pass"), "self-check should verify CAMotics result bundle support");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-schema" && check.status === "pass"), "self-check should verify closed-loop check support");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-evidence-chain" && check.status === "pass"), "self-check should verify closed-loop evidence-chain support");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-opencamlib-coverage" && check.status === "pass"), "self-check should verify closed-loop OpenCAMLib coverage diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-opencamlib-protected-zones" && check.status === "pass"), "self-check should verify closed-loop OpenCAMLib protected-zone diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-opencamlib-candidate-package" && check.status === "pass"), "self-check should verify closed-loop OpenCAMLib candidate package validation");
  assert(readyReport.checks?.some((check) => check.id === "command:camotics-material-run" && check.status === "pass"), "self-check should verify CAMotics material-removal runner command");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-schema" && check.status === "pass"), "self-check should verify CAMotics runner schema");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-fail-closed" && check.status === "pass"), "self-check should verify CAMotics runner fail-closed production lock");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-real-command" && check.status === "pass"), "self-check should verify CAMotics runner real command and bundle path");
  assert(readyReport.checks?.some((check) => check.id === "camotics-validator-upstream-evidence-gate" && check.status === "pass"), "self-check should verify CAMotics validator rejects mismatched upstream CAM evidence");
  assert(readyReport.checks?.some((check) => check.id === "diagnostics-bundle-schema" && check.status === "pass"), "self-check should verify diagnostics bundle schema");
  assert(readyReport.checks?.some((check) => check.id === "diagnostics-bundle-zip" && check.status === "pass"), "self-check should verify diagnostics bundle ZIP support");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-contact-spike-schema" && check.status === "pass"), "self-check should verify OpenCAMLib contact spike schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-contact-spike-boundary" && check.status === "pass"), "self-check should verify OpenCAMLib contact spike boundary");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-runner-readiness-schema" && check.status === "pass"), "self-check should verify OpenCAMLib runner readiness schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-runner-production-lock" && check.status === "pass"), "self-check should verify OpenCAMLib runner production lock");
  assert(readyReport.checks?.some((check) => check.id === "file:opencamlib-real-candidate-run.mjs" && check.status === "pass"), "self-check should require OpenCAMLib real candidate runner file");
  assert(readyReport.checks?.some((check) => check.id === "command:opencamlib-real-candidate" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate command");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-real-candidate-schema" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-real-candidate-fail-closed" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate production lock");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-validator-residual-evidence-gate" && check.status === "pass"), "self-check should verify OpenCAMLib validator requires measured or validated residual evidence");
  assert(readyReport.checks?.some((check) => check.id === "real-output-runner-readiness" && check.status === "pass"), "self-check should verify real-output bundle carries OpenCAMLib runner readiness");
  assert(readyReport.checks?.some((check) => check.id === "real-output-real-candidate" && check.status === "pass"), "self-check should verify real-output bundle carries OpenCAMLib real candidate evidence");
  assert(readyReport.checks?.some((check) => check.id === "real-output-contact-path-coverage" && check.status === "pass"), "self-check should verify real-output bundle preserves contact pathCoverage diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "real-candidate-path-coverage" && check.status === "pass"), "self-check should verify real candidate runner summarizes contact pathCoverage diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "real-candidate-protected-zones" && check.status === "pass"), "self-check should verify real candidate runner summarizes protected-zone diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "real-candidate-production-gap-review" && check.status === "pass"), "self-check should verify real candidate runner summarizes production gap review diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "manifest-file:native-cam-server-package.json" && check.status === "pass"), "self-check should require manifest to list itself");
  assert(existsSync(join(workDir, "native-cam-server-package-self-check.json")), "self-check should write JSON report");

  const closedLoopPath = join(workDir, "native-cam-closed-loop-check.mjs");
  assert(existsSync(closedLoopPath), "generated server package missing closed-loop check script");
  const closedLoop = spawnSync(node, [closedLoopPath, workDir, "--self-check-only"], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(closedLoop.status === 0, `closed-loop self-check-only should pass generated package: ${closedLoop.stderr || closedLoop.stdout}`);
  const closedLoopReport = JSON.parse(closedLoop.stdout);
  assert(closedLoopReport.schema === "hediao3d.native-cam-closed-loop-check.v1", "closed-loop report schema mismatch");
  assert(closedLoopReport.productionLocked === true, "closed-loop report must keep production locked");
  assert(closedLoopReport.evidenceChain?.schema === "hediao3d.native-cam-linux-evidence-chain.v1", "closed-loop report should include evidence chain schema");
  assert(closedLoopReport.evidenceChain?.crossChecks?.camoticsUpstreamEvidenceMatched === true, "closed-loop self-check-only should treat absent CAMotics upstream evidence as not required");
  assert(existsSync(join(workDir, "native-cam-closed-loop-check.json")), "closed-loop check should write JSON report");

  const realCandidatePath = join(workDir, "opencamlib-real-candidate-run.mjs");
  assert(existsSync(realCandidatePath), "generated server package missing OpenCAMLib real candidate runner");
  const realCandidate = spawnSync(node, [realCandidatePath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(realCandidate.status === 3, `real candidate runner should fail closed without job/plan/model inputs, got ${realCandidate.status}: ${realCandidate.stderr || realCandidate.stdout}`);
  const realCandidateReport = JSON.parse(realCandidate.stdout);
  assert(realCandidateReport.schema === "hediao3d.opencamlib-real-candidate-run.v1", "real candidate runner schema mismatch");
  assert(realCandidateReport.productionLocked === true, "real candidate runner must keep production locked");
  assert(realCandidateReport.blocking?.includes("opencamlib-production-candidate-not-proven"), "real candidate runner should block when production candidate is not proven");
  assert(realCandidateReport.productionGapReview?.schema === "hediao3d.opencamlib-production-gap-review.v1", "real candidate runner should expose production gap review");
  assert(realCandidateReport.productionGapReview?.criticalCount >= 1, "missing-input real candidate gap review should explain critical gaps");
  assert(existsSync(join(workDir, "opencamlib-real-candidate-run.json")), "real candidate runner should write JSON report");

  createOpenCamLibCandidateFiles(workDir);
  const realCandidateWithContact = spawnSync(node, [realCandidatePath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(realCandidateWithContact.status === 3, `real candidate runner should stay fail-closed without live OpenCAMLib runner but preserve contact evidence, got ${realCandidateWithContact.status}: ${realCandidateWithContact.stderr || realCandidateWithContact.stdout}`);
  const realCandidateWithContactReport = JSON.parse(realCandidateWithContact.stdout);
  assert(realCandidateWithContactReport.openCamLibContactReport?.candidateMachineFit?.level === "ok", "real candidate runner should summarize raw contact machine-fit evidence");
  assert(realCandidateWithContactReport.openCamLibContactReport?.candidateMachineFit?.targetMachine?.rotaryOutputAxis === "Y", "real candidate runner should preserve raw contact machine-fit rotary axis");
  assert(realCandidateWithContactReport.openCamLibContactReport?.materialRemovalReadiness?.readyForMaterialRemovalSimulation === true, "real candidate runner should summarize material-removal readiness");
  assert(realCandidateWithContactReport.openCamLibContactReport?.materialRemovalReadiness?.productionResidualEvidenceReady === true, "validated contact fixture should preserve production residual readiness summary");
  assert(realCandidateWithContactReport.candidatePackage?.productionGapReview?.productionCandidateReady === true, "real candidate runner should preserve ready candidate package production gap review");
  const candidateClosedLoop = spawnSync(node, [closedLoopPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(candidateClosedLoop.status === 3, `closed-loop should stay blocked without Native CAM/CAMotics evidence but still summarize OpenCAMLib candidate package, got ${candidateClosedLoop.status}: ${candidateClosedLoop.stderr || candidateClosedLoop.stdout}`);
  const candidateClosedLoopReport = JSON.parse(candidateClosedLoop.stdout);
  assert(candidateClosedLoopReport.productionLocked === true, "candidate closed-loop report must keep production locked");
  const candidatePackageReport = JSON.parse(readFileSync(join(workDir, "opencamlib-candidate-package-validation.json"), "utf8"));
  assert(candidatePackageReport.productionGapReview?.schema === "hediao3d.opencamlib-production-gap-review.v1", "candidate package validation should write production gap review");
  assert(candidatePackageReport.productionGapReview?.productionCandidateReady === true, "ready candidate fixture should clear OpenCAMLib production gap review");
  assert(candidateClosedLoopReport.evidenceChain?.openCamLib?.candidatePackage?.level === "ready", `closed-loop evidence chain should read candidate package validation level: ${JSON.stringify(candidatePackageReport, null, 2)}`);
  assert(candidateClosedLoopReport.evidenceChain?.openCamLib?.candidatePackageReadyForImport === true, "closed-loop evidence chain should mark candidate package ready for import");
  assert(candidateClosedLoopReport.evidenceChain?.openCamLib?.candidateMachineFit?.level === candidatePackageReport.machineFit?.level, "closed-loop evidence chain should preserve candidate machine-fit preflight");
  assert(candidateClosedLoopReport.evidenceChain?.crossChecks?.candidatePackageStep === "pass", "closed-loop cross-checks should expose candidate package validation step");
  assert(candidateClosedLoopReport.blocking?.some((item) => item.id === "native-cam-real-output-check"), "closed-loop should still block missing Native CAM evidence");
  assert(existsSync(join(workDir, "opencamlib-candidate-package-validation.json")), "closed-loop should write OpenCAMLib candidate package validation report");

  const camoticsRunnerPath = join(workDir, "camotics-material-removal-run.mjs");
  assert(existsSync(camoticsRunnerPath), "generated server package missing CAMotics material-removal runner");
  const camoticsRunner = spawnSync(node, [camoticsRunnerPath, "--run-package", "missing-camotics-cli-run-package.json"], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(camoticsRunner.status === 3, `CAMotics runner should fail closed without run package, got ${camoticsRunner.status}: ${camoticsRunner.stderr || camoticsRunner.stdout}`);
  const camoticsRunnerReport = JSON.parse(camoticsRunner.stdout);
  assert(camoticsRunnerReport.schema === "hediao3d.camotics-material-removal-run.v1", "CAMotics runner schema mismatch");
  assert(camoticsRunnerReport.productionLocked === true, "CAMotics runner must keep production locked");
  assert(camoticsRunnerReport.blocking?.some((item) => item.id === "missing-run-package"), "CAMotics runner should explain missing run package");
  assert(existsSync(join(workDir, "camotics-material-removal-run.json")), "CAMotics runner should write JSON report");

  writeFileSync(join(workDir, "camotics-preview.nc"), "(ROTARY_WRAP_AXIS=Y)\n(ROTARY_WRAP_PER_REV_MM=100)\n(LENGTH_AXIS=X)\nG0 X0 Y0 Z22\nG1 X10 Y5 Z21.45\n", "utf8");
  writeFileSync(join(workDir, "camotics-preview.png"), "fixture screenshot", "utf8");
  writeFileSync(join(workDir, "camotics-material-removal.stl"), "solid removed\nendsolid removed\n", "utf8");
  const camoticsRunPackage = createCamoticsRunPackage(workDir);
  const camoticsRunPackagePath = join(workDir, "camotics-cli-run-package.json");
  writeJson(camoticsRunPackagePath, camoticsRunPackage);
  const providedResultPath = join(workDir, "provided-camotics-result.json");
  writeJson(providedResultPath, createCamoticsResult(camoticsRunPackage, sha256File(camoticsRunPackagePath)));
  const camoticsProvidedRunner = spawnSync(node, [camoticsRunnerPath, "--run-package", camoticsRunPackagePath], {
    cwd: workDir,
    env: {
      ...process.env,
      HEDIAO3D_CAMOTICS_RESULT_JSON: providedResultPath
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(camoticsProvidedRunner.status === 0, `CAMotics runner should validate provided real result and write bundle, got ${camoticsProvidedRunner.status}: ${camoticsProvidedRunner.stderr || camoticsProvidedRunner.stdout}`);
  const camoticsProvidedRunnerReport = JSON.parse(camoticsProvidedRunner.stdout);
  assert(camoticsProvidedRunnerReport.ok === true, "CAMotics runner should be ok with a valid provided result");
  assert(camoticsProvidedRunnerReport.level === "ready-for-import", "CAMotics runner should mark valid result ready for import");
  assert(camoticsProvidedRunnerReport.productionLocked === true, "CAMotics provided-result runner must still keep production locked");
  assert(camoticsProvidedRunnerReport.steps?.some((step) => step.id === "copy-provided-result" && step.status === "pass"), "CAMotics runner should copy provided result");
  assert(camoticsProvidedRunnerReport.steps?.some((step) => step.id === "camotics-material-removal-validate" && step.status === "pass"), "CAMotics runner should call material-removal validator");
  assert(camoticsProvidedRunnerReport.validation?.productionEvidenceEligible === true, "CAMotics runner should expose production-eligible material-removal validation");
  assert(camoticsProvidedRunnerReport.validation?.upstreamCamEvidence?.status === "matched", "CAMotics runner should preserve upstream CAM evidence binding");
  assert(existsSync(join(workDir, "camotics-result-bundle.zip")), "CAMotics runner should write import bundle for valid provided result");
  const camoticsBoundClosedLoop = spawnSync(node, [closedLoopPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(camoticsBoundClosedLoop.status === 3, `closed-loop should stay blocked without Native CAM acceptance but summarize CAMotics upstream binding, got ${camoticsBoundClosedLoop.status}: ${camoticsBoundClosedLoop.stderr || camoticsBoundClosedLoop.stdout}`);
  const camoticsBoundClosedLoopReport = JSON.parse(camoticsBoundClosedLoop.stdout);
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamEvidence?.status === "matched", "closed-loop should summarize matched CAMotics upstream evidence");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageValidationBound === true, "closed-loop should show CAMotics is bound to OpenCAMLib candidate package validation");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamEvidence?.candidatePackageBundleBound === true, "closed-loop should show CAMotics is bound to OpenCAMLib candidate package bundle");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamMaterialReadinessStatus === "matched", "closed-loop should expose matched upstream material readiness");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamMaterialReadyForSimulation === true, "closed-loop should expose material readiness for simulation");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamMaterialResidualEvidenceReady === false, "closed-loop should preserve residual production boundary");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamEvidence?.materialRemovalReadiness?.status === "matched", "closed-loop upstream evidence should include material readiness detail");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.crossChecks?.camoticsUpstreamMaterialReadinessMatched === true, "closed-loop cross-checks should mark material readiness matched");
  assert(camoticsBoundClosedLoopReport.evidenceChain?.camotics?.upstreamEvidence?.matchedCount >= 4, "closed-loop should count matched upstream CAM evidence files");

  const diagnosticsPath = join(workDir, "native-cam-diagnostics-bundle.mjs");
  assert(existsSync(diagnosticsPath), "generated server package missing diagnostics bundle script");
  const diagnostics = spawnSync(node, [diagnosticsPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(diagnostics.status === 0, `diagnostics bundle should pass generated package: ${diagnostics.stderr || diagnostics.stdout}`);
  const diagnosticsReport = JSON.parse(diagnostics.stdout);
  assert(diagnosticsReport.schema === "hediao3d.native-cam-diagnostics-bundle.v1", "diagnostics bundle schema mismatch");
  assert(diagnosticsReport.productionLocked === true, "diagnostics bundle must keep production locked");
  assert(["diagnostic", "missing", "partial", "ready"].includes(diagnosticsReport.level), "diagnostics bundle level should stay in a diagnostic/readiness range");
  assert(existsSync(join(workDir, "native-cam-diagnostics-bundle.zip")), "diagnostics bundle should write ZIP");
  assert(existsSync(join(workDir, "opencamlib-real-contact-spike.json")), "diagnostics bundle should write contact spike report");

  unlinkSync(join(workDir, "camotics-material-removal-validate.mjs"));
  const blocked = spawnSync(node, [selfCheckPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(blocked.status === 3, `self-check should fail when CAMotics validator is missing, got ${blocked.status}: ${blocked.stdout}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.ok === false, "blocked self-check should not be ok");
  assert(blockedReport.level === "critical", "blocked self-check should be critical");
  assert(blockedReport.missing?.includes("file:camotics-material-removal-validate.mjs"), "blocked self-check should list missing CAMotics validator file");
  assert(blockedReport.missing?.includes("camotics-validator-schema"), "blocked self-check should list missing CAMotics validator schema");

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.checks.length,
    diagnosticsLevel: diagnosticsReport.level
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createCamoticsRunPackage() {
  const machineContext = createMachineContext();
  return {
    schema: "hediao3d.camotics-cli-run-package.v1",
    status: "ready-for-linux-camotics",
    preferredGcodeIdentity: {
      filename: "camotics-preview.nc",
      sha256: sha256File(join(workDir, "camotics-preview.nc")),
      sizeBytes: readFileSync(join(workDir, "camotics-preview.nc")).length,
      motionProfile: {
        motionLineCount: 2,
        zMin: 21.45,
        zMax: 22,
        machineContext
      },
      machineContext
    },
    expectedOutputs: {
      resultJson: "camotics-result.json",
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    },
    upstreamCamEvidence: createUpstreamCamEvidence(),
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false
    }
  };
}

function createOpenCamLibCandidateFiles(dir) {
  const modelPath = join(dir, "repaired-model.stl");
  const planPath = join(dir, "opencamlib-kernel-plan.json");
  const neutralPath = join(dir, "neutral-toolpath.json");
  const contactPath = join(dir, "opencamlib-cutter-contact-report.json");
  writeFileSync(modelPath, createOpenCamLibStl(), "utf8");
  writeJson(planPath, createOpenCamLibPlan(modelPath));
  const neutral = createOpenCamLibNeutral(contactPath);
  const neutralSha = sha256JsonWithoutContact(neutral);
  const contact = createOpenCamLibContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha
  });
  neutral.cutterContactReport = contact;
  writeJson(neutralPath, neutral);
  writeJson(contactPath, contact);
}

function createOpenCamLibPlan(modelPath) {
  return {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: "native-cam-closed-loop-candidate-test",
    engine: "opencamlib",
    model: {
      path: modelPath,
      format: "stl",
      exists: true
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    sampling: {
      recommendedPrimary: "unwrapped-rotary-drop-cutter",
      axisMapping: { lengthAxis: "X", depthAxis: "Z", rotaryAxis: "Y" }
    },
    operations: [{ id: "finishing", enabled: true, strategy: "opencamlib-drop-cutter-contact" }]
  };
}

function createOpenCamLibNeutral(contactPath) {
  return {
    schema: "hediao3d.neutral-toolpath.v1",
    jobId: "native-cam-closed-loop-candidate-test",
    engine: "opencamlib",
    synthetic: false,
    fixture: false,
    generatedByExternalCommand: true,
    coordinate: { lengthAxis: "X", rotaryAxis: "Y", depthAxis: "Z", rotaryUnit: "degree" },
    cutterContactReportPath: contactPath,
    points: [
      { x: -10, a: 0, z: 21.5, depth: 0.5 },
      { x: 0, a: 90, z: 21.2, depth: 0.8 },
      { x: 10, a: 180, z: 21.6, depth: 0.4 }
    ],
    runner: { mode: "opencamlib-drop-cutter-contact" }
  };
}

function createOpenCamLibContact({ modelSha, planSha, neutralSha }) {
  return {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    jobId: "native-cam-closed-loop-candidate-test",
    engine: "opencamlib",
    mode: "opencamlib-drop-cutter-contact",
    inputIdentity: {
      modelSha256: modelSha,
      planSha256: planSha,
      neutralToolpathWithoutContactReportSha256: neutralSha,
      sourceNeutralToolpathSha256: neutralSha
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    contactSampling: {
      algorithm: "opencamlib-drop-cutter-contact",
      pointCount: 3,
      contactPointCount: 3,
      hitRate: 1,
      stepToCutterRatio: 0.18,
      pathCoverage: {
        schema: "hediao3d.opencamlib-path-dropcutter-coverage.v1",
        xCoverageRatio: 1,
        crossCoverageRatio: 1,
        sampledXSpanMm: 20,
        sampledCrossSpanMm: 180,
        modelXSpanMm: 20,
        modelCrossSpanMm: 180
      }
    },
    residualMaterial: {
      measured: true,
      validationBasis: "swept-volume-validated-fixture",
      maxGougeMm: 0.01,
      maxUndercutMm: 0.03,
      residualVolumeMm3: 0.4
    },
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    protectedZones: {
      schema: "hediao3d.opencamlib-protected-zones.v1",
      enabled: true,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      safeMinX: -10,
      safeMaxX: 10,
      sampledMinX: -10,
      sampledMaxX: 10,
      violationCount: 0,
      violations: []
    },
    candidateMachineFit: {
      schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
      level: "ok",
      summary: "Fixture contact matches the target rotary-Y machine boundary.",
      targetMachine: {
        controllerClass: "3axis-controller-with-rotary-fixture",
        rotaryOutputAxis: "Y",
        wrapPerRevolutionMm: 100,
        toolProfileId: "vflat-4mm-25deg"
      },
      coverage: {
        pointCount: 3,
        finitePointCount: 3,
        xSpanMm: 20,
        rotarySampleCount: 3,
        rotarySpanDeg: 360,
        expectedRotaryCoverageDeg: 360,
        rotaryCoverageRatio: 1,
        depthMax: 0.8
      },
      riskCounts: {
        holdZonePointCount: 0,
        deepPointCount: 0,
        invalidPointCount: 0,
        missingRotaryCount: 0
      },
      checks: {
        rotaryCoordinatePresent: true,
        protectedZoneClean: true,
        depthWithinLimit: true
      }
    },
    materialRemovalReadiness: {
      schema: "hediao3d.opencamlib-material-removal-readiness.v1",
      level: "ready-for-camotics-or-equivalent",
      readyForMaterialRemovalSimulation: true,
      productionResidualEvidenceReady: true,
      missingForProduction: [],
      summary: "Fixture contact has swept-volume validated residual metrics and can enter material-removal validation."
    },
    quality: {
      level: "validated-contact",
      previewScaffold: false,
      postprocessEligible: true,
      productionCandidate: true
    }
  };
}

function createOpenCamLibStl() {
  return `solid model
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid model
`;
}

function createCamoticsResult(runPackage, runPackageSha) {
  return {
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    simulator: {
      schema: "hediao3d.material-removal-simulator.v1",
      name: "CAMotics",
      version: "1.2.0-test",
      sourceCommand: "provided external CAMotics/equivalent result",
      equivalentSimulator: false
    },
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    inputs: {
      preferredGcodeSha256: runPackage.preferredGcodeIdentity.sha256,
      camoticsCliRunPackageSha256: runPackageSha,
      machineContext: runPackage.preferredGcodeIdentity.machineContext,
      upstreamCamEvidence: runPackage.upstreamCamEvidence
    },
    metrics: {
      motionLineCount: runPackage.preferredGcodeIdentity.motionProfile.motionLineCount,
      zMin: runPackage.preferredGcodeIdentity.motionProfile.zMin,
      zMax: runPackage.preferredGcodeIdentity.motionProfile.zMax,
      materialRemovedMm3: 12.4
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    }
  };
}

function createMachineContext() {
  return {
    schema: "hediao3d.camotics-machine-context.v1",
    camMode: "rotaryWrap",
    rotaryWrapAxis: "Y",
    rotaryOutputAxis: "Y",
    rotaryWrapPerRevolutionMm: 100,
    lengthAxis: "X",
    simulationInterpretation: "linearized-rotary-wrap-as-3axis"
  };
}

function createUpstreamCamEvidence() {
  return {
    schema: "hediao3d.camotics-upstream-cam-evidence.v1",
    status: "hash-bound",
    required: true,
    presentCount: 2,
    materialRemovalReadiness: {
      schema: "hediao3d.opencamlib-material-removal-readiness.v1",
      level: "ready-for-camotics-or-equivalent",
      readyForMaterialRemovalSimulation: true,
      productionResidualEvidenceReady: false,
      missingForProduction: ["residual-stock-map", "verified-material-removal-volume"],
      summary: "Fixture upstream material readiness can enter CAMotics/equivalent simulation."
    },
    files: [
      {
        key: "opencamlibRealCandidateRun",
        label: "OpenCAMLib 一键真实候选链路",
        filename: "opencamlib-real-candidate-run.json",
        exists: true,
        sizeBytes: 42,
        sha256: sha256Text("real-candidate-fixture")
      },
      {
        key: "opencamlibContactValidation",
        label: "OpenCAMLib strict contact 验收",
        filename: "opencamlib-contact-output-validation.json",
        exists: true,
        sizeBytes: 42,
        sha256: sha256Text("contact-validation-fixture")
      },
      {
        key: "opencamlibCandidatePackageValidation",
        label: "OpenCAMLib 候选包预检",
        filename: "opencamlib-candidate-package-validation.json",
        exists: true,
        sizeBytes: 42,
        sha256: sha256Text("candidate-package-validation-fixture")
      },
      {
        key: "opencamlibCandidatePackageBundle",
        label: "OpenCAMLib 候选包证据包",
        filename: "opencamlib-candidate-package-bundle.zip",
        exists: true,
        sizeBytes: 42,
        sha256: sha256Text("candidate-package-bundle-fixture")
      }
    ],
    summary: "Fixture upstream CAM evidence for CAMotics runner self-check."
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256JsonWithoutContact(value) {
  const copy = { ...value };
  delete copy.cutterContactReport;
  delete copy.cutterContactReportPath;
  delete copy.cutterEnvelopeReportPath;
  return createHash("sha256").update(JSON.stringify(copy, null, 2)).digest("hex");
}
