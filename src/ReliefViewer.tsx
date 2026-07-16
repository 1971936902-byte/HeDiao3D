import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelSettings, ToolpathPoint } from "./types";

type ReliefViewerProps = {
  geometry: THREE.BufferGeometry;
  wireframe: boolean;
  toolpathPoints?: ToolpathPoint[];
  settings: ModelSettings;
};

export function ReliefViewer({ geometry, wireframe, toolpathPoints = [], settings }: ReliefViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const wireRef = useRef<THREE.LineSegments | null>(null);
  const toolpathRef = useRef<THREE.Line | null>(null);
  const holdZonesRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f1ea);

    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 1000);
    camera.position.set(18, -30, 18);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.92);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(24, -44, 42);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xffc884, 1.9);
    rim.position.set(-34, 18, 14);
    scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffe0b0, 0.48);
    fill.position.set(-16, 28, 18);
    scene.add(fill);

    const material = new THREE.MeshStandardMaterial({
      roughness: 0.64,
      metalness: 0.02,
      vertexColors: true,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    meshRef.current = mesh;

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x3f3328, transparent: true, opacity: 0.22 });
    const line = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), lineMaterial);
    line.rotation.x = mesh.rotation.x;
    line.visible = wireframe;
    scene.add(line);
    wireRef.current = line;

    const toolpathMaterial = new THREE.LineBasicMaterial({ color: 0xd2451e, transparent: true, opacity: 0.92 });
    const toolpathLine = new THREE.Line(new THREE.BufferGeometry(), toolpathMaterial);
    toolpathLine.rotation.x = mesh.rotation.x;
    scene.add(toolpathLine);
    toolpathRef.current = toolpathLine;

    const holdZones = new THREE.Group();
    holdZones.rotation.x = mesh.rotation.x;
    scene.add(holdZones);
    holdZonesRef.current = holdZones;

    const grid = new THREE.GridHelper(42, 14, 0x8d7b68, 0xd8cfc2);
    grid.position.y = -13;
    scene.add(grid);

    const axes = new THREE.AxesHelper(14);
    axes.position.set(-18, -13, -10);
    scene.add(axes);

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
      lineMaterial.dispose();
      toolpathMaterial.dispose();
      toolpathLine.geometry.dispose();
      disposeHoldZones(holdZones);
      host.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.geometry.dispose();
      meshRef.current.geometry = geometry;
    }

    if (wireRef.current) {
      wireRef.current.geometry.dispose();
      wireRef.current.geometry = new THREE.WireframeGeometry(geometry);
    }
  }, [geometry]);

  useEffect(() => {
    if (wireRef.current) {
      wireRef.current.visible = wireframe;
    }
  }, [wireframe]);

  useEffect(() => {
    if (!toolpathRef.current) return;

    toolpathRef.current.geometry.dispose();
    toolpathRef.current.geometry = createToolpathGeometry(toolpathPoints);
    toolpathRef.current.visible = toolpathPoints.length > 0;
  }, [toolpathPoints]);

  useEffect(() => {
    if (!holdZonesRef.current) return;
    updateHoldZones(holdZonesRef.current, settings);
  }, [settings]);

  return <div className="viewer" ref={hostRef} />;
}

function createToolpathGeometry(points: ToolpathPoint[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  if (points.length === 0) {
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    return geometry;
  }

  const stride = Math.max(1, Math.ceil(points.length / 12000));
  const positions: number[] = [];

  for (let i = 0; i < points.length; i += stride) {
    const point = points[i];
    if (point.y != null) {
      positions.push(point.x, point.y, point.z);
      continue;
    }
    const theta = THREE.MathUtils.degToRad(point.a);
    const radius = point.z + 0.12;
    positions.push(point.x, Math.cos(theta) * radius, Math.sin(theta) * radius);
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function updateHoldZones(group: THREE.Group, settings: ModelSettings) {
  disposeHoldZones(group);
  group.clear();

  const radius = settings.diameterMm / 2 + settings.depthMm + 0.36;
  const halfLength = settings.lengthMm / 2;
  const leftHold = Math.max(0, settings.leftHoldMm);
  const rightHold = Math.max(0, settings.rightHoldMm);
  const transition = Math.max(0, settings.endTransitionMm);

  if (leftHold > 0) {
    group.add(createZoneCylinder(-halfLength + leftHold / 2, leftHold, radius, 0xff6b9c, 0.28));
  }

  if (rightHold > 0) {
    group.add(createZoneCylinder(halfLength - rightHold / 2, rightHold, radius, 0xff6b9c, 0.28));
  }

  if (transition > 0) {
    group.add(createZoneCylinder(-halfLength + leftHold + transition / 2, transition, radius * 1.01, 0xeab558, 0.18));
    group.add(createZoneCylinder(halfLength - rightHold - transition / 2, transition, radius * 1.01, 0xeab558, 0.18));
  }
}

function createZoneCylinder(x: number, length: number, radius: number, color: number, opacity: number) {
  const geometry = new THREE.CylinderGeometry(radius, radius, Math.max(0.02, length), 48, 1, true);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.x = x;
  return mesh;
}

function disposeHoldZones(group: THREE.Group) {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else {
        material.dispose();
      }
    }
  }
}
