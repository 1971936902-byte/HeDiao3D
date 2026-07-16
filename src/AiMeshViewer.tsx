import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { ToolpathPoint, ToolpathPreviewPoint } from "./types";

(THREE.BufferGeometry.prototype as THREE.BufferGeometry & { computeBoundsTree?: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as THREE.BufferGeometry & { disposeBoundsTree?: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

type AiMeshViewerProps = {
  modelUrl: string;
  modelName?: string;
  toolpathPoints?: ToolpathPoint[];
  previewPoints?: ToolpathPreviewPoint[];
  toolpathColor?: number;
  meshLengthAxis?: "auto" | "x" | "y" | "z";
  meshAxisReverse?: boolean;
};

export function AiMeshViewer({
  modelUrl,
  modelName,
  toolpathPoints = [],
  previewPoints = [],
  toolpathColor = 0xd2451e,
  meshLengthAxis = "auto",
  meshAxisReverse = false
}: AiMeshViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const toolpathRef = useRef<THREE.LineSegments | null>(null);
  const mismatchRef = useRef<THREE.LineSegments | null>(null);
  const modelBoundsRef = useRef<THREE.Box3 | null>(null);
  const loadedModelRef = useRef<THREE.Group | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [modelVersion, setModelVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setLoadState("loading");
    setErrorText("");
    modelBoundsRef.current = null;
    loadedModelRef.current = null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f1ea);

    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 2000);
    camera.position.set(2.6, -4.5, 2.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(5, -7, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffcc8f, 1.6);
    rim.position.set(-5, 3, 4);
    scene.add(rim);

    const grid = new THREE.GridHelper(5, 10, 0x8d7b68, 0xd8cfc2);
    grid.position.y = -1.2;
    scene.add(grid);

    const toolpathMaterial = new THREE.LineBasicMaterial({ color: toolpathColor, transparent: true, opacity: 0.95 });
    const toolpathLine = new THREE.LineSegments(new THREE.BufferGeometry(), toolpathMaterial);
    scene.add(toolpathLine);
    toolpathRef.current = toolpathLine;

    const mismatchMaterial = new THREE.LineBasicMaterial({ color: 0xff2f92, transparent: true, opacity: 0.98 });
    const mismatchLine = new THREE.LineSegments(new THREE.BufferGeometry(), mismatchMaterial);
    scene.add(mismatchLine);
    mismatchRef.current = mismatchLine;

    let loaded: THREE.Group | null = null;
    let disposed = false;

    loadModelObject(modelUrl, modelName)
      .then((object) => {
        if (disposed) return;
        loaded = normalizeModel(object);
        prepareModelForFastRaycast(loaded);
        scene.add(loaded);
        loaded.updateMatrixWorld(true);
        loadedModelRef.current = loaded;
        modelBoundsRef.current = new THREE.Box3().setFromObject(loaded);
        setLoadState("ready");
        setModelVersion((version) => version + 1);
      })
      .catch((error) => {
        console.error("3D模型加载失败", error);
        if (!disposed) {
          setLoadState("error");
          setErrorText(error instanceof Error ? error.message : "模型文件无法读取，请确认是 STL/OBJ/GLB/GLTF。");
        }
      });

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
      disposed = true;
      modelBoundsRef.current = null;
      loadedModelRef.current = null;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      if (loaded) disposeObject(loaded);
      toolpathMaterial.dispose();
      toolpathLine.geometry.dispose();
      mismatchMaterial.dispose();
      mismatchLine.geometry.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [modelUrl, modelName, toolpathColor]);

  useEffect(() => {
    if (!toolpathRef.current) return;

    toolpathRef.current.geometry.dispose();
    if (mismatchRef.current) {
      mismatchRef.current.geometry.dispose();
    }

    const geometries =
      toolpathPoints.length > 0 && loadedModelRef.current
        ? createDisplayedMeshProjectionGeometries(toolpathPoints, loadedModelRef.current, meshLengthAxis, meshAxisReverse)
        : previewPoints.length > 0
          ? createSurfacePreviewGeometries(previewPoints)
          : { fit: createAlignedToolpathGeometry(toolpathPoints, modelBoundsRef.current, meshLengthAxis, meshAxisReverse), mismatch: createEmptyGeometry() };

    toolpathRef.current.geometry = geometries.fit;
    if (mismatchRef.current) {
      mismatchRef.current.geometry = geometries.mismatch;
      mismatchRef.current.visible = toolpathPoints.length > 0 || previewPoints.length > 0;
    }
    toolpathRef.current.visible = previewPoints.length > 0 || toolpathPoints.length > 0;
  }, [toolpathPoints, previewPoints, modelVersion, meshLengthAxis, meshAxisReverse]);

  return (
    <div className="viewer ai-viewer" ref={hostRef}>
      {loadState !== "ready" && (
        <div className={`viewer-overlay ${loadState === "error" ? "error" : ""}`}>
          <strong>{loadState === "error" ? "3D 模型加载失败" : "正在加载 3D Mesh"}</strong>
          <span>{loadState === "error" ? errorText : "STL/OBJ/GLB 文件较大时可能需要等待几秒"}</span>
        </div>
      )}
    </div>
  );
}

function loadModelObject(modelUrl: string, modelName?: string): Promise<THREE.Object3D> {
  const extension = getModelExtension(modelName ?? modelUrl);

  if (extension === "stl") {
    const loader = new STLLoader();
    return new Promise((resolve, reject) => {
      loader.load(
        modelUrl,
        (geometry) => {
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            color: 0xd4b783,
            roughness: 0.58,
            metalness: 0.02,
            side: THREE.DoubleSide
          });
          resolve(new THREE.Mesh(geometry, material));
        },
        undefined,
        reject
      );
    });
  }

  if (extension === "obj") {
    const loader = new OBJLoader();
    return new Promise((resolve, reject) => {
      loader.load(
        modelUrl,
        (object) => {
          object.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry?.computeVertexNormals();
            if (!mesh.material) {
              mesh.material = new THREE.MeshStandardMaterial({
                color: 0xd4b783,
                roughness: 0.58,
                metalness: 0.02,
                side: THREE.DoubleSide
              });
            }
          });
          resolve(object);
        },
        undefined,
        reject
      );
    });
  }

  if (extension === "glb" || extension === "gltf") {
    const loader = new GLTFLoader();
    loader.setCrossOrigin("anonymous");
    return new Promise((resolve, reject) => {
      loader.load(modelUrl, (gltf) => resolve(gltf.scene), undefined, reject);
    });
  }

  return Promise.reject(new Error("不支持的模型格式，请导入 .stl/.obj/.glb/.gltf 文件。"));
}

