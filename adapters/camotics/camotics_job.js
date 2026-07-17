#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const [, , jobPath, resultPath] = process.argv;
const protocolVersion = "hediao3d.adapter.v1";
const engine = "camotics";

if (!jobPath || !resultPath) {
  console.error("Usage: camotics_job.js <job.json> <result.json>");
  process.exit(2);
}

const job = JSON.parse(readFileSync(jobPath, "utf8"));
const recipe = job.externalCamRecipe ?? {};
const operations = Array.isArray(recipe.operations) ? recipe.operations : [];
const settings = job.settings ?? {};
const workDir = job.workDir ?? dirname(resultPath);
const camoticsDetection = detectCamotics();
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

const missing = ["jobId", "settings", "outputs"].filter((key) => !(key in job));
const simulationPlan = buildSimulationPlan(job, camoticsDetection);
const artifactPaths = missing.length > 0 ? null : writePlanArtifacts(workDir, simulationPlan);
const attempt = attemptCamoticsExecution(job, simulationPlan, camoticsDetection);
const result = missing.length > 0
  ? {
      status: "failed",
      protocolVersion,
      engine,
      jobId: job.jobId ?? null,
      error: `Missing adapter job keys: ${missing.join(", ")}`,
      warnings: [],
      metrics: {
        recipe: recipeSummary,
        camotics: camoticsDetection
      }
    }
  : {
      status: attempt.status,
      protocolVersion,
      engine,
      jobId: job.jobId ?? null,
      error: attempt.error,
      warnings: [
        "CAMotics adapter now emits a simulation plan and project template.",
        attempt.synthetic
          ? "Synthetic CAMotics result validates Orchestrator simulation handoff only; it is not real material-removal output."
          : "Material-removal execution remains locked until CAMotics CLI behavior is validated on the deployment server."
      ],
      metrics: {
        gcodePath: job.outputs?.gcode ?? null,
        resultPath: attempt.resultPath ?? null,
        imported: Boolean(attempt.imported),
        synthetic: Boolean(attempt.synthetic),
        camMode: settings.camMode ?? null,
        recipe: recipeSummary,
        camotics: camoticsDetection,
        camoticsPlan: {
          status: "generated",
          planPath: artifactPaths.simulationPlan,
          projectTemplatePath: artifactPaths.projectTemplate,
          preferredGcode: simulationPlan.inputs.preferredGcode,
          canRunInCamotics: simulationPlan.compatibility.canRunInCamotics
        }
      },
      ...(attempt.resultPath ? { simulationResultPath: attempt.resultPath, outputs: { simulationResult: attempt.resultPath } } : {})
    };

mkdirSync(dirname(resultPath), { recursive: true });
writeFileSync(resultPath, JSON.stringify(result, null, 2));

