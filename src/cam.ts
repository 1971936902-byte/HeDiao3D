import { sampleDepth } from "./imageProcessing";
import { getToolProfile } from "./manufacturingProfiles";
import type { DepthMap, GeneratedToolpath, ModelSettings, ToolpathPoint, ToolpathProgram } from "./types";

const fmt = (value: number, digits = 4) => value.toFixed(digits);

const postProcessorNames = {
  generic: "通用四轴 G-code",
  weihong: "维宏风格 G-code",
  syntec: "新代风格 G-code",
  generic3: "通用三轴 G-code",
  wrapY: "Y轴旋转包裹 G-code",
  wrapX: "X轴旋转包裹 G-code"
} satisfies Record<ModelSettings["postProcessor"], string>;

export function generateToolpath(depthMap: DepthMap, settings: ModelSettings): GeneratedToolpath {
  if (settings.camMode === "3axis") {
    return generateThreeAxisToolpath(depthMap, settings);
  }

  const finishPoints = createScanPoints(depthMap, settings, {
    stockAllowance: 0,
    maxLayerDepth: settings.depthMm,
    strategy: settings.finishingStrategy
  });
  const roughPoints = createRoughingPoints(depthMap, settings);
  const restPoints = createRestMachiningPoints(depthMap, settings);
  const combinedPoints = [...roughPoints, ...finishPoints, ...restPoints];
  const radius = settings.diameterMm / 2;
  const roughMinutes = estimateTravel(roughPoints, radius) / Math.max(1, settings.feedRate);
  const finishMinutes = estimateTravel(finishPoints, radius) / Math.max(1, settings.feedRate);
  const restMinutes = estimateTravel(restPoints, radius) / Math.max(1, settings.feedRate * 0.78);
  const combinedMinutes = roughMinutes + finishMinutes + restMinutes;
  const roughGcode = toGcode(roughPoints, settings, roughMinutes, "Roughing pass");
  const finishGcode = toGcode(finishPoints, settings, finishMinutes, "Finishing pass");
  const restGcode = toGcode(restPoints, { ...settings, feedRate: Math.max(30, settings.feedRate * 0.78) }, restMinutes, "Rest machining pass");
  const combinedGcode = toGcode(combinedPoints, settings, combinedMinutes, "Roughing + finishing + rest machining");
  const airRunProgram = createAirRunProgram(combinedPoints, settings, combinedMinutes, "Air run - no cutting");
  const programs: GeneratedToolpath["programs"] = {
    rough: createProgram("粗加工", "nuclear-carving-rough.nc", roughGcode, roughPoints, roughMinutes),
    finish: createProgram("精加工", "nuclear-carving-finish.nc", finishGcode, finishPoints, finishMinutes),
    rest: createProgram("清残", "nuclear-carving-rest.nc", restGcode, restPoints, restMinutes),
    combined: createProgram("合并程序", "nuclear-carving-combined.nc", combinedGcode, combinedPoints, combinedMinutes),
    airRun: airRunProgram
  };

  return {
    points: finishPoints,
    programs,
    gcode: combinedGcode,
    tap: combinedGcode,
    txt: combinedGcode,
    csv: toCsv(finishPoints),
    estimatedMinutes: combinedMinutes,
    postProcessorName: postProcessorNames[settings.postProcessor],
    summary: summarizeToolpath(combinedPoints, settings, {
      roughPasses: countRoughLayers(settings),
      roughPoints: roughPoints.length,
      finishPoints: finishPoints.length,
      restPoints: restPoints.length,
      roughMinutes,
      finishMinutes,
      restMinutes
    })
  };
}

