import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

loadEnv();

const port = Number(process.env.API_PORT ?? 8787);
const meshyBase = process.env.MESHY_API_BASE ?? "https://api.meshy.ai";

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/meshy/multi-image-to-3d") {
      return createMultiImageTask(req, res);
    }

    if (req.method === "POST" && req.url === "/api/meshy/repair-printability") {
      return createRepairPrintabilityTask(req, res);
    }

    if (req.method === "POST" && req.url === "/api/meshy/remesh") {
      return createRemeshTask(req, res);
    }

    if (req.method === "POST" && req.url === "/api/cam/mesh-toolpath") {
      return createMeshToolpath(req, res);
    }

    if (req.method === "POST" && req.url === "/api/mesh/analyze") {
      return analyzeMesh(req, res);
    }

    const taskMatch = req.url?.match(/^\/api\/meshy\/multi-image-to-3d\/([^/?#]+)$/);
    if (req.method === "GET" && taskMatch) {
      return getMultiImageTask(taskMatch[1], res);
    }

    const repairMatch = req.url?.match(/^\/api\/meshy\/repair-printability\/([^/?#]+)$/);
    if (req.method === "GET" && repairMatch) {
      return getRepairPrintabilityTask(repairMatch[1], res);
    }

    const remeshMatch = req.url?.match(/^\/api\/meshy\/remesh\/([^/?#]+)$/);
    if (req.method === "GET" && remeshMatch) {
      return getRemeshTask(remeshMatch[1], res);
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "Unknown server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Meshy API proxy listening on http://127.0.0.1:${port}`);
});

async function createMultiImageTask(req, res) {
  const apiKey = requireApiKey();
  const input = await readJson(req);
  const imageUrls = Array.isArray(input.image_urls) ? input.image_urls.slice(0, 4) : [];

  if (imageUrls.length === 0) {
    return json(res, 400, { error: "image_urls is required" });
  }

  const response = await fetch(`${meshyBase}/openapi/v1/multi-image-to-3d`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      image_urls: imageUrls,
      should_texture: true,
      enable_pbr: false,
      target_formats: input.target_formats ?? ["glb", "stl"]
    })
  });

  return proxyJson(response, res);
}

async function getMultiImageTask(taskId, res) {
  const apiKey = requireApiKey();
  const response = await fetch(`${meshyBase}/openapi/v1/multi-image-to-3d/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "application/json";

  if (!response.ok || !contentType.includes("application/json")) {
    res.writeHead(response.status, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*"
    });
    res.end(text);
    return;
  }

  const data = JSON.parse(text);
  const status = data.status ?? data.state;
  if (status === "SUCCEEDED" || status === "succeeded" || status === "COMPLETED") {
    data.local_model_urls = await cacheMeshyAssets(taskId, data);
  }

  return json(res, response.status, data);
}

async function createRepairPrintabilityTask(req, res) {
  const apiKey = requireApiKey();
  const input = await readJson(req);
  const modelUrl = await localModelUrlToDataUri(String(input.stlUrl ?? input.modelUrl ?? ""));

  const response = await fetch(`${meshyBase}/openapi/v1/print/repair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model_url: modelUrl })
  });

  return proxyJson(response, res);
}

async function getRepairPrintabilityTask(taskId, res) {
  const apiKey = requireApiKey();
  const response = await fetch(`${meshyBase}/openapi/v1/print/repair/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  return proxyMeshyTaskWithCache(response, res, `repair-${taskId}`);
}

async function createRemeshTask(req, res) {
  const apiKey = requireApiKey();
  const input = await readJson(req);
  const modelUrl = await localModelUrlToDataUri(String(input.modelUrl ?? input.stlUrl ?? ""));

  const response = await fetch(`${meshyBase}/openapi/v1/remesh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model_url: modelUrl,
      target_formats: ["glb", "stl"],
      topology: input.topology ?? "triangle",
      target_polycount: input.target_polycount ?? 80000
    })
  });

  return proxyJson(response, res);
}

