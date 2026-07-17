#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const workDir = join(tmpdir(), `hediao3d-camotics-import-${Date.now()}`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.env.V3_CAMOTICS_IMPORT_DIR ?? join(root, "public", "orchestrator-camotics-import", stamp));
mkdirSync(workDir, { recursive: true });
mkdirSync(outputRoot, { recursive: true });

const jobPath = join(workDir, "camotics-job.json");
const resultPath = join(workDir, "camotics-adapter-report.json");
const importedPath = join(workDir, "real-camotics-result.json");
const previewPath = join(workDir, "camotics-preview.nc");
const screenshotPath = join(workDir, "source-camotics-preview.png");
const materialMeshPath = join(workDir, "source-camotics-material-removal.stl");
const completeResultPath = join(workDir, "complete-camotics-result.json");

writeFileSync(previewPath, [
  "(CAMOTICS PREVIEW ONLY - not for machine)",
  "G21",
  "G90",
  "G0 X0 Y0 Z5",
  "G1 X1 Y1 Z-0.2 F120",
  "M30",
  ""
].join("\n"));
const previewSha256 = createHash("sha256").update(readFileSync(previewPath)).digest("hex");
writeFileSync(screenshotPath, "fake-png-bytes-for-contract-test");
writeFileSync(materialMeshPath, [
  "solid camotics_material_removal",
  "  facet normal 0 0 1",
  "    outer loop",
  "      vertex 0 0 0",
  "      vertex 1 0 0",
  "      vertex 0 1 0",
  "    endloop",
  "  endfacet",
  "endsolid camotics_material_removal",
  ""
].join("\n"));
const screenshotSha256 = createHash("sha256").update(readFileSync(screenshotPath)).digest("hex");
const materialMeshSha256 = createHash("sha256").update(readFileSync(materialMeshPath)).digest("hex");

writeFileSync(importedPath, JSON.stringify({
  schema: "hediao3d.camotics-result.v1",
  jobId: "camotics-import-test",
  engine: "camotics",
  status: "completed",
  synthetic: false,
  riskLevel: "ready",
  summary: "Imported real CAMotics result fixture.",
  inputs: {
    preferredGcode: "camotics-preview.nc",
    preferredGcodeSha256: previewSha256
  },
  metrics: {
    motionLineCount: 2,
    zMin: -0.2,
    zMax: 5,
    materialRemovedMm3: 1.2
  },
  artifacts: {
    screenshot: screenshotPath,
    materialMesh: materialMeshPath
  }
}, null, 2));

writeFileSync(jobPath, JSON.stringify({
  jobId: "camotics-import-test",
  engine: "camotics",
  modelPath: join(workDir, "model.glb"),
  workDir,
  settings: {
    camMode: "rotaryWrap",
    rotaryOutputAxis: "Y",
    rotaryWrapPerRevolutionMm: 100,
    lengthMm: 38,
    diameterMm: 15,
    depthMm: 1.25,
    safeZ: 22,
    toolDiameter: 4,
    toolProfileId: "vflat-4mm-25deg",
    feedRate: 180,
    spindleRpm: 12000
  },
  outputs: {
    gcode: join(workDir, "toolpath.nc"),
    report: resultPath,
    preview: previewPath,
    simulationResult: join(workDir, "camotics-result.json")
  }
}, null, 2));

const run = spawnSync(process.execPath, ["adapters/camotics/camotics_job.js", jobPath, resultPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
    HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
    HEDIAO3D_CAMOTICS_RESULT_JSON: importedPath
  }
});

assert(!run.error, `adapter spawn failed: ${run.error?.message}`);
assert(run.status === 0, `adapter exited ${run.status}: ${run.stderr}`);

const report = JSON.parse(readFileSync(resultPath, "utf8"));
assert(report.status === "completed", `adapter report expected completed, got ${report.status}: ${report.error}`);
assert(report.simulationResultPath, "adapter report missing simulationResultPath");
assert(report.metrics?.resultPath === report.simulationResultPath, "adapter metrics should expose imported result path");

const result = JSON.parse(readFileSync(join(workDir, "camotics-result.json"), "utf8"));
assert(result.schema === "hediao3d.camotics-result.v1", "result schema mismatch");
assert(result.synthetic === false, "imported result must remain non-synthetic");
assert(result.importedFrom === importedPath, "imported result should record source path");
assert(result.metrics?.materialRemovedMm3 === 1.2, "imported metrics were not preserved");
assert(result.evidenceQuality?.productionEvidenceEligible === true, "complete imported CAMotics evidence should be production eligible");
assert(result.evidenceQuality?.status === "complete", `evidence quality should be complete, got ${result.evidenceQuality?.status}`);
assert(result.evidenceQuality?.inputIdentity?.status === "matched", `input identity should match, got ${result.evidenceQuality?.inputIdentity?.status}`);
assert(result.inputs?.expectedPreferredGcodeSha256 === previewSha256, "expected preview hash missing from imported result");
assert(result.artifactEvidence?.files?.screenshot?.sha256 === screenshotSha256, "screenshot artifact hash missing or mismatched");
assert(result.artifactEvidence?.files?.materialMesh?.sha256 === materialMeshSha256, "material mesh artifact hash missing or mismatched");
assert(result.artifacts?.screenshot === "camotics-preview.png", "screenshot should be copied to standard job artifact name");
assert(result.artifacts?.materialMesh === "camotics-material-removal.stl", "material mesh should be copied to standard job artifact name");
copyFileSync(join(workDir, "camotics-result.json"), completeResultPath);

