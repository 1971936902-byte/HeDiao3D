import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { BadgeInfo, Box, Download, FileImage, Hammer, ImagePlus, Layers3, Library, ShieldCheck, SlidersHorizontal, Sparkles, UploadCloud } from "lucide-react";
import { generateToolpath, downloadText } from "./cam";
import { createBlankDepthMap, createDemoDepthMap, createReliefGeometry } from "./geometry";
import { assetUrlToDepthMap, blendDepthMaps, createMultiViewDepthMap, fileToDepthMap, processDepthMap } from "./imageProcessing";
import { DepthEditor } from "./DepthEditor";
import { AiMeshViewer } from "./AiMeshViewer";
import { exportGeometryAsStl } from "./modelExport";
import { ReliefViewer } from "./ReliefViewer";
import { SimulationViewer } from "./SimulationViewer";
import {
  applyMachineProfile,
  applyMaterialProfile,
  applyToolProfile,
  getMachineProfile,
  getMaterialProfile,
  getToolProfile,
  hasCriticalIssue,
  machineProfiles,
  materialProfiles,
  toolProfiles,
  validateManufacturingSetup
} from "./manufacturingProfiles";
import { analyzeDepthMapQuality, createManufacturingQualityReport } from "./quality";
import type { CarvingImage, DepthMap, GeneratedToolpath, MeshQualityReport, ModelSettings } from "./types";

