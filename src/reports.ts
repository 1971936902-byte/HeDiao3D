import type { CostEstimate } from "./costEstimate";
import type { MachineProfile, MaterialProfile, SafetyIssue, ToolProfile } from "./manufacturingProfiles";
import type { ManufacturingQualityReport } from "./quality";
import type { GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";

export type ManufacturingReportInput = {
  settings: ModelSettings;
  sourceLabel: string;
  aiMeshUrl: string | null;
  aiMeshStlUrl: string | null;
  toolpath: GeneratedToolpath;
  tool: ToolProfile;
  material: MaterialProfile;
  machine: MachineProfile;
  safetyIssues: SafetyIssue[];
  manufacturingQuality: ManufacturingQualityReport;
  meshQuality: MeshQualityReport | null;
  costEstimate: CostEstimate | null;
};

export function createSafetyReport(input: ManufacturingReportInput) {
  const critical = input.safetyIssues.filter((issue) => issue.level === "critical");
  return {
    createdAt: new Date().toISOString(),
    verdict: critical.length > 0 ? "blocked" : "ready_for_air_cut",
    source: {
      label: input.sourceLabel,
      aiMeshUrl: input.aiMeshUrl,
      aiMeshStlUrl: input.aiMeshStlUrl
    },
    machine: input.machine,
    tool: input.tool,
    material: input.material,
    settings: input.settings,
    toolpathSummary: input.toolpath.summary,
    safetyIssues: input.safetyIssues
  };
}

export function createSafetyReportMarkdown(input: ManufacturingReportInput) {
  const report = createSafetyReport(input);
  const criticalCount = input.safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = input.safetyIssues.filter((issue) => issue.level === "warning").length;
  return [
    "# 核雕 CAM 上机前安全报告",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `结论：${report.verdict === "blocked" ? "禁止直接上机" : "可进入离料空跑验证"}`,
    `阻断项：${criticalCount}`,
    `提醒项：${warningCount}`,
    "",
    "## 机床与工艺",
    "",
    `- 机床：${input.machine.name}`,
    `- 控制系统：${input.machine.controller}`,
    `- 刀具：${input.tool.name}`,
    `- 材料：${input.material.name}`,
    `- 毛坯左/中/右直径：${input.settings.blankLeftDiameterMm.toFixed(1)} / ${input.settings.blankCenterDiameterMm.toFixed(1)} / ${input.settings.blankRightDiameterMm.toFixed(1)} mm`,
    `- 左/右夹持：${input.settings.leftHoldMm.toFixed(1)} / ${input.settings.rightHoldMm.toFixed(1)} mm`,
    `- 安全高度：${input.settings.safeZ.toFixed(2)} mm`,
    "",
    "## 刀路范围",
    "",
    `- X：${input.toolpath.summary.xMin.toFixed(2)} ~ ${input.toolpath.summary.xMax.toFixed(2)} mm`,
    `- A：${input.toolpath.summary.aMin.toFixed(2)} ~ ${input.toolpath.summary.aMax.toFixed(2)}°`,
    `- Z：${input.toolpath.summary.zMin.toFixed(2)} ~ ${input.toolpath.summary.zMax.toFixed(2)} mm`,
    `- 最大深度：${input.toolpath.summary.maxDepth.toFixed(2)} mm`,
    "",
    "## 风险项",
    "",
    ...input.safetyIssues.map((issue) => `- [${issue.level}] ${issue.title}：${issue.detail}${issue.command ? `\n  - 指令：\`${issue.command}\`` : ""}`),
    "",
    "## 操作建议",
    "",
    "- 首次上机必须先离料空跑，确认 X/A/Z 方向和 A 轴连续性。",
    "- 存在 critical 阻断项时，不建议下载后的 NC/TAP 直接上机。",
    "- 存在 A 轴跳变提醒时，请确认控制系统是否支持该角度跳转，必要时调整包覆策略或后处理。",
    "- 毛坯直径差异较大时，请保守增加端部过渡和夹持保留。"
  ].join("\n");
}

export function createQualityReport(input: ManufacturingReportInput) {
  return {
    createdAt: new Date().toISOString(),
    manufacturingQuality: input.manufacturingQuality,
    meshQuality: input.meshQuality,
    toolpath: {
      points: input.toolpath.points.length,
      estimatedMinutes: input.toolpath.estimatedMinutes,
      roughMinutes: input.toolpath.programs?.rough?.estimatedMinutes ?? null,
      finishMinutes: input.toolpath.programs?.finish?.estimatedMinutes ?? null,
      warnings: input.toolpath.summary.warnings
    }
  };
}

export function createPackageManifest(input: ManufacturingReportInput) {
  return {
    packageVersion: "V2",
    createdAt: new Date().toISOString(),
    sourceLabel: input.sourceLabel,
    files: [
      "nc/nuclear-carving-combined.nc",
      input.toolpath.programs?.rough ? "nc/nuclear-carving-rough.nc" : null,
      input.toolpath.programs?.finish ? "nc/nuclear-carving-finish.nc" : null,
      "nc/nuclear-carving-toolpath.tap",
      "nc/nuclear-carving-toolpath.txt",
      "nc/nuclear-carving-toolpath.csv",
      "reports/safety-report.json",
      "reports/quality-report.json",
      "reports/cost-estimate.json",
      "operator-note.md"
    ].filter(Boolean),
    modelReferences: {
      previewGlb: input.aiMeshUrl,
      sourceStl: input.aiMeshStlUrl,
      note: input.aiMeshUrl || input.aiMeshStlUrl ? "模型文件当前以本地 URL 形式引用，必要时请从页面单独下载 GLB/STL。" : "本地浮雕 STL 请从页面单独下载。"
    }
  };
}