function getModelExtension(nameOrUrl: string) {
  const clean = nameOrUrl.split("?")[0].split("#")[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function createDisplayedMeshProjectionGeometries(
  points: ToolpathPoint[],
  model: THREE.Group,
  meshLengthAxis: "auto" | Axis,
  meshAxisReverse: boolean
) {
  const fitGeometry = new THREE.BufferGeometry();
  const mismatchGeometry = new THREE.BufferGeometry();
  const previewPoints = removeSafeZMoves(points);
  if (previewPoints.length === 0) {
    return { fit: createEmptyGeometry(), mismatch: createAlignedToolpathGeometry(points, new THREE.Box3().setFromObject(model)) };
  }

  model.updateMatrixWorld(true);
  const meshes: THREE.Object3D[] = [];
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
  });

  if (meshes.length === 0) {
    return { fit: createEmptyGeometry(), mismatch: createEmptyGeometry() };
  }

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const lengthAxis = selectLengthAxis(size, meshLengthAxis);
  const radialAxes = (["x", "y", "z"] as Axis[]).filter((axis) => axis !== lengthAxis) as [Axis, Axis];
  const xMin = previewPoints.reduce((min, point) => Math.min(min, point.x), Number.POSITIVE_INFINITY);
  const xMax = previewPoints.reduce((max, point) => Math.max(max, point.x), Number.NEGATIVE_INFINITY);
  const xSpan = Math.max(xMax - xMin, 0.001);
  const outerRadius = Math.max(axisValue(size, radialAxes[0]), axisValue(size, radialAxes[1])) * 0.9 + 0.4;
  const stride = Math.max(1, Math.ceil(previewPoints.length / 4200));
  const raycaster = new THREE.Raycaster();
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const fallbackMapper = createPreviewMapper(
    box,
    xMin,
    xMax,
    (xMin + xMax) / 2,
    previewPoints.reduce((max, point) => Math.max(max, Math.abs(point.z)), 0.001),
    meshLengthAxis,
    meshAxisReverse
  );
  const fitPositions: number[] = [];
  const mismatchPositions: number[] = [];
  let previous: THREE.Vector3 | null = null;

  for (let i = 0; i < previewPoints.length; i += stride) {
    const point = previewPoints[i];
    const rawT = (point.x - xMin) / xSpan;
    const t = meshAxisReverse ? 1 - rawT : rawT;
    const theta = THREE.MathUtils.degToRad(point.a);
    const centerline = center.clone();
    setAxisValue(centerline, lengthAxis, axisValue(box.min, lengthAxis) + t * axisValue(size, lengthAxis));

    const origin = centerline.clone();
    setAxisValue(origin, radialAxes[0], axisValue(centerline, radialAxes[0]) + Math.cos(theta) * outerRadius);
    setAxisValue(origin, radialAxes[1], axisValue(centerline, radialAxes[1]) + Math.sin(theta) * outerRadius);

    raycaster.set(origin, centerline.clone().sub(origin).normalize());
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) {
      addMismatchMarker(mismatchPositions, fallbackMapper(point), size);
      previous = null;
      continue;
    }

    const current = offsetVisibleHit(hit);
    if (previous) {
      fitPositions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    }
    previous = current;
  }

  fitGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fitPositions, 3));
  fitGeometry.computeBoundingSphere();
  mismatchGeometry.setAttribute("position", new THREE.Float32BufferAttribute(mismatchPositions, 3));
  mismatchGeometry.computeBoundingSphere();
  return { fit: fitGeometry, mismatch: mismatchGeometry };
}