const defaultSettings: ModelSettings = {
  lengthMm: 38,
  diameterMm: 15,
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
type WorkflowStage = "source" | "model" | "process" | "cam";

const toolpathColors = {
  rough: 0xd2451e,
  finish: 0x8b5cf6,
  simulation: 0x00a676
};

const workflowStages: Array<{ id: WorkflowStage; label: string; hint: string }> = [
  { id: "source", label: "素材", hint: "上传/载入" },
  { id: "model", label: "建模", hint: "3D/Meshy" },
  { id: "process", label: "工艺", hint: "刀具/机床" },
  { id: "cam", label: "CAM", hint: "刀路/导出" }
];

export function App() {
  const [images, setImages] = useState<CarvingImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [activeStage, setActiveStage] = useState<WorkflowStage>("source");
  const [wireframe, setWireframe] = useState(false);
  const [toolpath, setToolpath] = useState<GeneratedToolpath | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [generatedDepth, setGeneratedDepth] = useState<DepthMap | null>(null);
  const [generationLabel, setGenerationLabel] = useState("内置示例");
  const [aiMeshUrl, setAiMeshUrl] = useState<string | null>(null);
  const [aiMeshStlUrl, setAiMeshStlUrl] = useState<string | null>(null);
  const [aiMeshStatus, setAiMeshStatus] = useState("未生成");
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isMeshRepairing, setIsMeshRepairing] = useState(false);
  const [isToolpathGenerating, setIsToolpathGenerating] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [toolpathKind, setToolpathKind] = useState<ToolpathKind>("rough");
  const [meshQuality, setMeshQuality] = useState<MeshQualityReport | null>(null);
  const [meshQualityStatus, setMeshQualityStatus] = useState("等待 STL 模型");

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
  const safetyIssues = useMemo(() => validateManufacturingSetup(settings, toolpath), [settings, toolpath]);
  const exportBlocked = hasCriticalIssue(safetyIssues);
  const activeQuality = activeImage?.quality;
  const manufacturingQuality = useMemo(
    () => createManufacturingQualityReport(settings, toolpath, safetyIssues, envelopeQuality),
    [settings, toolpath, safetyIssues, envelopeQuality]
  );

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
  };

  const applySettingsPreset = (nextSettings: ModelSettings) => {
    setSettings(nextSettings);
    setToolpath(null);
    setIsSimulationMode(false);
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
    } finally {
      setIsReading(false);
      event.target.value = "";
    }
  };

  const handleGenerateToolpath = async () => {
    await generateToolpathForSettings(settings, false);
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
      try {
        const response = await fetch("/api/cam/mesh-toolpath", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stlUrl: aiMeshStlUrl, settings: meshCamSettings })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error ?? "Mesh CAM 刀路生成失败");
        }
        setToolpath(data);
        setToolpathKind(finishing ? "finish" : "rough");
        setIsSimulationMode(true);
        setAiMeshStatus(finishing ? "Mesh 精加工刀路已生成，可下载 NC/TAP 文件" : "Mesh 360° 表面采样刀路已生成，可下载 NC/TAP 文件");
      } catch (error) {
        setAiMeshStatus(error instanceof Error ? error.message : "Mesh CAM 刀路生成失败");
      } finally {
        setIsToolpathGenerating(false);
      }
      return;
    }

    setToolpath(generateToolpath(processedDepth, baseSettings));
    setToolpathKind(finishing ? "finish" : "rough");
    setIsSimulationMode(true);
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
    } else {
      setGenerationLabel(settings.generationMode === "blend" ? `多图融合：${images.length}张图片` : `当前图片：${activeImage?.name ?? images[0].name}`);
    }
    setToolpath(null);
    setIsSimulationMode(false);
  };

  const handleDepthEdit = (depth: DepthMap) => {
    setGeneratedDepth(depth);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setToolpath(null);
    setIsSimulationMode(false);
  };

  const handleClearAiMesh = () => {
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setAiMeshStatus("未生成");
    setGenerationLabel(generatedDepth ? "本地浮雕网格" : images.length > 0 ? "图片已载入，待生成3D" : "内置示例");
    setToolpath(null);
    setIsSimulationMode(false);
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
    } finally {
      setIsReading(false);
    }
  };

  const handleGenerateAiMesh = async () => {
    if (images.length === 0) {
      setAiMeshStatus("请先上传图片或载入素材");
      return;
    }

    setIsAiGenerating(true);
    setAiMeshUrl(null);
    setAiMeshStlUrl(null);
    setMeshQuality(null);
    setToolpath(null);

    try {
      const selected = images.slice(0, 4);
      setAiMeshStatus(`准备上传 ${selected.length} 张图片到 Meshy`);
      const imageUrls = await Promise.all(selected.map((image) => imageToDataUri(image.url)));

      setAiMeshStatus("已提交 Meshy 任务，等待排队");
      const createResponse = await fetch("/api/meshy/multi-image-to-3d", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: imageUrls,
          target_formats: ["glb", "stl"]
        })
      });

      const createData = await createResponse.json();
      if (!createResponse.ok) {
        throw new Error(createData.error ?? createData.message ?? "Meshy任务创建失败");
      }

      const taskId = createData.result ?? createData.id;
      if (!taskId) {
        throw new Error("Meshy响应中没有任务ID");
      }

      const task = await pollMeshyTask(taskId, setAiMeshStatus);
      const glb = task.local_model_urls?.glb ?? task.model_urls?.glb ?? task.output?.model_urls?.glb ?? task.model_url;
      const stl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!glb) {
        throw new Error("Meshy任务已完成，但没有返回GLB模型地址");
      }

      setAiMeshUrl(glb);
      setAiMeshStlUrl(stl ?? null);
      setSettings((current) => ({ ...current, reliefAngleDeg: 360 }));
      setGenerationLabel(`AI 3D Mesh：${selected.length}张图片`);
      setAiMeshStatus(task.local_model_urls?.glb ? "Meshy 3D Mesh 生成完成，已缓存到本地" : "Meshy 3D Mesh 生成完成");
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Meshy生成失败");
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
  };

  const handleRepairMesh = async () => {
    if (!aiMeshStlUrl) {
      setAiMeshStatus("当前没有可修复的本地 STL，请先生成或载入 Meshy 模型");
      return;
    }

    setIsMeshRepairing(true);
    setAiMeshStatus("正在提交 Meshy 可制造性修复任务");
    try {
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

      const task = await pollMeshyTaskByEndpoint(`/api/meshy/repair-printability/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh修复");
      const repairedStl = task.local_model_urls?.stl ?? task.model_urls?.stl ?? task.output?.model_urls?.stl;
      if (!repairedStl) throw new Error("Mesh 修复完成，但没有返回 STL");

      setAiMeshStlUrl(repairedStl);
      setMeshQuality(null);
      setToolpath(null);
      setIsSimulationMode(false);
      setAiMeshStatus("Mesh 缺损修复完成，已替换刀路用 STL，请重新生成刀路");
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 修复失败");
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
    try {
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

      const task = await pollMeshyTaskByEndpoint(`/api/meshy/remesh/${encodeURIComponent(taskId)}`, setAiMeshStatus, "Mesh重网格");
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
    } catch (error) {
      setAiMeshStatus(error instanceof Error ? error.message : "Mesh 重网格失败");
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
              <p className="panel-note">使用前 1-4 张图片调用 Meshy 多图转 3D，生成真正的 GLB/STL 三维网格。</p>
              <button className="primary-action ai-action" onClick={handleGenerateAiMesh} disabled={isAiGenerating || images.length === 0}>
                <Sparkles size={18} />
                {isAiGenerating ? "AI生成中..." : "Meshy生成3D Mesh"}
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
            <div className="safety-list">
              {safetyIssues.map((issue, index) => (
                <div className={`safety-item ${issue.level}`} key={`${issue.title}-${index}`}>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                </div>
              ))}
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
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <h2>{isSimulationMode && toolpath ? "模拟雕刻" : generationLabel}</h2>
            <p>{isSimulationMode && toolpath ? "按当前刀路反推雕刻包络曲面，用于下载前检查方向、深浅和包覆范围" : "拖动旋转查看 360° 视图，滚轮缩放，右键平移"}</p>
          </div>
          <div className="status-pill">
            <BadgeInfo size={16} />
            <span>{isSimulationMode && toolpath ? "正在查看刀路模拟结果" : aiMeshUrl ? "已加载 Meshy AI 3D Mesh" : generatedDepth ? (isMultiviewGenerated ? "已生成本地360°环绕浮雕" : "已生成3D浮雕") : images.length > 0 ? "等待点击3D生成" : "未上传图片，显示内置示例"}</span>
          </div>
        </header>

        {isSimulationMode && toolpath ? (
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
              <a className="download" href={aiMeshUrl} target="_blank" rel="noreferrer">
                <Download size={17} />
                下载 GLB
              </a>
              {aiMeshStlUrl && (
                <a className="download secondary" href={aiMeshStlUrl} target="_blank" rel="noreferrer">
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
            <button className="download secondary" onClick={() => exportGeometryAsStl(geometry, "nuclear-carving-relief.stl")}>
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
                  <i className={`legend-dot ${isSimulationMode ? "simulation" : toolpathKind}`} />
                  {isSimulationMode
                    ? "青绿=模拟包络，粉色=未贴合"
                    : aiMeshUrl
                      ? `${toolpathKind === "finish" ? "紫色=精加工" : "橙红=普通刀路"}，粉色=未贴合`
                      : `${toolpathKind === "finish" ? "紫色=精加工" : "橙红=普通刀路"}，粉色=夹持区，琥珀=过渡区`}
                </strong>
              </div>
              <button className="download secondary" onClick={() => setIsSimulationMode((current) => !current)}>
                <Layers3 size={17} />
                {isSimulationMode ? "返回3D视图" : "模拟雕刻"}
              </button>
              <button className="download" onClick={() => downloadText("nuclear-carving-toolpath.nc", toolpath.gcode)} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载 NC"}>
                <Download size={17} />
                下载合并 NC
              </button>
              {toolpath.programs?.rough && (
                <button className="download secondary" onClick={() => downloadText(toolpath.programs?.rough?.filename ?? "nuclear-carving-rough.nc", toolpath.programs?.rough?.gcode ?? "")} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载粗加工 NC"}>
                  <Download size={17} />
                  下载粗加工
                </button>
              )}
              {toolpath.programs?.finish && (
                <button className="download secondary" onClick={() => downloadText(toolpath.programs?.finish?.filename ?? "nuclear-carving-finish.nc", toolpath.programs?.finish?.gcode ?? "")} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载精加工 NC"}>
                  <Download size={17} />
                  下载精加工
                </button>
              )}
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.tap", toolpath.tap)} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载 TAP"}>
                <Download size={17} />
                下载 TAP
              </button>
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.txt", toolpath.txt)} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载 TXT"}>
                <Download size={17} />
                下载 TXT
              </button>
              <button className="download secondary" onClick={() => downloadText("nuclear-carving-toolpath.csv", toolpath.csv, "text/csv")} disabled={exportBlocked} title={exportBlocked ? "导出前安全校验存在阻断项" : "下载 CSV"}>
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

  return {
    score,
    fitRate,
    missCount,
    continuityRate,
    safeRate,
    zJumpRate
  };
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
  return pollMeshyTaskByEndpoint(`/api/meshy/multi-image-to-3d/${encodeURIComponent(taskId)}`, onStatus, "Meshy任务");
}

async function pollMeshyTaskByEndpoint(endpoint: string, onStatus: (status: string) => void, label: string) {
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

  throw new Error("Meshy任务等待超时");
}
