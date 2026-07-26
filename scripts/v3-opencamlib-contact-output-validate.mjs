#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const neutralPath = requiredPath(args.neutral, "--neutral");
const planPath = optionalPath(args.plan);
const modelPath = optionalPath(args.model);
const explicitContactPath = optionalPath(args.contact);
const camoticsLocalValidationPath = optionalPath(args.camoticsLocalValidation ?? args["camotics-local-validation"] ?? args.localValidation ?? args["local-validation"]);
const outPath = args.out ? resolve(String(args.out)) : null;
const expectProductionCandidate = parseBool(args.expectProductionCandidate ?? args.expectProduction ?? "true");
const strict = parseBool(args.strict ?? "true");

const neutral = readJson(neutralPath, "neutral-toolpath");
const contactPath = explicitContactPath ?? resolveContactPath(neutralPath, neutral);
const contact = contactPath ? readJson(contactPath, "OpenCAMLib contact report") : embeddedContact(neutral);
const camoticsLocalValidation = camoticsLocalValidationPath ? readJson(camoticsLocalValidationPath, "CAMotics local validation") : null;
const result = validate({ neutralPath, neutral, contactPath, contact, planPath, modelPath, camoticsLocalValidationPath, camoticsLocalValidation, expectProductionCandidate, strict });

if (outPath) {
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
}
console.log(JSON.stringify(result, null, 2));

if (strict && result.level === "critical") {
  process.exitCode = 3;
}

