import type { GeneratedToolpath, ModelSettings } from "./types";

export type ToolProfile = {
  id: string;
  name: string;
  type: "ball" | "flat" | "taper" | "v-bit" | "micro";
  diameterMm: number;
  tipRadiusMm: number;
  flatTipMm?: number;
  fluteLengthMm: number;
  angleDeg?: number;
  stickoutMm: number;
  recommendedRpm: number;
  recommendedFeed: number;
  recommendedStepoverMm: number;
  maxCutDepthMm: number;
  stockAllowanceMm: number;
  notes: string;
};

export type MaterialProfile = {
  id: string;
  name: string;
  density: "soft" | "medium" | "hard";
  spindleRpm: number;
  roughFeed: number;
  finishFeed: number;
  maxCutDepthMm: number;
  minWallMm: number;
  notes: string;
};

export type MachineProfile = {
  id: string;
  name: string;
  axes: "3axis" | "4axis";
  controller: "generic" | "weihong" | "syntec";
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  aMin: number;
  aMax: number;
  safeZ: number;
  maxFeed: number;
  maxRpm: number;
  aDirection: "normal" | "reversed";
  notes: string;
};

export type SafetyIssue = {
  level: "ok" | "warning" | "critical";
  title: string;
  detail: string;
  line?: number;
  command?: string;
};

export type ProcessTemplate = {
  id: string;
  name: string;
  intent: string;
  toolProfileId: string;
  materialProfileId: string;
  maxCutDepth: number;
  stockAllowance: number;
  stepoverMm: number;
  stepoverDeg: number;
  feedRate: number;
  spindleRpm: number;
  finishingStrategy: ModelSettings["finishingStrategy"];
  notes: string;
};

export const toolProfiles: ToolProfile[] = [
  {
    id: "ball-0.6",
    name: "0.6mm 球刀 - 通用精雕",
    type: "ball",
    diameterMm: 0.6,
    tipRadiusMm: 0.3,
    fluteLengthMm: 4,
    stickoutMm: 8,
    recommendedRpm: 12000,
    recommendedFeed: 160,
    recommendedStepoverMm: 0.1,
    maxCutDepthMm: 0.18,
    stockAllowanceMm: 0.12,
    notes: "适合核雕细节粗精一体试雕。"
  },
  {
    id: "ball-0.3",
    name: "0.3mm 球刀 - 高精细纹理",
    type: "ball",
    diameterMm: 0.3,
    tipRadiusMm: 0.15,
    fluteLengthMm: 2.5,
    stickoutMm: 6,
    recommendedRpm: 16000,
    recommendedFeed: 90,
    recommendedStepoverMm: 0.045,
    maxCutDepthMm: 0.08,
    stockAllowanceMm: 0.06,
    notes: "用于佛头五官、衣纹等精修，进给需保守。"
  },
  {
    id: "flat-1.0",
    name: "1.0mm 平刀 - 快速开粗",
    type: "flat",
    diameterMm: 1,
    tipRadiusMm: 0,
    fluteLengthMm: 5,
    stickoutMm: 9,
    recommendedRpm: 10000,
    recommendedFeed: 220,
    recommendedStepoverMm: 0.28,
    maxCutDepthMm: 0.25,
    stockAllowanceMm: 0.18,
    notes: "用于粗加工去料，后续需要球刀精修。"
  },
  {
    id: "vflat-4mm-25deg",
    name: "4mm 25° 平底尖刀 - 三轴浮雕",
    type: "v-bit",
    diameterMm: 4,
    tipRadiusMm: 0.2,
    flatTipMm: 0.4,
    fluteLengthMm: 12,
    angleDeg: 25,
    stickoutMm: 18,
    recommendedRpm: 12000,
    recommendedFeed: 450,
    recommendedStepoverMm: 0.28,
    maxCutDepthMm: 0.45,
    stockAllowanceMm: 0.08,
    notes: "4mm 刃径、25° 夹角、约 0.4mm 平底尖端；适合三轴平面浮雕、牌匾和较大核雕素材试雕，下刀需保守。"
  },
  {
    id: "taper-0.2",
    name: "0.2mm 锥刀 - 微细线条",
    type: "taper",
    diameterMm: 0.2,
    tipRadiusMm: 0.1,
    fluteLengthMm: 2,
    angleDeg: 20,
    stickoutMm: 5,
    recommendedRpm: 18000,
    recommendedFeed: 55,
    recommendedStepoverMm: 0.025,
    maxCutDepthMm: 0.04,
    stockAllowanceMm: 0.03,
    notes: "仅建议用于最终浅层纹理。"
  }
];

