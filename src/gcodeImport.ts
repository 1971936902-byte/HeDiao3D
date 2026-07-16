import type { GeneratedToolpath, ModelSettings, ToolpathPoint, ToolpathProgram } from "./types";

const fmt = (value: number, digits = 4) => Number(value).toFixed(digits);

type ParserState = {
  x: number;
  y: number;
  z: number;
  a: number;
  feed: number;
  motion: "G0" | "G1" | null;
  unitScale: number;
};

type ParsedLine = ToolpathPoint & {
  line: number;
  rapid: boolean;
};

export function parseGcodeToToolpath(source: string, filename: string, settings: ModelSettings): GeneratedToolpath {
  if (/\.csv$/i.test(filename)) return parseCsvToToolpath(source, filename, settings);

  const rotaryWrapMeta = readRotaryWrapMeta(source);
  const lines = source.split(/\r?\n/);
  const state: ParserState = {
    x: 0,
    y: 0,
    z: settings.safeZ,
    a: 0,
    feed: settings.feedRate,
    motion: null,
    unitScale: 1
  };
  const parsed: ParsedLine[] = [];
  let hasY = false;
  let hasA = false;
  let maxFeed = 0;
  let spindle = 0;
  let arcCount = 0;

  lines.forEach((rawLine, index) => {
    const stripped = stripGcodeComments(rawLine).trim().toUpperCase();
    if (!stripped) return;

    const words = readWords(stripped);
    if (words.size === 0) return;

    const gCodes = words.get("G") ?? [];
    if (gCodes.some((value) => Math.round(value) === 20)) state.unitScale = 25.4;
    if (gCodes.some((value) => Math.round(value) === 21)) state.unitScale = 1;
    if (gCodes.some((value) => Math.round(value) === 0)) state.motion = "G0";
    if (gCodes.some((value) => Math.round(value) === 1)) state.motion = "G1";
    if (gCodes.some((value) => Math.round(value) === 2 || Math.round(value) === 3)) {
      state.motion = "G1";
      arcCount += 1;
    }
    if (words.has("X")) state.x = last(words.get("X"), state.x / state.unitScale) * state.unitScale;
    if (words.has("Y")) {
      state.y = last(words.get("Y"), state.y / state.unitScale) * state.unitScale;
      hasY = true;
    }
    if (words.has("Z")) state.z = last(words.get("Z"), state.z / state.unitScale) * state.unitScale;
    if (words.has("A")) {
      state.a = last(words.get("A"), state.a);
      hasA = true;
    }
    if (words.has("F")) {
      state.feed = last(words.get("F"), state.feed / state.unitScale) * state.unitScale;
      maxFeed = Math.max(maxFeed, state.feed);
    }
    if (words.has("S")) spindle = Math.max(spindle, last(words.get("S"), spindle));

    const hasMotionAxis = words.has("X") || words.has("Y") || words.has("Z") || words.has("A");
    if (!state.motion || !hasMotionAxis) return;

    const depth = state.motion === "G1" ? Math.max(0, hasY ? -state.z : settings.diameterMm / 2 + settings.toolDiameter / 2 - state.z) : 0;
    parsed.push({
      x: state.x,
      y: hasY ? state.y : undefined,
      a: hasA ? state.a : 0,
      z: state.z,
      depth,
      line: index + 1,
      rapid: state.motion === "G0"
    });
  });

  if (parsed.length === 0) {
    throw new Error("没有识别到 G0/G1 运动指令，请确认文件是 NC/TAP/G-code 文本。");
  }

  const cuttingPoints = parsed.filter((point) => !point.rapid);
  const previewPoints = cuttingPoints.length > 0 ? cuttingPoints : parsed;
  const points = previewPoints.map(({ line: _line, rapid: _rapid, ...point }) => normalizeImportedRotaryPoint(point, rotaryWrapMeta));
  const camMode: ModelSettings["camMode"] = rotaryWrapMeta ? "rotaryWrap" : hasY && !hasA ? "3axis" : "4axis";
  const estimatedMinutes = estimateImportedMinutes(parsed, settings.feedRate);
  const gcode = source.endsWith("\n") ? source : `${source}\n`;
  const warnings = createImportWarnings(filename, parsed, hasY, hasA, maxFeed, spindle, arcCount, settings, rotaryWrapMeta);
  const summary = summarizeImportedPoints(points, warnings);
  const program = createProgram("导入程序", filename || "imported-toolpath.nc", gcode, points, estimatedMinutes);

  return {
    points,
    programs: {
      combined: program
    },
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: camMode === "rotaryWrap" ? `导入${rotaryWrapMeta?.axis ?? ""}轴旋转包裹 G-code` : camMode === "3axis" ? "导入三轴 G-code" : "导入四轴/旋转 G-code",
    summary
  };
}

type RotaryWrapMeta = {
  axis: "A" | "X" | "Y";
  lengthAxis: "X" | "Y";
  perRevMm: number;
};

