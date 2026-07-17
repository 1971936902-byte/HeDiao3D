#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const [, , jobDirArg, outputDirArg] = process.argv;

if (!jobDirArg) {
  console.error("Usage: camotics_cli_prepare.js <orchestrator-job-dir> [output-dir]");
  process.exit(2);
}

const jobDir = resolve(jobDirArg);
const outputDir = resolve(outputDirArg ?? jobDir);
const planPath = join(jobDir, "camotics-cli-execution-plan.json");

mkdirSync(outputDir, { recursive: true });

const checks = [];
const plan = readJsonIfExists(planPath);
if (!plan) {
  writeBlockedPackage("missing-cli-execution-plan", `Missing ${planPath}`);
  process.exit(0);
}

const requiredInputKeys = [
  ["preferredGcode", plan.inputs?.preferredGcode ?? "camotics-preview.nc"],
  ["projectTemplate", plan.inputs?.projectTemplate ?? "camotics-project-template.json"],
  ["simulationPlan", plan.inputs?.simulationPlan ?? "camotics-simulation-plan.json"]
];
const optionalInputKeys = [
  ["machineGcodeReferenceOnly", plan.inputs?.machineGcodeReferenceOnly ?? "toolpath.nc"],
  ["airRunReferenceOnly", plan.inputs?.airRunReferenceOnly ?? "air-run.nc"]
];

const inputs = {};
for (const [key, filename] of requiredInputKeys) {
  inputs[key] = inspectInputFile(key, filename, true);
}
for (const [key, filename] of optionalInputKeys) {
  inputs[key] = inspectInputFile(key, filename, false);
}

const preferred = inputs.preferredGcode;
const motionProfile = preferred.exists ? createGcodeMotionProfile(readFileSync(preferred.path, "utf8")) : null;
const ready = checks.every((check) => check.ok);
const packageJson = createRunPackage(plan, inputs, motionProfile, ready);

const runPackagePath = join(outputDir, "camotics-cli-run-package.json");
writeFileSync(runPackagePath, JSON.stringify(packageJson, null, 2), "utf8");
const runPackageIdentity = inspectWrittenRunPackage(runPackagePath);
const resultTemplate = createResultTemplate(plan, preferred, motionProfile, runPackageIdentity);
writeFileSync(join(outputDir, "camotics-result-template.json"), JSON.stringify(resultTemplate, null, 2), "utf8");
writeFileSync(join(outputDir, "camotics-linux-run.sh"), createLinuxRunScript(packageJson), "utf8");

console.log(JSON.stringify({
  ok: ready,
  status: packageJson.status,
  outputDir,
  package: join(outputDir, "camotics-cli-run-package.json"),
  resultTemplate: join(outputDir, "camotics-result-template.json"),
  runScript: join(outputDir, "camotics-linux-run.sh"),
  checks: checks.length
}, null, 2));

function writeBlockedPackage(reason, message) {
  const packageJson = {
    schema: "hediao3d.camotics-cli-run-package.v1",
    createdAt: new Date().toISOString(),
    status: "blocked",
    sourceJobDir: jobDir,
    reason,
    checks: [
      { id: reason, ok: false, severity: "critical", message }
    ],
    safetyLocks: {
      productionUnlockFromPreparePackage: false
    }
  };
  writeFileSync(join(outputDir, "camotics-cli-run-package.json"), JSON.stringify(packageJson, null, 2), "utf8");
  console.log(JSON.stringify({ ok: false, status: "blocked", outputDir, reason }, null, 2));
}

