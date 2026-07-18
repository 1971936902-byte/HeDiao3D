#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const node = process.execPath;
const root = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), "hediao3d-native-cam-package-self-check-"));
const nativeCamCheck = resolve("scripts", "v3-linux-native-cam-check.mjs");

try {
  const generated = spawnSync(node, [nativeCamCheck], {
    cwd: root,
    env: {
      ...process.env,
      V3_NATIVE_CAM_CHECK_DIR: workDir
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(!generated.error, `native CAM package generation failed to start: ${generated.error?.message}`);
  assert(generated.status === 0, `native CAM package generation should exit 0 in non-strict mode: ${generated.stderr || generated.stdout}`);

  const selfCheckPath = join(workDir, "native-cam-server-package-self-check.mjs");
  assert(existsSync(selfCheckPath), "generated server package missing self-check script");
  const ready = spawnSync(node, [selfCheckPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(ready.status === 0, `self-check should pass generated package: ${ready.stderr || ready.stdout}`);
  const readyReport = JSON.parse(ready.stdout);
  assert(readyReport.schema === "hediao3d.native-cam-server-package-self-check.v1", "self-check schema mismatch");
  assert(readyReport.ok === true, "self-check should be ok for generated package");
  assert(readyReport.level === "ready", "self-check level should be ready");
  assert(readyReport.checks?.some((check) => check.id === "target-rotary-output-axis" && check.status === "pass"), "self-check should verify Y rotary output axis");
  assert(readyReport.checks?.some((check) => check.id === "camotics-validator-bundle" && check.status === "pass"), "self-check should verify CAMotics result bundle support");
  assert(readyReport.checks?.some((check) => check.id === "closed-loop-check-schema" && check.status === "pass"), "self-check should verify closed-loop check support");
  assert(readyReport.checks?.some((check) => check.id === "diagnostics-bundle-schema" && check.status === "pass"), "self-check should verify diagnostics bundle schema");
  assert(readyReport.checks?.some((check) => check.id === "diagnostics-bundle-zip" && check.status === "pass"), "self-check should verify diagnostics bundle ZIP support");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-contact-spike-schema" && check.status === "pass"), "self-check should verify OpenCAMLib contact spike schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-contact-spike-boundary" && check.status === "pass"), "self-check should verify OpenCAMLib contact spike boundary");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-runner-readiness-schema" && check.status === "pass"), "self-check should verify OpenCAMLib runner readiness schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-runner-production-lock" && check.status === "pass"), "self-check should verify OpenCAMLib runner production lock");
  assert(readyReport.checks?.some((check) => check.id === "file:opencamlib-real-candidate-run.mjs" && check.status === "pass"), "self-check should require OpenCAMLib real candidate runner file");
  assert(readyReport.checks?.some((check) => check.id === "command:opencamlib-real-candidate" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate command");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-real-candidate-schema" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate schema");
  assert(readyReport.checks?.some((check) => check.id === "opencamlib-real-candidate-fail-closed" && check.status === "pass"), "self-check should verify OpenCAMLib real candidate production lock");
  assert(readyReport.checks?.some((check) => check.id === "real-output-runner-readiness" && check.status === "pass"), "self-check should verify real-output bundle carries OpenCAMLib runner readiness");
  assert(readyReport.checks?.some((check) => check.id === "manifest-file:native-cam-server-package.json" && check.status === "pass"), "self-check should require manifest to list itself");
  assert(existsSync(join(workDir, "native-cam-server-package-self-check.json")), "self-check should write JSON report");

  const realCandidatePath = join(workDir, "opencamlib-real-candidate-run.mjs");
  assert(existsSync(realCandidatePath), "generated server package missing OpenCAMLib real candidate runner");
  const realCandidate = spawnSync(node, [realCandidatePath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(realCandidate.status === 3, `real candidate runner should fail closed without job/plan/model inputs, got ${realCandidate.status}: ${realCandidate.stderr || realCandidate.stdout}`);
  const realCandidateReport = JSON.parse(realCandidate.stdout);
  assert(realCandidateReport.schema === "hediao3d.opencamlib-real-candidate-run.v1", "real candidate runner schema mismatch");
  assert(realCandidateReport.productionLocked === true, "real candidate runner must keep production locked");
  assert(realCandidateReport.blocking?.includes("opencamlib-production-candidate-not-proven"), "real candidate runner should block when production candidate is not proven");
  assert(existsSync(join(workDir, "opencamlib-real-candidate-run.json")), "real candidate runner should write JSON report");

  const diagnosticsPath = join(workDir, "native-cam-diagnostics-bundle.mjs");
  assert(existsSync(diagnosticsPath), "generated server package missing diagnostics bundle script");
  const diagnostics = spawnSync(node, [diagnosticsPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(diagnostics.status === 0, `diagnostics bundle should pass generated package: ${diagnostics.stderr || diagnostics.stdout}`);
  const diagnosticsReport = JSON.parse(diagnostics.stdout);
  assert(diagnosticsReport.schema === "hediao3d.native-cam-diagnostics-bundle.v1", "diagnostics bundle schema mismatch");
  assert(diagnosticsReport.productionLocked === true, "diagnostics bundle must keep production locked");
  assert(["diagnostic", "missing", "partial", "ready"].includes(diagnosticsReport.level), "diagnostics bundle level should stay in a diagnostic/readiness range");
  assert(existsSync(join(workDir, "native-cam-diagnostics-bundle.zip")), "diagnostics bundle should write ZIP");
  assert(existsSync(join(workDir, "opencamlib-real-contact-spike.json")), "diagnostics bundle should write contact spike report");

  unlinkSync(join(workDir, "camotics-material-removal-validate.mjs"));
  const blocked = spawnSync(node, [selfCheckPath, workDir], {
    cwd: workDir,
    encoding: "utf8",
    windowsHide: true
  });
  assert(blocked.status === 3, `self-check should fail when CAMotics validator is missing, got ${blocked.status}: ${blocked.stdout}`);
  const blockedReport = JSON.parse(blocked.stdout);
  assert(blockedReport.ok === false, "blocked self-check should not be ok");
  assert(blockedReport.level === "critical", "blocked self-check should be critical");
  assert(blockedReport.missing?.includes("file:camotics-material-removal-validate.mjs"), "blocked self-check should list missing CAMotics validator file");
  assert(blockedReport.missing?.includes("camotics-validator-schema"), "blocked self-check should list missing CAMotics validator schema");

  console.log(JSON.stringify({
    ok: true,
    readyLevel: readyReport.level,
    blockedLevel: blockedReport.level,
    checks: readyReport.checks.length,
    diagnosticsLevel: diagnosticsReport.level
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
