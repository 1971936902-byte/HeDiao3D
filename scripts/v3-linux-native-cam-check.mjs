#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.env.V3_NATIVE_CAM_CHECK_DIR ?? join(root, "public", "native-cam-readiness", stamp));
const strict = process.argv.includes("--strict") || isTrue(process.env.V3_NATIVE_CAM_CHECK_STRICT);

mkdirSync(outputRoot, { recursive: true });

const checks = [
  checkFreeCad(),
  checkBlenderCam(),
  checkOpenCamLib(),
  checkCamotics()
];
const summary = createSummary(checks);
const targetMachineBoundary = createTargetMachineBoundary();
const report = {
  schema: "hediao3d.linux-native-cam-check.v1",
  createdAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    node: process.version
  },
  outputRoot,
  environment: {
    ENABLE_EXTERNAL_CAM_ADAPTERS: process.env.ENABLE_EXTERNAL_CAM_ADAPTERS ?? null,
    HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: process.env.HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT ?? null,
    HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: process.env.HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN ?? null,
    V3_FREECAD_CMD: process.env.V3_FREECAD_CMD ?? null,
    V3_BLENDER_CMD: process.env.V3_BLENDER_CMD ?? null,
    V3_PYTHON_CMD: process.env.V3_PYTHON_CMD ?? null
  },
  targetMachineBoundary,
  summary,
  checks
};
report.artifacts = writeNativeCamServerPackageArtifacts(report);

