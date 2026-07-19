#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const skipBuild = process.argv.includes("--skip-build");
const reportDir = join(process.cwd(), "reports");
const commands = [
  {
    id: "mvp-release",
    title: "Release package self-check",
    command: npmRun("test:v3:mvp-release")
  },
  {
    id: "architecture-coverage",
    title: "Requested V3 architecture coverage audit",
    command: npmRun("test:v3:architecture")
  },
  {
    id: "mvp-basic",
    title: "Basic usable MVP acceptance",
    command: npmRun("test:v3:mvp-basic")
  },
  ...(skipBuild
    ? []
    : [{
        id: "production-build",
        title: "Production frontend build",
        command: npmRun("build")
      }])
];

mkdirSync(reportDir, { recursive: true });

const startedAt = new Date();
const results = [];
let failed = false;

for (const item of commands) {
  const stepStartedAt = Date.now();
  const run = spawnSync(item.command[0], item.command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env }
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const ok = run.status === 0;
  results.push({
    id: item.id,
    title: item.title,
    ok,
    exitCode: run.status,
    durationMs: Date.now() - stepStartedAt,
    command: item.command.join(" "),
    outputTail: tail(output, 1600)
  });
  if (!ok) {
    failed = true;
    break;
  }
}

const finishedAt = new Date();
const report = {
  schema: "hediao3d.v3-mvp-one-command-acceptance.v1",
  ok: !failed,
  releaseClass: "basic-usable-safe-trial-mvp",
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  productionBoundary: "This command proves a safe-trial MVP release candidate only. It never unlocks production NC.",
  commands: results,
  failed: results.filter((item) => !item.ok).map((item) => item.id),
  nextActions: failed
    ? ["Fix the first failed command, then rerun npm run test:v3:mvp-one-command."]
    : [
        "Use npm run dev:v3 for local operator testing.",
        "Use the safe-trial package and keep production NC locked until real CAM, material-removal simulation, air-run, trial feedback and machine acceptance are bound to the same job."
      ],
  summary: failed
    ? `V3 MVP one-command acceptance failed at ${results.find((item) => !item.ok)?.id ?? "unknown"}.`
    : "V3 MVP one-command acceptance passed: release package, basic safe-trial flow and production build are healthy."
};

const jsonPath = join(reportDir, "v3-mvp-one-command-acceptance.json");
const mdPath = join(reportDir, "v3-mvp-one-command-acceptance.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(mdPath, markdownReport(report));

console.log(JSON.stringify({
  ok: report.ok,
  schema: report.schema,
  summary: report.summary,
  reportJson: jsonPath,
  reportMarkdown: mdPath,
  failed: report.failed
}, null, 2));

if (failed) process.exit(1);

function npmRun(scriptName) {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", "npm", "run", scriptName];
  }
  return ["npm", "run", scriptName];
}

function tail(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function markdownReport(value) {
  const lines = [
    "# HeDiao3D V3 MVP One-command Acceptance",
    "",
    `- Result: ${value.ok ? "PASS" : "FAIL"}`,
    `- Release class: ${value.releaseClass}`,
    `- Started: ${value.startedAt}`,
    `- Finished: ${value.finishedAt}`,
    `- Duration: ${Math.round(value.durationMs / 1000)}s`,
    `- Production boundary: ${value.productionBoundary}`,
    "",
    "## Commands",
    ""
  ];

  for (const item of value.commands) {
    lines.push(`### ${item.ok ? "PASS" : "FAIL"} ${item.title}`);
    lines.push("");
    lines.push(`- Id: ${item.id}`);
    lines.push(`- Exit code: ${item.exitCode}`);
    lines.push(`- Duration: ${item.durationMs}ms`);
    lines.push(`- Command: \`${item.command}\``);
    if (!item.ok && item.outputTail) {
      lines.push("");
      lines.push("```text");
      lines.push(item.outputTail);
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## Next Actions");
  lines.push("");
  for (const action of value.nextActions) lines.push(`- ${action}`);
  lines.push("");
  lines.push(value.summary);
  lines.push("");
  return lines.join("\n");
}
