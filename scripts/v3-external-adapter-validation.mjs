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
  nativeReadiness: createNativeReadiness(results),
  handoffClassificationAudit: createHandoffClassificationAudit(results),
  productionGuardrails: createProductionGuardrails(results),
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
    handoffClassification: item.handoffEvidence?.classification ?? "missing",
    productionCandidate: Boolean(item.handoffEvidence?.productionCandidate),
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
    handoffEvidence: extractHandoffEvidence(adapter.id, report),
    contactReport: summarizeAdapterContactReport(report),
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
    handoffEvidence: extractHandoffEvidence(adapter.id, null),
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

function extractHandoffEvidence(id, report) {
  const evidence = report?.metrics?.handoffEvidence;
  if (evidence?.schema === "hediao3d.adapter-handoff-evidence.v1") return evidence;
  return {
    schema: "hediao3d.adapter-handoff-evidence.v1",
    engine: id,
    outputKind: id === "opencamlib" ? "neutral-toolpath" : "gcode",
    classification: "missing",
    fixture: false,
    synthetic: false,
    previewScaffold: false,
    generatedByExternalCommand: false,
    productionCandidate: false,
    productionBoundary: "Adapter did not expose handoff evidence; production NC remains locked."
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
  const productionGuardrails = createProductionGuardrails(results);
  return {
    adapterCount: results.length,
    failed: results.filter((item) => item.failed).length,
    generatedPlans: results.filter((item) => item.plan.generated).length,
    completedAdapters: results.filter((item) => item.report?.status === "completed").length,
    readyForProduction: false,
    guardrailCount: productionGuardrails.required.length,
    note: "Plan generation is a deployment validation step. Production still requires completed adapter output plus HeDiao3D gates."
  };
}

function createProductionGuardrails(results) {
  const audit = createHandoffClassificationAudit(results);
  const required = [
    {
      id: "disable-fixtures",
      level: "critical",
      summary: "生产验收必须关闭所有 synthetic/fixture 输出开关。",
      envMustNotBeTrue: [
        "HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT",
        "HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT",
        "HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT",
        "HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT"
      ]
    },
    {
      id: "camotics-input-identity",
      level: "critical",
      summary: "CAMotics 真实结果必须带 inputs.preferredGcodeSha256，并与当前 camotics-preview.nc 哈希匹配。",
      evidence: ["camotics-result.json", "camotics-preview.nc", "simulation-summary.json"]
    },
    {
      id: "rotary-postprocess-owned-by-hediao3d",
      level: "critical",
      summary: "外部 CAM 输出必须是中立/展开刀位点或可摄取 G-code；三轴控制器 + Y轴旋转夹具最终 NC 仍由 HeDiao3D 后处理生成。",
      evidence: ["neutral-toolpath.json", "toolpath.nc", "postprocess-profile.json", "controller-dialect-report.json"]
    },
    {
      id: "field-acceptance-required",
      level: "critical",
      summary: "生产 NC 解锁必须同时具备旋转标定空跑、整条离料空跑、机床验收和试雕反馈记录。",
      evidence: ["rotary-calibration-airrun.nc", "air-run.nc", "machine-acceptance-log.json", "trial-feedback-log.json"]
    }
  ];
  const adapterStatuses = Object.fromEntries(results.map((item) => [item.id, item.report?.status ?? "missing"]));
  const handoffClassifications = Object.fromEntries(results.map((item) => [item.id, item.handoffEvidence?.classification ?? "missing"]));
  return {
    schema: "hediao3d.external-adapter-production-guardrails.v1",
    readyForProduction: false,
    summary: "Adapter 验证只证明计划和接口契约；生产仍需真实外部 CAM、匹配 G-code 的 CAMotics 材料去除结果和现场验收。",
    handoffClassificationAudit: {
      productionCandidateCount: audit.productionCandidateCount,
      unsafeCount: audit.unsafeCount,
      missingCount: audit.missingCount,
      summary: audit.summary
    },
    adapterStatuses,
    handoffClassifications,
    required,
    nextActions: [
      "在 CAM 服务器上运行 V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters。",
      "逐项关闭 fixture/synthetic 开关，只保留真实外部命令输出。",
      "运行 npm run test:v3:camotics-import，确认 CAMotics 结果与当前 camotics-preview.nc 哈希匹配。",
      "完成 rotary-calibration-airrun.nc、air-run.nc、机床验收和试雕反馈回填后再重新生成 V3 readiness。"
    ]
  };
}

function createHandoffClassificationAudit(results) {
  const adapters = results.map((item) => {
    const evidence = item.handoffEvidence ?? {};
    const contactReport = summarizeAdapterContactReport(item.report);
    const classification = evidence.classification ?? "missing";
    const fixture = Boolean(evidence.fixture) || classification === "fixture-contract";
    const synthetic = Boolean(evidence.synthetic) || classification === "synthetic-contract";
    const previewScaffold = Boolean(evidence.previewScaffold) || /preview|scaffold/i.test(classification);
    const productionCandidate = Boolean(evidence.productionCandidate) && classification === "production-candidate" && !fixture && !synthetic && !previewScaffold;
    const missingCamProof = classification === "missing-cam-proof";
    const camProofReview = classification === "cam-proof-review";
    const missing = classification === "missing";
    const notGenerated = classification === "not-generated";
    const unsafe = !productionCandidate;
    return {
      id: item.id,
      status: item.report?.status ?? item.run?.status ?? "missing",
      outputKind: evidence.outputKind ?? (item.id === "opencamlib" ? "neutral-toolpath" : "gcode"),
      classification,
      productionCandidate,
      fixture,
      synthetic,
      previewScaffold,
      missingCamProof,
      camProofReview,
      missing,
      notGenerated,
      unsafe,
      generatedByExternalCommand: Boolean(evidence.generatedByExternalCommand),
      contactReport
    };
  });
  const productionCandidateCount = adapters.filter((adapter) => adapter.productionCandidate).length;
  const unsafeCount = adapters.filter((adapter) => adapter.unsafe).length;
  const missingCount = adapters.filter((adapter) => adapter.missing).length;
  const fixtureCount = adapters.filter((adapter) => adapter.fixture).length;
  const syntheticCount = adapters.filter((adapter) => adapter.synthetic).length;
  const previewScaffoldCount = adapters.filter((adapter) => adapter.previewScaffold).length;
  const missingCamProofCount = adapters.filter((adapter) => adapter.missingCamProof).length;
  const camProofReviewCount = adapters.filter((adapter) => adapter.camProofReview).length;
  const notGeneratedCount = adapters.filter((adapter) => adapter.notGenerated).length;
  const contactReportBindingCounts = createContactReportBindingCounts(adapters);
  const unboundProductionCandidateCount = adapters.filter((adapter) => adapter.productionCandidate && adapter.contactReport?.inputBindingStatus !== "bound").length;
  const blockers = [
    ...(missingCount ? [`${missingCount} 个 adapter 缺少 handoff evidence。`] : []),
    ...(notGeneratedCount ? [`${notGeneratedCount} 个 adapter 尚未生成外部 handoff 输出。`] : []),
    ...(fixtureCount ? [`${fixtureCount} 个 adapter 输出为 fixture-contract。`] : []),
    ...(syntheticCount ? [`${syntheticCount} 个 adapter 输出为 synthetic-contract。`] : []),
    ...(previewScaffoldCount ? [`${previewScaffoldCount} 个 adapter 输出为 preview/scaffold。`] : []),
    ...(missingCamProofCount ? [`${missingCamProofCount} 个 adapter 缺少 CAM 输出证明。`] : []),
    ...(camProofReviewCount ? [`${camProofReviewCount} 个 adapter 的 CAM 输出证明需要复核。`] : []),
    ...(unboundProductionCandidateCount ? [`${unboundProductionCandidateCount} 个 production-candidate contact report 未绑定输入哈希。`] : [])
  ];
  return {
    schema: "hediao3d.adapter-handoff-classification-audit.v1",
    readyForProduction: false,
    productionCandidateCount,
    unsafeCount,
    missingCount,
    fixtureCount,
    syntheticCount,
    previewScaffoldCount,
    missingCamProofCount,
    camProofReviewCount,
    notGeneratedCount,
    contactReportBindingCounts,
    unboundProductionCandidateCount,
    summary: productionCandidateCount > 0 && unsafeCount === 0
      ? "Adapter 输出分类看起来可进入下一步生产证据链，但仍需 CAMotics、空跑和机床验收。"
      : `Adapter 输出分类未达到生产候选：productionCandidate=${productionCandidateCount}，unsafe=${unsafeCount}，missing=${missingCount}。`,
    blockers,
    nextActions: [
      "确认每个 adapter-report.json 都包含 hediao3d.adapter-handoff-evidence.v1。",
      "关闭 fixture/synthetic/preview scaffold 输出后重新运行外部 adapter validation。",
      "只有 production-candidate 输出才允许进入后续 CAMotics 材料去除和机床验收链路。"
    ],
    adapters
  };
}

function createContactReportBindingCounts(adapters) {
  const counts = {
    bound: 0,
    missing: 0,
    mismatch: 0,
    review: 0,
    notChecked: 0,
    other: 0
  };
  for (const adapter of adapters) {
    const status = adapter.contactReport?.inputBindingStatus ?? "missing";
    if (status === "bound") counts.bound += 1;
    else if (status === "missing") counts.missing += 1;
    else if (status === "mismatch") counts.mismatch += 1;
    else if (status === "review") counts.review += 1;
    else if (status === "not-checked") counts.notChecked += 1;
    else counts.other += 1;
  }
  return counts;
}

function summarizeAdapterContactReport(report) {
  const contact = report?.metrics?.neutralToolpath?.cutterContactReport;
  if (!contact || typeof contact !== "object") {
    return {
      status: "missing",
      productionCandidate: false,
      inputBindingStatus: "missing",
      reportSchema: null,
      summary: "No cutter-contact report was exposed by this adapter."
    };
  }
  return {
    status: contact.status ?? "unknown",
    productionCandidate: Boolean(contact.productionCandidate),
    inputBindingStatus: contact.inputIdentityBinding?.status ?? "missing",
    reportSchema: contact.reportSchema ?? null,
    summary: contact.summary ?? ""
  };
}

function createNativeReadiness(results) {
  const adapters = results.map((adapter) => {
    const readiness = evaluateAdapterNativeReadiness(adapter.id, adapter.nativeSignals);
    return {
      id: adapter.id,
      ready: readiness.ready,
      level: readiness.ready ? "ready" : adapter.commandMode === "native" && adapter.command ? "partial" : "missing",
      command: adapter.command,
      commandMode: adapter.commandMode,
      signals: adapter.nativeSignals,
      missing: readiness.missing
    };
  });
  const readyCount = adapters.filter((adapter) => adapter.ready).length;
  const blockers = adapters
    .filter((adapter) => !adapter.ready)
    .flatMap((adapter) => adapter.missing.map((item) => `${adapter.id}: ${item}`));
  return {
    schema: "hediao3d.native-cam-readiness.v1",
    mode: useNativeCommands ? "native" : "safe-default",
    readyCount,
    requiredCount: adapters.length,
    level: readyCount === adapters.length ? "ready" : readyCount > 0 ? "partial" : "missing",
    summary: readyCount === adapters.length
      ? "外部 CAM Native 环境已具备完整执行信号。"
      : `外部 CAM Native 环境未完整就绪：${readyCount}/${adapters.length} 个引擎具备执行信号。`,
    blockers,
    nextActions: createNativeReadinessActions(adapters),
    adapters
  };
}

function evaluateAdapterNativeReadiness(id, signals = {}) {
  if (id === "freecad") {
    const missing = [];
    if (!signals.freecadPythonAvailable) missing.push("FreeCAD Python/Cmd 不可用");
    if (!signals.pathWorkbenchAvailable) missing.push("FreeCAD Path/CAM Workbench 不可用");
    return { ready: missing.length === 0, missing };
  }
  if (id === "blendercam") {
    const missing = [];
    if (!signals.blenderPythonAvailable) missing.push("Blender Python 不可用");
    if (!signals.camAddonDetected) missing.push("BlenderCAM/FabexCNC 插件未检测到");
    return { ready: missing.length === 0, missing };
  }
  if (id === "opencamlib") {
    const missing = signals.available ? [] : ["OpenCAMLib/ocl Python 模块不可用"];
    return { ready: missing.length === 0, missing };
  }
  if (id === "camotics") {
    const missing = signals.available ? [] : ["CAMotics CLI 不可用"];
    return { ready: missing.length === 0, missing };
  }
  return { ready: false, missing: ["未知 Adapter 类型"] };
}

function createNativeReadinessActions(adapters) {
  const actions = [];
  if (!useNativeCommands) actions.push("在 CAM 服务器上设置 V3_ADAPTER_USE_NATIVE_COMMANDS=true 重新执行 Native 预检。");
  if (adapters.some((adapter) => adapter.id === "freecad" && !adapter.ready)) actions.push("安装 FreeCAD 并确认 FreeCADCmd/Path Workbench 可在服务账号下运行。");
  if (adapters.some((adapter) => adapter.id === "blendercam" && !adapter.ready)) actions.push("安装 Blender 与 BlenderCAM/FabexCNC 插件，用于艺术 Mesh 曲面刀路。");
  if (adapters.some((adapter) => adapter.id === "opencamlib" && !adapter.ready)) actions.push("在 Python 环境安装 OpenCAMLib/ocl，用于 drop-cutter 与曲面刀位计算。");
  if (adapters.some((adapter) => adapter.id === "camotics" && !adapter.ready)) actions.push("安装 CAMotics CLI，用于 NC 材料去除仿真与空跑验证。");
  if (actions.length === 0) actions.push("Native 预检通过后，再逐项打开实验开关验证真实 G-code/仿真输出。");
  return [...new Set(actions)];
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
    `- Native readiness: ${summary.nativeReadiness.readyCount}/${summary.nativeReadiness.requiredCount} (${summary.nativeReadiness.level})`,
    `- Handoff audit: productionCandidate=${summary.handoffClassificationAudit.productionCandidateCount}, unsafe=${summary.handoffClassificationAudit.unsafeCount}, missing=${summary.handoffClassificationAudit.missingCount}`,
    `- Guardrails: ${summary.productionGuardrails.required.length} required / production ready ${summary.productionGuardrails.readyForProduction ? "yes" : "no"}`,
    "",
    "## Environment switches",
    "",
    ...Object.entries(summary.environment).map(([key, value]) => `- ${key}: ${value ?? "(unset)"}`),
    "",
    "## Native readiness",
    "",
    summary.nativeReadiness.summary,
    "",
    "Blockers:",
    ...(summary.nativeReadiness.blockers.length ? summary.nativeReadiness.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Next actions:",
    ...summary.nativeReadiness.nextActions.map((item) => `- ${item}`),
    "",
    "## Handoff classification audit",
    "",
    summary.handoffClassificationAudit.summary,
    "",
    "Adapters:",
    ...summary.handoffClassificationAudit.adapters.map((adapter) => `- ${adapter.id}: ${adapter.classification} / productionCandidate=${adapter.productionCandidate} / unsafe=${adapter.unsafe} / contact=${adapter.contactReport?.status ?? "missing"} / binding=${adapter.contactReport?.inputBindingStatus ?? "missing"}`),
    "",
    "Audit next actions:",
    ...summary.handoffClassificationAudit.nextActions.map((item) => `- ${item}`),
    "",
    "## Production guardrails",
    "",
    summary.productionGuardrails.summary,
    "",
    ...summary.productionGuardrails.required.flatMap((guardrail) => [
      `- ${guardrail.id}: ${guardrail.summary}`,
      ...(guardrail.envMustNotBeTrue ? [`  - env must not be true: ${guardrail.envMustNotBeTrue.join(", ")}`] : []),
      ...(guardrail.evidence ? [`  - evidence: ${guardrail.evidence.join(", ")}`] : [])
    ]),
    "",
    "Guardrail next actions:",
    ...summary.productionGuardrails.nextActions.map((item) => `- ${item}`),
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
      `- Handoff classification: ${adapter.handoffEvidence?.classification ?? "missing"}`,
      `- Production candidate: ${adapter.handoffEvidence?.productionCandidate ? "yes" : "no"}`,
      `- Contact report: ${adapter.contactReport?.status ?? "(missing)"} / binding=${adapter.contactReport?.inputBindingStatus ?? "missing"}`,
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
