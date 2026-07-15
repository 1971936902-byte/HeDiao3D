import * as THREE from "three";
import { sampleDepth } from "./imageProcessing";
import type { DepthMap, ModelSettings } from "./types";

export function createReliefGeometry(depthMap: DepthMap, settings: ModelSettings): THREE.BufferGeometry {
  const segmentsU = settings.meshU;
  const segmentsV = settings.meshV;
  const halfLength = settings.lengthMm / 2;
  const baseRadius = settings.diameterMm / 2;
  const angleSpan = THREE.MathUtils.degToRad(settings.reliefAngleDeg);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segmentsU; i += 1) {
    const u = i / segmentsU;
    const x = -halfLength + u * settings.lengthMm;
    const taper = 0.72 + 0.28 * Math.sin(Math.PI * u);
    const ovalRadius = baseRadius * taper;

    for (let j = 0; j <= segmentsV; j += 1) {
      const v = j / segmentsV;
      const theta = -Math.PI / 2 + v * Math.PI * 2;
      const inReliefArea = Math.abs(theta) <= angleSpan / 2;
      const localV = inReliefArea ? (theta + angleSpan / 2) / angleSpan : 0;
      const depth = inReliefArea ? sampleDepth(depthMap, u, 1 - localV) : 0;
      const relief = depth * settings.depthMm;
      const radius = ovalRadius + relief;
      const y = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      positions.push(x, y, z);
      colors.push(0.39 + depth * 0.35, 0.25 + depth * 0.18, 0.12 + depth * 0.08);
    }
  }

  const row = segmentsV + 1;
  for (let i = 0; i < segmentsU; i += 1) {
    for (let j = 0; j < segmentsV; j += 1) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      const c = (i + 1) * row + j + 1;
      const d = i * row + j + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createBlankDepthMap(width = 256, height = 160): DepthMap {
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const center = Math.exp(-((u - 0.5) ** 2 / 0.08 + (v - 0.5) ** 2 / 0.12));
      const wave = Math.max(0, Math.sin(u * Math.PI * 4) * Math.sin(v * Math.PI * 3));
      values[y * width + x] = Math.min(1, center * 0.75 + wave * 0.22);
    }
  }

  return { width, height, values };
}

export function createDemoDepthMap(variant: "lotus" | "waves", width = 256, height = 160): DepthMap {
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const cx = u - 0.5;
      const cy = v - 0.5;
      const radial = Math.sqrt(cx * cx + cy * cy);
      const petals = Math.max(0, Math.cos(Math.atan2(cy, cx) * 8) * 0.5 + 0.5) * Math.exp(-radial * 3.2);
      const center = Math.exp(-(cx * cx / 0.016 + cy * cy / 0.02));
      const wave = Math.max(0, Math.sin(u * Math.PI * 7 + Math.sin(v * Math.PI * 3)) * 0.5 + 0.5) * Math.exp(-Math.abs(v - 0.55) * 2.4);

      values[y * width + x] =
        variant === "lotus"
          ? Math.min(1, center * 0.9 + petals * 0.62)
          : Math.min(1, wave * 0.58 + Math.exp(-((u - 0.72) ** 2 / 0.025 + (v - 0.38) ** 2 / 0.035)) * 0.75);
    }
  }

  return { width, height, values };
}
