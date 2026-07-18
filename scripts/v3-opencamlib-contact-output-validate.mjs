#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const neutralPath = requiredPath(args.neutral, "--neutral");
const planPath = optionalPath(args.plan);
const modelPath = optionalPath(args.model);
const explicitContactPath = optionalPath(args.contact);
const outPath = args.out ? resolve(String(args.out)) : null;
const expectProductionCandidate = parseBool(args.expectProductionCandidate ?? args.expectProduction ?? "true");
const strict = parseBool(args.strict ?? "true");

const neutral = readJson(neutralPath, "neutral-toolpath");
const contactPath = explicitContactPath ?? resolveContactPath(neutralPath, neutral);
const contact = contactPath ? readJson(contactPath, "OpenCAMLib contact report") : embeddedContact(neutral);
const result = validate({ neutralPath, neutral, contactPath, contact, planPath, modelPath, expectProductionCandidate, strict });

if (outPath) {
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
}
console.log(JSON.stringify(result, null, 2));

if (strict && result.level === "critical") {
  process.exitCode = 3;
}

function validate({ neutralPath, neutral, contactPath, contact, planPath, modelPath, expectProductionCandidate, strict }) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const neutralText = readFileSync(neutralPath, "utf8");
  const neutralFullSha = sha256Text(neutralText);
  const neutralWithoutContactSha = sha256JsonWithoutContactReport(neutral);

  check(checks, "neutral-schema", neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema must be hediao3d.neutral-toolpath.v1", errors);
  check(checks, "neutral-points", Array.isArray(neutral.points) && neutral.points.length > 0, "neutral points[] must be non-empty", errors);
  check(checks, "neutral-not-synthetic", neutral.synthetic !== true, "neutral must not be synthetic", errors);
  check(checks, "neutral-not-fixture", neutral.fixture !== true, "neutral must not be fixture output", errors);
  const neutralPreview = hasPreviewMarker(neutral);
  const experimentalRealApi = hasExperimentalRealApi(neutral, contact);
  check(checks, "neutral-not-preview", !neutralPreview, "neutral must not be preview/scaffold output", expectProductionCandidate ? errors : warnings);
  check(
    checks,
    "experimental-real-api-boundary",
    !experimentalRealApi || !expectProductionCandidate,
    "experimental OpenCAMLib real API output is not production-candidate evidence until residual/material-removal/machine evidence is complete",
    expectProductionCandidate ? errors : warnings
  );

  if (!contact) {
    errors.push("OpenCAMLib cutter contact report is missing.");
  } else {
    check(checks, "contact-schema", contact.schema === "hediao3d.opencamlib-cutter-contact-report.v1", "contact report schema must be hediao3d.opencamlib-cutter-contact-report.v1", errors);
    const quality = contact.quality && typeof contact.quality === "object" ? contact.quality : {};
    check(checks, "quality-postprocessEligible", quality.postprocessEligible === true, "contact quality.postprocessEligible must be true", expectProductionCandidate ? errors : warnings);
    check(checks, "quality-productionCandidate", quality.productionCandidate === true, "contact quality.productionCandidate must be true", expectProductionCandidate ? errors : warnings);
    check(checks, "quality-not-preview", quality.previewScaffold !== true && !/preview|scaffold/i.test(String(quality.level ?? "")), "contact report must not be preview/scaffold", expectProductionCandidate ? errors : warnings);
    checkProductionContactEvidence(checks, contact, expectProductionCandidate ? errors : warnings);

    const identity = contact.inputIdentity && typeof contact.inputIdentity === "object" ? contact.inputIdentity : {};
    const reportedNeutral = [
      identity.neutralToolpathSha256,
      identity.sourceNeutralToolpathSha256,
      identity.neutralToolpathWithoutContactReportSha256,
      identity.externalNeutralToolpathSha256
    ].filter(Boolean).map(String);
    const neutralMatched = reportedNeutral.includes(neutralFullSha) || reportedNeutral.includes(neutralWithoutContactSha);
    check(checks, "identity-neutral", neutralMatched, "contact inputIdentity must bind neutral full hash or neutral-without-contact hash", errors, {
      acceptable: [neutralFullSha, neutralWithoutContactSha],
      reported: reportedNeutral
    });

    if (planPath) {
      check(checks, "identity-plan", identity.planSha256 === sha256File(planPath), "contact inputIdentity.planSha256 must match plan file", errors, {
        expected: sha256File(planPath),
        reported: identity.planSha256 ?? null
      });
    }
    if (modelPath) {
      check(checks, "identity-model", identity.modelSha256 === sha256File(modelPath), "contact inputIdentity.modelSha256 must match model file", errors, {
        expected: sha256File(modelPath),
        reported: identity.modelSha256 ?? null
      });
    }
  }

  const level = errors.length ? "critical" : warnings.length ? "review" : "ready";
  const evidenceClass = neutralPreview
    ? "preview-scaffold"
    : experimentalRealApi
      ? "experimental-real-api"
      : level === "ready" && expectProductionCandidate
        ? "production-candidate"
        : "contact-report-review";
  return {
    schema: "hediao3d.opencamlib-contact-output-validation.v1",
    createdAt: new Date().toISOString(),
    level,
    evidenceClass,
    strict,
    expectProductionCandidate,
    productionCandidateEligible: level === "ready" && expectProductionCandidate,
    inputIdentity: {
      neutral: {
        path: neutralPath,
        filename: basename(neutralPath),
        sha256: neutralFullSha,
        neutralWithoutContactReportSha256: neutralWithoutContactSha
      },
      contact: contactPath ? {
        path: contactPath,
        filename: basename(contactPath),
        sha256: sha256File(contactPath)
      } : {
        path: null,
        filename: null,
        sha256: null,
        embedded: Boolean(contact)
      },
      plan: planPath ? { path: planPath, sha256: sha256File(planPath) } : null,
      model: modelPath ? { path: modelPath, sha256: sha256File(modelPath) } : null
    },
    checks,
    errors,
    warnings,
    nextActions: errors.length
      ? [
        "Regenerate neutral-toolpath.json from validated OpenCAMLib drop-cutter/cutter-contact output.",
        "Write hediao3d.opencamlib-cutter-contact-report.v1 with matching model/plan/neutral hashes.",
        "Keep production locked until this validator reports ready and CAMotics/material-removal evidence is imported."
      ]
      : warnings.length
        ? [
          ...(evidenceClass === "experimental-real-api"
            ? ["Treat this OpenCAMLib PathDropCutter output as engineering evidence only; add residual metrics, CAMotics/material-removal, air-run and machine acceptance before production."]
            : ["Review non-critical warnings before importing this output into HeDiao3D."])
        ]
        : ["Import neutral-toolpath.json through the OpenCAMLib neutral handoff and continue CAMotics/material-removal validation."],
    productionBoundary: "This validator only checks OpenCAMLib neutral/contact handoff identity. HeDiao3D still requires postprocess checks, material-removal simulation, air-run, trial feedback and machine acceptance before production NC unlock."
  };
}

