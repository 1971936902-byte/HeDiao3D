import type { MachineProfile, MaterialProfile, ToolProfile } from "./manufacturingProfiles";
import type { GeneratedToolpath, ModelSettings } from "./types";

export type CostEstimate = {
  machiningMinutes: number;
  setupMinutes: number;
  toolChangeMinutes: number;
  inspectionMinutes: number;
  totalMinutes: number;
  machineCostLow: number;
  machineCostHigh: number;
  materialCost: number;
  toolWearCost: number;
  totalCostLow: number;
  totalCostHigh: number;
  confidence: "rough" | "review" | "usable";
  assumptions: string[];
};

const materialBlankCost: Record<string, number> = {
  "olive-core": 12,
  "peach-core": 6,
  "ivory-nut": 18,
  "resin-test": 3
};

const machineHourlyRate: Record<MachineProfile["controller"], { low: number; high: number }> = {
  generic: { low: 30, high: 60 },
  weihong: { low: 45, high: 80 },
  syntec: { low: 55, high: 95 }
};

const toolLifeMinutesByType: Record<ToolProfile["type"], number> = {
  ball: 420,
  flat: 520,
  taper: 260,
  "v-bit": 300,
  micro: 180
};

const toolReplacementCostByType: Record<ToolProfile["type"], number> = {
  ball: 18,
  flat: 14,
  taper: 28,
  "v-bit": 22,
  micro: 30
};

export function createCostEstimate(
  settings: ModelSettings,
  toolpath: GeneratedToolpath | null,
  tool: ToolProfile,
  material: MaterialProfile,
  machine: MachineProfile
): CostEstimate | null {
  if (!toolpath) return null;

  const programMinutes = {
    rough: toolpath.programs?.rough?.estimatedMinutes ?? 0,
    finish: toolpath.programs?.finish?.estimatedMinutes ?? 0,
    rest: toolpath.programs?.rest?.estimatedMinutes ?? 0
  };
  const knownSplitMinutes = programMinutes.rough + programMinutes.finish + programMinutes.rest;
  const machiningMinutes = Math.max(toolpath.estimatedMinutes, knownSplitMinutes);
  const hasSeparatePrograms = Boolean(toolpath.programs?.rough && toolpath.programs?.finish);
  const hasRestProgram = Boolean(toolpath.programs?.rest && toolpath.programs.rest.points.length > 0);
  const setupMinutes = 12 + (settings.meshLengthAxis === "auto" ? 2 : 0) + (material.density === "hard" ? 3 : 0);
  const toolChangeMinutes = hasSeparatePrograms ? (hasRestProgram ? 6 : 4) : 0;
  const inspectionMinutes = 5 + (machiningMinutes > 180 ? 5 : 0);
  const totalMinutes = machiningMinutes + setupMinutes + toolChangeMinutes + inspectionMinutes;
  const rate = machineHourlyRate[machine.controller];
  const machineCostLow = (totalMinutes / 60) * rate.low;
  const machineCostHigh = (totalMinutes / 60) * rate.high;
  const materialCost = materialBlankCost[material.id] ?? 10;
  const toolLifeMinutes = toolLifeMinutesByType[tool.type] * (material.density === "hard" ? 0.75 : material.density === "soft" ? 1.25 : 1);
  const toolWearCost = Math.max(1, (machiningMinutes / toolLifeMinutes) * toolReplacementCostByType[tool.type]);
  const uncertainty = machiningMinutes > 240 ? 1.18 : machiningMinutes > 90 ? 1.12 : 1.08;
  const totalCostLow = machineCostLow + materialCost + toolWearCost;
  const totalCostHigh = (machineCostHigh + materialCost + toolWearCost) * uncertainty;
  const confidence: CostEstimate["confidence"] =
    toolpath.summary.warnings.length > 2 || settings.meshLengthAxis === "auto"
      ? "rough"
      : hasSeparatePrograms
        ? "usable"
        : "review";

  const assumptions = [
    `机床小时费按 ${rate.low}-${rate.high} 元/小时估算。`,
    `准备 ${setupMinutes.toFixed(0)} 分钟，换刀 ${toolChangeMinutes.toFixed(0)} 分钟，首件检查 ${inspectionMinutes.toFixed(0)} 分钟。`,
    hasSeparatePrograms ? `已按粗加工/精加工${hasRestProgram ? "/清残" : ""}独立程序估算。` : "当前未完整区分粗精加工，机时误差会偏大。",
    "未计入装夹返工、断刀、人工修边和批量排产等待时间。"
  ];

  return {
    machiningMinutes,
    setupMinutes,
    toolChangeMinutes,
    inspectionMinutes,
    totalMinutes,
    machineCostLow,
    machineCostHigh,
    materialCost,
    toolWearCost,
    totalCostLow,
    totalCostHigh,
    confidence,
    assumptions
  };
}

export function formatCurrencyRange(low: number, high: number) {
  return `¥${low.toFixed(0)}-${high.toFixed(0)}`;
}
