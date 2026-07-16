#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , jobPath, resultPath] = process.argv;

if (!jobPath || !resultPath) {
  console.error("Usage: camotics_job.js <job.json> <result.json>");
  process.exit(2);
}

const job = JSON.parse(readFileSync(jobPath, "utf8"));
const recipe = job.externalCamRecipe ?? {};
const operations = Array.isArray(recipe.operations) ? recipe.operations : [];
const recipeSummary = {
  present: Boolean(job.externalCamRecipe),
  status: recipe.status ?? null,
  selectedEngine: recipe.engine?.selectedEngine ?? null,
  engineFamily: recipe.engine?.engineFamily ?? null,
  operationCount: operations.length,
  enabledOperationCount: operations.filter((operation) => operation?.enabled).length,
  postprocessPolicy: recipe.postprocess?.policy ?? null,
  toolProfileId: recipe.tool?.toolProfileId ?? null
};
const result = {
  status: "adapter_not_ready",
  protocolVersion: "hediao3d.adapter.v1",
  engine: "camotics",
  jobId: job.jobId ?? null,
  error: "CAMotics adapter is scaffolded but not enabled for material-removal output.",
  warnings: [
    "Install CAMotics on the server, then implement project generation, CLI execution and screenshot/mesh artifact extraction."
  ],
  metrics: {
    gcodePath: job.outputs?.gcode ?? null,
    camMode: job.settings?.camMode ?? null,
    recipe: recipeSummary
  }
};

mkdirSync(dirname(resultPath), { recursive: true });
writeFileSync(resultPath, JSON.stringify(result, null, 2));