export const materialProfiles: MaterialProfile[] = [
  {
    id: "olive-core",
    name: "橄榄核",
    density: "hard",
    spindleRpm: 13000,
    roughFeed: 150,
    finishFeed: 95,
    maxCutDepthMm: 0.16,
    minWallMm: 0.8,
    notes: "硬度较高且形体小，建议小切深多遍加工。"
  },
  {
    id: "peach-core",
    name: "桃核",
    density: "medium",
    spindleRpm: 11500,
    roughFeed: 180,
    finishFeed: 115,
    maxCutDepthMm: 0.2,
    minWallMm: 1,
    notes: "纹理不均，首刀建议低进给。"
  },
  {
    id: "ivory-nut",
    name: "象牙果",
    density: "medium",
    spindleRpm: 14000,
    roughFeed: 170,
    finishFeed: 120,
    maxCutDepthMm: 0.18,
    minWallMm: 0.9,
    notes: "材质较均匀，适合验证细节。"
  },
  {
    id: "resin-test",
    name: "树脂测试料",
    density: "soft",
    spindleRpm: 9000,
    roughFeed: 260,
    finishFeed: 180,
    maxCutDepthMm: 0.3,
    minWallMm: 0.6,
    notes: "适合低成本验证刀路方向和夹持。"
  }
];

export const machineProfiles: MachineProfile[] = [
  {
    id: "desktop-4axis-generic",
    name: "桌面四轴雕刻机 - 通用",
    axes: "4axis",
    controller: "generic",
    xMin: -45,
    xMax: 45,
    yMin: -20,
    yMax: 20,
    zMin: 0,
    zMax: 35,
    aMin: -9999,
    aMax: 9999,
    safeZ: 22,
    maxFeed: 500,
    maxRpm: 18000,
    aDirection: "normal",
    notes: "保守通用配置，适合首次空跑。"
  },
  {
    id: "weihong-4axis-small",
    name: "维宏小型四轴",
    axes: "4axis",
    controller: "weihong",
    xMin: -55,
    xMax: 55,
    yMin: -25,
    yMax: 25,
    zMin: 0,
    zMax: 40,
    aMin: -9999,
    aMax: 9999,
    safeZ: 24,
    maxFeed: 600,
    maxRpm: 24000,
    aDirection: "normal",
    notes: "维宏风格后处理，导出前仍需按实机行程校准。"
  },
  {
    id: "syntec-4axis-small",
    name: "新代小型四轴",
    axes: "4axis",
    controller: "syntec",
    xMin: -60,
    xMax: 60,
    yMin: -30,
    yMax: 30,
    zMin: 0,
    zMax: 45,
    aMin: -9999,
    aMax: 9999,
    safeZ: 25,
    maxFeed: 700,
    maxRpm: 24000,
    aDirection: "normal",
    notes: "新代风格后处理，适合带完整安全段的程序。"
  },
  {
    id: "desktop-3axis-generic",
    name: "桌面三轴雕刻机 - 通用",
    axes: "3axis",
    controller: "generic",
    xMin: -80,
    xMax: 80,
    yMin: -60,
    yMax: 60,
    zMin: -20,
    zMax: 45,
    aMin: 0,
    aMax: 0,
    safeZ: 12,
    maxFeed: 1200,
    maxRpm: 24000,
    aDirection: "normal",
    notes: "三轴 X/Y/Z 平面浮雕配置，不输出 A 轴；首次上机请重新确认工件原点和安全高度。"
  },
  {
    id: "desktop-3axis-rotary-y",
    name: "三轴控制器 + Y轴旋转夹具",
    axes: "3axis",
    controller: "generic",
    xMin: -80,
    xMax: 80,
    yMin: -120,
    yMax: 120,
    zMin: -20,
    zMax: 45,
    aMin: 0,
    aMax: 0,
    safeZ: 16,
    maxFeed: 900,
    maxRpm: 24000,
    aDirection: "normal",
    notes: "X 走核雕长度，Z 控制刀深，Y 轴线性位移映射夹具旋转；适合一行一行展开雕刻。"
  }
];

