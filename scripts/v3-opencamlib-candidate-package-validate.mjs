#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const root = resolve(String(args.root ?? process.cwd()));
const strict = parseBool(args.strict ?? "true");
const outPath = resolvePath(args.out, join(root, "opencamlib-candidate-package-validation.json"));
const bundlePath = resolvePath(args.bundle, join(root, "opencamlib-candidate-package-bundle.zip"));
const defaultValidatorPath = existsSync(join(root, "opencamlib-contact-output-validate.mjs"))
  ? join(root, "opencamlib-contact-output-validate.mjs")
  : resolve("scripts", "v3-opencamlib-contact-output-validate.mjs");
const validatorPath = resolvePath(args.validator, defaultValidatorPath);
const neutralPath = resolvePath(args.neutral, join(root, "neutral-toolpath.json"));
const planPath = resolvePath(args.plan, join(root, "opencamlib-kernel-plan.json"));
const contactPath = resolvePath(args.contact, join(root, "opencamlib-cutter-contact-report.json"));
const explicitModelPath = args.model ? resolve(String(args.model)) : null;

const files = {
  neutral: createFileIdentity(neutralPath, "neutral-toolpath.json"),
  plan: createFileIdentity(planPath, "opencamlib-kernel-plan.json"),
  contact: createFileIdentity(contactPath, "opencamlib-cutter-contact-report.json"),
  validator: createFileIdentity(validatorPath, "opencamlib-contact-output-validate.mjs")
};
const plan = files.plan.exists ? readJson(planPath, "OpenCAMLib kernel plan") : null;
const neutral = files.neutral.exists ? readJson(neutralPath, "neutral toolpath") : null;
const modelPath = explicitModelPath ?? resolveModelPath(plan, planPath);
files.model = createFileIdentity(modelPath, modelPath ? basename(modelPath) : "model");

const missing = Object.entries(files)
  .filter(([key, file]) => key !== "model" && !file.exists)
  .map(([key, file]) => `${key}: ${file.path}`);
if (!files.model.exists) missing.push(`model: ${files.model.path ?? "missing"}`);

let contactValidation = null;
let validatorRun = null;
if (missing.length === 0) {
  validatorRun = spawnSync(process.execPath, [
    validatorPath,
    "--neutral", neutralPath,
    "--plan", planPath,
    "--model", modelPath,
    "--contact", contactPath,
    "--out", join(dirname(outPath), "opencamlib-contact-output-validation.json"),
    "--strict", String(strict)
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  contactValidation = parseValidatorOutput(validatorRun);
}

const blockers = [
  ...missing.map((item) => `missing required file: ${item}`),
  ...(validatorRun && ![0, 3].includes(validatorRun.status) ? [`validator exited ${validatorRun.status}`] : []),
  ...(contactValidation && contactValidation.level !== "ready" ? [`strict contact validation is ${contactValidation.level} (${contactValidation.evidenceClass ?? "unknown-evidence"})`] : []),
  ...(contactValidation?.evidenceClass === "experimental-real-api" ? ["experimental-real-api output is engineering evidence only, not a production candidate"] : [])
];
const machineFit = createNeutralMachineFitPreflight(neutral, plan);
if (machineFit.level === "critical") {
  blockers.push(`neutral machine-fit preflight is critical: ${machineFit.summary}`);
}
const level = blockers.length ? "critical" : "ready";
const artifactManifest = createArtifactManifest({ files, outPath, bundlePath, contactValidation, machineFit });
const handoffContract = createHandoffContract({ level, files, contactValidation, machineFit });
const report = {
  schema: "hediao3d.opencamlib-candidate-package-validation.v1",
  createdAt: new Date().toISOString(),
  level,
  strict,
  root,
  files,
  artifactManifest,
  handoffContract,
  machineFit,
  contactValidation: contactValidation ? createContactValidationSummary(contactValidation) : null,
  validatorRun: validatorRun ? {
    exitCode: validatorRun.status,
    stdoutTail: validatorRun.stdout.slice(-1200),
    stderrTail: validatorRun.stderr.slice(-1200)
  } : null,
  blockers,
  nextActions: level === "ready"
    ? [
      machineFit.level === "review"
        ? "Import neutral-toolpath.json into HeDiao3D only after reviewing machineFit warnings for rotary coverage, protected zones and depth limits."
        : "Import neutral-toolpath.json into HeDiao3D or include this output in native-cam-real-output-bundle.zip.",
      "Continue CAMotics material-removal validation and field air-run/trial evidence before production unlock."
    ]
    : [
      "Regenerate OpenCAMLib neutral/contact outputs with real drop-cutter/cutter-contact/waterline evidence.",
      "Ensure model/plan/neutral/contact hashes match and rerun this preflight."
    ],
  productionBoundary: "This preflight proves only the OpenCAMLib candidate package contract. HeDiao3D still requires postprocess, CAMotics/material-removal, air-run, trial feedback and machine acceptance."
};

writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(bundlePath, createZip(createBundleFiles(report, outPath, files)), "binary");
console.log(JSON.stringify(report, null, 2));

if (strict && level === "critical") {
  process.exitCode = 3;
}

function parseValidatorOutput(run) {
  if (!run) return null;
  const candidates = [
    run.stdout,
    run.stderr
  ].filter(Boolean);
  for (const text of candidates) {
    const parsed = parseLastJsonObject(text);
    if (parsed) return parsed;
  }
  return {
    schema: "hediao3d.opencamlib-contact-output-validation.v1",
    level: "critical",
    errors: [`validator output was not parseable JSON; exit=${run.status}`],
    warnings: [],
    checks: []
  };
}

function parseLastJsonObject(text) {
  const start = text.lastIndexOf("{");
  if (start < 0) return null;
  for (let index = start; index >= 0; index = text.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      continue;
    }
  }
  return null;
}

function createContactValidationSummary(value) {
  const checks = Array.isArray(value.checks) ? value.checks : [];
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  return {
    schema: value.schema ?? "hediao3d.opencamlib-contact-output-validation.v1",
    level: value.level ?? "missing",
    evidenceClass: value.evidenceClass ?? "unknown",
    productionCandidateEligible: Boolean(value.productionCandidateEligible),
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.status === "fail").length,
    errorCount: errors.length,
    warningCount: warnings.length,
    firstError: errors[0] ?? null
  };
}

