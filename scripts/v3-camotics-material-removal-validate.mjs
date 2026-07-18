#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const resultPath = requiredPath(args.result, "--result");
const runPackagePath = requiredPath(args.runPackage ?? args["run-package"], "--run-package");
const outPath = args.out ? resolve(String(args.out)) : join(dirname(resultPath), "camotics-result-local-validation.json");
const bundlePath = args.bundle ? resolve(String(args.bundle)) : join(dirname(resultPath), "camotics-result-bundle.zip");
const strict = parseBool(args.strict ?? "true");

const result = readJson(resultPath, "CAMotics result");
const runPackage = readJson(runPackagePath, "CAMotics CLI run package");
const validation = validateMaterialRemovalResult({ resultPath, result, runPackagePath, runPackage, args, bundlePath });

writeFileSync(outPath, JSON.stringify(validation, null, 2), "utf8");
if (validation.ok) {
  writeFileSync(bundlePath, createResultBundle({ resultPath, validationPath: outPath, artifactEvidence: validation.artifactEvidence }));
}
console.log(JSON.stringify(validation, null, 2));

if (strict && !validation.ok) {
  process.exitCode = 3;
}

function validateMaterialRemovalResult({ resultPath, result, runPackagePath, runPackage, args, bundlePath }) {
  const checks = [];
  const expectedGcode = runPackage.preferredGcodeIdentity ?? {};
  const expectedMotion = expectedGcode.motionProfile ?? {};
  const expectedMachineContext = expectedGcode.machineContext ?? expectedMotion.machineContext ?? {};
  const expectedRunPackageSha = sha256File(runPackagePath);

  check(checks, "run-package-schema", runPackage.schema === "hediao3d.camotics-cli-run-package.v1", "run package schema must be hediao3d.camotics-cli-run-package.v1.");
  check(checks, "run-package-ready", runPackage.status === "ready-for-linux-camotics", "run package must be ready-for-linux-camotics.");
  check(checks, "run-package-no-production-unlock", runPackage.safetyLocks?.productionUnlockFromPreparePackage === false, "run package must not unlock production by itself.");
  check(checks, "result-schema", result.schema === "hediao3d.camotics-result.v1", "result schema must be hediao3d.camotics-result.v1.");
  check(checks, "result-status", result.status === "completed", "result status must be completed.");
  check(checks, "result-non-synthetic", result.synthetic === false, "result.synthetic must be false.");
  check(checks, "result-risk-ready", result.riskLevel === "ready", "result.riskLevel must be ready.");
  check(checks, "preferred-gcode-hash", Boolean(expectedGcode.sha256) && result.inputs?.preferredGcodeSha256 === expectedGcode.sha256, "result inputs.preferredGcodeSha256 must match run package preferred G-code SHA-256.", {
    expected: expectedGcode.sha256 ?? null,
    reported: result.inputs?.preferredGcodeSha256 ?? null
  });
  check(checks, "run-package-hash", result.inputs?.camoticsCliRunPackageSha256 === expectedRunPackageSha, "result inputs.camoticsCliRunPackageSha256 must match camotics-cli-run-package.json SHA-256.", {
    expected: expectedRunPackageSha,
    reported: result.inputs?.camoticsCliRunPackageSha256 ?? null
  });
  check(checks, "machine-context", machineContextMatches(result.inputs?.machineContext, expectedMachineContext), "result inputs.machineContext must match run package machine context.", {
    expected: expectedMachineContext,
    reported: result.inputs?.machineContext ?? null
  });
  check(checks, "motion-line-count", Number(result.metrics?.motionLineCount) === Number(expectedMotion.motionLineCount), "result metrics.motionLineCount must match run package motion profile.", {
    expected: expectedMotion.motionLineCount ?? null,
    reported: result.metrics?.motionLineCount ?? null
  });
  check(checks, "z-min", close(Number(result.metrics?.zMin), Number(expectedMotion.zMin), 0.05), "result metrics.zMin must match run package within 0.05mm.", {
    expected: expectedMotion.zMin ?? null,
    reported: result.metrics?.zMin ?? null
  });
  check(checks, "z-max", close(Number(result.metrics?.zMax), Number(expectedMotion.zMax), 0.05), "result metrics.zMax must match run package within 0.05mm.", {
    expected: expectedMotion.zMax ?? null,
    reported: result.metrics?.zMax ?? null
  });
  check(checks, "material-removed", Number.isFinite(Number(result.metrics?.materialRemovedMm3)) && Number(result.metrics.materialRemovedMm3) >= 0, "result metrics.materialRemovedMm3 must be a real non-negative number.");

  const artifactEvidence = inspectArtifacts({ result, resultPath, args, runPackage });
  check(checks, "visual-or-material-artifact", artifactEvidence.hasScreenshot || artifactEvidence.hasMaterialMesh, "provide at least one real artifact: screenshot or material-removal mesh.", artifactEvidence);

  const failed = checks.filter((item) => item.status === "fail");
  const ok = failed.length === 0;
  return {
    schema: "hediao3d.camotics-result-local-validation.v1",
    createdAt: new Date().toISOString(),
    ok,
    level: ok ? "ready" : "critical",
    productionEvidenceEligible: ok,
    result: {
      path: resultPath,
      filename: basename(resultPath),
      sha256: sha256File(resultPath)
    },
    runPackage: {
      path: runPackagePath,
      filename: basename(runPackagePath),
      sha256: expectedRunPackageSha,
      status: runPackage.status ?? null
    },
    checks,
    missing: failed.map((item) => item.id),
    artifactEvidence,
    output: {
      localValidation: basename(outPath),
      uploadBundle: ok ? basename(bundlePath) : null
    },
    safetyBoundary: "This validator only proves CAMotics/material-removal evidence identity and completeness. Production NC still requires external CAM proof, postprocess checks, air-run, trial feedback and machine acceptance in the same HeDiao3D job.",
    nextActions: ok
      ? [
        "Upload camotics-result-bundle.zip to the current HeDiao3D V3 job.",
        "Regenerate readiness and continue air-run, soft-material trial and machine acceptance."
      ]
      : [
        "Fix every failed check before importing this CAMotics result.",
        "Keep production NC locked until non-synthetic material-removal evidence is hash-bound to the current run package."
      ],
    summary: ok
      ? "CAMotics material-removal validation passed."
      : `CAMotics material-removal validation failed: ${failed.map((item) => item.id).join(", ")}`
  };
}

