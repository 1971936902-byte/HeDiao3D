#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.env.V3_ADAPTER_VALIDATION_DIR ?? join(root, "public", "orchestrator-adapter-validation", stamp));
const useNativeCommands = isTrue(process.env.V3_ADAPTER_USE_NATIVE_COMMANDS);
const timeoutMs = Number(process.env.V3_ADAPTER_VALIDATION_TIMEOUT_MS ?? 120000);
const jsonOnly = process.argv.includes("--json-only");

const adapters = [
  {
    id: "freecad",
    script: "adapters/freecad/freecad_cam_job.py",
    defaultCommand: process.env.PYTHON ?? "python",
    nativeCommands: [process.env.V3_FREECAD_CMD, "FreeCADCmd", "freecadcmd", "FreeCAD", "freecad"].filter(Boolean),
    args: (script, jobPath, resultPath, commandMode) => [script, jobPath, resultPath],
    expectedPlan: {
      metricKey: "freecadPlan",
      files: ["freecad-cam-plan.json", "freecad-run-template.py"]
    }
  },
  {
    id: "blendercam",
    script: "adapters/blendercam/blendercam_job.py",
    defaultCommand: process.env.PYTHON ?? "python",
    nativeCommands: [process.env.V3_BLENDER_CMD, "blender"].filter(Boolean),
    args: (script, jobPath, resultPath, commandMode) => commandMode === "native"
      ? ["--background", "--python", script, "--", jobPath, resultPath]
      : [script, jobPath, resultPath],
    expectedPlan: {
      metricKey: "blendercamPlan",
      files: ["blendercam-cam-plan.json", "blendercam-run-template.py"]
    }
  },
  {
    id: "opencamlib",
    script: "adapters/opencamlib/opencamlib_job.py",
    defaultCommand: process.env.PYTHON ?? "python",
    nativeCommands: [process.env.V3_PYTHON_CMD, process.env.PYTHON, "python3", "python", "py"].filter(Boolean),
    args: (script, jobPath, resultPath) => [script, jobPath, resultPath],
    expectedPlan: {
      metricKey: "opencamlibPlan",
      files: ["opencamlib-kernel-plan.json", "opencamlib-run-template.py"]
    }
  },
  {
    id: "camotics",
    script: "adapters/camotics/camotics_job.js",
    defaultCommand: process.execPath,
    nativeCommands: [process.execPath],
    args: (script, jobPath, resultPath) => [script, jobPath, resultPath],
    expectedPlan: {
      metricKey: "camoticsPlan",
      files: ["camotics-simulation-plan.json", "camotics-project-template.json"]
    }
  }
];

mkdirSync(outputRoot, { recursive: true });

const results = adapters.map((adapter) => runAdapterValidation(adapter));
const summary = {
  schema: "hediao3d.external-adapter-validation.v1",
  createdAt: new Date().toISOString(),
  root,
  outputRoot,
  useNativeCommands,
  timeoutMs,
  overall: summarize(results),
  environment: {
    ENABLE_EXTERNAL_CAM_ADAPTERS: process.env.ENABLE_EXTERNAL_CAM_ADAPTERS ?? null,
    HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: process.env.HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN ?? null
  },
  adapters: results
};

