#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

let baseUrl;
let server;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-rotary-neutral-handoff-"));
const camoticsFixturePath = join(fixtureDir, "camotics-rotary-result-fixture.json");
const importedModelName = `v3-rotary-neutral-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = `/imported-models/${importedModelName}`;

const settings = {
  lengthMm: 30,
  diameterMm: 12,
  blankLeftDiameterMm: 11.5,
  blankLeftMidDiameterMm: 12,
  blankCenterDiameterMm: 12,
  blankRightMidDiameterMm: 12,
  blankRightDiameterMm: 11.5,
  depthMm: 1.2,
  reliefAngleDeg: 360,
  contrast: 1.2,
  smoothPasses: 1,
  invertDepth: false,
  meshU: 96,
  meshV: 64,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 18,
  leftHoldMm: 1,
  rightHoldMm: 1,
  endTransitionMm: 0.8,
  toolDiameter: 4,
  stepoverDeg: 5,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-rotary-y",
  camMode: "rotaryWrap",
  rotaryOutputAxis: "Y",
  rotaryWrapPerRevolutionMm: 100,
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "wrapY"
};

async function main() {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
  writeFileSync(importedModelPath, createRotaryReliefStl(), "utf8");
  writeCamoticsFixture(camoticsFixturePath);

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHON: process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_OPENCAMLIB_ADAPTER: "true",
      HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT: "false",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW: "true",
      HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_PREVIEW: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "33",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "7",
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

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `adapter report expected completed, got ${adapterReport.status}`);
  assert(adapterReport.metrics?.opencamlib?.rotaryHeightfieldPreviewEnabled === true, "adapter should expose rotary heightfield preview flag");
  assert(adapterReport.metrics?.neutralToolpath?.autoRunner === true, "adapter should use bundled runner");
  assert(adapterReport.metrics?.neutralToolpath?.heightfieldPreview === true, "adapter should classify rotary heightfield as heightfield preview");
  assert(adapterReport.metrics?.neutralToolpath?.previewScaffold === true, "rotary preview must remain scaffold");

  const neutral = await getArtifactJson(job.id, "neutral-toolpath.json");
  assert(neutral.experimentalRotaryHeightfield === true, "neutral should mark rotary heightfield mode");
  assert(neutral.runner?.mode === "stl-rotary-heightfield-preview", "neutral runner mode should be rotary heightfield");
  assert(neutral.runner?.heightfield?.rotaryEnvelope === true, "neutral should mark rotary envelope");
  assert(neutral.runner?.heightfield?.cutterEnvelope === true, "neutral should include cutter envelope");
  assert(neutral.runner?.heightfield?.cutterRadiusMm === 2, "4mm cutter should use 2mm radius");
  assert(neutral.runner?.heightfield?.missCount === 0, `rotary model should have no misses, got ${neutral.runner?.heightfield?.missCount}`);
  assert(neutral.cutterContactReport?.schema === "hediao3d.opencamlib-cutter-contact-report.v1", "neutral should embed OpenCAMLib contact report");
  assert(neutral.cutterContactReport.quality?.previewScaffold === true, "rotary heightfield contact report must stay preview scaffold");
  assert(neutral.cutterContactReport.quality?.productionCandidate === false, "rotary heightfield contact report must not be production candidate");
  assert(neutral.cutterContactReport.inputIdentity?.sourceNeutralToolpathSha256, "contact report should bind neutral hash");
  assert(Array.isArray(neutral.points) && neutral.points.length === 231, `expected 231 rotary neutral points, got ${neutral.points?.length}`);

  const envelope = await getArtifactJson(job.id, "opencamlib-cutter-envelope-report.json");
  assert(envelope.mode === "stl-rotary-heightfield-preview", "envelope report should use rotary mode");
  assert(envelope.sampling?.rotaryEnvelope === true, "envelope report should mark rotary envelope");
  assert(envelope.rotaryEnvelope?.cutterEnvelopeLiftMaxMm > 0, "envelope report should expose cutter lift");
  assert(envelope.quality?.productionCandidate === false, "rotary preview envelope must not be production candidate");
  const contact = await getArtifactJson(job.id, "opencamlib-cutter-contact-report.json");
  assert(contact.quality?.previewScaffold === true, "contact artifact should classify preview scaffold");
  assert(contact.quality?.productionCandidate === false, "contact artifact must not be production candidate");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.source === "external-adapter", "toolpath should come from external adapter");
  assert(toolpathSummary.sequencingReport === "toolpath-sequencing-report.json", "toolpath summary should reference sequencing report");
  assert(toolpathSummary.externalSourceSnapshot?.neutral?.runner?.heightfieldMode === true, "source snapshot should classify heightfield");

  const sequencing = await getArtifactJson(job.id, "toolpath-sequencing-report.json");
  assert(sequencing.mode === "rotary-wrap-boustrophedon", "rotary neutral should be sequenced by row");
  assert(sequencing.output?.rowCount === 32, `expected 32 rotary rows after 0/360 seam merge, got ${sequencing.output?.rowCount}`);
  assert(sequencing.output?.pointCount === neutral.points.length, "sequencing point count should match neutral points");

  const machineFit = await getArtifactJson(job.id, "neutral-toolpath-import-validation.json");
  assert(machineFit.machineFit?.coverage?.rotarySpanDeg >= 340, "machine-fit should cover near full revolution");
  assert(machineFit.machineFit?.targetMachine?.rotaryOutputAxis === "Y", "machine-fit should target Y rotary fixture");
  assert(machineFit.cutterContactReport?.status === "preview-scaffold", "preview contact report should not become production candidate");

  const gcode = await getArtifactText(job.id, "toolpath.nc");
  assert(gcode.includes("ROTARY_WRAP_AXIS=Y"), "machine NC should declare Y rotary wrap");
  assert(/\bY\d/.test(gcode), "machine NC should contain Y rotary moves");
  assert(!/\bA-?\d/.test(gcode), "wrapY NC should not emit A-axis moves");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowProductionNc === false, "rotary preview must not unlock production");
  assert(productionGate.allowTrialNc === false, "preview scaffold should not unlock trial NC");
  assert(productionGate.allowAirRun === true, "static-valid rotary preview should allow air-run");

  const packageIndex = await getArtifactJson(job.id, "machining-package-index.json");
  assert(packageIndex.filesByPurpose?.readFirst?.some((file) => file.filename === "toolpath-sequencing-report.json"), "package index should include sequencing report in read-first files");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    neutralMode: neutral.runner.mode,
    neutralPoints: neutral.points.length,
    rows: sequencing.output.rowCount,
    cutterRadiusMm: neutral.runner.heightfield.cutterRadiusMm,
    production: productionGate.allowProductionNc,
    trial: productionGate.allowTrialNc,
    airRun: productionGate.allowAirRun
  }, null, 2));
}

function writeCamoticsFixture(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    synthetic: false,
    status: "completed",
    riskLevel: "ready",
    summary: "Imported non-synthetic CAMotics fixture for rotary neutral handoff contract.",
    inputs: {
      preferredGcode: "camotics-preview.nc",
      motionLineCount: 231
    },
    metrics: {
      motionLineCount: 231,
      zMin: -1.2,
      zMax: 18,
      materialRemovedMm3: 6.2,
      fitRate: 99.2,
      missCount: 0,
      estimatedMinutes: 1.8
    }
  }, null, 2));
}

function createRotaryReliefStl() {
  const xs = [0, 5, 10, 15, 20, 25, 30];
  const segments = 32;
  const vertices = [];
  for (let xi = 0; xi < xs.length; xi += 1) {
    const x = xs[xi];
    const xT = xi / (xs.length - 1);
    const ring = [];
    for (let ai = 0; ai < segments; ai += 1) {
      const angle = (Math.PI * 2 * ai) / segments;
      const relief = 0.75 * Math.sin(Math.PI * xT) * Math.max(0, Math.cos(angle));
      const radius = 5 + relief;
      ring.push([x, Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    vertices.push(ring);
  }

  const facets = [];
  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let ai = 0; ai < segments; ai += 1) {
      const next = (ai + 1) % segments;
      facets.push([vertices[xi][ai], vertices[xi + 1][ai], vertices[xi + 1][next]]);
      facets.push([vertices[xi][ai], vertices[xi + 1][next], vertices[xi][next]]);
    }
  }
  return `solid rotary_relief\n${facets.map(formatFacet).join("")}endsolid rotary_relief\n`;
}

function formatFacet([a, b, c]) {
  return `  facet normal 0 0 0
    outer loop
      vertex ${a[0].toFixed(6)} ${a[1].toFixed(6)} ${a[2].toFixed(6)}
      vertex ${b[0].toFixed(6)} ${b[1].toFixed(6)} ${b[2].toFixed(6)}
      vertex ${c[0].toFixed(6)} ${c[1].toFixed(6)} ${c[2].toFixed(6)}
    endloop
  endfacet
`;
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

async function getArtifactText(jobId, filename) {
  const response = await fetch(`${baseUrl}/api/orchestrator/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`);
  const text = await response.text();
  assert(response.ok, `artifact ${filename} failed: ${response.status} ${text}`);
  return text;
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

async function getFreePort() {
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const address = portServer.address();
  const port = typeof address === "object" && address ? address.port : null;
  portServer.close();
  await once(portServer, "close");
  if (!port) throw new Error("Could not allocate a local API port.");
  return port;
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
