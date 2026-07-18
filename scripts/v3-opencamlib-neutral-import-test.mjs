#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = process.cwd();
const workDir = join(tmpdir(), `hediao3d-opencamlib-neutral-import-${Date.now()}`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.env.V3_NEUTRAL_IMPORT_DIR ?? join(root, "public", "orchestrator-neutral-import", stamp));
mkdirSync(workDir, { recursive: true });
mkdirSync(outputRoot, { recursive: true });

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
assert(report.metrics?.handoffEvidence?.classification === "missing-contact-report", `imported OpenCAMLib neutral without contact report should be missing-contact-report, got ${report.metrics?.handoffEvidence?.classification}`);
assert(report.metrics?.handoffEvidence?.productionCandidate === false, "imported OpenCAMLib neutral without contact report must not be production candidate");

const neutral = JSON.parse(readFileSync(outputNeutralPath, "utf8"));
assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
assert(neutral.synthetic === false, "imported neutral output must remain non-synthetic");
assert(neutral.importedFrom === importedPath, "neutral output should record source path");
assert(neutral.points.length === 3, "neutral point count mismatch");

const contract = {
  schema: "hediao3d.neutral-import-contract.v1",
  createdAt: new Date().toISOString(),
  ok: true,
  workDir,
  outputRoot,
  status: report.status,
  adapterReport: join(outputRoot, "adapter-report.json"),
  neutralToolpath: join(outputRoot, "neutral-toolpath.json"),
  imported: report.metrics.neutralToolpath.imported,
  synthetic: neutral.synthetic,
  pointCount: neutral.points.length,
  postprocessEligible: neutral.synthetic === false && report.status === "completed" && neutral.points.length > 0
};
copyFileSync(resultPath, contract.adapterReport);
copyFileSync(outputNeutralPath, contract.neutralToolpath);
writeFileSync(join(outputRoot, "neutral-import-contract.json"), JSON.stringify(contract, null, 2));

const candidateJobPath = join(workDir, "opencamlib-candidate-job.json");
const candidateResultPath = join(workDir, "adapter-candidate-report.json");
const candidateImportedPath = join(workDir, "real-neutral-toolpath-with-contact-report.json");
const candidateOutputNeutralPath = join(workDir, "neutral-toolpath-candidate.json");
const candidateContactReportPath = join(workDir, "opencamlib-cutter-contact-report.json");
writeFileSync(candidateImportedPath, JSON.stringify({
  schema: "hediao3d.neutral-toolpath.v1",
  engine: "opencamlib",
  synthetic: false,
  coordinate: {
    lengthAxis: "X",
    rotaryAxis: "Y",
    depthAxis: "Z",
    rotaryUnit: "degree"
  },
  cutterContactReportPath: candidateContactReportPath,
  points: [
    { x: -12, a: 0, z: 21.6, depth: 0.4, source: "validated-contact-fixture" },
    { x: 0, a: 90, z: 21.2, depth: 0.8, source: "validated-contact-fixture" },
    { x: 12, a: 180, z: 21.5, depth: 0.5, source: "validated-contact-fixture" }
  ]
}, null, 2));
writeFileSync(candidateContactReportPath, JSON.stringify({
  schema: "hediao3d.opencamlib-cutter-contact-report.v1",
  inputIdentity: {
    sourceNeutralToolpathSha256: sha256File(candidateImportedPath)
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
      sampledXSpanMm: 24,
      sampledCrossSpanMm: 180,
      modelXSpanMm: 24,
      modelCrossSpanMm: 180
    }
  },
  residualMaterial: {
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
    safeMinX: -12,
    safeMaxX: 12,
    sampledMinX: -12,
    sampledMaxX: 12,
    violationCount: 0,
    violations: []
  },
  quality: {
    level: "ready",
    productionCandidate: true,
    postprocessEligible: true,
    summary: "Validated OpenCAMLib cutter-contact report fixture for production-candidate classification."
  }
}, null, 2));
writeFileSync(candidateJobPath, JSON.stringify({
  ...JSON.parse(readFileSync(jobPath, "utf8")),
  outputs: {
    gcode: join(workDir, "toolpath-candidate.nc"),
    report: candidateResultPath,
    neutralToolpath: candidateOutputNeutralPath
  }
}, null, 2));
const candidateRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/opencamlib/opencamlib_job.py", candidateJobPath, candidateResultPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
    HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
    HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON: candidateImportedPath
  }
});
assert(!candidateRun.error, `candidate adapter spawn failed: ${candidateRun.error?.message}`);
assert(candidateRun.status === 0, `candidate adapter exited ${candidateRun.status}: ${candidateRun.stderr || candidateRun.stdout}`);
const candidateReport = JSON.parse(readFileSync(candidateResultPath, "utf8"));
assert(candidateReport.status === "completed", `candidate adapter report expected completed, got ${candidateReport.status}: ${candidateReport.error}`);
assert(candidateReport.metrics?.neutralToolpath?.cutterContactReport?.status === "production-candidate", "candidate contact report should be production-candidate");
assert(candidateReport.metrics.neutralToolpath.cutterContactReport.strictEvidence?.status === "ready", "candidate contact report should expose ready strict contact evidence");
assert(candidateReport.metrics.neutralToolpath.cutterContactReport.inputIdentityBinding?.status === "bound", "candidate contact report should bind to source neutral hash");
assert(candidateReport.metrics?.handoffEvidence?.classification === "production-candidate", `validated contact report should classify as production-candidate, got ${candidateReport.metrics?.handoffEvidence?.classification}`);
assert(candidateReport.metrics?.handoffEvidence?.productionCandidate === true, "validated contact report should allow production candidate classification");