function generateThreeAxisToolpath(depthMap: DepthMap, settings: ModelSettings): GeneratedToolpath {
  const roughPoints = createThreeAxisRoughingPoints(depthMap, settings);
  const finishPoints = createThreeAxisScanPoints(depthMap, settings, {
    stockAllowance: 0,
    maxLayerDepth: settings.depthMm,
    strategy: settings.finishingStrategy
  });
  const restPoints = createThreeAxisRestPoints(depthMap, settings);
  const combinedPoints = [...roughPoints, ...finishPoints, ...restPoints];
  const roughMinutes = estimateTravel3Axis(roughPoints) / Math.max(1, settings.feedRate);
  const finishMinutes = estimateTravel3Axis(finishPoints) / Math.max(1, settings.feedRate);
  const restMinutes = estimateTravel3Axis(restPoints) / Math.max(1, settings.feedRate * 0.78);
  const combinedMinutes = roughMinutes + finishMinutes + restMinutes;
  const roughGcode = toThreeAxisGcode(roughPoints, settings, roughMinutes, "3-axis roughing pass");
  const finishGcode = toThreeAxisGcode(finishPoints, settings, finishMinutes, "3-axis finishing pass");
  const restGcode = toThreeAxisGcode(restPoints, { ...settings, feedRate: Math.max(30, settings.feedRate * 0.78) }, restMinutes, "3-axis rest machining pass");
  const combinedGcode = toThreeAxisGcode(combinedPoints, settings, combinedMinutes, "3-axis roughing + finishing + rest machining");
  const airRunProgram = createAirRunProgram(combinedPoints, settings, combinedMinutes, "3-axis air run - no cutting");
  const programs: GeneratedToolpath["programs"] = {
    rough: createProgram("三轴粗加工", "nuclear-carving-3axis-rough.nc", roughGcode, roughPoints, roughMinutes),
    finish: createProgram("三轴精加工", "nuclear-carving-3axis-finish.nc", finishGcode, finishPoints, finishMinutes),
    rest: createProgram("三轴清残", "nuclear-carving-3axis-rest.nc", restGcode, restPoints, restMinutes),
    combined: createProgram("三轴合并程序", "nuclear-carving-3axis-combined.nc", combinedGcode, combinedPoints, combinedMinutes),
    airRun: airRunProgram
  };

  return {
    points: finishPoints,
    programs,
    gcode: combinedGcode,
    tap: combinedGcode,
    txt: combinedGcode,
    csv: toCsv(finishPoints),
    estimatedMinutes: combinedMinutes,
    postProcessorName: postProcessorNames[settings.postProcessor],
    summary: summarizeToolpath(combinedPoints, settings, {
      roughPasses: countRoughLayers(settings),
      roughPoints: roughPoints.length,
      finishPoints: finishPoints.length,
      restPoints: restPoints.length,
      roughMinutes,
      finishMinutes,
      restMinutes
    })
  };
}

type ScanOptions = {
  stockAllowance: number;
  maxLayerDepth: number;
  strategy: ModelSettings["finishingStrategy"];
};

function createScanPoints(depthMap: DepthMap, settings: ModelSettings, options: ScanOptions): ToolpathPoint[] {
  const points: ToolpathPoint[] = [];
  const halfLength = settings.lengthMm / 2;
  const xStart = -halfLength + settings.leftHoldMm;
  const xEnd = halfLength - settings.rightHoldMm;
  const carveLength = Math.max(settings.stepoverMm, xEnd - xStart);
  const radius = settings.diameterMm / 2;
  const aMin = settings.reliefAngleDeg >= 360 ? -180 : -settings.reliefAngleDeg / 2;
  const aMax = settings.reliefAngleDeg >= 360 ? 180 : settings.reliefAngleDeg / 2;
  const passes = Math.max(2, Math.ceil(settings.reliefAngleDeg / settings.stepoverDeg));
  const xSteps = Math.max(2, Math.ceil(carveLength / settings.stepoverMm));

  const pushPoint = (pass: number, step: number, serpentine: boolean) => {
    const a = aMin + (pass / passes) * (aMax - aMin);
    const v = pass / passes;
    const index = serpentine ? xSteps - step : step;
    const carveU = index / xSteps;
    const x = xStart + carveU * carveLength;
    const sourceU = (x + halfLength) / settings.lengthMm;
    const transition = endTransitionFactor(x, xStart, xEnd, settings.endTransitionMm);
    const targetDepth = sampleDepth(depthMap, sourceU, 1 - v) * settings.depthMm * transition;
    const roughDepth = Math.max(0, targetDepth - options.stockAllowance);
    const depth = Math.min(roughDepth, options.maxLayerDepth);
    const z = radius + depth + settings.toolDiameter / 2;
    points.push({ x, a, z, depth });
  };

  if (options.strategy === "a-scan") {
    for (let step = 0; step <= xSteps; step += 1) {
      const serpentine = step % 2 === 1;
      for (let pass = 0; pass <= passes; pass += 1) {
        const passIndex = serpentine ? passes - pass : pass;
        pushPoint(passIndex, step, false);
      }
    }
    return points;
  }

  for (let pass = 0; pass <= passes; pass += 1) {
    const serpentine = pass % 2 === 1;
    for (let step = 0; step <= xSteps; step += 1) {
      pushPoint(pass, step, serpentine);
    }
  }

  if (options.strategy === "cross") {
    points.push(
      ...createScanPoints(depthMap, settings, {
        ...options,
        strategy: "a-scan"
      })
    );
  }

  return points;
}