function inspectInputFile(key, filename, required) {
  const resolved = resolveJobPath(filename);
  const exists = Boolean(resolved && existsSync(resolved));
  const check = {
    id: `input:${key}`,
    ok: required ? exists : true,
    severity: required && !exists ? "critical" : "info",
    filename,
    path: resolved,
    message: exists
      ? `${filename} exists.`
      : required
        ? `${filename} is required for CAMotics CLI validation.`
        : `${filename} is optional reference material and was not found.`
  };
  checks.push(check);
  if (!exists) {
    return {
      filename,
      path: resolved,
      exists: false,
      required,
      sizeBytes: null,
      sha256: null
    };
  }
  const bytes = readFileSync(resolved);
  const stats = statSync(resolved);
  return {
    filename,
    path: resolved,
    exists: true,
    required,
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function resolveJobPath(value) {
  if (!value) return null;
  if (isAbsolute(value)) return value;
  return join(jobDir, value);
}

function createRunPackage(plan, inspectedInputs, motionProfile, ready) {
  const preferred = inspectedInputs.preferredGcode;
  const expectedResult = plan.expectedOutputs ?? {};
  return {
    schema: "hediao3d.camotics-cli-run-package.v1",
    createdAt: new Date().toISOString(),
    status: ready ? "ready-for-linux-camotics" : "blocked",
    sourceJobDir: jobDir,
    outputDir,
    cliExecutionPlan: {
      schema: plan.schema ?? null,
      status: plan.status ?? null,
      purpose: plan.purpose ?? null
    },
    inputs: inspectedInputs,
    preferredGcodeIdentity: preferred.exists ? {
      filename: preferred.filename,
      sha256: preferred.sha256,
      sizeBytes: preferred.sizeBytes,
      motionProfile
    } : null,
    commandCandidates: normalizeCommands(plan.commandCandidates ?? [], jobDir, outputDir),
    expectedOutputs: {
      resultJson: expectedResult.resultJson ?? "camotics-result.json",
      screenshot: expectedResult.screenshot ?? "camotics-preview.png",
      materialMesh: expectedResult.materialMesh ?? "camotics-material-removal.stl",
      resultTemplate: "camotics-result-template.json"
    },
    importBack: {
      adapterCommand: `HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true HEDIAO3D_CAMOTICS_RESULT_JSON=${shellQuote(join(outputDir, expectedResult.resultJson ?? "camotics-result.json"))} node adapters/camotics/camotics_job.js ${shellQuote(join(jobDir, "camotics-job.json"))} ${shellQuote(join(jobDir, "camotics-adapter-report.json"))}`,
      apiEndpoint: "/api/orchestrator/jobs/:jobId/camotics-result",
      requires: [
        "camotics-result.json 使用 hediao3d.camotics-result.v1",
        "inputs.preferredGcodeSha256 等于 preferredGcodeIdentity.sha256",
        "metrics.motionLineCount/zMin/zMax 与 preferredGcodeIdentity.motionProfile 匹配",
        "至少提供 camotics-preview.png 或 camotics-material-removal.stl"
      ]
    },
    checks,
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false,
      note: "This package prepares a real CAMotics run; it never unlocks production NC by itself."
    }
  };
}

function inspectWrittenRunPackage(path) {
  const bytes = readFileSync(path);
  return {
    filename: "camotics-cli-run-package.json",
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength
  };
}

function createResultTemplate(plan, preferred, motionProfile, runPackageIdentity) {
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId: plan.jobId ?? null,
    engine: "camotics",
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "Fill this file with metrics from the real CAMotics material-removal run before importing it back to HeDiao3D.",
    inputs: {
      preferredGcode: preferred.filename,
      preferredGcodeSha256: preferred.sha256,
      camoticsCliRunPackage: runPackageIdentity.filename,
      camoticsCliRunPackageSha256: runPackageIdentity.sha256,
      expectedMotionProfile: motionProfile
    },
    metrics: {
      motionLineCount: motionProfile?.motionLineCount ?? null,
      zMin: motionProfile?.zMin ?? null,
      zMax: motionProfile?.zMax ?? null,
      materialRemovedMm3: null
    },
    artifacts: {
      screenshot: "camotics-preview.png",
      materialMesh: "camotics-material-removal.stl"
    },
    notes: [
      "materialRemovedMm3 must come from the real CAMotics/material-removal run.",
      "Do not import this template until the screenshot or material-removal STL exists.",
      "Synthetic or hand-edited fixture evidence must remain locked for production."
    ]
  };
}

function normalizeCommands(commands, cwd, outDir) {
  const normalized = commands.map((command) => ({
    id: command.id ?? "command",
    command: command.command ?? "",
    cwd,
    purpose: command.purpose ?? null
  }));
  normalized.push({
    id: "prepare-output-folder",
    command: `mkdir -p ${shellQuote(outDir)}`,
    cwd,
    purpose: "Create the output folder for CAMotics result artifacts."
  });
  return normalized;
}

function createLinuxRunScript(packageJson) {
  const preferred = packageJson.inputs?.preferredGcode?.filename ?? "camotics-preview.nc";
  const resultJson = packageJson.expectedOutputs?.resultJson ?? "camotics-result.json";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `cd ${shellQuote(packageJson.sourceJobDir)}`,
    `mkdir -p ${shellQuote(packageJson.outputDir)}`,
    "echo '[HeDiao3D] CAMotics CLI run package prepared.'",
    `echo '[HeDiao3D] Preferred G-code: ${preferred}'`,
    `echo '[HeDiao3D] Expected SHA-256: ${packageJson.preferredGcodeIdentity?.sha256 ?? "missing"}'`,
    "",
    "if command -v camotics >/dev/null 2>&1; then",
    `  echo '[HeDiao3D] Opening CAMotics preview: ${preferred}'`,
    `  camotics ${shellQuote(preferred)} || true`,
    "else",
    "  echo '[HeDiao3D] camotics command not found; install CAMotics or run the equivalent validated simulator.' >&2",
    "fi",
    "",
    `echo '[HeDiao3D] Fill ${resultJson} from real material-removal metrics, then import it back.'`,
    `echo '[HeDiao3D] Template: ${join(packageJson.outputDir, "camotics-result-template.json")}'`,
    ""
  ].join("\n");
}

function createGcodeMotionProfile(gcodeText) {
  const motionLines = String(gcodeText ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line));
  const zValues = motionLines
    .map((line) => parseWord(line, "Z"))
    .filter(Number.isFinite);
  return {
    motionLineCount: motionLines.length,
    zMin: zValues.length ? Math.min(...zValues) : null,
    zMax: zValues.length ? Math.max(...zValues) : null
  };
}

function parseWord(line, word) {
  const match = line.match(new RegExp(`\\b${word}\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : NaN;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
