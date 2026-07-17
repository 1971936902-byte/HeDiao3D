#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.V3_FREECAD_PROOF_HANDOFF_PORT ?? 8797);
const baseUrl = `http://127.0.0.1:${port}`;
const importedModelName = `v3-freecad-proof-${Date.now()}.stl`;
const importedModelPath = resolve("public", "imported-models", importedModelName);
const modelUrl = `/imported-models/${importedModelName}`;
const timeoutMs = Number(process.env.V3_SMOKE_TIMEOUT_MS ?? 120000);
const fixtureDir = mkdtempSync(join(tmpdir(), "hediao3d-freecad-proof-handoff-"));
const camoticsFixturePath = join(fixtureDir, "camotics-freecad-proof-result.json");
const proofRunnerPath = join(fixtureDir, "freecad-proof-runner.py");

const settings = {
  lengthMm: 38,
  diameterMm: 15,
  depthMm: 1.25,
  meshU: 120,
  meshV: 80,
  spindleRpm: 12000,
  feedRate: 180,
  safeZ: 22,
  toolDiameter: 4,
  stepoverMm: 0.28,
  toolProfileId: "vflat-4mm-25deg",
  materialProfileId: "olive-core",
  machineProfileId: "desktop-3axis-relief",
  camMode: "3axis",
  rotaryOutputAxis: "Y",
  maxCutDepth: 0.45,
  stockAllowance: 0.08,
  finishingStrategy: "x-scan",
  generationMode: "active",
  postProcessor: "generic-3axis"
};

let server;

async function main() {
  writeClosedReliefStl(importedModelPath);
  writeCamoticsFixture(camoticsFixturePath);
  writeProofRunner(proofRunnerPath);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      ENABLE_EXTERNAL_CAM_ADAPTERS: "true",
      HEDIAO3D_FORCE_FREECAD_ADAPTER: "true",
      HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT: "true",
      HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON: JSON.stringify([process.env.PYTHON ?? "python", proofRunnerPath]),
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
    engine: "freecad"
  });
  const job = await waitForJob(created.id, Date.now());
  assert(job.status === "completed", `job did not complete: ${job.status}`);
  assert(job.selectedEngine === "freecad", `selectedEngine expected freecad, got ${job.selectedEngine}`);
  assert(job.result?.engine === "freecad", `result engine expected freecad, got ${job.result?.engine}`);

  const adapterReport = await getArtifactJson(job.id, "adapter-report.json");
  assert(adapterReport.status === "completed", `adapter report expected completed, got ${adapterReport.status}`);
  assert(adapterReport.metrics?.handoffEvidence?.classification === "production-candidate", `proof-backed FreeCAD should be production-candidate, got ${adapterReport.metrics?.handoffEvidence?.classification}`);
  assert(adapterReport.metrics?.handoffEvidence?.productionCandidate === true, "proof-backed FreeCAD should expose productionCandidate=true");
  assert(adapterReport.metrics?.handoffEvidence?.camOutputProof?.status === "production-candidate", "CAM output proof should validate as production-candidate");

  const toolpathSummary = await getArtifactJson(job.id, "toolpath-summary.json");
  assert(toolpathSummary.engine === "freecad", "toolpath summary engine should be freecad");
  assert(toolpathSummary.source === "external-adapter", "toolpath should come from external adapter");
  assert(toolpathSummary.externalSourceSnapshot?.kind === "gcode", "toolpath summary should snapshot G-code source");
  assert(toolpathSummary.externalSourceSnapshot.gcode?.containsFixtureMarker === false, "proof-backed G-code must not carry fixture marker");
  assert(toolpathSummary.externalSourceSnapshot.gcode?.containsPreviewScaffoldMarker === false, "proof-backed G-code must not carry preview/scaffold marker");

  const gcodeImportValidation = await getArtifactJson(job.id, "external-gcode-import-validation.json");
  assert(gcodeImportValidation.status === "bound-production-candidate", `proof-backed G-code should be bound-production-candidate, got ${gcodeImportValidation.status}`);
  assert(gcodeImportValidation.productionCandidate === true, "G-code import validation should preserve productionCandidate=true");
  assert(gcodeImportValidation.sourceBinding?.sourceSnapshot?.matchesSourceArtifact === true, "source snapshot should match proof-backed G-code source");
  assert(gcodeImportValidation.sourceBinding?.sourceSnapshot?.matchesPostprocessArtifact === true, "source snapshot should match final toolpath.nc");
  assert(gcodeImportValidation.camOutputProof?.declaredGcodeSha256 === gcodeImportValidation.camOutputProof?.gcodeSha256, "proof declared G-code hash should match actual hash");
  assert(gcodeImportValidation.camOutputProof?.declaredModelSha256 === gcodeImportValidation.camOutputProof?.modelSha256, "proof declared model hash should match actual model");
  assert(gcodeImportValidation.camOutputProof?.declaredPlanSha256 === gcodeImportValidation.camOutputProof?.planSha256, "proof declared plan hash should match actual plan");

  const camHandoffQuality = await getArtifactJson(job.id, "cam-handoff-quality.json");
  assert(camHandoffQuality.adapterHandoffEvidence?.classification === "production-candidate", "CAM handoff should preserve proof-backed classification");
  assert(camHandoffQuality.synthetic === false, "proof-backed handoff should not be synthetic");
  assert(camHandoffQuality.importedFixture === false, "proof-backed handoff should not be fixture");
  assert(camHandoffQuality.previewScaffold === false, "proof-backed handoff should not be preview scaffold");

  const unlockMatrix = await getArtifactJson(job.id, "production-unlock-matrix.json");
  const gcodeUnlockRow = unlockMatrix.rows?.find((row) => row.id === "external-gcode-import-validation");
  assert(gcodeUnlockRow, "production unlock matrix should include external G-code validation row");
  assert(gcodeUnlockRow.status === "pass", `proof-backed G-code unlock row should pass, got ${gcodeUnlockRow.status}`);
  assert(/productionCandidate=yes/.test(gcodeUnlockRow.summary), "G-code unlock row should expose productionCandidate=yes");

  const evidenceDossier = await getArtifactJson(job.id, "production-evidence-dossier.json");
  const gcodeEvidenceItem = evidenceDossier.evidenceItems?.find((item) => item.id === "external-gcode-import-validation");
  assert(gcodeEvidenceItem, "production evidence dossier should include external G-code validation item");
  assert(gcodeEvidenceItem.status === "pass", `proof-backed G-code evidence item should pass, got ${gcodeEvidenceItem.status}`);
  assert(evidenceDossier.crossChecks?.externalGcodeSourceBindingPass === true, "dossier should mark external G-code source binding as pass");
  assert(evidenceDossier.crossChecks?.externalGcodeProductionCandidate === true, "dossier should mark external G-code as production candidate");

  const productionGate = await getArtifactJson(job.id, "production-gate.json");
  assert(productionGate.allowTrialNc === true, `proof-backed FreeCAD should allow trial NC; blockers: ${(productionGate.blockers ?? []).join("; ")}`);
  assert(productionGate.allowProductionNc === false, "proof-backed FreeCAD still must not unlock production without full external validation and machine acceptance");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    selectedEngine: job.selectedEngine,
    resultEngine: job.result.engine,
    handoff: adapterReport.metrics.handoffEvidence.classification,
    gcodeValidation: gcodeImportValidation.status,
    production: productionGate.allowProductionNc,
    trial: productionGate.allowTrialNc,
    packageLevel: productionGate.level
  }, null, 2));
}

