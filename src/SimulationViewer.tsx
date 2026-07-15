import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelSettings, ToolpathPoint, ToolpathPreviewPoint } from "./types";

type SimulationViewerProps = {
  points: ToolpathPoint[];
  previewPoints?: ToolpathPreviewPoint[];
  settings: ModelSettings;
  envelopeColor?: number;
  surfaceColor?: number;
};

export function SimulationViewer({ points, previewPoints = [], settings, envelopeColor = 0x00a676, surfaceColor = 0xb95a1b }: SimulationViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const usesPreviewSurface = previewPoints.length === points.length;
  const geometry = useMemo(
    () => (usesPreviewSurface ? createPreviewSurfaceGeometry(points, previewPoints, settings) : createSimulatedCarvingGeometry(points, settings)),
    [points, previewPoints, settings]
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f1ea);

    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 1000);
    camera.position.set(18, -30, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(22, -38, 36);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffc884, 1.7);
    rim.position.set(-28, 18, 22);
    scene.add(rim);

    const material = new THREE.MeshStandardMaterial({
      color: surfaceColor,
      roughness: 0.62,
      metalness: 0.02,
      side: THREE.DoubleSide,
      vertexColors: true
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = usesPreviewSurface ? 0 : -Math.PI / 2;
    scene.add(mesh);

    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: envelopeColor, transparent: true, opacity: 0.42 })
    );
    wire.rotation.x = mesh.rotation.x;
    scene.add(wire);

    const grid = new THREE.GridHelper(42, 14, 0x8d7b68, 0xd8cfc2);
    grid.position.y = -13;
    scene.add(grid);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      material.dispose();
      mesh.geometry.dispose();
      wire.geometry.dispose();
      const wireMaterial = wire.material;
      if (Array.isArray(wireMaterial)) {
        wireMaterial.forEach((item) => item.dispose());
      } else {
        wireMaterial.dispose();
      }
      host.removeChild(renderer.domElement);
    };
  }, [geometry, envelopeColor, surfaceColor, usesPreviewSurface]);

  return <div className="viewer" ref={hostRef} />;
}

