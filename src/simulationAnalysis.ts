import type { GeneratedToolpath, ModelSettings, ToolpathPoint } from "./types";
import { getToolProfile, type ToolProfile } from "./manufacturingProfiles";

export type MaterialRemovalMetric = {
  label: string;
  value: string;
  status: "ok" | "warning" | "critical";
  detail: string;
};

export type MaterialRemovalReport = {
  score: number;
  verdict: "ready" | "review" | "risk";
  summary: string;
  simulationMode: "preview" | "swept-tool";
  toolGeometry: {
    type: ToolProfile["type"];
    effectiveRadiusMm: number;
    contactWidthMm: number;
    angleDeg: number | null;
  };
  maxTextureMm: number;
  meanTextureMm: number;
  coverageRate: number;
  restAreaRate: number;
  maxOvercutMm: number;
  maxUndercutMm: number;
  residualRiskMm: number;
  sweptAreaRate: number;
  metrics: MaterialRemovalMetric[];
  suggestions: string[];
};

export function analyzeMaterialRemoval(settings: ModelSettings, toolpath: GeneratedToolpath | null): MaterialRemovalReport | null {
  if (!toolpath) return null;

  const cuttingPoints = removeSafeMoves(toolpath.programs?.combined?.points ?? toolpath.points, settings);
  if (cuttingPoints.length === 0) return null;

  const tool = getToolProfile(settings.toolProfileId);
  const isThreeAxis = settings.camMode === "3axis" || cuttingPoints.some((point) => point.y != null);
  const maxDepth = cuttingPoints.reduce((max, point) => Math.max(max, point.depth), 0);
  const geometry = createToolSweepGeometry(tool, settings, maxDepth);
  const xScallop = estimateScallopHeightByTool(settings.stepoverMm, geometry);
  const secondaryStepMm = isThreeAxis ? settings.stepoverMm : (Math.PI / 180) * settings.stepoverDeg * (settings.diameterMm / 2);
  const secondaryScallop = estimateScallopHeightByTool(secondaryStepMm, geometry);
  const maxTextureMm = Math.max(xScallop, secondaryScallop);
  const meanTextureMm = (xScallop + secondaryScallop) / 2;
  const coverageRate = estimateCoverageRate(cuttingPoints, settings);
  const restAreaRate = estimateRestAreaRate(toolpath);
  const sweptAreaRate = estimateSweptAreaRate(cuttingPoints, settings, geometry.contactWidthMm);
  const removalBias = estimateToolRemovalBias(tool, settings, geometry, maxDepth);
  const maxOvercutMm = Math.max(0, maxDepth - settings.depthMm + removalBias.overcutMm);
  const maxUndercutMm = Math.max(0, settings.stockAllowance - maxDepth + removalBias.undercutMm);
  const residualRiskMm = estimateResidualRisk(settings, geometry, restAreaRate, maxDepth);
  const metrics: MaterialRemovalMetric[] = [
    {
      label: "仿真模式",
      value: formatToolType(tool.type),
      status: geometry.status,
      detail: `${geometry.detail}；有效半径 ${geometry.effectiveRadiusMm.toFixed(3)}mm，扫掠宽度 ${geometry.contactWidthMm.toFixed(3)}mm。`
    },
    {
      label: "刀痕纹理",
      value: `${(maxTextureMm * 1000).toFixed(0)} μm`,
      status: maxTextureMm <= 0.012 ? "ok" : maxTextureMm <= 0.035 ? "warning" : "critical",
      detail: `按 ${formatToolType(tool.type)} 扫掠几何估算；X ${(xScallop * 1000).toFixed(0)}μm，${isThreeAxis ? "Y" : "A"} ${(secondaryScallop * 1000).toFixed(0)}μm。`
    },
    {
      label: "刀路覆盖",
      value: `${coverageRate.toFixed(1)}%`,
      status: coverageRate >= 92 ? "ok" : coverageRate >= 82 ? "warning" : "critical",
      detail: `按可雕刻区 ${isThreeAxis ? "X/Y" : "X/A"} 网格估算覆盖率，低覆盖率可能留下未加工区域。`
    },
    {
      label: "扫掠覆盖",
      value: `${sweptAreaRate.toFixed(1)}%`,
      status: sweptAreaRate >= 96 ? "ok" : sweptAreaRate >= 88 ? "warning" : "critical",
      detail: "按刀具接触宽度扩展估算实际材料被刀刃扫过的比例。"
    },
    {
      label: "清残占比",
      value: `${restAreaRate.toFixed(1)}%`,
      status: restAreaRate >= 2 && restAreaRate <= 35 ? "ok" : restAreaRate > 35 ? "warning" : "warning",
      detail: restAreaRate > 0 ? "清残会补加工深纹理和高变化区域。" : "未检测到有效清残点，细节区域可能依赖精加工完成。"
    },
    {
      label: "过切风险",
      value: `${maxOvercutMm.toFixed(3)} mm`,
      status: maxOvercutMm <= 0.02 ? "ok" : maxOvercutMm <= 0.08 ? "warning" : "critical",
      detail: "比较刀路最大深度与目标浮雕深度，过大时可能切穿细节或削弱薄壁。"
    },
    {
      label: "欠切/残料",
      value: `${maxUndercutMm.toFixed(3)} mm`,
      status: maxUndercutMm <= 0.03 ? "ok" : maxUndercutMm <= settings.stockAllowance + 0.02 ? "warning" : "critical",
      detail: "估算目标深度与实际最大切深差值；粗加工余量会由精加工/清残继续处理。"
    },
    {
      label: "残料风险",
      value: `${residualRiskMm.toFixed(3)} mm`,
      status: residualRiskMm <= 0.025 ? "ok" : residualRiskMm <= 0.08 ? "warning" : "critical",
      detail: "结合刀具形状、清残占比和最大切深估算细节凹槽可能残留的材料。"
    }
  ];

  const score = clamp(
    100 -
      Math.max(0, maxTextureMm - 0.012) * 950 -
      Math.max(0, 94 - coverageRate) * 1.4 -
      Math.max(0, 96 - sweptAreaRate) * 0.8 -
      Math.max(0, maxOvercutMm - 0.02) * 180 -
      Math.max(0, residualRiskMm - 0.025) * 160 -
      (restAreaRate === 0 ? 8 : restAreaRate > 45 ? 7 : 0),
    0,
    100
  );
  const verdict: MaterialRemovalReport["verdict"] = score >= 86 ? "ready" : score >= 68 ? "review" : "risk";
  const summary = verdict === "ready" ? "仿真指标适合进入空跑" : verdict === "review" ? "建议复核纹理和残料风险" : "存在明显仿真风险";
  const suggestions: string[] = [];
  if (maxTextureMm > 0.035) suggestions.push(`刀痕纹理偏大，建议降低 ${isThreeAxis ? "X/Y" : "X/A"} 步距或改用更小球刀精修。`);
  if (coverageRate < 92) suggestions.push("刀路覆盖不足，建议减小步距或检查夹持/过渡区是否过大。");
  if (sweptAreaRate < 88) suggestions.push("按刀具扫掠估算仍有覆盖缺口，建议减小步距或增加交叉精修。");
  if (restAreaRate === 0) suggestions.push("没有有效清残点，细节较深时建议使用清残刀路或更小刀具。");
  if (restAreaRate > 35) suggestions.push("清残占比偏高，可能说明模型细节过密或刀具偏大，建议先小样试雕。");
  if (maxOvercutMm > 0.02) suggestions.push("检测到过切风险，建议降低浮雕深度或提高安全余量。");
  if (residualRiskMm > 0.08) suggestions.push("残料风险偏高，建议改用更小球刀/锥刀清残或增加精加工遍数。");
  if (tool.type === "flat") suggestions.push("当前为平刀模型，适合粗加工去料；最终细节建议再用球刀或锥刀精修。");
  if (tool.type === "taper" && maxDepth > tool.fluteLengthMm * 0.75) suggestions.push("锥刀切深接近刃长上限，建议降低单层切深并检查刀尖磨损。");

  return {
    score,
    verdict,
    summary,
    simulationMode: "swept-tool",
    toolGeometry: {
      type: tool.type,
      effectiveRadiusMm: geometry.effectiveRadiusMm,
      contactWidthMm: geometry.contactWidthMm,
      angleDeg: tool.angleDeg ?? null
    },
    maxTextureMm,
    meanTextureMm,
    coverageRate,
    restAreaRate,
    maxOvercutMm,
    maxUndercutMm,
    residualRiskMm,
    sweptAreaRate,
    metrics,
    suggestions: suggestions.length > 0 ? suggestions : ["材料去除快览指标正常，可继续进行模拟雕刻和离料空跑。"]
  };
}