function createArtifactManifest({ files, outPath, bundlePath, contactValidation, machineFit }) {
  const entries = [
    createManifestEntry("neutral-toolpath", files.neutral, "required", "HeDiao3D imports this neutral cutter-contact point path before rotary-Y postprocessing."),
    createManifestEntry("opencamlib-kernel-plan", files.plan, "required", "Hash-bound CAM kernel plan used by the real OpenCAMLib run."),
    createManifestEntry("cutter-contact-report", files.contact, "required", "Strict cutter-contact, tool, residual and identity evidence."),
    createManifestEntry("source-model", files.model, "required", "Source/repaired mesh identity. The bundle records this hash but does not include the model by default."),
    createManifestEntry("contact-output-validator", files.validator, "audit", "Validator script version used for this preflight."),
    createManifestEntry("candidate-package-validation", createFileIdentity(outPath, "opencamlib-candidate-package-validation.json"), "generated", "This report."),
    createManifestEntry("candidate-package-bundle", createFileIdentity(bundlePath, "opencamlib-candidate-package-bundle.zip"), "generated", "Lightweight evidence ZIP for job audit.")
  ];
  return {
    schema: "hediao3d.opencamlib-candidate-artifact-manifest.v1",
    readyForImport: contactValidation?.level === "ready" && machineFit?.level !== "critical" && entries.every((entry) => entry.required !== true || entry.exists),
    evidenceClass: contactValidation?.evidenceClass ?? "missing",
    machineFitLevel: machineFit?.level ?? "missing",
    entries,
    missingRequired: entries.filter((entry) => entry.required && !entry.exists).map((entry) => entry.filename ?? entry.kind),
    productionBoundary: "These artifacts can enter HeDiao3D as CAM evidence only; they do not bypass material-removal simulation, air-run, trial feedback or machine acceptance."
  };
}

function createManifestEntry(kind, identity, role, description) {
  return {
    kind,
    role,
    required: role === "required",
    path: identity?.path ?? null,
    filename: identity?.filename ?? null,
    exists: Boolean(identity?.exists),
    sizeBytes: identity?.sizeBytes ?? 0,
    sha256: identity?.sha256 ?? null,
    description
  };
}