export const processTemplates: ProcessTemplate[] = [
  {
    id: "first-safe-cut",
    name: "低风险首刀",
    intent: "首次上机空跑/浅雕验证方向",
    toolProfileId: "ball-0.6",
    materialProfileId: "olive-core",
    maxCutDepth: 0.08,
    stockAllowance: 0.18,
    stepoverMm: 0.16,
    stepoverDeg: 1.8,
    feedRate: 90,
    spindleRpm: 12000,
    finishingStrategy: "x-scan",
    notes: "优先安全，时间较长但切削负担低。"
  },
  {
    id: "quick-test",
    name: "快速试雕",
    intent: "快速验证图案方向和整体比例",
    toolProfileId: "flat-1.0",
    materialProfileId: "resin-test",
    maxCutDepth: 0.24,
    stockAllowance: 0.18,
    stepoverMm: 0.28,
    stepoverDeg: 2.4,
    feedRate: 240,
    spindleRpm: 9000,
    finishingStrategy: "x-scan",
    notes: "适合树脂或废料验证，不建议直接用于橄榄核成品。"
  },
  {
    id: "standard-olive",
    name: "标准核雕",
    intent: "橄榄核常规粗精加工",
    toolProfileId: "ball-0.6",
    materialProfileId: "olive-core",
    maxCutDepth: 0.16,
    stockAllowance: 0.12,
    stepoverMm: 0.1,
    stepoverDeg: 1.2,
    feedRate: 150,
    spindleRpm: 13000,
    finishingStrategy: "x-scan",
    notes: "平衡时间、细节和上机风险。"
  },
  {
    id: "fine-detail",
    name: "高精细雕刻",
    intent: "佛头五官、衣纹等细节精修",
    toolProfileId: "ball-0.3",
    materialProfileId: "olive-core",
    maxCutDepth: 0.06,
    stockAllowance: 0.05,
    stepoverMm: 0.045,
    stepoverDeg: 0.6,
    feedRate: 85,
    spindleRpm: 16000,
    finishingStrategy: "cross",
    notes: "加工时间长，适合作为最终精修模板。"
  }
];

export function getToolProfile(id: string) {
  return toolProfiles.find((profile) => profile.id === id) ?? toolProfiles[0];
}

export function getMaterialProfile(id: string) {
  return materialProfiles.find((profile) => profile.id === id) ?? materialProfiles[0];
}

export function getMachineProfile(id: string) {
  return machineProfiles.find((profile) => profile.id === id) ?? machineProfiles[0];
}

export function getProcessTemplate(id: string) {
  return processTemplates.find((template) => template.id === id) ?? processTemplates[0];
}

export function applyProcessTemplate(settings: ModelSettings, template: ProcessTemplate): ModelSettings {
  return {
    ...settings,
    toolProfileId: template.toolProfileId,
    materialProfileId: template.materialProfileId,
    toolDiameter: getToolProfile(template.toolProfileId).diameterMm,
    maxCutDepth: template.maxCutDepth,
    stockAllowance: template.stockAllowance,
    stepoverMm: template.stepoverMm,
    stepoverDeg: template.stepoverDeg,
    feedRate: template.feedRate,
    spindleRpm: template.spindleRpm,
    finishingStrategy: template.finishingStrategy
  };
}

export function applyToolProfile(settings: ModelSettings, tool: ToolProfile): ModelSettings {
  const material = getMaterialProfile(settings.materialProfileId);
  return {
    ...settings,
    toolProfileId: tool.id,
    toolDiameter: tool.diameterMm,
    stepoverMm: tool.recommendedStepoverMm,
    maxCutDepth: Math.min(tool.maxCutDepthMm, material.maxCutDepthMm),
    stockAllowance: tool.stockAllowanceMm,
    feedRate: Math.min(settings.feedRate, tool.recommendedFeed),
    spindleRpm: tool.recommendedRpm
  };
}

