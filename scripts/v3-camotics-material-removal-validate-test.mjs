#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-camotics-material-validate-"));
const validator = resolve("scripts", "v3-camotics-material-removal-validate.mjs");
const node = process.execPath;

try {
  const runPackagePath = join(workDir, "camotics-cli-run-package.json");
  const resultPath = join(workDir, "camotics-result.json");
  const outPath = join(workDir, "camotics-result-local-validation.json");
  const runPackage = createRunPackage();
  writeJsonWithHash(runPackagePath, runPackage);
  const runPackageSha = sha256File(runPackagePath);

  writeFileSync(join(workDir, "camotics-preview.png"), "fixture screenshot", "utf8");
  writeFileSync(join(workDir, "camotics-material-removal.stl"), "solid removed\nendsolid removed\n", "utf8");
  writeJsonWithHash(resultPath, createResult({ runPackage, runPackageSha }));

  const ready = spawnSync(node, [validator, "--result", resultPath, "--run-package", runPackagePath, "--out", outPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(ready.status === 0, `ready validation failed: ${ready.stderr || ready.stdout}`);
  assert(existsSync(outPath), "validator did not write local validation report");
  const readyReport = JSON.parse(readFileSync(outPath, "utf8"));
  assert(readyReport.schema === "hediao3d.camotics-result-local-validation.v1", "schema mismatch");
  assert(readyReport.ok === true, "ready report should be ok");
  assert(readyReport.level === "ready", "ready report level mismatch");
  assert(readyReport.productionEvidenceEligible === true, "ready report should be production evidence eligible");
  assert(readyReport.checks.some((check) => check.id === "run-package-hash" && check.status === "pass"), "run package hash check missing");
  assert(readyReport.checks.some((check) => check.id === "machine-context" && check.status === "pass"), "machine context check missing");
  assert(readyReport.checks.some((check) => check.id === "simulator-evidence" && check.status === "pass"), "simulator evidence check missing");
  assert(readyReport.checks.some((check) => check.id === "upstream-cam-evidence" && check.ok && check.status === "matched"), "upstream CAM evidence check missing");
  assert(readyReport.checks.some((check) => check.id === "upstream-machine-fit" && check.ok && check.status === "matched"), "upstream machine-fit check missing");
  assert(readyReport.checks.some((check) => check.id === "upstream-material-readiness" && check.ok && check.status === "matched"), "upstream material readiness check missing");
  assert(readyReport.upstreamCamEvidence?.status === "matched", "ready report should expose matched upstream CAM evidence");
  assert(readyReport.upstreamCamEvidence?.machineFit?.status === "matched", "ready report should expose matched upstream machine-fit");
  assert(readyReport.upstreamCamEvidence?.materialRemovalReadiness?.status === "matched", "ready report should expose matched upstream material readiness");
  assert(readyReport.upstreamCamEvidence?.materialRemovalReadiness?.productionResidualEvidenceReady === false, "ready report should preserve production residual boundary");
  assert(readyReport.simulator?.name === "CAMotics", "ready report should expose simulator evidence");
  assert(readyReport.missing.length === 0, "ready report should not have missing checks");
  const bundlePath = join(workDir, "camotics-result-bundle.zip");
  assert(existsSync(bundlePath), "ready validator should write camotics-result-bundle.zip");
  const bundleNames = listZipFilenames(readFileSync(bundlePath));
  assert(bundleNames.includes("camotics-result.json"), "bundle missing result JSON");
  assert(bundleNames.includes("camotics-result-local-validation.json"), "bundle missing validation JSON");
  assert(bundleNames.includes("camotics-preview.png"), "bundle missing screenshot");
  assert(bundleNames.includes("camotics-material-removal.stl"), "bundle missing material mesh");

  writeJsonWithHash(resultPath, createResult({
    runPackage,
    runPackageSha: "bad-hash",
    synthetic: true,
    riskLevel: "review",
    machineContext: { ...runPackage.preferredGcodeIdentity.machineContext, rotaryWrapAxis: "X" },
    artifacts: { screenshot: "missing.png", materialMesh: "missing.stl", simulatorName: "", simulatorVersion: "", sourceCommand: "" }
  }));
  const blocked = spawnSync(node, [validator, "--result", resultPath, "--run-package", runPackagePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(blocked.status === 3, `blocked validation should exit 3, got ${blocked.status}: ${blocked.stdout}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.ok === false, "blocked report should not be ok");
  assert(blockedReport.level === "critical", "blocked report level should be critical");
  assert(blockedReport.productionEvidenceEligible === false, "blocked report should not be production eligible");
  for (const id of ["result-non-synthetic", "result-risk-ready", "run-package-hash", "machine-context", "simulator-evidence", "visual-or-material-artifact"]) {
    assert(blockedReport.missing.includes(id), `blocked report missing ${id}`);
  }
  writeJsonWithHash(resultPath, createResult({
    runPackage,
    runPackageSha,
    upstreamCamEvidence: null
  }));
  const upstreamMismatch = spawnSync(node, [validator, "--result", resultPath, "--run-package", runPackagePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(upstreamMismatch.status === 3, "upstream evidence mismatch should fail strict validation");
  const upstreamMismatchReport = JSON.parse(upstreamMismatch.stdout);
  assert(upstreamMismatchReport.missing.includes("upstream-cam-evidence"), "upstream mismatch should list upstream-cam-evidence");

  const criticalMachineFitRunPackagePath = join(workDir, "critical-machinefit-camotics-cli-run-package.json");
  const criticalMachineFitRunPackage = createRunPackage({
    upstreamCamEvidence: createUpstreamCamEvidence({
      candidateMachineFit: createCandidateMachineFit({ level: "critical", missingRotaryCount: 12 })
    })
  });
  writeJsonWithHash(criticalMachineFitRunPackagePath, criticalMachineFitRunPackage);
  const criticalMachineFitRunPackageSha = sha256File(criticalMachineFitRunPackagePath);
  writeJsonWithHash(resultPath, createResult({
    runPackage: criticalMachineFitRunPackage,
    runPackageSha: criticalMachineFitRunPackageSha
  }));
  const criticalMachineFit = spawnSync(node, [validator, "--result", resultPath, "--run-package", criticalMachineFitRunPackagePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(criticalMachineFit.status === 3, "critical upstream machine-fit should fail material-removal validation");
  const criticalMachineFitReport = JSON.parse(criticalMachineFit.stdout);
  assert(criticalMachineFitReport.missing.includes("upstream-cam-evidence"), "critical machine-fit should fail upstream CAM evidence");
  assert(criticalMachineFitReport.missing.includes("upstream-machine-fit"), "critical machine-fit should list upstream-machine-fit");
  assert(criticalMachineFitReport.upstreamCamEvidence?.machineFit?.importedLevel === "critical", "critical machine-fit report should expose imported critical level");

  const blockedReadinessRunPackagePath = join(workDir, "blocked-readiness-camotics-cli-run-package.json");
  const blockedReadinessRunPackage = createRunPackage({
    upstreamCamEvidence: createUpstreamCamEvidence({
      materialRemovalReadiness: createMaterialRemovalReadiness({ readyForMaterialRemovalSimulation: false, level: "blocked" })
    })
  });
  writeJsonWithHash(blockedReadinessRunPackagePath, blockedReadinessRunPackage);
  const blockedReadinessRunPackageSha = sha256File(blockedReadinessRunPackagePath);
  writeJsonWithHash(resultPath, createResult({
    runPackage: blockedReadinessRunPackage,
    runPackageSha: blockedReadinessRunPackageSha
  }));
  const blockedReadiness = spawnSync(node, [validator, "--result", resultPath, "--run-package", blockedReadinessRunPackagePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(blockedReadiness.status === 3, "blocked upstream material readiness should fail material-removal validation");
  const blockedReadinessReport = JSON.parse(blockedReadiness.stdout);
  assert(blockedReadinessReport.missing.includes("upstream-cam-evidence"), "blocked material readiness should fail upstream CAM evidence");
  assert(blockedReadinessReport.missing.includes("upstream-material-readiness"), "blocked material readiness should list upstream-material-readiness");
  assert(blockedReadinessReport.upstreamCamEvidence?.materialRemovalReadiness?.importedReadyForMaterialRemovalSimulation === false, "blocked material readiness report should expose imported readiness=false");

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.checks.length
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createRunPackage(overrides = {}) {
  const preferredGcodeSha = sha256Text("(ROTARY_WRAP_AXIS=Y)\n(ROTARY_WRAP_PER_REV_MM=100)\n(LENGTH_AXIS=X)\nG0 X0 Y0 Z22\nG1 X10 Y5 Z21.45\n");
  return {
    schema: "hediao3d.camotics-cli-run-package.v1",
    status: "ready-for-linux-camotics",
    preferredGcodeIdentity: {
      filename: "camotics-preview.nc",
      sha256: preferredGcodeSha,
      sizeBytes: 90,
      motionProfile: {
        motionLineCount: 2,
        zMin: 21.45,
        zMax: 22,
        machineContext: createMachineContext()
      },
      machineContext: createMachineContext()
    },
    expectedOutputs: {
      resultJson: "camotics-result.json",
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    },
    upstreamCamEvidence: overrides.upstreamCamEvidence ?? createUpstreamCamEvidence(),
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false
    }
  };
}

function createResult({ runPackage, runPackageSha, synthetic = false, riskLevel = "ready", machineContext = null, artifacts = null, upstreamCamEvidence = runPackage.upstreamCamEvidence }) {
  return {
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    simulator: {
      schema: "hediao3d.material-removal-simulator.v1",
      name: artifacts?.simulatorName ?? "CAMotics",
      version: artifacts?.simulatorVersion ?? "1.2.0-test",
      sourceCommand: artifacts?.sourceCommand ?? "camotics camotics-preview.nc",
      equivalentSimulator: false
    },
    status: "completed",
    synthetic,
    riskLevel,
    inputs: {
      preferredGcodeSha256: runPackage.preferredGcodeIdentity.sha256,
      camoticsCliRunPackageSha256: runPackageSha,
      machineContext: machineContext ?? runPackage.preferredGcodeIdentity.machineContext,
      upstreamCamEvidence
    },
    metrics: {
      motionLineCount: runPackage.preferredGcodeIdentity.motionProfile.motionLineCount,
      zMin: runPackage.preferredGcodeIdentity.motionProfile.zMin,
      zMax: runPackage.preferredGcodeIdentity.motionProfile.zMax,
      materialRemovedMm3: 12.4
    },
    artifacts: artifacts ?? {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    }
  };
}

function createUpstreamCamEvidence(overrides = {}) {
  return {
    schema: "hediao3d.camotics-upstream-cam-evidence.v1",
    status: "hash-bound",
    required: true,
    presentCount: 2,
    candidateMachineFit: overrides.candidateMachineFit ?? createCandidateMachineFit(),
    materialRemovalReadiness: overrides.materialRemovalReadiness ?? createMaterialRemovalReadiness(),
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
    summary: "Fixture upstream CAM evidence."
  };
}

function createMaterialRemovalReadiness({ level = "ready-for-camotics-or-equivalent", readyForMaterialRemovalSimulation = true, productionResidualEvidenceReady = false } = {}) {
  return {
    schema: "hediao3d.opencamlib-material-removal-readiness.v1",
    level,
    readyForMaterialRemovalSimulation,
    productionResidualEvidenceReady,
    missingForProduction: productionResidualEvidenceReady ? [] : ["residual-stock-map", "verified-material-removal-volume"],
    summary: readyForMaterialRemovalSimulation
      ? "Fixture contact evidence is ready for CAMotics/equivalent simulation."
      : "Fixture contact evidence is blocked before material-removal simulation."
  };
}

function createCandidateMachineFit({ level = "ok", missingRotaryCount = 0 } = {}) {
  return {
    schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
    level,
    summary: level === "ok" ? "Fixture machine-fit ok." : "Fixture machine-fit critical.",
    targetMachine: {
      controllerClass: "3axis-controller-with-rotary-fixture",
      rotaryOutputAxis: "Y",
      wrapPerRevolutionMm: 100,
      toolProfileId: "vflat-4mm-25deg"
    },
    coverage: {
      pointCount: 231,
      rotarySpanDeg: level === "ok" ? 360 : 0,
      expectedRotaryCoverageDeg: 360,
      rotaryCoverageRatio: level === "ok" ? 1 : 0,
      depthMax: 0.8
    },
    riskCounts: {
      holdZonePointCount: 0,
      deepPointCount: 0,
      invalidPointCount: 0,
      missingRotaryCount
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

function writeJsonWithHash(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