function removeSafeMoves(points: ToolpathPoint[], settings: ModelSettings) {
  const safeCutoff = settings.safeZ * 0.92;
  return points.filter((point) => Number.isFinite(point.z) && point.z < safeCutoff);
}

type ToolSweepGeometry = {
  effectiveRadiusMm: number;
  contactWidthMm: number;
  status: MaterialRemovalMetric["status"];
  detail: string;
  flatFactor: number;
  taperFactor: number;
};

function createToolSweepGeometry(tool: ToolProfile, settings: ModelSettings, maxDepth: number): ToolSweepGeometry {
  const nominalRadius = Math.max(0.001, settings.toolDiameter / 2);
  if (tool.type === "flat") {
    return {
      effectiveRadiusMm: nominalRadius * 4,
      contactWidthMm: Math.max(settings.toolDiameter, tool.diameterMm),
      status: "warning",
      detail: "按平刀圆柱扫掠估算，底面去料强但细节圆角能力弱",
      flatFactor: 1,
      taperFactor: 0
    };
  }

  if (tool.type === "taper" || tool.type === "v-bit" || tool.type === "micro") {
    const angleRad = ((tool.angleDeg ?? 20) * Math.PI) / 180;
    const radiusAtDepth = Math.max(tool.tipRadiusMm, tool.tipRadiusMm + Math.tan(angleRad / 2) * Math.max(0, maxDepth));
    return {
      effectiveRadiusMm: Math.max(0.001, radiusAtDepth),
      contactWidthMm: Math.max(tool.tipRadiusMm * 2, radiusAtDepth * 2),
      status: maxDepth > tool.fluteLengthMm * 0.75 ? "warning" : "ok",
      detail: "按锥刀刀尖角随深度扩大的扫掠宽度估算",
      flatFactor: 0,
      taperFactor: 1
    };
  }

  return {
    effectiveRadiusMm: Math.max(0.001, tool.tipRadiusMm || nominalRadius),
    contactWidthMm: Math.max(settings.toolDiameter, (tool.tipRadiusMm || nominalRadius) * 2),
    status: "ok",
    detail: "按球刀球面半径扣除材料并估算等高刀痕",
    flatFactor: 0,
    taperFactor: 0
  };
}

