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
  assert(readyReport.checks?.some((check) => check.id === "command:camotics-material-run" && check.status === "pass"), "self-check should verify CAMotics material-removal runner command");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-schema" && check.status === "pass"), "self-check should verify CAMotics runner schema");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-fail-closed" && check.status === "pass"), "self-check should verify CAMotics runner fail-closed production lock");
  assert(readyReport.checks?.some((check) => check.id === "camotics-runner-real-command" && check.status === "pass"), "self-check should verify CAMotics runner real command and bundle path");
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
  assert(readyReport.checks?.some((check) => check.id === "real-output-runner-readiness" && check.status === "pass"), "self-check should verify real-output bundle carries OpenCAMLib runner readiness");
  assert(readyReport.checks?.some((check) => check.id === "real-output-real-candidate" && check.status === "pass"), "self-check should verify real-output bundle carries OpenCAMLib real candidate evidence");
  assert(readyReport.checks?.some((check) => check.id === "real-output-contact-path-coverage" && check.status === "pass"), "self-check should verify real-output bundle preserves contact pathCoverage diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "real-candidate-path-coverage" && check.status === "pass"), "self-check should verify real candidate runner summarizes contact pathCoverage diagnostics");
  assert(readyReport.checks?.some((check) => check.id === "real-candidate-protected-zones" && check.status === "pass"), "self-check should verify real candidate runner summarizes protected-zone diagnostics");
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
  assert(existsSync(join(workDir, "opencamlib-real-candidate-run.json")), "real candidate runner should write JSON report");

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