function inspectArtifacts({ result, resultPath, args, runPackage }) {
  const resultDir = dirname(resultPath);
  const expectedOutputs = runPackage.expectedOutputs ?? {};
  const screenshotPath = resolveArtifact(args.screenshot ?? result.artifacts?.screenshot ?? expectedOutputs.screenshot, resultDir);
  const materialMeshPath = resolveArtifact(args.materialMesh ?? args["material-mesh"] ?? result.artifacts?.materialMesh ?? expectedOutputs.materialMesh, resultDir);
  const screenshot = inspectFile(screenshotPath);
  const materialMesh = inspectFile(materialMeshPath);
  return {
    screenshot,
    materialMesh,
    hasScreenshot: screenshot.exists,
    hasMaterialMesh: materialMesh.exists
  };
}

function machineContextMatches(imported, expected) {
  if (!expected || Object.keys(expected).length === 0) return true;
  if (!imported || typeof imported !== "object") return false;
  const expectedMode = String(expected.camMode ?? "");
  const importedMode = String(imported.camMode ?? "");
  const expectedAxis = String(expected.rotaryWrapAxis ?? expected.rotaryOutputAxis ?? "").toUpperCase();
  const importedAxis = String(imported.rotaryWrapAxis ?? imported.rotaryOutputAxis ?? "").toUpperCase();
  const expectedLengthAxis = String(expected.lengthAxis ?? "X").toUpperCase();
  const importedLengthAxis = String(imported.lengthAxis ?? "X").toUpperCase();
  const expectedWrap = Number(expected.rotaryWrapPerRevolutionMm);
  const importedWrap = Number(imported.rotaryWrapPerRevolutionMm);
  return importedMode === expectedMode
    && importedAxis === expectedAxis
    && importedLengthAxis === expectedLengthAxis
    && close(importedWrap, expectedWrap, 0.001);
}

function check(checks, id, pass, summary, details = {}) {
  checks.push({ id, status: pass ? "pass" : "fail", ok: Boolean(pass), severity: pass ? "info" : "critical", summary, ...details });
}

function resolveArtifact(value, baseDir) {
  if (!value || typeof value !== "string") return null;
  return isAbsolute(value) ? value : join(baseDir, value);
}

function inspectFile(path) {
  if (!path || !existsSync(path)) return { path, exists: false, sizeBytes: null, sha256: null };
  const bytes = readFileSync(path);
  const stats = statSync(path);
  return {
    path,
    exists: true,
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function createResultBundle({ resultPath, validationPath, artifactEvidence }) {
  const files = [
    { name: "camotics-result.json", content: readFileSync(resultPath) },
    { name: "camotics-result-local-validation.json", content: readFileSync(validationPath) },
    {
      name: "README-CAMOTICS-RESULT.md",
      content: Buffer.from([
        "# HeDiao3D CAMotics Result Bundle",
        "",
        "Upload this ZIP in the HeDiao3D V3 CAMotics result import panel.",
        "",
        "Included files:",
        "- camotics-result.json",
        "- camotics-result-local-validation.json",
        "- camotics-preview.png and/or camotics-material-removal.stl when available",
        "",
        "This bundle is material-removal evidence only. It does not unlock production NC by itself.",
        ""
      ].join("\n"), "utf8")
    }
  ];
  if (artifactEvidence?.hasScreenshot && artifactEvidence.screenshot?.path) {
    files.push({ name: "camotics-preview.png", content: readFileSync(artifactEvidence.screenshot.path) });
  }
  if (artifactEvidence?.hasMaterialMesh && artifactEvidence.materialMesh?.path) {
    files.push({ name: "camotics-material-removal.stl", content: readFileSync(artifactEvidence.materialMesh.path) });
  }
  return createZip(files);
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
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]));
    offset += local.length;
  }
  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  return Buffer.concat([
    ...chunks,
    centralBuffer,
    Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralBuffer.length), u32(centralOffset), u16(0)
    ])
  ]);
}

function close(actual, expected, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
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
  const path = resolve(String(value));
  if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
  return path;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}
