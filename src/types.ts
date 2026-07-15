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
  quality?: ImageQualityReport;
};

export type ImageQualityMetric = {
  label: string;
  value: number;
  unit: string;
  status: "ok" | "warning" | "critical";
};

export type ImageQualityReport = {
  score: number;
  verdict: "ready" | "usable" | "retake";
  summary: string;
  metrics: ImageQualityMetric[];
  suggestions: string[];
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
  leftHoldMm: number;
  rightHoldMm: number;
  endTransitionMm: number;
  toolDiameter: number;
  stepoverDeg: number;
  stepoverMm: number;
  toolProfileId: string;
  materialProfileId: string;
  machineProfileId: string;
  meshLengthAxis: "auto" | "x" | "y" | "z";
  meshAxisReverse: boolean;
  maxCutDepth: number;
  stockAllowance: number;
  finishingStrategy: "x-scan" | "a-scan" | "cross";
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

export type ToolpathProgram = {
  name: string;
  filename: string;
  gcode: string;
  points: ToolpathPoint[];
  estimatedMinutes: number;
};

export type GeneratedToolpath = {
  gcode: string;
  tap: string;
  txt: string;
  csv: string;
  points: ToolpathPoint[];
  programs?: {
    rough?: ToolpathProgram;
    finish?: ToolpathProgram;
    combined?: ToolpathProgram;
  };
  previewPoints?: ToolpathPreviewPoint[];
  estimatedMinutes: number;
  postProcessorName: string;
  summary: ToolpathSummary;
};

export type MeshQualityCheck = {
  label: string;
  value: string;
  status: "ok" | "warning" | "critical";
};

export type MeshQualityReport = {
  score: number;
  verdict: "ready" | "review" | "repair";
  triangleCount: number;
  vertexCount: number;
  edgeCount: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  degenerateFaces: number;
  dimensions: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  detectedLongAxis: "x" | "y" | "z";
  checks: MeshQualityCheck[];
  recommendations: string[];
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