function validate({ neutralPath, neutral, contactPath, contact, planPath, modelPath, camoticsLocalValidationPath, camoticsLocalValidation, expectProductionCandidate, strict }) {
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
    const externalResidualProof = createExternalResidualProof(camoticsLocalValidation);
    checkProductionContactEvidence(checks, contact, externalResidualProof, expectProductionCandidate ? errors : warnings);

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
  const productionCandidatePromotion = createProductionCandidatePromotion({
    checks,
    contact,
    neutralPreview,
    experimentalRealApi,
    level,
    expectProductionCandidate
  });
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
    productionCandidatePromotion,
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
      model: modelPath ? { path: modelPath, sha256: sha256File(modelPath) } : null,
      camoticsLocalValidation: camoticsLocalValidationPath ? {
        path: camoticsLocalValidationPath,
        filename: basename(camoticsLocalValidationPath),
        sha256: sha256File(camoticsLocalValidationPath)
      } : null
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

function checkProductionContactEvidence(checks, contact, externalResidualProof, target) {
  const algorithm = String(contact?.contactSampling?.algorithm ?? contact?.mode ?? "");
  const tool = contact?.tool && typeof contact.tool === "object" ? contact.tool : {};
  const sampling = contact?.contactSampling && typeof contact.contactSampling === "object" ? contact.contactSampling : {};
  const residual = contact?.residualMaterial && typeof contact.residualMaterial === "object" ? contact.residualMaterial : {};
  const readiness = contact?.materialRemovalReadiness && typeof contact.materialRemovalReadiness === "object" ? contact.materialRemovalReadiness : {};
  const tolerance = contact?.tolerances && typeof contact.tolerances === "object" ? contact.tolerances : {};
  const protectedZones = contact?.protectedZones && typeof contact.protectedZones === "object" ? contact.protectedZones : {};
  const maxGougeMm = numberOrNull(residual.maxGougeMm);
  const maxUndercutMm = numberOrNull(residual.maxUndercutMm);
  const residualValidationBasis = String(residual.validationBasis ?? residual.estimationMethod ?? residual.evidenceClass ?? "");
  const residualMeasuredOrValidated = residual.measured === true || /(swept-volume|material-removal|validated|measured)/i.test(residualValidationBasis);
  const externalResidualReady = externalResidualProof?.ready === true;
  const proofResidual = externalResidualProof?.residualValidation ?? {};
  const proofMaxGougeMm = numberOrNull(proofResidual.maxGougeMm);
  const proofMaxUndercutMm = numberOrNull(proofResidual.maxUndercutMm);
  const proofBasis = String(proofResidual.validationBasis ?? proofResidual.evidenceClass ?? "");
  const effectiveMaxGougeMm = maxGougeMm ?? proofMaxGougeMm;
  const effectiveMaxUndercutMm = maxUndercutMm ?? proofMaxUndercutMm;
  const effectiveMeasuredOrValidated = residualMeasuredOrValidated || externalResidualReady;
  const gougeToleranceMm = numberOrNull(tolerance.maxGougeMm) ?? 0.03;
  const undercutToleranceMm = numberOrNull(tolerance.maxUndercutMm) ?? 0.08;
  const residualWithinTolerance = effectiveMaxGougeMm !== null && effectiveMaxGougeMm <= gougeToleranceMm && effectiveMaxUndercutMm !== null && effectiveMaxUndercutMm <= undercutToleranceMm;
  const residualEvidenceClosed = residualWithinTolerance && effectiveMeasuredOrValidated;
  const declaredProductionResidualReady = residual.productionResidualEvidenceReady === true || readiness.productionResidualEvidenceReady === true;
  const unsafeResidualProductionClaim = declaredProductionResidualReady && !residualEvidenceClosed;
  const hitRate = numberOrNull(sampling.hitRate);
  const pointCount = numberOrNull(sampling.pointCount);
  const contactPointCount = numberOrNull(sampling.contactPointCount ?? sampling.pointCount);
  const stepToCutterRatio = numberOrNull(sampling.stepToCutterRatio ?? sampling.samplingQuality?.stepToCutterRatio);
  const pathCoverage = sampling.pathCoverage && typeof sampling.pathCoverage === "object" ? sampling.pathCoverage : {};
  const xCoverageRatio = numberOrNull(pathCoverage.xCoverageRatio);
  const crossCoverageRatio = numberOrNull(pathCoverage.crossCoverageRatio);
  const protectedEnabled = protectedZones.enabled === true;
  const protectedViolationCount = numberOrNull(protectedZones.violationCount);
  const safeMinX = numberOrNull(protectedZones.safeMinX);
  const safeMaxX = numberOrNull(protectedZones.safeMaxX);
  const sampledMinX = numberOrNull(protectedZones.sampledMinX);
  const sampledMaxX = numberOrNull(protectedZones.sampledMaxX);
  const protectedBoundsReady = safeMinX !== null && safeMaxX !== null && sampledMinX !== null && sampledMaxX !== null && safeMinX <= safeMaxX && sampledMinX >= safeMinX - 0.001 && sampledMaxX <= safeMaxX + 0.001;

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
  check(checks, "contact-residual-gouge", effectiveMaxGougeMm !== null && effectiveMaxGougeMm <= gougeToleranceMm, "residualMaterial.maxGougeMm must be present and within tolerance, or supplied by a bound CAMotics/equivalent residual proof chain", target, { reported: effectiveMaxGougeMm, contactReported: maxGougeMm, externalReported: proofMaxGougeMm, tolerance: gougeToleranceMm, evidenceSource: externalResidualReady && maxGougeMm === null ? "camotics-local-validation" : "contact-report" });
  check(checks, "contact-residual-undercut", effectiveMaxUndercutMm !== null && effectiveMaxUndercutMm <= undercutToleranceMm, "residualMaterial.maxUndercutMm must be present and within tolerance, or supplied by a bound CAMotics/equivalent residual proof chain", target, { reported: effectiveMaxUndercutMm, contactReported: maxUndercutMm, externalReported: proofMaxUndercutMm, tolerance: undercutToleranceMm, evidenceSource: externalResidualReady && maxUndercutMm === null ? "camotics-local-validation" : "contact-report" });
  check(checks, "contact-residual-measured-or-validated", effectiveMeasuredOrValidated, "residualMaterial must be measured or backed by swept-volume/material-removal/validated evidence, not only an engineering estimate", target, { measured: residual.measured === true || Boolean(proofResidual.measured), validationBasis: residualValidationBasis || proofBasis || null, externalProofReady: externalResidualReady });
  check(checks, "contact-residual-production-claim", !unsafeResidualProductionClaim, "residualMaterial/materialRemovalReadiness must not claim production residual evidence until measured or swept-volume/material-removal validation is within tolerance", target, {
    declaredProductionResidualReady,
    unsafeProductionClaim: unsafeResidualProductionClaim,
    measured: residual.measured === true || Boolean(proofResidual.measured),
    validationBasis: residualValidationBasis || proofBasis || null,
    maxGougeMm: effectiveMaxGougeMm,
    maxUndercutMm: effectiveMaxUndercutMm,
    gougeToleranceMm,
    undercutToleranceMm
  });
  if (externalResidualProof?.present) {
    check(checks, "contact-residual-external-proof-chain", externalResidualReady, "external CAMotics/equivalent residual proof chain must be ready and hash-bound to the upstream OpenCAMLib candidate package before it can support promotion", target, {
      proofSchema: externalResidualProof.schema,
      proofStatus: externalResidualProof.status,
      localValidationOk: externalResidualProof.localValidationOk,
      productionResidualEvidenceReady: externalResidualProof.productionResidualEvidenceReady,
      unsafeProductionClaim: externalResidualProof.unsafeProductionClaim,
      upstreamStatus: externalResidualProof.upstreamStatus,
      upstreamCandidatePackageStatus: externalResidualProof.upstreamCandidatePackageStatus
    });
  }
  check(checks, "protected-zones-present", protectedEnabled, "contact report must declare enabled protectedZones for rotary fixture hold/end transition areas", target, { reported: protectedZones.enabled ?? null });
  check(checks, "protected-zones-no-violations", protectedViolationCount !== null && protectedViolationCount === 0, "protectedZones.violationCount must be 0", target, { reported: protectedViolationCount });
  check(checks, "protected-zones-sampled-bounds", protectedBoundsReady, "protectedZones sampledMinX/sampledMaxX must stay inside safeMinX/safeMaxX", target, { safeMinX, safeMaxX, sampledMinX, sampledMaxX });
}

function createExternalResidualProof(localValidation) {
  if (!localValidation || typeof localValidation !== "object") {
    return { present: false, ready: false };
  }
  const proofChain = localValidation.residualProofChain && typeof localValidation.residualProofChain === "object"
    ? localValidation.residualProofChain
    : {};
  const residualValidation = proofChain.residualValidation && typeof proofChain.residualValidation === "object"
    ? proofChain.residualValidation
    : localValidation.residualValidation && typeof localValidation.residualValidation === "object"
      ? localValidation.residualValidation
      : {};
  const upstream = proofChain.upstreamCamEvidence && typeof proofChain.upstreamCamEvidence === "object"
    ? proofChain.upstreamCamEvidence
    : localValidation.upstreamCamEvidence && typeof localValidation.upstreamCamEvidence === "object"
      ? localValidation.upstreamCamEvidence
      : {};
  const upstreamMatched = upstream.status === "matched" && upstream.candidatePackageStatus === "matched";
  const ready = localValidation.ok === true
    && proofChain.schema === "hediao3d.camotics-residual-proof-chain.v1"
    && proofChain.productionResidualEvidenceReady === true
    && proofChain.unsafeProductionClaim !== true
    && upstreamMatched;
  return {
    present: true,
    ready,
    schema: proofChain.schema ?? null,
    status: proofChain.status ?? localValidation.level ?? "unknown",
    localValidationOk: Boolean(localValidation.ok),
    productionResidualEvidenceReady: Boolean(proofChain.productionResidualEvidenceReady),
    unsafeProductionClaim: Boolean(proofChain.unsafeProductionClaim),
    upstreamStatus: upstream.status ?? "missing",
    upstreamCandidatePackageStatus: upstream.candidatePackageStatus ?? "missing",
    residualValidation: {
      status: residualValidation.status ?? "missing",
      measured: Boolean(residualValidation.measured),
      validationBasis: residualValidation.validationBasis ?? null,
      evidenceClass: residualValidation.evidenceClass ?? null,
      maxGougeMm: numberOrNull(residualValidation.maxGougeMm),
      maxUndercutMm: numberOrNull(residualValidation.maxUndercutMm),
      maxResidualStockMm: numberOrNull(residualValidation.maxResidualStockMm)
    }
  };
}

function createProductionCandidatePromotion({ checks, contact, neutralPreview, experimentalRealApi, level, expectProductionCandidate }) {
  const quality = contact?.quality && typeof contact.quality === "object" ? contact.quality : {};
  const criteria = [
    criterionFromCheck(checks, "neutral-schema", "neutral", "Neutral schema is hediao3d.neutral-toolpath.v1."),
    criterionFromCheck(checks, "neutral-points", "neutral", "Neutral toolpath contains points."),
    criterionFromCheck(checks, "neutral-not-synthetic", "neutral", "Neutral output is not synthetic."),
    criterionFromCheck(checks, "neutral-not-fixture", "neutral", "Neutral output is not fixture output."),
    criterionFromCheck(checks, "neutral-not-preview", "neutral", "Neutral output is not preview/scaffold."),
    criterionFromCheck(checks, "experimental-real-api-boundary", "runtime-boundary", "OpenCAMLib output is no longer blocked by experimental-real-api boundary."),
    criterionFromCheck(checks, "contact-schema", "contact", "Contact report schema is hediao3d.opencamlib-cutter-contact-report.v1."),
    criterionFromCheck(checks, "quality-postprocessEligible", "contact-quality", "Contact quality declares postprocessEligible=true."),
    criterionFromCheck(checks, "quality-productionCandidate", "contact-quality", "Contact quality declares productionCandidate=true."),
    criterionFromCheck(checks, "quality-not-preview", "contact-quality", "Contact quality is not preview/scaffold."),
    criterionFromCheck(checks, "contact-algorithm-real", "contact-sampling", "Contact sampling uses real drop-cutter/cutter-contact/waterline algorithm."),
    criterionFromCheck(checks, "contact-sampling-hit-rate", "contact-sampling", "Contact hitRate is at least 99.5%."),
    criterionFromCheck(checks, "contact-sampling-step-ratio", "contact-sampling", "Sampling step-to-cutter ratio is <= 0.25."),
    criterionFromCheck(checks, "contact-path-coverage-x", "contact-sampling", "X path coverage is at least 98%."),
    criterionFromCheck(checks, "contact-path-coverage-cross", "contact-sampling", "Cross/rotary path coverage is at least 98%."),
    criterionFromCheck(checks, "contact-residual-gouge", "residual-gouge", "Residual gouge is present and within tolerance."),
    criterionFromCheck(checks, "contact-residual-undercut", "residual-gouge", "Residual undercut is present and within tolerance."),
    criterionFromCheck(checks, "contact-residual-measured-or-validated", "residual-gouge", "Residual metrics are measured or swept-volume/material-removal validated."),
    criterionFromCheck(checks, "contact-residual-production-claim", "residual-gouge", "Residual production claim is not unsafe."),
    criterionFromCheck(checks, "contact-residual-external-proof-chain", "residual-gouge", "External CAMotics/equivalent residual proof chain is ready and bound when supplied.", "not-required"),
    criterionFromCheck(checks, "protected-zones-present", "machine-boundary", "Protected fixture zones are declared."),
    criterionFromCheck(checks, "protected-zones-no-violations", "machine-boundary", "Protected fixture zones have no sampled violations."),
    criterionFromCheck(checks, "protected-zones-sampled-bounds", "machine-boundary", "Sampled contact stays within protected safe bounds."),
    criterionFromCheck(checks, "identity-neutral", "identity", "Contact report is hash-bound to neutral output."),
    criterionFromCheck(checks, "identity-plan", "identity", "Contact report is hash-bound to kernel plan.", "not-required"),
    criterionFromCheck(checks, "identity-model", "identity", "Contact report is hash-bound to source model.", "not-required")
  ].filter(Boolean);
  const blockingCriteria = criteria.filter((item) => item.status !== "pass" && item.status !== "not-required");
  const ready = level === "ready" && expectProductionCandidate && !neutralPreview && !experimentalRealApi && blockingCriteria.length === 0;
  return {
    schema: "hediao3d.opencamlib-production-candidate-promotion.v1",
    status: ready ? "production-candidate-ready" : blockingCriteria.length ? "blocked" : "review",
    productionCandidateReady: ready,
    productionUnlockReady: false,
    evidenceClass: experimentalRealApi ? "experimental-real-api" : neutralPreview ? "preview-scaffold" : ready ? "production-candidate" : "contact-report-review",
    qualityLevel: quality.level ?? null,
    qualityProductionCandidate: Boolean(quality.productionCandidate),
    qualityPostprocessEligible: Boolean(quality.postprocessEligible),
    criterionCount: criteria.length,
    passedCount: criteria.filter((item) => item.status === "pass" || item.status === "not-required").length,
    blockingCount: blockingCriteria.length,
    criteria,
    blockingCriteria: blockingCriteria.slice(0, 10),
    nextActions: createPromotionNextActions(blockingCriteria, experimentalRealApi, neutralPreview),
    productionBoundary: "This promotion audit only explains OpenCAMLib contact output readiness. It never unlocks production NC without material-removal, air-run, trial and machine acceptance evidence."
  };
}

function criterionFromCheck(checks, id, layer, title, missingStatus = "missing") {
  const check = checks.find((item) => item?.id === id);
  if (!check) {
    if (missingStatus === "not-required") {
      return { id, layer, title, status: "not-required", summary: "Not required for this validation run." };
    }
    return { id, layer, title, status: missingStatus, summary: "Check did not run." };
  }
  return {
    id,
    layer,
    title,
    status: check.status === "pass" ? "pass" : "fail",
    summary: check.summary ?? "",
    reported: check.reported ?? null,
    expected: check.expected ?? null,
    tolerance: check.tolerance ?? null,
    validationBasis: check.validationBasis ?? null,
    measured: check.measured ?? null
  };
}

function createPromotionNextActions(blockingCriteria, experimentalRealApi, neutralPreview) {
  const actions = [];
  if (neutralPreview) actions.push("Replace preview/heightfield/scaffold output with real OpenCAMLib drop-cutter/cutter-contact/waterline output.");
  if (experimentalRealApi) actions.push("Promote the OpenCAMLib runner out of experimental-real-api only after residual/material-removal and machine-boundary evidence are validated.");
  const ids = new Set(blockingCriteria.map((item) => item.id));
  if ([...ids].some((id) => id.startsWith("contact-sampling") || id.startsWith("contact-path-coverage"))) actions.push("Increase or repair OpenCAMLib contact sampling until hitRate, step-to-cutter ratio and path coverage pass.");
  if ([...ids].some((id) => id.startsWith("contact-residual"))) actions.push("Bind measured or swept-volume/material-removal validated gouge and undercut metrics within tolerance.");
  if ([...ids].some((id) => id.startsWith("protected-zones"))) actions.push("Regenerate contact output with rotary fixture hold/end protected zones and zero violations.");
  if ([...ids].some((id) => id.startsWith("identity"))) actions.push("Regenerate neutral/contact outputs from the same model and kernel plan so all SHA-256 bindings match.");
  if (!actions.length && blockingCriteria.length) actions.push("Fix the listed OpenCAMLib contact promotion criteria and rerun this validator.");
  if (!actions.length) actions.push("Proceed to candidate package validation, CAMotics/equivalent material-removal validation and field evidence; production remains locked.");
  return actions.slice(0, 6);
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
