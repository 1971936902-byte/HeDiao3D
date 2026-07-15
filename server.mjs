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
  const lengthAxis = largestAxis(size);
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
      const u = (x + halfLength) / Number(settings.lengthMm);
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
