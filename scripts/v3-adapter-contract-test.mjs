#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  assert(neutralReport.metrics.handoffEvidence?.schema === "hediao3d.adapter-handoff-evidence.v1", "opencamlib neutral handoff evidence missing");
  assert(neutralReport.metrics.handoffEvidence.classification === "synthetic-contract", "opencamlib synthetic neutral handoff should be classified as synthetic-contract");
  assert(neutralReport.metrics.handoffEvidence.productionCandidate === false, "opencamlib synthetic neutral handoff must not be production candidate");
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
  assert(freecadExternalReport.metrics.handoffEvidence?.schema === "hediao3d.adapter-handoff-evidence.v1", "freecad handoff evidence missing");
  assert(freecadExternalReport.metrics.handoffEvidence.classification === "fixture-contract", "freecad fixture output should be classified as fixture-contract");
  assert(freecadExternalReport.metrics.handoffEvidence.productionCandidate === false, "freecad fixture output must not be production candidate");
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

  const freecadNoProofRunnerPath = join(workDir, "freecad-no-proof-runner.py");
  const freecadNoProofJobPath = join(workDir, "freecad-no-proof-job.json");
  const freecadNoProofResultPath = join(workDir, "freecad-no-proof-report.json");
  const freecadNoProofGcodePath = join(workDir, "outputs", "freecad-no-proof-toolpath.nc");
  writeExternalRunner(freecadNoProofRunnerPath, "freecad", false);
  writeFileSync(freecadNoProofJobPath, JSON.stringify({
    ...job,
    engine: "freecad",
    modelPath: freecadExternalModelPath,
    outputs: {
      ...job.outputs,
      report: freecadNoProofResultPath,
      gcode: freecadNoProofGcodePath
    }
  }, null, 2));
  const freecadNoProofRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/freecad/freecad_cam_job.py", freecadNoProofJobPath, freecadNoProofResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", freecadNoProofRunnerPath])
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(freecadNoProofRun.status === 0, `freecad no-proof handoff exited ${freecadNoProofRun.status}: ${freecadNoProofRun.stderr || freecadNoProofRun.stdout}`);
  const freecadNoProofReport = JSON.parse(readFileSync(freecadNoProofResultPath, "utf8"));
  validateReport("freecad", freecadNoProofReport);
  assert(freecadNoProofReport.metrics.handoffEvidence.classification === "missing-cam-proof", "freecad real G-code without CAM proof must be missing-cam-proof");
  assert(freecadNoProofReport.metrics.handoffEvidence.productionCandidate === false, "freecad missing-proof output must not be production candidate");

  const freecadProofRunnerPath = join(workDir, "freecad-proof-runner.py");
  const freecadProofJobPath = join(workDir, "freecad-proof-job.json");
  const freecadProofResultPath = join(workDir, "freecad-proof-report.json");
  const freecadProofGcodePath = join(workDir, "outputs", "freecad-proof-toolpath.nc");
  writeExternalRunner(freecadProofRunnerPath, "freecad", true);
  writeFileSync(freecadProofJobPath, JSON.stringify({
    ...job,
    engine: "freecad",
    modelPath: freecadExternalModelPath,
    outputs: {
      ...job.outputs,
      report: freecadProofResultPath,
      gcode: freecadProofGcodePath
    }
  }, null, 2));
  const freecadProofRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/freecad/freecad_cam_job.py", freecadProofJobPath, freecadProofResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", freecadProofRunnerPath])
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(freecadProofRun.status === 0, `freecad proof handoff exited ${freecadProofRun.status}: ${freecadProofRun.stderr || freecadProofRun.stdout}`);
  const freecadProofReport = JSON.parse(readFileSync(freecadProofResultPath, "utf8"));
  validateReport("freecad", freecadProofReport);
  assert(freecadProofReport.metrics.handoffEvidence.classification === "production-candidate", "freecad proof-backed output should be production-candidate");
  assert(freecadProofReport.metrics.handoffEvidence.productionCandidate === true, "freecad proof-backed output should be production candidate");
  assert(freecadProofReport.metrics.handoffEvidence.camOutputProof.gcodeSha256 === sha256(normalizedText(readFileSync(freecadProofGcodePath, "utf8"))), "freecad proof hash should bind current G-code");
  assert(freecadProofReport.metrics.handoffEvidence.camOutputProof.jobId === "adapter-contract-test", "freecad proof should bind current job id");
  assert(freecadProofReport.metrics.handoffEvidence.camOutputProof.modelSha256 === sha256Bytes(readFileSync(freecadExternalModelPath)), "freecad proof should bind current model");
  assert(freecadProofReport.metrics.handoffEvidence.camOutputProof.planSha256 === sha256Bytes(readFileSync(freecadProofReport.metrics.freecadPlan.planPath)), "freecad proof should bind current CAM plan");

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
  assert(blendercamExternalReport.metrics.handoffEvidence?.schema === "hediao3d.adapter-handoff-evidence.v1", "blendercam handoff evidence missing");
  assert(blendercamExternalReport.metrics.handoffEvidence.classification === "fixture-contract", "blendercam fixture output should be classified as fixture-contract");
  assert(blendercamExternalReport.metrics.handoffEvidence.productionCandidate === false, "blendercam fixture output must not be production candidate");
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

  const blendercamNoProofRunnerPath = join(workDir, "blendercam-no-proof-runner.py");
  const blendercamNoProofJobPath = join(workDir, "blendercam-no-proof-job.json");
  const blendercamNoProofResultPath = join(workDir, "blendercam-no-proof-report.json");
  const blendercamNoProofGcodePath = join(workDir, "outputs", "blendercam-no-proof-toolpath.nc");
  writeExternalRunner(blendercamNoProofRunnerPath, "blendercam", false);
  writeFileSync(blendercamNoProofJobPath, JSON.stringify({
    ...job,
    engine: "blendercam",
    modelPath: blendercamExternalModelPath,
    outputs: {
      ...job.outputs,
      report: blendercamNoProofResultPath,
      gcode: blendercamNoProofGcodePath
    }
  }, null, 2));
  const blendercamNoProofRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/blendercam/blendercam_job.py", blendercamNoProofJobPath, blendercamNoProofResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", blendercamNoProofRunnerPath])
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(blendercamNoProofRun.status === 0, `blendercam no-proof handoff exited ${blendercamNoProofRun.status}: ${blendercamNoProofRun.stderr || blendercamNoProofRun.stdout}`);
  const blendercamNoProofReport = JSON.parse(readFileSync(blendercamNoProofResultPath, "utf8"));
  validateReport("blendercam", blendercamNoProofReport);
  assert(blendercamNoProofReport.metrics.handoffEvidence.classification === "missing-cam-proof", "blendercam real G-code without CAM proof must be missing-cam-proof");
  assert(blendercamNoProofReport.metrics.handoffEvidence.productionCandidate === false, "blendercam missing-proof output must not be production candidate");

  const blendercamProofRunnerPath = join(workDir, "blendercam-proof-runner.py");
  const blendercamProofJobPath = join(workDir, "blendercam-proof-job.json");
  const blendercamProofResultPath = join(workDir, "blendercam-proof-report.json");
  const blendercamProofGcodePath = join(workDir, "outputs", "blendercam-proof-toolpath.nc");
  writeExternalRunner(blendercamProofRunnerPath, "blendercam", true);
  writeFileSync(blendercamProofJobPath, JSON.stringify({
    ...job,
    engine: "blendercam",
    modelPath: blendercamExternalModelPath,
    outputs: {
      ...job.outputs,
      report: blendercamProofResultPath,
      gcode: blendercamProofGcodePath
    }
  }, null, 2));
  const blendercamProofRun = spawnSync(process.env.PYTHON ?? "python", ["adapters/blendercam/blendercam_job.py", blendercamProofJobPath, blendercamProofResultPath], {
    cwd: root,
    env: {
      ...process.env,
      HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", blendercamProofRunnerPath])
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(blendercamProofRun.status === 0, `blendercam proof handoff exited ${blendercamProofRun.status}: ${blendercamProofRun.stderr || blendercamProofRun.stdout}`);
  const blendercamProofReport = JSON.parse(readFileSync(blendercamProofResultPath, "utf8"));
  validateReport("blendercam", blendercamProofReport);
  assert(blendercamProofReport.metrics.handoffEvidence.classification === "production-candidate", "blendercam proof-backed output should be production-candidate");
  assert(blendercamProofReport.metrics.handoffEvidence.productionCandidate === true, "blendercam proof-backed output should be production candidate");
  assert(blendercamProofReport.metrics.handoffEvidence.camOutputProof.gcodeSha256 === sha256(normalizedText(readFileSync(blendercamProofGcodePath, "utf8"))), "blendercam proof hash should bind current G-code");
  assert(blendercamProofReport.metrics.handoffEvidence.camOutputProof.jobId === "adapter-contract-test", "blendercam proof should bind current job id");
  assert(blendercamProofReport.metrics.handoffEvidence.camOutputProof.modelSha256 === sha256Bytes(readFileSync(blendercamExternalModelPath)), "blendercam proof should bind current model");
  assert(blendercamProofReport.metrics.handoffEvidence.camOutputProof.planSha256 === sha256Bytes(readFileSync(blendercamProofReport.metrics.blendercamPlan.planPath)), "blendercam proof should bind current CAM plan");

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

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedText(text) {
  return text.replace(/\r\n/g, "\n");
}

function writeExternalRunner(filePath, engine, withProof) {
  const schema = engine === "freecad" ? "hediao3d.freecad-cam-output-report.v1" : "hediao3d.blendercam-cam-output-report.v1";
  writeFileSync(filePath, `#!/usr/bin/env python3
import hashlib
import json
import sys
from pathlib import Path

job_path = Path(sys.argv[-3])
plan_path = Path(sys.argv[-2])
output_path = Path(sys.argv[-1])
job = json.loads(job_path.read_text(encoding="utf-8"))
model_path = Path(str(job.get("modelPath") or ""))
output_path.parent.mkdir(parents=True, exist_ok=True)
gcode = "\\n".join([
    "(HeDiao3D ${engine} proof contract)",
    f"(JOB_ID={job.get('jobId')})",
    "G21",
    "G90",
    "G0 X0.0000 Y0.0000 Z22.0000",
    "G1 X10.0000 Y0.0000 Z-0.4500 F180",
    "G1 X20.0000 Y1.0000 Z-0.6000 F180",
    "G0 Z22.0000",
    "M30",
    "",
])
output_path.write_text(gcode, encoding="utf-8")
if ${withProof ? "True" : "False"}:
    proof = {
        "schema": "${schema}",
        "engine": "${engine}",
        "jobId": job.get("jobId"),
        "gcodeSha256": hashlib.sha256(gcode.encode("utf-8")).hexdigest(),
        "modelSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "planSha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        "quality": {
            "productionCandidate": True,
            "postprocessEligible": True,
            "fixture": False,
            "previewScaffold": False
        }
    }
    Path(str(output_path) + ".cam-proof.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"ok": True, "engine": "${engine}", "proof": ${withProof ? "True" : "False"}}))
`);
}
