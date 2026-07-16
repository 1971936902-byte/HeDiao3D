import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { BadgeInfo, Box, Calculator, Camera, Clock3, Cloud, Download, FileImage, Hammer, HardDrive, ImagePlus, KeyRound, Layers3, Library, Save, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, UploadCloud } from "lucide-react";
import { createAirRunProgram, generateToolpath, downloadText } from "./cam";
import { createBlankDepthMap, createDemoDepthMap, createReliefGeometry } from "./geometry";
import { assetUrlToDepthMap, blendDepthMaps, createMultiViewDepthMap, fileToDepthMap, processDepthMap } from "./imageProcessing";
import { DepthEditor } from "./DepthEditor";
import { AiMeshViewer } from "./AiMeshViewer";
import { exportGeometryAsStl, geometryToStlString } from "./modelExport";
import { ReliefViewer } from "./ReliefViewer";
import { SimulationViewer } from "./SimulationViewer";
import { createOperatorPackageMarkdown } from "./exportPackage";
import { createCostEstimate, formatCurrencyRange, type CostEstimate } from "./costEstimate";
import { createPackageManifest, createQualityReport, createSafetyReport, createSafetyReportMarkdown } from "./reports";
import { createZipBlob, downloadBlob, type ZipFile } from "./zipPackage";
import { ai3dProviders, getAi3dProvider, isProviderAvailable, type Ai3dProviderId } from "./aiProviders";
import { analyzeMaterialRemoval, type MaterialRemovalReport } from "./simulationAnalysis";
import {
  applyMachineProfile,
  applyMaterialProfile,
  applyProcessTemplate,
  applyToolProfile,
  getMachineProfile,
  getMaterialProfile,
  getToolProfile,
  hasCriticalIssue,
  machineProfiles,
  materialProfiles,
  processTemplates,
  toolProfiles,
  validateGcodeProgram,
  validateManufacturingSetup
} from "./manufacturingProfiles";
import { analyzeDepthMapQuality, createManufacturingQualityReport } from "./quality";
import type { ManufacturingQualityReport } from "./quality";
import type { CarvingImage, DepthMap, GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";
import type { MachineProfile, MaterialProfile, ProcessTemplate, SafetyIssue, ToolProfile } from "./manufacturingProfiles";

const defaultSettings: ModelSettings = {
  lengthMm: 38,
  diameterMm: 15,
  blankLeftDiameterMm: 13.8,
  blankCenterDiameterMm: 15,
  blankRightDiameterMm: 13.8,
  depthMm: 1.25,
  reliefAngleDeg: 220,
  contrast: 1.45,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  endTransitionMm: 1.2,
  toolDiameter: 0.6,
  stepoverDeg: 1.2,
  stepoverMm: 0.12,
  toolProfileId: "ball-0.6",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-4axis-generic",
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.16,
  stockAllowance: 0.12,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "generic"
};

type ToolpathKind = "rough" | "finish";
type WorkflowStage = "project" | "source" | "model" | "process" | "cam" | "tasks" | "deployment" | "feedback";
type WorkbenchView = "model" | "simulation" | "heatmap" | "gcode" | "report";
type UserRole = "designer" | "process" | "operator" | "admin";
type TaskEvent = {
  id: string;
  title: string;
  detail: string;
  status: "ok" | "warning" | "error";
  category: "source" | "model" | "process" | "cam" | "feedback";
  timestamp: string;
};

type TaskJob = {
  id: string;
  title: string;
  detail: string;
  status: "running" | "done" | "error" | "canceled";
  category: TaskEvent["category"];
  startedAt: number;
  startedLabel: string;
  finishedLabel?: string;
  durationMs?: number;
  progress: number;
  retryAction?: TaskRetryAction;
  logs: TaskJobLog[];
};

type TaskRetryAction = "generate-ai-mesh" | "repair-mesh" | "remesh" | "generate-toolpath" | "generate-finish-toolpath";

type TaskJobLog = {
  id: string;
  time: string;
  message: string;
};

type TaskSnapshot = {
  id: string;
  label: string;
  detail: string;
  settings: ModelSettings;
  sourceLabel: string;
  createdAt: string;
};

type MachineFeedback = {
  id: string;
  createdAt: string;
  outcome: "success" | "review" | "failed";
  sourceLabel: string;
  machineName: string;
  toolName: string;
  materialName: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  costEstimateRange: string | null;
  issues: string[];
  notes: string;
  photoName: string | null;
  photoUrl: string | null;
  settings: ModelSettings;
};

type FeedbackDraft = {
  outcome: MachineFeedback["outcome"];
  actualMinutes: string;
  notes: string;
  issues: string[];
  photoName: string | null;
  photoUrl: string | null;
};

type CostCalibrationReport = {
  sampleCount: number;
  averageRatio: number;
  averageErrorRate: number;
  calibratedTotalMinutes: number;
  calibratedCostLow: number;
  calibratedCostHigh: number;
  confidence: "none" | "low" | "medium" | "high";
  matchedSamples: MachineFeedback[];
};

type ProjectProfile = {
  projectName: string;
  customerName: string;
  projectCode: string;
  role: UserRole;
};

type DeploymentMode = "local-only" | "lan-proxy" | "cloud-hybrid";
type DeploymentProfile = {
  mode: DeploymentMode;
  apiKeyLocation: "server-env" | "browser-local" | "not-configured";
  assetStorage: "browser-cache" | "lan-server" | "cloud-bucket";
  computeTarget: "browser" | "lan-server" | "cloud-worker";
  meshCachePath: string;
  lanBaseUrl: string;
  cloudBaseUrl: string;
  allowExternalAssetLinks: boolean;
};

type ProjectArchive = {
  id: string;
  createdAt: string;
  projectName: string;
  customerName: string;
  projectCode: string;
  sourceLabel: string;
  machineName: string;
  toolName: string;
  materialName: string;
  hasToolpath: boolean;
  exportReady: boolean;
  feedbackCount: number;
};

type CaptureGuideSlot = {
  label: string;
  imageName: string | null;
  score: number | null;
  status: "ready" | "usable" | "retake" | "missing";
  hint: string;
};

type CaptureGuideReport = {
  score: number;
  verdict: "ready" | "usable" | "retake";
  summary: string;
  slots: CaptureGuideSlot[];
  suggestions: string[];
};

type ExportGateState = {
  safetyReportReviewed: boolean;
  airRunVerified: boolean;
  fixtureConfirmed: boolean;
};

const toolpathColors = {
  rough: 0xd2451e,
  finish: 0x8b5cf6,
  simulation: 0x00a676
};

const workflowStages: Array<{ id: WorkflowStage; label: string; hint: string }> = [
  { id: "project", label: "项目", hint: "客户/权限" },
  { id: "source", label: "素材", hint: "上传/载入" },
  { id: "model", label: "建模", hint: "3D/Meshy" },
  { id: "process", label: "工艺", hint: "刀具/机床" },
  { id: "cam", label: "CAM", hint: "刀路/导出" },
  { id: "tasks", label: "任务", hint: "历史/版本" },
  { id: "deployment", label: "部署", hint: "本地/云端" },
  { id: "feedback", label: "反馈", hint: "实机闭环" }
];

const CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY = "hediao3d.customProcessTemplates.v1";
const MACHINE_FEEDBACK_STORAGE_KEY = "hediao3d.machineFeedback.v1";
const PROJECT_PROFILE_STORAGE_KEY = "hediao3d.projectProfile.v1";
const PROJECT_ARCHIVE_STORAGE_KEY = "hediao3d.projectArchive.v1";
const DEPLOYMENT_PROFILE_STORAGE_KEY = "hediao3d.deploymentProfile.v1";
const defaultProjectProfile: ProjectProfile = {
  projectName: "核雕试雕项目",
  customerName: "默认客户",
  projectCode: "HD3D-V2",
  role: "admin"
};
const defaultDeploymentProfile: DeploymentProfile = {
  mode: "lan-proxy",
  apiKeyLocation: "server-env",
  assetStorage: "lan-server",
  computeTarget: "lan-server",
  meshCachePath: "./data/hediao3d-cache",
  lanBaseUrl: "http://192.168.1.10:5174",
  cloudBaseUrl: "",
  allowExternalAssetLinks: false
};
const defaultFeedbackDraft: FeedbackDraft = {
  outcome: "success",
  actualMinutes: "",
  notes: "",
  issues: [],
  photoName: null,
  photoUrl: null
};
const feedbackIssueOptions = ["过切", "欠切", "毛刺", "断刀", "端部残料", "夹持痕迹", "纹理丢失", "A轴错位"];

function loadCustomProcessTemplates(): ProcessTemplate[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProcessTemplate).slice(0, 16);
  } catch {
    return [];
  }
}

function loadMachineFeedback(): MachineFeedback[] {
  try {
    const raw = window.localStorage.getItem(MACHINE_FEEDBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMachineFeedback).slice(0, 40);
  } catch {
    return [];
  }
}

function loadProjectProfile(): ProjectProfile {
  try {
    const raw = window.localStorage.getItem(PROJECT_PROFILE_STORAGE_KEY);
    if (!raw) return defaultProjectProfile;
    const parsed = JSON.parse(raw);
    return isProjectProfile(parsed) ? parsed : defaultProjectProfile;
  } catch {
    return defaultProjectProfile;
  }
}

function loadProjectArchives(): ProjectArchive[] {
  try {
    const raw = window.localStorage.getItem(PROJECT_ARCHIVE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProjectArchive).slice(0, 30);
  } catch {
    return [];
  }
}

function loadDeploymentProfile(): DeploymentProfile {
  try {
    const raw = window.localStorage.getItem(DEPLOYMENT_PROFILE_STORAGE_KEY);
    if (!raw) return defaultDeploymentProfile;
    const parsed = JSON.parse(raw);
    return isDeploymentProfile(parsed) ? parsed : defaultDeploymentProfile;
  } catch {
    return defaultDeploymentProfile;
  }
}

function isProcessTemplate(value: unknown): value is ProcessTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Partial<ProcessTemplate>;
  return (
    typeof template.id === "string" &&
    typeof template.name === "string" &&
    typeof template.intent === "string" &&
    typeof template.toolProfileId === "string" &&
    typeof template.materialProfileId === "string" &&
    typeof template.maxCutDepth === "number" &&
    typeof template.stockAllowance === "number" &&
    typeof template.stepoverMm === "number" &&
    typeof template.stepoverDeg === "number" &&
    typeof template.feedRate === "number" &&
    typeof template.spindleRpm === "number" &&
    typeof template.finishingStrategy === "string" &&
    typeof template.notes === "string"
  );
}

function isMachineFeedback(value: unknown): value is MachineFeedback {
  if (!value || typeof value !== "object") return false;
  const feedback = value as Partial<MachineFeedback>;
  return (
    typeof feedback.id === "string" &&
    typeof feedback.createdAt === "string" &&
    (feedback.outcome === "success" || feedback.outcome === "review" || feedback.outcome === "failed") &&
    typeof feedback.sourceLabel === "string" &&
    typeof feedback.machineName === "string" &&
    typeof feedback.toolName === "string" &&
    typeof feedback.materialName === "string" &&
    Array.isArray(feedback.issues) &&
    typeof feedback.notes === "string" &&
    Boolean(feedback.settings)
  );
}

function isProjectProfile(value: unknown): value is ProjectProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<ProjectProfile>;
  return (
    typeof profile.projectName === "string" &&
    typeof profile.customerName === "string" &&
    typeof profile.projectCode === "string" &&
    isUserRole(profile.role)
  );
}

function isProjectArchive(value: unknown): value is ProjectArchive {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectArchive>;
  return (
    typeof item.id === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.projectName === "string" &&
    typeof item.customerName === "string" &&
    typeof item.projectCode === "string" &&
    typeof item.sourceLabel === "string" &&
    typeof item.machineName === "string" &&
    typeof item.toolName === "string" &&
    typeof item.materialName === "string" &&
    typeof item.hasToolpath === "boolean" &&
    typeof item.exportReady === "boolean" &&
    typeof item.feedbackCount === "number"
  );
}

function isDeploymentProfile(value: unknown): value is DeploymentProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<DeploymentProfile>;
  return (
    isDeploymentMode(profile.mode) &&
    (profile.apiKeyLocation === "server-env" || profile.apiKeyLocation === "browser-local" || profile.apiKeyLocation === "not-configured") &&
    (profile.assetStorage === "browser-cache" || profile.assetStorage === "lan-server" || profile.assetStorage === "cloud-bucket") &&
    (profile.computeTarget === "browser" || profile.computeTarget === "lan-server" || profile.computeTarget === "cloud-worker") &&
    typeof profile.meshCachePath === "string" &&
    typeof profile.lanBaseUrl === "string" &&
    typeof profile.cloudBaseUrl === "string" &&
    typeof profile.allowExternalAssetLinks === "boolean"
  );
}

function isDeploymentMode(mode: unknown): mode is DeploymentMode {
  return mode === "local-only" || mode === "lan-proxy" || mode === "cloud-hybrid";
}

function isUserRole(role: unknown): role is UserRole {
  return role === "designer" || role === "process" || role === "operator" || role === "admin";
}