function estimateScallopHeightByTool(stepMm: number, geometry: ToolSweepGeometry) {
  if (geometry.flatFactor > 0) {
    return Math.max(0, stepMm - geometry.contactWidthMm * 0.82) * 0.18;
  }
  const scallop = estimateBallScallopHeight(stepMm, geometry.effectiveRadiusMm);
  return geometry.taperFactor > 0 ? scallop * 1.18 : scallop;
}

function estimateBallScallopHeight(stepMm: number, toolRadiusMm: number) {
  if (stepMm <= 0 || toolRadiusMm <= 0) return 0;
  const halfStep = stepMm / 2;
  if (halfStep >= toolRadiusMm) return toolRadiusMm;
  return toolRadiusMm - Math.sqrt(Math.max(0, toolRadiusMm * toolRadiusMm - halfStep * halfStep));
}

function estimateSweptAreaRate(points: ToolpathPoint[], settings: ModelSettings, contactWidthMm: number) {
  const rawCoverage = estimateCoverageRate(points, settings);
  const xBoost = contactWidthMm / Math.max(settings.stepoverMm, 0.001);
  const secondaryStepMm = settings.camMode === "3axis" || points.some((point) => point.y != null)
    ? settings.stepoverMm
    : (Math.PI / 180) * settings.stepoverDeg * (settings.diameterMm / 2);
  const secondaryBoost = contactWidthMm / Math.max(secondaryStepMm, 0.001);
  const boost = clamp((xBoost + secondaryBoost) / 2, 0.7, 1.45);
  return Math.min(100, rawCoverage * boost);
}

