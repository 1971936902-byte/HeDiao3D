#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

writeFileSync(previewPath, [
  "(CAMOTICS PREVIEW ONLY - not for machine)",
  "G21",
  "G90",
  "G0 X0 Y0 Z5",
  "G1 X1 Y1 Z-0.2 F120",
  "M30",
  ""
].join("\n"));

writeFileSync(importedPath, JSON.stringify({
  schema: "hediao3d.camotics-result.v1",
  engine: "camotics",
  status: "completed",
  synthetic: false,
  riskLevel: "ready",
  summary: "Imported real CAMotics result fixture.",
  metrics: {
    motionLineCount: 2,
    zMin: -0.2,
    zMax: 5,
    materialRemovedMm3: 1.2
  },
  artifacts: {
    screenshot: "camotics-preview.png",
    materialMesh: "camotics-material-removal.stl"
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
  productionEvidenceEligible: result.evidenceQuality.productionEvidenceEligible
};
copyFileSync(resultPath, contract.adapterReport);
copyFileSync(join(workDir, "camotics-result.json"), contract.camoticsResult);
writeFileSync(join(outputRoot, "camotics-import-contract.json"), JSON.stringify(contract, null, 2));

console.log(JSON.stringify(contract, null, 2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