function createRoughingPoints(depthMap: DepthMap, settings: ModelSettings): ToolpathPoint[] {
  const layerDepth = Math.max(0.02, settings.maxCutDepth);
  const maxRoughDepth = Math.max(0, settings.depthMm - settings.stockAllowance);
  const layers = Math.max(1, Math.ceil(maxRoughDepth / layerDepth));
  const points: ToolpathPoint[] = [];

  for (let layer = 1; layer <= layers; layer += 1) {
    const currentDepth = Math.min(maxRoughDepth, layer * layerDepth);
    points.push(
      ...createScanPoints(depthMap, settings, {
        stockAllowance: settings.stockAllowance,
        maxLayerDepth: currentDepth,
        strategy: "x-scan"
      })
    );
  }

  return points;
}

function createRestMachiningPoints(depthMap: DepthMap, settings: ModelSettings): ToolpathPoint[] {
  const points: ToolpathPoint[] = [];
  const halfLength = settings.lengthMm / 2;
  const xStart = -halfLength + settings.leftHoldMm;
  const xEnd = halfLength - settings.rightHoldMm;
  const carveLength = Math.max(settings.stepoverMm, xEnd - xStart);
  const radius = settings.diameterMm / 2;
  const aMin = settings.reliefAngleDeg >= 360 ? -180 : -settings.reliefAngleDeg / 2;
  const aMax = settings.reliefAngleDeg >= 360 ? 180 : settings.reliefAngleDeg / 2;
  const restStepoverMm = Math.max(0.018, settings.stepoverMm * 0.62);
  const restStepoverDeg = Math.max(0.16, settings.stepoverDeg * 0.62);
  const passes = Math.max(2, Math.ceil(settings.reliefAngleDeg / restStepoverDeg));
  const xSteps = Math.max(2, Math.ceil(carveLength / restStepoverMm));
  const gradientThreshold = Math.max(0.04, settings.toolDiameter * 0.16);
  const deepThreshold = settings.depthMm * 0.72;

  for (let pass = 0; pass <= passes; pass += 1) {
    const serpentine = pass % 2 === 1;
    const v = pass / passes;
    const a = aMin + v * (aMax - aMin);

    for (let step = 0; step <= xSteps; step += 1) {
      const index = serpentine ? xSteps - step : step;
      const carveU = index / xSteps;
      const x = xStart + carveU * carveLength;
      const sourceU = (x + halfLength) / settings.lengthMm;
      const sourceV = 1 - v;
      const transition = endTransitionFactor(x, xStart, xEnd, settings.endTransitionMm);
      const centerDepth = sampleDepth(depthMap, sourceU, sourceV) * settings.depthMm * transition;
      if (centerDepth <= 0.01) continue;

      const gradient = estimateDepthGradient(depthMap, sourceU, sourceV) * settings.depthMm * transition;
      const likelyResidual = gradient >= gradientThreshold || centerDepth >= deepThreshold;
      const checker = (pass + step) % 2 === 0;
      if (!likelyResidual || !checker) continue;

      const z = radius + centerDepth + settings.toolDiameter / 2;
      points.push({ x, a, z, depth: centerDepth });
    }
  }

  return points;
}