function checkProductionContactEvidence(checks, contact, target) {
  const algorithm = String(contact?.contactSampling?.algorithm ?? contact?.mode ?? "");
  const tool = contact?.tool && typeof contact.tool === "object" ? contact.tool : {};
  const sampling = contact?.contactSampling && typeof contact.contactSampling === "object" ? contact.contactSampling : {};
  const residual = contact?.residualMaterial && typeof contact.residualMaterial === "object" ? contact.residualMaterial : {};
  const tolerance = contact?.tolerances && typeof contact.tolerances === "object" ? contact.tolerances : {};
  const maxGougeMm = numberOrNull(residual.maxGougeMm);
  const maxUndercutMm = numberOrNull(residual.maxUndercutMm);
  const gougeToleranceMm = numberOrNull(tolerance.maxGougeMm) ?? 0.03;
  const undercutToleranceMm = numberOrNull(tolerance.maxUndercutMm) ?? 0.08;
  const hitRate = numberOrNull(sampling.hitRate);
  const pointCount = numberOrNull(sampling.pointCount);
  const contactPointCount = numberOrNull(sampling.contactPointCount ?? sampling.pointCount);
  const stepToCutterRatio = numberOrNull(sampling.stepToCutterRatio ?? sampling.samplingQuality?.stepToCutterRatio);
  const pathCoverage = sampling.pathCoverage && typeof sampling.pathCoverage === "object" ? sampling.pathCoverage : {};
  const xCoverageRatio = numberOrNull(pathCoverage.xCoverageRatio);
  const crossCoverageRatio = numberOrNull(pathCoverage.crossCoverageRatio);

  check(
    checks,
    "contact-algorithm-real",
    /(drop-cutter|cutter-contact|waterline)/i.test(algorithm) && !/(preview|heightfield|scaffold|fixture|synthetic)/i.test(algorithm),
    "contactSampling.algorithm must be a real OpenCAMLib drop-cutter/cutter-contact/waterline algorithm, not preview/heightfield/scaffold",
    target,
    { reported: algorithm || null }
  );
  check(checks, "contact-tool-diameter", numberOrNull(tool.diameterMm) > 0, "contact report tool.diameterMm must be positive", target, { reported: tool.diameterMm ?? null });
  check(checks, "contact-tool-angle", numberOrNull(tool.angleDeg) > 0, "contact report tool.angleDeg must be positive", target, { reported: tool.angleDeg ?? null });
  check(checks, "contact-tool-flat-tip", numberOrNull(tool.flatTipMm) >= 0, "contact report tool.flatTipMm must be present and non-negative", target, { reported: tool.flatTipMm ?? null });
  check(checks, "contact-sampling-hit-rate", hitRate !== null && hitRate >= 0.995, "contactSampling.hitRate must be at least 99.5%", target, { reported: hitRate });
  check(checks, "contact-sampling-point-count", pointCount !== null && pointCount > 0 && contactPointCount !== null && contactPointCount > 0, "contactSampling point/contact counts must be positive", target, { pointCount, contactPointCount });
  check(checks, "contact-sampling-step-ratio", stepToCutterRatio !== null && stepToCutterRatio <= 0.25, "contact sampling step-to-cutter ratio must be <= 0.25", target, { reported: stepToCutterRatio });
  check(checks, "contact-path-coverage-x", xCoverageRatio !== null && xCoverageRatio >= 0.98, "contactSampling.pathCoverage.xCoverageRatio must be at least 98%", target, { reported: xCoverageRatio });
  check(checks, "contact-path-coverage-cross", crossCoverageRatio !== null && crossCoverageRatio >= 0.98, "contactSampling.pathCoverage.crossCoverageRatio must be at least 98%", target, { reported: crossCoverageRatio });
  check(checks, "contact-residual-gouge", maxGougeMm !== null && maxGougeMm <= gougeToleranceMm, "residualMaterial.maxGougeMm must be present and within tolerance", target, { reported: maxGougeMm, tolerance: gougeToleranceMm });
  check(checks, "contact-residual-undercut", maxUndercutMm !== null && maxUndercutMm <= undercutToleranceMm, "residualMaterial.maxUndercutMm must be present and within tolerance", target, { reported: maxUndercutMm, tolerance: undercutToleranceMm });
}