function offsetVisibleHit(hit: THREE.Intersection) {
  const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  normal.transformDirection(hit.object.matrixWorld);
  return hit.point.clone().addScaledVector(normal, 0.018);
}

function createSurfacePreviewGeometries(points: ToolpathPreviewPoint[]) {
  const fitGeometry = new THREE.BufferGeometry();
  const mismatchGeometry = new THREE.BufferGeometry();
  const stride = Math.max(1, Math.ceil(points.length / 18000));
  const fitPositions: number[] = [];
  const mismatchPositions: number[] = [];
  let previous: THREE.Vector3 | null = null;

  for (let i = 0; i < points.length; i += stride) {
    const point = points[i];
    if (!point.hit) {
      addMismatchMarker(mismatchPositions, new THREE.Vector3(point.x, point.y, point.z), new THREE.Vector3(3.2, 3.2, 3.2));
      previous = null;
      continue;
    }

    const current = new THREE.Vector3(point.x, point.y, point.z);
    if (previous) {
      fitPositions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    }
    previous = current;
  }

  fitGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fitPositions, 3));
  fitGeometry.computeBoundingSphere();
  mismatchGeometry.setAttribute("position", new THREE.Float32BufferAttribute(mismatchPositions, 3));
  mismatchGeometry.computeBoundingSphere();
  return { fit: fitGeometry, mismatch: mismatchGeometry };
}

function createEmptyGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  return geometry;
}

function addMismatchMarker(positions: number[], center: THREE.Vector3, size: THREE.Vector3) {
  const markerSize = Math.max(size.x, size.y, size.z) * 0.012;
  positions.push(center.x - markerSize, center.y, center.z, center.x + markerSize, center.y, center.z);
  positions.push(center.x, center.y - markerSize, center.z, center.x, center.y + markerSize, center.z);
  positions.push(center.x, center.y, center.z - markerSize, center.x, center.y, center.z + markerSize);
}

