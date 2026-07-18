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
    ok: source.includes("Linux OpenCAMLib：") && source.includes("formatLinuxOpenCamLibEvidence") && source.includes("candidatePackageBlockedReason") && source.includes("contactPathCoverage") && source.includes("protectedZones") && source.includes("端部保护") && source.includes("预检") && source.includes("证据JSON已回填"),
    summary: "Focused readiness UI should expose Linux OpenCAMLib path coverage, protected end zones, candidate package preflight step, evidence JSON, and blocker diagnostics."
  },
  {
    id: "linux-camotics-upstream-binding-visible",
    ok: source.includes("Linux CAMotics绑定：") && source.includes("formatLinuxCamoticsUpstreamEvidence") && source.includes("candidatePackageValidationBound") && source.includes("candidatePackageBundleBound") && source.includes("候选包预检已绑定") && source.includes("候选包证据包已绑定"),
    summary: "Focused readiness UI should expose CAMotics upstream binding to OpenCAMLib candidate package validation and bundle evidence."
  },
  {
    id: "locked-production-guidance-visible",
    ok: source.includes("formatLockedProductionPackageGuidance") && source.includes("operatorGuidance") && source.includes("先下载安全试雕包") && source.includes("禁止上机") && source.includes("证据缺口") && source.includes("可下载证据审查包复核缺口"),
    summary: "Focused UI should turn locked production-package responses into actionable safe-trial guidance."
  },
  {
    id: "locked-production-task-actions",
    ok: source.includes("createLockedProductionPackageTaskLinks") && source.includes("actionLinks") && source.includes("下载安全试雕包") && source.includes("下载证据审查包") && source.includes("重新检查生产包门禁") && source.includes("task-event-action"),
    summary: "Locked production-package warnings should persist actionable package links in the task timeline."
  },
  {
    id: "opencamlib-input-package-download",
    ok: source.includes("handleDownloadV3OpenCamLibCandidateInputs") && source.includes("opencamlib-candidate-inputs.zip") && source.includes("下载OCL输入包"),
    summary: "Focused operator UI should expose an OpenCAMLib Linux real-candidate input package download."
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