function resolveContactPath(neutralPath, neutral) {
  const candidates = [
    neutral.cutterContactReportPath,
    neutral.cutterContactReportFile,
    join(dirname(neutralPath), "opencamlib-cutter-contact-report.json")
  ].filter(Boolean).map((item) => resolve(String(item)));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function embeddedContact(neutral) {
  return neutral.cutterContactReport && typeof neutral.cutterContactReport === "object" ? neutral.cutterContactReport : null;
}

function check(checks, id, pass, summary, target, extra = {}) {
  checks.push({ id, status: pass ? "pass" : "fail", summary, ...extra });
  if (!pass) target.push(summary);
}

function hasPreviewMarker(neutral) {
  const runner = neutral.runner && typeof neutral.runner === "object" ? neutral.runner : {};
  return Boolean(
    neutral.experimentalHeightfield ||
    neutral.experimentalRotaryHeightfield ||
    /preview|scaffold/i.test(String(runner.mode ?? "")) ||
    /preview|scaffold/i.test(String(runner.warning ?? ""))
  );
}

function hasExperimentalRealApi(neutral, contact) {
  const runner = neutral.runner && typeof neutral.runner === "object" ? neutral.runner : {};
  const quality = contact?.quality && typeof contact.quality === "object" ? contact.quality : {};
  return Boolean(
    neutral.experimentalOpenCamLibPathDropCutter ||
    /experimental-real-api/i.test(String(runner.mode ?? "")) ||
    /experimental-real-api/i.test(String(contact?.mode ?? "")) ||
    /experimental-real-api/i.test(String(quality.level ?? ""))
  );
}

function sha256JsonWithoutContactReport(value) {
  const copy = { ...value };
  delete copy.cutterContactReport;
  delete copy.cutterContactReportPath;
  delete copy.cutterEnvelopeReportPath;
  return sha256Text(JSON.stringify(copy, null, 2));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${label} JSON at ${path}: ${error.message}`);
  }
}

function requiredPath(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return optionalPath(value);
}

function optionalPath(value) {
  if (!value) return null;
  const path = resolve(String(value));
  if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
  return path;
}

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
