import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

export function exportGeometryAsStl(geometry: THREE.BufferGeometry, filename: string) {
  const stl = geometryToStlString(geometry);
  downloadBlob(filename, stl, "model/stl");
}

export function geometryToStlString(geometry: THREE.BufferGeometry) {
  const mesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial());
  const exporter = new STLExporter();
  const stl = exporter.parse(mesh, { binary: false }) as string;
  mesh.geometry.dispose();
  return stl;
}

function downloadBlob(filename: string, content: BlobPart, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
