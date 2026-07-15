import type { GeneratedToolpath, ModelSettings } from "./types";

export type ToolProfile = {
  id: string;
  name: string;
  type: "ball" | "flat" | "taper" | "v-bit" | "micro";
  diameterMm: number;
  tipRadiusMm: number;
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
  controller: "generic" | "weihong" | "syntec";
  xMin: number;
  xMax: number;
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
    controller: "generic",
    xMin: -45,
    xMax: 45,
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
    controller: "weihong",
    xMin: -55,
    xMax: 55,
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
    controller: "syntec",
    xMin: -60,
    xMax: 60,
    zMin: 0,
    zMax: 45,
    aMin: -9999,
    aMax: 9999,
    safeZ: 25,
    maxFeed: 700,
    maxRpm: 24000,
    aDirection: "normal",
    notes: "新代风格后处理，适合带完整安全段的程序。"
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
  return {
    ...settings,
    toolProfileId: tool.id,
    toolDiameter: tool.diameterMm,
    stepoverMm: tool.recommendedStepoverMm,
    maxCutDepth: tool.maxCutDepthMm,
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
  return {
    ...settings,
    machineProfileId: machine.id,
    safeZ: machine.safeZ,
    postProcessor: machine.controller
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

  if (settings.leftHoldMm < 1.5 || settings.rightHoldMm < 1.5) {
    issues.push({
      level: "warning",
      title: "夹持保留偏小",
      detail: "真实核雕两端通常需要留夹持区，建议左右至少 1.5-2.0mm。"
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

  if (toolpath.summary.zMin < machine.zMin || toolpath.summary.zMax > machine.zMax) {
    issues.push({
      level: "critical",
      title: "Z 轴行程越界",
      detail: `刀路 Z=${toolpath.summary.zMin.toFixed(1)}~${toolpath.summary.zMax.toFixed(1)}mm，机床范围 ${machine.zMin}~${machine.zMax}mm。`
    });
  }

  if (settings.safeZ <= toolpath.summary.zMax) {
    issues.push({
      level: "critical",
      title: "安全高度不足",
      detail: `安全高度 ${settings.safeZ.toFixed(1)}mm 低于或接近最高刀位 ${toolpath.summary.zMax.toFixed(1)}mm。`
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

export function hasCriticalIssue(issues: SafetyIssue[]) {
  return issues.some((issue) => issue.level === "critical");
}
