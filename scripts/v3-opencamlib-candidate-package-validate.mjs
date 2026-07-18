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
const level = blockers.length ? "critical" : "ready";
const artifactManifest = createArtifactManifest({ files, outPath, bundlePath, contactValidation });
const handoffContract = createHandoffContract({ level, files, contactValidation });
const report = {
  schema: "hediao3d.opencamlib-candidate-package-validation.v1",
  createdAt: new Date().toISOString(),
  level,
  strict,
  root,
  files,
  artifactManifest,
  handoffContract,
  contactValidation: contactValidation ? createContactValidationSummary(contactValidation) : null,
  validatorRun: validatorRun ? {
    exitCode: validatorRun.status,
    stdoutTail: validatorRun.stdout.slice(-1200),
    stderrTail: validatorRun.stderr.slice(-1200)
  } : null,
  blockers,
  nextActions: level === "ready"
    ? [
      "Import neutral-toolpath.json into HeDiao3D or include this output in native-cam-real-output-bundle.zip.",
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

function createArtifactManifest({ files, outPath, bundlePath, contactValidation }) {
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
    readyForImport: contactValidation?.level === "ready" && entries.every((entry) => entry.required !== true || entry.exists),
    evidenceClass: contactValidation?.evidenceClass ?? "missing",
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

function createHandoffContract({ level, files, contactValidation }) {
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
      modelHashBound: Boolean(contactValidation?.checks?.some((check) => check.id === "identity-model" && check.status === "pass"))
    },
    blockedReason: level === "ready"
      ? null
      : evidenceClass === "experimental-real-api"
        ? "OpenCAMLib real API output is experimental and lacks production residual/material-removal/machine evidence."
        : "Candidate output is missing required files or failed strict cutter-contact validation.",
    machineUse: "report-only-until-full-production-gates-pass"
  };
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