export function applyMaterialProfile(settings: ModelSettings, material: MaterialProfile): ModelSettings {
  return {
    ...settings,
    materialProfileId: material.id,
    spindleRpm: material.spindleRpm,
    feedRate: material.roughFeed,
    maxCutDepth: Math.min(settings.maxCutDepth, material.maxCutDepthMm)
  };
}

export function applyMachineProfile(settings: ModelSettings, machine: MachineProfile): ModelSettings {
  if (machine.id === "desktop-3axis-rotary-y") {
    return {
      ...settings,
      machineProfileId: machine.id,
      safeZ: machine.safeZ,
      camMode: "rotaryWrap",
      rotaryOutputAxis: "Y",
      postProcessor: "wrapY"
    };
  }

  return {
    ...settings,
    machineProfileId: machine.id,
    safeZ: machine.safeZ,
    postProcessor: machine.controller
      ? machine.axes === "3axis"
        ? "generic3"
        : machine.controller
      : settings.postProcessor,
    camMode: machine.axes === "3axis" ? settings.camMode === "rotaryWrap" ? "rotaryWrap" : "3axis" : "4axis"
  };
}

export function validateManufacturingSetup(settings: ModelSettings, toolpath: GeneratedToolpath | null): SafetyIssue[] {
  const tool = getToolProfile(settings.toolProfileId);
  const material = getMaterialProfile(settings.materialProfileId);
  const machine = getMachineProfile(settings.machineProfileId);
  const issues: SafetyIssue[] = [];

  if (settings.toolDiameter !== tool.diameterMm) {
    issues.push({
      level: "warning",
      title: "刀具直径与预设不一致",
      detail: `当前 ${settings.toolDiameter.toFixed(2)}mm，预设 ${tool.diameterMm.toFixed(2)}mm。请确认实际装刀。`
    });
  }

  if (settings.feedRate > Math.min(machine.maxFeed, tool.recommendedFeed * 1.8)) {
    issues.push({
      level: "critical",
      title: "进给速度过高",
      detail: `当前 ${settings.feedRate.toFixed(0)}mm/min，超过该刀具/机床建议上限。`
    });
  }

  if (settings.spindleRpm > Math.min(machine.maxRpm, tool.recommendedRpm * 1.35)) {
    issues.push({
      level: "critical",
      title: "主轴转速超限",
      detail: `当前 ${settings.spindleRpm.toFixed(0)}rpm，超过机床或刀具建议范围。`
    });
  }

  if (settings.maxCutDepth > Math.min(tool.maxCutDepthMm, material.maxCutDepthMm)) {
    issues.push({
      level: "critical",
      title: "单层切深过大",
      detail: `当前 ${settings.maxCutDepth.toFixed(2)}mm，建议不超过 ${Math.min(tool.maxCutDepthMm, material.maxCutDepthMm).toFixed(2)}mm。`
    });
  }

  if (settings.stepoverMm > tool.diameterMm * 0.6) {
    issues.push({
      level: "warning",
      title: "X 步距偏大",
      detail: "可能留下明显刀痕，精加工建议控制在刀径 20%-40%。"
    });
  }

  if (settings.camMode === "3axis" && machine.axes !== "3axis") {
    issues.push({
      level: "critical",
      title: "三轴 CAM 与机床不匹配",
      detail: "当前 CAM 模式为三轴 X/Y/Z，但机床预设不是三轴。请选择三轴机床或切回四轴模式。"
    });
  }

  if (settings.camMode === "4axis" && machine.axes === "3axis") {
    issues.push({
      level: "critical",
      title: "四轴 CAM 与三轴机床不匹配",
      detail: "三轴机床不能执行 A 轴旋转刀路。请选择四轴机床或切换三轴浮雕模式。"
    });
  }

  if (settings.camMode === "rotaryWrap") {
    if (settings.rotaryOutputAxis === "A" && machine.axes !== "4axis") {
      issues.push({
        level: "critical",
        title: "真实 A 轴与三轴机床不匹配",
        detail: "当前旋转包裹输出为 A 轴，但机床预设不是四轴。若夹具接在三轴控制器上，请选择 Y轴或 X轴代替旋转。"
      });
    }
    if (settings.rotaryOutputAxis === "X") {
      issues.push({
        level: "warning",
        title: "X轴代替旋转会占用长度轴",
        detail: "X轴通常用于核雕长度方向。若夹具接在 X 轴，系统会把长度方向改用 Y 输出，请确认机床接线和工件方向。"
      });
    }
    if (settings.rotaryOutputAxis !== "A" && settings.rotaryWrapPerRevolutionMm <= 0) {
      issues.push({
        level: "critical",
        title: "旋转每圈距离未设置",
        detail: "Y/X 轴代替旋转时必须设置“每圈距离 mm/圈”，用于把 A 角度换算为线性轴位移。"
      });
    }
  }

  if (settings.camMode === "3axis" && settings.postProcessor !== "generic3") {
    issues.push({
      level: "critical",
      title: "三轴后处理不匹配",
      detail: "三轴程序应使用“通用三轴”后处理，避免导出带 A 轴语义的程序头。"
    });
  }

  if (settings.camMode === "4axis" && settings.postProcessor === "generic3") {
    issues.push({
      level: "critical",
      title: "四轴后处理不匹配",
      detail: "四轴核雕程序不能使用三轴后处理。"
    });
  }

  if (settings.camMode === "rotaryWrap") {
    const expectedPost = settings.rotaryOutputAxis === "X" ? "wrapX" : settings.rotaryOutputAxis === "Y" ? "wrapY" : "generic";
    if (settings.postProcessor !== expectedPost) {
      issues.push({
        level: "critical",
        title: "旋转包裹后处理不匹配",
        detail: `当前夹具接入轴为 ${settings.rotaryOutputAxis}，建议后处理使用 ${expectedPost === "wrapX" ? "X轴旋转包裹" : expectedPost === "wrapY" ? "Y轴旋转包裹" : "通用四轴"}。`
      });
    }
  }

  if (settings.camMode === "3axis" && tool.type === "v-bit" && tool.angleDeg != null) {
    issues.push({
      level: "warning",
      title: "V 型平底尖刀已启用",
      detail: `${tool.name} 会按尖端 Z 深度输出三轴刀路，尖刀侧刃会随深度扩大实际切削宽度，正式上机前请先做浅雕验证。`
    });
  }

  if (settings.leftHoldMm < 1.5 || settings.rightHoldMm < 1.5) {
    issues.push({
      level: "warning",
      title: "夹持保留偏小",
      detail: "真实核雕两端通常需要留夹持区，建议左右至少 1.5-2.0mm。"
    });
  }

  const blankDiameters = getBlankProfileDiameters(settings);
  const minBlankDiameter = Math.min(...blankDiameters);
  const blankTaper = Math.max(...blankDiameters) - minBlankDiameter;
  if (minBlankDiameter < settings.diameterMm - 2.5) {
    issues.push({
      level: "warning",
      title: "毛坯截面小于目标最大直径",
      detail: `毛坯 5 截面最小直径 ${minBlankDiameter.toFixed(1)}mm，目标最大直径 ${settings.diameterMm.toFixed(1)}mm。请确认模型缩放和夹持区不会切空。`
    });
  }

  if (blankTaper > 3) {
    issues.push({
      level: "warning",
      title: "毛坯左右直径差异较大",
      detail: `毛坯 5 截面直径为 ${formatBlankProfileDiameters(settings)}mm，建议先空跑并保守设置端部过渡。`
    });
  }

  if (!toolpath) {
    issues.push({
      level: "warning",
      title: "尚未生成刀路",
      detail: "生成刀路后会继续检查 X/A/Z 范围和安全高度。"
    });
    return issues;
  }

  if (toolpath.summary.xMin < machine.xMin || toolpath.summary.xMax > machine.xMax) {
    issues.push({
      level: "critical",
      title: "X 轴行程越界",
      detail: `刀路 X=${toolpath.summary.xMin.toFixed(1)}~${toolpath.summary.xMax.toFixed(1)}mm，机床范围 ${machine.xMin}~${machine.xMax}mm。`
    });
  }

  if (settings.camMode === "rotaryWrap" && settings.rotaryOutputAxis !== "A") {
    const wrapTravelMin = (toolpath.summary.aMin / 360) * settings.rotaryWrapPerRevolutionMm;
    const wrapTravelMax = (toolpath.summary.aMax / 360) * settings.rotaryWrapPerRevolutionMm;
    const axisMin = settings.rotaryOutputAxis === "Y" ? machine.yMin : machine.xMin;
    const axisMax = settings.rotaryOutputAxis === "Y" ? machine.yMax : machine.xMax;
    if (wrapTravelMin < axisMin || wrapTravelMax > axisMax) {
      issues.push({
        level: "critical",
        title: `${settings.rotaryOutputAxis}轴旋转行程越界`,
        detail: `旋转包裹换算 ${settings.rotaryOutputAxis}=${wrapTravelMin.toFixed(1)}~${wrapTravelMax.toFixed(1)}mm，机床范围 ${axisMin}~${axisMax}mm。请调整每圈距离或机床行程。`
      });
    }
  }

  if (
    settings.camMode === "3axis" &&
    (toolpath.summary.yMin == null ||
      toolpath.summary.yMax == null ||
      toolpath.summary.yMin < machine.yMin ||
      toolpath.summary.yMax > machine.yMax)
  ) {
    issues.push({
      level: "critical",
      title: "Y 轴行程越界",
      detail: `刀路 Y=${(toolpath.summary.yMin ?? 0).toFixed(1)}~${(toolpath.summary.yMax ?? 0).toFixed(1)}mm，机床范围 ${machine.yMin}~${machine.yMax}mm。`
    });
  }

  if (toolpath.summary.zMin < machine.zMin || toolpath.summary.zMax > machine.zMax) {
    issues.push({
      level: "critical",
      title: "Z 轴行程越界",
      detail: `刀路 Z=${toolpath.summary.zMin.toFixed(1)}~${toolpath.summary.zMax.toFixed(1)}mm，机床范围 ${machine.zMin}~${machine.zMax}mm。`
    });
  }

  if (toolpath.summary.zMax > settings.safeZ + 0.01) {
    issues.push({
      level: "critical",
      title: "安全高度不足",
      detail: `安全高度 ${settings.safeZ.toFixed(1)}mm 低于最高刀位 ${toolpath.summary.zMax.toFixed(1)}mm。`
    });
  }

  if (toolpath.summary.maxDepth > settings.depthMm + 0.05) {
    issues.push({
      level: "warning",
      title: "最大切削深度异常",
      detail: "刀路深度超过模型设定深度，请检查 Mesh 采样或浮雕深度。"
    });
  }

  if (issues.length === 0) {
    issues.push({
      level: "ok",
      title: "导出前校验通过",
      detail: "当前刀具、材料、机床和刀路基础范围未发现阻断项。"
    });
  }

  return issues;
}

