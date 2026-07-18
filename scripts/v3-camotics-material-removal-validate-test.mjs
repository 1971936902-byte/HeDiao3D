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
    artifacts: { screenshot: "missing.png", materialMesh: "missing.stl" }
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
  for (const id of ["result-non-synthetic", "result-risk-ready", "run-package-hash", "machine-context", "visual-or-material-artifact"]) {
    assert(blockedReport.missing.includes(id), `blocked report missing ${id}`);
  }

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.checks.length
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createRunPackage() {
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
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false
    }
  };
}

function createResult({ runPackage, runPackageSha, synthetic = false, riskLevel = "ready", machineContext = null, artifacts = null }) {
  return {
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    status: "completed",
    synthetic,
    riskLevel,
    inputs: {
      preferredGcodeSha256: runPackage.preferredGcodeIdentity.sha256,
      camoticsCliRunPackageSha256: runPackageSha,
      machineContext: machineContext ?? runPackage.preferredGcodeIdentity.machineContext
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
