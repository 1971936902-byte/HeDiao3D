import type { DepthMap, GeneratedToolpath, ImageQualityMetric, ImageQualityReport, ModelSettings } from "./types";
import type { SafetyIssue } from "./manufacturingProfiles";

export type ManufacturingQualityItem = {
  label: string;
  value: string;
  status: "ok" | "warning" | "critical";
  detail: string;
};

export type ManufacturingQualityReport = {
  score: number;
  verdict: "ready" | "review" | "blocked";
  summary: string;
  items: ManufacturingQualityItem[];
};

export function analyzeDepthMapQuality(depthMap: DepthMap): ImageQualityReport {
  const values = depthMap.values;
  const coverage = calculateCoverage(values);
  const contrast = calculateStd(values);
  const sharpness = calculateSharpness(depthMap);
  const centering = calculateCentering(depthMap);

  const metrics: ImageQualityMetric[] = [
    createMetric("主体覆盖", coverage * 100, "%", coverage >= 0.18 && coverage <= 0.72, coverage >= 0.1 && coverage <= 0.82),
    createMetric("深度对比", contrast * 100, "%", contrast >= 0.16, contrast >= 0.08),
    createMetric("边缘清晰", sharpness * 100, "%", sharpness >= 0.08, sharpness >= 0.035),
    createMetric("主体居中", centering * 100, "%", centering >= 0.72, centering >= 0.55)
  ];

  const score = clamp(
      coverageScore(coverage) * 0.28 +
      clamp(contrast / 0.22, 0, 1) * 28 +
      clamp(sharpness / 0.1, 0, 1) * 22 +
      clamp(centering / 0.86, 0, 1) * 22,
    0,
    100
  );

  const suggestions: string[] = [];
  if (coverage < 0.12) suggestions.push("主体占画面过小，建议靠近拍摄或裁切背景。");
  if (coverage > 0.78) suggestions.push("主体贴边过多，建议留出边缘，避免 AI 误判轮廓。");
  if (contrast < 0.08) suggestions.push("主体与背景反差不足，建议使用纯色背景或补光。");
  if (sharpness < 0.035) suggestions.push("边缘清晰度偏低，建议固定手机并重新对焦。");
  if (centering < 0.55) suggestions.push("主体偏离画面中心，建议重拍并保持核胚居中。");

  const verdict = score >= 82 ? "ready" : score >= 64 ? "usable" : "retake";
  const summary =
    verdict === "ready"
      ? "适合用于 AI 3D 生成"
      : verdict === "usable"
        ? "可用于测试，建议补拍提升质量"
        : "不建议直接用于 Meshy，请补拍";

  return {
    score,
    verdict,
    summary,
    metrics,
    suggestions: suggestions.length > 0 ? suggestions : ["照片质量基础指标正常，可继续进入建模。"]
  };
}

