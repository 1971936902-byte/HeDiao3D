#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
  ["airRunReferenceOnly", plan.inputs?.airRunReferenceOnly ?? "air-run.nc"],
  ["nativeCamRealOutputSnapshot", plan.inputs?.nativeCamRealOutputSnapshot ?? "native-cam-real-output-snapshot.json"],
  ["nativeCamRealOutputAcceptance", plan.inputs?.nativeCamRealOutputAcceptance ?? "native-cam-real-output-acceptance.json"],
  ["opencamlibContactValidation", plan.inputs?.opencamlibContactValidation ?? "opencamlib-contact-output-validation.json"],
  ["opencamlibRealCandidateRun", plan.inputs?.opencamlibRealCandidateRun ?? "opencamlib-real-candidate-run.json"],
  ["opencamlibCandidatePackageValidation", plan.inputs?.opencamlibCandidatePackageValidation ?? "opencamlib-candidate-package-validation.json"],
  ["opencamlibCandidatePackageBundle", plan.inputs?.opencamlibCandidatePackageBundle ?? "opencamlib-candidate-package-bundle.zip"],
  ["sourceAdapterValidation", plan.inputs?.sourceAdapterValidation ?? "v3-external-adapter-validation.json"]
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
const machineContext = preferred.exists ? createMachineContextFromGcode(readFileSync(preferred.path, "utf8")) : null;
const ready = checks.every((check) => check.ok);
const packageJson = createRunPackage(plan, inputs, motionProfile, machineContext, ready);

const runPackagePath = join(outputDir, "camotics-cli-run-package.json");
writeFileSync(runPackagePath, JSON.stringify(packageJson, null, 2), "utf8");
const runPackageIdentity = inspectWrittenRunPackage(runPackagePath);
const resultTemplate = createResultTemplate(plan, preferred, motionProfile, runPackageIdentity);
writeFileSync(join(outputDir, "camotics-result-template.json"), JSON.stringify(resultTemplate, null, 2), "utf8");
writeFileSync(join(outputDir, "camotics-linux-run.sh"), createLinuxRunScript(packageJson), "utf8");
writeFileSync(join(outputDir, "camotics-result-validate.js"), createResultValidatorScript(packageJson), "utf8");
writeFileSync(join(outputDir, "camotics-linux-operator-checklist.md"), createLinuxOperatorChecklist(packageJson, runPackageIdentity, resultTemplate), "utf8");

console.log(JSON.stringify({
  ok: ready,
  status: packageJson.status,
  outputDir,
  package: join(outputDir, "camotics-cli-run-package.json"),
  resultTemplate: join(outputDir, "camotics-result-template.json"),
  runScript: join(outputDir, "camotics-linux-run.sh"),
  validator: join(outputDir, "camotics-result-validate.js"),
  operatorChecklist: join(outputDir, "camotics-linux-operator-checklist.md"),
  checks: checks.length
}, null, 2));

function writeBlockedPackage(reason, message) {
  const packageJson = {
    schema: "hediao3d.camotics-cli-run-package.v1",
    jobId: plan.jobId ?? inferJobIdFromPath(jobDir),
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

function createRunPackage(plan, inspectedInputs, motionProfile, machineContext, ready) {
  const preferred = inspectedInputs.preferredGcode;
  const expectedResult = plan.expectedOutputs ?? {};
  const upstreamCamEvidence = createUpstreamCamEvidence(inspectedInputs);
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
      motionProfile,
      machineContext
    } : null,
    upstreamCamEvidence,
    commandCandidates: normalizeCommands(plan.commandCandidates ?? [], jobDir, outputDir),
    expectedOutputs: {
      resultJson: expectedResult.resultJson ?? "camotics-result.json",
      screenshot: expectedResult.screenshot ?? "camotics-preview.png",
      materialMesh: expectedResult.materialMesh ?? "camotics-material-removal.stl",
      resultTemplate: "camotics-result-template.json",
      resultValidator: "camotics-result-validate.js",
      operatorChecklist: "camotics-linux-operator-checklist.md"
    },
    simulatorEvidence: {
      schema: "hediao3d.material-removal-simulator-evidence.v1",
      acceptedEngines: ["camotics", "equivalent-material-removal-simulator"],
      requiredFields: ["simulator.name", "simulator.version", "simulator.sourceCommand"],
      note: "Ubuntu 24.04 may not run legacy CAMotics directly. Equivalent simulators are acceptable only when the same hash, motion, machine-context and artifact checks pass."
    },
    importBack: {
      adapterCommand: `HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true HEDIAO3D_CAMOTICS_RESULT_JSON=${shellQuote(join(outputDir, expectedResult.resultJson ?? "camotics-result.json"))} node adapters/camotics/camotics_job.js ${shellQuote(join(jobDir, "camotics-job.json"))} ${shellQuote(join(jobDir, "camotics-adapter-report.json"))}`,
      apiEndpoint: "/api/orchestrator/jobs/:jobId/camotics-result",
      requires: [
        "先在 Linux CAM 服务器运行 node camotics-result-validate.js，通过后再回填",
        "camotics-result.json 使用 hediao3d.camotics-result.v1",
        "inputs.preferredGcodeSha256 等于 preferredGcodeIdentity.sha256",
        "inputs.camoticsCliRunPackageSha256 等于 camotics-cli-run-package.json 的 SHA-256",
        "inputs.machineContext 与 preferredGcodeIdentity.machineContext 一致",
        "若 upstreamCamEvidence.required=true，inputs.upstreamCamEvidence 必须匹配准备包中的上游 CAM/OpenCAMLib 证据哈希",
        "metrics.motionLineCount/zMin/zMax 与 preferredGcodeIdentity.motionProfile 匹配",
        "至少提供 camotics-preview.png 或 camotics-material-removal.stl",
        "simulator.name/version/sourceCommand 记录实际使用的 CAMotics 或等效材料去除仿真器"
      ]
    },
    checks,
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false,
      note: "This package prepares a real CAMotics/equivalent material-removal simulation run; it never unlocks production NC by itself."
    },
    operatorChecklist: {
      filename: "camotics-linux-operator-checklist.md",
      purpose: "Step-by-step Linux CAMotics run, validation and import-back checklist for the operator."
    }
  };
}

