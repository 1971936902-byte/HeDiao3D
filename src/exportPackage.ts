import type { GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";
import type { MachineProfile, MaterialProfile, SafetyIssue, ToolProfile } from "./manufacturingProfiles";
import type { ManufacturingQualityReport } from "./quality";
import type { CostEstimate } from "./costEstimate";
import { formatCurrencyRange } from "./costEstimate";
import type { MaterialRemovalReport } from "./simulationAnalysis";

type ExportPackageInput = {
  settings: ModelSettings;
  toolpath: GeneratedToolpath;
  sourceLabel: string;
  aiMeshUrl: string | null;
  aiMeshStlUrl: string | null;
  tool: ToolProfile;
  material: MaterialProfile;
  machine: MachineProfile;
  safetyIssues: SafetyIssue[];
  manufacturingQuality: ManufacturingQualityReport;
  materialRemoval: MaterialRemovalReport | null;
  meshQuality: MeshQualityReport | null;
  costEstimate: CostEstimate | null;
  machineAcceptance?: {
    machineId: string;
    machineName: string;
    controller: MachineProfile["controller"];
    updatedAt: string;
    airRun: boolean;
    airRunAt: string | null;
    softTrial: boolean;
    softTrialAt: string | null;
    formalTrial: boolean;
    formalTrialAt: string | null;
    notes: string;
  } | null;
  exportGate?: {
    safetyReportReviewed: boolean;
    airRunVerified: boolean;
    fixtureConfirmed: boolean;
  };
  safetyGate?: {
    level: string;
    title: string;
    detail: string;
    productionUnlocked: boolean;
  };
};

export function createOperatorPackageMarkdown(input: ExportPackageInput) {
  const createdAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const files = [
    input.aiMeshUrl ? `- \`models/model-download-links.md\`：AI Mesh GLB/STL 下载引用` : "- `models/source.stl`：本地浮雕 STL",
    "- `preview/simulation-result.png`：导出时右侧 3D/仿真视图截图",
    "- `preview/preview-index.md`：预览视图索引与复核顺序",
    "- `parameters.json`：机床、刀具、材料、刀路和质量参数快照",
    "- `nuclear-carving-air-run.nc`：离料空跑程序，主轴关闭，Z 保持安全高度，仅验证机器动作",
    "- `nuclear-carving-combined.nc`：合并加工程序",
    input.toolpath.programs?.rough ? "- `nuclear-carving-rough.nc`：粗加工程序" : "- `nuclear-carving-rough.nc`：当前无独立粗加工程序",
    input.toolpath.programs?.finish ? "- `nuclear-carving-finish.nc`：精加工程序" : "- `nuclear-carving-finish.nc`：当前无独立精加工程序",
    input.toolpath.programs?.rest ? "- `nuclear-carving-rest.nc`：清残补加工程序，用于深纹理和高变化细节区域" : "- `nuclear-carving-rest.nc`：当前无独立清残程序",
    "- `nuclear-carving-toolpath.tap/txt/csv`：兼容导出文件",
    "- `reports/package-checklist.md`：交付检查清单",
    "- `reports/manufacturing-summary.md`：制造关键指标摘要",
    "- `operator-note.md`：本说明"
  ];

  return [
    "# 核雕 CAM 加工包说明",
    "",
    `生成时间：${createdAt}`,
    `模型来源：${input.sourceLabel}`,
    "",
    "## 1. 文件清单",
    "",
    ...files,
    "",
    "## 2. 机床与工艺",
    "",
    `- 机床：${input.machine.name}`,
    `- 控制系统：${input.machine.controller}`,
    `- 刀具：${input.tool.name}`,
    `- 材料：${input.material.name}`,
    `- 主轴：${input.settings.spindleRpm.toFixed(0)} rpm`,
    `- 进给：${input.settings.feedRate.toFixed(0)} mm/min`,
    `- 刀具直径：${input.settings.toolDiameter.toFixed(2)} mm`,
    `- 最大单层切深：${input.settings.maxCutDepth.toFixed(2)} mm`,
    `- 粗加工余量：${input.settings.stockAllowance.toFixed(2)} mm`,
    `- 毛坯 5 截面直径：${formatBlankProfileDiameters(input.settings)} mm`,
    `- X 步距：${input.settings.stepoverMm.toFixed(3)} mm`,
    `- A 步距：${input.settings.stepoverDeg.toFixed(2)}°`,
    `- 安全高度：${input.settings.safeZ.toFixed(2)} mm`,
    `- 左/右夹持：${input.settings.leftHoldMm.toFixed(1)} / ${input.settings.rightHoldMm.toFixed(1)} mm`,
    `- 端部过渡：${input.settings.endTransitionMm.toFixed(1)} mm`,
    "",
    "## 2.1 机床验收记录",
    "",
    ...(input.machineAcceptance
      ? [
          `- 离料空跑：${input.machineAcceptance.airRun ? `已通过（${input.machineAcceptance.airRunAt ?? "未记录时间"}）` : "未记录"}`,
          `- 软材料试雕：${input.machineAcceptance.softTrial ? `已通过（${input.machineAcceptance.softTrialAt ?? "未记录时间"}）` : "未记录"}`,
          `- 正式材料试雕：${input.machineAcceptance.formalTrial ? `已通过（${input.machineAcceptance.formalTrialAt ?? "未记录时间"}）` : "未记录"}`,
          `- 最近更新：${input.machineAcceptance.updatedAt || "未记录"}`,
          input.machineAcceptance.notes ? `- 备注：${input.machineAcceptance.notes}` : "- 备注：无"
        ]
      : ["- 未记录当前机床验收信息。"]),
    "",
    "## 2.2 正式导出闸口",
    "",
    ...(input.safetyGate
      ? [
          `- 安全等级：${input.safetyGate.title}`,
          `- 正式文件：${input.safetyGate.productionUnlocked ? "已解锁" : "锁定"}`,
          `- 说明：${input.safetyGate.detail}`,
          `- 安全报告：${input.exportGate?.safetyReportReviewed ? "已确认" : "未确认"}`,
          `- 离料空跑：${input.exportGate?.airRunVerified ? "已确认" : "未确认"}`,
          `- 夹持确认：${input.exportGate?.fixtureConfirmed ? "已确认" : "未确认"}`
        ]
      : ["- 未记录导出闸口状态。"]),
    "",
    "## 3. 刀路摘要",
    "",
    `- 总点数：${input.toolpath.points.length}`,
    `- 估算总时间：${input.toolpath.estimatedMinutes.toFixed(1)} min`,
    input.toolpath.programs?.rough ? `- 粗加工时间：${input.toolpath.programs.rough.estimatedMinutes.toFixed(1)} min` : "- 粗加工时间：无独立程序",
    input.toolpath.programs?.finish ? `- 精加工时间：${input.toolpath.programs.finish.estimatedMinutes.toFixed(1)} min` : "- 精加工时间：无独立程序",
    input.toolpath.programs?.rest ? `- 清残时间：${input.toolpath.programs.rest.estimatedMinutes.toFixed(1)} min` : "- 清残时间：无独立程序",
    ...(input.toolpath.summary.process
      ? [
          `- 粗加工层数：${input.toolpath.summary.process.roughPasses}`,
          `- 清残策略：${input.toolpath.summary.process.restStrategy}`,
          `- 清残触发：${input.toolpath.summary.process.restTrigger}`,
          `- 清残点占比：${input.toolpath.summary.process.restPointRate.toFixed(1)}%`
        ]
      : []),
    `- X 范围：${input.toolpath.summary.xMin.toFixed(2)} ~ ${input.toolpath.summary.xMax.toFixed(2)} mm`,
    `- A 范围：${input.toolpath.summary.aMin.toFixed(2)} ~ ${input.toolpath.summary.aMax.toFixed(2)}°`,
    `- Z 范围：${input.toolpath.summary.zMin.toFixed(2)} ~ ${input.toolpath.summary.zMax.toFixed(2)} mm`,
    "",
    "## 4. 工时与成本估算",
    "",
    ...(input.costEstimate
      ? [
          `- 切削机时：${input.costEstimate.machiningMinutes.toFixed(1)} min`,
          `- 准备/换刀/检查：${(input.costEstimate.setupMinutes + input.costEstimate.toolChangeMinutes + input.costEstimate.inspectionMinutes).toFixed(1)} min`,
          `- 预计总占机：${input.costEstimate.totalMinutes.toFixed(1)} min`,
          `- 机床费用：${formatCurrencyRange(input.costEstimate.machineCostLow, input.costEstimate.machineCostHigh)}`,
          `- 材料成本：¥${input.costEstimate.materialCost.toFixed(0)}`,
          `- 刀具损耗：¥${input.costEstimate.toolWearCost.toFixed(0)}`,
          `- 综合估算：${formatCurrencyRange(input.costEstimate.totalCostLow, input.costEstimate.totalCostHigh)}`,
          `- 可信度：${input.costEstimate.confidence}`,
          ...input.costEstimate.assumptions.map((item) => `- 估算依据：${item}`)
        ]
      : ["- 尚未生成刀路，无法估算工时和成本。"]),
    "",
    "## 5. 导出前安全校验",
    "",
    ...input.safetyIssues.map((issue) => `- [${issue.level}] ${issue.title}：${issue.detail}`),
    "",
    "## 6. 加工质量体检",
    "",
    `- 综合评分：${input.manufacturingQuality.score.toFixed(1)} / 100`,
    `- 结论：${input.manufacturingQuality.summary}`,
    ...input.manufacturingQuality.items.map((item) => `- [${item.status}] ${item.label}：${item.value}，${item.detail}`),
    "",
    "## 7. 材料去除仿真",
    "",
    ...(input.materialRemoval
      ? [
          `- 综合评分：${input.materialRemoval.score.toFixed(1)} / 100`,
          `- 结论：${input.materialRemoval.summary}`,
          `- 仿真模式：${input.materialRemoval.simulationMode}`,
          `- 刀具扫掠：${input.materialRemoval.toolGeometry.type} / 有效半径 ${input.materialRemoval.toolGeometry.effectiveRadiusMm.toFixed(3)}mm / 接触宽度 ${input.materialRemoval.toolGeometry.contactWidthMm.toFixed(3)}mm`,
          `- 估算最大刀痕：${(input.materialRemoval.maxTextureMm * 1000).toFixed(0)} μm`,
          `- 刀路覆盖率：${input.materialRemoval.coverageRate.toFixed(1)}%`,
          `- 扫掠覆盖率：${input.materialRemoval.sweptAreaRate.toFixed(1)}%`,
          `- 清残占比：${input.materialRemoval.restAreaRate.toFixed(1)}%`,
          `- 最大过切风险：${input.materialRemoval.maxOvercutMm.toFixed(3)} mm`,
          `- 最大欠切/残料：${input.materialRemoval.maxUndercutMm.toFixed(3)} mm`,
          `- 细节残料风险：${input.materialRemoval.residualRiskMm.toFixed(3)} mm`,
          ...input.materialRemoval.suggestions.map((item) => `- 建议：${item}`)
        ]
      : ["- 尚未生成刀路，无法完成材料去除仿真。"]),
    "",
    "## 8. Mesh 质量体检",
    "",
    ...(input.meshQuality
      ? [
          `- 综合评分：${input.meshQuality.score.toFixed(1)} / 100`,
          `- 结论：${input.meshQuality.verdict}`,
          `- 面数：${input.meshQuality.triangleCount.toLocaleString()}`,
          `- 边界边：${input.meshQuality.boundaryEdges}`,
          `- 非流形边：${input.meshQuality.nonManifoldEdges}`,
          `- 退化面：${input.meshQuality.degenerateFaces}`,
          `- 尺寸：${input.meshQuality.dimensions.x.toFixed(1)} x ${input.meshQuality.dimensions.y.toFixed(1)} x ${input.meshQuality.dimensions.z.toFixed(1)}`,
          `- 长轴：${input.meshQuality.detectedLongAxis.toUpperCase()}`,
          ...(input.meshQuality.regions?.map((region) => `- 区域风险：${region.label}，${region.detail}，风险 ${region.riskScore}`) ?? []),
          ...input.meshQuality.recommendations.map((item) => `- 建议：${item}`)
        ]
      : ["- 当前为本地浮雕或尚未完成 Mesh 体检。"]),
    "",
    "## 9. 上机建议",
    "",
    "- 首次使用请先运行 `nuclear-carving-air-run.nc` 离料空跑，确认 X/A/Z 方向正确。",
    "- 空跑程序主轴关闭且 Z 保持安全高度，但仍需确认 X/A 行程和夹具距离。",
    "- 首刀建议把进给降低到 50%-70%，确认无撞刀后再恢复。",
    "- 检查夹具两端是否留有足够夹持区，粉色区域不应进入雕刻范围。",
    "- 若安全校验存在 critical 阻断项，不建议直接上机。",
    "- 若 Mesh 采样未命中点集中在端部或顶部，建议先修复 Mesh 或调整 CAM 长轴。"
  ].join("\n");
}

function formatBlankProfileDiameters(settings: ModelSettings) {
  return [
    settings.blankLeftDiameterMm,
    settings.blankLeftMidDiameterMm,
    settings.blankCenterDiameterMm,
    settings.blankRightMidDiameterMm,
    settings.blankRightDiameterMm
  ].map((value) => value.toFixed(1)).join(" / ");
}