function getBlankProfileDiameters(settings: ModelSettings) {
  return [
    settings.blankLeftDiameterMm,
    settings.blankLeftMidDiameterMm,
    settings.blankCenterDiameterMm,
    settings.blankRightMidDiameterMm,
    settings.blankRightDiameterMm
  ].filter((value) => Number.isFinite(value));
}

function formatBlankProfileDiameters(settings: ModelSettings) {
  return getBlankProfileDiameters(settings).map((value) => value.toFixed(1)).join(" / ");
}

export function validateGcodeProgram(settings: ModelSettings, toolpath: GeneratedToolpath | null): SafetyIssue[] {
  if (!toolpath) return [];

  const machine = getMachineProfile(settings.machineProfileId);
  const issues: SafetyIssue[] = [];
  const lines = toolpath.gcode.split(/\r?\n/);
  let previousA: number | null = null;
  let sawSafeRetract = false;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("(") || trimmed === "%" || trimmed.startsWith(";")) return;

    const lineNumber = index + 1;
    const x = readAxis(trimmed, "X");
    const z = readAxis(trimmed, "Z");
    const y = readAxis(trimmed, "Y");
    const a = readAxis(trimmed, "A");
    const feed = readAxis(trimmed, "F");
    const spindle = readAxis(trimmed, "S");
    const isMotion = /\bG0?0\b|\bG0?1\b/.test(trimmed);

    if (x !== null && (x < machine.xMin || x > machine.xMax)) {
      issues.push(createGcodeIssue("critical", "G-code X 轴越界", lineNumber, trimmed, `X=${x.toFixed(3)}mm，机床范围 ${machine.xMin}~${machine.xMax}mm。`));
    }

    if (z !== null && (z < machine.zMin || z > machine.zMax)) {
      issues.push(createGcodeIssue("critical", "G-code Z 轴越界", lineNumber, trimmed, `Z=${z.toFixed(3)}mm，机床范围 ${machine.zMin}~${machine.zMax}mm。`));
    }

    if ((settings.camMode === "3axis" || settings.camMode === "rotaryWrap") && y !== null && (y < machine.yMin || y > machine.yMax)) {
      issues.push(createGcodeIssue("critical", "G-code Y 轴越界", lineNumber, trimmed, `Y=${y.toFixed(3)}mm，机床范围 ${machine.yMin}~${machine.yMax}mm。`));
    }

    if (settings.camMode === "3axis" && a !== null) {
      issues.push(createGcodeIssue("critical", "三轴程序不应包含 A 轴", lineNumber, trimmed, "当前机床为三轴模式，请重新生成三轴刀路。"));
    }

    if (settings.camMode !== "3axis" && settings.camMode !== "rotaryWrap" && a !== null && (a < machine.aMin || a > machine.aMax)) {
      issues.push(createGcodeIssue("critical", "G-code A 轴越界", lineNumber, trimmed, `A=${a.toFixed(3)}°，机床范围 ${machine.aMin}~${machine.aMax}°。`));
    }

    if (feed !== null && feed > machine.maxFeed) {
      issues.push(createGcodeIssue("critical", "G-code 进给超限", lineNumber, trimmed, `F=${feed.toFixed(1)}mm/min，机床上限 ${machine.maxFeed}mm/min。`));
    }

    if (spindle !== null && spindle > machine.maxRpm) {
      issues.push(createGcodeIssue("critical", "G-code 主轴超限", lineNumber, trimmed, `S=${spindle.toFixed(0)}rpm，机床上限 ${machine.maxRpm}rpm。`));
    }

    if (settings.camMode !== "3axis" && a !== null && previousA !== null && Math.abs(a - previousA) > 120) {
      issues.push(createGcodeIssue("warning", "A 轴角度跳变较大", lineNumber, trimmed, `上一 A=${previousA.toFixed(2)}°，当前 A=${a.toFixed(2)}°。请空跑确认旋转方向和连续性。`));
    }
    if (a !== null) previousA = a;

    if (isMotion && z !== null && z >= settings.safeZ - 0.01) {
      sawSafeRetract = true;
    }
  });

  if (!sawSafeRetract) {
    issues.push({
      level: "warning",
      title: "未发现安全高度抬刀行",
      detail: `程序中未检测到 Z>=${settings.safeZ.toFixed(2)}mm 的运动行，请确认后处理程序头/程序尾是否有安全抬刀。`
    });
  }

  if (issues.length === 0) {
    issues.push({
      level: "ok",
      title: "G-code 行级校验通过",
      detail: "已扫描合并程序，未发现坐标越界、进给超限、主轴超限或异常 A 轴跳变。"
    });
  }

  return prioritizeGcodeIssues(issues).slice(0, 16);
}

export function hasCriticalIssue(issues: SafetyIssue[]) {
  return issues.some((issue) => issue.level === "critical");
}

function readAxis(line: string, axis: string) {
  const match = line.match(new RegExp(`(?:^|\\s)${axis}(-?\\d+(?:\\.\\d+)?)`, "i"));
  return match ? Number(match[1]) : null;
}

function createGcodeIssue(level: SafetyIssue["level"], title: string, line: number, command: string, detail: string): SafetyIssue {
  return {
    level,
    title,
    line,
    command,
    detail: `第 ${line} 行：${detail}`
  };
}

function prioritizeGcodeIssues(issues: SafetyIssue[]) {
  const rank = { critical: 0, warning: 1, ok: 2 } satisfies Record<SafetyIssue["level"], number>;
  return [...issues].sort((a, b) => rank[a.level] - rank[b.level]);
}
