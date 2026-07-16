#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const workDir = join(tmpdir(), `hediao3d-opencamlib-neutral-import-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const jobPath = join(workDir, "opencamlib-job.json");
const resultPath = join(workDir, "adapter-report.json");
const importedPath = join(workDir, "real-neutral-toolpath.json");
const outputNeutralPath = join(workDir, "neutral-toolpath.json");

writeFileSync(importedPath, JSON.stringify({
  schema: "hediao3d.neutral-toolpath.v1",
  engine: "opencamlib",
  synthetic: false,
  coordinate: {
    lengthAxis: "X",
    rotaryAxis: "Y",
    depthAxis: "Z",
    rotaryUnit: "degree"
  },
  estimatedMinutes: 1.5,
  points: [
    { x: -12, a: 0, z: 21.6, depth: 0.4, source: "real-import-fixture" },
    { x: 0, a: 90, z: 21.2, depth: 0.8, source: "real-import-fixture" },
    { x: 12, a: 180, z: 21.5, depth: 0.5, source: "real-import-fixture" }
  ],
  warnings: []
}, null, 2));

writeFileSync(jobPath, JSON.stringify({
  jobId: "opencamlib-neutral-import-test",
  engine: "opencamlib",
  modelPath: join(workDir, "model.stl"),
  workDir,
  settings: {
    camMode: "rotaryWrap",
    lengthMm: 38,
    diameterMm: 15,
    depthMm: 1.25,
    safeZ: 22,
    rotaryOutputAxis: "Y",
    rotaryWrapPerRevolutionMm: 100,
    toolDiameter: 4,
    toolProfileId: "vflat-4mm-25deg",
    stepoverMm: 0.28,
    stepoverDeg: 5,
    maxCutDepth: 0.45,
    stockAllowance: 0.08
  },
  outputs: {
    gcode: join(workDir, "toolpath.nc"),
    report: resultPath,
    neutralToolpath: outputNeutralPath
  },
  externalCamRecipe: {
    schema: "hediao3d.external-cam-recipe.v1",
    status: "ready-for-adapter",
    engine: {
      selectedEngine: "opencamlib",
      selectedEngineName: "OpenCAMLib",
      engineFamily: "opencamlib-kernel"
    },
    operations: [
      { id: "finishing", enabled: true, strategy: "unwrapped-rotary-drop-cutter", parameters: {} }
    ],
    postprocess: {
      policy: "External CAM returns neutral/unwrapped path; HeDiao3D owns final rotary-wrap Y/A postprocess."
    }
  }
}, null, 2));

const run = spawnSync(process.env.PYTHON ?? "python", ["adapters/opencamlib/opencamlib_job.py", jobPath, resultPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
    HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
    HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON: importedPath
  }
});

assert(!run.error, `adapter spawn failed: ${run.error?.message}`);
assert(run.status === 0, `adapter exited ${run.status}: ${run.stderr || run.stdout}`);

const report = JSON.parse(readFileSync(resultPath, "utf8"));
assert(report.status === "completed", `adapter report expected completed, got ${report.status}: ${report.error}`);
assert(report.neutralToolpathPath === outputNeutralPath, "adapter report should point to imported neutral output");
assert(report.metrics?.neutralToolpath?.imported === true, "adapter metrics should mark neutral output as imported");
assert(report.metrics?.neutralToolpath?.synthetic === false, "adapter metrics should mark neutral output as non-synthetic");

const neutral = JSON.parse(readFileSync(outputNeutralPath, "utf8"));
assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
assert(neutral.synthetic === false, "imported neutral output must remain non-synthetic");
assert(neutral.importedFrom === importedPath, "neutral output should record source path");
assert(neutral.points.length === 3, "neutral point count mismatch");

console.log(JSON.stringify({
  ok: true,
  workDir,
  status: report.status,
  imported: report.metrics.neutralToolpath.imported,
  synthetic: neutral.synthetic,
  pointCount: neutral.points.length
}, null, 2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