writeFileSync(join(outputRoot, "native-cam-readiness.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outputRoot, "native-cam-readiness.md"), createMarkdown(report));

console.log(JSON.stringify({
  ok: summary.level !== "missing" && summary.readyCount === summary.requiredCount,
  level: summary.level,
  ready: `${summary.readyCount}/${summary.requiredCount}`,
  outputRoot,
  blockers: summary.blockers,
  nextActions: summary.nextActions
}, null, 2));

if (strict && summary.readyCount < summary.requiredCount) {
  process.exitCode = 1;
}

function checkFreeCad() {
  const command = findWorkingCommand([
    process.env.V3_FREECAD_CMD,
    "FreeCADCmd",
    "freecadcmd",
    "freecad.cmd",
    "/snap/bin/freecad.cmd",
    "FreeCAD",
    "freecad"
  ].filter(Boolean), ["--version"]);
  const pythonProbe = command.command
    ? spawn(command.command, ["-c", "import Path; print('PATH_WORKBENCH_OK')"])
    : null;
  const pathWorkbenchAvailable = Boolean(pythonProbe && (pythonProbe.stdout.includes("PATH_WORKBENCH_OK") || pythonProbe.exitCode === 0));
  return createCheck({
    id: "freecad",
    name: "FreeCAD CAM",
    role: "三轴/规则实体 CAM 生成",
    requiredFor: ["3axis", "fixture", "regular-solid"],
    capabilities: createCapabilityProfile("freecad"),
    command,
    nativeSignals: {
      freecadCmdAvailable: Boolean(command.command),
      pathWorkbenchAvailable
    },
    ready: Boolean(command.command && pathWorkbenchAvailable),
    missing: [
      ...(!command.command ? ["FreeCADCmd/freecadcmd/freecad.cmd 命令不可用"] : []),
      ...(command.command && !pathWorkbenchAvailable ? ["FreeCAD Path/CAM Workbench Python 模块未通过探测"] : [])
    ],
    installHints: [
      "Ubuntu/Debian: sudo apt install freecad",
      "确认运行 Node API 的同一用户可以执行 FreeCADCmd --version、freecadcmd --version 或 freecad.cmd --version",
      "Path Workbench 未通过时，先在 FreeCAD GUI 中确认 CAM/Path 工作台可用，再回到服务用户环境复测"
    ]
  });
}

function checkBlenderCam() {
  const command = findWorkingCommand([process.env.V3_BLENDER_CMD, "blender"].filter(Boolean), ["--version"]);
  const addonProbe = command.command
    ? spawn(command.command, ["--background", "--python-expr", "import importlib.util as u\nmods=['cam','blendercam','fabex']\nprint('BLENDER_PYTHON_OK')\nprint('CAM_ADDON_OK' if any(u.find_spec(m) for m in mods) else 'CAM_ADDON_MISSING')"])
    : null;
  const blenderPythonAvailable = Boolean(addonProbe && addonProbe.stdout.includes("BLENDER_PYTHON_OK"));
  const camAddonDetected = Boolean(addonProbe && addonProbe.stdout.includes("CAM_ADDON_OK"));
  return createCheck({
    id: "blendercam",
    name: "BlenderCAM/FabexCNC",
    role: "Meshy 佛头/艺术曲面/旋转夹具展开刀路",
    requiredFor: ["rotaryWrap", "artistic-mesh", "relief"],
    capabilities: createCapabilityProfile("blendercam"),
    command,
    nativeSignals: {
      blenderAvailable: Boolean(command.command),
      blenderPythonAvailable,
      camAddonDetected
    },
    ready: Boolean(command.command && blenderPythonAvailable && camAddonDetected),
    missing: [
      ...(!command.command ? ["blender 命令不可用"] : []),
      ...(command.command && !blenderPythonAvailable ? ["Blender Python 后台执行未通过"] : []),
      ...(command.command && !camAddonDetected ? ["BlenderCAM/FabexCNC 插件未检测到"] : [])
    ],
    installHints: [
      "安装 Blender，并确认 blender --version 在服务用户 PATH 下可执行",
      "安装 BlenderCAM/FabexCNC 插件，优先用与服务器 Blender 版本匹配的插件版本",
      "插件安装后重新运行本脚本，直到 camAddonDetected=true"
    ]
  });
}

function checkOpenCamLib() {
  const python = findWorkingCommand([process.env.V3_PYTHON_CMD, process.env.PYTHON, "python3", "python"].filter(Boolean), ["--version"]);
  const probe = python.command
    ? spawn(python.command, ["-c", "import importlib.util as u; print('opencamlib=' + str(bool(u.find_spec('opencamlib')))); print('ocl=' + str(bool(u.find_spec('ocl'))))"])
    : null;
  const opencamlib = parseBooleanSignal(probe?.stdout, "opencamlib");
  const ocl = parseBooleanSignal(probe?.stdout, "ocl");
  return createCheck({
    id: "opencamlib",
    name: "OpenCAMLib",
    role: "drop-cutter、水线、刀具接触几何内核",
    requiredFor: ["rotaryWrap", "advanced-surface-cam"],
    capabilities: createCapabilityProfile("opencamlib"),
    command: python,
    nativeSignals: {
      pythonAvailable: Boolean(python.command),
      opencamlibModule: opencamlib,
      oclModule: ocl
    },
    ready: Boolean(python.command && (opencamlib || ocl)),
    missing: [
      ...(!python.command ? ["python3/python 命令不可用"] : []),
      ...(python.command && !opencamlib && !ocl ? ["opencamlib/ocl Python 模块不可用"] : [])
    ],
    installHints: [
      "优先在 Linux CAM 服务端安装 OpenCAMLib/ocl Python wrapper",
      "安装后确认 python -c \"import opencamlib\" 或 python -c \"import ocl\" 成功",
      "OpenCAMLib 是几何内核，仍需 HeDiao3D 后处理生成目标机床 NC"
    ]
  });
}

function checkCamotics() {
  const command = findWorkingCommand(["camotics-cli", "camotics"], ["--version"]);
  return createCheck({
    id: "camotics",
    name: "CAMotics",
    role: "G-code 材料去除仿真和空跑验证",
    requiredFor: ["simulation", "production-gate"],
    capabilities: createCapabilityProfile("camotics"),
    command,
    nativeSignals: {
      camoticsAvailable: Boolean(command.command)
    },
    ready: Boolean(command.command),
    missing: [
      ...(!command.command ? ["camotics-cli/camotics 命令不可用"] : [])
    ],
    installHints: [
      "安装 CAMotics，并确认 camotics-cli --version 或 camotics --version 可执行",
      "CAMotics 用于三轴/展开刀路材料去除仿真，不负责生成刀路",
      "旋转夹具真实材料去除仍需结合 HeDiao3D 自研旋转包裹预览和机床控制软件复核"
    ]
  });
}

function createCheck(input) {
  return {
    ...input,
    level: input.ready ? "ready" : input.command.command ? "partial" : "missing",
    command: input.command.command,
    version: input.command.version,
    attemptedCommands: input.command.attempted,
    missing: [...new Set(input.missing)]
  };
}

function createSummary(checks) {
  const readyCount = checks.filter((check) => check.ready).length;
  const requiredCount = checks.length;
  const blockers = checks.flatMap((check) => check.missing.map((item) => `${check.name}: ${item}`));
  const nextActions = checks
    .filter((check) => !check.ready)
    .flatMap((check) => check.installHints.slice(0, 2));
  if (!isTrue(process.env.ENABLE_EXTERNAL_CAM_ADAPTERS)) {
    nextActions.push("所有 Native 引擎验收通过后，再设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true 并重启 API。");
  }
  return {
    readyCount,
    requiredCount,
    level: readyCount === requiredCount ? "ready" : readyCount > 0 ? "partial" : "missing",
    summary: readyCount === requiredCount
      ? "Linux Native CAM 环境已具备 V3 外部 CAM/仿真验收条件。"
      : `Linux Native CAM 环境未完整就绪：${readyCount}/${requiredCount}。`,
    integrationStrategy: createOpenSourceCamIntegrationStrategy(),
    executionPlan: createOpenSourceCamExecutionPlan(checks),
    capabilityMatrix: createCapabilityMatrix(checks),
    blockers,
    nextActions: [...new Set(nextActions)]
  };
}

function createOpenSourceCamIntegrationStrategy() {
  return {
    schema: "hediao3d.opensource-cam-integration-strategy.v1",
    summary: "FreeCAD/BlenderCAM/OpenCAMLib/CAMotics 可以接入 HeDiao3D，但必须按“外部 CAM 生成中间结果，HeDiao3D 负责核雕后处理和生产门禁”的边界落地。",
    recommendedStack: [
      {
        id: "freecad",
        role: "standard-cam-generator",
        priority: "P0",
        purpose: "三轴浮雕、规则实体、夹具/治具和标准 G-code 参考路线。",
        handoff: "通过 FreeCADCmd 生成可审计 G-code 或 CAM plan；进入 Orchestrator 后继续做 NC 静态分析、CAMotics 仿真和 wrapY/wrapA 后处理复核。",
        limits: "不直接输出三轴控制器+Y旋转夹具的最终专用 NC。"
      },
      {
        id: "opencamlib",
        role: "surface-contact-kernel",
        priority: "P0",
        purpose: "复杂佛头 Mesh 的 drop-cutter、水线、刀具接触点和精加工刀位点。",
        handoff: "优先输出 hediao3d.neutral-toolpath.v1，中立点位再由 HeDiao3D 转成 Y/A 旋转夹具 NC。",
        limits: "不是完整 CAM 软件，不能替代装夹、后处理、仿真和机床验收。"
      },
      {
        id: "camotics",
        role: "material-removal-simulation",
        priority: "P0",
        purpose: "正式下载前做三轴/展开刀路材料去除仿真、Z 深度和边界复核。",
        handoff: "使用 camotics-preview.nc 和 camotics-project-template.json 运行，结果以 hediao3d.camotics-result.v1 回填并绑定输入 SHA-256。",
        limits: "CAMotics 不生成刀路，也不能完全替代真实旋转夹具机床空跑。"
      },
      {
        id: "blendercam",
        role: "artistic-mesh-cam",
        priority: "P1",
        purpose: "艺术 Mesh、佛头、浮雕纹理和 Blender 修模流程联动。",
        handoff: "通过 Blender 后台脚本生成 G-code/operation report，再进入统一安全门和后处理链路。",
        limits: "插件 API 和版本差异较大，必须在目标服务器验证后才能用于实验输出。"
      }
    ],
    rolloutStages: [
      "保留内置 Mesh CAM fallback，只作为 V3 小闭环和对照基线。",
      "先接 FreeCAD/OpenCAMLib 的计划产物和 adapter 合约，验证 Orchestrator 可摄取外部 G-code/neutral toolpath。",
      "在 Linux CAM 服务器安装 Native 引擎，运行 native-cam、external-adapters、neutral-handoff 和 camotics-import 测试。",
      "用真实佛头 STL/GLB 转换产物做小模型试算，人工复核刀路、仿真截图和材料去除网格。",
      "通过离料空跑、软料试雕、真实机床验收后，才允许生产门禁从 trial-only 逐步解锁。"
    ],
    productionBoundary: [
      "fixture、synthetic、heightfield preview 只能证明协议链路，不能作为生产证据。",
      "外部 CAM 的输出必须包含源码快照、输入模型哈希、刀具参数、坐标系和非 synthetic 仿真结果。",
      "三轴控制器+Y轴旋转夹具的最终 NC 永远由 HeDiao3D 后处理层负责，不能直接使用通用 CAM 默认后处理。"
    ]
  };
}

function createOpenSourceCamExecutionPlan(checks) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const stageDefinitions = [
    {
      id: "freecad-reference-cam",
      engineId: "freecad",
      title: "FreeCAD 标准三轴参考 CAM",
      phase: "external-cam-generator",
      priority: "P0",
      input: "repaired-model.stl 或 cam-input-plan.json 选中的 STL/STEP/OBJ",
      output: "adapter-report.json + G-code source snapshot",
      acceptance: "npm run test:v3:freecad-external-handoff",
      handoff: "Orchestrator 摄取 FreeCAD G-code，再执行 NC 静态分析、CAMotics 仿真和 HeDiao3D 专用后处理复核。",
      productionBoundary: "不能直接把 FreeCAD 默认后处理输出当成三轴控制器+Y旋转夹具最终 NC。"
    },
    {
      id: "opencamlib-neutral-core",
      engineId: "opencamlib",
      title: "OpenCAMLib 曲面接触与中立刀位点",
      phase: "geometry-kernel",
      priority: "P0",
      input: "修复后的佛头 STL/高度场采样 + 刀具几何参数",
      output: "hediao3d.neutral-toolpath.v1 + cutter-envelope/contact report",
      acceptance: "npm run test:v3:neutral-import && npm run test:v3:closed-neutral-handoff",
      handoff: "中立刀位点由 HeDiao3D 转换为 X+Z+Y/A 旋转夹具 NC。",
      productionBoundary: "preview/heightfield fixture 只能验协议，真实生产必须来自 OpenCAMLib/ocl 接触计算。"
    },
    {
      id: "camotics-material-removal",
      engineId: "camotics",
      title: "CAMotics 材料去除仿真",
      phase: "simulation",
      priority: "P0",
      input: "camotics-preview.nc + camotics-project-template.json + 当前 NC SHA-256",
      output: "hediao3d.camotics-result.v1 + screenshot/material-removal mesh",
      acceptance: "npm run test:v3:camotics-import && npm run test:v3:camotics-cli-package-api",
      handoff: "仿真结果回填 Orchestrator，进入 production-gate 和 evidence dossier。",
      productionBoundary: "CAMotics 不生成刀路；synthetic 结果永远不能解锁生产。"
    },
    {
      id: "blendercam-artistic-mesh",
      engineId: "blendercam",
      title: "BlenderCAM/Fabex 艺术 Mesh 候选刀路",
      phase: "artistic-cam-generator",
      priority: "P1",
      input: "Meshy/导入 GLB 转换后的 STL/OBJ + Blender 修模产物",
      output: "operation report + G-code source snapshot",
      acceptance: "npm run test:v3:blendercam-external-handoff",
      handoff: "作为复杂佛头 Mesh 的候选刀路，与 OpenCAMLib 中立刀位点互相对照。",
      productionBoundary: "插件版本和坐标系差异大，必须经过真实服务器验收和机床空跑。"
    }
  ];

  const stages = stageDefinitions.map((stage, index) => {
    const check = byId.get(stage.engineId);
    return {
      ...stage,
      order: index + 1,
      engineReady: Boolean(check?.ready),
      engineLevel: check?.level ?? "missing",
      command: check?.command ?? null,
      status: check?.ready ? "ready-to-validate-output" : check?.command ? "partial-native-env" : "missing-native-env",
      missing: Array.isArray(check?.missing) ? check.missing : [`${stage.engineId} readiness check missing`],
      evidence: [
        "native-cam-readiness.json",
        "v3-external-adapter-validation.json",
        "adapter-report.json",
        stage.output
      ]
    };
  });
  const readyStages = stages.filter((stage) => stage.engineReady).length;
  return {
    schema: "hediao3d.opensource-cam-execution-plan.v1",
    summary: `${readyStages}/${stages.length} 个开源 CAM/仿真阶段具备 Native 环境；生产仍需真实输出验收、仿真和机床验收。`,
    strategy: "外部 CAM 只负责生成可审计中间结果；HeDiao3D 负责三轴控制器+Y/A旋转夹具后处理、仿真回填和生产门禁。",
    readyStages,
    totalStages: stages.length,
    stages,
    globalAcceptanceCommands: [
      "npm run test:v3:native-cam",
      "npm run test:v3:freecad-proof-handoff",
      "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
      "bash native-cam-real-output-check.sh",
      "npm run test:v3:real-neutral-handoff",
      "npm run test:v3:camotics-import"
    ],
    productionLocks: [
      "没有 production-candidate handoffEvidence 时禁止生产 NC。",
      "没有非 synthetic CAMotics/等效材料去除仿真时禁止生产 NC。",
      "没有三轴控制器+Y/A旋转夹具空跑、软料试雕和现场验收时禁止生产 NC。"
    ]
  };
}

function createCapabilityProfile(id) {
  const profiles = {
    freecad: {
      category: "cam-generator",
      integrationRole: "外部三轴/规则实体 CAM 生成器，可作为标准 G-code 和后处理参考。",
      inputFormats: ["stl", "step", "iges", "obj"],
      outputFormats: ["gcode", "nc", "cam-plan"],
      supportedWorkflows: ["3axis-relief", "pocket", "profile", "surface-finishing", "postprocess-reference"],
      bestFor: ["规则几何", "三轴平面浮雕", "标准 CAM 工序验证"],
      notEnoughFor: ["直接生成三轴控制器+Y旋转夹具的最终专用 NC", "未验证夹具碰撞和核胚装夹"],
      projectUse: "Orchestrator 调用 FreeCADCmd 生成三轴参考刀路，再由 HeDiao3D 安全门和后处理层复核。",
      productionGate: "必须有非 synthetic G-code、CAMotics/等效仿真、空跑和试雕证据。"
    },
    blendercam: {
      category: "artistic-mesh-cam",
      integrationRole: "艺术 Mesh/浮雕 CAM 适配器，适合 Meshy 佛头等复杂曲面预处理。",
      inputFormats: ["stl", "obj", "glb-after-conversion"],
      outputFormats: ["gcode", "nc", "operation-report"],
      supportedWorkflows: ["artistic-relief", "mesh-surface-finishing", "rotary-wrap-reference"],
      bestFor: ["佛头/人物/纹理等艺术曲面", "网格雕刻策略研究", "与 Blender 修模流程联动"],
      notEnoughFor: ["未经插件 API 验证的无人值守生产", "真实 Y/A 旋转夹具后处理"],
      projectUse: "作为 Mesh 艺术刀路候选引擎，输出必须回到 neutral/G-code 摄取链路。",
      productionGate: "必须确认 BlenderCAM/FabexCNC 插件版本、输出坐标系、刀具补偿和机床后处理。"
    },
    opencamlib: {
      category: "geometry-kernel",
      integrationRole: "曲面刀具接触几何内核，用于 drop-cutter、水线和旋转展开高度场。",
      inputFormats: ["stl", "heightfield", "neutral-surface-samples"],
      outputFormats: ["neutral-toolpath", "contact-points", "cutter-envelope-report"],
      supportedWorkflows: ["drop-cutter", "waterline", "rotary-wrap-heightfield", "finishing-contact"],
      bestFor: ["精加工刀位点", "刀具半径包络", "自研 Y/A 旋转后处理前的中性刀路"],
      notEnoughFor: ["完整 CAM 软件 UI", "自动装夹避让", "未经后处理的机床 NC"],
      projectUse: "V3 的核心曲面计算层；输出 neutral toolpath，再交给 HeDiao3D wrapY/wrapA 后处理。",
      productionGate: "必须替换当前 preview scaffold 为真实 OpenCAMLib cutter-contact 输出，并通过材料去除仿真。"
    },
    camotics: {
      category: "simulation",
      integrationRole: "G-code 材料去除仿真和离料空跑验证，不生成刀路。",
      inputFormats: ["gcode", "nc", "camotics-project"],
      outputFormats: ["simulation-report", "material-removal-mesh", "bounds", "screenshot"],
      supportedWorkflows: ["3axis-simulation", "unwrapped-rotary-preview", "air-run-validation"],
      bestFor: ["三轴/展开刀路检查", "Z 深度和边界检查", "生产下载前证据"],
      notEnoughFor: ["完整连续四轴材料去除", "替代真实机床空跑", "刀路生成"],
      projectUse: "作为生产安全门的一项外部仿真证据，结果需与当前 camotics-preview.nc 哈希绑定。",
      productionGate: "必须导入非 synthetic 仿真结果，并匹配当前 NC 输入哈希。"
    }
  };
  return profiles[id] ?? {
    category: "unknown",
    integrationRole: "未知外部引擎。",
    inputFormats: [],
    outputFormats: [],
    supportedWorkflows: [],
    bestFor: [],
    notEnoughFor: ["未知能力，不能用于生产"],
    projectUse: "仅保留为占位。",
    productionGate: "不允许生产解锁。"
  };
}

function createCapabilityMatrix(checks) {
  return checks.map((check) => ({
    id: check.id,
    name: check.name,
    level: check.level,
    ready: check.ready,
    category: check.capabilities.category,
    integrationRole: check.capabilities.integrationRole,
    supportedWorkflows: check.capabilities.supportedWorkflows,
    outputFormats: check.capabilities.outputFormats,
    productionGate: check.capabilities.productionGate
  }));
}

function createTargetMachineBoundary() {
  return {
    schema: "hediao3d.target-machine-boundary.v1",
    controllerClass: "3axis-controller-with-rotary-fixture",
    machineProfileId: "desktop-3axis-rotary-y",
    camMode: "rotaryWrap",
    postProcessor: "wrapY",
    axisMapping: {
      X: "length-mm",
      Y: "rotary-fixture-linearized-angle-or-wrap-mm",
      Z: "tool-depth-and-safe-height"
    },
    rotaryOutputAxis: "Y",
    rotaryWrapPerRevolutionMm: 100,
    lengthAxis: "X",
    depthAxis: "Z",
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      angleDeg: 25,
      tip: "flat"
    },
    requiredPostprocessOwner: "HeDiao3D",
    forbiddenDirectOutputs: [
      "generic-freecad-postprocessor-as-final-machine-nc",
      "generic-blendercam-postprocessor-as-final-machine-nc",
      "unverified-a-axis-output-for-y-fixture"
    ],
    productionRule: "External CAM may produce G-code or neutral toolpath evidence, but final machine NC for this controller must pass HeDiao3D wrapY postprocess, NC static analysis, controller dialect checks, CAMotics/material-removal review, air-run, trial feedback and machine acceptance."
  };
}

