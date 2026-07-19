#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const sources = new Map();

const layers = [
  {
    id: "frontend-hediao3d",
    title: "Frontend HeDiao3D",
    responsibility: "素材、模型预览、参数、中文工艺流程、报告、下载",
    evidence: [
      includes("src/App.tsx", "V3_TRIAL_FOCUSED_UI = true", "V3 focused operator UI is enabled by default."),
      includes("src/App.tsx", "下载安全试雕包", "Operator can download the safe-trial package from the UI."),
      includes("src/App.tsx", "模拟雕刻", "Workbench exposes carving simulation preview."),
      includes("src/App.tsx", "报告", "Workbench exposes report view."),
      includes("src/App.tsx", "导入原始3D模型", "Operator can import original STL/OBJ/GLB-style 3D model inputs.")
    ]
  },
  {
    id: "backend-orchestrator",
    title: "Backend Orchestrator",
    responsibility: "任务队列、文件缓存、模型修复、调用外部 CAM 引擎",
    evidence: [
      includes("server.mjs", "async function writeJobManifest(job)", "Jobs are persisted under the Orchestrator workspace."),
      includes("server.mjs", "public\", \"orchestrator-jobs", "Job file cache uses public/orchestrator-jobs for artifacts."),
      includes("server.mjs", "async function cacheMeshyAssets(taskId, task)", "Meshy model assets are cached through the backend."),
      includes("server.mjs", "repair-plan.json", "Model repair planning artifacts are generated."),
      includes("server.mjs", "cam-server-config.json", "External CAM server configuration is generated per job."),
      includes("server.mjs", "getOrchestratorLinuxCamJobPackage", "Unified Linux CAM job packages can be created.")
    ]
  },
  {
    id: "cam-engine-layer",
    title: "CAM Engine Layer",
    responsibility: "FreeCAD CAM / BlenderCAM / OpenCAMLib 更专业刀路生成",
    evidence: [
      includes("server.mjs", "FreeCAD CAM", "FreeCAD CAM adapter planning is represented."),
      includes("server.mjs", "BlenderCAM / FabexCNC", "BlenderCAM/FabexCNC adapter planning is represented."),
      includes("server.mjs", "OpenCAMLib", "OpenCAMLib adapter and Linux package planning are represented."),
      includes("server.mjs", "neutral-toolpath.json", "External CAM can hand off neutral toolpath data."),
      includes("scripts/v3-linux-native-cam-check.mjs", "opencamlib-real-candidate-run.mjs", "Linux native CAM package includes the OpenCAMLib real-candidate runner."),
      includes("scripts/v3-opencamlib-candidate-package-validate.mjs", "hediao3d.neutral-toolpath.v1", "OpenCAMLib candidate package validates the neutral toolpath schema.")
    ]
  },
  {
    id: "simulation-layer",
    title: "Simulation Layer",
    responsibility: "CAMotics + 自研旋转包裹预览、材料去除仿真、空跑验证",
    evidence: [
      includes("server.mjs", "CAMotics", "CAMotics/equivalent simulation package flow is represented."),
      includes("server.mjs", "rotary-wrap-preview-report.json", "Self-built rotary-wrap preview report is generated."),
      includes("scripts/v3-camotics-material-removal-validate.mjs", "hediao3d.camotics-result-local-validation.v1", "Material-removal validation has a stable schema."),
      includes("scripts/v3-camotics-material-removal-validate.mjs", "camotics-result-bundle.zip", "Validated material-removal evidence can be bundled for import."),
      includes("server.mjs", "air-run.nc", "Air-run files are part of the safe-trial and evidence workflow.")
    ]
  },
  {
    id: "postprocess-layer",
    title: "Postprocess Layer",
    responsibility: "三轴控制器 + Y轴旋转夹具专用 NC",
    evidence: [
      includes("src/manufacturingProfiles.ts", "desktop-3axis-rotary-y", "Target machine profile exists."),
      includes("src/manufacturingProfiles.ts", "vflat-4mm-25deg", "4mm 25 degree flat-tip V tool profile exists."),
      includes("src/manufacturingProfiles.ts", "postProcessor: \"wrapY\"", "Target machine defaults to wrapY postprocess."),
      includes("server.mjs", "ROTARY_WRAP_AXIS=Y", "Generated/validated NC declares Y rotary wrap boundary."),
      includes("server.mjs", "createPostprocessTraceReport", "Postprocess trace report is generated."),
      includes("scripts/v3-postprocess-regression-test.mjs", "wrapY", "Postprocess regression covers wrapY.")
    ]
  }
];

const layerReports = layers.map((layer) => {
  const evidence = layer.evidence.map((item) => evaluateEvidence(item));
  const failed = evidence.filter((item) => !item.ok);
  return {
    id: layer.id,
    title: layer.title,
    responsibility: layer.responsibility,
    ok: failed.length === 0,
    coverage: `${evidence.length - failed.length}/${evidence.length}`,
    evidence,
    missing: failed.map((item) => item.id)
  };
});

const failedLayers = layerReports.filter((layer) => !layer.ok);
const report = {
  schema: "hediao3d.v3-architecture-coverage-audit.v1",
  ok: failedLayers.length === 0,
  checkedAt: new Date().toISOString(),
  scope: "V3 requested five-layer architecture",
  productionBoundary: "This audit proves architecture coverage in the current codebase. It does not prove production CAM accuracy or unlock production NC.",
  layers: layerReports,
  failedLayers: failedLayers.map((layer) => layer.id),
  summary: failedLayers.length === 0
    ? "V3 architecture coverage audit passed for frontend, Orchestrator, CAM engine handoff, simulation and wrapY postprocess layers."
    : `V3 architecture coverage audit failed in ${failedLayers.length} layer(s): ${failedLayers.map((layer) => layer.id).join(", ")}.`
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);

function includes(file, needle, summary) {
  return {
    id: `${file}:${needle}`,
    file,
    needle,
    summary
  };
}

function evaluateEvidence(item) {
  const content = readSource(item.file);
  const ok = content != null && content.includes(item.needle);
  return {
    id: item.id,
    ok,
    file: item.file,
    summary: item.summary,
    missing: ok ? null : item.needle
  };
}

function readSource(file) {
  if (sources.has(file)) return sources.get(file);
  if (!existsSync(file)) {
    sources.set(file, null);
    return null;
  }
  const content = readFileSync(file, "utf8");
  sources.set(file, content);
  return content;
}
