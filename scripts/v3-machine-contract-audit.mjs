#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const files = {
  app: read("src/App.tsx"),
  profiles: read("src/manufacturingProfiles.ts"),
  server: read("server.mjs"),
  postprocessTest: read("scripts/v3-postprocess-regression-test.mjs"),
  architectureAudit: read("scripts/v3-architecture-coverage-audit.mjs")
};

const checks = [
  check("profile:machine-id", files.profiles.includes('id: "desktop-3axis-rotary-y"'), "Machine profile desktop-3axis-rotary-y exists."),
  check("profile:machine-name", files.profiles.includes("三轴控制器 + Y轴旋转夹具"), "Machine profile is named for the real user machine style."),
  check("profile:machine-3axis", files.profiles.includes('axes: "3axis"'), "Machine profile stays in 3-axis controller class."),
  check("profile:apply-wrap-y", includesAll(files.profiles, ['machine.id === "desktop-3axis-rotary-y"', 'rotaryOutputAxis: "Y"', 'postProcessor: "wrapY"']), "Applying the machine profile forces Y rotary wrap."),
  check("profile:tool-id", files.profiles.includes('id: "vflat-4mm-25deg"'), "4mm 25 degree flat-tip V tool exists."),
  check("profile:tool-geometry", includesAll(files.profiles, ["diameterMm: 4", "angleDeg: 25", "flatTipMm: 0.4"]), "Tool geometry records 4mm diameter, 25 degree angle and flat tip."),
  check("frontend:default-machine", includesAll(files.app, ['machineProfileId: "desktop-3axis-rotary-y"', 'toolProfileId: "vflat-4mm-25deg"', 'rotaryOutputAxis: "Y"', 'postProcessor: "wrapY"']), "Frontend default V3 settings target the real machine contract."),
  check("frontend:focused-copy", files.app.includes("三轴控制器 + Y轴旋转夹具，后处理固定走 wrapY 证据链"), "Focused UI tells the operator the target wrapY boundary."),
  check("server:default-normalization", includesAll(files.server, ['rotaryOutputAxis: "Y"', 'postProcessor: "wrapY"', 'machineProfileId: "desktop-3axis-rotary-y"', 'toolProfileId: "vflat-4mm-25deg"']), "Backend defaults and normalization preserve the machine/tool contract."),
  check("server:axis-policy", files.server.includes("X=长度方向，Y=旋转夹具，Z=刀深/安全高度"), "Generated machine policy states the exact axis mapping."),
  check("server:forbid-a-axis", includesAll(files.server, ["A-axis words are forbidden for wrapY", "forbiddenWords", '"A"']), "Backend rejects or flags A-axis words for wrapY machine output."),
  check("server:rotary-header", files.server.includes("ROTARY_WRAP_AXIS=Y"), "Backend requires or emits the Y rotary wrap header."),
  check("postprocess:e2e-contract", includesAll(files.postprocessTest, ['machineProfileId: "desktop-3axis-rotary-y"', 'toolProfileId: "vflat-4mm-25deg"', 'rotaryOutputAxis: "Y"', 'postProcessor: "wrapY"', "axisCounts.a === 0"]), "Postprocess E2E regression covers the no-A-axis wrapY contract."),
  check("architecture:audit-contract", includesAll(files.architectureAudit, ["desktop-3axis-rotary-y", "vflat-4mm-25deg", "postProcessor: \\\"wrapY\\\"", "ROTARY_WRAP_AXIS=Y"]), "Architecture audit also watches the target machine boundary.")
];

const failed = checks.filter((item) => !item.ok);
const report = {
  schema: "hediao3d.v3-machine-contract-audit.v1",
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  target: {
    controllerClass: "3axis-controller-with-rotary-fixture",
    lengthAxis: "X",
    rotaryOutputAxis: "Y",
    depthAxis: "Z",
    machineProfileId: "desktop-3axis-rotary-y",
    toolProfileId: "vflat-4mm-25deg",
    postProcessor: "wrapY"
  },
  productionBoundary: "This audit prevents source-level regression of the target machine contract. It does not prove real machine calibration or unlock production NC.",
  checks,
  failed: failed.map((item) => item.id),
  summary: failed.length === 0
    ? "Target machine contract is present: X length, Y rotary fixture, Z depth, wrapY postprocess, 4mm 25 degree flat-tip V tool, and no A-axis machine output."
    : `Target machine contract audit failed: ${failed.map((item) => item.id).join(", ")}.`
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exit(1);

function read(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function check(id, ok, summary) {
  return { id, ok: Boolean(ok), summary };
}

function includesAll(source, needles) {
  return needles.every((needle) => source.includes(needle));
}