function createHandoffContract({ level, files, contactValidation, machineFit }) {
  const evidenceClass = contactValidation?.evidenceClass ?? "missing";
  return {
    schema: "hediao3d.opencamlib-neutral-handoff-contract.v1",
    status: level === "ready" ? "ready-for-hediao3d-import" : "blocked",
    evidenceClass,
    importTarget: "OpenCAMLib neutral handoff -> HeDiao3D rotary-Y postprocess -> CAMotics/material-removal -> air-run/trial gate",
    requiredFiles: [
      "neutral-toolpath.json",
      "opencamlib-cutter-contact-report.json",
      "opencamlib-kernel-plan.json",
      files.model.filename || "source/repaired model"
    ],
    requiredSchemas: {
      neutral: "hediao3d.neutral-toolpath.v1",
      contact: "hediao3d.opencamlib-cutter-contact-report.v1",
      plan: "hediao3d.opencamlib-kernel-plan.v1"
    },
    strictAcceptance: {
      contactValidationLevel: contactValidation?.level ?? "not-run",
      contactEvidenceClass: evidenceClass,
      productionCandidateEligible: Boolean(contactValidation?.productionCandidateEligible),
      neutralHashBound: Boolean(contactValidation?.checks?.some((check) => check.id === "identity-neutral" && check.status === "pass")),
      planHashBound: Boolean(contactValidation?.checks?.some((check) => check.id === "identity-plan" && check.status === "pass")),
      modelHashBound: Boolean(contactValidation?.checks?.some((check) => check.id === "identity-model" && check.status === "pass")),
      machineFitLevel: machineFit?.level ?? "missing",
      rotaryCoordinatePresent: Boolean(machineFit?.checks?.rotaryCoordinatePresent),
      protectedZoneClean: Boolean(machineFit?.checks?.protectedZoneClean),
      depthWithinLimit: Boolean(machineFit?.checks?.depthWithinLimit)
    },
    blockedReason: level === "ready"
      ? null
      : evidenceClass === "experimental-real-api"
        ? "OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence."
        : "Candidate output is missing required files or failed strict cutter-contact validation.",
    machineUse: "report-only-until-full-production-gates-pass"
  };
}

