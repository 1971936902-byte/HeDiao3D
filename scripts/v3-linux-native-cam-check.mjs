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
  summary,
  checks
};

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
  const command = findWorkingCommand([process.env.V3_FREECAD_CMD, "FreeCADCmd", "freecadcmd", "FreeCAD", "freecad"].filter(Boolean), ["--version"]);
  const pythonProbe = command.command
    ? spawn(command.command, ["--console", "-c", "import Path; print('PATH_WORKBENCH_OK')"])
    : null;
  const pathWorkbenchAvailable = Boolean(pythonProbe && (pythonProbe.stdout.includes("PATH_WORKBENCH_OK") || pythonProbe.exitCode === 0));
  return createCheck({
    id: "freecad",
    name: "FreeCAD CAM",
    role: "三轴/规则实体 CAM 生成",
    requiredFor: ["3axis", "fixture", "regular-solid"],
    command,
    nativeSignals: {
      freecadCmdAvailable: Boolean(command.command),
      pathWorkbenchAvailable
    },
    ready: Boolean(command.command && pathWorkbenchAvailable),
    missing: [
      ...(!command.command ? ["FreeCADCmd/freecadcmd 命令不可用"] : []),
      ...(command.command && !pathWorkbenchAvailable ? ["FreeCAD Path/CAM Workbench Python 模块未通过探测"] : [])
    ],
    installHints: [
      "Ubuntu/Debian: sudo apt install freecad",
      "确认运行 Node API 的同一用户可以执行 FreeCADCmd --version 或 freecadcmd --version",
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
    blockers,
    nextActions: [...new Set(nextActions)]
  };
}

function findWorkingCommand(commands, args) {
  const attempted = [];
  for (const command of commands) {
    attempted.push(command);
    const result = spawn(command, args);
    if (!result.error && (result.exitCode === 0 || result.stdout || result.stderr)) {
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
      `- Command: ${check.command ?? "(missing)"}`,
      `- Version: ${check.version ?? "(unknown)"}`,
      `- Missing: ${check.missing.length ? check.missing.join("; ") : "none"}`,
      `- Signals: ${JSON.stringify(check.nativeSignals)}`,
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