function readRotaryWrapMeta(source: string): RotaryWrapMeta | null {
  const axisMatch = source.match(/ROTARY_WRAP_AXIS\s*=\s*([AXY])/i);
  if (!axisMatch) return null;
  const axis = axisMatch[1].toUpperCase() as RotaryWrapMeta["axis"];
  const lengthAxisMatch = source.match(/LENGTH_AXIS\s*=\s*([XY])/i);
  const perRevMatch = source.match(/ROTARY_WRAP_PER_REV_MM\s*=\s*([-+]?\d*\.?\d+)/i);
  return {
    axis,
    lengthAxis: (lengthAxisMatch?.[1]?.toUpperCase() as RotaryWrapMeta["lengthAxis"] | undefined) ?? (axis === "X" ? "Y" : "X"),
    perRevMm: Math.max(0.001, Number(perRevMatch?.[1] ?? 100))
  };
}

function normalizeImportedRotaryPoint(point: ToolpathPoint, meta: RotaryWrapMeta | null): ToolpathPoint {
  if (!meta) return point;
  if (meta.axis === "A") return { ...point, y: undefined };

  const rotaryValue = meta.axis === "Y" ? point.y ?? 0 : point.x;
  const lengthValue = meta.lengthAxis === "Y" ? point.y ?? 0 : point.x;
  return {
    ...point,
    x: lengthValue,
    y: undefined,
    a: (rotaryValue / meta.perRevMm) * 360
  };
}

export function isSupportedToolpathFile(filename: string) {
  return /\.(nc|tap|gcode|ngc|cnc|txt|csv)$/i.test(filename);
}

function parseCsvToToolpath(source: string, filename: string, settings: ModelSettings): GeneratedToolpath {
  const rows = source.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) throw new Error("CSV 点位文件为空，至少需要表头和一行点位。");

  const headers = splitCsvRow(rows[0]).map((header) => header.trim().toLowerCase());
  const xIndex = findHeader(headers, ["x", "x_mm"]);
  const yIndex = findHeader(headers, ["y", "y_mm"]);
  const aIndex = findHeader(headers, ["a", "a_deg"]);
  const zIndex = findHeader(headers, ["z", "z_mm"]);
  const depthIndex = findHeader(headers, ["depth", "depth_mm", "relief_depth_mm", "mesh_surface_depth_mm"]);
  if (xIndex < 0 || zIndex < 0 || (yIndex < 0 && aIndex < 0)) {
    throw new Error("CSV 需要包含 x/z 以及 y 或 a 字段，例如 x_mm,y_mm,z_mm 或 x_mm,a_deg,z_mm。");
  }

  const points: ToolpathPoint[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const values = splitCsvRow(rows[i]);
    const x = Number(values[xIndex]);
    const y = yIndex >= 0 ? Number(values[yIndex]) : undefined;
    const a = aIndex >= 0 ? Number(values[aIndex]) : 0;
    const z = Number(values[zIndex]);
    if (!Number.isFinite(x) || !Number.isFinite(z) || (yIndex >= 0 && !Number.isFinite(y)) || (aIndex >= 0 && !Number.isFinite(a))) continue;
    const depth = depthIndex >= 0 && Number.isFinite(Number(values[depthIndex]))
      ? Number(values[depthIndex])
      : Math.max(0, yIndex >= 0 ? -z : settings.diameterMm / 2 + settings.toolDiameter / 2 - z);
    points.push({ x, y, a, z, depth });
  }

  if (points.length === 0) throw new Error("CSV 中没有可用点位。");

  const warnings = [`已从 ${filename} 导入 ${points.length} 个 CSV 点位。`, "CSV 导入按点位连线预览，不包含原始进给、主轴、圆弧和刀补信息。"];
  const estimatedMinutes = estimateImportedMinutes(points.map((point, index) => ({ ...point, line: index + 1, rapid: false })), settings.feedRate);
  const gcode = toPointListGcode(points, filename, settings);
  const program = createProgram("导入CSV点位", filename, gcode, points, estimatedMinutes);
  return {
    points,
    programs: { combined: program },
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: yIndex >= 0 ? "导入三轴 CSV 点位" : "导入四轴 CSV 点位",
    summary: summarizeImportedPoints(points, warnings)
  };
}

function stripGcodeComments(line: string) {
  return line
    .replace(/\([^)]*\)/g, " ")
    .replace(/;.*$/g, " ")
    .replace(/（[^）]*）/g, " ");
}

function readWords(line: string) {
  const words = new Map<string, number[]>();
  const matches = line.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g);
  for (const match of matches) {
    const key = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const values = words.get(key) ?? [];
    values.push(value);
    words.set(key, values);
  }
  return words;
}

function splitCsvRow(row: string) {
  return row.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
}

function findHeader(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header));
}

function last(values: number[] | undefined, fallback: number) {
  return values && values.length > 0 ? values[values.length - 1] : fallback;
}

function createProgram(name: string, filename: string, gcode: string, points: ToolpathPoint[], estimatedMinutes: number): ToolpathProgram {
  return { name, filename, gcode, points, estimatedMinutes };
}

