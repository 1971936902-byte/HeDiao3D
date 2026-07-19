#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

const packageJson = readJson("package.json");

const requiredFiles = [
  { path: "README.md", purpose: "project entry documentation", mustInclude: ["V3 基本可用版", "npm run test:v3:mvp-basic"] },
  { path: "V3基本可用版交付说明.md", purpose: "basic usable release guide", mustInclude: ["安全试雕 MVP", "下载安全试雕包", "正式生产 NC"] },
  { path: "V3后续完善项清单.md", purpose: "deferred feature backlog", mustInclude: ["P0", "P1", "P2", "P3"] },
  { path: "V3目标进度与剩余任务.md", purpose: "progress and remaining tasks", mustInclude: ["基本可用版收敛口径", "npm run test:v3:mvp-basic"] },
  { path: "scripts/v3-start-local.mjs", purpose: "one-command local V3 startup" },
  { path: "scripts/v3-mvp-basic-acceptance.mjs", purpose: "basic MVP acceptance" },
  { path: "scripts/v3-mvp-release-check.mjs", purpose: "release package self-check" },
  { path: "scripts/v3-small-loop-acceptance.mjs", purpose: "full engineering acceptance" },
  { path: "public/v3-fixtures/buddha-baseline.json", purpose: "fixed Buddha regression fixture" }
];

const requiredScripts = [
  "dev:v3",
  "build",
  "test:v3:mvp-basic",
  "test:v3:mvp-release",
  "test:v3:small-loop-acceptance",
  "test:v3:focused-ui",
  "test:v3:buddha-fixture"
];

const checks = [];

for (const file of requiredFiles) {
  const present = existsSync(file.path);
  const content = present ? readFileSync(file.path, "utf8") : "";
  const missingText = present && Array.isArray(file.mustInclude)
    ? file.mustInclude.filter((text) => !content.includes(text))
    : [];
  checks.push({
    id: `file:${file.path}`,
    ok: present && missingText.length === 0,
    purpose: file.purpose,
    path: file.path,
    sizeBytes: present ? statSync(file.path).size : 0,
    sha256: present ? sha256(content) : null,
    missingText
  });
}

for (const scriptName of requiredScripts) {
  checks.push({
    id: `script:${scriptName}`,
    ok: typeof packageJson.scripts?.[scriptName] === "string" && packageJson.scripts[scriptName].length > 0,
    scriptName,
    command: packageJson.scripts?.[scriptName] ?? null
  });
}

const buddhaFixture = readJson("public/v3-fixtures/buddha-baseline.json", null);
const buddhaTarget = buddhaFixture?.targetMachine && typeof buddhaFixture.targetMachine === "object"
  ? buddhaFixture.targetMachine
  : {};
const buddhaAllowsProduction = buddhaFixture?.productionBoundary?.allowProductionNc === true
  || buddhaFixture?.productionAllowed === true;
checks.push({
  id: "fixture:buddha-machine-boundary",
  ok: buddhaTarget.controllerClass === "3axis-controller-with-rotary-fixture"
    && buddhaTarget.rotaryOutputAxis === "Y"
    && buddhaTarget.toolProfileId === "vflat-4mm-25deg"
    && buddhaAllowsProduction === false,
  targetMachine: buddhaTarget.controllerClass ?? null,
  rotaryOutputAxis: buddhaTarget.rotaryOutputAxis ?? null,
  tool: buddhaTarget.toolProfileId ?? null,
  productionAllowed: buddhaAllowsProduction
});

const failed = checks.filter((check) => !check.ok);
const report = {
  schema: "hediao3d.v3-mvp-release-check.v1",
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  releaseClass: "basic-usable-safe-trial-mvp",
  productionBoundary: "Release package check does not unlock production NC. It only verifies first-release documentation, scripts and fixtures.",
  summary: failed.length === 0
    ? "V3 basic usable release package is complete."
    : `V3 release package has ${failed.length} missing or inconsistent item(s).`,
  checks,
  failed: failed.map((check) => check.id)
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exit(1);

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