function writeNativeCamServerPackageArtifacts(report) {
  const artifacts = {
    schema: "hediao3d.native-cam-server-package.v1",
    createdAt: report.createdAt,
    files: [
      {
        filename: "native-cam-server-bootstrap.sh",
        role: "linux-bootstrap-script",
        description: "Linux CAM 服务端安装/探测辅助脚本。默认 DRY_RUN=1，只打印命令；设置 DRY_RUN=0 才会执行安装命令。"
      },
      {
        filename: "native-cam-env.template",
        role: "environment-template",
        description: "HeDiao3D V3 外部 CAM adapter 环境变量模板。"
      },
      {
        filename: "native-cam-acceptance-checklist.md",
        role: "operator-checklist",
        description: "Linux CAM 服务器从安装、adapter 验证到小模型试算的验收清单。"
      },
      {
        filename: "native-cam-real-output-check.sh",
        role: "real-output-acceptance-script",
        description: "在 Linux CAM 服务端执行真实 adapter 输出验收，解析 handoffEvidence 并阻止 fixture/synthetic/preview 误入生产证据。"
      },
      {
        filename: "linux-cam-closed-loop-handoff.md",
        role: "closed-loop-operator-handoff",
        description: "一页式 Linux CAM 闭环交接说明：Native CAM 验收、真实输出 ZIP、CAMotics 结果 ZIP、V3 回填和 readiness 复核顺序。"
      }
    ],
    commands: [
      "bash native-cam-server-bootstrap.sh",
      "DRY_RUN=0 bash native-cam-server-bootstrap.sh",
      "cp native-cam-env.template .env.cam",
      "npm run test:v3:native-cam",
      "npm run test:v3:freecad-proof-handoff",
      "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
      "bash native-cam-real-output-check.sh",
      "npm run test:v3:readiness-api"
    ],
    productionBoundary: report.summary.integrationStrategy.productionBoundary,
    targetMachineBoundary: report.targetMachineBoundary
  };
  writeFileSync(join(outputRoot, "native-cam-server-bootstrap.sh"), createNativeCamBootstrapShell(report), { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(outputRoot, "native-cam-env.template"), createNativeCamEnvTemplate(report), "utf8");
  writeFileSync(join(outputRoot, "native-cam-acceptance-checklist.md"), createNativeCamAcceptanceChecklist(report), "utf8");
  writeFileSync(join(outputRoot, "native-cam-real-output-check.sh"), createNativeCamRealOutputCheckShell(report), { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(outputRoot, "linux-cam-closed-loop-handoff.md"), createLinuxCamClosedLoopHandoff(report), "utf8");
  writeFileSync(join(outputRoot, "native-cam-server-package.json"), JSON.stringify(artifacts, null, 2), "utf8");
  return artifacts;
}

function createLinuxCamClosedLoopHandoff(report) {
  const commandLines = [
    "bash native-cam-server-bootstrap.sh",
    "DRY_RUN=0 bash native-cam-server-bootstrap.sh",
    "cp native-cam-env.template .env.cam",
    "npm run test:v3:native-cam",
    "npm run test:v3:freecad-proof-handoff",
    "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
    "bash native-cam-real-output-check.sh",
    "上传 native-cam-real-output-bundle.zip 到 HeDiao3D V3 Native CAM 回填面板",
    "在当前 V3 job 下载 CAMotics Linux 仿真包并在 Linux 服务器执行",
    "上传 camotics-result-bundle.zip 到当前 V3 job 的 CAMotics 结果回填面板",
    "npm run test:v3:readiness-api",
    "完成离料空跑、软料试雕、trial feedback 和 machine acceptance 回填"
  ];
  const evidence = [
    "native-cam-readiness.json",
    "v3-external-adapter-validation.json",
    "native-cam-real-output-acceptance.json",
    "native-cam-real-output-bundle.zip",
    "camotics-cli-run-package.json",
    "camotics-result.json",
    "camotics-result-local-validation.json",
    "camotics-result-bundle.zip",
    "production-evidence-dossier.json",
    "next-action-checklist.md",
    "package-integrity.json",
    "trial-feedback-log.json",
    "machine-acceptance-log.json"
  ];
  return `# HeDiao3D V3 Linux CAM 闭环交接说明

Generated: ${report.createdAt}

这份文件给 Linux CAM 服务器操作者使用。它把 Native CAM、CAMotics、HeDiao3D V3 回填和总门禁复核串成同一条闭环。

## 1. 目标边界

- 目标机型：三轴控制器 + Y轴旋转夹具。
- X = 长度方向，Y = 旋转夹具等效行程/角度步进，Z = 刀深/安全高度。
- 外部 CAM 只负责产生可审计的 G-code 或 neutral toolpath 中间产物。
- HeDiao3D 仍负责 wrapY 后处理、证据档案、生产门禁和最终上机包。
- 这份交接说明本身不解锁生产 NC。

## 2. 顺序执行

${commandLines.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## 3. 必须保留的证据

${evidence.map((item) => `- [ ] \`${item}\``).join("\n")}

## 4. 上传回填规则

- Native CAM 真实输出验收完成后，上传 \`native-cam-real-output-bundle.zip\`。
- CAMotics 材料去除仿真完成后，上传 \`camotics-result-bundle.zip\`。
- 两个 ZIP 必须对应同一轮模型、同一套 CAM 输入和同一个 V3 job。
- 回填后重新生成 readiness，总门禁应能看到 \`nativeCamRealOutputAcceptance\` 和 \`readinessCamoticsEvidence\`。

## 5. 生产锁

正式生产包仍必须等待这些条件同时成立：

${report.summary.executionPlan.productionLocks.map((item) => `- ${item}`).join("\n")}

还必须补齐离料空跑、软料试雕、试雕反馈、机床验收，并且这些现场证据要和 \`package-integrity.json\` 中的同一组文件哈希匹配。

## 6. 失败时先看哪里

- Native CAM 验收失败：看 \`native-cam-readiness.json\` 和 \`v3-external-adapter-validation.json\`。
- 出现 fixture/synthetic/preview：关闭对应环境变量，重新跑真实外部命令。
- CAMotics 不被 readiness 接受：看 \`camotics-result-local-validation.json\`、输入 G-code SHA-256、motion profile 和截图/STL 证据。
- 生产包仍 423：这是预期安全行为，查看 \`production-evidence-dossier.json\` 和 \`next-action-checklist.md\` 的缺口。
`;
}