writeFileSync(join(outputRoot, "v3-external-adapter-validation.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(outputRoot, "v3-external-adapter-validation.md"), createMarkdown(summary));
const consoleSummary = {
  ok: summary.overall.failed === 0,
  outputRoot,
  mode: useNativeCommands ? "native" : "safe-default",
  generatedPlans: summary.overall.generatedPlans,
  failed: summary.overall.failed,
  adapters: results.map((item) => ({
    id: item.id,
    status: item.report?.status ?? item.run.status,
    command: item.command,
    planGenerated: item.plan.generated,
      nativeSignals: item.nativeSignals
    }))
};
console.log(JSON.stringify(jsonOnly ? summary : consoleSummary, null, 2));

if (summary.overall.failed > 0 && isTrue(process.env.V3_ADAPTER_VALIDATION_STRICT)) {
  process.exitCode = 1;
}

function runAdapterValidation(adapter) {
  const workDir = join(outputRoot, adapter.id);
  mkdirSync(workDir, { recursive: true });
  const modelPath = join(workDir, "sample.glb");
  const jobPath = join(workDir, `${adapter.id}-job.json`);
  const resultPath = join(workDir, "adapter-report.json");
  writeFileSync(modelPath, "placeholder model for adapter validation");
  const job = createValidationJob(adapter.id, modelPath, workDir, resultPath);
  writeFileSync(jobPath, JSON.stringify(job, null, 2));

  const commandResolution = resolveAdapterCommand(adapter);
  if (!commandResolution.command) {
    return createMissingCommandResult(adapter, workDir, jobPath, resultPath, commandResolution);
  }

  const args = adapter.args(adapter.script, jobPath, resultPath, commandResolution.mode);
  const startedAt = Date.now();
  const run = spawnSync(commandResolution.command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    env: process.env
  });
  const durationMs = Date.now() - startedAt;
  const report = readReport(resultPath);
  const plan = inspectPlanArtifacts(adapter, workDir, report);
  const failed = Boolean(run.error) || (run.status !== 0 && run.status !== null) || !report || !plan.generated;

  return {
    id: adapter.id,
    workDir,
    jobPath,
    resultPath,
    command: commandResolution.command,
    commandMode: commandResolution.mode,
    commandArgs: args,
    run: {
      exitCode: run.status,
      error: run.error?.message ?? null,
      durationMs,
      stdout: String(run.stdout ?? "").slice(-6000),
      stderr: String(run.stderr ?? "").slice(-6000)
    },
    report,
    plan,
    nativeSignals: extractNativeSignals(adapter.id, report),
    failed,
    nextActions: createNextActions(adapter.id, report, plan, commandResolution.mode)
  };
}

function createValidationJob(engine, modelPath, workDir, resultPath) {
  return {
    jobId: `adapter-validation-${engine}`,
    engine,
    modelPath,
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
      gcode: join(workDir, "toolpath.nc"),
      report: resultPath,
      preview: join(workDir, "preview.json")
    },
    externalCamRecipe: {
      schema: "hediao3d.external-cam-recipe.v1",
      status: "ready-for-adapter",
      engine: {
        selectedEngine: engine,
        selectedEngineName: engine,
        engineFamily: `${engine}-validation`
      },
      model: {
        path: modelPath,
        policy: "adapter-validation-placeholder"
      },
      stock: {
        lengthMm: 38,
        diameterMm: 15,
        leftHoldMm: 2,
        rightHoldMm: 2
      },
      tool: {
        toolProfileId: "vflat-4mm-25deg",
        diameterMm: 4,
        description: "4mm 25deg flat-tip V-bit"
      },
      operations: [
        { id: "roughing", enabled: true, strategy: "unwrapped-x-scan-roughing", parameters: { maxCutDepthMm: 0.45 } },
        { id: "finishing", enabled: true, strategy: "x-scan", parameters: { stepoverMm: 0.28 } },
        { id: "rest-detail", enabled: true, strategy: "local-detail-pass-on-steep-features", parameters: { enabled: true } }
      ],
      postprocess: {
        camMode: "rotaryWrap",
        postProcessor: "wrapY",
        policy: "External CAM returns neutral/unwrapped path; HeDiao3D owns final rotary-wrap Y/A postprocess."
      },
      simulation: {
        required: true,
        preferredEngine: "camotics"
      }
    }
  };
}

function resolveAdapterCommand(adapter) {
  if (!useNativeCommands) {
    return { command: adapter.defaultCommand, mode: "safe-default", attempted: [adapter.defaultCommand] };
  }
  for (const command of adapter.nativeCommands) {
    if (!command) continue;
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3500
    });
    if (!probe.error || probe.status === 0) return { command, mode: "native", attempted: adapter.nativeCommands };
  }
  return { command: null, mode: "native", attempted: adapter.nativeCommands };
}

function createMissingCommandResult(adapter, workDir, jobPath, resultPath, commandResolution) {
  return {
    id: adapter.id,
    workDir,
    jobPath,
    resultPath,
    command: null,
    commandMode: commandResolution.mode,
    commandArgs: [],
    run: {
      exitCode: null,
      error: `No command found. Attempted: ${commandResolution.attempted.join(", ")}`,
      durationMs: 0,
      stdout: "",
      stderr: ""
    },
    report: null,
    plan: inspectPlanArtifacts(adapter, workDir, null),
    nativeSignals: {},
    failed: true,
    nextActions: [`Install or expose command for ${adapter.id}, then re-run npm run test:v3:external-adapters.`]
  };
}

function readReport(resultPath) {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
}

