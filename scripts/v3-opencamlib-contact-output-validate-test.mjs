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

function createContact({ modelSha, planSha, neutralSha, productionCandidate, previewScaffold }) {
  return {
    schema: "hediao3d.opencamlib-cutter-contact-report.v1",
    jobId: "contact-output-validate-test",
    engine: "opencamlib",
    mode: previewScaffold ? "stl-heightfield-preview" : "opencamlib-drop-cutter-contact",
    inputIdentity: {
      modelSha256: modelSha,
      planSha256: planSha,
      neutralToolpathWithoutContactReportSha256: neutralSha,
      sourceNeutralToolpathSha256: neutralSha
    },
    quality: {
      level: previewScaffold ? "preview-scaffold" : "validated-contact",
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