function createNativeCamBootstrapShell(report) {
  const missingIds = report.checks.filter((check) => !check.ready).map((check) => check.id);
  return `#!/usr/bin/env bash
set -euo pipefail

# HeDiao3D V3 Native CAM server bootstrap helper.
# Default is DRY_RUN=1 so this script prints commands without changing the server.
# Review every command before running: DRY_RUN=0 bash native-cam-server-bootstrap.sh

DRY_RUN="\${DRY_RUN:-1}"
SUDO="\${SUDO:-sudo}"
APT_PACKAGES=()

if [[ " ${missingIds.join(" ")} " == *" freecad "* ]]; then
  APT_PACKAGES+=(freecad)
fi
if [[ " ${missingIds.join(" ")} " == *" blendercam "* ]]; then
  APT_PACKAGES+=(blender)
fi
if [[ " ${missingIds.join(" ")} " == *" camotics "* ]]; then
  APT_PACKAGES+=(camotics)
fi
if [[ " ${missingIds.join(" ")} " == *" opencamlib "* ]]; then
  APT_PACKAGES+=(python3 python3-pip python3-venv)
fi

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" == "0" ]]; then
    "$@"
  fi
}

echo "[HeDiao3D] Native CAM bootstrap"
echo "[HeDiao3D] DRY_RUN=$DRY_RUN"
echo "[HeDiao3D] Missing engines at package time: ${missingIds.join(", ") || "none"}"

if command -v apt-get >/dev/null 2>&1 && [[ "\${#APT_PACKAGES[@]}" -gt 0 ]]; then
  run $SUDO apt-get update
  run $SUDO apt-get install -y "\${APT_PACKAGES[@]}"
else
  echo "[HeDiao3D] apt-get not available or no apt packages selected. Install missing engines manually for this distro."
fi

if [[ " ${missingIds.join(" ")} " == *" opencamlib "* ]]; then
  echo "[HeDiao3D] OpenCAMLib packaging differs by distro/Python. Try one of these after reviewing:"
  echo "+ python3 -m pip install --user opencamlib"
  echo "+ python3 -m pip install --user ocl"
  if [[ "$DRY_RUN" == "0" ]]; then
    python3 -m pip install --user opencamlib || python3 -m pip install --user ocl || true
  fi
fi

echo "[HeDiao3D] Version probes:"
for cmd in FreeCADCmd freecadcmd blender camotics-cli camotics python3; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "--- $cmd"
    "$cmd" --version 2>&1 | head -n 3 || true
  fi
done

echo "[HeDiao3D] OpenCAMLib module probe:"
python3 - <<'PY' || true
import importlib.util
print("opencamlib=", bool(importlib.util.find_spec("opencamlib")))
print("ocl=", bool(importlib.util.find_spec("ocl")))
PY

echo "[HeDiao3D] Next commands:"
echo "npm run test:v3:native-cam"
echo "npm run test:v3:freecad-proof-handoff"
echo "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters"
`;
}