function createThreeAxisScanPoints(depthMap: DepthMap, settings: ModelSettings, options: ScanOptions): ToolpathPoint[] {
  const points: ToolpathPoint[] = [];
  const halfLength = settings.lengthMm / 2;
  const halfWidth = settings.diameterMm / 2;
  const xSteps = Math.max(2, Math.ceil(settings.lengthMm / settings.stepoverMm));
  const ySteps = Math.max(2, Math.ceil(settings.diameterMm / settings.stepoverMm));

  const pushPoint = (xIndex: number, yIndex: number) => {
    const xRatio = xIndex / xSteps;
    const yRatio = yIndex / ySteps;
    const x = -halfLength + xRatio * settings.lengthMm;
    const y = -halfWidth + yRatio * settings.diameterMm;
    const targetDepth = sampleDepth(depthMap, xRatio, 1 - yRatio) * settings.depthMm;
    const roughDepth = Math.max(0, targetDepth - options.stockAllowance);
    const depth = Math.min(roughDepth, options.maxLayerDepth);
    points.push({ x, y, a: 0, z: -depth, depth });
  };

  if (options.strategy === "a-scan") {
    for (let xIndex = 0; xIndex <= xSteps; xIndex += 1) {
      const serpentine = xIndex % 2 === 1;
      for (let yStep = 0; yStep <= ySteps; yStep += 1) {
        pushPoint(xIndex, serpentine ? ySteps - yStep : yStep);
      }
    }
    return points;
  }

  for (let yIndex = 0; yIndex <= ySteps; yIndex += 1) {
    const serpentine = yIndex % 2 === 1;
    for (let xStep = 0; xStep <= xSteps; xStep += 1) {
      pushPoint(serpentine ? xSteps - xStep : xStep, yIndex);
    }
  }

  if (options.strategy === "cross") {
    points.push(
      ...createThreeAxisScanPoints(depthMap, settings, {
        ...options,
        strategy: "a-scan"
      })
    );
  }

  return points;
}

function createThreeAxisRoughingPoints(depthMap: DepthMap, settings: ModelSettings): ToolpathPoint[] {
  const layerDepth = Math.max(0.02, settings.maxCutDepth);
  const maxRoughDepth = Math.max(0, settings.depthMm - settings.stockAllowance);
  const layers = Math.max(1, Math.ceil(maxRoughDepth / layerDepth));
  const points: ToolpathPoint[] = [];

  for (let layer = 1; layer <= layers; layer += 1) {
    points.push(
      ...createThreeAxisScanPoints(depthMap, settings, {
        stockAllowance: settings.stockAllowance,
        maxLayerDepth: Math.min(maxRoughDepth, layer * layerDepth),
        strategy: "x-scan"
      })
    );
  }

  return points;
}

function createThreeAxisRestPoints(depthMap: DepthMap, settings: ModelSettings): ToolpathPoint[] {
  const restSettings = {
    ...settings,
    stepoverMm: Math.max(0.04, settings.stepoverMm * 0.62)
  };
  const candidatePoints = createThreeAxisScanPoints(depthMap, restSettings, {
    stockAllowance: 0,
    maxLayerDepth: settings.depthMm,
    strategy: settings.finishingStrategy === "cross" ? "cross" : "x-scan"
  });
  const gradientThreshold = Math.max(0.04, settings.toolDiameter * 0.05);
  const deepThreshold = settings.depthMm * 0.72;
  const halfLength = settings.lengthMm / 2;
  const halfWidth = settings.diameterMm / 2;

  return candidatePoints.filter((point, index) => {
    if (point.depth <= 0.01) return false;
    const u = (point.x + halfLength) / settings.lengthMm;
    const v = 1 - ((point.y ?? 0) + halfWidth) / settings.diameterMm;
    const gradient = estimateDepthGradient(depthMap, u, v) * settings.depthMm;
    return (point.depth >= deepThreshold || gradient >= gradientThreshold) && index % 2 === 0;
  });
}

function estimateDepthGradient(depthMap: DepthMap, u: number, v: number) {
  const du = 1 / Math.max(2, depthMap.width - 1);
  const dv = 1 / Math.max(2, depthMap.height - 1);
  const left = sampleDepth(depthMap, THREEClamp(u - du, 0, 1), v);
  const right = sampleDepth(depthMap, THREEClamp(u + du, 0, 1), v);
  const top = sampleDepth(depthMap, u, THREEClamp(v - dv, 0, 1));
  const bottom = sampleDepth(depthMap, u, THREEClamp(v + dv, 0, 1));
  return Math.sqrt((right - left) ** 2 + (bottom - top) ** 2);
}

