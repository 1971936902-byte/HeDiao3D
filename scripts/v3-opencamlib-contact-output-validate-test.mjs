#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-contact-validate-"));
const validator = resolve("scripts", "v3-opencamlib-contact-output-validate.mjs");
const node = process.execPath;

try {
  const modelPath = join(workDir, "model.stl");
  const planPath = join(workDir, "opencamlib-kernel-plan.json");
  const neutralPath = join(workDir, "neutral-toolpath.json");
  const contactPath = join(workDir, "opencamlib-cutter-contact-report.json");
  const reportPath = join(workDir, "contact-output-validation.json");

  writeFileSync(modelPath, createStl(), "utf8");
  writeFileSync(planPath, JSON.stringify(createPlan(modelPath, neutralPath), null, 2), "utf8");
  const neutral = createNeutral(contactPath);
  const neutralSha = sha256Json(neutral);
  const contact = createContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha,
    productionCandidate: true,
    previewScaffold: false
  });
  neutral.cutterContactReport = contact;
  writeFileSync(neutralPath, JSON.stringify(neutral, null, 2), "utf8");
  writeFileSync(contactPath, JSON.stringify(contact, null, 2), "utf8");

  const ready = spawnSync(node, [validator, "--neutral", neutralPath, "--plan", planPath, "--model", modelPath, "--contact", contactPath, "--out", reportPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(ready.status === 0, `ready validation failed: ${ready.stderr || ready.stdout}`);
  assert(existsSync(reportPath), "validator did not write report");
  const readyReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(readyReport.level === "ready", `expected ready, got ${readyReport.level}`);
  assert(readyReport.productionCandidateEligible === true, "ready report should be production candidate eligible");
  assert(readyReport.checks.some((check) => check.id === "identity-neutral" && check.status === "pass"), "neutral identity should pass");
  assert(readyReport.checks.some((check) => check.id === "contact-algorithm-real" && check.status === "pass"), "real contact algorithm evidence should pass");
  assert(readyReport.checks.some((check) => check.id === "contact-residual-gouge" && check.status === "pass"), "residual gouge evidence should pass");

  const previewNeutralPath = join(workDir, "preview-neutral-toolpath.json");
  const previewContactPath = join(workDir, "preview-contact-report.json");
  const previewNeutral = {
    ...createNeutral(previewContactPath),
    experimentalHeightfield: true,
    runner: { mode: "stl-heightfield-preview" }
  };
  const previewSha = sha256Json(previewNeutral);
  const previewContact = createContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha: previewSha,
    productionCandidate: false,
    previewScaffold: true
  });
  previewNeutral.cutterContactReport = previewContact;
  writeFileSync(previewNeutralPath, JSON.stringify(previewNeutral, null, 2), "utf8");
  writeFileSync(previewContactPath, JSON.stringify(previewContact, null, 2), "utf8");
  const blocked = spawnSync(node, [validator, "--neutral", previewNeutralPath, "--plan", planPath, "--model", modelPath, "--contact", previewContactPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(blocked.status === 3, `preview validation should fail strict mode, got ${blocked.status}: ${blocked.stdout}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.level === "critical", "preview output should be critical when production candidate is expected");
  assert(blockedReport.errors.some((error) => /preview/i.test(error)), "preview error should be reported");
  assert(blockedReport.errors.some((error) => /drop-cutter|cutter-contact|heightfield/i.test(error)), "preview output should fail real algorithm evidence");

  const weakContactPath = join(workDir, "weak-contact-report.json");
  const weakNeutralPath = join(workDir, "weak-neutral-toolpath.json");
  const weakNeutral = createNeutral(weakContactPath);
  const weakSha = sha256Json(weakNeutral);
  const weakContact = createContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha: weakSha,
    productionCandidate: true,
    previewScaffold: false,
    weakEvidence: true
  });
  weakNeutral.cutterContactReport = weakContact;
  writeFileSync(weakNeutralPath, JSON.stringify(weakNeutral, null, 2), "utf8");
  writeFileSync(weakContactPath, JSON.stringify(weakContact, null, 2), "utf8");
  const weak = spawnSync(node, [validator, "--neutral", weakNeutralPath, "--plan", planPath, "--model", modelPath, "--contact", weakContactPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(weak.status === 3, `weak contact evidence should fail strict mode, got ${weak.status}: ${weak.stdout}`);
  const weakReport = JSON.parse(weak.stdout);
  assert(weakReport.errors.some((error) => /hitRate|过切|gouge|maxGouge|step-to-cutter/i.test(error)), "weak contact evidence should report quality metric failures");

  const experimentalContactPath = join(workDir, "experimental-contact-report.json");
  const experimentalNeutralPath = join(workDir, "experimental-neutral-toolpath.json");
  const experimentalNeutral = {
    ...createNeutral(experimentalContactPath),
    experimentalOpenCamLibPathDropCutter: true,
    runner: { mode: "opencamlib-path-drop-cutter-experimental" }
  };
  const experimentalSha = sha256Json(experimentalNeutral);
  const experimentalContact = createContact({
    modelSha: sha256File(modelPath),
    planSha: sha256File(planPath),
    neutralSha: experimentalSha,
    productionCandidate: false,
    previewScaffold: false,
    experimental: true
  });
  experimentalNeutral.cutterContactReport = experimentalContact;
  writeFileSync(experimentalNeutralPath, JSON.stringify(experimentalNeutral, null, 2), "utf8");
  writeFileSync(experimentalContactPath, JSON.stringify(experimentalContact, null, 2), "utf8");
  const experimental = spawnSync(node, [
    validator,
    "--neutral", experimentalNeutralPath,
    "--plan", planPath,
    "--model", modelPath,
    "--contact", experimentalContactPath,
    "--expectProductionCandidate", "false"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  assert(experimental.status === 0, `experimental real API evidence should be review-only, got ${experimental.status}: ${experimental.stdout}`);
  const experimentalReport = JSON.parse(experimental.stdout);
  assert(experimentalReport.level === "review", `experimental real API should be review, got ${experimentalReport.level}`);
  assert(experimentalReport.evidenceClass === "experimental-real-api", "experimental real API evidence class mismatch");
  assert(experimentalReport.productionCandidateEligible === false, "experimental real API must not be production eligible");
  assert(experimentalReport.checks.some((check) => check.id === "experimental-real-api-boundary" && check.status === "pass"), "experimental real API boundary check should pass when production is not expected");
  assert(experimentalReport.warnings.some((warning) => /postprocessEligible|productionCandidate|hitRate|residual|experimental/i.test(warning)), "experimental real API should carry review warnings");

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.checks.length
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createPlan(modelPath, neutralPath) {
  return {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: "contact-output-validate-test",
    engine: "opencamlib",
    model: { path: modelPath, format: "stl", exists: true },
    sampling: { axisMapping: { lengthAxis: "X", rotaryAxis: "Y", depthAxis: "Z" } },
    outputs: {
      neutralPolyline: neutralPath,
      cutterContactReport: "opencamlib-cutter-contact-report.json"
    }
  };
}

function createNeutral(contactPath) {
  return {
    schema: "hediao3d.neutral-toolpath.v1",
    jobId: "contact-output-validate-test",
    engine: "opencamlib",
    synthetic: false,
    fixture: false,
    generatedByExternalCommand: true,
    coordinate: { lengthAxis: "X", rotaryAxis: "Y", depthAxis: "Z", rotaryUnit: "degree" },
    points: [
      { x: -10, a: 0, z: 21.5, depth: 0.5 },
      { x: 0, a: 90, z: 21.2, depth: 0.8 },
      { x: 10, a: 180, z: 21.6, depth: 0.4 }
    ],
    cutterContactReportPath: contactPath,
    runner: { mode: "opencamlib-drop-cutter-contact" }
  };
}

function createContact({ modelSha, planSha, neutralSha, productionCandidate, previewScaffold, weakEvidence = false, experimental = false }) {
  return {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    jobId: "contact-output-validate-test",
    engine: "opencamlib",
    mode: previewScaffold ? "stl-heightfield-preview" : experimental ? "opencamlib-path-drop-cutter-experimental" : "opencamlib-drop-cutter-contact",
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
      algorithm: previewScaffold ? "rotary-ray-heightfield-envelope-preview" : experimental ? "opencamlib-path-drop-cutter" : "opencamlib-drop-cutter-contact",
      pointCount: 3,
      contactPointCount: 3,
      hitRate: weakEvidence ? 0.91 : experimental ? undefined : 1,
      stepToCutterRatio: weakEvidence ? 0.42 : experimental ? undefined : 0.18
    },
    ...(experimental ? {} : {
      residualMaterial: {
        maxGougeMm: weakEvidence ? 0.12 : 0.01,
        maxUndercutMm: weakEvidence ? 0.18 : 0.03,
        residualVolumeMm3: weakEvidence ? 6.5 : 0.4
      }
    }),
    tolerances: {
      maxGougeMm: 0.03,
      maxUndercutMm: 0.08
    },
    quality: {
      level: previewScaffold ? "preview-scaffold" : experimental ? "experimental-real-api" : "validated-contact",
      previewScaffold,
      postprocessEligible: productionCandidate,
      productionCandidate,
      summary: "OpenCAMLib contact output validation fixture."
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

function sha256Json(value) {
  const copy = { ...value };
  delete copy.cutterContactReport;
  delete copy.cutterContactReportPath;
  delete copy.cutterEnvelopeReportPath;
  return createHash("sha256").update(JSON.stringify(copy, null, 2)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