function createNativeCamEnvTemplate(report) {
  return `# HeDiao3D V3 Native CAM environment template
# Generated: ${report.createdAt}
# Copy into your deployment .env only after reviewing every line.

ENABLE_EXTERNAL_CAM_ADAPTERS=false

# Keep experimental outputs disabled until native-cam readiness, adapter validation,
# CAMotics material-removal evidence, air-run, trial feedback and machine acceptance pass.
HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=false
HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=false

# External command examples. Prefer *_COMMAND_JSON to avoid shell quoting issues.
# HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON=["python","/opt/HeDiao3D/adapters/freecad/freecad_runner.py"]
# HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON=["blender","--background","--python","/opt/HeDiao3D/adapters/blendercam/blendercam_runner.py","--"]
# HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON=["python3","/opt/HeDiao3D/adapters/opencamlib/opencamlib_runner.py"]

HEDIAO3D_FREECAD_EXTERNAL_TIMEOUT_SEC=240
HEDIAO3D_BLENDERCAM_EXTERNAL_TIMEOUT_SEC=240
HEDIAO3D_OPENCAMLIB_EXTERNAL_TIMEOUT_SEC=240

# Fixture/synthetic switches are only for contract tests. They must stay false for production evidence.
HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT=false
HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT=false
HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT=false
HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW=false
HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT=false

# Real external result imports, if produced by validated wrappers:
# HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON=/absolute/path/to/neutral-toolpath.json
# HEDIAO3D_CAMOTICS_RESULT_JSON=/absolute/path/to/camotics-result.json
`;
}

