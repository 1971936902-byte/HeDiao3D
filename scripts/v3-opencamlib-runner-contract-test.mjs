#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-runner-contract-"));
const runnerPath = resolve("adapters", "opencamlib", "opencamlib_runner.py");
const python = process.env.PYTHON ?? "python";

try {
  const jobPath = join(workDir, "job.json");
  const planPath = join(workDir, "opencamlib-kernel-plan.json");
  const outputPath = join(workDir, "neutral-toolpath.json");
  const job = createJob();
  const plan = createPlan(job);
  writeFileSync(job.modelPath, createAsciiStl());
  writeFileSync(jobPath, JSON.stringify(job, null, 2));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const fixtureRun = spawnSync(python, [runnerPath, jobPath, planPath, outputPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT: "true"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(fixtureRun.status === 0, `fixture runner exited ${fixtureRun.status}: ${fixtureRun.stderr || fixtureRun.stdout}`);
  assert(existsSync(outputPath), "fixture runner did not write neutral output");
  const neutral = JSON.parse(readFileSync(outputPath, "utf8"));
  assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
  assert(neutral.synthetic === false, "runner fixture must be non-synthetic for adapter import classification");
  assert(neutral.fixture === true, "runner fixture marker missing");
  assert(neutral.generatedByExternalCommand === true, "external command marker missing");
  assert(Array.isArray(neutral.points) && neutral.points.length === 48, "runner fixture point count mismatch");
  assert(neutral.coordinate?.rotaryAxis === "Y", "runner fixture rotary axis mismatch");
  assert(neutral.runner?.geometry?.triangleCount === 2, "runner geometry triangle count mismatch");
  assert(neutral.runner?.geometry?.dimensions?.x === 10, "runner geometry X dimension mismatch");
  assert(neutral.runner?.geometry?.dimensions?.y === 5, "runner geometry Y dimension mismatch");

  const heightfieldOutput = join(workDir, "neutral-heightfield.json");
  const heightfieldRun = spawnSync(python, [runnerPath, jobPath, planPath, heightfieldOutput], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "3",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "4"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(heightfieldRun.status === 0, `heightfield runner exited ${heightfieldRun.status}: ${heightfieldRun.stderr || heightfieldRun.stdout}`);
  const heightfield = JSON.parse(readFileSync(heightfieldOutput, "utf8"));
  assert(heightfield.schema === "hediao3d.neutral-toolpath.v1", "heightfield neutral schema mismatch");
  assert(heightfield.synthetic === false, "heightfield neutral must be non-synthetic");
  assert(heightfield.fixture === false, "heightfield neutral must not be fixture output");
  assert(heightfield.experimentalHeightfield === true, "heightfield marker missing");
  assert(heightfield.runner?.heightfield?.pointCount === 12, "heightfield point count mismatch");
  assert(heightfield.runner?.heightfield?.missCount === 0, "heightfield should sample the whole rectangle");
  assert(heightfield.runner?.heightfield?.cutterEnvelope === true, "heightfield should enable cutter envelope sampling");
  assert(heightfield.runner?.heightfield?.cutterRadiusMm > 0, "heightfield cutter radius should be derived from the tool profile");
  assert(heightfield.runner?.heightfield?.cutterSampleCount >= heightfield.points.length, "heightfield should report cutter contact sample count");
  assert(heightfield.points.every((point) => point.cutterRadiusMm === heightfield.runner.heightfield.cutterRadiusMm), "heightfield points should echo cutter radius");
  assert(heightfield.points.some((point) => point.contactSamples > 1), "heightfield should include multi-contact cutter envelope samples");
  assert(heightfield.points.some((point) => point.source === "stl-heightfield-preview"), "heightfield point source missing");
  assert(new Set(heightfield.points.map((point) => point.depth)).size > 1, "heightfield should contain varying depths from STL Z interpolation");

  const noFixtureOutput = join(workDir, "neutral-no-fixture.json");
  const noFixtureRun = spawnSync(python, [runnerPath, jobPath, planPath, noFixtureOutput], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT: "false"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(noFixtureRun.status !== 0, "runner should fail closed without fixture mode or validated real OpenCAMLib implementation");

  console.log(JSON.stringify({
    ok: true,
    runner: runnerPath,
    fixturePoints: neutral.points.length,
    heightfieldPoints: heightfield.points.length,
    fixtureMode: neutral.runner?.mode,
    failClosedExit: noFixtureRun.status
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createJob() {
  return {
    jobId: "opencamlib-runner-contract-test",
    engine: "opencamlib",
    modelPath: join(workDir, "sample.stl"),
    workDir,
    settings: {
      camMode: "rotaryWrap",
      lengthMm: 38,
      diameterMm: 15,
      depthMm: 1.25,
      safeZ: 22,
      feedRate: 180,
      spindleRpm: 12000,
      rotaryOutputAxis: "Y",
      rotaryWrapPerRevolutionMm: 100,
      toolProfileId: "vflat-4mm-25deg",
      toolDiameter: 4,
      stepoverMm: 0.28,
      stepoverDeg: 5,
      maxCutDepth: 0.45,
      stockAllowance: 0.08,
      postProcessor: "wrapY"
    },
    outputs: {
      neutralToolpath: join(workDir, "neutral-toolpath.json")
    }
  };
}

function createPlan(job) {
  return {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: job.jobId,
    engine: "opencamlib",
    model: {
      path: job.modelPath,
      format: "stl",
      exists: true
    },
    stock: {
      lengthMm: 38,
      diameterMm: 15
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    sampling: {
      recommendedPrimary: "unwrapped-rotary-drop-cutter",
      axisMapping: {
        lengthAxis: "X",
        depthAxis: "Z",
        rotaryAxis: "Y",
        rotaryWrapPerRevolutionMm: 100
      }
    },
    operations: [
      { id: "finishing", enabled: true, strategy: "unwrapped-rotary-drop-cutter" }
    ]
  };
}

function createAsciiStl() {
  return `solid sample
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 1
      vertex 0 5 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 10 0 1
      vertex 10 5 1
      vertex 0 5 0
    endloop
  endfacet
endsolid sample
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
