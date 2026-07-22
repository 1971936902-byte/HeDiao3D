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
  assert(readyReport.machineFit?.schema === "hediao3d.opencamlib-candidate-machine-fit-preflight.v1", "ready package should include machine-fit preflight");
  assert(["ok", "review"].includes(readyReport.machineFit?.level), `ready machine-fit should be ok/review, got ${readyReport.machineFit?.level}`);
  assert(readyReport.artifactManifest?.machineFitLevel === readyReport.machineFit.level, "artifact manifest should expose machine-fit level");
  assert(readyReport.artifactManifest?.schema === "hediao3d.opencamlib-candidate-artifact-manifest.v1", "ready package should include artifact manifest");
  assert(readyReport.artifactManifest?.readyForImport === true, "ready artifact manifest should be ready for import");
  assert(readyReport.handoffContract?.schema === "hediao3d.opencamlib-neutral-handoff-contract.v1", "ready package should include handoff contract");
  assert(readyReport.handoffContract?.status === "ready-for-hediao3d-import", "ready handoff contract should be import-ready");
  assert(readyReport.handoffContract?.strictAcceptance?.neutralHashBound === true, "ready handoff contract should confirm neutral hash binding");
  assert(readyReport.handoffContract?.strictAcceptance?.machineFitLevel === readyReport.machineFit.level, "handoff contract should expose machine-fit level");
  assert(readyReport.productionGapReview?.schema === "hediao3d.opencamlib-production-gap-review.v1", "ready package should include production gap review");
  assert(readyReport.productionGapReview?.productionCandidateReady === true, "ready package should clear OpenCAMLib production gap review");
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
  assert(blockedReport.productionGapReview?.criticalCount >= 1, "blocked package production gap review should include critical gaps");
  assert(blockedReport.productionGapReview?.gaps?.some((gap) => gap.id === "missing-required-artifacts"), "blocked package gap review should mention missing artifacts");
  assert(blockedReport.blockers?.some((item) => /contact/i.test(item)), "blocked package should mention missing contact");
  assert(existsSync(join(blockedDir, "opencamlib-candidate-package-validation.json")), "blocked package should still write report");
  rmSync(blockedDir, { recursive: true, force: true });

  const identityMismatchDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-candidate-package-identity-mismatch-"));
  const mismatchModelPath = join(identityMismatchDir, "repaired-model.stl");
  const mismatchPlanPath = join(identityMismatchDir, "opencamlib-kernel-plan.json");
  const mismatchNeutralPath = join(identityMismatchDir, "neutral-toolpath.json");
  const mismatchContactPath = join(identityMismatchDir, "opencamlib-cutter-contact-report.json");
  writeFileSync(mismatchModelPath, createStl(), "utf8");
  writeFileSync(mismatchPlanPath, JSON.stringify(createPlan(mismatchModelPath), null, 2), "utf8");
  const mismatchNeutral = createNeutral(mismatchContactPath);
  const mismatchNeutralSha = sha256JsonWithoutContact(mismatchNeutral);
  const mismatchContact = createContact({
    modelSha: sha256File(mismatchModelPath),
    planSha: sha256Text("wrong-plan-hash"),
    neutralSha: mismatchNeutralSha
  });
  mismatchNeutral.cutterContactReport = mismatchContact;
  writeFileSync(mismatchNeutralPath, JSON.stringify(mismatchNeutral, null, 2), "utf8");
  writeFileSync(mismatchContactPath, JSON.stringify(mismatchContact, null, 2), "utf8");
  const identityMismatch = spawnSync(node, [validator, "--root", identityMismatchDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(identityMismatch.status === 3, `identity-mismatched candidate package should fail strict mode, got ${identityMismatch.status}: ${identityMismatch.stdout}`);
  const identityMismatchReport = JSON.parse(identityMismatch.stdout);
  assert(identityMismatchReport.level === "critical", "identity-mismatched package should be critical");
  assert(identityMismatchReport.contactValidation?.level === "critical", "identity-mismatched package should expose critical contact validation");
  assert(identityMismatchReport.contactValidation?.firstError?.includes("planSha256"), "identity mismatch should name the plan hash binding failure");
  assert(identityMismatchReport.artifactManifest?.readyForImport === false, "identity-mismatched artifact manifest should not be import-ready");
  assert(identityMismatchReport.handoffContract?.status === "blocked", "identity-mismatched handoff contract should be blocked");
  assert(identityMismatchReport.handoffContract?.strictAcceptance?.planHashBound === false, "identity-mismatched handoff should mark plan hash as unbound");
  assert(identityMismatchReport.productionGapReview?.gaps?.some((gap) => gap.id === "strict-contact-validation-not-ready"), "identity mismatch gap review should mention strict contact validation");
  assert(identityMismatchReport.blockers?.some((item) => /strict contact validation is critical/.test(item)), "identity mismatch should block candidate package at strict contact validation");
  rmSync(identityMismatchDir, { recursive: true, force: true });

  const machineMismatchDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-candidate-package-machine-mismatch-"));
  const machineModelPath = join(machineMismatchDir, "repaired-model.stl");
  const machinePlanPath = join(machineMismatchDir, "opencamlib-kernel-plan.json");
  const machineNeutralPath = join(machineMismatchDir, "neutral-toolpath.json");
  const machineContactPath = join(machineMismatchDir, "opencamlib-cutter-contact-report.json");
  writeFileSync(machineModelPath, createStl(), "utf8");
  writeFileSync(machinePlanPath, JSON.stringify(createPlan(machineModelPath), null, 2), "utf8");
  const machineNeutral = createNeutralWithoutRotary(machineContactPath);
  const machineNeutralSha = sha256JsonWithoutContact(machineNeutral);
  const machineContact = createContact({
    modelSha: sha256File(machineModelPath),
    planSha: sha256File(machinePlanPath),
    neutralSha: machineNeutralSha
  });
  machineNeutral.cutterContactReport = machineContact;
  writeFileSync(machineNeutralPath, JSON.stringify(machineNeutral, null, 2), "utf8");
  writeFileSync(machineContactPath, JSON.stringify(machineContact, null, 2), "utf8");
  const machineMismatch = spawnSync(node, [validator, "--root", machineMismatchDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(machineMismatch.status === 3, `machine-mismatched candidate package should fail strict mode, got ${machineMismatch.status}: ${machineMismatch.stdout}`);
  const machineMismatchReport = JSON.parse(machineMismatch.stdout);
  assert(machineMismatchReport.level === "critical", "machine-mismatched package should be critical");
  assert(machineMismatchReport.machineFit?.level === "critical", "machine-mismatched package should expose critical machine-fit");
  assert(machineMismatchReport.machineFit?.checks?.rotaryCoordinatePresent === false, "machine-fit should fail missing rotary coordinate");
  assert(machineMismatchReport.artifactManifest?.readyForImport === false, "machine-mismatched artifact manifest should not be import-ready");
  assert(machineMismatchReport.handoffContract?.strictAcceptance?.rotaryCoordinatePresent === false, "handoff should expose missing rotary coordinate");
  assert(machineMismatchReport.productionGapReview?.gaps?.some((gap) => gap.id === "machine-fit-critical"), "machine mismatch gap review should mention machine-fit critical");
  assert(machineMismatchReport.blockers?.some((item) => /machine-fit/i.test(item)), "machine mismatch should block candidate package at machine-fit preflight");
  rmSync(machineMismatchDir, { recursive: true, force: true });

  const experimentalDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-candidate-package-experimental-"));
  const experimentalModelPath = join(experimentalDir, "repaired-model.stl");
  const experimentalPlanPath = join(experimentalDir, "opencamlib-kernel-plan.json");
  const experimentalNeutralPath = join(experimentalDir, "neutral-toolpath.json");
  const experimentalContactPath = join(experimentalDir, "opencamlib-cutter-contact-report.json");
  writeFileSync(experimentalModelPath, createStl(), "utf8");
  writeFileSync(experimentalPlanPath, JSON.stringify(createPlan(experimentalModelPath), null, 2), "utf8");
  const experimentalNeutral = createExperimentalNeutral(experimentalContactPath);
  const experimentalSha = sha256JsonWithoutContact(experimentalNeutral);
  const experimentalContact = createExperimentalContact({
    modelSha: sha256File(experimentalModelPath),
    planSha: sha256File(experimentalPlanPath),
    neutralSha: experimentalSha
  });
  experimentalNeutral.cutterContactReport = experimentalContact;
  writeFileSync(experimentalNeutralPath, JSON.stringify(experimentalNeutral, null, 2), "utf8");
  writeFileSync(experimentalContactPath, JSON.stringify(experimentalContact, null, 2), "utf8");
  const experimental = spawnSync(node, [validator, "--root", experimentalDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(experimental.status === 3, `experimental package should fail strict production preflight, got ${experimental.status}: ${experimental.stdout}`);
  const experimentalReport = JSON.parse(experimental.stdout);
  assert(experimentalReport.level === "critical", "experimental package should be critical in strict candidate preflight");
  assert(experimentalReport.contactValidation?.evidenceClass === "experimental-real-api", "experimental package should expose contact evidence class");
  assert(experimentalReport.artifactManifest?.evidenceClass === "experimental-real-api", "experimental artifact manifest should expose evidence class");
  assert(experimentalReport.handoffContract?.evidenceClass === "experimental-real-api", "experimental handoff contract should expose evidence class");
  assert(experimentalReport.handoffContract?.blockedReason?.includes("experimental"), "experimental handoff should explain blocked reason");
  assert(experimentalReport.productionGapReview?.gaps?.some((gap) => gap.id === "experimental-real-api"), "experimental gap review should mention experimental-real-api");
  assert(experimentalReport.blockers?.some((item) => /experimental-real-api/.test(item)), "experimental package blockers should name experimental-real-api");
  rmSync(experimentalDir, { recursive: true, force: true });

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

function createExperimentalNeutral(contactPath) {
  return {
    ...createNeutral(contactPath),
    experimentalOpenCamLibPathDropCutter: true,
    runner: { mode: "opencamlib-path-drop-cutter-experimental" }
  };
}

function createNeutralWithoutRotary(contactPath) {
  return {
    ...createNeutral(contactPath),
    coordinate: { lengthAxis: "X", depthAxis: "Z" },
    points: [
      { x: -10, z: 21.5, depth: 0.5 },
      { x: 0, z: 21.2, depth: 0.8 },
      { x: 10, z: 21.6, depth: 0.4 }
    ]
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
      stepToCutterRatio: 0.18,
      pathCoverage: {
        schema: "hediao3d.opencamlib-path-dropcutter-coverage.v1",
        xCoverageRatio: 1,
        crossCoverageRatio: 1,
        sampledXSpanMm: 20,
        sampledCrossSpanMm: 180,
        modelXSpanMm: 20,
        modelCrossSpanMm: 180
      }
    },
    residualMaterial: {
      measured: true,
      validationBasis: "swept-volume-validated-fixture",
      maxGougeMm: 0.01,
      maxUndercutMm: 0.03,
      residualVolumeMm3: 0.4
    },
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    protectedZones: {
      schema: "hediao3d.opencamlib-protected-zones.v1",
      enabled: true,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      safeMinX: -10,
      safeMaxX: 10,
      sampledMinX: -10,
      sampledMaxX: 10,
      violationCount: 0,
      violations: []
    },
    quality: {
      level: "validated-contact",
      previewScaffold: false,
      postprocessEligible: true,
      productionCandidate: true
    }
  };
}

function createExperimentalContact({ modelSha, planSha, neutralSha }) {
  return {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    jobId: "candidate-package-test",
    engine: "opencamlib",
    mode: "opencamlib-path-drop-cutter-experimental",
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
      algorithm: "opencamlib-path-drop-cutter",
      pointCount: 3,
      contactPointCount: 3
    },
    quality: {
      level: "experimental-real-api",
      previewScaffold: false,
      postprocessEligible: false,
      productionCandidate: false
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

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