function createNativeCamRealOutputCheckShell(report) {
  return `#!/usr/bin/env bash
set -euo pipefail

# HeDiao3D V3 real native CAM output acceptance.
# Run this on the Linux CAM server after installing FreeCAD/BlenderCAM/OpenCAMLib/CAMotics.
# It checks adapter handoffEvidence so fixture/synthetic/preview outputs cannot be mistaken for production CAM.

ROOT="\${ROOT:-$(pwd)}"
OUT_DIR="\${V3_ADAPTER_VALIDATION_DIR:-$ROOT/public/orchestrator-adapter-validation/native-real-output-$(date -u +%Y%m%dT%H%M%SZ)}"
STRICT="\${STRICT:-1}"
EXPECT_PRODUCTION_CANDIDATE="\${EXPECT_PRODUCTION_CANDIDATE:-1}"

echo "[HeDiao3D] Real native CAM output acceptance"
echo "[HeDiao3D] Root: $ROOT"
echo "[HeDiao3D] Output: $OUT_DIR"
echo "[HeDiao3D] Generated package time: ${report.createdAt}"

mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/target-machine-boundary.json" <<'JSON'
${JSON.stringify(report.targetMachineBoundary, null, 2)}
JSON

echo "[HeDiao3D] Step 1/3 native readiness"
npm run test:v3:native-cam

echo "[HeDiao3D] Step 2/3 proof-backed FreeCAD handoff"
npm run test:v3:freecad-proof-handoff

echo "[HeDiao3D] Step 3/3 external adapter validation with native commands"
V3_ADAPTER_USE_NATIVE_COMMANDS=true V3_ADAPTER_VALIDATION_DIR="$OUT_DIR" npm run test:v3:external-adapters

REPORT="$OUT_DIR/v3-external-adapter-validation.json"
ACCEPTANCE_REPORT="$OUT_DIR/native-cam-real-output-acceptance.json"
ACCEPTANCE_BUNDLE="$OUT_DIR/native-cam-real-output-bundle.zip"
TARGET_BOUNDARY="$OUT_DIR/target-machine-boundary.json"
if [[ ! -s "$REPORT" ]]; then
  echo "[HeDiao3D] Missing validation report: $REPORT" >&2
  exit 2
fi

node - "$REPORT" "$ACCEPTANCE_REPORT" "$STRICT" "$EXPECT_PRODUCTION_CANDIDATE" "$TARGET_BOUNDARY" <<'NODE'
const { readFileSync, writeFileSync } = require("fs");
const { createHash } = require("crypto");
const [reportPath, acceptancePath, strictValue, expectValue, targetBoundaryPath] = process.argv.slice(2);
const strict = /^(1|true|yes|on)$/i.test(strictValue || "");
const expectProductionCandidate = /^(1|true|yes|on)$/i.test(expectValue || "");
const reportBytes = readFileSync(reportPath);
const reportText = reportBytes.toString("utf8");
const report = JSON.parse(reportText);
const targetMachineBoundaryBytes = readFileSync(targetBoundaryPath);
const targetMachineBoundary = JSON.parse(targetMachineBoundaryBytes.toString("utf8"));
const adapters = Array.isArray(report.adapters) ? report.adapters : [];
const rows = adapters.map((adapter) => ({
  id: adapter.id,
  status: adapter.report?.status ?? adapter.run?.status ?? "missing",
  classification: adapter.handoffEvidence?.classification ?? "missing",
  productionCandidate: Boolean(adapter.handoffEvidence?.productionCandidate),
  fixture: Boolean(adapter.handoffEvidence?.fixture),
  synthetic: Boolean(adapter.handoffEvidence?.synthetic),
  previewScaffold: Boolean(adapter.handoffEvidence?.previewScaffold),
  generatedByExternalCommand: Boolean(adapter.handoffEvidence?.generatedByExternalCommand)
}));

const unsafe = rows.filter((row) =>
  row.fixture ||
  row.synthetic ||
  row.previewScaffold ||
  ["fixture-contract", "synthetic-contract", "preview-scaffold"].includes(row.classification)
);
const missing = rows.filter((row) => ["missing", "not-generated"].includes(row.classification));
const candidates = rows.filter((row) => row.productionCandidate && row.classification === "production-candidate");
const blockers = [
  ...unsafe.map((row) => row.id + " uses unsafe " + row.classification),
  ...(expectProductionCandidate && candidates.length === 0 ? ["no production-candidate adapter output found"] : [])
];
const warnings = missing.map((row) => row.id + " did not generate real output: " + row.classification);
const acceptance = {
  schema: "hediao3d.native-cam-real-output-acceptance.v1",
  createdAt: new Date().toISOString(),
  sourceReport: reportPath,
  sourceReportIdentity: {
    filename: "v3-external-adapter-validation.json",
    path: reportPath,
    sha256: createHash("sha256").update(reportBytes).digest("hex"),
    schema: report.schema || null,
    createdAt: report.createdAt || null
  },
  targetMachineBoundary,
  targetMachineBoundaryIdentity: {
    filename: "target-machine-boundary.json",
    path: targetBoundaryPath,
    sha256: createHash("sha256").update(targetMachineBoundaryBytes).digest("hex"),
    schema: targetMachineBoundary.schema || null,
    machineProfileId: targetMachineBoundary.machineProfileId || null,
    postProcessor: targetMachineBoundary.postProcessor || null
  },
  strict,
  expectProductionCandidate,
  level: blockers.length ? "critical" : warnings.length ? "review" : "ready",
  productionCandidateCount: candidates.length,
  unsafeCount: unsafe.length,
  missingCount: missing.length,
  adapters: rows,
  blockers,
  warnings,
  nextActions: blockers.length
    ? [
      "Disable fixture/synthetic/preview switches.",
      "Run real FreeCAD/BlenderCAM/OpenCAMLib commands until handoffEvidence.classification is production-candidate.",
      "Continue with CAMotics material-removal import, V3 readiness, air-run and machine acceptance only after this report is ready."
    ]
    : [
      "Import non-synthetic CAMotics material-removal result.",
      "Regenerate V3 readiness and complete air-run, trial feedback and machine acceptance."
    ]
};
writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2));
console.log(JSON.stringify(acceptance, null, 2));

if (unsafe.length) {
  console.error("[HeDiao3D] Unsafe fixture/synthetic/preview handoff detected:", unsafe.map((row) => row.id).join(", "));
}
if (expectProductionCandidate && candidates.length === 0) {
  console.error("[HeDiao3D] No production-candidate adapter output found.");
}
if (missing.length) {
  console.error("[HeDiao3D] Some adapters did not generate real output:", missing.map((row) => row.id + ":" + row.classification).join(", "));
}

if (strict && (unsafe.length || (expectProductionCandidate && candidates.length === 0))) {
  process.exit(3);
}
NODE

node - "$REPORT" "$ACCEPTANCE_REPORT" "$ACCEPTANCE_BUNDLE" "$TARGET_BOUNDARY" <<'NODE'
const { readFileSync, writeFileSync } = require("fs");
const [reportPath, acceptancePath, bundlePath, targetBoundaryPath] = process.argv.slice(2);
const files = [
  { name: "v3-external-adapter-validation.json", content: readFileSync(reportPath) },
  { name: "native-cam-real-output-acceptance.json", content: readFileSync(acceptancePath) },
  { name: "target-machine-boundary.json", content: readFileSync(targetBoundaryPath) },
  {
    name: "README-NATIVE-CAM-REAL-OUTPUT.md",
    content: Buffer.from([
      "# HeDiao3D Native CAM Real Output Bundle",
      "",
      "Upload this ZIP in the HeDiao3D V3 Native CAM real-output import panel.",
      "",
      "Included files:",
      "- native-cam-real-output-acceptance.json",
      "- v3-external-adapter-validation.json",
      "- target-machine-boundary.json",
      "",
      "Target machine boundary:",
      "- 3-axis controller + Y-axis rotary fixture",
      "- X=length, Y=rotary fixture linearized axis, Z=depth/safe height",
      "- Tool=4mm 25-degree flat-tip V cutter",
      "- Final machine NC must be produced/checked by HeDiao3D wrapY postprocess",
      "",
      "This bundle is evidence for readiness gates only. It does not unlock production NC by itself.",
      ""
    ].join("\\n"), "utf8")
  }
];
writeFileSync(bundlePath, createZip(files));
console.log("[HeDiao3D] Wrote real-output import bundle: " + bundlePath);

function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data
    ]);
    chunks.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]));
    offset += local.length;
  }
  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuffer.length), u32(centralOffset), u16(0)
  ]);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
NODE

echo "[HeDiao3D] Acceptance artifacts:"
echo "- $REPORT"
echo "- $OUT_DIR/v3-external-adapter-validation.md"
echo "- $ACCEPTANCE_REPORT"
echo "- $ACCEPTANCE_BUNDLE"
echo "[HeDiao3D] If this script exits 0 with production-candidate output, continue with CAMotics import, V3 readiness, air-run and machine acceptance."
`;
}