function createPreviewSurfaceGeometry(points: ToolpathPoint[], previewPoints: ToolpathPreviewPoint[], settings: ModelSettings) {
  const rows = buildPreviewRows(points, previewPoints);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const row of rows) {
    for (const point of row.points) {
      positions.push(point.x, point.y, point.z);
      const depthShade = THREE.MathUtils.clamp(point.depth / Math.max(settings.depthMm, 0.001), 0, 1);
      colors.push(0.38 + depthShade * 0.2, 0.54 + depthShade * 0.25, 0.42 + depthShade * 0.12);
    }
  }

  const rowLength = rows[0]?.points.length ?? 0;
  for (let r = 0; r < rows.length - 1; r += 1) {
    for (let c = 0; c < rowLength - 1; c += 1) {
      const a = r * rowLength + c;
      const b = (r + 1) * rowLength + c;
      const c1 = (r + 1) * rowLength + c + 1;
      const d = r * rowLength + c + 1;
      indices.push(a, b, d, b, c1, d);
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

function buildPreviewRows(points: ToolpathPoint[], previewPoints: ToolpathPreviewPoint[]) {
  const rows = new Map<string, Array<ToolpathPreviewPoint & { depth: number; machineX: number }>>();

  for (let i = 0; i < points.length; i += 1) {
    const key = points[i].a.toFixed(3);
    const row = rows.get(key) ?? [];
    row.push({ ...previewPoints[i], depth: points[i].depth, machineX: points[i].x });
    rows.set(key, row);
  }

  return Array.from(rows.entries())
    .map(([a, rowPoints]) => ({
      a: Number(a),
      points: fillMissingPreviewPoints(rowPoints.sort((left, right) => left.machineX - right.machineX))
    }))
    .sort((left, right) => left.a - right.a);
}

function fillMissingPreviewPoints(points: Array<ToolpathPreviewPoint & { depth: number }>) {
  return points.map((point, index) => {
    if (point.hit) return point;

    const left = findHitPreviewNeighbor(points, index, -1);
    const right = findHitPreviewNeighbor(points, index, 1);
    if (left && right) {
      return {
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2,
        z: (left.z + right.z) / 2,
        hit: false,
        depth: 0
      };
    }

    const fallback = left ?? right;
    return fallback ? { ...fallback, hit: false, depth: 0 } : point;
  });
}

function findHitPreviewNeighbor(points: ToolpathPreviewPoint[], start: number, direction: -1 | 1) {
  for (let i = start + direction; i >= 0 && i < points.length; i += direction) {
    if (points[i].hit) return points[i];
  }
  return null;
}


function createSimulatedCarvingGeometry(points: ToolpathPoint[], settings: ModelSettings) {
  const rows = buildRows(points, settings);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const toolRadius = settings.toolDiameter / 2;
  const baseRadius = settings.diameterMm / 2;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let pointIndex = 0; pointIndex < row.points.length; pointIndex += 1) {
      const point = row.points[pointIndex];
      const theta = THREE.MathUtils.degToRad(point.a);
      const cutRadius = Math.max(0.1, simulateRemovedRadius(rows, rowIndex, pointIndex, settings, baseRadius, toolRadius));
      positions.push(point.x, Math.cos(theta) * cutRadius, Math.sin(theta) * cutRadius);

      const depthShade = THREE.MathUtils.clamp((baseRadius - cutRadius) / Math.max(settings.depthMm, 0.001), 0, 1);
      colors.push(0.58 + depthShade * 0.18, 0.28 + depthShade * 0.08, 0.08);
    }
  }

  const rowLength = rows[0]?.points.length ?? 0;
  for (let r = 0; r < rows.length - 1; r += 1) {
    for (let c = 0; c < rowLength - 1; c += 1) {
      const a = r * rowLength + c;
      const b = (r + 1) * rowLength + c;
      const c1 = (r + 1) * rowLength + c + 1;
      const d = r * rowLength + c + 1;
      indices.push(a, b, d, b, c1, d);
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

function simulateRemovedRadius(
  rows: Array<{ a: number; points: ToolpathPoint[] }>,
  rowIndex: number,
  pointIndex: number,
  settings: ModelSettings,
  baseRadius: number,
  toolRadius: number
) {
  const point = rows[rowIndex].points[pointIndex];
  const xStep = estimateXStep(rows[rowIndex].points);
  const aStepDeg = estimateAStep(rows);
  const xWindow = Math.max(1, Math.ceil(toolRadius / Math.max(xStep, 0.001)) + 1);
  const aWindow = Math.max(1, Math.ceil(THREE.MathUtils.radToDeg(toolRadius / Math.max(baseRadius, 0.001)) / Math.max(aStepDeg, 0.001)) + 1);
  let carvedRadius = Math.max(0.1, point.z - toolRadius);

  for (let r = Math.max(0, rowIndex - aWindow); r <= Math.min(rows.length - 1, rowIndex + aWindow); r += 1) {
    const row = rows[r];
    for (let c = Math.max(0, pointIndex - xWindow); c <= Math.min(row.points.length - 1, pointIndex + xWindow); c += 1) {
      const cutter = row.points[c];
      const dx = point.x - cutter.x;
      const da = THREE.MathUtils.degToRad(shortestAngleDelta(point.a, cutter.a)) * baseRadius;
      const distanceSq = dx * dx + da * da;
      if (distanceSq > toolRadius * toolRadius) continue;

      const removed = cutter.z - Math.sqrt(Math.max(0, toolRadius * toolRadius - distanceSq));
      carvedRadius = Math.min(carvedRadius, removed);
    }
  }

  return Math.min(Math.max(0.1, carvedRadius), settings.safeZ);
}

function estimateXStep(points: ToolpathPoint[]) {
  if (points.length < 2) return 0.1;
  return Math.abs(points[1].x - points[0].x) || 0.1;
}

function estimateAStep(rows: Array<{ a: number; points: ToolpathPoint[] }>) {
  if (rows.length < 2) return 1;
  return Math.abs(rows[1].a - rows[0].a) || 1;
}

function shortestAngleDelta(a: number, b: number) {
  let delta = a - b;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function buildRows(points: ToolpathPoint[], settings: ModelSettings) {
  const safeCutoff = settings.safeZ * 0.92;
  const rows = new Map<string, ToolpathPoint[]>();

  for (const point of points) {
    const key = point.a.toFixed(3);
    const row = rows.get(key) ?? [];
    row.push(point.z >= safeCutoff ? { ...point, z: Number.NaN } : point);
    rows.set(key, row);
  }

  return Array.from(rows.entries())
    .map(([a, rowPoints]) => ({
      a: Number(a),
      points: fillMissingZ(rowPoints.sort((left, right) => left.x - right.x), settings)
    }))
    .sort((left, right) => left.a - right.a);
}

function fillMissingZ(points: ToolpathPoint[], settings: ModelSettings) {
  const fallbackZ = settings.diameterMm / 2 + settings.toolDiameter / 2;
  return points.map((point, index) => {
    if (Number.isFinite(point.z)) return point;

    const left = findFiniteNeighbor(points, index, -1);
    const right = findFiniteNeighbor(points, index, 1);
    const z = left && right ? (left.z + right.z) / 2 : left?.z ?? right?.z ?? fallbackZ;
    return { ...point, z, depth: 0 };
  });
}

function findFiniteNeighbor(points: ToolpathPoint[], start: number, direction: -1 | 1) {
  for (let i = start + direction; i >= 0 && i < points.length; i += direction) {
    if (Number.isFinite(points[i].z)) return points[i];
  }
  return null;
}