function estimateToolRemovalBias(tool: ToolProfile, settings: ModelSettings, geometry: ToolSweepGeometry, maxDepth: number) {
  if (tool.type === "flat") {
    return {
      overcutMm: settings.stepoverMm > geometry.contactWidthMm * 0.55 ? 0.01 : 0,
      undercutMm: Math.max(0, settings.stockAllowance * 0.22)
    };
  }
  if (geometry.taperFactor > 0) {
    const sideGrowth = Math.max(0, geometry.effectiveRadiusMm - Math.max(0.001, tool.tipRadiusMm));
    return {
      overcutMm: sideGrowth * 0.12,
      undercutMm: maxDepth < settings.depthMm * 0.55 ? 0.03 : 0
    };
  }
  return { overcutMm: 0, undercutMm: 0 };
}

function estimateResidualRisk(settings: ModelSettings, geometry: ToolSweepGeometry, restAreaRate: number, maxDepth: number) {
  const stepResidual = Math.max(0, settings.stepoverMm - geometry.contactWidthMm * 0.42) * 0.35;
  const depthResidual = Math.max(0, settings.depthMm - maxDepth) * 0.18;
  const noRestPenalty = restAreaRate > 0 ? 0 : Math.min(0.08, settings.stockAllowance * 0.35);
  return stepResidual + depthResidual + noRestPenalty;
}

function formatToolType(type: ToolProfile["type"]) {
  if (type === "ball") return "球刀扫掠";
  if (type === "flat") return "平刀扫掠";
  if (type === "taper") return "锥刀扫掠";
  if (type === "v-bit") return "V 刀扫掠";
  return "微雕刀扫掠";
}

function estimateCoverageRate(points: ToolpathPoint[], settings: ModelSettings) {
  if (settings.camMode === "3axis" || points.some((point) => point.y != null)) {
    const xMin = -settings.lengthMm / 2;
    const xMax = settings.lengthMm / 2;
    const yMin = -settings.diameterMm / 2;
    const yMax = settings.diameterMm / 2;
    const xCells = Math.max(2, Math.ceil((xMax - xMin) / Math.max(settings.stepoverMm, 0.001)));
    const yCells = Math.max(2, Math.ceil((yMax - yMin) / Math.max(settings.stepoverMm, 0.001)));
    const visited = new Set<string>();

    for (const point of points) {
      const xi = clamp(Math.floor(((point.x - xMin) / Math.max(0.001, xMax - xMin)) * xCells), 0, xCells - 1);
      const yi = clamp(Math.floor((((point.y ?? 0) - yMin) / Math.max(0.001, yMax - yMin)) * yCells), 0, yCells - 1);
      visited.add(`${xi}:${yi}`);
    }

    return Math.min(100, (visited.size / Math.max(1, xCells * yCells)) * 100);
  }

  const xMin = -settings.lengthMm / 2 + settings.leftHoldMm;
  const xMax = settings.lengthMm / 2 - settings.rightHoldMm;
  const aMin = settings.reliefAngleDeg >= 360 ? -180 : -settings.reliefAngleDeg / 2;
  const aMax = settings.reliefAngleDeg >= 360 ? 180 : settings.reliefAngleDeg / 2;
  const xCells = Math.max(2, Math.ceil(Math.max(settings.stepoverMm, xMax - xMin) / Math.max(settings.stepoverMm, 0.001)));
  const aCells = Math.max(2, Math.ceil((aMax - aMin) / Math.max(settings.stepoverDeg, 0.001)));
  const visited = new Set<string>();

  for (const point of points) {
    const xi = clamp(Math.floor(((point.x - xMin) / Math.max(0.001, xMax - xMin)) * xCells), 0, xCells - 1);
    const ai = clamp(Math.floor(((point.a - aMin) / Math.max(0.001, aMax - aMin)) * aCells), 0, aCells - 1);
    visited.add(`${xi}:${ai}`);
  }

  return Math.min(100, (visited.size / Math.max(1, xCells * aCells)) * 100);
}

function estimateRestAreaRate(toolpath: GeneratedToolpath) {
  const restPoints = toolpath.programs?.rest?.points.length ?? 0;
  const finishPoints = toolpath.programs?.finish?.points.length ?? toolpath.points.length;
  return finishPoints > 0 ? (restPoints / finishPoints) * 100 : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