function countRoughLayers(settings: ModelSettings) {
  const maxRoughDepth = Math.max(0, settings.depthMm - settings.stockAllowance);
  return Math.max(1, Math.ceil(maxRoughDepth / Math.max(0.02, settings.maxCutDepth)));
}

function createProgram(name: string, filename: string, gcode: string, points: ToolpathPoint[], estimatedMinutes: number): ToolpathProgram {
  return { name, filename, gcode, points, estimatedMinutes };
}

export function createAirRunProgram(
  points: ToolpathPoint[],
  settings: ModelSettings,
  estimatedMinutes: number,
  programName = "Air run - no cutting"
): ToolpathProgram {
  const airPoints = points.map((point) => ({
    ...point,
    z: settings.safeZ,
    depth: 0
  }));
  return createProgram("离料空跑", "nuclear-carving-air-run.nc", toAirRunGcode(airPoints, settings, estimatedMinutes, programName), airPoints, estimatedMinutes);
}

function summarizeToolpath(
  points: ToolpathPoint[],
  settings: ModelSettings,
  process?: {
    roughPasses: number;
    roughPoints: number;
    finishPoints: number;
    restPoints: number;
    roughMinutes: number;
    finishMinutes: number;
    restMinutes: number;
  }
) {
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
    {
      xMin: Number.POSITIVE_INFINITY,
      xMax: Number.NEGATIVE_INFINITY,
      yMin: Number.POSITIVE_INFINITY,
      yMax: Number.NEGATIVE_INFINITY,
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

  if (settings.camMode !== "3axis" && settings.reliefAngleDeg > 300) {
    warnings.push("包覆角度较大，请确认夹具与A轴连续旋转方向。");
  }

  if (settings.camMode !== "3axis" && (settings.leftHoldMm > 0 || settings.rightHoldMm > 0)) {
    warnings.push(`已避开端部夹持区：左 ${fmt(settings.leftHoldMm, 1)}mm / 右 ${fmt(settings.rightHoldMm, 1)}mm。`);
  }

  const processSummary = process
    ? {
        ...process,
        restPointRate: process.finishPoints > 0 ? (process.restPoints / process.finishPoints) * 100 : 0,
        restStrategy: "高梯度/深纹理区域二次清残",
        restTrigger: `深度 >= ${fmt(settings.depthMm * 0.72, 2)}mm 或局部梯度 >= ${fmt(Math.max(0.04, settings.toolDiameter * 0.16), 3)}mm`
      }
    : undefined;

  if (processSummary) {
    warnings.push(`粗加工 ${processSummary.roughPasses} 层，余量 ${fmt(settings.stockAllowance, 2)}mm；粗加工点 ${processSummary.roughPoints}，精加工点 ${processSummary.finishPoints}，清残点 ${processSummary.restPoints}。`);
    if (processSummary.restPoints === 0) {
      warnings.push("清残程序没有有效切削点，请确认模型细节是否足够或减小步距/刀具直径。");
    } else if (processSummary.restPointRate > 45) {
      warnings.push("清残点占比偏高，建议检查模型噪声、刀具直径和精加工步距。");
    }
  }

  return { ...values, process: processSummary, warnings };
}

function endTransitionFactor(x: number, xStart: number, xEnd: number, transitionMm: number) {
  if (transitionMm <= 0) return 1;
  const left = THREEClamp((x - xStart) / transitionMm, 0, 1);
  const right = THREEClamp((xEnd - x) / transitionMm, 0, 1);
  return Math.min(left, right);
}

function THREEClamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toGcode(points: ToolpathPoint[], settings: ModelSettings, estimatedMinutes: number, programName = "Relief toolpath"): string {
  if (settings.camMode === "3axis") return toThreeAxisGcode(points, settings, estimatedMinutes, programName);
  if (settings.camMode === "rotaryWrap") return toRotaryWrapGcode(points, settings, estimatedMinutes, programName);
  const tool = getToolProfile(settings.toolProfileId);

  const lines = [
    `%`,
    `(Nuclear carving relief CAM V2 - ${programName} - ${postProcessorNames[settings.postProcessor]})`,
    "(Coordinate: X length axis, A rotary axis, Z radial tool center)",
    `(Length=${fmt(settings.lengthMm, 3)}mm Diameter=${fmt(settings.diameterMm, 3)}mm MaxDepth=${fmt(settings.depthMm, 3)}mm)`,
    `(HoldLeft=${fmt(settings.leftHoldMm, 3)}mm HoldRight=${fmt(settings.rightHoldMm, 3)}mm EndTransition=${fmt(settings.endTransitionMm, 3)}mm)`,
    `(Tool=${tool.name} Diameter=${fmt(settings.toolDiameter, 3)}mm MaxCutDepth=${fmt(settings.maxCutDepth, 3)}mm StockAllowance=${fmt(settings.stockAllowance, 3)}mm Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    ...postStart(settings)
  ];

  const outputPoints = unwrapRotaryAngles(points);

  if (outputPoints.length > 0) {
    lines.push(`G0 X${fmt(outputPoints[0].x)} A${fmt(outputPoints[0].a, 3)}`);
    lines.push(`G1 Z${fmt(outputPoints[0].z)} F${fmt(settings.feedRate * 0.45, 1)}`);
  }

  for (const point of outputPoints) {
    lines.push(`G1 X${fmt(point.x)} A${fmt(point.a, 3)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
}

function toAirRunGcode(points: ToolpathPoint[], settings: ModelSettings, estimatedMinutes: number, programName = "Air run - no cutting"): string {
  if (settings.camMode === "3axis") {
    const lines = [
      `%`,
      `(Nuclear carving CAM V2 - ${programName} - ${postProcessorNames[settings.postProcessor]})`,
      "(AIR RUN ONLY: spindle stays off, Z remains at safe height, do not use for cutting)",
      "(Coordinate: X/Y table axes, Z spindle axis)",
      `(SafeZ=${fmt(settings.safeZ, 3)}mm EstimatedMotion=${fmt(estimatedMinutes, 2)}min)`,
      "G21",
      "G90",
      "G94",
      "(POST: GENERIC 3AXIS AIR RUN)",
      `F${fmt(Math.min(settings.feedRate, 300), 1)}`,
      "M5",
      `G0 Z${fmt(settings.safeZ)}`
    ];

    if (points.length > 0) {
      lines.push(`G0 X${fmt(points[0].x)} Y${fmt(points[0].y ?? 0)} Z${fmt(settings.safeZ)}`);
    }

    for (const point of points) {
      lines.push(`G1 X${fmt(point.x)} Y${fmt(point.y ?? 0)} Z${fmt(settings.safeZ)} F${fmt(Math.min(settings.feedRate, 300), 1)}`);
    }

    lines.push(`G0 Z${fmt(settings.safeZ)}`);
    lines.push("M5", "M30", "%");
    return `${lines.join("\n")}\n`;
  }

  if (settings.camMode === "rotaryWrap") {
    const airPoints = points.map((point) => ({ ...point, z: settings.safeZ, depth: 0 }));
    return toRotaryWrapGcode(airPoints, settings, estimatedMinutes, programName, true);
  }

  const lines = [
    `%`,
    `(Nuclear carving relief CAM V2 - ${programName} - ${postProcessorNames[settings.postProcessor]})`,
    "(AIR RUN ONLY: spindle stays off, Z remains at safe height, do not use for cutting)",
    "(Purpose: verify X/A direction, travel range, fixture clearance and program continuity)",
    `(SafeZ=${fmt(settings.safeZ, 3)}mm EstimatedMotion=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    ...postAirRunStart(settings)
  ];

  const outputPoints = unwrapRotaryAngles(points);

  if (outputPoints.length > 0) {
    lines.push(`G0 X${fmt(outputPoints[0].x)} A${fmt(outputPoints[0].a, 3)} Z${fmt(settings.safeZ)}`);
  }

  for (const point of outputPoints) {
    lines.push(`G1 X${fmt(point.x)} A${fmt(point.a, 3)} Z${fmt(settings.safeZ)} F${fmt(Math.min(settings.feedRate, 180), 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
}

function unwrapRotaryAngles(points: ToolpathPoint[]): ToolpathPoint[] {
  return points.map((point) => ({ ...point, a: normalizeRotaryAngle(point.a) }));
}

function normalizeRotaryAngle(angle: number) {
  const normalized = ((Number(angle) || 0) + 360) % 360;
  return Math.abs(normalized - 360) < 0.000001 ? 0 : normalized;
}

function postStart(settings: ModelSettings): string[] {
  if (settings.postProcessor === "generic3") {
    return ["(POST: GENERIC 3AXIS)", "G17", `F${fmt(settings.feedRate, 1)}`, `S${Math.round(settings.spindleRpm)} M3`, `G0 Z${fmt(settings.safeZ)}`];
  }

  if (settings.postProcessor === "wrapY" || settings.postProcessor === "wrapX") {
    return [
      `(POST: ROTARY WRAP ${settings.rotaryOutputAxis}-AXIS)`,
      "(Rotary angle is mapped to linear axis by rotaryWrapPerRevolutionMm)",
      `F${fmt(settings.feedRate, 1)}`,
      `S${Math.round(settings.spindleRpm)} M3`,
      `G0 Z${fmt(settings.safeZ)}`
    ];
  }

  const shared = [`F${fmt(settings.feedRate, 1)}`, `S${Math.round(settings.spindleRpm)} M3`, `G0 Z${fmt(settings.safeZ)}`];

  if (settings.postProcessor === "weihong") {
    return ["(POST: WEIHONG STYLE)", "G17", ...shared];
  }

  if (settings.postProcessor === "syntec") {
    return ["(POST: SYNTEC STYLE)", "G17 G40 G49 G80", ...shared];
  }

  return ["(POST: GENERIC 4AXIS)", ...shared];
}

function postAirRunStart(settings: ModelSettings): string[] {
  const shared = [`F${fmt(Math.min(settings.feedRate, 180), 1)}`, "M5", `G0 Z${fmt(settings.safeZ)}`];

  if (settings.postProcessor === "weihong") {
    return ["(POST: WEIHONG STYLE AIR RUN)", "G17", ...shared];
  }

  if (settings.postProcessor === "syntec") {
    return ["(POST: SYNTEC STYLE AIR RUN)", "G17 G40 G49 G80", ...shared];
  }

  return ["(POST: GENERIC 4AXIS AIR RUN)", ...shared];
}

function postEnd(settings: ModelSettings): string[] {
  if (settings.postProcessor === "syntec") {
    return ["G49", "M5", "M30"];
  }

  return ["M5", "M30"];
}

function toCsv(points: ToolpathPoint[]): string {
  const hasY = points.some((point) => point.y != null);
  const rows = [hasY ? "x_mm,y_mm,z_mm,relief_depth_mm" : "x_mm,a_deg,z_mm,relief_depth_mm"];
  for (const point of points) {
    rows.push(hasY ? `${fmt(point.x)},${fmt(point.y ?? 0)},${fmt(point.z)},${fmt(point.depth)}` : `${fmt(point.x)},${fmt(point.a, 3)},${fmt(point.z)},${fmt(point.depth)}`);
  }
  return `${rows.join("\n")}\n`;
}

function toRotaryWrapGcode(
  points: ToolpathPoint[],
  settings: ModelSettings,
  estimatedMinutes: number,
  programName = "Rotary wrapped toolpath",
  airRun = false
): string {
  const tool = getToolProfile(settings.toolProfileId);
  const rotaryAxis = settings.rotaryOutputAxis ?? (settings.postProcessor === "wrapX" ? "X" : settings.postProcessor === "wrapY" ? "Y" : "A");
  const wrapPerRev = Math.max(0.001, settings.rotaryWrapPerRevolutionMm ?? 100);
  const linearLengthAxis = rotaryAxis === "X" ? "Y" : "X";
  const rotaryWord = (aDeg: number) => {
    if (rotaryAxis === "A") return `A${fmt(aDeg, 3)}`;
    return `${rotaryAxis}${fmt((aDeg / 360) * wrapPerRev, 4)}`;
  };
  const lengthWord = (x: number) => `${linearLengthAxis}${fmt(x)}`;
  const lines = [
    `%`,
    `(Nuclear carving rotary wrap CAM V2 - ${programName} - ${postProcessorNames[settings.postProcessor]})`,
    `(Coordinate: ${linearLengthAxis}=length axis, ${rotaryAxis}=rotary fixture${rotaryAxis === "A" ? " angle deg" : ` linearized, ${fmt(wrapPerRev, 3)}mm per 360deg`}, Z=radial tool center)`,
    `(ROTARY_WRAP_AXIS=${rotaryAxis} ROTARY_WRAP_PER_REV_MM=${fmt(wrapPerRev, 6)} LENGTH_AXIS=${linearLengthAxis})`,
    `(Length=${fmt(settings.lengthMm, 3)}mm Diameter=${fmt(settings.diameterMm, 3)}mm MaxDepth=${fmt(settings.depthMm, 3)}mm)`,
    `(Tool=${tool.name} Diameter=${fmt(settings.toolDiameter, 3)}mm MaxCutDepth=${fmt(settings.maxCutDepth, 3)}mm StockAllowance=${fmt(settings.stockAllowance, 3)}mm Estimated=${fmt(estimatedMinutes, 2)}min)`,
    airRun ? "(AIR RUN ONLY: spindle stays off, Z remains at safe height, do not use for cutting)" : "(Wrapped rotary mode: controller may be 3-axis, fixture rotation is driven by mapped linear axis)",
    "G21",
    "G90",
    "G94",
    ...postStart({ ...settings, postProcessor: settings.postProcessor === "generic3" ? "wrapY" : settings.postProcessor })
  ];

  if (airRun) {
    lines.push("M5");
  }

  if (points.length > 0) {
    lines.push(`G0 ${lengthWord(points[0].x)} ${rotaryWord(points[0].a)} Z${fmt(settings.safeZ)}`);
    if (!airRun) lines.push(`G1 Z${fmt(points[0].z)} F${fmt(settings.feedRate * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 ${lengthWord(point.x)} ${rotaryWord(point.a)} Z${fmt(airRun ? settings.safeZ : point.z)} F${fmt(airRun ? Math.min(settings.feedRate, 180) : settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
}

function estimateTravel(points: ToolpathPoint[], radius: number): number {
  if (points.some((point) => point.y != null)) return estimateTravel3Axis(points);

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

function estimateTravel3Axis(points: ToolpathPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dy = (next.y ?? 0) - (prev.y ?? 0);
    const dz = next.z - prev.z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return total;
}

function toThreeAxisGcode(points: ToolpathPoint[], settings: ModelSettings, estimatedMinutes: number, programName = "3-axis relief toolpath"): string {
  const tool = getToolProfile(settings.toolProfileId);
  const toolGeometry = tool.type === "v-bit"
    ? ` Type=VBIT Angle=${fmt(tool.angleDeg ?? 0, 1)}deg FlatTip=${fmt(tool.flatTipMm ?? tool.tipRadiusMm * 2, 3)}mm`
    : ` Type=${tool.type.toUpperCase()}`;
  const lines = [
    `%`,
    `(Nuclear carving relief CAM V2 - ${programName} - ${postProcessorNames[settings.postProcessor]})`,
    "(Coordinate: X/Y table axes, Z spindle axis; workpiece top is Z0, cutting Z is negative)",
    `(Length=${fmt(settings.lengthMm, 3)}mm Width=${fmt(settings.diameterMm, 3)}mm MaxDepth=${fmt(settings.depthMm, 3)}mm)`,
    `(Tool=${tool.name} Diameter=${fmt(settings.toolDiameter, 3)}mm${toolGeometry} MaxCutDepth=${fmt(settings.maxCutDepth, 3)}mm StockAllowance=${fmt(settings.stockAllowance, 3)}mm Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    "(POST: GENERIC 3AXIS)",
    `F${fmt(settings.feedRate, 1)}`,
    `S${Math.round(settings.spindleRpm)} M3`,
    `G0 Z${fmt(settings.safeZ)}`
  ];

  if (points.length > 0) {
    lines.push(`G0 X${fmt(points[0].x)} Y${fmt(points[0].y ?? 0)}`);
    lines.push(`G1 Z${fmt(points[0].z)} F${fmt(settings.feedRate * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 X${fmt(point.x)} Y${fmt(point.y ?? 0)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push("M5", "M30", "%");
  return `${lines.join("\n")}\n`;
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 30000);
}