function inspectPlanArtifacts(adapter, workDir, report) {
  const expected = adapter.expectedPlan;
  const metric = report?.metrics?.[expected.metricKey] ?? null;
  const files = expected.files.map((filename) => {
    const path = join(workDir, filename);
    return {
      filename,
      path,
      exists: existsSync(path)
    };
  });
  return {
    metricKey: expected.metricKey,
    generated: files.every((file) => file.exists) && (metric?.status === "generated" || metric === null || typeof metric === "object"),
    metric,
    files
  };
}

function extractNativeSignals(id, report) {
  const metrics = report?.metrics ?? {};
  if (id === "freecad") {
    return {
      freecadPythonAvailable: metrics.freecad?.freecadPythonAvailable ?? null,
      pathWorkbenchAvailable: metrics.freecad?.pathWorkbenchAvailable ?? null
    };
  }
  if (id === "blendercam") {
    return {
      blenderPythonAvailable: metrics.blendercam?.blenderPythonAvailable ?? null,
      camAddonDetected: metrics.blendercam?.camAddonDetected ?? null
    };
  }
  if (id === "opencamlib") {
    return {
      available: metrics.opencamlib?.available ?? null,
      module: metrics.opencamlib?.module ?? null
    };
  }
  if (id === "camotics") {
    return {
      available: metrics.camotics?.available ?? null,
      command: metrics.camotics?.command ?? null
    };
  }
  return {};
}

function createNextActions(id, report, plan, commandMode) {
  const actions = [];
  if (!plan.generated) actions.push("Plan artifacts are missing; check adapter stderr and adapter-report.json.");
  if (!report) actions.push("Adapter report is missing or invalid JSON.");
  if (report?.status !== "completed") actions.push(report?.error ?? "Adapter did not produce completed output yet.");
  if (commandMode !== "native") actions.push("Re-run with V3_ADAPTER_USE_NATIVE_COMMANDS=true on the CAM server to test installed external software.");
  if (id === "freecad") actions.push("Validate freecad-cam-plan.json and freecad-run-template.py before enabling HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT.");
  if (id === "blendercam") actions.push("Validate Blender/FabexCNC add-on API before enabling HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT.");
  if (id === "opencamlib") actions.push("Validate neutral cutter-contact JSON handoff before enabling HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT.");
  if (id === "camotics") actions.push("Validate screenshot/material mesh extraction before enabling HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN.");
  return [...new Set(actions)];
}

function summarize(results) {
  return {
    adapterCount: results.length,
    failed: results.filter((item) => item.failed).length,
    generatedPlans: results.filter((item) => item.plan.generated).length,
    completedAdapters: results.filter((item) => item.report?.status === "completed").length,
    readyForProduction: false,
    note: "Plan generation is a deployment validation step. Production still requires completed adapter output plus HeDiao3D gates."
  };
}

function createMarkdown(summary) {
  const lines = [
    "# HeDiao3D V3 External Adapter Validation",
    "",
    `Created: ${summary.createdAt}`,
    `Mode: ${summary.useNativeCommands ? "native commands" : "safe default commands"}`,
    `Output: ${summary.outputRoot}`,
    "",
    "## Summary",
    "",
    `- Adapters: ${summary.overall.adapterCount}`,
    `- Generated plans: ${summary.overall.generatedPlans}`,
    `- Failed: ${summary.overall.failed}`,
    `- Completed external outputs: ${summary.overall.completedAdapters}`,
    `- Production ready: ${summary.overall.readyForProduction ? "yes" : "no"}`,
    "",
    "## Environment switches",
    "",
    ...Object.entries(summary.environment).map(([key, value]) => `- ${key}: ${value ?? "(unset)"}`),
    "",
    "## Adapters",
    ""
  ];
  for (const adapter of summary.adapters) {
    lines.push(
      `### ${adapter.id}`,
      "",
      `- Command: ${adapter.command ?? "(missing)"}`,
      `- Mode: ${adapter.commandMode}`,
      `- Exit: ${adapter.run.exitCode ?? "(none)"}`,
      `- Report status: ${adapter.report?.status ?? "(missing)"}`,
      `- Plan generated: ${adapter.plan.generated ? "yes" : "no"}`,
      `- Native signals: ${JSON.stringify(adapter.nativeSignals)}`,
      `- Work dir: ${adapter.workDir}`,
      "",
      "Plan files:",
      ...adapter.plan.files.map((file) => `- ${file.filename}: ${file.exists ? "ok" : "missing"}`),
      "",
      "Next actions:",
      ...adapter.nextActions.map((item) => `- ${item}`),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function isTrue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}
