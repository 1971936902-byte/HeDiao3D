#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-probe-"));
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const probePath = resolve("adapters", "opencamlib", "opencamlib_probe.py");
const outPath = join(workDir, "opencamlib-runtime-probe.json");

try {
  const run = spawnSync(python, [probePath, "--out", outPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(run.status === 0, `probe exited ${run.status}: ${run.stderr || run.stdout}`);
  assert(existsSync(outPath), "probe did not write output JSON");
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  assert(report.schema === "hediao3d.opencamlib-runtime-probe.v1", "probe schema mismatch");
  assert(["ready", "partial", "missing"].includes(report.level), `probe level mismatch: ${report.level}`);
  assert(Array.isArray(report.modules) && report.modules.length === 3, "probe should inspect opencamlib.ocl, opencamlib and ocl modules");
  assert(report.modules.some((item) => item.name === "opencamlib.ocl"), "probe missing opencamlib.ocl module report");
  assert(report.modules.some((item) => item.name === "opencamlib"), "probe missing opencamlib module report");
  assert(report.modules.some((item) => item.name === "ocl"), "probe missing ocl module report");
  assert(report.python?.executable, "probe should record python executable");
  assert(report.capabilitySummary?.schema === undefined, "capability summary should remain a plain embedded object");
  assert(typeof report.capabilitySummary?.dropCutterReady === "boolean", "probe should classify dropCutterReady boolean");
  assert(report.recommendedBindings?.schema === "hediao3d.opencamlib-recommended-bindings.v1", "probe should expose recommended bindings schema");
  assert(["missing-module", "candidate-incomplete", "candidate-complete"].includes(report.recommendedBindings?.status), "probe recommended binding status mismatch");
  assert(report.runnerReadiness?.schema === "hediao3d.opencamlib-runner-readiness.v1", "probe should expose runner readiness schema");
  assert(typeof report.runnerReadiness?.canAttemptRealContactSpike === "boolean", "probe should classify real contact spike readiness");
  assert(Array.isArray(report.runnerReadiness?.requiredOutputFiles) && report.runnerReadiness.requiredOutputFiles.includes("opencamlib-cutter-contact-report.json"), "runner readiness should name strict contact output");
  assert(Array.isArray(report.integrationPlan) && report.integrationPlan.some((step) => step.id === "real-contact-spike"), "probe should expose real contact spike integration plan");
  assert(Array.isArray(report.nextActions) && report.nextActions.length > 0, "probe should include next actions");
  assert(/must not/i.test(report.productionBoundary), "probe should state production boundary");
  const parsedStdout = JSON.parse(run.stdout);
  assert(parsedStdout.schema === report.schema, "stdout JSON should match output schema");

  console.log(JSON.stringify({
    ok: true,
    level: report.level,
    selectedModule: report.selectedModule,
    moduleCount: report.modules.length,
    dropCutterReady: report.capabilitySummary.dropCutterReady
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