export function createManufacturingQualityReport(
  settings: ModelSettings,
  toolpath: GeneratedToolpath | null,
  safetyIssues: SafetyIssue[],
  envelopeQuality: { score: number; fitRate: number; missCount: number; continuityRate: number; zJumpRate: number } | null
): ManufacturingQualityReport {
  const items: ManufacturingQualityItem[] = [];
  const criticalCount = safetyIssues.filter((issue) => issue.level === "critical").length;
  const warningCount = safetyIssues.filter((issue) => issue.level === "warning").length;

  items.push({
    label: "安全校验",
    value: criticalCount > 0 ? `${criticalCount} 个阻断项` : warningCount > 0 ? `${warningCount} 个提醒` : "通过",
    status: criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok",
    detail: safetyIssues[0]?.detail ?? "基础安全项未发现风险。"
  });

  if (toolpath) {
    const riskWarnings = toolpath.summary.warnings.filter((warning) => !warning.startsWith("已避开端部夹持区") && !warning.startsWith("粗加工"));
    items.push({
      label: "刀路范围",
      value: `X ${toolpath.summary.xMin.toFixed(1)}~${toolpath.summary.xMax.toFixed(1)} / A ${toolpath.summary.aMin.toFixed(0)}~${toolpath.summary.aMax.toFixed(0)}`,
      status: riskWarnings.length > 0 ? "warning" : "ok",
      detail: riskWarnings[0] ?? "刀路范围正常，夹持区已避让。"
    });

    items.push({
      label: "粗精加工",
      value: toolpath.programs?.rough && toolpath.programs.finish && toolpath.programs.rest ? "粗/精/清残" : toolpath.programs?.rough && toolpath.programs.finish ? "已分离" : "未分离",
      status: toolpath.programs?.rough && toolpath.programs.finish && toolpath.programs.rest ? "ok" : toolpath.programs?.rough && toolpath.programs.finish ? "ok" : "warning",
      detail: toolpath.programs?.rough
        ? `粗加工 ${toolpath.programs.rough.points.length} 点，精加工 ${toolpath.programs.finish?.points.length ?? 0} 点，清残 ${toolpath.programs.rest?.points.length ?? 0} 点。`
        : "当前没有粗精加工独立程序。"
    });
  } else {
    items.push({
      label: "刀路范围",
      value: "待生成",
      status: "warning",
      detail: "生成刀路后才能检查 X/A/Z 范围。"
    });
  }

  if (envelopeQuality) {
    items.push({
      label: "包络贴合",
      value: `${envelopeQuality.fitRate.toFixed(1)}%`,
      status: envelopeQuality.fitRate >= 96 ? "ok" : envelopeQuality.fitRate >= 88 ? "warning" : "critical",
      detail: `未贴合点 ${envelopeQuality.missCount}，连续贴合 ${envelopeQuality.continuityRate.toFixed(1)}%。`
    });
  } else {
    items.push({
      label: "包络贴合",
      value: "待生成",
      status: "warning",
      detail: "生成刀路后会计算包络贴合度。"
    });
  }

  items.push({
    label: "端部工艺",
    value: `左 ${settings.leftHoldMm.toFixed(1)} / 右 ${settings.rightHoldMm.toFixed(1)}mm`,
    status: settings.leftHoldMm >= 1.5 && settings.rightHoldMm >= 1.5 ? "ok" : "warning",
    detail: `端部过渡 ${settings.endTransitionMm.toFixed(1)}mm，粉色夹持区会在 3D 视图中显示。`
  });

  const score = clamp(
    100 -
      criticalCount * 26 -
      warningCount * 8 -
      (envelopeQuality ? Math.max(0, 98 - envelopeQuality.fitRate) * 1.2 : 12) -
      (toolpath ? 0 : 10),
    0,
    100
  );
  const verdict = criticalCount > 0 ? "blocked" : score >= 86 ? "ready" : "review";
  const summary = verdict === "ready" ? "可进入下载/空跑验证" : verdict === "blocked" ? "存在阻断项，请先修复" : "建议复核后再上机";

  return { score, verdict, summary, items };
}

function createMetric(label: string, value: number, unit: string, ok: boolean, warning: boolean): ImageQualityMetric {
  return {
    label,
    value,
    unit,
    status: ok ? "ok" : warning ? "warning" : "critical"
  };
}

function calculateCoverage(values: Float32Array) {
  let count = 0;
  for (const value of values) {
    if (value > 0.16) count += 1;
  }
  return count / values.length;
}

function calculateStd(values: Float32Array) {
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  return Math.sqrt(variance / values.length);
}

function calculateSharpness(depthMap: DepthMap) {
  let total = 0;
  let count = 0;
  for (let y = 1; y < depthMap.height - 1; y += 1) {
    for (let x = 1; x < depthMap.width - 1; x += 1) {
      const i = y * depthMap.width + x;
      const dx = Math.abs(depthMap.values[i + 1] - depthMap.values[i - 1]);
      const dy = Math.abs(depthMap.values[i + depthMap.width] - depthMap.values[i - depthMap.width]);
      total += Math.sqrt(dx * dx + dy * dy);
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

function calculateCentering(depthMap: DepthMap) {
  let weight = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < depthMap.height; y += 1) {
    for (let x = 0; x < depthMap.width; x += 1) {
      const value = Math.max(0, depthMap.values[y * depthMap.width + x] - 0.12);
      weight += value;
      sx += x * value;
      sy += y * value;
    }
  }

  if (weight <= 0) return 0;
  const cx = sx / weight / (depthMap.width - 1);
  const cy = sy / weight / (depthMap.height - 1);
  const distance = Math.sqrt((cx - 0.5) ** 2 + (cy - 0.5) ** 2);
  return clamp(1 - distance / 0.5, 0, 1);
}

function coverageScore(coverage: number) {
  if (coverage >= 0.22 && coverage <= 0.62) return 28;
  if (coverage < 0.22) return clamp(coverage / 0.22, 0, 1) * 28;
  return clamp((0.86 - coverage) / 0.24, 0, 1) * 28;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