function createNeutralMachineFitPreflight(neutral, plan) {
  const settings = extractMachineFitSettings(plan);
  const warnings = [];
  const errors = [];
  const points = Array.isArray(neutral?.points) ? neutral.points : [];
  const finitePoints = points.filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.z)));
  if (!neutral) errors.push("neutral-toolpath.json is missing or unreadable.");
  if (neutral && neutral.schema !== "hediao3d.neutral-toolpath.v1") {
    errors.push(`neutral schema must be hediao3d.neutral-toolpath.v1, got ${neutral.schema ?? "unknown"}.`);
  }
  if (points.length === 0) errors.push("neutral-toolpath has no points.");
  if (finitePoints.length !== points.length) {
    errors.push(`${points.length - finitePoints.length} neutral points are missing finite X/Z coordinates.`);
  }

  const rotaryValues = finitePoints.map((point) => {
    if (Number.isFinite(Number(point.a))) return normalizeAngle(Number(point.a));
    if (settings.rotaryOutputAxis !== "A" && Number.isFinite(Number(point.y))) {
      return normalizeAngle((Number(point.y) / settings.wrapPerRevMm) * 360);
    }
    return null;
  }).filter((value) => Number.isFinite(value));
  if (settings.rotaryMode && finitePoints.length > 0 && rotaryValues.length === 0) {
    errors.push("rotary-wrap neutral output has no usable A angle or Y linearized rotary coordinate.");
  }

  const stats = createMachineFitPointStats(finitePoints, settings);
  const xMin = stats.xMin;
  const xMax = stats.xMax;
  const depthMax = stats.depthMax;
  const holdZonePointCount = stats.holdZonePointCount;
  const deepPointCount = stats.deepPointCount;
  const rotaryCoverage = calculateRotaryCoverage(rotaryValues);
  const expectedRotaryCoverageDeg = settings.expectedRotaryCoverageDeg;
  const rotaryCoverageRatio = settings.rotaryMode && expectedRotaryCoverageDeg > 0
    ? Math.min(1, rotaryCoverage.spanDeg / expectedRotaryCoverageDeg)
    : null;

  if (holdZonePointCount > 0) {
    warnings.push(`${holdZonePointCount} neutral points fall inside protected end/holding zones.`);
  }
  if (deepPointCount > 0) {
    warnings.push(`${deepPointCount} neutral points exceed depth limit ${settings.depthLimitMm.toFixed(2)}mm.`);
  }
  if (settings.rotaryMode && rotaryValues.length > 2 && expectedRotaryCoverageDeg >= 300 && rotaryCoverage.spanDeg < expectedRotaryCoverageDeg * 0.72) {
    warnings.push(`rotary coverage is ${rotaryCoverage.spanDeg.toFixed(1)}deg, below expected ${expectedRotaryCoverageDeg.toFixed(1)}deg.`);
  }

  const level = errors.length ? "critical" : warnings.length ? "review" : "ok";
  return {
    schema: "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
    level,
    summary: level === "ok"
      ? "neutral output matches the target rotary-Y machine boundary for pre-import review."
      : level === "critical"
        ? "neutral output cannot be proven compatible with the target rotary-Y machine boundary."
        : "neutral output can be imported for engineering review, but machine boundary warnings remain.",
    targetMachine: {
      controllerClass: settings.rotaryMode ? "3axis-controller-with-rotary-fixture" : "3axis-cartesian",
      axisMapping: settings.rotaryMode
        ? `X=length, ${settings.rotaryOutputAxis}=rotary fixture, Z=depth/safe height`
        : "X/Y=plane, Z=depth/safe height",
      rotaryOutputAxis: settings.rotaryOutputAxis,
      wrapPerRevolutionMm: settings.wrapPerRevMm,
      toolProfileId: plan?.tool?.toolProfileId ?? null
    },
    stockEnvelope: {
      lengthMm: settings.lengthMm,
      safeMinX: settings.safeMinX,
      safeMaxX: settings.safeMaxX,
      leftHoldMm: settings.leftHoldMm,
      rightHoldMm: settings.rightHoldMm,
      endTransitionMm: settings.endTransitionMm,
      depthLimitMm: settings.depthLimitMm
    },
    coverage: {
      pointCount: points.length,
      finitePointCount: finitePoints.length,
      xMin,
      xMax,
      xSpanMm: xMin == null || xMax == null ? 0 : Math.max(0, xMax - xMin),
      rotarySampleCount: rotaryValues.length,
      rotaryMinDeg: rotaryCoverage.minDeg,
      rotaryMaxDeg: rotaryCoverage.maxDeg,
      rotarySpanDeg: rotaryCoverage.spanDeg,
      expectedRotaryCoverageDeg,
      rotaryCoverageRatio,
      depthMax
    },
    riskCounts: {
      holdZonePointCount,
      deepPointCount,
      invalidPointCount: Math.max(0, points.length - finitePoints.length),
      missingRotaryCount: settings.rotaryMode ? Math.max(0, finitePoints.length - rotaryValues.length) : 0
    },
    checks: {
      schemaValid: neutral?.schema === "hediao3d.neutral-toolpath.v1",
      hasPoints: points.length > 0,
      finiteXz: finitePoints.length === points.length && points.length > 0,
      rotaryCoordinatePresent: !settings.rotaryMode || rotaryValues.length > 0,
      protectedZoneClean: holdZonePointCount === 0,
      depthWithinLimit: deepPointCount === 0
    },
    warnings,
    errors
  };
}

function extractMachineFitSettings(plan) {
  const stock = plan?.stock ?? {};
  const sampling = plan?.sampling ?? {};
  const axisMapping = sampling.axisMapping ?? {};
  const lengthMm = Math.max(1, Number(stock.lengthMm ?? sampling.lengthMm ?? 24));
  const leftHoldMm = Math.max(0, Number(stock.leftHoldMm ?? 0));
  const rightHoldMm = Math.max(0, Number(stock.rightHoldMm ?? 0));
  const endTransitionMm = Math.max(0, Number(stock.endTransitionMm ?? 0));
  const halfLength = lengthMm / 2;
  const maxCutDepthMm = Math.max(0.05, Number(sampling.maxCutDepthMm ?? sampling.depthLimitMm ?? 3));
  return {
    rotaryMode: sampling.recommendedPrimary === "unwrapped-rotary-drop-cutter" || Boolean(axisMapping.rotaryAxis),
    rotaryOutputAxis: String(axisMapping.rotaryAxis ?? "Y").toUpperCase(),
    wrapPerRevMm: Math.max(0.001, Number(axisMapping.rotaryWrapPerRevolutionMm ?? sampling.rotaryWrapPerRevolutionMm ?? 100)),
    expectedRotaryCoverageDeg: Math.max(0, Number(sampling.expectedRotaryCoverageDeg ?? sampling.reliefAngleDeg ?? 360)),
    lengthMm,
    leftHoldMm,
    rightHoldMm,
    endTransitionMm,
    safeMinX: -halfLength + leftHoldMm + endTransitionMm,
    safeMaxX: halfLength - rightHoldMm - endTransitionMm,
    safeZ: Number(sampling.safeZ ?? 0),
    depthLimitMm: maxCutDepthMm + Math.max(0, Number(sampling.stockAllowanceMm ?? 0)) + 0.5
  };
}

