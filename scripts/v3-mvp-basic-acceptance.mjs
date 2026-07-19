#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const checks = [
  {
    id: "server-syntax",
    title: "Orchestrator syntax",
    command: [process.execPath, ["--check", "server.mjs"]]
  },
  {
    id: "focused-ui",
    title: "Focused operator UI contract",
    command: [process.execPath, ["scripts/v3-focused-ui-contract-test.mjs"]]
  },
  {
    id: "buddha-fixture",
    title: "Buddha 3D fixture baseline",
    command: [process.execPath, ["scripts/v3-buddha-fixture-baseline-test.mjs"]]
  },
  {
    id: "mvp-source-boundary",
    title: "MVP machine/tool/safety boundary",
    sourceCheck: () => {
      const profiles = readFileSync("src/manufacturingProfiles.ts", "utf8");
      const app = readFileSync("src/App.tsx", "utf8");
      const server = readFileSync("server.mjs", "utf8");
      assertIncludes(profiles, "desktop-3axis-rotary-y", "machine profile");
      assertIncludes(profiles, "wrapY", "wrapY postprocess");
      assertIncludes(profiles, "vflat-4mm-25deg", "4mm 25deg flat-tip V tool");
      assertIncludes(app, "V3_TRIAL_FOCUSED_UI = true", "focused UI enabled");
      assertIncludes(app, "下载安全试雕包", "safe trial package action");
      assertIncludes(server, "productionUnlockEligible: false", "production lock boundary");
      return "MVP source boundary is present: focused safe-trial UI, wrapY target and default tool profile.";
    }
  },
  {
    id: "camotics-material-validator",
    title: "Material-removal evidence validator",
    command: [process.execPath, ["scripts/v3-camotics-material-removal-validate-test.mjs"]]
  }
];

const results = [];
let failed = false;

for (const check of checks) {
  const startedAt = Date.now();
  let run = null;
  let ok = false;
  let output = "";
  if (check.sourceCheck) {
    try {
      output = check.sourceCheck();
      ok = true;
      run = { status: 0 };
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
      run = { status: 1 };
    }
  } else {
    const [cmd, args] = check.command;
    run = spawnSync(cmd, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env }
    });
    ok = run.status === 0;
    output = run.stdout || run.stderr || "";
  }
  failed = failed || !ok;
  results.push({
    id: check.id,
    title: check.title,
    ok,
    exitCode: run.status,
    durationMs: Date.now() - startedAt,
    command: check.command ? `${check.command[0]} ${check.command[1].join(" ")}` : "source-check",
    outputTail: tail(output, 1200)
  });
  if (!ok) break;
}

const report = {
  schema: "hediao3d.v3-mvp-basic-acceptance.v1",
  ok: !failed,
  checkedAt: new Date().toISOString(),
  scope: "basic-usable-version",
  productionBoundary: "This acceptance proves the V3 safe-trial MVP path only. It does not unlock direct production NC.",
  checks: results,
  summary: failed
    ? `MVP basic acceptance failed at ${results.find((item) => !item.ok)?.id ?? "unknown"}.`
    : "MVP basic acceptance passed: focused UI, Buddha fixture, wrapY postprocess and material-removal evidence validator are healthy."
};

console.log(JSON.stringify(report, null, 2));
if (failed) process.exit(1);

function tail(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}