const mismatchPath = join(workDir, "mismatched-camotics-result.json");
const mismatchReportPath = join(workDir, "mismatched-camotics-adapter-report.json");
writeFileSync(mismatchPath, JSON.stringify({
  ...JSON.parse(readFileSync(importedPath, "utf8")),
  inputs: {
    preferredGcode: "camotics-preview.nc",
    preferredGcodeSha256: "0".repeat(64)
  }
}, null, 2));
const mismatchRun = spawnSync(process.execPath, ["adapters/camotics/camotics_job.js", jobPath, mismatchReportPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
    HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
    HEDIAO3D_CAMOTICS_RESULT_JSON: mismatchPath
  }
});
assert(!mismatchRun.error, `mismatch adapter spawn failed: ${mismatchRun.error?.message}`);
assert(mismatchRun.status === 0, `mismatch adapter exited ${mismatchRun.status}: ${mismatchRun.stderr}`);
const mismatchReport = JSON.parse(readFileSync(mismatchReportPath, "utf8"));
assert(mismatchReport.status === "completed", "mismatched import should still complete as review evidence");
const mismatchResult = JSON.parse(readFileSync(join(workDir, "camotics-result.json"), "utf8"));
assert(mismatchResult.evidenceQuality?.productionEvidenceEligible === false, "hash mismatch must not be production eligible");
assert(mismatchResult.evidenceQuality?.inputIdentity?.status === "mismatch", `hash mismatch should be reported, got ${mismatchResult.evidenceQuality?.inputIdentity?.status}`);

const missingArtifactPath = join(workDir, "missing-artifact-camotics-result.json");
const missingArtifactReportPath = join(workDir, "missing-artifact-camotics-adapter-report.json");
writeFileSync(missingArtifactPath, JSON.stringify({
  ...JSON.parse(readFileSync(importedPath, "utf8")),
  artifacts: {
    screenshot: "does-not-exist.png",
    materialMesh: "does-not-exist.stl"
  }
}, null, 2));
const missingArtifactRun = spawnSync(process.execPath, ["adapters/camotics/camotics_job.js", jobPath, missingArtifactReportPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
    HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
    HEDIAO3D_CAMOTICS_RESULT_JSON: missingArtifactPath
  }
});
assert(!missingArtifactRun.error, `missing artifact adapter spawn failed: ${missingArtifactRun.error?.message}`);
assert(missingArtifactRun.status === 0, `missing artifact adapter exited ${missingArtifactRun.status}: ${missingArtifactRun.stderr}`);
const missingArtifactReport = JSON.parse(readFileSync(missingArtifactReportPath, "utf8"));
assert(missingArtifactReport.status === "completed", "missing artifact import should complete as review evidence");
const missingArtifactResult = JSON.parse(readFileSync(join(workDir, "camotics-result.json"), "utf8"));
assert(missingArtifactResult.evidenceQuality?.productionEvidenceEligible === false, "missing visual/material artifacts must not be production eligible");
assert(missingArtifactResult.evidenceQuality?.missing?.includes("visualOrMeshArtifact"), "missing artifact should be reported in evidence quality");

const contract = {
  schema: "hediao3d.camotics-import-contract.v1",
  createdAt: new Date().toISOString(),
  ok: true,
  workDir,
  outputRoot,
  status: report.status,
  adapterReport: join(outputRoot, "camotics-adapter-report.json"),
  camoticsResult: join(outputRoot, "camotics-result.json"),
  synthetic: result.synthetic,
  riskLevel: result.riskLevel,
  materialRemovedMm3: result.metrics.materialRemovedMm3,
  productionEvidenceEligible: result.evidenceQuality.productionEvidenceEligible,
  artifactEvidence: result.artifactEvidence
};
copyFileSync(resultPath, contract.adapterReport);
copyFileSync(completeResultPath, contract.camoticsResult);
copyFileSync(join(workDir, "camotics-preview.png"), join(outputRoot, "camotics-preview.png"));
copyFileSync(join(workDir, "camotics-material-removal.stl"), join(outputRoot, "camotics-material-removal.stl"));
writeFileSync(join(outputRoot, "camotics-import-contract.json"), JSON.stringify(contract, null, 2));

console.log(JSON.stringify(contract, null, 2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