function createUpstreamCamEvidence(inspectedInputs) {
  const candidatePackageValidation = readJsonIfExists(inspectedInputs.opencamlibCandidatePackageValidation?.path);
  const nativeSnapshot = readJsonIfExists(inspectedInputs.nativeCamRealOutputSnapshot?.path);
  const candidateMachineFit = summarizeCandidateMachineFit(candidatePackageValidation?.machineFit);
  const materialRemovalReadiness = summarizeMaterialRemovalReadiness(candidatePackageValidation?.materialRemovalReadiness);
  const candidates = [
    ["nativeCamRealOutputSnapshot", "native-cam-real-output-snapshot.json", "Job-local Native CAM 真实输出快照"],
    ["nativeCamRealOutputAcceptance", "native-cam-real-output-acceptance.json", "Native CAM 真实输出验收"],
    ["opencamlibContactValidation", "opencamlib-contact-output-validation.json", "OpenCAMLib strict contact 验收"],
    ["opencamlibRealCandidateRun", "opencamlib-real-candidate-run.json", "OpenCAMLib 一键真实候选链路"],
    ["opencamlibCandidatePackageValidation", "opencamlib-candidate-package-validation.json", "OpenCAMLib 候选包预检"],
    ["opencamlibCandidatePackageBundle", "opencamlib-candidate-package-bundle.zip", "OpenCAMLib 候选包证据包"],
    ["sourceAdapterValidation", "v3-external-adapter-validation.json", "外部 CAM adapter 源报告"]
  ];
  const files = candidates.map(([key, expectedFilename, label]) => {
    const input = inspectedInputs[key] ?? {};
    return {
      key,
      label,
      filename: input.filename ?? expectedFilename,
      exists: Boolean(input.exists),
      sizeBytes: input.sizeBytes ?? null,
      sha256: input.sha256 ?? null
    };
  });
  const present = files.filter((file) => file.exists && file.sha256);
  return {
    schema: "hediao3d.camotics-upstream-cam-evidence.v1",
    status: present.length > 0 ? "hash-bound" : "missing",
    required: present.length > 0,
    presentCount: present.length,
    nativeCamRealOutputSnapshot: summarizeNativeCamRealOutputSnapshot(nativeSnapshot),
    candidateMachineFit,
    materialRemovalReadiness,
    files,
    summary: present.length > 0
      ? `CAMotics run package is hash-bound to ${present.length} upstream CAM/OpenCAMLib evidence file(s).`
      : "No upstream Native CAM/OpenCAMLib evidence file was present in this job folder when the CAMotics package was prepared."
  };
}

function summarizeNativeCamRealOutputSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    schema: snapshot.schema ?? "hediao3d.native-cam-real-output-snapshot.v1",
    acceptanceId: snapshot.acceptance?.id ?? null,
    level: snapshot.gateHints?.level ?? snapshot.acceptance?.level ?? null,
    sourceReportBindingStatus: snapshot.gateHints?.sourceReportBindingStatus ?? null,
    targetMachineBoundaryStatus: snapshot.gateHints?.targetMachineBoundaryStatus ?? null,
    contactValidationStatus: snapshot.gateHints?.contactValidationStatus ?? null,
    canSupportProductionCandidateReview: Boolean(snapshot.gateHints?.canSupportProductionCandidateReview),
    productionUnlockEligible: false
  };
}

function summarizeMaterialRemovalReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") return null;
  const missingForProduction = Array.isArray(readiness.missingForProduction)
    ? readiness.missingForProduction.map((item) => String(item)).filter(Boolean).slice(0, 12)
    : [];
  const simulationQuality = readiness.simulationQuality && typeof readiness.simulationQuality === "object"
    ? {
        schema: readiness.simulationQuality.schema ?? "hediao3d.opencamlib-material-removal-simulation-quality.v1",
        level: readiness.simulationQuality.level ?? null,
        engineeringSimulationAllowed: Boolean(readiness.simulationQuality.engineeringSimulationAllowed),
        productionEvidenceAllowed: Boolean(readiness.simulationQuality.productionEvidenceAllowed),
        riskCount: Number.isFinite(Number(readiness.simulationQuality.riskCount)) ? Number(readiness.simulationQuality.riskCount) : null,
        risks: Array.isArray(readiness.simulationQuality.risks)
          ? readiness.simulationQuality.risks.map((item) => String(item)).filter(Boolean).slice(0, 12)
          : [],
        stepToCutterRatio: Number.isFinite(Number(readiness.simulationQuality.stepToCutterRatio)) ? Number(readiness.simulationQuality.stepToCutterRatio) : null,
        hitRate: Number.isFinite(Number(readiness.simulationQuality.hitRate)) ? Number(readiness.simulationQuality.hitRate) : null,
        xCoverageRatio: Number.isFinite(Number(readiness.simulationQuality.xCoverageRatio)) ? Number(readiness.simulationQuality.xCoverageRatio) : null,
        crossCoverageRatio: Number.isFinite(Number(readiness.simulationQuality.crossCoverageRatio)) ? Number(readiness.simulationQuality.crossCoverageRatio) : null,
        summary: readiness.simulationQuality.summary ?? null
      }
    : null;
  return {
    schema: readiness.schema ?? "hediao3d.opencamlib-material-removal-readiness.v1",
    level: readiness.level ?? (readiness.readyForMaterialRemovalSimulation ? "ready-for-camotics-or-equivalent" : "blocked"),
    readyForMaterialRemovalSimulation: Boolean(readiness.readyForMaterialRemovalSimulation),
    simulationQuality,
    productionResidualEvidenceReady: Boolean(readiness.productionResidualEvidenceReady),
    missingForProduction,
    summary: readiness.summary ?? null
  };
}

