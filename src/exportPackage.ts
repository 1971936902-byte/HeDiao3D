import type { GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";
import type { MachineProfile, MaterialProfile, SafetyIssue, ToolProfile } from "./manufacturingProfiles";
import type { ManufacturingQualityReport } from "./quality";

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
  meshQuality: MeshQualityReport | null;
};

export function createOperatorPackageMarkdown(input: ExportPackageInput) {
  const createdAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const files = [
    input.aiMeshUrl ? `- \`preview.glb\`：${input.aiMeshUrl}` : "- `nuclear-carving-relief.stl`：本地浮雕 STL",
    input.aiMeshStlUrl ? `- \`source.stl\`：${input.aiMeshStlUrl}` : "- `source.stl`：请从页面下载当前浮雕 STL",
    "- `nuclear-carving-combined.nc`：合并加工程序",
    input.toolpath.programs?.rough ? "- `nuclear-carving-rough.nc`：粗加工程序" : "- `nuclear-carving-rough.nc`：当前无独立粗加工程序",
    input.toolpath.programs?.finish ? "- `nuclear-carving-finish.nc`：精加工程序" : "- `nuclear-carving-finish.nc`：当前无独立精加工程序",
    "- `nuclear-carving-toolpath.tap/txt/csv`：兼容导出文件",
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
    `- X 步距：${input.settings.stepoverMm.toFixed(3)} mm`,
    `- A 步距：${input.settings.stepoverDeg.toFixed(2)}°`,
    `- 安全高度：${input.settings.safeZ.toFixed(2)} mm`,
    `- 左/右夹持：${input.settings.leftHoldMm.toFixed(1)} / ${input.settings.rightHoldMm.toFixed(1)} mm`,
    `- 端部过渡：${input.settings.endTransitionMm.toFixed(1)} mm`,
    "",
    "## 3. 刀路摘要",
    "",
    `- 总点数：${input.toolpath.points.length}`,
    `- 估算总时间：${input.toolpath.estimatedMinutes.toFixed(1)} min`,
    input.toolpath.programs?.rough ? `- 粗加工时间：${input.toolpath.programs.rough.estimatedMinutes.toFixed(1)} min` : "- 粗加工时间：无独立程序",
    input.toolpath.programs?.finish ? `- 精加工时间：${input.toolpath.programs.finish.estimatedMinutes.toFixed(1)} min` : "- 精加工时间：无独立程序",
    `- X 范围：${input.toolpath.summary.xMin.toFixed(2)} ~ ${input.toolpath.summary.xMax.toFixed(2)} mm`,
    `- A 范围：${input.toolpath.summary.aMin.toFixed(2)} ~ ${input.toolpath.summary.aMax.toFixed(2)}°`,
    `- Z 范围：${input.toolpath.summary.zMin.toFixed(2)} ~ ${input.toolpath.summary.zMax.toFixed(2)} mm`,
    "",
    "## 4. 导出前安全校验",
    "",
    ...input.safetyIssues.map((issue) => `- [${issue.level}] ${issue.title}：${issue.detail}`),
    "",
    "## 5. 加工质量体检",
    "",
    `- 综合评分：${input.manufacturingQuality.score.toFixed(1)} / 100`,
    `- 结论：${input.manufacturingQuality.summary}`,
    ...input.manufacturingQuality.items.map((item) => `- [${item.status}] ${item.label}：${item.value}，${item.detail}`),
    "",
    "## 6. Mesh 质量体检",
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
          ...input.meshQuality.recommendations.map((item) => `- 建议：${item}`)
        ]
      : ["- 当前为本地浮雕或尚未完成 Mesh 体检。"]),
    "",
    "## 7. 上机建议",
    "",
    "- 首次使用请先离料空跑，确认 X/A/Z 方向正确。",
    "- 首刀建议把进给降低到 50%-70%，确认无撞刀后再恢复。",
    "- 检查夹具两端是否留有足够夹持区，粉色区域不应进入雕刻范围。",
    "- 若安全校验存在 critical 阻断项，不建议直接上机。",
    "- 若 Mesh 采样未命中点集中在端部或顶部，建议先修复 Mesh 或调整 CAM 长轴。"
  ].join("\n");
}
