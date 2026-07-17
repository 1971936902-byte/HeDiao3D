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
    commandCandidates: normalizeCommands(plan.commandCandidates ?? [], jobDir, outputDir),
    expectedOutputs: {
      resultJson: expectedResult.resultJson ?? "camotics-result.json",
      screenshot: expectedResult.screenshot ?? "camotics-preview.png",
      materialMesh: expectedResult.materialMesh ?? "camotics-material-removal.stl",
      resultTemplate: "camotics-result-template.json",
      resultValidator: "camotics-result-validate.js",
      operatorChecklist: "camotics-linux-operator-checklist.md"
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
        "metrics.motionLineCount/zMin/zMax 与 preferredGcodeIdentity.motionProfile 匹配",
        "至少提供 camotics-preview.png 或 camotics-material-removal.stl"
      ]
    },
    checks,
    safetyLocks: {
      productionUnlockFromPreparePackage: false,
      syntheticResultAllowedForProduction: false,
      note: "This package prepares a real CAMotics run; it never unlocks production NC by itself."
    },
    operatorChecklist: {
      filename: "camotics-linux-operator-checklist.md",
      purpose: "Step-by-step Linux CAMotics run, validation and import-back checklist for the operator."
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
  const machineContext = motionProfile?.machineContext ?? createMachineContextFromGcode(preferred.exists ? readFileSync(preferred.path, "utf8") : "");
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
      machineContext,
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
      "Before importing, run: node camotics-result-validate.js",
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
  materialMesh: ${JSON.stringify(materialMesh)}
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
    motionProfile: expected.motionProfile
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
  const files = [
    { name: "camotics-result.json", content: readFileSync(resultPath) },
    { name: "camotics-result-local-validation.json", content: readFileSync(localValidationPath) },
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
        "This bundle is material-removal evidence for readiness gates only. It does not unlock production NC by itself.",
        ""
      ].join("\\n"), "utf8")
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
