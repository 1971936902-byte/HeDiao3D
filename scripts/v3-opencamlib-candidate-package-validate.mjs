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
const validatorPath = resolvePath(args.validator, resolve("scripts", "v3-opencamlib-contact-output-validate.mjs"));
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
  ...(contactValidation && contactValidation.level !== "ready" ? [`strict contact validation is ${contactValidation.level}`] : [])
];
const level = blockers.length ? "critical" : "ready";
const report = {
  schema: "hediao3d.opencamlib-candidate-package-validation.v1",
  createdAt: new Date().toISOString(),
  level,
  strict,
  root,
  files,
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
    productionCandidateEligible: Boolean(value.productionCandidateEligible),
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.status === "fail").length,
    errorCount: errors.length,
    warningCount: warnings.length,
    firstError: errors[0] ?? null
  };
}

function createBundleFiles(report, reportPath, identities) {
  const files = [
    { name: "opencamlib-candidate-package-validation.json", content: Buffer.from(JSON.stringify(report, null, 2), "utf8") }
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
