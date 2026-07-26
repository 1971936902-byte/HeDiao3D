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
    ok: source.includes("Linux OpenCAMLib：") && source.includes("formatLinuxOpenCamLibEvidence") && source.includes("candidatePackageBlockedReason") && source.includes("contactPathCoverage") && source.includes("protectedZones") && source.includes("端部保护") && source.includes("materialRemovalReadiness") && source.includes("formatLinuxOpenCamLibMaterialRemovalReadiness") && source.includes("unsafeProductionClaim") && source.includes("危险残料声明") && source.includes("productionGapReview") && source.includes("OpenCAMLib差距审查：") && source.includes("formatOpenCamLibProductionGapReview") && source.includes("downstreamProductionEvidenceReady") && source.includes("下游证据未闭合") && source.includes("downstreamEvidencePlan") && source.includes("OpenCAMLib下游计划：") && source.includes("formatOpenCamLibDownstreamEvidencePlan") && source.includes("productionUnlockReady") && source.includes("不解锁生产") && source.includes("严格接触失败：") && source.includes("formatNativeOpenCamLibStrictContactFailure") && source.includes("contactValidationFailedChecks") && source.includes("productionBlocker") && source.includes("预检") && source.includes("证据JSON已回填") && source.includes("候选包generatedArtifacts已匹配") && source.includes("候选包generatedArtifacts不匹配"),
    summary: "Focused readiness UI should expose Linux OpenCAMLib path coverage, protected end zones, material-removal readiness, unsafe residual claims, production gap review, downstream evidence boundary, candidate package preflight step, generatedArtifacts binding, evidence JSON, and blocker diagnostics."
  },
  {
    id: "linux-camotics-upstream-binding-visible",
    ok: source.includes("Linux CAMotics绑定：") && source.includes("formatLinuxCamoticsUpstreamEvidence") && source.includes("candidatePackageValidationBound") && source.includes("candidatePackageBundleBound") && source.includes("候选包预检已绑定") && source.includes("候选包证据包已绑定") && source.includes("上游危险残料声明"),
    summary: "Focused readiness UI should expose CAMotics upstream binding to OpenCAMLib candidate package validation, bundle evidence, and unsafe upstream residual claims."
  },
  {
    id: "residual-closure-review-visible",
    ok: source.includes("残料/过切复核：")
      && source.includes("formatResidualClosureReview")
      && source.includes("productionResidualEvidenceReady")
      && source.includes("topBlockers")
      && source.includes("首要阻断")
      && source.includes("生产残料证据未闭合")
      && source.includes("材料去除仿真绑定"),
    summary: "Focused CAM report should expose residual/gouge closure review separately from material-removal simulation."
  },
  {
    id: "safe-trial-readiness-visible",
    ok: source.includes("安全试雕状态：")
      && source.includes("formatSafeTrialReadiness")
      && source.includes("safeTrialReadiness")
      && source.includes("生产仍锁定")
      && source.includes("仅建议离料空跑"),
    summary: "Focused readiness UI should show current job safe-trial readiness separately from production readiness."
  },
  {
    id: "locked-production-guidance-visible",
    ok: source.includes("formatLockedProductionPackageGuidance") && source.includes("operatorGuidance") && source.includes("先下载安全试雕包") && source.includes("禁止上机") && source.includes("证据缺口") && source.includes("可下载证据审查包复核缺口") && source.includes("生产闭环审计"),
    summary: "Focused UI should turn locked production-package responses into actionable safe-trial guidance."
  },
  {
    id: "locked-production-material-removal-gate-visible",
    ok: source.includes("formatProductionReadinessMaterialRemovalGate")
      && source.includes("formatLockedProductionMaterialRemovalGuidance")
      && source.includes("guidance?.materialRemovalGate")
      && source.includes("material-removal-proof")
      && source.includes("材料去除/残料门禁")
      && source.includes("需补残料/过切闭环证据")
      && source.includes("residualUnsafeProductionClaim")
      && source.includes("危险残料声明")
      && source.includes("productionResidualEvidenceReady=true")
      && source.includes("measured/swept-volume")
      && source.includes("residualLocalValidationBindingStatus")
      && source.includes("本地残料校验绑定")
      && source.includes("camotics-result-validate.js")
      && /formatLockedProductionPackageGuidance[\s\S]{0,600}formatProductionReadinessMaterialRemovalGate/.test(source),
    summary: "Locked production-package guidance should surface the material-removal residual/gouge gate and unsafe residual production claims separately from generic evidence gaps."
  },
  {
    id: "runbook-review-vs-production-safe-visible",
    ok: source.includes("runbookReviewSafe")
      && source.includes("productionSafeReason")
      && source.includes("审查")
      && source.includes("ready")
      && source.includes("blocked")
      && source.includes("生产")
      && source.includes("locked"),
    summary: "Focused readiness UI should distinguish review-safe Linux runbook evidence from production-safe unlock state and show the production-safe reason."
  },
  {
    id: "locked-production-field-evidence-gates-visible",
    ok: source.includes("formatLockedProductionAirRunGuidance")
      && source.includes("formatLockedProductionFieldEvidenceGuidance")
      && source.includes("formatLockedProductionRunbookBoundary")
      && source.includes("guidance?.airRunGate")
      && source.includes("guidance?.fieldEvidenceGate")
      && source.includes("guidance?.runbookBoundary")
      && source.includes("离料空跑门禁")
      && source.includes("现场同包证据")
      && source.includes("Runbook审查")
      && source.includes("同包绑定")
      && source.includes("证据链")
      && source.includes("proofChainStatus")
      && source.includes("不匹配文件")
      && source.includes("machineBindingStatus")
      && source.includes("trialBindingStatus")
      && source.includes("failedChecks")
      && source.includes("mismatchedFiles"),
    summary: "Locked production-package guidance should surface air-run, runbook boundary, and field package-binding mismatch details, not only material-removal blockers."
  },
  {
    id: "readiness-goal-audit-field-gates-visible",
    ok: source.includes("getGoalAuditFieldGateEvidence")
      && source.includes("field-evidence-closure")
      && source.includes("v3GoalAuditFieldGateEvidence")
      && source.includes("现场门禁")
      && source.includes("材料去除/残料门禁")
      && source.includes("离料空跑门禁")
      && source.includes("现场同包门禁"),
    summary: "Focused readiness UI should surface material-removal, air-run and field evidence gate details from goalAudit, not only the weakest layer and next action."
  },
  {
    id: "job-evidence-dossier-production-audit-gates-visible",
    ok: source.includes("productionEvidenceDossier.productionReadinessAudit")
      && source.includes("生产审计门禁")
      && source.includes("materialRemovalGate?.status")
      && source.includes("残料闭合")
      && source.includes("airRunGate?.status")
      && source.includes("fieldPackageGate?.status")
      && source.includes("空跑绑定")
      && source.includes("现场绑定")
      && source.includes("现场完整性")
      && source.includes("fieldCompletenessStatus")
      && source.includes("fieldCompletenessMissingCount"),
    summary: "Focused job evidence dossier UI should surface productionReadinessAudit material-removal, air-run and field package gates, not only generic cross-check tiles."
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
    ok: source.includes("handleImportV3LinuxCamJobValidation") && source.includes("linux-cam-job-validation") && source.includes("linux-cam-job-local-validation.json") && source.includes("整单校验JSON") && source.includes("回填整单校验") && source.includes("Linux证据进度") && source.includes("formatLinuxCamJobEvidenceStatus") && source.includes("残料proof") && source.includes("Linux上传计划") && source.includes("formatLinuxCamJobUploadPlan") && source.includes("handleImportV3LinuxCamEvidenceBundle") && source.includes("智能回填结果包") && source.includes("linux-cam-evidence-bundle") && source.includes("Linux执行三步") && source.includes("upload-linux-cam-evidence.mjs") && source.includes("HEDIAO3D_V3_API_BASE") && source.includes("Linux上传报告") && source.includes("formatLinuxCamEvidenceUploadReport") && source.includes("Linux预检") && source.includes("formatLinuxCamJobPreflight") && source.includes("Linux依赖安装") && source.includes("formatLinuxCamDepsInstallReport") && source.includes("linuxCamDepsInstallReport") && source.includes("resourceProfile") && source.includes("installPlan"),
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
      && /requestJson<\{\s*modelUrl:\s*string;/.test(source)
      && source.includes("requestJson<V3OrchestratorJob>")
      && source.includes("requestJson<GeneratedToolpath>")
      && source.includes("selectedAiProvider.name}任务创建失败"),
    summary: "Core model import, V3 job creation, Mesh CAM and Meshy creation requests should share actionable API connection errors."
  },
  {
    id: "v3-download-error-guidance",
    ok: source.includes("const downloadV3ApiArtifact")
      && source.includes("后端返回空文件")
      && source.includes("formatRequestError(error, `${context}失败`)")
      && source.includes("安全试雕包下载失败")
      && source.includes("CAMotics Linux 仿真包下载失败")
      && source.includes("OpenCAMLib 输入包下载失败")
      && source.includes("Linux CAM 整单包下载失败")
      && source.includes("V3 证据审查包下载失败")
      && countIncludes(source, "await downloadV3ApiArtifact({") >= 5,
    summary: "Focused V3 package downloads should share actionable network/HTTP/empty-file errors and visible task feedback."
  },
  {
    id: "original-model-import-failure-guidance",
    ok: source.includes("createOriginalModelImportFailureMessage")
      && source.includes("不是可用于 CAM 的 3D 模型格式")
      && source.includes("文件为空，无法生成 3D 预览或刀路")
      && source.includes("不能生成试雕刀路与安全包")
      && source.includes("setV3UserNotice({")
      && source.includes("原始3D模型缓存失败")
      && source.includes("meshQuality?: MeshQualityReport")
      && source.includes("if (data.meshQuality) setMeshQuality(data.meshQuality)"),
    summary: "Original model import failures should be visible, actionable, and prevent bad backend CAM cache assumptions."
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
