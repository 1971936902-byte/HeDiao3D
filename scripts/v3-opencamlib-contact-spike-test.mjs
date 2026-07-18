#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-contact-spike-"));
const python = process.env.PYTHON ?? "python";
const spikePath = resolve("adapters", "opencamlib", "opencamlib_contact_spike.py");
const outPath = join(workDir, "opencamlib-real-contact-spike.json");
const neutralPath = join(workDir, "neutral-toolpath-spike.json");

try {
  const run = spawnSync(python, [spikePath, "--out", outPath, "--neutral-out", neutralPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert([0, 4].includes(run.status), `spike exited ${run.status}: ${run.stderr || run.stdout}`);
  assert(existsSync(outPath), "contact spike did not write report JSON");
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  assert(report.schema === "hediao3d.opencamlib-real-contact-spike.v1", "spike schema mismatch");
  assert(report.productionLocked === true, "contact spike must keep production locked");
  assert(/not production/i.test(report.productionBoundary), "contact spike must state production boundary");
  assert(report.probe?.runnerReadiness?.schema === "hediao3d.opencamlib-runner-readiness.v1", "spike should embed runner readiness");
  assert(report.probe?.recommendedBindings?.schema === "hediao3d.opencamlib-recommended-bindings.v1", "spike should embed recommended bindings");
  assert(Array.isArray(report.checks) && report.checks.some((check) => check.id === "real-drop-cutter-call" || check.id === "module-imported"), "spike should report module/drop-cutter checks");
  assert(Array.isArray(report.nextActions) && report.nextActions.length > 0, "spike should include next actions");
  const stdout = JSON.parse(run.stdout);
  assert(stdout.schema === report.schema, "stdout summary schema should match report");
  if (report.ok) {
    assert(run.status === 0, "ready spike should exit 0");
    assert(existsSync(neutralPath), "ready spike should write neutral output");
    const neutral = JSON.parse(readFileSync(neutralPath, "utf8"));
    assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral spike schema mismatch");
    assert(neutral.productionCandidate === false, "neutral spike must not be production candidate");
    assert(neutral.runner?.mode === "opencamlib-real-contact-spike", "neutral spike runner mode mismatch");
  } else {
    assert(run.status === 4, "blocked spike should exit 4");
    assert(["blocked", "api-mapping-required"].includes(report.level), `blocked spike level mismatch: ${report.level}`);
  }

  console.log(JSON.stringify({
    ok: true,
    spikeOk: report.ok,
    level: report.level,
    selectedModule: report.selectedModule,
    checks: report.checks.length
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