function createAlignedToolpathGeometry(
  points: ToolpathPoint[],
  modelBounds: THREE.Box3 | null,
  meshLengthAxis: "auto" | Axis,
  meshAxisReverse: boolean
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const previewPoints = removeSafeZMoves(points);
  if (previewPoints.length === 0) {
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    return geometry;
  }

  const stride = Math.max(1, Math.ceil(previewPoints.length / 12000));
  const xMin = previewPoints.reduce((min, point) => Math.min(min, point.x), Number.POSITIVE_INFINITY);
  const xMax = previewPoints.reduce((max, point) => Math.max(max, point.x), Number.NEGATIVE_INFINITY);
  const maxRadius = previewPoints.reduce((max, point) => Math.max(max, Math.abs(point.z)), 0.001);
  const xCenter = (xMin + xMax) / 2;
  const positions: number[] = [];
  const mapper = createPreviewMapper(modelBounds, xMin, xMax, xCenter, maxRadius, meshLengthAxis, meshAxisReverse);

  let previous: THREE.Vector3 | null = null;
  for (let i = 0; i < previewPoints.length; i += stride) {
    const current = mapper(previewPoints[i]);
    if (previous) {
      positions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    }
    previous = current;
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function removeSafeZMoves(points: ToolpathPoint[]) {
  if (points.length === 0) return points;
  const sortedZ = points.map((point) => Math.abs(point.z)).sort((a, b) => a - b);
  const q75 = sortedZ[Math.floor(sortedZ.length * 0.75)] ?? sortedZ[sortedZ.length - 1] ?? 0;
  const cutoff = Math.max(q75 * 1.8, q75 + 0.8);
  return points.filter((point) => Math.abs(point.z) <= cutoff);
}

function createPreviewMapper(
  modelBounds: THREE.Box3 | null,
  xMin: number,
  xMax: number,
  xCenter: number,
  maxRadius: number,
  meshLengthAxis: "auto" | Axis,
  meshAxisReverse: boolean
) {
  if (!modelBounds || modelBounds.isEmpty()) {
    const scale = 3.6 / Math.max(xMax - xMin, maxRadius * 2, 0.001);
    return (point: ToolpathPoint) => {
      const theta = THREE.MathUtils.degToRad(point.a);
      return new THREE.Vector3((point.x - xCenter) * scale, Math.cos(theta) * point.z * scale, Math.sin(theta) * point.z * scale);
    };
  }

  const size = modelBounds.getSize(new THREE.Vector3());
  const center = modelBounds.getCenter(new THREE.Vector3());
  const lengthAxis = selectLengthAxis(size, meshLengthAxis);
  const radialAxes = (["x", "y", "z"] as Axis[]).filter((axis) => axis !== lengthAxis) as [Axis, Axis];
  const lengthMin = axisValue(modelBounds.min, lengthAxis);
  const lengthSize = axisValue(size, lengthAxis);
  const radialMax = Math.max(axisValue(size, radialAxes[0]), axisValue(size, radialAxes[1])) * 0.54;
  const xSpan = Math.max(xMax - xMin, 0.001);

  return (point: ToolpathPoint) => {
    const rawT = (point.x - xMin) / xSpan;
    const t = meshAxisReverse ? 1 - rawT : rawT;
    const theta = THREE.MathUtils.degToRad(point.a);
    const radius = (point.z / Math.max(maxRadius, 0.001)) * radialMax;
    const current = center.clone();
    setAxisValue(current, lengthAxis, lengthMin + t * lengthSize);
    setAxisValue(current, radialAxes[0], axisValue(center, radialAxes[0]) + Math.cos(theta) * radius);
    setAxisValue(current, radialAxes[1], axisValue(center, radialAxes[1]) + Math.sin(theta) * radius);
    return current;
  };
}

type Axis = "x" | "y" | "z";

function largestAxis(size: THREE.Vector3): Axis {
  if (size.y >= size.x && size.y >= size.z) return "y";
  if (size.z >= size.x && size.z >= size.y) return "z";
  return "x";
}

function selectLengthAxis(size: THREE.Vector3, requestedAxis: "auto" | Axis): Axis {
  return requestedAxis === "auto" ? largestAxis(size) : requestedAxis;
}

function axisValue(vector: THREE.Vector3, axis: Axis) {
  return vector[axis];
}

function setAxisValue(vector: THREE.Vector3, axis: Axis, value: number) {
  vector[axis] = value;
}

function normalizeModel(model: THREE.Object3D) {
  const wrapper = new THREE.Group();
  wrapper.add(model);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 3.2 / maxAxis;

  model.position.set(-center.x, -center.y, -center.z);
  wrapper.scale.setScalar(scale);
  wrapper.rotation.x = -Math.PI / 2;

  return wrapper;
}

function prepareModelForFastRaycast(model: THREE.Object3D) {
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry & { computeBoundsTree?: () => void };
    if (mesh.isMesh && geometry && !geometry.boundsTree) {
      geometry.computeBoundsTree?.();
    }
  });
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void };
    geometry?.disposeBoundsTree?.();
    geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else {
      material?.dispose();
    }
  });
}