function summarizeImportedPoints(points: ToolpathPoint[], warnings: string[]): GeneratedToolpath["summary"] {
  const hasY = points.some((point) => point.y != null);
  const seed = {
    xMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
    aMin: Number.POSITIVE_INFINITY,
    aMax: Number.NEGATIVE_INFINITY,
    zMin: Number.POSITIVE_INFINITY,
    zMax: Number.NEGATIVE_INFINITY,
    maxDepth: 0
  };
  const values = points.reduce(
    (acc, point) => ({
      xMin: Math.min(acc.xMin, point.x),
      xMax: Math.max(acc.xMax, point.x),
      yMin: Math.min(acc.yMin, point.y ?? 0),
      yMax: Math.max(acc.yMax, point.y ?? 0),
      aMin: Math.min(acc.aMin, point.a),
      aMax: Math.max(acc.aMax, point.a),
      zMin: Math.min(acc.zMin, point.z),
      zMax: Math.max(acc.zMax, point.z),
      maxDepth: Math.max(acc.maxDepth, point.depth)
    }),
    seed
  );

  const summary = {
    ...values,
    warnings
  };
  if (!hasY) {
    return {
      ...summary,
      yMin: undefined,
      yMax: undefined
    };
  }

  return summary;
}

function createImportWarnings(filename: string, points: ParsedLine[], hasY: boolean, hasA: boolean, maxFeed: number, spindle: number, arcCount: number, settings: ModelSettings, rotaryWrapMeta: RotaryWrapMeta | null) {
  const warnings = [`已从 ${filename || "导入文件"} 反向解析 ${points.length} 条运动点。`];
  if (rotaryWrapMeta) warnings.push(`检测到旋转包裹程序：${rotaryWrapMeta.axis}轴驱动夹具，${rotaryWrapMeta.perRevMm.toFixed(3)}mm/圈，已还原为 X/A/Z 立体预览。`);
  if (hasY && hasA) warnings.push("同时检测到 Y 轴和 A 轴，可能是五轴/混合程序；当前仅按线性预览还原，正式上机请用原控制器仿真复核。");
  if (!hasY && !hasA) warnings.push("未检测到 Y/A 轴，仅按 X/Z 轨迹显示，无法判断完整加工面。");
  if (arcCount > 0) warnings.push(`检测到 ${arcCount} 条 G2/G3 圆弧，当前按圆弧终点连线预览，圆弧细分将在下一版补强。`);
  if (maxFeed > 0 && maxFeed > settings.feedRate * 1.8) warnings.push(`导入程序最大进给 F${fmt(maxFeed, 1)}，高于当前工艺进给，请复核。`);
  if (spindle > 0 && spindle !== settings.spindleRpm) warnings.push(`导入程序包含主轴 S${fmt(spindle, 0)}，与当前参数 ${settings.spindleRpm.toFixed(0)}rpm 不一致。`);
  warnings.push("导入还原只基于 G0/G1 轨迹；暂不展开 G2/G3 圆弧、宏变量、刀补和坐标系偏置。");
  return warnings;
}

function estimateImportedMinutes(points: ParsedLine[], fallbackFeed: number) {
  let totalMinutes = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dy = (next.y ?? 0) - (prev.y ?? 0);
    const dz = next.z - prev.z;
    const da = Math.abs(next.a - prev.a) * 0.04;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz + da * da);
    const feed = next.rapid ? Math.max(fallbackFeed * 3, 600) : Math.max(1, fallbackFeed);
    totalMinutes += distance / feed;
  }
  return totalMinutes;
}

function toCsv(points: ToolpathPoint[]) {
  const hasY = points.some((point) => point.y != null);
  const rows = [hasY ? "x_mm,y_mm,z_mm,depth_mm" : "x_mm,a_deg,z_mm,depth_mm"];
  for (const point of points) {
    rows.push(hasY ? `${fmt(point.x)},${fmt(point.y ?? 0)},${fmt(point.z)},${fmt(point.depth)}` : `${fmt(point.x)},${fmt(point.a, 3)},${fmt(point.z)},${fmt(point.depth)}`);
  }
  return `${rows.join("\n")}\n`;
}

function toPointListGcode(points: ToolpathPoint[], filename: string, settings: ModelSettings) {
  const hasY = points.some((point) => point.y != null);
  const lines = [
    "%",
    `(Imported point list preview: ${filename})`,
    hasY ? "(Coordinate: X/Y/Z point list)" : "(Coordinate: X/A/Z point list)",
    "G21",
    "G90",
    "G94",
    `G0 Z${fmt(settings.safeZ)}`
  ];
  if (points.length > 0) {
    lines.push(hasY ? `G0 X${fmt(points[0].x)} Y${fmt(points[0].y ?? 0)}` : `G0 X${fmt(points[0].x)} A${fmt(points[0].a, 3)}`);
  }
  for (const point of points) {
    lines.push(hasY ? `G1 X${fmt(point.x)} Y${fmt(point.y ?? 0)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}` : `G1 X${fmt(point.x)} A${fmt(point.a, 3)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }
  lines.push(`G0 Z${fmt(settings.safeZ)}`, "M30", "%");
  return `${lines.join("\n")}\n`;
}
