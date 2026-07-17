#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "hediao3d-adapter-contract-"));

const adapters = [
  {
    id: "freecad",
    command: process.env.PYTHON ?? "python",
    args: ["adapters/freecad/freecad_cam_job.py"]
  },
  {
    id: "blendercam",
    command: process.env.PYTHON ?? "python",
    args: ["adapters/blendercam/blendercam_job.py"]
  },
  {
    id: "opencamlib",
    command: process.env.PYTHON ?? "python",
    args: ["adapters/opencamlib/opencamlib_job.py"]
  },
  {
    id: "camotics",
    command: process.execPath,
    args: ["adapters/camotics/camotics_job.js"]
  }
];

try {
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const job = {
    jobId: "adapter-contract-test",
    engine: "contract",
    modelPath: join(workDir, "sample.glb"),
    workDir,
    settings: {
      camMode: "rotaryWrap",
      lengthMm: 38,
      diameterMm: 15,
      rotaryOutputAxis: "Y",
      rotaryWrapPerRevolutionMm: 100,
      toolProfileId: "vflat-4mm-25deg",
      toolDiameter: 4
    },
    outputs: {
      gcode: join(workDir, "outputs", "toolpath.nc"),
      report: join(workDir, "outputs", "adapter-report.json"),
      preview: join(workDir, "outputs", "preview.json"),
      neutralToolpath: join(workDir, "outputs", "neutral-toolpath.json")
    },
    externalCamRecipe: {
      schema: "hediao3d.external-cam-recipe.v1",
      status: "ready-for-adapter",
      engine: {
        selectedEngine: "contract",
        engineFamily: "contract-test"
      },
      tool: {
        toolProfileId: "vflat-4mm-25deg",
        diameterMm: 4
      },
      operations: [
        { id: "roughing", enabled: true, strategy: "unwrapped-x-scan-roughing" },
        { id: "finishing", enabled: true, strategy: "x-scan" },
        { id: "rest-detail", enabled: true, strategy: "local-detail-pass-on-steep-features" }
      ],
      postprocess: {
        camMode: "rotaryWrap",
        postProcessor: "wrapY",
        policy: "External CAM returns neutral/unwrapped path; HeDiao3D owns final rotary-wrap Y/A postprocess."
      }
    }
  };
  writeFileSync(job.modelPath, "placeholder model path for adapter contract test");

  const results = [];
  for (const adapter of adapters) {
    const jobPath = join(workDir, `${adapter.id}-job.json`);
    const resultPath = join(workDir, `${adapter.id}-report.json`);
    writeFileSync(jobPath, JSON.stringify({ ...job, engine: adapter.id, outputs: { ...job.outputs, report: resultPath } }, null, 2));

    const run = spawnSync(adapter.command, [...adapter.args, jobPath, resultPath], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000
    });
    assert(run.status === 0, `${adapter.id} exited ${run.status}: ${run.stderr || run.stdout}`);

    const report = JSON.parse(readFileSync(resultPath, "utf8"));
    validateReport(adapter.id, report);
    if (adapter.id === "freecad") {
      assert(report.metrics.freecadPlan?.status === "generated", "freecad adapter did not generate a CAM plan");
      assert(existsSync(report.metrics.freecadPlan.planPath), "freecad CAM plan file missing");
      assert(existsSync(report.metrics.freecadPlan.runTemplatePath), "freecad run template file missing");
    }
    if (adapter.id === "blendercam") {
      assert(report.metrics.blendercamPlan?.status === "generated", "blendercam adapter did not generate a CAM plan");
      assert(existsSync(report.metrics.blendercamPlan.planPath), "blendercam CAM plan file missing");
      assert(existsSync(report.metrics.blendercamPlan.runTemplatePath), "blendercam run template file missing");
      assert(report.metrics.blendercamPlan.preferredForMeshyOutput === true, "blendercam plan should prefer Meshy GLB/OBJ/STL inputs");
    }
    if (adapter.id === "camotics") {
      assert(report.metrics.camoticsPlan?.status === "generated", "camotics adapter did not generate a simulation plan");
      assert(existsSync(report.metrics.camoticsPlan.planPath), "camotics simulation plan file missing");
      assert(existsSync(report.metrics.camoticsPlan.projectTemplatePath), "camotics project template file missing");
      assert(report.metrics.camoticsPlan.preferredGcode === "camotics-preview.nc", "camotics preferred gcode mismatch");
    }
    if (adapter.id === "opencamlib") {
      assert(report.metrics.opencamlibPlan?.status === "generated", "opencamlib adapter did not generate a kernel plan");
      assert(existsSync(report.metrics.opencamlibPlan.planPath), "opencamlib kernel plan file missing");
      assert(existsSync(report.metrics.opencamlibPlan.runTemplatePath), "opencamlib run template file missing");
      assert(typeof report.metrics.opencamlibPlan.recommendedPrimary === "string", "opencamlib recommended strategy missing");
    }
    results.push({
      id: adapter.id,
      status: report.status,
      protocolVersion: report.protocolVersion,
      warningCount: report.warnings?.length ?? 0,
      recipeOperations: report.metrics.recipe.operationCount,
      freecadPlan: report.metrics.freecadPlan?.status ?? null,
      blendercamPlan: report.metrics.blendercamPlan?.status ?? null,
      camoticsPlan: report.metrics.camoticsPlan?.status ?? null,
      opencamlibPlan: report.metrics.opencamlibPlan?.status ?? null
    });
  }

  const neutralJobPath = join(workDir, "opencamlib-neutral-job.json");
  const neutralResultPath = join(workDir, "opencamlib-neutral-report.json");
  const neutralOutputPath = join(workDir, "outputs", "opencamlib-neutral-toolpath.json");
  writeFileSync(neutralJobPath, JSON.stringify({
    ...job,
    engine: "opencamlib",
    outputs: {
      ...job.outputs,
      report: neutralResultPath,
      neutralToolpath: neutralOutputPath
    }
  }, null, 2));
  const neutralRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/opencamlib/opencamlib_job.py", neutralJobPath, neutralResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "true"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(neutralRun.status === 0, `opencamlib neutral handoff exited ${neutralRun.status}: ${neutralRun.stderr || neutralRun.stdout}`);
  const neutralReport = JSON.parse(readFileSync(neutralResultPath, "utf8"));
  validateReport("opencamlib", neutralReport);
  assert(neutralReport.status === "completed", "opencamlib neutral handoff should complete in synthetic contract mode");
  assert(existsSync(neutralOutputPath), "opencamlib neutral toolpath file missing");
  const neutralToolpath = JSON.parse(readFileSync(neutralOutputPath, "utf8"));
  assert(neutralToolpath.schema === "hediao3d.neutral-toolpath.v1", "neutral toolpath schema mismatch");
  assert(Array.isArray(neutralToolpath.points) && neutralToolpath.points.length > 0, "neutral toolpath points missing");
  results.push({
    id: "opencamlib-neutral-handoff",
    status: neutralReport.status,
    protocolVersion: neutralReport.protocolVersion,
    warningCount: neutralReport.warnings?.length ?? 0,
    recipeOperations: neutralReport.metrics.recipe.operationCount,
    neutralToolpath: neutralReport.metrics.neutralToolpath?.status ?? null,
    pointCount: neutralToolpath.points.length
  });

  const freecadRunnerPath = resolve("adapters", "freecad", "freecad_runner.py");
  const freecadExternalJobPath = join(workDir, "freecad-external-job.json");
  const freecadExternalResultPath = join(workDir, "freecad-external-report.json");
  const freecadExternalGcodePath = join(workDir, "outputs", "freecad-external-toolpath.nc");
  const freecadExternalModelPath = join(workDir, "freecad-sample.stl");
  writeFileSync(freecadExternalModelPath, createTinyAsciiStl());
  writeFileSync(freecadExternalJobPath, JSON.stringify({
    ...job,
    engine: "freecad",
    modelPath: freecadExternalModelPath,
    outputs: {
      ...job.outputs,
      report: freecadExternalResultPath,
      gcode: freecadExternalGcodePath
    }
  }, null, 2));
  const freecadExternalRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/freecad/freecad_cam_job.py", freecadExternalJobPath, freecadExternalResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", freecadRunnerPath]),
      HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT: "true"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(freecadExternalRun.status === 0, `freecad external handoff exited ${freecadExternalRun.status}: ${freecadExternalRun.stderr || freecadExternalRun.stdout}`);
  const freecadExternalReport = JSON.parse(readFileSync(freecadExternalResultPath, "utf8"));
  validateReport("freecad", freecadExternalReport);
  assert(freecadExternalReport.status === "completed", "freecad external handoff should complete in fixture mode");
  assert(freecadExternalReport.gcodePath === freecadExternalGcodePath, "freecad report should expose gcodePath");
  assert(freecadExternalReport.metrics?.gcode?.status === "generated", "freecad metrics should mark G-code generated");
  const freecadPlan = JSON.parse(readFileSync(freecadExternalReport.metrics?.freecadPlan?.planPath, "utf8"));
  assert(freecadPlan.operations.every((operation) => operation.freecadOperationHint), "freecad plan operations should include FreeCAD operation hints");
  assert(freecadPlan.operations.every((operation) => operation.validationState), "freecad plan operations should include validation state");
  assert(freecadPlan.operations.some((operation) => /Surface|Profile|Pocket|Engrave/i.test(operation.freecadOperationHint)), "freecad operation hints should name Path operation candidates");
  assert(existsSync(freecadExternalReport.metrics?.freecadPlan?.runTemplatePath), "freecad run template missing");
  assert(existsSync(freecadExternalGcodePath), "freecad external G-code file missing");
  const freecadRunTemplate = readFileSync(freecadExternalReport.metrics.freecadPlan.runTemplatePath, "utf8");
  assert(freecadRunTemplate.includes("PathJob.Create"), "freecad run template should create a Path Job");
  assert(freecadRunTemplate.includes("PathToolController.Create"), "freecad run template should create a ToolController");
  assert(freecadRunTemplate.includes("PathPostProcessor.export"), "freecad run template should define postprocessing");
  assert(freecadRunTemplate.includes("HeDiao3D FreeCAD operation mapping"), "freecad run template should print operation mapping");
  assert(freecadRunTemplate.includes("freecadOperationHint"), "freecad run template should consume operation hints");
  assert(freecadRunTemplate.includes("validationState"), "freecad run template should consume operation validation states");
  assert(freecadRunTemplate.includes("HEDIAO3D_FREECAD_TEMPLATE_ALLOW_UNVALIDATED_OPS"), "freecad run template should fail closed for unvalidated operations");
  assert(freecadRunTemplate.includes(freecadExternalGcodePath.replaceAll("\\", "\\\\")) || freecadRunTemplate.includes(freecadExternalGcodePath), "freecad run template should include expected G-code output path");
  const freecadExternalGcode = readFileSync(freecadExternalGcodePath, "utf8");
  assert(freecadExternalGcode.includes("HeDiao3D FreeCAD external runner fixture"), "freecad external G-code marker missing");
  assert(/\bG1\b/.test(freecadExternalGcode), "freecad external G-code should contain G1 motion");
  results.push({
    id: "freecad-external-handoff",
    status: freecadExternalReport.status,
    protocolVersion: freecadExternalReport.protocolVersion,
    warningCount: freecadExternalReport.warnings?.length ?? 0,
    recipeOperations: freecadExternalReport.metrics.recipe.operationCount,
    gcode: freecadExternalReport.metrics.gcode?.status ?? null
  });

  const blendercamRunnerPath = resolve("adapters", "blendercam", "blendercam_runner.py");
  const blendercamExternalJobPath = join(workDir, "blendercam-external-job.json");
  const blendercamExternalResultPath = join(workDir, "blendercam-external-report.json");
  const blendercamExternalGcodePath = join(workDir, "outputs", "blendercam-external-toolpath.nc");
  const blendercamExternalModelPath = join(workDir, "blendercam-sample.stl");
  writeFileSync(blendercamExternalModelPath, createTinyAsciiStl());
  writeFileSync(blendercamExternalJobPath, JSON.stringify({
    ...job,
    engine: "blendercam",
    modelPath: blendercamExternalModelPath,
    outputs: {
      ...job.outputs,
      report: blendercamExternalResultPath,
      gcode: blendercamExternalGcodePath
    }
  }, null, 2));
  const blendercamExternalRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/blendercam/blendercam_job.py", blendercamExternalJobPath, blendercamExternalResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", blendercamRunnerPath]),
      HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT: "true"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(blendercamExternalRun.status === 0, `blendercam external handoff exited ${blendercamExternalRun.status}: ${blendercamExternalRun.stderr || blendercamExternalRun.stdout}`);
  const blendercamExternalReport = JSON.parse(readFileSync(blendercamExternalResultPath, "utf8"));
  validateReport("blendercam", blendercamExternalReport);
  assert(blendercamExternalReport.status === "completed", "blendercam external handoff should complete in fixture mode");
  assert(blendercamExternalReport.gcodePath === blendercamExternalGcodePath, "blendercam report should expose gcodePath");
  assert(blendercamExternalReport.metrics?.gcode?.status === "generated", "blendercam metrics should mark G-code generated");
  assert(existsSync(blendercamExternalGcodePath), "blendercam external G-code file missing");
  const blendercamExternalGcode = readFileSync(blendercamExternalGcodePath, "utf8");
  assert(blendercamExternalGcode.includes("HeDiao3D BlenderCAM external runner fixture"), "blendercam external G-code marker missing");
  assert(/\bG1\b/.test(blendercamExternalGcode), "blendercam external G-code should contain G1 motion");
  results.push({
    id: "blendercam-external-handoff",
    status: blendercamExternalReport.status,
    protocolVersion: blendercamExternalReport.protocolVersion,
    warningCount: blendercamExternalReport.warnings?.length ?? 0,
    recipeOperations: blendercamExternalReport.metrics.recipe.operationCount,
    gcode: blendercamExternalReport.metrics.gcode?.status ?? null
  });

  console.log(JSON.stringify({ ok: true, adapters: results }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function validateReport(engineId, report) {
  const allowedStatuses = new Set(["completed", "adapter_not_ready", "adapter_missing", "failed", "invalid_report", "completed_without_report"]);
  assert(report && typeof report === "object", `${engineId} report is not an object`);
  assert(report.protocolVersion === "hediao3d.adapter.v1", `${engineId} missing protocolVersion`);
  assert(report.engine === engineId, `${engineId} report engine mismatch: ${report.engine}`);
  assert(report.jobId === "adapter-contract-test", `${engineId} missing jobId`);
  assert(allowedStatuses.has(report.status), `${engineId} unsupported status ${report.status}`);
  assert(Array.isArray(report.warnings), `${engineId} warnings must be an array`);
  assert(report.metrics && typeof report.metrics === "object", `${engineId} metrics must be an object`);
  assert(report.metrics.recipe?.present === true, `${engineId} missing external CAM recipe summary`);
  assert(report.metrics.recipe.operationCount === 3, `${engineId} recipe operation count mismatch`);
  assert(report.metrics.recipe.enabledOperationCount === 3, `${engineId} enabled recipe operation count mismatch`);
  assert(report.metrics.recipe.toolProfileId === "vflat-4mm-25deg", `${engineId} recipe tool mismatch`);
  assert(typeof report.metrics.recipe.postprocessPolicy === "string" && report.metrics.recipe.postprocessPolicy.includes("wrap"), `${engineId} recipe postprocess policy missing`);
  if (report.status === "completed") {
    assert(report.gcodePath || report.outputs?.gcode || report.neutralToolpathPath || report.outputs?.neutralToolpath || report.metrics?.neutralToolpath?.path, `${engineId} completed report must include G-code or neutral toolpath path`);
  } else {
    assert(typeof report.error === "string" && report.error.length > 0, `${engineId} non-completed report must include an error`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createTinyAsciiStl() {
  return `solid freecad_contract
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 5 0
    endloop
  endfacet
endsolid freecad_contract
`;
}
