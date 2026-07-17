import { createServer } from "node:http";
import { copyFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
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

    if (req.method === "GET" && req.url === "/api/orchestrator/readiness/latest") {
      return getLatestV3Readiness(res);
    }

    if (req.method === "GET" && req.url === "/api/orchestrator/readiness/runbook-result/latest") {
      return getLatestV3RunbookResult(res);
    }

    if (req.method === "POST" && req.url === "/api/orchestrator/readiness") {
      return createV3ReadinessReport(req, res);
    }

    if (req.method === "GET" && req.url === "/api/orchestrator/adapter-validation/latest") {
      return getLatestAdapterValidation(res);
    }

    if (req.method === "POST" && req.url === "/api/orchestrator/adapter-validation") {
      return runAdapterValidation(req, res);
    }

    if (req.method === "GET" && req.url === "/api/orchestrator/native-cam/latest") {
      return getLatestNativeCamReadiness(res);
    }

    if (req.method === "POST" && req.url === "/api/orchestrator/native-cam") {
      return runNativeCamReadinessCheck(req, res);
    }

    if (req.method === "POST" && req.url === "/api/orchestrator/native-cam/real-output-acceptance") {
      return importNativeCamRealOutputAcceptance(req, res);
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

    const orchestratorTrialFeedbackMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/trial-feedback$/);
    if (req.method === "POST" && orchestratorTrialFeedbackMatch) {
      return createOrchestratorTrialFeedback(req, orchestratorTrialFeedbackMatch[1], res);
    }

    const orchestratorMachineAcceptanceMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/machine-acceptance$/);
    if (req.method === "POST" && orchestratorMachineAcceptanceMatch) {
      return createOrchestratorMachineAcceptance(req, orchestratorMachineAcceptanceMatch[1], res);
    }

    const orchestratorCamoticsResultMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/camotics-result$/);
    if (req.method === "POST" && orchestratorCamoticsResultMatch) {
      return importOrchestratorCamoticsResult(req, orchestratorCamoticsResultMatch[1], res);
    }

    const orchestratorCamoticsCliPackageMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/camotics-cli-package$/);
    if (req.method === "POST" && orchestratorCamoticsCliPackageMatch) {
      return createOrchestratorCamoticsCliPackage(orchestratorCamoticsCliPackageMatch[1], res);
    }

    const orchestratorCamoticsLinuxPackageMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/camotics-linux-package$/);
    if (req.method === "GET" && orchestratorCamoticsLinuxPackageMatch) {
      return getOrchestratorCamoticsLinuxPackage(orchestratorCamoticsLinuxPackageMatch[1], res);
    }

    const orchestratorTrialPackageMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/trial-package$/);
    if (req.method === "GET" && orchestratorTrialPackageMatch) {
      return getOrchestratorTrialPackage(orchestratorTrialPackageMatch[1], res);
    }

    const orchestratorProductionPackageMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/production-package$/);
    if (req.method === "GET" && orchestratorProductionPackageMatch) {
      return getOrchestratorProductionPackage(orchestratorProductionPackageMatch[1], res);
    }

    const orchestratorNeutralToolpathMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/neutral-toolpath$/);
    if (req.method === "POST" && orchestratorNeutralToolpathMatch) {
      return importOrchestratorNeutralToolpath(req, orchestratorNeutralToolpathMatch[1], res);
    }

    const orchestratorArtifactMatch = req.url?.match(/^\/api\/orchestrator\/jobs\/([^/?#/]+)\/artifacts\/([^/?#/]+)$/);
    if (req.method === "GET" && orchestratorArtifactMatch) {
      return getOrchestratorArtifact(orchestratorArtifactMatch[1], orchestratorArtifactMatch[2], res);
    }

    const adapterValidationArtifactMatch = req.url?.match(/^\/api\/orchestrator\/adapter-validation\/([^/?#/]+)\/([^/?#/]+)$/);
    if (req.method === "GET" && adapterValidationArtifactMatch) {
      return getAdapterValidationArtifact(adapterValidationArtifactMatch[1], adapterValidationArtifactMatch[2], res);
    }

    const nativeCamServerPackageMatch = req.url?.match(/^\/api\/orchestrator\/native-cam\/([^/?#/]+)\/server-package\.zip$/);
    if (req.method === "GET" && nativeCamServerPackageMatch) {
      return getNativeCamServerPackage(nativeCamServerPackageMatch[1], res);
    }

    const nativeCamArtifactMatch = req.url?.match(/^\/api\/orchestrator\/native-cam\/([^/?#/]+)\/([^/?#/]+)$/);
    if (req.method === "GET" && nativeCamArtifactMatch) {
      return getNativeCamReadinessArtifact(nativeCamArtifactMatch[1], nativeCamArtifactMatch[2], res);
    }

    const readinessArtifactMatch = req.url?.match(/^\/api\/orchestrator\/readiness\/([^/?#/]+)\/([^/?#/]+)$/);
    if (req.method === "GET" && readinessArtifactMatch) {
      return getV3ReadinessArtifact(readinessArtifactMatch[1], readinessArtifactMatch[2], res);
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
  return json(res, 200, await createOrchestratorDiagnosticsReport());
}

async function createOrchestratorDiagnosticsReport() {
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

  return {
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
  };
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

async function createV3ReadinessReport(req, res) {
  await readJson(req, 100_000).catch(() => ({}));
  const reportId = `readiness-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = join(process.cwd(), "public", "orchestrator-readiness", reportId);
  await mkdir(outputRoot, { recursive: true });
  const report = await buildV3ReadinessReport(reportId, outputRoot);
  await writeFile(join(outputRoot, "v3-readiness-report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(outputRoot, "v3-readiness-report.md"), createV3ReadinessMarkdown(report), "utf8");
  await writeFile(join(outputRoot, "v3-acceptance-runbook.sh"), createV3AcceptanceRunbookShell(report), "utf8");
  return json(res, 200, createV3ReadinessPublicSummary(report, reportId));
}

function getLatestV3Readiness(res) {
  const root = join(process.cwd(), "public", "orchestrator-readiness");
  if (!existsSync(root)) return json(res, 200, { latest: null, reports: [] });
  const reports = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readV3ReadinessSummary(entry.name))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .slice(0, 12);
  return json(res, 200, {
    latest: reports[0] ?? null,
    reports
  });
}

async function buildV3ReadinessReport(reportId, outputRoot) {
  const createdAt = new Date().toISOString();
  const diagnostics = await createOrchestratorDiagnosticsReport();
  const nativeCam = readLatestFromDirectory("public/native-cam-readiness", "native-cam-readiness.json", createNativeCamReadinessPublicSummary);
  const adapterValidation = readLatestFromDirectory("public/orchestrator-adapter-validation", "v3-external-adapter-validation.json", createAdapterValidationPublicSummary);
  const nativeCamRealOutputAcceptance = readLatestFromDirectory("public/orchestrator-adapter-validation", "native-cam-real-output-acceptance.json", createNativeCamRealOutputAcceptancePublicSummary);
  const runbookResult = readLatestV3RunbookResultSummary();
  const externalHandoff = getLatestExternalHandoffJobSummary();
  const externalCamHandoffs = getExternalCamHandoffSummaries();
  const neutralImport = readLatestFromDirectory("public/orchestrator-neutral-import", "neutral-import-contract.json", createNeutralImportContractPublicSummary);
  const camoticsImport = readLatestFromDirectory("public/orchestrator-camotics-import", "camotics-import-contract.json", createCamoticsImportContractPublicSummary);
  const postprocessHandoffReadiness = createV3PostprocessHandoffReadiness({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport });
  const latestJob = getLatestOrchestratorJobSummary();
  const latestEvidenceDossier = getLatestProductionEvidenceDossierSummary();
  const readinessCamoticsEvidence = createReadinessCamoticsEvidence({ camoticsImport, latestEvidenceDossier });
  const latestTrialFeedback = getLatestJobLogSummary("trial-feedback-log.json", createTrialFeedbackLogPublicSummary);
  const latestMachineAcceptance = getLatestJobLogSummary("machine-acceptance-log.json", createMachineAcceptanceLogPublicSummary);
  const camServerConfig = createDeploymentCamServerConfigReport(reportId);
  await writeFile(join(outputRoot, "cam-server-config.json"), JSON.stringify(camServerConfig, null, 2), "utf8");
  const gates = createV3ReadinessGates({ diagnostics, nativeCam, adapterValidation, nativeCamRealOutputAcceptance, runbookResult, camServerConfig, externalHandoff, externalCamHandoffs, neutralImport, camoticsImport, readinessCamoticsEvidence, latestJob, latestTrialFeedback, latestMachineAcceptance, latestEvidenceDossier });
  const acceptancePlan = createV3DeploymentAcceptancePlan({ gates, diagnostics, nativeCam, adapterValidation, nativeCamRealOutputAcceptance, runbookResult, camServerConfig, externalHandoff, externalCamHandoffs, neutralImport, camoticsImport, readinessCamoticsEvidence, latestJob, latestTrialFeedback, latestMachineAcceptance, latestEvidenceDossier });
  return {
    schema: "hediao3d.v3-readiness-report.v1",
    id: reportId,
    createdAt,
    outputRoot,
    level: gates.level,
    summary: gates.summary,
    gates,
    acceptancePlan,
    diagnostics,
    nativeCam,
    camServerConfig,
    adapterValidation,
    nativeCamRealOutputAcceptance,
    runbookResult,
    externalHandoff,
    externalCamHandoffs,
    neutralImport,
    postprocessHandoffReadiness,
    camoticsImport,
    readinessCamoticsEvidence,
    latestJob,
    latestTrialFeedback,
    latestMachineAcceptance,
    latestEvidenceDossier,
    apiArtifacts: createV3ReadinessArtifactLinks(reportId)
  };
}

function createDeploymentCamServerConfigReport(reportId) {
  const settings = normalizeServerCamSettings({
    camMode: "rotaryWrap",
    rotaryOutputAxis: "Y",
    postProcessor: "wrapY",
    rotaryWrapPerRevolutionMm: 100,
    machineProfileId: "desktop-3axis-rotary-y"
  });
  const engines = detectCamEngines();
  const selected = selectCamEngine(engines, "auto", settings);
  const engineReadiness = createEngineReadinessReport(engines, selected, settings);
  const nativeCamReadiness = createNativeCamReadinessReport(engines, selected, settings, engineReadiness);
  return createCamServerConfigReport({
    job: { id: reportId },
    settings,
    engines,
    selectedEngine: selected,
    nativeCamReadiness,
    engineReadiness
  });
}

function createV3ReadinessGates({ diagnostics, nativeCam, adapterValidation, nativeCamRealOutputAcceptance, runbookResult, camServerConfig, externalHandoff, externalCamHandoffs, neutralImport, camoticsImport, readinessCamoticsEvidence, latestJob, latestTrialFeedback, latestMachineAcceptance, latestEvidenceDossier }) {
  const blockers = [];
  const warnings = [];
  const nextActions = [];

  if (diagnostics.level === "critical") {
    blockers.push(`Orchestrator 自检 critical：${diagnostics.summary}`);
  } else if (diagnostics.level === "warning") {
    warnings.push(diagnostics.summary);
  }
  nextActions.push(...(diagnostics.recommendedActions ?? []));

  if (!camServerConfig) {
    warnings.push("尚未生成 CAM 服务器配置矩阵。");
    nextActions.push("重新生成 V3 总门禁，下载 cam-server-config.json 作为 Linux CAM 服务端部署清单。");
  } else if (camServerConfig.status === "missing-native-dependencies") {
    warnings.push(`CAM 服务器缺少 Native 依赖：${camServerConfig.missingRequired.join("；") || "未知"}`);
    nextActions.push("按 cam-server-config.json 配置 FreeCAD/BlenderCAM/OpenCAMLib/CAMotics 命令和环境变量。");
  } else if (camServerConfig.status === "installed-but-adapters-disabled") {
    warnings.push("CAM Native 依赖已具备，但 ENABLE_EXTERNAL_CAM_ADAPTERS 尚未启用。");
    nextActions.push("完成小模型外部 CAM 验收后设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true。");
  }

  if (!nativeCam) {
    warnings.push("尚未运行 Native CAM 环境验收。");
    nextActions.push("在 V3 面板点击“验收Native CAM”，或运行 npm run test:v3:native-cam。");
  } else if (nativeCam.summary.level !== "ready") {
    warnings.push(`Native CAM 未就绪：${nativeCam.summary.readyCount}/${nativeCam.summary.requiredCount}，${nativeCam.summary.level}`);
    nextActions.push(...(nativeCam.summary.nextActions ?? []));
  }

  if (!adapterValidation) {
    warnings.push("尚未运行外部 Adapter 验证。");
    nextActions.push("先运行安全模板 Adapter 验证，再在 CAM 服务器上运行 Native 验证。");
  } else {
    const handoffAudit = adapterValidation.handoffClassificationAudit;
    if (adapterValidation.overall.failed > 0) blockers.push(`Adapter 验证失败 ${adapterValidation.overall.failed} 项。`);
    if (!handoffAudit) {
      warnings.push("Adapter 验证缺少 handoff 分类审计，无法判断外部输出是否为生产候选。");
      nextActions.push("重新运行 npm run test:v3:external-adapters，生成 handoffClassificationAudit。");
    } else {
      if (handoffAudit.unsafeCount > 0) blockers.push(`Adapter handoff 分类存在 ${handoffAudit.unsafeCount} 个 unsafe 输出：${handoffAudit.summary}`);
      if (handoffAudit.unboundProductionCandidateCount > 0) {
        blockers.push(`Adapter handoff 存在 ${handoffAudit.unboundProductionCandidateCount} 个未绑定输入哈希的 production-candidate contact report。`);
        nextActions.push("查看 v3-external-adapter-validation.json 的 contactReport.inputBindingStatus，确认真实 OpenCAMLib 接触报告绑定当前模型/计划/neutral 输出哈希。");
      }
      if (handoffAudit.productionCandidateCount === 0) warnings.push("Adapter handoff 尚无 production-candidate 输出，不能作为真实 CAM 生产证据。");
      nextActions.push(...(handoffAudit.nextActions ?? []));
    }
    if (adapterValidation.overall.completedAdapters === 0) {
      warnings.push("Adapter 还没有 completed 外部输出，当前仍依赖内置 fallback。");
    }
    if (!adapterValidation.overall.readyForProduction) {
      nextActions.push(adapterValidation.overall.note ?? "继续完成外部 CAM adapter 的真实输出验收。");
    }
  }

  if (!nativeCamRealOutputAcceptance) {
    warnings.push("尚未运行 Native CAM 真实输出验收，当前无法证明外部 CAM 已产生 production-candidate 输出。");
    nextActions.push("在 Linux CAM 服务器运行 bash native-cam-real-output-check.sh，并保留 native-cam-real-output-acceptance.json。");
  } else if (nativeCamRealOutputAcceptance.sourceReportBindingRequired && nativeCamRealOutputAcceptance.sourceReportBindingStatus !== "matched") {
    blockers.push(`Native CAM 真实输出验收缺少源报告绑定：${nativeCamRealOutputAcceptance.sourceReportBindingSummary}`);
    nextActions.push("导入 native-cam-real-output-acceptance.json 时同时随附 v3-external-adapter-validation.json，或重新运行 native-cam-real-output-check.sh 生成 sourceReportIdentity。");
  } else if (nativeCamRealOutputAcceptance.level === "critical") {
    blockers.push(`Native CAM 真实输出验收未通过：${nativeCamRealOutputAcceptance.blockers[0] ?? nativeCamRealOutputAcceptance.summary}`);
    nextActions.push(...(nativeCamRealOutputAcceptance.nextActions ?? []));
  } else if (nativeCamRealOutputAcceptance.level !== "ready") {
    warnings.push(`Native CAM 真实输出验收需要复核：${nativeCamRealOutputAcceptance.summary}`);
    nextActions.push(...(nativeCamRealOutputAcceptance.nextActions ?? []));
  } else if (adapterValidation?.handoffClassificationAudit) {
    const handoffAudit = adapterValidation.handoffClassificationAudit;
    if (handoffAudit.unsafeCount > 0 || handoffAudit.productionCandidateCount === 0 || handoffAudit.unboundProductionCandidateCount > 0) {
      blockers.push(`Native CAM 真实输出验收为 ready，但最新 Adapter handoff 审计仍不一致：productionCandidate=${handoffAudit.productionCandidateCount}，unsafe=${handoffAudit.unsafeCount}，unboundContact=${handoffAudit.unboundProductionCandidateCount ?? 0}。`);
      nextActions.push("重新运行 V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters 和 bash native-cam-real-output-check.sh，确保两份报告来自同一次真实 CAM 输出。");
    }
  }

  if (!runbookResult) {
    warnings.push("尚未执行 V3 部署验收脚本，当前总门禁缺少服务器侧执行证据。");
    nextActions.push("在 Linux CAM 服务器运行下载的 v3-acceptance-runbook.sh，再重新生成总门禁。");
  } else if (!runbookResult.identityValid) {
    blockers.push("V3 验收脚本结果缺少有效的 readiness 身份绑定，不能作为生产放行证据。");
    nextActions.push("重新下载最新 v3-acceptance-runbook.sh，在 Linux CAM 服务器执行后再生成总门禁。");
  } else if (!runbookResult.ok) {
    const firstFailed = runbookResult.failedSteps[0];
    const message = `V3 验收脚本失败 ${runbookResult.failedCount} 项${firstFailed ? `：${firstFailed.title}` : ""}。`;
    if (runbookResult.failedSteps.some((step) => step.blocksProduction)) blockers.push(message);
    else warnings.push(message);
    nextActions.push("查看 runbook result JSON，优先修复失败步骤后重新运行验收脚本。");
  } else if (!runbookResult.productionSafe) {
    blockers.push("V3 验收脚本已执行，但生产安全标记未通过。");
    nextActions.push("确认 runbook 的 blockingFailedCount 为 0 且 productionSafe=true 后再重新生成总门禁。");
  }

  if (!externalHandoff) {
    warnings.push("尚未运行外部 CAM neutral handoff + CAMotics 回填小闭环。");
    nextActions.push("运行 npm run test:v3:neutral-adapter，验证外部 neutral 刀位点、Y轴旋转后处理和 CAMotics 仿真回填。");
  } else if (externalHandoff.status !== "completed" || externalHandoff.simulationStatus !== "completed") {
    warnings.push(`外部 handoff 验证未完成：${externalHandoff.status} / ${externalHandoff.simulationStatus ?? "unknown"}。`);
    nextActions.push("查看最近 handoff job 的 adapter-report.json、camotics-adapter-report.json 和 simulation-summary.json。");
  } else if (externalHandoff.syntheticSimulation) {
    warnings.push("最近外部 handoff 使用 synthetic CAMotics 结果，只能证明协议链路，不能证明材料去除效果。");
    nextActions.push("运行 npm run test:v3:real-neutral-handoff，验证非 synthetic neutral 刀路和 CAMotics 结果回填。");
  }

  const handoffsByEngine = externalCamHandoffs?.byEngine ?? {};
  for (const engineId of ["freecad", "blendercam", "opencamlib"]) {
    const handoff = handoffsByEngine[engineId];
    if (!handoff) {
      warnings.push(`尚未运行 ${engineLabel(engineId)} 外部 handoff 小闭环。`);
      nextActions.push(createEngineHandoffCommand(engineId));
    } else if (handoff.status !== "completed" || handoff.simulationStatus !== "completed") {
      warnings.push(`${engineLabel(engineId)} handoff 未完成：${handoff.status} / ${handoff.simulationStatus ?? "unknown"}。`);
    }
  }

  if (!neutralImport) {
    warnings.push("尚未运行 OpenCAMLib 真实 neutral 刀路导入契约测试。");
    nextActions.push("运行 npm run test:v3:neutral-import，验证非 synthetic 中立刀路可进入后处理链路。");
  } else if (!neutralImport.ok || !neutralImport.postprocessEligible) {
    warnings.push(`OpenCAMLib neutral 导入契约未通过：${neutralImport.status ?? "unknown"}。`);
    nextActions.push("查看 neutral-import-contract.json、adapter-report.json 和 neutral-toolpath.json。");
  }

  const productionCamEvidence = createV3ProductionCamEvidenceSummary({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport });
  const postprocessHandoffReadiness = createV3PostprocessHandoffReadiness({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport });
  if (postprocessHandoffReadiness.status === "blocked") {
    blockers.push(postprocessHandoffReadiness.summary);
    nextActions.push(...postprocessHandoffReadiness.nextActions);
  } else if (postprocessHandoffReadiness.status === "pending") {
    warnings.push(postprocessHandoffReadiness.summary);
    nextActions.push(...postprocessHandoffReadiness.nextActions);
  } else if (postprocessHandoffReadiness.status === "review") {
    warnings.push(postprocessHandoffReadiness.summary);
    nextActions.push(...postprocessHandoffReadiness.nextActions);
  }
  const camoticsEvidence = readinessCamoticsEvidence ?? createReadinessCamoticsEvidence({ camoticsImport, latestEvidenceDossier });
  if (!camoticsEvidence.productionEvidenceEligible) {
    const message = productionCamEvidence.required
      ? `已有真实 CAM 生产候选证据（${productionCamEvidence.summary}），但 CAMotics 材料去除证据未达到生产标准：${camoticsEvidence.summary}`
      : camoticsEvidence.source === "latest-job-evidence-dossier"
        ? `最新 job 的 CAMotics 材料去除证据仍需复核：${camoticsEvidence.summary}`
        : "尚未运行 CAMotics 真实结果导入契约测试，且最新 job 也没有可用材料去除证据。";
    if (productionCamEvidence.required) blockers.push(message);
    else warnings.push(message);
    nextActions.push(camoticsEvidence.source === "latest-job-evidence-dossier"
      ? "查看最新 job 的 production-evidence-dossier.json、camotics-result.json 和 camotics-result-local-validation.json。"
      : "运行 npm run test:v3:camotics-import，验证非 synthetic 材料去除结果可回填。");
  } else if (camoticsEvidence.inputIdentityStatus !== "matched") {
    blockers.push(`CAMotics 材料去除证据已标记可用，但输入哈希绑定状态为 ${camoticsEvidence.inputIdentityStatus}。`);
    nextActions.push("查看 camotics-result.json 的 evidenceQuality.inputIdentity，确认 preferredGcodeSha256 与当前 camotics-preview.nc 匹配。");
  }

  if (!latestJob) {
    warnings.push("尚未运行 V3 Orchestrator 小闭环任务。");
    nextActions.push("导入/生成一个 GLB/STL 后运行 V3 小闭环，生成加工包与生产门禁报告。");
  } else {
    if (latestJob.status !== "completed") warnings.push(`最近 V3 任务状态为 ${latestJob.status}。`);
    if (!latestJob.allowAirRun) warnings.push("最近任务未生成可用离料空跑文件。");
    if (!latestJob.allowTrialNc) warnings.push("最近任务未解锁试雕 NC。");
    if (!latestJob.camoticsCliPackage?.artifactExists) {
      warnings.push("最近任务尚未生成 CAMotics Linux 仿真准备包。");
      nextActions.push("在 V3 面板点击“生成仿真准备包”，或运行 npm run test:v3:camotics-cli-package-api 验证准备包 API。");
    }
    if (!latestJob.allowProductionNc) warnings.push(`最近任务生产 NC 未解锁，包级别 ${latestJob.packageLevel ?? "unknown"}。`);
  }

  if (!latestEvidenceDossier) {
    warnings.push("尚未生成生产证据档案。");
    nextActions.push("运行 V3 小闭环生成 production-evidence-dossier.json，并查看证据缺口。");
  } else {
    if (latestEvidenceDossier.status === "blocked" || latestEvidenceDossier.blockedCount > 0) {
      blockers.push(`生产证据档案存在 ${latestEvidenceDossier.blockedCount} 个阻断项：${latestEvidenceDossier.summary}`);
    } else if (latestEvidenceDossier.status !== "production-evidence-complete" || latestEvidenceDossier.reviewCount > 0) {
      warnings.push(`生产证据档案未完整：通过 ${latestEvidenceDossier.passedCount}，复核 ${latestEvidenceDossier.reviewCount}，阻断 ${latestEvidenceDossier.blockedCount}。`);
      nextActions.push("查看 production-evidence-dossier.json，按 missingEvidence 补齐真实 CAM/仿真/试雕证据。");
    }
  }

  if (!latestTrialFeedback) {
    warnings.push("尚未回填真实试雕反馈，生产 NC 继续保持锁定。");
    nextActions.push("完成离料空跑/软料试雕后，在 V3 面板回填试雕反馈并重新生成 readiness。");
  } else if (latestTrialFeedback.latestOutcome === "failed") {
    blockers.push("最近试雕反馈为 failed，需先修正工艺参数并重新试雕。");
    nextActions.push("查看 trial-feedback-log.json 和 process-optimization-plan.json，按建议重新生成刀路。");
  } else if (latestTrialFeedback.latestOutcome === "success" && latestTrialFeedback.latestDownloadIntegrityBound !== "matched") {
    warnings.push("最近试雕反馈为 success，但未绑定当前下载包哈希，暂不能作为生产放行证据。");
    nextActions.push("重新下载当前安全试雕包，按 operator-download-checklist.md 核验 SHA-256 后再回填试雕反馈。");
  } else if (latestTrialFeedback.latestOutcome !== "success") {
    warnings.push(`最近试雕反馈为 ${latestTrialFeedback.latestOutcome ?? "unknown"}，生产放行前仍需复核。`);
    nextActions.push("将试雕问题闭环到参数优化后，再回填 success 试雕记录。");
  }

  if (!latestMachineAcceptance) {
    warnings.push("尚未回填机床现场验收记录，生产 NC 继续保持锁定。");
    nextActions.push("按 machine-acceptance-checklist.json 完成机床验收并回填记录。");
  } else if (latestMachineAcceptance.latestOutcome === "failed" || !latestMachineAcceptance.latestAllRequiredPassed) {
    blockers.push("最近机床验收未通过必需项，禁止解锁生产 NC。");
    nextActions.push("修复机床验收失败项后，重新执行离料空跑/软料试雕并回填验收。");
  } else if (latestMachineAcceptance.latestOutcome !== "success") {
    warnings.push(`最近机床验收为 ${latestMachineAcceptance.latestOutcome ?? "unknown"}，生产放行前仍需人工复核。`);
  }

  const level = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "trial-only" : "production-ready";
  return {
    level,
    summary: level === "production-ready"
      ? "V3 部署、外部 CAM、仿真和最近任务门禁均已通过。"
      : level === "blocked"
        ? `V3 存在阻断项：${blockers[0]}`
        : "V3 可继续小闭环/试雕，但尚未达到生产级 CAM 门禁。",
    allowProductionNc: level === "production-ready",
    allowTrialNc: Boolean(latestJob?.allowTrialNc) && blockers.length === 0,
    allowAirRun: Boolean(latestJob?.allowAirRun),
    blockers: dedupeStrings(blockers),
    warnings: dedupeStrings(warnings),
    nextActions: dedupeStrings(nextActions).slice(0, 12)
  };
}

function createV3ProductionCamEvidenceSummary({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport }) {
  const reasons = [];
  const productionCandidateCount = Number(adapterValidation?.handoffClassificationAudit?.productionCandidateCount ?? 0);
  if (productionCandidateCount > 0) reasons.push(`Adapter production-candidate=${productionCandidateCount}`);
  if (nativeCamRealOutputAcceptance?.level === "ready" && Number(nativeCamRealOutputAcceptance.productionCandidateCount ?? 0) > 0) {
    reasons.push(`Native CAM 真实输出 ready=${nativeCamRealOutputAcceptance.productionCandidateCount}`);
  }
  if (neutralImport?.ok && neutralImport?.postprocessEligible && neutralImport?.synthetic === false) {
    reasons.push(`Neutral 导入可后处理 ${neutralImport.pointCount ?? 0} 点`);
  }
  return {
    required: reasons.length > 0,
    summary: reasons.join("；") || "none"
  };
}

function createV3PostprocessHandoffReadiness({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport }) {
  const productionCamEvidence = createV3ProductionCamEvidenceSummary({ adapterValidation, nativeCamRealOutputAcceptance, neutralImport });
  const nextActions = [];
  const neutralReady = Boolean(neutralImport?.ok && neutralImport?.postprocessEligible && neutralImport?.synthetic === false);
  const pointCount = Number(neutralImport?.pointCount ?? 0);
  const sourceBindingStatus = neutralImport?.sourceBindingStatus ?? "missing";
  const sourceBindingBound = sourceBindingStatus === "bound";
  if (neutralReady) {
    return {
      schema: "hediao3d.v3-postprocess-handoff-readiness.v1",
      status: pointCount > 0 && sourceBindingBound ? "ready" : "review",
      summary: pointCount > 0 && sourceBindingBound
        ? `真实 neutral-toolpath 已通过导入校验，可进入 HeDiao3D Y/A 旋转夹具后处理（${pointCount} 点）。`
        : pointCount > 0
          ? `neutral-toolpath 已通过导入校验，但 sourceBinding=${sourceBindingStatus}，需复核导入源、neutral-toolpath.json 和后处理输入哈希链。`
          : "neutral-toolpath 已通过导入校验，但点数为 0 或未知，需复核后处理输入。",
      required: productionCamEvidence.required,
      source: "neutral-import",
      productionCamEvidence: productionCamEvidence.summary,
      neutralImportId: neutralImport.id ?? null,
      pointCount,
      sourceBindingStatus,
      nextActions: pointCount > 0 && sourceBindingBound
        ? ["继续执行 CAMotics 材料去除仿真、离料空跑、软料试雕和机床验收。"]
        : pointCount > 0
          ? ["查看 neutral-import-contract.json 的 sourceBinding，确认导入源与后处理输入哈希一致。"]
          : ["复核 neutral-import-contract.json 和 neutral-toolpath.json，确认 points[] 有效。"]
    };
  }

  nextActions.push("运行 npm run test:v3:neutral-import，导入非 synthetic/fixture/preview 的 hediao3d.neutral-toolpath.v1。");
  nextActions.push("确认外部 CAM 输出不是 raw G-code 直传，而是可由 HeDiao3D 自研 Y/A 旋转夹具后处理消费的中立刀位点。");

  if (productionCamEvidence.required) {
    return {
      schema: "hediao3d.v3-postprocess-handoff-readiness.v1",
      status: "blocked",
      summary: `已有真实 CAM 生产候选证据（${productionCamEvidence.summary}），但尚未证明刀路可进入 HeDiao3D 自研 Y/A 旋转夹具后处理。`,
      required: true,
      source: neutralImport ? "neutral-import-ineligible" : "missing-neutral-import",
      productionCamEvidence: productionCamEvidence.summary,
      neutralImportId: neutralImport?.id ?? null,
      pointCount,
      sourceBindingStatus,
      nextActions
    };
  }

  return {
    schema: "hediao3d.v3-postprocess-handoff-readiness.v1",
    status: "pending",
    summary: "尚未证明外部 CAM neutral 刀位点可进入 HeDiao3D 自研 Y/A 旋转夹具后处理。",
    required: false,
    source: neutralImport ? "neutral-import-ineligible" : "missing-neutral-import",
    productionCamEvidence: productionCamEvidence.summary,
    neutralImportId: neutralImport?.id ?? null,
    pointCount,
    sourceBindingStatus,
    nextActions
  };
}

function createV3DeploymentAcceptancePlan({ gates, diagnostics, nativeCam, adapterValidation, nativeCamRealOutputAcceptance, runbookResult, camServerConfig, externalHandoff, externalCamHandoffs, neutralImport, camoticsImport, readinessCamoticsEvidence, latestJob, latestTrialFeedback, latestMachineAcceptance, latestEvidenceDossier }) {
  const camoticsEvidence = readinessCamoticsEvidence ?? createReadinessCamoticsEvidence({ camoticsImport, latestEvidenceDossier });
  const orchestratorBaseReady = diagnostics.level !== "critical"
    && Array.isArray(diagnostics.checks)
    && diagnostics.checks
      .filter((check) => ["api-port", "concurrency", "orchestrator-jobs", "imported-models", "meshy-results"].includes(check.id))
      .every((check) => check.level === "ok");
  const steps = [
    createAcceptanceStep({
      order: 1,
      id: "orchestrator-diagnostics",
      title: "Orchestrator 环境自检",
      status: diagnostics.level === "critical" ? "blocked" : orchestratorBaseReady ? "done" : "pending",
      command: "curl http://127.0.0.1:8787/api/orchestrator/diagnostics",
      evidence: ["/api/orchestrator/diagnostics", "V3 面板环境自检"],
      detail: orchestratorBaseReady
        ? "API、队列和文件缓存目录可用；外部 CAM 缺失由后续 Native CAM/Adapter 步骤验收。"
        : diagnostics.summary,
      blocksProduction: diagnostics.level === "critical" || !orchestratorBaseReady
    }),
    createAcceptanceStep({
      order: 2,
      id: "native-cam-readiness",
      title: "Native CAM 环境验收",
      status: !nativeCam ? "pending" : nativeCam.summary.level === "ready" ? "done" : "pending",
      command: "npm run test:v3:native-cam",
      evidence: [
        "native-cam-readiness.json",
        "native-cam-server-bootstrap.sh",
        "native-cam-env.template",
        "native-cam-acceptance-checklist.md",
        "native-cam-server-package.json",
        "/api/orchestrator/native-cam/latest"
      ],
      detail: nativeCam
        ? `${nativeCam.summary.readyCount}/${nativeCam.summary.requiredCount} ${nativeCam.summary.level}${nativeCam.packageArtifacts?.files?.length ? ` / server-package=${nativeCam.packageArtifacts.files.length} files` : ""}`
        : "尚未生成 Native CAM 环境验收报告。",
      blocksProduction: !nativeCam || nativeCam.summary.level !== "ready"
    }),
    createAcceptanceStep({
      order: 3,
      id: "cam-server-config",
      title: "CAM 服务器配置矩阵",
      status: !camServerConfig
        ? "pending"
        : camServerConfig.status === "ready-to-attempt-external-cam"
          ? "done"
          : camServerConfig.status === "installed-but-adapters-disabled"
            ? "pending"
            : "pending",
      command: "npm run test:v3:native-cam && V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
      evidence: ["cam-server-config.json", "native-cam-readiness.json", "v3-external-adapter-validation.json"],
      detail: camServerConfig
        ? `${camServerConfig.status} / ${camServerConfig.selectedEngineName} / missing=${camServerConfig.missingRequired.length}`
        : "尚未生成 CAM 服务器配置矩阵。",
      blocksProduction: !camServerConfig || camServerConfig.status !== "ready-to-attempt-external-cam"
    }),
    createAcceptanceStep({
      order: 4,
      id: "adapter-validation",
      title: "外部 CAM Adapter 验证",
      status: !adapterValidation
        ? "pending"
        : adapterValidation.overall.failed > 0
          ? "blocked"
          : adapterValidation.handoffClassificationAudit?.unsafeCount > 0
            || adapterValidation.handoffClassificationAudit?.unboundProductionCandidateCount > 0
            ? "blocked"
            : adapterValidation.handoffClassificationAudit?.productionCandidateCount > 0
          ? "done"
          : "pending",
      command: "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
      evidence: ["v3-external-adapter-validation.json", "adapter-report.json", "handoffClassificationAudit"],
      detail: adapterValidation
        ? `计划 ${adapterValidation.overall.generatedPlans}/${adapterValidation.overall.adapterCount}，completed ${adapterValidation.overall.completedAdapters}，失败 ${adapterValidation.overall.failed}，productionCandidate=${adapterValidation.handoffClassificationAudit?.productionCandidateCount ?? 0}，unsafe=${adapterValidation.handoffClassificationAudit?.unsafeCount ?? "unknown"}，contactBound=${adapterValidation.handoffClassificationAudit?.contactReportBindingCounts?.bound ?? 0}，unboundContact=${adapterValidation.handoffClassificationAudit?.unboundProductionCandidateCount ?? 0}`
        : "尚未运行外部 Adapter 验证。",
      blocksProduction: !adapterValidation || adapterValidation.overall.failed > 0 || (adapterValidation.handoffClassificationAudit?.unsafeCount ?? 1) > 0 || (adapterValidation.handoffClassificationAudit?.productionCandidateCount ?? 0) === 0 || (adapterValidation.handoffClassificationAudit?.unboundProductionCandidateCount ?? 0) > 0
    }),
    createAcceptanceStep({
      order: 4.5,
      id: "native-cam-real-output-acceptance",
      title: "Native CAM 真实输出验收",
      status: !nativeCamRealOutputAcceptance
        ? "pending"
        : nativeCamRealOutputAcceptance.level === "ready"
          ? "done"
          : nativeCamRealOutputAcceptance.level === "critical"
            ? "blocked"
            : "pending",
      command: "bash native-cam-real-output-check.sh",
      evidence: ["native-cam-real-output-acceptance.json", "v3-external-adapter-validation.json", "adapter-report.json"],
      detail: nativeCamRealOutputAcceptance
        ? `${nativeCamRealOutputAcceptance.level} / productionCandidate=${nativeCamRealOutputAcceptance.productionCandidateCount} / unsafe=${nativeCamRealOutputAcceptance.unsafeCount} / missing=${nativeCamRealOutputAcceptance.missingCount} / sourceBinding=${nativeCamRealOutputAcceptance.sourceReportBindingStatus ?? "missing"}`
        : "尚未运行 Linux CAM 服务端真实输出验收脚本。",
      blocksProduction: !nativeCamRealOutputAcceptance
        || nativeCamRealOutputAcceptance.level !== "ready"
        || (nativeCamRealOutputAcceptance.sourceReportBindingRequired && nativeCamRealOutputAcceptance.sourceReportBindingStatus !== "matched")
    }),
    createAcceptanceStep({
      order: 5,
      id: "external-neutral-handoff",
      title: "外部 CAM Handoff 小闭环",
      status: !externalHandoff
        ? "pending"
        : externalHandoff.status === "completed" && externalHandoff.simulationStatus === "completed"
          ? "done"
          : "blocked",
      command: "npm run test:v3:neutral-adapter",
      evidence: ["adapter-report.json", "neutral-toolpath.json", "camotics-result.json", "simulation-summary.json", "toolpath.nc"],
      detail: externalHandoff
        ? `${externalHandoff.id} / ${externalHandoff.resultEngine} / ${externalHandoff.source} / ${externalHandoff.simulationEngine} / ${externalHandoff.points ?? 0} 点`
        : "尚未验证外部 neutral 刀位点、Y轴旋转后处理和 CAMotics 回填链路。",
      blocksProduction: !externalHandoff || externalHandoff.status !== "completed" || externalHandoff.simulationStatus !== "completed"
    }),
    createAcceptanceStep({
      order: 6,
      id: "external-real-neutral-handoff",
      title: "非 Synthetic Neutral + CAMotics 回填",
      status: !externalHandoff
        ? "pending"
        : externalHandoff.status === "completed" && externalHandoff.simulationStatus === "completed" && !externalHandoff.syntheticSimulation
          ? "done"
          : "pending",
      command: "npm run test:v3:real-neutral-handoff",
      evidence: ["adapter-report.json", "neutral-toolpath.json", "camotics-result.json", "simulation-summary.json", "production-gate.json"],
      detail: externalHandoff
        ? `${externalHandoff.id} / syntheticSimulation=${externalHandoff.syntheticSimulation} / ${externalHandoff.simulationEngine ?? "unknown"}`
        : "尚未验证非 synthetic neutral 刀路和 CAMotics 结果回填。",
      blocksProduction: !externalHandoff || externalHandoff.status !== "completed" || externalHandoff.simulationStatus !== "completed" || externalHandoff.syntheticSimulation
    }),
    createAcceptanceStep({
      order: 7,
      id: "freecad-external-gcode-handoff",
      title: "FreeCAD External G-code Handoff",
      status: createEngineHandoffStatus(externalCamHandoffs, "freecad"),
      command: "npm run test:v3:freecad-external-handoff",
      evidence: ["adapter-report.json", "freecad-cam-plan.json", "toolpath.nc", "simulation-summary.json", "production-gate.json"],
      detail: createEngineHandoffDetail(externalCamHandoffs, "freecad"),
      blocksProduction: false
    }),
    createAcceptanceStep({
      order: 8,
      id: "blendercam-external-gcode-handoff",
      title: "BlenderCAM External G-code Handoff",
      status: createEngineHandoffStatus(externalCamHandoffs, "blendercam"),
      command: "npm run test:v3:blendercam-external-handoff",
      evidence: ["adapter-report.json", "blendercam-cam-plan.json", "toolpath.nc", "simulation-summary.json", "production-gate.json"],
      detail: createEngineHandoffDetail(externalCamHandoffs, "blendercam"),
      blocksProduction: false
    }),
    createAcceptanceStep({
      order: 9,
      id: "opencamlib-external-neutral-handoff",
      title: "OpenCAMLib External Neutral Handoff",
      status: createEngineHandoffStatus(externalCamHandoffs, "opencamlib"),
      command: "npm run test:v3:closed-neutral-handoff",
      evidence: ["adapter-report.json", "opencamlib-kernel-plan.json", "neutral-toolpath.json", "toolpath.nc", "production-gate.json"],
      detail: createEngineHandoffDetail(externalCamHandoffs, "opencamlib"),
      blocksProduction: false
    }),
    createAcceptanceStep({
      order: 10,
      id: "opencamlib-neutral-import",
      title: "OpenCAMLib Neutral 导入契约",
      status: !neutralImport
        ? "pending"
        : neutralImport.ok && neutralImport.postprocessEligible
          ? "done"
          : "blocked",
      command: "npm run test:v3:neutral-import",
      evidence: ["neutral-import-contract.json", "adapter-report.json", "neutral-toolpath.json"],
      detail: neutralImport
        ? `${neutralImport.status} / imported=${neutralImport.imported} / synthetic=${neutralImport.synthetic} / ${neutralImport.pointCount ?? 0} 点`
        : "尚未验证真实 OpenCAMLib neutral 刀路导入契约。",
      blocksProduction: !neutralImport || !neutralImport.ok || !neutralImport.postprocessEligible
    }),
    createAcceptanceStep({
      order: 11,
      id: "camotics-result-import",
      title: "CAMotics 真实结果导入契约",
      status: !camoticsEvidence || camoticsEvidence.source === "missing"
        ? "pending"
        : camoticsEvidence.ok && camoticsEvidence.productionEvidenceEligible
          ? "done"
          : "blocked",
      command: "npm run test:v3:camotics-import",
      evidence: camoticsEvidence?.source === "latest-job-evidence-dossier"
        ? ["production-evidence-dossier.json", "camotics-result.json", "camotics-result-local-validation.json"]
        : ["camotics-import-contract.json", "camotics-adapter-report.json", "camotics-result.json"],
      detail: camoticsEvidence && camoticsEvidence.source !== "missing"
        ? `${camoticsEvidence.status} / source=${camoticsEvidence.source} / synthetic=${camoticsEvidence.synthetic} / risk=${camoticsEvidence.riskLevel ?? "unknown"} / input=${camoticsEvidence.inputIdentityStatus ?? "missing"} / cli=${camoticsEvidence.cliRunPackageBindingStatus ?? "not-required"} / motion=${camoticsEvidence.motionConsistencyStatus ?? "missing"}`
        : "尚未验证真实 CAMotics 结果导入契约 / input=missing / cli=not-required / motion=missing。",
      blocksProduction: !camoticsEvidence || !camoticsEvidence.ok || !camoticsEvidence.productionEvidenceEligible || camoticsEvidence.inputIdentityStatus !== "matched"
    }),
    createAcceptanceStep({
      order: 12,
      id: "v3-small-loop",
      title: "V3 小闭环加工包",
      status: !latestJob
        ? "pending"
        : latestJob.status !== "completed"
          ? "blocked"
          : latestJob.allowTrialNc && latestJob.allowAirRun
            ? "done"
            : "pending",
      command: "npm run test:v3",
      evidence: ["machining-package-index.json", "production-gate.json", "delivery-manifest.json", "package-integrity.json", "rotary-calibration-airrun.nc", "air-run.nc"],
      detail: latestJob
        ? `${latestJob.status} / ${latestJob.packageLevel ?? "unknown"} / ${latestJob.points ?? 0} 点`
        : "尚未运行 V3 Orchestrator 小闭环。",
      blocksProduction: !latestJob || latestJob.status !== "completed" || !latestJob.allowTrialNc || !latestJob.allowAirRun
    }),
    createAcceptanceStep({
      order: 13,
      id: "camotics-cli-package",
      title: "CAMotics Linux 仿真准备包",
      status: !latestJob
        ? "pending"
        : latestJob.camoticsCliPackage?.artifactExists && latestJob.camoticsCliPackage?.productionUnlockEligible === false
          ? "done"
          : "pending",
      command: "npm run test:v3:camotics-cli-package-api",
      evidence: ["camotics-cli-run-package.json", "camotics-result-template.json", "camotics-linux-run.sh", "camotics-result-validate.js", "camotics-linux-operator-checklist.md", "camotics-cli-package-report.json"],
      detail: latestJob?.camoticsCliPackage
        ? `${latestJob.camoticsCliPackage.status ?? "unknown"} / lines=${latestJob.camoticsCliPackage.motionLineCount ?? "-"} / productionUnlock=${latestJob.camoticsCliPackage.productionUnlockEligible}`
        : "尚未为最近任务生成 CAMotics Linux 准备包。",
      blocksProduction: false
    }),
    createAcceptanceStep({
      order: 14,
      id: "production-evidence-dossier",
      title: "生产证据档案",
      status: !latestEvidenceDossier
        ? "pending"
        : latestEvidenceDossier.status === "production-evidence-complete"
          ? "done"
          : latestEvidenceDossier.blockedCount > 0
            ? "blocked"
            : "pending",
      command: "npm run test:v3",
      evidence: ["production-evidence-dossier.json", "production-unlock-matrix.json", "trial-feedback-log.json", "process-optimization-plan.json"],
      detail: latestEvidenceDossier
        ? `${latestEvidenceDossier.status} / pass=${latestEvidenceDossier.passedCount} review=${latestEvidenceDossier.reviewCount} block=${latestEvidenceDossier.blockedCount} / ${formatProductionEvidenceCrossChecksForReadiness(latestEvidenceDossier.crossChecks)}`
        : "尚未生成生产证据档案。",
      blocksProduction: !latestEvidenceDossier || latestEvidenceDossier.status !== "production-evidence-complete"
    }),
    createAcceptanceStep({
      order: 15,
      id: "trial-feedback",
      title: "真实试雕反馈回填",
      status: !latestTrialFeedback
        ? "pending"
        : latestTrialFeedback.latestOutcome === "failed"
          ? "blocked"
          : latestTrialFeedback.latestOutcome === "success" && latestTrialFeedback.latestDownloadIntegrityBound === "matched"
            ? "done"
            : "pending",
      command: "在 V3 面板填写试雕反馈，或 POST /api/orchestrator/jobs/:id/trial-feedback",
      evidence: ["trial-feedback-log.json", "trial-feedback-record.json", "process-optimization-plan.json"],
      detail: latestTrialFeedback
        ? `${latestTrialFeedback.recordCount} 条 / 最新 ${latestTrialFeedback.latestOutcome ?? "unknown"} / ${latestTrialFeedback.latestIssues?.length ?? 0} 个问题 / 下载包绑定 ${latestTrialFeedback.latestDownloadIntegrityBound ?? "missing"}`
        : "尚未回填真实离料空跑/软料试雕反馈。",
      blocksProduction: !latestTrialFeedback || latestTrialFeedback.latestOutcome !== "success" || latestTrialFeedback.latestDownloadIntegrityBound !== "matched"
    }),
    createAcceptanceStep({
      order: 16,
      id: "machine-acceptance",
      title: "机床现场验收回填",
      status: !latestMachineAcceptance
        ? "pending"
        : latestMachineAcceptance.latestOutcome === "failed" || !latestMachineAcceptance.latestAllRequiredPassed
          ? "blocked"
          : latestMachineAcceptance.latestOutcome === "success"
            ? "done"
            : "pending",
      command: "在 V3 面板填写机床验收，或 POST /api/orchestrator/jobs/:id/machine-acceptance",
      evidence: ["machine-acceptance-checklist.json", "machine-acceptance-log.json", "machine-acceptance-record.json"],
      detail: latestMachineAcceptance
        ? `${latestMachineAcceptance.recordCount} 条 / 最新 ${latestMachineAcceptance.latestOutcome ?? "unknown"} / 必需项 ${latestMachineAcceptance.latestAllRequiredPassed ? "通过" : "未通过"}`
        : "尚未回填机床现场验收记录。",
      blocksProduction: !latestMachineAcceptance || latestMachineAcceptance.latestOutcome !== "success" || !latestMachineAcceptance.latestAllRequiredPassed
    }),
    createAcceptanceStep({
      order: 17,
      id: "production-gate",
      title: "生产 NC 门禁",
      status: gates.allowProductionNc ? "done" : gates.blockers.length > 0 ? "blocked" : "pending",
      command: "curl http://127.0.0.1:8787/api/orchestrator/readiness/latest",
      evidence: ["v3-readiness-report.json", "production-gate.json", "nc-static-analysis.json", "controller-dialect-report.json"],
      detail: gates.summary,
      blocksProduction: !gates.allowProductionNc
    })
  ];
  return {
    schema: "hediao3d.v3-deployment-acceptance-plan.v1",
    level: gates.level,
    nextStep: steps.find((step) => step.status !== "done") ?? null,
    completed: steps.filter((step) => step.status === "done").length,
    total: steps.length,
    steps
  };
}

function createAcceptanceStep({ order, id, title, status, command, evidence, detail, blocksProduction }) {
  return {
    order,
    id,
    title,
    status,
    command,
    evidence,
    detail,
    blocksProduction
  };
}

function getLatestOrchestratorJobSummary() {
  const jobs = [];
  for (const job of orchestratorJobs.values()) jobs.push(job);
  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      if (manifest) jobs.push(manifest);
    }
  }
  const summaries = jobs
    .map(createOrchestratorJobSummary)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return summaries[0] ?? null;
}

function getLatestExternalHandoffJobSummary() {
  const jobs = [];
  for (const job of orchestratorJobs.values()) jobs.push(job);
  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      if (manifest) jobs.push(manifest);
    }
  }
  const handoffs = jobs
    .map(createExternalHandoffJobSummary)
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  return handoffs[0] ?? null;
}

function getExternalCamHandoffSummaries() {
  const jobs = [];
  for (const job of orchestratorJobs.values()) jobs.push(job);
  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      if (manifest) jobs.push(manifest);
    }
  }
  const handoffs = jobs
    .map(createExternalHandoffJobSummary)
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  const byEngine = {};
  for (const handoff of handoffs) {
    const engine = handoff.resultEngine ?? handoff.selectedEngine;
    if (!engine || byEngine[engine]) continue;
    byEngine[engine] = handoff;
  }
  return {
    schema: "hediao3d.external-cam-handoffs.v1",
    requiredEngines: ["freecad", "blendercam", "opencamlib"],
    completedEngines: ["freecad", "blendercam", "opencamlib"].filter((engine) => {
      const handoff = byEngine[engine];
      return handoff?.status === "completed" && handoff?.simulationStatus === "completed";
    }),
    byEngine,
    latest: handoffs.slice(0, 8)
  };
}

function getLatestProductionEvidenceDossierSummary() {
  const candidates = [];
  for (const job of orchestratorJobs.values()) {
    const summary = createProductionEvidenceDossierSummaryFromJob(job);
    if (summary) candidates.push(summary);
  }
  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      const summary = manifest ? createProductionEvidenceDossierSummaryFromJob(manifest) : null;
      if (summary) candidates.push(summary);
    }
  }
  return candidates
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())[0] ?? null;
}

function createProductionEvidenceDossierSummaryFromJob(job) {
  const dossierPath = job?.workDir ? join(job.workDir, "production-evidence-dossier.json") : null;
  if (!dossierPath || !existsSync(dossierPath)) return null;
  const dossier = readJsonFileSafe(dossierPath);
  if (!dossier) return null;
  const rawCrossChecks = dossier.crossChecks ?? createProductionEvidenceCrossChecksFromArtifacts(job.workDir);
  return {
    schema: dossier.schema ?? "unknown",
    jobId: dossier.jobId ?? job.id,
    updatedAt: dossier.createdAt ?? job.updatedAt ?? job.createdAt,
    status: dossier.status ?? "unknown",
    packageLevel: dossier.packageLevel ?? null,
    allowProductionNc: Boolean(dossier.allowProductionNc),
    allowTrialNc: Boolean(dossier.allowTrialNc),
    passedCount: Number(dossier.passedCount ?? 0),
    reviewCount: Number(dossier.reviewCount ?? 0),
    blockedCount: Number(dossier.blockedCount ?? 0),
    missingEvidenceCount: Array.isArray(dossier.missingEvidence) ? dossier.missingEvidence.length : 0,
    summary: dossier.summary ?? null,
    crossChecks: rawCrossChecks ? createProductionEvidenceCrossChecksSummary(rawCrossChecks) : null,
    artifact: publicArtifactUrl(dossier.jobId ?? job.id, "production-evidence-dossier.json")
  };
}

function createProductionEvidenceCrossChecksFromArtifacts(workDir) {
  if (!workDir) return null;
  const ncStatic = readJsonFileSafe(join(workDir, "nc-static-analysis.json"));
  const controllerDialect = readJsonFileSafe(join(workDir, "controller-dialect-report.json"));
  const camHandoff = readJsonFileSafe(join(workDir, "cam-handoff-quality.json"));
  const neutralImport = readJsonFileSafe(join(workDir, "neutral-toolpath-import-validation.json"));
  const camoticsResult = readJsonFileSafe(join(workDir, "camotics-result.json"));
  const machineAcceptanceLog = readJsonFileSafe(join(workDir, "machine-acceptance-log.json"));
  const trialFeedbackLog = readJsonFileSafe(join(workDir, "trial-feedback-log.json"));
  const optimizationPlan = readJsonFileSafe(join(workDir, "process-optimization-plan.json"));
  const camoticsEvidence = camoticsResult?.evidenceQuality;
  return {
    realMaterialRemovalVerified: Boolean(camoticsEvidence?.productionEvidenceEligible && camoticsResult?.synthetic === false),
    camHandoffReady: camHandoff?.level === "ready",
    neutralSourceBindingStatus: neutralImport?.sourceBinding?.status ?? "missing",
    neutralSourceBindingPass: Boolean(neutralImport?.sourceBinding?.status === "bound" && neutralImport?.postprocessEligible),
    camoticsInputIdentityStatus: camoticsEvidence?.inputIdentity?.status ?? "missing",
    camoticsCliRunPackageBindingStatus: camoticsEvidence?.inputIdentity?.cliRunPackage?.status ?? "missing",
    camoticsMotionConsistencyStatus: camoticsEvidence?.motionConsistency?.status ?? "missing",
    camoticsArtifactEvidenceStatus: camoticsEvidence?.status ?? "missing",
    ncStaticReady: ncStatic?.level === "ready",
    controllerDialectReady: controllerDialect?.level === "ready",
    machineAcceptanceRecords: Number(machineAcceptanceLog?.recordCount ?? 0),
    latestMachineAcceptanceOutcome: machineAcceptanceLog?.latestOutcome ?? null,
    machineAcceptancePassed: Boolean(machineAcceptanceLog?.latestOutcome === "success" && machineAcceptanceLog?.allRequiredPassed),
    machineAcceptanceIntegrityBound: Boolean(machineAcceptanceLog?.latestRecord?.integrity?.packageBindingStatus === "matched" || machineAcceptanceLog?.latestIntegrityBound),
    trialFeedbackRecords: Number(trialFeedbackLog?.recordCount ?? 0),
    latestTrialFeedbackOutcome: trialFeedbackLog?.latestOutcome ?? null,
    trialFeedbackPassed: Boolean(trialFeedbackLog?.latestOutcome === "success" && trialFeedbackLog?.records?.[0]?.downloadIntegrity?.packageBinding?.status === "matched"),
    trialFeedbackIntegrityBound: trialFeedbackLog?.records?.[0]?.downloadIntegrity?.packageBinding?.status === "matched",
    optimizationStatus: optimizationPlan?.status ?? null
  };
}

function createProductionEvidenceCrossChecksSummary(crossChecks) {
  return {
    unlockMatrixPass: Boolean(crossChecks.unlockMatrixPass),
    realMaterialRemovalVerified: Boolean(crossChecks.realMaterialRemovalVerified),
    camHandoffReady: Boolean(crossChecks.camHandoffReady),
    neutralSourceBindingStatus: crossChecks.neutralSourceBindingStatus ?? "missing",
    neutralSourceBindingPass: Boolean(crossChecks.neutralSourceBindingPass),
    camoticsInputIdentityStatus: crossChecks.camoticsInputIdentityStatus ?? "missing",
    camoticsCliRunPackageBindingStatus: crossChecks.camoticsCliRunPackageBindingStatus ?? "missing",
    camoticsMotionConsistencyStatus: crossChecks.camoticsMotionConsistencyStatus ?? "missing",
    camoticsArtifactEvidenceStatus: crossChecks.camoticsArtifactEvidenceStatus ?? "missing",
    ncStaticReady: Boolean(crossChecks.ncStaticReady),
    controllerDialectReady: Boolean(crossChecks.controllerDialectReady),
    machineAcceptanceRecords: Number(crossChecks.machineAcceptanceRecords ?? 0),
    latestMachineAcceptanceOutcome: crossChecks.latestMachineAcceptanceOutcome ?? null,
    machineAcceptancePassed: Boolean(crossChecks.machineAcceptancePassed),
    machineAcceptanceIntegrityBound: Boolean(crossChecks.machineAcceptanceIntegrityBound),
    trialFeedbackRecords: Number(crossChecks.trialFeedbackRecords ?? 0),
    latestTrialFeedbackOutcome: crossChecks.latestTrialFeedbackOutcome ?? null,
    trialFeedbackPassed: Boolean(crossChecks.trialFeedbackPassed),
    trialFeedbackIntegrityBound: Boolean(crossChecks.trialFeedbackIntegrityBound),
    productionReadinessAudit: crossChecks.productionReadinessAudit
      ? {
        schema: crossChecks.productionReadinessAudit.schema ?? "hediao3d.production-readiness-audit.v1",
        status: crossChecks.productionReadinessAudit.status ?? "unknown",
        allowProductionPackage: Boolean(crossChecks.productionReadinessAudit.allowProductionPackage),
        passCount: Number(crossChecks.productionReadinessAudit.passCount ?? 0),
        reviewCount: Number(crossChecks.productionReadinessAudit.reviewCount ?? 0),
        blockCount: Number(crossChecks.productionReadinessAudit.blockCount ?? 0),
        summary: crossChecks.productionReadinessAudit.summary ?? null
      }
      : null,
    optimizationStatus: crossChecks.optimizationStatus ?? null
  };
}

function formatProductionEvidenceCrossChecksForReadiness(crossChecks) {
  if (!crossChecks) return "crossChecks=missing";
  return [
    `cam=${crossChecks.camHandoffReady ? "ready" : "review"}`,
    `camoticsInput=${crossChecks.camoticsInputIdentityStatus ?? "missing"}`,
    `camoticsRunPackage=${crossChecks.camoticsCliRunPackageBindingStatus ?? "missing"}`,
    `camoticsMotion=${crossChecks.camoticsMotionConsistencyStatus ?? "missing"}`,
    `nc=${crossChecks.ncStaticReady && crossChecks.controllerDialectReady ? "ready" : "review"}`,
    `machine=${crossChecks.machineAcceptancePassed && crossChecks.machineAcceptanceIntegrityBound ? "accepted" : "locked"}`,
    `trial=${crossChecks.trialFeedbackPassed && crossChecks.trialFeedbackIntegrityBound ? "bound-success" : "locked"}`,
    `productionAudit=${crossChecks.productionReadinessAudit?.status ?? "missing"}`,
    `trialRecords=${crossChecks.trialFeedbackRecords ?? 0}`
  ].join(" / ");
}

function getLatestJobLogSummary(filename, summarizer) {
  const candidates = [];
  for (const job of orchestratorJobs.values()) {
    const summary = createJobLogSummaryFromJob(job, filename, summarizer);
    if (summary) candidates.push(summary);
  }
  const root = join(process.cwd(), "public", "orchestrator-jobs");
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJobManifest(entry.name);
      const summary = manifest ? createJobLogSummaryFromJob(manifest, filename, summarizer) : null;
      if (summary) candidates.push(summary);
    }
  }
  return candidates
    .sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())[0] ?? null;
}

function createJobLogSummaryFromJob(job, filename, summarizer) {
  const logPath = job?.workDir ? join(job.workDir, filename) : null;
  if (!logPath || !existsSync(logPath)) return null;
  const log = readJsonFileSafe(logPath);
  if (!log) return null;
  return summarizer(log, job);
}

function createTrialFeedbackLogPublicSummary(log, job) {
  const latestRecord = Array.isArray(log.records) ? log.records[0] : null;
  return {
    schema: log.schema ?? "unknown",
    jobId: log.jobId ?? job.id,
    createdAt: log.createdAt ?? null,
    updatedAt: log.updatedAt ?? null,
    recordCount: Number(log.recordCount ?? (Array.isArray(log.records) ? log.records.length : 0)),
    latestRecordId: log.latestRecordId ?? null,
    latestOutcome: log.latestOutcome ?? null,
    latestIssues: Array.isArray(latestRecord?.issues) ? latestRecord.issues.slice(0, 8) : [],
    latestDownloadIntegrityBound: log.latestDownloadIntegrityBound ?? latestRecord?.downloadIntegrity?.packageBinding?.status ?? null,
    latestAllRequiredHashesVerified: Boolean(log.latestAllRequiredHashesVerified ?? latestRecord?.downloadIntegrity?.allRequiredHashesVerified),
    artifact: publicArtifactUrl(log.jobId ?? job.id, "trial-feedback-log.json")
  };
}

function createMachineAcceptanceLogPublicSummary(log, job) {
  return {
    schema: log.schema ?? "unknown",
    jobId: log.jobId ?? job.id,
    createdAt: log.createdAt ?? null,
    updatedAt: log.updatedAt ?? null,
    recordCount: Number(log.recordCount ?? (Array.isArray(log.records) ? log.records.length : 0)),
    latestRecordId: log.latestRecordId ?? null,
    latestOutcome: log.latestOutcome ?? null,
    latestAllRequiredPassed: Boolean(log.latestAllRequiredPassed),
    latestDownloadIntegrityBound: log.latestDownloadIntegrityBound ?? log.records?.[0]?.downloadIntegrity?.packageBinding?.status ?? null,
    artifact: publicArtifactUrl(log.jobId ?? job.id, "machine-acceptance-log.json")
  };
}

function createEngineHandoffStatus(externalCamHandoffs, engineId) {
  const handoff = externalCamHandoffs?.byEngine?.[engineId];
  if (!handoff) return "pending";
  return handoff.status === "completed" && handoff.simulationStatus === "completed" ? "done" : "blocked";
}

function createEngineHandoffDetail(externalCamHandoffs, engineId) {
  const handoff = externalCamHandoffs?.byEngine?.[engineId];
  if (!handoff) return `尚未验证 ${engineLabel(engineId)} 外部 handoff 小闭环。`;
  return `${handoff.id} / ${handoff.resultEngine} / ${handoff.source} / ${handoff.simulationEngine ?? "unknown"} / ${handoff.points ?? 0} 点 / synthetic=${handoff.syntheticSimulation}`;
}

function createEngineHandoffCommand(engineId) {
  if (engineId === "freecad") return "运行 npm run test:v3:freecad-external-handoff，验证 FreeCAD external G-code 摄取链路。";
  if (engineId === "blendercam") return "运行 npm run test:v3:blendercam-external-handoff，验证 BlenderCAM external G-code 摄取链路。";
  if (engineId === "opencamlib") return "运行 npm run test:v3:closed-neutral-handoff，验证 OpenCAMLib external neutral 摄取链路。";
  return `运行 ${engineLabel(engineId)} 外部 handoff 小闭环测试。`;
}

function engineLabel(engineId) {
  if (engineId === "freecad") return "FreeCAD";
  if (engineId === "blendercam") return "BlenderCAM/FabexCNC";
  if (engineId === "opencamlib") return "OpenCAMLib";
  return engineId;
}

function createExternalHandoffJobSummary(job) {
  const summary = job?.result?.summary;
  const simulation = summary?.simulation;
  const camoticsAdapter = simulation?.camoticsAdapter;
  const toolpathSummaryPath = job?.workDir ? join(job.workDir, "toolpath-summary.json") : null;
  const toolpathSummary = toolpathSummaryPath && existsSync(toolpathSummaryPath)
    ? readJsonFileSafe(toolpathSummaryPath)
    : null;
  const source = toolpathSummary?.source ?? (job?.result?.engine && job.result.engine !== "internal-mesh-cam" ? "external-adapter" : null);
  const resultEngine = job?.result?.engine ?? toolpathSummary?.engine ?? null;
  const hasExternalToolpath = source === "external-adapter" && resultEngine && resultEngine !== "internal-mesh-cam";
  const hasCamoticsResult = Boolean(camoticsAdapter?.status === "completed" || (job?.workDir && existsSync(join(job.workDir, "camotics-result.json"))));
  if (!hasExternalToolpath || !hasCamoticsResult) return null;
  return {
    id: job.id,
    status: job.status,
    updatedAt: job.updatedAt ?? job.createdAt,
    selectedEngine: job.selectedEngine,
    resultEngine,
    source,
    simulationEngine: simulation?.engine ?? null,
    simulationStatus: camoticsAdapter?.status ?? (hasCamoticsResult ? "completed" : null),
    syntheticSimulation: Boolean(camoticsAdapter?.synthetic),
    points: summary?.points ?? toolpathSummary?.points ?? null,
    postProcessorName: summary?.postProcessorName ?? toolpathSummary?.postProcessorName ?? null,
    packageLevel: summary?.productionGate?.level ?? summary?.deliveryManifest?.packageLevel ?? null,
    artifacts: {
      adapterReport: publicArtifactUrl(job.id, "adapter-report.json"),
      neutralToolpath: publicArtifactUrl(job.id, "neutral-toolpath.json"),
      camoticsResult: publicArtifactUrl(job.id, "camotics-result.json"),
      simulationSummary: publicArtifactUrl(job.id, "simulation-summary.json"),
      toolpath: publicArtifactUrl(job.id, "toolpath.nc")
    }
  };
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readLatestFromDirectory(relativeRoot, filename, mapper) {
  const root = join(process.cwd(), relativeRoot);
  if (!existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, path: join(root, entry.name, filename) }))
    .filter((entry) => existsSync(entry.path))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  if (!entries[0]) return null;
  try {
    return mapper(JSON.parse(readFileSync(entries[0].path, "utf8")), entries[0].id);
  } catch {
    return null;
  }
}

function createNativeCamRealOutputAcceptancePublicSummary(report, acceptanceId) {
  const adapters = Array.isArray(report.adapters) ? report.adapters : [];
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  return {
    id: acceptanceId,
    schema: report.schema ?? "hediao3d.native-cam-real-output-acceptance.v1",
    createdAt: report.createdAt ?? null,
    sourceReport: report.sourceReport ?? null,
    sourceReportBindingStatus: report.sourceReportBinding?.status ?? "missing",
    sourceReportBindingRequired: Boolean(report.sourceReportBinding?.required),
    sourceReportBindingSummary: report.sourceReportBinding?.summary ?? "未提供源报告绑定。",
    sourceReportSha256: report.sourceReportBinding?.expectedSha256 ?? report.sourceReportIdentity?.sha256 ?? null,
    level: report.level ?? (blockers.length ? "critical" : warnings.length ? "review" : "ready"),
    summary: `productionCandidate=${Number(report.productionCandidateCount ?? 0)} / unsafe=${Number(report.unsafeCount ?? 0)} / missing=${Number(report.missingCount ?? 0)}`,
    productionCandidateCount: Number(report.productionCandidateCount ?? 0),
    unsafeCount: Number(report.unsafeCount ?? 0),
    missingCount: Number(report.missingCount ?? 0),
    strict: Boolean(report.strict),
    expectProductionCandidate: Boolean(report.expectProductionCandidate),
    blockers: blockers.slice(0, 8),
    warnings: warnings.slice(0, 8),
    nextActions: Array.isArray(report.nextActions) ? report.nextActions.slice(0, 8) : [],
    adapters: adapters.slice(0, 8).map((adapter) => ({
      id: adapter.id,
      status: adapter.status ?? null,
      classification: adapter.classification ?? "missing",
      productionCandidate: Boolean(adapter.productionCandidate),
      fixture: Boolean(adapter.fixture),
      synthetic: Boolean(adapter.synthetic),
      previewScaffold: Boolean(adapter.previewScaffold),
      generatedByExternalCommand: Boolean(adapter.generatedByExternalCommand)
    }))
  };
}

function getLatestV3RunbookResult(res) {
  return json(res, 200, { latest: readLatestV3RunbookResultSummary() });
}

function readLatestV3RunbookResultSummary() {
  const resultPath = join(process.cwd(), "public", "orchestrator-readiness", "runbook-results", "v3-acceptance-runbook-result.json");
  if (!existsSync(resultPath)) return null;
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    return createV3RunbookResultPublicSummary(result, resultPath);
  } catch {
    return null;
  }
}

function createV3RunbookResultPublicSummary(result, resultPath) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const failedSteps = Array.isArray(result.failedSteps) ? result.failedSteps : steps
    .filter((step) => !step.ok)
    .map((step) => ({
      id: step.id,
      title: step.title,
      exitCode: step.exitCode,
      blocksProduction: Boolean(step.blocksProduction)
    }));
  const blockingFailedCount = Number.isFinite(Number(result.blockingFailedCount))
    ? Number(result.blockingFailedCount)
    : failedSteps.filter((step) => step.blocksProduction).length;
  const readinessReportId = result.readinessReportId ?? null;
  const linkedReadinessReportExists = readinessReportId
    ? existsSync(join(process.cwd(), "public", "orchestrator-readiness", String(readinessReportId), "v3-readiness-report.json"))
    : false;
  const commandCount = Number.isFinite(Number(result.commandCount)) ? Number(result.commandCount) : steps.length;
  const timeOrderValid = Boolean(result.readinessCreatedAt && result.runbookGeneratedAt && result.createdAt)
    && new Date(result.readinessCreatedAt).getTime() <= new Date(result.runbookGeneratedAt).getTime()
    && new Date(result.runbookGeneratedAt).getTime() <= new Date(result.createdAt).getTime();
  const identityValid = Boolean(readinessReportId && result.readinessCreatedAt && result.runbookGeneratedAt && linkedReadinessReportExists && timeOrderValid);
  return {
    schema: result.schema ?? "unknown",
    readinessReportId,
    readinessCreatedAt: result.readinessCreatedAt ?? null,
    runbookGeneratedAt: result.runbookGeneratedAt ?? null,
    createdAt: result.createdAt ?? null,
    ok: Boolean(result.ok),
    exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
    failedCount: Number.isFinite(Number(result.failedCount)) ? Number(result.failedCount) : failedSteps.length,
    blockingFailedCount,
    failedSteps: failedSteps.slice(0, 8).map((step) => ({
      id: step.id ?? "unknown",
      title: step.title ?? step.id ?? "unknown",
      exitCode: Number.isFinite(Number(step.exitCode)) ? Number(step.exitCode) : null,
      blocksProduction: Boolean(step.blocksProduction)
    })),
    stepCount: steps.length,
    commandCount,
    blockingStepCountAtReport: Number.isFinite(Number(result.blockingStepCountAtReport)) ? Number(result.blockingStepCountAtReport) : null,
    productionSafe: Boolean(result.productionSafe) && identityValid && blockingFailedCount === 0,
    identityValid,
    linkedReadinessReportExists,
    environment: result.environment && typeof result.environment === "object" ? {
      nodeVersion: result.environment.nodeVersion ?? null,
      platform: result.environment.platform ?? null,
      cwd: result.environment.cwd ?? null,
      apiBase: result.environment.apiBase ?? null
    } : null,
    levelAtReport: result.levelAtReport ?? null,
    acceptanceAtReport: result.acceptanceAtReport ?? null,
    artifactPath: resultPath
  };
}

function createCamoticsImportContractPublicSummary(report, contractId) {
  return {
    id: contractId,
    schema: report.schema ?? "unknown",
    createdAt: report.createdAt ?? null,
    ok: Boolean(report.ok),
    status: report.status ?? null,
    synthetic: Boolean(report.synthetic),
    riskLevel: report.riskLevel ?? null,
    materialRemovedMm3: report.materialRemovedMm3 ?? null,
    productionEvidenceEligible: Boolean(report.productionEvidenceEligible),
    inputIdentityStatus: report.inputIdentityStatus ?? report.evidenceQuality?.inputIdentity?.status ?? "missing",
    cliRunPackageBindingStatus: report.cliRunPackageBindingStatus ?? report.evidenceQuality?.inputIdentity?.cliRunPackage?.status ?? "not-required",
    motionConsistencyStatus: report.motionConsistencyStatus ?? report.evidenceQuality?.motionConsistency?.status ?? "missing",
    evidenceQualityStatus: report.evidenceQualityStatus ?? report.evidenceQuality?.status ?? null,
    adapterReport: report.adapterReport ?? null,
    camoticsResult: report.camoticsResult ?? null,
    outputRoot: report.outputRoot ?? null
  };
}

function createReadinessCamoticsEvidence({ camoticsImport, latestEvidenceDossier }) {
  const latestJobEvidence = createReadinessCamoticsEvidenceFromLatestJob(latestEvidenceDossier);
  if (camoticsImport && latestJobEvidence?.productionEvidenceEligible) {
    const importTime = new Date(camoticsImport.createdAt ?? 0).getTime();
    const jobTime = new Date(latestEvidenceDossier?.updatedAt ?? 0).getTime();
    if (!Number.isFinite(importTime) || !Number.isFinite(jobTime) || jobTime >= importTime) {
      return latestJobEvidence;
    }
  }
  if (camoticsImport) {
    return {
      schema: "hediao3d.readiness-camotics-evidence.v1",
      source: "camotics-import-contract",
      id: camoticsImport.id ?? null,
      jobId: camoticsImport.camoticsResult?.jobId ?? null,
      ok: Boolean(camoticsImport.ok),
      status: camoticsImport.status ?? null,
      synthetic: Boolean(camoticsImport.synthetic),
      riskLevel: camoticsImport.riskLevel ?? null,
      productionEvidenceEligible: Boolean(camoticsImport.productionEvidenceEligible),
      realMaterialRemovalVerified: Boolean(camoticsImport.productionEvidenceEligible && camoticsImport.synthetic === false),
      inputIdentityStatus: camoticsImport.inputIdentityStatus ?? "missing",
      cliRunPackageBindingStatus: camoticsImport.cliRunPackageBindingStatus ?? "not-required",
      motionConsistencyStatus: camoticsImport.motionConsistencyStatus ?? "missing",
      artifactEvidenceStatus: camoticsImport.evidenceQualityStatus ?? "unknown",
      summary: camoticsImport.productionEvidenceEligible
        ? "CAMotics 全局导入契约已达到材料去除证据标准。"
        : `CAMotics 全局导入契约未达到材料去除证据标准：${camoticsImport.status ?? "unknown"}。`
    };
  }
  if (latestJobEvidence) return latestJobEvidence;

  return {
    schema: "hediao3d.readiness-camotics-evidence.v1",
    source: "missing",
    id: null,
    jobId: latestEvidenceDossier?.jobId ?? null,
    ok: false,
    status: "missing",
    synthetic: null,
    riskLevel: null,
    productionEvidenceEligible: false,
    realMaterialRemovalVerified: false,
    inputIdentityStatus: "missing",
    cliRunPackageBindingStatus: "missing",
    motionConsistencyStatus: "missing",
    artifactEvidenceStatus: "missing",
    summary: "尚未找到 CAMotics 全局导入契约或最新 job 材料去除证据。"
  };
}

function createReadinessCamoticsEvidenceFromLatestJob(latestEvidenceDossier) {
  const crossChecks = latestEvidenceDossier?.crossChecks;
  if (!crossChecks) return null;

  const verified = Boolean(crossChecks.realMaterialRemovalVerified);
  const inputMatched = crossChecks.camoticsInputIdentityStatus === "matched";
  const cliMatched = ["matched", "not-required"].includes(crossChecks.camoticsCliRunPackageBindingStatus);
  const motionMatched = crossChecks.camoticsMotionConsistencyStatus === "matched";
  const artifactComplete = ["complete", "ready", "matched"].includes(crossChecks.camoticsArtifactEvidenceStatus);
  const eligible = verified && inputMatched && cliMatched && motionMatched && artifactComplete;
  return {
    schema: "hediao3d.readiness-camotics-evidence.v1",
    source: "latest-job-evidence-dossier",
    id: latestEvidenceDossier.artifact ?? null,
    jobId: latestEvidenceDossier.jobId ?? null,
    ok: eligible,
    status: eligible ? "completed" : verified ? "review" : "missing",
    synthetic: false,
    riskLevel: eligible ? "ready" : "review",
    productionEvidenceEligible: eligible,
    realMaterialRemovalVerified: verified,
    inputIdentityStatus: crossChecks.camoticsInputIdentityStatus ?? "missing",
    cliRunPackageBindingStatus: crossChecks.camoticsCliRunPackageBindingStatus ?? "missing",
    motionConsistencyStatus: crossChecks.camoticsMotionConsistencyStatus ?? "missing",
    artifactEvidenceStatus: crossChecks.camoticsArtifactEvidenceStatus ?? "missing",
    summary: eligible
      ? `最新 job ${latestEvidenceDossier.jobId} 的 production-evidence-dossier 已包含可用 CAMotics 材料去除证据。`
      : `最新 job ${latestEvidenceDossier.jobId ?? "unknown"} 的 CAMotics 证据仍需复核：verified=${verified} / input=${crossChecks.camoticsInputIdentityStatus ?? "missing"} / cli=${crossChecks.camoticsCliRunPackageBindingStatus ?? "missing"} / motion=${crossChecks.camoticsMotionConsistencyStatus ?? "missing"} / artifacts=${crossChecks.camoticsArtifactEvidenceStatus ?? "missing"}。`
  };
}

function createNeutralImportContractPublicSummary(report, contractId) {
  const sourceBinding = report.sourceBinding ?? report.neutralToolpathImportValidation?.sourceBinding ?? null;
  return {
    id: contractId,
    schema: report.schema ?? "unknown",
    createdAt: report.createdAt ?? null,
    ok: Boolean(report.ok),
    status: report.status ?? null,
    imported: Boolean(report.imported),
    synthetic: Boolean(report.synthetic),
    pointCount: Number.isFinite(Number(report.pointCount)) ? Number(report.pointCount) : null,
    postprocessEligible: Boolean(report.postprocessEligible),
    sourceBindingStatus: sourceBinding?.status ?? "missing",
    sourceBindingSummary: sourceBinding?.summary ?? null,
    adapterReport: report.adapterReport ?? null,
    neutralToolpath: report.neutralToolpath ?? null,
    outputRoot: report.outputRoot ?? null
  };
}

function readV3ReadinessSummary(reportId) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(reportId)) return null;
  const reportPath = join(process.cwd(), "public", "orchestrator-readiness", reportId, "v3-readiness-report.json");
  if (!existsSync(reportPath)) return null;
  try {
    return createV3ReadinessPublicSummary(JSON.parse(readFileSync(reportPath, "utf8")), reportId);
  } catch {
    return null;
  }
}

function createV3ReadinessPublicSummary(report, reportId) {
  return {
    id: reportId,
    schema: report.schema,
    createdAt: report.createdAt,
    level: report.level,
    summary: report.summary,
    gates: report.gates,
    acceptancePlan: report.acceptancePlan ?? { steps: [], nextStep: null },
    diagnostics: {
      level: report.diagnostics?.level ?? "unknown",
      summary: report.diagnostics?.summary ?? null
    },
    nativeCam: report.nativeCam ? {
      level: report.nativeCam.summary.level,
      readyCount: report.nativeCam.summary.readyCount,
      requiredCount: report.nativeCam.summary.requiredCount,
      serverPackage: createNativeCamServerPackageSummary(report.nativeCam)
    } : null,
    camServerConfig: report.camServerConfig ? {
      schema: report.camServerConfig.schema,
      status: report.camServerConfig.status,
      selectedEngine: report.camServerConfig.selectedEngine,
      selectedEngineName: report.camServerConfig.selectedEngineName,
      nativeCamLevel: report.camServerConfig.nativeCamLevel,
      missingRequired: report.camServerConfig.missingRequired ?? [],
      deploymentValidation: report.camServerConfig.deploymentValidation ? {
        schema: report.camServerConfig.deploymentValidation.schema,
        camMode: report.camServerConfig.deploymentValidation.camMode,
        requiredAdapters: report.camServerConfig.deploymentValidation.requiredAdapters ?? [],
        fixtureOrSyntheticMustBeOff: report.camServerConfig.deploymentValidation.fixtureOrSyntheticMustBeOff ?? [],
        productionUnlockRequires: report.camServerConfig.deploymentValidation.productionUnlockRequires ?? [],
        stages: (report.camServerConfig.deploymentValidation.stages ?? []).map((stage) => ({
          id: stage.id,
          title: stage.title,
          command: stage.command,
          expectedArtifacts: stage.expectedArtifacts ?? [],
          blocksProduction: Boolean(stage.blocksProduction)
        })),
        forbiddenProductionEnv: report.camServerConfig.deploymentValidation.forbiddenProductionEnv ?? []
      } : null
    } : null,
    adapterValidation: report.adapterValidation ? {
      failed: report.adapterValidation.overall.failed,
      generatedPlans: report.adapterValidation.overall.generatedPlans,
      completedAdapters: report.adapterValidation.overall.completedAdapters,
      readyForProduction: report.adapterValidation.overall.readyForProduction,
      handoffClassificationAudit: report.adapterValidation.handoffClassificationAudit ? {
        productionCandidateCount: Number(report.adapterValidation.handoffClassificationAudit.productionCandidateCount ?? 0),
        unsafeCount: Number(report.adapterValidation.handoffClassificationAudit.unsafeCount ?? 0),
        missingCount: Number(report.adapterValidation.handoffClassificationAudit.missingCount ?? 0),
        notGeneratedCount: Number(report.adapterValidation.handoffClassificationAudit.notGeneratedCount ?? 0),
        summary: report.adapterValidation.handoffClassificationAudit.summary ?? ""
      } : null
    } : null,
    nativeCamRealOutputAcceptance: report.nativeCamRealOutputAcceptance ?? null,
    runbookResult: report.runbookResult ?? null,
    externalHandoff: report.externalHandoff ?? null,
    externalCamHandoffs: report.externalCamHandoffs ?? null,
    neutralImport: report.neutralImport ?? null,
    postprocessHandoffReadiness: report.postprocessHandoffReadiness ?? null,
    camoticsImport: report.camoticsImport ?? null,
    readinessCamoticsEvidence: report.readinessCamoticsEvidence ?? null,
    latestJob: report.latestJob,
    latestTrialFeedback: report.latestTrialFeedback ?? null,
    latestMachineAcceptance: report.latestMachineAcceptance ?? null,
    latestEvidenceDossier: report.latestEvidenceDossier ?? null,
    apiArtifacts: createV3ReadinessArtifactLinks(reportId)
  };
}

function createNativeCamServerPackageSummary(nativeCam) {
  const files = nativeCam?.packageArtifacts?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  return {
    schema: nativeCam.packageArtifacts.schema ?? "hediao3d.native-cam-server-package.v1",
    files: files.map((file) => ({
      filename: file.filename,
      role: file.role,
      url: file.url ?? null
    })),
    commands: Array.isArray(nativeCam.packageArtifacts.commands)
      ? nativeCam.packageArtifacts.commands.slice(0, 6)
      : []
  };
}

function createV3ReadinessArtifactLinks(reportId) {
  return {
    json: `/api/orchestrator/readiness/${encodeURIComponent(reportId)}/v3-readiness-report.json`,
    markdown: `/api/orchestrator/readiness/${encodeURIComponent(reportId)}/v3-readiness-report.md`,
    runbook: `/api/orchestrator/readiness/${encodeURIComponent(reportId)}/v3-acceptance-runbook.sh`,
    camServerConfig: `/api/orchestrator/readiness/${encodeURIComponent(reportId)}/cam-server-config.json`
  };
}

function getV3ReadinessArtifact(reportId, filename, res) {
  const safeId = decodeURIComponent(reportId);
  const safeFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(safeId) || !/^[a-zA-Z0-9_.-]+$/.test(safeFilename)) {
    return json(res, 400, { error: "非法 V3 readiness 路径" });
  }
  const filePath = join(process.cwd(), "public", "orchestrator-readiness", safeId, safeFilename);
  if (!existsSync(filePath)) return json(res, 404, { error: "找不到 V3 readiness 产物" });
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": artifactContentType(safeFilename),
    "Content-Length": content.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

function createV3ReadinessMarkdown(report) {
  const lines = [
    "# HeDiao3D V3 Readiness Report",
    "",
    `Created: ${report.createdAt}`,
    `Level: ${report.level}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Adapter Handoff Audit",
    "",
    report.adapterValidation?.handoffClassificationAudit
      ? `productionCandidate=${report.adapterValidation.handoffClassificationAudit.productionCandidateCount}, unsafe=${report.adapterValidation.handoffClassificationAudit.unsafeCount}, missing=${report.adapterValidation.handoffClassificationAudit.missingCount}, notGenerated=${report.adapterValidation.handoffClassificationAudit.notGeneratedCount}`
      : "missing",
    report.adapterValidation?.handoffClassificationAudit?.summary ?? "",
    "",
    "## Gates",
    "",
    `- Production NC: ${report.gates.allowProductionNc ? "yes" : "no"}`,
    `- Trial NC: ${report.gates.allowTrialNc ? "yes" : "no"}`,
    `- Air run: ${report.gates.allowAirRun ? "yes" : "no"}`,
    "",
    "## Blockers",
    "",
    ...(report.gates.blockers.length ? report.gates.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Warnings",
    "",
    ...(report.gates.warnings.length ? report.gates.warnings.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Next Actions",
    "",
    ...(report.gates.nextActions.length ? report.gates.nextActions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Acceptance Plan",
    "",
    ...(report.acceptancePlan?.steps?.length
      ? report.acceptancePlan.steps.flatMap((step) => [
        `### ${step.order}. ${step.title}`,
        "",
        `- Status: ${step.status}`,
        `- Blocks production: ${step.blocksProduction ? "yes" : "no"}`,
        `- Command: ${step.command ?? "(manual)"}`,
        `- Evidence: ${step.evidence.join("; ")}`,
        `- Detail: ${step.detail}`,
        ""
      ])
      : ["- none"]),
    "",
    "## Components",
    "",
    `- Diagnostics: ${report.diagnostics?.level ?? "unknown"} / ${report.diagnostics?.summary ?? ""}`,
    `- Native CAM: ${report.nativeCam ? `${report.nativeCam.summary.readyCount}/${report.nativeCam.summary.requiredCount} ${report.nativeCam.summary.level}` : "missing"}`,
    `- Native CAM server package: ${report.nativeCam?.packageArtifacts?.files?.length ? report.nativeCam.packageArtifacts.files.map((file) => file.filename).join(", ") : "missing"}`,
    `- CAM server config: ${report.camServerConfig ? `${report.camServerConfig.status} / ${report.camServerConfig.selectedEngineName} / missing=${report.camServerConfig.missingRequired.length}` : "missing"}`,
    `- Adapter validation: ${report.adapterValidation ? `${report.adapterValidation.overall.generatedPlans} plans, ${report.adapterValidation.overall.failed} failed` : "missing"}`,
    `- Native CAM real output acceptance: ${report.nativeCamRealOutputAcceptance ? `${report.nativeCamRealOutputAcceptance.level} / productionCandidate=${report.nativeCamRealOutputAcceptance.productionCandidateCount} / unsafe=${report.nativeCamRealOutputAcceptance.unsafeCount} / missing=${report.nativeCamRealOutputAcceptance.missingCount}` : "missing"}`,
    `- Runbook result: ${report.runbookResult ? `${report.runbookResult.ok ? "ok" : "failed"} / ${report.runbookResult.failedCount} failed / blocking=${report.runbookResult.blockingFailedCount ?? "unknown"} / identity=${report.runbookResult.identityValid ? "valid" : "invalid"} / productionSafe=${report.runbookResult.productionSafe ? "yes" : "no"} / report=${report.runbookResult.readinessReportId ?? "missing"}` : "missing"}`,
    `- External handoff: ${report.externalHandoff ? `${report.externalHandoff.id} / ${report.externalHandoff.resultEngine} / ${report.externalHandoff.simulationEngine}` : "missing"}`,
    `- External CAM handoffs: ${report.externalCamHandoffs ? `${report.externalCamHandoffs.completedEngines.length}/${report.externalCamHandoffs.requiredEngines.length} engines (${report.externalCamHandoffs.completedEngines.join(", ") || "none"})` : "missing"}`,
    `- Neutral import: ${report.neutralImport ? `${report.neutralImport.status} / imported=${report.neutralImport.imported} / eligible=${report.neutralImport.postprocessEligible}` : "missing"}`,
    `- Postprocess handoff: ${report.postprocessHandoffReadiness ? `${report.postprocessHandoffReadiness.status} / required=${report.postprocessHandoffReadiness.required} / source=${report.postprocessHandoffReadiness.source}` : "missing"}`,
    `- CAMotics import: ${report.camoticsImport ? `${report.camoticsImport.status} / synthetic=${report.camoticsImport.synthetic} / eligible=${report.camoticsImport.productionEvidenceEligible}` : "missing"}`,
    `- CAMotics readiness evidence: ${report.readinessCamoticsEvidence ? `${report.readinessCamoticsEvidence.status} / source=${report.readinessCamoticsEvidence.source} / eligible=${report.readinessCamoticsEvidence.productionEvidenceEligible} / input=${report.readinessCamoticsEvidence.inputIdentityStatus} / motion=${report.readinessCamoticsEvidence.motionConsistencyStatus}` : "missing"}`,
    `- Latest job: ${report.latestJob ? `${report.latestJob.id} ${report.latestJob.status} ${report.latestJob.packageLevel ?? ""}` : "missing"}`,
    `- Latest trial feedback: ${report.latestTrialFeedback ? `${report.latestTrialFeedback.recordCount} records / ${report.latestTrialFeedback.latestOutcome ?? "unknown"}` : "missing"}`,
    `- Latest machine acceptance: ${report.latestMachineAcceptance ? `${report.latestMachineAcceptance.recordCount} records / ${report.latestMachineAcceptance.latestOutcome ?? "unknown"} / required=${report.latestMachineAcceptance.latestAllRequiredPassed ? "pass" : "review"}` : "missing"}`,
    `- Production evidence dossier: ${report.latestEvidenceDossier ? `${report.latestEvidenceDossier.status} / pass=${report.latestEvidenceDossier.passedCount} review=${report.latestEvidenceDossier.reviewCount} block=${report.latestEvidenceDossier.blockedCount}` : "missing"}`,
    `- Evidence cross checks: ${report.latestEvidenceDossier ? formatProductionEvidenceCrossChecksForReadiness(report.latestEvidenceDossier.crossChecks) : "missing"}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function createV3AcceptanceRunbookShell(report) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -u",
    "",
    "# HeDiao3D V3 deployment acceptance runbook",
    `# Readiness report: ${report.id}`,
    `# Generated: ${report.createdAt}`,
    `# Level: ${report.level}`,
    "",
    "ROOT_DIR=${ROOT_DIR:-$(pwd)}",
    "API_BASE=${API_BASE:-http://127.0.0.1:8787}",
    "RESULT_DIR=${RESULT_DIR:-public/orchestrator-readiness/runbook-results}",
    "RESULT_JSON=${RESULT_JSON:-${RESULT_DIR}/v3-acceptance-runbook-result.json}",
    "RESULT_STEPS_JSONL=${RESULT_STEPS_JSONL:-${RESULT_DIR}/v3-acceptance-runbook-steps.jsonl}",
    "cd \"$ROOT_DIR\"",
    "mkdir -p \"$RESULT_DIR\"",
    ": > \"$RESULT_STEPS_JSONL\"",
    "",
    "run_step() {",
    "  local id=\"$1\"",
    "  local status_at_report=\"$2\"",
    "  local blocks_production=\"$3\"",
    "  local evidence=\"$4\"",
    "  shift 4",
    "  local title=\"$1\"",
    "  local command=\"$2\"",
    "  echo",
    "  echo \"==> ${title}\"",
    "  echo \"    ${command}\"",
    "  bash -lc \"${command}\"",
    "  local code=$?",
    "  if [ $code -ne 0 ]; then",
    "    echo \"!! ${title} failed with exit code ${code}\"",
    "  fi",
    "  STEP_ID=\"$id\" STEP_TITLE=\"$title\" STEP_STATUS_AT_REPORT=\"$status_at_report\" STEP_BLOCKS_PRODUCTION=\"$blocks_production\" STEP_EVIDENCE=\"$evidence\" STEP_COMMAND=\"$command\" STEP_EXIT_CODE=\"$code\" node - <<'NODE' >> \"$RESULT_STEPS_JSONL\"",
    "const row = {",
    "  id: process.env.STEP_ID,",
    "  title: process.env.STEP_TITLE,",
    "  statusAtReport: process.env.STEP_STATUS_AT_REPORT,",
    "  blocksProduction: process.env.STEP_BLOCKS_PRODUCTION === 'true',",
    "  evidence: String(process.env.STEP_EVIDENCE || '').split('|').filter(Boolean),",
    "  command: process.env.STEP_COMMAND,",
    "  exitCode: Number(process.env.STEP_EXIT_CODE),",
    "  ok: Number(process.env.STEP_EXIT_CODE) === 0",
    "};",
    "console.log(JSON.stringify(row));",
    "NODE",
    "  return $code",
    "}",
    "",
    "echo \"HeDiao3D V3 acceptance runbook\"",
    "echo " + shellQuote(`Readiness report: ${report.id}`),
    "echo \"ROOT_DIR=${ROOT_DIR}\"",
    "echo \"API_BASE=${API_BASE}\"",
    "echo \"RESULT_JSON=${RESULT_JSON}\"",
    "echo \"This script only runs checks; it does not enable production switches.\"",
    "",
    "overall=0"
  ];
  for (const step of report.acceptancePlan?.steps ?? []) {
    const command = normalizeAcceptanceShellCommand(step.command);
    lines.push(
      "",
      `# ${step.order}. ${step.title}`,
      `# Status at report time: ${step.status}`,
      `# Evidence: ${step.evidence.join(", ")}`,
      `# Detail: ${step.detail}`,
      `run_step ${shellQuote(step.id)} ${shellQuote(step.status)} ${shellQuote(String(step.blocksProduction))} ${shellQuote(step.evidence.join("|"))} ${shellQuote(step.title)} ${shellQuote(command)} || overall=1`
    );
  }
  lines.push(
    "",
    "RESULT_OVERALL=\"$overall\" RESULT_READINESS_ID=" + shellQuote(report.id) + " RESULT_READINESS_CREATED_AT=" + shellQuote(report.createdAt) + " RESULT_RUNBOOK_GENERATED_AT=" + shellQuote(report.createdAt) + " RESULT_LEVEL=" + shellQuote(report.level) + " RESULT_ACCEPTANCE=" + shellQuote(`${report.acceptancePlan?.completed ?? 0}/${report.acceptancePlan?.total ?? 0}`) + " RESULT_COMMAND_COUNT=" + shellQuote(String(report.acceptancePlan?.steps?.length ?? 0)) + " RESULT_BLOCKING_STEP_COUNT=" + shellQuote(String((report.acceptancePlan?.steps ?? []).filter((step) => step.blocksProduction).length)) + " RESULT_API_BASE=\"$API_BASE\" node - <<'NODE'",
    "const fs = require('fs');",
    "const path = process.env.RESULT_JSON;",
    "const stepsPath = process.env.RESULT_STEPS_JSONL;",
    "const steps = fs.existsSync(stepsPath)",
    "  ? fs.readFileSync(stepsPath, 'utf8').split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))",
    "  : [];",
    "const failed = steps.filter((step) => !step.ok);",
    "const blockingFailed = failed.filter((step) => step.blocksProduction);",
    "const result = {",
    "  schema: 'hediao3d.v3-acceptance-runbook-result.v1',",
    "  readinessReportId: process.env.RESULT_READINESS_ID,",
    "  readinessCreatedAt: process.env.RESULT_READINESS_CREATED_AT,",
    "  runbookGeneratedAt: process.env.RESULT_RUNBOOK_GENERATED_AT,",
    "  createdAt: new Date().toISOString(),",
    "  levelAtReport: process.env.RESULT_LEVEL,",
    "  acceptanceAtReport: process.env.RESULT_ACCEPTANCE,",
    "  commandCount: Number(process.env.RESULT_COMMAND_COUNT),",
    "  blockingStepCountAtReport: Number(process.env.RESULT_BLOCKING_STEP_COUNT),",
    "  environment: {",
    "    nodeVersion: process.version,",
    "    platform: process.platform,",
    "    cwd: process.cwd(),",
    "    apiBase: process.env.RESULT_API_BASE",
    "  },",
    "  exitCode: Number(process.env.RESULT_OVERALL),",
    "  ok: Number(process.env.RESULT_OVERALL) === 0,",
    "  failedCount: failed.length,",
    "  blockingFailedCount: blockingFailed.length,",
    "  productionSafe: Number(process.env.RESULT_OVERALL) === 0 && blockingFailed.length === 0,",
    "  failedSteps: failed.map((step) => ({ id: step.id, title: step.title, exitCode: step.exitCode, blocksProduction: step.blocksProduction })),",
    "  steps",
    "};",
    "fs.writeFileSync(path, JSON.stringify(result, null, 2));",
    "NODE",
    "",
    "echo",
    "echo \"Acceptance evidence to review:\"",
    "echo \"- ${RESULT_JSON}\"",
    "echo \"- public/orchestrator-readiness/*/v3-readiness-report.json\"",
    "echo \"- public/orchestrator-readiness/*/cam-server-config.json\"",
    "echo \"- public/native-cam-readiness/*/native-cam-readiness.json\"",
    "echo \"- public/native-cam-readiness/*/native-cam-server-bootstrap.sh\"",
    "echo \"- public/native-cam-readiness/*/native-cam-env.template\"",
    "echo \"- public/native-cam-readiness/*/native-cam-acceptance-checklist.md\"",
    "echo \"- public/orchestrator-adapter-validation/*/v3-external-adapter-validation.json\"",
    "echo \"- public/orchestrator-jobs/*/production-gate.json\"",
    "echo",
    "if [ $overall -ne 0 ]; then",
    "  echo \"V3 acceptance checks completed with failures. Keep production NC locked.\"",
    "else",
    "  echo \"V3 acceptance checks executed. Review readiness reports before enabling production NC.\"",
    "fi",
    "exit $overall",
    ""
  );
  return lines.join("\n");
}

function normalizeAcceptanceShellCommand(command) {
  if (!command) return "true";
  return command
    .replaceAll("http://127.0.0.1:8787", "${API_BASE}")
    .replace("curl ${API_BASE}", "curl -fsS ${API_BASE}");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function runAdapterValidation(req, res) {
  const input = await readJson(req, 1_000_000).catch(() => ({}));
  const validationId = `validation-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = join(process.cwd(), "public", "orchestrator-adapter-validation", validationId);
  await mkdir(outputRoot, { recursive: true });
  const native = Boolean(input.native);
  const timeoutMs = Number(input.timeoutMs ?? process.env.V3_ADAPTER_VALIDATION_TIMEOUT_MS ?? 120000);
  const run = spawnSync(process.execPath, ["scripts/v3-external-adapter-validation.mjs", "--json-only"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs + 5000,
    env: {
      ...process.env,
      V3_ADAPTER_VALIDATION_DIR: outputRoot,
      V3_ADAPTER_VALIDATION_TIMEOUT_MS: String(timeoutMs),
      V3_ADAPTER_USE_NATIVE_COMMANDS: native ? "true" : "false"
    }
  });
  const summaryPath = join(outputRoot, "v3-external-adapter-validation.json");
  let summary = null;
  if (existsSync(summaryPath)) {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } else {
    summary = {
      schema: "hediao3d.external-adapter-validation.v1",
      createdAt: new Date().toISOString(),
      outputRoot,
      useNativeCommands: native,
      overall: {
        adapterCount: 0,
        failed: 1,
        generatedPlans: 0,
        completedAdapters: 0,
        readyForProduction: false,
        note: "Adapter validation script did not write a summary."
      },
      adapters: []
    };
  }

  summary.id = validationId;
  summary.apiArtifacts = createAdapterValidationArtifactLinks(validationId);
  summary.run = {
    exitCode: run.status,
    error: run.error?.message ?? null,
    stdoutTail: run.status === 0 ? "" : String(run.stdout ?? "").slice(-6000),
    stderrTail: String(run.stderr ?? "").slice(-6000)
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  return json(res, run.status === 0 || summary.overall?.generatedPlans > 0 ? 200 : 500, createAdapterValidationPublicSummary(summary, validationId));
}

function getLatestAdapterValidation(res) {
  const root = join(process.cwd(), "public", "orchestrator-adapter-validation");
  if (!existsSync(root)) return json(res, 200, { latest: null, validations: [] });
  const validations = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readAdapterValidationSummary(entry.name))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .slice(0, 12);
  return json(res, 200, {
    latest: validations[0] ?? null,
    validations
  });
}

function readAdapterValidationSummary(validationId) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(validationId)) return null;
  const summaryPath = join(process.cwd(), "public", "orchestrator-adapter-validation", validationId, "v3-external-adapter-validation.json");
  if (!existsSync(summaryPath)) return null;
  try {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    return createAdapterValidationPublicSummary(summary, validationId);
  } catch {
    return null;
  }
}

function createAdapterValidationPublicSummary(summary, validationId) {
  return {
    id: validationId,
    schema: summary.schema,
    createdAt: summary.createdAt,
    outputRoot: summary.outputRoot,
    useNativeCommands: Boolean(summary.useNativeCommands),
    timeoutMs: summary.timeoutMs,
    overall: summary.overall ?? {
      adapterCount: 0,
      failed: 1,
      generatedPlans: 0,
      completedAdapters: 0,
      readyForProduction: false,
      note: "Adapter validation summary is missing overall metrics."
    },
    nativeReadiness: createPublicNativeReadiness(summary.nativeReadiness),
    handoffClassificationAudit: summary.handoffClassificationAudit ? {
      schema: summary.handoffClassificationAudit.schema,
      readyForProduction: Boolean(summary.handoffClassificationAudit.readyForProduction),
      productionCandidateCount: Number(summary.handoffClassificationAudit.productionCandidateCount ?? 0),
      unsafeCount: Number(summary.handoffClassificationAudit.unsafeCount ?? 0),
      missingCount: Number(summary.handoffClassificationAudit.missingCount ?? 0),
      fixtureCount: Number(summary.handoffClassificationAudit.fixtureCount ?? 0),
      syntheticCount: Number(summary.handoffClassificationAudit.syntheticCount ?? 0),
      previewScaffoldCount: Number(summary.handoffClassificationAudit.previewScaffoldCount ?? 0),
      missingCamProofCount: Number(summary.handoffClassificationAudit.missingCamProofCount ?? 0),
      camProofReviewCount: Number(summary.handoffClassificationAudit.camProofReviewCount ?? 0),
      notGeneratedCount: Number(summary.handoffClassificationAudit.notGeneratedCount ?? 0),
      unboundProductionCandidateCount: Number(summary.handoffClassificationAudit.unboundProductionCandidateCount ?? 0),
      contactReportBindingCounts: {
        bound: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.bound ?? 0),
        missing: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.missing ?? 0),
        mismatch: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.mismatch ?? 0),
        review: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.review ?? 0),
        notChecked: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.notChecked ?? 0),
        other: Number(summary.handoffClassificationAudit.contactReportBindingCounts?.other ?? 0)
      },
      summary: summary.handoffClassificationAudit.summary ?? "",
      nextActions: Array.isArray(summary.handoffClassificationAudit.nextActions) ? summary.handoffClassificationAudit.nextActions.slice(0, 6) : [],
      adapters: Array.isArray(summary.handoffClassificationAudit.adapters)
        ? summary.handoffClassificationAudit.adapters.slice(0, 8).map((adapter) => ({
          id: adapter.id,
          classification: adapter.classification ?? "missing",
          outputKind: adapter.outputKind ?? null,
          productionCandidate: Boolean(adapter.productionCandidate),
          fixture: Boolean(adapter.fixture),
          synthetic: Boolean(adapter.synthetic),
          previewScaffold: Boolean(adapter.previewScaffold),
          notGenerated: Boolean(adapter.notGenerated),
          unsafe: Boolean(adapter.unsafe),
          generatedByExternalCommand: Boolean(adapter.generatedByExternalCommand),
          contactReport: adapter.contactReport ? {
            status: adapter.contactReport.status ?? "unknown",
            productionCandidate: Boolean(adapter.contactReport.productionCandidate),
            inputBindingStatus: adapter.contactReport.inputBindingStatus ?? "missing",
            reportSchema: adapter.contactReport.reportSchema ?? null,
            summary: adapter.contactReport.summary ?? ""
          } : null
        }))
        : []
    } : null,
    adapters: Array.isArray(summary.adapters)
      ? summary.adapters.map((adapter) => ({
        id: adapter.id,
        name: adapter.name ?? adapter.id,
        command: adapter.command ?? null,
        commandMode: adapter.commandMode ?? null,
        plan: {
          generated: Boolean(adapter.plan?.generated),
          path: adapter.plan?.metric?.planPath ?? adapter.plan?.metric?.runTemplatePath ?? null
        },
        report: {
          status: adapter.report?.status ?? null,
          error: adapter.report?.error ?? null
        },
        run: {
          exitCode: adapter.run?.exitCode ?? null,
          error: adapter.run?.error ?? null,
          durationMs: adapter.run?.durationMs ?? null
        },
        nativeSignals: adapter.nativeSignals ?? null,
        contactReport: adapter.contactReport ? {
          status: adapter.contactReport.status ?? "unknown",
          productionCandidate: Boolean(adapter.contactReport.productionCandidate),
          inputBindingStatus: adapter.contactReport.inputBindingStatus ?? "missing",
          reportSchema: adapter.contactReport.reportSchema ?? null,
          summary: adapter.contactReport.summary ?? ""
        } : null,
        handoffClassification: adapter.handoffEvidence?.classification ?? "missing",
        productionCandidate: Boolean(adapter.handoffEvidence?.productionCandidate),
        failed: Boolean(adapter.failed)
      }))
      : [],
    productionGuardrails: summary.productionGuardrails ? {
      schema: summary.productionGuardrails.schema,
      readyForProduction: Boolean(summary.productionGuardrails.readyForProduction),
      summary: summary.productionGuardrails.summary,
      requiredCount: Array.isArray(summary.productionGuardrails.required) ? summary.productionGuardrails.required.length : 0,
      nextActions: Array.isArray(summary.productionGuardrails.nextActions) ? summary.productionGuardrails.nextActions.slice(0, 8) : []
    } : null,
    apiArtifacts: createAdapterValidationArtifactLinks(validationId),
    run: {
      exitCode: summary.run?.exitCode ?? null,
      error: summary.run?.error ?? null,
      hasStdout: Boolean(summary.run?.stdoutTail),
      hasStderr: Boolean(summary.run?.stderrTail)
    }
  };
}

function createPublicNativeReadiness(nativeReadiness) {
  if (!nativeReadiness) {
    return {
      schema: "hediao3d.native-cam-readiness.v1",
      mode: "unknown",
      readyCount: 0,
      requiredCount: 0,
      level: "missing",
      summary: "Native CAM readiness report is missing.",
      blockers: [],
      nextActions: ["重新运行外部 Adapter 验证。"],
      adapters: []
    };
  }
  return {
    schema: nativeReadiness.schema,
    mode: nativeReadiness.mode,
    readyCount: nativeReadiness.readyCount,
    requiredCount: nativeReadiness.requiredCount,
    level: nativeReadiness.level,
    summary: nativeReadiness.summary,
    blockers: Array.isArray(nativeReadiness.blockers) ? nativeReadiness.blockers.slice(0, 8) : [],
    nextActions: Array.isArray(nativeReadiness.nextActions) ? nativeReadiness.nextActions.slice(0, 6) : [],
    adapters: Array.isArray(nativeReadiness.adapters)
      ? nativeReadiness.adapters.map((adapter) => ({
        id: adapter.id,
        ready: Boolean(adapter.ready),
        level: adapter.level,
        command: adapter.command ?? null,
        commandMode: adapter.commandMode ?? null,
        missing: Array.isArray(adapter.missing) ? adapter.missing.slice(0, 4) : []
      }))
      : []
  };
}

function createAdapterValidationArtifactLinks(validationId) {
  return {
    json: `/api/orchestrator/adapter-validation/${encodeURIComponent(validationId)}/v3-external-adapter-validation.json`,
    markdown: `/api/orchestrator/adapter-validation/${encodeURIComponent(validationId)}/v3-external-adapter-validation.md`
  };
}

function getAdapterValidationArtifact(validationId, filename, res) {
  const safeId = decodeURIComponent(validationId);
  const safeFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(safeId) || !/^[a-zA-Z0-9_.-]+$/.test(safeFilename)) {
    return json(res, 400, { error: "非法 adapter validation 路径" });
  }
  const filePath = join(process.cwd(), "public", "orchestrator-adapter-validation", safeId, safeFilename);
  if (!existsSync(filePath)) return json(res, 404, { error: "找不到 adapter validation 产物" });
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": artifactContentType(safeFilename),
    "Content-Length": content.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

async function runNativeCamReadinessCheck(req, res) {
  const input = await readJson(req, 100_000).catch(() => ({}));
  const checkId = `native-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = join(process.cwd(), "public", "native-cam-readiness", checkId);
  await mkdir(outputRoot, { recursive: true });
  const strict = Boolean(input.strict);
  const timeoutMs = Number(input.timeoutMs ?? process.env.V3_NATIVE_CAM_CHECK_TIMEOUT_MS ?? 60000);
  const args = ["scripts/v3-linux-native-cam-check.mjs"];
  if (strict) args.push("--strict");
  const run = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs + 5000,
    env: {
      ...process.env,
      V3_NATIVE_CAM_CHECK_DIR: outputRoot
    }
  });
  const reportPath = join(outputRoot, "native-cam-readiness.json");
  let report = null;
  if (existsSync(reportPath)) {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } else {
    report = {
      schema: "hediao3d.linux-native-cam-check.v1",
      createdAt: new Date().toISOString(),
      outputRoot,
      summary: {
        readyCount: 0,
        requiredCount: 4,
        level: "missing",
        summary: "Native CAM check script did not write a report.",
        blockers: ["Native CAM check report missing."],
        nextActions: ["查看服务器日志并重新运行 Native CAM 环境验收。"]
      },
      checks: []
    };
  }
  report.id = checkId;
  report.apiArtifacts = createNativeCamReadinessArtifactLinks(checkId);
  report.run = {
    exitCode: run.status,
    error: run.error?.message ?? null,
    stdoutTail: run.status === 0 ? "" : String(run.stdout ?? "").slice(-4000),
    stderrTail: String(run.stderr ?? "").slice(-4000)
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return json(res, run.status === 0 || report.summary ? 200 : 500, createNativeCamReadinessPublicSummary(report, checkId));
}

function getLatestNativeCamReadiness(res) {
  const root = join(process.cwd(), "public", "native-cam-readiness");
  if (!existsSync(root)) return json(res, 200, { latest: null, checks: [] });
  const checks = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readNativeCamReadinessSummary(entry.name))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .slice(0, 12);
  return json(res, 200, {
    latest: checks[0] ?? null,
    checks
  });
}

function readNativeCamReadinessSummary(checkId) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(checkId)) return null;
  const reportPath = join(process.cwd(), "public", "native-cam-readiness", checkId, "native-cam-readiness.json");
  if (!existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    return createNativeCamReadinessPublicSummary(report, checkId);
  } catch {
    return null;
  }
}

function createNativeCamReadinessPublicSummary(report, checkId) {
  const summary = report.summary ?? {};
  return {
    id: checkId,
    schema: report.schema,
    createdAt: report.createdAt,
    outputRoot: report.outputRoot,
    host: report.host ?? null,
    summary: {
      readyCount: Number(summary.readyCount ?? 0),
      requiredCount: Number(summary.requiredCount ?? 0),
      level: summary.level ?? "missing",
      text: summary.summary ?? "Native CAM readiness summary missing.",
      capabilityMatrix: Array.isArray(summary.capabilityMatrix)
        ? summary.capabilityMatrix.map((item) => ({
          id: item.id,
          name: item.name,
          level: item.level,
          ready: Boolean(item.ready),
          category: item.category,
          integrationRole: item.integrationRole,
          supportedWorkflows: Array.isArray(item.supportedWorkflows) ? item.supportedWorkflows.slice(0, 8) : [],
          outputFormats: Array.isArray(item.outputFormats) ? item.outputFormats.slice(0, 6) : [],
          productionGate: item.productionGate
        }))
        : [],
      integrationStrategy: summary.integrationStrategy ? {
        schema: summary.integrationStrategy.schema ?? null,
        summary: summary.integrationStrategy.summary ?? null,
        recommendedStack: Array.isArray(summary.integrationStrategy.recommendedStack)
          ? summary.integrationStrategy.recommendedStack.slice(0, 6).map((item) => ({
            id: item.id,
            role: item.role,
            priority: item.priority,
            purpose: item.purpose,
            handoff: item.handoff,
            limits: item.limits
          }))
          : [],
        rolloutStages: Array.isArray(summary.integrationStrategy.rolloutStages)
          ? summary.integrationStrategy.rolloutStages.slice(0, 8)
          : [],
        productionBoundary: Array.isArray(summary.integrationStrategy.productionBoundary)
          ? summary.integrationStrategy.productionBoundary.slice(0, 6)
          : []
      } : null,
      executionPlan: summary.executionPlan ? {
        schema: summary.executionPlan.schema ?? null,
        summary: summary.executionPlan.summary ?? null,
        strategy: summary.executionPlan.strategy ?? null,
        readyStages: Number(summary.executionPlan.readyStages ?? 0),
        totalStages: Number(summary.executionPlan.totalStages ?? 0),
        stages: Array.isArray(summary.executionPlan.stages)
          ? summary.executionPlan.stages.slice(0, 8).map((stage) => ({
            id: stage.id,
            order: stage.order,
            title: stage.title,
            engineId: stage.engineId,
            phase: stage.phase,
            priority: stage.priority,
            status: stage.status,
            engineReady: Boolean(stage.engineReady),
            engineLevel: stage.engineLevel,
            input: stage.input,
            output: stage.output,
            acceptance: stage.acceptance,
            handoff: stage.handoff,
            productionBoundary: stage.productionBoundary
          }))
          : [],
        globalAcceptanceCommands: Array.isArray(summary.executionPlan.globalAcceptanceCommands)
          ? summary.executionPlan.globalAcceptanceCommands.slice(0, 8)
          : [],
        productionLocks: Array.isArray(summary.executionPlan.productionLocks)
          ? summary.executionPlan.productionLocks.slice(0, 8)
          : []
      } : null,
      blockers: Array.isArray(summary.blockers) ? summary.blockers.slice(0, 8) : [],
      nextActions: Array.isArray(summary.nextActions) ? summary.nextActions.slice(0, 8) : []
    },
    checks: Array.isArray(report.checks)
      ? report.checks.map((check) => ({
        id: check.id,
        name: check.name,
        role: check.role,
        level: check.level,
        ready: Boolean(check.ready),
        capabilities: check.capabilities ? {
          category: check.capabilities.category,
          integrationRole: check.capabilities.integrationRole,
          inputFormats: Array.isArray(check.capabilities.inputFormats) ? check.capabilities.inputFormats.slice(0, 8) : [],
          outputFormats: Array.isArray(check.capabilities.outputFormats) ? check.capabilities.outputFormats.slice(0, 8) : [],
          supportedWorkflows: Array.isArray(check.capabilities.supportedWorkflows) ? check.capabilities.supportedWorkflows.slice(0, 8) : [],
          bestFor: Array.isArray(check.capabilities.bestFor) ? check.capabilities.bestFor.slice(0, 5) : [],
          notEnoughFor: Array.isArray(check.capabilities.notEnoughFor) ? check.capabilities.notEnoughFor.slice(0, 5) : [],
          projectUse: check.capabilities.projectUse ?? null,
          productionGate: check.capabilities.productionGate ?? null
        } : null,
        command: check.command ?? null,
        version: check.version ?? null,
        missing: Array.isArray(check.missing) ? check.missing.slice(0, 4) : []
      }))
      : [],
    apiArtifacts: createNativeCamReadinessArtifactLinks(checkId),
    packageArtifacts: report.artifacts ? {
      schema: report.artifacts.schema ?? null,
      files: Array.isArray(report.artifacts.files)
        ? report.artifacts.files.slice(0, 8).map((file) => ({
          filename: file.filename,
          role: file.role,
          description: file.description,
          url: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/${encodeURIComponent(file.filename)}`
        }))
        : [],
      commands: Array.isArray(report.artifacts.commands) ? report.artifacts.commands.slice(0, 8) : []
    } : null,
    run: {
      exitCode: report.run?.exitCode ?? null,
      error: report.run?.error ?? null,
      hasStdout: Boolean(report.run?.stdoutTail),
      hasStderr: Boolean(report.run?.stderrTail)
    }
  };
}

function createNativeCamReadinessArtifactLinks(checkId) {
  return {
    json: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-readiness.json`,
    markdown: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-readiness.md`,
    bootstrap: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-server-bootstrap.sh`,
    envTemplate: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-env.template`,
    checklist: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-acceptance-checklist.md`,
    realOutputCheck: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-real-output-check.sh`,
    packageManifest: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/native-cam-server-package.json`,
    packageZip: `/api/orchestrator/native-cam/${encodeURIComponent(checkId)}/server-package.zip`
  };
}

function getNativeCamServerPackage(checkId, res) {
  const safeId = decodeURIComponent(checkId);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(safeId)) {
    return json(res, 400, { error: "非法 native CAM readiness 路径" });
  }
  const root = join(process.cwd(), "public", "native-cam-readiness", safeId);
  const manifestPath = join(root, "native-cam-server-package.json");
  if (!existsSync(manifestPath)) return json(res, 404, { error: "找不到 native CAM 服务端包清单" });
  const manifest = readJsonFile(manifestPath);
  const listedFiles = Array.isArray(manifest?.files)
    ? manifest.files.map((file) => file.filename).filter((filename) => /^[a-zA-Z0-9_.-]+$/.test(String(filename)))
    : [];
  const requiredFiles = [
    "native-cam-readiness.json",
    "native-cam-readiness.md",
    "native-cam-server-bootstrap.sh",
    "native-cam-env.template",
    "native-cam-acceptance-checklist.md",
    "native-cam-real-output-check.sh",
    "native-cam-server-package.json"
  ];
  const filenames = Array.from(new Set([...requiredFiles, ...listedFiles]));
  const missing = filenames.filter((filename) => !existsSync(join(root, filename)));
  if (missing.length) {
    return json(res, 409, {
      error: "native CAM 服务端包存在缺失文件，请重新运行验收检查",
      missing
    });
  }
  const files = filenames.map((filename) => ({
    name: `hediao3d-native-cam-server/${filename}`,
    content: readFileSync(join(root, filename))
  }));
  files.push({
    name: "hediao3d-native-cam-server/README-NATIVE-CAM.md",
    content: createNativeCamServerPackageReadme(safeId, manifest)
  });
  const zip = createServerZipBuffer(files);
  const filename = `hediao3d-native-cam-${safeId}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(zip);
}

function createNativeCamServerPackageReadme(checkId, manifest) {
  const commands = Array.isArray(manifest?.commands) ? manifest.commands : [];
  const lines = [
    "# HeDiao3D Native CAM Server Package",
    "",
    `Check ID: ${checkId}`,
    "",
    "## Purpose",
    "",
    "This package is for the Linux CAM server only. It prepares and validates FreeCAD CAM, BlenderCAM/FabexCNC, OpenCAMLib and CAMotics evidence for HeDiao3D V3.",
    "",
    "## First Steps",
    "",
    "- Read native-cam-acceptance-checklist.md.",
    "- Copy native-cam-env.template to your server environment file and keep synthetic CAMotics disabled.",
    "- Run native-cam-server-bootstrap.sh in dry-run mode first.",
    "- Run native-cam-real-output-check.sh only after external CAM commands are configured.",
    "",
    "## Production Boundary",
    "",
    "- This ZIP does not unlock production NC.",
    "- Fixture, synthetic and preview scaffold outputs are contract evidence only.",
    "- Production unlock still requires non-synthetic CAM output, real material-removal simulation, air-run, trial feedback and machine acceptance bound to one job.",
    "",
    "## Commands",
    "",
    ...(commands.length ? commands.map((command) => `- ${command}`) : ["- See native-cam-acceptance-checklist.md."]),
    ""
  ];
  return lines.join("\n");
}

function getNativeCamReadinessArtifact(checkId, filename, res) {
  const safeId = decodeURIComponent(checkId);
  const safeFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(safeId) || !/^[a-zA-Z0-9_.-]+$/.test(safeFilename)) {
    return json(res, 400, { error: "非法 native CAM readiness 路径" });
  }
  const filePath = join(process.cwd(), "public", "native-cam-readiness", safeId, safeFilename);
  if (!existsSync(filePath)) return json(res, 404, { error: "找不到 native CAM readiness 产物" });
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": artifactContentType(safeFilename),
    "Content-Length": content.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(content);
}

async function importNativeCamRealOutputAcceptance(req, res) {
  const input = await readJson(req, 30_000_000).catch((error) => ({ error }));
  if (input.error) {
    return json(res, 400, { error: input.error instanceof Error ? input.error.message : "native CAM 真实输出验收 JSON 无法解析" });
  }
  let zipBundle = null;
  try {
    zipBundle = input.acceptanceZipDataUrl ? extractNativeCamRealOutputAcceptanceZipBundle(input.acceptanceZipDataUrl) : null;
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : "native CAM 真实输出验收 ZIP 无法解析" });
  }
  const acceptance = input.acceptance ?? zipBundle?.acceptance ?? input;
  const bindingInput = {
    ...input,
    ...(zipBundle?.validationReport && !input.validationReport ? { validationReport: zipBundle.validationReport } : {})
  };
  const validation = validateNativeCamRealOutputAcceptance(acceptance);
  if (!validation.ok) {
    return json(res, 400, { error: validation.error });
  }
  const sourceReportBinding = createNativeCamRealOutputSourceReportBinding(acceptance, bindingInput);
  if (sourceReportBinding.status === "mismatch") {
    return json(res, 400, {
      error: sourceReportBinding.summary,
      sourceReportBinding
    });
  }

  const importId = `imported-real-output-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = join(process.cwd(), "public", "orchestrator-adapter-validation", importId);
  await mkdir(outputRoot, { recursive: true });

  const imported = {
    ...acceptance,
    importedAt: new Date().toISOString(),
    importSource: {
      sourceName: typeof input.sourceName === "string" ? input.sourceName.slice(0, 160) : zipBundle?.sourceName ?? "native-cam-real-output-acceptance.json",
      route: "/api/orchestrator/native-cam/real-output-acceptance",
      note: "Imported from a Linux/native CAM server acceptance run. This evidence is consumed by readiness gates but does not unlock production by itself.",
      zipBundle: zipBundle ? "imported-native-cam-real-output-bundle.zip" : null
    },
    sourceReportBinding
  };
  await writeFile(join(outputRoot, "native-cam-real-output-acceptance.json"), JSON.stringify(imported, null, 2), "utf8");
  if (zipBundle) {
    await writeFile(join(outputRoot, "imported-native-cam-real-output-bundle.zip"), zipBundle.sourceBuffer);
  }
  await writeFile(join(outputRoot, "native-cam-real-output-import.json"), JSON.stringify({
    schema: "hediao3d.native-cam-real-output-import.v1",
    id: importId,
    createdAt: imported.importedAt,
    sourceName: imported.importSource.sourceName,
    zipBundle: imported.importSource.zipBundle,
    acceptanceSchema: imported.schema,
    acceptanceLevel: imported.level ?? null,
    sourceReportBinding,
    productionCandidateCount: Number(imported.productionCandidateCount ?? 0),
    unsafeCount: Number(imported.unsafeCount ?? 0),
    missingCount: Number(imported.missingCount ?? 0)
  }, null, 2), "utf8");

  const summary = createNativeCamRealOutputAcceptancePublicSummary(imported, importId);
  return json(res, 200, {
    ...summary,
    apiArtifacts: {
      json: `/api/orchestrator/adapter-validation/${encodeURIComponent(importId)}/native-cam-real-output-acceptance.json`,
      importJson: `/api/orchestrator/adapter-validation/${encodeURIComponent(importId)}/native-cam-real-output-import.json`,
      ...(zipBundle ? { zipBundle: `/api/orchestrator/adapter-validation/${encodeURIComponent(importId)}/imported-native-cam-real-output-bundle.zip` } : {})
    }
  });
}

function extractNativeCamRealOutputAcceptanceZipBundle(value) {
  const buffer = decodeInlineFile(value);
  const entries = extractZipEntries(buffer);
  const findEntry = (predicate) => entries.find((entry) => predicate(entry.name.toLowerCase()));
  const acceptanceEntry = findEntry((name) => /(^|\/)native-cam-real-output-acceptance\.json$/.test(name));
  if (!acceptanceEntry) throw new Error("ZIP 中找不到 native-cam-real-output-acceptance.json。");
  const validationEntry = findEntry((name) => /(^|\/)v3-external-adapter-validation\.json$/.test(name));
  return {
    sourceBuffer: buffer,
    sourceName: "native-cam-real-output-bundle.zip",
    acceptance: parseJsonBuffer(acceptanceEntry.content, "native-cam-real-output-acceptance.json"),
    validationReport: validationEntry ? parseJsonBuffer(validationEntry.content, "v3-external-adapter-validation.json") : null,
    entries: entries.map((entry) => ({
      name: entry.name,
      sizeBytes: entry.content.length
    }))
  };
}

function createNativeCamRealOutputSourceReportBinding(acceptance, input) {
  const suppliedReport = input?.validationReport && typeof input.validationReport === "object"
    ? JSON.stringify(input.validationReport, null, 2)
    : typeof input?.validationReportText === "string"
      ? input.validationReportText
      : null;
  const suppliedSha256 = suppliedReport ? createHash("sha256").update(suppliedReport).digest("hex") : null;
  const expected = acceptance?.sourceReportIdentity && typeof acceptance.sourceReportIdentity === "object"
    ? acceptance.sourceReportIdentity
    : null;
  const expectedSha256 = typeof expected?.sha256 === "string" ? expected.sha256.toLowerCase() : null;
  const suppliedSchema = input?.validationReport?.schema ?? null;
  const suppliedCreatedAt = input?.validationReport?.createdAt ?? null;
  if (suppliedSha256 && expectedSha256 && suppliedSha256 !== expectedSha256) {
    return {
      schema: "hediao3d.native-cam-source-report-binding.v1",
      status: "mismatch",
      required: true,
      expectedSha256,
      suppliedSha256,
      sourceReport: acceptance?.sourceReport ?? null,
      suppliedSchema,
      suppliedCreatedAt,
      summary: "Native CAM 真实输出验收与随附 v3-external-adapter-validation.json 哈希不匹配。"
    };
  }
  if (suppliedSha256 && !expectedSha256) {
    return {
      schema: "hediao3d.native-cam-source-report-binding.v1",
      status: "unclaimed-supplied",
      required: false,
      expectedSha256: null,
      suppliedSha256,
      sourceReport: acceptance?.sourceReport ?? null,
      suppliedSchema,
      suppliedCreatedAt,
      summary: "已随附 v3-external-adapter-validation.json，但 acceptance 未声明 sourceReportIdentity.sha256。"
    };
  }
  if (!suppliedSha256 && expectedSha256) {
    return {
      schema: "hediao3d.native-cam-source-report-binding.v1",
      status: "missing-supplied-report",
      required: true,
      expectedSha256,
      suppliedSha256: null,
      sourceReport: acceptance?.sourceReport ?? null,
      suppliedSchema: null,
      suppliedCreatedAt: null,
      summary: "acceptance 声明了 sourceReportIdentity.sha256，但导入时未随附 v3-external-adapter-validation.json。"
    };
  }
  if (suppliedSha256 && expectedSha256 && suppliedSha256 === expectedSha256) {
    return {
      schema: "hediao3d.native-cam-source-report-binding.v1",
      status: "matched",
      required: true,
      expectedSha256,
      suppliedSha256,
      sourceReport: acceptance?.sourceReport ?? null,
      suppliedSchema,
      suppliedCreatedAt,
      summary: "Native CAM 真实输出验收已绑定随附 v3-external-adapter-validation.json。"
    };
  }
  return {
    schema: "hediao3d.native-cam-source-report-binding.v1",
    status: "missing",
    required: false,
    expectedSha256: null,
    suppliedSha256: null,
    sourceReport: acceptance?.sourceReport ?? null,
    suppliedSchema: null,
    suppliedCreatedAt: null,
    summary: "未提供 v3-external-adapter-validation.json 源报告哈希绑定；只能作为待复核证据。"
  };
}

function validateNativeCamRealOutputAcceptance(acceptance) {
  if (!acceptance || typeof acceptance !== "object") {
    return { ok: false, error: "native CAM 真实输出验收必须是 JSON object。" };
  }
  if (acceptance.schema !== "hediao3d.native-cam-real-output-acceptance.v1") {
    return { ok: false, error: "schema 必须是 hediao3d.native-cam-real-output-acceptance.v1。" };
  }
  if (!Array.isArray(acceptance.adapters)) {
    return { ok: false, error: "native CAM 真实输出验收缺少 adapters[]。" };
  }
  const allowedLevels = new Set(["ready", "review", "critical", "missing"]);
  if (acceptance.level && !allowedLevels.has(String(acceptance.level))) {
    return { ok: false, error: "native CAM 真实输出验收 level 必须是 ready/review/critical/missing。" };
  }
  const allowedClassifications = new Set([
    "production-candidate",
    "fixture-contract",
    "synthetic-contract",
    "preview-scaffold",
    "missing-contact-report",
    "contact-report-review",
    "missing-cam-proof",
    "cam-proof-review",
    "not-generated",
    "internal-fallback",
    "missing"
  ]);
  for (const adapter of acceptance.adapters) {
    if (!adapter || typeof adapter !== "object" || typeof adapter.id !== "string" || !adapter.id.trim()) {
      return { ok: false, error: "adapters[] 中每项必须包含 id。" };
    }
    if (adapter.classification && !allowedClassifications.has(String(adapter.classification))) {
      return { ok: false, error: `adapter ${adapter.id} 的 classification 不受支持：${adapter.classification}` };
    }
  }
  return { ok: true };
}

function createToolpathFromAdapterReport(adapterReport, job, settings, selectedEngine) {
  if (!adapterReport || adapterReport.status !== "completed") return null;
  const neutralToolpath = createToolpathFromNeutralAdapterOutput(adapterReport, job, settings, selectedEngine);
  if (neutralToolpath) return neutralToolpath;

  const candidatePath = adapterReport.gcodePath
    ?? adapterReport.outputs?.gcode
    ?? join(job.workDir, "toolpath.nc");
  if (!candidatePath || !existsSync(candidatePath)) return null;

  const gcode = readFileSync(candidatePath, "utf8");
  if (!gcode.trim()) return null;
  const points = parseGcodeMotionPoints(gcode, settings);
  const sourceSnapshot = createExternalHandoffSourceSnapshot(candidatePath, "gcode", {
    points,
    adapterReport,
    selectedEngine
  });
  const warnings = [
    `${selectedEngine.name} adapter 输出已由 Orchestrator 摄取。`,
    "外部 CAM G-code 已进入统一交付链路；正式上机前仍需 CAMotics/机床控制器复核。"
  ];
  if (points.length === 0) warnings.push("外部 G-code 未解析到 G0/G1 运动点，无法生成可靠 3D 预览。");
  const estimatedMinutes = Number(adapterReport.metrics?.estimatedMinutes ?? adapterReport.estimatedMinutes ?? estimateTravel(points, Number(settings.diameterMm) / 2) / Math.max(1, Number(settings.feedRate)));

  return {
    points,
    previewPoints: limitPreviewPoints(points.map((point) => ({ ...point, hit: true }))),
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: `${selectedEngine.name} adapter G-code + ${postProcessorName(settings.postProcessor)}`,
    externalSourceSnapshot: sourceSnapshot,
    summary: summarizePoints(points, [...warnings, ...(adapterReport.warnings ?? [])])
  };
}

function createToolpathFromNeutralAdapterOutput(adapterReport, job, settings, selectedEngine) {
  const candidatePath = adapterReport.neutralToolpathPath
    ?? adapterReport.outputs?.neutralToolpath
    ?? adapterReport.metrics?.neutralToolpath?.path
    ?? join(job.workDir, "neutral-toolpath.json");
  if (!candidatePath || !existsSync(candidatePath)) return null;

  let neutral;
  try {
    neutral = JSON.parse(readFileSync(candidatePath, "utf8"));
  } catch {
    return null;
  }

  const points = normalizeNeutralToolpathPoints(neutral, settings);
  if (points.length === 0) return null;
  const sourceSnapshot = createExternalHandoffSourceSnapshot(candidatePath, "neutral-toolpath", {
    neutral,
    points,
    adapterReport,
    selectedEngine
  });
  const estimatedMinutes = Number(
    adapterReport.metrics?.estimatedMinutes
      ?? neutral.estimatedMinutes
      ?? estimateTravel(points, Number(settings.diameterMm) / 2) / Math.max(1, Number(settings.feedRate))
  );
  const gcode = toGcode(points, settings, estimatedMinutes, `${selectedEngine.name} neutral adapter`);
  const warnings = [
    `${selectedEngine.name} adapter 输出中立刀位点，已由 HeDiao3D 后处理为机床 NC。`,
    "中立刀路已进入统一仿真和安全门禁；生产解锁仍需真实 CAM 环境、CAMotics/机床仿真和试雕记录。"
  ];
  if (neutral.schema !== "hediao3d.neutral-toolpath.v1") {
    warnings.push(`中立刀路 schema 为 ${neutral.schema ?? "unknown"}，建议升级到 hediao3d.neutral-toolpath.v1。`);
  }

  return {
    points,
    previewPoints: limitPreviewPoints(points.map((point) => ({ ...point, hit: true }))),
    gcode,
    tap: gcode,
    txt: gcode,
    csv: toCsv(points),
    estimatedMinutes,
    postProcessorName: `${selectedEngine.name} neutral + ${postProcessorName(settings.postProcessor)}`,
    externalSourceSnapshot: sourceSnapshot,
    summary: summarizePoints(points, [...warnings, ...(adapterReport.warnings ?? [])])
  };
}

function createExternalHandoffSourceSnapshot(filePath, kind, context = {}) {
  const bytes = readFileSync(filePath);
  const stats = statSync(filePath);
  const adapterReport = context.adapterReport ?? {};
  const selectedEngine = context.selectedEngine ?? {};
  const base = {
    schema: "hediao3d.external-handoff-source-snapshot.v1",
    kind,
    path: filePath,
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturedAt: new Date().toISOString(),
    selectedEngine: selectedEngine.id ?? null,
    adapterEngine: adapterReport.engine ?? selectedEngine.id ?? null,
    adapterStatus: adapterReport.status ?? null,
    generatedByExternalCommand: Boolean(adapterReport.externalCommand || adapterReport.metrics?.neutralToolpath?.generatedByExternalCommand || adapterReport.metrics?.externalCommand)
  };
  if (kind === "neutral-toolpath") {
    const neutral = context.neutral ?? {};
    return {
      ...base,
      neutral: {
        schema: neutral.schema ?? null,
        pointCount: Array.isArray(neutral.points) ? neutral.points.length : 0,
        normalizedPointCount: Array.isArray(context.points) ? context.points.length : 0,
        synthetic: Boolean(neutral.synthetic),
        fixture: Boolean(neutral.fixture),
        imported: Boolean(adapterReport.imported || adapterReport.metrics?.neutralToolpath?.imported),
        generatedByExternalCommand: Boolean(neutral.generatedByExternalCommand || base.generatedByExternalCommand),
        coordinate: neutral.coordinate ?? null,
        runner: neutral.runner
          ? {
              mode: neutral.runner.mode ?? null,
              heightfieldMode: /heightfield/i.test(String(neutral.runner.mode ?? "")) || Boolean(neutral.experimentalHeightfield),
              fixtureMode: /fixture/i.test(String(neutral.runner.mode ?? "")) || Boolean(neutral.fixture),
              previewScaffold: /preview|scaffold/i.test(String(neutral.runner.mode ?? "")) || Boolean(neutral.experimentalHeightfield),
              warning: neutral.runner.warning ?? null
            }
          : null
      }
    };
  }
  const text = bytes.toString("utf8");
  const motionLineCount = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line)).length;
  return {
    ...base,
    gcode: {
      motionLineCount,
      parsedPointCount: Array.isArray(context.points) ? context.points.length : 0,
      containsFixtureMarker: /fixture/i.test(text),
      containsPreviewScaffoldMarker: /fixture|contract|scaffold|preview/i.test(text.slice(0, 12000)),
      containsRotaryMarker: /ROTARY_WRAP_AXIS|A[-+]?\d|Y[-+]?\d/i.test(text.slice(0, 12000))
    }
  };
}

function createNeutralToolpathImportValidation(neutral, settings, source = {}) {
  const errors = [];
  const warnings = [];
  const points = Array.isArray(neutral?.points) ? neutral.points : [];
  const coordinate = neutral?.coordinate && typeof neutral.coordinate === "object" ? neutral.coordinate : {};
  const runner = neutral?.runner && typeof neutral.runner === "object" ? neutral.runner : null;
  const previewScaffold = Boolean(
    neutral?.experimentalHeightfield
    || /preview|scaffold/i.test(String(runner?.mode ?? ""))
    || /preview|scaffold/i.test(String(runner?.warning ?? ""))
  );

  if (neutral?.schema !== "hediao3d.neutral-toolpath.v1") {
    errors.push(`schema 必须是 hediao3d.neutral-toolpath.v1，当前为 ${neutral?.schema ?? "unknown"}。`);
  }
  if (!Array.isArray(neutral?.points)) {
    errors.push("points 必须是数组。");
  } else if (points.length === 0) {
    errors.push("points 不能为空。");
  }
  if (neutral?.synthetic === true) {
    errors.push("synthetic neutral-toolpath 只能用于合约测试，不能通过真实导入接口进入后处理。");
  }
  if (neutral?.fixture === true) {
    errors.push("fixture neutral-toolpath 只能用于合约测试，不能通过真实导入接口进入后处理。");
  }
  if (previewScaffold && source.allowPreviewScaffold !== true) {
    errors.push("preview/heightfield scaffold 只能用于预览验证，不能通过真实导入接口进入后处理。");
  } else if (previewScaffold) {
    warnings.push("preview/heightfield scaffold 仅允许进入外部 adapter trial-only 小闭环，不能作为生产级 OpenCAMLib 刀具接触证据。");
  }
  if (coordinate.depthAxis && String(coordinate.depthAxis).toUpperCase() !== "Z") {
    errors.push(`coordinate.depthAxis 必须是 Z，当前为 ${coordinate.depthAxis}。`);
  }
  if (coordinate.lengthAxis && String(coordinate.lengthAxis).toUpperCase() !== "X") {
    warnings.push(`coordinate.lengthAxis 为 ${coordinate.lengthAxis}，HeDiao3D 会按 X 长度轴解释。`);
  }

  const safeZ = Number(settings.safeZ ?? 0);
  const lengthLimit = Math.max(1, Number(settings.lengthMm ?? 0) / 2 + 5);
  const zFloor = safeZ - Math.max(1, Number(settings.depthMm ?? 0) + Number(settings.stockAllowance ?? 0) + 5);
  let invalidPointCount = 0;
  let missingRotaryCount = 0;
  let outOfRangeCount = 0;
  let deepestZ = Infinity;
  let shallowestZ = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [index, point] of points.entries()) {
    const x = Number(point?.x ?? point?.xMm ?? point?.lengthMm);
    const z = Number(point?.z ?? point?.zMm);
    const y = point?.y ?? point?.yMm;
    const a = point?.a ?? point?.aDeg ?? point?.angleDeg;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      invalidPointCount += 1;
      if (invalidPointCount <= 3) errors.push(`points[${index}] 缺少有效 x/z。`);
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    deepestZ = Math.min(deepestZ, z);
    shallowestZ = Math.max(shallowestZ, z);
    if (Math.abs(x) > lengthLimit || z < zFloor || z > safeZ + 5) {
      outOfRangeCount += 1;
    }
    if (settings.camMode === "rotaryWrap" && !Number.isFinite(Number(a)) && !Number.isFinite(Number(y))) {
      missingRotaryCount += 1;
      if (missingRotaryCount <= 3) errors.push(`points[${index}] 在旋转夹具模式下缺少 a/aDeg/angleDeg 或 y/yMm。`);
    }
  }
  if (invalidPointCount > 3) errors.push(`另有 ${invalidPointCount - 3} 个点缺少有效 x/z。`);
  if (missingRotaryCount > 3) errors.push(`另有 ${missingRotaryCount - 3} 个点缺少旋转角度/线性旋转坐标。`);
  if (outOfRangeCount > 0) {
    warnings.push(`${outOfRangeCount} 个点超出保守工件/Z 范围，需在 CAM 软件和空跑中复核。`);
  }

  const normalizedPoints = errors.length === 0 ? normalizeNeutralToolpathPoints(neutral, settings) : [];
  const level = errors.length ? "critical" : warnings.length ? "review" : "ready";
  return {
    schema: "hediao3d.neutral-toolpath-import-validation.v1",
    createdAt: new Date().toISOString(),
    status: level,
    postprocessEligible: errors.length === 0,
    summary: errors.length
      ? `neutral-toolpath 导入被拒绝：${errors[0]}`
      : warnings.length
        ? `neutral-toolpath 可进入后处理，但有 ${warnings.length} 个复核项。`
        : "neutral-toolpath 导入校验通过，可进入 HeDiao3D 后处理。",
    sourceName: source.sourceName ?? null,
    engine: source.engine ?? neutral?.engine ?? null,
    sourceBinding: source.sourceBinding ?? null,
    classification: {
      synthetic: Boolean(neutral?.synthetic),
      fixture: Boolean(neutral?.fixture),
      previewScaffold,
      imported: true,
      generatedByExternalCommand: Boolean(neutral?.generatedByExternalCommand),
      allowPreviewScaffold: Boolean(source.allowPreviewScaffold)
    },
    coordinate: {
      lengthAxis: coordinate.lengthAxis ?? null,
      rotaryAxis: coordinate.rotaryAxis ?? null,
      depthAxis: coordinate.depthAxis ?? null,
      rotaryUnit: coordinate.rotaryUnit ?? null
    },
    metrics: {
      sourcePointCount: points.length,
      normalizedPointCount: normalizedPoints.length,
      invalidPointCount,
      missingRotaryCount,
      outOfRangeCount,
      xMin: Number.isFinite(minX) ? minX : null,
      xMax: Number.isFinite(maxX) ? maxX : null,
      zMin: Number.isFinite(deepestZ) ? deepestZ : null,
      zMax: Number.isFinite(shallowestZ) ? shallowestZ : null
    },
    errors,
    warnings,
    productionBoundary: [
      "该校验只证明 neutral-toolpath 可进入 HeDiao3D 后处理，不解锁生产 NC。",
      "生产仍需 production-candidate handoffEvidence、非 synthetic 材料去除仿真、空跑、软料试雕和机床验收。"
    ]
  };
}

function createNeutralToolpathSourceBinding(neutral, source = {}) {
  const submittedText = JSON.stringify(neutral, null, 2);
  return {
    schema: "hediao3d.neutral-toolpath-source-binding.v1",
    status: "pending",
    sourceName: source.sourceName ?? null,
    submitted: {
      sha256: createHash("sha256").update(submittedText).digest("hex"),
      sizeBytes: Buffer.byteLength(submittedText, "utf8"),
      schema: neutral?.schema ?? null,
      engine: neutral?.engine ?? null,
      pointCount: Array.isArray(neutral?.points) ? neutral.points.length : 0
    },
    importedArtifact: null,
    postprocessArtifact: null,
    sourceSnapshot: null,
    summary: "neutral-toolpath 输入已记录，等待写入导入/后处理产物。"
  };
}

async function createExternalAdapterNeutralToolpathValidation(job, settings, adapterReport, toolpath, selectedEngine) {
  if (!job?.workDir || !adapterReport || !toolpath?.externalSourceSnapshot) return null;
  if (toolpath.externalSourceSnapshot.kind !== "neutral-toolpath") return null;
  const neutralPath = join(job.workDir, "neutral-toolpath.json");
  if (!existsSync(neutralPath)) return null;
  const neutral = readJsonFile(neutralPath);
  if (!neutral) return null;

  const neutralText = JSON.stringify(neutral, null, 2);
  const neutralFileBytes = await readFile(neutralPath);
  const neutralFileSha256 = createHash("sha256").update(neutralFileBytes).digest("hex");
  const neutralSourceBinding = createNeutralToolpathSourceBinding(neutral, {
    sourceName: `${selectedEngine?.id ?? neutral.engine ?? "external"} adapter neutral-toolpath.json`
  });
  neutralSourceBinding.importedArtifact = {
    filename: "neutral-toolpath.json",
    sha256: neutralFileSha256,
    sizeBytes: neutralFileBytes.byteLength,
    matchesSubmitted: createHash("sha256").update(neutralText).digest("hex") === neutralSourceBinding.submitted.sha256,
    generatedByExternalAdapter: true
  };
  neutralSourceBinding.postprocessArtifact = {
    filename: "neutral-toolpath.json",
    sha256: neutralFileSha256,
    sizeBytes: neutralFileBytes.byteLength,
    derivedFromSubmitted: true,
    generatedByExternalAdapter: true
  };
  neutralSourceBinding.sourceSnapshot = {
    kind: toolpath.externalSourceSnapshot.kind,
    sha256: toolpath.externalSourceSnapshot.sha256,
    sizeBytes: toolpath.externalSourceSnapshot.sizeBytes,
    capturedAt: toolpath.externalSourceSnapshot.capturedAt,
    matchesPostprocessArtifact: toolpath.externalSourceSnapshot.sha256 === neutralSourceBinding.postprocessArtifact.sha256
  };
  neutralSourceBinding.status = neutralSourceBinding.importedArtifact.matchesSubmitted && neutralSourceBinding.sourceSnapshot.matchesPostprocessArtifact
    ? "bound"
    : "review";
  neutralSourceBinding.summary = neutralSourceBinding.status === "bound"
    ? "外部 adapter neutral-toolpath、后处理输入和 toolpath sourceSnapshot 已完成哈希绑定。"
    : "外部 adapter neutral-toolpath 绑定链路需要复核，请检查 adapter 输出、后处理输入和 sourceSnapshot。";

  const importValidation = createNeutralToolpathImportValidation(neutral, settings, {
    sourceName: neutralSourceBinding.sourceName,
    engine: String(selectedEngine?.id ?? neutral.engine ?? "external"),
    sourceBinding: neutralSourceBinding,
    allowPreviewScaffold: true
  });
  importValidation.sourceBinding = neutralSourceBinding;
  await writeFile(join(job.workDir, "neutral-toolpath-import-validation.json"), JSON.stringify(importValidation, null, 2), "utf8");

  const nextAdapterReport = {
    ...adapterReport,
    metrics: {
      ...(adapterReport.metrics ?? {}),
      neutralToolpath: {
        ...(adapterReport.metrics?.neutralToolpath ?? {}),
        importValidation: "neutral-toolpath-import-validation.json",
        sourceBinding: neutralSourceBinding
      }
    }
  };
  await writeFile(join(job.workDir, "adapter-report.json"), JSON.stringify(nextAdapterReport, null, 2), "utf8");
  pushIfArtifactExists(job, "neutral-toolpath-import-validation.json");
  return { validation: importValidation, adapterReport: nextAdapterReport };
}

async function createExternalAdapterGcodeValidation(job, adapterReport, toolpath, selectedEngine) {
  if (!job?.workDir || !adapterReport || !toolpath?.externalSourceSnapshot) return null;
  if (toolpath.externalSourceSnapshot.kind !== "gcode") return null;
  const sourcePath = adapterReport.gcodePath
    ?? adapterReport.outputs?.gcode
    ?? toolpath.externalSourceSnapshot.path
    ?? join(job.workDir, "toolpath.nc");
  if (!sourcePath || !existsSync(sourcePath)) return null;
  const finalPath = join(job.workDir, "toolpath.nc");
  if (!existsSync(finalPath)) return null;

  const sourceBytes = await readFile(sourcePath);
  const finalBytes = await readFile(finalPath);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const finalSha256 = createHash("sha256").update(finalBytes).digest("hex");
  const adapterEvidence = adapterReport.metrics?.handoffEvidence ?? null;
  const normalizedEvidence = normalizeAdapterHandoffEvidence(adapterReport);
  const camOutputProof = adapterEvidence?.camOutputProof ?? null;
  const proofIssues = Array.isArray(camOutputProof?.issues) ? camOutputProof.issues : [];
  const sourceMatchesSnapshot = sourceSha256 === toolpath.externalSourceSnapshot.sha256;
  const finalMatchesSource = finalSha256 === sourceSha256;
  const productionCandidate = Boolean(normalizedEvidence.productionCandidate && camOutputProof?.productionCandidate);
  const reviewIssues = [];
  const criticalIssues = [];
  const requiredActions = [];

  if (!sourceMatchesSnapshot) {
    criticalIssues.push("外部 G-code 源文件与 toolpath-summary 中的 sourceSnapshot 哈希不一致。");
  }
  if (!finalMatchesSource) {
    criticalIssues.push("最终 toolpath.nc 与外部 adapter G-code 源文件哈希不一致。");
  }
  if (!camOutputProof?.present) {
    reviewIssues.push("外部 G-code 缺少 CAM output proof，不能作为生产候选。");
    requiredActions.push("让 FreeCAD/BlenderCAM 服务端随 G-code 输出 .cam-proof.json，并包含 gcode/model/plan/job SHA-256。");
  } else if (!camOutputProof.productionCandidate) {
    reviewIssues.push(`CAM output proof 未通过生产候选校验：${proofIssues[0] ?? camOutputProof.status ?? "需要复核"}`);
    requiredActions.push("复核 .cam-proof.json 的 gcodeSha256、modelSha256、planSha256、fixture/scaffold 和 postprocessEligible 字段。");
  }
  if (normalizedEvidence.fixture) {
    reviewIssues.push("外部 G-code 被标记为 fixture/合约测试输出。");
    requiredActions.push("关闭 adapter runner fixture 输出，改用真实 CAM 计算结果。");
  }
  if (normalizedEvidence.previewScaffold) {
    reviewIssues.push("外部 G-code 被标记为 preview/scaffold 输出。");
    requiredActions.push("用真实刀具接触/材料去除 CAM 输出替代预览脚手架。");
  }
  if (!normalizedEvidence.generatedByExternalCommand) {
    reviewIssues.push("未检测到外部命令执行记录。");
    requiredActions.push("检查 adapter-report.json，确认 G-code 由外部 CAM 命令生成。");
  }

  const status = criticalIssues.length
    ? "critical"
    : productionCandidate && reviewIssues.length === 0
      ? "bound-production-candidate"
      : "bound-review";
  const validation = {
    schema: "hediao3d.external-gcode-import-validation.v1",
    createdAt: new Date().toISOString(),
    jobId: job.id,
    status,
    postprocessEligible: criticalIssues.length === 0,
    productionCandidate,
    engine: selectedEngine?.id ?? adapterReport.engine ?? null,
    sourceName: `${selectedEngine?.id ?? adapterReport.engine ?? "external"} adapter G-code`,
    sourceBinding: {
      schema: "hediao3d.external-gcode-source-binding.v1",
      status: criticalIssues.length ? "mismatch" : "bound",
      sourceArtifact: {
        path: sourcePath,
        sha256: sourceSha256,
        sizeBytes: sourceBytes.byteLength
      },
      postprocessArtifact: {
        filename: "toolpath.nc",
        sha256: finalSha256,
        sizeBytes: finalBytes.byteLength,
        derivedFromExternalGcode: true
      },
      sourceSnapshot: {
        kind: toolpath.externalSourceSnapshot.kind,
        sha256: toolpath.externalSourceSnapshot.sha256,
        sizeBytes: toolpath.externalSourceSnapshot.sizeBytes,
        capturedAt: toolpath.externalSourceSnapshot.capturedAt,
        matchesSourceArtifact: sourceMatchesSnapshot,
        matchesPostprocessArtifact: toolpath.externalSourceSnapshot.sha256 === finalSha256
      }
    },
    adapterHandoffEvidence: normalizedEvidence,
    camOutputProof,
    metrics: {
      motionLineCount: toolpath.externalSourceSnapshot.gcode?.motionLineCount ?? null,
      parsedPointCount: toolpath.externalSourceSnapshot.gcode?.parsedPointCount ?? null,
      containsFixtureMarker: Boolean(toolpath.externalSourceSnapshot.gcode?.containsFixtureMarker),
      containsPreviewScaffoldMarker: Boolean(toolpath.externalSourceSnapshot.gcode?.containsPreviewScaffoldMarker),
      containsRotaryMarker: Boolean(toolpath.externalSourceSnapshot.gcode?.containsRotaryMarker)
    },
    criticalIssues,
    warningIssues: reviewIssues,
    requiredActions,
    productionBoundary: [
      "该报告只证明外部 G-code 摄取链路和哈希绑定状态。",
      "生产 NC 仍需非 fixture/scaffold 的 CAM output proof、真实材料去除仿真、NC 静态分析、空跑、软料试雕和机床验收。"
    ],
    summary: criticalIssues.length
      ? `外部 G-code 绑定存在 ${criticalIssues.length} 个阻断项。`
      : reviewIssues.length
        ? `外部 G-code 已绑定，但有 ${reviewIssues.length} 个生产复核项。`
        : "外部 G-code、sourceSnapshot 和最终 toolpath.nc 已完成哈希绑定。"
  };

  await writeFile(join(job.workDir, "external-gcode-import-validation.json"), JSON.stringify(validation, null, 2), "utf8");
  const nextAdapterReport = {
    ...adapterReport,
    metrics: {
      ...(adapterReport.metrics ?? {}),
      gcode: {
        ...(adapterReport.metrics?.gcode ?? {}),
        importValidation: "external-gcode-import-validation.json",
        sourceBinding: validation.sourceBinding
      }
    }
  };
  await writeFile(join(job.workDir, "adapter-report.json"), JSON.stringify(nextAdapterReport, null, 2), "utf8");
  pushIfArtifactExists(job, "external-gcode-import-validation.json");
  return { validation, adapterReport: nextAdapterReport };
}

function normalizeNeutralToolpathPoints(neutral, settings) {
  const sourcePoints = Array.isArray(neutral?.points) ? neutral.points : [];
  const safeZ = Number(settings.safeZ ?? 0);
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const rotaryAxis = String(settings.rotaryOutputAxis ?? "Y").toUpperCase();
  const rotaryLinearToDeg = (value) => (Number(value) / wrapPerRev) * 360;

  return sourcePoints
    .map((point) => {
      const x = Number(point.x ?? point.xMm ?? point.lengthMm);
      const y = point.y ?? point.yMm;
      const a = point.a ?? point.aDeg ?? point.angleDeg;
      const z = Number(point.z ?? point.zMm);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      const normalized = {
        x,
        y: Number.isFinite(Number(y)) ? Number(y) : undefined,
        a: Number.isFinite(Number(a))
          ? Number(a)
          : settings.camMode === "rotaryWrap" && rotaryAxis !== "A" && Number.isFinite(Number(y))
            ? rotaryLinearToDeg(Number(y))
            : 0,
        z,
        depth: Number.isFinite(Number(point.depth)) ? Number(point.depth) : Math.max(0, safeZ - z)
      };
      if (settings.camMode === "3axis" && normalized.y == null) normalized.y = 0;
      return normalized;
    })
    .filter(Boolean);
}

function parseGcodeMotionPoints(gcode, settings) {
  const points = [];
  const current = { x: 0, y: 0, a: 0, z: Number(settings.safeZ ?? 0), depth: 0 };
  const safeZ = Number(settings.safeZ ?? 0);
  const rotaryAxis = settings.camMode === "rotaryWrap" ? String(settings.rotaryOutputAxis ?? "Y").toUpperCase() : null;
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  for (const rawLine of gcode.split(/\r?\n/)) {
    const line = rawLine.replace(/\([^)]*\)/g, "").trim().toUpperCase();
    if (!line || !/(?:\bG0?0\b|\bG0?1\b)/.test(line)) continue;
    const isCutFeedMove = /\bG0?1\b/.test(line);
    const x = parseGcodeWord(line, "X");
    const y = parseGcodeWord(line, "Y");
    const a = parseGcodeWord(line, "A");
    const z = parseGcodeWord(line, "Z");
    if (Number.isFinite(x)) current.x = x;
    if (Number.isFinite(y)) current.y = y;
    if (Number.isFinite(a)) current.a = a;
    if (Number.isFinite(z)) current.z = z;
    current.depth = Math.max(0, safeZ - current.z);
    if (settings.camMode === "rotaryWrap" && rotaryAxis && Number.isFinite(current[rotaryAxis.toLowerCase()])) {
      current.a = rotaryAxis === "A"
        ? Number(current.a ?? 0)
        : (Number(current[rotaryAxis.toLowerCase()] ?? 0) / wrapPerRev) * 360;
    }
    if (!isCutFeedMove || current.depth <= 0.001) continue;
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
  await attachCamSourceConversion(job, repairExecution);
  await attachRepairedMeshQuality(job, repairExecution);
  await writeFile(join(job.workDir, "repair-execution.json"), JSON.stringify(repairExecution, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "repair-execution.json"));
  pushRepairOutputArtifacts(job, repairExecution);
  appendOrchestratorLog(job, `Mesh 修复执行状态：${repairExecution.summary}`);
  await writeJobManifest(job);
  checkOrchestratorCancellation(job);

  updatePipelineStage(job, "cam-input", "running", "正在准备外部 CAM 输入模型和预处理策略。");
  const camInputPlan = createCamInputPlan(job, meshQuality, repairPlan, repairExecution, settings);
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
  const camEngineSelection = createCamEngineSelectionReport({
    requestedEngine: job.requestedEngine,
    selectedEngine: selected,
    engines,
    settings,
    camInputPlan,
    engineReadiness
  });
  await writeFile(join(job.workDir, "engine-diagnostics.json"), JSON.stringify(engineReadiness, null, 2), "utf8");
  await writeFile(join(job.workDir, "cam-engine-selection.json"), JSON.stringify(camEngineSelection, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "engine-diagnostics.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-engine-selection.json"));
  updatePipelineStage(job, "engine", engineReadiness.externalReady ? "completed" : "review", `选择 ${selected.name}；${engineReadiness.summary}`);
  const nativeCamReadiness = createNativeCamReadinessReport(engines, selected, settings, engineReadiness);
  await writeFile(join(job.workDir, "native-cam-readiness.json"), JSON.stringify(nativeCamReadiness, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "native-cam-readiness.json"));
  appendOrchestratorLog(job, `Native CAM 预检：${nativeCamReadiness.summary}`);
  const camServerConfig = createCamServerConfigReport({
    job,
    settings,
    engines,
    selectedEngine: selected,
    nativeCamReadiness,
    engineReadiness
  });
  await writeFile(join(job.workDir, "cam-server-config.json"), JSON.stringify(camServerConfig, null, 2), "utf8");
  await writeFile(join(job.workDir, "cam-server-prep-checklist.md"), createCamServerPrepChecklistMarkdown({ job, settings, selectedEngine: selected, nativeCamReadiness, camServerConfig }), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-server-config.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-server-prep-checklist.md"));
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
  const openSourceCamExecutionPlan = createJobOpenSourceCamExecutionPlan({
    job,
    settings,
    camInputPlan,
    selectedEngine: selected,
    engineReadiness,
    camEngineSelection,
    nativeCamReadiness,
    externalCamRecipe
  });
  await writeFile(join(job.workDir, "open-source-cam-execution-plan.json"), JSON.stringify(openSourceCamExecutionPlan, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "open-source-cam-execution-plan.json"));
  await writeAdapterJobSpec(job, settings, { camInputPlan, meshQuality, repairPlan, repairExecution, engineReadiness, externalCamRecipe, camServerConfig });
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
    pushIfArtifactExists(job, "opencamlib-kernel-plan.json");
    pushIfArtifactExists(job, "opencamlib-run-template.py");
    pushIfArtifactExists(job, "opencamlib-cutter-envelope-report.json");
    pushIfArtifactExists(job, "neutral-toolpath.json");
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
  const externalNeutralValidation = externalToolpath
    ? await createExternalAdapterNeutralToolpathValidation(job, settings, adapterReport, toolpath, selected)
    : null;
  if (externalNeutralValidation?.adapterReport) {
    adapterReport = externalNeutralValidation.adapterReport;
  }
  await writeFile(join(job.workDir, "toolpath.nc"), toolpath.gcode, "utf8");
  const externalGcodeValidation = externalToolpath
    ? await createExternalAdapterGcodeValidation(job, adapterReport, toolpath, selected)
    : null;
  if (externalGcodeValidation?.adapterReport) {
    adapterReport = externalGcodeValidation.adapterReport;
  }
  const camHandoffQuality = createCamHandoffQualityReport({
    job,
    settings,
    toolpath,
    selectedEngine: selected,
    resultEngine: externalToolpath ? selected.id : "internal-mesh-cam",
    adapterReport,
    externalToolpathUsed: Boolean(externalToolpath)
  });
  await writeFile(join(job.workDir, "cam-handoff-quality.json"), JSON.stringify(camHandoffQuality, null, 2), "utf8");
  await writeFile(join(job.workDir, "cam-handoff-evidence.md"), createCamHandoffEvidenceMarkdown(camHandoffQuality), "utf8");
  updatePipelineStage(job, "toolpath", "completed", `生成 ${toolpath.points.length} 个刀路点。`);
  updatePipelineStage(job, "simulation", "running", "正在生成自研旋转包裹预览、CAMotics 仿真输入和离料空跑。");
  const airRunGcode = createServerAirRunGcode(toolpath.points, settings, toolpath.estimatedMinutes, "V3 Orchestrator air run");
  const rotaryCalibrationAirRunGcode = createRotaryCalibrationAirRunGcode(settings);
  const camoticsPreviewGcode = createCamoticsPreviewGcode(toolpath.points, settings, toolpath.estimatedMinutes);
  const machineControllerProfile = createMachineControllerProfile(settings);
  const ncStaticAnalysis = createNcStaticAnalysis({
    settings,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "rotary-calibration-airrun.nc", role: "air-run", gcode: rotaryCalibrationAirRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  const controllerDialectReport = createControllerDialectReport({
    settings,
    machineControllerProfile,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "rotary-calibration-airrun.nc", role: "air-run", gcode: rotaryCalibrationAirRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  const internalSimulationSummary = createSimulationSummary(toolpath, settings, selected);
  await writeFile(join(job.workDir, "toolpath-summary.json"), JSON.stringify({
    engine: externalToolpath ? selected.id : "internal-mesh-cam",
    fallbackFrom: selected.id,
    source: externalToolpath ? "external-adapter" : "internal-fallback",
    externalSourceSnapshot: toolpath.externalSourceSnapshot ?? null,
    points: toolpath.points.length,
    previewPoints: toolpath.previewPoints?.length ?? 0,
    estimatedMinutes: toolpath.estimatedMinutes,
    postProcessorName: toolpath.postProcessorName,
    warnings: toolpath.summary?.warnings ?? []
  }, null, 2), "utf8");
  const camoticsInput = createCamoticsInputPlan(job, toolpath, settings, selected);
  const camoticsSimulationPlan = createCamoticsSimulationPlan(job, toolpath, settings, selected, camoticsInput);
  const camoticsCliExecutionPlan = createCamoticsCliExecutionPlan(job, camoticsInput, camoticsSimulationPlan, settings);
  const rotaryWrapPreviewReport = createRotaryWrapPreviewReport({
    job,
    settings,
    toolpath,
    machineGcode: toolpath.gcode,
    airRunGcode,
    camoticsPreviewGcode,
    ncStaticAnalysis,
    controllerDialectReport,
    machineControllerProfile,
    camoticsInput
  });
  const postprocessTraceReport = createPostprocessTraceReport({
    job,
    settings,
    toolpath,
    machineGcode: toolpath.gcode,
    machineControllerProfile
  });
  await writeFile(join(job.workDir, "machine-controller-profile.json"), JSON.stringify(machineControllerProfile, null, 2), "utf8");
  await writeFile(join(job.workDir, "nc-static-analysis.json"), JSON.stringify(ncStaticAnalysis, null, 2), "utf8");
  await writeFile(join(job.workDir, "controller-dialect-report.json"), JSON.stringify(controllerDialectReport, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-input.json"), JSON.stringify(camoticsInput, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-simulation-plan.json"), JSON.stringify(camoticsSimulationPlan, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-project-template.json"), JSON.stringify(camoticsSimulationPlan.projectTemplate, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-cli-execution-plan.json"), JSON.stringify(camoticsCliExecutionPlan, null, 2), "utf8");
  await writeFile(join(job.workDir, "rotary-wrap-preview-report.json"), JSON.stringify(rotaryWrapPreviewReport, null, 2), "utf8");
  await writeFile(join(job.workDir, "postprocess-trace-report.json"), JSON.stringify(postprocessTraceReport, null, 2), "utf8");
  await writeFile(join(job.workDir, "camotics-run.md"), createCamoticsRunbook(camoticsInput), "utf8");
  await writeFile(join(job.workDir, "camotics-preview.nc"), camoticsPreviewGcode, "utf8");
  await writeFile(join(job.workDir, "air-run.nc"), airRunGcode, "utf8");
  await writeFile(join(job.workDir, "rotary-calibration-airrun.nc"), rotaryCalibrationAirRunGcode, "utf8");
  const camoticsCliPackage = await prepareCamoticsCliPackageForJob(job, job.workDir);
  const camoticsAdapterReport = await runCamoticsSimulationAdapter(job, settings, camoticsInput, camoticsSimulationPlan);
  pushIfArtifactExists(job, "camotics-adapter-report.json");
  pushIfArtifactExists(job, "camotics-result.json");
  pushIfArtifactExists(job, "camotics-preview.png");
  pushIfArtifactExists(job, "camotics-material-removal.stl");
  const simulationSummary = mergeCamoticsSimulationResult(internalSimulationSummary, camoticsAdapterReport, job);
  await writeFile(join(job.workDir, "simulation-summary.json"), JSON.stringify(simulationSummary, null, 2), "utf8");
  updatePipelineStage(job, "simulation", "completed", `仿真 ${simulationSummary.engine}，贴合 ${simulationSummary.metrics.fitRate.toFixed(1)}%，未命中 ${simulationSummary.metrics.missCount} 点。`);
  updatePipelineStage(job, "postprocess", "running", "正在生成 V3 加工包门禁和交付清单。");
  const productionGate = createProductionGate({
    toolpath,
    settings,
    selectedEngine: selected,
    resultEngine: externalToolpath ? selected.id : "internal-mesh-cam",
    meshQuality,
    repairPlan,
    repairExecution,
    camInputPlan,
    engineReadiness,
    nativeCamReadiness,
    simulationSummary,
    camoticsInput,
    camHandoffQuality,
    neutralToolpathImportValidation: readJsonFile(join(job.workDir, "neutral-toolpath-import-validation.json")),
    postprocessTraceReport,
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
  const toolSetupSheet = createToolSetupSheet({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile
  });
  await writeFile(join(job.workDir, "tool-setup-sheet.json"), JSON.stringify(toolSetupSheet, null, 2), "utf8");
  const rotaryCalibrationSheet = createRotaryCalibrationSheet({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile,
    machineControllerProfile
  });
  await writeFile(join(job.workDir, "rotary-calibration-sheet.json"), JSON.stringify(rotaryCalibrationSheet, null, 2), "utf8");
  const machineAcceptanceChecklist = createMachineAcceptanceChecklist({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile,
    simulationSummary,
    ncStaticAnalysis,
    machineControllerProfile,
    controllerDialectReport
  });
  await writeFile(join(job.workDir, "machine-acceptance-checklist.json"), JSON.stringify(machineAcceptanceChecklist, null, 2), "utf8");
  const operatorRunbook = createOperatorRunbookMarkdown({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile,
    toolSetupSheet,
    rotaryCalibrationSheet,
    machineAcceptanceChecklist,
    ncStaticAnalysis,
    controllerDialectReport
  });
  await writeFile(join(job.workDir, "operator-runbook.md"), operatorRunbook, "utf8");
  const productionUnlockMatrix = createProductionUnlockMatrix({
    job,
    productionGate,
    meshQuality,
    repairPlan,
    camInputPlan,
    engineReadiness,
    nativeCamReadiness,
    simulationSummary,
    ncStaticAnalysis,
    camHandoffQuality,
    postprocessTraceReport,
    neutralToolpathImportValidation: readJsonFile(join(job.workDir, "neutral-toolpath-import-validation.json")),
    externalGcodeImportValidation: readJsonFile(join(job.workDir, "external-gcode-import-validation.json")),
    controllerDialectReport,
    toolSetupSheet,
    rotaryCalibrationSheet
  });
  await writeFile(join(job.workDir, "production-unlock-matrix.json"), JSON.stringify(productionUnlockMatrix, null, 2), "utf8");
  const trialFeedbackTemplate = createTrialFeedbackTemplate({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile,
    toolSetupSheet,
    rotaryCalibrationSheet,
    machineAcceptanceChecklist
  });
  await writeFile(join(job.workDir, "trial-feedback-template.json"), JSON.stringify(trialFeedbackTemplate, null, 2), "utf8");
  const productionEvidenceDossier = createProductionEvidenceDossier({
    job,
    productionGate,
    productionUnlockMatrix,
    camHandoffQuality,
    neutralToolpathImportValidation: readJsonFile(join(job.workDir, "neutral-toolpath-import-validation.json")),
    externalGcodeImportValidation: readJsonFile(join(job.workDir, "external-gcode-import-validation.json")),
    simulationSummary,
    ncStaticAnalysis,
    postprocessTraceReport,
    controllerDialectReport,
    machineAcceptanceChecklist
  });
  await writeFile(join(job.workDir, "production-evidence-dossier.json"), JSON.stringify(productionEvidenceDossier, null, 2), "utf8");
  const safeTrialExecutionPlan = createSafeTrialExecutionPlan({
    job,
    settings,
    productionGate,
    postprocessProfile,
    toolSetupSheet,
    rotaryCalibrationSheet,
    machineAcceptanceChecklist,
    productionEvidenceDossier
  });
  await writeFile(join(job.workDir, "safe-trial-execution-plan.json"), JSON.stringify(safeTrialExecutionPlan, null, 2), "utf8");
  await writeFile(join(job.workDir, "next-action-checklist.md"), createNextActionChecklistMarkdown({
    job,
    productionGate,
    productionUnlockMatrix,
    productionEvidenceDossier,
    safeTrialExecutionPlan,
    postprocessProfile,
    machineControllerProfile
  }), "utf8");
  const deliveryManifest = createDeliveryManifest(job, toolpath, productionGate, repairExecution);
  const machiningPackageIndex = createMachiningPackageIndex({
    job,
    toolpath,
    productionGate,
    postprocessProfile,
    simulationSummary,
    camoticsInput,
    camoticsSimulationPlan,
    camoticsCliExecutionPlan,
    rotaryWrapPreviewReport,
    camHandoffQuality,
    postprocessTraceReport,
    camServerConfig,
    productionEvidenceDossier,
    ncStaticAnalysis,
    nativeCamReadiness,
    camEngineSelection,
    openSourceCamExecutionPlan,
    machineControllerProfile,
    machineAcceptanceChecklist,
    controllerDialectReport,
    deliveryManifest
  });
  await writeFile(join(job.workDir, "production-gate.json"), JSON.stringify(productionGate, null, 2), "utf8");
  await writeFile(join(job.workDir, "postprocess-profile.json"), JSON.stringify(postprocessProfile, null, 2), "utf8");
  await writeFile(join(job.workDir, "machining-package-index.json"), JSON.stringify(machiningPackageIndex, null, 2), "utf8");
  await writeFile(join(job.workDir, "delivery-manifest.json"), JSON.stringify(deliveryManifest, null, 2), "utf8");
  await writeFile(join(job.workDir, "operator-download-checklist.md"), "# HeDiao3D V3 操作员下载核验清单\n\n生成中，请以最终 package-integrity.json 为准。\n", "utf8");
  let packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(job.workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");
  await writeFile(join(job.workDir, "operator-download-checklist.md"), createOperatorDownloadChecklistMarkdown({
    job,
    deliveryManifest,
    packageIntegrity,
    productionGate,
    machineControllerProfile,
    camHandoffQuality,
    simulationSummary
  }), "utf8");
  packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(job.workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");
  updatePipelineStage(job, "postprocess", productionGate.allowProductionNc ? "completed" : "review", productionGate.summary);
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "toolpath.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "toolpath-summary.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-handoff-quality.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-handoff-evidence.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "tool-setup-sheet.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "rotary-calibration-sheet.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "operator-runbook.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "production-unlock-matrix.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "production-evidence-dossier.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "safe-trial-execution-plan.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "next-action-checklist.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "open-source-cam-execution-plan.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-server-config.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "trial-feedback-template.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "simulation-summary.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "machine-controller-profile.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "machine-acceptance-checklist.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "nc-static-analysis.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "controller-dialect-report.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-input.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-simulation-plan.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-project-template.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-cli-execution-plan.json"));
  pushIfArtifactExists(job, "camotics-cli-run-package.json");
  pushIfArtifactExists(job, "camotics-result-template.json");
  pushIfArtifactExists(job, "camotics-linux-run.sh");
  pushIfArtifactExists(job, "camotics-result-validate.js");
  pushIfArtifactExists(job, "camotics-linux-operator-checklist.md");
  pushIfArtifactExists(job, "camotics-cli-package-report.json");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "rotary-wrap-preview-report.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "postprocess-trace-report.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "rotary-calibration-airrun.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-run.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-preview.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "air-run.nc"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "production-gate.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "postprocess-profile.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "machining-package-index.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "delivery-manifest.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "operator-download-checklist.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "package-integrity.json"));
  job.status = "completed";
  job.currentStage = "completed";
  job.progress = 100;
  job.result = {
    engine: externalToolpath ? selected.id : "internal-mesh-cam",
    fallbackFrom: selected.id,
    externalAvailable: selected.available,
    adapterReady: selected.adapterReady,
    adapterReport,
    camoticsAdapterReport,
    toolpath,
    summary: {
      meshQuality,
      repairPlan,
      repairExecution,
      camInputPlan,
      engineReadiness,
      camEngineSelection,
      nativeCamReadiness,
      camServerConfig,
      externalCamRecipe,
      openSourceCamExecutionPlan,
      adapterPreflight,
      productionGate,
      postprocessProfile,
      operatorRunbook: {
        schema: "hediao3d.operator-runbook.v1",
        artifact: "operator-runbook.md",
        summary: "操作员中文上机说明书已生成。"
      },
      safeTrialExecutionPlan: {
        schema: safeTrialExecutionPlan.schema,
        artifact: "safe-trial-execution-plan.json",
        stepCount: safeTrialExecutionPlan.steps.length,
        activeGate: safeTrialExecutionPlan.gate.packageLevel,
        allowTrialNc: safeTrialExecutionPlan.gate.allowTrialNc,
        allowAirRun: safeTrialExecutionPlan.gate.allowAirRun
      },
      toolSetupSheet,
      rotaryCalibrationSheet,
      productionUnlockMatrix,
      productionEvidenceDossier,
      trialFeedbackTemplate,
      camHandoffQuality,
      camoticsInput,
      camoticsSimulationPlan,
      camoticsCliExecutionPlan,
      camoticsCliPackage: camoticsCliPackage ? {
        status: camoticsCliPackage.status,
        ok: camoticsCliPackage.ok,
        artifact: "camotics-cli-run-package.json",
        resultTemplate: "camotics-result-template.json",
        linuxRunScript: "camotics-linux-run.sh",
        report: "camotics-cli-package-report.json",
        productionUnlockEligible: false,
        preferredGcodeSha256: camoticsCliPackage.preferredGcodeIdentity?.sha256 ?? null,
        motionProfile: camoticsCliPackage.preferredGcodeIdentity?.motionProfile ?? null
      } : null,
      rotaryWrapPreviewReport,
      postprocessTraceReport,
      ncStaticAnalysis,
      machineControllerProfile,
      machineAcceptanceChecklist,
      controllerDialectReport,
      machiningPackageIndex,
      deliveryManifest,
      packageIntegrity,
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
      preview: join(workDir, "preview.json"),
      neutralToolpath: join(workDir, "neutral-toolpath.json")
    }
  };
}

async function writeAdapterJobSpec(job, settings, extras = {}) {
  const jobSpec = createAdapterJobSpec(job, job.modelUrl, settings, job.workDir, job.requestedEngine);
  Object.assign(jobSpec, extras);
  if (extras.camInputPlan?.selectedModelPath) {
    jobSpec.modelPath = extras.camInputPlan.selectedModelPath;
    jobSpec.modelUrl = extras.camInputPlan.selectedModelUrl ?? job.modelUrl;
  }
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
  const meshQuality = await createMeshQualityReportForPath(localModelUrlToPath(job.modelUrl));
  await writeFile(join(job.workDir, "mesh-quality.json"), JSON.stringify(meshQuality, null, 2), "utf8");
  return meshQuality;
}

async function createMeshQualityReportForPath(modelPath) {
  let geometry;
  try {
    geometry = await loadModelGeometry(modelPath);
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.computeVertexNormals();
    return buildMeshQualityReport(geometry);
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
  const importedRepair = importExternalRepairArtifact(job);
  const outputCandidates = createRepairOutputCandidates(job, sourceModelPath);
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
  if (importedRepair.imported) {
    status = required ? "external-repair-imported" : "external-repair-available";
    summary = required
      ? "检测到外部修复 STL，已纳入 CAM 输入候选；正式生产前仍需复核修复后 Mesh 质量。"
      : "检测到外部修复 STL，可作为 CAM 输入候选；当前源模型未强制要求修复。";
  } else if (required && !autoRepairEnabled) {
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
    importedRepair,
    outputs: outputCandidates,
    outputCandidates: Object.fromEntries(outputCandidates.map((candidate) => [candidate.id, candidate.path])),
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

function createRepairOutputCandidates(job, sourceModelPath) {
  const candidates = [
    {
      id: "source",
      role: "source",
      label: "原始导入模型",
      filename: null,
      path: sourceModelPath,
      url: job.modelUrl,
      exists: existsSync(sourceModelPath),
      priority: 0,
      productionEligible: true,
      note: "未执行自动修复时的默认 CAM 输入。"
    },
    {
      id: "repairedStl",
      role: "mesh-heal",
      label: "封孔/修非流形后的 STL",
      filename: "repaired-model.stl",
      path: join(job.workDir, "repaired-model.stl"),
      url: publicArtifactUrl(job.id, "repaired-model.stl"),
      exists: existsSync(join(job.workDir, "repaired-model.stl")),
      priority: 30,
      productionEligible: true,
      note: "用于边界边、非流形边修复后的外部 CAM 输入。"
    },
    {
      id: "camSourceConvertedStl",
      role: "format-conversion",
      label: "外部CAM转换STL",
      filename: "cam-source-converted.stl",
      path: join(job.workDir, "cam-source-converted.stl"),
      url: publicArtifactUrl(job.id, "cam-source-converted.stl"),
      exists: existsSync(join(job.workDir, "cam-source-converted.stl")),
      priority: 25,
      productionEligible: false,
      note: "由 Orchestrator 从 GLB/GLTF 转换为 STL，优先供 OpenCAMLib/FreeCAD 等外部 CAM 小闭环使用。"
    },
    {
      id: "remeshedGlb",
      role: "remesh",
      label: "重网格后的 GLB",
      filename: "remeshed-model.glb",
      path: join(job.workDir, "remeshed-model.glb"),
      url: publicArtifactUrl(job.id, "remeshed-model.glb"),
      exists: existsSync(join(job.workDir, "remeshed-model.glb")),
      priority: 20,
      productionEligible: true,
      note: "用于 Meshy/Blender 重网格后的高质量曲面输入。"
    },
    {
      id: "camDecimatedStl",
      role: "cam-decimation",
      label: "CAM 降面 STL",
      filename: "cam-decimated-model.stl",
      path: join(job.workDir, "cam-decimated-model.stl"),
      url: publicArtifactUrl(job.id, "cam-decimated-model.stl"),
      exists: existsSync(join(job.workDir, "cam-decimated-model.stl")),
      priority: 10,
      productionEligible: true,
      note: "用于高面数模型的外部 CAM 加速输入。"
    }
  ];
  return candidates.map((candidate) => ({
    ...candidate,
    selectedForCam: false
  }));
}

function importExternalRepairArtifact(job) {
  const source = process.env.ORCHESTRATOR_REPAIRED_MODEL_PATH;
  const sourcePath = source ? join(process.cwd(), source) : null;
  const resolvedSource = source && existsSync(source) ? source : sourcePath && existsSync(sourcePath) ? sourcePath : null;
  const targetPath = join(job.workDir, "repaired-model.stl");
  if (!resolvedSource) {
    return {
      imported: false,
      sourcePath: source ?? null,
      targetPath,
      reason: source ? "configured repair artifact path does not exist" : "ORCHESTRATOR_REPAIRED_MODEL_PATH not configured"
    };
  }
  try {
    copyFileSync(resolvedSource, targetPath);
    return {
      imported: true,
      sourcePath: resolvedSource,
      targetPath,
      filename: "repaired-model.stl",
      url: publicArtifactUrl(job.id, "repaired-model.stl")
    };
  } catch (error) {
    return {
      imported: false,
      sourcePath: resolvedSource,
      targetPath,
      reason: error instanceof Error ? error.message : "failed to copy repaired model"
    };
  }
}

async function attachRepairedMeshQuality(job, repairExecution) {
  const repaired = repairExecution?.outputs?.find((output) => output.id === "repairedStl" && output.exists);
  if (!repaired?.path) return;
  try {
    const quality = await createMeshQualityReportForPath(repaired.path);
    repairExecution.repairedMeshQuality = {
      ...quality,
      artifact: publicArtifactUrl(job.id, "repaired-mesh-quality.json"),
      modelPath: repaired.path,
      modelUrl: repaired.url ?? null
    };
    await writeFile(join(job.workDir, "repaired-mesh-quality.json"), JSON.stringify(repairExecution.repairedMeshQuality, null, 2), "utf8");
  } catch (error) {
    repairExecution.repairedMeshQuality = {
      error: error instanceof Error ? error.message : "failed to inspect repaired mesh",
      artifact: null,
      modelPath: repaired.path,
      modelUrl: repaired.url ?? null
    };
  }
}

async function attachCamSourceConversion(job, repairExecution) {
  const conversionEnabled = enableExternalCamAdapters || String(process.env.ORCHESTRATOR_PREPARE_CAM_STL ?? "").toLowerCase() === "true";
  if (!conversionEnabled) return;
  const sourceModelPath = repairExecution?.sourceModelPath ?? localModelUrlToPath(job.modelUrl);
  if (!/\.(glb|gltf)$/i.test(sourceModelPath)) return;
  const targetPath = join(job.workDir, "cam-source-converted.stl");
  const targetUrl = publicArtifactUrl(job.id, "cam-source-converted.stl");
  const output = repairExecution?.outputs?.find((candidate) => candidate.id === "camSourceConvertedStl");
  try {
    const geometry = await loadModelGeometry(sourceModelPath);
    try {
      const conversion = geometryToAsciiStl(geometry, "hediao3d_cam_source_converted", {
        maxTriangles: getCamStlMaxTriangles()
      });
      await writeFile(targetPath, conversion.stl, "utf8");
      repairExecution.camSourceConversionStats = {
        originalTriangleCount: conversion.originalTriangleCount,
        exportedTriangleCount: conversion.exportedTriangleCount,
        decimated: conversion.decimated,
        stride: conversion.stride,
        maxTriangles: conversion.maxTriangles,
        strategy: conversion.strategy,
        baseKeptCount: conversion.baseKeptCount,
        curvatureKeptCount: conversion.curvatureKeptCount
      };
    } finally {
      geometry.dispose?.();
    }
    if (output) {
      output.exists = true;
      output.conversionStatus = "completed";
      output.note = "由 Orchestrator 从 GLB/GLTF 自动转换，用于 FreeCAD/OpenCAMLib 等外部 CAM 输入。";
    }
    repairExecution.camSourceConversion = {
      schema: "hediao3d.cam-source-conversion.v1",
      status: "completed",
      sourcePath: sourceModelPath,
      sourceUrl: job.modelUrl,
      targetPath,
      targetUrl,
      format: "stl",
      stats: repairExecution.camSourceConversionStats,
      summary: "已将 GLB/GLTF 转换为 STL，供外部 CAM adapter 使用。"
    };
  } catch (error) {
    if (output) {
      output.exists = false;
      output.conversionStatus = "failed";
      output.note = error instanceof Error ? error.message : "GLB/GLTF 转 STL 失败。";
    }
    repairExecution.camSourceConversion = {
      schema: "hediao3d.cam-source-conversion.v1",
      status: "failed",
      sourcePath: sourceModelPath,
      sourceUrl: job.modelUrl,
      targetPath,
      targetUrl,
      format: "stl",
      stats: repairExecution.camSourceConversionStats ?? null,
      error: error instanceof Error ? error.message : "GLB/GLTF 转 STL 失败。",
      summary: "未能生成外部 CAM STL 输入，adapter 可能需要直接处理源模型或降级。"
    };
  }
}

function pushRepairOutputArtifacts(job, repairExecution) {
  if (repairExecution?.camSourceConversion?.status === "completed") {
    pushUnique(job.artifacts, publicArtifactUrl(job.id, "cam-source-converted.stl"));
  }
  if (repairExecution?.repairedMeshQuality?.artifact) {
    pushUnique(job.artifacts, repairExecution.repairedMeshQuality.artifact);
  }
  for (const output of repairExecution?.outputs ?? []) {
    if (!output?.filename || !output.exists) continue;
    pushUnique(job.artifacts, publicArtifactUrl(job.id, output.filename));
  }
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

function createCamInputPlan(job, meshQuality, repairPlan, repairExecution, settings) {
  const needsRepair = repairPlan.status === "repair-required";
  const needsReview = repairPlan.status === "review-required";
  const highPoly = meshQuality.triangleCount > 180000;
  const veryHighPoly = meshQuality.triangleCount > 500000;
  const thinOrOpen = meshQuality.boundaryEdges > 0 || meshQuality.nonManifoldEdges > 0;
  const sourceModelPath = localModelUrlToPath(job.modelUrl);
  const modelSelection = createCamInputModelSelection(job, repairPlan, repairExecution, sourceModelPath);
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

  const status = modelSelection.blockingReason
    ? "blocked"
    : needsReview || highPoly || (needsRepair && modelSelection.selectedModelRole !== "source")
      ? "review"
      : "ready";
  const selectedModelKind = status === "blocked"
    ? "requires-repaired-model"
    : modelSelection.selectedModelRole && modelSelection.selectedModelRole !== "source"
      ? `repaired-${modelSelection.selectedModelRole}`
    : highPoly
      ? "source-model-with-decimation-recommended"
      : "source-model";
  const summary = status === "blocked"
    ? "当前模型需先修复后再进入生产 CAM，小闭环仍可使用 fallback 试算。"
    : status === "review"
      ? "当前模型可试算刀路，但建议先按计划清理/降面后交给外部 CAM。"
      : "当前模型可作为 CAM 输入进入小闭环。";

  return {
    schema: "hediao3d.cam-input-plan.v1",
    status,
    summary,
    selectedModelKind,
    sourceModelUrl: job.modelUrl,
    sourceModelPath,
    selectedModelUrl: status === "blocked" ? null : modelSelection.selectedModelUrl ?? job.modelUrl,
    selectedModelPath: status === "blocked" ? null : modelSelection.selectedModelPath ?? sourceModelPath,
    modelSelection,
    preferredExternalEngine,
    adapterModelPolicy,
    camMode: settings.camMode,
    rotaryOutputAxis: settings.rotaryOutputAxis ?? null,
    preprocessing,
    gate: {
      allowInternalFallback: true,
      allowExternalCamTrial: status !== "blocked",
      allowProductionNc: status === "ready",
      reason: modelSelection.blockingReason ?? summary
    }
  };
}

function createCamInputModelSelection(job, repairPlan, repairExecution, sourceModelPath) {
  const candidates = Array.isArray(repairExecution?.outputs) && repairExecution.outputs.length > 0
    ? repairExecution.outputs
    : createRepairOutputCandidates(job, sourceModelPath);
  const sorted = candidates
    .map((candidate) => ({ ...candidate, selectedForCam: false }))
    .sort((a, b) => {
      if (a.exists !== b.exists) return a.exists ? -1 : 1;
      return Number(b.priority ?? 0) - Number(a.priority ?? 0);
    });
  const repairedCandidate = sorted.find((candidate) => candidate.exists && candidate.role !== "source") ?? null;
  const sourceCandidate = sorted.find((candidate) => candidate.role === "source") ?? sorted.find((candidate) => candidate.exists) ?? null;
  const selected = repairedCandidate ?? sourceCandidate;
  const blockedByMissingRepair = repairPlan.status === "repair-required" && !repairedCandidate;
  const blockingReason = blockedByMissingRepair
    ? "模型存在生产级 Mesh 阻断项，且没有可用的修复/重网格 CAM 输入模型。"
    : null;
  const selectionReason = repairedCandidate
    ? `选择 ${repairedCandidate.label} 作为外部 CAM 输入。`
    : sourceCandidate
      ? "未发现修复产物，选择原始模型作为试算 CAM 输入。"
      : "未找到可用 CAM 输入模型。";
  const selectedCandidates = sorted.map((candidate) => ({
    ...candidate,
    selectedForCam: Boolean(selected && candidate.id === selected.id)
  }));

  return {
    schema: "hediao3d.cam-input-model-selection.v1",
    status: blockedByMissingRepair ? "blocked-missing-repair-output" : selected ? "selected" : "blocked-missing-model",
    selectedModelId: selected?.id ?? null,
    selectedModelUrl: selected?.url ?? null,
    selectedModelPath: selected?.path ?? null,
    selectedModelRole: selected?.role ?? null,
    repairExecutionStatus: repairExecution?.status ?? null,
    repairRequired: repairPlan.status === "repair-required",
    blockingReason,
    selectionReason,
    candidates: selectedCandidates
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
      repairStatus: repairPlan.status,
      modelSelection: camInputPlan.modelSelection ?? null,
      preprocessing: camInputPlan.preprocessing ?? []
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

function createJobOpenSourceCamExecutionPlan({ job, settings, camInputPlan, selectedEngine, engineReadiness, camEngineSelection, nativeCamReadiness, externalCamRecipe }) {
  const enginesById = new Map((engineReadiness.engines ?? []).map((engine) => [engine.id, engine]));
  const rotaryMode = settings.camMode === "rotaryWrap";
  const stageDefinitions = [
    {
      id: "freecad-reference-cam",
      engineId: "freecad",
      title: "FreeCAD 标准三轴参考 CAM",
      phase: "external-cam-generator",
      priority: settings.camMode === "3axis" ? "P0" : "P1",
      input: camInputPlan.selectedModelPath ?? camInputPlan.selectedModelUrl ?? "cam-input-plan.json",
      output: "freecad-cam-plan.json / adapter-report.json / G-code source snapshot",
      acceptance: "npm run test:v3:freecad-external-handoff",
      handoff: rotaryMode
        ? "仅作为展开三轴参考；最终 Y/A 旋转夹具 NC 仍由 HeDiao3D 后处理生成。"
        : "FreeCAD 输出进入 Orchestrator 统一 NC 静态分析、CAMotics 仿真和交付门禁。",
      productionBoundary: "不得直接使用 FreeCAD 默认后处理输出作为本机床生产 NC。"
    },
    {
      id: "opencamlib-neutral-core",
      engineId: "opencamlib",
      title: "OpenCAMLib 曲面接触与中立刀位点",
      phase: "geometry-kernel",
      priority: "P0",
      input: `${camInputPlan.selectedModelPath ?? "cam-input-plan.json"} + ${describeTool(settings).name}`,
      output: "opencamlib-kernel-plan.json / neutral-toolpath.json / cutter-envelope-report",
      acceptance: "npm run test:v3:neutral-import && npm run test:v3:closed-neutral-handoff",
      handoff: "输出 hediao3d.neutral-toolpath.v1 后，由 HeDiao3D 转成 X+Z+Y/A 旋转夹具 NC。",
      productionBoundary: "preview/fixture neutral 只能验协议；真实生产必须来自 OpenCAMLib/ocl 接触计算和材料去除仿真。"
    },
    {
      id: "camotics-material-removal",
      engineId: "camotics",
      title: "CAMotics 材料去除仿真",
      phase: "simulation",
      priority: "P0",
      input: "camotics-preview.nc / camotics-project-template.json / camotics-cli-run-package.json",
      output: "camotics-result.json / camotics-preview.png / camotics-material-removal.stl",
      acceptance: "npm run test:v3:camotics-import && npm run test:v3:camotics-cli-package-api",
      handoff: "非 synthetic 仿真结果回填 Orchestrator 后进入 production-gate 和 production-evidence-dossier。",
      productionBoundary: "CAMotics 不生成刀路；synthetic 或哈希不匹配的结果不能解锁生产。"
    },
    {
      id: "blendercam-artistic-mesh",
      engineId: "blendercam",
      title: "BlenderCAM/Fabex 艺术 Mesh 候选刀路",
      phase: "artistic-cam-generator",
      priority: rotaryMode ? "P0" : "P1",
      input: camInputPlan.selectedModelPath ?? camInputPlan.selectedModelUrl ?? "cam-input-plan.json",
      output: "blendercam-cam-plan.json / operation report / G-code source snapshot",
      acceptance: "npm run test:v3:blendercam-external-handoff",
      handoff: "复杂佛头 Mesh 候选刀路必须回到 Orchestrator 摄取链路，与 OpenCAMLib 中立刀位点对照。",
      productionBoundary: "Blender 插件版本、坐标系、刀具补偿和后处理必须在目标服务器和机床空跑中验收。"
    }
  ];
  const stages = stageDefinitions.map((stage, index) => {
    const engine = enginesById.get(stage.engineId);
    const candidate = camEngineSelection.candidates?.find((item) => item.id === stage.engineId);
    const selected = selectedEngine.id === stage.engineId;
    const missing = [
      ...(engine?.available ? [] : [`${engineDisplayName(stage.engineId)} native 命令未检测到`]),
      ...(engine?.adapterReady ? [] : [`${engineDisplayName(stage.engineId)} adapter 尚未 ready`]),
      ...(camInputPlan.status === "blocked" ? [camInputPlan.summary] : []),
      ...(!enableExternalCamAdapters && stage.engineId !== "camotics" ? ["ENABLE_EXTERNAL_CAM_ADAPTERS=false，外部 CAM 只生成计划不执行"] : [])
    ];
    const canAttempt = Boolean(candidate?.canAttemptNow || (selected && selectedEngine.available && enableExternalCamAdapters && camInputPlan.status !== "blocked"));
    return {
      ...stage,
      order: index + 1,
      selected,
      engineLevel: engine?.status ?? "missing",
      engineAvailable: Boolean(engine?.available),
      adapterReady: Boolean(engine?.adapterReady),
      canAttemptNow: canAttempt,
      status: canAttempt ? "ready-to-run-adapter" : missing.length ? "blocked-or-pending" : "review-required",
      missing: dedupeStrings(missing),
      evidence: [
        "open-source-cam-execution-plan.json",
        "native-cam-readiness.json",
        "cam-engine-selection.json",
        "external-cam-recipe.json",
        "adapter-report.json",
        stage.output
      ]
    };
  });
  const selectedStage = stages.find((stage) => stage.selected) ?? stages[0];
  const readyStageCount = stages.filter((stage) => stage.canAttemptNow).length;
  return {
    schema: "hediao3d.job-open-source-cam-execution-plan.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    camMode: settings.camMode,
    selectedEngine: selectedEngine.id,
    selectedEngineName: selectedEngine.name,
    sourceModelUrl: camInputPlan.sourceModelUrl,
    selectedModelUrl: camInputPlan.selectedModelUrl,
    selectedModelKind: camInputPlan.selectedModelKind,
    camInputStatus: camInputPlan.status,
    summary: `${readyStageCount}/${stages.length} 个开源 CAM 阶段可尝试执行；当前任务选择 ${selectedEngine.name}，${externalCamRecipe.status}。`,
    strategy: rotaryMode
      ? "佛头/核雕旋转夹具任务优先 OpenCAMLib 中立刀位点或 BlenderCAM 艺术 Mesh 候选，再由 HeDiao3D 后处理为 X+Z+Y/A NC。"
      : "三轴任务优先 FreeCAD 标准三轴 CAM，OpenCAMLib/BlenderCAM 作为复杂曲面补充。",
    readyStageCount,
    totalStageCount: stages.length,
    selectedStageId: selectedStage?.id ?? null,
    selectedStageStatus: selectedStage?.status ?? "missing",
    nativeCamLevel: nativeCamReadiness.level,
    externalAdapterExecutionEnabled: enableExternalCamAdapters,
    stages,
    globalAcceptanceCommands: [
      "npm run test:v3:native-cam",
      "V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters",
      "bash native-cam-real-output-check.sh",
      "npm run test:v3:real-neutral-handoff",
      "npm run test:v3:camotics-import",
      "npm run test:v3:readiness-api"
    ],
    productionLocks: [
      "没有 production-candidate handoffEvidence 时禁止生产 NC。",
      "没有非 synthetic CAMotics/等效材料去除仿真时禁止生产 NC。",
      "没有 operator-runbook.md 指导下的离料空跑、软料试雕和机床验收记录时禁止生产 NC。"
    ],
    nextActions: dedupeStrings([
      ...(selectedStage?.missing ?? []),
      ...(camEngineSelection.requiredNextActions ?? []),
      "在 Linux CAM 服务器执行真实输出验收后，把 native-cam-real-output-acceptance.json 回填到 V3 总门禁。"
    ])
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

function createCamEngineSelectionReport({ requestedEngine, selectedEngine, engines, settings, camInputPlan, engineReadiness }) {
  const rotaryMode = settings.camMode === "rotaryWrap";
  const preferredOrder = createCamEnginePreferenceOrder(settings);
  const candidates = preferredOrder
    .map((id, index) => {
      const engine = engines.find((candidate) => candidate.id === id);
      if (!engine) return null;
      const reasons = [];
      if (id === "freecad") reasons.push("适合三轴平面、规则实体和标准 Path/CAM 工序。");
      if (id === "blendercam") reasons.push("适合 Meshy/艺术曲面/浮雕类高面数网格。");
      if (id === "opencamlib") reasons.push("适合曲面刀具接触、drop-cutter、水线和中性刀位点输出。");
      if (id === "internal-mesh-cam") reasons.push("用于外部 CAM 未就绪时完成 V3 小闭环和试雕 fallback。");
      if (rotaryMode && id !== "internal-mesh-cam") reasons.push("旋转夹具模式优先要求输出展开/中性刀位点，再由 HeDiao3D 后处理。");
      const blockers = [];
      if (!engine.available) blockers.push("引擎命令或模块未检测到。");
      if (!engine.adapterReady) blockers.push("adapter 尚未达到可执行状态。");
      if (camInputPlan.status === "blocked" && id !== "internal-mesh-cam") blockers.push("CAM 输入模型存在生产阻断，需先修复。");
      if (!enableExternalCamAdapters && id !== "internal-mesh-cam") blockers.push("ENABLE_EXTERNAL_CAM_ADAPTERS 未启用，暂不执行外部 adapter。");
      return {
        id,
        rank: index + 1,
        name: engine.name,
        available: engine.available,
        adapterReady: engine.adapterReady,
        command: engine.command ?? null,
        selected: selectedEngine.id === id,
        canAttemptNow: id === "internal-mesh-cam"
          ? true
          : Boolean(engine.available && engine.adapterReady && camInputPlan.status !== "blocked" && enableExternalCamAdapters),
        reasons,
        blockers
      };
    })
    .filter(Boolean);
  const selectedCandidate = candidates.find((candidate) => candidate.selected);
  const fallbackUsed = selectedEngine.id === "internal-mesh-cam" || !selectedCandidate?.canAttemptNow;
  const fallbackReason = fallbackUsed
    ? selectedEngine.id === "internal-mesh-cam"
      ? "未找到当前可执行的外部 CAM adapter，使用内置 Mesh CAM 完成小闭环。"
      : selectedCandidate?.blockers?.[0] ?? "选中引擎暂不可执行，后续会进入内置 fallback。"
    : "选中外部 CAM adapter 具备尝试执行条件。";
  return {
    schema: "hediao3d.cam-engine-selection.v1",
    createdAt: new Date().toISOString(),
    requestedEngine: requestedEngine ?? "auto",
    selectedEngine: selectedEngine.id,
    selectedEngineName: selectedEngine.name,
    camMode: settings.camMode,
    strategy: rotaryMode
      ? "rotary-wrap prefers BlenderCAM/OpenCAMLib neutral output, then HeDiao3D wrapY/wrapA postprocess"
      : settings.camMode === "3axis"
        ? "3-axis prefers FreeCAD Path output, with OpenCAMLib/BlenderCAM as specialist fallback"
        : "4-axis/artistic mesh prefers BlenderCAM/OpenCAMLib, with internal fallback for trial loop",
    fallbackUsed,
    fallbackReason,
    externalAttemptAllowed: Boolean(selectedCandidate?.canAttemptNow && selectedEngine.id !== "internal-mesh-cam"),
    externalReady: engineReadiness.externalReady,
    camInputStatus: camInputPlan.status,
    camInputModelKind: camInputPlan.selectedModelKind,
    preferredOrder,
    candidates,
    requiredNextActions: createCamEngineSelectionNextActions(candidates, camInputPlan)
  };
}

function createCamEnginePreferenceOrder(settings) {
  if (settings.camMode === "3axis") return ["freecad", "opencamlib", "blendercam", "internal-mesh-cam"];
  if (settings.camMode === "rotaryWrap") return ["blendercam", "opencamlib", "freecad", "internal-mesh-cam"];
  return ["blendercam", "opencamlib", "freecad", "internal-mesh-cam"];
}

function createCamEngineSelectionNextActions(candidates, camInputPlan) {
  const actions = [];
  if (camInputPlan.status === "blocked") actions.push("先修复/重网格 CAM 输入模型，再启用外部 CAM 生产试算。");
  if (candidates.some((candidate) => candidate.id === "freecad" && !candidate.available)) actions.push("安装 FreeCAD 并暴露 FreeCADCmd/freecadcmd。");
  if (candidates.some((candidate) => candidate.id === "blendercam" && !candidate.available)) actions.push("安装 Blender + BlenderCAM/FabexCNC，用于艺术 Mesh 曲面加工。");
  if (candidates.some((candidate) => candidate.id === "opencamlib" && !candidate.available)) actions.push("在 CAM 服务端安装 OpenCAMLib/ocl Python 模块。");
  if (!enableExternalCamAdapters) actions.push("外部 adapter 小模型验证后，设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true。");
  if (actions.length === 0) actions.push("运行 V3 小闭环并检查 adapter-report.json 与 CAMotics 仿真结果。");
  return dedupeStrings(actions);
}

function createNativeCamReadinessReport(engines, selected, settings, engineReadiness) {
  const targetEngines = settings.camMode === "3axis"
    ? ["freecad", "camotics"]
    : ["blendercam", "opencamlib", "camotics"];
  const engineById = new Map(engines.map((engine) => [engine.id, engine]));
  const adapters = targetEngines.map((id) => {
    const engine = engineById.get(id);
    const missing = [];
    if (!engine?.available) missing.push(`${engineDisplayName(id)} 命令不可用`);
    if (!engine?.adapterReady) missing.push(`${engineDisplayName(id)} adapter 未解锁生产输出`);
    return {
      id,
      name: engine?.name ?? engineDisplayName(id),
      required: true,
      ready: missing.length === 0,
      level: missing.length === 0 ? "ready" : engine?.available ? "partial" : "missing",
      command: engine?.command ?? null,
      version: engine?.version ?? null,
      missing,
      deploymentHints: createAdapterDeploymentHints(id)
    };
  });
  const readyCount = adapters.filter((adapter) => adapter.ready).length;
  const blockers = adapters.flatMap((adapter) => adapter.missing.map((item) => `${adapter.name}: ${item}`));
  return {
    schema: "hediao3d.native-cam-readiness.v1",
    jobCamMode: settings.camMode,
    selectedEngine: selected.id,
    selectedEngineName: selected.name,
    enableExternalCamAdapters,
    readyCount,
    requiredCount: adapters.length,
    level: readyCount === adapters.length ? "ready" : readyCount > 0 ? "partial" : "missing",
    summary: readyCount === adapters.length
      ? "目标 CAM/仿真 Native 环境已具备执行条件。"
      : `目标 CAM/仿真 Native 环境未完整就绪：${readyCount}/${adapters.length}。`,
    productionImpact: engineReadiness.externalReady
      ? "外部 CAM 已具备执行信号，仍需 adapter completed、CAMotics 仿真和后处理门禁通过。"
      : "生产 NC 门禁将保持 trial-only，直到外部 CAM 和仿真 Native 环境补齐。",
    blockers,
    requiredActions: createNativeCamRequiredActions(adapters),
    adapters
  };
}

function createCamServerConfigReport({ job, settings, engines, selectedEngine, nativeCamReadiness, engineReadiness }) {
  const engineById = new Map(engines.map((engine) => [engine.id, engine]));
  const adapterConfigs = ["freecad", "blendercam", "opencamlib", "camotics"].map((engineId) => {
    const engine = engineById.get(engineId);
    return createCamServerAdapterConfig(engineId, engine, settings);
  });
  const missingRequired = adapterConfigs
    .filter((config) => config.requiredForCurrentMode && config.status !== "ready")
    .map((config) => `${config.name}: ${config.status}`);
  const environment = {
    ENABLE_EXTERNAL_CAM_ADAPTERS: {
      current: enableExternalCamAdapters ? "true" : "false",
      requiredForExecution: true,
      recommendation: "外部 CAM 小模型验收通过后设为 true；未验证前保持 false。"
    },
    API_PORT: {
      current: String(port),
      recommendation: "生产服务器建议固定端口并由反向代理转发。"
    },
    MAX_TOOLPATH_PREVIEW_POINTS: {
      current: String(maxToolpathPreviewPoints),
      recommendation: "大模型可提高该值，但前端预览和浏览器内存会增加。"
    }
  };
  return {
    schema: "hediao3d.cam-server-config.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    camMode: settings.camMode,
    selectedEngine: selectedEngine.id,
    selectedEngineName: selectedEngine.name,
    externalReady: engineReadiness.externalReady,
    nativeCamLevel: nativeCamReadiness.level,
    status: missingRequired.length === 0 && enableExternalCamAdapters ? "ready-to-attempt-external-cam" : missingRequired.length === 0 ? "installed-but-adapters-disabled" : "missing-native-dependencies",
    environment,
    adapters: adapterConfigs,
    missingRequired,
    recommendedSetupOrder: [
      "先安装 FreeCAD/Blender/CAMotics/OpenCAMLib，并确认命令可被服务进程 PATH 找到。",
      "运行 npm run test:v3:native-cam 验证 native-cam-readiness.json。",
      "运行 npm run test:v3:external-adapters 验证 adapter 计划和命令配置。",
      "小模型跑通后再设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true。",
      "生产前必须跑 CAMotics 或等效机床仿真，并回填 production-evidence-dossier.json。"
    ],
    deploymentValidation: createCamServerDeploymentValidation(adapterConfigs, settings),
    linuxEnvExample: createCamServerLinuxEnvExample(adapterConfigs),
    notes: [
      "fixture/synthetic 开关只允许用于合约测试，不允许作为生产证据。",
      "HeDiao3D 仍负责最终三轴控制器 + Y/A 旋转夹具后处理，外部 CAM 应优先输出中立刀位点或可审计 G-code。",
      "本配置清单不会保存密钥，只记录本地 CAM 命令和环境变量名称。"
    ]
  };
}

function createCamServerPrepChecklistMarkdown({ job, settings, selectedEngine, nativeCamReadiness, camServerConfig }) {
  const requiredAdapters = camServerConfig.deploymentValidation?.requiredAdapters ?? [];
  const forbiddenEnv = camServerConfig.deploymentValidation?.forbiddenProductionEnv ?? [];
  const stages = camServerConfig.deploymentValidation?.stages ?? [];
  const adapterRows = (camServerConfig.adapters ?? [])
    .filter((adapter) => adapter.requiredForCurrentMode)
    .map((adapter) => `- [ ] ${adapter.name}: ${adapter.status}; command=${adapter.detectedCommand ?? "missing"}; env=${adapter.env.experimentalOutput ?? "-"}`);
  return `# HeDiao3D V3 CAM Server Prep Checklist

Job: ${job.id}
Created: ${new Date().toISOString()}
CAM mode: ${settings.camMode}
Selected engine: ${selectedEngine.name} (${selectedEngine.id})
Native CAM: ${nativeCamReadiness.readyCount}/${nativeCamReadiness.requiredCount} ${nativeCamReadiness.level}
CAM server status: ${camServerConfig.status}

## 1. Required Native Adapters

${adapterRows.length ? adapterRows.join("\n") : "- [ ] No required native adapter was selected for this mode."}

## 2. Server Commands

- [ ] npm run test:v3:native-cam
- [ ] V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters
${stages.map((stage) => `- [ ] ${stage.command}  # ${stage.title}`).join("\n")}

## 3. Required Evidence

- [ ] native-cam-readiness.json
- [ ] cam-server-config.json
- [ ] cam-server-prep-checklist.md
- [ ] v3-external-adapter-validation.json
- [ ] adapter-report.json or neutral-toolpath.json
- [ ] camotics-result.json with non-synthetic material-removal evidence
- [ ] production-gate.json
- [ ] machine-acceptance-record.json

## 4. Production Boundary

- This checklist does not unlock production NC.
- Required adapters for current mode: ${requiredAdapters.join(", ") || "none"}.
- Keep these production-forbidden switches off: ${forbiddenEnv.join(", ") || "none"}.
- Fixture, synthetic and preview scaffold outputs are contract evidence only.
- Final NC for the three-axis controller plus Y rotary fixture must still pass HeDiao3D postprocess, NC static analysis, CAMotics or equivalent simulation, air-run, trial feedback and machine acceptance.

## 5. Missing Required Items

${camServerConfig.missingRequired.length ? camServerConfig.missingRequired.map((item) => `- ${item}`).join("\n") : "- none"}
`;
}

function createCamServerDeploymentValidation(adapterConfigs, settings) {
  const requiredAdapters = adapterConfigs.filter((config) => config.requiredForCurrentMode);
  const fixtureEnvNames = adapterConfigs
    .flatMap((config) => [config.env.fixtureOrSynthetic, config.env.previewScaffold])
    .filter(Boolean);
  return {
    schema: "hediao3d.cam-server-deployment-validation.v1",
    camMode: settings.camMode,
    requiredAdapters: requiredAdapters.map((config) => config.id),
    fixtureOrSyntheticMustBeOff: fixtureEnvNames,
    productionUnlockRequires: [
      "Native CAM readiness ready",
      "External adapter validation completed with at least one completed adapter",
      "External CAM handoff source snapshot with SHA-256",
      "Non-synthetic CAMotics material-removal result with input identity",
      "Machine acceptance and trial feedback success"
    ],
    stages: [
      {
        id: "native-cam-readiness",
        title: "Native CAM 命令探测",
        command: "npm run test:v3:native-cam",
        expectedArtifacts: ["native-cam-readiness.json"],
        blocksProduction: true
      },
      {
        id: "adapter-plan-validation",
        title: "Adapter 计划与模板验证",
        command: "npm run test:v3:external-adapters",
        expectedArtifacts: ["v3-external-adapter-validation.json", "freecad-cam-plan.json", "blendercam-cam-plan.json", "opencamlib-kernel-plan.json"],
        blocksProduction: true
      },
      {
        id: "external-handoff-smoke",
        title: "外部 CAM 小模型 handoff",
        command: settings.camMode === "3axis"
          ? "npm run test:v3:freecad-external-handoff"
          : "npm run test:v3:real-neutral-handoff",
        expectedArtifacts: settings.camMode === "3axis"
          ? ["adapter-report.json", "freecad-cam-plan.json", "toolpath.nc", "cam-handoff-quality.json"]
          : ["adapter-report.json", "opencamlib-kernel-plan.json", "neutral-toolpath.json", "toolpath.nc", "cam-handoff-quality.json"],
        blocksProduction: true
      },
      {
        id: "camotics-material-removal",
        title: "CAMotics 材料去除仿真回填",
        command: "npm run test:v3:camotics-import",
        expectedArtifacts: ["camotics-import-contract.json", "camotics-adapter-report.json", "camotics-result.json"],
        blocksProduction: true
      },
      {
        id: "readiness-runbook",
        title: "总门禁与服务器侧验收脚本",
        command: "npm run test:v3:readiness-api",
        expectedArtifacts: ["v3-readiness-report.json", "v3-acceptance-runbook.sh", "v3-acceptance-runbook-result.json"],
        blocksProduction: true
      }
    ],
    requiredEnvForCurrentMode: requiredAdapters.flatMap((config) => [
      "ENABLE_EXTERNAL_CAM_ADAPTERS",
      config.env.commandJson ?? config.env.command,
      config.env.experimentalOutput
    ].filter(Boolean)),
    forbiddenProductionEnv: fixtureEnvNames.map((name) => `${name}=true`),
    note: "这些步骤是 CAM 服务器部署验收清单；通过协议测试仍不等于生产可用，生产还需要真实材料去除仿真、空跑、试雕和机床验收。"
  };
}

function createCamServerAdapterConfig(engineId, engine, settings) {
  const requiredForCurrentMode = settings.camMode === "3axis"
    ? ["freecad", "camotics"].includes(engineId)
    : ["blendercam", "opencamlib", "camotics"].includes(engineId);
  const commandEnv = {
    freecad: "HEDIAO3D_FREECAD_EXTERNAL_COMMAND",
    blendercam: "HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND",
    opencamlib: "HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND",
    camotics: "HEDIAO3D_CAMOTICS_COMMAND"
  }[engineId];
  const commandJsonEnv = {
    freecad: "HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON",
    blendercam: "HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON",
    opencamlib: "HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON",
    camotics: null
  }[engineId];
  const experimentalEnv = {
    freecad: "HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT",
    blendercam: "HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT",
    opencamlib: "HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT",
    camotics: "HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN"
  }[engineId];
  const timeoutEnv = {
    freecad: "HEDIAO3D_FREECAD_EXTERNAL_TIMEOUT_SEC",
    blendercam: "HEDIAO3D_BLENDERCAM_EXTERNAL_TIMEOUT_SEC",
    opencamlib: "HEDIAO3D_OPENCAMLIB_EXTERNAL_TIMEOUT_SEC",
    camotics: null
  }[engineId];
  const fixtureEnv = {
    freecad: "HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT",
    blendercam: "HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT",
    opencamlib: "HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT",
    camotics: "HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT"
  }[engineId];
  const previewEnv = {
    opencamlib: "HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW"
  }[engineId];
  const status = engine?.available && engine?.adapterReady ? "ready" : engine?.available ? "command-detected-adapter-locked" : "missing-command";
  return {
    id: engineId,
    name: engine?.name ?? engineDisplayName(engineId),
    requiredForCurrentMode,
    status,
    detectedCommand: engine?.command ?? null,
    version: engine?.version ?? null,
    adapterReady: Boolean(engine?.adapterReady),
    env: {
      command: commandEnv,
      commandJson: commandJsonEnv,
      experimentalOutput: experimentalEnv,
      timeoutSec: timeoutEnv,
      fixtureOrSynthetic: fixtureEnv,
      previewScaffold: previewEnv
    },
    commandTemplate: createCamServerCommandTemplate(engineId),
    validationCommand: createCamServerValidationCommand(engineId),
    productionPolicy: [
      fixtureEnv
        ? `${fixtureEnv} 必须关闭；真实生产证据要求 ${experimentalEnv}=true 且输出非 synthetic/fixture。`
        : `真实生产证据要求 ${experimentalEnv}=true 且 adapter 返回 completed。`,
      previewEnv ? `${previewEnv}=true 只允许用于 STL heightfield 小闭环预览，不允许解锁生产 NC。` : null
    ].filter(Boolean).join(" ")
  };
}

function createCamServerCommandTemplate(engineId) {
  if (engineId === "freecad") return "python adapters/freecad/freecad_runner.py <job.json> <freecad-cam-plan.json> <toolpath.nc>";
  if (engineId === "blendercam") return "blender --background --python adapters/blendercam/blendercam_runner.py -- <job.json> <blendercam-cam-plan.json> <toolpath.nc>";
  if (engineId === "opencamlib") return "python adapters/opencamlib/opencamlib_runner.py <job.json> <opencamlib-kernel-plan.json> <neutral-toolpath.json>";
  if (engineId === "camotics") return "camotics-cli <camotics-project-template.json>";
  return "";
}

function createCamServerValidationCommand(engineId) {
  if (engineId === "freecad") return "npm run test:v3:freecad-external-handoff";
  if (engineId === "blendercam") return "npm run test:v3:blendercam-external-handoff";
  if (engineId === "opencamlib") return "npm run test:v3:closed-neutral-handoff";
  if (engineId === "camotics") return "npm run test:v3:camotics-import";
  return "npm run test:v3:external-adapters";
}

function createCamServerLinuxEnvExample(adapterConfigs) {
  const lines = [
    "ENABLE_EXTERNAL_CAM_ADAPTERS=false",
    "# After native validation, set ENABLE_EXTERNAL_CAM_ADAPTERS=true",
    "HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=false",
    "HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=false",
    "HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=false",
    "HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=false"
  ];
  for (const config of adapterConfigs) {
    if (config.env.command) lines.push(`# ${config.env.command}="${config.commandTemplate}"`);
    if (config.env.timeoutSec) lines.push(`${config.env.timeoutSec}=240`);
    if (config.env.previewScaffold) lines.push(`${config.env.previewScaffold}=false`);
  }
  return `${lines.join("\n")}\n`;
}

function engineDisplayName(id) {
  if (id === "freecad") return "FreeCAD CAM";
  if (id === "blendercam") return "BlenderCAM/FabexCNC";
  if (id === "opencamlib") return "OpenCAMLib";
  if (id === "camotics") return "CAMotics";
  return id;
}

function createNativeCamRequiredActions(adapters) {
  const actions = [];
  for (const adapter of adapters) {
    if (adapter.ready) continue;
    if (adapter.id === "freecad") actions.push("安装 FreeCAD 并确认 FreeCADCmd/freecadcmd 可被服务进程调用。");
    if (adapter.id === "blendercam") actions.push("安装 Blender 与 BlenderCAM/FabexCNC 插件，并确认 blender 可被服务进程调用。");
    if (adapter.id === "opencamlib") actions.push("在 CAM 服务端安装 OpenCAMLib/ocl Python 模块，用于曲面刀具接触计算。");
    if (adapter.id === "camotics") actions.push("安装 CAMotics/camotics-cli，用于正式 NC 下载前的材料去除仿真。");
  }
  if (!enableExternalCamAdapters) actions.push("环境安装完成并小模型验证后，再设置 ENABLE_EXTERNAL_CAM_ADAPTERS=true。");
  return dedupeStrings(actions);
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

function createProductionGate({ toolpath, settings, selectedEngine, resultEngine, meshQuality, repairPlan, repairExecution, camInputPlan, engineReadiness, nativeCamReadiness, simulationSummary, camoticsInput, camHandoffQuality, neutralToolpathImportValidation = null, postprocessTraceReport, ncStaticAnalysis, controllerDialectReport }) {
  const blockers = [];
  const warnings = [];
  const requiredActions = [];
  const simulationEvidence = createSimulationEvidence(simulationSummary);

  const repairedCamInputSelected = camInputPlan?.modelSelection?.selectedModelRole && camInputPlan.modelSelection.selectedModelRole !== "source";
  if (repairPlan.status === "repair-required" && !repairedCamInputSelected) {
    blockers.push("Mesh 质量需要修复，不能直接生成生产 NC。");
    requiredActions.push("先执行封孔、修非流形、删除退化面或 Meshy/Blender 重网格。");
  } else if (repairPlan.status === "repair-required" && repairedCamInputSelected) {
    const repairedQuality = repairExecution?.repairedMeshQuality;
    if (repairedQuality?.verdict === "ready") {
      warnings.push("源 Mesh 存在修复阻断项；修复产物 Mesh 体检已通过，但生产前仍需真实外部 CAM 和材料去除仿真。");
    } else {
      warnings.push("源 Mesh 存在修复阻断项，CAM 已选择修复产物；修复后模型尚未通过 ready 体检。");
      requiredActions.push("查看 repaired-mesh-quality.json，确认边界边、非流形和退化面风险已消除。");
    }
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
  if (nativeCamReadiness?.level !== "ready") {
    warnings.push(nativeCamReadiness?.summary ?? "Native CAM 环境未完整就绪。");
    requiredActions.push(...(nativeCamReadiness?.requiredActions ?? ["查看 native-cam-readiness.json，补齐外部 CAM 与仿真环境。"]));
  }
  if (resultEngine === "internal-mesh-cam") {
    warnings.push("本次刀路仍由内置 Mesh CAM fallback 生成，不是外部专业 CAM 输出。");
    requiredActions.push("确认 adapter-report.json；外部 CAM 未返回 completed 前不要按生产级 CAM 精度评估。");
  }

  if (camHandoffQuality?.level === "critical") {
    blockers.push(`CAM handoff 质量存在阻断项：${camHandoffQuality.criticalIssues[0] ?? "请查看 cam-handoff-quality.json"}`);
    requiredActions.push("修复外部 adapter 输出的点数、轴覆盖、行程或 synthetic/fixture 标记后重新生成。");
  } else if (camHandoffQuality?.level === "review") {
    warnings.push(`CAM handoff 质量需要复核：${camHandoffQuality.warningIssues[0] ?? "请查看 cam-handoff-quality.json"}`);
    requiredActions.push("查看 cam-handoff-quality.json，确认外部 CAM 输出是真实可复核刀路，不是合约 fixture。");
  }

  const neutralBinding = createNeutralToolpathBindingGateStatus(neutralToolpathImportValidation, camHandoffQuality);
  if (neutralBinding.required && neutralBinding.status === "block") {
    blockers.push(`Neutral 刀位点源绑定存在阻断项：${neutralBinding.summary}`);
    requiredActions.push("查看 neutral-toolpath-import-validation.json，确认 API 输入、neutral-toolpath.json 和后处理 sourceSnapshot 哈希一致。");
  } else if (neutralBinding.required && neutralBinding.status === "review") {
    warnings.push(`Neutral 刀位点源绑定需要复核：${neutralBinding.summary}`);
    requiredActions.push("查看 neutral-toolpath-import-validation.json 的 sourceBinding，确认导入源与后处理输入一致。");
  }

  if (!simulationEvidence.productionUnlockEligible) {
    warnings.push(simulationEvidence.summary);
    requiredActions.push(...simulationEvidence.requiredActions);
  }

  if (camoticsInput && !camoticsInput.compatibility.canRunInCamotics) {
    warnings.push(camoticsInput.compatibility.reason);
    requiredActions.push("若使用真实旋转轴 A 或四轴联动，需要用支持旋转轴的机床仿真软件复核。");
  }

  if (postprocessTraceReport?.level === "critical") {
    blockers.push(`后处理追溯存在阻断项：${postprocessTraceReport.criticalIssues[0] ?? "请查看 postprocess-trace-report.json"}`);
    requiredActions.push("修复旋转展开轴映射、点位顺序或 G-code 后处理，再重新生成 NC。");
  } else if (postprocessTraceReport?.level === "review") {
    warnings.push(`后处理追溯需要复核：${postprocessTraceReport.warningIssues[0] ?? "请查看 postprocess-trace-report.json"}`);
    requiredActions.push("查看 postprocess-trace-report.json，确认机床 NC 与源刀路点的一致性。");
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
    && simulationEvidence.productionUnlockEligible
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
      nativeCamReady: nativeCamReadiness?.level === "ready",
      nativeCamReadyCount: nativeCamReadiness?.readyCount ?? 0,
      nativeCamRequiredCount: nativeCamReadiness?.requiredCount ?? 0,
      simulationEngine: simulationSummary.engine,
      simulationEvidenceLevel: simulationEvidence.level,
      realMaterialRemovalVerified: simulationEvidence.realMaterialRemovalVerified,
      simulationRiskLevel: simulationSummary.riskLevel,
      postprocessTraceLevel: postprocessTraceReport?.level ?? "missing",
      postprocessTraceFitRate: postprocessTraceReport?.metrics?.fitRate ?? null,
      neutralSourceBindingStatus: neutralBinding.required ? neutralBinding.bindingStatus : "not-required",
      camHandoffQualityLevel: camHandoffQuality?.level ?? "unknown",
      camHandoffSource: camHandoffQuality?.source ?? "unknown",
      fitRate: simulationSummary.metrics.fitRate,
      missCount: simulationSummary.metrics.missCount,
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes
    },
    simulationEvidence,
    blockers,
    warnings: dedupeStrings(warnings),
    requiredActions: dedupeStrings(requiredActions),
    recommendedWorkflow: [
      "下载并查看 mesh-quality.json、repair-plan.json、cam-input-plan.json。",
      "先运行 rotary-calibration-airrun.nc 做旋转夹具标定空跑，确认 90/180/360 度方向和每圈距离。",
      "再运行 air-run.nc 做整条刀路离料空跑，确认 X/Y旋转/Z 安全方向。",
      "用废料或低进给做小料试雕，记录真实深度、耗时和夹具方向。",
      "接入 BlenderCAM/FreeCAD 与 CAMotics 后，再解锁生产 NC 下载。"
    ]
  };
}

function createNeutralToolpathBindingGateStatus(neutralToolpathImportValidation, camHandoffQuality) {
  const required = Boolean(
    neutralToolpathImportValidation
    || camHandoffQuality?.sourceSnapshot?.kind === "neutral-toolpath"
  );
  if (!required) {
    return {
      required: false,
      status: "pass",
      bindingStatus: "not-required",
      summary: "当前不是 neutral-toolpath handoff。"
    };
  }
  const binding = neutralToolpathImportValidation?.sourceBinding ?? null;
  if (!neutralToolpathImportValidation) {
    return {
      required: true,
      status: "block",
      bindingStatus: "missing-validation",
      summary: "检测到 neutral-toolpath handoff，但缺少 neutral-toolpath-import-validation.json。"
    };
  }
  if (!neutralToolpathImportValidation.postprocessEligible) {
    return {
      required: true,
      status: "block",
      bindingStatus: binding?.status ?? "ineligible",
      summary: neutralToolpathImportValidation.summary ?? "neutral-toolpath 未通过导入校验。"
    };
  }
  if (!binding) {
    return {
      required: true,
      status: "review",
      bindingStatus: "missing",
      summary: "neutral-toolpath 已可进入后处理，但缺少 sourceBinding 哈希链。"
    };
  }
  if (binding.status !== "bound") {
    return {
      required: true,
      status: "review",
      bindingStatus: binding.status ?? "unknown",
      summary: binding.summary ?? "neutral-toolpath sourceBinding 未完全绑定。"
    };
  }
  if (binding.sourceSnapshot && binding.sourceSnapshot.matchesPostprocessArtifact !== true) {
    return {
      required: true,
      status: "block",
      bindingStatus: "snapshot-mismatch",
      summary: "neutral-toolpath 后处理 sourceSnapshot 与 neutral-toolpath.json 哈希不一致。"
    };
  }
  return {
    required: true,
    status: "pass",
    bindingStatus: "bound",
    summary: binding.summary ?? "neutral-toolpath sourceBinding 已绑定。"
  };
}

function createSimulationEvidence(simulationSummary) {
  const adapter = simulationSummary?.camoticsAdapter ?? null;
  const adapterCompleted = adapter?.status === "completed";
  const synthetic = Boolean(adapter?.synthetic) || simulationSummary?.engine === "camotics-synthetic";
  const evidenceQuality = adapter?.evidenceQuality ?? null;
  const evidenceComplete = evidenceQuality?.productionEvidenceEligible === true;
  const realMaterialRemovalVerified = simulationSummary?.engine === "camotics" && adapterCompleted && !synthetic && evidenceComplete;
  const level = realMaterialRemovalVerified
    ? "material-removal-verified"
    : synthetic
      ? "handoff-only"
      : simulationSummary?.engine === "camotics" && adapterCompleted
        ? "material-removal-incomplete"
      : "preview-only";
  const summary = realMaterialRemovalVerified
    ? "CAMotics 已返回真实材料去除仿真结果，可作为生产门禁证据之一。"
    : synthetic
      ? "CAMotics synthetic 结果只验证 adapter 回填协议，不代表真实材料去除。"
      : simulationSummary?.engine === "camotics" && adapterCompleted
        ? `CAMotics 已返回结果，但证据不完整：${evidenceQuality?.summary ?? "缺少材料体积、Z范围或截图/材料网格。"}`
      : "当前只有内置旋转包裹/三轴预览摘要，不是 CAMotics 真实材料去除仿真。";
  const requiredActions = realMaterialRemovalVerified
    ? []
    : synthetic
      ? ["在 CAM 服务端安装并运行真实 CAMotics，替换 synthetic 回填结果后再申请生产 NC。"]
      : simulationSummary?.engine === "camotics" && adapterCompleted
        ? ["补齐 CAMotics 材料去除体积、Z范围以及截图或材料网格证据后，再申请生产 NC。"]
      : ["正式上机前用 CAMotics 或机床控制软件完成材料去除仿真。"];

  return {
    schema: "hediao3d.simulation-evidence.v1",
    level,
    productionUnlockEligible: realMaterialRemovalVerified,
    realMaterialRemovalVerified,
    synthetic,
    engine: simulationSummary?.engine ?? "unknown",
    adapterStatus: adapter?.status ?? "missing",
    evidenceQuality,
    resultArtifact: adapter?.resultArtifact ?? null,
    reportArtifact: adapter?.reportArtifact ?? null,
    summary,
    requiredActions
  };
}

function createCamHandoffQualityReport({ job, settings, toolpath, selectedEngine, resultEngine, adapterReport, externalToolpathUsed }) {
  const points = Array.isArray(toolpath?.points) ? toolpath.points : [];
  const source = externalToolpathUsed ? "external-adapter" : "internal-fallback";
  const expectedRotary = settings.camMode === "rotaryWrap";
  const rotaryAxis = String(settings.rotaryOutputAxis ?? "Y").toUpperCase();
  const stats = summarizeHandoffPointStats(points);
  const criticalIssues = [];
  const warningIssues = [];
  const requiredActions = [];
  const adapterHandoffEvidence = normalizeAdapterHandoffEvidence(adapterReport);
  const adapterSynthetic = Boolean(adapterReport?.synthetic || adapterReport?.metrics?.neutralToolpath?.synthetic || adapterHandoffEvidence.synthetic);
  const adapterImportedFixture = Boolean(adapterReport?.imported || adapterReport?.metrics?.neutralToolpath?.imported || adapterHandoffEvidence.fixture);
  const externalCommandGenerated = Boolean(adapterReport?.externalCommand || adapterReport?.metrics?.neutralToolpath?.generatedByExternalCommand || adapterHandoffEvidence.generatedByExternalCommand);
  const sourceSnapshot = toolpath?.externalSourceSnapshot ?? null;
  const sourceSnapshotFixture = Boolean(
    sourceSnapshot?.neutral?.fixture
      || sourceSnapshot?.neutral?.runner?.fixtureMode
      || sourceSnapshot?.gcode?.containsFixtureMarker
  );
  const sourceSnapshotPreviewScaffold = Boolean(
    sourceSnapshot?.neutral?.runner?.previewScaffold
      || sourceSnapshot?.gcode?.containsPreviewScaffoldMarker
  );

  if (points.length <= 0) {
    criticalIssues.push("未生成任何可解析刀路点。");
  } else if (points.length < 100) {
    warningIssues.push(`刀路点数 ${points.length} 偏少，只适合 adapter 合约或小样验证。`);
  }

  const usableLengthMm = Math.max(0.001, Number(settings.lengthMm ?? 0) - Number(settings.leftHoldMm ?? 0) - Number(settings.rightHoldMm ?? 0));
  const xCoverage = usableLengthMm > 0 ? clamp01(stats.xSpan / usableLengthMm) : 0;
  const expectedRotarySpan = expectedRotary ? Number(settings.reliefAngleDeg ?? 360) : 0;
  const rotarySpan = rotaryAxis === "A" ? stats.aSpan : Math.max(stats.ySpan, stats.aSpan);
  const rotaryCoverage = expectedRotary && expectedRotarySpan > 0 ? clamp01(rotarySpan / expectedRotarySpan) : null;

  if (xCoverage < 0.65) {
    warningIssues.push(`X 长度覆盖 ${(xCoverage * 100).toFixed(1)}% 偏低，可能只加工了局部区域。`);
  }
  if (expectedRotary && rotaryCoverage !== null && rotaryCoverage < 0.75) {
    warningIssues.push(`旋转覆盖 ${(rotaryCoverage * 100).toFixed(1)}% 偏低，可能未完整包裹 360°。`);
  }
  if (stats.zMin === null || stats.zMax === null) {
    criticalIssues.push("无法统计 Z 轴范围。");
  } else if (stats.zSpan <= 0.001) {
    warningIssues.push("Z 轴范围几乎没有变化，刀路可能没有真实切深。");
  }

  if (source === "internal-fallback") {
    warningIssues.push("本次 handoff 来自内置 fallback，只能验证流程，不能代表 FreeCAD/BlenderCAM/OpenCAMLib 精度。");
    requiredActions.push("启用外部 CAM adapter 并取得非 synthetic 的真实输出后再评估生产精度。");
  }
  if (adapterSynthetic) {
    warningIssues.push("外部 adapter 输出带 synthetic 标记，只能用于合约测试。");
    requiredActions.push("关闭 synthetic/fixture 模式，使用真实外部 CAM 命令输出。");
  }
  if (adapterImportedFixture || sourceSnapshotFixture) {
    warningIssues.push("外部 adapter 输出带 fixture/测试样例标记，只能用于合约或小闭环验证。");
    requiredActions.push("关闭 runner fixture 输出，并接入 FreeCAD/BlenderCAM/OpenCAMLib 的真实刀路生成命令。");
  }
  if (sourceSnapshotPreviewScaffold) {
    warningIssues.push("外部 adapter 输出仍带 preview/scaffold 标记，不能作为生产级 CAM 精度证据。");
    requiredActions.push("替换 scaffold/heightfield 预览为经过验证的真实刀具接触算法输出。");
  }
  if (externalToolpathUsed && adapterHandoffEvidence.classification && adapterHandoffEvidence.classification !== "production-candidate") {
    warningIssues.push(`外部 adapter handoff 分类为 ${adapterHandoffEvidence.classification}，不能作为生产级 CAM 输出。`);
    requiredActions.push("在 CAM 服务端运行真实 FreeCAD/BlenderCAM/OpenCAMLib 命令，让 handoffEvidence.productionCandidate=true 后再进入生产验收。");
  }
  if (externalToolpathUsed && adapterHandoffEvidence.classification === "production-candidate" && !adapterHandoffEvidence.productionCandidate) {
    warningIssues.push("adapter handoff 分类看似生产候选，但 productionCandidate 未通过。");
    requiredActions.push("复核 adapter-report.json 的 handoffEvidence 字段，确认输出不是 fixture/synthetic/preview。");
  }
  if (externalToolpathUsed && !externalCommandGenerated && !adapterImportedFixture) {
    warningIssues.push("未检测到外部命令生成记录，需复核 adapter-report.json。");
  }
  if (externalToolpathUsed && !sourceSnapshot?.sha256) {
    warningIssues.push("外部 CAM 摄取源缺少 SHA-256 快照，无法完整追溯最终 NC 的来源。");
    requiredActions.push("重新生成外部 CAM handoff，确认 toolpath-summary.json 中 externalSourceSnapshot 存在。");
  }

  const level = criticalIssues.length > 0 ? "critical" : warningIssues.length > 0 ? "review" : "ready";
  return {
    schema: "hediao3d.cam-handoff-quality.v1",
    createdAt: new Date().toISOString(),
    jobId: job.id,
    level,
    source,
    selectedEngine: selectedEngine?.id ?? null,
    resultEngine,
    adapterStatus: adapterReport?.status ?? null,
    externalToolpathUsed,
    sourceSnapshot,
    synthetic: adapterSynthetic,
    importedFixture: adapterImportedFixture || sourceSnapshotFixture,
    previewScaffold: sourceSnapshotPreviewScaffold || adapterHandoffEvidence.previewScaffold,
    adapterHandoffEvidence,
    externalCommandGenerated,
    metrics: {
      pointCount: points.length,
      previewPointCount: toolpath?.previewPoints?.length ?? 0,
      estimatedMinutes: Number(toolpath?.estimatedMinutes ?? 0),
      xRangeMm: { min: stats.xMin, max: stats.xMax, span: stats.xSpan },
      yRange: { min: stats.yMin, max: stats.yMax, span: stats.ySpan },
      aRangeDeg: { min: stats.aMin, max: stats.aMax, span: stats.aSpan },
      zRangeMm: { min: stats.zMin, max: stats.zMax, span: stats.zSpan },
      depthRangeMm: { min: stats.depthMin, max: stats.depthMax, span: stats.depthSpan },
      xCoverage,
      rotaryCoverage,
      expectedRotaryAxis: expectedRotary ? rotaryAxis : null,
      expectedRotarySpanDeg: expectedRotary ? expectedRotarySpan : null
    },
    criticalIssues,
    warningIssues,
    requiredActions,
    summary: criticalIssues.length > 0
      ? `CAM handoff 存在 ${criticalIssues.length} 个阻断项。`
      : warningIssues.length > 0
        ? `CAM handoff 有 ${warningIssues.length} 个复核项。`
        : "CAM handoff 质量检查通过。"
  };
}

function createRotaryWrapPreviewReport({ job, settings, toolpath, machineGcode, airRunGcode, camoticsPreviewGcode, ncStaticAnalysis, controllerDialectReport, machineControllerProfile, camoticsInput }) {
  const camMode = settings.camMode;
  const expectedRotary = camMode === "rotaryWrap";
  const rotaryAxis = expectedRotary ? String(settings.rotaryOutputAxis ?? "Y").toUpperCase() : null;
  const lengthAxis = expectedRotary && rotaryAxis === "X" ? "Y" : "X";
  const wrapPerRev = expectedRotary ? Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100)) : null;
  const expectedAngleSpanDeg = expectedRotary ? Math.max(0.001, Number(settings.reliefAngleDeg ?? 360)) : null;
  const expectedLinearSpanMm = expectedRotary && wrapPerRev && expectedAngleSpanDeg
    ? (expectedAngleSpanDeg / 360) * wrapPerRev
    : null;
  const pointStats = summarizeHandoffPointStats(Array.isArray(toolpath?.points) ? toolpath.points : []);
  const machineAxes = summarizeGcodeAxisRanges(machineGcode);
  const airRunAxes = summarizeGcodeAxisRanges(airRunGcode);
  const camoticsPreviewAxes = summarizeGcodeAxisRanges(camoticsPreviewGcode);
  const pointAngleSpanDeg = pointStats.aSpan > 0
    ? pointStats.aSpan
    : expectedRotary && wrapPerRev && pointStats.ySpan > 0
      ? (pointStats.ySpan / wrapPerRev) * 360
      : 0;
  const machineRotarySpan = rotaryAxis === "A" ? machineAxes.a.span : rotaryAxis === "Y" ? machineAxes.y.span : rotaryAxis === "X" ? machineAxes.x.span : 0;
  const machineAngleSpanDeg = expectedRotary && rotaryAxis === "A"
    ? machineRotarySpan
    : expectedRotary && wrapPerRev
      ? (machineRotarySpan / wrapPerRev) * 360
      : 0;
  const machineCoverage = expectedAngleSpanDeg ? clamp01(machineAngleSpanDeg / expectedAngleSpanDeg) : null;
  const pointCoverage = expectedAngleSpanDeg ? clamp01(pointAngleSpanDeg / expectedAngleSpanDeg) : null;
  const linearizationErrorMm = expectedLinearSpanMm === null
    ? null
    : Math.abs(machineRotarySpan - expectedLinearSpanMm);
  const linearizationErrorRate = expectedLinearSpanMm && expectedLinearSpanMm > 0
    ? linearizationErrorMm / expectedLinearSpanMm
    : null;
  const criticalIssues = [];
  const warningIssues = [];
  const requiredActions = [];

  if (!expectedRotary) {
    warningIssues.push("当前不是 rotaryWrap 模式，旋转包裹预览报告仅作参考。");
  }
  if (expectedRotary && !rotaryAxis) {
    criticalIssues.push("未识别旋转输出轴。");
  }
  if (expectedRotary && wrapPerRev !== null && wrapPerRev <= 0) {
    criticalIssues.push("rotaryWrapPerRevolutionMm 必须大于 0。");
  }
  if (expectedRotary && machineAxes.motionLineCount === 0) {
    criticalIssues.push("机床 NC 未解析到 G0/G1 运动，无法验证旋转包裹。");
  }
  if (expectedRotary && rotaryAxis === "Y" && machineAxes.y.count === 0) {
    criticalIssues.push("Y 轴旋转夹具模式下，toolpath.nc 未输出 Y 旋转运动。");
  }
  if (expectedRotary && rotaryAxis === "Y" && machineAxes.a.count > 0) {
    criticalIssues.push("Y 轴旋转夹具模式下，toolpath.nc 不应输出 A 轴。");
  }
  if (expectedRotary && machineCoverage !== null && machineCoverage < 0.9) {
    warningIssues.push(`机床 NC 旋转覆盖 ${(machineCoverage * 100).toFixed(1)}%，未达到目标角度范围。`);
  }
  if (expectedRotary && pointCoverage !== null && pointCoverage < 0.9) {
    warningIssues.push(`中立/内部刀路点旋转覆盖 ${(pointCoverage * 100).toFixed(1)}%，可能不是完整 360°。`);
  }
  if (linearizationErrorRate !== null && linearizationErrorRate > 0.08) {
    warningIssues.push(`旋转线性化距离与目标偏差 ${(linearizationErrorRate * 100).toFixed(1)}%，需复核每圈等效距离。`);
  }
  if (expectedRotary && !camoticsInput?.compatibility?.canRunInCamotics) {
    warningIssues.push("CAMotics 展开预览未标记为可运行，需要人工复核坐标解释。");
  }
  if (airRunAxes.z.min !== null && Math.abs(airRunAxes.z.min - Number(settings.safeZ ?? 0)) > 0.001) {
    criticalIssues.push("air-run.nc 的最小 Z 不等于安全高度。");
  }
  if (camoticsPreviewAxes.z.min !== null && camoticsPreviewAxes.z.min >= 0) {
    warningIssues.push("camotics-preview.nc 未出现负向切深，展开材料去除预览可能无效。");
  }
  if (ncStaticAnalysis?.level === "critical") {
    criticalIssues.push("NC 静态分析存在阻断项，请先处理 nc-static-analysis.json。");
  }
  if (controllerDialectReport?.level === "critical") {
    criticalIssues.push("控制器方言检查存在阻断项，请先处理 controller-dialect-report.json。");
  }

  if (warningIssues.length > 0 || criticalIssues.length > 0) {
    requiredActions.push("先运行 rotary-calibration-airrun.nc，确认 90/180/360 度方向和每圈等效距离。");
    requiredActions.push("用 camotics-preview.nc 做展开三轴仿真，但不要把该文件上机。");
    requiredActions.push("若旋转覆盖或线性化偏差异常，复核 rotaryWrapPerRevolutionMm、rotaryOutputAxis 和机床脉冲设置。");
  }

  const level = criticalIssues.length > 0 ? "critical" : warningIssues.length > 0 ? "review" : "ready";
  return {
    schema: "hediao3d.rotary-wrap-preview-report.v1",
    createdAt: new Date().toISOString(),
    jobId: job.id,
    level,
    camMode,
    coordinateMapping: {
      lengthAxis,
      depthAxis: "Z",
      rotaryAxis,
      rotaryOutputMode: expectedRotary && rotaryAxis === "A" ? "degree-axis" : expectedRotary ? "linearized-rotary-axis" : "none",
      rotaryWrapPerRevolutionMm: wrapPerRev,
      expectedAngleSpanDeg,
      expectedLinearSpanMm,
      machineControllerProfile: machineControllerProfile?.id ?? null,
      camoticsInterpretation: camoticsInput?.compatibility?.interpretation ?? null
    },
    metrics: {
      pointCount: toolpath.points?.length ?? 0,
      machineMotionLineCount: machineAxes.motionLineCount,
      pointAngleSpanDeg,
      machineAngleSpanDeg,
      machineRotaryLinearSpanMm: expectedRotary && rotaryAxis !== "A" ? machineRotarySpan : null,
      pointCoverage,
      machineCoverage,
      linearizationErrorMm,
      linearizationErrorRate,
      machineZRangeMm: machineAxes.z,
      airRunZRangeMm: airRunAxes.z,
      camoticsPreviewZRangeMm: camoticsPreviewAxes.z
    },
    axisRanges: {
      points: {
        x: { min: pointStats.xMin, max: pointStats.xMax, span: pointStats.xSpan },
        y: { min: pointStats.yMin, max: pointStats.yMax, span: pointStats.ySpan },
        a: { min: pointStats.aMin, max: pointStats.aMax, span: pointStats.aSpan },
        z: { min: pointStats.zMin, max: pointStats.zMax, span: pointStats.zSpan }
      },
      machineNc: machineAxes,
      airRunNc: airRunAxes,
      camoticsPreviewNc: camoticsPreviewAxes
    },
    evidence: {
      machineNc: "toolpath.nc",
      airRunNc: "air-run.nc",
      rotaryCalibrationAirRunNc: "rotary-calibration-airrun.nc",
      camoticsPreviewNc: "camotics-preview.nc",
      ncStaticAnalysis: "nc-static-analysis.json",
      controllerDialectReport: "controller-dialect-report.json",
      machineControllerProfile: "machine-controller-profile.json"
    },
    criticalIssues,
    warningIssues,
    requiredActions,
    summary: criticalIssues.length > 0
      ? `旋转包裹预览存在 ${criticalIssues.length} 个阻断项。`
      : warningIssues.length > 0
        ? `旋转包裹预览有 ${warningIssues.length} 个复核项。`
        : "旋转包裹展开预览与 Y/A 后处理几何关系检查通过。"
  };
}

function summarizeGcodeAxisRanges(gcode) {
  const axes = {
    x: createAxisSummary([]),
    y: createAxisSummary([]),
    z: createAxisSummary([]),
    a: createAxisSummary([]),
    motionLineCount: 0
  };
  const values = { x: [], y: [], z: [], a: [] };
  for (const rawLine of String(gcode ?? "").split(/\r?\n/)) {
    const upper = rawLine.toUpperCase();
    if (!/(?:\bG0?0\b|\bG0?1\b)/.test(upper)) continue;
    axes.motionLineCount += 1;
    for (const axis of ["x", "y", "z", "a"]) {
      const value = parseGcodeWord(upper, axis.toUpperCase());
      if (value !== null && Number.isFinite(value)) values[axis].push(value);
    }
  }
  return {
    x: createAxisSummary(values.x),
    y: createAxisSummary(values.y),
    z: createAxisSummary(values.z),
    a: createAxisSummary(values.a),
    motionLineCount: axes.motionLineCount
  };
}

function createAxisSummary(values) {
  return {
    min: minOrNull(values),
    max: maxOrNull(values),
    span: spanOrZero(values),
    count: values.length
  };
}

function createCamHandoffEvidenceMarkdown(report) {
  const snapshot = report.sourceSnapshot ?? {};
  const sourceIdentity = snapshot.sha256
    ? `${snapshot.kind ?? "source"} sha256=${snapshot.sha256}`
    : "missing source sha256";
  const metrics = report.metrics ?? {};
  const adapterEvidence = report.adapterHandoffEvidence ?? {};
  return `# HeDiao3D V3 CAM Handoff Evidence

Job: ${report.jobId}
Created: ${report.createdAt}
Level: ${report.level}
Summary: ${report.summary}

## 1. Source Classification

- Source: ${report.source}
- Selected engine: ${report.selectedEngine ?? "unknown"}
- Result engine: ${report.resultEngine ?? "unknown"}
- Adapter status: ${report.adapterStatus ?? "missing"}
- External toolpath used: ${report.externalToolpathUsed ? "yes" : "no"}
- External command generated: ${report.externalCommandGenerated ? "yes" : "no"}
- Synthetic: ${report.synthetic ? "yes" : "no"}
- Fixture/imported fixture: ${report.importedFixture ? "yes" : "no"}
- Preview scaffold: ${report.previewScaffold ? "yes" : "no"}
- Source identity: ${sourceIdentity}

## 2. Adapter Handoff Classification

- Schema: ${adapterEvidence.schema ?? "missing"}
- Engine: ${adapterEvidence.engine ?? "n/a"}
- Output kind: ${adapterEvidence.outputKind ?? "n/a"}
- Classification: ${adapterEvidence.classification ?? "missing"}
- Production candidate: ${adapterEvidence.productionCandidate ? "yes" : "no"}
- Generated by external command: ${adapterEvidence.generatedByExternalCommand ? "yes" : "no"}
- Fixture: ${adapterEvidence.fixture ? "yes" : "no"}
- Synthetic: ${adapterEvidence.synthetic ? "yes" : "no"}
- Preview scaffold: ${adapterEvidence.previewScaffold ? "yes" : "no"}

## 3. Motion Coverage

- Point count: ${metrics.pointCount ?? 0}
- Preview point count: ${metrics.previewPointCount ?? 0}
- Estimated minutes: ${fmt(Number(metrics.estimatedMinutes ?? 0), 2)}
- X coverage: ${metrics.xCoverage == null ? "n/a" : `${fmt(Number(metrics.xCoverage) * 100, 1)}%`}
- Rotary coverage: ${metrics.rotaryCoverage == null ? "n/a" : `${fmt(Number(metrics.rotaryCoverage) * 100, 1)}%`}
- Z range: ${formatRange(metrics.zRangeMm)}
- Depth range: ${formatRange(metrics.depthRangeMm)}
- Expected rotary axis: ${metrics.expectedRotaryAxis ?? "n/a"}

## 4. Issues

Critical:
${report.criticalIssues.length ? report.criticalIssues.map((item) => `- ${item}`).join("\n") : "- none"}

Review:
${report.warningIssues.length ? report.warningIssues.map((item) => `- ${item}`).join("\n") : "- none"}

## 5. Required Actions

${report.requiredActions.length ? report.requiredActions.map((item) => `- ${item}`).join("\n") : "- none"}

## 6. Production Boundary

- This evidence file does not unlock production NC by itself.
- Production requires non-synthetic external CAM output, source identity, real material-removal simulation, NC static analysis, air-run, trial feedback and machine acceptance.
- Internal fallback, fixture, synthetic and preview scaffold outputs are useful for contract validation only.
`;
}

function normalizeAdapterHandoffEvidence(adapterReport) {
  const evidence = adapterReport?.metrics?.handoffEvidence;
  if (evidence?.schema === "hediao3d.adapter-handoff-evidence.v1") {
    return {
      schema: evidence.schema,
      engine: evidence.engine ?? adapterReport?.engine ?? null,
      outputKind: evidence.outputKind ?? null,
      classification: evidence.classification ?? "missing",
      fixture: Boolean(evidence.fixture),
      synthetic: Boolean(evidence.synthetic),
      previewScaffold: Boolean(evidence.previewScaffold || evidence.heightfieldPreview),
      generatedByExternalCommand: Boolean(evidence.generatedByExternalCommand),
      productionCandidate: Boolean(evidence.productionCandidate),
      pointCount: evidence.pointCount ?? null,
      motionCount: evidence.motionCount ?? null,
      productionBoundary: evidence.productionBoundary ?? null
    };
  }
  const hasCompletedOutput = adapterReport?.status === "completed" && (
    adapterReport?.gcodePath
    || adapterReport?.outputs?.gcode
    || adapterReport?.neutralToolpathPath
    || adapterReport?.outputs?.neutralToolpath
    || adapterReport?.metrics?.neutralToolpath?.path
  );
  return {
    schema: "hediao3d.adapter-handoff-evidence.v1",
    engine: adapterReport?.engine ?? null,
    outputKind: adapterReport?.neutralToolpathPath || adapterReport?.outputs?.neutralToolpath || adapterReport?.metrics?.neutralToolpath?.path ? "neutral-toolpath" : "gcode",
    classification: adapterReport ? (hasCompletedOutput ? "missing" : "not-generated") : "internal-fallback",
    fixture: Boolean(adapterReport?.metrics?.neutralToolpath?.fixture),
    synthetic: Boolean(adapterReport?.synthetic || adapterReport?.metrics?.neutralToolpath?.synthetic),
    previewScaffold: Boolean(adapterReport?.metrics?.neutralToolpath?.previewScaffold || adapterReport?.metrics?.neutralToolpath?.heightfieldPreview),
    generatedByExternalCommand: Boolean(adapterReport?.externalCommand || adapterReport?.metrics?.neutralToolpath?.generatedByExternalCommand),
    productionCandidate: false,
    pointCount: adapterReport?.metrics?.neutralToolpath?.pointCount ?? null,
    motionCount: null,
    productionBoundary: adapterReport ? "Adapter report did not expose normalized handoff evidence; production NC remains locked." : "No external adapter output was used; internal fallback is trial-only evidence."
  };
}

function formatRange(range) {
  if (!range || range.min == null || range.max == null) return "n/a";
  return `${fmt(Number(range.min), 4)} .. ${fmt(Number(range.max), 4)} span=${fmt(Number(range.span ?? 0), 4)}`;
}

function summarizeHandoffPointStats(points) {
  if (!points.length) {
    return {
      xMin: null, xMax: null, xSpan: 0,
      yMin: null, yMax: null, ySpan: 0,
      aMin: null, aMax: null, aSpan: 0,
      zMin: null, zMax: null, zSpan: 0,
      depthMin: null, depthMax: null, depthSpan: 0
    };
  }
  const xs = points.map((point) => Number(point.x)).filter(Number.isFinite);
  const ys = points.map((point) => Number(point.y ?? 0)).filter(Number.isFinite);
  const as = points.map((point) => Number(point.a ?? 0)).filter(Number.isFinite);
  const zs = points.map((point) => Number(point.z)).filter(Number.isFinite);
  const depths = points.map((point) => Number(point.depth ?? 0)).filter(Number.isFinite);
  return {
    xMin: minOrNull(xs),
    xMax: maxOrNull(xs),
    xSpan: spanOrZero(xs),
    yMin: minOrNull(ys),
    yMax: maxOrNull(ys),
    ySpan: spanOrZero(ys),
    aMin: minOrNull(as),
    aMax: maxOrNull(as),
    aSpan: spanOrZero(as),
    zMin: minOrNull(zs),
    zMax: maxOrNull(zs),
    zSpan: spanOrZero(zs),
    depthMin: minOrNull(depths),
    depthMax: maxOrNull(depths),
    depthSpan: spanOrZero(depths)
  };
}

function minOrNull(values) {
  return values.length ? Math.min(...values) : null;
}

function maxOrNull(values) {
  return values.length ? Math.max(...values) : null;
}

function spanOrZero(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function createToolSetupSheet({ job, settings, toolpath, productionGate, postprocessProfile }) {
  const tool = describeTool(settings);
  const isVFlat25 = settings.toolProfileId === "vflat-4mm-25deg" || settings.toolProfileId === "vbit-flat-4mm-25deg";
  const toolDiameter = Number(settings.toolDiameter ?? 0);
  const stepoverMm = Number(settings.stepoverMm ?? 0);
  const stepoverDeg = Number(settings.stepoverDeg ?? 0);
  const maxCutDepth = Number(settings.maxCutDepth ?? settings.depthMm ?? 0);
  const depthMm = Number(settings.depthMm ?? 0);
  const feedRate = Number(settings.feedRate ?? 0);
  const spindleRpm = Number(settings.spindleRpm ?? 0);
  const fluteLengthMm = isVFlat25 ? 12 : null;
  const stickoutMm = isVFlat25 ? 18 : null;
  const warnings = [];
  const checks = [];

  checks.push({
    id: "tool-profile",
    status: isVFlat25 ? "ready" : "review",
    expected: "4mm 25deg flat-tip V-bit / 平底尖刀",
    actual: tool.name,
    note: isVFlat25 ? "已匹配 4mm 25度平底尖刀工艺配置。" : "当前不是项目指定的 4mm 25度平底尖刀，请确认机床装刀。"
  });
  checks.push({
    id: "diameter",
    status: Math.abs(toolDiameter - 4) <= 0.05 && isVFlat25 ? "ready" : "review",
    expected: "4.000mm",
    actual: `${fmt(toolDiameter, 3)}mm`,
    note: "建议用卡尺复核刀具外径；后处理和 CAM 配方按该直径计算。"
  });
  checks.push({
    id: "stepover",
    status: stepoverMm > 0 && stepoverMm <= toolDiameter * 0.12 ? "ready" : stepoverMm <= toolDiameter * 0.18 ? "review" : "critical",
    expected: `<= ${fmt(toolDiameter * 0.12, 3)}mm`,
    actual: `${fmt(stepoverMm, 3)}mm`,
    note: "平底尖刀步距过大时，佛头面部和衣纹会留下明显刀痕。"
  });
  checks.push({
    id: "cut-depth",
    status: maxCutDepth <= 0.45 ? "ready" : maxCutDepth <= 0.7 ? "review" : "critical",
    expected: "<= 0.450mm",
    actual: `${fmt(maxCutDepth, 3)}mm`,
    note: "核雕材料和细刀尖建议保守下刀，首次试雕可再降低 30%-50%。"
  });
  checks.push({
    id: "feed-spindle",
    status: feedRate <= 450 && spindleRpm >= 10000 ? "ready" : "review",
    expected: "F<=450mm/min, S>=10000rpm",
    actual: `F${fmt(feedRate, 1)} / S${Math.round(spindleRpm)}`,
    note: "低刚性小机床建议用倍率旋钮从 30%-50% 起步。"
  });

  if (!isVFlat25) warnings.push("当前刀具不是 4mm 25度平底尖刀，真实刀痕和清根能力会与项目预期不同。");
  if (stepoverMm > toolDiameter * 0.18) warnings.push("步距相对 4mm 尖刀偏大，精加工表面可能有明显台阶。");
  if (maxCutDepth > 0.45) warnings.push("单刀最大切深超过 0.45mm，建议先用废料验证刀具受力和夹具刚性。");
  if (depthMm > 0 && maxCutDepth > depthMm) warnings.push("单刀最大切深大于目标深度，请检查 maxCutDepth/depthMm 参数。");

  return {
    schema: "hediao3d.tool-setup-sheet.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    summary: warnings.length === 0
      ? "刀具参数与 4mm 25度平底尖刀试雕配置匹配。"
      : `刀具核验存在 ${warnings.length} 个复核项。`,
    tool: {
      toolProfileId: settings.toolProfileId ?? null,
      name: tool.name,
      type: isVFlat25 ? "v-bit-flat-tip" : "custom",
      diameterMm: toolDiameter,
      angleDeg: isVFlat25 ? 25 : null,
      flatTipMm: isVFlat25 ? 0.4 : null,
      tipRadiusMm: isVFlat25 ? 0.2 : null,
      fluteLengthMm,
      stickoutMm
    },
    cutting: {
      spindleRpm,
      feedRateMmMin: feedRate,
      safeZMm: Number(settings.safeZ ?? 0),
      maxCutDepthMm: maxCutDepth,
      targetDepthMm: depthMm,
      stepoverMm,
      stepoverDeg,
      stockAllowanceMm: Number(settings.stockAllowance ?? 0),
      estimatedMinutes: Number(toolpath.estimatedMinutes ?? 0),
      pointCount: toolpath.points?.length ?? 0
    },
    machineContext: {
      camMode: settings.camMode,
      postProcessorName: postprocessProfile.postProcessorName,
      rotaryOutputAxis: postprocessProfile.machine?.rotaryOutputAxis ?? null,
      rotaryWrapPerRevolutionMm: postprocessProfile.machine?.rotaryWrapPerRevolutionMm ?? null
    },
    checks,
    warnings,
    setupProcedure: [
      "确认实际装刀为 4mm 25度平底尖刀，刀尖平底约 0.4mm。",
      "测量伸出长度，尽量短装；若伸出超过 18mm，降低进给和单刀切深。",
      "先运行 rotary-calibration-airrun.nc 确认旋转夹具方向、每圈距离和反向间隙。",
      "再运行 air-run.nc 前确认主轴关闭、Z 安全高度和整条刀路行程。",
      "首次试雕使用废料或低价值核胚，并把进给倍率降到 30%-50%。"
    ]
  };
}

function createRotaryCalibrationSheet({ job, settings, toolpath, productionGate, postprocessProfile, machineControllerProfile }) {
  const camMode = settings.camMode ?? "unknown";
  const rotaryAxis = machineControllerProfile?.axisMapping?.rotaryAxis ?? postprocessProfile.coordinateMapping?.rotaryAxis ?? settings.rotaryOutputAxis ?? null;
  const lengthAxis = machineControllerProfile?.axisMapping?.lengthAxis ?? postprocessProfile.coordinateMapping?.lengthAxis ?? "X";
  const depthAxis = machineControllerProfile?.axisMapping?.depthAxis ?? postprocessProfile.coordinateMapping?.depthAxis ?? "Z";
  const wrapPerRev = camMode === "rotaryWrap"
    ? Math.max(0.001, Number(machineControllerProfile?.rotary?.wrapPerRevolutionMm ?? postprocessProfile.machine?.rotaryWrapPerRevolutionMm ?? settings.rotaryWrapPerRevolutionMm ?? 100))
    : null;
  const rotaryDegPerMm = wrapPerRev ? 360 / wrapPerRev : null;
  const warnings = [];
  if (camMode !== "rotaryWrap") warnings.push("当前不是旋转包裹 CAM 模式，旋转夹具标定单仅作参考。");
  if (!rotaryAxis) warnings.push("未识别旋转输出轴，请确认机床夹具接线。");
  if (wrapPerRev && (wrapPerRev < 20 || wrapPerRev > 400)) warnings.push("每圈等效距离超出常见小型旋转夹具范围，请复核控制器脉冲参数。");
  const testMoveMm = wrapPerRev ? Math.min(wrapPerRev / 4, 25) : null;
  const testMoveDeg = rotaryDegPerMm && testMoveMm ? testMoveMm * rotaryDegPerMm : null;

  return {
    schema: "hediao3d.rotary-calibration-sheet.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    summary: warnings.length === 0
      ? "旋转夹具参数已按 Y/A 包裹模式记录；上机前仍需现场标定方向和每圈距离。"
      : `旋转夹具标定存在 ${warnings.length} 个复核项。`,
    mode: camMode,
    axisMapping: {
      lengthAxis,
      depthAxis,
      rotaryAxis,
      rotaryOutputMode: rotaryAxis === "A" ? "degree-axis" : rotaryAxis ? "linearized-rotary-axis" : "unknown",
      rotaryWrapPerRevolutionMm: wrapPerRev,
      rotaryDegPerLinearMm: rotaryDegPerMm
    },
    testProgramIntent: {
      airRunFile: "air-run.nc",
      rotaryCalibrationAirRunFile: "rotary-calibration-airrun.nc",
      machineFileForTrialOnly: productionGate.allowTrialNc ? "toolpath.nc" : null,
      recommendedManualTest: rotaryAxis
        ? `${rotaryAxis}${testMoveMm ? fmt(testMoveMm, 3) : "?"} 应约等于夹具旋转 ${testMoveDeg ? fmt(testMoveDeg, 1) : "?"} 度。`
        : "先确认旋转夹具接到 Y 轴、A 轴或其他控制器轴。"
    },
    acceptanceThresholds: {
      oneRevolutionErrorDegMax: 2,
      quarterTurnErrorDegMax: 1,
      backlashDegMax: 0.5,
      lengthAxisPositionErrorMmMax: 0.1,
      safeZMustRemainMm: Number(settings.safeZ ?? 0)
    },
    checklist: [
      {
        id: "axis-direction",
        title: "确认旋转方向",
        expected: "正向旋转应与预览中的展开方向一致；若佛头左右颠倒，反转旋转轴方向或 meshAxisReverse。"
      },
      {
        id: "per-revolution",
        title: "确认每圈等效距离",
        expected: wrapPerRev ? `控制器 ${rotaryAxis ?? "旋转轴"} 移动 ${fmt(wrapPerRev, 3)}mm 时，夹具应旋转 360 度。` : "记录实际一圈所需的控制器距离。"
      },
      {
        id: "backlash",
        title: "确认反向间隙",
        expected: "正反各走 10 度后回零，视觉误差建议小于 0.5 度。"
      },
      {
        id: "hold-margin",
        title: "确认两端夹持余量",
        expected: `左右夹持区不应进入有效雕刻区；当前左 ${fmt(settings.leftHoldMm ?? 0, 2)}mm / 右 ${fmt(settings.rightHoldMm ?? 0, 2)}mm。`
      }
    ],
    warnings,
    operatorRecordTemplate: {
      measuredWrapPerRevolutionMm: wrapPerRev,
      measuredQuarterTurnMm: testMoveMm,
      measuredQuarterTurnDeg: "",
      backlashDeg: "",
      directionOk: false,
      notes: ""
    },
    metrics: {
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes: Number(toolpath.estimatedMinutes ?? 0)
    }
  };
}

function createOperatorRunbookMarkdown({ job, settings, toolpath, productionGate, postprocessProfile, toolSetupSheet, rotaryCalibrationSheet, machineAcceptanceChecklist, ncStaticAnalysis, controllerDialectReport }) {
  const axisInstruction = createOperatorAxisInstruction(postprocessProfile);
  const lines = [
    "# HeDiao3D V3 操作员上机说明书",
    "",
    `Job ID: ${job.id}`,
    `生成时间: ${new Date().toISOString()}`,
    `加工包级别: ${productionGate.level}`,
    `结论: ${productionGate.summary}`,
    "",
    "## 先读结论",
    "",
    `- 允许离料空跑: ${productionGate.allowAirRun ? "是" : "否"}`,
    `- 允许小料试雕: ${productionGate.allowTrialNc ? "是" : "否"}`,
    `- 允许生产 NC: ${productionGate.allowProductionNc ? "是" : "否"}`,
    productionGate.allowProductionNc
      ? "- 当前仍需操作员完成现场验收记录后再正式加工。"
      : "- 当前不建议直接正式加工，只允许按门禁结果做空跑或低风险试雕。",
    "",
    "## 文件用途",
    "",
    "- `rotary-calibration-airrun.nc`: 旋转夹具标定空跑，主轴关闭，Z 保持安全高度，只验证 90/180/360 度旋转距离和方向。",
    "- `air-run.nc`: 离料空跑，主轴关闭，确认行程、方向和安全高度。",
    "- `toolpath.nc`: 试雕/生产候选文件，只有生产门禁或试雕门禁允许时才能使用。",
    "- `camotics-preview.nc`: 仅用于 CAMotics 展开三轴仿真，禁止上机。",
    "- `production-gate.json`: 生产门禁结论。",
    "- `machine-acceptance-checklist.json`: 现场验收记录模板。",
    "- `package-integrity.json`: 文件大小和 SHA-256 核验清单。",
    "",
    "## 机床与轴向",
    "",
    `- CAM 模式: ${postprocessProfile.camMode}`,
    `- 长度轴: ${postprocessProfile.coordinateMapping?.lengthAxis ?? "X"}`,
    `- 刀深轴: ${postprocessProfile.coordinateMapping?.depthAxis ?? "Z"}`,
    `- 旋转轴: ${postprocessProfile.coordinateMapping?.rotaryAxis ?? "无"}`,
    `- 每圈等效距离: ${rotaryCalibrationSheet.axisMapping?.rotaryWrapPerRevolutionMm ?? "-"} mm/圈`,
    `- 上机轴向: ${axisInstruction}`,
    "",
    "## 刀具确认",
    "",
    `- 刀具: ${toolSetupSheet.tool.name}`,
    `- 直径: ${toolSetupSheet.tool.diameterMm} mm`,
    `- 角度: ${toolSetupSheet.tool.angleDeg ?? "-"} deg`,
    `- 平底: ${toolSetupSheet.tool.flatTipMm ?? "-"} mm`,
    `- 最大单刀切深: ${toolSetupSheet.cutting.maxCutDepthMm} mm`,
    `- 步距: ${toolSetupSheet.cutting.stepoverMm} mm / ${toolSetupSheet.cutting.stepoverDeg} deg`,
    `- 进给/转速: F${toolSetupSheet.cutting.feedRateMmMin} / S${toolSetupSheet.cutting.spindleRpm}`,
    ...(toolSetupSheet.warnings.length ? toolSetupSheet.warnings.map((item) => `- 复核: ${item}`) : ["- 刀具参数无额外复核项。"]),
    "",
    "## 上机顺序",
    "",
    "1. 核对 `package-integrity.json`，确认下载文件没有缺失。",
    "2. 阅读 `production-gate.json`、`tool-setup-sheet.json`、`rotary-calibration-sheet.json`。",
    "3. 手动低速验证旋转夹具方向和每圈等效距离。",
    "4. 运行 `rotary-calibration-airrun.nc`，确认 90/180/360 度旋转方向、每圈距离和反向间隙。",
    `5. 运行 \`air-run.nc\`，确认 ${axisInstruction} 的方向、行程和安全高度。`,
    "6. 若允许试雕，使用废料或低价值核胚运行 `toolpath.nc`，进给倍率建议 30%-50%。",
    "7. 记录试雕结果；只有生产门禁允许且现场验收通过后，才可正式加工。",
    "",
    "## 现场验收清单",
    "",
    ...(machineAcceptanceChecklist.steps ?? []).map((step) => `- [ ] ${step.title}: ${step.expectedEvidence}`),
    "",
    "## 风险与阻断",
    "",
    ...(productionGate.blockers?.length ? productionGate.blockers.map((item) => `- 阻断: ${item}`) : ["- 阻断: 无"]),
    ...(productionGate.warnings?.length ? productionGate.warnings.slice(0, 12).map((item) => `- 复核: ${item}`) : ["- 复核: 无"]),
    ...(ncStaticAnalysis?.criticalIssues?.length ? ncStaticAnalysis.criticalIssues.map((item) => `- NC阻断: ${item}`) : []),
    ...(controllerDialectReport?.criticalIssues?.length ? controllerDialectReport.criticalIssues.map((item) => `- 控制器阻断: ${item}`) : []),
    "",
    "## 记录",
    "",
    "- 操作员:",
    "- 机床编号:",
    "- 刀具实测直径:",
    "- 旋转每圈实测距离:",
    "- 空跑时间:",
    "- 试雕材料:",
    "- 试雕结论:",
    "- 备注:",
    "",
    `估算加工时间: ${fmt(toolpath.estimatedMinutes ?? 0, 1)} min`,
    `刀路点数: ${toolpath.points?.length ?? 0}`,
    `长度/直径: ${fmt(settings.lengthMm, 2)}mm / ${fmt(settings.diameterMm, 2)}mm`
  ];
  return `${lines.join("\n")}\n`;
}

function createOperatorAxisInstruction(postprocessProfile = {}) {
  const mapping = postprocessProfile.coordinateMapping ?? {};
  const lengthAxis = mapping.lengthAxis ?? "X";
  const depthAxis = mapping.depthAxis ?? "Z";
  const rotaryAxis = mapping.rotaryAxis ?? null;
  if (postprocessProfile.camMode === "rotaryWrap" && rotaryAxis) {
    return `${lengthAxis}=长度方向，${rotaryAxis}=旋转夹具，${depthAxis}=刀深/安全高度`;
  }
  const planarAxis = mapping.planarWidthAxis ?? "Y";
  return `${lengthAxis}=长度方向，${planarAxis}=平面宽度方向，${depthAxis}=刀深/安全高度`;
}

function createExternalGcodeBindingGateStatus(externalGcodeImportValidation, camHandoffQuality) {
  const required = Boolean(
    externalGcodeImportValidation
    || camHandoffQuality?.sourceSnapshot?.kind === "gcode"
    || camHandoffQuality?.adapterHandoffEvidence?.outputKind === "gcode"
  );
  if (!required) {
    return {
      required: false,
      status: "pass",
      bindingStatus: "not-required",
      productionCandidate: false,
      summary: "本次未使用外部 G-code handoff。"
    };
  }
  if (!externalGcodeImportValidation) {
    return {
      required: true,
      status: "review",
      bindingStatus: "missing",
      productionCandidate: false,
      summary: "检测到外部 G-code handoff，但缺少 external-gcode-import-validation.json。"
    };
  }
  if (externalGcodeImportValidation.status === "critical") {
    return {
      required: true,
      status: "block",
      bindingStatus: externalGcodeImportValidation.sourceBinding?.status ?? "critical",
      productionCandidate: false,
      summary: externalGcodeImportValidation.summary ?? "外部 G-code 源绑定存在阻断项。"
    };
  }
  if (externalGcodeImportValidation.status === "bound-production-candidate" && externalGcodeImportValidation.productionCandidate === true) {
    return {
      required: true,
      status: "pass",
      bindingStatus: externalGcodeImportValidation.sourceBinding?.status ?? "bound",
      productionCandidate: true,
      summary: externalGcodeImportValidation.summary ?? "外部 G-code 源绑定和 CAM proof 已通过。"
    };
  }
  return {
    required: true,
    status: "review",
    bindingStatus: externalGcodeImportValidation.sourceBinding?.status ?? externalGcodeImportValidation.status ?? "review",
    productionCandidate: Boolean(externalGcodeImportValidation.productionCandidate),
    summary: externalGcodeImportValidation.summary ?? "外部 G-code 源绑定需要复核。"
  };
}

function createProductionUnlockMatrix({ job, productionGate, meshQuality, repairPlan, camInputPlan, engineReadiness, nativeCamReadiness, simulationSummary, ncStaticAnalysis, camHandoffQuality, postprocessTraceReport, neutralToolpathImportValidation = null, externalGcodeImportValidation = null, controllerDialectReport, toolSetupSheet, rotaryCalibrationSheet }) {
  const simulationEvidence = productionGate.simulationEvidence ?? createSimulationEvidence(simulationSummary);
  const neutralBinding = createNeutralToolpathBindingGateStatus(neutralToolpathImportValidation, camHandoffQuality);
  const externalGcodeBinding = createExternalGcodeBindingGateStatus(externalGcodeImportValidation, camHandoffQuality);
  const neutralToolpathHandoff = Boolean(
    neutralToolpathImportValidation
    || camHandoffQuality?.sourceSnapshot?.kind === "neutral-toolpath"
    || existsSync(join(job.workDir, "neutral-toolpath.json"))
  );
  const rows = [
    {
      id: "mesh-quality",
      label: "Mesh质量",
      status: meshQuality.verdict === "ready" || repairPlan.status !== "repair-required" ? "pass" : "block",
      evidence: "mesh-quality.json",
      summary: `${meshQuality.verdict} / score ${fmt(meshQuality.score ?? 0, 1)}`,
      requiredForProduction: true
    },
    {
      id: "cam-input",
      label: "CAM输入模型",
      status: camInputPlan.gate?.allowProductionNc ? "pass" : camInputPlan.status === "blocked" ? "block" : "review",
      evidence: "cam-input-plan.json",
      summary: camInputPlan.summary,
      requiredForProduction: true
    },
    {
      id: "external-cam",
      label: "外部CAM引擎",
      status: engineReadiness.externalReady ? "pass" : "review",
      evidence: "engine-diagnostics.json",
      summary: engineReadiness.summary,
      requiredForProduction: true
    },
    {
      id: "native-cam",
      label: "Native CAM环境",
      status: nativeCamReadiness?.level === "ready" ? "pass" : "review",
      evidence: "native-cam-readiness.json",
      summary: nativeCamReadiness?.summary ?? "未生成 Native CAM 就绪报告。",
      requiredForProduction: true
    },
    {
      id: "cam-handoff-quality",
      label: "CAM Handoff质量",
      status: camHandoffQuality?.level === "ready" ? "pass" : camHandoffQuality?.level === "critical" ? "block" : "review",
      evidence: "cam-handoff-quality.json",
      summary: camHandoffQuality?.summary ?? "未生成 CAM handoff 质量报告。",
      requiredForProduction: true
    },
    ...(neutralToolpathHandoff ? [{
      id: "neutral-toolpath-import-validation",
      label: "Neutral刀位点导入校验",
      status: neutralBinding.status,
      evidence: "neutral-toolpath-import-validation.json",
      summary: neutralToolpathImportValidation
        ? `${neutralToolpathImportValidation.summary} / sourceBinding=${neutralBinding.bindingStatus}`
        : neutralBinding.summary,
      requiredForProduction: true
    }] : []),
    ...(externalGcodeBinding.required ? [{
      id: "external-gcode-import-validation",
      label: "外部G-code导入校验",
      status: externalGcodeBinding.status,
      evidence: "external-gcode-import-validation.json",
      summary: externalGcodeImportValidation
        ? `${externalGcodeImportValidation.summary} / sourceBinding=${externalGcodeBinding.bindingStatus} / productionCandidate=${externalGcodeBinding.productionCandidate ? "yes" : "no"}`
        : externalGcodeBinding.summary,
      requiredForProduction: true
    }] : []),
    {
      id: "simulation-evidence",
      label: "材料去除仿真证据",
      status: simulationEvidence.productionUnlockEligible ? "pass" : "review",
      evidence: "simulation-summary.json / camotics-result.json",
      summary: simulationEvidence.summary,
      requiredForProduction: true
    },
    {
      id: "nc-static-analysis",
      label: "NC静态分析",
      status: ncStaticAnalysis?.level === "ready" ? "pass" : ncStaticAnalysis?.level === "critical" ? "block" : "review",
      evidence: "nc-static-analysis.json",
      summary: ncStaticAnalysis?.summary ?? "未生成 NC 静态分析。",
      requiredForProduction: true
    },
    {
      id: "postprocess-trace",
      label: "后处理点位追溯",
      status: postprocessTraceReport?.level === "ready" ? "pass" : postprocessTraceReport?.level === "critical" ? "block" : "review",
      evidence: "postprocess-trace-report.json",
      summary: postprocessTraceReport?.summary ?? "未生成后处理追溯报告。",
      requiredForProduction: true
    },
    {
      id: "controller-dialect",
      label: "控制器方言兼容",
      status: controllerDialectReport?.level === "ready" ? "pass" : controllerDialectReport?.level === "critical" ? "block" : "review",
      evidence: "controller-dialect-report.json",
      summary: controllerDialectReport?.summary ?? "未生成控制器方言报告。",
      requiredForProduction: true
    },
    {
      id: "tool-setup",
      label: "刀具装夹参数",
      status: toolSetupSheet?.warnings?.length ? "review" : "pass",
      evidence: "tool-setup-sheet.json",
      summary: toolSetupSheet?.summary ?? "未生成刀具核验单。",
      requiredForProduction: true
    },
    {
      id: "rotary-calibration",
      label: "旋转夹具标定",
      status: rotaryCalibrationSheet?.warnings?.length ? "review" : "pass",
      evidence: "rotary-calibration-sheet.json",
      summary: rotaryCalibrationSheet?.summary ?? "未生成旋转夹具标定单。",
      requiredForProduction: true
    }
  ];
  const blockCount = rows.filter((row) => row.status === "block").length;
  const reviewCount = rows.filter((row) => row.status === "review").length;
  const passCount = rows.filter((row) => row.status === "pass").length;

  return {
    schema: "hediao3d.production-unlock-matrix.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    allowProductionNc: productionGate.allowProductionNc,
    summary: productionGate.allowProductionNc
      ? "生产 NC 已满足矩阵条件。"
      : `生产 NC 未解锁：${blockCount} 个阻断项，${reviewCount} 个复核项。`,
    passCount,
    reviewCount,
    blockCount,
    rows,
    blockers: productionGate.blockers ?? [],
    warnings: productionGate.warnings ?? [],
    requiredActions: productionGate.requiredActions ?? []
  };
}

function createProductionEvidenceDossierFromJobArtifacts(job, overrides = {}) {
  if (!job?.workDir) return null;
  const productionGate = readJsonFile(join(job.workDir, "production-gate.json"));
  const productionUnlockMatrix = readJsonFile(join(job.workDir, "production-unlock-matrix.json"));
  const camHandoffQuality = readJsonFile(join(job.workDir, "cam-handoff-quality.json"));
  const neutralToolpathImportValidation = readJsonFile(join(job.workDir, "neutral-toolpath-import-validation.json"));
  const externalGcodeImportValidation = readJsonFile(join(job.workDir, "external-gcode-import-validation.json"));
  const simulationSummary = readJsonFile(join(job.workDir, "simulation-summary.json"));
  const ncStaticAnalysis = readJsonFile(join(job.workDir, "nc-static-analysis.json"));
  const postprocessTraceReport = readJsonFile(join(job.workDir, "postprocess-trace-report.json"));
  const controllerDialectReport = readJsonFile(join(job.workDir, "controller-dialect-report.json"));
  const machineAcceptanceChecklist = readJsonFile(join(job.workDir, "machine-acceptance-checklist.json"));
  if (!productionGate) return null;
  return createProductionEvidenceDossier({
    job,
    productionGate,
    productionUnlockMatrix,
    camHandoffQuality,
    neutralToolpathImportValidation,
    externalGcodeImportValidation,
    simulationSummary,
    ncStaticAnalysis,
    postprocessTraceReport,
    controllerDialectReport,
    machineAcceptanceChecklist,
    machineAcceptanceLog: overrides.machineAcceptanceLog ?? readJsonFile(join(job.workDir, "machine-acceptance-log.json")),
    trialFeedbackLog: overrides.trialFeedbackLog ?? readJsonFile(join(job.workDir, "trial-feedback-log.json")),
    processOptimizationPlan: overrides.processOptimizationPlan ?? readJsonFile(join(job.workDir, "process-optimization-plan.json"))
  });
}

function createProductionEvidenceDossier({ job, productionGate, productionUnlockMatrix, camHandoffQuality, neutralToolpathImportValidation = null, externalGcodeImportValidation = null, simulationSummary, ncStaticAnalysis, postprocessTraceReport, controllerDialectReport, machineAcceptanceChecklist, machineAcceptanceLog = null, trialFeedbackLog = null, processOptimizationPlan = null }) {
  const simulationEvidence = productionGate?.simulationEvidence ?? createSimulationEvidence(simulationSummary);
  const camoticsIdentity = summarizeCamoticsEvidenceIdentity(simulationEvidence);
  const unlockRows = Array.isArray(productionUnlockMatrix?.rows) ? productionUnlockMatrix.rows : [];
  const hasNeutralToolpathImport = Boolean(
    neutralToolpathImportValidation
    || unlockRows.some((row) => row.id === "neutral-toolpath-import-validation")
    || camHandoffQuality?.sourceSnapshot?.kind === "neutral-toolpath"
    || existsSync(join(job.workDir, "neutral-toolpath.json"))
  );
  const hasExternalGcodeImport = Boolean(
    externalGcodeImportValidation
    || unlockRows.some((row) => row.id === "external-gcode-import-validation")
    || camHandoffQuality?.sourceSnapshot?.kind === "gcode"
    || camHandoffQuality?.adapterHandoffEvidence?.outputKind === "gcode"
  );
  const latestMachineAcceptanceRecord = Array.isArray(machineAcceptanceLog?.records) ? machineAcceptanceLog.records[0] : null;
  const latestTrialFeedbackRecord = Array.isArray(trialFeedbackLog?.records) ? trialFeedbackLog.records[0] : null;
  const neutralBinding = createNeutralToolpathBindingGateStatus(neutralToolpathImportValidation, camHandoffQuality);
  const externalGcodeBinding = createExternalGcodeBindingGateStatus(externalGcodeImportValidation, camHandoffQuality);
  const machineAcceptanceIntegrityBound = latestMachineAcceptanceRecord?.downloadIntegrity?.packageBinding?.status === "matched";
  const trialFeedbackIntegrityBound = latestTrialFeedbackRecord?.downloadIntegrity?.packageBinding?.status === "matched";
  const fieldEvidencePackageBinding = createFieldEvidencePackageBinding(latestMachineAcceptanceRecord, latestTrialFeedbackRecord);
  const trialFeedbackPassed = trialFeedbackLog?.recordCount > 0
    && trialFeedbackLog.latestOutcome === "success"
    && trialFeedbackIntegrityBound;
  const machineAcceptancePassed = machineAcceptanceLog?.recordCount > 0
    && machineAcceptanceLog.latestOutcome === "success"
    && machineAcceptanceLog.latestAllRequiredPassed === true
    && machineAcceptanceIntegrityBound;
  const productionReadinessAudit = createProductionReadinessAudit({
    productionGate,
    camHandoffQuality,
    neutralBinding,
    externalGcodeBinding,
    simulationEvidence,
    ncStaticAnalysis,
    controllerDialectReport,
    machineAcceptancePassed,
    trialFeedbackPassed,
    fieldEvidencePackageBinding
  });
  const evidenceItems = [
    {
      id: "production-gate",
      label: "生产门禁",
      status: productionGate?.allowProductionNc ? "pass" : productionGate?.level === "blocked" ? "block" : "review",
      evidence: ["production-gate.json"],
      summary: productionGate?.summary ?? "未生成生产门禁。"
    },
    {
      id: "unlock-matrix",
      label: "生产解锁矩阵",
      status: productionUnlockMatrix?.allowProductionNc ? "pass" : productionUnlockMatrix?.blockCount > 0 ? "block" : "review",
      evidence: ["production-unlock-matrix.json"],
      summary: productionUnlockMatrix?.summary ?? "未生成生产解锁矩阵。"
    },
    {
      id: "external-cam-handoff",
      label: "CAM Handoff",
      status: camHandoffQuality?.level === "ready" ? "pass" : camHandoffQuality?.level === "critical" ? "block" : "review",
      evidence: ["cam-handoff-quality.json", "adapter-report.json", "neutral-toolpath.json"],
      summary: camHandoffQuality?.summary ?? "未生成 CAM handoff 质量报告。"
    },
    ...(hasNeutralToolpathImport ? [{
      id: "neutral-toolpath-import-validation",
      label: "Neutral刀位点导入校验",
      status: neutralBinding.status,
      evidence: ["neutral-toolpath-import-validation.json", "neutral-toolpath.json", "imported-neutral-toolpath.json"],
      summary: neutralToolpathImportValidation
        ? `${neutralToolpathImportValidation.summary} / sourceBinding=${neutralBinding.bindingStatus}`
        : neutralBinding.summary
    }] : []),
    ...(hasExternalGcodeImport ? [{
      id: "external-gcode-import-validation",
      label: "外部G-code导入校验",
      status: externalGcodeBinding.status,
      evidence: ["external-gcode-import-validation.json", "adapter-report.json", "toolpath.nc"],
      summary: externalGcodeImportValidation
        ? `${externalGcodeImportValidation.summary} / sourceBinding=${externalGcodeBinding.bindingStatus} / productionCandidate=${externalGcodeBinding.productionCandidate ? "yes" : "no"}`
        : externalGcodeBinding.summary
    }] : []),
    {
      id: "material-removal-simulation",
      label: "材料去除仿真",
      status: simulationEvidence?.productionUnlockEligible ? "pass" : "review",
      evidence: ["simulation-summary.json", "camotics-result.json", "camotics-adapter-report.json"],
      summary: simulationEvidence
        ? `${simulationEvidence.summary} / input=${camoticsIdentity.inputIdentityStatus} / cli=${camoticsIdentity.cliRunPackageBindingStatus} / motion=${camoticsIdentity.motionConsistencyStatus} / artifacts=${camoticsIdentity.artifactEvidenceStatus}`
        : "未生成仿真证据。"
    },
    {
      id: "nc-static-analysis",
      label: "NC 静态分析",
      status: ncStaticAnalysis?.level === "ready" ? "pass" : ncStaticAnalysis?.level === "critical" ? "block" : "review",
      evidence: ["nc-static-analysis.json", "toolpath.nc", "air-run.nc"],
      summary: ncStaticAnalysis?.summary ?? "未生成 NC 静态分析。"
    },
    {
      id: "postprocess-trace",
      label: "后处理点位追溯",
      status: postprocessTraceReport?.level === "ready" ? "pass" : postprocessTraceReport?.level === "critical" ? "block" : "review",
      evidence: ["postprocess-trace-report.json", "toolpath.nc", "toolpath-summary.json"],
      summary: postprocessTraceReport?.summary ?? "未生成后处理追溯报告。"
    },
    {
      id: "controller-dialect",
      label: "控制器方言",
      status: controllerDialectReport?.level === "ready" ? "pass" : controllerDialectReport?.level === "critical" ? "block" : "review",
      evidence: ["controller-dialect-report.json", "machine-controller-profile.json"],
      summary: controllerDialectReport?.summary ?? "未生成控制器方言报告。"
    },
    {
      id: "machine-acceptance",
      label: "机床现场验收",
      status: machineAcceptanceLog?.recordCount > 0
        ? machineAcceptancePassed ? "pass" : machineAcceptanceLog.latestOutcome === "failed" ? "block" : "review"
        : "review",
      evidence: ["machine-acceptance-checklist.json", "machine-acceptance-log.json", "machine-acceptance-record.json", "operator-runbook.md"],
      summary: machineAcceptanceLog?.recordCount > 0
        ? `已回填 ${machineAcceptanceLog.recordCount} 条机床验收记录，最新结论 ${machineAcceptanceLog.latestOutcome}，必需项${machineAcceptanceLog.latestAllRequiredPassed ? "已通过" : "未全部通过"}，下载包绑定${machineAcceptanceIntegrityBound ? "已匹配" : "未匹配"}。`
        : machineAcceptanceChecklist
          ? "已生成机床验收清单，但尚未回填真实空跑/试雕验收记录。"
          : "未生成机床验收清单。"
    },
    {
      id: "trial-feedback",
      label: "试雕反馈",
      status: trialFeedbackLog?.recordCount > 0
        ? trialFeedbackPassed ? "pass" : "review"
        : "review",
      evidence: ["trial-feedback-template.json", "trial-feedback-log.json", "trial-feedback-record.json"],
      summary: trialFeedbackLog?.recordCount > 0
        ? `已回填 ${trialFeedbackLog.recordCount} 条试雕反馈，最新结论 ${trialFeedbackLog.latestOutcome}，下载包绑定${trialFeedbackIntegrityBound ? "已匹配" : "未匹配"}。`
        : "尚未回填真实空跑/试雕反馈。"
    },
    {
      id: "process-optimization",
      label: "工艺优化闭环",
      status: processOptimizationPlan
        ? processOptimizationPlan.status === "candidate-success-profile" ? "pass" : "review"
        : "review",
      evidence: ["process-optimization-plan.json"],
      summary: processOptimizationPlan?.summary ?? "尚未根据试雕反馈生成工艺优化计划。"
    }
  ];
  const passedCount = evidenceItems.filter((item) => item.status === "pass").length;
  const blockedCount = evidenceItems.filter((item) => item.status === "block").length;
  const reviewCount = evidenceItems.filter((item) => item.status === "review").length;
  const missingEvidence = evidenceItems
    .filter((item) => item.status !== "pass")
    .map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      summary: item.summary,
      evidence: item.evidence
    }));
  const unlockByMatrix = unlockRows.length
    ? unlockRows.every((row) => row.status === "pass")
    : false;
  const status = productionGate?.allowProductionNc && blockedCount === 0 && reviewCount === 0 && unlockByMatrix
    ? "production-evidence-complete"
    : blockedCount > 0
      ? "blocked"
      : "trial-evidence-incomplete";
  return {
    schema: "hediao3d.production-evidence-dossier.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    status,
    packageLevel: productionGate?.level ?? null,
    allowProductionNc: Boolean(productionGate?.allowProductionNc),
    allowTrialNc: Boolean(productionGate?.allowTrialNc),
    passedCount,
    reviewCount,
    blockedCount,
    evidenceItems,
    missingEvidence,
    crossChecks: {
      unlockMatrixPass: unlockByMatrix,
      realMaterialRemovalVerified: Boolean(simulationEvidence?.realMaterialRemovalVerified),
      camoticsInputIdentityStatus: camoticsIdentity.inputIdentityStatus,
      camoticsCliRunPackageBindingStatus: camoticsIdentity.cliRunPackageBindingStatus,
      camoticsMotionConsistencyStatus: camoticsIdentity.motionConsistencyStatus,
      camoticsArtifactEvidenceStatus: camoticsIdentity.artifactEvidenceStatus,
      camHandoffReady: camHandoffQuality?.level === "ready",
      neutralSourceBindingStatus: neutralBinding.required ? neutralBinding.bindingStatus : "not-required",
      neutralSourceBindingPass: !neutralBinding.required || neutralBinding.status === "pass",
      externalGcodeSourceBindingStatus: externalGcodeBinding.required ? externalGcodeBinding.bindingStatus : "not-required",
      externalGcodeSourceBindingPass: !externalGcodeBinding.required || externalGcodeBinding.status === "pass",
      externalGcodeProductionCandidate: Boolean(externalGcodeBinding.productionCandidate),
      ncStaticReady: ncStaticAnalysis?.level === "ready",
      controllerDialectReady: controllerDialectReport?.level === "ready",
      machineAcceptanceRecords: machineAcceptanceLog?.recordCount ?? 0,
      latestMachineAcceptanceOutcome: machineAcceptanceLog?.latestOutcome ?? null,
      machineAcceptancePassed,
      machineAcceptanceIntegrityBound,
      trialFeedbackRecords: trialFeedbackLog?.recordCount ?? 0,
      latestTrialFeedbackOutcome: trialFeedbackLog?.latestOutcome ?? null,
      trialFeedbackPassed,
      trialFeedbackIntegrityBound,
      fieldEvidencePackageBinding,
      productionReadinessAudit,
      optimizationStatus: processOptimizationPlan?.status ?? null
    },
    requiredActions: dedupeStrings([
      ...(productionGate?.requiredActions ?? []),
      ...missingEvidence.map((item) => `补齐或复核：${item.label} - ${item.summary}`)
    ]),
    summary: status === "production-evidence-complete"
      ? "生产证据档案完整，可作为生产 NC 解锁依据之一。"
      : status === "blocked"
        ? `生产证据档案存在 ${blockedCount} 个阻断项。`
        : `生产证据仍不完整：${reviewCount} 个复核项。`
  };
}

function createProductionReadinessAudit({ productionGate, camHandoffQuality, neutralBinding, externalGcodeBinding, simulationEvidence, ncStaticAnalysis, controllerDialectReport, machineAcceptancePassed, trialFeedbackPassed, fieldEvidencePackageBinding }) {
  const externalSourceReady = camHandoffQuality?.level === "ready"
    && camHandoffQuality?.source === "external-adapter"
    && camHandoffQuality?.externalToolpathUsed === true
    && camHandoffQuality?.synthetic !== true
    && camHandoffQuality?.importedFixture !== true
    && camHandoffQuality?.previewScaffold !== true;
  const externalBindingReady = Boolean(
    externalGcodeBinding?.productionCandidate === true
    || (neutralBinding?.required === true && neutralBinding?.status === "pass")
  );
  const realCamReady = externalSourceReady && externalBindingReady;
  const realSimulationReady = Boolean(
    simulationEvidence?.realMaterialRemovalVerified
    && simulationEvidence?.productionUnlockEligible
    && simulationEvidence?.level === "material-removal-verified"
  );
  const ncReady = ncStaticAnalysis?.level === "ready" && controllerDialectReport?.level === "ready";
  const fieldReady = Boolean(
    machineAcceptancePassed
    && trialFeedbackPassed
    && fieldEvidencePackageBinding?.status === "matched"
  );
  const gates = [
    {
      id: "external-cam-proof",
      label: "真实外部CAM输出",
      status: realCamReady ? "pass" : camHandoffQuality?.level === "critical" ? "block" : "review",
      summary: realCamReady
        ? "外部 CAM handoff 已通过，且不是 synthetic/fixture/preview 输出。"
        : "尚未证明当前刀路来自真实外部 CAM 生产候选输出。"
    },
    {
      id: "material-removal-proof",
      label: "真实材料去除仿真",
      status: realSimulationReady ? "pass" : "review",
      summary: realSimulationReady
        ? "CAMotics/等效材料去除仿真已绑定当前输入并满足生产证据。"
        : simulationEvidence?.summary ?? "缺少真实材料去除仿真证据。"
    },
    {
      id: "postprocess-machine-proof",
      label: "NC与控制器兼容",
      status: ncReady ? "pass" : ncStaticAnalysis?.level === "critical" || controllerDialectReport?.level === "critical" ? "block" : "review",
      summary: ncReady
        ? "NC 静态分析和控制器方言检查通过。"
        : "NC 静态分析或控制器方言仍需复核。"
    },
    {
      id: "field-package-proof",
      label: "现场证据同包绑定",
      status: fieldReady ? "pass" : "review",
      summary: fieldReady
        ? "试雕反馈和机床验收均通过，并绑定同一组加工包文件哈希。"
        : fieldEvidencePackageBinding?.summary ?? "缺少试雕反馈、机床验收或同包哈希绑定。"
    }
  ];
  const blockCount = gates.filter((gate) => gate.status === "block").length;
  const reviewCount = gates.filter((gate) => gate.status === "review").length;
  const passCount = gates.filter((gate) => gate.status === "pass").length;
  const productionGateAllows = productionGate?.allowProductionNc === true;
  const status = productionGateAllows && blockCount === 0 && reviewCount === 0
    ? "production-ready"
    : blockCount > 0
      ? "blocked"
      : "trial-only";
  return {
    schema: "hediao3d.production-readiness-audit.v1",
    status,
    productionGateAllows,
    allowProductionPackage: status === "production-ready",
    passCount,
    reviewCount,
    blockCount,
    gates,
    summary: status === "production-ready"
      ? "生产下载证据已闭环：真实 CAM、真实仿真、NC 检查、现场同包验收均通过。"
      : status === "blocked"
        ? `生产下载存在 ${blockCount} 个阻断项。`
        : `生产下载仍锁定：${reviewCount} 个生产证据项待补齐。`
  };
}

function createFieldEvidencePackageBinding(machineRecord, trialRecord) {
  const machineBinding = machineRecord?.downloadIntegrity?.packageBinding ?? null;
  const trialBinding = trialRecord?.downloadIntegrity?.packageBinding ?? null;
  if (!machineRecord && !trialRecord) {
    return {
      schema: "hediao3d.field-evidence-package-binding.v1",
      status: "missing",
      machineBindingStatus: "missing",
      trialBindingStatus: "missing",
      matchedSharedFileCount: 0,
      mismatchCount: 0,
      sharedFiles: [],
      summary: "尚未回填试雕反馈或机床验收记录。"
    };
  }
  if (!machineRecord || !trialRecord) {
    return {
      schema: "hediao3d.field-evidence-package-binding.v1",
      status: "partial",
      machineBindingStatus: machineBinding?.status ?? "missing",
      trialBindingStatus: trialBinding?.status ?? "missing",
      matchedSharedFileCount: 0,
      mismatchCount: 0,
      sharedFiles: [],
      summary: !machineRecord ? "已回填试雕反馈，但尚未回填机床验收记录。" : "已回填机床验收，但尚未回填试雕反馈。"
    };
  }
  const machineFiles = Array.isArray(machineBinding?.files) ? machineBinding.files : [];
  const trialFiles = Array.isArray(trialBinding?.files) ? trialBinding.files : [];
  const trialByName = new Map(trialFiles.map((file) => [file.filename, file]));
  const sharedFiles = machineFiles
    .filter((file) => trialByName.has(file.filename))
    .map((machineFile) => {
      const trialFile = trialByName.get(machineFile.filename);
      const machineSha = machineFile.expectedSha256 ?? machineFile.submittedSha256 ?? null;
      const trialSha = trialFile.expectedSha256 ?? trialFile.submittedSha256 ?? null;
      const issues = [];
      if (machineFile.status !== "matched") issues.push("machine-binding-not-matched");
      if (trialFile.status !== "matched") issues.push("trial-binding-not-matched");
      if (!machineSha || !trialSha) issues.push("missing-sha256");
      if (machineSha && trialSha && machineSha !== trialSha) issues.push("sha256-mismatch");
      return {
        filename: machineFile.filename,
        status: issues.length === 0 ? "matched" : "mismatch",
        machineSha256: machineSha,
        trialSha256: trialSha,
        issues
      };
    });
  const mismatches = sharedFiles.filter((file) => file.status !== "matched");
  const bothBindingsMatched = machineBinding?.status === "matched" && trialBinding?.status === "matched";
  const status = bothBindingsMatched && sharedFiles.length > 0 && mismatches.length === 0
    ? "matched"
    : "review";
  return {
    schema: "hediao3d.field-evidence-package-binding.v1",
    status,
    machineBindingStatus: machineBinding?.status ?? "missing",
    trialBindingStatus: trialBinding?.status ?? "missing",
    matchedSharedFileCount: sharedFiles.length - mismatches.length,
    mismatchCount: mismatches.length,
    sharedFiles,
    summary: status === "matched"
      ? "试雕反馈和机床验收记录绑定到同一组关键加工包文件哈希。"
      : "试雕反馈与机床验收的加工包绑定需要复核。"
  };
}

function summarizeCamoticsEvidenceIdentity(simulationEvidence) {
  const evidenceQuality = simulationEvidence?.evidenceQuality ?? null;
  return {
    inputIdentityStatus: evidenceQuality?.inputIdentity?.status ?? "missing",
    cliRunPackageBindingStatus: evidenceQuality?.inputIdentity?.cliRunPackage?.status ?? "not-required",
    motionConsistencyStatus: evidenceQuality?.motionConsistency?.status ?? "missing",
    artifactEvidenceStatus: evidenceQuality?.artifactEvidence?.complete === true || evidenceQuality?.artifactEvidenceComplete === true
      ? "complete"
      : Array.isArray(evidenceQuality?.missing) && evidenceQuality.missing.some((item) => /screenshot|material|artifact|截图|网格/i.test(String(item)))
        ? "missing"
        : evidenceQuality?.status ?? "unknown"
  };
}

function createProductionEvidenceDossierPublicSummary(dossier) {
  if (!dossier) return null;
  return {
    schema: dossier.schema,
    artifact: "production-evidence-dossier.json",
    status: dossier.status,
    passedCount: dossier.passedCount,
    reviewCount: dossier.reviewCount,
    blockedCount: dossier.blockedCount,
    summary: dossier.summary,
    crossChecks: dossier.crossChecks ?? null,
    evidenceItems: Array.isArray(dossier.evidenceItems)
      ? dossier.evidenceItems.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        summary: item.summary,
        evidence: item.evidence
      }))
      : []
  };
}

function createSafeTrialExecutionPlan({ job, settings, productionGate, postprocessProfile, toolSetupSheet, rotaryCalibrationSheet, machineAcceptanceChecklist, productionEvidenceDossier }) {
  const axisInstruction = createOperatorAxisInstruction(postprocessProfile);
  const trialNcAllowed = Boolean(productionGate?.allowTrialNc);
  const airRunAllowed = Boolean(productionGate?.allowAirRun);
  const machineName = "三轴控制器 + Y轴旋转夹具";
  const requiredHashFiles = [
    ...(trialNcAllowed ? ["toolpath.nc"] : []),
    "air-run.nc",
    "rotary-calibration-airrun.nc",
    "operator-runbook.md",
    "operator-download-checklist.md",
    "machine-acceptance-checklist.json",
    "trial-feedback-template.json"
  ];
  return {
    schema: "hediao3d.v3-safe-trial-execution-plan.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    purpose: "把前端安全试雕向导、下载包、空跑/软料试雕和证据回填固化为可审计执行计划。",
    machine: {
      model: machineName,
      camMode: settings.camMode,
      postProcessor: settings.postProcessor,
      axisMapping: axisInstruction,
      rotaryOutputAxis: settings.rotaryOutputAxis ?? postprocessProfile?.coordinateMapping?.rotaryAxis ?? "Y",
      rotaryWrapPerRevolutionMm: Number(settings.rotaryWrapPerRevolutionMm ?? postprocessProfile?.machine?.rotaryWrapPerRevolutionMm ?? 0),
      safeZ: Number(settings.safeZ ?? 0)
    },
    tool: {
      profileId: settings.toolProfileId,
      name: toolSetupSheet?.tool?.name ?? null,
      diameterMm: Number(settings.toolDiameter ?? toolSetupSheet?.tool?.diameterMm ?? 0),
      angleDeg: toolSetupSheet?.tool?.angleDeg ?? null,
      flatTipMm: toolSetupSheet?.tool?.flatTipMm ?? null,
      maxCutDepthMm: Number(settings.maxCutDepth ?? 0),
      feedRateMmMin: Number(settings.feedRate ?? 0),
      spindleRpm: Number(settings.spindleRpm ?? 0)
    },
    gate: {
      packageLevel: productionGate?.level ?? "unknown",
      allowAirRun: airRunAllowed,
      allowTrialNc: trialNcAllowed,
      allowProductionNc: Boolean(productionGate?.allowProductionNc),
      summary: productionGate?.summary ?? null,
      blockers: productionGate?.blockers ?? [],
      warnings: productionGate?.warnings ?? []
    },
    steps: [
      {
        id: "read-and-verify",
        title: "阅读并核验下载包",
        status: "required",
        files: ["safe-trial-execution-plan.json", "operator-runbook.md", "operator-download-checklist.md", "package-integrity.json", "production-gate.json"],
        passCriteria: [
          "确认 production-gate.json 仍为 trial-only 或 production-ready 的真实状态。",
          "确认 package-integrity.json 中 requiredHashFiles 的 SHA-256 与本地下载文件一致。",
          "确认 camotics-preview.nc 没有进入上机文件清单。"
        ]
      },
      {
        id: "rotary-calibration-airrun",
        title: "旋转夹具标定空跑",
        status: airRunAllowed ? "ready" : "blocked",
        files: ["rotary-calibration-airrun.nc", "rotary-calibration-sheet.json"],
        passCriteria: [
          "主轴关闭，Z 始终保持安全高度。",
          "Y 轴带动夹具按 90/180/360 度等效距离运动，方向与实机一致。",
          "夹持端、尾座和刀具无干涉。"
        ]
      },
      {
        id: "full-air-run",
        title: "整条刀路离料空跑",
        status: airRunAllowed ? "ready" : "blocked",
        files: ["air-run.nc", "machine-controller-profile.json", "postprocess-trace-report.json"],
        passCriteria: [
          `确认 ${axisInstruction} 与机床接线一致。`,
          "整条程序没有越程、突然下扎、夹具干涉或反向旋转。"
        ]
      },
      {
        id: "soft-material-trial",
        title: "软料/废料低风险试雕",
        status: trialNcAllowed ? "trial-ready" : "locked",
        files: trialNcAllowed ? ["toolpath.nc", "tool-setup-sheet.json", "nc-static-analysis.json"] : ["tool-setup-sheet.json", "nc-static-analysis.json"],
        passCriteria: trialNcAllowed
          ? ["首次进给倍率建议 30%-50%。", "确认深浅、方向、端部夹持区和表面刀痕可接受。"]
          : ["当前 toolpath.nc 未进入安全试雕包，只能完成空跑、标定和报告复核。"]
      },
      {
        id: "feedback-and-acceptance",
        title: "回填试雕反馈与机床验收",
        status: "required",
        files: ["trial-feedback-template.json", "machine-acceptance-checklist.json"],
        passCriteria: [
          "试雕反馈必须绑定当前 package-integrity.json 的关键文件哈希。",
          "机床验收必须通过 verify-download-integrity、rotary-calibration-airrun、air-run 和 soft-material-trial 必需项。",
          "未完成回填前，生产 NC 保持锁定。"
        ]
      }
    ],
    requiredHashFiles,
    filePolicy: {
      allowedOnMachine: [
        ...(trialNcAllowed ? ["toolpath.nc"] : []),
        "air-run.nc",
        "rotary-calibration-airrun.nc"
      ],
      neverRunOnMachine: ["camotics-preview.nc", "camotics-cli-run-package.json", "camotics-linux-run.sh", "camotics-result-template.json", "camotics-result-validate.js", "camotics-linux-operator-checklist.md"],
      reportsOnly: ["operator-runbook.md", "operator-download-checklist.md", "production-gate.json", "production-evidence-dossier.json", "machine-acceptance-checklist.json", "trial-feedback-template.json"]
    },
    evidenceBinding: {
      packageIntegrity: "package-integrity.json",
      trialFeedback: "trial-feedback-log.json",
      machineAcceptance: "machine-acceptance-log.json",
      productionEvidenceDossier: "production-evidence-dossier.json",
      currentDossierStatus: productionEvidenceDossier?.status ?? null,
      currentDossierSummary: productionEvidenceDossier?.summary ?? null
    },
    nextActions: trialNcAllowed
      ? ["下载安全试雕包并核验哈希。", "先运行旋转标定空跑，再运行整条离料空跑。", "低倍率软料试雕后回填试雕反馈和机床验收。"]
      : ["下载安全试雕包并核验哈希。", "当前只允许旋转标定空跑和整条离料空跑。", "补齐阻断项后重新生成 V3 小闭环。"]
  };
}

function createNextActionChecklistMarkdown({ job, productionGate, productionUnlockMatrix, productionEvidenceDossier, safeTrialExecutionPlan, postprocessProfile, machineControllerProfile }) {
  const axisInstruction = createOperatorAxisInstruction(postprocessProfile);
  const blockedRows = Array.isArray(productionUnlockMatrix?.rows)
    ? productionUnlockMatrix.rows.filter((row) => row.status === "block" || row.blocksProduction)
    : [];
  const reviewRows = Array.isArray(productionUnlockMatrix?.rows)
    ? productionUnlockMatrix.rows.filter((row) => row.status === "review" || row.status === "warning")
    : [];
  const dossierItems = Array.isArray(productionEvidenceDossier?.evidenceItems)
    ? productionEvidenceDossier.evidenceItems.filter((item) => item.status !== "pass")
    : [];
  const allowedFiles = safeTrialExecutionPlan?.filePolicy?.allowedOnMachine ?? ["air-run.nc", "rotary-calibration-airrun.nc"];
  const neverFiles = safeTrialExecutionPlan?.filePolicy?.neverRunOnMachine ?? ["camotics-preview.nc"];
  const nextActions = safeTrialExecutionPlan?.nextActions ?? [];
  const machineName = machineControllerProfile?.name ?? "三轴控制器 + Y轴旋转夹具";
  const gateLevel = productionGate?.level ?? "unknown";
  const productionAllowed = Boolean(productionGate?.allowProductionNc);
  const trialAllowed = Boolean(productionGate?.allowTrialNc);
  const lines = [
    "# HeDiao3D V3 下一步行动清单",
    "",
    `任务: ${job.id}`,
    `生成时间: ${new Date().toISOString()}`,
    `当前级别: ${gateLevel}`,
    `机床: ${machineName}`,
    `轴映射: ${axisInstruction}`,
    "",
    "## 证据状态",
    "",
    `- 生产门禁: ${productionGate?.level ?? "missing"} / ${productionGate?.summary ?? "未生成"}`,
    `- 仿真证据: ${productionGate?.simulationEvidence?.level ?? "missing"} / ${productionGate?.simulationEvidence?.summary ?? "未生成"}`,
    `- 解锁矩阵: 通过 ${productionUnlockMatrix?.passCount ?? "-"} / 复核 ${productionUnlockMatrix?.reviewCount ?? "-"} / 阻断 ${productionUnlockMatrix?.blockCount ?? "-"}`,
    `- 证据档案: ${productionEvidenceDossier?.status ?? "missing"} / ${productionEvidenceDossier?.summary ?? "未生成"}`,
    "",
    "## 当前结论",
    "",
    productionAllowed
      ? "- [ ] 已允许正式生产包下载；正式上机前仍要核验 package-integrity.json、生产门禁和现场验收记录。"
      : trialAllowed
        ? "- [ ] 当前只进入安全试雕阶段；toolpath.nc 只能低倍率试雕，不能当成成品生产 NC。"
        : "- [ ] 当前只适合空跑、旋转标定和报告复核；toolpath.nc 不应上机切削。",
    `- [ ] 生产门禁摘要: ${productionGate?.summary ?? "未生成"}`,
    "",
    "## 立即执行",
    "",
    ...(nextActions.length ? nextActions.map((item) => `- [ ] ${item}`) : ["- [ ] 重新生成 V3 小闭环，确认安全试雕数据和交付清单存在。"]),
    "",
    "## 允许上机文件",
    "",
    ...allowedFiles.map((filename) => `- ${filename}`),
    "",
    "## 禁止上机文件",
    "",
    ...neverFiles.map((filename) => `- ${filename}`),
    "",
    "## 正式生产仍需补齐",
    "",
    ...(productionAllowed
      ? ["- 当前 production-gate 已放行，但仍应保留空跑、试雕、验收和哈希核验记录。"]
      : [
        ...((productionGate?.blockers ?? []).slice(0, 8).map((item) => `- 阻断: ${item}`)),
        ...((productionGate?.warnings ?? []).slice(0, 8).map((item) => `- 复核: ${item}`)),
        ...(blockedRows.slice(0, 8).map((row) => `- 矩阵阻断: ${row.label ?? row.id} / ${row.summary ?? row.status}`)),
        ...(reviewRows.slice(0, 6).map((row) => `- 矩阵复核: ${row.label ?? row.id} / ${row.summary ?? row.status}`)),
        ...(dossierItems.slice(0, 8).map((item) => `- 证据缺口: ${item.label ?? item.id} / ${item.summary ?? item.status}`))
      ]),
    "",
    "## 操作提醒",
    "",
    "- [ ] 先核验 operator-download-checklist.md 和 package-integrity.json 中的 SHA-256。",
    "- [ ] 先跑 rotary-calibration-airrun.nc，再跑 air-run.nc。",
    "- [ ] 首次切削只用软料/废料，进给倍率建议 30%-50%。",
    "- [ ] 试雕后回填 trial-feedback-template.json 和 machine-acceptance-checklist.json。",
    "- [ ] 未完成真实 CAM、CAMotics 材料去除仿真、试雕反馈和机床验收前，不解锁正式生产 NC。",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function createTrialFeedbackTemplate({ job, settings, toolpath, productionGate, postprocessProfile, toolSetupSheet, rotaryCalibrationSheet, machineAcceptanceChecklist }) {
  const issueOptions = ["过切", "欠切", "毛刺", "断刀", "端部残料", "夹持痕迹", "纹理丢失", "旋转错位", "耗时异常", "刀路停顿"];
  return {
    schema: "hediao3d.trial-feedback-template.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    purpose: "现场空跑/试雕后回填，用于校准进给、切深、旋转标定和后续 CAM 参数。",
    sourceFiles: {
      operatorRunbook: "operator-runbook.md",
      productionGate: "production-gate.json",
      toolSetup: "tool-setup-sheet.json",
      rotaryCalibration: "rotary-calibration-sheet.json",
      machineAcceptance: "machine-acceptance-checklist.json"
    },
    context: {
      camMode: postprocessProfile.camMode,
      postProcessorName: postprocessProfile.postProcessorName,
      lengthMm: Number(settings.lengthMm ?? 0),
      diameterMm: Number(settings.diameterMm ?? 0),
      estimatedMinutes: Number(toolpath.estimatedMinutes ?? 0),
      pointCount: toolpath.points?.length ?? 0,
      allowAirRun: productionGate.allowAirRun,
      allowTrialNc: productionGate.allowTrialNc,
      allowProductionNc: productionGate.allowProductionNc
    },
    tool: {
      name: toolSetupSheet.tool.name,
      diameterMm: toolSetupSheet.tool.diameterMm,
      angleDeg: toolSetupSheet.tool.angleDeg,
      flatTipMm: toolSetupSheet.tool.flatTipMm,
      feedRateMmMin: toolSetupSheet.cutting.feedRateMmMin,
      spindleRpm: toolSetupSheet.cutting.spindleRpm,
      maxCutDepthMm: toolSetupSheet.cutting.maxCutDepthMm,
      stepoverMm: toolSetupSheet.cutting.stepoverMm
    },
    rotary: {
      axis: rotaryCalibrationSheet.axisMapping?.rotaryAxis ?? null,
      wrapPerRevolutionMm: rotaryCalibrationSheet.axisMapping?.rotaryWrapPerRevolutionMm ?? null,
      degPerLinearMm: rotaryCalibrationSheet.axisMapping?.rotaryDegPerLinearMm ?? null
    },
    feedbackFields: {
      outcome: "success | review | failed",
      operator: "",
      machineSerial: "",
      materialBatch: "",
      airRunOk: false,
      trialRunOk: false,
      actualMinutes: null,
      measuredMaxDepthMm: null,
      measuredWrapPerRevolutionMm: null,
      feedOverridePercent: null,
      spindleOverridePercent: null,
      issues: [],
      notes: "",
      photoNames: []
    },
    issueOptions,
    acceptanceSteps: (machineAcceptanceChecklist.steps ?? []).map((step) => ({
      id: step.id,
      title: step.title,
      status: "unchecked",
      expectedEvidence: step.expectedEvidence,
      notes: ""
    })),
    suggestedParameterAdjustments: [
      {
        condition: "出现过切或刀具颤动",
        action: "降低 feedRate 或 maxCutDepth，优先降低 20%-40%。"
      },
      {
        condition: "出现欠切或细节浅",
        action: "检查 Z 零点、刀尖磨损和模型缩放，再微调 depthMm。"
      },
      {
        condition: "出现旋转错位或左右颠倒",
        action: "复核 rotaryWrapPerRevolutionMm、旋转方向和 meshAxisReverse。"
      },
      {
        condition: "耗时明显偏离估算",
        action: "把 actualMinutes 回填到反馈页，用于后续报价和工艺模板校准。"
      }
    ]
  };
}

function createMachineAcceptanceChecklist({ job, settings, toolpath, productionGate, postprocessProfile, simulationSummary, ncStaticAnalysis, machineControllerProfile, controllerDialectReport }) {
  const estimatedMinutes = Number(toolpath.estimatedMinutes ?? 0);
  const rotaryAxis = machineControllerProfile?.axisMapping?.rotaryAxis ?? postprocessProfile.coordinateMapping?.rotaryAxis ?? settings.rotaryOutputAxis ?? null;
  const lengthAxis = machineControllerProfile?.axisMapping?.lengthAxis ?? postprocessProfile.coordinateMapping?.lengthAxis ?? "X";
  const depthAxis = machineControllerProfile?.axisMapping?.depthAxis ?? postprocessProfile.coordinateMapping?.depthAxis ?? "Z";
  const trialAllowed = productionGate.allowTrialNc;
  const productionAllowed = productionGate.allowProductionNc;
  const airRunAllowed = productionGate.allowAirRun;
  const unresolvedRisks = dedupeStrings([
    ...(productionGate.blockers ?? []),
    ...(productionGate.warnings ?? []),
    ...(ncStaticAnalysis?.warningIssues ?? []),
    ...(controllerDialectReport?.warningIssues ?? [])
  ]).slice(0, 12);
  const steps = [
    {
      id: "read-package",
      title: "阅读加工包和门禁报告",
      required: true,
      status: "required",
      file: "machining-package-index.json",
      expectedEvidence: "操作员确认 production-gate.json、machine-controller-profile.json、postprocess-profile.json 均与当前机床一致。",
      blocksProduction: true
    },
    {
      id: "verify-download-integrity",
      title: "核验下载包 SHA-256 和文件用途",
      required: true,
      status: "required",
      file: "operator-download-checklist.md",
      expectedEvidence: "按 operator-download-checklist.md 和 package-integrity.json 核对 toolpath.nc、air-run.nc、rotary-calibration-airrun.nc 的 SHA-256，并确认 camotics-preview.nc 等仿真/报告文件不会上机运行。",
      blocksProduction: true
    },
    {
      id: "camotics-preview",
      title: "执行 CAMotics/展开预览复核",
      required: true,
      status: productionGate.simulationEvidence?.productionUnlockEligible ? "passed-by-evidence" : "required",
      file: "camotics-preview.nc",
      expectedEvidence: "确认展开刀路没有越界、Z 最小值和材料去除结果可接受；camotics-preview.nc 不可上机。",
      blocksProduction: !productionGate.simulationEvidence?.productionUnlockEligible
    },
    {
      id: "rotary-calibration-airrun",
      title: "执行旋转夹具标定空跑",
      required: true,
      status: airRunAllowed ? "ready" : "blocked",
      file: "rotary-calibration-airrun.nc",
      expectedEvidence: `主轴关闭，${depthAxis} 保持安全高度，确认 ${rotaryAxis ?? "旋转夹具"} 90/180/360 度方向、每圈等效距离和反向间隙。`,
      blocksProduction: !airRunAllowed
    },
    {
      id: "air-run",
      title: "执行整条刀路离料空跑",
      required: true,
      status: airRunAllowed ? "ready" : "blocked",
      file: "air-run.nc",
      expectedEvidence: `主轴关闭，${depthAxis} 保持安全高度，确认 ${lengthAxis}/${rotaryAxis ?? "旋转夹具"}/${depthAxis} 方向和行程无碰撞。`,
      blocksProduction: !airRunAllowed
    },
    {
      id: "soft-material-trial",
      title: "软材料或废料低进给试雕",
      required: true,
      status: trialAllowed ? "ready" : "blocked",
      file: trialAllowed ? "toolpath.nc" : null,
      expectedEvidence: "记录实际切深、夹具旋转方向、刀痕、耗时和异常停机情况；首刀建议降低进给倍率。",
      blocksProduction: !trialAllowed
    },
    {
      id: "formal-trial",
      title: "正式核胚试雕确认",
      required: productionAllowed,
      status: productionAllowed ? "ready" : "locked",
      file: productionAllowed ? "toolpath.nc" : null,
      expectedEvidence: "仅在外部 CAM、真实材料去除仿真、NC 静态分析和控制器方言均通过后执行。",
      blocksProduction: !productionAllowed
    }
  ];

  return {
    schema: "hediao3d.machine-acceptance-checklist.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    summary: productionAllowed
      ? "生产门禁已通过；仍需操作员按清单完成机床现场验收。"
      : trialAllowed
        ? "当前允许离料空跑和小料试雕；生产 NC 仍锁定。"
        : airRunAllowed
          ? "当前仅允许离料空跑；试雕和生产 NC 未解锁。"
          : "当前仅可查看报告，不建议上机。",
    machine: {
      profileId: machineControllerProfile?.id ?? null,
      name: machineControllerProfile?.name ?? null,
      controllerClass: machineControllerProfile?.controllerClass ?? null,
      lengthAxis,
      depthAxis,
      rotaryAxis,
      rotaryWrapPerRevolutionMm: machineControllerProfile?.rotary?.wrapPerRevolutionMm ?? postprocessProfile.machine?.rotaryWrapPerRevolutionMm ?? null
    },
    programs: {
      airRun: airRunAllowed ? "air-run.nc" : null,
      trial: trialAllowed ? "toolpath.nc" : null,
      production: productionAllowed ? "toolpath.nc" : null,
      simulationOnly: "camotics-preview.nc"
    },
    gates: {
      allowAirRun: airRunAllowed,
      allowTrialNc: trialAllowed,
      allowProductionNc: productionAllowed,
      simulationEvidenceLevel: productionGate.simulationEvidence?.level ?? null,
      ncStaticAnalysisLevel: ncStaticAnalysis?.level ?? null,
      controllerDialectLevel: controllerDialectReport?.level ?? null
    },
    metrics: {
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes,
      fitRate: simulationSummary?.metrics?.fitRate ?? null,
      missCount: simulationSummary?.metrics?.missCount ?? null
    },
    steps,
    unresolvedRisks,
    operatorRecordTemplate: {
      operator: "",
      machineSerial: "",
      fixtureType: "三轴控制器 + 旋转轴夹具",
      materialBatch: "",
      toolMeasuredDiameterMm: settings.toolDiameter ?? null,
      airRunAt: "",
      softTrialAt: "",
      formalTrialAt: "",
      notes: ""
    }
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
      rotaryCalibrationAirRunNc: "rotary-calibration-airrun.nc",
      productionGate: "production-gate.json",
      simulationSummary: "simulation-summary.json"
    },
    safetyNotes: [
      "先运行 rotary-calibration-airrun.nc 做旋转夹具标定空跑，确认每圈等效距离、方向和反向间隙。",
      "再运行 air-run.nc 做整条刀路离料空跑，确认长度轴、旋转轴和 Z 方向。",
      "当前 packageLevel 不是 production 时，只建议小料试雕，不建议直接正式上机。",
      "若机床把旋转夹具接到 Y 轴，请确认控制器每转一圈等效距离与 rotaryWrapPerRevolutionMm 一致。"
    ]
  };
}

function createPostprocessTraceReport({ job, settings, toolpath, machineGcode, machineControllerProfile }) {
  const postProcessor = settings.postProcessor ?? "generic";
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? String(settings.rotaryOutputAxis || (postProcessor === "wrapX" ? "X" : postProcessor === "wrapY" ? "Y" : "A")).toUpperCase()
    : null;
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const lengthAxis = settings.camMode === "rotaryWrap" && rotaryAxis === "X" ? "Y" : "X";
  const sourcePoints = Array.isArray(toolpath.points) ? toolpath.points : [];
  const machineMoves = extractMachineCuttingMovesForTrace(machineGcode, settings, { rotaryAxis, lengthAxis });
  const compareCount = Math.min(sourcePoints.length, machineMoves.length);
  const tolerances = {
    lengthMm: 0.01,
    rotaryLinearMm: 0.01,
    rotaryDeg: 0.05,
    zMm: 0.01
  };
  const mismatches = [];
  const maxAbs = {
    lengthMm: 0,
    rotaryMachine: 0,
    rotaryDeg: 0,
    zMm: 0
  };
  let matched = 0;

  for (let index = 0; index < compareCount; index += 1) {
    const source = sourcePoints[index] ?? {};
    const move = machineMoves[index] ?? {};
    const expected = expectedMachineTracePoint(source, settings, { rotaryAxis, lengthAxis, wrapPerRev });
    const deltas = {
      lengthMm: absDelta(move[lengthAxis.toLowerCase()], expected[lengthAxis.toLowerCase()]),
      zMm: absDelta(move.z, expected.z),
      rotaryMachine: rotaryAxis ? absDelta(move[rotaryAxis.toLowerCase()], expected[rotaryAxis.toLowerCase()]) : 0,
      rotaryDeg: settings.camMode === "rotaryWrap" ? absDelta(source.a, move.rotaryDeg) : 0
    };
    maxAbs.lengthMm = Math.max(maxAbs.lengthMm, deltas.lengthMm);
    maxAbs.zMm = Math.max(maxAbs.zMm, deltas.zMm);
    maxAbs.rotaryMachine = Math.max(maxAbs.rotaryMachine, deltas.rotaryMachine);
    maxAbs.rotaryDeg = Math.max(maxAbs.rotaryDeg, deltas.rotaryDeg);
    const rotaryTolerance = rotaryAxis === "A" ? tolerances.rotaryDeg : tolerances.rotaryLinearMm;
    const ok = deltas.lengthMm <= tolerances.lengthMm
      && deltas.zMm <= tolerances.zMm
      && deltas.rotaryMachine <= rotaryTolerance
      && (settings.camMode !== "rotaryWrap" || deltas.rotaryDeg <= tolerances.rotaryDeg);
    if (ok) {
      matched += 1;
    } else if (mismatches.length < 20) {
      mismatches.push({
        index,
        source: compactTracePoint(source),
        expected: compactTracePoint(expected),
        actual: compactTracePoint(move),
        deltas
      });
    }
  }

  const missingMoves = Math.max(0, sourcePoints.length - machineMoves.length);
  const extraMoves = Math.max(0, machineMoves.length - sourcePoints.length);
  const fitRate = sourcePoints.length > 0 ? matched / sourcePoints.length : 0;
  const criticalIssues = [];
  const warningIssues = [];
  if (sourcePoints.length <= 0) criticalIssues.push("源刀路点为空，无法追溯后处理输出。");
  if (machineMoves.length <= 0) criticalIssues.push("机床 NC 中没有可追溯的切削运动。");
  if (missingMoves > 0 || extraMoves > 0) criticalIssues.push(`源点与机床切削运动数量不一致：source=${sourcePoints.length}，machine=${machineMoves.length}。`);
  if (fitRate < 0.995) criticalIssues.push(`后处理点位匹配率 ${(fitRate * 100).toFixed(2)}% 低于 99.5%。`);
  if (maxAbs.lengthMm > tolerances.lengthMm) criticalIssues.push(`长度轴最大偏差 ${maxAbs.lengthMm.toFixed(4)}mm 超过 ${tolerances.lengthMm}mm。`);
  if (maxAbs.zMm > tolerances.zMm) criticalIssues.push(`Z轴最大偏差 ${maxAbs.zMm.toFixed(4)}mm 超过 ${tolerances.zMm}mm。`);
  if (settings.camMode === "rotaryWrap" && rotaryAxis !== "A" && maxAbs.rotaryMachine > tolerances.rotaryLinearMm) criticalIssues.push(`旋转线性化轴最大偏差 ${maxAbs.rotaryMachine.toFixed(4)}mm 超过 ${tolerances.rotaryLinearMm}mm。`);
  if (settings.camMode === "rotaryWrap" && rotaryAxis === "A" && maxAbs.rotaryMachine > tolerances.rotaryDeg) criticalIssues.push(`A轴角度最大偏差 ${maxAbs.rotaryMachine.toFixed(4)}deg 超过 ${tolerances.rotaryDeg}deg。`);
  if (settings.camMode === "rotaryWrap" && maxAbs.rotaryDeg > tolerances.rotaryDeg) criticalIssues.push(`回算旋转角最大偏差 ${maxAbs.rotaryDeg.toFixed(4)}deg 超过 ${tolerances.rotaryDeg}deg。`);
  if (machineControllerProfile?.axisMapping?.rotaryAxis && rotaryAxis && machineControllerProfile.axisMapping.rotaryAxis !== rotaryAxis) {
    criticalIssues.push(`机床配置旋转轴 ${machineControllerProfile.axisMapping.rotaryAxis} 与后处理旋转轴 ${rotaryAxis} 不一致。`);
  }
  if (fitRate < 1 && fitRate >= 0.995) warningIssues.push("后处理存在少量小偏差，请查看 mismatches 抽样。");

  const level = criticalIssues.length > 0 ? "critical" : warningIssues.length > 0 ? "review" : "ready";
  return {
    schema: "hediao3d.postprocess-trace-report.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    level,
    camMode: settings.camMode,
    postProcessor: settings.postProcessor,
    postProcessorName: toolpath.postProcessorName ?? postProcessorName(settings.postProcessor),
    source: {
      pointCount: sourcePoints.length,
      toolpathSha256: createHash("sha256").update(JSON.stringify(sourcePoints)).digest("hex")
    },
    machineNc: {
      filename: "toolpath.nc",
      cuttingMoveCount: machineMoves.length,
      sha256: createHash("sha256").update(String(machineGcode ?? ""), "utf8").digest("hex")
    },
    coordinateMapping: {
      lengthAxis,
      depthAxis: "Z",
      rotaryAxis,
      rotaryWrapPerRevolutionMm: settings.camMode === "rotaryWrap" ? wrapPerRev : null,
      rotaryOutputMode: settings.camMode === "rotaryWrap"
        ? rotaryAxis === "A" ? "degree-axis" : "linearized-rotary-axis"
        : "plain-3axis"
    },
    tolerances,
    metrics: {
      compared: compareCount,
      matched,
      fitRate,
      missingMoves,
      extraMoves,
      maxAbs
    },
    mismatches,
    criticalIssues,
    warningIssues,
    summary: level === "ready"
      ? "后处理追溯通过：机床 NC 切削运动与源刀路点一致。"
      : level === "critical"
        ? `后处理追溯发现 ${criticalIssues.length} 个阻断项。`
        : `后处理追溯发现 ${warningIssues.length} 个复核项。`
  };
}

function extractMachineCuttingMovesForTrace(gcode, settings, mapping) {
  const lines = String(gcode ?? "").split(/\r?\n/);
  const state = { x: NaN, y: NaN, z: NaN, a: NaN };
  const moves = [];
  const lengthWord = mapping.lengthAxis ?? "X";
  const rotaryWord = settings.camMode === "rotaryWrap" ? mapping.rotaryAxis : null;
  for (const rawLine of lines) {
    const upper = rawLine.toUpperCase();
    const x = parseGcodeWord(upper, "X");
    const y = parseGcodeWord(upper, "Y");
    const z = parseGcodeWord(upper, "Z");
    const a = parseGcodeWord(upper, "A");
    if (Number.isFinite(x)) state.x = x;
    if (Number.isFinite(y)) state.y = y;
    if (Number.isFinite(z)) state.z = z;
    if (Number.isFinite(a)) state.a = a;
    if (!/\bG0?1\b/.test(upper)) continue;
    const hasLengthWord = new RegExp(`\\b${lengthWord}\\s*-?\\d`, "i").test(rawLine);
    const hasRotaryWord = !rotaryWord || new RegExp(`\\b${rotaryWord}\\s*-?\\d`, "i").test(rawLine);
    const hasPlanarWord = settings.camMode === "3axis" ? /\b[XY]\s*-?\d/i.test(rawLine) : true;
    if (!hasLengthWord || !hasRotaryWord || !hasPlanarWord) continue;
    if (!Number.isFinite(state.z)) continue;
    const move = { ...state, line: rawLine.trim() };
    if (settings.camMode === "rotaryWrap" && rotaryWord) {
      move.rotaryDeg = rotaryWord === "A"
        ? state.a
        : ((state[rotaryWord.toLowerCase()] / Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100))) * 360);
    }
    moves.push(move);
  }
  return moves;
}

function expectedMachineTracePoint(point, settings, mapping) {
  const expected = { x: NaN, y: NaN, z: Number(point.z ?? 0), a: NaN };
  if (settings.camMode === "rotaryWrap") {
    const rotaryMachine = mapping.rotaryAxis === "A"
      ? Number(point.a ?? 0)
      : (Number(point.a ?? 0) / 360) * mapping.wrapPerRev;
    expected[mapping.lengthAxis.toLowerCase()] = Number(point.x ?? 0);
    expected[mapping.rotaryAxis.toLowerCase()] = rotaryMachine;
    expected.rotaryDeg = Number(point.a ?? 0);
    return expected;
  }
  expected.x = Number(point.x ?? 0);
  expected.y = Number(point.y ?? 0);
  return expected;
}

function absDelta(actual, expected) {
  const a = Number(actual);
  const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b);
}

function compactTracePoint(point) {
  const result = {};
  for (const key of ["x", "y", "z", "a", "rotaryDeg", "depth"]) {
    const value = Number(point?.[key]);
    if (Number.isFinite(value)) result[key] = Number(value.toFixed(6));
  }
  return result;
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
    id: settings.machineProfileId ?? (settings.camMode === "rotaryWrap" ? "desktop-3axis-rotary-y" : "desktop-3axis-relief"),
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

function createCamoticsCliExecutionPlan(job, camoticsInput, camoticsSimulationPlan, settings) {
  const preferredGcode = camoticsSimulationPlan.inputs?.preferredGcode ?? "camotics-preview.nc";
  return {
    schema: "hediao3d.camotics-cli-execution-plan.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    status: camoticsInput.compatibility.canRunInCamotics ? "ready-for-linux-validation" : "review-required",
    purpose: "在 Linux CAM 服务器上执行真实 CAMotics/等效材料去除仿真，并生成可回填的 camotics-result.json。",
    inputs: {
      preferredGcode,
      projectTemplate: "camotics-project-template.json",
      simulationPlan: "camotics-simulation-plan.json",
      machineGcodeReferenceOnly: "toolpath.nc",
      airRunReferenceOnly: "air-run.nc"
    },
    commandCandidates: [
      {
        id: "open-project",
        command: "camotics camotics-project-template.json",
        purpose: "人工打开项目模板，检查展开毛坯、刀具和预览刀路。"
      },
      {
        id: "open-gcode",
        command: `camotics ${preferredGcode}`,
        purpose: "人工打开展开三轴预览 NC。"
      },
      {
        id: "cli-wrapper",
        command: "HEDIAO3D_CAMOTICS_RESULT_JSON=/absolute/path/to/camotics-result.json HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true node adapters/camotics/camotics_job.js camotics-job.json camotics-adapter-report.json",
        purpose: "由经过验证的外部包装脚本生成 camotics-result.json 后，让 HeDiao3D adapter 摄取并校验证据。"
      }
    ],
    expectedOutputs: {
      resultJson: "camotics-result.json",
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    },
    resultContract: {
      schema: "hediao3d.camotics-result.v1",
      requiredFields: [
        "status=completed",
        "synthetic=false",
        "riskLevel=ready",
        "inputs.preferredGcodeSha256",
        "metrics.motionLineCount",
        "metrics.zMin",
        "metrics.zMax",
        "metrics.materialRemovedMm3",
        "artifacts.screenshot or artifacts.materialMesh"
      ],
      verification: [
        "inputs.preferredGcodeSha256 必须匹配当前 camotics-preview.nc 的 SHA-256。",
        "metrics.motionLineCount 和 Z 范围必须匹配 camotics-preview.nc 的运动画像。",
        "截图或材料去除 STL 必须复制进加工包并生成 SHA-256。",
        "synthetic 或 fixture 结果不能作为生产证据。"
      ]
    },
    safetyLocks: {
      productionUnlockFromCliPlan: false,
      forbiddenProductionEnv: [
        "HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT=true"
      ],
      requiredBeforeProduction: [
        "导入非 synthetic camotics-result.json",
        "通过 motionProfile/inputIdentity/artifactEvidence 校验",
        "完成 rotary-calibration-airrun.nc 和 air-run.nc 离料空跑",
        "完成机床验收和试雕反馈"
      ]
    },
    coordinateInterpretation: camoticsSimulationPlan.coordinateInterpretation,
    stock: camoticsSimulationPlan.stock,
    tool: camoticsSimulationPlan.tool,
    notes: [
      "camotics-preview.nc 是展开三轴仿真文件，禁止上机。",
      "toolpath.nc 是目标机床后处理文件，不能直接等同于 CAMotics 三轴材料去除结论。",
      settings.camMode === "rotaryWrap"
        ? "Y/A 旋转夹具真实圆柱材料去除仍需结合旋转包裹预览报告和现场空跑。"
        : "三轴模式仍需核对机床控制器方言和空跑结果。"
    ]
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

function createMachiningPackageIndex({ job, toolpath, productionGate, postprocessProfile, simulationSummary, camoticsInput, camoticsSimulationPlan, camoticsCliExecutionPlan, rotaryWrapPreviewReport, camHandoffQuality, postprocessTraceReport, camServerConfig, productionEvidenceDossier, ncStaticAnalysis, nativeCamReadiness, camEngineSelection, openSourceCamExecutionPlan, machineControllerProfile, machineAcceptanceChecklist, controllerDialectReport, deliveryManifest }) {
  const fileByName = new Map(deliveryManifest.files.map((file) => [file.filename, file]));
  const getFile = (filename) => fileByName.get(filename) ?? createDeliveryFile(job.id, filename, filename, "unknown", false, "未列入交付清单。");
  const externalGcodeImportValidation = readJsonFile(join(job.workDir, "external-gcode-import-validation.json"));
  const productionCandidate = productionGate.allowProductionNc ? "toolpath.nc" : null;
  const trialCandidate = productionGate.allowTrialNc ? "toolpath.nc" : null;
  const camoticsIdentity = summarizeCamoticsEvidenceIdentity(productionGate.simulationEvidence ?? createSimulationEvidence(simulationSummary));
  const axisInstruction = createOperatorAxisInstruction(postprocessProfile);

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
        getFile("production-unlock-matrix.json"),
        getFile("production-evidence-dossier.json"),
        getFile("cam-handoff-quality.json"),
        getFile("cam-handoff-evidence.md"),
        getFile("rotary-wrap-preview-report.json"),
        getFile("postprocess-trace-report.json"),
        getFile("nc-static-analysis.json"),
        getFile("machine-controller-profile.json"),
        getFile("next-action-checklist.md"),
        getFile("operator-runbook.md"),
        getFile("safe-trial-execution-plan.json"),
        getFile("trial-feedback-template.json"),
        getFile("tool-setup-sheet.json"),
        getFile("rotary-calibration-sheet.json"),
        getFile("machine-acceptance-checklist.json"),
        getFile("controller-dialect-report.json"),
        getFile("native-cam-readiness.json"),
        getFile("cam-server-config.json"),
        getFile("cam-server-prep-checklist.md"),
        getFile("cam-engine-selection.json"),
        getFile("open-source-cam-execution-plan.json"),
        getFile("external-cam-recipe.json"),
        getFile("neutral-toolpath-import-validation.json"),
        getFile("external-gcode-import-validation.json"),
        getFile("postprocess-profile.json"),
        getFile("delivery-manifest.json"),
        getFile("operator-download-checklist.md"),
        getFile("package-integrity.json")
      ],
      reports: deliveryManifest.files.filter((file) => file.kind === "report" && !["machining-package-index.json", "production-gate.json", "rotary-wrap-preview-report.json", "postprocess-trace-report.json", "nc-static-analysis.json", "machine-controller-profile.json", "operator-runbook.md", "controller-dialect-report.json", "native-cam-readiness.json", "cam-server-prep-checklist.md", "cam-handoff-evidence.md", "cam-engine-selection.json", "open-source-cam-execution-plan.json", "postprocess-profile.json", "delivery-manifest.json", "operator-download-checklist.md", "package-integrity.json"].includes(file.filename)),
      camInputs: deliveryManifest.files
        .filter((file) => file.kind === "model")
        .map((file) => ({
          ...file,
          usage: "external-cam-input-candidate"
        })),
      simulationOnly: [
        getFile("camotics-input.json"),
        getFile("camotics-simulation-plan.json"),
        getFile("camotics-project-template.json"),
        getFile("camotics-cli-execution-plan.json"),
        getFile("camotics-cli-run-package.json"),
        getFile("camotics-result-template.json"),
        getFile("camotics-linux-run.sh"),
        getFile("camotics-linux-operator-checklist.md"),
        getFile("camotics-cli-package-report.json"),
        getFile("camotics-adapter-report.json"),
        getFile("camotics-result.json"),
        getFile("camotics-run.md"),
        getFile("camotics-preview.nc"),
        getFile("simulation-summary.json")
      ],
      airRun: [getFile("air-run.nc"), getFile("rotary-calibration-airrun.nc")],
      machineNcCandidates: [
        ...(trialCandidate ? [{ ...getFile(trialCandidate), usage: productionGate.allowProductionNc ? "production-or-trial" : "trial-only" }] : [])
      ],
      neverRunOnMachine: deliveryManifest.files
        .filter((file) => file.machineUse?.allowedOnMachine === false)
        .map((file) => ({
          ...file,
          reason: file.machineUse?.summary ?? "不是可上机文件。"
        }))
    },
    recommendedSequence: [
      "阅读 machining-package-index.json 和 production-gate.json，确认包级别。",
      "先阅读 next-action-checklist.md，只执行当前允许的下一步，未放行的生产 NC 不要上机。",
      "阅读 production-unlock-matrix.json，明确生产 NC 仍差哪些条件。",
      "阅读 rotary-wrap-preview-report.json，确认旋转包裹展开预览、Y/A 后处理和 CAMotics 预览坐标关系。",
      "阅读 postprocess-trace-report.json，确认 toolpath.nc 的 X/Y/A/Z 输出与源刀路点逐点一致。",
      "若使用 FreeCAD/BlenderCAM 外部 G-code，阅读 external-gcode-import-validation.json，确认源 G-code、toolpath.nc 和 CAM proof 已绑定。",
      "先阅读 operator-runbook.md，按操作员说明书执行空跑和试雕。",
      "阅读 safe-trial-execution-plan.json，按四步安全试雕计划执行并保留现场证据。",
      "试雕后填写 trial-feedback-template.json，把真实耗时、刀痕和旋转误差回填到工艺优化流程。",
      "阅读 machine-controller-profile.json，确认当前是目标机床配置，而不是默认保守配置。",
      "阅读 tool-setup-sheet.json，确认实际装刀、进给、转速、切深与 CAM 参数一致。",
      "阅读 rotary-calibration-sheet.json，确认旋转轴方向、每圈距离和反向间隙。",
      "按 machine-acceptance-checklist.json 完成操作员现场验收记录。",
      `阅读 postprocess-profile.json，确认 ${axisInstruction} 与机床接线一致。`,
      "使用 camotics-preview.nc 做展开三轴仿真检查，不要上机运行该文件。",
      "先运行 rotary-calibration-airrun.nc，确认旋转夹具 90/180/360 度方向和每圈等效距离。",
      `再运行 air-run.nc 做整条刀路离料空跑，确认 ${axisInstruction}。`,
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
    camHandoffQuality: camHandoffQuality ? {
      level: camHandoffQuality.level,
      source: camHandoffQuality.source,
      pointCount: camHandoffQuality.metrics?.pointCount ?? 0,
      xCoverage: camHandoffQuality.metrics?.xCoverage ?? null,
      rotaryCoverage: camHandoffQuality.metrics?.rotaryCoverage ?? null,
      summary: camHandoffQuality.summary,
      criticalIssues: camHandoffQuality.criticalIssues ?? [],
      warningIssues: camHandoffQuality.warningIssues ?? []
    } : null,
    externalGcodeImportValidation: externalGcodeImportValidation ? {
      artifact: "external-gcode-import-validation.json",
      status: externalGcodeImportValidation.status,
      productionCandidate: Boolean(externalGcodeImportValidation.productionCandidate),
      postprocessEligible: Boolean(externalGcodeImportValidation.postprocessEligible),
      summary: externalGcodeImportValidation.summary
    } : null,
    rotaryWrapPreview: rotaryWrapPreviewReport ? {
      level: rotaryWrapPreviewReport.level,
      summary: rotaryWrapPreviewReport.summary,
      machineCoverage: rotaryWrapPreviewReport.metrics?.machineCoverage ?? null,
      pointCoverage: rotaryWrapPreviewReport.metrics?.pointCoverage ?? null,
      linearizationErrorRate: rotaryWrapPreviewReport.metrics?.linearizationErrorRate ?? null,
      artifact: "rotary-wrap-preview-report.json"
    } : null,
    postprocessTrace: postprocessTraceReport ? {
      level: postprocessTraceReport.level,
      summary: postprocessTraceReport.summary,
      fitRate: postprocessTraceReport.metrics?.fitRate ?? null,
      matched: postprocessTraceReport.metrics?.matched ?? null,
      compared: postprocessTraceReport.metrics?.compared ?? null,
      missingMoves: postprocessTraceReport.metrics?.missingMoves ?? null,
      extraMoves: postprocessTraceReport.metrics?.extraMoves ?? null,
      artifact: "postprocess-trace-report.json"
    } : null,
    productionEvidenceDossier: productionEvidenceDossier ? {
      status: productionEvidenceDossier.status,
      passedCount: productionEvidenceDossier.passedCount,
      reviewCount: productionEvidenceDossier.reviewCount,
      blockedCount: productionEvidenceDossier.blockedCount,
      summary: productionEvidenceDossier.summary,
      crossChecks: productionEvidenceDossier.crossChecks ?? null,
      artifact: "production-evidence-dossier.json"
    } : null,
    controllerDialect: {
      level: controllerDialectReport?.level ?? "unknown",
      summary: controllerDialectReport?.summary ?? null,
      dialect: controllerDialectReport?.dialect?.name ?? null
    },
    machineAcceptance: machineAcceptanceChecklist ? {
      summary: machineAcceptanceChecklist.summary,
      requiredStepCount: machineAcceptanceChecklist.steps?.filter((step) => step.required).length ?? 0,
      blockedStepCount: machineAcceptanceChecklist.steps?.filter((step) => step.status === "blocked" || step.status === "locked").length ?? 0,
      artifact: "machine-acceptance-checklist.json"
    } : null,
    nativeCamReadiness: nativeCamReadiness ? {
      level: nativeCamReadiness.level,
      readyCount: nativeCamReadiness.readyCount,
      requiredCount: nativeCamReadiness.requiredCount,
      summary: nativeCamReadiness.summary,
      requiredActions: nativeCamReadiness.requiredActions
    } : null,
    camServerConfig: camServerConfig ? {
      status: camServerConfig.status,
      selectedEngine: camServerConfig.selectedEngine,
      nativeCamLevel: camServerConfig.nativeCamLevel,
      missingRequired: camServerConfig.missingRequired,
      artifact: "cam-server-config.json",
      prepChecklist: "cam-server-prep-checklist.md"
    } : null,
    camEngineSelection: camEngineSelection ? {
      selectedEngine: camEngineSelection.selectedEngine,
      selectedEngineName: camEngineSelection.selectedEngineName,
      strategy: camEngineSelection.strategy,
      fallbackUsed: camEngineSelection.fallbackUsed,
      fallbackReason: camEngineSelection.fallbackReason,
      externalAttemptAllowed: camEngineSelection.externalAttemptAllowed,
      requiredNextActions: camEngineSelection.requiredNextActions
    } : null,
    openSourceCamExecutionPlan: openSourceCamExecutionPlan ? {
      schema: openSourceCamExecutionPlan.schema,
      selectedEngine: openSourceCamExecutionPlan.selectedEngine,
      selectedEngineName: openSourceCamExecutionPlan.selectedEngineName,
      readyStageCount: openSourceCamExecutionPlan.readyStageCount,
      totalStageCount: openSourceCamExecutionPlan.totalStageCount,
      selectedStageId: openSourceCamExecutionPlan.selectedStageId,
      selectedStageStatus: openSourceCamExecutionPlan.selectedStageStatus,
      summary: openSourceCamExecutionPlan.summary,
      artifact: "open-source-cam-execution-plan.json"
    } : null,
    neutralToolpathImportValidation: fileByName.has("neutral-toolpath-import-validation.json") ? {
      artifact: "neutral-toolpath-import-validation.json",
      exists: getFile("neutral-toolpath-import-validation.json").exists,
      summary: readJsonFile(join(job.workDir, "neutral-toolpath-import-validation.json"))?.summary ?? null
    } : null,
    simulationEvidence: productionGate.simulationEvidence ?? createSimulationEvidence(simulationSummary),
    camotics: {
      status: camoticsInput.status,
      previewFile: "camotics-preview.nc",
      cliExecutionPlan: camoticsCliExecutionPlan ? {
        status: camoticsCliExecutionPlan.status,
        commandCount: camoticsCliExecutionPlan.commandCandidates?.length ?? 0,
        artifact: "camotics-cli-execution-plan.json"
      } : null,
      cliRunPackage: getFile("camotics-cli-run-package.json")?.exists ? {
        artifact: "camotics-cli-run-package.json",
        resultTemplate: getFile("camotics-result-template.json")?.exists ? "camotics-result-template.json" : null,
        linuxRunScript: getFile("camotics-linux-run.sh")?.exists ? "camotics-linux-run.sh" : null,
        resultValidator: getFile("camotics-result-validate.js")?.exists ? "camotics-result-validate.js" : null,
        operatorChecklist: getFile("camotics-linux-operator-checklist.md")?.exists ? "camotics-linux-operator-checklist.md" : null,
        report: getFile("camotics-cli-package-report.json")?.exists ? "camotics-cli-package-report.json" : null
      } : null,
      compatibility: camoticsInput.compatibility,
      resultFile: fileByName.has("camotics-result.json") ? "camotics-result.json" : null,
      evidenceLevel: productionGate.simulationEvidence?.level ?? null,
      inputIdentityStatus: camoticsIdentity.inputIdentityStatus,
      cliRunPackageBindingStatus: camoticsIdentity.cliRunPackageBindingStatus,
      motionConsistencyStatus: camoticsIdentity.motionConsistencyStatus,
      artifactEvidenceStatus: camoticsIdentity.artifactEvidenceStatus,
      productionUnlockEligible: productionGate.simulationEvidence?.productionUnlockEligible ?? false,
      limitation: "CAMotics 仅用于展开三轴检查；旋转夹具真实材料去除仍需专业仿真或机床控制软件复核。"
    },
    metrics: {
      pointCount: toolpath.points?.length ?? 0,
      estimatedMinutes: toolpath.estimatedMinutes
    }
  };
}

function createDeliveryManifest(job, toolpath, productionGate, repairExecution = null) {
  const files = [
    createDeliveryFile(job.id, "job.json", "任务参数快照", "report", true, "用于复现本次 Orchestrator 输入。"),
    createDeliveryFile(job.id, "job-status.json", "任务状态和日志", "report", true, "用于追踪队列、日志和结果摘要。"),
    createDeliveryFile(job.id, "mesh-quality.json", "Mesh 质量报告", "report", true, "上机前必须查看模型风险。"),
    createDeliveryFile(job.id, "repair-plan.json", "Mesh 修复计划", "report", true, "说明是否需要封孔、降面、重网格。"),
    createDeliveryFile(job.id, "repair-execution.json", "Mesh 修复执行记录", "report", true, "说明是否自动修复、为何跳过以及下一步修复动作。"),
    createDeliveryFile(job.id, "repaired-mesh-quality.json", "修复后 Mesh 质量报告", "report", existsSync(join(job.workDir, "repaired-mesh-quality.json")), "当存在修复产物时，复核 repaired-model.stl 的封闭性、非流形和退化面。"),
    createDeliveryFile(job.id, "cam-input-plan.json", "CAM 输入计划", "report", true, "说明进入外部 CAM 前应使用哪份模型。"),
    createDeliveryFile(job.id, "cam-engine-selection.json", "CAM 引擎选择报告", "report", true, "说明当前为何选择 FreeCAD/BlenderCAM/OpenCAMLib 或降级到内置 fallback。"),
    createDeliveryFile(job.id, "external-cam-recipe.json", "外部CAM作业配方", "report", true, "统一描述 FreeCAD/BlenderCAM/OpenCAMLib 所需模型、毛坯、刀具、工序、后处理和仿真要求。"),
    createDeliveryFile(job.id, "adapter-report.json", "外部 CAM Adapter 报告", "report", existsSync(join(job.workDir, "adapter-report.json")), "记录外部 CAM 或 API 回填中立刀路的执行结果、来源和风险。"),
    createDeliveryFile(job.id, "neutral-toolpath.json", "外部中立刀路", "report", existsSync(join(job.workDir, "neutral-toolpath.json")), "外部 CAM 输出的统一刀位点，HeDiao3D 会在此基础上执行 Y/A 旋转夹具后处理。"),
    createDeliveryFile(job.id, "imported-neutral-toolpath.json", "API导入原始中立刀路", "report", existsSync(join(job.workDir, "imported-neutral-toolpath.json")), "通过 API 回填时保存的原始 neutral-toolpath 输入快照，用于审计和复现。"),
    createDeliveryFile(job.id, "neutral-toolpath-import-validation.json", "中立刀路导入校验", "report", existsSync(join(job.workDir, "neutral-toolpath-import-validation.json")), "导入外部 neutral-toolpath 前的 schema、点位、fixture/synthetic/preview 和坐标安全校验报告。"),
    createDeliveryFile(job.id, "external-gcode-import-validation.json", "外部G-code导入校验", "report", existsSync(join(job.workDir, "external-gcode-import-validation.json")), "校验外部 FreeCAD/BlenderCAM G-code、sourceSnapshot、最终 toolpath.nc 和 CAM proof 的哈希绑定。"),
    createDeliveryFile(job.id, "engine-diagnostics.json", "外部引擎诊断", "report", true, "说明 FreeCAD/BlenderCAM/CAMotics 接入状态。"),
    createDeliveryFile(job.id, "native-cam-readiness.json", "Native CAM 就绪报告", "report", true, "按当前 CAM 模式列出 FreeCAD/BlenderCAM/OpenCAMLib/CAMotics 的缺失项和部署动作。"),
    createDeliveryFile(job.id, "cam-server-config.json", "CAM服务器配置清单", "report", true, "列出外部 CAM/CAMotics adapter 所需环境变量、命令模板、验证命令和 fixture 禁用策略。"),
    createDeliveryFile(job.id, "cam-server-prep-checklist.md", "CAM服务器准备清单", "report", true, "绑定本次 job 的 Linux CAM 服务端安装、验证命令、必关开关和生产边界。"),
    createDeliveryFile(job.id, "open-source-cam-execution-plan.json", "开源CAM执行计划", "report", true, "绑定本次任务的 FreeCAD/BlenderCAM/OpenCAMLib/CAMotics 输入、输出、验收命令和生产边界。"),
    createDeliveryFile(job.id, "adapter-preflight.json", "Adapter 运行预检", "report", true, "说明 adapter 脚本、命令、环境开关和 fallback 原因。"),
    createDeliveryFile(job.id, "cam-handoff-quality.json", "CAM Handoff 质量报告", "report", true, "统一检查外部/内置刀路来源、点数、轴覆盖、Z范围和 synthetic/fixture 风险。"),
    createDeliveryFile(job.id, "cam-handoff-evidence.md", "CAM Handoff证据说明", "report", true, "用可读文本说明刀路来源、输入哈希、fixture/synthetic 风险、覆盖率和生产边界。"),
    createDeliveryFile(job.id, "rotary-wrap-preview-report.json", "旋转包裹预览一致性报告", "report", true, "检查中立刀路、Y/A旋转后处理、CAMotics展开预览和每圈等效距离是否一致。"),
    createDeliveryFile(job.id, "postprocess-trace-report.json", "后处理点位追溯报告", "report", true, "逐点核对源刀路与 toolpath.nc 的 X/Y/A/Z 输出，防止轴映射、拉伸和点位错位。"),
    createDeliveryFile(job.id, "simulation-summary.json", "仿真摘要", "report", true, "当前记录内置预览或 CAMotics 仿真结果。"),
    createDeliveryFile(job.id, "camotics-input.json", "CAMotics 输入计划", "report", true, "准备 CAMotics/机床仿真复核所需的刀路、毛坯和刀具参数。"),
    createDeliveryFile(job.id, "camotics-simulation-plan.json", "CAMotics 仿真计划", "report", true, "记录 CAMotics 预览 NC、展开毛坯、刀具、坐标解释和待执行检查项。"),
    createDeliveryFile(job.id, "camotics-project-template.json", "CAMotics 项目模板", "report", true, "后续 CAMotics adapter 生成真实项目/截图/材料去除网格的结构化模板。"),
    createDeliveryFile(job.id, "camotics-cli-execution-plan.json", "CAMotics CLI执行计划", "report", true, "列出 Linux CAM 服务器真实材料去除仿真的命令、输出契约和生产安全锁。"),
    createDeliveryFile(job.id, "camotics-cli-run-package.json", "CAMotics Linux运行包", "report", existsSync(join(job.workDir, "camotics-cli-run-package.json")), "Linux CAM 服务器执行前准备包，包含输入哈希、运动画像、命令和回填要求。"),
    createDeliveryFile(job.id, "camotics-result-template.json", "CAMotics结果回填模板", "report", existsSync(join(job.workDir, "camotics-result-template.json")), "真实 CAMotics 材料去除后按此模板填写 result JSON，再回填到 HeDiao3D。"),
    createDeliveryFile(job.id, "camotics-linux-run.sh", "CAMotics Linux运行脚本", "report", existsSync(join(job.workDir, "camotics-linux-run.sh")), "Linux CAM 服务器辅助脚本，仅用于打开/执行仿真准备流程，不解锁生产 NC。"),
    createDeliveryFile(job.id, "camotics-result-validate.js", "CAMotics结果本地校验脚本", "report", existsSync(join(job.workDir, "camotics-result-validate.js")), "Linux CAM 服务器回填前校验 camotics-result.json、输入哈希、运动画像和截图/STL 证据。"),
    createDeliveryFile(job.id, "camotics-linux-operator-checklist.md", "CAMotics Linux操作清单", "report", existsSync(join(job.workDir, "camotics-linux-operator-checklist.md")), "Linux CAM 操作员按此完成输入核验、真实仿真、结果校验和回填步骤。"),
    createDeliveryFile(job.id, "camotics-cli-package-report.json", "CAMotics运行包报告", "report", existsSync(join(job.workDir, "camotics-cli-package-report.json")), "记录 CAMotics Linux 准备包生成状态、检查项和安全锁。"),
    createDeliveryFile(job.id, "camotics-job.json", "CAMotics Adapter 任务", "report", existsSync(join(job.workDir, "camotics-job.json")), "CAMotics adapter 的独立输入快照。"),
    createDeliveryFile(job.id, "camotics-adapter-report.json", "CAMotics Adapter 报告", "report", existsSync(join(job.workDir, "camotics-adapter-report.json")), "记录 CAMotics adapter 是否执行、命令、耗时和错误。"),
    createDeliveryFile(job.id, "camotics-result-local-validation.json", "CAMotics本地结果校验报告", "report", existsSync(join(job.workDir, "camotics-result-local-validation.json")), "Linux CAM 服务器运行 camotics-result-validate.js 生成的本地校验报告，说明是否可作为材料去除证据回填。"),
    createDeliveryFile(job.id, "imported-camotics-result-bundle.zip", "CAMotics结果导入原包", "report", existsSync(join(job.workDir, "imported-camotics-result-bundle.zip")), "从 Linux CAM 服务器回传的一次性结果 ZIP 原件，用于审计回填来源。"),
    createDeliveryFile(job.id, "camotics-result.json", "CAMotics 仿真结果", "report", existsSync(join(job.workDir, "camotics-result.json")), "CAMotics 或 synthetic 仿真 adapter 返回的材料去除检查摘要。"),
    createDeliveryFile(job.id, "camotics-preview.png", "CAMotics 仿真截图", "report", existsSync(join(job.workDir, "camotics-preview.png")), "真实 CAMotics 或等效材料去除仿真截图，需与 camotics-result.json 中 SHA-256 对应。"),
    createDeliveryFile(job.id, "camotics-material-removal.stl", "CAMotics 材料去除网格", "model", existsSync(join(job.workDir, "camotics-material-removal.stl")), "真实 CAMotics 或等效材料去除仿真输出网格，需与 camotics-result.json 中 SHA-256 对应。"),
    createDeliveryFile(job.id, "camotics-run.md", "CAMotics 操作说明", "report", true, "说明如何用 CAMotics 打开 toolpath.nc 和 air-run.nc，以及旋转夹具模式限制。"),
    createDeliveryFile(job.id, "camotics-preview.nc", "CAMotics 展开预览 NC", "simulation", true, "仅用于 CAMotics 三轴展开仿真，Z 已转成负向切深，不可上机。"),
    createDeliveryFile(job.id, "production-gate.json", "生产门禁", "report", true, "说明是否允许生产 NC 下载。"),
    createDeliveryFile(job.id, "production-unlock-matrix.json", "生产解锁条件矩阵", "report", true, "逐项列出生产 NC 解锁所需条件、证据文件和阻断/复核状态。"),
    createDeliveryFile(job.id, "production-evidence-dossier.json", "生产证据档案", "report", true, "汇总外部CAM、仿真、NC分析、控制器、验收和试雕反馈证据，说明生产缺口。"),
    createDeliveryFile(job.id, "machine-controller-profile.json", "机床控制器配置", "report", true, "显式记录三轴控制器、Y/A旋转夹具、允许 G/M 指令和轴字规则。"),
    createDeliveryFile(job.id, "next-action-checklist.md", "下一步行动清单", "report", true, "面向当前加工包的最小可执行清单，列出可做、禁止做和生产解锁缺口。"),
    createDeliveryFile(job.id, "operator-runbook.md", "操作员上机说明书", "report", true, "面向机台操作员的中文空跑、试雕和正式加工流程。"),
    createDeliveryFile(job.id, "safe-trial-execution-plan.json", "安全试雕执行计划", "report", true, "结构化记录导入模型、生成安全数据、下载核验、空跑/软料试雕和证据回填步骤。"),
    createDeliveryFile(job.id, "trial-feedback-template.json", "试雕反馈回填模板", "report", true, "记录空跑/试雕结果、实际耗时、缺陷标签和参数调整建议。"),
    createDeliveryFile(job.id, "trial-feedback-record.json", "最新试雕反馈记录", "report", existsSync(join(job.workDir, "trial-feedback-record.json")), "现场空跑/试雕后回填的最新单条反馈记录。"),
    createDeliveryFile(job.id, "trial-feedback-log.json", "试雕反馈日志", "report", existsSync(join(job.workDir, "trial-feedback-log.json")), "按时间保存现场反馈记录，用于工艺参数优化闭环。"),
    createDeliveryFile(job.id, "process-optimization-plan.json", "工艺优化建议", "report", existsSync(join(job.workDir, "process-optimization-plan.json")), "根据试雕反馈生成的下一轮参数复核和调整建议。"),
    createDeliveryFile(job.id, "tool-setup-sheet.json", "刀具装夹与切削参数核验单", "report", true, "核验 4mm 25度平底尖刀、切深、步距、进给和主轴转速。"),
    createDeliveryFile(job.id, "rotary-calibration-sheet.json", "旋转夹具标定单", "report", true, "核验旋转轴方向、每圈等效距离、反向间隙和夹持余量。"),
    createDeliveryFile(job.id, "machine-acceptance-checklist.json", "机床现场验收清单", "report", existsSync(join(job.workDir, "machine-acceptance-checklist.json")), "操作员按此记录离料空跑、软材料试雕和正式试雕验收结果。"),
    createDeliveryFile(job.id, "machine-acceptance-record.json", "最新机床验收记录", "report", existsSync(join(job.workDir, "machine-acceptance-record.json")), "现场离料空跑、软料试雕和正式试雕的最新验收记录。"),
    createDeliveryFile(job.id, "machine-acceptance-log.json", "机床验收日志", "report", existsSync(join(job.workDir, "machine-acceptance-log.json")), "按时间保存机床现场验收记录，用于生产证据链。"),
    createDeliveryFile(job.id, "postprocess-profile.json", "后处理配置", "report", true, "说明 X/Z/旋转轴映射、刀具、胚料和 G-code 输出约定。"),
    createDeliveryFile(job.id, "machining-package-index.json", "加工包索引", "report", true, "加工包首页，区分可上机文件、仿真文件、空跑文件和必读报告。"),
    createDeliveryFile(job.id, "operator-download-checklist.md", "操作员下载核验清单", "report", true, "下载加工包后按此核验文件 SHA-256 和上机用途，避免误运行仿真或报告文件。"),
    createDeliveryFile(job.id, "package-integrity.json", "加工包完整性清单", "report", true, "记录交付文件大小和 SHA-256，用于下载后核验。"),
    createDeliveryFile(job.id, "air-run.nc", "离料空跑 NC", "air-run", productionGate.allowAirRun, "主轴关闭且 Z 在安全高度，用来验证轴向和行程。"),
    createDeliveryFile(job.id, "rotary-calibration-airrun.nc", "旋转夹具标定空跑 NC", "air-run", true, "主轴关闭且 Z 在安全高度，用 90/180/360 度动作核验旋转方向、每圈距离和反向间隙。"),
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
  if (existsSync(join(job.workDir, "opencamlib-kernel-plan.json"))) {
    files.push(createDeliveryFile(job.id, "opencamlib-kernel-plan.json", "OpenCAMLib 几何内核计划", "report", true, "外部 OpenCAMLib adapter 生成的 drop-cutter/刀具接触几何计算计划。"));
  }
  if (existsSync(join(job.workDir, "opencamlib-run-template.py"))) {
    files.push(createDeliveryFile(job.id, "opencamlib-run-template.py", "OpenCAMLib 运行模板", "report", true, "外部 OpenCAMLib adapter 生成的中性 cutter-contact 输出模板，用于服务器端二次验证。"));
  }
  if (existsSync(join(job.workDir, "opencamlib-cutter-envelope-report.json"))) {
    files.push(createDeliveryFile(job.id, "opencamlib-cutter-envelope-report.json", "OpenCAMLib 刀具包络采样报告", "report", true, "记录 STL 几何采样、刀具半径包络、命中率和 preview scaffold 生产边界。"));
  }
  for (const output of repairExecution?.outputs ?? []) {
    if (!output?.filename || !output.exists) continue;
    files.push(createDeliveryFile(job.id, output.filename, output.label ?? output.filename, "model", true, output.note ?? "Mesh 修复/重网格/CAM 降面产物，可作为外部 CAM 输入候选。"));
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
  const artifactPath = join(process.cwd(), "public", "orchestrator-jobs", jobId, filename);
  const exists = existsSync(artifactPath);
  return {
    filename,
    label,
    kind,
    url: publicArtifactUrl(jobId, filename),
    downloadable,
    exists,
    bytes: exists ? statSync(artifactPath).size : 0,
    machineUse: classifyDeliveryMachineUse(filename, kind, downloadable),
    note
  };
}

function classifyDeliveryMachineUse(filename, kind, downloadable) {
  if (filename === "toolpath.nc") {
    return {
      class: downloadable ? "trial-or-production-candidate" : "locked-machine-nc",
      allowedOnMachine: Boolean(downloadable),
      requiresGate: true,
      spindleExpected: true,
      summary: downloadable
        ? "可按 production-gate.json 的试雕/生产门禁使用。"
        : "机床 NC 已生成但当前门禁未放行，禁止上机。"
    };
  }
  if (filename === "air-run.nc" || filename === "rotary-calibration-airrun.nc") {
    return {
      class: "air-run-no-cut",
      allowedOnMachine: true,
      requiresGate: false,
      spindleExpected: false,
      summary: "只允许离料空跑，主轴关闭，Z 保持安全高度。"
    };
  }
  if (filename === "camotics-preview.nc" || kind === "simulation") {
    return {
      class: "simulation-only-never-machine",
      allowedOnMachine: false,
      requiresGate: false,
      spindleExpected: false,
      summary: "仅用于仿真/预览，禁止上机。"
    };
  }
  if (kind === "model") {
    return {
      class: "cam-input-only",
      allowedOnMachine: false,
      requiresGate: false,
      spindleExpected: false,
      summary: "模型/CAM 输入候选，不是机床程序。"
    };
  }
  if (kind === "report") {
    return {
      class: "report-only",
      allowedOnMachine: false,
      requiresGate: false,
      spindleExpected: false,
      summary: "报告或说明文件，不是机床程序。"
    };
  }
  return {
    class: "not-machine-code",
    allowedOnMachine: false,
    requiresGate: false,
    spindleExpected: false,
    summary: "未分类为机床程序。"
  };
}

function createPackageIntegrityReport(job, deliveryManifest) {
  const files = deliveryManifest.files.map((file) => {
    const filePath = join(job.workDir, file.filename);
    if (file.filename === "package-integrity.json") {
      return {
        filename: file.filename,
        label: file.label,
        kind: file.kind,
        downloadable: file.downloadable,
        machineUse: file.machineUse,
        exists: true,
        bytes: null,
        sha256: null,
        selfReference: true,
        note: "完整性清单自身不参与哈希，避免自引用。"
      };
    }
    if (!existsSync(filePath)) {
      return {
        filename: file.filename,
        label: file.label,
        kind: file.kind,
        downloadable: file.downloadable,
        machineUse: file.machineUse,
        exists: false,
        bytes: 0,
        sha256: null,
        note: "文件不存在或本次任务未生成。"
      };
    }
    const bytes = readFileSync(filePath);
    return {
      filename: file.filename,
      label: file.label,
      kind: file.kind,
      downloadable: file.downloadable,
      machineUse: file.machineUse,
      exists: true,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      note: file.note
    };
  });
  const downloadable = files.filter((file) => file.downloadable);
  const missingDownloadable = downloadable.filter((file) => !file.exists);

  return {
    schema: "hediao3d.package-integrity.v1",
    jobId: job.id,
    createdAt: new Date().toISOString(),
    packageLevel: deliveryManifest.packageLevel,
    fileCount: files.length,
    downloadableCount: downloadable.length,
    missingDownloadableCount: missingDownloadable.length,
    totalBytes: files.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0),
    status: missingDownloadable.length === 0 ? "complete" : "incomplete",
    summary: missingDownloadable.length === 0
      ? "所有可下载交付文件均已生成并记录 SHA-256。"
      : `存在 ${missingDownloadable.length} 个可下载文件缺失，请重新生成加工包。`,
    files
  };
}

function createOperatorDownloadChecklistMarkdown({ job, deliveryManifest, packageIntegrity, productionGate, machineControllerProfile, camHandoffQuality, simulationSummary }) {
  const manifestByName = new Map((deliveryManifest.files ?? []).map((file) => [file.filename, file]));
  const integrityFiles = packageIntegrity.files ?? [];
  const fileRows = integrityFiles
    .filter((file) => file.downloadable && !["package-integrity.json", "operator-download-checklist.md"].includes(file.filename))
    .map((file) => ({
      ...file,
      manifest: manifestByName.get(file.filename),
      machineUse: file.machineUse ?? manifestByName.get(file.filename)?.machineUse
    }));
  const machineCandidates = fileRows.filter((file) => file.filename === "toolpath.nc");
  const airRunFiles = fileRows.filter((file) => file.machineUse?.class === "air-run-no-cut");
  const neverMachineFiles = fileRows.filter((file) => file.machineUse?.allowedOnMachine === false);
  const missing = integrityFiles.filter((file) => file.downloadable && !file.exists);
  const axisInstruction = createOperatorAxisInstruction({
    camMode: machineControllerProfile?.camMode,
    coordinateMapping: machineControllerProfile?.axisMapping
  });
  const hashLine = (file) => `- [ ] ${file.filename}: ${file.exists ? `${file.sha256 ?? "self-reference"} (${file.bytes ?? "-"} bytes)` : "缺失"}${file.machineUse?.summary ? ` - ${file.machineUse.summary}` : ""}`;
  const lines = [
    "# HeDiao3D V3 操作员下载核验清单",
    "",
    `Job ID: ${job.id}`,
    `生成时间: ${new Date().toISOString()}`,
    `包级别: ${deliveryManifest.packageLevel}`,
    `完整性: ${packageIntegrity.status} / ${packageIntegrity.summary}`,
    `机床: ${machineControllerProfile?.name ?? "未生成"} / ${machineControllerProfile?.controllerClass ?? "-"}`,
    `上机轴向: ${axisInstruction}`,
    `CAM交接: ${camHandoffQuality?.level ?? "未生成"} / ${camHandoffQuality?.source ?? "-"}`,
    `仿真: ${simulationSummary?.engine ?? "未生成"} / ${simulationSummary?.riskLevel ?? "-"}`,
    "",
    "## 上机前必须确认",
    "",
    "- [ ] 已阅读 `machining-package-index.json`、`production-gate.json`、`operator-runbook.md`。",
    "- [ ] 已阅读 `package-integrity.json`，并用本清单核对下载后的文件哈希。",
    `- [ ] 已确认机床接线与 \`machine-controller-profile.json\` 中的轴向一致：${axisInstruction}。`,
    "- [ ] 已确认刀具与 `tool-setup-sheet.json` 一致，尤其是 4mm 25度平底尖刀、进给、转速和最大切深。",
    "- [ ] 先运行 `rotary-calibration-airrun.nc`，再运行 `air-run.nc`，两者都必须主轴关闭、Z 保持安全高度。",
    productionGate.allowProductionNc
      ? "- [ ] 生产门禁已放行；仍需完成离料空跑、低进给试雕和现场验收后再运行 `toolpath.nc`。"
      : "- [ ] 生产门禁未放行；`toolpath.nc` 最多只能按试雕/废料验证流程处理，禁止直接生产上机。",
    "",
    "## 推荐核验命令",
    "",
    "```powershell",
    "Get-FileHash .\\toolpath.nc -Algorithm SHA256",
    "Get-FileHash .\\air-run.nc -Algorithm SHA256",
    "Get-FileHash .\\rotary-calibration-airrun.nc -Algorithm SHA256",
    "```",
    "",
    "```bash",
    "sha256sum toolpath.nc air-run.nc rotary-calibration-airrun.nc",
    "```",
    "",
    "## 可上机候选",
    "",
    ...(machineCandidates.length ? machineCandidates.map(hashLine) : ["- 当前没有生产/试雕 NC 候选。"]),
    "",
    "## 只允许离料空跑",
    "",
    ...(airRunFiles.length ? airRunFiles.map(hashLine) : ["- 当前没有离料空跑文件。"]),
    "",
    "## 永远不要上机运行",
    "",
    ...(neverMachineFiles.length ? neverMachineFiles.map(hashLine) : ["- 无。"]),
    "",
    "## 缺失或异常",
    "",
    ...(missing.length ? missing.map((file) => `- [ ] ${file.filename}: 缺失，应重新生成加工包。`) : ["- 未发现缺失的可下载文件。"]),
    "",
    "## 操作记录",
    "",
    "- [ ] rotary-calibration-airrun.nc 运行结果：通过 / 未通过 / 备注：",
    "- [ ] air-run.nc 运行结果：通过 / 未通过 / 备注：",
    "- [ ] 低进给试雕结果：通过 / 未通过 / 备注：",
    "- [ ] 已回填 trial-feedback-template.json 和 machine-acceptance-checklist.json。",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function refreshEvidenceDeliveryArtifacts(job) {
  if (!job?.workDir) return null;
  await refreshNextActionChecklistArtifact(job);
  const manifestPath = join(job.workDir, "delivery-manifest.json");
  const existingManifest = readJsonFile(manifestPath);
  if (!existingManifest?.files) return null;
  let deliveryManifest = {
    ...existingManifest,
    updatedAt: new Date().toISOString(),
    files: [...existingManifest.files]
  };
  const evidenceFiles = [
    createDeliveryFile(job.id, "camotics-adapter-report.json", "CAMotics Adapter 报告", "report", existsSync(join(job.workDir, "camotics-adapter-report.json")), "记录 CAMotics adapter 是否执行、命令、耗时和错误。"),
    createDeliveryFile(job.id, "camotics-result-local-validation.json", "CAMotics本地结果校验报告", "report", existsSync(join(job.workDir, "camotics-result-local-validation.json")), "Linux CAM 服务器运行 camotics-result-validate.js 生成的本地校验报告，说明是否可作为材料去除证据回填。"),
    createDeliveryFile(job.id, "imported-camotics-result-bundle.zip", "CAMotics结果导入原包", "report", existsSync(join(job.workDir, "imported-camotics-result-bundle.zip")), "从 Linux CAM 服务器回传的一次性结果 ZIP 原件，用于审计回填来源。"),
    createDeliveryFile(job.id, "camotics-result.json", "CAMotics 仿真结果", "report", existsSync(join(job.workDir, "camotics-result.json")), "CAMotics 或 synthetic 仿真 adapter 返回的材料去除检查摘要。"),
    createDeliveryFile(job.id, "camotics-preview.png", "CAMotics 仿真截图", "report", existsSync(join(job.workDir, "camotics-preview.png")), "真实 CAMotics 或等效材料去除仿真截图，需与 camotics-result.json 中 SHA-256 对应。"),
    createDeliveryFile(job.id, "camotics-material-removal.stl", "CAMotics 材料去除网格", "model", existsSync(join(job.workDir, "camotics-material-removal.stl")), "真实 CAMotics 或等效材料去除仿真输出网格，需与 camotics-result.json 中 SHA-256 对应。"),
    createDeliveryFile(job.id, "camotics-cli-run-package.json", "CAMotics Linux运行包", "report", existsSync(join(job.workDir, "camotics-cli-run-package.json")), "Linux CAM 服务器执行前准备包，包含输入哈希、运动画像、命令和回填要求。"),
    createDeliveryFile(job.id, "camotics-result-template.json", "CAMotics结果回填模板", "report", existsSync(join(job.workDir, "camotics-result-template.json")), "真实 CAMotics 材料去除后按此模板填写 result JSON，再回填到 HeDiao3D。"),
    createDeliveryFile(job.id, "camotics-linux-run.sh", "CAMotics Linux运行脚本", "report", existsSync(join(job.workDir, "camotics-linux-run.sh")), "Linux CAM 服务器辅助脚本，仅用于打开/执行仿真准备流程，不解锁生产 NC。"),
    createDeliveryFile(job.id, "camotics-result-validate.js", "CAMotics结果本地校验脚本", "report", existsSync(join(job.workDir, "camotics-result-validate.js")), "Linux CAM 服务器回填前校验 camotics-result.json、输入哈希、运动画像和截图/STL 证据。"),
    createDeliveryFile(job.id, "camotics-linux-operator-checklist.md", "CAMotics Linux操作清单", "report", existsSync(join(job.workDir, "camotics-linux-operator-checklist.md")), "Linux CAM 操作员按此完成输入核验、真实仿真、结果校验和回填步骤。"),
    createDeliveryFile(job.id, "camotics-cli-package-report.json", "CAMotics运行包报告", "report", existsSync(join(job.workDir, "camotics-cli-package-report.json")), "记录 CAMotics Linux 准备包生成状态、检查项和安全锁。"),
    createDeliveryFile(job.id, "simulation-summary.json", "仿真摘要", "report", existsSync(join(job.workDir, "simulation-summary.json")), "当前记录内置预览或 CAMotics 仿真结果。"),
    createDeliveryFile(job.id, "production-gate.json", "生产门禁", "report", existsSync(join(job.workDir, "production-gate.json")), "说明是否允许生产 NC 下载。"),
    createDeliveryFile(job.id, "production-unlock-matrix.json", "生产解锁条件矩阵", "report", existsSync(join(job.workDir, "production-unlock-matrix.json")), "逐项列出生产 NC 解锁所需条件、证据文件和阻断/复核状态。"),
    createDeliveryFile(job.id, "machining-package-index.json", "加工包索引", "report", existsSync(join(job.workDir, "machining-package-index.json")), "加工包首页，区分可上机文件、仿真文件、空跑文件和必读报告。"),
    createDeliveryFile(job.id, "next-action-checklist.md", "下一步行动清单", "report", existsSync(join(job.workDir, "next-action-checklist.md")), "面向当前加工包的最小可执行清单，列出可做、禁止做和生产解锁缺口。"),
    createDeliveryFile(job.id, "trial-feedback-record.json", "最新试雕反馈记录", "report", existsSync(join(job.workDir, "trial-feedback-record.json")), "现场空跑/试雕后回填的最新单条反馈记录。"),
    createDeliveryFile(job.id, "trial-feedback-log.json", "试雕反馈日志", "report", existsSync(join(job.workDir, "trial-feedback-log.json")), "按时间保存现场反馈记录，用于工艺参数优化闭环。"),
    createDeliveryFile(job.id, "process-optimization-plan.json", "工艺优化建议", "report", existsSync(join(job.workDir, "process-optimization-plan.json")), "根据试雕反馈生成的下一轮参数复核和调整建议。"),
    createDeliveryFile(job.id, "machine-acceptance-record.json", "最新机床验收记录", "report", existsSync(join(job.workDir, "machine-acceptance-record.json")), "现场离料空跑、软料试雕和正式试雕的最新验收记录。"),
    createDeliveryFile(job.id, "machine-acceptance-log.json", "机床验收日志", "report", existsSync(join(job.workDir, "machine-acceptance-log.json")), "按时间保存机床现场验收记录，用于生产证据链。"),
    createDeliveryFile(job.id, "production-evidence-dossier.json", "生产证据档案", "report", existsSync(join(job.workDir, "production-evidence-dossier.json")), "汇总外部CAM、仿真、NC分析、控制器、验收和试雕反馈证据，说明生产缺口。")
  ];
  for (const file of evidenceFiles) {
    deliveryManifest = upsertDeliveryManifestFile(deliveryManifest, file);
  }
  await writeFile(manifestPath, JSON.stringify(deliveryManifest, null, 2), "utf8");
  await writeFile(join(job.workDir, "operator-download-checklist.md"), "# HeDiao3D V3 操作员下载核验清单\n\n更新中，请以最终 package-integrity.json 为准。\n", "utf8");
  let packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(job.workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");
  await writeFile(join(job.workDir, "operator-download-checklist.md"), createOperatorDownloadChecklistMarkdown({
    job,
    deliveryManifest,
    packageIntegrity,
    productionGate: readJsonFile(join(job.workDir, "production-gate.json")) ?? { allowProductionNc: false },
    machineControllerProfile: readJsonFile(join(job.workDir, "machine-controller-profile.json")),
    camHandoffQuality: readJsonFile(join(job.workDir, "cam-handoff-quality.json")),
    simulationSummary: readJsonFile(join(job.workDir, "simulation-summary.json"))
  }), "utf8");
  packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(job.workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "delivery-manifest.json"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "operator-download-checklist.md"));
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "package-integrity.json"));
  return { deliveryManifest, packageIntegrity };
}

async function refreshNextActionChecklistArtifact(job) {
  if (!job?.workDir) return false;
  const productionGate = readJsonFile(join(job.workDir, "production-gate.json"));
  const productionUnlockMatrix = readJsonFile(join(job.workDir, "production-unlock-matrix.json"));
  const productionEvidenceDossier = readJsonFile(join(job.workDir, "production-evidence-dossier.json"));
  const safeTrialExecutionPlan = readJsonFile(join(job.workDir, "safe-trial-execution-plan.json"));
  const postprocessProfile = readJsonFile(join(job.workDir, "postprocess-profile.json"));
  const machineControllerProfile = readJsonFile(join(job.workDir, "machine-controller-profile.json"));
  if (!productionGate && !productionUnlockMatrix && !productionEvidenceDossier && !safeTrialExecutionPlan) return false;
  await writeFile(join(job.workDir, "next-action-checklist.md"), createNextActionChecklistMarkdown({
    job,
    productionGate,
    productionUnlockMatrix,
    productionEvidenceDossier,
    safeTrialExecutionPlan,
    postprocessProfile,
    machineControllerProfile
  }), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "next-action-checklist.md"));
  return true;
}

function upsertDeliveryManifestFile(deliveryManifest, nextFile) {
  const files = Array.isArray(deliveryManifest.files) ? [...deliveryManifest.files] : [];
  const index = files.findIndex((file) => file.filename === nextFile.filename);
  if (index >= 0) {
    files[index] = {
      ...files[index],
      ...nextFile,
      downloadable: Boolean(nextFile.downloadable)
    };
  } else {
    files.push(nextFile);
  }
  return {
    ...deliveryManifest,
    files
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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
    const neutralToolpathPath = report.neutralToolpathPath ?? report.outputs?.neutralToolpath ?? report.metrics?.neutralToolpath?.path ?? join(job.workDir, "neutral-toolpath.json");
    const hasGcode = Boolean(gcodePath && existsSync(gcodePath) && statSync(gcodePath).size > 0);
    const hasNeutralToolpath = Boolean(neutralToolpathPath && existsSync(neutralToolpathPath) && statSync(neutralToolpathPath).size > 0);
    if (!hasGcode && !hasNeutralToolpath) errors.push("completed adapter report did not write G-code or neutral toolpath output");
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
    const command = String(selectedEngine.command ?? "");
    if (/^(python|python3|py)(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? command)) {
      return {
        command: selectedEngine.command,
        args: [scriptPath, jobPath, resultPath]
      };
    }
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

async function runCamoticsSimulationAdapter(job, settings, camoticsInput, camoticsSimulationPlan) {
  const shouldAttempt = camoticsInput.compatibility.canRunInCamotics
    && (
      String(process.env.HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN ?? "").toLowerCase() === "true"
      || String(process.env.HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT ?? "").toLowerCase() === "true"
    );
  if (!shouldAttempt) {
    return {
      status: "skipped",
      protocolVersion: "hediao3d.adapter.v1",
      engine: "camotics",
      jobId: job.id,
      error: "CAMotics adapter 未启用；保留自研旋转包裹预览摘要。",
      warnings: [],
      metrics: {
        camoticsInput: camoticsInput.status,
        canRunInCamotics: camoticsInput.compatibility.canRunInCamotics
      }
    };
  }

  const scriptPath = getAdapterScriptPath("camotics");
  const resultPath = join(job.workDir, "camotics-adapter-report.json");
  const adapterJobPath = join(job.workDir, "camotics-job.json");
  const adapterJob = {
    jobId: job.id,
    engine: "camotics",
    modelUrl: job.modelUrl,
    modelPath: localModelUrlToPath(job.modelUrl),
    workDir: job.workDir,
    settings,
    outputs: {
      gcode: join(job.workDir, "toolpath.nc"),
      report: resultPath,
      preview: join(job.workDir, "camotics-preview.nc"),
      simulationResult: join(job.workDir, "camotics-result.json")
    },
    camoticsInput,
    camoticsSimulationPlan,
    externalCamRecipe: {
      schema: "hediao3d.camotics-adapter-job.v1",
      status: camoticsInput.status,
      engine: {
        selectedEngine: "camotics",
        engineFamily: "camotics-simulation"
      },
      operations: [
        {
          id: "material-removal-preview",
          enabled: true,
          strategy: camoticsInput.compatibility.interpretation
        }
      ],
      postprocess: {
        policy: "CAMotics consumes camotics-preview.nc only; machine toolpath remains toolpath.nc."
      }
    }
  };
  await writeFile(adapterJobPath, JSON.stringify(adapterJob, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-job.json"));

  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [scriptPath, adapterJobPath, resultPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: Number(process.env.CAMOTICS_ADAPTER_TIMEOUT_MS ?? 120000)
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
      protocolVersion: "hediao3d.adapter.v1",
      engine: "camotics",
      jobId: job.id,
      error: run.error?.message ?? (run.status === 0 ? null : `camotics adapter exit ${run.status}`),
      warnings: [],
      metrics: {}
    };
  }
  report.command = `${process.execPath} ${scriptPath} ${adapterJobPath} ${resultPath}`;
  report.exitCode = run.status;
  report.durationMs = Date.now() - startedAt;
  report.stdout = String(run.stdout ?? "").slice(-6000);
  report.stderr = String(run.stderr ?? "").slice(-6000);
  await writeFile(resultPath, JSON.stringify(report, null, 2), "utf8");
  appendOrchestratorLog(job, `CAMotics adapter 返回 ${report.status}，${report.error ?? "无错误信息"}`);
  return report;
}

function mergeCamoticsSimulationResult(internalSummary, camoticsAdapterReport, job) {
  const resultPath = camoticsAdapterReport?.simulationResultPath
    ?? camoticsAdapterReport?.outputs?.simulationResult
    ?? camoticsAdapterReport?.metrics?.resultPath
    ?? join(job.workDir, "camotics-result.json");
  if (!camoticsAdapterReport || camoticsAdapterReport.status !== "completed" || !existsSync(resultPath)) {
    return {
      ...internalSummary,
      camoticsAdapter: {
        status: camoticsAdapterReport?.status ?? "skipped",
        error: camoticsAdapterReport?.error ?? null,
        resultArtifact: null
      }
    };
  }

  let camoticsResult;
  try {
    camoticsResult = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return {
      ...internalSummary,
      camoticsAdapter: {
        status: "invalid_result",
        error: "camotics-result.json is not valid JSON",
        resultArtifact: publicArtifactUrl(job.id, "camotics-result.json")
      }
    };
  }

  const synthetic = Boolean(camoticsResult.synthetic);
  return {
    ...internalSummary,
    engine: synthetic ? "camotics-synthetic" : "camotics",
    status: camoticsResult.status === "completed" ? "completed" : internalSummary.status,
    riskLevel: camoticsResult.riskLevel ?? internalSummary.riskLevel,
    notes: [
      ...(internalSummary.notes ?? []),
      synthetic
        ? "CAMotics synthetic result 只验证仿真 adapter 回填链路，不代表真实材料去除。"
        : "CAMotics adapter 已返回材料去除仿真结果。"
    ],
    camoticsAdapter: {
      status: camoticsAdapterReport.status,
      error: camoticsAdapterReport.error ?? null,
      synthetic,
      resultArtifact: publicArtifactUrl(job.id, "camotics-result.json"),
      reportArtifact: publicArtifactUrl(job.id, "camotics-adapter-report.json"),
      summary: camoticsResult.summary ?? null,
      metrics: camoticsResult.metrics ?? {},
      evidenceQuality: camoticsResult.evidenceQuality ?? null
    }
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

function createRotaryCalibrationAirRunGcode(settings) {
  const safeZ = Number(settings.safeZ ?? 10);
  const rotaryAxis = settings.camMode === "rotaryWrap"
    ? String(settings.rotaryOutputAxis || (settings.postProcessor === "wrapX" ? "X" : settings.postProcessor === "wrapY" ? "Y" : "A")).toUpperCase()
    : String(settings.rotaryOutputAxis || "Y").toUpperCase();
  const wrapPerRev = Math.max(0.001, Number(settings.rotaryWrapPerRevolutionMm ?? 100));
  const lengthAxis = rotaryAxis === "X" ? "Y" : "X";
  const lengthCenter = 0;
  const rotaryWord = (deg) => rotaryAxis === "A"
    ? `A${fmt(deg, 3)}`
    : `${rotaryAxis}${fmt((deg / 360) * wrapPerRev, 4)}`;
  const lengthWord = `${lengthAxis}${fmt(lengthCenter, 4)}`;
  const feed = Math.max(60, Math.min(300, Number(settings.feedRate ?? 180)));
  const steps = [0, 90, 180, 270, 360, 270, 180, 90, 0];
  const lines = [
    "(AIR RUN ONLY - ROTARY CALIBRATION - DO NOT CUT)",
    "(Purpose: verify rotary fixture direction, 90/180/360 degree distance, and backlash at safe Z)",
    `(ROTARY_WRAP_AXIS=${rotaryAxis} ROTARY_WRAP_PER_REV_MM=${fmt(wrapPerRev, 6)} LENGTH_AXIS=${lengthAxis})`,
    `(Coordinate: ${lengthAxis}=length hold position, ${rotaryAxis}=rotary fixture calibration, Z=safe height only)`,
    "G21",
    "G90",
    "M5",
    `G0 ${lengthWord} Z${fmt(safeZ)}`,
    `G0 ${rotaryWord(0)} Z${fmt(safeZ)}`
  ];
  for (const deg of steps.slice(1)) {
    lines.push(`G1 ${lengthWord} ${rotaryWord(deg)} Z${fmt(safeZ)} F${fmt(feed, 1)} (calibration ${fmt(deg, 1)} deg)`);
  }
  lines.push("M5", "G0 Z" + fmt(safeZ), "M30", "");
  return lines.join("\n");
}

function publicArtifactUrl(jobId, filename) {
  return `/orchestrator-jobs/${jobId}/${filename}`;
}

async function getOrchestratorJob(jobId, res) {
  const job = orchestratorJobs.get(jobId) ?? readJobManifest(jobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  return json(res, 200, job);
}

async function createOrchestratorTrialFeedback(req, jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) return json(res, 400, { error: "非法 Orchestrator 任务 ID" });
  const job = orchestratorJobs.get(safeJobId) ?? readJobManifest(safeJobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  const workDir = job.workDir ?? join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  if (!existsSync(workDir)) return json(res, 404, { error: "找不到 Orchestrator 任务目录" });

  const input = await readJson(req);
  const packageIntegrity = readJsonFile(join(workDir, "package-integrity.json"));
  const record = createTrialFeedbackRecord(job, input, packageIntegrity);
  const optimizationPlan = createProcessOptimizationPlan(job, record);
  const refreshedEvidenceDossier = createProductionEvidenceDossierFromJobArtifacts(job, {
    trialFeedbackLog: null,
    processOptimizationPlan: optimizationPlan
  });
  const logPath = join(workDir, "trial-feedback-log.json");
  const existingLog = readJsonFile(logPath) ?? {
    schema: "hediao3d.trial-feedback-log.v1",
    jobId: safeJobId,
    createdAt: new Date().toISOString(),
    records: []
  };
  const records = Array.isArray(existingLog.records) ? existingLog.records : [];
  const updatedLog = {
    ...existingLog,
    schema: "hediao3d.trial-feedback-log.v1",
    jobId: safeJobId,
    updatedAt: record.createdAt,
    recordCount: records.length + 1,
    latestRecordId: record.id,
    latestOutcome: record.outcome,
    latestDownloadIntegrityBound: record.downloadIntegrity?.packageBinding?.status ?? null,
    latestAllRequiredHashesVerified: Boolean(record.downloadIntegrity?.allRequiredHashesVerified),
    records: [record, ...records].slice(0, 80)
  };
  const productionEvidenceDossier = createProductionEvidenceDossierFromJobArtifacts(job, {
    trialFeedbackLog: updatedLog,
    processOptimizationPlan: optimizationPlan
  }) ?? refreshedEvidenceDossier;

  await writeFile(join(workDir, "trial-feedback-record.json"), JSON.stringify(record, null, 2), "utf8");
  await writeFile(logPath, JSON.stringify(updatedLog, null, 2), "utf8");
  await writeFile(join(workDir, "process-optimization-plan.json"), JSON.stringify(optimizationPlan, null, 2), "utf8");
  if (productionEvidenceDossier) {
    await writeFile(join(workDir, "production-evidence-dossier.json"), JSON.stringify(productionEvidenceDossier, null, 2), "utf8");
  }
  await writeTrialFeedbackGlobalRecord(record);
  job.workDir = workDir;
  const refreshedDelivery = await refreshEvidenceDeliveryArtifacts(job);

  job.updatedAt = record.createdAt;
  job.trialFeedback = {
    latestRecord: record,
    logArtifact: "trial-feedback-log.json",
    recordCount: updatedLog.recordCount
  };
  job.result = job.result ?? {};
  job.result.summary = {
    ...(job.result.summary ?? {}),
    trialFeedbackLog: {
      schema: updatedLog.schema,
      artifact: "trial-feedback-log.json",
      recordCount: updatedLog.recordCount,
      latestOutcome: record.outcome,
      latestRecordId: record.id,
      latestDownloadIntegrityBound: record.downloadIntegrity?.packageBinding?.status ?? null,
      latestAllRequiredHashesVerified: Boolean(record.downloadIntegrity?.allRequiredHashesVerified),
      recommendations: record.recommendations
    },
    processOptimizationPlan: {
      schema: optimizationPlan.schema,
      artifact: "process-optimization-plan.json",
      status: optimizationPlan.status,
      actionCount: optimizationPlan.actions.length,
      nextRunProfile: optimizationPlan.nextRunProfile
    },
    ...(refreshedDelivery ? {
      deliveryManifest: refreshedDelivery.deliveryManifest,
      packageIntegrity: {
        schema: refreshedDelivery.packageIntegrity.schema,
        status: refreshedDelivery.packageIntegrity.status,
        summary: refreshedDelivery.packageIntegrity.summary,
        fileCount: refreshedDelivery.packageIntegrity.fileCount,
        downloadableCount: refreshedDelivery.packageIntegrity.downloadableCount,
        missingDownloadableCount: refreshedDelivery.packageIntegrity.missingDownloadableCount,
        totalBytes: refreshedDelivery.packageIntegrity.totalBytes
      }
    } : {}),
    ...(productionEvidenceDossier ? {
      productionEvidenceDossier: createProductionEvidenceDossierPublicSummary(productionEvidenceDossier)
    } : {})
  };
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "trial-feedback-record.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "trial-feedback-log.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "process-optimization-plan.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "delivery-manifest.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "package-integrity.json"));
  if (productionEvidenceDossier) pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "production-evidence-dossier.json"));
  orchestratorJobs.set(safeJobId, job);
  await writeJobManifest(job);

  return json(res, 200, {
    ok: true,
    record,
    log: {
      schema: updatedLog.schema,
      jobId: safeJobId,
      recordCount: updatedLog.recordCount,
      latestRecordId: record.id,
      artifact: publicArtifactUrl(safeJobId, "trial-feedback-log.json")
    },
    optimizationPlan,
    productionEvidenceDossier
  });
}

async function createOrchestratorMachineAcceptance(req, jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) return json(res, 400, { error: "非法 Orchestrator 任务 ID" });
  const job = orchestratorJobs.get(safeJobId) ?? readJobManifest(safeJobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  const workDir = job.workDir ?? join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  if (!existsSync(workDir)) return json(res, 404, { error: "找不到 Orchestrator 任务目录" });

  const input = await readJson(req);
  const checklist = readJsonFile(join(workDir, "machine-acceptance-checklist.json"));
  const packageIntegrity = readJsonFile(join(workDir, "package-integrity.json"));
  const record = createMachineAcceptanceRecord(job, checklist, input, packageIntegrity);
  const logPath = join(workDir, "machine-acceptance-log.json");
  const existingLog = readJsonFile(logPath) ?? {
    schema: "hediao3d.machine-acceptance-log.v1",
    jobId: safeJobId,
    createdAt: new Date().toISOString(),
    records: []
  };
  const records = Array.isArray(existingLog.records) ? existingLog.records : [];
  const updatedLog = {
    ...existingLog,
    schema: "hediao3d.machine-acceptance-log.v1",
    jobId: safeJobId,
    updatedAt: record.createdAt,
    recordCount: records.length + 1,
    latestRecordId: record.id,
    latestOutcome: record.outcome,
    latestAllRequiredPassed: record.allRequiredPassed,
    latestDownloadIntegrityBound: record.downloadIntegrity?.packageBinding?.status ?? null,
    records: [record, ...records].slice(0, 80)
  };
  const productionEvidenceDossier = createProductionEvidenceDossierFromJobArtifacts(job, {
    machineAcceptanceLog: updatedLog
  });

  await writeFile(join(workDir, "machine-acceptance-record.json"), JSON.stringify(record, null, 2), "utf8");
  await writeFile(logPath, JSON.stringify(updatedLog, null, 2), "utf8");
  if (productionEvidenceDossier) {
    await writeFile(join(workDir, "production-evidence-dossier.json"), JSON.stringify(productionEvidenceDossier, null, 2), "utf8");
  }
  await writeMachineAcceptanceGlobalRecord(record);
  job.workDir = workDir;
  const refreshedDelivery = await refreshEvidenceDeliveryArtifacts(job);

  job.updatedAt = record.createdAt;
  job.machineAcceptance = {
    latestRecord: record,
    logArtifact: "machine-acceptance-log.json",
    recordCount: updatedLog.recordCount
  };
  job.result = job.result ?? {};
  job.result.summary = {
    ...(job.result.summary ?? {}),
    machineAcceptanceLog: {
      schema: updatedLog.schema,
      artifact: "machine-acceptance-log.json",
      recordCount: updatedLog.recordCount,
      latestOutcome: record.outcome,
      latestRecordId: record.id,
      allRequiredPassed: record.allRequiredPassed,
      downloadIntegrityBound: record.downloadIntegrity?.packageBinding?.status ?? null,
      recommendations: record.recommendations
    },
    ...(refreshedDelivery ? {
      deliveryManifest: refreshedDelivery.deliveryManifest,
      packageIntegrity: {
        schema: refreshedDelivery.packageIntegrity.schema,
        status: refreshedDelivery.packageIntegrity.status,
        summary: refreshedDelivery.packageIntegrity.summary,
        fileCount: refreshedDelivery.packageIntegrity.fileCount,
        downloadableCount: refreshedDelivery.packageIntegrity.downloadableCount,
        missingDownloadableCount: refreshedDelivery.packageIntegrity.missingDownloadableCount,
        totalBytes: refreshedDelivery.packageIntegrity.totalBytes
      }
    } : {}),
    ...(productionEvidenceDossier ? {
      productionEvidenceDossier: createProductionEvidenceDossierPublicSummary(productionEvidenceDossier)
    } : {})
  };
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "machine-acceptance-record.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "machine-acceptance-log.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "delivery-manifest.json"));
  pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "package-integrity.json"));
  if (productionEvidenceDossier) pushUnique(job.artifacts, publicArtifactUrl(safeJobId, "production-evidence-dossier.json"));
  orchestratorJobs.set(safeJobId, job);
  await writeJobManifest(job);

  return json(res, 200, {
    ok: true,
    record,
    log: {
      schema: updatedLog.schema,
      jobId: safeJobId,
      recordCount: updatedLog.recordCount,
      latestRecordId: record.id,
      latestOutcome: updatedLog.latestOutcome,
      latestAllRequiredPassed: updatedLog.latestAllRequiredPassed,
      artifact: publicArtifactUrl(safeJobId, "machine-acceptance-log.json")
    },
    productionEvidenceDossier
  });
}

async function importOrchestratorCamoticsResult(req, jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) return json(res, 400, { error: "非法 Orchestrator 任务 ID" });
  const job = orchestratorJobs.get(safeJobId) ?? readJobManifest(safeJobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  const workDir = job.workDir ?? join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  if (!existsSync(workDir)) return json(res, 404, { error: "找不到 Orchestrator 任务目录" });
  if (!existsSync(join(workDir, "camotics-preview.nc"))) {
    return json(res, 409, { error: "当前任务缺少 camotics-preview.nc，无法校验 CAMotics 输入哈希。" });
  }

  const input = await readJson(req, 30_000_000);
  const importBundle = await writeImportedCamoticsResultBundle(workDir, input);
  const adapterJobPath = await ensureCamoticsAdapterJobForImport(job, workDir);
  const resultPath = join(workDir, "camotics-adapter-report.json");
  const run = spawnSync(process.execPath, [getAdapterScriptPath("camotics"), adapterJobPath, resultPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: Number(process.env.CAMOTICS_ADAPTER_TIMEOUT_MS ?? 120000),
    env: {
      ...process.env,
      HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
      HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
      HEDIAO3D_CAMOTICS_RESULT_JSON: importBundle.resultPath
    }
  });

  let adapterReport = readJsonFile(resultPath);
  if (!adapterReport) {
    adapterReport = {
      status: run.status === 0 ? "completed_without_report" : "failed",
      protocolVersion: "hediao3d.adapter.v1",
      engine: "camotics",
      jobId: safeJobId,
      error: run.error?.message ?? (run.status === 0 ? null : `camotics adapter exit ${run.status}`),
      warnings: [],
      metrics: {}
    };
  }
  adapterReport.importedViaApi = true;
  adapterReport.importBundle = {
    result: "imported-camotics-result.json",
    screenshot: importBundle.screenshotFilename,
    materialMesh: importBundle.materialMeshFilename,
    localValidation: importBundle.localValidationFilename,
    zipBundle: importBundle.zipBundleFilename
  };
  adapterReport.localValidation = importBundle.localValidation
    ? {
        artifact: importBundle.localValidationFilename,
        ok: importBundle.localValidation.ok,
        productionEvidenceEligible: importBundle.localValidation.productionEvidenceEligible,
        missing: importBundle.localValidation.missing,
        summary: importBundle.localValidation.summary
      }
    : null;
  adapterReport.exitCode = run.status;
  adapterReport.stdout = String(run.stdout ?? "").slice(-6000);
  adapterReport.stderr = String(run.stderr ?? "").slice(-6000);
  await writeFile(resultPath, JSON.stringify(adapterReport, null, 2), "utf8");

  const refreshed = await refreshCamoticsEvidenceArtifacts(job, adapterReport);
  appendOrchestratorLog(job, `CAMotics 真实结果回填：${adapterReport.status}，${adapterReport.error ?? "已更新仿真证据"}`);
  job.workDir = workDir;
  job.updatedAt = new Date().toISOString();
  job.camoticsImport = {
    importedAt: job.updatedAt,
    status: adapterReport.status,
    resultArtifact: "camotics-result.json",
    productionEvidenceEligible: Boolean(refreshed.simulationEvidence?.productionUnlockEligible)
  };
  job.result = job.result ?? {};
  job.result.camoticsAdapterReport = adapterReport;
  job.result.summary = {
    ...(job.result.summary ?? {}),
    simulation: refreshed.simulationSummary,
    productionGate: refreshed.productionGate,
    productionUnlockMatrix: refreshed.productionUnlockMatrix,
    productionEvidenceDossier: refreshed.productionEvidenceDossier ? createProductionEvidenceDossierPublicSummary(refreshed.productionEvidenceDossier) : job.result.summary?.productionEvidenceDossier,
    machiningPackageIndex: refreshed.machiningPackageIndex ?? job.result.summary?.machiningPackageIndex,
    deliveryManifest: refreshed.deliveryManifest ?? job.result.summary?.deliveryManifest,
    packageIntegrity: refreshed.packageIntegrity ? {
      schema: refreshed.packageIntegrity.schema,
      status: refreshed.packageIntegrity.status,
      summary: refreshed.packageIntegrity.summary,
      fileCount: refreshed.packageIntegrity.fileCount,
      downloadableCount: refreshed.packageIntegrity.downloadableCount,
      missingDownloadableCount: refreshed.packageIntegrity.missingDownloadableCount,
      totalBytes: refreshed.packageIntegrity.totalBytes,
      files: refreshed.packageIntegrity.files
    } : job.result.summary?.packageIntegrity
  };
  for (const filename of [
    "imported-camotics-result.json",
    "imported-camotics-result-bundle.zip",
    "camotics-adapter-report.json",
    "camotics-result-local-validation.json",
    "camotics-result.json",
    "camotics-preview.png",
    "camotics-material-removal.stl",
    "simulation-summary.json",
    "production-gate.json",
    "production-unlock-matrix.json",
    "production-evidence-dossier.json",
    "open-source-cam-execution-plan.json",
    "machining-package-index.json",
    "delivery-manifest.json",
    "operator-download-checklist.md",
    "package-integrity.json"
  ]) {
    pushIfArtifactExists(job, filename);
  }
  orchestratorJobs.set(safeJobId, job);
  await writeJobManifest(job);

  return json(res, 200, {
    ok: adapterReport.status === "completed",
    adapterReport,
    simulationEvidence: refreshed.simulationEvidence,
    productionGate: refreshed.productionGate,
    productionUnlockMatrix: refreshed.productionUnlockMatrix,
    productionEvidenceDossier: refreshed.productionEvidenceDossier,
    artifacts: {
      result: publicArtifactUrl(safeJobId, "camotics-result.json"),
      adapterReport: publicArtifactUrl(safeJobId, "camotics-adapter-report.json"),
      screenshot: existsSync(join(workDir, "camotics-preview.png")) ? publicArtifactUrl(safeJobId, "camotics-preview.png") : null,
      materialMesh: existsSync(join(workDir, "camotics-material-removal.stl")) ? publicArtifactUrl(safeJobId, "camotics-material-removal.stl") : null
    }
  });
}

async function createOrchestratorCamoticsCliPackage(jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) return json(res, 400, { error: "非法 Orchestrator 任务 ID" });
  const job = orchestratorJobs.get(safeJobId) ?? readJobManifest(safeJobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  const workDir = job.workDir ?? join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  if (!existsSync(workDir)) return json(res, 404, { error: "找不到 Orchestrator 任务目录" });
  if (!existsSync(join(workDir, "camotics-cli-execution-plan.json"))) {
    return json(res, 409, { error: "当前任务缺少 camotics-cli-execution-plan.json，无法生成 Linux CAMotics 准备包。" });
  }

  const report = await prepareCamoticsCliPackageForJob(job, workDir);
  if (!report || report.status === "failed") {
    pushIfArtifactExists(job, "camotics-cli-package-report.json");
    orchestratorJobs.set(safeJobId, job);
    await writeJobManifest(job);
    return json(res, 500, { error: report?.error ?? "CAMotics Linux 准备包生成失败", report });
  }

  job.workDir = workDir;
  job.updatedAt = report.createdAt;
  appendOrchestratorLog(job, `CAMotics Linux 准备包已生成：${report.status}。`);
  const refreshedDelivery = await refreshEvidenceDeliveryArtifacts(job);
  job.result = job.result ?? {};
  job.result.summary = {
    ...(job.result.summary ?? {}),
    camoticsCliPackage: {
      status: report.status,
      ok: report.ok,
      artifact: "camotics-cli-run-package.json",
      resultTemplate: "camotics-result-template.json",
      linuxRunScript: "camotics-linux-run.sh",
      resultValidator: "camotics-result-validate.js",
      operatorChecklist: "camotics-linux-operator-checklist.md",
      report: "camotics-cli-package-report.json",
      productionUnlockEligible: false,
      preferredGcodeSha256: report.preferredGcodeIdentity?.sha256 ?? null,
      motionProfile: report.preferredGcodeIdentity?.motionProfile ?? null
    },
    ...(refreshedDelivery ? {
      deliveryManifest: refreshedDelivery.deliveryManifest,
      packageIntegrity: {
        schema: refreshedDelivery.packageIntegrity.schema,
        status: refreshedDelivery.packageIntegrity.status,
        summary: refreshedDelivery.packageIntegrity.summary,
        fileCount: refreshedDelivery.packageIntegrity.fileCount,
        downloadableCount: refreshedDelivery.packageIntegrity.downloadableCount,
        missingDownloadableCount: refreshedDelivery.packageIntegrity.missingDownloadableCount,
        totalBytes: refreshedDelivery.packageIntegrity.totalBytes,
        files: refreshedDelivery.packageIntegrity.files
      }
    } : {})
  };
  for (const filename of [
    "camotics-cli-run-package.json",
    "camotics-result-template.json",
    "camotics-linux-run.sh",
    "camotics-result-validate.js",
    "camotics-linux-operator-checklist.md",
    "camotics-cli-package-report.json",
    "delivery-manifest.json",
    "operator-download-checklist.md",
    "package-integrity.json"
  ]) {
    pushIfArtifactExists(job, filename);
  }
  orchestratorJobs.set(safeJobId, job);
  await writeJobManifest(job);

  return json(res, 200, {
    ok: report.ok,
    status: report.status,
    report,
    artifacts: {
      runPackage: publicArtifactUrl(safeJobId, "camotics-cli-run-package.json"),
      resultTemplate: publicArtifactUrl(safeJobId, "camotics-result-template.json"),
      linuxRunScript: publicArtifactUrl(safeJobId, "camotics-linux-run.sh"),
      resultValidator: publicArtifactUrl(safeJobId, "camotics-result-validate.js"),
      operatorChecklist: publicArtifactUrl(safeJobId, "camotics-linux-operator-checklist.md"),
      report: publicArtifactUrl(safeJobId, "camotics-cli-package-report.json")
    },
    deliveryManifest: refreshedDelivery?.deliveryManifest ?? null,
    packageIntegrity: refreshedDelivery?.packageIntegrity ?? null
  });
}

async function prepareCamoticsCliPackageForJob(job, workDir) {
  const scriptPath = join(process.cwd(), "adapters", "camotics", "camotics_cli_prepare.js");
  const safeJobId = job.id;
  if (!existsSync(scriptPath)) {
    const report = {
      schema: "hediao3d.camotics-cli-package-report.v1",
      jobId: safeJobId,
      createdAt: new Date().toISOString(),
      status: "failed",
      ok: false,
      exitCode: null,
      error: "找不到 CAMotics CLI 准备工具脚本",
      package: {
        runPackage: "camotics-cli-run-package.json",
        resultTemplate: "camotics-result-template.json",
        linuxRunScript: "camotics-linux-run.sh",
        resultValidator: "camotics-result-validate.js",
        operatorChecklist: "camotics-linux-operator-checklist.md"
      },
      preferredGcodeIdentity: null,
      checks: [],
      safetyLocks: {
        productionUnlockFromPreparePackage: false
      }
    };
    await writeFile(join(workDir, "camotics-cli-package-report.json"), JSON.stringify(report, null, 2), "utf8");
    return report;
  }

  const run = spawnSync(process.execPath, [scriptPath, workDir, workDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: Number(process.env.CAMOTICS_CLI_PREPARE_TIMEOUT_MS ?? 30000)
  });
  const runPackage = readJsonFile(join(workDir, "camotics-cli-run-package.json"));
  const report = {
    schema: "hediao3d.camotics-cli-package-report.v1",
    jobId: safeJobId,
    createdAt: new Date().toISOString(),
    status: run.error || run.status !== 0 || !runPackage ? "failed" : runPackage.status,
    ok: Boolean(!run.error && run.status === 0 && runPackage?.status === "ready-for-linux-camotics"),
    exitCode: run.status,
    error: run.error?.message ?? (run.status === 0 && runPackage ? null : `camotics cli prepare exit ${run.status}`),
    stdout: String(run.stdout ?? "").slice(-6000),
    stderr: String(run.stderr ?? "").slice(-6000),
    package: {
      runPackage: "camotics-cli-run-package.json",
      resultTemplate: "camotics-result-template.json",
      linuxRunScript: "camotics-linux-run.sh",
      resultValidator: "camotics-result-validate.js",
      operatorChecklist: "camotics-linux-operator-checklist.md"
    },
    preferredGcodeIdentity: runPackage?.preferredGcodeIdentity ?? null,
    checks: runPackage?.checks ?? [],
    safetyLocks: runPackage?.safetyLocks ?? {
      productionUnlockFromPreparePackage: false
    }
  };
  await writeFile(join(workDir, "camotics-cli-package-report.json"), JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function importOrchestratorNeutralToolpath(req, jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) return json(res, 400, { error: "非法 Orchestrator 任务 ID" });
  const job = orchestratorJobs.get(safeJobId) ?? readJobManifest(safeJobId);
  if (!job) return json(res, 404, { error: "找不到 Orchestrator 任务" });
  const workDir = job.workDir ?? join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  if (!existsSync(workDir)) return json(res, 404, { error: "找不到 Orchestrator 任务目录" });

  const input = await readJson(req, 30_000_000);
  const neutral = input?.neutralToolpath && typeof input.neutralToolpath === "object" ? input.neutralToolpath : null;
  if (!neutral) return json(res, 400, { error: "请传入 neutralToolpath 对象。" });
  const settings = readJobSettingsForRefresh(job, workDir);
  if (!settings) return json(res, 409, { error: "当前任务缺少 settings，无法执行 HeDiao3D 后处理。" });
  const neutralSourceBinding = createNeutralToolpathSourceBinding(neutral, {
    sourceName: String(input.sourceName ?? "neutral-toolpath.json")
  });
  const importValidation = createNeutralToolpathImportValidation(neutral, settings, {
    sourceName: String(input.sourceName ?? "neutral-toolpath.json"),
    engine: String(input.engine ?? neutral.engine ?? "opencamlib"),
    sourceBinding: neutralSourceBinding
  });
  if (!importValidation.postprocessEligible) {
    return json(res, 400, {
      error: importValidation.summary,
      validation: importValidation
    });
  }

  const importPath = join(workDir, "imported-neutral-toolpath.json");
  const neutralPath = join(workDir, "neutral-toolpath.json");
  const importedNeutralText = JSON.stringify(neutral, null, 2);
  const postprocessNeutral = {
    ...neutral,
    importedFromApi: true,
    importedAt: new Date().toISOString()
  };
  const postprocessNeutralText = JSON.stringify(postprocessNeutral, null, 2);
  neutralSourceBinding.importedArtifact = {
    filename: "imported-neutral-toolpath.json",
    sha256: createHash("sha256").update(importedNeutralText).digest("hex"),
    matchesSubmitted: createHash("sha256").update(importedNeutralText).digest("hex") === neutralSourceBinding.submitted.sha256
  };
  neutralSourceBinding.postprocessArtifact = {
    filename: "neutral-toolpath.json",
    sha256: createHash("sha256").update(postprocessNeutralText).digest("hex"),
    derivedFromSubmitted: true,
    addsApiImportMetadata: true
  };
  neutralSourceBinding.status = neutralSourceBinding.importedArtifact.matchesSubmitted ? "bound" : "review";
  neutralSourceBinding.summary = neutralSourceBinding.importedArtifact.matchesSubmitted
    ? "neutral-toolpath API 输入、原始导入文件和后处理文件已建立哈希绑定。"
    : "neutral-toolpath 原始导入文件与 API 输入哈希不一致，需复核。";
  importValidation.sourceBinding = neutralSourceBinding;
  await writeFile(importPath, importedNeutralText, "utf8");
  await writeFile(neutralPath, postprocessNeutralText, "utf8");
  await writeFile(join(workDir, "neutral-toolpath-import-validation.json"), JSON.stringify(importValidation, null, 2), "utf8");

  const pointCount = Array.isArray(neutral.points) ? neutral.points.length : 0;
  const selectedEngine = {
    id: String(input.engine ?? neutral.engine ?? "opencamlib"),
    name: engineDisplayName(String(input.engine ?? neutral.engine ?? "opencamlib")),
    available: true,
    adapterReady: true
  };
  const adapterReport = {
    status: "completed",
    protocolVersion: "hediao3d.adapter.v1",
    engine: selectedEngine.id,
    jobId: safeJobId,
    imported: true,
    importedViaApi: true,
    neutralToolpathPath: neutralPath,
    outputs: {
      neutralToolpath: neutralPath
    },
    warnings: [
      "外部 neutral-toolpath 已通过 API 回填；HeDiao3D 将负责最终 Y/A 旋转夹具后处理。",
      ...importValidation.warnings
    ],
    metrics: {
      neutralToolpath: {
        schema: neutral.schema ?? null,
        path: neutralPath,
        imported: true,
        synthetic: Boolean(neutral.synthetic),
        fixture: Boolean(neutral.fixture),
        previewScaffold: Boolean(importValidation.classification.previewScaffold),
        importValidation: "neutral-toolpath-import-validation.json",
        sourceBinding: neutralSourceBinding,
        pointCount
      },
      estimatedMinutes: Number(neutral.estimatedMinutes ?? 0) || null
    }
  };
  await writeFile(join(workDir, "adapter-report.json"), JSON.stringify(adapterReport, null, 2), "utf8");

  const toolpath = createToolpathFromAdapterReport(adapterReport, job, settings, selectedEngine);
  if (!toolpath) return json(res, 400, { error: "neutral-toolpath 无法转换为有效刀路，请检查 schema/points/坐标字段。" });
  neutralSourceBinding.sourceSnapshot = toolpath.externalSourceSnapshot ? {
    kind: toolpath.externalSourceSnapshot.kind,
    sha256: toolpath.externalSourceSnapshot.sha256,
    sizeBytes: toolpath.externalSourceSnapshot.sizeBytes,
    capturedAt: toolpath.externalSourceSnapshot.capturedAt,
    matchesPostprocessArtifact: toolpath.externalSourceSnapshot.sha256 === neutralSourceBinding.postprocessArtifact?.sha256
  } : null;
  neutralSourceBinding.status = neutralSourceBinding.importedArtifact?.matchesSubmitted && neutralSourceBinding.sourceSnapshot?.matchesPostprocessArtifact
    ? "bound"
    : "review";
  neutralSourceBinding.summary = neutralSourceBinding.status === "bound"
    ? "neutral-toolpath API 输入、原始导入文件、后处理文件和 toolpath sourceSnapshot 已完成哈希绑定。"
    : "neutral-toolpath 绑定链路需要复核，请检查 sourceBinding。";
  importValidation.sourceBinding = neutralSourceBinding;
  adapterReport.metrics.neutralToolpath.sourceBinding = neutralSourceBinding;
  await writeFile(join(workDir, "neutral-toolpath-import-validation.json"), JSON.stringify(importValidation, null, 2), "utf8");
  await writeFile(join(workDir, "adapter-report.json"), JSON.stringify(adapterReport, null, 2), "utf8");
  job.workDir = workDir;
  const refreshed = await refreshImportedToolpathArtifacts(job, settings, selectedEngine, adapterReport, toolpath);
  appendOrchestratorLog(job, `外部 neutral-toolpath 已回填并后处理：${toolpath.points.length} 点。`);
  job.updatedAt = new Date().toISOString();
  job.result = {
    ...(job.result ?? {}),
    engine: selectedEngine.id,
    fallbackFrom: selectedEngine.id,
    externalAvailable: true,
    adapterReady: true,
    adapterReport,
    toolpath,
    summary: {
      ...(job.result?.summary ?? {}),
      ...refreshed.summary
    }
  };
  for (const filename of [
    "imported-neutral-toolpath.json",
    "neutral-toolpath.json",
    "neutral-toolpath-import-validation.json",
    "adapter-report.json",
    "toolpath.nc",
    "toolpath-summary.json",
    "cam-handoff-quality.json",
    "air-run.nc",
    "rotary-calibration-airrun.nc",
    "camotics-preview.nc",
    "camotics-input.json",
    "camotics-simulation-plan.json",
    "camotics-project-template.json",
    "camotics-run.md",
    "simulation-summary.json",
    "production-gate.json",
    "production-unlock-matrix.json",
    "production-evidence-dossier.json",
    "open-source-cam-execution-plan.json",
    "machining-package-index.json",
    "delivery-manifest.json",
    "operator-download-checklist.md",
    "package-integrity.json"
  ]) {
    pushIfArtifactExists(job, filename);
  }
  orchestratorJobs.set(safeJobId, job);
  await writeJobManifest(job);

  return json(res, 200, {
    ok: true,
    validation: importValidation,
    adapterReport,
    toolpathSummary: refreshed.summary.toolpathSummary,
    camHandoffQuality: refreshed.summary.camHandoffQuality,
    productionGate: refreshed.summary.productionGate,
    artifacts: {
      neutralToolpath: publicArtifactUrl(safeJobId, "neutral-toolpath.json"),
      toolpath: publicArtifactUrl(safeJobId, "toolpath.nc"),
      adapterReport: publicArtifactUrl(safeJobId, "adapter-report.json")
    }
  });
}

async function writeImportedCamoticsResultBundle(workDir, input) {
  const zipBundle = input?.resultZipDataUrl ? extractCamoticsResultZipBundle(input.resultZipDataUrl) : null;
  const result = input?.result && typeof input.result === "object"
    ? { ...input.result }
    : zipBundle?.result
      ? { ...zipBundle.result }
      : null;
  if (!result) throw new Error("CAMotics result 不能为空，需传入 result 对象。");
  if (result.schema !== "hediao3d.camotics-result.v1") throw new Error("result.schema 必须是 hediao3d.camotics-result.v1。");
  if (result.synthetic === true) throw new Error("不能通过真实结果回填接口导入 synthetic CAMotics 结果。");
  const localValidation = normalizeCamoticsLocalValidation(input?.localValidation ?? zipBundle?.localValidation);

  const screenshotBuffer = input.screenshotDataUrl
    ? decodeInlineFile(input.screenshotDataUrl)
    : zipBundle?.screenshot?.content ?? null;
  const materialMeshBuffer = input.materialMeshText
    ? Buffer.from(String(input.materialMeshText), "utf8")
    : input.materialMeshDataUrl
      ? decodeInlineFile(input.materialMeshDataUrl)
      : zipBundle?.materialMesh?.content ?? null;
  const screenshotFilename = screenshotBuffer ? "imported-camotics-preview.png" : null;
  const materialMeshFilename = materialMeshBuffer ? "imported-camotics-material-removal.stl" : null;
  if (screenshotFilename) {
    await writeFile(join(workDir, screenshotFilename), screenshotBuffer);
  }
  if (materialMeshFilename) {
    await writeFile(join(workDir, materialMeshFilename), materialMeshBuffer);
  }
  const zipBundleFilename = zipBundle ? "imported-camotics-result-bundle.zip" : null;
  if (zipBundleFilename) {
    await writeFile(join(workDir, zipBundleFilename), zipBundle.sourceBuffer);
  }

  result.artifacts = {
    ...(result.artifacts ?? {}),
    ...(screenshotFilename ? { screenshot: join(workDir, screenshotFilename) } : {}),
    ...(materialMeshFilename ? { materialMesh: join(workDir, materialMeshFilename) } : {})
  };
  const resultPath = join(workDir, "imported-camotics-result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  const localValidationFilename = localValidation ? "camotics-result-local-validation.json" : null;
  if (localValidation) {
    await writeFile(join(workDir, localValidationFilename), JSON.stringify(localValidation, null, 2), "utf8");
  }
  return { resultPath, screenshotFilename, materialMeshFilename, localValidationFilename, localValidation, zipBundleFilename };
}

function extractCamoticsResultZipBundle(value) {
  const buffer = decodeInlineFile(value);
  const entries = extractZipEntries(buffer);
  const findEntry = (predicate) => entries.find((entry) => predicate(entry.name.toLowerCase()));
  const resultEntry = findEntry((name) => /(^|\/)camotics-result\.json$/.test(name) && !/template/.test(name));
  if (!resultEntry) throw new Error("ZIP 中找不到 camotics-result.json。");
  const localValidationEntry = findEntry((name) => /(^|\/)camotics-result-local-validation\.json$/.test(name));
  const screenshotEntry = findEntry((name) => /\.(png|jpg|jpeg|webp)$/.test(name) && /camotics|preview|screenshot/.test(name));
  const materialMeshEntry = findEntry((name) => /\.stl$/.test(name) && /material|removal|camotics/.test(name));
  return {
    sourceBuffer: buffer,
    entries: entries.map((entry) => ({
      name: entry.name,
      sizeBytes: entry.content.length
    })),
    result: parseJsonBuffer(resultEntry.content, "camotics-result.json"),
    localValidation: localValidationEntry ? parseJsonBuffer(localValidationEntry.content, "camotics-result-local-validation.json") : null,
    screenshot: screenshotEntry ? { name: screenshotEntry.name, content: screenshotEntry.content } : null,
    materialMesh: materialMeshEntry ? { name: materialMeshEntry.name, content: materialMeshEntry.content } : null
  };
}

function extractZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (flags & 0x08) throw new Error("暂不支持带 data descriptor 的 ZIP，请使用普通 zip 文件。");
    if (dataEnd > buffer.length) throw new Error("ZIP 文件不完整或损坏。");
    const name = buffer.subarray(nameStart, nameEnd).toString("utf8").replace(/\\/g, "/");
    if (!name.endsWith("/")) {
      const compressed = buffer.subarray(dataStart, dataEnd);
      const content = method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed)
          : null;
      if (!content) throw new Error(`ZIP 条目 ${name} 使用了暂不支持的压缩方式 ${method}。`);
      if (uncompressedSize !== 0 && content.length !== uncompressedSize) {
        throw new Error(`ZIP 条目 ${name} 解压大小不匹配。`);
      }
      entries.push({ name, content });
    }
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error("ZIP 中没有可读取文件。");
  return entries;
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function normalizeCamoticsLocalValidation(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schema !== "hediao3d.camotics-result-local-validation.v1") {
    throw new Error("localValidation.schema 必须是 hediao3d.camotics-result-local-validation.v1。");
  }
  return {
    ...value,
    importedAt: new Date().toISOString(),
    importedVia: "api-camotics-result",
    ok: value.ok === true,
    productionEvidenceEligible: value.productionEvidenceEligible === true,
    missing: Array.isArray(value.missing) ? value.missing.map((item) => String(item)).slice(0, 50) : [],
    summary: typeof value.summary === "string" ? value.summary.slice(0, 1000) : null
  };
}

function decodeInlineFile(value) {
  const text = String(value ?? "");
  const base64 = text.includes(",") ? text.split(",").pop() : text;
  if (!base64) throw new Error("上传文件内容为空。");
  return Buffer.from(base64, "base64");
}

async function ensureCamoticsAdapterJobForImport(job, workDir) {
  const existing = readJsonFile(join(workDir, "camotics-job.json"));
  const jobSpec = readJsonFile(join(workDir, "job.json"));
  const camoticsInput = readJsonFile(join(workDir, "camotics-input.json"));
  const camoticsSimulationPlan = readJsonFile(join(workDir, "camotics-simulation-plan.json"));
  const adapterJob = {
    ...(existing ?? {}),
    jobId: job.id,
    engine: "camotics",
    modelUrl: job.modelUrl,
    modelPath: existing?.modelPath ?? jobSpec?.modelPath ?? localModelUrlToPath(job.modelUrl),
    workDir,
    settings: existing?.settings ?? jobSpec?.settings ?? {},
    outputs: {
      ...(existing?.outputs ?? {}),
      gcode: join(workDir, "toolpath.nc"),
      report: join(workDir, "camotics-adapter-report.json"),
      preview: join(workDir, "camotics-preview.nc"),
      simulationResult: join(workDir, "camotics-result.json")
    },
    camoticsInput: existing?.camoticsInput ?? camoticsInput,
    camoticsSimulationPlan: existing?.camoticsSimulationPlan ?? camoticsSimulationPlan
  };
  const adapterJobPath = join(workDir, "camotics-job.json");
  await writeFile(adapterJobPath, JSON.stringify(adapterJob, null, 2), "utf8");
  pushUnique(job.artifacts, publicArtifactUrl(job.id, "camotics-job.json"));
  return adapterJobPath;
}

async function refreshCamoticsEvidenceArtifacts(job, adapterReport) {
  const workDir = job.workDir;
  const previousSimulationSummary = readJsonFile(join(workDir, "simulation-summary.json")) ?? {
    engine: "internal-rotary-preview",
    status: "completed",
    riskLevel: "review",
    metrics: {}
  };
  const simulationSummary = mergeCamoticsSimulationResult(previousSimulationSummary, adapterReport, job);
  await writeFile(join(workDir, "simulation-summary.json"), JSON.stringify(simulationSummary, null, 2), "utf8");

  const productionGate = refreshProductionGateSimulationEvidence(readJsonFile(join(workDir, "production-gate.json")), simulationSummary);
  await writeFile(join(workDir, "production-gate.json"), JSON.stringify(productionGate, null, 2), "utf8");
  const productionUnlockMatrix = refreshProductionUnlockMatrixSimulationRow(readJsonFile(join(workDir, "production-unlock-matrix.json")), productionGate, simulationSummary);
  await writeFile(join(workDir, "production-unlock-matrix.json"), JSON.stringify(productionUnlockMatrix, null, 2), "utf8");
  const productionEvidenceDossier = createProductionEvidenceDossierFromJobArtifacts(job);
  if (productionEvidenceDossier) {
    await writeFile(join(workDir, "production-evidence-dossier.json"), JSON.stringify(productionEvidenceDossier, null, 2), "utf8");
  }

  const refreshedDelivery = await refreshEvidenceDeliveryArtifacts(job);
  const deliveryManifest = refreshedDelivery?.deliveryManifest ?? readJsonFile(join(workDir, "delivery-manifest.json"));
  const postprocessProfile = readJsonFile(join(workDir, "postprocess-profile.json"));
  const camoticsInput = readJsonFile(join(workDir, "camotics-input.json"));
  const camoticsSimulationPlan = readJsonFile(join(workDir, "camotics-simulation-plan.json"));
  const camoticsCliExecutionPlan = readJsonFile(join(workDir, "camotics-cli-execution-plan.json"));
  const rotaryWrapPreviewReport = readJsonFile(join(workDir, "rotary-wrap-preview-report.json"));
  const postprocessTraceReport = readJsonFile(join(workDir, "postprocess-trace-report.json"));
  const machiningPackageIndex = deliveryManifest && postprocessProfile && camoticsInput
    ? createMachiningPackageIndex({
      job,
      toolpath: createToolpathStubForRefresh(job),
      productionGate,
      postprocessProfile,
      simulationSummary,
      camoticsInput,
      camoticsSimulationPlan,
      camoticsCliExecutionPlan,
      rotaryWrapPreviewReport,
      postprocessTraceReport,
      camHandoffQuality: readJsonFile(join(workDir, "cam-handoff-quality.json")),
      camServerConfig: readJsonFile(join(workDir, "cam-server-config.json")),
      productionEvidenceDossier,
      ncStaticAnalysis: readJsonFile(join(workDir, "nc-static-analysis.json")),
      nativeCamReadiness: readJsonFile(join(workDir, "native-cam-readiness.json")),
      camEngineSelection: readJsonFile(join(workDir, "cam-engine-selection.json")),
      openSourceCamExecutionPlan: readJsonFile(join(workDir, "open-source-cam-execution-plan.json")),
      machineControllerProfile: readJsonFile(join(workDir, "machine-controller-profile.json")),
      machineAcceptanceChecklist: readJsonFile(join(workDir, "machine-acceptance-checklist.json")),
      controllerDialectReport: readJsonFile(join(workDir, "controller-dialect-report.json")),
      deliveryManifest
    })
    : null;
  if (machiningPackageIndex) {
    await writeFile(join(workDir, "machining-package-index.json"), JSON.stringify(machiningPackageIndex, null, 2), "utf8");
  }
  const refreshedAfterIndex = await refreshEvidenceDeliveryArtifacts(job);
  return {
    simulationSummary,
    simulationEvidence: productionGate.simulationEvidence,
    productionGate,
    productionUnlockMatrix,
    productionEvidenceDossier,
    machiningPackageIndex,
    deliveryManifest: refreshedAfterIndex?.deliveryManifest ?? deliveryManifest,
    packageIntegrity: refreshedAfterIndex?.packageIntegrity ?? refreshedDelivery?.packageIntegrity
  };
}

function refreshProductionGateSimulationEvidence(productionGate, simulationSummary) {
  const simulationEvidence = createSimulationEvidence(simulationSummary);
  const gate = productionGate && typeof productionGate === "object" ? { ...productionGate } : {
    schema: "hediao3d.production-gate.v1",
    level: "trial-only",
    allowProductionNc: false,
    allowTrialNc: true,
    allowAirRun: true,
    blockers: [],
    warnings: [],
    requiredActions: []
  };
  gate.simulationEvidence = simulationEvidence;
  gate.checks = {
    ...(gate.checks ?? {}),
    simulationEngine: simulationSummary.engine,
    simulationEvidenceLevel: simulationEvidence.level,
    realMaterialRemovalVerified: simulationEvidence.realMaterialRemovalVerified,
    simulationRiskLevel: simulationSummary.riskLevel
  };
  gate.warnings = dedupeStrings([
    ...(gate.warnings ?? []).filter((item) => !/CAMotics|仿真|材料去除|旋转包裹\/三轴预览/.test(String(item))),
    ...(simulationEvidence.productionUnlockEligible ? [] : [simulationEvidence.summary])
  ]);
  gate.requiredActions = dedupeStrings([
    ...(gate.requiredActions ?? []).filter((item) => !/CAMotics|仿真|材料去除/.test(String(item))),
    ...simulationEvidence.requiredActions
  ]);
  gate.allowProductionNc = Boolean(gate.allowProductionNc) && simulationEvidence.productionUnlockEligible;
  gate.level = gate.blockers?.length > 0 ? "blocked" : gate.allowProductionNc ? "production" : "trial-only";
  gate.summary = gate.allowProductionNc
    ? "已通过 V3 生产门禁，可下载生产 NC。"
    : gate.blockers?.length
      ? `禁止上机：${gate.blockers[0]}`
      : "仅建议离料空跑/小料试雕，暂不建议直接生产上机。";
  gate.updatedAt = new Date().toISOString();
  return gate;
}

function refreshProductionUnlockMatrixSimulationRow(matrix, productionGate, simulationSummary) {
  const simulationEvidence = productionGate.simulationEvidence ?? createSimulationEvidence(simulationSummary);
  const next = matrix && typeof matrix === "object" ? { ...matrix } : {
    schema: "hediao3d.production-unlock-matrix.v1",
    rows: []
  };
  const rows = Array.isArray(next.rows) ? [...next.rows] : [];
  const row = {
    id: "simulation-evidence",
    label: "材料去除仿真证据",
    status: simulationEvidence.productionUnlockEligible ? "pass" : "review",
    evidence: "simulation-summary.json / camotics-result.json",
    summary: simulationEvidence.summary,
    requiredForProduction: true
  };
  const index = rows.findIndex((item) => item.id === "simulation-evidence");
  if (index >= 0) rows[index] = { ...rows[index], ...row };
  else rows.push(row);
  const blockCount = rows.filter((item) => item.status === "block").length;
  const reviewCount = rows.filter((item) => item.status === "review").length;
  const passCount = rows.filter((item) => item.status === "pass").length;
  return {
    ...next,
    jobId: productionGate.jobId ?? next.jobId,
    updatedAt: new Date().toISOString(),
    packageLevel: productionGate.level,
    allowProductionNc: productionGate.allowProductionNc,
    summary: productionGate.allowProductionNc
      ? "生产 NC 已满足矩阵条件。"
      : `生产 NC 未解锁：${blockCount} 个阻断项，${reviewCount} 个复核项。`,
    passCount,
    reviewCount,
    blockCount,
    rows,
    blockers: productionGate.blockers ?? [],
    warnings: productionGate.warnings ?? [],
    requiredActions: productionGate.requiredActions ?? []
  };
}

function createToolpathStubForRefresh(job) {
  const summary = job.result?.summary ?? {};
  const toolpathSummary = readJsonFile(join(job.workDir, "toolpath-summary.json"));
  return {
    points: new Array(Math.max(0, Number(summary.points ?? toolpathSummary?.points ?? 0))).fill(null),
    estimatedMinutes: Number(summary.estimatedMinutes ?? toolpathSummary?.estimatedMinutes ?? 0),
    postProcessorName: summary.postProcessorName ?? toolpathSummary?.postProcessorName ?? "V3 postprocess",
    summary: {
      warnings: summary.warnings ?? toolpathSummary?.warnings ?? []
    }
  };
}

function readJobSettingsForRefresh(job, workDir) {
  const jobSpec = readJsonFile(join(workDir, "job.json"));
  return normalizeServerCamSettings(jobSpec?.settings ?? job.result?.summary?.settings ?? {});
}

async function refreshImportedToolpathArtifacts(job, settings, selectedEngine, adapterReport, toolpath) {
  const workDir = job.workDir;
  await writeFile(join(workDir, "toolpath.nc"), toolpath.gcode, "utf8");
  await writeFile(join(workDir, "toolpath-summary.json"), JSON.stringify({
    engine: selectedEngine.id,
    fallbackFrom: selectedEngine.id,
    source: "external-adapter",
    externalSourceSnapshot: toolpath.externalSourceSnapshot ?? null,
    points: toolpath.points.length,
    previewPoints: toolpath.previewPoints?.length ?? 0,
    estimatedMinutes: toolpath.estimatedMinutes,
    postProcessorName: toolpath.postProcessorName,
    warnings: toolpath.summary?.warnings ?? []
  }, null, 2), "utf8");

  const machineControllerProfile = createMachineControllerProfile(settings);
  const airRunGcode = createServerAirRunGcode(toolpath.points, settings, toolpath.estimatedMinutes, "V3 imported neutral air run");
  const rotaryCalibrationAirRunGcode = createRotaryCalibrationAirRunGcode(settings);
  const camoticsPreviewGcode = createCamoticsPreviewGcode(toolpath.points, settings, toolpath.estimatedMinutes);
  await writeFile(join(workDir, "air-run.nc"), airRunGcode, "utf8");
  await writeFile(join(workDir, "rotary-calibration-airrun.nc"), rotaryCalibrationAirRunGcode, "utf8");
  await writeFile(join(workDir, "camotics-preview.nc"), camoticsPreviewGcode, "utf8");
  await writeFile(join(workDir, "machine-controller-profile.json"), JSON.stringify(machineControllerProfile, null, 2), "utf8");

  const ncStaticAnalysis = createNcStaticAnalysis({
    settings,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "rotary-calibration-airrun.nc", role: "air-run", gcode: rotaryCalibrationAirRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  const controllerDialectReport = createControllerDialectReport({
    settings,
    machineControllerProfile,
    files: [
      { filename: "toolpath.nc", role: "machine", gcode: toolpath.gcode },
      { filename: "air-run.nc", role: "air-run", gcode: airRunGcode },
      { filename: "rotary-calibration-airrun.nc", role: "air-run", gcode: rotaryCalibrationAirRunGcode },
      { filename: "camotics-preview.nc", role: "simulation-only", gcode: camoticsPreviewGcode }
    ]
  });
  await writeFile(join(workDir, "nc-static-analysis.json"), JSON.stringify(ncStaticAnalysis, null, 2), "utf8");
  await writeFile(join(workDir, "controller-dialect-report.json"), JSON.stringify(controllerDialectReport, null, 2), "utf8");

  const camHandoffQuality = createCamHandoffQualityReport({
    job,
    settings,
    toolpath,
    selectedEngine,
    resultEngine: selectedEngine.id,
    adapterReport,
    externalToolpathUsed: true
  });
  await writeFile(join(workDir, "cam-handoff-quality.json"), JSON.stringify(camHandoffQuality, null, 2), "utf8");

  const camoticsInput = createCamoticsInputPlan(job, toolpath, settings, selectedEngine);
  const camoticsSimulationPlan = createCamoticsSimulationPlan(job, toolpath, settings, selectedEngine, camoticsInput);
  const camoticsCliExecutionPlan = createCamoticsCliExecutionPlan(job, camoticsInput, camoticsSimulationPlan, settings);
  const rotaryWrapPreviewReport = createRotaryWrapPreviewReport({
    job,
    settings,
    toolpath,
    machineGcode: toolpath.gcode,
    airRunGcode,
    camoticsPreviewGcode,
    ncStaticAnalysis,
    controllerDialectReport,
    machineControllerProfile,
    camoticsInput
  });
  const postprocessTraceReport = createPostprocessTraceReport({
    job,
    settings,
    toolpath,
    machineGcode: toolpath.gcode,
    machineControllerProfile
  });
  await writeFile(join(workDir, "camotics-input.json"), JSON.stringify(camoticsInput, null, 2), "utf8");
  await writeFile(join(workDir, "camotics-simulation-plan.json"), JSON.stringify(camoticsSimulationPlan, null, 2), "utf8");
  await writeFile(join(workDir, "camotics-project-template.json"), JSON.stringify(camoticsSimulationPlan.projectTemplate, null, 2), "utf8");
  await writeFile(join(workDir, "camotics-cli-execution-plan.json"), JSON.stringify(camoticsCliExecutionPlan, null, 2), "utf8");
  await writeFile(join(workDir, "rotary-wrap-preview-report.json"), JSON.stringify(rotaryWrapPreviewReport, null, 2), "utf8");
  await writeFile(join(workDir, "postprocess-trace-report.json"), JSON.stringify(postprocessTraceReport, null, 2), "utf8");
  await writeFile(join(workDir, "camotics-run.md"), createCamoticsRunbook(camoticsInput), "utf8");

  const simulationSummary = createSimulationSummary(toolpath, settings, selectedEngine);
  await writeFile(join(workDir, "simulation-summary.json"), JSON.stringify(simulationSummary, null, 2), "utf8");
  const meshQuality = readJsonFile(join(workDir, "mesh-quality.json")) ?? { verdict: "review", score: 0 };
  const repairPlan = readJsonFile(join(workDir, "repair-plan.json")) ?? { status: "review-required" };
  const repairExecution = readJsonFile(join(workDir, "repair-execution.json")) ?? null;
  const camInputPlan = readJsonFile(join(workDir, "cam-input-plan.json")) ?? { status: "review", gate: { allowProductionNc: false, reason: "CAM 输入计划缺失。" } };
  const engineReadiness = readJsonFile(join(workDir, "engine-diagnostics.json")) ?? { externalReady: true, summary: "External neutral toolpath imported via API." };
  const nativeCamReadiness = readJsonFile(join(workDir, "native-cam-readiness.json"));
  const productionGate = createProductionGate({
    toolpath,
    settings,
    selectedEngine,
    resultEngine: selectedEngine.id,
    meshQuality,
    repairPlan,
    repairExecution,
    camInputPlan,
    engineReadiness,
    nativeCamReadiness,
    simulationSummary,
    camoticsInput,
    camHandoffQuality,
    neutralToolpathImportValidation: readJsonFile(join(workDir, "neutral-toolpath-import-validation.json")),
    postprocessTraceReport,
    ncStaticAnalysis,
    machineControllerProfile,
    controllerDialectReport
  });
  await writeFile(join(workDir, "production-gate.json"), JSON.stringify(productionGate, null, 2), "utf8");

  const postprocessProfile = createPostprocessProfile({
    job,
    settings,
    toolpath,
    selectedEngine,
    resultEngine: selectedEngine.id,
    productionGate
  });
  const toolSetupSheet = createToolSetupSheet({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile
  });
  const rotaryCalibrationSheet = createRotaryCalibrationSheet({
    job,
    settings,
    toolpath,
    productionGate,
    postprocessProfile,
    machineControllerProfile
  });
  await writeFile(join(workDir, "postprocess-profile.json"), JSON.stringify(postprocessProfile, null, 2), "utf8");
  await writeFile(join(workDir, "tool-setup-sheet.json"), JSON.stringify(toolSetupSheet, null, 2), "utf8");
  await writeFile(join(workDir, "rotary-calibration-sheet.json"), JSON.stringify(rotaryCalibrationSheet, null, 2), "utf8");

  const productionUnlockMatrix = createProductionUnlockMatrix({
    job,
    productionGate,
    meshQuality,
    repairPlan,
    camInputPlan,
    engineReadiness,
    nativeCamReadiness,
    simulationSummary,
    ncStaticAnalysis,
    camHandoffQuality,
    postprocessTraceReport,
    neutralToolpathImportValidation: readJsonFile(join(workDir, "neutral-toolpath-import-validation.json")),
    externalGcodeImportValidation: readJsonFile(join(workDir, "external-gcode-import-validation.json")),
    controllerDialectReport,
    toolSetupSheet,
    rotaryCalibrationSheet
  });
  await writeFile(join(workDir, "production-unlock-matrix.json"), JSON.stringify(productionUnlockMatrix, null, 2), "utf8");
  const productionEvidenceDossier = createProductionEvidenceDossierFromJobArtifacts(job);
  if (productionEvidenceDossier) {
    await writeFile(join(workDir, "production-evidence-dossier.json"), JSON.stringify(productionEvidenceDossier, null, 2), "utf8");
  }

  const deliveryManifest = createDeliveryManifest(job, toolpath, productionGate, repairExecution);
  const machiningPackageIndex = createMachiningPackageIndex({
    job,
    toolpath,
    productionGate,
    postprocessProfile,
    simulationSummary,
    camoticsInput,
    camoticsSimulationPlan,
    camoticsCliExecutionPlan,
    rotaryWrapPreviewReport,
    camHandoffQuality,
    postprocessTraceReport,
    camServerConfig: readJsonFile(join(workDir, "cam-server-config.json")),
    productionEvidenceDossier,
    ncStaticAnalysis,
    nativeCamReadiness,
    camEngineSelection: readJsonFile(join(workDir, "cam-engine-selection.json")),
    openSourceCamExecutionPlan: readJsonFile(join(workDir, "open-source-cam-execution-plan.json")),
    machineControllerProfile,
    machineAcceptanceChecklist: readJsonFile(join(workDir, "machine-acceptance-checklist.json")),
    controllerDialectReport,
    deliveryManifest
  });
  await writeFile(join(workDir, "machining-package-index.json"), JSON.stringify(machiningPackageIndex, null, 2), "utf8");
  await writeFile(join(workDir, "delivery-manifest.json"), JSON.stringify(deliveryManifest, null, 2), "utf8");
  await writeFile(join(workDir, "operator-download-checklist.md"), "# HeDiao3D V3 操作员下载核验清单\n\n更新中，请以最终 package-integrity.json 为准。\n", "utf8");
  let packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");
  await writeFile(join(workDir, "operator-download-checklist.md"), createOperatorDownloadChecklistMarkdown({
    job,
    deliveryManifest,
    packageIntegrity,
    productionGate,
    machineControllerProfile,
    camHandoffQuality,
    simulationSummary
  }), "utf8");
  packageIntegrity = createPackageIntegrityReport(job, deliveryManifest);
  await writeFile(join(workDir, "package-integrity.json"), JSON.stringify(packageIntegrity, null, 2), "utf8");

  return {
    summary: {
      adapterReport,
      neutralToolpathImportValidation: readJsonFile(join(workDir, "neutral-toolpath-import-validation.json")),
      toolpathSummary: readJsonFile(join(workDir, "toolpath-summary.json")),
      camHandoffQuality,
      camoticsInput,
      camoticsSimulationPlan,
      camoticsCliExecutionPlan,
      rotaryWrapPreviewReport,
      postprocessTraceReport,
      ncStaticAnalysis,
      controllerDialectReport,
      machineControllerProfile,
      simulation: simulationSummary,
      productionGate,
      postprocessProfile,
      toolSetupSheet,
      rotaryCalibrationSheet,
      productionUnlockMatrix,
      productionEvidenceDossier,
      openSourceCamExecutionPlan: readJsonFile(join(workDir, "open-source-cam-execution-plan.json")),
      machiningPackageIndex,
      deliveryManifest,
      packageIntegrity,
      points: toolpath.points.length,
      previewPoints: toolpath.previewPoints?.length ?? 0,
      estimatedMinutes: toolpath.estimatedMinutes,
      postProcessorName: toolpath.postProcessorName,
      warnings: toolpath.summary?.warnings ?? []
    }
  };
}

function createMachineAcceptanceRecord(job, checklist, input, packageIntegrity = null) {
  const now = new Date().toISOString();
  const checklistSteps = Array.isArray(checklist?.steps) ? checklist.steps : [];
  const submittedSteps = Array.isArray(input?.steps) ? input.steps : [];
  const downloadIntegrity = normalizeDownloadIntegrityEvidence(input?.downloadIntegrity, packageIntegrity);
  const submittedById = new Map(submittedSteps
    .filter((step) => step && typeof step === "object")
    .map((step) => [String(step.id ?? ""), step]));
  const steps = checklistSteps.map((template) => {
    const submitted = submittedById.get(String(template.id));
    let passed = normalizeBoolean(submitted?.passed ?? submitted?.ok);
    if (template.id === "verify-download-integrity" && passed === true) {
      passed = downloadIntegrity.allRequiredHashesVerified
        && downloadIntegrity.neverMachineConfirmed
        && downloadIntegrity.packageBinding?.status === "matched";
    }
    const status = passed === true
      ? "pass"
      : passed === false
        ? "failed"
        : template.required ? "review" : "not-checked";
    return {
      id: template.id,
      title: template.title,
      required: Boolean(template.required),
      status,
      passed: passed === true,
      file: template.file ?? null,
      expectedEvidence: template.expectedEvidence ?? null,
      evidenceNote: String(submitted?.evidenceNote ?? submitted?.notes ?? "").slice(0, 1000),
      measuredValue: submitted?.measuredValue ?? null,
      blocksProduction: Boolean(template.blocksProduction) && status !== "pass"
    };
  });
  const extraSteps = submittedSteps
    .filter((step) => step?.id && !steps.some((known) => known.id === String(step.id)))
    .slice(0, 20)
    .map((step) => {
      const passed = normalizeBoolean(step.passed ?? step.ok);
      return {
        id: String(step.id).slice(0, 120),
        title: String(step.title ?? step.id).slice(0, 200),
        required: false,
        status: passed === true ? "pass" : passed === false ? "failed" : "review",
        passed: passed === true,
        file: null,
        expectedEvidence: null,
        evidenceNote: String(step.evidenceNote ?? step.notes ?? "").slice(0, 1000),
        measuredValue: step.measuredValue ?? null,
        blocksProduction: false
      };
    });
  const allSteps = [...steps, ...extraSteps];
  const requiredSteps = allSteps.filter((step) => step.required);
  const failedRequired = requiredSteps.filter((step) => step.status !== "pass");
  const explicitOutcome = ["success", "review", "failed"].includes(input?.outcome) ? input.outcome : null;
  const outcome = explicitOutcome ?? (failedRequired.length === 0 && requiredSteps.length > 0 ? "success" : "review");
  const notes = String(input?.notes ?? "").trim().slice(0, 4000);
  return {
    schema: "hediao3d.machine-acceptance-record.v1",
    id: input?.id && /^[a-zA-Z0-9_.:-]+$/.test(String(input.id)) ? String(input.id) : randomUUID(),
    jobId: job.id,
    createdAt: now,
    source: String(input?.source ?? "frontend-machine-acceptance").slice(0, 80),
    outcome,
    operator: String(input?.operator ?? "").slice(0, 160),
    machineSerial: String(input?.machineSerial ?? "").slice(0, 160),
    fixtureType: String(input?.fixtureType ?? checklist?.operatorRecordTemplate?.fixtureType ?? "三轴控制器 + 旋转轴夹具").slice(0, 200),
    materialBatch: String(input?.materialBatch ?? "").slice(0, 200),
    programName: String(input?.programName ?? "toolpath.nc").slice(0, 200),
    downloadIntegrity,
    airRunOk: normalizeBoolean(input?.airRunOk),
    softTrialOk: normalizeBoolean(input?.softTrialOk),
    formalTrialOk: normalizeBoolean(input?.formalTrialOk),
    requiredStepCount: requiredSteps.length,
    passedRequiredCount: requiredSteps.length - failedRequired.length,
    failedRequiredSteps: failedRequired.map((step) => step.id),
    allRequiredPassed: requiredSteps.length > 0 && failedRequired.length === 0 && outcome === "success",
    steps: allSteps,
    notes,
    attachments: normalizeAcceptanceAttachments(input?.attachments, input?.photoName),
    recommendations: createMachineAcceptanceRecommendations({ outcome, failedRequired, steps: allSteps, checklist })
  };
}

function normalizeDownloadIntegrityEvidence(input, packageIntegrity = null) {
  const files = Array.isArray(input?.files) ? input.files : [];
  const normalizedFiles = files
    .map((file) => ({
      filename: String(file?.filename ?? "").slice(0, 160),
      sha256: typeof file?.sha256 === "string" ? file.sha256.trim().toLowerCase().slice(0, 128) : null,
      verified: Boolean(file?.verified),
      machineUseClass: typeof file?.machineUseClass === "string" ? file.machineUseClass.slice(0, 80) : null,
      note: typeof file?.note === "string" ? file.note.slice(0, 240) : null
    }))
    .filter((file) => file.filename);
  const requiredFilenames = ["toolpath.nc", "air-run.nc", "rotary-calibration-airrun.nc"];
  const packageBinding = createDownloadIntegrityPackageBinding(normalizedFiles, packageIntegrity, [
    ...requiredFilenames,
    "camotics-preview.nc"
  ]);
  const verifiedRequired = requiredFilenames.filter((filename) => {
    const submitted = normalizedFiles.find((file) => file.filename === filename);
    const bound = packageBinding.files?.find((file) => file.filename === filename);
    return Boolean(
      submitted?.verified
      && /^[a-f0-9]{64}$/.test(submitted.sha256 ?? "")
      && bound?.status === "matched"
    );
  });
  const neverMachineConfirmed = input?.neverMachineConfirmed === true
    || normalizedFiles.some((file) => {
      const bound = packageBinding.files?.find((item) => item.filename === "camotics-preview.nc");
      return file.filename === "camotics-preview.nc"
        && file.verified
        && file.machineUseClass === "simulation-only-never-machine"
        && (!bound || bound.status === "matched");
    });
  const allRequiredHashesVerified = requiredFilenames.every((filename) => verifiedRequired.includes(filename));
  return {
    schema: "hediao3d.download-integrity-evidence.v1",
    packageIntegrityReviewed: Boolean(input?.packageIntegrityReviewed),
    operatorChecklistReviewed: Boolean(input?.operatorChecklistReviewed),
    allRequiredHashesVerified,
    verifiedRequired,
    missingRequired: requiredFilenames.filter((filename) => !verifiedRequired.includes(filename)),
    neverMachineConfirmed,
    packageBinding,
    files: normalizedFiles,
    summary: allRequiredHashesVerified && neverMachineConfirmed && packageBinding.status === "matched"
      ? "关键 NC 文件 SHA-256 已与当前加工包匹配，且不可上机文件用途已确认。"
      : "下载包核验证据不完整。"
  };
}

function createDownloadIntegrityPackageBinding(submittedFiles, packageIntegrity, filenames) {
  const packageFiles = Array.isArray(packageIntegrity?.files) ? packageIntegrity.files : [];
  const expectedByName = new Map(packageFiles.map((file) => [file.filename, file]));
  const rows = filenames.map((filename) => {
    const submitted = submittedFiles.find((file) => file.filename === filename);
    const expected = expectedByName.get(filename);
    const expectedSha = typeof expected?.sha256 === "string" ? expected.sha256.toLowerCase() : null;
    const expectedMachineUseClass = expected?.machineUse?.class ?? null;
    const submittedSha = typeof submitted?.sha256 === "string" ? submitted.sha256.toLowerCase() : null;
    const issues = [];
    if (!packageIntegrity) issues.push("missing-package-integrity");
    if (!expected) issues.push("missing-expected-file");
    if (!submitted) issues.push("missing-submitted-file");
    if (expected && !expected.exists) issues.push("expected-file-not-generated");
    if (expectedSha && submittedSha && expectedSha !== submittedSha) issues.push("sha256-mismatch");
    if (expectedSha && !submittedSha) issues.push("missing-submitted-sha256");
    if (submitted && !submitted.verified) issues.push("not-marked-verified");
    if (expectedMachineUseClass && submitted?.machineUseClass && expectedMachineUseClass !== submitted.machineUseClass) issues.push("machine-use-mismatch");
    return {
      filename,
      status: issues.length === 0 ? "matched" : "mismatch",
      expectedSha256: expectedSha,
      submittedSha256: submittedSha,
      expectedMachineUseClass,
      submittedMachineUseClass: submitted?.machineUseClass ?? null,
      issues
    };
  });
  const mismatches = rows.filter((row) => row.status !== "matched");
  return {
    schema: "hediao3d.download-integrity-package-binding.v1",
    packageIntegrityJobId: packageIntegrity?.jobId ?? null,
    status: mismatches.length === 0 ? "matched" : "mismatch",
    matchedCount: rows.length - mismatches.length,
    mismatchCount: mismatches.length,
    files: rows,
    summary: mismatches.length === 0
      ? "验收提交的哈希与当前 package-integrity.json 完全匹配。"
      : `验收提交与当前加工包存在 ${mismatches.length} 个文件绑定问题。`
  };
}

function normalizeAcceptanceAttachments(attachments, photoName) {
  const normalized = Array.isArray(attachments)
    ? attachments.map((item) => String(item).slice(0, 240)).filter(Boolean)
    : [];
  if (photoName) normalized.push(String(photoName).slice(0, 240));
  return dedupeStrings(normalized).slice(0, 24);
}

function createMachineAcceptanceRecommendations({ outcome, failedRequired, steps, checklist }) {
  const recommendations = [];
  if (outcome !== "success") {
    recommendations.push("机床验收未达到成功状态，保持生产 NC 锁定，仅允许按门禁执行空跑或小料复核。");
  }
  if (failedRequired.length > 0) {
    recommendations.push(`优先复核未通过的必需项：${failedRequired.map((step) => step.title).join("、")}。`);
  }
  if (steps.some((step) => step.id === "air-run" && step.status !== "pass")) {
    recommendations.push("离料空跑未通过前不要装料加工；先确认 X/Y旋转/Z 方向、安全高度和夹具干涉。");
  }
  if (steps.some((step) => step.id === "verify-download-integrity" && step.status !== "pass")) {
    recommendations.push("先按 operator-download-checklist.md 核验 SHA-256 和文件用途，确认 camotics-preview.nc 等仿真文件不会上机。");
  }
  if (steps.some((step) => step.id === "soft-material-trial" && step.status !== "pass")) {
    recommendations.push("软材料或废料试雕未通过前，不要进入正式核胚试雕。");
  }
  if (steps.some((step) => step.id === "camotics-preview" && step.status !== "pass")) {
    recommendations.push("仿真/展开预览未确认前，应先补齐 CAMotics 或等效材料去除验证。");
  }
  if (outcome === "success" && failedRequired.length === 0) {
    recommendations.push("本次现场验收可作为生产证据之一；仍需结合真实 CAM、仿真和试雕反馈综合解锁。");
  }
  if (checklist?.unresolvedRisks?.length) {
    recommendations.push(`验收时仍需关注加工包遗留风险：${checklist.unresolvedRisks.slice(0, 3).join("；")}。`);
  }
  return dedupeStrings(recommendations);
}

function createTrialFeedbackRecord(job, input, packageIntegrity = null) {
  const summary = job.result?.summary ?? {};
  const now = new Date().toISOString();
  const settings = input?.settings && typeof input.settings === "object" ? input.settings : null;
  const outcome = ["success", "review", "failed"].includes(input?.outcome) ? input.outcome : "review";
  const downloadIntegrity = normalizeDownloadIntegrityEvidence(input?.downloadIntegrity, packageIntegrity);
  const actualMinutes = normalizePositiveNumber(input?.actualMinutes);
  const estimatedMinutes = normalizePositiveNumber(input?.estimatedMinutes ?? summary.estimatedMinutes);
  const timeRatio = actualMinutes && estimatedMinutes ? actualMinutes / estimatedMinutes : null;
  const issues = Array.isArray(input?.issues)
    ? input.issues.map((item) => String(item).trim()).filter(Boolean).slice(0, 24)
    : [];
  const notes = String(input?.notes ?? "").trim().slice(0, 4000);
  const settingsHash = settings ? sha256(JSON.stringify(settings)) : null;
  const photoName = input?.photoName ? String(input.photoName).slice(0, 240) : null;
  const photoAttached = Boolean(photoName || input?.photoAttached);
  return {
    schema: "hediao3d.trial-feedback-record.v1",
    id: input?.id && /^[a-zA-Z0-9_.:-]+$/.test(String(input.id)) ? String(input.id) : randomUUID(),
    jobId: job.id,
    createdAt: now,
    source: String(input?.source ?? "frontend-machine-feedback").slice(0, 80),
    phase: String(input?.phase ?? "soft-trial").slice(0, 80),
    outcome,
    machineName: String(input?.machineName ?? "").slice(0, 160),
    toolName: String(input?.toolName ?? "").slice(0, 160),
    materialName: String(input?.materialName ?? "").slice(0, 160),
    estimatedMinutes,
    actualMinutes,
    timeRatio,
    costEstimateRange: input?.costEstimateRange ? String(input.costEstimateRange).slice(0, 120) : null,
    issues,
    notes,
    photoName,
    photoAttached,
    downloadIntegrity,
    settingsHash,
    packageLevel: summary.productionGate?.level ?? summary.deliveryManifest?.packageLevel ?? null,
    resultEngine: job.result?.engine ?? null,
    camHandoffQualityLevel: summary.camHandoffQuality?.level ?? null,
    simulationEvidenceLevel: summary.productionGate?.simulationEvidence?.level ?? null,
    recommendations: createTrialFeedbackRecommendations({ outcome, issues, actualMinutes, estimatedMinutes, summary })
  };
}

function createTrialFeedbackRecommendations({ outcome, issues, actualMinutes, estimatedMinutes, summary }) {
  const recommendations = [];
  if (outcome === "success") {
    recommendations.push("保留当前参数为候选成功工艺；复雕前仍需核对刀具装夹和旋转夹具标定。");
  } else {
    recommendations.push("暂不把本次参数升级为生产参数；先复核刀具、夹具、CAM handoff 和仿真证据。");
  }
  if (actualMinutes && estimatedMinutes && actualMinutes > estimatedMinutes * 1.35) {
    recommendations.push("实际耗时明显高于估算，建议回看进给倍率、空走段和步距设置。");
  }
  if (actualMinutes && estimatedMinutes && actualMinutes < estimatedMinutes * 0.65) {
    recommendations.push("实际耗时明显低于估算，需确认是否漏跑刀路或控制器单位/进给解释不同。");
  }
  if (issues.some((item) => /欠切|纹理丢失|细节|浅/.test(item))) {
    recommendations.push("存在欠切/细节不足迹象，优先检查 Z 零点、最大切深、精加工步距和刀尖磨损。");
  }
  if (issues.some((item) => /过切|断刀|毛刺/.test(item))) {
    recommendations.push("存在过切/断刀/毛刺风险，建议降低单刀切深和进给，复核 4mm 25度平底尖刀伸出量。");
  }
  if (issues.some((item) => /端部|夹持|两端/.test(item))) {
    recommendations.push("端部或夹持区问题需要回到 rotary-calibration-sheet.json 复核夹持余量和不可达区域。");
  }
  if (issues.some((item) => /旋转|A轴|Y轴|错位/.test(item))) {
    recommendations.push("旋转错位优先复核每圈等效距离、旋转方向、Y/A 轴映射和反向间隙。");
  }
  if (summary.camHandoffQuality?.level && summary.camHandoffQuality.level !== "ready") {
    recommendations.push("CAM handoff 质量仍需复核，查看 cam-handoff-quality.json 后再扩大试雕。");
  }
  return dedupeStrings(recommendations);
}

function createProcessOptimizationPlan(job, record) {
  const summary = job.result?.summary ?? {};
  const sourceSettings = readJobSettings(job);
  const actions = [];
  const issueText = record.issues.join(" ");
  const outcome = record.outcome;
  const nextSettingsPatch = {};

  if (record.actualMinutes && record.estimatedMinutes) {
    if (record.timeRatio > 1.35) {
      actions.push(createOptimizationAction({
        id: "runtime-too-long",
        priority: "medium",
        target: "feed-stepover",
        reason: `实际耗时是估算的 ${record.timeRatio.toFixed(2)} 倍，需要减少空走或提高材料允许范围内的效率。`,
        recommendation: "先确认未漏跑空走；若表面质量可接受，下次试雕可将进给提高 5%-10% 或精加工步距提高 5%。"
      }));
      if (sourceSettings.feedRate) nextSettingsPatch.feedRate = roundClamp(Number(sourceSettings.feedRate) * 1.06, 30, 1200, 1);
    } else if (record.timeRatio < 0.65) {
      actions.push(createOptimizationAction({
        id: "runtime-too-short",
        priority: "high",
        target: "controller-units",
        reason: `实际耗时只有估算的 ${record.timeRatio.toFixed(2)} 倍，可能存在单位、进给解释或漏跑刀路问题。`,
        recommendation: "优先检查控制器单位、进给倍率、程序是否完整执行；不要因为耗时短而直接提高切深。"
      }));
    }
  }

  if (/欠切|浅|细节|纹理丢失/.test(issueText)) {
    actions.push(createOptimizationAction({
      id: "under-cut-detail-loss",
      priority: "high",
      target: "z-depth-finishing",
      reason: "反馈包含欠切或细节不足，优先从 Z 零点、刀尖和精加工密度排查。",
      recommendation: "复核 Z 零点和刀尖磨损；若确认机床正常，下次将精加工步距降低 5%-10%，不要一次性大幅加深。"
    }));
    if (sourceSettings.stepoverMm) nextSettingsPatch.stepoverMm = roundClamp(Number(sourceSettings.stepoverMm) * 0.92, 0.03, 2, 3);
    if (sourceSettings.stepoverDeg) nextSettingsPatch.stepoverDeg = roundClamp(Number(sourceSettings.stepoverDeg) * 0.92, 0.2, 30, 2);
  }

  if (/过切|断刀|毛刺/.test(issueText)) {
    actions.push(createOptimizationAction({
      id: "overcut-burr-tool-risk",
      priority: "high",
      target: "cut-depth-feed",
      reason: "反馈包含过切、毛刺或断刀风险，需要优先保护刀具和核胚。",
      recommendation: "下次试雕降低最大单刀切深 10%-15%，进给降低 5%-10%，并复核平底尖刀伸出量。"
    }));
    if (sourceSettings.maxCutDepth) nextSettingsPatch.maxCutDepth = roundClamp(Number(sourceSettings.maxCutDepth) * 0.88, 0.03, 2, 3);
    if (sourceSettings.feedRate) nextSettingsPatch.feedRate = roundClamp(Number(sourceSettings.feedRate) * 0.92, 30, 1200, 1);
  }

  if (/旋转|A轴|Y轴|错位|接缝/.test(issueText)) {
    actions.push(createOptimizationAction({
      id: "rotary-misalignment",
      priority: "critical",
      target: "rotary-calibration",
      reason: "反馈包含旋转错位，说明 Y/A 旋转映射、每圈距离或反向间隙可能不准。",
      recommendation: "先按 rotary-calibration-sheet.json 做 90/180/360 度标定；修正每圈等效距离后再重新生成刀路。"
    }));
  }

  if (/端部|夹持|两端|残料/.test(issueText)) {
    actions.push(createOptimizationAction({
      id: "end-hold-residue",
      priority: "medium",
      target: "hold-margin",
      reason: "反馈包含端部或夹持区问题，需要明确不可达区域和过渡区。",
      recommendation: "增大端部过渡区或夹持余量，检查刀路是否进入真实夹具不可达范围。"
    }));
    if (sourceSettings.endTransitionMm) nextSettingsPatch.endTransitionMm = roundClamp(Number(sourceSettings.endTransitionMm) * 1.15, 0, 8, 2);
  }

  if (outcome === "success") {
    actions.push(createOptimizationAction({
      id: "promote-success-profile",
      priority: "medium",
      target: "process-library",
      reason: "本次反馈标记为成功，可作为候选工艺参数沉淀。",
      recommendation: "保存为成功参数样本；至少再完成一次同材质复雕或更高价值材料试雕后，再申请生产门禁。"
    }));
  }

  if (summary.camHandoffQuality?.level && summary.camHandoffQuality.level !== "ready") {
    actions.push(createOptimizationAction({
      id: "handoff-quality-review",
      priority: "high",
      target: "cam-handoff",
      reason: `当前 CAM handoff 质量为 ${summary.camHandoffQuality.level}。`,
      recommendation: "先解决 cam-handoff-quality.json 的复核项，再扩大试雕范围。"
    }));
  }

  const uniqueActions = dedupeOptimizationActions(actions);
  return {
    schema: "hediao3d.process-optimization-plan.v1",
    jobId: job.id,
    feedbackRecordId: record.id,
    createdAt: new Date().toISOString(),
    status: outcome === "success" && uniqueActions.every((action) => action.priority !== "critical")
      ? "candidate-success-profile"
      : uniqueActions.some((action) => action.priority === "critical")
        ? "requires-calibration"
        : "requires-parameter-review",
    sourceEvidence: {
      trialFeedbackRecord: "trial-feedback-record.json",
      trialFeedbackLog: "trial-feedback-log.json",
      camHandoffQuality: "cam-handoff-quality.json",
      rotaryCalibration: "rotary-calibration-sheet.json",
      toolSetup: "tool-setup-sheet.json"
    },
    nextRunProfile: {
      mode: "suggested-patch-only",
      reason: "这些是下一次试雕建议值，不会自动覆盖当前参数。",
      settingsPatch: nextSettingsPatch,
      requiresRegeneration: Object.keys(nextSettingsPatch).length > 0 || uniqueActions.some((action) => action.target.includes("rotary") || action.target.includes("cam"))
    },
    actions: uniqueActions,
    summary: uniqueActions.length > 0
      ? `根据试雕反馈生成 ${uniqueActions.length} 条工艺优化动作。`
      : "本次反馈未触发参数调整动作；继续按操作员说明书复核。"
  };
}

function createOptimizationAction({ id, priority, target, reason, recommendation }) {
  return { id, priority, target, reason, recommendation };
}

function dedupeOptimizationActions(actions) {
  const byId = new Map();
  for (const action of actions) {
    if (!byId.has(action.id)) byId.set(action.id, action);
  }
  return [...byId.values()];
}

function readJobSettings(job) {
  const jobPath = job.workDir ? join(job.workDir, "job.json") : null;
  if (!jobPath || !existsSync(jobPath)) return {};
  const spec = readJsonFile(jobPath);
  return spec?.settings && typeof spec.settings === "object" ? spec.settings : {};
}

function roundClamp(value, min, max, digits) {
  const clamped = Math.max(min, Math.min(max, Number(value)));
  return Number(clamped.toFixed(digits));
}

async function writeTrialFeedbackGlobalRecord(record) {
  const recordDir = join(process.cwd(), "public", "orchestrator-trial-feedback", record.id);
  await mkdir(recordDir, { recursive: true });
  await writeFile(join(recordDir, "trial-feedback-record.json"), JSON.stringify(record, null, 2), "utf8");
}

async function writeMachineAcceptanceGlobalRecord(record) {
  const recordDir = join(process.cwd(), "public", "orchestrator-machine-acceptance", record.id);
  await mkdir(recordDir, { recursive: true });
  await writeFile(join(recordDir, "machine-acceptance-record.json"), JSON.stringify(record, null, 2), "utf8");
}

function normalizeBoolean(value) {
  if (value === true || value === "true" || value === "yes" || value === "pass" || value === 1) return true;
  if (value === false || value === "false" || value === "no" || value === "failed" || value === 0) return false;
  return null;
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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
  const camoticsCliPackageSummary = summary.camoticsCliPackage ?? null;
  const camoticsCliPackagePath = job.workDir ? join(job.workDir, "camotics-cli-run-package.json") : null;
  const camoticsCliPackageReportPath = job.workDir ? join(job.workDir, "camotics-cli-package-report.json") : null;
  const camoticsCliPackageReport = camoticsCliPackageReportPath && existsSync(camoticsCliPackageReportPath)
    ? readJsonFileSafe(camoticsCliPackageReportPath)
    : null;
  const camoticsCliPackageArtifactExists = Boolean(camoticsCliPackagePath && existsSync(camoticsCliPackagePath));
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
    allowAirRun: summary.productionGate?.allowAirRun ?? false,
    camoticsCliPackage: {
      artifactExists: camoticsCliPackageArtifactExists,
      status: camoticsCliPackageSummary?.status ?? camoticsCliPackageReport?.status ?? (camoticsCliPackageArtifactExists ? "ready-for-linux-camotics" : null),
      artifact: camoticsCliPackageSummary?.artifact ?? (camoticsCliPackageArtifactExists ? "camotics-cli-run-package.json" : null),
      report: camoticsCliPackageSummary?.report ?? (camoticsCliPackageReportPath && existsSync(camoticsCliPackageReportPath) ? "camotics-cli-package-report.json" : null),
      resultValidator: camoticsCliPackageSummary?.resultValidator ?? (job.workDir && existsSync(join(job.workDir, "camotics-result-validate.js")) ? "camotics-result-validate.js" : null),
      operatorChecklist: camoticsCliPackageSummary?.operatorChecklist ?? (job.workDir && existsSync(join(job.workDir, "camotics-linux-operator-checklist.md")) ? "camotics-linux-operator-checklist.md" : null),
      productionUnlockEligible: Boolean(camoticsCliPackageSummary?.productionUnlockEligible),
      motionLineCount: camoticsCliPackageSummary?.motionProfile?.motionLineCount
        ?? camoticsCliPackageReport?.preferredGcodeIdentity?.motionProfile?.motionLineCount
        ?? null
    }
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

function getOrchestratorTrialPackage(jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) {
    return json(res, 400, { error: "非法 job 路径" });
  }
  const workDir = join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  const manifest = readJsonFileSafe(join(workDir, "delivery-manifest.json"));
  if (!manifest?.files?.length) {
    return json(res, 404, { error: "找不到 delivery-manifest.json，请先运行 V3 小闭环" });
  }

  const trialFiles = manifest.files.filter((file) => isSafeTrialPackageDeliveryFile(file, manifest.allowTrialNc));
  const missing = trialFiles.filter((file) => !existsSync(join(workDir, file.filename)));
  if (missing.length > 0) {
    return json(res, 409, {
      error: "安全试雕包存在缺失文件，请重新运行 V3 小闭环",
      missing: missing.map((file) => file.filename)
    });
  }

  const packageManifest = createSafeTrialPackageManifest(safeJobId, manifest, trialFiles);
  const files = trialFiles.map((file) => ({
    name: `hediao3d-v3-trial/${file.kind}/${file.filename}`,
    content: readFileSync(join(workDir, file.filename))
  }));
  files.push({
    name: "hediao3d-v3-trial/safe-trial-package-manifest.json",
    content: JSON.stringify(packageManifest, null, 2)
  });
  files.push({
    name: "hediao3d-v3-trial/README-TRIAL.md",
    content: createSafeTrialPackageReadme(packageManifest)
  });

  const zip = createServerZipBuffer(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `hediao3d-v3-${safeJobId.slice(0, 8)}-safe-trial-${stamp}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(zip);
}

function getOrchestratorCamoticsLinuxPackage(jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) {
    return json(res, 400, { error: "非法 job 路径" });
  }
  const workDir = join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  const deliveryManifest = readJsonFileSafe(join(workDir, "delivery-manifest.json"));
  const packageIntegrity = readJsonFileSafe(join(workDir, "package-integrity.json"));
  const runPackage = readJsonFileSafe(join(workDir, "camotics-cli-run-package.json"));
  if (!deliveryManifest?.files?.length) {
    return json(res, 404, { error: "找不到 delivery-manifest.json，请先运行 V3 小闭环" });
  }
  if (!runPackage) {
    return json(res, 409, {
      error: "缺少 CAMotics Linux 运行包，请先生成仿真准备包",
      nextActions: [
        "调用 POST /api/orchestrator/jobs/:jobId/camotics-cli-package。",
        "确认 camotics-cli-run-package.json、camotics-result-template.json、camotics-result-validate.js 和 camotics-linux-operator-checklist.md 均存在。"
      ]
    });
  }

  const criticalFilenames = [
    "camotics-preview.nc",
    "camotics-project-template.json",
    "camotics-simulation-plan.json",
    "camotics-cli-execution-plan.json",
    "camotics-cli-run-package.json",
    "camotics-result-template.json",
    "camotics-linux-run.sh",
    "camotics-result-validate.js",
    "camotics-linux-operator-checklist.md"
  ];
  const optionalFilenames = [
    "camotics-input.json",
    "camotics-run.md",
    "camotics-cli-package-report.json",
    "toolpath.nc",
    "air-run.nc",
    "rotary-calibration-airrun.nc",
    "rotary-wrap-preview-report.json",
    "postprocess-trace-report.json",
    "machine-controller-profile.json",
    "package-integrity.json"
  ];
  const missingCritical = criticalFilenames.filter((filename) => !existsSync(join(workDir, filename)));
  if (missingCritical.length > 0) {
    return json(res, 409, {
      error: "CAMotics Linux 仿真包存在缺失文件，请重新生成仿真准备包",
      missing: missingCritical
    });
  }

  const packageFiles = [
    ...criticalFilenames.map((filename) => createCamoticsLinuxPackageFile(workDir, filename, true)),
    ...optionalFilenames
      .filter((filename) => existsSync(join(workDir, filename)))
      .map((filename) => createCamoticsLinuxPackageFile(workDir, filename, false))
  ];
  const packageManifest = createCamoticsLinuxPackageManifest(safeJobId, runPackage, deliveryManifest, packageIntegrity, packageFiles);
  const files = packageFiles.map((file) => ({
    name: `hediao3d-v3-camotics/${file.folder}/${file.filename}`,
    content: readFileSync(join(workDir, file.filename))
  }));
  files.push({
    name: "hediao3d-v3-camotics/camotics-linux-package-manifest.json",
    content: JSON.stringify(packageManifest, null, 2)
  });
  files.push({
    name: "hediao3d-v3-camotics/README-CAMOTICS.md",
    content: createCamoticsLinuxPackageReadme(packageManifest)
  });

  const zip = createServerZipBuffer(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `hediao3d-v3-${safeJobId.slice(0, 8)}-camotics-linux-${stamp}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(zip);
}

function getOrchestratorProductionPackage(jobId, res) {
  const safeJobId = decodeURIComponent(jobId);
  if (!/^[a-zA-Z0-9-]+$/.test(safeJobId)) {
    return json(res, 400, { error: "非法 job 路径" });
  }
  const workDir = join(process.cwd(), "public", "orchestrator-jobs", safeJobId);
  const manifest = readJsonFileSafe(join(workDir, "delivery-manifest.json"));
  const productionGate = readJsonFileSafe(join(workDir, "production-gate.json"));
  const evidenceDossier = readJsonFileSafe(join(workDir, "production-evidence-dossier.json"));
  const productionAudit = evidenceDossier?.crossChecks?.productionReadinessAudit ?? null;
  if (!manifest?.files?.length) {
    return json(res, 404, { error: "找不到 delivery-manifest.json，请先运行 V3 小闭环" });
  }
  if (!manifest.allowProductionNc || productionGate?.allowProductionNc !== true) {
    return json(res, 423, {
      error: "V3 正式生产包未解锁",
      packageLevel: manifest.packageLevel ?? productionGate?.level ?? "unknown",
      allowTrialNc: Boolean(manifest.allowTrialNc),
      allowProductionNc: false,
      summary: productionGate?.summary ?? "当前缺少 production-gate.json 或生产门禁未放行。",
      blockers: productionGate?.blockers ?? [],
      warnings: productionGate?.warnings ?? [],
      nextActions: productionGate?.recommendedWorkflow ?? [
        "完成真实外部 CAM 输出、非 synthetic CAMotics/等效材料去除仿真、空跑、试雕反馈和机床验收后重新生成。"
      ]
    });
  }
  if (evidenceDossier?.status !== "production-evidence-complete" || productionAudit?.allowProductionPackage !== true) {
    return json(res, 423, {
      error: "V3 正式生产包证据档案未闭环",
      packageLevel: manifest.packageLevel ?? productionGate?.level ?? "unknown",
      allowTrialNc: Boolean(manifest.allowTrialNc),
      allowProductionNc: false,
      dossierStatus: evidenceDossier?.status ?? "missing",
      productionReadinessAudit: productionAudit ?? null,
      summary: productionAudit?.summary ?? evidenceDossier?.summary ?? "缺少 production-evidence-dossier.json，无法证明真实 CAM、仿真、试雕反馈和机床验收均绑定同一加工包。",
      nextActions: [
        "完成真实外部 CAM 输出与非 synthetic CAMotics/等效材料去除仿真。",
        "下载同一 job 的安全试雕包，完成离料空跑和软料试雕。",
        "回填 trial-feedback-log.json 与 machine-acceptance-log.json，并确认 package-integrity 哈希匹配。",
        "重新请求生产包下载。"
      ]
    });
  }

  const productionFiles = manifest.files.filter(isProductionPackageDeliveryFile);
  const missing = productionFiles.filter((file) => !existsSync(join(workDir, file.filename)));
  if (missing.length > 0) {
    return json(res, 409, {
      error: "正式生产包存在缺失文件，请重新运行 V3 小闭环",
      missing: missing.map((file) => file.filename)
    });
  }

  const packageManifest = createProductionPackageManifest(safeJobId, manifest, productionGate, productionFiles);
  const files = productionFiles.map((file) => ({
    name: `hediao3d-v3-production/${file.kind}/${file.filename}`,
    content: readFileSync(join(workDir, file.filename))
  }));
  files.push({
    name: "hediao3d-v3-production/production-package-manifest.json",
    content: JSON.stringify(packageManifest, null, 2)
  });
  files.push({
    name: "hediao3d-v3-production/README-PRODUCTION.md",
    content: createProductionPackageReadme(packageManifest)
  });

  const zip = createServerZipBuffer(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `hediao3d-v3-${safeJobId.slice(0, 8)}-production-${stamp}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(zip);
}

function isSafeTrialPackageDeliveryFile(file, allowTrialNc) {
  if (!file?.downloadable) return false;
  if (file.filename === "toolpath.nc") return Boolean(allowTrialNc);
  if (file.machineUse?.class === "air-run-no-cut") return true;
  if (file.machineUse?.class === "simulation-only-never-machine") return false;
  return new Set([
    "machining-package-index.json",
    "production-gate.json",
    "production-unlock-matrix.json",
    "production-evidence-dossier.json",
    "delivery-manifest.json",
    "package-integrity.json",
    "next-action-checklist.md",
    "operator-runbook.md",
    "operator-download-checklist.md",
    "machine-controller-profile.json",
    "postprocess-profile.json",
    "postprocess-trace-report.json",
    "nc-static-analysis.json",
    "controller-dialect-report.json",
    "rotary-wrap-preview-report.json",
    "rotary-calibration-sheet.json",
    "tool-setup-sheet.json",
    "safe-trial-execution-plan.json",
    "machine-acceptance-checklist.json",
    "trial-feedback-template.json",
    "cam-handoff-evidence.md",
    "cam-handoff-quality.json",
    "camotics-input.json",
    "camotics-simulation-plan.json",
    "camotics-cli-execution-plan.json",
    "simulation-summary.json"
  ]).has(file.filename);
}

function isProductionPackageDeliveryFile(file) {
  if (!file?.downloadable || !file.exists) return false;
  if (file.machineUse?.class === "simulation-only-never-machine") return false;
  if (file.filename === "camotics-preview.nc") return false;
  return file.filename === "toolpath.nc"
    || file.machineUse?.class === "air-run-no-cut"
    || file.kind === "report"
    || file.kind === "model";
}

function createCamoticsLinuxPackageFile(workDir, filename, required) {
  const filePath = join(workDir, filename);
  const stat = statSync(filePath);
  const sha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const simulationInputs = new Set([
    "camotics-preview.nc",
    "camotics-project-template.json",
    "camotics-simulation-plan.json",
    "camotics-cli-execution-plan.json",
    "camotics-input.json",
    "camotics-run.md"
  ]);
  const runTools = new Set([
    "camotics-cli-run-package.json",
    "camotics-result-template.json",
    "camotics-linux-run.sh",
    "camotics-result-validate.js",
    "camotics-linux-operator-checklist.md",
    "camotics-cli-package-report.json"
  ]);
  const references = new Set([
    "toolpath.nc",
    "air-run.nc",
    "rotary-calibration-airrun.nc",
    "rotary-wrap-preview-report.json",
    "postprocess-trace-report.json",
    "machine-controller-profile.json",
    "package-integrity.json"
  ]);
  const folder = simulationInputs.has(filename)
    ? "inputs"
    : runTools.has(filename)
      ? "run"
      : references.has(filename)
        ? "references"
        : "extra";
  return {
    filename,
    folder,
    required,
    sizeBytes: stat.size,
    sha256,
    machineUse: {
      allowedOnMachine: false,
      class: filename === "camotics-preview.nc" ? "simulation-only-never-machine" : "linux-camotics-reference",
      summary: filename === "camotics-preview.nc"
        ? "展开三轴仿真 NC，禁止上机。"
        : "Linux CAMotics 仿真/回填参考文件，不是机床加工交付文件。"
    }
  };
}

function createSafeTrialPackageManifest(jobId, deliveryManifest, files) {
  return {
    schema: "hediao3d.v3-safe-trial-package.v1",
    jobId,
    createdAt: new Date().toISOString(),
    sourceManifest: "delivery-manifest.json",
    packageLevel: deliveryManifest.packageLevel ?? "unknown",
    allowTrialNc: Boolean(deliveryManifest.allowTrialNc),
    allowProductionNc: Boolean(deliveryManifest.allowProductionNc),
    policy: {
      toolpathNcIncluded: files.some((file) => file.filename === "toolpath.nc"),
      camoticsPreviewNcIncluded: false,
      productionUseAllowed: false,
      recommendedFirstCutFeedOverride: "30%-50%",
      machineModel: "三轴控制器 + Y轴旋转夹具",
      axisMapping: "X=长度方向，Y=旋转夹具，Z=刀深/安全高度"
    },
    files: files.map((file) => ({
      filename: file.filename,
      label: file.label,
      kind: file.kind,
      machineUse: file.machineUse,
      note: file.note
    })),
    excludedByPolicy: (deliveryManifest.files ?? [])
      .filter((file) => file.filename === "camotics-preview.nc" || file.machineUse?.class === "simulation-only-never-machine")
      .map((file) => ({
        filename: file.filename,
        reason: "simulation-only-never-machine"
      })),
    recommendedOrder: [
      "阅读 safe-trial-execution-plan.json、operator-runbook.md、operator-download-checklist.md 和 production-gate.json。",
      "运行 rotary-calibration-airrun.nc，确认 Y 轴旋转夹具方向和每圈距离。",
      "运行 air-run.nc，确认 X=长度方向，Y=旋转夹具，Z=安全高度。",
      "若本包包含 toolpath.nc，仅用于低风险试雕，首次建议 30%-50% 进给倍率。",
      "回填 trial-feedback-template.json 和 machine-acceptance-checklist.json。"
    ]
  };
}

function createProductionPackageManifest(jobId, deliveryManifest, productionGate, files) {
  return {
    schema: "hediao3d.v3-production-package.v1",
    jobId,
    createdAt: new Date().toISOString(),
    sourceManifest: "delivery-manifest.json",
    packageLevel: deliveryManifest.packageLevel ?? productionGate?.level ?? "unknown",
    allowTrialNc: Boolean(deliveryManifest.allowTrialNc),
    allowProductionNc: true,
    policy: {
      productionGateRequired: true,
      productionUseAllowed: true,
      toolpathNcIncluded: files.some((file) => file.filename === "toolpath.nc"),
      camoticsPreviewNcIncluded: false,
      machineModel: "三轴控制器 + Y轴旋转夹具",
      axisMapping: "X=长度方向，Y=旋转夹具，Z=刀深/安全高度",
      forbiddenOnMachineExcluded: true
    },
    productionGate: {
      level: productionGate?.level ?? null,
      summary: productionGate?.summary ?? null,
      blockers: productionGate?.blockers ?? [],
      warnings: productionGate?.warnings ?? []
    },
    files: files.map((file) => ({
      filename: file.filename,
      label: file.label,
      kind: file.kind,
      machineUse: file.machineUse,
      note: file.note
    })),
    excludedByPolicy: (deliveryManifest.files ?? [])
      .filter((file) => file.filename === "camotics-preview.nc" || file.machineUse?.class === "simulation-only-never-machine")
      .map((file) => ({
        filename: file.filename,
        reason: "simulation-only-never-machine"
      })),
    requiredBeforeRun: [
      "按 operator-download-checklist.md 核验 toolpath.nc、air-run.nc、rotary-calibration-airrun.nc 的 SHA-256。",
      "确认 production-gate.json 为 allowProductionNc=true。",
      "确认 machine-acceptance-log.json 和 trial-feedback-log.json 绑定当前 package-integrity。",
      "正式加工前仍建议保留 air-run.nc 与 rotary-calibration-airrun.nc 的现场记录。"
    ]
  };
}

function createCamoticsLinuxPackageManifest(jobId, runPackage, deliveryManifest, packageIntegrity, files) {
  const byName = new Map((packageIntegrity?.files ?? []).map((file) => [file.filename, file]));
  return {
    schema: "hediao3d.v3-camotics-linux-package.v1",
    jobId,
    createdAt: new Date().toISOString(),
    sourceManifest: "delivery-manifest.json",
    sourcePackageIntegrity: packageIntegrity?.schema ? "package-integrity.json" : null,
    packageLevel: deliveryManifest.packageLevel ?? "unknown",
    allowProductionNc: Boolean(deliveryManifest.allowProductionNc),
    policy: {
      productionUseAllowed: false,
      machineUseAllowed: false,
      purpose: "在 Linux CAM 服务器运行真实 CAMotics/等效材料去除仿真，并生成可回填证据。",
      machineModel: "三轴控制器 + Y轴旋转夹具",
      forbiddenOnMachine: files.map((file) => file.filename),
      requiredLocalValidation: "camotics-result-local-validation.json"
    },
    runPackage: {
      status: runPackage?.status ?? "unknown",
      preferredGcode: runPackage?.preferredGcodeIdentity?.filename ?? null,
      preferredGcodeSha256: runPackage?.preferredGcodeIdentity?.sha256 ?? null,
      motionProfile: runPackage?.preferredGcodeIdentity?.motionProfile ?? null,
      expectedOutputs: runPackage?.expectedOutputs ?? null,
      safetyLocks: runPackage?.safetyLocks ?? null
    },
    files: files.map((file) => ({
      ...file,
      matchesPackageIntegrity: byName.has(file.filename)
        ? byName.get(file.filename)?.sha256 === file.sha256
        : null
    })),
    requiredSequence: [
      "解压本包到 Linux CAM 服务器工作目录。",
      "阅读 run/camotics-linux-operator-checklist.md。",
      "核验 inputs/camotics-preview.nc 的 SHA-256 与 manifest 中 preferredGcodeSha256 一致。",
      "运行 run/camotics-linux-run.sh，或用 CAMotics/等效仿真打开 inputs/camotics-preview.nc。",
      "按 run/camotics-result-template.json 填写真实 camotics-result.json，并导出截图或材料去除 STL。",
      "运行 node run/camotics-result-validate.js camotics-result.json，生成 camotics-result-local-validation.json。",
      "将 camotics-result.json、camotics-result-local-validation.json 和截图/STL 回填到 HeDiao3D 当前 job。"
    ],
    importBack: {
      apiEndpoint: `/api/orchestrator/jobs/${jobId}/camotics-result`,
      requiredArtifacts: [
        "camotics-result.json",
        "camotics-result-local-validation.json",
        "camotics-preview.png 或 camotics-material-removal.stl"
      ]
    }
  };
}

function createSafeTrialPackageReadme(packageManifest) {
  const included = packageManifest.files.map((file) => `- ${file.filename}: ${file.label} / ${file.machineUse?.summary ?? file.note}`).join("\n");
  return [
    "# HeDiao3D V3 安全试雕包",
    "",
    `Job ID: ${packageManifest.jobId}`,
    `包级别: ${packageManifest.packageLevel}`,
    `允许试雕 NC: ${packageManifest.allowTrialNc ? "是" : "否"}`,
    `允许生产 NC: ${packageManifest.allowProductionNc ? "是" : "否"}`,
    "",
    "## 使用边界",
    "",
    "- 本包用于离料空跑、旋转夹具标定、低风险试雕和现场记录。",
    "- 本包不是正式生产包；正式生产 NC 必须由 production-gate 放行。",
    "- camotics-preview.nc 不会放入本包，因为它只用于 CAMotics 展开仿真，禁止上机。",
    packageManifest.policy.toolpathNcIncluded
      ? "- toolpath.nc 已放入本包，但仅可按试雕流程使用；首次建议 30%-50% 进给倍率。"
      : "- toolpath.nc 未放入本包；当前仅允许空跑、标定和报告复核。",
    "",
    "## 推荐顺序",
    "",
    ...packageManifest.recommendedOrder.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 文件清单",
    "",
    included || "- 无文件。"
  ].join("\n");
}

function createProductionPackageReadme(packageManifest) {
  const included = packageManifest.files.map((file) => `- ${file.filename}: ${file.label} / ${file.machineUse?.summary ?? file.note}`).join("\n");
  return [
    "# HeDiao3D V3 正式生产包",
    "",
    `Job ID: ${packageManifest.jobId}`,
    `包级别: ${packageManifest.packageLevel}`,
    "允许生产 NC: 是",
    "",
    "## 使用边界",
    "",
    "- 本包仅在 V3 production-gate 放行后由 Orchestrator 生成。",
    "- camotics-preview.nc 不会放入本包，因为它只用于 CAMotics 展开仿真，禁止上机。",
    "- 上机前仍需按 operator-download-checklist.md 核对 SHA-256 和文件用途。",
    "- 机床模型：三轴控制器 + Y轴旋转夹具；X=长度方向，Y=旋转夹具，Z=刀深/安全高度。",
    "",
    "## 上机前必做",
    "",
    ...packageManifest.requiredBeforeRun.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 文件清单",
    "",
    included || "- 无文件。",
    "",
    "## 门禁摘要",
    "",
    packageManifest.productionGate.summary ?? "production-gate.json 未提供摘要。"
  ].join("\n");
}

function createCamoticsLinuxPackageReadme(packageManifest) {
  const included = packageManifest.files
    .map((file) => `- ${file.folder}/${file.filename}: ${file.machineUse?.summary ?? "Linux CAMotics 文件"} / sha256=${file.sha256}`)
    .join("\n");
  return [
    "# HeDiao3D V3 CAMotics Linux 仿真包",
    "",
    `Job ID: ${packageManifest.jobId}`,
    `包级别: ${packageManifest.packageLevel}`,
    `首选仿真 NC: ${packageManifest.runPackage.preferredGcode ?? "missing"}`,
    `首选 NC SHA-256: ${packageManifest.runPackage.preferredGcodeSha256 ?? "missing"}`,
    "",
    "## 使用边界",
    "",
    "- 本包只用于 Linux CAM 服务器上的 CAMotics/等效材料去除仿真。",
    "- 本包内所有 NC 和脚本都不是正式上机加工文件。",
    "- `inputs/camotics-preview.nc` 是展开三轴仿真文件，禁止上机。",
    "- 正式生产 NC 下载仍由 `production-evidence-dossier.json` 和 `productionReadinessAudit` 锁定。",
    "",
    "## 执行顺序",
    "",
    ...packageManifest.requiredSequence.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 回填接口",
    "",
    `- ${packageManifest.importBack.apiEndpoint}`,
    "",
    "## 文件清单",
    "",
    included || "- 无文件。"
  ].join("\n");
}

function createServerZipBuffer(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.content)
      ? file.content
      : file.content instanceof Uint8Array
        ? Buffer.from(file.content)
        : Buffer.from(String(file.content), "utf8");
    const crc = crc32Buffer(data);
    const dosTime = dateToDosTimeParts(new Date());
    const localHeader = Buffer.concat([
      zipUint32(0x04034b50),
      zipUint16(20),
      zipUint16(0x0800),
      zipUint16(0),
      zipUint16(dosTime.time),
      zipUint16(dosTime.date),
      zipUint32(crc),
      zipUint32(data.length),
      zipUint32(data.length),
      zipUint16(nameBytes.length),
      zipUint16(0),
      nameBytes
    ]);
    chunks.push(localHeader, data);

    const centralHeader = Buffer.concat([
      zipUint32(0x02014b50),
      zipUint16(20),
      zipUint16(20),
      zipUint16(0x0800),
      zipUint16(0),
      zipUint16(dosTime.time),
      zipUint16(dosTime.date),
      zipUint32(crc),
      zipUint32(data.length),
      zipUint32(data.length),
      zipUint16(nameBytes.length),
      zipUint16(0),
      zipUint16(0),
      zipUint16(0),
      zipUint16(0),
      zipUint32(0),
      zipUint32(offset),
      nameBytes
    ]);
    centralDirectory.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = Buffer.concat([
    zipUint32(0x06054b50),
    zipUint16(0),
    zipUint16(0),
    zipUint16(files.length),
    zipUint16(files.length),
    zipUint32(centralSize),
    zipUint32(centralOffset),
    zipUint16(0)
  ]);
  return Buffer.concat([...chunks, ...centralDirectory, endRecord]);
}

function zipUint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff, 0);
  return bytes;
}

function zipUint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

function dateToDosTimeParts(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32Buffer(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
    detectFreeCadEngine(),
    detectBlenderCamEngine(),
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

function detectBlenderCamEngine() {
  if (String(process.env.HEDIAO3D_FORCE_BLENDERCAM_ADAPTER ?? "").toLowerCase() === "true") {
    const command = process.env.PYTHON ?? "python";
    return {
      id: "blendercam",
      name: "BlenderCAM / FabexCNC",
      role: "艺术曲面/浮雕 CAM adapter",
      available: true,
      adapterReady: true,
      command,
      version: "forced adapter contract mode",
      notes: "HEDIAO3D_FORCE_BLENDERCAM_ADAPTER=true，仅用于 adapter/Orchestrator 合约测试；生产环境必须安装真实 Blender + BlenderCAM/FabexCNC。"
    };
  }
  return detectCommandEngine({
    id: "blendercam",
    name: "BlenderCAM / FabexCNC",
    commands: ["blender"],
    role: "艺术曲面/浮雕 CAM adapter",
    adapterReady: true
  });
}

function detectFreeCadEngine() {
  if (String(process.env.HEDIAO3D_FORCE_FREECAD_ADAPTER ?? "").toLowerCase() === "true") {
    const command = process.env.PYTHON ?? "python";
    return {
      id: "freecad",
      name: "FreeCAD CAM",
      role: "专业 CAM job / Path Workbench adapter",
      available: true,
      adapterReady: true,
      command,
      version: "forced adapter contract mode",
      notes: "HEDIAO3D_FORCE_FREECAD_ADAPTER=true，仅用于 adapter/Orchestrator 合约测试；生产环境必须安装真实 FreeCADCmd/freecadcmd。"
    };
  }
  return detectCommandEngine({
    id: "freecad",
    name: "FreeCAD CAM",
    commands: ["FreeCADCmd", "freecadcmd", "FreeCAD", "freecad"],
    role: "专业 CAM job / Path Workbench adapter",
    adapterReady: true
  });
}

function detectOpenCamLibEngine() {
  if (String(process.env.HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER ?? "").toLowerCase() === "true") {
    const command = process.env.PYTHON ?? "python";
    return {
      id: "opencamlib",
      name: "OpenCAMLib",
      role: "底层刀具接触/drop-cutter 算法库 adapter",
      available: true,
      adapterReady: true,
      command,
      version: "forced adapter contract mode",
      notes: "HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER=true，仅用于 adapter/Orchestrator 合约测试；生产环境必须安装真实 OpenCAMLib/ocl。"
    };
  }

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
        adapterReady: true,
        command,
        version: String(probe.stdout ?? "").trim() || "python module detected",
        notes: "已检测到 Python OpenCAMLib 模块；adapter 可生成几何内核计划，真实 cutter-contact 输出仍需实验开关和服务器验证。"
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
    if (normalized.machineProfileId === "desktop-rotary-y-wrap") normalized.machineProfileId = "desktop-3axis-rotary-y";
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

function getCamStlMaxTriangles() {
  const configured = Number(process.env.ORCHESTRATOR_CAM_STL_MAX_TRIANGLES ?? 80000);
  if (!Number.isFinite(configured) || configured <= 0) return Infinity;
  return Math.max(1000, Math.floor(configured));
}

function geometryToAsciiStl(geometry, name = "hediao3d_mesh", options = {}) {
  let working = geometry;
  let disposeWorking = false;
  if (working.index) {
    working = working.toNonIndexed();
    disposeWorking = true;
  }
  const position = working.getAttribute("position");
  if (!position || position.count < 3) {
    if (disposeWorking) working.dispose();
    throw new Error("模型没有可导出的三角面。");
  }
  const originalTriangleCount = Math.floor(position.count / 3);
  const maxTriangles = Number(options.maxTriangles ?? Infinity);
  const selection = selectCamStlTriangleIndices(position, originalTriangleCount, maxTriangles);
  const selectedTriangles = selection.indices;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const lines = [`solid ${sanitizeStlName(name)}`];
  for (const triangleIndex of selectedTriangles) {
    const index = triangleIndex * 3;
    a.fromBufferAttribute(position, index);
    b.fromBufferAttribute(position, index + 1);
    c.fromBufferAttribute(position, index + 2);
    cb.subVectors(c, b);
    ab.subVectors(a, b);
    normal.crossVectors(cb, ab).normalize();
    if (!Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z)) {
      normal.set(0, 0, 0);
    }
    lines.push(
      `  facet normal ${formatStlNumber(normal.x)} ${formatStlNumber(normal.y)} ${formatStlNumber(normal.z)}`,
      "    outer loop",
      `      vertex ${formatStlNumber(a.x)} ${formatStlNumber(a.y)} ${formatStlNumber(a.z)}`,
      `      vertex ${formatStlNumber(b.x)} ${formatStlNumber(b.y)} ${formatStlNumber(b.z)}`,
      `      vertex ${formatStlNumber(c.x)} ${formatStlNumber(c.y)} ${formatStlNumber(c.z)}`,
      "    endloop",
      "  endfacet"
    );
  }
  lines.push(`endsolid ${sanitizeStlName(name)}`, "");
  if (disposeWorking) working.dispose();
  return {
    stl: lines.join("\n"),
    originalTriangleCount,
    exportedTriangleCount: selectedTriangles.length,
    decimated: selectedTriangles.length < originalTriangleCount,
    stride: selection.stride,
    maxTriangles: Number.isFinite(maxTriangles) ? maxTriangles : null,
    strategy: selection.strategy,
    baseKeptCount: selection.baseKeptCount,
    curvatureKeptCount: selection.curvatureKeptCount
  };
}

function selectCamStlTriangleIndices(position, triangleCount, maxTriangles) {
  if (!Number.isFinite(maxTriangles) || maxTriangles <= 0 || triangleCount <= maxTriangles) {
    return {
      indices: Array.from({ length: triangleCount }, (_value, index) => index),
      stride: 1,
      strategy: "full",
      baseKeptCount: triangleCount,
      curvatureKeptCount: 0
    };
  }
  const budget = Math.max(1, Math.floor(maxTriangles));
  const baseBudget = Math.max(1, Math.floor(budget * 0.55));
  const stride = Math.max(1, Math.ceil(triangleCount / baseBudget));
  const selected = new Set();
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += stride) {
    selected.add(triangleIndex);
  }
  const baseKeptCount = selected.size;
  const curvatureBudget = Math.max(0, budget - baseKeptCount);
  if (curvatureBudget <= 0) {
    return {
      indices: Array.from(selected).sort((a, b) => a - b),
      stride,
      strategy: "uniform-stride",
      baseKeptCount,
      curvatureKeptCount: 0
    };
  }
  const curvatureScores = computeTriangleCurvatureScores(position, triangleCount);
  const highCurvature = curvatureScores
    .filter((item) => !selected.has(item.index))
    .sort((a, b) => b.score - a.score)
    .slice(0, curvatureBudget);
  for (const item of highCurvature) selected.add(item.index);
  return {
    indices: Array.from(selected).sort((a, b) => a - b),
    stride,
    strategy: "uniform-plus-curvature",
    baseKeptCount,
    curvatureKeptCount: highCurvature.length
  };
}

function computeTriangleCurvatureScores(position, triangleCount) {
  const normals = [];
  const centers = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const index = triangleIndex * 3;
    a.fromBufferAttribute(position, index);
    b.fromBufferAttribute(position, index + 1);
    c.fromBufferAttribute(position, index + 2);
    const normal = cb.subVectors(c, b).cross(ab.subVectors(a, b)).normalize().clone();
    if (!Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z)) normal.set(0, 0, 0);
    normals.push(normal);
    centers.push(new THREE.Vector3(
      (a.x + b.x + c.x) / 3,
      (a.y + b.y + c.y) / 3,
      (a.z + b.z + c.z) / 3
    ));
  }
  const neighborWindow = 3;
  const scores = [];
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const normal = normals[triangleIndex];
    const center = centers[triangleIndex];
    let normalDelta = 0;
    let distancePenalty = 0;
    let samples = 0;
    const start = Math.max(0, triangleIndex - neighborWindow);
    const end = Math.min(triangleCount - 1, triangleIndex + neighborWindow);
    for (let neighborIndex = start; neighborIndex <= end; neighborIndex += 1) {
      if (neighborIndex === triangleIndex) continue;
      normalDelta += 1 - Math.max(-1, Math.min(1, normal.dot(normals[neighborIndex])));
      distancePenalty += center.distanceToSquared(centers[neighborIndex]);
      samples += 1;
    }
    const score = samples > 0
      ? normalDelta / samples + 1 / (1 + distancePenalty / samples)
      : 0;
    scores.push({ index: triangleIndex, score });
  }
  return scores;
}

function sanitizeStlName(name) {
  return String(name ?? "mesh").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "mesh";
}

function formatStlNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1e-9) return "0";
  return Number(value).toFixed(6).replace(/\.?0+$/, "");
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