function createNativeCamAcceptanceChecklist(report) {
  const rows = report.checks.map((check) => `- [ ] ${check.name}: ${check.ready ? "已探测到，但仍需小模型验证" : check.missing.join("; ")}`);
  const executionRows = (report.summary.executionPlan?.stages ?? []).map((stage) => [
    `### ${stage.order}. ${stage.title}`,
    "",
    `- 状态: ${stage.status} / ${stage.engineLevel}`,
    `- 输入: ${stage.input}`,
    `- 输出: ${stage.output}`,
    `- 验收: \`${stage.acceptance}\``,
    `- 交接: ${stage.handoff}`,
    `- 生产边界: ${stage.productionBoundary}`
  ].join("\n"));
  return `# HeDiao3D V3 Native CAM Server Acceptance Checklist

Generated: ${report.createdAt}

## 1. Native Engine Install

${rows.join("\n")}

## 2. Required Commands

- [ ] \`npm run test:v3:native-cam\`
- [ ] \`npm run test:v3:freecad-proof-handoff\`
- [ ] \`V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters\`
- [ ] \`bash native-cam-real-output-check.sh\`
- [ ] \`npm run test:v3:freecad-external-handoff\` for 3-axis/regular-solid route
- [ ] \`npm run test:v3:closed-neutral-handoff\` for OpenCAMLib neutral route
- [ ] \`npm run test:v3:camotics-import\`
- [ ] \`npm run test:v3:readiness-api\`

## 3. Open Source CAM Execution Plan

${executionRows.length ? executionRows.join("\n\n") : "- Execution plan missing."}

## 4. Production Boundary

${report.summary.integrationStrategy.productionBoundary.map((item) => `- ${item}`).join("\n")}

## 5. Evidence To Keep

- [ ] \`native-cam-readiness.json\`
- [ ] \`v3-external-adapter-validation.json\`
- [ ] \`adapter-report.json\`
- [ ] \`freecad-cam-plan.json\` or \`opencamlib-kernel-plan.json\`
- [ ] \`native-cam-real-output-acceptance.json\`
- [ ] \`native-cam-real-output-bundle.zip\` uploaded back to HeDiao3D V3 Native CAM import panel
- [ ] \`neutral-toolpath.json\` or externally generated G-code source snapshot
- [ ] \`camotics-result.json\` with non-synthetic flag and matching input hash
- [ ] \`production-gate.json\`
- [ ] \`machine-acceptance-record.json\`

## 6. Final Rule

Do not enable production NC downloads merely because this checklist exists. Production release requires the V3 readiness report to prove non-synthetic CAM, real material-removal evidence, air-run, trial feedback and machine acceptance.
`;
}