const unboundJobPath = join(workDir, "opencamlib-unbound-contact-job.json");
const unboundResultPath = join(workDir, "adapter-unbound-contact-report.json");
const unboundImportedPath = join(workDir, "real-neutral-toolpath-unbound-contact-report.json");
const unboundOutputNeutralPath = join(workDir, "neutral-toolpath-unbound.json");
writeFileSync(unboundImportedPath, JSON.stringify({
  schema: "hediao3d.neutral-toolpath.v1",
  engine: "opencamlib",
  synthetic: false,
  coordinate: {
    lengthAxis: "X",
    rotaryAxis: "Y",
    depthAxis: "Z",
    rotaryUnit: "degree"
  },
  cutterContactReport: {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    quality: {
      level: "ready",
      productionCandidate: true,
      postprocessEligible: true,
      summary: "Unbound report intentionally lacks inputIdentity and must not classify as production-candidate."
    }
  },
  points: [
    { x: -12, a: 0, z: 21.6, depth: 0.4, source: "unbound-contact-fixture" },
    { x: 0, a: 90, z: 21.2, depth: 0.8, source: "unbound-contact-fixture" },
    { x: 12, a: 180, z: 21.5, depth: 0.5, source: "unbound-contact-fixture" }
  ]
}, null, 2));
writeFileSync(unboundJobPath, JSON.stringify({
  ...JSON.parse(readFileSync(jobPath, "utf8")),
  outputs: {
    gcode: join(workDir, "toolpath-unbound.nc"),
    report: unboundResultPath,
    neutralToolpath: unboundOutputNeutralPath
  }
}, null, 2));
const unboundRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/opencamlib/opencamlib_job.py", unboundJobPath, unboundResultPath], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
    HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
    HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON: unboundImportedPath
  }
});
assert(!unboundRun.error, `unbound adapter spawn failed: ${unboundRun.error?.message}`);
assert(unboundRun.status === 0, `unbound adapter exited ${unboundRun.status}: ${unboundRun.stderr || unboundRun.stdout}`);
const unboundReport = JSON.parse(readFileSync(unboundResultPath, "utf8"));
assert(unboundReport.metrics?.neutralToolpath?.cutterContactReport?.inputIdentityBinding?.status === "missing", "unbound contact report should expose missing input identity");
assert(unboundReport.metrics?.handoffEvidence?.classification === "contact-report-review", `unbound contact report should classify as review, got ${unboundReport.metrics?.handoffEvidence?.classification}`);
assert(unboundReport.metrics?.handoffEvidence?.productionCandidate === false, "unbound contact report must not be production candidate");

console.log(JSON.stringify({
  ...contract,
  missingContactClassification: report.metrics.handoffEvidence.classification,
  candidateClassification: candidateReport.metrics.handoffEvidence.classification,
  unboundClassification: unboundReport.metrics.handoffEvidence.classification
}, null, 2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
