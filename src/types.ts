export type DepthMap = {
  width: number;
  height: number;
  values: Float32Array;
};

export type CarvingImage = {
  id: string;
  name: string;
  url: string;
  depthMap: DepthMap;
};

export type ModelSettings = {
  lengthMm: number;
  diameterMm: number;
  depthMm: number;
  reliefAngleDeg: number;
  contrast: number;
  smoothPasses: number;
  invertDepth: boolean;
  meshU: number;
  meshV: number;
  spindleRpm: number;
  feedRate: number;
  safeZ: number;
  toolDiameter: number;
  stepoverDeg: number;
  stepoverMm: number;
  generationMode: "active" | "blend" | "multiview";
  postProcessor: "generic" | "weihong" | "syntec";
};

export type ToolpathPoint = {
  x: number;
  a: number;
  z: number;
  depth: number;
};

export type ToolpathPreviewPoint = {
  x: number;
  y: number;
  z: number;
  hit: boolean;
};

export type GeneratedToolpath = {
  gcode: string;
  tap: string;
  txt: string;
  csv: string;
  points: ToolpathPoint[];
  previewPoints?: ToolpathPreviewPoint[];
  estimatedMinutes: number;
  postProcessorName: string;
  summary: ToolpathSummary;
};

export type ToolpathSummary = {
  xMin: number;
  xMax: number;
  aMin: number;
  aMax: number;
  zMin: number;
  zMax: number;
  maxDepth: number;
  warnings: string[];
};
