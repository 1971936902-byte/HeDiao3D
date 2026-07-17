#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_REPAIR_HANDOFF_PORT ?? 8798);
const baseUrl = `http://127.0.0.1:${port}`;
const importedModelName = `v3-repair-source-open-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = `/imported-models/${importedModelName}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-repair-artifact-handoff-"));
const repairedModelPath = join(fixtureDir, "server-repaired-model.stl");
const camoticsFixturePath = join(fixtureDir, "camotics-repair-result-fixture.json");
const runnerPath = resolve("adapters", "opencamlib", "opencamlib_runner.py");

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  depthMm: 1.25,
  meshU: 180,
  meshV: 120,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  leftHoldMm: 2,
  rightHoldMm: 2,
  toolDiameter: 4,
  stepoverDeg: 5,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-rotary-y-wrap",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  meshLengthAxis: "auto",
  meshAxisReverse: false,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "rotary-y-wrap"
};

let server;

async function main() {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
  writeFileSync(importedModelPath, createOpenAsciiStl());
  writeClosedReliefStl(repairedModelPath);
  writeCamoticsFixture(camoticsFixturePath);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      ORCHESTRATOR_REPAIRED_MODEL_PATH: repairedModelPath,
      HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER: "true",
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", runnerPath]),
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "8",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "10",
      HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN: "true",
      HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT: "false",
      HEDIAO3D_CAMOTICS_RESULT_JSON: camoticsFixturePath
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stdout.write(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    if (process.env.V3_TEST_VERBOSE) process.stderr.write(chunk);
  });

  await waitForHealth();
  const created = await postJson("/api/orchestrator/jobs", {
    modelUrl,
    settings,
    engine: "opencamlib"
  });
  const job = await waitForJob(created.id, Date.now());
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.selectedEngine === "opencamlib", `selectedEngine expected opencamlib, got ${job.selectedEngine}`);
  assert(job.result?.engine === "opencamlib", `result engine expected opencamlib, got ${job.result?.engine}`);

  const meshQuality = await getArtifactJson(job.id, "mesh-quality.json");
  assert(meshQuality.verdict === "repair", `source open STL should require repair, got ${meshQuality.verdict}`);
  assert(meshQuality.boundaryEdges > 0, "source open STL should have boundary edges");

  const repairExecution = await getArtifactJson(job.id, "repair-execution.json");
  assert(repairExecution.status === "external-repair-imported", `repair execution should import external STL, got ${repairExecution.status}`);
  assert(repairExecution.importedRepair?.imported === true, "repair execution should record imported repair artifact");
  assert(repairExecution.outputs?.some((candidate) => candidate.id === "repairedStl" && candidate.exists), "repaired STL candidate should exist");
  assert(repairExecution.repairedMeshQuality?.verdict === "ready", `repaired mesh should be ready, got ${repairExecution.repairedMeshQuality?.verdict}`);

  const repairedQuality = await getArtifactJson(job.id, "repaired-mesh-quality.json");
  assert(repairedQuality.verdict === "ready", `repaired mesh quality artifact should be ready, got ${repairedQuality.verdict}`);
  assert(repairedQuality.boundaryEdges === 0, "repaired mesh should not have boundary edges");

  const camInputPlan = await getArtifactJson(job.id, "cam-input-plan.json");
  assert(camInputPlan.status === "review", `repaired source should enter review, got ${camInputPlan.status}`);
  assert(camInputPlan.modelSelection?.selectedModelId === "repairedStl", `expected repairedStl selection, got ${camInputPlan.modelSelection?.selectedModelId}`);
  assert(camInputPlan.selectedModelPath?.endsWith("repaired-model.stl"), "CAM input should select repaired-model.stl");

  const adapterJob = await getArtifactJson(job.id, "job.json");
  assert(String(adapterJob.modelPath).endsWith("repaired-model.stl"), "adapter job should receive repaired model path");

  const kernelPlan = await getArtifactJson(job.id, "opencamlib-kernel-plan.json");
  assert(String(kernelPlan.model?.path).endsWith("repaired-model.stl"), "OpenCAMLib plan should use repaired model path");

  const neutralToolpath = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutralToolpath.generatedByExternalCommand === true, "neutral output should record external command generation");
  assert(neutralToolpath.runner?.heightfield?.missCount === 0, "heightfield runner should sample repaired closed STL");

  const camHandoffQuality = await getArtifactJson(job.id, "cam-handoff-quality.json");
  assert(camHandoffQuality.previewScaffold === true, "repaired heightfield handoff should remain preview scaffold until real cutter-contact CAM is wired");
  assert((camHandoffQuality.requiredActions ?? []).some((item) => /刀具接触|heightfield|scaffold|真实/i.test(item)), "handoff quality should require replacing preview scaffold with real CAM output");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowAirRun === true, "repaired handoff should allow air-run");
  assert(productionGate.allowTrialNc === true, `repaired handoff should allow trial NC; blockers: ${(productionGate.blockers ?? []).join("; ")}`);
  assert(productionGate.allowProductionNc === false, "unverified repaired STL must not unlock production NC");
  assert((productionGate.warnings ?? []).some((item) => /修复产物|修复后模型|repaired/i.test(item)), "production gate should warn about repaired model verification");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.filesByPurpose?.reports?.some((file) => file.filename === "repaired-mesh-quality.json"), "package index should include repaired mesh quality report");

  const deliveryManifest = await getArtifactJson(job.id, "delivery-manifest.json");
  assert(deliveryManifest.files?.some((file) => file.filename === "repaired-mesh-quality.json" && file.downloadable), "delivery manifest should expose repaired mesh quality report");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    sourceVerdict: meshQuality.verdict,
    boundaryEdges: meshQuality.boundaryEdges,
    repairStatus: repairExecution.status,
    repairedVerdict: repairedQuality.verdict,
    selectedModel: camInputPlan.modelSelection.selectedModelId,
    resultEngine: job.result.engine,
    trial: productionGate.allowTrialNc,
    production: productionGate.allowProductionNc
  }, null, 2));
}

