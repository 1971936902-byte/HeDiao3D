import type { DepthMap } from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export async function fileToDepthMap(file: File, width = 256, height = 160): Promise<{ url: string; depthMap: DepthMap }> {
  const url = URL.createObjectURL(file);
  const depthMap = await imageUrlToDepthMap(url, width, height);
  return { url, depthMap };
}

export async function assetUrlToDepthMap(url: string, width = 256, height = 160): Promise<{ url: string; depthMap: DepthMap }> {
  const depthMap = await imageUrlToDepthMap(url, width, height);
  return { url, depthMap };
}

async function imageUrlToDepthMap(url: string, width: number, height: number): Promise<DepthMap> {
  const image = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (!ctx) {
    throw new Error("无法创建图像处理画布");
  }

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const dx = (width - drawWidth) / 2;
  const dy = (height - drawHeight) / 2;
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const values = buildReliefDepth(pixels, width, height);

  normalize(values);
  return { width, height, values };
}

function buildReliefDepth(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
  const luminance = new Float32Array(width * height);
  const saturation = new Float32Array(width * height);

  for (let i = 0; i < luminance.length; i += 1) {
    const p = i * 4;
    const r = pixels[p] / 255;
    const g = pixels[p + 1] / 255;
    const b = pixels[p + 2] / 255;
    const alpha = pixels[p + 3] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    luminance[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) * alpha + (1 - alpha);
    saturation[i] = max <= 0 ? 0 : (max - min) / max;
  }

  const bgLum = estimateBackgroundLuminance(luminance, width, height);
  const foreground = new Float32Array(width * height);

  for (let i = 0; i < foreground.length; i += 1) {
    const darker = Math.max(0, bgLum - luminance[i]);
    const contrast = Math.abs(bgLum - luminance[i]);
    foreground[i] = clamp01(darker * 2.4 + contrast * 0.7 + saturation[i] * 0.35);
  }

  const mask = softenMask(thresholdMask(foreground, width, height), width, height, 3);
  const bounds = maskBounds(mask, width, height);
  const detail = new Float32Array(width * height);
  const values = new Float32Array(width * height);

  for (let i = 0; i < detail.length; i += 1) {
    detail[i] = clamp01((bgLum - luminance[i]) * 1.8 + saturation[i] * 0.35);
  }
  normalize(detail);

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const rx = Math.max(8, (bounds.maxX - bounds.minX) * 0.55);
  const ry = Math.max(8, (bounds.maxY - bounds.minY) * 0.58);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const dome = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const centralLift = Math.exp(-(nx * nx * 1.15 + ny * ny * 0.8));
      const edgeRelief = foreground[i] * 0.18;
      values[i] = mask[i] * (dome * 0.62 + centralLift * 0.18 + detail[i] * 0.28 + edgeRelief);
    }
  }

  return softenMask(values, width, height, 1);
}

export function processDepthMap(source: DepthMap, contrast: number, invert: boolean, smoothPasses: number): DepthMap {
  let values = new Float32Array(source.values);

  for (let i = 0; i < values.length; i += 1) {
    const adjusted = clamp01((values[i] - 0.5) * contrast + 0.5);
    values[i] = invert ? 1 - adjusted : adjusted;
  }

  for (let pass = 0; pass < smoothPasses; pass += 1) {
    values = smooth(values, source.width, source.height);
  }

  return { ...source, values };
}

export function blendDepthMaps(maps: DepthMap[]): DepthMap {
  if (maps.length === 0) {
    throw new Error("至少需要一张深度图");
  }

  const width = maps[0].width;
  const height = maps[0].height;
  const values = new Float32Array(width * height);

  for (const map of maps) {
    for (let i = 0; i < values.length; i += 1) {
      values[i] += sampleDepth(map, (i % width) / (width - 1), Math.floor(i / width) / (height - 1));
    }
  }

  for (let i = 0; i < values.length; i += 1) {
    values[i] /= maps.length;
  }

  return { width, height, values };
}

export function createMultiViewDepthMap(maps: DepthMap[]): DepthMap {
  if (maps.length === 0) {
    throw new Error("至少需要一张深度图");
  }

  const width = maps[0].width;
  const height = maps[0].height;
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const wrapped = (y / height) * maps.length;
    const leftIndex = Math.floor(wrapped) % maps.length;
    const rightIndex = (leftIndex + 1) % maps.length;
    const blend = wrapped - Math.floor(wrapped);
    const localV = blend;

    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const a = sampleDepth(maps[leftIndex], u, localV);
      const b = sampleDepth(maps[rightIndex], u, localV);
      const seamBlend = smoothstep(blend);
      values[y * width + x] = a * (1 - seamBlend) + b * seamBlend;
    }
  }

  return { width, height, values: softenMask(values, width, height, 1) };
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

export function sampleDepth(map: DepthMap, u: number, v: number): number {
  const x = clamp01(u) * (map.width - 1);
  const y = clamp01(v) * (map.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const a = map.values[y0 * map.width + x0];
  const b = map.values[y0 * map.width + x1];
  const c = map.values[y1 * map.width + x0];
  const d = map.values[y1 * map.width + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function smooth(values: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(values.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let weight = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const sx = Math.min(width - 1, Math.max(0, x + ox));
          const sy = Math.min(height - 1, Math.max(0, y + oy));
          const w = ox === 0 && oy === 0 ? 4 : ox === 0 || oy === 0 ? 2 : 1;
          sum += values[sy * width + sx] * w;
          weight += w;
        }
      }

      output[y * width + x] = sum / weight;
    }
  }

  return output;
}

function estimateBackgroundLuminance(luminance: Float32Array, width: number, height: number): number {
  const samples: number[] = [];
  const edge = Math.max(4, Math.floor(Math.min(width, height) * 0.08));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < edge || y < edge || x >= width - edge || y >= height - edge) {
        samples.push(luminance[y * width + x]);
      }
    }
  }

  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.72)] ?? 0.92;
}

function thresholdMask(foreground: Float32Array, width: number, height: number): Float32Array {
  const sorted = Array.from(foreground).sort((a, b) => a - b);
  const threshold = Math.max(0.08, sorted[Math.floor(sorted.length * 0.72)] ?? 0.12);
  const mask = new Float32Array(width * height);

  for (let i = 0; i < foreground.length; i += 1) {
    mask[i] = foreground[i] > threshold ? 1 : clamp01(foreground[i] / threshold) * 0.45;
  }

  return mask;
}

function softenMask(values: Float32Array, width: number, height: number, passes: number): Float32Array {
  let result = new Float32Array(values);
  for (let i = 0; i < passes; i += 1) {
    result = smooth(result, width, height);
  }
  return result;
}

function maskBounds(mask: Float32Array, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] > 0.18) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (minX >= maxX || minY >= maxY) {
    return { minX: width * 0.25, minY: height * 0.2, maxX: width * 0.75, maxY: height * 0.8 };
  }

  return { minX, minY, maxX, maxY };
}

function normalize(values: Float32Array) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  const span = Math.max(0.0001, max - min);
  for (let i = 0; i < values.length; i += 1) {
    values[i] = clamp01((values[i] - min) / span);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}
