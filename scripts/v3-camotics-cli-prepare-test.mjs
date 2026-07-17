#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const workDir = join(tmpdir(), `hediao3d-camotics-cli-prepare-${Date.now()}`);
const outputDir = join(workDir, "linux-camotics-package");
mkdirSync(workDir, { recursive: true });

const previewText = [
  "(CAMOTICS PREVIEW ONLY - not for machine)",
  "G21",
  "G90",
  "G0 X0 Y0 Z5",
  "G1 X1 Y0 Z-0.2 F120",
  "G1 X2 Y0 Z-0.4 F120",
  "M30",
  ""
].join("\n");
writeFileSync(join(workDir, "camotics-preview.nc"), previewText, "utf8");
writeFileSync(join(workDir, "toolpath.nc"), "(machine reference)\nG0 X0 Y0 Z22\n", "utf8");
writeFileSync(join(workDir, "air-run.nc"), "(air run)\nG0 X0 Y0 Z22\n", "utf8");
writeFileSync(join(workDir, "camotics-project-template.json"), JSON.stringify({ schema: "hediao3d.camotics-project-template.v1" }, null, 2), "utf8");
writeFileSync(join(workDir, "camotics-simulation-plan.json"), JSON.stringify({ schema: "hediao3d.camotics-simulation-plan.v1" }, null, 2), "utf8");
writeFileSync(join(workDir, "camotics-job.json"), JSON.stringify({ jobId: "camotics-cli-prepare-test" }, null, 2), "utf8");
writeFileSync(join(workDir, "camotics-cli-execution-plan.json"), JSON.stringify({
  schema: "hediao3d.camotics-cli-execution-plan.v1",
  jobId: "camotics-cli-prepare-test",
  status: "ready-for-linux-validation",
  purpose: "contract test",
  inputs: {
    preferredGcode: "camotics-preview.nc",
    projectTemplate: "camotics-project-template.json",
    simulationPlan: "camotics-simulation-plan.json",
    machineGcodeReferenceOnly: "toolpath.nc",
    airRunReferenceOnly: "air-run.nc"
  },
  commandCandidates: [
    { id: "open-gcode", command: "camotics camotics-preview.nc", purpose: "open preview" }
  ],
  expectedOutputs: {
    resultJson: "camotics-result.json",
    screenshot: "camotics-preview.png",
    materialMesh: "camotics-material-removal.stl"
  }
}, null, 2), "utf8");

const run = spawnSync(process.execPath, ["adapters/camotics/camotics_cli_prepare.js", workDir, outputDir], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
});

assert(!run.error, `prepare spawn failed: ${run.error?.message}`);
assert(run.status === 0, `prepare exited ${run.status}: ${run.stderr}`);

const cliPackagePath = join(outputDir, "camotics-cli-run-package.json");
const resultTemplatePath = join(outputDir, "camotics-result-template.json");
const runScriptPath = join(outputDir, "camotics-linux-run.sh");
assert(existsSync(cliPackagePath), "run package was not written");
assert(existsSync(resultTemplatePath), "result template was not written");
assert(existsSync(runScriptPath), "Linux run script was not written");

const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));
const template = JSON.parse(readFileSync(resultTemplatePath, "utf8"));
const previewSha256 = createHash("sha256").update(readFileSync(join(workDir, "camotics-preview.nc"))).digest("hex");
const cliPackageSha256 = createHash("sha256").update(readFileSync(cliPackagePath)).digest("hex");

assert(cliPackage.schema === "hediao3d.camotics-cli-run-package.v1", "run package schema mismatch");
assert(cliPackage.status === "ready-for-linux-camotics", `expected ready package, got ${cliPackage.status}`);
assert(cliPackage.preferredGcodeIdentity?.sha256 === previewSha256, "preview SHA-256 mismatch");
assert(cliPackage.preferredGcodeIdentity?.motionProfile?.motionLineCount === 3, "motion profile line count mismatch");
assert(cliPackage.preferredGcodeIdentity?.motionProfile?.zMin === -0.4, "motion profile zMin mismatch");
assert(cliPackage.preferredGcodeIdentity?.motionProfile?.zMax === 5, "motion profile zMax mismatch");
assert(cliPackage.importBack?.requires?.some((item) => item.includes("preferredGcodeSha256")), "import instructions should require preferred G-code hash");
assert(cliPackage.safetyLocks?.productionUnlockFromPreparePackage === false, "prepare package must not unlock production");
assert(template.inputs?.preferredGcodeSha256 === previewSha256, "template should include preferred G-code hash");
assert(template.inputs?.camoticsCliRunPackage === "camotics-cli-run-package.json", "template should name CLI run package");
assert(template.inputs?.camoticsCliRunPackageSha256 === cliPackageSha256, "template should bind to CLI run package hash");
assert(template.metrics?.motionLineCount === 3, "template should seed motion count from preview");
assert(template.metrics?.materialRemovedMm3 === null, "template must require real material removal volume");

const blockedDir = join(workDir, "blocked");
mkdirSync(blockedDir, { recursive: true });
writeFileSync(join(blockedDir, "camotics-cli-execution-plan.json"), JSON.stringify({
  schema: "hediao3d.camotics-cli-execution-plan.v1",
  inputs: {
    preferredGcode: "missing-preview.nc",
    projectTemplate: "camotics-project-template.json",
    simulationPlan: "camotics-simulation-plan.json"
  }
}, null, 2), "utf8");
writeFileSync(join(blockedDir, "camotics-project-template.json"), "{}", "utf8");
writeFileSync(join(blockedDir, "camotics-simulation-plan.json"), "{}", "utf8");

const blockedOutputDir = join(blockedDir, "out");
const blockedRun = spawnSync(process.execPath, ["adapters/camotics/camotics_cli_prepare.js", blockedDir, blockedOutputDir], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
});
assert(!blockedRun.error, `blocked prepare spawn failed: ${blockedRun.error?.message}`);
assert(blockedRun.status === 0, `blocked prepare exited ${blockedRun.status}: ${blockedRun.stderr}`);
const blockedPackage = JSON.parse(readFileSync(join(blockedOutputDir, "camotics-cli-run-package.json"), "utf8"));
assert(blockedPackage.status === "blocked", "missing preferred G-code should block package");
assert(blockedPackage.checks?.some((check) => check.id === "input:preferredGcode" && check.ok === false), "blocked package should report missing preferred G-code");

console.log(JSON.stringify({
  ok: true,
  packageStatus: cliPackage.status,
  blockedStatus: blockedPackage.status,
  motionProfile: cliPackage.preferredGcodeIdentity.motionProfile
}, null, 2));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