export function App() {
  const [images, setImages] = useState<CarvingImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [activeStage, setActiveStage] = useState<WorkflowStage>("project");
  const [wireframe, setWireframe] = useState(false);
  const [toolpath, setToolpath] = useState<GeneratedToolpath | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [generatedDepth, setGeneratedDepth] = useState<DepthMap | null>(null);
  const [generationLabel, setGenerationLabel] = useState("内置示例");
  const [aiMeshUrl, setAiMeshUrl] = useState<string | null>(null);
  const [aiMeshStlUrl, setAiMeshStlUrl] = useState<string | null>(null);
  const [aiMeshStatus, setAiMeshStatus] = useState("未生成");
  const [aiProviderId, setAiProviderId] = useState<Ai3dProviderId>("meshy");
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isMeshRepairing, setIsMeshRepairing] = useState(false);
  const [isToolpathGenerating, setIsToolpathGenerating] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("model");
  const [toolpathKind, setToolpathKind] = useState<ToolpathKind>("rough");
  const [meshQuality, setMeshQuality] = useState<MeshQualityReport | null>(null);
  const [meshQualityStatus, setMeshQualityStatus] = useState("等待 STL 模型");
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [taskJobs, setTaskJobs] = useState<TaskJob[]>([]);
  const [selectedTaskJobId, setSelectedTaskJobId] = useState<string | null>(null);
  const [taskSnapshots, setTaskSnapshots] = useState<TaskSnapshot[]>([]);
  const [customProcessTemplates, setCustomProcessTemplates] = useState<ProcessTemplate[]>(loadCustomProcessTemplates);
  const [machineFeedback, setMachineFeedback] = useState<MachineFeedback[]>(loadMachineFeedback);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>(defaultFeedbackDraft);
  const [projectProfile, setProjectProfile] = useState<ProjectProfile>(loadProjectProfile);
  const [projectArchives, setProjectArchives] = useState<ProjectArchive[]>(loadProjectArchives);
  const [deploymentProfile, setDeploymentProfile] = useState<DeploymentProfile>(loadDeploymentProfile);
  const [exportGate, setExportGate] = useState<ExportGateState>({
    safetyReportReviewed: false,
    airRunVerified: false,
    fixtureConfirmed: false
  });
  const canceledTaskJobIdsRef = useRef<Set<string>>(new Set());

  const activeImage = images.find((image) => image.id === activeId) ?? images[0];
  const sourceDepth = generatedDepth ?? createBlankDepthMap();
  const processedDepth = useMemo(
    () => processDepthMap(sourceDepth, settings.contrast, settings.invertDepth, settings.smoothPasses),
    [sourceDepth, settings.contrast, settings.invertDepth, settings.smoothPasses]
  );
  const geometry = useMemo(() => createReliefGeometry(processedDepth, settings), [processedDepth, settings]);
  const isMultiviewGenerated = generationLabel.startsWith("本地360°环绕浮雕");
  const envelopeQuality = useMemo(() => (toolpath ? analyzeEnvelopeQuality(toolpath, settings) : null), [toolpath, settings]);
  const selectedTool = useMemo(() => getToolProfile(settings.toolProfileId), [settings.toolProfileId]);
  const selectedMaterial = useMemo(() => getMaterialProfile(settings.materialProfileId), [settings.materialProfileId]);
  const selectedMachine = useMemo(() => getMachineProfile(settings.machineProfileId), [settings.machineProfileId]);
  const selectedAiProvider = useMemo(() => getAi3dProvider(aiProviderId), [aiProviderId]);
  const allProcessTemplates = useMemo(
    () => [...processTemplates, ...customProcessTemplates],
    [customProcessTemplates]
  );
  const safetyIssues = useMemo(() => [...validateManufacturingSetup(settings, toolpath), ...validateGcodeProgram(settings, toolpath)], [settings, toolpath]);
  const exportBlocked = hasCriticalIssue(safetyIssues);
  const exportGateReady = Boolean(toolpath && !exportBlocked && exportGate.safetyReportReviewed && exportGate.airRunVerified && exportGate.fixtureConfirmed);
  const isOperatorMode = projectProfile.role === "operator";
  const canDownloadProduction = !isOperatorMode || exportGateReady;
  const productionDownloadTitle = getProductionDownloadTitle(isOperatorMode, exportBlocked, exportGateReady);
  const activeQuality = activeImage?.quality;
  const captureGuide = useMemo(() => createCaptureGuideReport(images), [images]);
  const manufacturingQuality = useMemo(
    () => createManufacturingQualityReport(settings, toolpath, safetyIssues, envelopeQuality),
    [settings, toolpath, safetyIssues, envelopeQuality]
  );
  const materialRemoval = useMemo(() => analyzeMaterialRemoval(settings, toolpath), [settings, toolpath]);
  const costEstimate = useMemo(
    () => createCostEstimate(settings, toolpath, selectedTool, selectedMaterial, selectedMachine),
    [settings, toolpath, selectedTool, selectedMaterial, selectedMachine]
  );
  const costCalibration = useMemo(
    () => createCostCalibrationReport(costEstimate, machineFeedback, selectedMachine.name, selectedTool.name),
    [costEstimate, machineFeedback, selectedMachine.name, selectedTool.name]
  );
  const deploymentReadiness = useMemo(() => createDeploymentReadiness(deploymentProfile), [deploymentProfile]);
  const airRunProgram = useMemo(
    () => (toolpath ? toolpath.programs?.airRun ?? createAirRunProgram(toolpath.programs?.combined?.points ?? toolpath.points, settings, toolpath.estimatedMinutes) : null),
    [settings, toolpath]
  );
  const viewingSimulation = workbenchView === "simulation" && Boolean(toolpath);
  const workbenchTitle =
    workbenchView === "simulation" && toolpath
      ? "模拟雕刻"
      : workbenchView === "heatmap" && toolpath
        ? "误差热力图"
      : workbenchView === "gcode" && toolpath
        ? "G-code 预览"
        : workbenchView === "report" && toolpath
          ? "报告摘要"
          : generationLabel;
  const workbenchHint =
    workbenchView === "simulation" && toolpath
      ? "按当前刀路反推雕刻包络曲面，用于下载前检查方向、深浅和包覆范围"
      : workbenchView === "heatmap" && toolpath
        ? "按 X/A 网格显示包络贴合率，粉红区域代表未贴合或采样风险"
      : workbenchView === "gcode" && toolpath
        ? "查看合并程序的前后处理、运动指令和安全高度，不在这里编辑机床代码"
        : workbenchView === "report" && toolpath
          ? "汇总安全、质量、材料去除和成本指标，辅助试雕前复核"
          : "拖动旋转查看 360° 视图，滚轮缩放，右键平移";

  useEffect(() => {
    setExportGate({
      safetyReportReviewed: false,
      airRunVerified: false,
      fixtureConfirmed: false
    });
  }, [toolpath]);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_PROCESS_TEMPLATE_STORAGE_KEY, JSON.stringify(customProcessTemplates));
  }, [customProcessTemplates]);

  useEffect(() => {
    window.localStorage.setItem(MACHINE_FEEDBACK_STORAGE_KEY, JSON.stringify(machineFeedback));
  }, [machineFeedback]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_PROFILE_STORAGE_KEY, JSON.stringify(projectProfile));
  }, [projectProfile]);

  useEffect(() => {
    window.localStorage.setItem(PROJECT_ARCHIVE_STORAGE_KEY, JSON.stringify(projectArchives));
  }, [projectArchives]);

  useEffect(() => {
    window.localStorage.setItem(DEPLOYMENT_PROFILE_STORAGE_KEY, JSON.stringify(deploymentProfile));
  }, [deploymentProfile]);

  useEffect(() => {
    if (!aiMeshStlUrl) {
      setMeshQuality(null);
      setMeshQualityStatus("等待 STL 模型");
      return;
    }

    let cancelled = false;
    setMeshQuality(null);
    setMeshQualityStatus("正在体检 Mesh");

    fetch("/api/mesh/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stlUrl: aiMeshStlUrl })
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Mesh 体检失败");
        }
        return data as MeshQualityReport;
      })
      .then((report) => {
        if (cancelled) return;
        setMeshQuality(report);
        setMeshQualityStatus(report.verdict === "ready" ? "Mesh 体检通过" : report.verdict === "review" ? "Mesh 需要复核" : "Mesh 建议修复");
      })
      .catch((error) => {
        if (cancelled) return;
        setMeshQualityStatus(error instanceof Error ? error.message : "Mesh 体检失败");
      });

    return () => {
      cancelled = true;
    };
  }, [aiMeshStlUrl]);

  const updateSetting = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const recordTask = (event: Omit<TaskEvent, "id" | "timestamp">) => {
    setTaskEvents((current) => [
      {
        ...event,
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleString("zh-CN", { hour12: false })
      },
      ...current
    ].slice(0, 80));
  };

  const startTaskJob = (job: Pick<TaskJob, "title" | "detail" | "category" | "retryAction">) => {
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    canceledTaskJobIdsRef.current.delete(id);
    setTaskJobs((current) => [
      {
        ...job,
        id,
        status: "running",
        startedAt,
        startedLabel: new Date(startedAt).toLocaleString("zh-CN", { hour12: false }),
        progress: 8,
        logs: [createTaskJobLog(`开始：${job.detail}`)]
      },
      ...current
    ].slice(0, 24));
    return id;
  };

  const finishTaskJob = (id: string, status: TaskJob["status"], detail: string) => {
    const finishedAt = Date.now();
    setTaskJobs((current) =>
      current.map((job) =>
        job.id === id
          ? job.status === "canceled"
            ? job
            : {
              ...job,
              status,
              detail,
              progress: status === "done" ? 100 : status === "error" ? Math.max(job.progress, 100) : job.progress,
              durationMs: Math.max(0, finishedAt - job.startedAt),
              finishedLabel: new Date(finishedAt).toLocaleString("zh-CN", { hour12: false }),
              logs: [...job.logs, createTaskJobLog(`${status === "done" ? "完成" : status === "error" ? "失败" : "结束"}：${detail}`)]
            }
          : job
      )
    );
  };

  const appendTaskJobLog = (id: string, message: string, progress?: number) => {
    setTaskJobs((current) =>
      current.map((job) =>
        job.id === id
          ? {
              ...job,
              progress: progress === undefined ? job.progress : THREEClamp(progress, job.progress, 98),
              logs: [...job.logs, createTaskJobLog(message)].slice(-40),
              detail: message
            }
          : job
      )
    );
  };

  const isTaskJobCanceled = (id: string) => canceledTaskJobIdsRef.current.has(id);

  const cancelTaskJob = (job: TaskJob) => {
    if (job.status !== "running") return;
    canceledTaskJobIdsRef.current.add(job.id);
    const finishedAt = Date.now();
    setTaskJobs((current) =>
      current.map((item) =>
        item.id === job.id
          ? {
              ...item,
              status: "canceled",
              detail: "用户已取消。若远端任务已经提交，后台服务可能仍会完成，但本页面不会自动采用结果。",
              durationMs: Math.max(0, finishedAt - item.startedAt),
              finishedLabel: new Date(finishedAt).toLocaleString("zh-CN", { hour12: false }),
              logs: [...item.logs, createTaskJobLog("用户取消任务。")]
            }
          : item
      )
    );
    recordTask({
      category: job.category,
      status: "warning",
      title: `取消任务：${job.title}`,
      detail: "已在任务中心标记取消；如为远端 AI 任务，请以服务端最终状态为准。"
    });
  };

  const retryTaskJob = async (job: TaskJob) => {
    if (!job.retryAction || job.status === "running") return;
    recordTask({
      category: job.category,
      status: "warning",
      title: `重试任务：${job.title}`,
      detail: "已按当前页面参数重新发起任务。"
    });
    if (job.retryAction === "generate-ai-mesh") await handleGenerateAiMesh();
    if (job.retryAction === "repair-mesh") await handleRepairMesh();
    if (job.retryAction === "remesh") await handleRemesh();
    if (job.retryAction === "generate-toolpath") await generateToolpathForSettings(settings, false);
    if (job.retryAction === "generate-finish-toolpath") await handleGenerateFinishingToolpath();
  };

  const saveSnapshot = (label: string, snapshotSettings: ModelSettings, detail: string) => {
    setTaskSnapshots((current) => [
      {
        id: crypto.randomUUID(),
        label,
        detail,
        settings: { ...snapshotSettings },
        sourceLabel: generationLabel,
        createdAt: new Date().toLocaleString("zh-CN", { hour12: false })
      },
      ...current
    ].slice(0, 24));
  };

  const restoreSnapshot = (snapshot: TaskSnapshot) => {
    setSettings(snapshot.settings);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    recordTask({
      category: "process",
      status: "ok",
      title: `回退参数版本：${snapshot.label}`,
      detail: `${snapshot.detail}；请重新生成刀路验证。`
    });
  };

  const handleSaveCurrentSnapshot = () => {
    saveSnapshot("手动保存参数", settings, `来源：${generationLabel}`);
    recordTask({
      category: "process",
      status: "ok",
      title: "手动保存参数版本",
      detail: "已保存当前刀具、材料、机床、步距、进给和夹持参数。"
    });
  };

  const updateProjectProfile = <K extends keyof ProjectProfile>(key: K, value: ProjectProfile[K]) => {
    setProjectProfile((current) => ({ ...current, [key]: value }));
  };

  const updateDeploymentProfile = <K extends keyof DeploymentProfile>(key: K, value: DeploymentProfile[K]) => {
    setDeploymentProfile((current) => ({ ...current, [key]: value }));
  };

  const handleSaveProjectProfile = () => {
    recordTask({
      category: "process",
      status: "ok",
      title: "保存项目档案",
      detail: `${projectProfile.projectCode} / ${projectProfile.customerName} / ${formatUserRole(projectProfile.role)}`
    });
  };

  const handleSaveDeploymentProfile = () => {
    recordTask({
      category: "process",
      status: deploymentReadiness.level === "critical" ? "warning" : "ok",
      title: "保存部署与安全方案",
      detail: `${formatDeploymentMode(deploymentProfile.mode)} / ${formatApiKeyLocation(deploymentProfile.apiKeyLocation)} / ${formatComputeTarget(deploymentProfile.computeTarget)}`
    });
  };

  const handleArchiveProject = () => {
    const archive: ProjectArchive = {
      id: crypto.randomUUID(),
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      projectName: projectProfile.projectName,
      customerName: projectProfile.customerName,
      projectCode: projectProfile.projectCode,
      sourceLabel: generationLabel,
      machineName: selectedMachine.name,
      toolName: selectedTool.name,
      materialName: selectedMaterial.name,
      hasToolpath: Boolean(toolpath),
      exportReady: exportGateReady,
      feedbackCount: machineFeedback.length
    };
    setProjectArchives((current) => [archive, ...current].slice(0, 30));
    recordTask({
      category: "process",
      status: archive.exportReady ? "ok" : "warning",
      title: "归档当前项目",
      detail: `${archive.projectName} / ${archive.hasToolpath ? "已有刀路" : "未生成刀路"} / ${archive.exportReady ? "可正式导出" : "未解锁正式导出"}`
    });
  };

  const applySettingsPreset = (nextSettings: ModelSettings) => {
    setSettings(nextSettings);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleToolProfileChange = (toolId: string) => {
    applySettingsPreset(applyToolProfile(settings, getToolProfile(toolId)));
  };

  const handleMaterialProfileChange = (materialId: string) => {
    applySettingsPreset(applyMaterialProfile(settings, getMaterialProfile(materialId)));
  };

  const handleMachineProfileChange = (machineId: string) => {
    applySettingsPreset(applyMachineProfile(settings, getMachineProfile(machineId)));
  };

  const handleProcessTemplateChange = (templateId: string) => {
    const template = allProcessTemplates.find((item) => item.id === templateId) ?? processTemplates[0];
    const nextSettings = applyProcessTemplate(settings, template);
    applySettingsPreset(nextSettings);
    saveSnapshot(`模板：${template.name}`, nextSettings, `${template.intent}；${template.notes}`);
    recordTask({
      category: "process",
      status: "ok",
      title: `应用工艺模板：${template.name}`,
      detail: `${template.intent}；${template.notes}`
    });
  };

  const handleSaveCustomProcessTemplate = () => {
    const now = new Date();
    const tool = getToolProfile(settings.toolProfileId);
    const material = getMaterialProfile(settings.materialProfileId);
    const template: ProcessTemplate = {
      id: `custom-${now.getTime()}`,
      name: `自定义模板 ${customProcessTemplates.length + 1}`,
      intent: "用户保存的当前工艺参数",
      toolProfileId: settings.toolProfileId,
      materialProfileId: settings.materialProfileId,
      maxCutDepth: settings.maxCutDepth,
      stockAllowance: settings.stockAllowance,
      stepoverMm: settings.stepoverMm,
      stepoverDeg: settings.stepoverDeg,
      feedRate: settings.feedRate,
      spindleRpm: settings.spindleRpm,
      finishingStrategy: settings.finishingStrategy,
      notes: `${tool.name} / ${material.name} / X步距 ${settings.stepoverMm.toFixed(3)}mm / A步距 ${settings.stepoverDeg.toFixed(1)}°`
    };
    setCustomProcessTemplates((current) => [template, ...current].slice(0, 16));
    saveSnapshot(`保存模板：${template.name}`, settings, template.notes);
    recordTask({
      category: "process",
      status: "ok",
      title: `保存自定义工艺模板：${template.name}`,
      detail: template.notes
    });
  };

  const toggleFeedbackIssue = (issue: string) => {
    setFeedbackDraft((current) => ({
      ...current,
      issues: current.issues.includes(issue)
        ? current.issues.filter((item) => item !== issue)
        : [...current.issues, issue]
    }));
  };

  const handleFeedbackPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const photoUrl = await fileToDataUrl(file);
    setFeedbackDraft((current) => ({
      ...current,
      photoName: file.name,
      photoUrl
    }));
    event.target.value = "";
  };

  const handleSaveMachineFeedback = () => {
    const actualMinutes = Number(feedbackDraft.actualMinutes);
    const normalizedActual = Number.isFinite(actualMinutes) && actualMinutes > 0 ? actualMinutes : null;
    const feedback: MachineFeedback = {
      id: crypto.randomUUID(),
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      outcome: feedbackDraft.outcome,
      sourceLabel: generationLabel,
      machineName: selectedMachine.name,
      toolName: selectedTool.name,
      materialName: selectedMaterial.name,
      estimatedMinutes: toolpath?.estimatedMinutes ?? null,
      actualMinutes: normalizedActual,
      costEstimateRange: costEstimate ? formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh) : null,
      issues: feedbackDraft.issues,
      notes: feedbackDraft.notes.trim(),
      photoName: feedbackDraft.photoName,
      photoUrl: feedbackDraft.photoUrl,
      settings: { ...settings }
    };
    setMachineFeedback((current) => [feedback, ...current].slice(0, 40));
    if (feedback.outcome === "success") {
      saveSnapshot("实机成功参数", settings, `真实耗时 ${feedback.actualMinutes ?? "-"} min；${feedback.notes || "无备注"}`);
    }
    setFeedbackDraft(defaultFeedbackDraft);
    recordTask({
      category: "feedback",
      status: feedback.outcome === "success" ? "ok" : feedback.outcome === "review" ? "warning" : "error",
      title: `记录实机反馈：${formatFeedbackOutcome(feedback.outcome)}`,
      detail: `${feedback.machineName} / ${feedback.toolName} / ${feedback.issues.length > 0 ? feedback.issues.join("、") : "无缺陷标签"}`
    });
  };

  const restoreFeedbackSettings = (feedback: MachineFeedback) => {
    setSettings(feedback.settings);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    setActiveStage("process");
    recordTask({
      category: "feedback",
      status: "ok",
      title: "复用实机反馈参数",
      detail: `${feedback.createdAt} / ${formatFeedbackOutcome(feedback.outcome)} / ${feedback.toolName}`
    });
  };

  const deleteMachineFeedback = (feedback: MachineFeedback) => {
    setMachineFeedback((current) => current.filter((item) => item.id !== feedback.id));
    recordTask({
      category: "feedback",
      status: "warning",
      title: "删除实机反馈记录",
      detail: `${feedback.createdAt} / ${formatFeedbackOutcome(feedback.outcome)}`
    });
  };

  const handleDeleteCustomProcessTemplate = (templateId: string) => {
    const template = customProcessTemplates.find((item) => item.id === templateId);
    setCustomProcessTemplates((current) => current.filter((item) => item.id !== templateId));
    if (template) {
      recordTask({
        category: "process",
        status: "warning",
        title: `删除自定义工艺模板：${template.name}`,
        detail: "模板已从本机浏览器保存区移除，不影响已有参数快照。"
      });
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    setIsReading(true);
    try {
      const loaded = await Promise.all(
        files.map(async (file) => {
          const result = await fileToDepthMap(file);
          return {
            id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
            name: file.name,
            quality: analyzeDepthMapQuality(result.depthMap),
            ...result
          };
        })
      );
      setImages((current) => [...current, ...loaded]);
      setActiveId(loaded[0].id);
      setGeneratedDepth(null);
      setAiMeshUrl(null);
      setAiMeshStlUrl(null);
      setMeshQuality(null);
      setGenerationLabel("图片已载入，待生成3D");
      setToolpath(null);
      setIsSimulationMode(false);
      setWorkbenchView("model");
      recordTask({
        category: "source",
        status: "ok",
        title: "上传图片素材",
        detail: `已读取 ${loaded.length} 张图片，首张质量评分 ${loaded[0].quality?.score.toFixed(1) ?? "-"}。`
      });
    } finally {
      setIsReading(false);
      event.target.value = "";
    }
  };

  const handleGenerateToolpath = async () => {
    await generateToolpathForSettings(settings, false);
  };

  const handleDownloadOperatorPackage = () => {
    if (!toolpath) return;
    const content = createOperatorPackageMarkdown({
      settings,
      toolpath,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      tool: selectedTool,
      material: selectedMaterial,
      machine: selectedMachine,
      safetyIssues,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate
    });
    downloadText("operator-note.md", content, "text/markdown");
  };

  const handleDownloadAirRun = () => {
    if (!airRunProgram) return;
    downloadText(airRunProgram.filename, airRunProgram.gcode);
    setExportGate((current) => ({ ...current, airRunVerified: true }));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: "下载离料空跑程序",
      detail: exportBlocked ? "当前正式程序存在阻断项，空跑前仍需确认 X/A 行程和夹具距离。" : "空跑程序主轴关闭，Z 保持安全高度，用于验证机器动作。"
    });
  };

  const createReportInput = () => {
    if (!toolpath) return null;
    return {
      settings,
      toolpath,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      tool: selectedTool,
      material: selectedMaterial,
      machine: selectedMachine,
      safetyIssues,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate
    };
  };

  const handleDownloadZipPackage = () => {
    const reportInput = createReportInput();
    if (!reportInput) return;

    const operatorNote = createOperatorPackageMarkdown(reportInput);
    const parameters = createPackageParameters({
      projectProfile,
      deploymentProfile,
      settings,
      sourceLabel: generationLabel,
      aiMeshUrl,
      aiMeshStlUrl,
      selectedTool,
      selectedMaterial,
      selectedMachine,
      toolpath,
      manufacturingQuality,
      materialRemoval,
      meshQuality,
      costEstimate,
      envelopeQuality
    });
    const checklist = createPackageChecklist(reportInput, Boolean(exportGateReady), Boolean(aiMeshUrl));
    const previewPng = captureWorkbenchPreviewPng();
    const files: ZipFile[] = [
      { name: "manifest.json", content: JSON.stringify(createPackageManifest(reportInput), null, 2), mime: "application/json" },
      { name: "parameters.json", content: JSON.stringify(parameters, null, 2), mime: "application/json" },
      { name: "operator-note.md", content: operatorNote, mime: "text/markdown" },
      { name: "reports/package-checklist.md", content: checklist, mime: "text/markdown" },
      { name: "reports/safety-report.json", content: JSON.stringify(createSafetyReport(reportInput), null, 2), mime: "application/json" },
      { name: "reports/quality-report.json", content: JSON.stringify(createQualityReport(reportInput), null, 2), mime: "application/json" },
      { name: "reports/cost-estimate.json", content: JSON.stringify(costEstimate, null, 2), mime: "application/json" },
      ...(airRunProgram ? [{ name: `nc/${airRunProgram.filename}`, content: airRunProgram.gcode }] : []),
      { name: "nc/nuclear-carving-combined.nc", content: toolpath.gcode },
      { name: "nc/nuclear-carving-toolpath.tap", content: toolpath.tap },
      { name: "nc/nuclear-carving-toolpath.txt", content: toolpath.txt },
      { name: "nc/nuclear-carving-toolpath.csv", content: toolpath.csv, mime: "text/csv" }
    ];

    if (previewPng) {
      files.push({ name: "preview/simulation-result.png", content: previewPng, mime: "image/png" });
    }
    if (!aiMeshUrl) {
      files.push({ name: "models/source.stl", content: geometryToStlString(geometry), mime: "model/stl" });
    } else {
      files.push({
        name: "models/model-download-links.md",
        content: [
          "# AI Mesh 模型下载链接",
          "",
          aiMeshUrl ? `- GLB：${aiMeshUrl}` : "- GLB：未生成",
          aiMeshStlUrl ? `- STL：${aiMeshStlUrl}` : "- STL：未生成",
          "",
          "说明：AI Mesh 文件可能由本地代理缓存，请在归档前从页面下载 GLB/STL 原文件。"
        ].join("\n"),
        mime: "text/markdown"
      });
    }

    if (toolpath.programs?.rough) {
      files.push({ name: `nc/${toolpath.programs.rough.filename}`, content: toolpath.programs.rough.gcode });
    }
    if (toolpath.programs?.finish) {
      files.push({ name: `nc/${toolpath.programs.finish.filename}`, content: toolpath.programs.finish.gcode });
    }
    if (toolpath.programs?.rest) {
      files.push({ name: `nc/${toolpath.programs.rest.filename}`, content: toolpath.programs.rest.gcode });
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const projectSlug = createFileSlug(projectProfile.projectCode || projectProfile.projectName);
    const machineSlug = createFileSlug(selectedMachine.id);
    const toolSlug = createFileSlug(selectedTool.id);
    downloadBlob(`hediao3d-${projectSlug}-${stamp}-${machineSlug}-${toolSlug}-v2.zip`, createZipBlob(files));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: "导出 ZIP 加工包",
      detail: `已打包 ${files.length} 个文件，包含 NC、报告、参数、预览截图和上机说明。`
    });
  };

  const handleDownloadSafetyReport = (format: "json" | "md") => {
    const reportInput = createReportInput();
    if (!reportInput) return;
    if (format === "json") {
      downloadText("safety-report.json", JSON.stringify(createSafetyReport(reportInput), null, 2), "application/json");
    } else {
      downloadText("safety-report.md", createSafetyReportMarkdown(reportInput), "text/markdown");
    }
    setExportGate((current) => ({ ...current, safetyReportReviewed: true }));
    recordTask({
      category: "cam",
      status: exportBlocked ? "warning" : "ok",
      title: `下载安全报告：${format.toUpperCase()}`,
      detail: exportBlocked ? "安全报告包含阻断项，正式上机前需修复。" : "安全报告可用于离料空跑前复核。"
    });
  };

  const handleGenerateFinishingToolpath = async () => {
    const finishingSettings = createFinishingSettings(settings);
    setSettings(finishingSettings);
    await generateToolpathForSettings(finishingSettings, true);
  };

  const generateToolpathForSettings = async (baseSettings: ModelSettings, finishing: boolean) => {
    if (aiMeshUrl) {
      if (!aiMeshStlUrl) {
        setAiMeshStatus("当前 Meshy 模型没有本地 STL，无法生成 Mesh 贴面刀路");
        return;
      }

      const meshCamSettings = { ...baseSettings, reliefAngleDeg: 360 };
      if (baseSettings.reliefAngleDeg !== 360) {
        setSettings(meshCamSettings);
      }
      setIsToolpathGenerating(true);
      setAiMeshStatus(finishing ? "正在生成 360° Mesh 精加工刀路" : "正在按 360° 包覆对 Meshy STL 做表面采样并生成四轴刀路");
      const jobId = startTaskJob({
        category: "cam",
        title: finishing ? "Mesh 精加工刀路" : "Mesh 四轴刀路",
        detail: "正在采样 STL 表面并生成四轴刀路。",
        retryAction: finishing ? "generate-finish-toolpath" : "generate-toolpath"
      });
      try {
        appendTaskJobLog(jobId, "提交 Mesh CAM 采样请求。", 24);
        const response = await fetch("/api/cam/mesh-toolpath", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stlUrl: aiMeshStlUrl, settings: meshCamSettings })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Mesh CAM 刀路生成失败");
        }
        if (isTaskJobCanceled(jobId)) return;
        appendTaskJobLog(jobId, "服务端已返回刀路，正在写入预览和报告。", 86);
        setToolpath(data);
        setToolpathKind(finishing ? "finish" : "rough");
        setIsSimulationMode(true);
        setWorkbenchView("simulation");
        saveSnapshot(finishing ? "Mesh 精加工刀路" : "Mesh 四轴刀路", meshCamSettings, `点数 ${data.points.length}，估算 ${data.estimatedMinutes.toFixed(1)} min。`);
        setAiMeshStatus(finishing ? "Mesh 精加工刀路已生成，可下载 NC/TAP 文件" : "Mesh 360° 表面采样刀路已生成，可下载 NC/TAP 文件");
        finishTaskJob(jobId, "done", `完成：${data.points.length} 点，估算 ${data.estimatedMinutes.toFixed(1)} min。`);
        recordTask({
          category: "cam",
          status: data.summary.warnings.length > 0 ? "warning" : "ok",
          title: finishing ? "生成 Mesh 精加工刀路" : "生成 Mesh 四轴刀路",
          detail: `点数 ${data.points.length}，估算 ${data.estimatedMinutes.toFixed(1)} min，警告 ${data.summary.warnings.length} 条。`
        });
      } catch (error) {
        setAiMeshStatus(error instanceof Error ? error.message : "Mesh CAM 刀路生成失败");
        finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh CAM 刀路生成失败");
        recordTask({
          category: "cam",
          status: "error",
          title: "Mesh CAM 刀路生成失败",
          detail: error instanceof Error ? error.message : "未知错误"
        });
      } finally {
        setIsToolpathGenerating(false);
      }
      return;
    }

    const localJobId = startTaskJob({
      category: "cam",
      title: finishing ? "本地精加工刀路" : "本地粗精清残刀路",
      detail: "正在生成粗加工、精加工、清残和空跑程序。",
      retryAction: finishing ? "generate-finish-toolpath" : "generate-toolpath"
    });
    appendTaskJobLog(localJobId, "读取当前深度场与工艺参数。", 28);
    const generatedToolpath = generateToolpath(processedDepth, baseSettings);
    if (isTaskJobCanceled(localJobId)) return;
    appendTaskJobLog(localJobId, "刀路计算完成，正在生成仿真与质量指标。", 88);
    setToolpath(generatedToolpath);
    setToolpathKind(finishing ? "finish" : "rough");
    setIsSimulationMode(true);
    setWorkbenchView("simulation");
    saveSnapshot(finishing ? "本地精加工刀路" : "本地粗精刀路", baseSettings, `点数 ${generatedToolpath.points.length}，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min。`);
    finishTaskJob(localJobId, "done", `完成：${generatedToolpath.points.length} 点，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min。`);
    recordTask({
      category: "cam",
      status: generatedToolpath.summary.warnings.length > 0 ? "warning" : "ok",
      title: finishing ? "生成本地精加工刀路" : "生成本地粗精加工刀路",
      detail: `点数 ${generatedToolpath.points.length}，估算 ${generatedToolpath.estimatedMinutes.toFixed(1)} min，粗加工 ${generatedToolpath.programs?.rough?.estimatedMinutes.toFixed(1) ?? "-"} min，清残 ${generatedToolpath.programs?.rest?.points.length ?? 0} 点。`
    });
  };

  const handleGenerate3D = () => {
    if (images.length === 0) {
      setGeneratedDepth(createBlankDepthMap());
      setGenerationLabel("内置示例");
    setToolpath(null);
    setIsSimulationMode(false);
    return;
    }

    const depth =
      settings.generationMode === "multiview"
        ? createMultiViewDepthMap(images.map((image) => image.depthMap))
        : settings.generationMode === "blend"
          ? blendDepthMaps(images.map((image) => image.depthMap))
          : (activeImage?.depthMap ?? images[0].depthMap);

    setGeneratedDepth(depth);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setAiMeshStatus("未生成");
    if (settings.generationMode === "multiview") {
      setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
      setGenerationLabel(`本地360°环绕浮雕：${images.length}张图片`);
      recordTask({
        category: "model",
        status: "ok",
        title: "生成本地 360° 环绕浮雕",
        detail: `使用 ${images.length} 张图片生成本地环绕深度场。`
      });
    } else {
      setGenerationLabel(settings.generationMode === "blend" ? `多图融合：${images.length}张图片` : `当前图片：${activeImage?.name ?? images[0].name}`);
      recordTask({
        category: "model",
        status: "ok",
        title: settings.generationMode === "blend" ? "生成多图融合浮雕" : "生成单图浮雕",
        detail: settings.generationMode === "blend" ? `融合 ${images.length} 张图片。` : `使用 ${activeImage?.name ?? images[0].name}。`
      });
    }
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleDepthEdit = (depth: DepthMap) => {
    setGeneratedDepth(depth);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleClearAiMesh = () => {
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setAiMeshStatus("未生成");
    setGenerationLabel(generatedDepth ? "本地浮雕网格" : images.length > 0 ? "图片已载入，待生成3D" : "内置示例");
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
  };

  const handleLoadDemoImages = () => {
    const demos = [
      { name: "内置莲纹示例", depthMap: createDemoDepthMap("lotus") },
      { name: "内置云纹示例", depthMap: createDemoDepthMap("waves") }
    ].map((demo) => ({
      ...demo,
      id: `${demo.name}-${crypto.randomUUID()}`,
      url: depthMapToPreviewUrl(demo.depthMap),
      quality: analyzeDepthMapQuality(demo.depthMap)
    }));

    setImages(demos);
    setActiveId(demos[0].id);
    setGeneratedDepth(null);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setGenerationLabel("示例图案已载入，待生成3D");
    setToolpath(null);
    setIsSimulationMode(false);
    setWorkbenchView("model");
    recordTask({
      category: "source",
      status: "ok",
      title: "载入示例图案",
      detail: "已载入内置莲纹和云纹示例。"
    });
  };

  const handleLoadMaterial01 = async () => {
    setIsReading(true);
    try {
      const filenames = ["0.png", "1.png", "2.png", "3.png", "4.png", "5.png"];
      const loaded = await Promise.all(
        filenames.map(async (name) => {
          const url = `/test-assets/01/${name}`;
          const result = await assetUrlToDepthMap(url);
          return {
            id: `素材01-${name}-${crypto.randomUUID()}`,
            name: `素材01/${name}`,
            quality: analyzeDepthMapQuality(result.depthMap),
            ...result
          };
        })
      );

      setImages(loaded);
      setActiveId(loaded[0].id);
      setGeneratedDepth(null);
      setAiMeshUrl(null);
      setAiMeshStlUrl(null);
      setMeshQuality(null);
      setGenerationLabel("素材01已载入，待生成3D");
      setToolpath(null);
      setIsSimulationMode(false);
      setWorkbenchView("model");
      recordTask({
        category: "source",
        status: "ok",
        title: "载入素材01",
        detail: `已载入 ${loaded.length} 张测试素材，首张质量评分 ${loaded[0].quality?.score.toFixed(1) ?? "-"}。`
      });
    } finally {
      setIsReading(false);
    }
  };

  const handleGenerateAiMesh = async () => {
    if (images.length === 0) {
      setAiMeshStatus("请先上传图片或载入素材");
      return;
    }
    if (!isProviderAvailable(selectedAiProvider)) {
      setAiMeshStatus(`${selectedAiProvider.name} 尚未接入，当前请选择 Meshy 生成。`);
      recordTask({
        category: "model",
        status: "warning",
        title: "AI Provider 未接入",
        detail: `${selectedAiProvider.name} 已预留接口，但还没有可调用的后端服务。`
      });
      return;
    }

    setIsAiGenerating(true);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setToolpath(null);
    const selected = images.slice(0, selectedAiProvider.maxImages);
    const jobId = startTaskJob({
      category: "model",
      title: `${selectedAiProvider.name} 生成 3D Mesh`,
      detail: `正在上传 ${selected.length} 张图片并等待 AI 3D 任务完成。`,
      retryAction: "generate-ai-mesh"
    });

    try {
      setAiMeshStatus(`准备上传 ${selected.length} 张图片到 ${selectedAiProvider.name}`);
      appendTaskJobLog(jobId, `准备 ${selected.length} 张输入图。`, 18);
      const imageUrls = await Promise.all(selected.map((image) => imageToDataUri(image.url)));
      if (isTaskJobCanceled(jobId)) return;

      setAiMeshStatus(`已提交 ${selectedAiProvider.name} 任务，等待排队`);
      appendTaskJobLog(jobId, "图片已转换，正在创建远端 AI 任务。", 32);
      const createResponse = await fetch(selectedAiProvider.endpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: imageUrls,
          target_formats: selectedAiProvider.targetFormats
        })
      });

      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? `${selectedAiProvider.name}任务创建失败`);
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) {
        throw new Error(`${selectedAiProvider.name}响应中没有任务ID`);
      }

      appendTaskJobLog(jobId, `远端任务已创建：${taskId}`, 45);
      const task = await pollAi3dTask(selectedAiProvider.taskEndpoint!(taskId), setAiMeshStatus, `${selectedAiProvider.name}任务`);
      if (isTaskJobCanceled(jobId)) return;
      const glb = task.local_model_urls?.glb ?? task.model_urls?.glb ?? task.output?.model_urls?.glb ?? task.model_url;
      const stl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!glb) {
        throw new Error(`${selectedAiProvider.name}任务已完成，但没有返回GLB模型地址`);
      }

      setAiMeshUrl(glb);
      setAiMeshStlUrl(stl ?? null);
      setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
      setGenerationLabel(`${selectedAiProvider.name} AI 3D Mesh：${selected.length}张图片`);
      setAiMeshStatus(task.local_model_urls?.glb ? `${selectedAiProvider.name} 3D Mesh 生成完成，已缓存到本地` : `${selectedAiProvider.name} 3D Mesh 生成完成`);
      appendTaskJobLog(jobId, "AI Mesh 文件已返回，正在载入预览。", 92);
      finishTaskJob(jobId, "done", `完成：生成 GLB${stl ? "/STL" : ""}，输入 ${selected.length} 张图片。`);
      recordTask({
        category: "model",
        status: stl ? "ok" : "warning",
        title: `${selectedAiProvider.name} 生成 3D Mesh`,
        detail: `使用 ${selected.length} 张图片生成 GLB${stl ? "/STL" : ""}。`
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : `${selectedAiProvider.name}生成失败`);
      finishTaskJob(jobId, "error", error instanceof Error ? error.message : `${selectedAiProvider.name}生成失败`);
      recordTask({
        category: "model",
        status: "error",
        title: `${selectedAiProvider.name} 生成失败`,
        detail: error instanceof Error ? error.message : "未知错误"
      });
    } finally {
      setIsAiGenerating(false);
    }
  };

  const handleLoadLocalMeshyResult = () => {
    setAiMeshUrl("/meshy-results/material01-meshy.glb");
    setAiMeshStlUrl("/meshy-results/material01-meshy.stl");
    setMeshQuality(null);
    setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
    setGenerationLabel("AI 3D Mesh：素材01测试结果");
    setAiMeshStatus("已载入本地 Meshy 测试结果");
    setToolpath(null);
    setIsSimulationMode(false);
    recordTask({
      category: "model",
      status: "ok",
      title: "载入 Meshy 测试结果",
      detail: "已载入本地 GLB/STL 测试模型。"
    });
  };

  const handleRepairMesh = async () => {
    if (!aiMeshStlUrl) {
      setAiMeshStatus("当前没有可修复的本地 STL，请先生成或载入 Meshy 模型");
      return;
    }

    setIsMeshRepairing(true);
    setAiMeshStatus("正在提交 Meshy 可制造性修复任务");
    const jobId = startTaskJob({
      category: "model",
      title: "Mesh 缺损修复",
      detail: "正在提交 Meshy Repair Printability 并等待修复 STL。",
      retryAction: "repair-mesh"
    });
    try {
      appendTaskJobLog(jobId, "提交 Meshy Repair Printability 请求。", 24);
      const createResponse = await fetch("/api/meshy/repair-printability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stlUrl: aiMeshStlUrl })
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? "Mesh 修复任务创建失败");
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) throw new Error("Mesh 修复响应中没有任务ID");

      appendTaskJobLog(jobId, `修复任务已创建：${taskId}`, 42);
      const task = await pollMeshyTaskByEndpoint(`/api/meshy/repair-printability/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh修复");
      if (isTaskJobCanceled(jobId)) return;
      const repairedStl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!repairedStl) throw new Error("Mesh 修复完成，但没有返回 STL");

      setAiMeshStlUrl(repairedStl);
      setMeshQuality(null);
      setToolpath(null);
      setIsSimulationMode(false);
      setAiMeshStatus("Mesh 缺损修复完成，已替换刀路用 STL，请重新生成刀路");
      appendTaskJobLog(jobId, "修复 STL 已返回，已替换刀路输入模型。", 92);
      finishTaskJob(jobId, "done", "完成：已替换刀路用 STL。");
      recordTask({
        category: "model",
        status: "ok",
        title: "Mesh 缺损修复完成",
        detail: "已替换刀路用 STL，请重新生成刀路并查看未命中点。"
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 修复失败");
      finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh 修复失败");
      recordTask({
        category: "model",
        status: "error",
        title: "Mesh 修复失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
    } finally {
      setIsMeshRepairing(false);
    }
  };

  const handleRemesh = async () => {
    const sourceModel = aiMeshUrl?.startsWith("/meshy-results/") ? aiMeshUrl : aiMeshStlUrl;
    if (!sourceModel) {
      setAiMeshStatus("当前没有可重建的本地 Meshy 模型");
      return;
    }

    setIsMeshRepairing(true);
    setAiMeshStatus("正在提交 Meshy 重网格任务");
    const jobId = startTaskJob({
      category: "model",
      title: "Mesh 重网格",
      detail: "正在提交 Meshy Remesh 并等待可雕刻网格。",
      retryAction: "remesh"
    });
    try {
      appendTaskJobLog(jobId, "提交 Meshy Remesh 请求。", 24);
      const createResponse = await fetch("/api/meshy/remesh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelUrl: sourceModel })
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? "Mesh 重网格任务创建失败");
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) throw new Error("Mesh 重网格响应中没有任务ID");

      appendTaskJobLog(jobId, `重网格任务已创建：${taskId}`, 42);
      const task = await pollMeshyTaskByEndpoint(`/api/meshy/remesh/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh重网格");
      if (isTaskJobCanceled(jobId)) return;
      const remeshGlb = task.local_model_urls?.glb ?? task.model_urls?.glb ?? task.output?.model_urls?.glb ?? task.model_url;
      const remeshStl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!remeshGlb && !remeshStl) throw new Error("Mesh 重网格完成，但没有返回模型文件");

      if (remeshGlb) setAiMeshUrl(remeshGlb);
      if (remeshStl) setAiMeshStlUrl(remeshStl);
      setMeshQuality(null);
      setGenerationLabel("AI 3D Mesh：已重建可雕刻网格");
      setToolpath(null);
      setIsSimulationMode(false);
      setAiMeshStatus("Mesh 重网格完成，已替换当前模型，请重新生成刀路");
      appendTaskJobLog(jobId, "重网格模型已返回，正在更新当前模型。", 92);
      finishTaskJob(jobId, "done", `完成：${remeshGlb ? "GLB" : ""}${remeshGlb && remeshStl ? "/" : ""}${remeshStl ? "STL" : ""} 已替换。`);
      recordTask({
        category: "model",
        status: "ok",
        title: "Mesh 重网格完成",
        detail: "已替换当前模型，请重新生成刀路。"
      });
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 重网格失败");
      finishTaskJob(jobId, "error", error instanceof Error ? error.message : "Mesh 重网格失败");
      recordTask({
        category: "model",
        status: "error",
        title: "Mesh 重网格失败",
        detail: error instanceof Error ? error.message : "未知错误"
      });
    } finally {
      setIsMeshRepairing(false);
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="brand">
          <div className="brand-mark">
            <Box size={22} />
          </div>
          <div>
            <h1>核雕3D CAM</h1>
            <p>图片生成浮雕曲面与四轴刀路</p>
          </div>
        </section>

        <nav className="workflow-nav" aria-label="V2 workflow stages">
          {workflowStages.map((stage) => (
            <button className={stage.id === activeStage ? "active" : ""} key={stage.id} onClick={() => setActiveStage(stage.id)} type="button">
              <strong>{stage.label}</strong>
              <span>{stage.hint}</span>
            </button>
          ))}
        </nav>

        {activeStage === "project" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Library size={18} />
                <h2>项目档案</h2>
              </div>
              <p className="panel-note">把客户、项目编号、素材、模型、刀路和反馈绑定在一起，导出包和任务记录可追溯。</p>
              <label className="field-control">
                <span>项目名称</span>
                <input value={projectProfile.projectName} onChange={(event) => updateProjectProfile("projectName", event.target.value)} />
              </label>
              <label className="field-control">
                <span>客户名称</span>
                <input value={projectProfile.customerName} onChange={(event) => updateProjectProfile("customerName", event.target.value)} />
              </label>
              <label className="field-control">
                <span>项目编号</span>
                <input value={projectProfile.projectCode} onChange={(event) => updateProjectProfile("projectCode", event.target.value)} />
              </label>
              <label className="select-row">
                <span>当前角色</span>
                <select value={projectProfile.role} onChange={(event) => updateProjectProfile("role", event.target.value as UserRole)}>
                  <option value="admin">管理员</option>
                  <option value="designer">设计员</option>
                  <option value="process">工艺员</option>
                  <option value="operator">操作员</option>
                </select>
              </label>
              <div className={`permission-card ${projectProfile.role}`}>
                <strong>{formatUserRole(projectProfile.role)}</strong>
                <span>{getRolePermissionText(projectProfile.role)}</span>
              </div>
              <button className="primary-action package-action" type="button" onClick={handleSaveProjectProfile}>
                <Save size={17} />
                保存项目档案
              </button>
              <button className="demo-action package-action" type="button" onClick={handleArchiveProject}>
                <Library size={17} />
                归档当前项目
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>项目状态</h2>
              </div>
              <div className="project-summary">
                <span><strong>{images.length}</strong> 素材</span>
                <span><strong>{aiMeshUrl ? "AI Mesh" : generatedDepth ? "浮雕" : "待建模"}</strong> 模型</span>
                <span><strong>{toolpath ? toolpath.points.length.toLocaleString() : "-"}</strong> 刀路点</span>
                <span><strong>{exportGateReady ? "已解锁" : "未解锁"}</strong> 导出</span>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>项目归档</h2>
              </div>
              {projectArchives.length === 0 ? (
                <p className="panel-note">还没有归档记录。完成建模、刀路或反馈后，可以把当前项目状态保存为一条生产记录。</p>
              ) : (
                <div className="project-archive-list">
                  {projectArchives.map((archive) => (
                    <div className={`project-archive-card ${archive.exportReady ? "ready" : "review"}`} key={archive.id}>
                      <div>
                        <strong>{archive.projectName}</strong>
                        <span>{archive.createdAt}</span>
                      </div>
                      <p>{archive.customerName} / {archive.projectCode}</p>
                      <small>{archive.machineName} / {archive.toolName} / {archive.hasToolpath ? "已有刀路" : "未生成刀路"} / 反馈 {archive.feedbackCount}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {activeStage === "source" && (
          <>
            <label className="upload-panel">
              <UploadCloud size={24} />
              <span>{isReading ? "正在读取图片..." : "上传一张或多张核雕图片"}</span>
              <input type="file" accept="image/*" multiple onChange={handleFiles} disabled={isReading} />
            </label>
            <button className="demo-action" onClick={handleLoadDemoImages} type="button">
              <Sparkles size={17} />
              载入示例图案
            </button>
            <button className="demo-action material-action" onClick={handleLoadMaterial01} type="button" disabled={isReading}>
              <FileImage size={17} />
              载入素材01
            </button>
          </>
        )}

        {activeStage === "source" && images.length > 0 && (
          <section className="panel">
            <div className="panel-title">
              <Camera size={18} />
              <h2>采集向导</h2>
            </div>
            <div className={`capture-summary ${captureGuide.verdict}`}>
              <strong>{captureGuide.score.toFixed(1)}</strong>
              <span>{captureGuide.summary}</span>
            </div>
            <div className="capture-slots">
              {captureGuide.slots.map((slot, index) => (
                <button
                  className={`capture-slot ${slot.status}`}
                  key={slot.label}
                  type="button"
                  disabled={!images[index]}
                  onClick={() => {
                    if (images[index]) setActiveId(images[index].id);
                  }}
                >
                  <span>{slot.label}</span>
                  <strong>{slot.imageName ?? "待补拍"}</strong>
                  <small>{slot.hint}</small>
                </button>
              ))}
            </div>
            <div className="quality-notes">
              {captureGuide.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {activeStage === "source" && images.length > 0 && (
          <section className="panel">
            <div className="panel-title">
              <FileImage size={18} />
              <h2>图片素材</h2>
            </div>
            <div className="thumb-grid">
              {images.map((image) => (
                <button
                  className={`thumb ${image.id === activeImage?.id ? "active" : ""}`}
                  key={image.id}
                  onClick={() => {
                    setActiveId(image.id);
                    setToolpath(null);
                  }}
                  title={image.name}
                >
                  <img src={image.url} alt={image.name} />
                </button>
              ))}
            </div>
          </section>
        )}

        {activeStage === "source" && activeQuality && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>采集质量检测</h2>
            </div>
            <div className={`quality-score ${activeQuality.verdict}`}>
              <strong>{activeQuality.score.toFixed(1)}</strong>
              <span>{activeQuality.summary}</span>
            </div>
            <div className="quality-grid">
              {activeQuality.metrics.map((metric) => (
                <div className={`quality-metric ${metric.status}`} key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value.toFixed(metric.unit === "%" ? 1 : 2)}{metric.unit}</strong>
                </div>
              ))}
            </div>
            <div className="quality-notes">
              {activeQuality.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {activeStage === "model" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Layers3 size={18} />
                <h2>生成控制</h2>
              </div>
              <label className="select-row">
                <span>生成模式</span>
                <select value={settings.generationMode} onChange={(event) => updateSetting("generationMode", event.target.value as ModelSettings["generationMode"])} disabled={images.length < 2}>
                  <option value="active">当前选中图片</option>
                  <option value="blend">多图平均融合</option>
                  <option value="multiview">本地360°环绕浮雕（非AI Mesh）</option>
                </select>
              </label>
              <button className="primary-action generate-3d" onClick={handleGenerate3D}>
                <Layers3 size={18} />
                3D生成
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <Sparkles size={18} />
                <h2>推荐：真实3D网格</h2>
              </div>
              <p className="panel-note">选择 AI 3D Provider，将多角度图片生成真正的 GLB/STL 三维网格；当前 Meshy 已接入，其他服务为预留接口。</p>
              <label className="select-row">
                <span>AI Provider</span>
                <select value={aiProviderId} onChange={(event) => setAiProviderId(event.target.value as Ai3dProviderId)}>
                  {ai3dProviders.map((provider) => (
                    <option value={provider.id} key={provider.id}>
                      {provider.name}{provider.status === "available" ? "（已接入）" : provider.status === "local" ? "（本地预留）" : "（预留）"}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`provider-card ${selectedAiProvider.status}`}>
                <strong>{selectedAiProvider.name}</strong>
                <span>{selectedAiProvider.note}</span>
                <small>{selectedAiProvider.capabilities.join(" / ")}</small>
              </div>
              <button className="primary-action ai-action" onClick={handleGenerateAiMesh} disabled={isAiGenerating || images.length === 0}>
                <Sparkles size={18} />
                {isAiGenerating ? "AI生成中..." : `${selectedAiProvider.name}生成3D Mesh`}
              </button>
              <div className="ai-tool-grid">
                <button className="demo-action material-action" onClick={handleLoadLocalMeshyResult} type="button">
                  <FileImage size={17} />
                  载入测试结果
                </button>
                <button className="demo-action repair-action" onClick={handleRepairMesh} type="button" disabled={!aiMeshStlUrl || isMeshRepairing}>
                  <Sparkles size={17} />
                  {isMeshRepairing ? "修复中..." : "修复缺损"}
                </button>
                <button className="demo-action repair-action ai-tool-wide" onClick={handleRemesh} type="button" disabled={!aiMeshUrl || isMeshRepairing}>
                  <Layers3 size={17} />
                  重建可雕刻网格
                </button>
              </div>
              <div className="ai-status">{aiMeshStatus}</div>
              {aiMeshUrl && (
                <div className="ai-links">
                  <a href={aiMeshUrl} target="_blank" rel="noreferrer">下载 GLB</a>
                  {aiMeshStlUrl && <a href={aiMeshStlUrl} target="_blank" rel="noreferrer">下载 AI STL</a>}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <ShieldCheck size={18} />
                <h2>Mesh质量体检</h2>
              </div>
              {!aiMeshStlUrl ? (
                <p className="panel-note">载入或生成带 STL 的 Meshy 模型后，会自动检查封闭性、非流形边、退化面和模型尺寸。</p>
              ) : meshQuality ? (
                <>
                  <div className={`quality-score ${meshQuality.verdict === "ready" ? "ready" : meshQuality.verdict === "review" ? "usable" : "retake"}`}>
                    <strong>{meshQuality.score.toFixed(1)}</strong>
                    <span>{meshQuality.verdict === "ready" ? "Mesh 可进入刀路生成" : meshQuality.verdict === "review" ? "Mesh 建议复核后加工" : "Mesh 建议先修复"}</span>
                  </div>
                  <div className="mesh-stats">
                    <span>面数 <strong>{meshQuality.triangleCount.toLocaleString()}</strong></span>
                    <span>边界边 <strong>{meshQuality.boundaryEdges}</strong></span>
                    <span>非流形 <strong>{meshQuality.nonManifoldEdges}</strong></span>
                    <span>长轴 <strong>{meshQuality.detectedLongAxis.toUpperCase()}</strong></span>
                    <span>尺寸 <strong>{meshQuality.dimensions.x.toFixed(1)} x {meshQuality.dimensions.y.toFixed(1)} x {meshQuality.dimensions.z.toFixed(1)}</strong></span>
                  </div>
                  <div className="inspection-list">
                    {meshQuality.checks.map((check) => (
                      <div className={`inspection-item ${check.status}`} key={check.label}>
                        <div>
                          <span>{check.label}</span>
                          <strong>{check.value}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="quality-notes">
                    {meshQuality.recommendations.map((recommendation) => (
                      <span key={recommendation}>{recommendation}</span>
                    ))}
                  </div>
                  <div className="calibration-controls">
                    <label className="select-row">
                      <span>CAM长轴</span>
                      <select value={settings.meshLengthAxis} onChange={(event) => updateSetting("meshLengthAxis", event.target.value as ModelSettings["meshLengthAxis"])}>
                        <option value="auto">自动识别</option>
                        <option value="x">X 轴</option>
                        <option value="y">Y 轴</option>
                        <option value="z">Z 轴</option>
                      </select>
                    </label>
                    <label className="toggle-row">
                      <input type="checkbox" checked={settings.meshAxisReverse} onChange={(event) => updateSetting("meshAxisReverse", event.target.checked)} />
                      <span>反转长轴采样方向</span>
                    </label>
                    <button className="demo-action" type="button" onClick={() => updateSetting("meshLengthAxis", meshQuality.detectedLongAxis)}>
                      <Layers3 size={17} />
                      采用体检长轴 {meshQuality.detectedLongAxis.toUpperCase()}
                    </button>
                  </div>
                  <div className="repair-steps">
                    <div className={meshQuality.boundaryEdges > 0 ? "active" : ""}>
                      <strong>1. 修复缺损</strong>
                      <span>优先处理孔洞、开口和打印可制造性。</span>
                    </div>
                    <div className={meshQuality.nonManifoldEdges > 0 || meshQuality.degenerateFaces > 0 ? "active" : ""}>
                      <strong>2. 重建可雕刻网格</strong>
                      <span>处理非流形边、退化面和网格密度不均。</span>
                    </div>
                    <div>
                      <strong>3. 重新生成刀路</strong>
                      <span>修复后重新采样并查看未命中点变化。</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="ai-status">{meshQualityStatus}</div>
              )}
            </section>
          </>
        )}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <Sparkles size={18} />
              <h2>工艺模板</h2>
            </div>
            <p className="panel-note">按加工目标一键套用刀具、材料、进给、步距、切深和精修策略。应用后会清空旧刀路，并保存参数快照。</p>
            <div className="template-toolbar">
              <button className="demo-action" type="button" onClick={handleSaveCustomProcessTemplate}>
                <Save size={16} />
                保存当前为模板
              </button>
              <span>{customProcessTemplates.length}/16 个自定义模板</span>
            </div>
            <div className="template-section-title">
              <strong>内置模板</strong>
              <span>低风险、快速验证、标准核雕和高精细场景</span>
            </div>
            <div className="template-grid">
              {processTemplates.map((template) => (
                <button className="template-card" type="button" key={template.id} onClick={() => handleProcessTemplateChange(template.id)}>
                  <strong>{template.name}</strong>
                  <span>{template.intent}</span>
                  <small>{template.notes}</small>
                </button>
              ))}
            </div>
            <div className="template-section-title">
              <strong>自定义模板</strong>
              <span>保存在当前浏览器，用于复用试雕成功参数</span>
            </div>
            {customProcessTemplates.length > 0 ? (
              <div className="template-grid custom-template-grid">
                {customProcessTemplates.map((template) => (
                  <div className="template-card custom-template-card" key={template.id}>
                    <button className="template-apply" type="button" onClick={() => handleProcessTemplateChange(template.id)}>
                      <strong>{template.name}</strong>
                      <span>{template.intent}</span>
                      <small>{template.notes}</small>
                    </button>
                    <button className="template-delete" type="button" onClick={() => handleDeleteCustomProcessTemplate(template.id)} title="删除自定义模板" aria-label={`删除 ${template.name}`}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-inline">还没有自定义模板。调整好刀具、材料、步距和进给后，可保存当前参数。</p>
            )}
          </section>
        )}

        {activeStage === "process" && <section className="panel">
          <div className="panel-title">
            <SlidersHorizontal size={18} />
            <h2>3D微调</h2>
          </div>
          <Control label="核长" value={settings.lengthMm} min={18} max={70} step={0.5} suffix="mm" onChange={(v) => updateSetting("lengthMm", v)} />
          <Control label="最大直径" value={settings.diameterMm} min={8} max={28} step={0.2} suffix="mm" onChange={(v) => updateSetting("diameterMm", v)} />
          <Control label="浮雕深度" value={settings.depthMm} min={0.1} max={2.5} step={0.05} suffix="mm" onChange={(v) => updateSetting("depthMm", v)} />
          <Control label="包覆角度" value={settings.reliefAngleDeg} min={60} max={360} step={5} suffix="°" onChange={(v) => updateSetting("reliefAngleDeg", v)} />
          <Control label="图像对比" value={settings.contrast} min={0.5} max={3} step={0.05} suffix="x" onChange={(v) => updateSetting("contrast", v)} />
          <Control label="平滑次数" value={settings.smoothPasses} min={0} max={5} step={1} suffix="" onChange={(v) => updateSetting("smoothPasses", v)} />
          <label className="toggle-row">
            <input type="checkbox" checked={settings.invertDepth} onChange={(event) => updateSetting("invertDepth", event.target.checked)} />
            <span>反转深浅</span>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} />
            <span>显示网格</span>
          </label>
        </section>}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <SlidersHorizontal size={18} />
              <h2>毛坯截面标定</h2>
            </div>
            <p className="panel-note">真实核胚通常不是标准圆柱。用左/中/右三段直径近似毛坯外形，用于风险提示、报告和后续刀路补偿。</p>
            <Control label="左端直径" value={settings.blankLeftDiameterMm} min={6} max={30} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankLeftDiameterMm", v)} />
            <Control label="中部直径" value={settings.blankCenterDiameterMm} min={6} max={32} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankCenterDiameterMm", v)} />
            <Control label="右端直径" value={settings.blankRightDiameterMm} min={6} max={30} step={0.1} suffix="mm" onChange={(v) => updateSetting("blankRightDiameterMm", v)} />
            <div className="blank-profile">
              <span>左 {settings.blankLeftDiameterMm.toFixed(1)}mm</span>
              <strong>中 {settings.blankCenterDiameterMm.toFixed(1)}mm</strong>
              <span>右 {settings.blankRightDiameterMm.toFixed(1)}mm</span>
            </div>
          </section>
        )}

        {activeStage === "process" && (aiMeshUrl ? (
          <section className="panel ai-mesh-note">
            <div className="panel-title">
              <Sparkles size={18} />
              <h2>Meshy网格查看</h2>
            </div>
            <p className="panel-note">
              当前加载的是 Meshy AI 3D Mesh。真实三维网格显示在右侧 3D 视图区；局部修模只适用于本地浮雕深度图。
            </p>
            <button className="demo-action" onClick={handleClearAiMesh} type="button">
              回到本地浮雕修模
            </button>
          </section>
        ) : (
          <DepthEditor depthMap={generatedDepth} onChange={handleDepthEdit} />
        ))}

        {activeStage === "process" && (
          <section className="panel">
            <div className="panel-title">
              <Library size={18} />
              <h2>工艺预设</h2>
            </div>
            <label className="select-row">
              <span>刀具</span>
              <select value={settings.toolProfileId} onChange={(event) => handleToolProfileChange(event.target.value)}>
                {toolProfiles.map((tool) => (
                  <option value={tool.id} key={tool.id}>{tool.name}</option>
                ))}
              </select>
            </label>
            <label className="select-row">
              <span>材料</span>
              <select value={settings.materialProfileId} onChange={(event) => handleMaterialProfileChange(event.target.value)}>
                {materialProfiles.map((material) => (
                  <option value={material.id} key={material.id}>{material.name}</option>
                ))}
              </select>
            </label>
            <label className="select-row">
              <span>机床</span>
              <select value={settings.machineProfileId} onChange={(event) => handleMachineProfileChange(event.target.value)}>
                {machineProfiles.map((machine) => (
                  <option value={machine.id} key={machine.id}>{machine.name}</option>
                ))}
              </select>
            </label>
            <div className="profile-summary">
              <span>刀具：{selectedTool.diameterMm.toFixed(2)}mm / 最大切深 {selectedTool.maxCutDepthMm.toFixed(2)}mm</span>
              <span>材料：{selectedMaterial.notes}</span>
              <span>机床：{selectedMachine.notes}</span>
            </div>
          </section>
        )}

        {activeStage === "cam" && <section className="panel">
          <div className="panel-title">
            <Hammer size={18} />
            <h2>刀路参数</h2>
          </div>
          <Control label="刀具直径" value={settings.toolDiameter} min={0.2} max={2} step={0.05} suffix="mm" onChange={(v) => updateSetting("toolDiameter", v)} />
          <Control label="左端夹持" value={settings.leftHoldMm} min={0} max={8} step={0.1} suffix="mm" onChange={(v) => updateSetting("leftHoldMm", v)} />
          <Control label="右端夹持" value={settings.rightHoldMm} min={0} max={8} step={0.1} suffix="mm" onChange={(v) => updateSetting("rightHoldMm", v)} />
          <Control label="端部过渡" value={settings.endTransitionMm} min={0} max={6} step={0.1} suffix="mm" onChange={(v) => updateSetting("endTransitionMm", v)} />
          <Control label="X步距" value={settings.stepoverMm} min={0.03} max={0.8} step={0.01} suffix="mm" onChange={(v) => updateSetting("stepoverMm", v)} />
          <Control label="A步距" value={settings.stepoverDeg} min={0.2} max={5} step={0.1} suffix="°" onChange={(v) => updateSetting("stepoverDeg", v)} />
          <Control label="最大单层切深" value={settings.maxCutDepth} min={0.02} max={0.5} step={0.01} suffix="mm" onChange={(v) => updateSetting("maxCutDepth", v)} />
          <Control label="粗加工余量" value={settings.stockAllowance} min={0} max={0.5} step={0.01} suffix="mm" onChange={(v) => updateSetting("stockAllowance", v)} />
          <Control label="进给" value={settings.feedRate} min={30} max={600} step={10} suffix="mm/min" onChange={(v) => updateSetting("feedRate", v)} />
          <Control label="主轴" value={settings.spindleRpm} min={3000} max={24000} step={500} suffix="rpm" onChange={(v) => updateSetting("spindleRpm", v)} />
          <label className="select-row">
            <span>精修策略</span>
            <select value={settings.finishingStrategy} onChange={(event) => updateSetting("finishingStrategy", event.target.value as ModelSettings["finishingStrategy"])}>
              <option value="x-scan">沿 X 扫描</option>
              <option value="a-scan">沿 A 轴环扫</option>
              <option value="cross">交叉精修</option>
            </select>
          </label>
          <label className="select-row">
            <span>后处理</span>
            <select value={settings.postProcessor} onChange={(event) => updateSetting("postProcessor", event.target.value as ModelSettings["postProcessor"])}>
              <option value="generic">通用四轴</option>
              <option value="weihong">维宏风格</option>
              <option value="syntec">新代风格</option>
            </select>
          </label>
          <button className="primary-action" onClick={handleGenerateToolpath} disabled={isToolpathGenerating}>
            <Hammer size={18} />
            {isToolpathGenerating ? "刀路生成中..." : "生成刀路"}
          </button>
          <button className="demo-action finish-action" onClick={handleGenerateFinishingToolpath} disabled={isToolpathGenerating}>
            <Hammer size={17} />
            生成精加工刀路
          </button>
        </section>}

        {activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>导出前安全校验</h2>
            </div>
            <div className={`safety-verdict ${exportBlocked ? "blocked" : toolpath ? "ready" : "review"}`}>
              <strong>{exportBlocked ? "禁止直接上机" : toolpath ? "可进入离料空跑验证" : "等待生成刀路"}</strong>
              <span>{exportBlocked ? "存在 critical 阻断项，正式下载/上机前必须修复。" : toolpath ? "未发现阻断项，仍需离料空跑确认方向和夹持。" : "生成刀路后会输出独立安全报告。"}</span>
            </div>
            <div className="safety-list">
              {safetyIssues.map((issue, index) => (
                <div className={`safety-item ${issue.level}`} key={`${issue.title}-${index}`}>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                  {issue.command && <code>{issue.command}</code>}
                </div>
              ))}
            </div>
            <div className="report-actions">
              <button className="demo-action" type="button" onClick={() => handleDownloadSafetyReport("md")} disabled={!toolpath}>
                下载安全报告 MD
              </button>
              <button className="demo-action" type="button" onClick={() => handleDownloadSafetyReport("json")} disabled={!toolpath}>
                下载安全报告 JSON
              </button>
            </div>
            <div className={`export-gate ${exportGateReady ? "ready" : exportBlocked ? "blocked" : "review"}`}>
              <strong>{exportGateReady ? "正式加工文件已解锁" : exportBlocked ? "正式加工文件锁定" : "正式加工文件待确认"}</strong>
              <span>{exportGateReady ? "可下载 ZIP/NC/TAP/TXT 正式文件；上机前仍建议先空跑。" : exportBlocked ? "存在阻断项，只允许下载报告和空跑文件。" : "下载正式文件前，请完成安全报告、离料空跑和夹持确认。"}</span>
            </div>
            <div className="export-gate-list">
              <label className={exportGate.safetyReportReviewed ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.safetyReportReviewed}
                  onChange={(event) => setExportGate((current) => ({ ...current, safetyReportReviewed: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已查看安全报告</span>
              </label>
              <label className={exportGate.airRunVerified ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.airRunVerified}
                  onChange={(event) => setExportGate((current) => ({ ...current, airRunVerified: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已下载/完成离料空跑</span>
              </label>
              <label className={exportGate.fixtureConfirmed ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={exportGate.fixtureConfirmed}
                  onChange={(event) => setExportGate((current) => ({ ...current, fixtureConfirmed: event.target.checked }))}
                  disabled={!toolpath}
                />
                <span>已确认夹持区和刀具装夹</span>
              </label>
            </div>
          </section>
        )}

        {activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <BadgeInfo size={18} />
              <h2>加工质量体检</h2>
            </div>
            <div className={`quality-score ${manufacturingQuality.verdict}`}>
              <strong>{manufacturingQuality.score.toFixed(1)}</strong>
              <span>{manufacturingQuality.summary}</span>
            </div>
            <div className="inspection-list">
              {manufacturingQuality.items.map((item) => (
                <div className={`inspection-item ${item.status}`} key={item.label}>
                  <div>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <p>{item.detail}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeStage === "cam" && envelopeQuality && (
          <section className="panel">
            <div className="panel-title">
              <ShieldCheck size={18} />
              <h2>包络诊断</h2>
            </div>
            <div className={`envelope-diagnosis ${envelopeQuality.diagnosis.level}`}>
              <strong>{envelopeQuality.diagnosis.title}</strong>
              <span>{envelopeQuality.diagnosis.detail}</span>
            </div>
            <div className="envelope-region-grid">
              {envelopeQuality.regions.map((region) => (
                <div className={`envelope-region ${region.status}`} key={region.label}>
                  <span>{region.label}</span>
                  <strong>{region.fitRate.toFixed(1)}%</strong>
                  <small>未贴合 {region.missCount}/{region.total}</small>
                </div>
              ))}
            </div>
            <div className="quality-notes">
              {envelopeQuality.diagnosis.suggestions.map((suggestion) => (
                <span key={suggestion}>{suggestion}</span>
              ))}
            </div>
          </section>
        )}

        {activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Layers3 size={18} />
              <h2>材料去除仿真</h2>
            </div>
            {materialRemoval ? (
              <>
                <div className={`simulation-verdict ${materialRemoval.verdict}`}>
                  <strong>{materialRemoval.score.toFixed(1)} / 100</strong>
                  <span>{materialRemoval.summary}</span>
                </div>
                <div className="simulation-metric-grid">
                  {materialRemoval.metrics.map((metric) => (
                    <div className={`simulation-metric ${metric.status}`} key={metric.label}>
                      <div>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </div>
                      <p>{metric.detail}</p>
                    </div>
                  ))}
                </div>
                <div className="quality-notes">
                  {materialRemoval.suggestions.slice(0, 3).map((suggestion) => (
                    <span key={suggestion}>{suggestion}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="panel-note">生成刀路后会按球刀半径、X/A 步距、清残占比和覆盖率估算材料去除效果。</p>
            )}
          </section>
        )}

        {activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Calculator size={18} />
              <h2>工时与成本估算</h2>
            </div>
            {costEstimate ? (
              <>
                <div className={`estimate-confidence ${costEstimate.confidence}`}>
                  <strong>{formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh)}</strong>
                  <span>{costEstimate.confidence === "usable" ? "可用于试报价" : costEstimate.confidence === "review" ? "建议结合空跑复核" : "粗估，需实机校正"}</span>
                </div>
                <div className="estimate-grid">
                  <div>
                    <span>总占机</span>
                    <strong>{costEstimate.totalMinutes.toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>切削机时</span>
                    <strong>{costEstimate.machiningMinutes.toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>准备/检查</span>
                    <strong>{(costEstimate.setupMinutes + costEstimate.inspectionMinutes).toFixed(1)} min</strong>
                  </div>
                  <div>
                    <span>刀具损耗</span>
                    <strong>¥{costEstimate.toolWearCost.toFixed(0)}</strong>
                  </div>
                </div>
                <div className={`calibration-card ${costCalibration.confidence}`}>
                  <div>
                    <span>实机校正</span>
                    <strong>{costCalibration.sampleCount > 0 ? `${costCalibration.calibratedTotalMinutes.toFixed(1)} min` : "待反馈"}</strong>
                  </div>
                  <p>
                    {costCalibration.sampleCount > 0
                      ? `基于 ${costCalibration.sampleCount} 条同机床/同刀具反馈，耗时系数 ${costCalibration.averageRatio.toFixed(2)}x，平均误差 ${(costCalibration.averageErrorRate * 100).toFixed(1)}%。`
                      : "完成空跑或试雕后，在“反馈”阶段录入真实耗时，系统会自动校正后续估算。"}
                  </p>
                  {costCalibration.sampleCount > 0 && (
                    <small>校正成本 {formatCurrencyRange(costCalibration.calibratedCostLow, costCalibration.calibratedCostHigh)} / 可信度 {formatCalibrationConfidence(costCalibration.confidence)}</small>
                  )}
                </div>
                <div className="estimate-assumptions">
                  {costEstimate.assumptions.slice(0, 3).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="panel-note">生成刀路后会按机床小时费、准备时间、材料和刀具损耗估算总占机时间与成本区间。</p>
            )}
          </section>
        )}

        {activeStage === "cam" && (
          <section className="panel">
            <div className="panel-title">
              <Download size={18} />
              <h2>加工包交付</h2>
            </div>
            <p className="panel-note">下载完整加工包，包含 NC/TAP/TXT/CSV、质量报告、安全校验、成本估算和上机说明。</p>
            <div className="package-list">
              <span>离料空跑 NC</span>
              <span>合并 NC</span>
              <span>粗加工 NC</span>
              <span>精加工 NC</span>
              <span>清残 NC</span>
              <span>CSV 点位</span>
              <span>参数快照</span>
              <span>仿真截图</span>
              <span>源模型</span>
              <span>质量报告</span>
              <span>安全报告</span>
              <span>交付清单</span>
            </div>
            <button className="primary-action package-action" onClick={handleDownloadZipPackage} disabled={!exportGateReady || !canDownloadProduction} type="button" title={productionDownloadTitle}>
              <Download size={17} />
              下载 ZIP 加工包
            </button>
            <button className="demo-action package-action" onClick={handleDownloadAirRun} disabled={!airRunProgram} type="button" title="主轴关闭，Z 保持安全高度，用于离料空跑验证机器动作">
              <Download size={17} />
              下载离料空跑 NC
            </button>
            <button className="demo-action package-action" onClick={handleDownloadOperatorPackage} disabled={!toolpath} type="button">
              <Download size={17} />
              下载加工包说明
            </button>
          </section>
        )}

        {activeStage === "tasks" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>任务中心</h2>
              </div>
              <div className="task-summary">
                <span><strong>{taskEvents.length}</strong> 事件</span>
                <span><strong>{taskJobs.filter((job) => job.status === "running").length}</strong> 运行中</span>
                <span><strong>{taskEvents.filter((event) => event.status === "ok").length}</strong> 成功</span>
                <span><strong>{taskEvents.filter((event) => event.status === "warning").length}</strong> 提醒</span>
                <span><strong>{taskEvents.filter((event) => event.status === "error").length}</strong> 失败</span>
                <span><strong>{taskJobs.filter((job) => job.status === "canceled").length}</strong> 已取消</span>
              </div>
              <button className="demo-action package-action" onClick={() => { setTaskEvents([]); setTaskJobs([]); setSelectedTaskJobId(null); }} disabled={taskEvents.length === 0 && taskJobs.length === 0} type="button">
                清空任务记录
              </button>
              <button className="demo-action package-action" onClick={handleSaveCurrentSnapshot} type="button">
                保存当前参数版本
              </button>
            </section>
            <section className="panel">
              <div className="panel-title">
                <Clock3 size={18} />
                <h2>任务队列</h2>
              </div>
              {taskJobs.length === 0 ? (
                <p className="panel-note">AI 生成、Mesh 修复、重网格、CAM 生成等长任务会显示在这里。</p>
              ) : (
                <div className="job-list">
                  {taskJobs.map((job) => (
                    <div className={`job-card ${job.status}`} key={job.id}>
                      <div>
                        <strong>{job.title}</strong>
                        <span>{formatTaskJobStatus(job.status)}</span>
                      </div>
                      <p>{job.detail}</p>
                      <div className="job-progress" aria-label={`${job.title}进度`}>
                        <i style={{ width: `${job.progress}%` }} />
                      </div>
                      <small>
                        {job.category.toUpperCase()} / 开始 {job.startedLabel}
                        {job.durationMs !== undefined ? ` / 耗时 ${(job.durationMs / 1000).toFixed(1)}s` : ""}
                      </small>
                      <div className="job-actions">
                        <button className="mini-action" type="button" onClick={() => setSelectedTaskJobId(selectedTaskJobId === job.id ? null : job.id)}>
                          {selectedTaskJobId === job.id ? "收起日志" : "查看日志"}
                        </button>
                        <button className="mini-action" type="button" onClick={() => cancelTaskJob(job)} disabled={job.status !== "running"}>
                          取消
                        </button>
                        <button className="mini-action" type="button" onClick={() => void retryTaskJob(job)} disabled={!job.retryAction || job.status === "running"}>
                          重试
                        </button>
                      </div>
                      {selectedTaskJobId === job.id && (
                        <div className="job-log">
                          {job.logs.map((log) => (
                            <p key={log.id}><span>{log.time}</span>{log.message}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-title">
                <Library size={18} />
                <h2>参数版本</h2>
              </div>
              {taskSnapshots.length === 0 ? (
                <p className="panel-note">应用工艺模板或生成刀路后，会自动保存参数快照，可在这里回退并重新生成。</p>
              ) : (
                <div className="snapshot-list">
                  {taskSnapshots.map((snapshot) => (
                    <div className="snapshot-card" key={snapshot.id}>
                      <div>
                        <strong>{snapshot.label}</strong>
                        <span>{snapshot.createdAt}</span>
                      </div>
                      <p>{snapshot.detail}</p>
                      <small>
                        刀具 {snapshot.settings.toolDiameter.toFixed(2)}mm / 进给 {snapshot.settings.feedRate.toFixed(0)} / 毛坯 {snapshot.settings.blankLeftDiameterMm.toFixed(1)}-{snapshot.settings.blankCenterDiameterMm.toFixed(1)}-{snapshot.settings.blankRightDiameterMm.toFixed(1)} / X步距 {snapshot.settings.stepoverMm.toFixed(3)}
                      </small>
                      <button className="demo-action snapshot-action" type="button" onClick={() => restoreSnapshot(snapshot)}>
                        回退到此版本
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>历史版本时间线</h2>
              </div>
              {taskEvents.length === 0 ? (
                <p className="panel-note">当前会话还没有任务记录。载入素材、生成模型、修复 Mesh 或生成刀路后会自动记录。</p>
              ) : (
                <div className="task-timeline">
                  {taskEvents.map((event) => (
                    <div className={`task-event ${event.status}`} key={event.id}>
                      <div>
                        <strong>{event.title}</strong>
                        <span>{event.timestamp}</span>
                      </div>
                      <p>{event.detail}</p>
                      <small>{event.category.toUpperCase()}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {activeStage === "deployment" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Cloud size={18} />
                <h2>部署模式</h2>
              </div>
              <p className="panel-note">定义 AI Key、客户素材、模型缓存和重计算任务放在哪里，避免把生产密钥或客户素材直接暴露到前端。</p>
              <div className="deployment-mode-grid">
                {(["local-only", "lan-proxy", "cloud-hybrid"] as const).map((mode) => (
                  <button
                    className={deploymentProfile.mode === mode ? "deployment-mode active" : "deployment-mode"}
                    key={mode}
                    type="button"
                    onClick={() => updateDeploymentProfile("mode", mode)}
                  >
                    <strong>{formatDeploymentMode(mode)}</strong>
                    <span>{getDeploymentModeHint(mode)}</span>
                  </button>
                ))}
              </div>
              <label className="select-row">
                <span>API Key 存放</span>
                <select value={deploymentProfile.apiKeyLocation} onChange={(event) => updateDeploymentProfile("apiKeyLocation", event.target.value as DeploymentProfile["apiKeyLocation"])}>
                  <option value="server-env">后端 .env / 环境变量</option>
                  <option value="browser-local">浏览器本地存储</option>
                  <option value="not-configured">暂未配置</option>
                </select>
              </label>
              <label className="select-row">
                <span>素材/模型存储</span>
                <select value={deploymentProfile.assetStorage} onChange={(event) => updateDeploymentProfile("assetStorage", event.target.value as DeploymentProfile["assetStorage"])}>
                  <option value="browser-cache">仅浏览器缓存</option>
                  <option value="lan-server">局域网服务器</option>
                  <option value="cloud-bucket">云端对象存储</option>
                </select>
              </label>
              <label className="select-row">
                <span>重计算位置</span>
                <select value={deploymentProfile.computeTarget} onChange={(event) => updateDeploymentProfile("computeTarget", event.target.value as DeploymentProfile["computeTarget"])}>
                  <option value="browser">当前浏览器</option>
                  <option value="lan-server">局域网服务器</option>
                  <option value="cloud-worker">云端任务节点</option>
                </select>
              </label>
              <label className="toggle-row deployment-toggle">
                <input
                  type="checkbox"
                  checked={deploymentProfile.allowExternalAssetLinks}
                  onChange={(event) => updateDeploymentProfile("allowExternalAssetLinks", event.target.checked)}
                />
                <span>允许加工包包含外部模型下载链接</span>
              </label>
              <button className="primary-action package-action" type="button" onClick={handleSaveDeploymentProfile}>
                <Save size={17} />
                保存部署方案
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <KeyRound size={18} />
                <h2>密钥与路径</h2>
              </div>
              <label className="field-control">
                <span>局域网访问地址</span>
                <input value={deploymentProfile.lanBaseUrl} onChange={(event) => updateDeploymentProfile("lanBaseUrl", event.target.value)} />
              </label>
              <label className="field-control">
                <span>云端 API 地址</span>
                <input value={deploymentProfile.cloudBaseUrl} onChange={(event) => updateDeploymentProfile("cloudBaseUrl", event.target.value)} placeholder="https://api.example.com" />
              </label>
              <label className="field-control">
                <span>Mesh/刀路缓存目录</span>
                <input value={deploymentProfile.meshCachePath} onChange={(event) => updateDeploymentProfile("meshCachePath", event.target.value)} />
              </label>
              <div className={`deployment-readiness ${deploymentReadiness.level}`}>
                <strong>{deploymentReadiness.title}</strong>
                <span>{deploymentReadiness.detail}</span>
              </div>
              <div className="deployment-checklist">
                {deploymentReadiness.checks.map((check) => (
                  <div className={check.status} key={check.label}>
                    <span>{check.label}</span>
                    <strong>{check.value}</strong>
                    <small>{check.detail}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <HardDrive size={18} />
                <h2>落地建议</h2>
              </div>
              <div className="deployment-advice">
                {deploymentReadiness.suggestions.map((suggestion) => (
                  <p key={suggestion}>{suggestion}</p>
                ))}
              </div>
            </section>
          </>
        )}

        {activeStage === "feedback" && (
          <>
            <section className="panel">
              <div className="panel-title">
                <Hammer size={18} />
                <h2>实机反馈</h2>
              </div>
              <p className="panel-note">记录空跑、软材料试雕或正式材料结果，把真实耗时、缺陷和照片绑定到当前参数。</p>
              <div className="feedback-outcomes" role="radiogroup" aria-label="实机结果">
                {(["success", "review", "failed"] as const).map((outcome) => (
                  <button
                    className={feedbackDraft.outcome === outcome ? "active" : ""}
                    key={outcome}
                    type="button"
                    onClick={() => setFeedbackDraft((current) => ({ ...current, outcome }))}
                  >
                    {formatFeedbackOutcome(outcome)}
                  </button>
                ))}
              </div>
              <label className="field-control">
                <span>真实耗时 min</span>
                <input
                  min="0"
                  step="0.1"
                  type="number"
                  value={feedbackDraft.actualMinutes}
                  onChange={(event) => setFeedbackDraft((current) => ({ ...current, actualMinutes: event.target.value }))}
                  placeholder={toolpath ? toolpath.estimatedMinutes.toFixed(1) : "待试雕"}
                />
              </label>
              <div className="feedback-issues">
                {feedbackIssueOptions.map((issue) => (
                  <button className={feedbackDraft.issues.includes(issue) ? "active" : ""} key={issue} type="button" onClick={() => toggleFeedbackIssue(issue)}>
                    {issue}
                  </button>
                ))}
              </div>
              <label className="field-control">
                <span>试雕备注</span>
                <textarea
                  value={feedbackDraft.notes}
                  onChange={(event) => setFeedbackDraft((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="例如：顶部欠切轻微，端部保留正常，进给可提高 10%。"
                />
              </label>
              <label className="upload photo-upload">
                <Camera size={18} />
                <span>{feedbackDraft.photoName ? `已选择：${feedbackDraft.photoName}` : "上传试雕照片"}</span>
                <input accept="image/*" type="file" onChange={handleFeedbackPhoto} />
              </label>
              {feedbackDraft.photoUrl && <img className="feedback-photo-preview" src={feedbackDraft.photoUrl} alt="试雕照片预览" />}
              <button className="primary-action package-action" type="button" onClick={handleSaveMachineFeedback}>
                <Save size={17} />
                保存实机反馈
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <BadgeInfo size={18} />
                <h2>反馈统计</h2>
              </div>
              <div className="feedback-summary">
                <span><strong>{machineFeedback.length}</strong> 记录</span>
                <span><strong>{machineFeedback.filter((item) => item.outcome === "success").length}</strong> 成功</span>
                <span><strong>{machineFeedback.filter((item) => item.outcome !== "success").length}</strong> 待优化</span>
                <span><strong>{calculateAverageActualMinutes(machineFeedback)}</strong> 平均耗时</span>
                <span><strong>{costCalibration.sampleCount}</strong> 校正样本</span>
                <span><strong>{costCalibration.sampleCount > 0 ? `${(costCalibration.averageErrorRate * 100).toFixed(1)}%` : "-"}</strong> 估算误差</span>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <Library size={18} />
                <h2>反馈记录</h2>
              </div>
              {machineFeedback.length === 0 ? (
                <p className="panel-note">还没有实机反馈。完成空跑或试雕后，把结果记录在这里，后续可复用成功参数。</p>
              ) : (
                <div className="feedback-list">
                  {machineFeedback.map((feedback) => (
                    <div className={`feedback-card ${feedback.outcome}`} key={feedback.id}>
                      <div>
                        <strong>{formatFeedbackOutcome(feedback.outcome)}</strong>
                        <span>{feedback.createdAt}</span>
                      </div>
                      <p>{feedback.machineName} / {feedback.toolName} / {feedback.materialName}</p>
                      <small>
                        估算 {feedback.estimatedMinutes?.toFixed(1) ?? "-"} min / 实际 {feedback.actualMinutes?.toFixed(1) ?? "-"} min
                        {feedback.issues.length > 0 ? ` / ${feedback.issues.join("、")}` : " / 无缺陷标签"}
                      </small>
                      {feedback.notes && <p>{feedback.notes}</p>}
                      {feedback.photoUrl && <img src={feedback.photoUrl} alt={feedback.photoName ?? "实机反馈照片"} />}
                      <div className="feedback-actions">
                        <button className="demo-action snapshot-action" type="button" onClick={() => restoreFeedbackSettings(feedback)}>
                          复用这组参数
                        </button>
                        <button className="mini-action" type="button" onClick={() => deleteMachineFeedback(feedback)}>
                          删除记录
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <h2>{workbenchTitle}</h2>
            <p>{workbenchHint}</p>
          </div>
          <div className="status-pill">
            <BadgeInfo size={16} />
            <span>{viewingSimulation ? "正在查看刀路模拟结果" : workbenchView === "heatmap" && toolpath ? "正在查看包络误差热力图" : workbenchView === "gcode" && toolpath ? "正在查看合并 G-code" : workbenchView === "report" && toolpath ? "正在查看加工报告摘要" : aiMeshUrl ? "已加载 Meshy AI 3D Mesh" : generatedDepth ? (isMultiviewGenerated ? "已生成本地360°环绕浮雕" : "已生成3D浮雕") : images.length > 0 ? "等待点击3D生成" : "未上传图片，显示内置示例"}</span>
          </div>
        </header>

        <div className="workbench-tabs" role="tablist" aria-label="workbench views">
          <button className={workbenchView === "model" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("model"); setIsSimulationMode(false); }}>3D模型</button>
          <button className={workbenchView === "simulation" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("simulation"); setIsSimulationMode(true); }} disabled={!toolpath}>模拟雕刻</button>
          <button className={workbenchView === "heatmap" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("heatmap"); setIsSimulationMode(false); }} disabled={!toolpath}>热力图</button>
          <button className={workbenchView === "gcode" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("gcode"); setIsSimulationMode(false); }} disabled={!toolpath}>G-code</button>
          <button className={workbenchView === "report" ? "active" : ""} type="button" onClick={() => { setWorkbenchView("report"); setIsSimulationMode(false); }} disabled={!toolpath}>报告</button>
        </div>

        {workbenchView === "gcode" && toolpath ? (
          <GcodePreview toolpath={toolpath} exportGateReady={exportGateReady} />
        ) : workbenchView === "heatmap" && toolpath && envelopeQuality ? (
          <EnvelopeHeatmapPreview toolpath={toolpath} settings={settings} envelopeQuality={envelopeQuality} />
        ) : workbenchView === "report" && toolpath ? (
          <WorkbenchReportSummary
            exportBlocked={exportBlocked}
            manufacturingQuality={manufacturingQuality}
            materialRemoval={materialRemoval}
            costEstimate={costEstimate}
            envelopeQuality={envelopeQuality}
            safetyIssues={safetyIssues}
          />
        ) : viewingSimulation ? (
          <SimulationViewer
            points={toolpath.points}
            previewPoints={toolpath.previewPoints ?? []}
            settings={settings}
            envelopeColor={toolpathColors.simulation}
            surfaceColor={toolpathKind === "finish" ? 0x9a6ff0 : 0xb95a1b}
          />
        ) : aiMeshUrl ? (
          <AiMeshViewer
            modelUrl={aiMeshUrl}
            toolpathPoints={toolpath?.points ?? []}
            previewPoints={toolpath?.previewPoints ?? []}
            toolpathColor={toolpathKind === "finish" ? toolpathColors.finish : toolpathColors.rough}
            meshLengthAxis={settings.meshLengthAxis}
            meshAxisReverse={settings.meshAxisReverse}
          />
        ) : (
          <ReliefViewer geometry={geometry} wireframe={wireframe} toolpathPoints={toolpath?.points ?? []} settings={settings} />
        )}

        <footer className="output-bar">
          {aiMeshUrl ? (
            <>
              <div className="metric">
                <span>模式</span>
                <strong>Meshy AI Mesh</strong>
              </div>
              <div className="metric wide">
                <span>模型</span>
                <strong>GLB/STL真实网格</strong>
              </div>
              {toolpath && (
                <div className="metric wide">
                  <span>刀路显示</span>
                  <strong>{toolpathKind === "finish" ? "精加工刀路" : "普通刀路"}</strong>
                </div>
              )}
              <a className={`download ${canDownloadProduction ? "" : "disabled-link"}`} href={aiMeshUrl} target="_blank" rel="noreferrer" aria-disabled={!canDownloadProduction} title={productionDownloadTitle} onClick={(event) => { if (!canDownloadProduction) event.preventDefault(); }}>
                <Download size={17} />
                下载 GLB
              </a>
              {aiMeshStlUrl && (
                <a className={`download secondary ${canDownloadProduction ? "" : "disabled-link"}`} href={aiMeshStlUrl} target="_blank" rel="noreferrer" aria-disabled={!canDownloadProduction} title={productionDownloadTitle} onClick={(event) => { if (!canDownloadProduction) event.preventDefault(); }}>
                  <Download size={17} />
                  下载 AI STL
                </a>
              )}
            </>
          ) : (
            <>
              <div className="metric">
                <span>网格</span>
                <strong>{settings.meshU} x {settings.meshV}</strong>
              </div>
              <div className="metric">
                <span>最大深度</span>
                <strong>{settings.depthMm.toFixed(2)} mm</strong>
              </div>
              <div className="metric">
                <span>雕刻角</span>
                <strong>{settings.reliefAngleDeg.toFixed(0)}°</strong>
              </div>
            </>
          )}
          {generatedDepth && !aiMeshUrl && (
            <div className="metric">
              <span>模式</span>
              <strong>{isMultiviewGenerated ? "本地环绕浮雕" : "浮雕网格"}</strong>
            </div>
          )}
          {!aiMeshUrl && (
            <button className="download secondary" onClick={() => exportGeometryAsStl(geometry, "nuclear-carving-relief.stl")} disabled={!canDownloadProduction} title={productionDownloadTitle}>
              <Download size={17} />
              下载 STL
            </button>
          )}
          {toolpath && (
            <>
              <div className="metric">
                <span>刀路点</span>
                <strong>{toolpath.points.length}</strong>
              </div>
              <div className="metric">
                <span>估算时间</span>
                <strong>{toolpath.estimatedMinutes.toFixed(1)} min</strong>
              </div>
              {costEstimate && (
                <div className="metric">
                  <span>成本估算</span>
                  <strong>{formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh)}</strong>
                </div>
              )}
              {toolpath.programs?.rough && (
                <div className="metric">
                  <span>粗加工</span>
                  <strong>{toolpath.programs.rough.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              {toolpath.programs?.finish && (
                <div className="metric">
                  <span>精加工</span>
                  <strong>{toolpath.programs.finish.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              {toolpath.programs?.rest && (
                <div className="metric">
                  <span>清残</span>
                  <strong>{toolpath.programs.rest.estimatedMinutes.toFixed(1)} min</strong>
                </div>
              )}
              <div className="metric">
                <span>后处理</span>
                <strong>{toolpath.postProcessorName}</strong>
              </div>
              <div className={`metric ${exportBlocked ? "warning" : "ok"}`}>
                <span>导出校验</span>
                <strong>{exportBlocked ? "存在阻断项" : "可导出"}</strong>
              </div>
              <div className="metric wide">
                <span>范围</span>
                <strong>
                  X {toolpath.summary.xMin.toFixed(1)}~{toolpath.summary.xMax.toFixed(1)} / A {toolpath.summary.aMin.toFixed(0)}~{toolpath.summary.aMax.toFixed(0)}
                </strong>
              </div>
              <div className={`metric wide ${toolpath.summary.warnings.length > 0 ? "warning" : "ok"}`}>
                <span>校验</span>
                <strong>{toolpath.summary.warnings[0] ?? "基础范围正常"}</strong>
              </div>
              {envelopeQuality && (
                <>
                  <div className={`metric ${envelopeQuality.score >= 92 ? "ok" : envelopeQuality.score >= 82 ? "" : "warning"}`}>
                    <span>包络评分</span>
                    <strong>{envelopeQuality.score.toFixed(1)} / 100</strong>
                  </div>
                  <div className="metric">
                    <span>贴合率</span>
                    <strong>{envelopeQuality.fitRate.toFixed(1)}%</strong>
                  </div>
                  <div className="metric">
                    <span>未贴合点</span>
                    <strong>{envelopeQuality.missCount}</strong>
                  </div>
                  <div className="metric">
                    <span>连续贴合</span>
                    <strong>{envelopeQuality.continuityRate.toFixed(1)}%</strong>
                  </div>
                </>
              )}
              <div className="metric legend-metric">
                <span>颜色标识</span>
                <strong>
                  <i className={`legend-dot ${viewingSimulation ? "simulation" : toolpathKind}`} />
                  {viewingSimulation
                    ? "青绿=模拟包络，粉色=未贴合"
                    : aiMeshUrl
                      ? `${toolpathKind === "finish" ? "紫色=精加工" : "橙红=普通刀路"}，粉色=未贴合`
                      : `${toolpathKind === "finish" ? "紫色=精加工" : "橙红=普通刀路"}，粉色=夹持区，琥珀=过渡区`}
                </strong>
              </div>
              <button className="download secondary" onClick={() => {
                const nextView: WorkbenchView = viewingSimulation ? "model" : "simulation";
                setWorkbenchView(nextView);
                setIsSimulationMode(nextView === "simulation");
              }}>
                <Layers3 size={17} />
                {viewingSimulation ? "返回3D视图" : "模拟雕刻"}
              </button>
              <button className="download secondary" onClick={handleDownloadOperatorPackage} disabled={isOperatorMode && !exportGateReady} title={productionDownloadTitle}>
                <Download size={17} />
                加工包说明
              </button>
              <button className="download secondary" onClick={handleDownloadAirRun} disabled={!airRunProgram} title="主轴关闭，Z 保持安全高度，用于离料空跑验证机器动作">
                <Download size={17} />
                下载空跑 NC
              </button>
              <button className="download" onClick={() => downloadText("nuclear-carving-toolpath.nc", toolpath.gcode)} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                <Download size={17} />
                下载合并 NC
              </button>
              {toolpath.programs?.rough && (
                <button className="download secondary" onClick={() => downloadText(toolpath.programs?.rough?.filename ?? "nuclear-carving-rough.nc", toolpath.programs?.rough?.gcode ?? "")} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                  <Download size={17} />
                  下载粗加工
                </button>
              )}
              {toolpath.programs?.finish && (
                <button className="download secondary" onClick={() => downloadText(toolpath.programs?.finish?.filename ?? "nuclear-carving-finish.nc", toolpath.programs?.finish?.gcode ?? "")} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                  <Download size={17} />
                  下载精加工
                </button>
              )}
              {toolpath.programs?.rest && (
                <button className="download secondary" onClick={() => downloadText(toolpath.programs?.rest?.filename ?? "nuclear-carving-rest.nc", toolpath.programs?.rest?.gcode ?? "")} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                  <Download size={17} />
                  下载清残
                </button>
              )}
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.tap", toolpath.tap)} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                <Download size={17} />
                下载 TAP
              </button>
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.txt", toolpath.txt)} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                <Download size={17} />
                下载 TXT
              </button>
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.csv", toolpath.csv, "text/csv")} disabled={!exportGateReady || !canDownloadProduction} title={productionDownloadTitle}>
                <Download size={17} />
                下载 CSV
              </button>
            </>
          )}
          {!toolpath && (
            <div className="hint">
              <ImagePlus size={17} />
              {aiMeshUrl ? "Meshy模型已加载，右侧可拖动查看" : images.length > 0 && !generatedDepth ? "先点击左侧“3D生成”" : "调好模型后点击左侧“生成刀路”"}
            </div>
          )}
        </footer>
      </section>
    </main>
  );
}

function GcodePreview({ toolpath, exportGateReady }: { toolpath: GeneratedToolpath; exportGateReady: boolean }) {
  const lines = toolpath.gcode.split(/\r?\n/).filter(Boolean);
  const head = lines.slice(0, 18);
  const tail = lines.slice(Math.max(18, lines.length - 18));

  return (
    <div className="workbench-panel">
      <div className="gcode-summary">
        <span><strong>{lines.length.toLocaleString()}</strong> 行 G-code</span>
        <span><strong>{toolpath.summary.xMin.toFixed(1)}~{toolpath.summary.xMax.toFixed(1)}</strong> X 范围</span>
        <span><strong>{toolpath.summary.aMin.toFixed(0)}~{toolpath.summary.aMax.toFixed(0)}</strong> A 范围</span>
        <span><strong>{exportGateReady ? "已解锁" : "待确认"}</strong> 正式导出</span>
      </div>
      <div className="gcode-preview-grid">
        <section>
          <h3>程序开头</h3>
          <pre>{head.join("\n")}</pre>
        </section>
        <section>
          <h3>程序结尾</h3>
          <pre>{tail.join("\n")}</pre>
        </section>
      </div>
    </div>
  );
}

function createTaskJobLog(message: string): TaskJobLog {
  return {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    message
  };
}

function formatTaskJobStatus(status: TaskJob["status"]) {
  if (status === "running") return "运行中";
  if (status === "done") return "完成";
  if (status === "canceled") return "已取消";
  return "失败";
}

function formatFeedbackOutcome(outcome: MachineFeedback["outcome"]) {
  if (outcome === "success") return "试雕成功";
  if (outcome === "review") return "需复核";
  return "失败/断刀";
}

function calculateAverageActualMinutes(feedback: MachineFeedback[]) {
  const values = feedback.map((item) => item.actualMinutes).filter((value): value is number => typeof value === "number" && value > 0);
  if (values.length === 0) return "-";
  return `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)} min`;
}

function createCostCalibrationReport(
  costEstimate: CostEstimate | null,
  feedback: MachineFeedback[],
  machineName: string,
  toolName: string
): CostCalibrationReport {
  const empty: CostCalibrationReport = {
    sampleCount: 0,
    averageRatio: 1,
    averageErrorRate: 0,
    calibratedTotalMinutes: costEstimate?.totalMinutes ?? 0,
    calibratedCostLow: costEstimate?.totalCostLow ?? 0,
    calibratedCostHigh: costEstimate?.totalCostHigh ?? 0,
    confidence: "none",
    matchedSamples: []
  };
  if (!costEstimate) return empty;

  const usable = feedback.filter((item) => item.actualMinutes && item.actualMinutes > 0 && item.estimatedMinutes && item.estimatedMinutes > 0);
  const matched = usable.filter((item) => item.machineName === machineName && item.toolName === toolName);
  const samples = (matched.length >= 2 ? matched : usable).slice(0, 12);
  if (samples.length === 0) return empty;

  const ratios = samples.map((item) => (item.actualMinutes ?? 0) / Math.max(1, item.estimatedMinutes ?? 1));
  const averageRatio = THREEClamp(ratios.reduce((sum, value) => sum + value, 0) / ratios.length, 0.45, 2.4);
  const averageErrorRate = samples.reduce((sum, item) => {
    const estimated = Math.max(1, item.estimatedMinutes ?? 1);
    return sum + Math.abs((item.actualMinutes ?? estimated) - estimated) / estimated;
  }, 0) / samples.length;
  const calibratedTotalMinutes = costEstimate.totalMinutes * averageRatio;
  const timeRatio = calibratedTotalMinutes / Math.max(1, costEstimate.totalMinutes);
  const calibratedCostLow = costEstimate.totalCostLow * timeRatio;
  const calibratedCostHigh = costEstimate.totalCostHigh * timeRatio;
  const confidence: CostCalibrationReport["confidence"] = samples.length >= 6 ? "high" : samples.length >= 3 ? "medium" : "low";

  return {
    sampleCount: samples.length,
    averageRatio,
    averageErrorRate,
    calibratedTotalMinutes,
    calibratedCostLow,
    calibratedCostHigh,
    confidence,
    matchedSamples: samples
  };
}

function formatCalibrationConfidence(confidence: CostCalibrationReport["confidence"]) {
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  if (confidence === "low") return "低";
  return "无样本";
}

function formatUserRole(role: UserRole) {
  if (role === "admin") return "管理员";
  if (role === "designer") return "设计员";
  if (role === "process") return "工艺员";
  return "操作员";
}

function getRolePermissionText(role: UserRole) {
  if (role === "operator") return "仅允许下载已通过安全校验并完成正式导出确认的文件；适合交给机台操作员。";
  if (role === "designer") return "可整理素材、生成模型和查看预览；正式导出仍需工艺/管理确认。";
  if (role === "process") return "可调整工艺、生成刀路、仿真并完成导出前确认。";
  return "拥有完整项目、工艺、导出和反馈管理权限。";
}

function formatDeploymentMode(mode: DeploymentMode) {
  if (mode === "local-only") return "纯本地单机";
  if (mode === "lan-proxy") return "店内局域网";
  return "云端混合";
}

function getDeploymentModeHint(mode: DeploymentMode) {
  if (mode === "local-only") return "适合离线演示和轻量试算，AI Key 不应放前端。";
  if (mode === "lan-proxy") return "推荐门店首版，前端访问局域网后端代理。";
  return "适合多门店协作，重计算和素材归档走云端。";
}

function formatApiKeyLocation(location: DeploymentProfile["apiKeyLocation"]) {
  if (location === "server-env") return "后端环境变量";
  if (location === "browser-local") return "浏览器本地";
  return "暂未配置";
}

function formatAssetStorage(storage: DeploymentProfile["assetStorage"]) {
  if (storage === "browser-cache") return "浏览器缓存";
  if (storage === "lan-server") return "局域网服务器";
  return "云端对象存储";
}

function formatComputeTarget(target: DeploymentProfile["computeTarget"]) {
  if (target === "browser") return "当前浏览器";
  if (target === "lan-server") return "局域网服务器";
  return "云端任务节点";
}

function createDeploymentReadiness(profile: DeploymentProfile) {
  const checks = [
    {
      label: "API Key",
      value: formatApiKeyLocation(profile.apiKeyLocation),
      status: profile.apiKeyLocation === "server-env" ? "ok" : profile.apiKeyLocation === "not-configured" ? "critical" : "warning",
      detail: profile.apiKeyLocation === "server-env"
        ? "Meshy 等密钥由后端代理读取，前端和加工包不暴露密钥。"
        : profile.apiKeyLocation === "browser-local"
          ? "浏览器本地存储适合临时测试，不建议用于客户素材生产。"
          : "AI 生成、修复和云端重计算会不可用。"
    },
    {
      label: "素材存储",
      value: formatAssetStorage(profile.assetStorage),
      status: profile.assetStorage === "browser-cache" && profile.mode !== "local-only" ? "warning" : "ok",
      detail: profile.assetStorage === "browser-cache"
        ? "刷新或换电脑后素材追溯能力较弱。"
        : "素材和生成模型可以随项目归档，便于复盘。"
    },
    {
      label: "重计算",
      value: formatComputeTarget(profile.computeTarget),
      status: profile.computeTarget === "browser" && profile.mode !== "local-only" ? "warning" : "ok",
      detail: profile.computeTarget === "browser"
        ? "高精度仿真和批量任务可能卡住页面。"
        : "长任务可进入后端队列，适合 Mesh 修复、CAM 和仿真。"
    },
    {
      label: "访问地址",
      value: profile.mode === "cloud-hybrid" ? profile.cloudBaseUrl || "未填写" : profile.lanBaseUrl || "未填写",
      status: (profile.mode === "cloud-hybrid" ? profile.cloudBaseUrl : profile.lanBaseUrl) ? "ok" : "critical",
      detail: profile.mode === "local-only" ? "单机可直接访问本机服务。" : "操作员电脑需要能稳定访问该地址。"
    }
  ] as Array<{ label: string; value: string; status: "ok" | "warning" | "critical"; detail: string }>;

  const criticalCount = checks.filter((check) => check.status === "critical").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const suggestions: string[] = [];
  if (profile.apiKeyLocation !== "server-env") suggestions.push("生产环境建议把 Meshy Key 放在后端 `.env`，前端只调用 `/api/*` 代理接口。");
  if (profile.mode === "lan-proxy") suggestions.push("门店首版推荐一台 Linux/Windows 小服务器运行前端和 API 代理，操作员通过局域网访问。");
  if (profile.mode === "cloud-hybrid") suggestions.push("云端混合需要对象存储、任务队列和访问审计；客户素材应按项目隔离。");
  if (profile.computeTarget === "browser") suggestions.push("高精度材料去除仿真、Mesh 修复和批量 CAM 建议迁移到后端任务队列。");
  if (!profile.allowExternalAssetLinks) suggestions.push("加工包默认不放外部模型链接，适合保护客户素材；需要跨设备复核时可临时开启。");
  if (suggestions.length === 0) suggestions.push("当前部署策略满足生产试用基线，可继续做局域网联调和权限审计。");

  return {
    level: criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok",
    title: criticalCount > 0 ? "部署方案存在阻断项" : warningCount > 0 ? "部署方案可试用但需复核" : "部署方案适合生产试用",
    detail: criticalCount > 0
      ? "请先补齐 API Key、访问地址或存储策略，再交给店内多人使用。"
      : warningCount > 0
        ? "可以继续本机测试，但正式处理客户素材前建议迁移到后端代理和可归档存储。"
        : "密钥、素材、任务和访问地址均有明确归属。",
    checks,
    suggestions
  };
}

function getProductionDownloadTitle(isOperatorMode: boolean, exportBlocked: boolean, exportGateReady: boolean) {
  if (isOperatorMode && !exportGateReady) return "操作员模式：只能下载已通过安全校验并完成正式确认的文件";
  if (exportBlocked) return "导出前安全校验存在阻断项";
  if (!exportGateReady) return "请先完成正式导出确认";
  return "下载已确认文件";
}

function captureWorkbenchPreviewPng() {
  const canvas = document.querySelector<HTMLCanvasElement>(".workbench .viewer canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrlToUint8Array(dataUrl);
  } catch {
    return null;
  }
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToUint8Array(dataUrl: string) {
  const [, base64 = ""] = dataUrl.split(",");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createPackageParameters(input: {
  projectProfile: ProjectProfile;
  deploymentProfile: DeploymentProfile;
  settings: ModelSettings;
  sourceLabel: string;
  aiMeshUrl: string | null;
  aiMeshStlUrl: string | null;
  selectedTool: ToolProfile;
  selectedMaterial: MaterialProfile;
  selectedMachine: MachineProfile;
  toolpath: GeneratedToolpath;
  manufacturingQuality: ManufacturingQualityReport;
  materialRemoval: MaterialRemovalReport | null;
  meshQuality: MeshQualityReport | null;
  costEstimate: CostEstimate | null;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
}) {
  return {
    packageVersion: "V2",
    createdAt: new Date().toISOString(),
    project: input.projectProfile,
    deployment: input.deploymentProfile,
    source: {
      label: input.sourceLabel,
      aiMeshUrl: input.aiMeshUrl,
      aiMeshStlUrl: input.aiMeshStlUrl
    },
    machine: input.selectedMachine,
    tool: input.selectedTool,
    material: input.selectedMaterial,
    settings: input.settings,
    toolpath: {
      postProcessorName: input.toolpath.postProcessorName,
      estimatedMinutes: input.toolpath.estimatedMinutes,
      summary: input.toolpath.summary,
      programFiles: {
        rough: input.toolpath.programs?.rough?.filename ?? null,
        finish: input.toolpath.programs?.finish?.filename ?? null,
        rest: input.toolpath.programs?.rest?.filename ?? null,
        combined: input.toolpath.programs?.combined?.filename ?? "nuclear-carving-combined.nc",
        airRun: input.toolpath.programs?.airRun?.filename ?? null
      }
    },
    quality: {
      manufacturing: input.manufacturingQuality,
      materialRemoval: input.materialRemoval,
      mesh: input.meshQuality,
      envelope: input.envelopeQuality
    },
    costEstimate: input.costEstimate
  };
}

function createPackageChecklist(
  input: Parameters<typeof createOperatorPackageMarkdown>[0],
  exportGateReady: boolean,
  usesAiMesh: boolean
) {
  const criticalCount = input.safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = input.safetyIssues.filter((issue) => issue.level === "warning").length;
  return [
    "# ZIP 加工包交付检查清单",
    "",
    `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `正式导出状态：${exportGateReady ? "已完成确认" : "未完成确认"}`,
    `风险项：阻断 ${criticalCount} / 提醒 ${warningCount}`,
    "",
    "## 必查文件",
    "",
    "- [ ] `operator-note.md` 已阅读",
    "- [ ] `reports/safety-report.json` 已复核",
    "- [ ] `parameters.json` 已归档",
    "- [ ] `preview/simulation-result.png` 已查看",
    "- [ ] `nc/nuclear-carving-air-run.nc` 已先空跑",
    "- [ ] 正式 NC/TAP/TXT 文件已按目标机床后处理确认",
    usesAiMesh ? "- [ ] `models/model-download-links.md` 中的 GLB/STL 已单独归档" : "- [ ] `models/source.stl` 已归档",
    "",
    "## 上机前确认",
    "",
    `- 机床：${input.machine.name}`,
    `- 刀具：${input.tool.name}`,
    `- 材料：${input.material.name}`,
    `- 左/右夹持：${input.settings.leftHoldMm.toFixed(1)} / ${input.settings.rightHoldMm.toFixed(1)} mm`,
    `- 安全高度：${input.settings.safeZ.toFixed(2)} mm`,
    `- 估算时间：${input.toolpath.estimatedMinutes.toFixed(1)} min`,
    "",
    "## 结论",
    "",
    criticalCount > 0
      ? "- 当前存在阻断项，不建议直接上机。"
      : "- 当前可进入离料空跑和低风险试雕流程。"
  ].join("\n");
}

function createFileSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

type EnvelopeHeatmapCell = {
  key: string;
  xIndex: number;
  aIndex: number;
  total: number;
  missCount: number;
  fitRate: number;
  status: "ok" | "warning" | "critical" | "empty";
};

function EnvelopeHeatmapPreview({
  toolpath,
  settings,
  envelopeQuality
}: {
  toolpath: GeneratedToolpath;
  settings: ModelSettings;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality>;
}) {
  const heatmap = createEnvelopeHeatmapCells(toolpath, settings);
  const maxSamples = Math.max(1, ...heatmap.cells.map((cell) => cell.total));
  const sourceLabel = toolpath.previewPoints && toolpath.previewPoints.length > 0 ? "Mesh 表面采样" : "刀路覆盖估算";

  return (
    <div className="workbench-panel heatmap-panel">
      <div className={`heatmap-verdict ${envelopeQuality.diagnosis.level}`}>
        <div>
          <span>{sourceLabel}</span>
          <strong>{envelopeQuality.diagnosis.title}</strong>
          <small>{envelopeQuality.diagnosis.detail}</small>
        </div>
        <b>{envelopeQuality.score.toFixed(1)}</b>
      </div>

      <div className="heatmap-summary">
        <div>
          <span>包络评分</span>
          <strong>{envelopeQuality.score.toFixed(1)} / 100</strong>
        </div>
        <div>
          <span>贴合率</span>
          <strong>{envelopeQuality.fitRate.toFixed(1)}%</strong>
        </div>
        <div>
          <span>未贴合点</span>
          <strong>{envelopeQuality.missCount.toLocaleString()}</strong>
        </div>
        <div>
          <span>连续贴合</span>
          <strong>{envelopeQuality.continuityRate.toFixed(1)}%</strong>
        </div>
      </div>

      <div className="heatmap-layout">
        <div className="heatmap-axis y-axis">A 轴角度</div>
        <div
          className="heatmap-grid"
          style={{ gridTemplateColumns: `repeat(${heatmap.xBins}, minmax(0, 1fr))` }}
          aria-label="包络误差热力图"
        >
          {heatmap.cells.map((cell) => {
            const opacity = cell.total > 0 ? 0.38 + (cell.total / maxSamples) * 0.62 : 1;
            const xStart = heatmap.xLabels[cell.xIndex] ?? "";
            const aStart = heatmap.aLabels[cell.aIndex] ?? "";
            const title = `X ${xStart} / A ${aStart} / 样本 ${cell.total} / 未贴合 ${cell.missCount} / 贴合 ${cell.fitRate.toFixed(1)}%`;
            return (
              <span
                className={`heatmap-cell ${cell.status}`}
                key={cell.key}
                style={{ opacity }}
                title={title}
              />
            );
          })}
        </div>
        <div className="heatmap-axis x-axis">X 长度方向</div>
      </div>

      <div className="heatmap-legend">
        <span><i className="ok" />贴合良好</span>
        <span><i className="warning" />局部风险</span>
        <span><i className="critical" />未贴合集中</span>
        <span><i className="empty" />无采样</span>
      </div>

      <div className="heatmap-suggestions">
        {envelopeQuality.diagnosis.suggestions.map((suggestion) => (
          <p key={suggestion}>{suggestion}</p>
        ))}
      </div>
    </div>
  );
}

function createEnvelopeHeatmapCells(toolpath: GeneratedToolpath, settings: ModelSettings) {
  const xBins = 28;
  const aBins = 18;
  const halfLength = settings.lengthMm / 2;
  const samples = toolpath.previewPoints && toolpath.previewPoints.length > 0
    ? toolpath.previewPoints.map((point) => ({
      x: point.x,
      a: normalizeAngleDeg((Math.atan2(point.y, point.z) * 180) / Math.PI),
      hit: point.hit
    }))
    : toolpath.points.map((point) => ({
      x: point.x,
      a: normalizeAngleDeg(point.a),
      hit: true
    }));
  const buckets = Array.from({ length: xBins * aBins }, (_, index) => ({
    total: 0,
    missCount: 0,
    xIndex: index % xBins,
    aIndex: Math.floor(index / xBins)
  }));

  for (const sample of samples) {
    const xRatio = THREEClamp((sample.x + halfLength) / Math.max(0.001, settings.lengthMm), 0, 0.999999);
    const aRatio = THREEClamp(sample.a / 360, 0, 0.999999);
    const xIndex = Math.floor(xRatio * xBins);
    const aIndex = aBins - 1 - Math.floor(aRatio * aBins);
    const bucket = buckets[aIndex * xBins + xIndex];
    bucket.total += 1;
    if (!sample.hit) bucket.missCount += 1;
  }

  const cells: EnvelopeHeatmapCell[] = buckets.map((bucket) => {
    const fitRate = bucket.total > 0 ? ((bucket.total - bucket.missCount) / bucket.total) * 100 : 100;
    const status = bucket.total === 0 ? "empty" : fitRate >= 96 ? "ok" : fitRate >= 88 ? "warning" : "critical";
    return {
      key: `${bucket.xIndex}-${bucket.aIndex}`,
      xIndex: bucket.xIndex,
      aIndex: bucket.aIndex,
      total: bucket.total,
      missCount: bucket.missCount,
      fitRate,
      status
    };
  });

  return {
    cells,
    xBins,
    aBins,
    xLabels: Array.from({ length: xBins }, (_, index) => `${(-halfLength + (settings.lengthMm * index) / xBins).toFixed(1)}mm`),
    aLabels: Array.from({ length: aBins }, (_, index) => `${Math.round((360 * (aBins - 1 - index)) / aBins)}deg`)
  };
}

function normalizeAngleDeg(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function WorkbenchReportSummary({
  exportBlocked,
  manufacturingQuality,
  materialRemoval,
  costEstimate,
  envelopeQuality,
  safetyIssues
}: {
  exportBlocked: boolean;
  manufacturingQuality: ManufacturingQualityReport;
  materialRemoval: MaterialRemovalReport | null;
  costEstimate: CostEstimate | null;
  envelopeQuality: ReturnType<typeof analyzeEnvelopeQuality> | null;
  safetyIssues: SafetyIssue[];
}) {
  const criticalCount = safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = safetyIssues.filter((issue) => issue.level === "warning").length;

  return (
    <div className="workbench-panel report-preview">
      <div className={`report-verdict ${exportBlocked ? "blocked" : manufacturingQuality.verdict}`}>
        <strong>{exportBlocked ? "禁止直接上机" : manufacturingQuality.summary}</strong>
        <span>阻断 {criticalCount} 项 / 提醒 {warningCount} 项</span>
      </div>
      <div className="report-preview-grid">
        <div>
          <span>加工质量</span>
          <strong>{manufacturingQuality.score.toFixed(1)} / 100</strong>
          <small>{manufacturingQuality.summary}</small>
        </div>
        <div>
          <span>材料去除</span>
          <strong>{materialRemoval ? `${materialRemoval.score.toFixed(1)} / 100` : "待生成"}</strong>
          <small>{materialRemoval?.summary ?? "生成刀路后显示仿真指标"}</small>
        </div>
        <div>
          <span>包络贴合</span>
          <strong>{envelopeQuality ? `${envelopeQuality.fitRate.toFixed(1)}%` : "待生成"}</strong>
          <small>{envelopeQuality ? `未贴合 ${envelopeQuality.missCount} 点` : "生成刀路后计算"}</small>
        </div>
        <div>
          <span>成本估算</span>
          <strong>{costEstimate ? formatCurrencyRange(costEstimate.totalCostLow, costEstimate.totalCostHigh) : "待生成"}</strong>
          <small>{costEstimate ? `总占机 ${costEstimate.totalMinutes.toFixed(1)} min` : "生成刀路后估算"}</small>
        </div>
      </div>
      <div className="report-preview-list">
        {manufacturingQuality.items.slice(0, 5).map((item) => (
          <div className={item.status} key={item.label}>
            <strong>{item.label}：{item.value}</strong>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
};

function Control({ label, value, min, max, step, suffix, onChange }: ControlProps) {
  return (
    <label className="control">
      <span>
        {label}
        <strong>{value}{suffix}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function createFinishingSettings(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    reliefAngleDeg: 360,
    stepoverMm: Math.min(settings.stepoverMm, Math.max(0.05, settings.toolDiameter * 0.18)),
    stepoverDeg: Math.min(settings.stepoverDeg, 0.6),
    feedRate: Math.max(30, Math.round(settings.feedRate * 0.65))
  };
}

function analyzeEnvelopeQuality(toolpath: GeneratedToolpath, settings: ModelSettings) {
  const preview = toolpath.previewPoints ?? [];
  const sourceCount = preview.length > 0 ? preview.length : toolpath.points.length;
  const hitCount = preview.length > 0 ? preview.filter((point) => point.hit).length : toolpath.points.length;
  const safeCutoff = settings.safeZ * 0.92;
  const safeMoveCount = toolpath.points.filter((point) => point.z >= safeCutoff).length;
  const missCount = Math.max(0, sourceCount - hitCount);
  const fitRate = sourceCount > 0 ? (hitCount / sourceCount) * 100 : 0;
  const safeRate = toolpath.points.length > 0 ? (safeMoveCount / toolpath.points.length) * 100 : 0;
  const continuityRate = preview.length > 1 ? calculateContinuityRate(preview) : 100;
  const zJumpRate = calculateZJumpRate(toolpath.points, settings);
  const score = THREEClamp(fitRate * 0.58 + continuityRate * 0.28 + (100 - safeRate) * 0.1 + (100 - zJumpRate) * 0.04, 0, 100);
  const regions = createEnvelopeRegionStats(preview, toolpath.points, settings);
  const diagnosis = createEnvelopeDiagnosis({ fitRate, missCount, continuityRate, zJumpRate, regions });

  return {
    score,
    fitRate,
    missCount,
    continuityRate,
    safeRate,
    zJumpRate,
    regions,
    diagnosis
  };
}

type EnvelopeRegionStat = {
  label: string;
  total: number;
  missCount: number;
  fitRate: number;
  status: "ok" | "warning" | "critical";
};

function createEnvelopeRegionStats(
  preview: Array<{ x: number; y: number; z: number; hit: boolean }>,
  toolpathPoints: Array<{ x: number; a: number }>,
  settings: ModelSettings
): EnvelopeRegionStat[] {
  const regions = [
    createRegionBucket("左端"),
    createRegionBucket("主体"),
    createRegionBucket("右端"),
    createRegionBucket("顶部"),
    createRegionBucket("底部")
  ];

  const samples = preview.length > 0
    ? preview.map((point) => ({ x: point.x, angle: Math.atan2(point.y, point.z), hit: point.hit }))
    : toolpathPoints.map((point) => ({ x: point.x, angle: (point.a * Math.PI) / 180, hit: true }));

  const halfLength = settings.lengthMm / 2;
  const leftLimit = -halfLength + settings.leftHoldMm + Math.max(settings.endTransitionMm, settings.toolDiameter);
  const rightLimit = halfLength - settings.rightHoldMm - Math.max(settings.endTransitionMm, settings.toolDiameter);

  for (const point of samples) {
    if (point.x <= leftLimit) addRegionSample(regions[0], point.hit);
    else if (point.x >= rightLimit) addRegionSample(regions[2], point.hit);
    else addRegionSample(regions[1], point.hit);

    if (point.angle > Math.PI * 0.22 && point.angle < Math.PI * 0.78) {
      addRegionSample(regions[3], point.hit);
    }
    if (point.angle < -Math.PI * 0.22 && point.angle > -Math.PI * 0.78) {
      addRegionSample(regions[4], point.hit);
    }
  }

  return regions.map((region) => finalizeRegion(region));
}

function createRegionBucket(label: string) {
  return { label, total: 0, missCount: 0 };
}

function addRegionSample(region: { total: number; missCount: number }, hit: boolean) {
  region.total += 1;
  if (!hit) region.missCount += 1;
}

function finalizeRegion(region: { label: string; total: number; missCount: number }): EnvelopeRegionStat {
  const fitRate = region.total > 0 ? ((region.total - region.missCount) / region.total) * 100 : 100;
  return {
    ...region,
    fitRate,
    status: fitRate >= 96 ? "ok" : fitRate >= 88 ? "warning" : "critical"
  };
}

function createEnvelopeDiagnosis(input: {
  fitRate: number;
  missCount: number;
  continuityRate: number;
  zJumpRate: number;
  regions: EnvelopeRegionStat[];
}) {
  const problematic = input.regions.filter((region) => region.total > 0 && region.status !== "ok").sort((a, b) => a.fitRate - b.fitRate);
  const worst = problematic[0];
  const suggestions: string[] = [];
  let title = "包络贴合正常";
  let detail = "当前刀路采样与目标网格整体贴合，未发现明显区域性缺损。";
  let level: "ok" | "warning" | "critical" = "ok";

  if (input.fitRate < 88 || input.continuityRate < 82) {
    level = "critical";
    title = "存在明显未贴合区域";
    detail = worst ? `${worst.label}贴合率最低，仅 ${worst.fitRate.toFixed(1)}%，可能来自 Mesh 缺损、姿态偏轴或端部过渡过窄。` : "整体贴合率偏低，请优先检查 Mesh 质量和旋转轴。";
  } else if (input.fitRate < 96 || problematic.length > 0) {
    level = "warning";
    title = "局部区域建议复核";
    detail = worst ? `${worst.label}存在局部未贴合，贴合率 ${worst.fitRate.toFixed(1)}%。` : "整体贴合可用，但建议上机前复核局部细节。";
  }

  if (problematic.some((region) => region.label === "左端" || region.label === "右端")) {
    suggestions.push("未贴合集中在两端时，优先检查夹持区、端部过渡和 AI Mesh 端部是否缺面。");
  }
  if (problematic.some((region) => region.label === "顶部" || region.label === "底部")) {
    suggestions.push("未贴合集中在顶部/底部时，优先使用 Mesh 修复、重网格或重新校准旋转轴。");
  }
  if (input.zJumpRate > 8) {
    suggestions.push("Z 向跳变偏多，建议降低步距、平滑 Mesh 或减小单层切深。");
  }
  if (input.missCount > 0 && suggestions.length === 0) {
    suggestions.push("存在少量未贴合点，可先模拟雕刻并查看粉色标记是否集中成片。");
  }
  if (suggestions.length === 0) {
    suggestions.push("包络指标正常，可继续做模拟雕刻和空跑验证。");
  }

  return { level, title, detail, suggestions };
}

function calculateContinuityRate(points: Array<{ hit: boolean }>) {
  let totalTransitions = 0;
  let continuousHits = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (!points[i - 1].hit && !points[i].hit) continue;
    totalTransitions += 1;
    if (points[i - 1].hit && points[i].hit) {
      continuousHits += 1;
    }
  }
  return totalTransitions > 0 ? (continuousHits / totalTransitions) * 100 : 100;
}

function calculateZJumpRate(points: Array<{ z: number }>, settings: ModelSettings) {
  if (points.length < 2) return 0;
  const jumpThreshold = Math.max(settings.toolDiameter * 2.5, settings.depthMm * 1.8, 0.5);
  let jumps = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i].z - points[i - 1].z) > jumpThreshold) {
      jumps += 1;
    }
  }
  return (jumps / (points.length - 1)) * 100;
}

function THREEClamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function depthMapToPreviewUrl(depthMap: DepthMap): string {
  const canvas = document.createElement("canvas");
  canvas.width = depthMap.width;
  canvas.height = depthMap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const image = ctx.createImageData(depthMap.width, depthMap.height);
  for (let i = 0; i < depthMap.values.length; i += 1) {
    const shade = Math.round(255 - depthMap.values[i] * 235);
    const p = i * 4;
    image.data[p] = shade;
    image.data[p + 1] = Math.max(0, shade - 22);
    image.data[p + 2] = Math.max(0, shade - 48);
    image.data[p + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function createCaptureGuideReport(images: CarvingImage[]): CaptureGuideReport {
  const angleLabels = ["正面", "左侧", "右侧", "背面"];
  const slots = angleLabels.map((label, index): CaptureGuideSlot => {
    const image = images[index];
    if (!image) {
      return {
        label,
        imageName: null,
        score: null,
        status: "missing",
        hint: "缺少该角度"
      };
    }

    const score = image.quality?.score ?? 60;
    const status: CaptureGuideSlot["status"] = score >= 82 ? "ready" : score >= 64 ? "usable" : "retake";
    return {
      label,
      imageName: image.name,
      score,
      status,
      hint: status === "ready" ? `${score.toFixed(1)} 分，可用` : status === "usable" ? `${score.toFixed(1)} 分，建议复核` : `${score.toFixed(1)} 分，建议重拍`
    };
  });

  const presentSlots = slots.filter((slot) => slot.status !== "missing");
  const missingCount = slots.length - presentSlots.length;
  const retakeCount = slots.filter((slot) => slot.status === "retake").length;
  const usableCount = slots.filter((slot) => slot.status === "usable").length;
  const averageQuality = presentSlots.length > 0 ? presentSlots.reduce((sum, slot) => sum + (slot.score ?? 0), 0) / presentSlots.length : 0;
  const coverageScore = Math.min(1, images.length / 4) * 42;
  const qualityScore = Math.min(1, averageQuality / 90) * 48;
  const penalty = retakeCount * 12 + usableCount * 4 + Math.max(0, images.length - 4) * 2;
  const score = THREEClamp(coverageScore + qualityScore + (missingCount === 0 ? 10 : 0) - penalty, 0, 100);
  const verdict: CaptureGuideReport["verdict"] = score >= 82 && missingCount === 0 && retakeCount === 0 ? "ready" : score >= 62 && images.length >= 2 ? "usable" : "retake";
  const summary =
    verdict === "ready"
      ? "适合进入 AI 多图 3D 生成"
      : verdict === "usable"
        ? "可用于测试，建议补齐或复核角度"
        : "建议补拍后再生成 3D Mesh";

  const suggestions: string[] = [];
  if (images.length < 4) suggestions.push(`建议补齐 4 个角度，目前还缺 ${4 - images.length} 张。`);
  if (images.length > 4) suggestions.push("Meshy 多图入口最多使用前 4 张，请把最佳角度排在前面。");
  if (missingCount > 0) suggestions.push(`缺少：${slots.filter((slot) => slot.status === "missing").map((slot) => slot.label).join("、")}。`);
  if (retakeCount > 0) suggestions.push("存在低质量照片，建议固定手机、加强补光并使用纯色背景重拍。");
  if (usableCount > 0) suggestions.push("部分照片可用于测试，但正式生成前建议复核主体是否居中、边缘是否清晰。");
  if (suggestions.length === 0) suggestions.push("角度覆盖和基础质量正常，可以进入 Meshy 或其他 AI Provider 生成。");

  return { score, verdict, summary, slots, suggestions };
}

async function imageToDataUri(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片转base64失败"));
    reader.readAsDataURL(blob);
  });
}

async function pollMeshyTask(taskId: string, onStatus: (status: string) => void) {
  return pollAi3dTask(`/api/meshy/multi-image-to-3d/${encodeURIComponent(taskId)}`, onStatus, "Meshy任务");
}

async function pollMeshyTaskByEndpoint(endpoint: string, onStatus: (status: string) => void, label: string) {
  return pollAi3dTask(endpoint, onStatus, label);
}

async function pollAi3dTask(endpoint: string, onStatus: (status: string) => void, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(endpoint);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? data.message ?? "Meshy任务查询失败");
    }

    const status = data.status ?? data.state ?? "UNKNOWN";
    const progress = typeof data.progress === "number" ? ` ${Math.round(data.progress * 100)}%` : "";
    onStatus(`${label} ${status}${progress}`);

    if (status === "SUCCEEDED" || status === "succeeded" || status === "COMPLETED") {
      return data;
    }

    if (status === "FAILED" || status === "failed" || status === "CANCELED") {
      throw new Error(data.task_error?.message ?? data.error ?? "Meshy任务失败");
    }

    await new Promise((resolve) => window.setTimeout(resolve, 6000));
  }

  throw new Error(`${label}等待超时`);
}
