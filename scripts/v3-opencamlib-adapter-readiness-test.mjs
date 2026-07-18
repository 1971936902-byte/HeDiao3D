#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-adapter-readiness-"));
const python = process.env.PYTHON ?? "python";
const adapterPath = resolve("adapters", "opencamlib", "opencamlib_job.py");

try {
  const jobPath = join(workDir, "job.json");
  const resultPath = join(workDir, "adapter-report.json");
  const modelPath = join(workDir, "model.stl");
  const neutralPath = join(workDir, "neutral-toolpath.json");
  writeFileSync(modelPath, createAsciiStl());
  writeFileSync(jobPath, JSON.stringify(createJob({ modelPath, resultPath, neutralPath }), null, 2));

  const run = spawnSync(python, [adapterPath, jobPath, resultPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW: "false",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON: JSON.stringify([python, resolve("adapters", "opencamlib", "opencamlib_runner.py")])
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });

  assert(run.status === 0, `adapter exited ${run.status}: ${run.stderr || run.stdout}`);
  assert(existsSync(resultPath), "adapter report missing");
  const report = JSON.parse(readFileSync(resultPath, "utf8"));
  assert(report.status === "adapter_not_ready", `adapter should stay fail-closed, got ${report.status}`);
  assert(report.metrics?.neutralToolpath?.status === "not_generated", "neutral output should not be generated");
  const readiness = report.metrics?.opencamlibRunnerReadiness;
  assert(readiness?.schema === "hediao3d.opencamlib-runner-readiness-summary.v1", "adapter should expose runner readiness summary");
  assert(readiness.status === "blocked", `runner readiness should be blocked locally, got ${readiness.status}`);
  assert(readiness.canAttemptRealContactRunner === false, "runner readiness must not allow real contact runner locally");
  assert(Array.isArray(readiness.blockers) && readiness.blockers.length > 0, "runner readiness should expose blockers");
  assert(readiness.contactSpikeStatus, "runner readiness should expose contact spike status");
  assert(existsSync(join(workDir, "opencamlib-runner-readiness.json")), "runner readiness artifact missing beside neutral output");
  assert(existsSync(join(workDir, "opencamlib-real-contact-spike.json")), "runner contact spike precheck artifact missing");

  console.log(JSON.stringify({
    ok: true,
    status: report.status,
    readinessStatus: readiness.status,
    blockers: readiness.blockers,
    contactSpikeStatus: readiness.contactSpikeStatus
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createJob({ modelPath, resultPath, neutralPath }) {
  return {
    jobId: "opencamlib-adapter-readiness-test",
    engine: "opencamlib",
    modelPath,
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
      neutralToolpath: neutralPath
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
        policy: "External CAM returns neutral/unwrapped path; HeDiao3D owns final rotary-wrap Y postprocess."
      }
    }
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
