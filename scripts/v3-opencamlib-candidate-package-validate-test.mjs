#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-candidate-package-"));
const validator = resolve("scripts", "v3-opencamlib-candidate-package-validate.mjs");
const node = process.execPath;

try {
  const modelPath = join(workDir, "repaired-model.stl");
  const planPath = join(workDir, "opencamlib-kernel-plan.json");
  const neutralPath = join(workDir, "neutral-toolpath.json");
  const contactPath = join(workDir, "opencamlib-cutter-contact-report.json");
  writeFileSync(modelPath, createStl(), "utf8");
  writeFileSync(planPath, JSON.stringify(createPlan(modelPath), null, 2), "utf8");
  const neutral = createNeutral(contactPath);
  const neutralSha = sha256JsonWithoutContact(neutral);
  const contact = createContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha
  });
  neutral.cutterContactReport = contact;
  writeFileSync(neutralPath, JSON.stringify(neutral, null, 2), "utf8");
  writeFileSync(contactPath, JSON.stringify(contact, null, 2), "utf8");

  const ready = spawnSync(node, [validator, "--root", workDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(ready.status === 0, `ready candidate package should pass: ${ready.stderr || ready.stdout}`);
  const readyReport = JSON.parse(ready.stdout);
  assert(readyReport.schema === "hediao3d.opencamlib-candidate-package-validation.v1", "candidate package schema mismatch");
  assert(readyReport.level === "ready", `ready candidate package level mismatch: ${readyReport.level}`);
  assert(readyReport.contactValidation?.level === "ready", "ready package should include ready contact validation");
  assert(readyReport.artifactManifest?.schema === "hediao3d.opencamlib-candidate-artifact-manifest.v1", "ready package should include artifact manifest");
  assert(readyReport.artifactManifest?.readyForImport === true, "ready artifact manifest should be ready for import");
  assert(readyReport.handoffContract?.schema === "hediao3d.opencamlib-neutral-handoff-contract.v1", "ready package should include handoff contract");
  assert(readyReport.handoffContract?.status === "ready-for-hediao3d-import", "ready handoff contract should be import-ready");
  assert(readyReport.handoffContract?.strictAcceptance?.neutralHashBound === true, "ready handoff contract should confirm neutral hash binding");
  assert(readyReport.files.neutral?.sha256 === sha256File(neutralPath), "ready package should hash neutral output");
  assert(existsSync(join(workDir, "opencamlib-candidate-package-validation.json")), "candidate package report should be written");
  assert(existsSync(join(workDir, "opencamlib-candidate-package-bundle.zip")), "candidate package bundle should be written");

  const blockedDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-candidate-package-blocked-"));
  writeFileSync(join(blockedDir, "repaired-model.stl"), createStl(), "utf8");
  writeFileSync(join(blockedDir, "opencamlib-kernel-plan.json"), JSON.stringify(createPlan(join(blockedDir, "repaired-model.stl")), null, 2), "utf8");
  writeFileSync(join(blockedDir, "neutral-toolpath.json"), JSON.stringify(createNeutral(join(blockedDir, "opencamlib-cutter-contact-report.json")), null, 2), "utf8");
  const blocked = spawnSync(node, [validator, "--root", blockedDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(blocked.status === 3, `blocked candidate package should fail strict mode, got ${blocked.status}: ${blocked.stdout}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.level === "critical", "blocked package should be critical");
  assert(blockedReport.artifactManifest?.readyForImport === false, "blocked artifact manifest should not be import-ready");
  assert(blockedReport.handoffContract?.status === "blocked", "blocked handoff contract should be blocked");
  assert(blockedReport.blockers?.some((item) => /contact/i.test(item)), "blocked package should mention missing contact");
  assert(existsSync(join(blockedDir, "opencamlib-candidate-package-validation.json")), "blocked package should still write report");
  rmSync(blockedDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.contactValidation.checkCount
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createPlan(modelPath) {
  return {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: "candidate-package-test",
    engine: "opencamlib",
    model: {
      path: modelPath,
      format: "stl",
      exists: true
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    sampling: {
      recommendedPrimary: "unwrapped-rotary-drop-cutter",
      axisMapping: { lengthAxis: "X", depthAxis: "Z", rotaryAxis: "Y" }
    },
    operations: [{ id: "finishing", enabled: true, strategy: "opencamlib-drop-cutter-contact" }]
  };
}

function createNeutral(contactPath) {
  return {
    schema: "hediao3d.neutral-toolpath.v1",
    jobId: "candidate-package-test",
    engine: "opencamlib",
    synthetic: false,
    fixture: false,
    generatedByExternalCommand: true,
    coordinate: { lengthAxis: "X", rotaryAxis: "Y", depthAxis: "Z", rotaryUnit: "degree" },
    cutterContactReportPath: contactPath,
    points: [
      { x: -10, a: 0, z: 21.5, depth: 0.5 },
      { x: 0, a: 90, z: 21.2, depth: 0.8 },
      { x: 10, a: 180, z: 21.6, depth: 0.4 }
    ],
    runner: { mode: "opencamlib-drop-cutter-contact" }
  };
}

function createContact({ modelSha, planSha, neutralSha }) {
  return {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    jobId: "candidate-package-test",
    engine: "opencamlib",
    mode: "opencamlib-drop-cutter-contact",
    inputIdentity: {
      modelSha256: modelSha,
      planSha256: planSha,
      neutralToolpathWithoutContactReportSha256: neutralSha,
      sourceNeutralToolpathSha256: neutralSha
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    contactSampling: {
      algorithm: "opencamlib-drop-cutter-contact",
      pointCount: 3,
      contactPointCount: 3,
      hitRate: 1,
      stepToCutterRatio: 0.18
    },
    residualMaterial: {
      maxGougeMm: 0.01,
      maxUndercutMm: 0.03,
      residualVolumeMm3: 0.4
    },
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    quality: {
      level: "validated-contact",
      previewScaffold: false,
      postprocessEligible: true,
      productionCandidate: true
    }
  };
}

function createStl() {
  return `solid model
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid model
`;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256JsonWithoutContact(value) {
  const copy = { ...value };
  delete copy.cutterContactReport;
  delete copy.cutterContactReportPath;
  delete copy.cutterEnvelopeReportPath;
  return createHash("sha256").update(JSON.stringify(copy, null, 2)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
