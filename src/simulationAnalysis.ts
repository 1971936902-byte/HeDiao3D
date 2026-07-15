import type { GeneratedToolpath, ModelSettings, ToolpathPoint } from "./types";

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
  maxTextureMm: number;
  meanTextureMm: number;
  coverageRate: number;
  restAreaRate: number;
  maxOvercutMm: number;
  maxUndercutMm: number;
  metrics: MaterialRemovalMetric[];
  suggestions: string[];
};

export function analyzeMaterialRemoval(settings: ModelSettings, toolpath: GeneratedToolpath | null): MaterialRemovalReport | null {
  if (!toolpath) return null;

  const cuttingPoints = removeSafeMoves(toolpath.programs?.combined?.points ?? toolpath.points, settings);
  if (cuttingPoints.length === 0) return null;

  const toolRadius = Math.max(0.001, settings.toolDiameter / 2);
  const xScallop = estimateScallopHeight(settings.stepoverMm, toolRadius);
  const arcStepMm = (Math.PI / 180) * settings.stepoverDeg * (settings.diameterMm / 2);
  const aScallop = estimateScallopHeight(arcStepMm, toolRadius);
  const maxTextureMm = Math.max(xScallop, aScallop);
  const meanTextureMm = (xScallop + aScallop) / 2;
  const coverageRate = estimateCoverageRate(cuttingPoints, settings);
  const restAreaRate = estimateRestAreaRate(toolpath);
  const maxDepth = cuttingPoints.reduce((max, point) => Math.max(max, point.depth), 0);
  const maxOvercutMm = Math.max(0, maxDepth - settings.depthMm);
  const maxUndercutMm = Math.max(0, settings.stockAllowance - maxDepth);
  const metrics: MaterialRemovalMetric[] = [
    {
      label: "刀痕纹理",
      value: `${(maxTextureMm * 1000).toFixed(0)} μm`,
      status: maxTextureMm <= 0.012 ? "ok" : maxTextureMm <= 0.035 ? "warning" : "critical",
      detail: `按球刀半径与 X/A 步距估算；X ${(xScallop * 1000).toFixed(0)}μm，A ${(aScallop * 1000).toFixed(0)}μm。`
    },
    {
      label: "刀路覆盖",
      value: `${coverageRate.toFixed(1)}%`,
      status: coverageRate >= 92 ? "ok" : coverageRate >= 82 ? "warning" : "critical",
      detail: "按可雕刻区 X/A 网格估算覆盖率，低覆盖率可能留下未加工区域。"
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
    }
  ];

  const score = clamp(
    100 -
      Math.max(0, maxTextureMm - 0.012) * 950 -
      Math.max(0, 94 - coverageRate) * 1.4 -
      Math.max(0, maxOvercutMm - 0.02) * 180 -
      (restAreaRate === 0 ? 8 : restAreaRate > 45 ? 7 : 0),
    0,
    100
  );
  const verdict: MaterialRemovalReport["verdict"] = score >= 86 ? "ready" : score >= 68 ? "review" : "risk";
  const summary = verdict === "ready" ? "仿真指标适合进入空跑" : verdict === "review" ? "建议复核纹理和残料风险" : "存在明显仿真风险";
  const suggestions: string[] = [];
  if (maxTextureMm > 0.035) suggestions.push("刀痕纹理偏大，建议降低 X/A 步距或改用更小球刀精修。");
  if (coverageRate < 92) suggestions.push("刀路覆盖不足，建议减小步距或检查夹持/过渡区是否过大。");
  if (restAreaRate === 0) suggestions.push("没有有效清残点，细节较深时建议使用清残刀路或更小刀具。");
  if (restAreaRate > 35) suggestions.push("清残占比偏高，可能说明模型细节过密或刀具偏大，建议先小样试雕。");
  if (maxOvercutMm > 0.02) suggestions.push("检测到过切风险，建议降低浮雕深度或提高安全余量。");

  return {
    score,
    verdict,
    summary,
    maxTextureMm,
    meanTextureMm,
    coverageRate,
    restAreaRate,
    maxOvercutMm,
    maxUndercutMm,
    metrics,
    suggestions: suggestions.length > 0 ? suggestions : ["材料去除快览指标正常，可继续进行模拟雕刻和离料空跑。"]
  };
}

function removeSafeMoves(points: ToolpathPoint[], settings: ModelSettings) {
  const safeCutoff = settings.safeZ * 0.92;
  return points.filter((point) => Number.isFinite(point.z) && point.z < safeCutoff);
}

function estimateScallopHeight(stepMm: number, toolRadiusMm: number) {
  if (stepMm <= 0 || toolRadiusMm <= 0) return 0;
  const halfStep = stepMm / 2;
  if (halfStep >= toolRadiusMm) return toolRadiusMm;
  return toolRadiusMm - Math.sqrt(Math.max(0, toolRadiusMm * toolRadiusMm - halfStep * halfStep));
}

function estimateCoverageRate(points: ToolpathPoint[], settings: ModelSettings) {
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
