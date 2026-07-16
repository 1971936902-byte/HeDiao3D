import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

loadEnv();

const port = Number(process.env.API_PORT ?? 8787);
const meshyBase = process.env.MESHY_API_BASE ?? "https://api.meshy.ai";
const maxToolpathPreviewPoints = Number(process.env.MAX_TOOLPATH_PREVIEW_POINTS ?? 650000);
const orchestratorJobs = new Map();
const orchestratorQueue = [];
let orchestratorRunning = 0;
const maxOrchestratorConcurrency = Math.max(1, Number(process.env.ORCHESTRATOR_CONCURRENCY ?? 1));
const enableExternalCamAdapters = String(process.env.ENABLE_EXTERNAL_CAM_ADAPTERS ?? "").toLowerCase() === "true";

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

    if (req.method === "GET" && req.url === "/api/orchestrator/engines") {
      return getOrchestratorEngines(res);
    }

    if (req.method === "GET" && req.url === "/api/orchestrator/diagnostics") {
      return getOrchestratorDiagnostics(res);
    }

    if (req.method === "GET" && req.url === "/api/orchestrator/jobs") {
      return listOrchestratorJobs(res);
    }

    if (req.method === "POST" && req.url === "/api/orchestrator/jobs") {
      return createOrchestratorJob(req, res);
    }

    if (req.method === "POST" && req.url === "/api/mesh/import") {
      return importLocalMesh(req, res);
    }

    if (req.method === "POST" && req.url === "/api/mesh/analyze") {
      return analyzeMesh(req, res);
    }

    const orchestratorJobMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)$/);
    if (req.method === "GET" && orchestratorJobMatch) {
      return getOrchestratorJob(orchestratorJobMatch[1], res);
    }

    const orchestratorCancelMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/cancel$/);
    if (req.method === "POST" && orchestratorCancelMatch) {
      return cancelOrchestratorJob(orchestratorCancelMatch[1], res);
    }

    const orchestratorArtifactMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/artifacts\/([^/?#/]+)$/);
    if (req.method === "GET" && orchestratorArtifactMatch) {
      return getOrchestratorArtifact(orchestratorArtifactMatch[1], orchestratorArtifactMatch[2], res);
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
  const modelUrl = String(input.stlUrl ?? input.modelUrl ?? "");

  if (!settings || !isAllowedLocalModelUrl(modelUrl)) {
    return json(res, 400, { error: "本地 Mesh 模型地址或刀路参数无效" });
  }

  try {
    const toolpath = await generateToolpathFromLocalModel(modelUrl, settings);
    return json(res, 200, toolpath);
  } catch (error) {
    return json(res, 500, {
      error: error instanceof Error ? `Mesh CAM 解析失败：${error.message}` : "Mesh CAM 解析失败"
    });
  }
}

async function generateToolpathFromLocalModel(modelUrl, settings) {
  const modelPath = localModelUrlToPath(modelUrl);
  if (!existsSync(modelPath)) {
    throw new Error("找不到本地 Mesh 文件，请重新生成或重新导入模型");
  }

  let geometry;
  try {
    geometry = await loadModelGeometry(modelPath);
    geometry.computeVertexNormals();
    geometry.computeBoundsTree();

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const toolpath = generateMeshSurfaceToolpath(mesh, settings);
    geometry.disposeBoundsTree();
    geometry.dispose();
    return toolpath;
  } catch (error) {
    if (geometry) {
      try {
        geometry.disposeBoundsTree?.();
        geometry.dispose?.();
      } catch {
        // Ignore cleanup errors so the original CAM error can be reported.
      }
    }
    throw error;
  }
}

async function analyzeMesh(req, res) {
  const input = await readJson(req);
  const modelUrl = String(input.stlUrl ?? input.modelUrl ?? "");

  if (!isAllowedLocalModelUrl(modelUrl)) {
    return json(res, 400, { error: "本地 Mesh 模型地址无效" });
  }

  const modelPath = join(process.cwd(), "public", modelUrl.replace(/^\//, ""));
  if (!existsSync(modelPath)) {
    return json(res, 404, { error: "找不到本地 Mesh 文件，请重新生成或重新导入模型" });
  }

  let geometry;
  try {
    geometry = await loadModelGeometry(modelPath);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const report = buildMeshQualityReport(geometry);
    geometry.dispose();
    return json(res, 200, report);
  } catch (error) {
    geometry?.dispose?.();
    return json(res, 500, {
      error: error instanceof Error ? `Mesh 体检失败：${error.message}` : "Mesh 体检失败"
    });
  }
}

async function getOrchestratorEngines(res) {
  return json(res, 200, {
    engines: detectCamEngines(),
    architecture: {
      frontend: "HeDiao3D workflow UI",
      orchestrator: "local Node.js job coordinator",
      cam: "FreeCAD CAM / BlenderCAM / OpenCAMLib adapter slots with internal Mesh CAM fallback",
      simulation: "CAMotics adapter slot + internal rotary wrap preview",
      postprocess: "HeDiao3D post processors for 4-axis, 3-axis and Y/X rotary-wrap NC"
    }
  });
}

async function getOrchestratorDiagnostics(res) {
  const engines = detectCamEngines();
  const checks = [
    createDiagnosticCheck("api-port", "ok", `API_PORT=${port}`, "本地 API 端口可读取。"),
    createDiagnosticCheck("meshy-key", process.env.MESHY_API_KEY ? "ok" : "warning", process.env.MESHY_API_KEY ? "已配置" : "未配置", "未配置时不能调用 Meshy 生成/修复。"),
    createDiagnosticCheck("external-adapters", enableExternalCamAdapters ? "ok" : "warning", enableExternalCamAdapters ? "已启用" : "未启用", "未启用时不会执行 FreeCAD/BlenderCAM/OpenCAMLib adapter。"),
    createDiagnosticCheck("auto-mesh-repair", String(process.env.ORCHESTRATOR_AUTO_MESH_REPAIR ?? "").toLowerCase() === "true" ? "ok" : "warning", String(process.env.ORCHESTRATOR_AUTO_MESH_REPAIR ?? "false"), "未启用时 Orchestrator 只记录修复计划，不自动改模型。"),
    createDiagnosticCheck("concurrency", maxOrchestratorConcurrency >= 1 ? "ok" : "critical", String(maxOrchestratorConcurrency), "并发数必须大于等于 1。"),
    await createWritableDirectoryCheck("orchestrator-jobs", join(process.cwd(), "public", "orchestrator-jobs")),
    await createWritableDirectoryCheck("imported-models", join(process.cwd(), "public", "imported-models")),
    await createWritableDirectoryCheck("meshy-results", join(process.cwd(), "public", "meshy-results"))
  ];

  const externalEngines = engines.filter((engine) => engine.id !== "internal-mesh-cam");
  const availableExternal = externalEngines.filter((engine) => engine.available);
  checks.push(createDiagnosticCheck(
    "external-engine-detection",
    availableExternal.length > 0 ? "ok" : "warning",
    availableExternal.length > 0 ? availableExternal.map((engine) => engine.name).join("、") : "未检测到外部 CAM/仿真引擎",
    "生产级 CAM 需要安装 BlenderCAM/FabexCNC、FreeCAD CAM、CAMotics 或 OpenCAMLib。"
  ));

  const critical = checks.filter((check) => check.level === "critical").length;
  const warning = checks.filter((check) => check.level === "warning").length;
  const level = critical > 0 ? "critical" : warning > 0 ? "warning" : "ok";

  return json(res, 200, {
    level,
    summary: level === "ok" ? "V3 Orchestrator 环境可用。" : level === "warning" ? "V3 Orchestrator 可运行，但仍缺少生产级外部 CAM/仿真配置。" : "V3 Orchestrator 存在阻断项。",
    platform: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd()
    },
    queue: {
      queued: orchestratorQueue.length,
      running: orchestratorRunning,
      concurrency: maxOrchestratorConcurrency
    },
    env: {
      API_PORT: port,
      MESHY_API_BASE: meshyBase,
      MAX_TOOLPATH_PREVIEW_POINTS: maxToolpathPreviewPoints,
      ORCHESTRATOR_CONCURRENCY: maxOrchestratorConcurrency,
      ENABLE_EXTERNAL_CAM_ADAPTERS: enableExternalCamAdapters,
      ORCHESTRATOR_AUTO_MESH_REPAIR: String(process.env.ORCHESTRATOR_AUTO_MESH_REPAIR ?? "").toLowerCase() === "true",
      MESHY_API_KEY: Boolean(process.env.MESHY_API_KEY)
    },
    engines,
    checks,
    recommendedActions: createDiagnosticsRecommendedActions(checks, engines)
  });
}

function createDiagnosticCheck(id, level, value, detail) {
  return { id, level, value, detail };
}

async function createWritableDirectoryCheck(id, directory) {
  try {
    await mkdir(directory, { recursive: true });
    const probe = join(directory, `.hediao3d-write-test-${process.pid}-${Date.now()}.tmp`);
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    return createDiagnosticCheck(id, "ok", directory, "目录存在且可写。");
  } catch (error) {
    return createDiagnosticCheck(id, "critical", directory, error instanceof Error ? error.message : "目录不可写。");
  }
}

function createDiagnosticsRecommendedActions(checks, engines) {
  const actions = [];
  if (checks.some((check) => check.id === "meshy-key" && check.level !== "ok")) actions.push("配置 MESHY_API_KEY，启用 Meshy 多图建模和模型修复。");
  if (checks.some((check) => check.id === "external-adapters" && check.level !== "ok")) actions.push("生产环境确认外部 CAM adapter 后，设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true。");
  if (!engines.some((engine) => engine.id === "blendercam" && engine.available)) actions.push("旋转夹具/艺术 Mesh 场景优先安装 Blender + BlenderCAM/FabexCNC。");
  if (!engines.some((engine) => engine.id === "camotics" && engine.available)) actions.push("安装 CAMotics，用于正式 NC 下载前的材料去除仿真。");
  if (!engines.some((engine) => engine.id === "opencamlib" && engine.available)) actions.push("在 Linux CAM 服务端安装 OpenCAMLib/ocl，用于后续 drop-cutter 和水线算法。");
  if (actions.length === 0) actions.push("环境自检通过，可继续运行 V3 小闭环和外部 CAM adapter 试算。");
  return actions;
}

function createToolpathFromAdapterReport(adapterReport, job, settings, selectedEngine) {
  if (!adapterReport || adapterReport.status !== "completed") return null;
  const candidatePath = adapterReport.gcodePath
    ?? adapterReport.outputs?.gcode
    ?? join(job.workDir, "toolpath.nc");
  if (!candidatePath || !existsSync(candidatePath)) return null;

  const gcode = readFileSync(candidatePath, "utf8");
  if (!gcode.trim()) return null;
  const points = parseGcodeMotionPoints(gcode, settings);
  const warnings = [
    `${selectedEngine.name} adapter 输出已由 Orchestrator 摄取。`,
    "外部 CAM G-code 已进入统一交付链路；正式上机前仍需 CAMotics/机床控制器复核。"
  ];
  if (points.length === 0) warnings.push("外部 G-code 未解析到 G0/G1 运动点，无法生成可靠 3D 预览。");
  const estimatedMinutes = Number(adapterReport.metrics?.estimatedMinutes ?? adapterReport.estimatedMinutes ?? estimateTravel(points, Number(settings.diameterMm) / 2) / Math.max(1, Number(settings.feedRate)));

  return {
    points,
    previewPoints: limitToolpathPreviewPoints(points.map((point) => ({ ...point, hit: true }))),
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: `${selectedEngine.name} adapter G-code`,
    summary: summarizePoints(points, [...warnings, ...(adapterReport.warnings ?? [])])
  };
}

function parseGcodeMotionPoints(gcode, settings) {
  const points = [];
  const current = { x: 0, y: 0, a: 0, z: Number(settings.safeZ ?? 0), depth: 0 };
  const safeZ = Number(settings.safeZ ?? 0);
  for (const rawLine of gcode.split(/\r?\n/)) {
    const line = rawLine.replace(/\([^)]*\)/g, "").trim().toUpperCase();
    if (!line || !/(?:\bG0?0\b|\bG0?1\b)/.test(line)) continue;
    const x = parseGcodeWord(line, "X");
    const y = parseGcodeWord(line, "Y");
    const a = parseGcodeWord(line, "A");
    const z = parseGcodeWord(line, "Z");
    if (Number.isFinite(x)) current.x = x;
    if (Number.isFinite(y)) current.y = y;
    if (Number.isFinite(a)) current.a = a;
    if (Number.isFinite(z)) current.z = z;
    current.depth = Math.max(0, safeZ - current.z);
    points.push({ ...current });
  }
  return points;
}

function parseGcodeWord(line, word) {
  const match = line.match(new RegExp(`${word}\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : NaN;
}

async function createOrchestratorJob(req, res) {
  const input = await readJson(req);
  const settings = normalizeServerCamSettings(input.settings);
  const modelUrl = String(input.stlUrl ?? input.modelUrl ?? "");
  const requestedEngine = String(input.engine ?? "auto");

  if (!settings || !isAllowedLocalModelUrl(modelUrl)) {
    return json(res, 400, { error: "Orchestrator 需要本地 Mesh 模型地址和刀路参数" });
  }

  const job = {
    id: randomUUID(),
    status: "queued",
    requestedEngine,
    selectedEngine: null,
    modelUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workDir: null,
    pipeline: [],
    currentStage: "queued",
    progress: 0,
    artifacts: [],
    logs: [],
    cancelRequested: false,
    result: null,
    error: null
  };
  orchestratorJobs.set(job.id, job);

  try {
    const workDir = join(process.cwd(), "public", "orchestrator-jobs", job.id);
    await mkdir(workDir, { recursive: true });
    job.workDir = workDir;
    const jobSpec = createAdapterJobSpec(job, modelUrl, settings, workDir, requestedEngine);
    await writeFile(join(workDir, "job.json"), JSON.stringify(jobSpec, null, 2), "utf8");
    job.artifacts.push(publicArtifactUrl(job.id, "job.json"));
    appendOrchestratorLog(job, "已创建 Orchestrator job 工作目录和参数快照，等待队列调度。");
    await writeJobManifest(job);
    enqueueOrchestratorJob(job, settings);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Orchestrator 任务创建失败";
    appendOrchestratorLog(job, job.error);
    job.updatedAt = new Date().toISOString();
    await writeJobManifest(job);
  }

  return json(res, job.status === "failed" ? 500 : 202, job);
}

function enqueueOrchestratorJob(job, settings) {
  orchestratorQueue.push({ job, settings });
  runNextOrchestratorJob();
}

async function cancelOrchestratorJob(jobId, res) {
  const job = orchestratorJobs.get(jobId) ?? readJobManifest(jobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
    return json(res, 200, job);
  }

  const queuedIndex = orchestratorQueue.findIndex((item) => item.job.id === jobId);
  if (queuedIndex >= 0) {
    orchestratorQueue.splice(queuedIndex, 1);
    job.status = "canceled";
    job.cancelRequested = true;
    job.currentStage = "canceled";
    job.progress = 100;
    appendOrchestratorLog(job, "任务已在队列中取消，未进入 CAM 计算。");
    await writeJobManifest(job);
    return json(res, 200, job);
  }

  job.cancelRequested = true;
  appendOrchestratorLog(job, "已请求取消；当前阶段完成检查点后会停止后续交付。");
  await writeJobManifest(job);
  return json(res, 202, job);
}

function runNextOrchestratorJob() {
  while (orchestratorRunning < maxOrchestratorConcurrency && orchestratorQueue.length > 0) {
    const item = orchestratorQueue.shift();
    if (!item) return;
    orchestratorRunning += 1;
    processOrchestratorJob(item.job, item.settings)
      .catch((error) => {
        if (error?.code === "ORCHESTRATOR_CANCELED") {
          item.job.status = "canceled";
          item.job.error = null;
          item.job.currentStage = "canceled";
          item.job.progress = 100;
          appendOrchestratorLog(item.job, "任务已取消。");
        } else {
          item.job.status = "failed";
          item.job.error = error instanceof Error ? error.message : "Orchestrator 任务失败";
          appendOrchestratorLog(item.job, item.job.error);
        }
      })
      .finally(async () => {
        item.job.updatedAt = new Date().toISOString();
        await writeJobManifest(item.job);
        orchestratorRunning -= 1;
        runNextOrchestratorJob();
      });
  }
}

async function processOrchestratorJob(job, settings) {
  job.status = "running";
  job.pipeline = createInitialOrchestratorPipeline();
  updatePipelineStage(job, "queue", "completed", "任务已从队列取出。");
  appendOrchestratorLog(job, "任务已进入运行队列。");
  await writeJobManifest(job);
  checkOrchestratorCancellation(job);

  updatePipelineStage(job, "mesh-quality", "running", "正在读取 Mesh 并执行可加工性体检。");
  appendOrchestratorLog(job, "执行 Mesh 质量检测和修复计划生成。");
  const meshQuality = await createMeshQualityArtifact(job);
  const repairPlan = createRepairPlan(meshQuality, settings);
  await writeFile(join(job.workDir, "repair-plan.json"), JSON.stringify(repairPlan, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "mesh-quality.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "repair-plan.json"));
  updatePipelineStage(job, "mesh-quality", meshQuality.verdict === "ready" ? "completed" : "review", `Mesh 评分 ${meshQuality.score.toFixed(1)}，结论 ${meshQuality.verdict}。`);
  appendOrchestratorLog(job, `Mesh 体检完成：评分 ${meshQuality.score.toFixed(1)}，${repairPlan.statusText}`);
  const repairExecution = createRepairExecutionReport(job, meshQuality, repairPlan, settings);
  await writeFile(join(job.workDir, "repair-execution.json"), JSON.stringify(repairExecution, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "repair-execution.json"));
  appendOrchestratorLog(job, `Mesh 修复执行状态：${repairExecution.summary}`);
  await writeJobManifest(job);
  checkOrchestratorCancellation(job);

  updatePipelineStage(job, "cam-input", "running", "正在准备外部 CAM 输入模型和预处理策略。");
  const camInputPlan = createCamInputPlan(job, meshQuality, repairPlan, settings);
  await writeFile(join(job.workDir, "cam-input-plan.json"), JSON.stringify(camInputPlan, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-input-plan.json"));
  updatePipelineStage(job, "cam-input", camInputPlan.status === "blocked" ? "review" : "completed", camInputPlan.summary);
  appendOrchestratorLog(job, `CAM 输入准备完成：${camInputPlan.summary}`);
  await writeAdapterJobSpec(job, settings, { camInputPlan, meshQuality, repairPlan, repairExecution });
  await writeJobManifest(job);
  checkOrchestratorCancellation(job);

  appendOrchestratorLog(job, "读取外部 CAM 引擎状态。");
  const engines = detectCamEngines();
  const selected = selectCamEngine(engines, job.requestedEngine, settings);
  job.selectedEngine = selected.id;
  const engineReadiness = createEngineReadinessReport(engines, selected, settings);
  await writeFile(join(job.workDir, "engine-diagnostics.json"), JSON.stringify(engineReadiness, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "engine-diagnostics.json"));
  updatePipelineStage(job, "engine", engineReadiness.externalReady ? "completed" : "review", `选择 ${selected.name}；${engineReadiness.summary}`);
  const externalCamRecipe = createExternalCamRecipe({
    job,
    settings,
    camInputPlan,
    meshQuality,
    repairPlan,
    selectedEngine: selected,
    engineReadiness
  });
  await writeFile(join(job.workDir, "external-cam-recipe.json"), JSON.stringify(externalCamRecipe, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "external-cam-recipe.json"));
  await writeAdapterJobSpec(job, settings, { camInputPlan, meshQuality, repairPlan, repairExecution, engineReadiness, externalCamRecipe });
  const adapterPreflight = createAdapterPreflightReport(selected, job, settings, camInputPlan, engineReadiness);
  await writeFile(join(job.workDir, "adapter-preflight.json"), JSON.stringify(adapterPreflight, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "adapter-preflight.json"));
  appendOrchestratorLog(job, `Adapter 预检完成：${adapterPreflight.summary}`);
  checkOrchestratorCancellation(job);

  let adapterReport = null;
  if (selected.id !== "internal-mesh-cam" && selected.available && enableExternalCamAdapters) {
    updatePipelineStage(job, "external-cam", "running", `${selected.name} adapter 已开启，正在尝试执行。`);
    appendOrchestratorLog(job, `${selected.name} 可用且 ENABLE_EXTERNAL_CAM_ADAPTERS=true，尝试执行外部 CAM adapter。`);
    adapterReport = await runExternalCamAdapter(selected, job);
    pushUnique(job.artifacts, publicArtifactUrl(job.id, "adapter-report.json"));
    pushIfArtifactExists(job, "freecad-cam-plan.json");
    pushIfArtifactExists(job, "freecad-run-template.py");
    pushIfArtifactExists(job, "blendercam-cam-plan.json");
    pushIfArtifactExists(job, "blendercam-run-template.py");
    pushIfArtifactExists(job, "camotics-simulation-plan.json");
    pushIfArtifactExists(job, "camotics-project-template.json");
    const adapterStatus = adapterReport.status === "completed" ? "completed" : "review";
    updatePipelineStage(job, "external-cam", adapterStatus, adapterReport.error ?? `adapter 状态 ${adapterReport.status}`);
    appendOrchestratorLog(job, `${selected.name} adapter 返回 ${adapterReport.status}，${adapterReport.error ?? "无错误信息"}`);
  } else if (selected.id !== "internal-mesh-cam" && selected.available) {
    updatePipelineStage(job, "external-cam", "skipped", "外部 CAM 命令已检测到，但环境开关未启用。");
    appendOrchestratorLog(job, `${selected.name} 已检测到，但 ENABLE_EXTERNAL_CAM_ADAPTERS 未开启，先不执行外部 adapter。`);
  } else {
    updatePipelineStage(job, "external-cam", "skipped", "未检测到可执行外部 CAM，进入内置 fallback。");
  }

  updatePipelineStage(job, "toolpath", "running", adapterReport?.status === "completed" ? "正在摄取外部 CAM adapter 刀路。" : "正在生成内置 Mesh CAM fallback 刀路。");
  const externalToolpath = createToolpathFromAdapterReport(adapterReport, job, settings, selected);
  if (externalToolpath) {
    appendOrchestratorLog(job, `${selected.name} adapter 已返回可用 G-code，进入 Orchestrator 统一仿真和交付。`);
  } else {
    appendOrchestratorLog(job, `${selected.name} 当前不可直接执行或 adapter 未完成，使用内置 Mesh CAM fallback 完成闭环。`);
  }
  const toolpath = externalToolpath ?? await generateToolpathFromLocalModel(job.modelUrl, settings);
  checkOrchestratorCancellation(job);
  await writeFile(join(job.workDir, "toolpath.nc"), toolpath.gcode, "utf8");
  updatePipelineStage(job, "toolpath", "completed", `生成 ${toolpath.points.length} 个刀路点。`);
  updatePipelineStage(job, "simulation", "running", "正在生成自研旋转包裹预览和离料空跑。");
  const simulationSummary = createSimulationSummary(toolpath, settings, selected);
  const airRunGcode = createServerAirRunGcode(toolpath.points, settings, toolpath.estimatedMinutes, "V3 Orchestrator air run");
  const camoticsPreviewGcode = createCamoticsPreviewGcode(toolpath.points, settings, toolpath.estimatedMinutes);
  const machineControllerProfile = createMachineControllerProfile(settings);
  const ncStaticAnalysis = createNcStaticAnalysis({
    settings,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  const controllerDialectReport = createControllerDialectReport({
    settings,
    machineControllerProfile,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  await writeFile(join(job.workDir, "toolpath-summary.json"), JSON.stringify({
    engine: externalToolpath ? selected.id : "internal-mesh-cam",
    fallbackFrom: selected.id,
    source: externalToolpath ? "external-adapter" : "internal-fallback",
    points: toolpath.points.length,
    previewPoints: toolpath.previewPoints?.length ?? 0,
    estimatedMinutes: toolpath.estimatedMinutes,
    postProcessorName: toolpath.postProcessorName,
    warnings: toolpath.summary?.warnings ?? []
  }, null, 2), "utf8");
  const camoticsInput = createCamoticsInputPlan(job, toolpath, settings, selected);
  const camoticsSimulationPlan = createCamoticsSimulationPlan(job, toolpath, settings, selected, camoticsInput);
  await writeFile(join(job.workDir, "simulation-summary.json"), JSON.stringify(simulationSummary, null, 2), "utf8");
  await writeFile(join(job.workDir, "machine-controller-profile.json"), JSON.stringify(machineControllerProfile, null, 2), "utf8");
  await writeFile(join(job.workDir, "nc-static-analysis.json"), JSON.stringify(ncStaticAnalysis, null, 2), "utf8");
  await writeFile(join(job.workDir, "controller-dialect-report.json"), JSON.stringify(controllerDialectReport, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-input.json"), JSON.stringify(camoticsInput, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-simulation-plan.json"), JSON.stringify(camoticsSimulationPlan, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-project-template.json"), JSON.stringify(camoticsSimulationPlan.projectTemplate, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-run.md"), createCamoticsRunbook(camoticsInput), "utf8");
  await writeFile(join(job.workDir, "camotics-preview.nc"), camoticsPreviewGcode, "utf8");
  await writeFile(join(job.workDir, "air-run.nc"), airRunGcode, "utf8");
  updatePipelineStage(job, "simulation", "completed", `仿真贴合 ${simulationSummary.metrics.fitRate.toFixed(1)}%，未命中 ${simulationSummary.metrics.missCount} 点。`);
  updatePipelineStage(job, "postprocess", "running", "正在生成 V3 加工包门禁和交付清单。");
  const productionGate = createProductionGate({
    toolpath,
    settings,
    selectedEngine: selected,
    resultEngine: externalToolpath ? selected.id : "internal-mesh-cam",
    meshQuality,
    repairPlan,
    camInputPlan,
    engineReadiness,
    simulationSummary,
    camoticsInput,
    ncStaticAnalysis,
    machineControllerProfile,
    controllerDialectReport
  });
  const postprocessProfile = createPostprocessProfile({
    job,
    settings,
    toolpath,
    selectedEngine: selected,
    resultEngine: externalToolpath ? selected.id : "internal-mesh-cam",
    productionGate
  });
  const deliveryManifest = createDeliveryManifest(job, toolpath, productionGate);
  const machiningPackageIndex = createMachiningPackageIndex({
    job,
    toolpath,
    productionGate,
    postprocessProfile,
    camoticsInput,
    camoticsSimulationPlan,
    ncStaticAnalysis,
    machineControllerProfile,
    controllerDialectReport,
    deliveryManifest
  });
  await writeFile(join(job.workDir, "production-gate.json"), JSON.stringify(productionGate, null, 2), "utf8");
  await writeFile(join(job.workDir, "postprocess-profile.json"), JSON.stringify(postprocessProfile, null, 2), "utf8");
  await writeFile(join(job.workDir, "machining-package-index.json"), JSON.stringify(machiningPackageIndex, null, 2), "utf8");
  await writeFile(join(job.workDir, "delivery-manifest.json"), JSON.stringify(deliveryManifest, null, 2), "utf8");
  updatePipelineStage(job, "postprocess", productionGate.allowProductionNc ? "completed" : "review", productionGate.summary);
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "toolpath.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "toolpath-summary.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "simulation-summary.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "machine-controller-profile.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "nc-static-analysis.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "controller-dialect-report.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-input.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-simulation-plan.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-project-template.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-run.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-preview.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "air-run.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "production-gate.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "postprocess-profile.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "machining-package-index.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "delivery-manifest.json"));
  job.status = "completed";
  job.currentStage = "completed";
  job.progress = 100;
  job.result = {
    engine: externalToolpath ? selected.id : "internal-mesh-cam",
    fallbackFrom: selected.id,
    externalAvailable: selected.available,
    adapterReady: selected.adapterReady,
    adapterReport,
    toolpath,
    summary: {
      meshQuality,
      repairPlan,
      repairExecution,
      camInputPlan,
      engineReadiness,
      externalCamRecipe,
      adapterPreflight,
      productionGate,
      postprocessProfile,
      camoticsInput,
      camoticsSimulationPlan,
      ncStaticAnalysis,
      machineControllerProfile,
      controllerDialectReport,
      machiningPackageIndex,
      deliveryManifest,
      points: toolpath.points.length,
      previewPoints: toolpath.previewPoints?.length ?? 0,
      estimatedMinutes: toolpath.estimatedMinutes,
        postProcessorName: toolpath.postProcessorName,
        warnings: toolpath.summary?.warnings ?? [],
        simulation: simulationSummary
      }
    };
  appendOrchestratorLog(job, `闭环完成：${toolpath.points.length} 点，后处理 ${toolpath.postProcessorName}。`);
}

function createAdapterJobSpec(job, modelUrl, settings, workDir, requestedEngine) {
  return {
    jobId: job.id,
    engine: requestedEngine,
    modelUrl,
    modelPath: localModelUrlToPath(modelUrl),
    workDir,
    settings,
    outputs: {
      gcode: join(workDir, "toolpath.nc"),
      report: join(workDir, "adapter-report.json"),
      preview: join(workDir, "preview.json")
    }
  };
}

async function writeAdapterJobSpec(job, settings, extras = {}) {
  const jobSpec = createAdapterJobSpec(job, job.modelUrl, settings, job.workDir, job.requestedEngine);
  Object.assign(jobSpec, extras);
  await writeFile(join(job.workDir, "job.json"), JSON.stringify(jobSpec, null, 2), "utf8");
}

function createInitialOrchestratorPipeline() {
  return [
    { id: "queue", label: "队列调度", status: "queued", message: "等待 Orchestrator 调度。" },
    { id: "mesh-quality", label: "Mesh 体检/修复计划", status: "queued", message: "等待模型质量分析。" },
    { id: "cam-input", label: "CAM 输入准备", status: "queued", message: "等待选择可加工输入模型。" },
    { id: "engine", label: "CAM 引擎选择", status: "queued", message: "等待引擎探测。" },
    { id: "external-cam", label: "外部 CAM adapter", status: "queued", message: "等待判断是否调用 FreeCAD/BlenderCAM。" },
    { id: "toolpath", label: "刀路生成", status: "queued", message: "等待生成 NC。" },
    { id: "simulation", label: "仿真/空跑", status: "queued", message: "等待材料去除预览和空跑文件。" },
    { id: "postprocess", label: "后处理交付", status: "queued", message: "等待生成机床文件。" }
  ];
}

function updatePipelineStage(job, id, status, message) {
  const stage = job.pipeline?.find((item) => item.id === id);
  if (!stage) return;
  stage.status = status;
  stage.message = message;
  stage.updatedAt = new Date().toISOString();
  job.currentStage = id;
  job.progress = estimateOrchestratorProgress(job.pipeline, id, status);
}

function estimateOrchestratorProgress(pipeline, activeId, activeStatus) {
  const weights = {
    queue: 6,
    "mesh-quality": 16,
    "cam-input": 26,
    engine: 36,
    "external-cam": 46,
    toolpath: 68,
    simulation: 84,
    postprocess: 96
  };
  const base = weights[activeId] ?? 0;
  const bump = activeStatus === "completed" || activeStatus === "review" || activeStatus === "skipped" ? 6 : activeStatus === "running" ? 2 : 0;
  const completedCount = Array.isArray(pipeline)
    ? pipeline.filter((stage) => ["completed", "review", "skipped"].includes(stage.status)).length
    : 0;
  const completedBonus = Math.min(12, completedCount * 1.2);
  return Math.max(0, Math.min(98, Math.round(base + bump + completedBonus)));
}

function checkOrchestratorCancellation(job) {
  if (!job.cancelRequested) return;
  const error = new Error("Orchestrator 任务已取消");
  error.code = "ORCHESTRATOR_CANCELED";
  throw error;
}

async function createMeshQualityArtifact(job) {
  let geometry;
  try {
    geometry = await loadModelGeometry(localModelUrlToPath(job.modelUrl));
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.computeVertexNormals();
    const meshQuality = buildMeshQualityReport(geometry);
    await writeFile(join(job.workDir, "mesh-quality.json"), JSON.stringify(meshQuality, null, 2), "utf8");
    return meshQuality;
  } finally {
    geometry?.dispose?.();
  }
}

function createRepairPlan(meshQuality, settings) {
  const criticalChecks = meshQuality.checks.filter((check) => check.status === "critical");
  const warningChecks = meshQuality.checks.filter((check) => check.status === "warning");
  const actions = [];
  const camModeLabel = settings.camMode === "rotaryWrap" ? "三轴控制器 + 旋转夹具展开刀路" : settings.camMode === "3axis" ? "三轴平面/浮雕刀路" : "四轴联动刀路";

  if (meshQuality.boundaryEdges > 0) {
    actions.push({
      id: "close-boundaries",
      priority: "high",
      label: "封孔/补面",
      engine: "Meshy repair / Blender Mesh cleanup / FreeCAD mesh heal",
      reason: `检测到 ${meshQuality.boundaryEdges} 条边界边，开口区域会导致刀路采样未命中或顶部/两端缺损。`
    });
  }
  if (meshQuality.nonManifoldEdges > 0) {
    actions.push({
      id: "fix-non-manifold",
      priority: "high",
      label: "修复非流形边",
      engine: "Blender cleanup / OpenCAMLib 前置过滤",
      reason: `检测到 ${meshQuality.nonManifoldEdges} 条非流形边，外部 CAM 可能无法稳定计算刀具接触。`
    });
  }
  if (meshQuality.degenerateFaces > 0) {
    actions.push({
      id: "remove-degenerate-faces",
      priority: meshQuality.degenerateFaces > meshQuality.triangleCount * 0.01 ? "high" : "medium",
      label: "删除退化面并重算法线",
      engine: "Blender remesh / Meshy remesh",
      reason: `检测到 ${meshQuality.degenerateFaces} 个退化面，容易造成局部尖刺、空洞或仿真误差。`
    });
  }
  if (meshQuality.triangleCount > 180000) {
    actions.push({
      id: "decimate",
      priority: "medium",
      label: "降面到可加工密度",
      engine: "Blender decimate / Meshy remesh",
      reason: `当前 ${meshQuality.triangleCount} 面，建议先降面再进入 CAM 队列，减少计算时间和浏览器预览压力。`
    });
  }
  if (meshQuality.triangleCount < 1500) {
    actions.push({
      id: "increase-detail",
      priority: "medium",
      label: "提高模型细节",
      engine: "Meshy 重新生成 / 高精度 remesh",
      reason: "面数偏低，佛头五官、发髻和衣纹可能无法生成稳定精加工刀路。"
    });
  }
  const riskyRegions = meshQuality.regions.filter((region) => region.status !== "ok");
  if (riskyRegions.length > 0) {
    actions.push({
      id: "inspect-risk-regions",
      priority: "medium",
      label: "重点检查风险区域",
      engine: "HeDiao3D QA preview",
      reason: `风险集中在 ${riskyRegions.map((region) => region.label).join("、")}，建议在生成刀路前放大检查。`
    });
  }
  if (actions.length === 0) {
    actions.push({
      id: "direct-cam",
      priority: "low",
      label: "可直接进入 CAM",
      engine: "BlenderCAM / FreeCAD CAM / internal fallback",
      reason: "基础几何质量通过，进入刀路生成后仍需查看包络贴合和空跑仿真。"
    });
  }

  const status = criticalChecks.length > 0 ? "repair-required" : warningChecks.length > 0 ? "review-required" : "ready";
  return {
    status,
    statusText: status === "repair-required" ? "建议先修复 Mesh 再上正式 CAM" : status === "review-required" ? "可试算刀路，但建议人工复核风险点" : "Mesh 可进入 CAM 小闭环",
    camMode: settings.camMode,
    camModeLabel,
    qualityScore: meshQuality.score,
    criticalChecks: criticalChecks.map((check) => check.label),
    warningChecks: warningChecks.map((check) => check.label),
    recommendedActions: actions,
    externalCamNotes: [
      "BlenderCAM/Fabex 更适合 Meshy 艺术网格、佛头和浮雕类曲面。",
      "FreeCAD CAM 更适合规则实体和标准三轴加工，导入高面数艺术网格前建议先修复/降面。",
      "CAMotics 用于 NC 仿真，不替代刀路生成。"
    ]
  };
}

function createRepairExecutionReport(job, meshQuality, repairPlan, settings) {
  const autoRepairEnabled = String(process.env.ORCHESTRATOR_AUTO_MESH_REPAIR ?? "").toLowerCase() === "true";
  const hasMeshyKey = Boolean(process.env.MESHY_API_KEY);
  const required = repairPlan.status === "repair-required";
  const suggested = repairPlan.status === "review-required" || repairPlan.recommendedActions.some((action) => action.id !== "direct-cam" && action.priority !== "low");
  const sourceModelPath = localModelUrlToPath(job.modelUrl);
  const recommendedActions = repairPlan.recommendedActions.map((action) => ({
    id: action.id,
    label: action.label,
    priority: action.priority,
    engine: action.engine,
    reason: action.reason,
    executableByOrchestrator: ["close-boundaries", "fix-non-manifold", "remove-degenerate-faces", "cam-decimation"].includes(action.id)
  }));

  let status = "not-needed";
  let summary = "Mesh 质量满足 V3 小闭环要求，未执行自动修复。";
  if (required && !autoRepairEnabled) {
    status = "manual-required";
    summary = "Mesh 需要修复，但自动修复未启用；请先执行 Meshy 修复/重网格后再生产上机。";
  } else if (required && autoRepairEnabled && !hasMeshyKey) {
    status = "blocked-missing-key";
    summary = "Mesh 需要修复且自动修复已开启，但缺少 MESHY_API_KEY。";
  } else if (required && autoRepairEnabled && hasMeshyKey) {
    status = "ready-for-auto-repair";
    summary = "自动修复条件已满足；当前 V3 记录执行计划，下一步可接入后台 Meshy repair polling。";
  } else if (suggested) {
    status = "recommended";
    summary = "Mesh 可试算刀路，但建议在正式 CAM 前执行清理/降面/重网格。";
  }

  return {
    status,
    summary,
    autoRepairEnabled,
    hasMeshyKey,
    repairRequired: required,
    repairSuggested: suggested,
    sourceModelUrl: job.modelUrl,
    sourceModelPath,
    selectedModelUrl: job.modelUrl,
    selectedModelPath: sourceModelPath,
    outputCandidates: {
      repairedStl: join(job.workDir, "repaired-model.stl"),
      remeshedGlb: join(job.workDir, "remeshed-model.glb"),
      camDecimatedStl: join(job.workDir, "cam-decimated-model.stl")
    },
    settings: {
      camMode: settings.camMode,
      rotaryOutputAxis: settings.rotaryOutputAxis ?? null,
      toolDiameter: settings.toolDiameter,
      stepoverMm: settings.stepoverMm,
      stepoverDeg: settings.stepoverDeg
    },
    quality: {
      score: meshQuality.score,
      verdict: meshQuality.verdict,
      triangleCount: meshQuality.triangleCount,
      boundaryEdges: meshQuality.boundaryEdges,
      nonManifoldEdges: meshQuality.nonManifoldEdges,
      degenerateFaces: meshQuality.degenerateFaces
    },
    recommendedActions,
    nextSteps: createRepairExecutionNextSteps(status)
  };
}

function createRepairExecutionNextSteps(status) {
  if (status === "manual-required") {
    return [
      "在前端执行 Mesh 修复或重网格，重新导入修复后的 STL/GLB。",
      "确认 mesh-quality.json 中 boundary/non-manifold/degenerate 风险下降。",
      "重新运行 V3 小闭环，再下载试雕/空跑包。"
    ];
  }
  if (status === "blocked-missing-key") {
    return [
      "配置 MESHY_API_KEY。",
      "确认 ORCHESTRATOR_AUTO_MESH_REPAIR=true。",
      "重新运行 V3 job，让后端进入自动修复队列。"
    ];
  }
  if (status === "ready-for-auto-repair") {
    return [
      "接入后台 Meshy repair polling。",
      "将 repaired-model.stl 写入 job 工作目录。",
      "让 cam-input-plan.json 选择修复后的模型作为外部 CAM 输入。"
    ];
  }
  if (status === "recommended") {
    return [
      "当前可继续试算刀路。",
      "正式上机前建议先清理退化面、降面或重网格。",
      "如包络未贴合，优先修复模型再调 CAM 参数。"
    ];
  }
  return [
    "继续进入 CAM 输入准备。",
    "仍需查看生产门禁和空跑仿真结果。"
  ];
}

function createCamInputPlan(job, meshQuality, repairPlan, settings) {
  const needsRepair = repairPlan.status === "repair-required";
  const needsReview = repairPlan.status === "review-required";
  const highPoly = meshQuality.triangleCount > 180000;
  const veryHighPoly = meshQuality.triangleCount > 500000;
  const thinOrOpen = meshQuality.boundaryEdges > 0 || meshQuality.nonManifoldEdges > 0;
  const sourceModelPath = localModelUrlToPath(job.modelUrl);
  const preferredExternalEngine = settings.camMode === "3axis" ? "freecad" : "blendercam";
  const adapterModelPolicy = settings.camMode === "rotaryWrap"
    ? "unwrap-rotary-surface-heightfield"
    : settings.camMode === "3axis"
      ? "top-projection-heightfield-or-solid-stock"
      : "indexed-or-continuous-rotary-surface-sampling";
  const preprocessing = [];

  if (thinOrOpen) {
    preprocessing.push({
      id: "mesh-heal",
      required: true,
      output: "healed-model.stl",
      tool: "Meshy repair / Blender mesh cleanup",
      reason: "边界边或非流形边会让 CAM 接触计算出现缺口，正式上机前应先封孔和修法线。"
    });
  }
  if (meshQuality.degenerateFaces > 0) {
    preprocessing.push({
      id: "remove-degenerate-faces",
      required: needsRepair,
      output: "cleaned-model.stl",
      tool: "Blender cleanup / Meshy remesh",
      reason: "退化面会制造局部尖刺或空采样点，建议在外部 CAM 前清理。"
    });
  }
  if (highPoly) {
    preprocessing.push({
      id: "cam-decimation",
      required: veryHighPoly,
      output: "cam-decimated-model.stl",
      tool: "Blender decimate / Meshy remesh",
      reason: `当前 ${meshQuality.triangleCount} 面，外部 CAM 和仿真会明显变慢；建议生成一份保细节降面 CAM 输入模型。`
    });
  }
  if (settings.camMode === "rotaryWrap") {
    preprocessing.push({
      id: "rotary-fixture-alignment",
      required: false,
      output: "axis-aligned-model.stl",
      tool: "HeDiao3D axis analyzer",
      reason: "旋转夹具模式需要确认模型长轴、夹持余量和 Y/A 轴换算，否则会出现拉长或顶部缺口。"
    });
  }

  const status = needsRepair ? "blocked" : needsReview || highPoly ? "review" : "ready";
  const selectedModelKind = status === "blocked"
    ? "requires-repaired-model"
    : highPoly
      ? "source-model-with-decimation-recommended"
      : "source-model";
  const summary = status === "blocked"
    ? "当前模型需先修复后再进入生产 CAM，小闭环仍可使用 fallback 试算。"
    : status === "review"
      ? "当前模型可试算刀路，但建议先按计划清理/降面后交给外部 CAM。"
      : "当前模型可作为 CAM 输入进入小闭环。";

  return {
    status,
    summary,
    selectedModelKind,
    sourceModelUrl: job.modelUrl,
    sourceModelPath,
    selectedModelUrl: status === "blocked" ? null : job.modelUrl,
    selectedModelPath: status === "blocked" ? null : sourceModelPath,
    preferredExternalEngine,
    adapterModelPolicy,
    camMode: settings.camMode,
    rotaryOutputAxis: settings.rotaryOutputAxis ?? null,
    preprocessing,
    gate: {
      allowInternalFallback: true,
      allowExternalCamTrial: status !== "blocked",
      allowProductionNc: status === "ready",
      reason: summary
    }
  };
}

function createExternalCamRecipe({ job, settings, camInputPlan, meshQuality, repairPlan, selectedEngine, engineReadiness }) {
  const tool = describeTool(settings);
  const rotaryMode = settings.camMode === "rotaryWrap";
  const engineFamily = selectedEngine.id === "freecad"
    ? "freecad-path"
    : selectedEngine.id === "blendercam"
      ? "blendercam-fabex"
      : selectedEngine.id === "opencamlib"
        ? "opencamlib-kernel"
        : "internal-or-unsupported";
  const recipeStatus = camInputPlan.status === "blocked"
    ? "blocked"
    : selectedEngine.id === "internal-mesh-cam"
      ? "fallback-only"
      : engineReadiness.externalReady
        ? "ready-for-adapter"
        : "adapter-environment-missing";

  return {
    schema: "hediao3d.external-cam-recipe.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    status: recipeStatus,
    engine: {
      selectedEngine: selectedEngine.id,
      selectedEngineName: selectedEngine.name,
      engineFamily,
      command: selectedEngine.command ?? null,
      available: selectedEngine.available,
      adapterReady: selectedEngine.adapterReady,
      externalReady: engineReadiness.externalReady
    },
    model: {
      sourceModelUrl: camInputPlan.sourceModelUrl,
      sourceModelPath: camInputPlan.sourceModelPath,
      selectedModelUrl: camInputPlan.selectedModelUrl,
      selectedModelPath: camInputPlan.selectedModelPath,
      selectedModelKind: camInputPlan.selectedModelKind,
      adapterModelPolicy: camInputPlan.adapterModelPolicy,
      meshQuality: {
        score: meshQuality.score,
        verdict: meshQuality.verdict,
        triangleCount: meshQuality.triangleCount,
        boundaryEdges: meshQuality.boundaryEdges,
        nonManifoldEdges: meshQuality.nonManifoldEdges,
        degenerateFaces: meshQuality.degenerateFaces
      },
      repairStatus: repairPlan.status
    },
    stock: {
      type: rotaryMode ? "rotary-olive-core-unwrapped-stock" : "rectangular-relief-stock",
      lengthMm: Number(settings.lengthMm),
      diameterMm: Number(settings.diameterMm),
      leftHoldMm: Number(settings.leftHoldMm ?? 0),
      rightHoldMm: Number(settings.rightHoldMm ?? 0),
      endTransitionMm: Number(settings.endTransitionMm ?? 0),
      rotaryWrapPerRevolutionMm: rotaryMode ? Number(settings.rotaryWrapPerRevolutionMm ?? 100) : null,
      note: rotaryMode
        ? "外部 CAM 应优先生成展开高度场/表面扫描刀路，再交给 HeDiao3D wrapY/wrapA 后处理。"
        : "外部 CAM 可按三轴浮雕/顶面投影方式处理。"
    },
    tool: {
      toolProfileId: settings.toolProfileId ?? null,
      description: tool.name,
      diameterMm: Number(settings.toolDiameter),
      flatTipMm: settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg" ? 0.4 : null,
      angleDeg: settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg" ? 25 : null,
      maxCutDepthMm: Number(settings.maxCutDepth ?? settings.depthMm ?? 0),
      stockAllowanceMm: Number(settings.stockAllowance ?? 0)
    },
    operations: createExternalCamOperations(settings, rotaryMode),
    postprocess: {
      desiredOutput: "toolpath.nc",
      airRunOutput: "air-run.nc",
      camoticsPreviewOutput: "camotics-preview.nc",
      camMode: settings.camMode,
      postProcessor: settings.postProcessor,
      rotaryOutputAxis: rotaryMode ? settings.rotaryOutputAxis ?? "Y" : null,
      lengthAxis: rotaryMode && settings.rotaryOutputAxis === "X" ? "Y" : "X",
      depthAxis: "Z",
      policy: rotaryMode
        ? "External CAM returns neutral/unwrapped path; HeDiao3D owns final rotary-wrap Y/A postprocess."
        : "External CAM may return ordinary X/Y/Z G-code; HeDiao3D still validates and packages it."
    },
    simulation: {
      requiredBeforeProduction: true,
      camoticsInput: "camotics-input.json",
      camoticsPreview: "camotics-preview.nc",
      limitation: rotaryMode
        ? "CAMotics preview checks unwrapped 3-axis motion only; real rotary fixture material removal still needs machine-side or rotary-capable simulation."
        : "CAMotics can be used as the primary 3-axis material-removal check once adapter execution is implemented."
    },
    adapterContract: {
      input: "job.json",
      outputReport: "adapter-report.json",
      completedGcode: "toolpath.nc",
      completedStatusRequiresNonEmptyGcode: true,
      protocolVersion: "hediao3d.adapter.v1"
    },
    blockingIssues: [
      ...(camInputPlan.status === "blocked" ? [camInputPlan.summary] : []),
      ...(!engineReadiness.externalReady ? ["外部 CAM adapter 环境未就绪，当前只能使用内置 fallback。"] : [])
    ],
    nextAdapterSteps: createExternalCamNextSteps(selectedEngine.id, rotaryMode)
  };
}

function createExternalCamOperations(settings, rotaryMode) {
  const common = {
    stepoverMm: Number(settings.stepoverMm),
    stepoverDeg: Number(settings.stepoverDeg),
    feedRateMmMin: Number(settings.feedRate),
    spindleRpm: Number(settings.spindleRpm),
    safeZMm: Number(settings.safeZ)
  };
  return [
    {
      id: "roughing",
      enabled: Number(settings.stockAllowance ?? 0) > 0,
      strategy: rotaryMode ? "unwrapped-x-scan-roughing" : "top-surface-zigzag-roughing",
      target: "remove bulk stock while preserving stock allowance",
      maxCutDepthMm: Number(settings.maxCutDepth ?? settings.depthMm ?? 0),
      stockToLeaveMm: Number(settings.stockAllowance ?? 0),
      ...common
    },
    {
      id: "finishing",
      enabled: true,
      strategy: rotaryMode ? String(settings.finishingStrategy ?? "x-scan") : "parallel-finish",
      target: "final visible surface",
      maxCutDepthMm: Number(settings.depthMm ?? 0),
      stockToLeaveMm: 0,
      ...common
    },
    {
      id: "rest-detail",
      enabled: Number(settings.toolDiameter) <= 1 || settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg",
      strategy: rotaryMode ? "local-detail-pass-on-steep-features" : "rest-machining-on-steep-features",
      target: "recover small facial details and steep local features",
      maxCutDepthMm: Math.min(Number(settings.maxCutDepth ?? settings.depthMm ?? 0), Number(settings.depthMm ?? 0)),
      stockToLeaveMm: 0,
      ...common
    }
  ];
}

function createExternalCamNextSteps(engineId, rotaryMode) {
  if (engineId === "freecad") {
    return [
      "实现 FreeCAD 模型导入、Stock、ToolController 和 Path operation 配方。",
      "三轴场景先输出普通 X/Y/Z G-code，再由 Orchestrator 摄取并仿真。",
      rotaryMode ? "旋转夹具场景不建议直接依赖 FreeCAD 四轴；优先让 FreeCAD 处理展开高度场。" : "接入 CAMotics 后再打开生产门禁。"
    ];
  }
  if (engineId === "blendercam") {
    return [
      "实现 Blender/FabexCNC 后台导入 GLB/STL，并创建艺术曲面加工 operation。",
      "输出中性 G-code 或点位表给 HeDiao3D 后处理。",
      rotaryMode ? "旋转夹具模式优先生成展开 X/角度 扫描轨迹，再交由 wrapY 后处理。" : "三轴模式可直接输出 X/Y/Z 试雕 NC。"
    ];
  }
  if (engineId === "opencamlib") {
    return [
      "实现 OpenCAMLib drop-cutter 或 waterline 采样，输出 cutter-contact 点位。",
      "保留 HeDiao3D 的 wrapY/wrapA 后处理，不让 OpenCAMLib 直接负责机床 NC。",
      "用相同 adapter contract 返回 G-code 或中性点位产物。"
    ];
  }
  return [
    "当前使用 internal-mesh-cam 小闭环。",
    "先安装并启用 FreeCAD/BlenderCAM/OpenCAMLib adapter。",
    "保持 ENABLE_EXTERNAL_CAM_ADAPTERS=false，直到 adapter recipe 在小模型上通过。"
  ];
}

function createEngineReadinessReport(engines, selected, settings) {
  const byId = new Map(engines.map((engine) => [engine.id, engine]));
  const required = settings.camMode === "3axis"
    ? ["freecad", "camotics"]
    : ["blendercam", "camotics"];
  const optional = settings.camMode === "3axis"
    ? ["blendercam", "opencamlib"]
    : ["freecad", "opencamlib"];
  const engineChecks = engines.map((engine) => ({
      id: engine.id,
      name: engine.name,
      role: engine.role,
      required: required.includes(engine.id),
      optional: optional.includes(engine.id),
      available: engine.available,
      adapterReady: engine.adapterReady,
      command: engine.command,
      version: engine.version,
      status: engine.available && engine.adapterReady ? "ready" : engine.available ? "adapter-pending" : "missing",
      notes: engine.notes
    }));
  const missingRequired = engineChecks.filter((engine) => engine.required && !engine.available);
  const adapterPending = engineChecks.filter((engine) => engine.required && engine.available && !engine.adapterReady);
  const externalReady = required.some((id) => {
    const engine = byId.get(id);
    return engine?.available && engine?.adapterReady;
  });

  return {
    selectedEngine: selected.id,
    selectedEngineName: selected.name,
    camMode: settings.camMode,
    externalReady,
    enableExternalCamAdapters,
    summary: externalReady
      ? "已有外部 CAM adapter 可执行。"
      : missingRequired.length > 0
        ? `缺少 ${missingRequired.map((engine) => engine.name).join("、")}，当前将使用内置 fallback。`
        : adapterPending.length > 0
          ? "外部软件已检测到，但 adapter 仍未启用生产输出。"
          : "当前将使用内置 fallback。",
    requiredEngines: required,
    optionalEngines: optional,
    engines: engineChecks,
    installHints: [
      {
        engine: "BlenderCAM / FabexCNC",
        when: "Meshy 生成的佛头、艺术曲面、核雕浮雕和旋转夹具展开优先接入",
        windows: "安装 Blender，再安装 Fabex/BlenderCAM 插件；确保 blender 命令可被 PATH 找到。",
        linux: "安装 blender 和 Fabex/BlenderCAM 插件；在服务环境中暴露 blender 命令。"
      },
      {
        engine: "FreeCAD CAM",
        when: "规则实体、三轴平面/2.5D、夹具或治具类零件优先接入",
        windows: "安装 FreeCAD，并确保 FreeCADCmd 或 freecadcmd 可被 PATH 找到。",
        linux: "安装 freecad/freecadcmd；服务器上建议使用 FreeCADCmd 无界面运行 adapter。"
      },
      {
        engine: "CAMotics",
        when: "所有生产 NC 下载前做材料去除仿真和空跑验证",
        windows: "安装 CAMotics，并确保 camotics-cli 或 camotics 可被 PATH 找到。",
        linux: "安装 camotics/camotics-cli；由 Orchestrator 生成项目文件后执行仿真。"
      },
      {
        engine: "OpenCAMLib",
        when: "需要更可靠的刀具接触、drop-cutter、水线和曲面清根算法",
        windows: "优先在 Linux 服务端接入 Python wrapper，Windows 本地仅做前端调试。",
        linux: "安装 opencamlib Python wrapper，封装为 adapter 服务供 Orchestrator 调用。"
      }
    ]
  };
}

function createAdapterPreflightReport(selectedEngine, job, settings, camInputPlan, engineReadiness) {
  const scriptPath = getAdapterScriptPath(selectedEngine.id);
  const scriptExists = Boolean(scriptPath && existsSync(scriptPath));
  const modelPath = localModelUrlToPath(job.modelUrl);
  const modelExists = existsSync(modelPath);
  const workDirExists = Boolean(job.workDir && existsSync(job.workDir));
  const outputGcode = join(job.workDir, "toolpath.nc");
  const outputReport = join(job.workDir, "adapter-report.json");
  const commandAvailable = Boolean(selectedEngine.available && selectedEngine.command);
  const commandArgs = scriptPath ? createAdapterCommandArgs(selectedEngine, scriptPath, join(job.workDir, "job.json"), outputReport) : null;
  const checks = [
    createPreflightCheck("adapter-script", scriptExists, scriptPath ?? "未配置 adapter 脚本"),
    createPreflightCheck("model-file", modelExists, modelPath),
    createPreflightCheck("work-dir", workDirExists, job.workDir ?? "无工作目录"),
    createPreflightCheck("external-command", selectedEngine.id === "internal-mesh-cam" || commandAvailable, selectedEngine.command ?? "未检测到外部命令"),
    createPreflightCheck("env-switch", selectedEngine.id === "internal-mesh-cam" || enableExternalCamAdapters, enableExternalCamAdapters ? "ENABLE_EXTERNAL_CAM_ADAPTERS=true" : "ENABLE_EXTERNAL_CAM_ADAPTERS 未开启"),
    createPreflightCheck("cam-input", camInputPlan.status !== "blocked", camInputPlan.summary)
  ];
  const failed = checks.filter((check) => !check.ok);
  const canAttemptExternal = selectedEngine.id !== "internal-mesh-cam"
    && scriptExists
    && modelExists
    && workDirExists
    && commandAvailable
    && enableExternalCamAdapters
    && camInputPlan.status !== "blocked";
  const fallbackReason = selectedEngine.id === "internal-mesh-cam"
    ? "当前选择内置 Mesh CAM。"
    : failed[0]?.detail ?? engineReadiness.summary;

  return {
    status: canAttemptExternal ? "ready-to-run" : selectedEngine.id === "internal-mesh-cam" ? "internal-fallback" : "fallback-required",
    summary: canAttemptExternal
      ? `${selectedEngine.name} adapter 已具备执行条件。`
      : `外部 adapter 暂不能执行：${fallbackReason}`,
    selectedEngine: selectedEngine.id,
    selectedEngineName: selectedEngine.name,
    adapterScript: scriptPath,
    command: commandArgs ? `${commandArgs.command} ${commandArgs.args.join(" ")}` : null,
    outputs: {
      gcode: outputGcode,
      report: outputReport,
      preview: join(job.workDir, "preview.json")
    },
    checks,
    canAttemptExternal,
    willUseFallback: !canAttemptExternal,
    fallbackEngine: canAttemptExternal ? null : "internal-mesh-cam",
    deploymentHints: createAdapterDeploymentHints(selectedEngine.id)
  };
}

function createPreflightCheck(id, ok, detail) {
  return {
    id,
    ok,
    detail
  };
}

function createAdapterDeploymentHints(engineId) {
  if (engineId === "freecad") {
    return [
      "Windows: 安装 FreeCAD，确认 FreeCADCmd 或 freecadcmd 在 PATH 中。",
      "Linux: 安装 freecad/freecadcmd，优先使用 FreeCADCmd 无界面执行 adapter。",
      "启用前设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true，并先用小模型 dry-run。"
    ];
  }
  if (engineId === "blendercam") {
    return [
      "Windows/Linux: 安装 Blender，并安装 BlenderCAM/FabexCNC 插件。",
      "确认 blender --version 可在服务进程 PATH 中执行。",
      "旋转夹具/艺术 Mesh 优先走此 adapter，正式输出前仍需 CAMotics 仿真。"
    ];
  }
  if (engineId === "camotics") {
    return [
      "安装 CAMotics，确认 camotics-cli 或 camotics 可执行。",
      "由 Orchestrator 生成仿真项目后执行材料去除仿真。",
      "CAMotics 是仿真层，不负责生成刀路。"
    ];
  }
  return [
    "内置 Mesh CAM fallback 可用于 V3 小闭环和试算。",
    "生产级输出需要外部 CAM adapter 和 CAMotics 仿真共同解锁。"
  ];
}

function createProductionGate({ toolpath, settings, selectedEngine, resultEngine, meshQuality, repairPlan, camInputPlan, engineReadiness, simulationSummary, camoticsInput, ncStaticAnalysis, controllerDialectReport }) {
  const blockers = [];
  const warnings = [];
  const requiredActions = [];

  if (repairPlan.status === "repair-required") {
    blockers.push("Mesh 质量需要修复，不能直接生成生产 NC。");
    requiredActions.push("先执行封孔、修非流形、删除退化面或 Meshy/Blender 重网格。");
  } else if (repairPlan.status === "review-required") {
    warnings.push("Mesh 质量需要人工复核。");
  }

  if (!camInputPlan.gate.allowProductionNc) {
    warnings.push(camInputPlan.gate.reason);
    requiredActions.push("按 cam-input-plan.json 完成 CAM 输入模型清理后再解锁生产下载。");
  }

  if (!engineReadiness.externalReady) {
    warnings.push("尚未接入可执行的外部专业 CAM adapter。");
    requiredActions.push("安装并启用 BlenderCAM/FabexCNC 或 FreeCAD CAM adapter。");
  }
  if (resultEngine === "internal-mesh-cam") {
    warnings.push("本次刀路仍由内置 Mesh CAM fallback 生成，不是外部专业 CAM 输出。");
    requiredActions.push("确认 adapter-report.json；外部 CAM 未返回 completed 前不要按生产级 CAM 精度评估。");
  }

  if (simulationSummary.engine !== "camotics") {
    warnings.push("当前不是 CAMotics 真实材料去除仿真，仅为内置旋转包裹预览。");
    requiredActions.push("正式上机前用 CAMotics 或机床控制软件完成 NC 仿真。");
  }

  if (camoticsInput && !camoticsInput.compatibility.canRunInCamotics) {
    warnings.push(camoticsInput.compatibility.reason);
    requiredActions.push("若使用真实旋转轴 A 或四轴联动，需要用支持旋转轴的机床仿真软件复核。");
  }

  if (simulationSummary.riskLevel !== "ready") {
    warnings.push(`仿真风险等级为 ${simulationSummary.riskLevel}。`);
    requiredActions.push("检查未命中点、夹具方向、Z 安全高度和两端夹持余量。");
  }

  if (ncStaticAnalysis?.level === "critical") {
    blockers.push(`NC 静态分析存在阻断项：${ncStaticAnalysis.criticalIssues[0] ?? "请查看 nc-static-analysis.json"}`);
    requiredActions.push("修复后处理轴映射、空跑安全高度或文件用途标记后重新生成 NC。");
  } else if (ncStaticAnalysis?.level === "review") {
    warnings.push(`NC 静态分析需要复核：${ncStaticAnalysis.warningIssues[0] ?? "请查看 nc-static-analysis.json"}`);
    requiredActions.push("上机前查看 nc-static-analysis.json，确认轴字、Z范围和文件用途。");
  }

  if (controllerDialectReport?.level === "critical") {
    blockers.push(`控制器方言存在阻断项：${controllerDialectReport.criticalIssues[0] ?? "请查看 controller-dialect-report.json"}`);
    requiredActions.push("移除控制器不支持的 G/M/轴字，或选择匹配机床控制器的后处理器。");
  } else if (controllerDialectReport?.level === "review") {
    warnings.push(`控制器方言需要复核：${controllerDialectReport.warningIssues[0] ?? "请查看 controller-dialect-report.json"}`);
    requiredActions.push("上机前查看 controller-dialect-report.json，确认控制器支持所有指令。");
  }

  if ((toolpath.points?.length ?? 0) <= 0) {
    blockers.push("没有生成有效刀路点。");
  }

  const estimatedMinutes = Number(toolpath.estimatedMinutes ?? 0);
  if (estimatedMinutes > 240) {
    warnings.push(`估算加工时间 ${estimatedMinutes.toFixed(1)} min 偏长，建议先调大步距或分粗/精加工验证。`);
  }

  const postProcessorName = String(toolpath.postProcessorName ?? "");
  const expectedRotary = settings.camMode === "rotaryWrap";
  if (expectedRotary && !/Y轴旋转包裹|A轴旋转包裹|rotary/i.test(postProcessorName)) {
    blockers.push("当前后处理名称不像旋转包裹 NC，请检查机床轴映射。");
  }

  const allowProductionNc = blockers.length === 0
    && warnings.length === 0
    && camInputPlan.gate.allowProductionNc
    && engineReadiness.externalReady
    && simulationSummary.engine === "camotics"
    && simulationSummary.riskLevel === "ready";
  const allowTrialNc = blockers.length === 0;
  const allowAirRun = (toolpath.points?.length ?? 0) > 0;
  const level = blockers.length > 0 ? "blocked" : allowProductionNc ? "production" : "trial-only";

  return {
    level,
    allowProductionNc,
    allowTrialNc,
    allowAirRun,
    allowReports: true,
    summary: allowProductionNc
      ? "已通过 V3 生产门禁，可下载生产 NC。"
      : blockers.length > 0
        ? `禁止上机：${blockers[0]}`
        : "仅建议离料空跑/小料试雕，暂不建议直接生产上机。",
    machineMode: settings.camMode,
    rotaryOutputAxis: settings.rotaryOutputAxis ?? null,
    selectedEngine: selectedEngine.id,
    resultEngine: resultEngine ?? "internal-mesh-cam",
    checks: {
      meshVerdict: meshQuality.verdict,
      camInputStatus: camInputPlan.status,
      externalCamReady: engineReadiness.externalReady,
      simulationEngine: simulationSummary.engine,
      simulationRiskLevel: simulationSummary.riskLevel,
      fitRate: simulationSummary.metrics.fitRate,
      missCount: simulationSummary.metrics.missCount,
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes
    },
    blockers,
    warnings: dedupeStrings(warnings),
    requiredActions: dedupeStrings(requiredActions),
    recommendedWorkflow: [
      "下载并查看 mesh-quality.json、repair-plan.json、cam-input-plan.json。",
      "先运行 air-run.nc 做离料空跑，确认 X/Y旋转/Z 安全方向。",
      "用废料或低进给做小料试雕，记录真实深度、耗时和夹具方向。",
      "接入 BlenderCAM/FreeCAD 与 CAMotics 后，再解锁生产 NC 下载。"
    ]
  };
}

function createPostprocessProfile({ job, settings, toolpath, selectedEngine, resultEngine, productionGate }) {
  const postProcessor = settings.postProcessor ?? "generic";
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? settings.rotaryOutputAxis || (postProcessor === "wrapX" ? "X" : postProcessor === "wrapY" ? "Y" : "A")
    : null;
  const wrapPerRev = settings.camMode === "rotaryWrap"
    ? Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100))
    : null;
  const lengthAxis = settings.camMode === "rotaryWrap" && rotaryAxis === "X" ? "Y" : "X";
  const rotaryMapping = rotaryAxis
    ? rotaryAxis === "A"
      ? `${rotaryAxis}=旋转角度，单位为度`
      : `${rotaryAxis}=旋转夹具线性化坐标，${fmt(wrapPerRev, 3)}mm/360deg`
    : null;

  return {
    schema: "hediao3d.postprocess-profile.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    camMode: settings.camMode,
    postProcessor,
    postProcessorName: toolpath.postProcessorName ?? postProcessorName(postProcessor),
    selectedEngine: selectedEngine.id,
    selectedEngineName: selectedEngine.name,
    resultEngine,
    fallbackUsed: selectedEngine.id !== resultEngine,
    packageLevel: productionGate.level,
    coordinateMapping: {
      lengthAxis,
      depthAxis: "Z",
      rotaryAxis,
      length: `${lengthAxis}=工件长度方向`,
      depth: "Z=刀具高度/径向刀深，安全高度为正向",
      rotary: rotaryMapping,
      gcodeHeaderMarkers: settings.camMode === "rotaryWrap"
        ? {
            ROTARY_WRAP_AXIS: rotaryAxis,
            ROTARY_WRAP_PER_REV_MM: wrapPerRev,
            LENGTH_AXIS: lengthAxis
          }
        : {
            LENGTH_AXIS: "X",
            WIDTH_AXIS: "Y",
            DEPTH_AXIS: "Z"
          }
    },
    machine: {
      machineProfileId: settings.machineProfileId ?? null,
      rotaryOutputAxis: rotaryAxis,
      rotaryWrapPerRevolutionMm: wrapPerRev,
      notes: settings.camMode === "rotaryWrap"
        ? "适用于三轴控制器加旋转夹具：X走长度，Z控刀深，Y/A驱动旋转。"
        : "适用于常规三轴平面浮雕：X/Y平面运动，Z控刀深。"
    },
    stock: {
      lengthMm: Number(settings.lengthMm),
      diameterMm: Number(settings.diameterMm),
      leftHoldMm: Number(settings.leftHoldMm ?? 0),
      rightHoldMm: Number(settings.rightHoldMm ?? 0),
      endTransitionMm: Number(settings.endTransitionMm ?? 0),
      blankDiametersMm: {
        left: Number(settings.blankLeftDiameterMm ?? settings.diameterMm),
        leftMid: Number(settings.blankLeftMidDiameterMm ?? settings.diameterMm),
        center: Number(settings.blankCenterDiameterMm ?? settings.diameterMm),
        rightMid: Number(settings.blankRightMidDiameterMm ?? settings.diameterMm),
        right: Number(settings.blankRightDiameterMm ?? settings.diameterMm)
      }
    },
    tool: {
      toolProfileId: settings.toolProfileId ?? null,
      toolDiameterMm: Number(settings.toolDiameter),
      stepoverMm: Number(settings.stepoverMm),
      stepoverDeg: Number(settings.stepoverDeg),
      maxCutDepthMm: Number(settings.maxCutDepth ?? settings.depthMm ?? 0),
      stockAllowanceMm: Number(settings.stockAllowance ?? 0),
      description: describeTool(settings).name
    },
    cutting: {
      feedRateMmMin: Number(settings.feedRate),
      spindleRpm: Number(settings.spindleRpm),
      safeZMm: Number(settings.safeZ),
      estimatedMinutes: Number(toolpath.estimatedMinutes ?? 0),
      pointCount: toolpath.points?.length ?? 0
    },
    outputFiles: {
      productionOrTrialNc: "toolpath.nc",
      airRunNc: "air-run.nc",
      productionGate: "production-gate.json",
      simulationSummary: "simulation-summary.json"
    },
    safetyNotes: [
      "先运行 air-run.nc 做离料空跑，确认长度轴、旋转轴和 Z 方向。",
      "当前 packageLevel 不是 production 时，只建议小料试雕，不建议直接正式上机。",
      "若机床把旋转夹具接到 Y 轴，请确认控制器每转一圈等效距离与 rotaryWrapPerRevolutionMm 一致。"
    ]
  };
}

function createNcStaticAnalysis({ settings, files }) {
  const reports = files.map((file) => analyzeNcProgram(file, settings));
  const criticalIssues = reports.flatMap((report) => report.issues.filter((issue) => issue.level === "critical").map((issue) => `${report.filename}: ${issue.message}`));
  const warningIssues = reports.flatMap((report) => report.issues.filter((issue) => issue.level === "warning").map((issue) => `${report.filename}: ${issue.message}`));
  return {
    schema: "hediao3d.nc-static-analysis.v1",
    createdAt: new Date().toISOString(),
    level: criticalIssues.length > 0 ? "critical" : warningIssues.length > 0 ? "review" : "ready",
    camMode: settings.camMode,
    postProcessor: settings.postProcessor,
    rotaryOutputAxis: settings.rotaryOutputAxis ?? null,
    safeZMm: Number(settings.safeZ),
    programs: reports,
    criticalIssues,
    warningIssues,
    summary: criticalIssues.length > 0
      ? `发现 ${criticalIssues.length} 个阻断项，禁止直接上机。`
      : warningIssues.length > 0
        ? `发现 ${warningIssues.length} 个复核项，上机前需人工确认。`
        : "NC 静态分析通过。"
  };
}

function analyzeNcProgram(file, settings) {
  const lines = String(file.gcode ?? "").split(/\r?\n/);
  const axisCounts = { x: 0, y: 0, z: 0, a: 0 };
  const zValues = [];
  let motionLineCount = 0;
  let spindleStartCount = 0;
  let spindleStopCount = 0;
  let hasRotaryHeader = false;
  let hasPreviewOnlyMarker = false;
  let hasAirRunMarker = false;
  let hasLengthAxisHeader = false;
  const expectedRotaryAxis = settings.camMode === "rotaryWrap" ? String(settings.rotaryOutputAxis ?? "Y") : null;

  for (const rawLine of lines) {
    const upper = rawLine.toUpperCase();
    if (upper.includes("ROTARY_WRAP_AXIS=")) hasRotaryHeader = true;
    if (upper.includes("LENGTH_AXIS=")) hasLengthAxisHeader = true;
    if (upper.includes("CAMOTICS PREVIEW ONLY") || upper.includes("NOT FOR MACHINE")) hasPreviewOnlyMarker = true;
    if (upper.includes("AIR RUN ONLY")) hasAirRunMarker = true;
    if (/\bM3\b/.test(upper)) spindleStartCount += 1;
    if (/\bM5\b/.test(upper)) spindleStopCount += 1;
    if (!/(?:\bG0?0\b|\bG0?1\b)/.test(upper)) continue;
    motionLineCount += 1;
    if (parseGcodeWord(upper, "X") !== null && Number.isFinite(parseGcodeWord(upper, "X"))) axisCounts.x += 1;
    if (parseGcodeWord(upper, "Y") !== null && Number.isFinite(parseGcodeWord(upper, "Y"))) axisCounts.y += 1;
    if (parseGcodeWord(upper, "A") !== null && Number.isFinite(parseGcodeWord(upper, "A"))) axisCounts.a += 1;
    const z = parseGcodeWord(upper, "Z");
    if (z !== null && Number.isFinite(z)) {
      axisCounts.z += 1;
      zValues.push(z);
    }
  }

  const issues = [];
  if (motionLineCount === 0) issues.push(createNcIssue("critical", "no-motion", "未解析到 G0/G1 运动。"));
  if (axisCounts.z === 0) issues.push(createNcIssue("critical", "missing-z", "未解析到 Z 轴运动。"));

  if (file.role === "machine") {
    if (hasPreviewOnlyMarker) issues.push(createNcIssue("critical", "machine-marked-preview", "机床 NC 含有仿真专用标记。"));
    if (settings.camMode === "rotaryWrap") {
      if (!hasRotaryHeader || !hasLengthAxisHeader) issues.push(createNcIssue("critical", "missing-rotary-header", "旋转包裹 NC 缺少 ROTARY_WRAP_AXIS/LENGTH_AXIS 头部标记。"));
      if (expectedRotaryAxis === "Y" && axisCounts.y === 0) issues.push(createNcIssue("critical", "missing-y-rotary", "Y轴旋转夹具模式未发现 Y 轴运动。"));
      if (expectedRotaryAxis === "A" && axisCounts.a === 0) issues.push(createNcIssue("critical", "missing-a-rotary", "A轴旋转夹具模式未发现 A 轴运动。"));
    }
    if (spindleStartCount === 0) issues.push(createNcIssue("warning", "spindle-not-started", "机床 NC 未发现 M3 主轴启动指令。"));
  }

  if (file.role === "air-run") {
    if (!hasAirRunMarker) issues.push(createNcIssue("warning", "missing-air-run-marker", "空跑文件缺少 AIR RUN ONLY 标记。"));
    if (spindleStartCount > 0) issues.push(createNcIssue("critical", "air-run-spindle-start", "空跑文件不应包含 M3 主轴启动。"));
    const minZ = zValues.length ? Math.min(...zValues) : Number.NaN;
    if (Number.isFinite(minZ) && minZ < Number(settings.safeZ) - 0.001) {
      issues.push(createNcIssue("critical", "air-run-below-safe-z", `空跑文件最低 Z=${fmt(minZ)}，低于安全高度 ${fmt(settings.safeZ)}。`));
    }
  }

  if (file.role === "simulation-only") {
    if (!hasPreviewOnlyMarker) issues.push(createNcIssue("critical", "simulation-missing-preview-marker", "仿真 NC 缺少不可上机标记。"));
    if (spindleStartCount > 0) issues.push(createNcIssue("warning", "simulation-spindle-start", "仿真预览文件出现 M3，建议保持主轴关闭。"));
  }

  return {
    filename: file.filename,
    role: file.role,
    lineCount: lines.length,
    motionLineCount,
    axisCounts,
    zRange: {
      min: zValues.length ? Math.min(...zValues) : null,
      max: zValues.length ? Math.max(...zValues) : null
    },
    markers: {
      hasRotaryHeader,
      hasLengthAxisHeader,
      hasPreviewOnlyMarker,
      hasAirRunMarker,
      spindleStartCount,
      spindleStopCount
    },
    level: issues.some((issue) => issue.level === "critical") ? "critical" : issues.length > 0 ? "review" : "ready",
    issues
  };
}

function createNcIssue(level, id, message) {
  return { level, id, message };
}

function createMachineControllerProfile(settings) {
  const postProcessor = settings.postProcessor ?? "generic";
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? String(settings.rotaryOutputAxis || (postProcessor === "wrapX" ? "X" : postProcessor === "wrapY" ? "Y" : "A")).toUpperCase()
    : null;
  const lengthAxis = settings.camMode === "rotaryWrap" && rotaryAxis === "X" ? "Y" : "X";
  const wrapPerRev = settings.camMode === "rotaryWrap"
    ? Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100))
    : null;
  const allowedWords = settings.camMode === "rotaryWrap"
    ? dedupeStrings([lengthAxis, "Z", rotaryAxis, "F", "S"].filter(Boolean))
    : ["X", "Y", "Z", "F", "S"];

  return {
    schema: "hediao3d.machine-controller-profile.v1",
    createdAt: new Date().toISOString(),
    id: settings.machineProfileId ?? (settings.camMode === "rotaryWrap" ? "desktop-rotary-y-wrap" : "desktop-3axis-relief"),
    name: settings.camMode === "rotaryWrap"
      ? `三轴控制器 + ${rotaryAxis}轴旋转夹具`
      : "常规三轴平面浮雕控制器",
    camMode: settings.camMode ?? "relief3axis",
    controllerClass: settings.camMode === "rotaryWrap" ? "3axis-controller-with-rotary-fixture" : "3axis-cartesian",
    axisMapping: {
      lengthAxis,
      depthAxis: "Z",
      rotaryAxis,
      planarWidthAxis: settings.camMode === "rotaryWrap" ? null : "Y",
      description: settings.camMode === "rotaryWrap"
        ? `${lengthAxis}=长度方向，Z=刀深/安全高度，${rotaryAxis}=旋转夹具线性化坐标。`
        : "X/Y=平面运动，Z=刀深/安全高度。"
    },
    rotary: {
      enabled: settings.camMode === "rotaryWrap",
      outputAxis: rotaryAxis,
      outputUnit: rotaryAxis && rotaryAxis !== "A" ? "linearized-mm" : rotaryAxis === "A" ? "degree" : null,
      wrapPerRevolutionMm: wrapPerRev,
      warning: settings.camMode === "rotaryWrap"
        ? "确认控制器中该轴每转一圈对应的脉冲/等效距离与 wrapPerRevolutionMm 一致。"
        : null
    },
    dialect: {
      allowedG: ["G0", "G00", "G1", "G01", "G21", "G90", "G94"],
      allowedM: ["M3", "M03", "M5", "M05", "M30"],
      allowedWords,
      expectedRotaryAxis: rotaryAxis,
      forbiddenWords: settings.camMode === "rotaryWrap" && rotaryAxis === "Y" ? ["A"] : [],
      unsupportedByDefault: ["G2", "G02", "G3", "G03", "G17", "G18", "G19", "G40", "G41", "G42", "G43", "G49", "G80", "G81", "G83"]
    },
    safety: {
      safeZMm: Number(settings.safeZ ?? 0),
      spindleRpm: Number(settings.spindleRpm ?? 0),
      feedRateMmMin: Number(settings.feedRate ?? 0),
      airRunRequired: true,
      softTrialRequiredBeforeProduction: true,
      notes: [
        "首次换机床、换夹具、换后处理器或修改旋转等效距离后，必须先运行 air-run.nc。",
        "空跑确认长度方向、旋转方向、Z正负方向、限位和夹持安全距离后，再做软材料试雕。",
        "当前 profile 是保守控制器能力集；若真实控制器支持圆弧、刀补或更多 M 指令，应新增机床 profile 后再放开。"
      ]
    },
    postprocessExpectation: {
      requestedPostProcessor: postProcessor,
      expectedOutput: settings.camMode === "rotaryWrap"
        ? `只输出 ${allowedWords.join("/")} 字地址和基础 G0/G1/G21/G90/G94/M3/M5/M30。`
        : "只输出 X/Y/Z/F/S 和基础 G0/G1/G21/G90/G94/M3/M5/M30。"
    }
  };
}

function createControllerDialectReport({ settings, machineControllerProfile, files }) {
  const profile = machineControllerProfile ?? createMachineControllerProfile(settings);
  const dialect = {
    id: profile.id,
    name: profile.name,
    allowedG: profile.dialect.allowedG,
    allowedM: profile.dialect.allowedM,
    allowedWords: profile.dialect.allowedWords,
    expectedRotaryAxis: profile.dialect.expectedRotaryAxis,
    forbiddenWords: profile.dialect.forbiddenWords ?? [],
    profileArtifact: "machine-controller-profile.json",
    notes: [
      profile.axisMapping.description,
      profile.rotary.warning,
      ...(profile.safety.notes ?? [])
    ].filter(Boolean)
  };
  const programs = files.map((file) => analyzeControllerDialectProgram(file, settings, dialect));
  const criticalIssues = programs.flatMap((program) => program.issues.filter((issue) => issue.level === "critical").map((issue) => `${program.filename}: ${issue.message}`));
  const warningIssues = programs.flatMap((program) => program.issues.filter((issue) => issue.level === "warning").map((issue) => `${program.filename}: ${issue.message}`));

  return {
    schema: "hediao3d.controller-dialect-report.v1",
    createdAt: new Date().toISOString(),
    level: criticalIssues.length > 0 ? "critical" : warningIssues.length > 0 ? "review" : "ready",
    dialect,
    programs,
    criticalIssues,
    warningIssues,
    summary: criticalIssues.length > 0
      ? `发现 ${criticalIssues.length} 个控制器方言阻断项。`
      : warningIssues.length > 0
        ? `发现 ${warningIssues.length} 个控制器方言复核项。`
        : "控制器方言兼容检查通过。"
  };
}

function analyzeControllerDialectProgram(file, settings, dialect) {
  const commandCounts = {};
  const wordCounts = {};
  const unsupportedCommands = [];
  const unsupportedWords = [];
  const forbiddenWords = [];
  const issues = [];
  const expectedRotaryAxis = dialect.expectedRotaryAxis;
  const forbiddenWordSet = new Set(dialect.forbiddenWords ?? []);

  for (const rawLine of String(file.gcode ?? "").split(/\r?\n/)) {
    const stripped = rawLine.replace(/\([^)]*\)/g, "").trim().toUpperCase();
    if (!stripped || stripped === "%") continue;
    const tokens = stripped.match(/[A-Z][+-]?\d+(?:\.\d+)?/g) ?? [];
    for (const token of tokens) {
      const letter = token[0];
      const normalized = normalizeGcodeToken(token);
      wordCounts[letter] = (wordCounts[letter] ?? 0) + 1;
      if (letter === "G") {
        commandCounts[normalized] = (commandCounts[normalized] ?? 0) + 1;
        if (!dialect.allowedG.includes(normalized)) unsupportedCommands.push(normalized);
      } else if (letter === "M") {
        commandCounts[normalized] = (commandCounts[normalized] ?? 0) + 1;
        if (!dialect.allowedM.includes(normalized)) unsupportedCommands.push(normalized);
      } else if (!dialect.allowedWords.includes(letter)) {
        unsupportedWords.push(letter);
      } else if (forbiddenWordSet.has(letter)) {
        forbiddenWords.push(letter);
      }
    }
  }

  const uniqueUnsupportedCommands = dedupeStrings(unsupportedCommands);
  const uniqueUnsupportedWords = dedupeStrings(unsupportedWords);
  const uniqueForbiddenWords = dedupeStrings(forbiddenWords);
  if (uniqueUnsupportedCommands.length > 0) {
    issues.push(createNcIssue(file.role === "simulation-only" ? "warning" : "critical", "unsupported-commands", `发现不在保守控制器方言中的指令：${uniqueUnsupportedCommands.join(", ")}。`));
  }
  if (uniqueUnsupportedWords.length > 0) {
    issues.push(createNcIssue(file.role === "simulation-only" ? "warning" : "critical", `unsupported-words`, `发现不在保守控制器方言中的字地址：${uniqueUnsupportedWords.join(", ")}。`));
  }
  if (uniqueForbiddenWords.length > 0) {
    issues.push(createNcIssue(file.role === "simulation-only" ? "warning" : "critical", "forbidden-words", `发现当前机床 Profile 禁止的字地址：${uniqueForbiddenWords.join(", ")}。`));
  }

  if (file.role === "machine" && settings.camMode === "rotaryWrap") {
    if (expectedRotaryAxis === "Y" && (wordCounts.A ?? 0) > 0) {
      issues.push(createNcIssue("critical", "unexpected-a-axis", "Y轴旋转夹具后处理不应输出 A 轴。"));
    }
    if (expectedRotaryAxis === "Y" && (wordCounts.Y ?? 0) === 0) {
      issues.push(createNcIssue("critical", "missing-y-axis", "Y轴旋转夹具后处理未输出 Y 轴。"));
    }
    if (expectedRotaryAxis === "A" && (wordCounts.A ?? 0) === 0) {
      issues.push(createNcIssue("critical", "missing-a-axis", "A轴旋转夹具后处理未输出 A 轴。"));
    }
  }

  if (file.role === "air-run" && ((commandCounts.M3 ?? 0) + (commandCounts.M03 ?? 0)) > 0) {
    issues.push(createNcIssue("critical", "air-run-spindle-start", "空跑 NC 不应包含 M3/M03。"));
  }

  return {
    filename: file.filename,
    role: file.role,
    level: issues.some((issue) => issue.level === "critical") ? "critical" : issues.length > 0 ? "review" : "ready",
    commandCounts,
    wordCounts,
    unsupportedCommands: uniqueUnsupportedCommands,
    unsupportedWords: uniqueUnsupportedWords,
    forbiddenWords: uniqueForbiddenWords,
    issues
  };
}

function normalizeGcodeToken(token) {
  const letter = token[0].toUpperCase();
  const value = Number(token.slice(1));
  if ((letter === "G" || letter === "M") && Number.isFinite(value)) {
    return `${letter}${String(Math.trunc(value)).padStart(value < 10 ? 1 : 0, "0")}`;
  }
  return token.toUpperCase();
}

function createCamoticsInputPlan(job, toolpath, settings, selectedEngine) {
  const points = toolpath.points ?? [];
  const postProcessor = settings.postProcessor ?? "generic";
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? settings.rotaryOutputAxis || (postProcessor === "wrapX" ? "X" : postProcessor === "wrapY" ? "Y" : "A")
    : null;
  const linearizedRotary = settings.camMode === "rotaryWrap" && rotaryAxis && rotaryAxis !== "A";
  const compatibleThreeAxis = settings.camMode === "3axis" || linearizedRotary;
  const bounds = createCamoticsBounds(points, settings, rotaryAxis);
  const tool = describeTool(settings);

  return {
    schema: "hediao3d.camotics-input.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    status: compatibleThreeAxis ? "prepared" : "review-required",
    source: {
      gcode: "toolpath.nc",
      camoticsPreviewGcode: "camotics-preview.nc",
      airRun: "air-run.nc",
      simulationSummary: "simulation-summary.json"
    },
    compatibility: {
      canRunInCamotics: compatibleThreeAxis,
      mode: settings.camMode,
      rotaryAxis,
      interpretation: linearizedRotary
        ? "linearized-rotary-wrap-as-3axis"
        : settings.camMode === "3axis"
          ? "plain-3axis"
          : "unsupported-rotary-or-4axis",
      reason: compatibleThreeAxis
        ? "CAMotics 可用于检查当前 X/Y/Z 形式的刀路、Z 安全高度和大致切削包络。"
        : "CAMotics 主要面向 3 轴仿真；真实 A 轴/四轴联动不能作为生产级材料去除结论。"
    },
    machine: {
      selectedEngine: selectedEngine.id,
      postProcessorName: toolpath.postProcessorName,
      lengthAxis: settings.camMode === "rotaryWrap" && rotaryAxis === "X" ? "Y" : "X",
      rotaryOutputAxis: rotaryAxis,
      rotaryWrapPerRevolutionMm: settings.camMode === "rotaryWrap" ? Number(settings.rotaryWrapPerRevolutionMm ?? 100) : null,
      safeZMm: Number(settings.safeZ)
    },
    stock: {
      shape: linearizedRotary ? "unwrapped-rectangular-stock" : "rectangular-stock",
      boundsMm: bounds,
      lengthMm: Number(settings.lengthMm),
      diameterMm: Number(settings.diameterMm),
      note: linearizedRotary
        ? "这里的 Y 宽度是旋转夹具一圈的线性展开距离，不是真实圆柱实体。"
        : "按三轴平面毛坯包络准备。"
    },
    tool: {
      toolProfileId: settings.toolProfileId ?? null,
      description: tool.name,
      diameterMm: Number(settings.toolDiameter),
      flatTipMm: settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg" ? 0.4 : null,
      angleDeg: settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg" ? 25 : null
    },
    commands: {
      openGcode: "camotics camotics-preview.nc",
      openMachineGcode: "camotics toolpath.nc",
      openAirRun: "camotics air-run.nc"
    },
    limitations: [
      "该输入包不等同于真实 CAMotics 材料去除结果；它用于准备和人工复核。",
      "camotics-preview.nc 是展开三轴预览文件，Z 已转换为普通负向切深；toolpath.nc 仍是机床实际后处理输出。",
      "Y轴旋转夹具模式会被当作展开平面 X/Y/Z 刀路检查，不能反映圆柱/橄榄核两端夹持实体。",
      "生产门禁仍要求真实 CAMotics adapter 或机床控制软件完成复核。"
    ]
  };
}

function createCamoticsSimulationPlan(job, toolpath, settings, selectedEngine, camoticsInput) {
  const bounds = camoticsInput.stock.boundsMm;
  const margin = Math.max(1, Number(settings.toolDiameter ?? 1));
  const stockMin = {
    x: Number(bounds.xMin) - margin,
    y: Number(bounds.yMin) - margin,
    z: Math.min(Number(bounds.zMin), -Number(settings.depthMm ?? 0)) - margin
  };
  const stockMax = {
    x: Number(bounds.xMax) + margin,
    y: Number(bounds.yMax) + margin,
    z: Math.max(Number(bounds.zMax), Number(settings.safeZ ?? 0)) + margin
  };
  const pointCount = toolpath.points?.length ?? 0;
  const previewPointCount = toolpath.previewPoints?.length ?? 0;
  const tool = camoticsInput.tool;

  return {
    schema: "hediao3d.camotics-simulation-plan.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    status: camoticsInput.compatibility.canRunInCamotics ? "ready-for-camotics-preview" : "review-required",
    engine: {
      selectedEngine: selectedEngine.id,
      adapter: "camotics",
      execution: "planned-not-run",
      reason: "当前产物准备 CAMotics 输入和项目模板；真实 CLI 执行会在 CAMotics adapter 启用后写入结果。"
    },
    inputs: {
      preferredGcode: "camotics-preview.nc",
      machineGcodeForReferenceOnly: "toolpath.nc",
      airRun: "air-run.nc",
      camoticsInput: "camotics-input.json"
    },
    coordinateInterpretation: {
      mode: camoticsInput.compatibility.mode,
      interpretation: camoticsInput.compatibility.interpretation,
      rotaryAxis: camoticsInput.compatibility.rotaryAxis,
      note: camoticsInput.compatibility.reason
    },
    stock: {
      shape: camoticsInput.stock.shape,
      boundsMm: {
        min: stockMin,
        max: stockMax
      },
      sourceBoundsMm: bounds,
      marginMm: margin,
      note: camoticsInput.stock.note
    },
    tool: {
      id: tool.toolProfileId,
      description: tool.description,
      diameterMm: tool.diameterMm,
      flatTipMm: tool.flatTipMm,
      angleDeg: tool.angleDeg,
      spindleRpm: Number(settings.spindleRpm ?? 0),
      feedRateMmMin: Number(settings.feedRate ?? 0)
    },
    expectedChecks: [
      "确认 camotics-preview.nc 没有超出展开毛坯包络。",
      "确认 Z 最小值不超过单刀最大切深和目标深度。",
      "确认空跑 air-run.nc 全程位于安全 Z。",
      "确认 toolpath.nc 仅作为机床后处理对照，不直接当 CAMotics 三轴结论。"
    ],
    metricsSeed: {
      pointCount,
      previewPointCount,
      estimatedMinutes: Number(toolpath.estimatedMinutes ?? 0)
    },
    commands: {
      openPreview: "camotics camotics-preview.nc",
      openAirRun: "camotics air-run.nc",
      cliPlaceholder: "camotics-cli --simulate camotics-project-template.json"
    },
    projectTemplate: {
      schema: "hediao3d.camotics-project-template.v1",
      jobId: job.id,
      units: "mm",
      coordinateSystem: "G21/G90",
      files: {
        gcode: "camotics-preview.nc",
        referenceMachineGcode: "toolpath.nc",
        airRun: "air-run.nc"
      },
      stock: {
        min: stockMin,
        max: stockMax,
        shape: camoticsInput.stock.shape
      },
      tool: {
        type: tool.angleDeg ? "v-bit-flat-tip" : "flat-endmill",
        diameterMm: tool.diameterMm,
        flatTipMm: tool.flatTipMm,
        angleDeg: tool.angleDeg
      },
      outputRequests: {
        screenshot: "camotics-preview.png",
        materialMesh: "camotics-material-removal.stl",
        summary: "camotics-result.json"
      },
      limitations: camoticsInput.limitations
    }
  };
}

function createCamoticsBounds(points, settings, rotaryAxis) {
  const xs = points.map((point) => Number(point.x)).filter(Number.isFinite);
  const ys = points.map((point) => Number(point.y)).filter(Number.isFinite);
  const zs = points.map((point) => Number(point.z)).filter(Number.isFinite);
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const isLinearizedWrap = settings.camMode === "rotaryWrap" && rotaryAxis && rotaryAxis !== "A";
  const yMin = isLinearizedWrap ? 0 : ys.length ? Math.min(...ys) : -Number(settings.diameterMm) / 2;
  const yMax = isLinearizedWrap ? wrapPerRev : ys.length ? Math.max(...ys) : Number(settings.diameterMm) / 2;

  return {
    xMin: xs.length ? Math.min(...xs) : -Number(settings.lengthMm) / 2,
    xMax: xs.length ? Math.max(...xs) : Number(settings.lengthMm) / 2,
    yMin,
    yMax,
    zMin: zs.length ? Math.min(...zs) : -Number(settings.depthMm ?? 0),
    zMax: Math.max(Number(settings.safeZ ?? 0), zs.length ? Math.max(...zs) : 0)
  };
}

function createCamoticsRunbook(camoticsInput) {
  const lines = [
    "# HeDiao3D CAMotics 输入说明",
    "",
    `Job ID: ${camoticsInput.jobId}`,
    `状态: ${camoticsInput.status}`,
    `兼容性: ${camoticsInput.compatibility.canRunInCamotics ? "可用作三轴检查" : "需要其他仿真软件复核"}`,
    `解释方式: ${camoticsInput.compatibility.interpretation}`,
    "",
    "## 文件",
    "",
    "- toolpath.nc: 当前试雕/生产刀路",
    "- camotics-preview.nc: 展开平面三轴仿真预览刀路，不用于上机",
    "- air-run.nc: 离料空跑刀路",
    "- camotics-input.json: CAMotics 输入参数和限制说明",
    "- camotics-simulation-plan.json: CAMotics 仿真计划、毛坯和刀具参数",
    "- camotics-project-template.json: 后续生成真实 CAMotics 项目的结构化模板",
    "",
    "## 建议命令",
    "",
    "```bash",
    camoticsInput.commands.openGcode,
    `# 机床原始NC仅用于对照：${camoticsInput.commands.openMachineGcode}`,
    camoticsInput.commands.openAirRun,
    "```",
    "",
    "## 注意",
    "",
    ...camoticsInput.limitations.map((item) => `- ${item}`)
  ];
  return `${lines.join("\n")}\n`;
}

function createCamoticsPreviewGcode(points, settings, estimatedMinutes) {
  const postProcessor = settings.postProcessor ?? "generic";
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? settings.rotaryOutputAxis || (postProcessor === "wrapX" ? "X" : postProcessor === "wrapY" ? "Y" : "A")
    : null;
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const observedMaxDepth = points.reduce((max, point) => Math.max(max, Number(point.depth ?? 0)), 0);
  const targetMaxDepth = Math.max(0.001, Number(settings.depthMm ?? settings.maxCutDepth ?? observedMaxDepth ?? 1));
  const depthScale = observedMaxDepth > 0 ? targetMaxDepth / observedMaxDepth : 1;
  const previewSafeZ = Math.max(2, Number(settings.depthMm ?? 0) + 1);
  const lines = [
    "%",
    "(CAMOTICS PREVIEW ONLY - not for machine)",
    "(Coordinate: X/Y unwrapped stock, Z negative cutting depth)",
    `(SourcePost=${postProcessorName(settings.postProcessor)} Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    `F${fmt(settings.feedRate, 1)}`,
    `G0 Z${fmt(previewSafeZ)}`
  ];

  if (points.length > 0) {
    const first = toCamoticsPreviewPoint(points[0], settings, rotaryAxis, wrapPerRev, depthScale);
    lines.push(`G0 X${fmt(first.x)} Y${fmt(first.y)} Z${fmt(previewSafeZ)}`);
    lines.push(`G1 Z${fmt(first.z)} F${fmt(Number(settings.feedRate) * 0.45, 1)}`);
  }

  for (const point of points) {
    const preview = toCamoticsPreviewPoint(point, settings, rotaryAxis, wrapPerRev, depthScale);
    lines.push(`G1 X${fmt(preview.x)} Y${fmt(preview.y)} Z${fmt(preview.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(previewSafeZ)}`);
  lines.push("M5", "M30", "%");
  return `${lines.join("\n")}\n`;
}

function toCamoticsPreviewPoint(point, settings, rotaryAxis, wrapPerRev, depthScale) {
  const normalizedDepth = Math.max(0, Number(point.depth ?? 0)) * depthScale;
  if (settings.camMode === "rotaryWrap") {
    const rotaryLinear = ((Number(point.a ?? 0) % 360 + 360) % 360) / 360 * wrapPerRev;
    if (rotaryAxis === "X") {
      return {
        x: rotaryLinear,
        y: Number(point.x ?? 0),
        z: -normalizedDepth
      };
    }
    return {
      x: Number(point.x ?? 0),
      y: rotaryLinear,
      z: -normalizedDepth
    };
  }

  return {
    x: Number(point.x ?? 0),
    y: Number(point.y ?? 0),
    z: -normalizedDepth
  };
}

function createMachiningPackageIndex({ job, toolpath, productionGate, postprocessProfile, camoticsInput, ncStaticAnalysis, machineControllerProfile, controllerDialectReport, deliveryManifest }) {
  const fileByName = new Map(deliveryManifest.files.map((file) => [file.filename, file]));
  const getFile = (filename) => fileByName.get(filename) ?? createDeliveryFile(job.id, filename, filename, "unknown", false, "未列入交付清单。");
  const productionCandidate = productionGate.allowProductionNc ? "toolpath.nc" : null;
  const trialCandidate = productionGate.allowTrialNc ? "toolpath.nc" : null;

  return {
    schema: "hediao3d.machining-package-index.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    summary: productionGate.summary,
    machineCompatibility: {
      machineControllerProfileId: machineControllerProfile?.id ?? null,
      controllerClass: machineControllerProfile?.controllerClass ?? null,
      camMode: postprocessProfile.camMode,
      postProcessorName: postprocessProfile.postProcessorName,
      lengthAxis: machineControllerProfile?.axisMapping?.lengthAxis ?? postprocessProfile.coordinateMapping?.lengthAxis ?? "X",
      depthAxis: machineControllerProfile?.axisMapping?.depthAxis ?? postprocessProfile.coordinateMapping?.depthAxis ?? "Z",
      rotaryAxis: machineControllerProfile?.axisMapping?.rotaryAxis ?? postprocessProfile.coordinateMapping?.rotaryAxis ?? null,
      rotaryWrapPerRevolutionMm: machineControllerProfile?.rotary?.wrapPerRevolutionMm ?? postprocessProfile.machine?.rotaryWrapPerRevolutionMm ?? null,
      intendedMachine: machineControllerProfile?.name ?? postprocessProfile.machine?.notes ?? null
    },
    filesByPurpose: {
      readFirst: [
        getFile("machining-package-index.json"),
        getFile("production-gate.json"),
        getFile("nc-static-analysis.json"),
        getFile("machine-controller-profile.json"),
        getFile("controller-dialect-report.json"),
        getFile("external-cam-recipe.json"),
        getFile("postprocess-profile.json"),
        getFile("delivery-manifest.json")
      ],
      reports: deliveryManifest.files.filter((file) => file.kind === "report" && !["machining-package-index.json", "production-gate.json", "nc-static-analysis.json", "machine-controller-profile.json", "controller-dialect-report.json", "postprocess-profile.json", "delivery-manifest.json"].includes(file.filename)),
      simulationOnly: [
        getFile("camotics-input.json"),
        getFile("camotics-simulation-plan.json"),
        getFile("camotics-project-template.json"),
        getFile("camotics-run.md"),
        getFile("camotics-preview.nc"),
        getFile("simulation-summary.json")
      ],
      airRun: [getFile("air-run.nc")],
      machineNcCandidates: [
        ...(trialCandidate ? [{ ...getFile(trialCandidate), usage: productionGate.allowProductionNc ? "production-or-trial" : "trial-only" }] : [])
      ],
      neverRunOnMachine: [
        { ...getFile("camotics-preview.nc"), reason: "展开三轴仿真预览，Z 已被归一化为负向切深，不是机床后处理输出。" },
        { ...getFile("camotics-run.md"), reason: "Markdown 操作说明，不是 NC。" }
      ]
    },
    recommendedSequence: [
      "阅读 machining-package-index.json 和 production-gate.json，确认包级别。",
      "阅读 machine-controller-profile.json，确认当前是目标机床配置，而不是默认保守配置。",
      "阅读 postprocess-profile.json，确认 X/Y/A/Z 轴映射与机床接线一致。",
      "使用 camotics-preview.nc 做展开三轴仿真检查，不要上机运行该文件。",
      "运行 air-run.nc 做离料空跑，确认夹具旋转方向、行程和 Z 安全高度。",
      productionGate.allowProductionNc
        ? "通过外部 CAM 与仿真门禁后，可按生产流程运行 toolpath.nc。"
        : "当前仅允许小料/废料低进给试雕；生产前必须补齐外部 CAM 和真实仿真复核。"
    ],
    gates: {
      allowProductionNc: productionGate.allowProductionNc,
      allowTrialNc: productionGate.allowTrialNc,
      allowAirRun: productionGate.allowAirRun,
      productionCandidate,
      trialCandidate,
      blockers: productionGate.blockers,
      warnings: productionGate.warnings,
      requiredActions: productionGate.requiredActions
    },
    ncStaticAnalysis: {
      level: ncStaticAnalysis?.level ?? "unknown",
      summary: ncStaticAnalysis?.summary ?? null
    },
    controllerDialect: {
      level: controllerDialectReport?.level ?? "unknown",
      summary: controllerDialectReport?.summary ?? null,
      dialect: controllerDialectReport?.dialect?.name ?? null
    },
    camotics: {
      status: camoticsInput.status,
      previewFile: "camotics-preview.nc",
      compatibility: camoticsInput.compatibility,
      limitation: "CAMotics 仅用于展开三轴检查；旋转夹具真实材料去除仍需专业仿真或机床控制软件复核。"
    },
    metrics: {
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes: toolpath.estimatedMinutes
    }
  };
}

function createDeliveryManifest(job, toolpath, productionGate) {
  const files = [
    createDeliveryFile(job.id, "job.json", "任务参数快照", "report", true, "用于复现本次 Orchestrator 输入。"),
    createDeliveryFile(job.id, "job-status.json", "任务状态和日志", "report", true, "用于追踪队列、日志和结果摘要。"),
    createDeliveryFile(job.id, "mesh-quality.json", "Mesh 质量报告", "report", true, "上机前必须查看模型风险。"),
    createDeliveryFile(job.id, "repair-plan.json", "Mesh 修复计划", "report", true, "说明是否需要封孔、降面、重网格。"),
    createDeliveryFile(job.id, "repair-execution.json", "Mesh 修复执行记录", "report", true, "说明是否自动修复、为何跳过以及下一步修复动作。"),
    createDeliveryFile(job.id, "cam-input-plan.json", "CAM 输入计划", "report", true, "说明进入外部 CAM 前应使用哪份模型。"),
    createDeliveryFile(job.id, "external-cam-recipe.json", "外部CAM作业配方", "report", true, "统一描述 FreeCAD/BlenderCAM/OpenCAMLib 所需模型、毛坯、刀具、工序、后处理和仿真要求。"),
    createDeliveryFile(job.id, "engine-diagnostics.json", "外部引擎诊断", "report", true, "说明 FreeCAD/BlenderCAM/CAMotics 接入状态。"),
    createDeliveryFile(job.id, "adapter-preflight.json", "Adapter 运行预检", "report", true, "说明 adapter 脚本、命令、环境开关和 fallback 原因。"),
    createDeliveryFile(job.id, "simulation-summary.json", "仿真摘要", "report", true, "当前记录内置预览或 CAMotics 仿真结果。"),
    createDeliveryFile(job.id, "camotics-input.json", "CAMotics 输入计划", "report", true, "准备 CAMotics/机床仿真复核所需的刀路、毛坯和刀具参数。"),
    createDeliveryFile(job.id, "camotics-simulation-plan.json", "CAMotics 仿真计划", "report", true, "记录 CAMotics 预览 NC、展开毛坯、刀具、坐标解释和待执行检查项。"),
    createDeliveryFile(job.id, "camotics-project-template.json", "CAMotics 项目模板", "report", true, "后续 CAMotics adapter 生成真实项目/截图/材料去除网格的结构化模板。"),
    createDeliveryFile(job.id, "camotics-run.md", "CAMotics 操作说明", "report", true, "说明如何用 CAMotics 打开 toolpath.nc 和 air-run.nc，以及旋转夹具模式限制。"),
    createDeliveryFile(job.id, "camotics-preview.nc", "CAMotics 展开预览 NC", "simulation", true, "仅用于 CAMotics 三轴展开仿真，Z 已转成负向切深，不可上机。"),
    createDeliveryFile(job.id, "production-gate.json", "生产门禁", "report", true, "说明是否允许生产 NC 下载。"),
    createDeliveryFile(job.id, "machine-controller-profile.json", "机床控制器配置", "report", true, "显式记录三轴控制器、Y/A旋转夹具、允许 G/M 指令和轴字规则。"),
    createDeliveryFile(job.id, "postprocess-profile.json", "后处理配置", "report", true, "说明 X/Z/旋转轴映射、刀具、胚料和 G-code 输出约定。"),
    createDeliveryFile(job.id, "machining-package-index.json", "加工包索引", "report", true, "加工包首页，区分可上机文件、仿真文件、空跑文件和必读报告。"),
    createDeliveryFile(job.id, "air-run.nc", "离料空跑 NC", "air-run", productionGate.allowAirRun, "主轴关闭且 Z 在安全高度，用来验证轴向和行程。"),
    createDeliveryFile(job.id, "toolpath.nc", "试雕/生产 NC", "nc", productionGate.allowTrialNc, productionGate.allowProductionNc ? "已允许生产下载。" : "当前仅建议小料试雕，不建议直接生产上机。"),
    createDeliveryFile(job.id, "toolpath-summary.json", "刀路摘要", "report", true, "记录点数、时间和后处理。"),
    createDeliveryFile(job.id, "nc-static-analysis.json", "NC 静态分析", "report", true, "检查机床 NC、空跑 NC、仿真 NC 的轴字、Z范围、头部标记和不可上机标记。"),
    createDeliveryFile(job.id, "controller-dialect-report.json", "控制器方言兼容", "report", true, "检查 NC 是否只使用三轴控制器 + Y轴旋转夹具常见基础 G/M/轴字。")
  ];
  if (existsSync(join(job.workDir, "freecad-cam-plan.json"))) {
    files.push(createDeliveryFile(job.id, "freecad-cam-plan.json", "FreeCAD CAM 执行计划", "report", true, "外部 FreeCAD adapter 生成的可审计 CAM 配方和环境探测结果。"));
  }
  if (existsSync(join(job.workDir, "freecad-run-template.py"))) {
    files.push(createDeliveryFile(job.id, "freecad-run-template.py", "FreeCAD 运行模板", "report", true, "外部 FreeCAD adapter 生成的 FreeCADCmd 脚本模板，用于服务器端二次验证。"));
  }
  if (existsSync(join(job.workDir, "blendercam-cam-plan.json"))) {
    files.push(createDeliveryFile(job.id, "blendercam-cam-plan.json", "BlenderCAM 曲面加工计划", "report", true, "外部 BlenderCAM/FabexCNC adapter 生成的艺术曲面 CAM 配方和环境探测结果。"));
  }
  if (existsSync(join(job.workDir, "blendercam-run-template.py"))) {
    files.push(createDeliveryFile(job.id, "blendercam-run-template.py", "BlenderCAM 运行模板", "report", true, "外部 BlenderCAM/FabexCNC adapter 生成的 Blender 后台脚本模板，用于服务器端二次验证。"));
  }

  return {
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    allowProductionNc: productionGate.allowProductionNc,
    allowTrialNc: productionGate.allowTrialNc,
    allowAirRun: productionGate.allowAirRun,
    pointCount: toolpath.points?.length ?? 0,
    estimatedMinutes: toolpath.estimatedMinutes,
    files,
    operatorNotes: productionGate.recommendedWorkflow
  };
}

function createDeliveryFile(jobId, filename, label, kind, downloadable, note) {
  return {
    filename,
    label,
    kind,
    url: publicArtifactUrl(jobId, filename),
    downloadable,
    note
  };
}

function dedupeStrings(list) {
  return [...new Set(list.filter(Boolean))];
}

async function runExternalCamAdapter(selectedEngine, job) {
  const jobPath = join(job.workDir, "job.json");
  const resultPath = join(job.workDir, "adapter-report.json");
  const scriptPath = getAdapterScriptPath(selectedEngine.id);
  if (!scriptPath || !existsSync(scriptPath)) {
    const report = {
      status: "adapter_missing",
      engine: selectedEngine.id,
      error: "未找到 adapter 脚本",
      warnings: [],
      metrics: {}
    };
    await writeFile(resultPath, JSON.stringify(report, null, 2), "utf8");
    return report;
  }

  const args = createAdapterCommandArgs(selectedEngine, scriptPath, jobPath, resultPath);
  const startedAt = Date.now();
  const run = spawnSync(args.command, args.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: Number(process.env.EXTERNAL_CAM_ADAPTER_TIMEOUT_MS ?? 120000)
  });
  let report = null;
  if (existsSync(resultPath)) {
    try {
      report = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch {
      report = null;
    }
  }
  if (!report) {
    report = {
      status: run.status === 0 ? "completed_without_report" : "failed",
      engine: selectedEngine.id,
      error: run.error?.message ?? (run.status === 0 ? null : `adapter exit ${run.status}`),
      warnings: [],
      metrics: {}
    };
  }
  report.command = `${args.command} ${args.args.join(" ")}`;
  report.exitCode = run.status;
  report.durationMs = Date.now() - startedAt;
  report.stdout = String(run.stdout ?? "").slice(-6000);
  report.stderr = String(run.stderr ?? "").slice(-6000);
  report.validation = validateAdapterReport(report, selectedEngine, job);
  if (!report.validation.ok && report.status === "completed") {
    report.status = "invalid_report";
    report.error = report.validation.errors[0] ?? "adapter completed but report did not pass Orchestrator validation";
  }
  await writeFile(resultPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

function validateAdapterReport(report, selectedEngine, job) {
  const allowedStatuses = new Set(["completed", "adapter_not_ready", "adapter_missing", "failed", "invalid_report", "completed_without_report"]);
  const errors = [];
  const warnings = [];

  if (!report || typeof report !== "object") {
    return { ok: false, errors: ["adapter report is not an object"], warnings };
  }

  if (!allowedStatuses.has(String(report.status))) {
    errors.push(`unsupported adapter status: ${String(report.status)}`);
  }

  if (report.engine && report.engine !== selectedEngine.id) {
    warnings.push(`adapter engine ${report.engine} differs from selected engine ${selectedEngine.id}`);
  }

  if (report.status === "completed") {
    const gcodePath = report.gcodePath ?? report.outputs?.gcode ?? join(job.workDir, "toolpath.nc");
    if (!gcodePath || !existsSync(gcodePath)) {
      errors.push("completed adapter report did not write a G-code file");
    } else {
      const size = statSync(gcodePath).size;
      if (size <= 0) errors.push("completed adapter G-code file is empty");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString()
  };
}

function getAdapterScriptPath(engineId) {
  const adapterScriptMap = {
    freecad: join(process.cwd(), "adapters", "freecad", "freecad_cam_job.py"),
    blendercam: join(process.cwd(), "adapters", "blendercam", "blendercam_job.py"),
    camotics: join(process.cwd(), "adapters", "camotics", "camotics_job.js"),
    opencamlib: join(process.cwd(), "adapters", "opencamlib", "opencamlib_job.py")
  };
  return adapterScriptMap[engineId] ?? null;
}

function createAdapterCommandArgs(selectedEngine, scriptPath, jobPath, resultPath) {
  if (selectedEngine.id === "freecad") {
    return {
      command: selectedEngine.command,
      args: [scriptPath, jobPath, resultPath]
    };
  }
  if (selectedEngine.id === "blendercam") {
    return {
      command: selectedEngine.command,
      args: ["--background", "--python", scriptPath, "--", jobPath, resultPath]
    };
  }
  if (selectedEngine.id === "opencamlib") {
    return {
      command: selectedEngine.command ?? "python",
      args: [scriptPath, jobPath, resultPath]
    };
  }
  return {
    command: process.execPath,
    args: [scriptPath, jobPath, resultPath]
  };
}

function createSimulationSummary(toolpath, settings, selectedEngine) {
  const points = toolpath.points ?? [];
  const previewPoints = toolpath.previewPoints ?? [];
  const safeZ = Number(settings.safeZ ?? 0);
  const safeMoveCount = points.filter((point) => Number(point.z) >= safeZ * 0.92).length;
  const missCount = previewPoints.filter((point) => point.hit === false).length;
  const cuttingCount = Math.max(0, points.length - safeMoveCount);
  const coverageRate = points.length > 0 ? (cuttingCount / points.length) * 100 : 0;
  const fitRate = previewPoints.length > 0 ? ((previewPoints.length - missCount) / previewPoints.length) * 100 : 100;
  const maxDepth = points.reduce((max, point) => Math.max(max, Number(point.depth ?? 0)), 0);
  const zValues = points.map((point) => Number(point.z)).filter(Number.isFinite);
  const zMin = zValues.length ? Math.min(...zValues) : 0;
  const zMax = zValues.length ? Math.max(...zValues) : 0;
  const riskLevel = missCount > points.length * 0.08 || fitRate < 92 ? "review" : coverageRate < 82 ? "review" : "ready";

  return {
    engine: selectedEngine.id === "camotics" && selectedEngine.available ? "camotics-adapter-slot" : "internal-rotary-preview",
    mode: settings.camMode === "rotaryWrap" ? "rotary-wrap-airrun-preview" : settings.camMode === "3axis" ? "three-axis-preview" : "four-axis-preview",
    status: "completed",
    riskLevel,
    metrics: {
      points: points.length,
      previewPoints: previewPoints.length,
      safeMoveCount,
      cuttingCount,
      missCount,
      fitRate,
      coverageRate,
      maxDepth,
      zMin,
      zMax,
      estimatedMinutes: toolpath.estimatedMinutes
    },
    notes: [
      selectedEngine.id === "camotics" && selectedEngine.available
        ? "CAMotics adapter slot detected; current V3 still writes internal preview summary until adapter is enabled."
        : "CAMotics 未启用，当前使用自研旋转包裹/三轴预览摘要作为仿真层小闭环。",
      "air-run.nc 已将切削 Z 替换为安全高度，用于离料空跑验证轴向、夹具方向和行程。"
    ]
  };
}

function createServerAirRunGcode(points, settings, estimatedMinutes, sourceName) {
  const safePoints = points.map((point) => ({
    ...point,
    z: Number(settings.safeZ),
    depth: 0
  }));
  return toGcode(safePoints, { ...settings, spindleRpm: 0 }, estimatedMinutes, sourceName)
    .replace(/S\d+\s+M3/g, "M5")
    .replace(/\(Nuclear carving /, "(AIR RUN ONLY - Nuclear carving ");
}

function publicArtifactUrl(jobId, filename) {
  return `/orchestrator-jobs/${jobId}/${filename}`;
}

async function getOrchestratorJob(jobId, res) {
  const job = orchestratorJobs.get(jobId) ?? readJobManifest(jobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  return json(res, 200, job);
}

function listOrchestratorJobs(res) {
  const jobs = new Map();
  for (const job of orchestratorJobs.values()) {
    jobs.set(job.id, job);
  }

  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      if (manifest) jobs.set(manifest.id ?? entry.name, manifest);
    }
  }

  const items = [...jobs.values()]
    .map(createOrchestratorJobSummary)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 50);

  return json(res, 200, {
    jobs: items,
    queue: {
      queued: orchestratorQueue.length,
      running: orchestratorRunning,
      concurrency: maxOrchestratorConcurrency
    }
  });
}

function createOrchestratorJobSummary(job) {
  const statusFile = job.workDir ? join(job.workDir, "job-status.json") : null;
  const diskUpdatedAt = statusFile && existsSync(statusFile) ? statSync(statusFile).mtime.toISOString() : null;
  const summary = job.result?.summary ?? {};
  return {
    id: job.id,
    status: job.status,
    requestedEngine: job.requestedEngine,
    selectedEngine: job.selectedEngine,
    modelUrl: job.modelUrl,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt ?? diskUpdatedAt ?? job.createdAt,
    currentStage: job.currentStage ?? inferCurrentStage(job),
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : inferJobProgress(job),
    artifactCount: job.artifacts?.length ?? 0,
    latestLog: job.logs?.[job.logs.length - 1]?.message ?? "",
    resultEngine: job.result?.engine ?? null,
    fallbackFrom: job.result?.fallbackFrom ?? null,
    points: summary.points ?? null,
    estimatedMinutes: summary.estimatedMinutes ?? null,
    packageLevel: summary.productionGate?.level ?? summary.deliveryManifest?.packageLevel ?? null,
    repairStatus: summary.repairExecution?.status ?? null,
    preflightStatus: summary.adapterPreflight?.status ?? null,
    allowProductionNc: summary.productionGate?.allowProductionNc ?? false,
    allowTrialNc: summary.productionGate?.allowTrialNc ?? false,
    allowAirRun: summary.productionGate?.allowAirRun ?? false
  };
}

function inferCurrentStage(job) {
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job.status;
  const running = job.pipeline?.find((stage) => stage.status === "running");
  if (running) return running.id;
  const lastTouched = [...(job.pipeline ?? [])].reverse().find((stage) => stage.updatedAt);
  return lastTouched?.id ?? job.status ?? "queued";
}

function inferJobProgress(job) {
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return 100;
  if (!Array.isArray(job.pipeline) || job.pipeline.length === 0) return job.status === "queued" ? 0 : 8;
  const running = job.pipeline.find((stage) => stage.status === "running");
  if (running) return estimateOrchestratorProgress(job.pipeline, running.id, running.status);
  const lastTouched = [...job.pipeline].reverse().find((stage) => stage.updatedAt);
  return lastTouched ? estimateOrchestratorProgress(job.pipeline, lastTouched.id, lastTouched.status) : 0;
}

function getOrchestratorArtifact(jobId, filename, res) {
  const safeJobId = decodeURIComponent(jobId);
  const safeFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId) || !/^[a-zA-Z0-9_.-]+$/.test(safeFilename)) {
    return json(res, 400, { error: "非法 artifact 路径" });
  }
  const filePath = join(process.cwd(), "public", "orchestrator-jobs", safeJobId, safeFilename);
  if (!existsSync(filePath)) return json(res, 404, { error: "找不到 artifact 文件" });
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": artifactContentType(safeFilename),
    "Content-Length": content.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function artifactContentType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".nc") || lower.endsWith(".gcode") || lower.endsWith(".tap") || lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

async function writeJobManifest(job) {
  if (!job.workDir) return;
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "job-status.json"));
  const manifest = {
    ...job,
    result: job.result
      ? {
        ...job.result,
        toolpath: undefined
      }
      : null
  };
  await writeFile(join(job.workDir, "job-status.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function readJobManifest(jobId) {
  const filePath = join(process.cwd(), "public", "orchestrator-jobs", jobId, "job-status.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function pushIfArtifactExists(job, filename) {
  if (job?.workDir && existsSync(join(job.workDir, filename))) {
    pushUnique(job.artifacts, publicArtifactUrl(job.id, filename));
  }
}

function detectCamEngines() {
  return [
    detectCommandEngine({
      id: "freecad",
      name: "FreeCAD CAM",
      commands: ["FreeCADCmd", "freecadcmd", "FreeCAD", "freecad"],
      role: "专业 CAM job / Path Workbench adapter",
      adapterReady: true
    }),
    detectCommandEngine({
      id: "blendercam",
      name: "BlenderCAM / FabexCNC",
      commands: ["blender"],
      role: "艺术曲面/浮雕 CAM adapter",
      adapterReady: true
    }),
    detectCommandEngine({
      id: "camotics",
      name: "CAMotics",
      commands: ["camotics-cli", "camotics"],
      role: "材料去除仿真 adapter",
      adapterReady: false
    }),
    detectOpenCamLibEngine(),
    {
      id: "internal-mesh-cam",
      name: "HeDiao3D internal Mesh CAM",
      role: "V3 fallback and rotary-wrap postprocess baseline",
      available: true,
      adapterReady: true,
      command: "node",
      version: "built-in",
      notes: "用于外部 CAM 未安装时的小闭环验证；正式 V3 将优先调用 FreeCAD/BlenderCAM/CAMotics。"
    }
  ];
}

function detectOpenCamLibEngine() {
  const pythonCommands = ["python", "python3", "py"];
  for (const command of pythonCommands) {
    const probe = spawnSync(command, ["-c", "import importlib.util; import sys; mod = importlib.util.find_spec('opencamlib') or importlib.util.find_spec('ocl'); print('opencamlib' if mod else 'missing'); sys.exit(0 if mod else 3)"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2500
    });
    if (!probe.error && probe.status === 0) {
      return {
        id: "opencamlib",
        name: "OpenCAMLib",
        role: "底层刀具接触/drop-cutter 算法库 adapter",
        available: true,
        adapterReady: false,
        command,
        version: String(probe.stdout ?? "").trim() || "python module detected",
        notes: "已检测到 Python OpenCAMLib 模块；adapter 仍需补齐 drop-cutter/水线配方后才能替换内置采样。"
      };
    }
  }

  return {
    id: "opencamlib",
    name: "OpenCAMLib",
    role: "底层刀具接触/drop-cutter 算法库 adapter",
    available: false,
    adapterReady: false,
    command: null,
    version: null,
    notes: "未检测到 Python OpenCAMLib/ocl 模块；后续可在 Linux 服务端安装后启用几何内核 adapter。"
  };
}

function detectCommandEngine({ id, name, commands, role, adapterReady }) {
  for (const command of commands) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 2500 });
    if (!probe.error || probe.status === 0) {
      return {
        id,
        name,
        role,
        available: true,
        adapterReady,
        command,
        version: `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split(/\r?\n/).slice(0, 2).join(" | ") || "detected",
        notes: adapterReady ? "adapter ready" : "已检测到命令，但 V3 仍需补齐脚本化 adapter。"
      };
    }
  }

  return {
    id,
    name,
    role,
    available: false,
    adapterReady,
    command: null,
    version: null,
    notes: "本机未检测到该引擎命令；可在服务器安装后由 Orchestrator 调用。"
  };
}

function selectCamEngine(engines, requestedEngine, settings = {}) {
  if (requestedEngine && requestedEngine !== "auto") {
    return engines.find((engine) => engine.id === requestedEngine) ?? engines.find((engine) => engine.id === "internal-mesh-cam");
  }
  const preferredExternalId = settings.camMode === "3axis" ? "freecad" : "blendercam";
  return engines.find((engine) => engine.available && engine.adapterReady && engine.id !== "internal-mesh-cam")
    ?? engines.find((engine) => engine.id === preferredExternalId)
    ?? engines.find((engine) => engine.id === "internal-mesh-cam");
}

function appendOrchestratorLog(job, message) {
  job.logs.push({ time: new Date().toISOString(), message });
  job.updatedAt = new Date().toISOString();
}

async function importLocalMesh(req, res) {
  const input = await readJson(req, 90_000_000);
  const filename = String(input.filename ?? "imported-model").replace(/[\\/:*?"<>|]/g, "_");
  const dataUrl = String(input.dataUrl ?? "");
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension || !["stl", "glb", "gltf"].includes(extension)) {
    return json(res, 400, { error: "当前后端 CAM 支持导入 .stl/.glb/.gltf 模型" });
  }
  const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() : dataUrl;
  if (!base64) return json(res, 400, { error: "模型文件内容为空" });

  const dir = join(process.cwd(), "public", "imported-models");
  await mkdir(dir, { recursive: true });
  const safeName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${filename}`;
  const filePath = join(dir, safeName);
  await writeFile(filePath, Buffer.from(base64, "base64"));
  const publicUrl = `/imported-models/${safeName}`;
  return json(res, 200, {
    modelUrl: publicUrl,
    camModelUrl: publicUrl,
    format: extension,
    message: `${filename} 已上传到本地 CAM 缓存`
  });
}

function isAllowedLocalModelUrl(modelUrl) {
  if (modelUrl.includes("..")) return false;
  return modelUrl.startsWith("/meshy-results/") || modelUrl.startsWith("/imported-models/");
}

function normalizeServerCamSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const normalized = { ...settings };
  if (normalized.camMode === "rotaryWrap") {
    if (normalized.postProcessor === "rotary-y-wrap" || normalized.postProcessor === "wrap-y") normalized.postProcessor = "wrapY";
    if (normalized.postProcessor === "rotary-x-wrap" || normalized.postProcessor === "wrap-x") normalized.postProcessor = "wrapX";
    if (!normalized.postProcessor || normalized.postProcessor === "generic") {
      normalized.postProcessor = normalized.rotaryOutputAxis === "X" ? "wrapX" : normalized.rotaryOutputAxis === "Y" ? "wrapY" : "generic";
    }
  }
  return normalized;
}

function localModelUrlToPath(modelUrl) {
  return join(process.cwd(), "public", modelUrl.replace(/^\//, ""));
}

async function loadModelGeometry(modelPath) {
  const file = readFileSync(modelPath);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const lower = modelPath.toLowerCase();
  if (lower.endsWith(".stl")) return new STLLoader().parse(buffer);
  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) return loadGltfGeometry(buffer);
  throw new Error("不支持的 Mesh 格式，当前支持 STL/GLB/GLTF");
}

function loadGltfGeometry(buffer) {
  return new Promise((resolve, reject) => {
    globalThis.self ??= globalThis;
    const loader = new GLTFLoader();
    const geometryOnlySource = stripGltfMaterialsForCam(buffer);
    loader.parse(geometryOnlySource, "", (gltf) => {
      const geometries = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        let geometry = child.geometry.clone();
        geometry.applyMatrix4(child.matrixWorld);
        if (geometry.index) {
          const nonIndexed = geometry.toNonIndexed();
          geometry.dispose();
          geometry = nonIndexed;
        }
        geometries.push(geometry);
      });
      if (geometries.length === 0) {
        reject(new Error("GLB 中没有可用 Mesh 几何"));
        return;
      }
      const merged = mergeGeometries(geometries, false);
      geometries.forEach((geometry) => geometry.dispose());
      if (!merged) {
        reject(new Error("GLB Mesh 合并失败"));
        return;
      }
      resolve(merged);
    }, reject);
  });
}

function stripGltfMaterialsForCam(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const glbMagic = 0x46546c67;

  if (bytes.byteLength >= 20 && view.getUint32(0, true) === glbMagic) {
    const version = view.getUint32(4, true);
    if (version !== 2) return buffer;

    const chunks = [];
    let offset = 12;
    let jsonChunkIndex = -1;
    while (offset + 8 <= bytes.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end > bytes.byteLength) break;
      const data = bytes.slice(start, end);
      if (type === 0x4e4f534a) jsonChunkIndex = chunks.length;
      chunks.push({ type, data });
      offset = end + ((4 - (length % 4)) % 4);
    }

    if (jsonChunkIndex === -1) return buffer;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const jsonText = decoder.decode(chunks[jsonChunkIndex].data).trim();
    const strippedJson = stripGltfMaterialJson(JSON.parse(jsonText));
    chunks[jsonChunkIndex] = {
      type: 0x4e4f534a,
      data: padBytes(encoder.encode(JSON.stringify(strippedJson)), 0x20)
    };

    const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.byteLength, 0);
    const output = new Uint8Array(totalLength);
    const outputView = new DataView(output.buffer);
    outputView.setUint32(0, glbMagic, true);
    outputView.setUint32(4, 2, true);
    outputView.setUint32(8, totalLength, true);
    let writeOffset = 12;
    for (const chunk of chunks) {
      outputView.setUint32(writeOffset, chunk.data.byteLength, true);
      outputView.setUint32(writeOffset + 4, chunk.type, true);
      output.set(chunk.data, writeOffset + 8);
      writeOffset += 8 + chunk.data.byteLength;
    }
    return output.buffer;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const text = decoder.decode(bytes).trim();
  return encoder.encode(JSON.stringify(stripGltfMaterialJson(JSON.parse(text)))).buffer;
}

function stripGltfMaterialJson(json) {
  const clone = structuredClone(json);
  delete clone.materials;
  delete clone.textures;
  delete clone.images;
  delete clone.samplers;

  for (const mesh of clone.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      delete primitive.material;
    }
  }

  return clone;
}

function padBytes(bytes, paddingByte) {
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  if (padding === 0) return bytes;
  const output = new Uint8Array(bytes.byteLength + padding);
  output.set(bytes);
  output.fill(paddingByte, bytes.byteLength);
  return output;
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

function readJson(req, limit = 25_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
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
  if (settings.camMode === "3axis") {
    return generateMeshTopSurfaceToolpath(mesh, settings);
  }

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

  if (settings.camMode === "rotaryWrap") {
    const axis = settings.rotaryOutputAxis || "Y";
    warnings.push(`Mesh CAM 已按旋转包裹生成，${axis}轴驱动夹具，${fmt(settings.rotaryWrapPerRevolutionMm ?? 100, 3)}mm/圈；首次实机请务必空跑并低进给试雕。`);
  } else {
    warnings.push("Mesh CAM 已按模型外表面采样生成；首次实机请务必空跑并使用低进给试雕。");
  }

  const travelMm = estimateTravel(points, machineRadius);
  const estimatedMinutes = travelMm / Math.max(1, Number(settings.feedRate));
  const gcode = toGcode(points, settings, estimatedMinutes, "Meshy STL surface CAM");

  return {
    points,
    previewPoints: limitPreviewPoints(previewPoints),
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: postProcessorName(settings.postProcessor),
    summary: summarizePoints(points, warnings)
  };
}

function generateMeshTopSurfaceToolpath(mesh, settings) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const lengthAxis = selectLengthAxis(size, settings.meshLengthAxis);
  const widthAxis = selectWidthAxis(size, lengthAxis);
  const heightAxis = ["x", "y", "z"].find((axis) => axis !== lengthAxis && axis !== widthAxis) ?? "z";
  const halfLength = Number(settings.lengthMm) / 2;
  const halfWidth = Number(settings.diameterMm) / 2;
  const xSteps = Math.max(2, Math.ceil(Number(settings.lengthMm) / Number(settings.stepoverMm)));
  const ySteps = Math.max(2, Math.ceil(Number(settings.diameterMm) / Number(settings.stepoverMm)));
  const castHeight = axisValue(size, heightAxis) * 2.2 + 1;
  const displayScale = 3.2 / Math.max(size.x, size.y, size.z, 0.001);
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const points = [];
  const previewPoints = [];
  const warnings = [];
  let missCount = 0;

  for (let yIndex = 0; yIndex <= ySteps; yIndex += 1) {
    const serpentine = yIndex % 2 === 1;
    const yRatio = yIndex / ySteps;
    const y = -halfWidth + yRatio * Number(settings.diameterMm);

    for (let xStep = 0; xStep <= xSteps; xStep += 1) {
      const xIndex = serpentine ? xSteps - xStep : xStep;
      const rawU = xIndex / xSteps;
      const u = settings.meshAxisReverse ? 1 - rawU : rawU;
      const x = -halfLength + rawU * Number(settings.lengthMm);
      const origin = center.clone();
      setAxisValue(origin, lengthAxis, axisValue(box.min, lengthAxis) + u * axisValue(size, lengthAxis));
      setAxisValue(origin, widthAxis, axisValue(box.min, widthAxis) + yRatio * axisValue(size, widthAxis));
      setAxisValue(origin, heightAxis, axisValue(box.max, heightAxis) + castHeight);
      const direction = new THREE.Vector3();
      setAxisValue(direction, heightAxis, -1);
      raycaster.set(origin, direction);
      const hit = raycaster.intersectObject(mesh, false)[0];

      let z = Number(settings.safeZ);
      let depth = 0;
      if (hit) {
        const heightFromTop = axisValue(box.max, heightAxis) - axisValue(hit.point, heightAxis);
        depth = THREE.MathUtils.clamp(heightFromTop * (Number(settings.depthMm) / Math.max(axisValue(size, heightAxis), 0.001)), 0, Number(settings.depthMm));
        z = -depth;
        previewPoints.push(toDisplayPreviewPoint(hit, center, displayScale));
      } else {
        missCount += 1;
        previewPoints.push(toDisplayMissPoint(origin, center, displayScale));
      }

      points.push({ x, y, a: 0, z, depth });
    }
  }

  if (missCount > 0) warnings.push(`Mesh顶面采样有 ${missCount} 个点未命中，已抬到安全Z；请检查模型朝向和三轴投影范围。`);
  if (Number(settings.stepoverMm) > Number(settings.toolDiameter) * 0.45) warnings.push("三轴步距偏大，尖刀精加工可能留下明显刀痕。");
  warnings.push("Mesh CAM 已按三轴顶面投影生成 X/Y/Z 刀路；首次实机请务必空跑并使用低进给试雕。");

  const travelMm = estimateTravel(points, 0);
  const estimatedMinutes = travelMm / Math.max(1, Number(settings.feedRate));
  const gcode = toGcode(points, settings, estimatedMinutes, "Meshy STL 3-axis top-surface CAM");

  return {
    points,
    previewPoints: limitPreviewPoints(previewPoints),
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: postProcessorName(settings.postProcessor),
    summary: summarizePoints(points, warnings)
  };
}

function limitPreviewPoints(previewPoints) {
  if (previewPoints.length <= maxToolpathPreviewPoints) return previewPoints;
  const stride = Math.ceil(previewPoints.length / maxToolpathPreviewPoints);
  return previewPoints.filter((_, index) => index % stride === 0);
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

function selectWidthAxis(size, lengthAxis) {
  const candidates = ["x", "y", "z"].filter((axis) => axis !== lengthAxis);
  return axisValue(size, candidates[0]) >= axisValue(size, candidates[1]) ? candidates[0] : candidates[1];
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
    yMin: Number.POSITIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
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
      yMin: Math.min(acc.yMin, point.y ?? 0),
      yMax: Math.max(acc.yMax, point.y ?? 0),
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
    const dy = (next.y ?? 0) - (prev.y ?? 0);
    const dz = next.z - prev.z;
    const da = ((next.a - prev.a) * Math.PI) / 180;
    const arc = Math.abs(da) * radius;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz + arc * arc);
  }
  return total;
}

function postProcessorName(postProcessor) {
  if (postProcessor === "generic3") return "通用三轴 G-code";
  if (postProcessor === "wrapY" || postProcessor === "rotary-y-wrap" || postProcessor === "wrap-y") return "Y轴旋转包裹 G-code";
  if (postProcessor === "wrapX" || postProcessor === "rotary-x-wrap" || postProcessor === "wrap-x") return "X轴旋转包裹 G-code";
  if (postProcessor === "weihong") return "维宏风格 G-code";
  if (postProcessor === "syntec") return "新代风格 G-code";
  return "通用四轴 G-code";
}

function fmt(value, digits = 4) {
  return Number(value).toFixed(digits);
}

function toGcode(points, settings, estimatedMinutes, sourceName) {
  if (settings.camMode === "3axis") return toThreeAxisGcode(points, settings, estimatedMinutes, sourceName);
  if (settings.camMode === "rotaryWrap") return toRotaryWrapGcode(points, settings, estimatedMinutes, sourceName);

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

function toThreeAxisGcode(points, settings, estimatedMinutes, sourceName) {
  const tool = describeTool(settings);
  const lines = [
    "%",
    `(Nuclear carving ${sourceName} - ${postProcessorName(settings.postProcessor)})`,
    "(Coordinate: X/Y table axes, Z spindle axis; workpiece top is Z0, cutting Z is negative)",
    `(Length=${fmt(settings.lengthMm, 3)}mm Width=${fmt(settings.diameterMm, 3)}mm Tool=${tool.name} Diameter=${fmt(settings.toolDiameter, 3)}mm${tool.geometry})`,
    `(Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    "(POST: GENERIC 3AXIS)",
    `F${fmt(settings.feedRate, 1)}`,
    `S${Math.round(Number(settings.spindleRpm))} M3`,
    `G0 Z${fmt(settings.safeZ)}`
  ];

  if (points.length > 0) {
    lines.push(`G0 X${fmt(points[0].x)} Y${fmt(points[0].y ?? 0)}`);
    lines.push(`G1 Z${fmt(points[0].z)} F${fmt(Number(settings.feedRate) * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 X${fmt(point.x)} Y${fmt(point.y ?? 0)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push("M5", "M30", "%");
  return `${lines.join("\n")}\n`;
}

function describeTool(settings) {
  if (settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg") {
    return {
      name: "4mm 25deg flat-tip V-bit",
      geometry: " Type=VBIT Angle=25.0deg FlatTip=0.400mm"
    };
  }

  return {
    name: settings.toolProfileId ?? "custom tool",
    geometry: ""
  };
}

function postStart(settings) {
  if (settings.postProcessor === "generic3") return ["(POST: GENERIC 3AXIS)", "G17", `F${fmt(settings.feedRate, 1)}`, `S${Math.round(Number(settings.spindleRpm))} M3`, `G0 Z${fmt(settings.safeZ)}`];
  if (settings.postProcessor === "wrapY" || settings.postProcessor === "wrapX" || settings.postProcessor === "rotary-y-wrap" || settings.postProcessor === "rotary-x-wrap" || settings.postProcessor === "wrap-y" || settings.postProcessor === "wrap-x") {
    return [
      `(POST: ROTARY WRAP ${settings.rotaryOutputAxis || (settings.postProcessor === "wrapX" ? "X" : "Y")}-AXIS)`,
      "(Rotary angle is mapped to linear axis by rotaryWrapPerRevolutionMm)",
      `F${fmt(settings.feedRate, 1)}`,
      `S${Math.round(Number(settings.spindleRpm))} M3`,
      `G0 Z${fmt(settings.safeZ)}`
    ];
  }
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
  const hasY = points.some((point) => point.y != null);
  const rows = [hasY ? "x_mm,y_mm,z_mm,mesh_surface_depth_mm" : "x_mm,a_deg,z_mm,mesh_surface_depth_mm"];
  for (const point of points) {
    rows.push(hasY ? `${fmt(point.x)},${fmt(point.y ?? 0)},${fmt(point.z)},${fmt(point.depth)}` : `${fmt(point.x)},${fmt(point.a, 3)},${fmt(point.z)},${fmt(point.depth)}`);
  }
  return `${rows.join("\n")}\n`;
}

function toRotaryWrapGcode(points, settings, estimatedMinutes, sourceName) {
  const rotaryAxis = settings.rotaryOutputAxis || (settings.postProcessor === "wrapX" || settings.postProcessor === "rotary-x-wrap" || settings.postProcessor === "wrap-x" ? "X" : settings.postProcessor === "wrapY" || settings.postProcessor === "rotary-y-wrap" || settings.postProcessor === "wrap-y" ? "Y" : "A");
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const lengthAxis = rotaryAxis === "X" ? "Y" : "X";
  const rotaryWord = (aDeg) => {
    if (rotaryAxis === "A") return `A${fmt(aDeg, 3)}`;
    return `${rotaryAxis}${fmt((Number(aDeg) / 360) * wrapPerRev, 4)}`;
  };
  const lengthWord = (x) => `${lengthAxis}${fmt(x)}`;
  const lines = [
    "%",
    `(Nuclear carving rotary wrap ${sourceName} - ${postProcessorName(settings.postProcessor)})`,
    `(Coordinate: ${lengthAxis}=length axis, ${rotaryAxis}=rotary fixture${rotaryAxis === "A" ? " angle deg" : ` linearized, ${fmt(wrapPerRev, 3)}mm per 360deg`}, Z=radial tool center)`,
    `(ROTARY_WRAP_AXIS=${rotaryAxis} ROTARY_WRAP_PER_REV_MM=${fmt(wrapPerRev, 6)} LENGTH_AXIS=${lengthAxis})`,
    `(Length=${fmt(settings.lengthMm, 3)}mm Diameter=${fmt(settings.diameterMm, 3)}mm ToolDiameter=${fmt(settings.toolDiameter, 3)}mm)`,
    `(Estimated=${fmt(estimatedMinutes, 2)}min)`,
    "G21",
    "G90",
    "G94",
    ...postStart(settings)
  ];

  if (points.length > 0) {
    lines.push(`G0 ${lengthWord(points[0].x)} ${rotaryWord(points[0].a)} Z${fmt(settings.safeZ)}`);
    lines.push(`G1 Z${fmt(points[0].z)} F${fmt(Number(settings.feedRate) * 0.45, 1)}`);
  }

  for (const point of points) {
    lines.push(`G1 ${lengthWord(point.x)} ${rotaryWord(point.a)} Z${fmt(point.z)} F${fmt(settings.feedRate, 1)}`);
  }

  lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(...postEnd(settings));
  lines.push("%");
  return `${lines.join("\n")}\n`;
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