function createOpenAsciiStl() {
  return `solid open_source
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 38 0 1
      vertex 0 15 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 38 0 1
      vertex 38 15 1
      vertex 0 15 0
    endloop
  endfacet
endsolid open_source
`;
}

function writeCamoticsFixture(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    synthetic: false,
    status: "completed",
    riskLevel: "ready",
    summary: "Imported non-synthetic CAMotics fixture for repaired STL CAM-input handoff.",
    metrics: {
      motionLineCount: 64,
      zMin: -1.2,
      zMax: 22,
      materialRemovedMm3: 7.2,
      fitRate: 99.3,
      missCount: 0,
      estimatedMinutes: 1.8
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl",
      note: "Fixture validates repaired model selection and external adapter handoff."
    }
  }, null, 2));
}

function writeClosedReliefStl(filePath) {
  const nx = 40;
  const ny = 30;
  const length = 38;
  const width = 15;
  const baseZ = -13.2;
  const facets = [];
  const top = (i, j) => {
    const x = (length * i) / nx;
    const y = (width * j) / ny;
    const u = i / nx;
    const v = j / ny;
    const dome = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    return [round(x), round(y), round(0.25 + dome)];
  };
  const bottom = (i, j) => [round((length * i) / nx), round((width * j) / ny), baseZ];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      addQuad(facets, top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
      addQuad(facets, bottom(i + 1, j), bottom(i, j), bottom(i, j + 1), bottom(i + 1, j + 1));
    }
  }
  for (let i = 0; i < nx; i += 1) {
    addQuad(facets, bottom(i, 0), bottom(i + 1, 0), top(i + 1, 0), top(i, 0));
    addQuad(facets, bottom(i + 1, ny), bottom(i, ny), top(i, ny), top(i + 1, ny));
  }
  for (let j = 0; j < ny; j += 1) {
    addQuad(facets, bottom(0, j + 1), bottom(0, j), top(0, j), top(0, j + 1));
    addQuad(facets, bottom(nx, j), bottom(nx, j + 1), top(nx, j + 1), top(nx, j));
  }
  writeFileSync(filePath, `solid repaired_closed_relief\n${facets.join("")}endsolid repaired_closed_relief\n`);
}

function addQuad(facets, a, b, c, d) {
  addFacet(facets, a, b, c);
  addFacet(facets, a, c, d);
}

function addFacet(facets, a, b, c) {
  facets.push(`  facet normal 0 0 1
    outer loop
      vertex ${a[0]} ${a[1]} ${a[2]}
      vertex ${b[0]} ${b[1]} ${b[2]}
      vertex ${c[0]} ${c[1]} ${c[2]}
    endloop
  endfacet
`);
}

function round(value) {
  return Number(value.toFixed(6));
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    try {
      await getJson("/api/health");
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`server did not become healthy on ${baseUrl}`);
}

async function waitForJob(jobId, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const job = await getJson(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return job;
    await sleep(1000);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms`);
}

async function getArtifactJson(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok || response.status === 202, `${path} failed: ${response.status} ${data.error ?? ""}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server && !server.killed) server.kill();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(importedModelPath, { force: true });
  });