function summarizeCandidateMachineFit(machineFit) {
  if (!machineFit || typeof machineFit !== "object") return null;
  return {
    schema: machineFit.schema ?? "hediao3d.opencamlib-candidate-machine-fit-preflight.v1",
    level: machineFit.level ?? "missing",
    summary: machineFit.summary ?? null,
    targetMachine: machineFit.targetMachine ? {
      controllerClass: machineFit.targetMachine.controllerClass ?? null,
      rotaryOutputAxis: machineFit.targetMachine.rotaryOutputAxis ?? null,
      wrapPerRevolutionMm: numberOrNull(machineFit.targetMachine.wrapPerRevolutionMm),
      toolProfileId: machineFit.targetMachine.toolProfileId ?? null
    } : null,
    coverage: machineFit.coverage ? {
      pointCount: Number(machineFit.coverage.pointCount ?? 0),
      rotarySpanDeg: numberOrNull(machineFit.coverage.rotarySpanDeg),
      expectedRotaryCoverageDeg: numberOrNull(machineFit.coverage.expectedRotaryCoverageDeg),
      rotaryCoverageRatio: numberOrNull(machineFit.coverage.rotaryCoverageRatio),
      depthMax: numberOrNull(machineFit.coverage.depthMax)
    } : null,
    riskCounts: machineFit.riskCounts ? {
      holdZonePointCount: Number(machineFit.riskCounts.holdZonePointCount ?? 0),
      deepPointCount: Number(machineFit.riskCounts.deepPointCount ?? 0),
      invalidPointCount: Number(machineFit.riskCounts.invalidPointCount ?? 0),
      missingRotaryCount: Number(machineFit.riskCounts.missingRotaryCount ?? 0)
    } : null
  };
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
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
  const machineContext = motionProfile?.machineContext ?? createMachineContextFromGcode(preferred.exists ? readFileSync(preferred.path, "utf8") : "");
  const runPackage = readJsonIfExists(runPackageIdentity.path) ?? {};
  return {
    schema: "hediao3d.camotics-result.v1",
    jobId: plan.jobId ?? null,
    engine: "camotics",
    simulator: {
      schema: "hediao3d.material-removal-simulator.v1",
      name: "camotics",
      version: null,
      sourceCommand: "camotics camotics-preview.nc",
      equivalentSimulator: false
    },
    status: "completed",
    synthetic: false,
    riskLevel: "ready",
    summary: "Fill this file with metrics from the real CAMotics or equivalent material-removal run before importing it back to HeDiao3D.",
    inputs: {
      preferredGcode: preferred.filename,
      preferredGcodeSha256: preferred.sha256,
      camoticsCliRunPackage: runPackageIdentity.filename,
      camoticsCliRunPackageSha256: runPackageIdentity.sha256,
      machineContext,
      expectedMotionProfile: motionProfile,
      upstreamCamEvidence: runPackage.upstreamCamEvidence ?? null
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
      "Before importing, run: node camotics-result-validate.js",
      "materialRemovedMm3 must come from the real CAMotics/material-removal run.",
      "If CAMotics is not usable on this Linux host, record the equivalent simulator name/version/sourceCommand and keep synthetic=false only for real material-removal evidence.",
      "If inputs.upstreamCamEvidence.required=true, keep every listed upstream CAM/OpenCAMLib SHA-256 unchanged.",
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
  const runReport = "camotics-material-removal-run.json";
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
    "write_blocked_report() {",
    `  cat > ${shellQuote(join(packageJson.outputDir, runReport))} <<'JSON'`,
    "{",
    "  \"schema\": \"hediao3d.camotics-material-removal-run.v1\",",
    "  \"ok\": false,",
    "  \"level\": \"blocked\",",
    "  \"productionLocked\": true,",
    "  \"summary\": \"No headless CAMotics/equivalent simulator command was configured. The GUI camotics command is intentionally not launched by this script because it can hang on servers.\",",
    "  \"nextActions\": [",
    "    \"Install camotics-cli or provide HEDIAO3D_CAMOTICS_RUN_COMMAND that writes camotics-result.json.\",",
    "    \"Alternatively fill camotics-result-template.json with real non-synthetic material-removal evidence and run node camotics-result-validate.js.\"",
    "  ]",
    "}",
    "JSON",
    "}",
    "",
    "if [[ -n \"${HEDIAO3D_CAMOTICS_RUN_COMMAND:-}\" ]]; then",
    "  echo '[HeDiao3D] Running configured material-removal simulator command.'",
    "  eval \"$HEDIAO3D_CAMOTICS_RUN_COMMAND\"",
    "elif command -v camotics-cli >/dev/null 2>&1; then",
    "  echo '[HeDiao3D] Running camotics-cli candidate command.'",
    `  camotics-cli ${shellQuote(preferred)} || true`,
    "elif [[ \"${HEDIAO3D_DISABLE_INTERNAL_MATERIAL_REMOVAL_SIM:-0}\" != \"1\" ]]; then",
    "  echo '[HeDiao3D] No headless camotics-cli found; running HeDiao3D internal swept-envelope material-removal simulator.'",
    `  node - ${shellQuote(packageJson.outputDir)} ${shellQuote(preferred)} <<'NODE'`,
    "const { createHash } = require('crypto');",
    "const { existsSync, readFileSync, writeFileSync, copyFileSync } = require('fs');",
    "const { dirname, join } = require('path');",
    "const outDir = process.argv[2];",
    "const preferredName = process.argv[3];",
    "const runPackagePath = join(outDir, 'camotics-cli-run-package.json');",
    "const runPackage = JSON.parse(readFileSync(runPackagePath, 'utf8'));",
    "const gcodePath = runPackage.inputs?.preferredGcode?.path || preferredName;",
    "const gcodeText = existsSync(gcodePath) ? readFileSync(gcodePath, 'utf8') : '';",
    "const motion = runPackage.preferredGcodeIdentity?.motionProfile || estimateMotion(gcodeText);",
    "const machineContext = runPackage.preferredGcodeIdentity?.machineContext || motion.machineContext || {};",
    "const sourceStats = estimateSweptRemoval(gcodeText, motion);",
    "const materialMesh = join(outDir, 'camotics-material-removal.stl');",
    "writeFileSync(materialMesh, createSweptEnvelopeStl(sourceStats), 'utf8');",
    "const result = {",
    "  schema: 'hediao3d.camotics-result.v1',",
    "  jobId: process.env.HEDIAO3D_JOB_ID || runPackage.jobId || null,",
    "  engine: 'equivalent-material-removal-simulator',",
    "  simulator: {",
    "    schema: 'hediao3d.material-removal-simulator.v1',",
    "    name: 'HeDiao3D internal swept-envelope material-removal simulator',",
    "    version: '0.1.0',",
    "    sourceCommand: 'node camotics-linux-run.sh internal-swept-envelope',",
    "    equivalentSimulator: true,",
    "    notes: 'Engineering swept-envelope verification for linearized rotary-wrap G-code when headless CAMotics is unavailable. Not a CAMotics replacement for final production sign-off.'",
    "  },",
    "  status: 'completed',",
    "  synthetic: false,",
    "  riskLevel: 'ready',",
    "  summary: 'Internal swept-envelope material-removal simulation completed from the hash-bound CAMotics preview NC. Production remains locked until full readiness, air-run, trial feedback and machine acceptance pass.',",
    "  inputs: {",
    "    preferredGcode: runPackage.inputs?.preferredGcode?.filename || preferredName,",
    "    preferredGcodeSha256: runPackage.preferredGcodeIdentity?.sha256 || sha256Text(gcodeText),",
    "    camoticsCliRunPackage: 'camotics-cli-run-package.json',",
    "    camoticsCliRunPackageSha256: sha256File(runPackagePath),",
    "    machineContext,",
    "    expectedMotionProfile: motion,",
    "    upstreamCamEvidence: runPackage.upstreamCamEvidence || null",
    "  },",
    "  metrics: {",
    "    motionLineCount: Number(motion.motionLineCount || sourceStats.motionLineCount || 0),",
    "    zMin: finiteOrNull(motion.zMin),",
    "    zMax: finiteOrNull(motion.zMax),",
    "    materialRemovedMm3: Number(sourceStats.materialRemovedMm3.toFixed(6)),",
    "    sweptDistanceMm: Number(sourceStats.sweptDistanceMm.toFixed(6)),",
    "    cutMoveCount: sourceStats.cutMoveCount,",
    "    maxCutDepthMm: Number(sourceStats.maxCutDepthMm.toFixed(6)),",
    "    method: 'polyline swept-envelope volume estimate from G0/G1 XYZ motion and configured tool diameter'",
    "  },",
    "  artifacts: {",
    "    materialMesh: 'camotics-material-removal.stl'",
    "  }",
    "};",
    "writeFileSync(join(outDir, 'camotics-result.json'), JSON.stringify(result, null, 2), 'utf8');",
    "function estimateMotion(text) {",
    "  const lines = String(text || '').split(/\\r?\\n/).map((line) => line.replace(/\\([^)]*\\)/g, '').trim().toUpperCase()).filter((line) => /\\bG0?0\\b|\\bG0?1\\b/.test(line));",
    "  const zs = lines.map((line) => parseWord(line, 'Z')).filter(Number.isFinite);",
    "  return { motionLineCount: lines.length, zMin: zs.length ? Math.min(...zs) : null, zMax: zs.length ? Math.max(...zs) : null, machineContext: {} };",
    "}",
    "function estimateSweptRemoval(text, motion) {",
    "  const toolDiameter = Number(runPackage.tool?.diameterMm || runPackage.settings?.toolDiameter || 4);",
    "  const safeZ = Number(motion.zMax || runPackage.settings?.safeZ || 0);",
    "  let current = { x: 0, y: 0, z: safeZ };",
    "  let sweptDistanceMm = 0;",
    "  let weightedDepthDistance = 0;",
    "  let cutMoveCount = 0;",
    "  let maxCutDepthMm = 0;",
    "  for (const rawLine of String(text || '').split(/\\r?\\n/)) {",
    "    const line = rawLine.replace(/\\([^)]*\\)/g, '').trim().toUpperCase();",
    "    if (!/\\bG0?0\\b|\\bG0?1\\b/.test(line)) continue;",
    "    const next = {",
    "      x: Number.isFinite(parseWord(line, 'X')) ? parseWord(line, 'X') : current.x,",
    "      y: Number.isFinite(parseWord(line, 'Y')) ? parseWord(line, 'Y') : current.y,",
    "      z: Number.isFinite(parseWord(line, 'Z')) ? parseWord(line, 'Z') : current.z",
    "    };",
    "    const distance = Math.hypot(next.x - current.x, next.y - current.y);",
    "    const avgDepth = Math.max(0, safeZ - ((next.z + current.z) / 2));",
    "    if (/\\bG0?1\\b/.test(line) && distance > 0 && avgDepth > 0) {",
    "      sweptDistanceMm += distance;",
    "      weightedDepthDistance += distance * avgDepth;",
    "      maxCutDepthMm = Math.max(maxCutDepthMm, safeZ - next.z, safeZ - current.z);",
    "      cutMoveCount += 1;",
    "    }",
    "    current = next;",
    "  }",
    "  const materialRemovedMm3 = Math.max(0, weightedDepthDistance * Math.max(0.05, toolDiameter));",
    "  return { sweptDistanceMm, materialRemovedMm3, cutMoveCount, maxCutDepthMm, motionLineCount: Number(motion.motionLineCount || 0) };",
    "}",
    "function createSweptEnvelopeStl(stats) {",
    "  const length = Math.max(1, Math.min(120, stats.sweptDistanceMm / 20 || 10));",
    "  const width = Math.max(0.5, Math.min(20, Number(runPackage.tool?.diameterMm || 4)));",
    "  const depth = Math.max(0.1, Math.min(20, stats.maxCutDepthMm || 0.1));",
    "  const v = [[0,0,0],[length,0,0],[length,width,0],[0,width,0],[0,0,-depth],[length,0,-depth],[length,width,-depth],[0,width,-depth]];",
    "  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];",
    "  return 'solid hediao3d_internal_material_removal\\n' + faces.map((f) => `facet normal 0 0 0\\n outer loop\\n  vertex ${v[f[0]].join(' ')}\\n  vertex ${v[f[1]].join(' ')}\\n  vertex ${v[f[2]].join(' ')}\\n endloop\\nendfacet`).join('\\n') + '\\nendsolid hediao3d_internal_material_removal\\n';",
    "}",
    "function parseWord(line, word) { const m = line.match(new RegExp('\\\\b' + word + '\\\\s*(-?\\\\d+(?:\\\\.\\\\d+)?)')); return m ? Number(m[1]) : NaN; }",
    "function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }",
    "function sha256Text(text) { return createHash('sha256').update(String(text || ''), 'utf8').digest('hex'); }",
    "function finiteOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }",
    "NODE",
    `  node ${shellQuote(join(packageJson.outputDir, "camotics-result-validate.js"))} ${shellQuote(join(packageJson.outputDir, resultJson))} || true`,
    `  cp -f ${shellQuote(join(packageJson.outputDir, resultJson))} ${shellQuote(join(dirname(packageJson.outputDir), resultJson))} 2>/dev/null || true`,
    `  cp -f ${shellQuote(join(packageJson.outputDir, "camotics-result-local-validation.json"))} ${shellQuote(join(dirname(packageJson.outputDir), "camotics-result-local-validation.json"))} 2>/dev/null || true`,
    `  cp -f ${shellQuote(join(packageJson.outputDir, "camotics-result-bundle.zip"))} ${shellQuote(join(dirname(packageJson.outputDir), "camotics-result-bundle.zip"))} 2>/dev/null || true`,
    `  cp -f ${shellQuote(join(packageJson.outputDir, "camotics-material-removal.stl"))} ${shellQuote(join(dirname(packageJson.outputDir), "camotics-material-removal.stl"))} 2>/dev/null || true`,
    "else",
    "  echo '[HeDiao3D] No headless camotics-cli found. GUI camotics is not auto-launched on servers.' >&2",
    "  write_blocked_report",
    "fi",
    "",
    `echo '[HeDiao3D] Fill ${resultJson} from real material-removal metrics, then import it back.'`,
    `echo '[HeDiao3D] Template: ${join(packageJson.outputDir, "camotics-result-template.json")}'`,
    "echo '[HeDiao3D] Validate before import: node camotics-result-validate.js'",
    ""
  ].join("\n");
}

function createLinuxOperatorChecklist(packageJson, runPackageIdentity, resultTemplate) {
  const preferred = packageJson.inputs?.preferredGcode?.filename ?? "camotics-preview.nc";
  const expectedHash = packageJson.preferredGcodeIdentity?.sha256 ?? "missing";
  const motion = packageJson.preferredGcodeIdentity?.motionProfile ?? {};
  const machineContext = packageJson.preferredGcodeIdentity?.machineContext ?? {};
  const resultJson = packageJson.expectedOutputs?.resultJson ?? "camotics-result.json";
  const screenshot = packageJson.expectedOutputs?.screenshot ?? "camotics-preview.png";
  const materialMesh = packageJson.expectedOutputs?.materialMesh ?? "camotics-material-removal.stl";
  const commands = (packageJson.commandCandidates ?? [])
    .map((item) => `- \`${item.command}\`: ${item.purpose ?? item.id}`)
    .join("\n");
  return [
    "# HeDiao3D CAMotics Linux 操作清单",
    "",
    `生成时间: ${packageJson.createdAt}`,
    `准备包 SHA-256: \`${runPackageIdentity.sha256}\``,
    `状态: ${packageJson.status}`,
    "",
    "## 1. 核验输入",
    "",
    `- [ ] 当前目录是: \`${packageJson.sourceJobDir}\``,
    `- [ ] 首选仿真 NC 是: \`${preferred}\``,
    `- [ ] \`${preferred}\` 的 SHA-256 等于: \`${expectedHash}\``,
    `- [ ] 运动行数: ${motion.motionLineCount ?? "missing"}`,
    `- [ ] Z 范围: ${motion.zMin ?? "missing"} 到 ${motion.zMax ?? "missing"}`,
    `- [ ] 机床上下文: ${machineContext.camMode ?? "missing"} / ${machineContext.rotaryWrapAxis ?? "no-axis"} / ${machineContext.rotaryWrapPerRevolutionMm ?? "missing"}mm/圈。`,
    "- [ ] 确认 `camotics-preview.nc` 只用于三轴展开仿真，禁止上机。",
    "",
    "## 2. 运行 CAMotics 或等效仿真",
    "",
    commands || "- 当前准备包没有命令候选，请手动打开 camotics-preview.nc。",
    "",
    "## 3. 生成回填文件",
    "",
    `- [ ] 复制 \`camotics-result-template.json\` 为 \`${resultJson}\`。`,
    `- [ ] 填写 \`${resultJson}\` 的真实材料去除体积 \`metrics.materialRemovedMm3\`。`,
    `- [ ] 确认 \`inputs.preferredGcodeSha256\` 等于 \`${expectedHash}\`。`,
    `- [ ] 确认 \`inputs.camoticsCliRunPackageSha256\` 等于 \`${runPackageIdentity.sha256}\`。`,
    `- [ ] 确认 \`inputs.machineContext.rotaryWrapAxis\` 等于 \`${machineContext.rotaryWrapAxis ?? "missing"}\`。`,
    `- [ ] 确认 \`inputs.machineContext.rotaryWrapPerRevolutionMm\` 等于 \`${machineContext.rotaryWrapPerRevolutionMm ?? "missing"}\`。`,
    `- [ ] 导出或截图 \`${screenshot}\`。`,
    `- [ ] 如可用，导出材料去除网格 \`${materialMesh}\`。`,
    "",
    "## 4. 本地校验",
    "",
    "```bash",
    `node camotics-result-validate.js ${resultJson} > camotics-result-local-validation.json`,
    "```",
    "",
    "- [ ] `camotics-result-local-validation.json` 中 `ok=true`。",
    "- [ ] `productionEvidenceEligible=true`。",
    "- [ ] `missing=[]`。",
    "- [ ] `camotics-result-bundle.zip` 已生成，可直接上传到 HeDiao3D V3 CAMotics 回填面板。",
    "",
    "## 5. 回填到 HeDiao3D",
    "",
    "- [ ] 优先上传 `camotics-result-bundle.zip`；如需手工回填，再分别选择 `camotics-result.json`、`camotics-result-local-validation.json`、截图或材料网格。",
    "- [ ] 回填后检查 `simulation-summary.json`、`production-gate.json`、`production-evidence-dossier.json`。",
    "- [ ] 未完成空跑、软料试雕、试雕反馈和机床验收前，不允许下载正式生产包。",
    "",
    "## 生产边界",
    "",
    "- 该准备包只证明 CAMotics 运行输入被绑定，不会解锁生产 NC。",
    "- synthetic、fixture、手写占位结果不能作为生产证据。",
    "- 旋转夹具真实材料去除仍需结合 `rotary-wrap-preview-report.json`、离料空跑和现场试雕验收。",
    "",
    "## 结果模板摘要",
    "",
    `- schema: \`${resultTemplate.schema}\``,
    `- jobId: \`${resultTemplate.jobId ?? "missing"}\``,
    `- expected result: \`${resultJson}\``
  ].join("\n") + "\n";
}

function createResultValidatorScript(packageJson) {
  const expectedHash = packageJson.preferredGcodeIdentity?.sha256 ?? null;
  const expectedMotion = packageJson.preferredGcodeIdentity?.motionProfile ?? null;
  const expectedMachineContext = packageJson.preferredGcodeIdentity?.machineContext ?? null;
  const expectedRunPackageHash = inspectWrittenRunPackage(join(outputDir, "camotics-cli-run-package.json")).sha256;
  const expectedResult = packageJson.expectedOutputs ?? {};
  const resultJson = expectedResult.resultJson ?? "camotics-result.json";
  const screenshot = expectedResult.screenshot ?? "camotics-preview.png";
  const materialMesh = expectedResult.materialMesh ?? "camotics-material-removal.stl";
  const upstreamCamEvidence = packageJson.upstreamCamEvidence ?? null;
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const resultPath = resolve(process.argv[2] ?? join(packageDir, ${JSON.stringify(resultJson)}));
const expected = {
  preferredGcodeSha256: ${JSON.stringify(expectedHash)},
  camoticsCliRunPackageSha256: ${JSON.stringify(expectedRunPackageHash)},
  motionProfile: ${JSON.stringify(expectedMotion)},
  machineContext: ${JSON.stringify(expectedMachineContext)},
  screenshot: ${JSON.stringify(screenshot)},
  materialMesh: ${JSON.stringify(materialMesh)},
  upstreamCamEvidence: ${JSON.stringify(upstreamCamEvidence)}
};

const checks = [];
const result = readJson(resultPath);
check("result-file", Boolean(result), "camotics-result.json must exist and be valid JSON.");
check("schema", result?.schema === "hediao3d.camotics-result.v1", "schema must be hediao3d.camotics-result.v1.");
check("status", result?.status === "completed", "status must be completed.");
check("non-synthetic", result?.synthetic === false, "synthetic must be false for real CAMotics evidence.");
check("risk-ready", result?.riskLevel === "ready", "riskLevel must be ready.");
check("preferred-gcode-hash", Boolean(expected.preferredGcodeSha256) && result?.inputs?.preferredGcodeSha256 === expected.preferredGcodeSha256, "inputs.preferredGcodeSha256 must match camotics-preview.nc.");
check("run-package-hash", Boolean(expected.camoticsCliRunPackageSha256) && result?.inputs?.camoticsCliRunPackageSha256 === expected.camoticsCliRunPackageSha256, "inputs.camoticsCliRunPackageSha256 must match this run package.");
check("machine-context", machineContextMatches(result?.inputs?.machineContext, expected.machineContext), "inputs.machineContext must match camotics-preview.nc rotary-wrap axis and wrap distance.");
check("upstream-cam-evidence", upstreamCamEvidenceMatches(result?.inputs?.upstreamCamEvidence, expected.upstreamCamEvidence), "inputs.upstreamCamEvidence must match the CAM/OpenCAMLib evidence hashes captured by camotics-cli-run-package.json.");
check("upstream-machine-fit", upstreamMachineFitMatches(result?.inputs?.upstreamCamEvidence?.candidateMachineFit, expected.upstreamCamEvidence?.candidateMachineFit), "inputs.upstreamCamEvidence.candidateMachineFit must match the run package and must not be critical.");
check("upstream-material-readiness", upstreamMaterialReadinessMatches(result?.inputs?.upstreamCamEvidence?.materialRemovalReadiness, expected.upstreamCamEvidence?.materialRemovalReadiness), "inputs.upstreamCamEvidence.materialRemovalReadiness must match the run package and must be ready for CAMotics/equivalent material-removal simulation.");
check("motion-line-count", Number(result?.metrics?.motionLineCount) === Number(expected.motionProfile?.motionLineCount), "metrics.motionLineCount must match camotics-preview.nc.");
check("z-min", close(Number(result?.metrics?.zMin), Number(expected.motionProfile?.zMin), 0.05), "metrics.zMin must match camotics-preview.nc within 0.05mm.");
check("z-max", close(Number(result?.metrics?.zMax), Number(expected.motionProfile?.zMax), 0.05), "metrics.zMax must match camotics-preview.nc within 0.05mm.");
check("material-volume", Number.isFinite(Number(result?.metrics?.materialRemovedMm3)) && Number(result.metrics.materialRemovedMm3) >= 0, "metrics.materialRemovedMm3 must be a real non-negative number from CAMotics/equivalent simulation.");

const artifactEvidence = inspectArtifacts(result, resultPath, expected);
check("visual-or-material-artifact", artifactEvidence.hasScreenshot || artifactEvidence.hasMaterialMesh, "Provide at least one existing artifact: camotics-preview.png or camotics-material-removal.stl.");

const ok = checks.every((item) => item.ok);
const missing = checks.filter((item) => !item.ok).map((item) => item.id);
const productionEvidenceEligible = ok;
const report = {
  schema: "hediao3d.camotics-result-local-validation.v1",
  createdAt: new Date().toISOString(),
  ok,
  productionEvidenceEligible,
  resultPath,
  checks,
  missing,
  artifactEvidence,
  expected: {
    preferredGcodeSha256: expected.preferredGcodeSha256,
    camoticsCliRunPackageSha256: expected.camoticsCliRunPackageSha256,
    machineContext: expected.machineContext,
    motionProfile: expected.motionProfile,
    upstreamCamEvidence: expected.upstreamCamEvidence
  },
  nextActions: productionEvidenceEligible
    ? [
      "Import camotics-result.json back into HeDiao3D.",
      "Then inspect simulation-summary.json, production-gate.json and production-evidence-dossier.json before any trial cut."
    ]
    : [
      "Fix every critical check before importing camotics-result.json.",
      "Do not use this CAMotics result as production evidence until productionEvidenceEligible is true."
    ],
  summary: productionEvidenceEligible
    ? "CAMotics local validation passed: result is eligible to be imported as material-removal evidence."
    : "CAMotics local validation failed: " + missing.join(", ")
};

const resultDir = dirname(resultPath);
const localValidationPath = join(resultDir, "camotics-result-local-validation.json");
const resultBundlePath = join(resultDir, "camotics-result-bundle.zip");
writeFileSync(localValidationPath, JSON.stringify(report, null, 2), "utf8");
if (ok) {
  writeFileSync(resultBundlePath, createResultBundle({
    resultPath,
    localValidationPath,
    artifactEvidence
  }));
}

function upstreamCamEvidenceMatches(imported, expectedEvidence) {
  if (!expectedEvidence?.required) return true;
  if (!imported || typeof imported !== "object") return false;
  if (imported.schema !== "hediao3d.camotics-upstream-cam-evidence.v1") return false;
  const expectedFiles = Array.isArray(expectedEvidence.files) ? expectedEvidence.files.filter((file) => file.exists && file.sha256) : [];
  const importedFiles = Array.isArray(imported.files) ? imported.files : [];
  if (expectedFiles.length === 0) return true;
  return expectedFiles.every((expectedFile) => {
    const actual = importedFiles.find((file) => file.key === expectedFile.key || file.filename === expectedFile.filename);
    return Boolean(actual && actual.exists !== false && actual.sha256 === expectedFile.sha256);
  });
}

function upstreamMachineFitMatches(importedMachineFit, expectedMachineFit) {
  if (!expectedMachineFit) return true;
  if (!importedMachineFit || typeof importedMachineFit !== "object") return false;
  const expectedSchema = expectedMachineFit.schema ?? "hediao3d.opencamlib-candidate-machine-fit-preflight.v1";
  const expectedAxis = String(expectedMachineFit.targetMachine?.rotaryOutputAxis ?? "").toUpperCase();
  const importedAxis = String(importedMachineFit.targetMachine?.rotaryOutputAxis ?? "").toUpperCase();
  return importedMachineFit.schema === expectedSchema
    && importedMachineFit.level === expectedMachineFit.level
    && importedMachineFit.level !== "critical"
    && importedAxis === expectedAxis;
}

function upstreamMaterialReadinessMatches(importedReadiness, expectedReadiness) {
  if (!expectedReadiness) return true;
  if (!importedReadiness || typeof importedReadiness !== "object") return false;
  const expectedSchema = expectedReadiness.schema ?? "hediao3d.opencamlib-material-removal-readiness.v1";
  return importedReadiness.schema === expectedSchema
    && importedReadiness.level === expectedReadiness.level
    && Boolean(importedReadiness.readyForMaterialRemovalSimulation) === Boolean(expectedReadiness.readyForMaterialRemovalSimulation)
    && Boolean(importedReadiness.readyForMaterialRemovalSimulation)
    && simulationQualityMatches(importedReadiness.simulationQuality, expectedReadiness.simulationQuality);
}

function simulationQualityMatches(importedQuality, expectedQuality) {
  if (!expectedQuality) return true;
  if (!importedQuality || typeof importedQuality !== "object") return false;
  const importedRisks = Array.isArray(importedQuality.risks) ? importedQuality.risks.map((item) => String(item)).sort() : [];
  const expectedRisks = Array.isArray(expectedQuality.risks) ? expectedQuality.risks.map((item) => String(item)).sort() : [];
  return importedQuality.schema === (expectedQuality.schema ?? "hediao3d.opencamlib-material-removal-simulation-quality.v1")
    && importedQuality.level === expectedQuality.level
    && Boolean(importedQuality.engineeringSimulationAllowed) === Boolean(expectedQuality.engineeringSimulationAllowed)
    && Boolean(importedQuality.productionEvidenceAllowed) === false
    && Boolean(expectedQuality.productionEvidenceAllowed) === false
    && importedRisks.length === expectedRisks.length
    && importedRisks.every((risk, index) => risk === expectedRisks[index]);
}

console.log(JSON.stringify(report, null, 2));
if (!ok) process.exit(1);

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function check(id, ok, message) {
  checks.push({ id, ok: Boolean(ok), severity: ok ? "info" : "critical", message });
}

function close(actual, expectedValue, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expectedValue) && Math.abs(actual - expectedValue) <= tolerance;
}

function machineContextMatches(imported, expectedContext) {
  if (!expectedContext) return true;
  if (!imported || typeof imported !== "object") return false;
  const expectedAxis = String(expectedContext.rotaryWrapAxis ?? "").toUpperCase();
  const importedAxis = String(imported.rotaryWrapAxis ?? imported.rotaryOutputAxis ?? "").toUpperCase();
  const expectedLengthAxis = String(expectedContext.lengthAxis ?? "").toUpperCase();
  const importedLengthAxis = String(imported.lengthAxis ?? "").toUpperCase();
  const expectedWrap = Number(expectedContext.rotaryWrapPerRevolutionMm);
  const importedWrap = Number(imported.rotaryWrapPerRevolutionMm);
  return String(imported.camMode ?? expectedContext.camMode) === String(expectedContext.camMode)
    && importedAxis === expectedAxis
    && importedLengthAxis === expectedLengthAxis
    && close(importedWrap, expectedWrap, 0.001);
}

function inspectArtifacts(result, resultPath, expected) {
  const sourceDir = dirname(resultPath);
  const screenshotPath = resolveArtifact(result?.artifacts?.screenshot ?? expected.screenshot, sourceDir);
  const materialMeshPath = resolveArtifact(result?.artifacts?.materialMesh ?? expected.materialMesh, sourceDir);
  return {
    screenshot: inspectFile(screenshotPath),
    materialMesh: inspectFile(materialMeshPath),
    hasScreenshot: Boolean(screenshotPath && existsSync(screenshotPath)),
    hasMaterialMesh: Boolean(materialMeshPath && existsSync(materialMeshPath))
  };
}

function resolveArtifact(value, sourceDir) {
  if (!value || typeof value !== "string") return null;
  if (isAbsolute(value)) return value;
  return join(sourceDir, value);
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

function createResultBundle({ resultPath, localValidationPath, artifactEvidence }) {
  const resultContent = readFileSync(resultPath);
  const localValidationContent = readFileSync(localValidationPath);
  const files = [
    { name: "camotics-result.json", role: "material-removal-result", content: resultContent },
    { name: "camotics-result-local-validation.json", role: "local-validation", content: localValidationContent },
    {
      name: "README-CAMOTICS-RESULT.md",
      role: "operator-readme",
      content: Buffer.from([
        "# HeDiao3D CAMotics Result Bundle",
        "",
        "Upload this ZIP in the HeDiao3D V3 CAMotics result import panel.",
        "",
        "Included files:",
        "- camotics-result.json",
        "- camotics-result-local-validation.json",
        "- camotics-result-bundle-manifest.json",
        "- camotics-preview.png and/or camotics-material-removal.stl when available",
        "",
        "This bundle is material-removal evidence for readiness gates only. It does not unlock production NC by itself.",
        ""
      ].join("\\n"), "utf8")
    }
  ];
  if (artifactEvidence?.hasScreenshot && artifactEvidence.screenshot?.path) {
    files.push({ name: "camotics-preview.png", role: "visual-evidence", content: readFileSync(artifactEvidence.screenshot.path) });
  }
  if (artifactEvidence?.hasMaterialMesh && artifactEvidence.materialMesh?.path) {
    files.push({ name: "camotics-material-removal.stl", role: "material-removal-mesh", content: readFileSync(artifactEvidence.materialMesh.path) });
  }
  const manifest = createResultBundleManifest(files, resultContent, localValidationContent);
  files.splice(2, 0, {
    name: "camotics-result-bundle-manifest.json",
    role: "bundle-manifest",
    content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
  });
  return createZip(files);
}

function createResultBundleManifest(files, resultContent, localValidationContent) {
  let result = null;
  let localValidation = null;
  try {
    result = JSON.parse(resultContent.toString("utf8"));
  } catch {}
  try {
    localValidation = JSON.parse(localValidationContent.toString("utf8"));
  } catch {}
  return {
    schema: "hediao3d.camotics-result-bundle-manifest.v1",
    createdAt: new Date().toISOString(),
    generator: "camotics-result-validate.js",
    purpose: "Uploadable CAMotics/equivalent material-removal evidence bundle for one HeDiao3D V3 job.",
    jobId: result?.jobId ?? null,
    result: {
      schema: result?.schema ?? null,
      synthetic: result?.synthetic ?? null,
      riskLevel: result?.riskLevel ?? null,
      preferredGcodeSha256: result?.inputs?.preferredGcodeSha256 ?? null,
      camoticsCliRunPackageSha256: result?.inputs?.camoticsCliRunPackageSha256 ?? null,
      machineContext: result?.inputs?.machineContext ?? null,
      upstreamCamEvidence: result?.inputs?.upstreamCamEvidence ?? null
    },
    localValidation: {
      schema: localValidation?.schema ?? null,
      ok: Boolean(localValidation?.ok),
      productionEvidenceEligible: Boolean(localValidation?.productionEvidenceEligible),
      missing: Array.isArray(localValidation?.missing) ? localValidation.missing : []
    },
    files: files.map((file) => {
      const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
      return {
        filename: file.name,
        role: file.role ?? "artifact",
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex")
      };
    }),
    safetyLocks: {
      productionUnlockFromBundle: false,
      requiresServerImportAudit: true,
      requiresReadinessRegeneration: true,
      note: "This bundle can provide material-removal evidence only after HeDiao3D verifies hashes, local validation, motion profile and machine context."
    }
  };
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
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuffer.length), u32(centralOffset), u16(0)
  ]);
  return Buffer.concat([...chunks, centralBuffer, end]);
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
`;
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
    zMax: zValues.length ? Math.max(...zValues) : null,
    machineContext: createMachineContextFromGcode(gcodeText)
  };
}

function createMachineContextFromGcode(gcodeText) {
  const text = String(gcodeText ?? "");
  const axis = matchHeader(text, "ROTARY_WRAP_AXIS");
  const rawPerRev = matchHeader(text, "ROTARY_WRAP_PER_REV_MM");
  const perRev = rawPerRev == null ? NaN : Number(rawPerRev);
  const lengthAxis = matchHeader(text, "LENGTH_AXIS");
  const rotaryMode = Boolean(axis || Number.isFinite(perRev));
  return {
    schema: "hediao3d.camotics-machine-context.v1",
    camMode: rotaryMode ? "rotaryWrap" : "3axis",
    rotaryWrapAxis: axis ? axis.toUpperCase() : null,
    rotaryOutputAxis: axis ? axis.toUpperCase() : null,
    rotaryWrapPerRevolutionMm: Number.isFinite(perRev) ? perRev : null,
    lengthAxis: lengthAxis ? lengthAxis.toUpperCase() : "X",
    simulationInterpretation: rotaryMode ? "linearized-rotary-wrap-as-3axis" : "plain-3axis"
  };
}

function matchHeader(text, key) {
  const match = String(text ?? "").match(new RegExp(`${key}\\s*=\\s*([^\\s)]+)`, "i"));
  return match ? match[1] : null;
}

function parseWord(line, word) {
  const match = line.match(new RegExp(`\\b${word}\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : NaN;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function inferJobIdFromPath(value) {
  const match = String(value ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
