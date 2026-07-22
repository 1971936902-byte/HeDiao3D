#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appPath = resolve("src", "App.tsx");
const source = readFileSync(appPath, "utf8");

const checks = [
  {
    id: "focused-ui-enabled",
    ok: source.includes("const V3_TRIAL_FOCUSED_UI = true"),
    summary: "V3 focused operator UI must stay enabled by default."
  },
  {
    id: "primary-action-label",
    ok: countIncludes(source, "生成试雕刀路与安全包") >= 4,
    summary: "Primary CAM action should use the operator-facing trial toolpath/package wording."
  },
  {
    id: "success-switches-to-simulation",
    ok: /finalJob\.result\?\.toolpath[\s\S]{0,500}setWorkbenchView\("simulation"\)[\s\S]{0,120}setIsSimulationMode\(true\)/.test(source),
    summary: "Successful V3 job must automatically switch the workbench to simulation view."
  },
  {
    id: "success-notice-explains-simulation",
    ok: source.includes("右侧已切到“模拟雕刻”"),
    summary: "Success notice should tell the operator where to inspect the generated preview."
  },
  {
    id: "local-preview-cache-gate",
    ok: source.includes("原始3D模型仍在本地预览状态") && source.includes("后端 CAM 缓存"),
    summary: "Imported GLB/STL must distinguish local preview from backend CAM-ready cache state."
  },
  {
    id: "safe-trial-package-download",
    ok: countIncludes(source, "下载安全试雕包") >= 4 && source.includes("handleDownloadV3TrialPackage"),
    summary: "Operator download path should emphasize the safe trial package."
  },
  {
    id: "buddha-fixture-load-visible",
    ok: source.includes("载入佛头测试模型") && source.includes("handleLoadLocalMeshyResult"),
    summary: "Focused UI should keep a visible fixed Buddha model loader for operator/browser E2E and demos."
  },
  {
    id: "production-download-hidden-in-focused-mode",
    ok: /!\s*V3_TRIAL_FOCUSED_UI\s*&&\s*activeStage\s*===\s*"cam"[\s\S]{0,2600}handleDownloadZipPackage/.test(source),
    summary: "Legacy direct production download controls must remain hidden in focused V3 flow."
  },
  {
    id: "view-tabs-operator-facing",
    ok: source.includes(">3D模型</button>") && source.includes(">模拟雕刻</button>") && source.includes(">报告</button>"),
    summary: "Workbench should expose the three operator-facing views."
  },
  {
    id: "linux-opencamlib-evidence-visible",
    ok: source.includes("Linux OpenCAMLib：") && source.includes("formatLinuxOpenCamLibEvidence") && source.includes("candidatePackageBlockedReason") && source.includes("contactPathCoverage") && source.includes("protectedZones") && source.includes("端部保护") && source.includes("materialRemovalReadiness") && source.includes("formatLinuxOpenCamLibMaterialRemovalReadiness") && source.includes("材料去除") && source.includes("预检") && source.includes("证据JSON已回填"),
    summary: "Focused readiness UI should expose Linux OpenCAMLib path coverage, protected end zones, material-removal readiness, candidate package preflight step, evidence JSON, and blocker diagnostics."
  },
  {
    id: "linux-camotics-upstream-binding-visible",
    ok: source.includes("Linux CAMotics绑定：") && source.includes("formatLinuxCamoticsUpstreamEvidence") && source.includes("candidatePackageValidationBound") && source.includes("candidatePackageBundleBound") && source.includes("候选包预检已绑定") && source.includes("候选包证据包已绑定"),
    summary: "Focused readiness UI should expose CAMotics upstream binding to OpenCAMLib candidate package validation and bundle evidence."
  },
  {
    id: "residual-closure-review-visible",
    ok: source.includes("残料/过切复核：")
      && source.includes("formatResidualClosureReview")
      && source.includes("productionResidualEvidenceReady")
      && source.includes("生产残料证据未闭合")
      && source.includes("材料去除仿真绑定"),
    summary: "Focused CAM report should expose residual/gouge closure review separately from material-removal simulation."
  },
  {
    id: "locked-production-guidance-visible",
    ok: source.includes("formatLockedProductionPackageGuidance") && source.includes("operatorGuidance") && source.includes("先下载安全试雕包") && source.includes("禁止上机") && source.includes("证据缺口") && source.includes("可下载证据审查包复核缺口") && source.includes("生产闭环审计"),
    summary: "Focused UI should turn locked production-package responses into actionable safe-trial guidance."
  },
  {
    id: "locked-production-task-actions",
    ok: source.includes("createLockedProductionPackageTaskLinks") && source.includes("actionLinks") && source.includes("下载安全试雕包") && source.includes("下载证据审查包") && source.includes("查看闭环审计") && source.includes("重新检查生产包门禁") && source.includes("task-event-action"),
    summary: "Locked production-package warnings should persist actionable package links in the task timeline."
  },
  {
    id: "production-closure-audit-visible",
    ok: source.includes("productionClosureAudit")
      && source.includes("production-closure-audit.json")
      && source.includes("production-closure-audit.md")
      && source.includes("闭环审计JSON")
      && source.includes("闭环审计说明")
      && source.includes("formatProductionClosureStatus"),
    summary: "Focused CAM panel should expose production closure audit status, downloads, and next actions."
  },
  {
    id: "opencamlib-input-package-download",
    ok: source.includes("handleDownloadV3OpenCamLibCandidateInputs") && source.includes("opencamlib-candidate-inputs.zip") && source.includes("下载OCL输入包"),
    summary: "Focused operator UI should expose an OpenCAMLib Linux real-candidate input package download."
  },
  {
    id: "linux-cam-job-package-download",
    ok: source.includes("handleDownloadV3LinuxCamJobPackage") && source.includes("linux-cam-job-package") && source.includes("下载Linux整单包") && source.includes("OpenCAMLib 输入、CAMotics 准备文件和证据回填说明"),
    summary: "Focused operator UI should expose a unified Linux CAM job package download."
  },
  {
    id: "linux-cam-job-validation-import",
    ok: source.includes("handleImportV3LinuxCamJobValidation") && source.includes("linux-cam-job-validation") && source.includes("linux-cam-job-local-validation.json") && source.includes("整单校验JSON") && source.includes("回填整单校验") && source.includes("Linux证据进度") && source.includes("formatLinuxCamJobEvidenceStatus") && source.includes("Linux上传计划") && source.includes("formatLinuxCamJobUploadPlan") && source.includes("handleImportV3LinuxCamEvidenceBundle") && source.includes("智能回填结果包") && source.includes("linux-cam-evidence-bundle") && source.includes("Linux执行三步") && source.includes("upload-linux-cam-evidence.mjs") && source.includes("HEDIAO3D_V3_API_BASE") && source.includes("Linux上传报告") && source.includes("formatLinuxCamEvidenceUploadReport") && source.includes("Linux预检") && source.includes("formatLinuxCamJobPreflight") && source.includes("Linux依赖安装") && source.includes("formatLinuxCamDepsInstallReport") && source.includes("linuxCamDepsInstallReport") && source.includes("resourceProfile") && source.includes("installPlan"),
    summary: "Focused operator UI should accept Linux CAM job local validation evidence after running the unified package."
  },
  {
    id: "external-gcode-boundary-visible",
    ok: source.includes("外部G-code边界")
      && source.includes("externalGcodeImportValidation")
      && source.includes("gcodeMachineBoundary")
      && source.includes("proofMachineBoundary")
      && source.includes("formatExternalGcodeBoundaryDetails")
      && source.includes("formatExternalProofBoundaryDetails")
      && source.includes("external-gcode-import-validation.json"),
    summary: "Focused operator UI should expose imported external G-code machine boundary and CAM proof boundary status."
  },
  {
    id: "core-api-request-error-guidance",
    ok: source.includes("function requestJson")
      && source.includes("无法连接本地后端 API")
      && source.includes('requestJson<{\n        modelUrl: string;')
      && source.includes("requestJson<V3OrchestratorJob>")
      && source.includes("requestJson<GeneratedToolpath>")
      && source.includes("selectedAiProvider.name}任务创建失败"),
    summary: "Core model import, V3 job creation, Mesh CAM and Meshy creation requests should share actionable API connection errors."
  }
];

const failed = checks.filter((check) => !check.ok);
const report = {
  ok: failed.length === 0,
  schema: "hediao3d.v3-focused-ui-contract-test.v1",
  appPath,
  checks,
  failed: failed.map((check) => check.id)
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;

function countIncludes(text, pattern) {
  let count = 0;
  let index = text.indexOf(pattern);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(pattern, index + pattern.length);
  }
  return count;
}