function writeProofRunner(filePath) {
  writeFileSync(filePath, `#!/usr/bin/env python3
import hashlib
import json
import sys
from pathlib import Path

job_path = Path(sys.argv[-3])
plan_path = Path(sys.argv[-2])
output_path = Path(sys.argv[-1])
job = json.loads(job_path.read_text(encoding="utf-8"))
model_path = Path(str(job.get("modelPath") or ""))
settings = job.get("settings") or {}
output_path.parent.mkdir(parents=True, exist_ok=True)
safe_z = float(settings.get("safeZ") or 22)
feed = int(float(settings.get("feedRate") or 180))
gcode = "\\n".join([
    "(HeDiao3D FreeCAD proof-backed output)",
    f"(JOB_ID={job.get('jobId')})",
    "G21",
    "G90",
    f"G0 X0.0000 Y0.0000 Z{safe_z:.4f}",
    f"G1 X6.0000 Y0.0000 Z-0.3500 F{feed}",
    f"G1 X12.0000 Y1.5000 Z-0.5500 F{feed}",
    f"G1 X18.0000 Y3.0000 Z-0.4500 F{feed}",
    f"G0 Z{safe_z:.4f}",
    "M5",
    "M30",
    "",
])
output_path.write_text(gcode, encoding="utf-8")
proof = {
    "schema": "hediao3d.freecad-cam-output-report.v1",
    "engine": "freecad",
    "jobId": job.get("jobId"),
    "gcodeSha256": hashlib.sha256(gcode.encode("utf-8")).hexdigest(),
    "modelSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
    "planSha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
    "quality": {
        "productionCandidate": True,
        "postprocessEligible": True,
        "fixture": False,
        "previewScaffold": False
    }
}
Path(str(output_path) + ".cam-proof.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"ok": True, "engine": "freecad", "proof": True}))
`);
}

function writeCamoticsFixture(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema: "hediao3d.camotics-result.v1",
    engine: "camotics",
    synthetic: false,
    status: "completed",
    riskLevel: "ready",
    summary: "Imported non-synthetic CAMotics fixture for proof-backed FreeCAD handoff.",
    metrics: {
      motionLineCount: 12,
      zMin: -0.55,
      zMax: 22,
      materialRemovedMm3: 5.1,
      fitRate: 99.2,
      missCount: 0,
      estimatedMinutes: 0.8
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl",
      note: "Fixture validates Orchestrator proof-backed FreeCAD G-code classification, not real material removal fidelity."
    }
  }, null, 2));
}

function writeClosedReliefStl(filePath) {
  mkdirSync(resolve("public", "imported-models"), { recursive: true });
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
    return [round(x), round(y), round(0.1 + dome)];
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
  writeFileSync(filePath, `solid freecad_proof_relief\\n${facets.join("")}endsolid freecad_proof_relief\\n`);
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
