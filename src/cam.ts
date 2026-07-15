import { sampleDepth } from "./imageProcessing";
import type { DepthMap, GeneratedToolpath, ModelSettings, ToolpathPoint } from "./types";

const fmt = (value: number, digits = 4) => value.toFixed(digits);

const postProcessorNames = {
  generic: "通用四轴 G-code",
  weihong: "维宏风格 G-code",
  syntec: "新代风格 G-code"
} satisfies Record<ModelSettings["postProcessor"], string>;

export function generateToolpath(depthMap: DepthMap, settings: ModelSettings): GeneratedToolpath {
  const points: ToolpathPoint[] = [];
  const halfLength = settings.lengthMm / 2;
  const radius = settings.diameterMm / 2;
  const aMin = settings.reliefAngleDeg >= 360 ? -180 : -settings.reliefAngleDeg / 2;
  const aMax = settings.reliefAngleDeg >= 360 ? 180 : settings.reliefAngleDeg / 2;
  const passes = Math.max(2, Math.ceil(settings.reliefAngleDeg / settings.stepoverDeg));
  const xSteps = Math.max(2, Math.ceil(settings.lengthMm / settings.stepoverMm));

  for (let pass = 0; pass <= passes; pass += 1) {
    const serpentine = pass % 2 === 1;
    const a = aMin + (pass / passes) * (aMax - aMin);
    const v = pass / passes;

    for (let step = 0; step <= xSteps; step += 1) {
      const index = serpentine ? xSteps - step : step;
      const u = index / xSteps;
      const x = -halfLength + u * settings.lengthMm;
      const depth = sampleDepth(depthMap, u, 1 - v) * settings.depthMm;
      const z = radius + depth + settings.toolDiameter / 2;
      points.push({ x, a, z, depth });
    }
  }

  const travelMm = estimateTravel(points, radius);
  const estimatedMinutes = travelMm / Math.max(1, settings.feedRate);
  const gcode = toGcode(points, settings, estimatedMinutes);
  return {
    points,
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: postProcessorNames[settings.postProcessor],
    summary: summarizeToolpath(points, settings)
  };
}

function summarizeToolpath(points: ToolpathPoint[], settings: ModelSettings) {
  const values = points.reduce(
    (acc, point) => ({
      xMin: Math.min(acc.xMin, point.x),
      xMax: Math.max(acc.xMax, point.x),
      aMin: Math.min(acc.aMin, point.a),
      aMax: Math.max(acc.aMax, point.a),
      zMin: Math.min(acc.zMin, point.z),
      zMax: Math.max(acc.zMax, point.z),
      maxDepth: Math.max(acc.maxDepth, point.depth)
    }),
    {
      xMin: Number.POSITIVE_INFINITY,
      xMax: Number.NEGATIVE_INFINITY,
      aMin: Number.POSITIVE_INFINITY,
      aMax: Number.NEGATIVE_INFINITY,
      zMin: Number.POSITIVE_INFINITY,
      zMax: Number.NEGATIVE_INFINITY,
      maxDepth: 0
    }
  );
  const warnings: string[] = [];

  if (settings.safeZ <= values.zMax) {
    warnings.push("安全高度低于或接近最高刀位，请提高安全高度。");
  }

  if (settings.stepoverMm > settings.toolDiameter * 0.6) {
    warnings.push("X步距偏大，可能留下明显刀痕。");
  }

  if (settings.reliefAngleDeg > 300) {
    warnings.push("包覆角度较大，请确认夹具与A轴连续旋转方向。");
  }

  return { ...values, warnings };
}

function toGcode(points: ToolpathPoint[], settings: ModelSettings, estimatedMinutes: number): string {
  const lines = [
    `%`,
    `(Nuclear carving relief CAM MVP - ${postProcessorNames[settings.postProcessor]})`,
    "(Coordinate: X length axis, A rotary axis, Z radial tool center)",
    `(Length=${fmt(settings.lengthMm, 3)}mm Diameter=${fmt(settings.diameterMm, 3)}mm MaxDepth=${fmt(settings.depthMm, 3)}mm)`,
    `(ToolDiameter=${fmt(settings.toolDiameter, 3)}mm Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    ...postStart(settings)
  ];

  if (points.length > 0) {
    lines.push(`G0 X${fmt(points[0].x)} A${fmt(points[0].a, 3)}`);
    lines.push(`G1 Z${fmt(points[0].z)} F${fmt(settings.feedRate * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 X${fmt(point.x)} A${fmt(point.a, 3)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
}

function postStart(settings: ModelSettings): string[] {
  const shared = [`F${fmt(settings.feedRate, 1)}`, `S${Math.round(settings.spindleRpm)} M3`, `G0 Z${fmt(settings.safeZ)}`];

  if (settings.postProcessor === "weihong") {
    return ["(POST: WEIHONG STYLE)", "G17", ...shared];
  }

  if (settings.postProcessor === "syntec") {
    return ["(POST: SYNTEC STYLE)", "G17 G40 G49 G80", ...shared];
  }

  return ["(POST: GENERIC 4AXIS)", ...shared];
}

function postEnd(settings: ModelSettings): string[] {
  if (settings.postProcessor === "syntec") {
    return ["G49", "M5", "M30"];
  }

  return ["M5", "M30"];
}

function toCsv(points: ToolpathPoint[]): string {
  const rows = ["x_mm,a_deg,z_mm,relief_depth_mm"];
  for (const point of points) {
    rows.push(`${fmt(point.x)},${fmt(point.a, 3)},${fmt(point.z)},${fmt(point.depth)}`);
  }
  return `${rows.join("\n")}\n`;
}

function estimateTravel(points: ToolpathPoint[], radius: number): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const da = ((next.a - prev.a) * Math.PI) / 180;
    const arc = Math.abs(da) * radius;
    total += Math.sqrt(dx * dx + dz * dz + arc * arc);
  }
  return total;
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
