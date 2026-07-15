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