function findWorkingCommand(commands, args) {
  const attempted = [];
  for (const command of commands) {
    attempted.push(command);
    const result = spawn(command, args);
    if (!result.error && result.exitCode === 0) {
      return {
        command,
        version: firstLine(result.stdout || result.stderr),
        attempted
      };
    }
  }
  return {
    command: null,
    version: null,
    attempted
  };
}

function spawn(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    env: process.env
  });
  return {
    exitCode: result.status,
    error: result.error?.message ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function parseBooleanSignal(text = "", key) {
  const match = text.match(new RegExp(`${key}=(true|false)`, "i"));
  return match ? match[1].toLowerCase() === "true" : false;
}

function createMarkdown(report) {
  const lines = [
    "# HeDiao3D V3 Linux Native CAM Readiness",
    "",
    `Created: ${report.createdAt}`,
    `Host: ${report.host.platform} ${report.host.release} ${report.host.arch}`,
    `Level: ${report.summary.level}`,
    `Ready: ${report.summary.readyCount}/${report.summary.requiredCount}`,
    "",
    "## Summary",
    "",
    report.summary.summary,
    "",
    "## Capability Matrix",
    "",
    ...report.summary.capabilityMatrix.flatMap((item) => [
      `- ${item.name}: ${item.level} / ${item.category}`,
      `  - role: ${item.integrationRole}`,
      `  - workflows: ${item.supportedWorkflows.join(", ")}`,
      `  - outputs: ${item.outputFormats.join(", ")}`,
      `  - production gate: ${item.productionGate}`
    ]),
    "",
    "## Integration Strategy",
    "",
    report.summary.integrationStrategy?.summary ?? "missing",
    "",
    ...((report.summary.integrationStrategy?.recommendedStack ?? []).flatMap((item) => [
      `- ${item.id}: ${item.priority} / ${item.role}`,
      `  - purpose: ${item.purpose}`,
      `  - handoff: ${item.handoff}`,
      `  - limits: ${item.limits}`
    ])),
    "",
    "Rollout stages:",
    ...((report.summary.integrationStrategy?.rolloutStages ?? []).map((item) => `- ${item}`)),
    "",
    "Production boundary:",
    ...((report.summary.integrationStrategy?.productionBoundary ?? []).map((item) => `- ${item}`)),
    "",
    "## Blockers",
    "",
    ...(report.summary.blockers.length ? report.summary.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Next Actions",
    "",
    ...report.summary.nextActions.map((item) => `- ${item}`),
    "",
    "## Checks",
    ""
  ];
  for (const check of report.checks) {
    lines.push(
      `### ${check.name}`,
      "",
      `- Level: ${check.level}`,
      `- Role: ${check.role}`,
      `- Category: ${check.capabilities.category}`,
      `- Command: ${check.command ?? "(missing)"}`,
      `- Version: ${check.version ?? "(unknown)"}`,
      `- Missing: ${check.missing.length ? check.missing.join("; ") : "none"}`,
      `- Signals: ${JSON.stringify(check.nativeSignals)}`,
      `- Inputs: ${check.capabilities.inputFormats.join(", ")}`,
      `- Outputs: ${check.capabilities.outputFormats.join(", ")}`,
      `- Best for: ${check.capabilities.bestFor.join("; ")}`,
      `- Not enough for: ${check.capabilities.notEnoughFor.join("; ")}`,
      `- Project use: ${check.capabilities.projectUse}`,
      "",
      "Install hints:",
      ...check.installHints.map((item) => `- ${item}`),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function isTrue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}