function detectCamotics() {
  for (const command of ["camotics-cli", "camotics"]) {
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2500
    });
    if (!probe.error || probe.status === 0) {
      return {
        available: true,
        command,
        version: `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split(/\r?\n/).slice(0, 2).join(" | ") || "detected"
      };
    }
  }
  return {
    available: false,
    command: null,
    version: null
  };
}

function buildSimulationPlan(adapterJob, detection) {
  const s = adapterJob.settings ?? {};
  const rotaryAxis = s.camMode === "rotaryWrap" ? String(s.rotaryOutputAxis ?? "Y").toUpperCase() : null;
  const linearizedRotary = s.camMode === "rotaryWrap" && rotaryAxis && rotaryAxis !== "A";
  const canRunInCamotics = s.camMode === "3axis" || linearizedRotary;
  const wrapPerRev = Math.max(0.001, Number(s.rotaryWrapPerRevolutionMm ?? 100));
  const length = Math.max(0.001, Number(s.lengthMm ?? 1));
  const diameter = Math.max(0.001, Number(s.diameterMm ?? 1));
  const depth = Math.max(0, Number(s.depthMm ?? 0));
  const safeZ = Number(s.safeZ ?? Math.max(5, depth + 2));
  const margin = Math.max(1, Number(s.toolDiameter ?? 1));
  const yMax = linearizedRotary ? wrapPerRev : diameter;
  const stockMin = { x: -length / 2 - margin, y: -margin, z: -depth - margin };
  const stockMax = { x: length / 2 + margin, y: yMax + margin, z: safeZ + margin };

  return {
    schema: "hediao3d.camotics-simulation-plan.v1",
    jobId: adapterJob.jobId ?? null,
    createdAt: new Date().toISOString(),
    status: canRunInCamotics ? "ready-for-camotics-preview" : "review-required",
    compatibility: {
      canRunInCamotics,
      mode: s.camMode ?? null,
      rotaryAxis,
      interpretation: linearizedRotary ? "linearized-rotary-wrap-as-3axis" : s.camMode === "3axis" ? "plain-3axis" : "unsupported-rotary-or-4axis",
      reason: canRunInCamotics
        ? "CAMotics can check the unwrapped X/Y/Z preview G-code envelope."
        : "CAMotics is primarily a 3-axis simulator; use rotary-aware simulation for true A-axis/four-axis output."
    },
    engine: {
      adapter: engine,
      execution: "planned-not-run",
      camoticsAvailable: detection.available,
      command: detection.command,
      reason: "CLI execution is locked until deployment validation is complete."
    },
    inputs: {
      preferredGcode: "camotics-preview.nc",
      machineGcodeForReferenceOnly: "toolpath.nc",
      airRun: "air-run.nc"
    },
    stock: {
      shape: linearizedRotary ? "unwrapped-rectangular-stock" : "rectangular-stock",
      boundsMm: { min: stockMin, max: stockMax },
      marginMm: margin
    },
    tool: {
      type: isVFlat25(s) ? "v-bit-flat-tip" : "flat-endmill",
      diameterMm: Number(s.toolDiameter ?? 0),
      flatTipMm: isVFlat25(s) ? 0.4 : null,
      angleDeg: isVFlat25(s) ? 25 : null,
      spindleRpm: Number(s.spindleRpm ?? 0),
      feedRateMmMin: Number(s.feedRate ?? 0)
    },
    commands: {
      openPreview: "camotics camotics-preview.nc",
      openAirRun: "camotics air-run.nc",
      cliPlaceholder: "camotics-cli --simulate camotics-project-template.json"
    },
    projectTemplate: {
      schema: "hediao3d.camotics-project-template.v1",
      jobId: adapterJob.jobId ?? null,
      units: "mm",
      files: {
        gcode: "camotics-preview.nc",
        referenceMachineGcode: "toolpath.nc",
        airRun: "air-run.nc"
      },
      stock: {
        min: stockMin,
        max: stockMax,
        shape: linearizedRotary ? "unwrapped-rectangular-stock" : "rectangular-stock"
      },
      tool: {
        type: isVFlat25(s) ? "v-bit-flat-tip" : "flat-endmill",
        diameterMm: Number(s.toolDiameter ?? 0),
        flatTipMm: isVFlat25(s) ? 0.4 : null,
        angleDeg: isVFlat25(s) ? 25 : null
      },
      outputRequests: {
        screenshot: "camotics-preview.png",
        materialMesh: "camotics-material-removal.stl",
        summary: "camotics-result.json"
      }
    }
  };
}

function writePlanArtifacts(dir, simulationPlan) {
  mkdirSync(dir, { recursive: true });
  const simulationPlanPath = join(dir, "camotics-simulation-plan.json");
  const projectTemplatePath = join(dir, "camotics-project-template.json");
  writeFileSync(simulationPlanPath, JSON.stringify(simulationPlan, null, 2));
  writeFileSync(projectTemplatePath, JSON.stringify(simulationPlan.projectTemplate, null, 2));
  return {
    simulationPlan: simulationPlanPath,
    projectTemplate: projectTemplatePath
  };
}

function attemptCamoticsExecution(adapterJob, simulationPlan, detection) {
  const enabled = String(process.env.HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN ?? "").toLowerCase() === "true";
  if (!enabled) {
    return {
      status: "adapter_not_ready",
      error: "CAMotics simulation plan generated, but experimental CLI execution is disabled. Set HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true only after validating the deployment server."
    };
  }
  const imported = tryImportCamoticsResult(adapterJob, simulationPlan, detection);
  if (imported) return imported;
  if (String(process.env.HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT ?? "").toLowerCase() === "true") {
    return writeSyntheticCamoticsResult(adapterJob, simulationPlan, detection);
  }
  if (!detection.available) {
    return {
      status: "adapter_not_ready",
      error: "CAMotics command is not available on PATH."
    };
  }
  if (!simulationPlan.compatibility.canRunInCamotics) {
    return {
      status: "adapter_not_ready",
      error: "The current CAM mode is not suitable for CAMotics 3-axis preview execution."
    };
  }
  if (!existsSync(join(adapterJob.workDir ?? dirname(resultPath), simulationPlan.inputs.preferredGcode))) {
    return {
      status: "adapter_not_ready",
      error: "Preferred CAMotics preview G-code does not exist yet."
    };
  }
  return {
    status: "adapter_not_ready",
    error: "CAMotics command detected, but material-removal result extraction is still locked pending server validation."
  };
}

function tryImportCamoticsResult(adapterJob, simulationPlan, detection) {
  const sourcePath = process.env.HEDIAO3D_CAMOTICS_RESULT_JSON;
  if (!sourcePath) return null;
  const dir = adapterJob.workDir ?? dirname(resultPath);
  const outputPath = join(dir, "camotics-result.json");
  if (!existsSync(sourcePath)) {
    return {
      status: "adapter_not_ready",
      error: `HEDIAO3D_CAMOTICS_RESULT_JSON does not exist: ${sourcePath}`
    };
  }
  let imported;
  try {
    imported = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch {
    return {
      status: "adapter_not_ready",
      error: `HEDIAO3D_CAMOTICS_RESULT_JSON is not valid JSON: ${sourcePath}`
    };
  }
  const validationErrors = validateImportedCamoticsResult(imported);
  if (validationErrors.length > 0) {
    return {
      status: "adapter_not_ready",
      error: `Imported CAMotics result failed validation: ${validationErrors.join("; ")}`
    };
  }
  const inputIdentity = createCamoticsInputIdentity(adapterJob, simulationPlan);
  const evidenceQuality = evaluateCamoticsEvidence(imported, inputIdentity);
  const result = {
    ...imported,
    jobId: imported.jobId ?? adapterJob.jobId ?? null,
    engine,
    synthetic: false,
    importedFrom: sourcePath,
    importedAt: new Date().toISOString(),
    evidenceQuality,
    inputs: {
      ...(imported.inputs ?? {}),
      preferredGcode: imported.inputs?.preferredGcode ?? simulationPlan.inputs.preferredGcode,
      preferredGcodeSha256: imported.inputs?.preferredGcodeSha256 ?? null,
      expectedPreferredGcodeSha256: inputIdentity.expectedPreferredGcodeSha256,
      identityStatus: evidenceQuality.inputIdentity.status
    },
    detection
  };
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  return {
    status: "completed",
    error: null,
    resultPath: outputPath,
    synthetic: false,
    imported: true,
    sourcePath
  };
}

function validateImportedCamoticsResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result is not an object"];
  if (result.schema !== "hediao3d.camotics-result.v1") errors.push("schema must be hediao3d.camotics-result.v1");
  if (result.status !== "completed") errors.push("status must be completed");
  if (result.synthetic === true) errors.push("synthetic result cannot be imported as real CAMotics evidence");
  if (!result.metrics || typeof result.metrics !== "object") errors.push("metrics object is required");
  if (!result.summary) errors.push("summary is required");
  return errors;
}

function createCamoticsInputIdentity(adapterJob, simulationPlan) {
  const dir = adapterJob.workDir ?? dirname(resultPath);
  const preferredGcode = simulationPlan.inputs.preferredGcode;
  const previewPath = join(dir, preferredGcode);
  if (!existsSync(previewPath)) {
    return {
      preferredGcode,
      previewPath,
      expectedPreferredGcodeSha256: null,
      status: "missing-preview",
      message: `Preferred CAMotics preview G-code does not exist: ${previewPath}`
    };
  }
  const bytes = readFileSync(previewPath);
  return {
    preferredGcode,
    previewPath,
    expectedPreferredGcodeSha256: createHash("sha256").update(bytes).digest("hex"),
    status: "ready",
    message: "Preferred CAMotics preview G-code identity hash computed."
  };
}

function evaluateCamoticsEvidence(result, inputIdentity = null) {
  const metrics = result?.metrics ?? {};
  const artifacts = result?.artifacts ?? {};
  const importedHash = result?.inputs?.preferredGcodeSha256;
  const expectedHash = inputIdentity?.expectedPreferredGcodeSha256 ?? null;
  const identityOk = nonEmptyString(expectedHash) && importedHash === expectedHash;
  const identityStatus = !inputIdentity || inputIdentity.status !== "ready"
    ? "missing-preview"
    : !nonEmptyString(importedHash)
      ? "missing-imported-hash"
      : identityOk
        ? "matched"
        : "mismatch";
  const checks = [
    {
      id: "inputIdentity",
      ok: identityOk,
      message: "inputs.preferredGcodeSha256 must match the current camotics-preview.nc SHA-256."
    },
    {
      id: "materialRemovedMm3",
      ok: Number.isFinite(Number(metrics.materialRemovedMm3)) && Number(metrics.materialRemovedMm3) >= 0,
      message: "metrics.materialRemovedMm3 must be a non-negative number."
    },
    {
      id: "zRange",
      ok: Number.isFinite(Number(metrics.zMin)) && Number.isFinite(Number(metrics.zMax)) && Number(metrics.zMin) <= Number(metrics.zMax),
      message: "metrics.zMin/zMax must be finite and ordered."
    },
    {
      id: "visualOrMeshArtifact",
      ok: nonEmptyString(artifacts.screenshot) || nonEmptyString(artifacts.materialMesh),
      message: "artifacts.screenshot or artifacts.materialMesh is required for production evidence."
    },
    {
      id: "riskReady",
      ok: result?.riskLevel === "ready",
      message: "riskLevel must be ready."
    }
  ];
  const missing = checks.filter((check) => !check.ok).map((check) => check.id);

  return {
    schema: "hediao3d.camotics-evidence-quality.v1",
    productionEvidenceEligible: missing.length === 0,
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    checks,
    inputIdentity: {
      status: identityStatus,
      preferredGcode: inputIdentity?.preferredGcode ?? null,
      expectedPreferredGcodeSha256: expectedHash,
      importedPreferredGcodeSha256: importedHash ?? null,
      message: identityStatus === "matched"
        ? "Imported CAMotics result matches the current preview G-code."
        : identityStatus === "mismatch"
          ? "Imported CAMotics result hash does not match the current preview G-code."
          : identityStatus === "missing-imported-hash"
            ? "Imported CAMotics result is missing inputs.preferredGcodeSha256."
            : inputIdentity?.message ?? "Preview G-code identity could not be verified."
    },
    summary: missing.length === 0
      ? "CAMotics result includes matching G-code identity, material volume, Z range and visual/material mesh evidence."
      : `CAMotics result imported, but evidence is incomplete: ${missing.join(", ")}.`
  };
}

function writeSyntheticCamoticsResult(adapterJob, simulationPlan, detection) {
  if (!simulationPlan.compatibility.canRunInCamotics) {
    return {
      status: "adapter_not_ready",
      error: "The current CAM mode is not suitable for CAMotics 3-axis preview execution."
    };
  }
  const dir = adapterJob.workDir ?? dirname(resultPath);
  const previewPath = join(dir, simulationPlan.inputs.preferredGcode);
  if (!existsSync(previewPath)) {
    return {
      status: "adapter_not_ready",
      error: "Preferred CAMotics preview G-code does not exist yet."
    };
  }
  const previewText = readFileSync(previewPath, "utf8");
  const previewHash = createHash("sha256").update(previewText).digest("hex");
  const motionLines = previewText
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line));
  const zValues = motionLines
    .map((line) => parseWord(line, "Z"))
    .filter(Number.isFinite);
  const bounds = simulationPlan.stock?.boundsMm ?? {};
  const result = {
    schema: "hediao3d.camotics-result.v1",
    jobId: adapterJob.jobId ?? null,
    engine,
    mode: "synthetic-contract",
    synthetic: true,
    createdAt: new Date().toISOString(),
    status: "completed",
    riskLevel: "review",
    summary: "Synthetic CAMotics result generated from camotics-preview.nc for Orchestrator handoff validation.",
    inputs: {
      preferredGcode: simulationPlan.inputs.preferredGcode,
      preferredGcodeSha256: previewHash,
      expectedPreferredGcodeSha256: previewHash,
      identityStatus: "synthetic",
      previewBytes: Buffer.byteLength(previewText),
      motionLineCount: motionLines.length
    },
    metrics: {
      motionLineCount: motionLines.length,
      zMin: zValues.length ? Math.min(...zValues) : null,
      zMax: zValues.length ? Math.max(...zValues) : null,
      estimatedMinutes: simulationPlan.metricsSeed?.estimatedMinutes ?? null,
      stockBoundsMm: bounds
    },
    artifacts: {
      screenshot: null,
      materialMesh: null,
      note: "Real CAMotics screenshot/material mesh extraction is still a deployment validation step."
    },
    evidenceQuality: {
      schema: "hediao3d.camotics-evidence-quality.v1",
      productionEvidenceEligible: false,
      status: "synthetic",
      missing: ["real-camotics-run"],
      checks: [],
      summary: "Synthetic CAMotics result is not production evidence."
    },
    detection
  };
  const outputPath = join(dir, "camotics-result.json");
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  return {
    status: "completed",
    error: null,
    resultPath: outputPath,
    synthetic: true
  };
}

function parseWord(line, word) {
  const match = line.match(new RegExp(`${word}\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : NaN;
}

function isVFlat25(s) {
  return s.toolProfileId === "vflat-4mm-25deg" || s.toolProfileId === "vbit-flat-4mm-25deg";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
