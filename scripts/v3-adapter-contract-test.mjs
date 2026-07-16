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
      preview: join(workDir, "outputs", "preview.json")
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
    assert(report.gcodePath || report.outputs?.gcode, `${engineId} completed report must include gcode path`);
  } else {
    assert(typeof report.error === "string" && report.error.length > 0, `${engineId} non-completed report must include an error`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