async function getRemeshTask(taskId, res) {
  const apiKey = requireApiKey();
  const response = await fetch(`${meshyBase}/openapi/v1/remesh/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  return proxyMeshyTaskWithCache(response, res, `remesh-${taskId}`);
}

async function proxyMeshyTaskWithCache(response, res, cacheKey) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "application/json";

  if (!response.ok || !contentType.includes("application/json")) {
    res.writeHead(response.status, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*"
    });
    res.end(text);
    return;
  }

  const data = JSON.parse(text);
  const status = data.status ?? data.state;
  if (status === "SUCCEEDED" || status === "succeeded" || status === "COMPLETED") {
    data.local_model_urls = await cacheMeshyAssets(cacheKey, data);
  }

  return json(res, response.status, data);
}

async function createMeshToolpath(req, res) {
  const input = await readJson(req);
  const settings = input.settings;
  const stlUrl = String(input.stlUrl ?? "");

  if (!settings || !stlUrl.startsWith("/meshy-results/") || stlUrl.includes("..")) {
    return json(res, 400, { error: "本地 Meshy STL 地址或刀路参数无效" });
  }

  const stlPath = join(process.cwd(), "public", stlUrl.replace(/^\//, ""));
  if (!existsSync(stlPath)) {
    return json(res, 404, { error: "找不到本地 Meshy STL 文件，请重新生成或载入测试结果" });
  }

  const file = readFileSync(stlPath);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  geometry.computeBoundsTree();

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const toolpath = generateMeshSurfaceToolpath(mesh, settings);
  geometry.disposeBoundsTree();
  geometry.dispose();

  return json(res, 200, toolpath);
}

async function analyzeMesh(req, res) {
  const input = await readJson(req);
  const stlUrl = String(input.stlUrl ?? "");

  if (!stlUrl.startsWith("/meshy-results/") || stlUrl.includes("..")) {
    return json(res, 400, { error: "本地 Meshy STL 地址无效" });
  }

  const stlPath = join(process.cwd(), "public", stlUrl.replace(/^\//, ""));
  if (!existsSync(stlPath)) {
    return json(res, 404, { error: "找不到本地 Meshy STL 文件，请重新生成或载入测试结果" });
  }

  const file = readFileSync(stlPath);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const report = buildMeshQualityReport(geometry);
  geometry.dispose();
  return json(res, 200, report);
}

async function proxyJson(response, res) {
  const text = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

function requireApiKey() {
  if (!process.env.MESHY_API_KEY) {
    throw new Error("MESHY_API_KEY is not configured");
  }
  return process.env.MESHY_API_KEY;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

async function localModelUrlToDataUri(publicUrl) {
  if (!publicUrl.startsWith("/meshy-results/") || publicUrl.includes("..")) {
    throw new Error("只支持修复本地缓存的 Meshy 模型文件");
  }

  const filePath = join(process.cwd(), "public", publicUrl.replace(/^\//, ""));
  if (!existsSync(filePath)) {
    throw new Error("找不到本地 Meshy 模型文件，请重新生成或载入测试结果");
  }

  const file = readFileSync(filePath);
  return `data:application/octet-stream;base64,${file.toString("base64")}`;
}

async function cacheMeshyAssets(taskId, task) {
  const urls = task.model_urls ?? task.output?.model_urls ?? {};
  const result = {};
  const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, "");

  await mkdir(join(process.cwd(), "public", "meshy-results"), { recursive: true });

  for (const format of ["glb", "stl"]) {
    const remoteUrl = format === "glb" ? (urls.glb ?? task.model_url) : urls.stl;
    if (!remoteUrl) continue;

    const filename = `${safeTaskId}.${format}`;
    const filePath = join(process.cwd(), "public", "meshy-results", filename);
    const publicUrl = `/meshy-results/${filename}`;

    if (!existsSync(filePath)) {
      const response = await fetch(remoteUrl);
      if (!response.ok) {
        result[`${format}_warning`] = `Meshy ${format.toUpperCase()} 文件缓存失败：${response.status}`;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(filePath, bytes);
    }

    result[format] = publicUrl;
  }

  return result;
}

function generateMeshSurfaceToolpath(mesh, settings) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const lengthAxis = selectLengthAxis(size, settings.meshLengthAxis);
  const radialAxes = ["x", "y", "z"].filter((axis) => axis !== lengthAxis);
  const halfLength = Number(settings.lengthMm) / 2;
  const leftHold = Number(settings.leftHoldMm ?? 0);
  const rightHold = Number(settings.rightHoldMm ?? 0);
  const xStart = -halfLength + leftHold;
  const xEnd = halfLength - rightHold;
  const carveLength = Math.max(Number(settings.stepoverMm), xEnd - xStart);
  const machineRadius = Number(settings.diameterMm) / 2;
  const toolRadius = Number(settings.toolDiameter) / 2;
  const aMin = Number(settings.reliefAngleDeg) >= 360 ? -180 : -Number(settings.reliefAngleDeg) / 2;
  const aMax = Number(settings.reliefAngleDeg) >= 360 ? 180 : Number(settings.reliefAngleDeg) / 2;
  const passes = Math.max(2, Math.ceil(Number(settings.reliefAngleDeg) / Number(settings.stepoverDeg)));
  const xSteps = Math.max(2, Math.ceil(carveLength / Number(settings.stepoverMm)));
  const radialMax = Math.max(axisValue(size, radialAxes[0]), axisValue(size, radialAxes[1])) / 2 || 1;
  const outerRadius = radialMax * 2.2 + 1;
  const displayScale = 3.2 / Math.max(size.x, size.y, size.z, 0.001);
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  const points = [];
  const previewPoints = [];
  const warnings = [];
  let missCount = 0;

  for (let pass = 0; pass <= passes; pass += 1) {
    const serpentine = pass % 2 === 1;
    const a = aMin + (pass / passes) * (aMax - aMin);
    const theta = THREE.MathUtils.degToRad(a);

    for (let step = 0; step <= xSteps; step += 1) {
      const index = serpentine ? xSteps - step : step;
      const carveU = index / xSteps;
      const x = xStart + carveU * carveLength;
      const rawU = (x + halfLength) / Number(settings.lengthMm);
      const u = settings.meshAxisReverse ? 1 - rawU : rawU;
      const centerline = center.clone();
      setAxisValue(centerline, lengthAxis, axisValue(box.min, lengthAxis) + u * axisValue(size, lengthAxis));

      const origin = centerline.clone();
      setAxisValue(origin, radialAxes[0], axisValue(centerline, radialAxes[0]) + Math.cos(theta) * outerRadius);
      setAxisValue(origin, radialAxes[1], axisValue(centerline, radialAxes[1]) + Math.sin(theta) * outerRadius);

      const direction = centerline.clone().sub(origin).normalize();
      raycaster.set(origin, direction);
      const hit = raycaster.intersectObject(mesh, false)[0];

      let z = Number(settings.safeZ);
      let depth = 0;
      if (hit) {
        const radialDistance = radialDistanceFromCenter(hit.point, centerline, radialAxes);
        const normalizedRadius = THREE.MathUtils.clamp(radialDistance / radialMax, 0, 1.35);
        z = normalizedRadius * machineRadius + toolRadius;
        depth = Math.max(0, machineRadius - (z - toolRadius));
        previewPoints.push(toDisplayPreviewPoint(hit, center, displayScale));
      } else {
        missCount += 1;
        previewPoints.push(toDisplayMissPoint(origin, center, displayScale));
      }

      points.push({ x, a, z, depth });
    }
  }

  if (missCount > 0) {
    warnings.push(`Mesh表面采样有 ${missCount} 个点未命中，已抬到安全Z；请检查模型朝向和包覆角度。`);
  }

  if (Number(settings.safeZ) <= maxCuttingZ(points, Number(settings.safeZ))) {
    warnings.push("安全高度低于或接近最高刀位，请提高安全高度。");
  }

  if (Number(settings.stepoverMm) > Number(settings.toolDiameter) * 0.6) {
    warnings.push("X步距偏大，可能留下明显刀痕。");
  }

  if (leftHold > 0 || rightHold > 0) {
    warnings.push(`已避开端部夹持区：左 ${fmt(leftHold, 1)}mm / 右 ${fmt(rightHold, 1)}mm。`);
  }

  warnings.push("Mesh CAM 已按模型外表面采样生成；首次实机请务必空跑并使用低进给试雕。");

  const travelMm = estimateTravel(points, machineRadius);
  const estimatedMinutes = travelMm / Math.max(1, Number(settings.feedRate));
  const gcode = toGcode(points, settings, estimatedMinutes, "Meshy STL surface CAM");

  return {
    points,
    previewPoints: previewPoints.length <= 120000 ? previewPoints : [],
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: postProcessorName(settings.postProcessor),
    summary: summarizePoints(points, warnings)
  };
}

function buildMeshQualityReport(geometry) {
  const position = geometry.getAttribute("position");
  const triangleCount = Math.floor(position.count / 3);
  const vertexCount = position.count;
  const box = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(position);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const axis = largestAxis(size);
  const edgeStats = analyzeMeshEdges(position, box, axis);
  const degenerateFaces = countDegenerateFaces(position);
  const largest = Math.max(size.x, size.y, size.z, 0.0001);
  const smallest = Math.min(size.x || largest, size.y || largest, size.z || largest);
  const boundaryRate = edgeStats.boundaryEdges / Math.max(1, edgeStats.totalEdges);
  const nonManifoldRate = edgeStats.nonManifoldEdges / Math.max(1, edgeStats.totalEdges);
  const degenerateRate = degenerateFaces / Math.max(1, triangleCount);
  const recommendations = [];
  const checks = [];

  checks.push(createMeshCheck("面数", triangleCount >= 1500, triangleCount >= 400, `${triangleCount} triangles`));
  checks.push(createMeshCheck("封闭性", boundaryRate < 0.003, boundaryRate < 0.02, `${edgeStats.boundaryEdges} boundary edges`));
  checks.push(createMeshCheck("非流形边", nonManifoldRate === 0, nonManifoldRate < 0.003, `${edgeStats.nonManifoldEdges} non-manifold edges`));
  checks.push(createMeshCheck("退化面", degenerateRate < 0.001, degenerateRate < 0.01, `${degenerateFaces} degenerate faces`));
  checks.push(createMeshCheck("长轴识别", largest / Math.max(0.001, smallest) < 8, largest / Math.max(0.001, smallest) < 12, `long axis ${axis.toUpperCase()}`));

  if (edgeStats.boundaryEdges > 0) recommendations.push("存在边界开口，建议先执行 Mesh 修复，再生成刀路。");
  if (edgeStats.nonManifoldEdges > 0) recommendations.push("存在非流形边，建议执行重建可雕刻网格。");
  const riskyRegions = edgeStats.regions.filter((region) => region.status !== "ok");
  if (riskyRegions.length > 0) recommendations.push(`Mesh 风险集中区域：${riskyRegions.map((region) => region.label).join("、")}，建议优先检查这些位置的孔洞和断面。`);
  if (degenerateFaces > triangleCount * 0.01) recommendations.push("退化面偏多，建议重网格后再进入 CAM。");
  if (triangleCount < 1500) recommendations.push("面数偏少，细节可能不足，建议重新生成或提高重网格目标面数。");
  if (largest / Math.max(0.001, smallest) >= 8) recommendations.push("模型比例差异较大，请检查姿态是否已对齐核胚长轴。");
  if (recommendations.length === 0) recommendations.push("Mesh 基础体检正常，可进入刀路生成和包络检查。");

  const critical = checks.filter((check) => check.status === "critical").length;
  const warning = checks.filter((check) => check.status === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - critical * 24 - warning * 8 - boundaryRate * 600 - nonManifoldRate * 1000 - degenerateRate * 500));

  return {
    score,
    verdict: critical > 0 ? "repair" : warning > 0 ? "review" : "ready",
    triangleCount,
    vertexCount,
    edgeCount: edgeStats.totalEdges,
    boundaryEdges: edgeStats.boundaryEdges,
    nonManifoldEdges: edgeStats.nonManifoldEdges,
    degenerateFaces,
    dimensions: {
      x: size.x,
      y: size.y,
      z: size.z
    },
    center: {
      x: center.x,
      y: center.y,
      z: center.z
    },
    detectedLongAxis: axis,
    checks,
    regions: edgeStats.regions,
    recommendations
  };
}

function createMeshCheck(label, ok, warning, value) {
  return {
    label,
    value,
    status: ok ? "ok" : warning ? "warning" : "critical"
  };
}

function analyzeMeshEdges(position, box, longAxis) {
  const edges = new Map();
  const vertices = new Map();

  for (let i = 0; i < position.count; i += 3) {
    const a = vertexKey(position, i);
    const b = vertexKey(position, i + 1);
    const c = vertexKey(position, i + 2);
    rememberVertex(vertices, a, position, i);
    rememberVertex(vertices, b, position, i + 1);
    rememberVertex(vertices, c, position, i + 2);
    addEdge(edges, a, b);
    addEdge(edges, b, c);
    addEdge(edges, c, a);
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  const regionBuckets = createMeshRegionBuckets();
  for (const [key, count] of edges.entries()) {
    if (count === 1) {
      boundaryEdges += 1;
      addMeshEdgeToRegions(regionBuckets, key, vertices, box, longAxis, "boundaryEdges");
    }
    if (count > 2) {
      nonManifoldEdges += 1;
      addMeshEdgeToRegions(regionBuckets, key, vertices, box, longAxis, "nonManifoldEdges");
    }
  }

  return {
    totalEdges: edges.size,
    boundaryEdges,
    nonManifoldEdges,
    regions: finalizeMeshRegions(regionBuckets)
  };
}

function rememberVertex(vertices, key, position, index) {
  if (vertices.has(key)) return;
  vertices.set(key, {
    x: position.getX(index),
    y: position.getY(index),
    z: position.getZ(index)
  });
}

function createMeshRegionBuckets() {
  return [
    { label: "左端", boundaryEdges: 0, nonManifoldEdges: 0 },
    { label: "主体", boundaryEdges: 0, nonManifoldEdges: 0 },
    { label: "右端", boundaryEdges: 0, nonManifoldEdges: 0 },
    { label: "顶部", boundaryEdges: 0, nonManifoldEdges: 0 },
    { label: "底部", boundaryEdges: 0, nonManifoldEdges: 0 }
  ];
}

function addMeshEdgeToRegions(regions, edgeKey, vertices, box, longAxis, field) {
  const [aKey, bKey] = edgeKey.split("|");
  const a = vertices.get(aKey);
  const b = vertices.get(bKey);
  if (!a || !b) return;
  const midpoint = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2
  };
  const min = box.min[longAxis];
  const max = box.max[longAxis];
  const ratio = (midpoint[longAxis] - min) / Math.max(0.0001, max - min);
  if (ratio < 0.22) regions[0][field] += 1;
  else if (ratio > 0.78) regions[2][field] += 1;
  else regions[1][field] += 1;

  const zRatio = (midpoint.z - box.min.z) / Math.max(0.0001, box.max.z - box.min.z);
  if (zRatio > 0.68) regions[3][field] += 1;
  if (zRatio < 0.32) regions[4][field] += 1;
}

function finalizeMeshRegions(regions) {
  return regions.map((region) => {
    const riskScore = region.boundaryEdges + region.nonManifoldEdges * 3;
    return {
      ...region,
      riskScore,
      status: riskScore === 0 ? "ok" : riskScore < 20 ? "warning" : "critical",
      detail:
        riskScore === 0
          ? "未发现开口或非流形集中"
          : `边界 ${region.boundaryEdges}，非流形 ${region.nonManifoldEdges}`
    };
  });
}

function addEdge(edges, a, b) {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  edges.set(key, (edges.get(key) ?? 0) + 1);
}

function vertexKey(position, index) {
  const scale = 10000;
  const x = Math.round(position.getX(index) * scale);
  const y = Math.round(position.getY(index) * scale);
  const z = Math.round(position.getZ(index) * scale);
  return `${x},${y},${z}`;
}

function countDegenerateFaces(position) {
  let count = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    if (ab.cross(ac).lengthSq() < 1e-12) count += 1;
  }

  return count;
}

function toDisplayPreviewPoint(hit, center, displayScale) {
  const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
  normal.transformDirection(hit.object.matrixWorld);
  const point = hit.point.clone().addScaledVector(normal, 0.018 / displayScale).sub(center).multiplyScalar(displayScale);
  point.applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  return { x: point.x, y: point.y, z: point.z, hit: true };
}

function toDisplayMissPoint(point, center, displayScale) {
  const displayPoint = point.clone().sub(center).multiplyScalar(displayScale);
  displayPoint.applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  return { x: displayPoint.x, y: displayPoint.y, z: displayPoint.z, hit: false };
}


function largestAxis(size) {
  if (size.y >= size.x && size.y >= size.z) return "y";
  if (size.z >= size.x && size.z >= size.y) return "z";
  return "x";
}

function selectLengthAxis(size, requestedAxis) {
  if (requestedAxis === "x" || requestedAxis === "y" || requestedAxis === "z") {
    return requestedAxis;
  }
  return largestAxis(size);
}

function axisValue(vector, axis) {
  return vector[axis];
}

function setAxisValue(vector, axis, value) {
  vector[axis] = value;
}

function radialDistanceFromCenter(point, centerline, axes) {
  const da = axisValue(point, axes[0]) - axisValue(centerline, axes[0]);
  const db = axisValue(point, axes[1]) - axisValue(centerline, axes[1]);
  return Math.sqrt(da * da + db * db);
}

function summarizePoints(points, warnings) {
  const seed = {
    xMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
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
      aMin: Math.min(acc.aMin, point.a),
      aMax: Math.max(acc.aMax, point.a),
      zMin: Math.min(acc.zMin, point.z),
      zMax: Math.max(acc.zMax, point.z),
      maxDepth: Math.max(acc.maxDepth, point.depth)
    }),
    seed
  );

  return { ...values, warnings };
}

function maxCuttingZ(points, safeZ) {
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.z >= safeZ * 0.92) continue;
    max = Math.max(max, point.z);
  }
  return max;
}

function estimateTravel(points, radius) {
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

function postProcessorName(postProcessor) {
  if (postProcessor === "weihong") return "维宏风格 G-code";
  if (postProcessor === "syntec") return "新代风格 G-code";
  return "通用四轴 G-code";
}

function fmt(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function toGcode(points, settings, estimatedMinutes, sourceName) {
  const lines = [
    "%",
    `(Nuclear carving ${sourceName} - ${postProcessorName(settings.postProcessor)})`,
    "(Coordinate: X length axis, A rotary axis, Z radial tool center)",
    `(Length=${fmt(settings.lengthMm, 3)}mm Diameter=${fmt(settings.diameterMm, 3)}mm ToolDiameter=${fmt(settings.toolDiameter, 3)}mm)`,
    `(HoldLeft=${fmt(settings.leftHoldMm ?? 0, 3)}mm HoldRight=${fmt(settings.rightHoldMm ?? 0, 3)}mm EndTransition=${fmt(settings.endTransitionMm ?? 0, 3)}mm)`,
    `(Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    ...postStart(settings)
  ];

  if (points.length > 0) {
    lines.push(`G0 X${fmt(points[0].x)} A${fmt(points[0].a, 3)}`);
    lines.push(`G1 Z${fmt(points[0].z)} F${fmt(Number(settings.feedRate) * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 X${fmt(point.x)} A${fmt(point.a, 3)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
}

function postStart(settings) {
  const shared = [`F${fmt(settings.feedRate, 1)}`, `S${Math.round(Number(settings.spindleRpm))} M3`, `G0 Z${fmt(settings.safeZ)}`];
  if (settings.postProcessor === "weihong") return ["(POST: WEIHONG STYLE)", "G17", ...shared];
  if (settings.postProcessor === "syntec") return ["(POST: SYNTEC STYLE)", "G17 G40 G49 G80", ...shared];
  return ["(POST: GENERIC 4AXIS)", ...shared];
}

function postEnd(settings) {
  if (settings.postProcessor === "syntec") return ["G49", "M5", "M30"];
  return ["M5", "M30"];
}

function toCsv(points) {
  const rows = ["x_mm,a_deg,z_mm,mesh_surface_depth_mm"];
  for (const point of points) {
    rows.push(`${fmt(point.x)},${fmt(point.a, 3)},${fmt(point.z)},${fmt(point.depth)}`);
  }
  return `${rows.join("\n")}\n`;
}

function loadEnv() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    process.env[key] ??= value;
  }
}