function calculateRotaryCoverage(angles) {
  const normalized = [...new Set(angles.map((angle) => normalizeAngle(angle)))].sort((a, b) => a - b);
  if (normalized.length === 0) return { minDeg: null, maxDeg: null, spanDeg: 0 };
  if (normalized.length === 1) return { minDeg: normalized[0], maxDeg: normalized[0], spanDeg: 0 };
  const directSpan = normalized[normalized.length - 1] - normalized[0];
  const wrapGap = 360 - directSpan;
  let largestGap = wrapGap;
  for (let index = 1; index < normalized.length; index += 1) {
    largestGap = Math.max(largestGap, normalized[index] - normalized[index - 1]);
  }
  return {
    minDeg: normalized[0],
    maxDeg: normalized[normalized.length - 1],
    spanDeg: Math.max(0, 360 - largestGap)
  };
}

function createMachineFitPointStats(points, settings) {
  let xMin = null;
  let xMax = null;
  let depthMax = null;
  let holdZonePointCount = 0;
  let deepPointCount = 0;
  for (const point of points) {
    const x = Number(point.x);
    const z = Number(point.z);
    const depth = Number.isFinite(Number(point.depth)) ? Number(point.depth) : Math.max(0, settings.safeZ - z);
    xMin = xMin === null ? x : Math.min(xMin, x);
    xMax = xMax === null ? x : Math.max(xMax, x);
    depthMax = depthMax === null ? depth : Math.max(depthMax, depth);
    if (x < settings.safeMinX || x > settings.safeMaxX) holdZonePointCount += 1;
    if (depth > settings.depthLimitMm) deepPointCount += 1;
  }
  return { xMin, xMax, depthMax, holdZonePointCount, deepPointCount };
}

function normalizeAngle(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function createBundleFiles(report, reportPath, identities) {
  const files = [
    { name: "opencamlib-candidate-package-validation.json", content: Buffer.from(JSON.stringify(report, null, 2), "utf8") },
    { name: "opencamlib-candidate-artifact-manifest.json", content: Buffer.from(JSON.stringify(report.artifactManifest, null, 2), "utf8") },
    { name: "opencamlib-neutral-handoff-contract.json", content: Buffer.from(JSON.stringify(report.handoffContract, null, 2), "utf8") }
  ];
  for (const [key, identity] of Object.entries(identities)) {
    if (!identity.exists || key === "model" || key === "validator") continue;
    files.push({ name: identity.filename, content: readFileSync(identity.path) });
  }
  const contactValidationPath = join(dirname(reportPath), "opencamlib-contact-output-validation.json");
  if (existsSync(contactValidationPath)) {
    files.push({ name: "opencamlib-contact-output-validation.json", content: readFileSync(contactValidationPath) });
  }
  files.push({
    name: "README-OPENCAMLIB-CANDIDATE.md",
    content: Buffer.from([
      "# HeDiao3D OpenCAMLib Candidate Package",
      "",
      "This ZIP is a lightweight preflight bundle for OpenCAMLib neutral/contact output.",
      "It does not contain the source model by default; model identity is recorded in the JSON report.",
      "",
      "Use it before Native CAM real-output import, CAMotics validation, air-run and trial evidence.",
      "",
      "Important:",
      "- The package is report-only until every HeDiao3D production gate passes.",
      "- The model file is not included by default; use the recorded sha256 to verify the exact source/repaired mesh.",
      ""
    ].join("\n"), "utf8")
  });
  return files;
}

function resolveModelPath(plan, planPath) {
  const raw = plan?.model?.path;
  if (!raw) return null;
  const value = String(raw);
  return resolve(dirname(planPath), value);
}

function createFileIdentity(path, fallbackName) {
  if (!path) {
    return { path: null, filename: fallbackName, exists: false, sizeBytes: 0, sha256: null };
  }
  if (!existsSync(path)) {
    return { path, filename: basename(path), exists: false, sizeBytes: 0, sha256: null };
  }
  const bytes = readFileSync(path);
  return {
    path,
    filename: basename(path),
    exists: true,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${path}: ${error.message}`);
  }
}

function resolvePath(value, fallback) {
  return resolve(String(value ?? fallback));
}

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
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

function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data
    ]);
    chunks.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes
    ]));
    offset += local.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  return Buffer.concat([
    ...chunks,
    ...central,
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)
  ]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
