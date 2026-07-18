#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
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
  const artifactEvidence = materializeCamoticsEvidenceArtifacts(imported, sourcePath, dir);
  const evidenceQuality = evaluateCamoticsEvidence(imported, inputIdentity, artifactEvidence, adapterJob);
  const result = {
    ...imported,
    jobId: imported.jobId ?? adapterJob.jobId ?? null,
    engine,
    synthetic: false,
    importedFrom: sourcePath,
    importedAt: new Date().toISOString(),
    evidenceQuality,
    artifactEvidence,
    artifacts: {
      ...(imported.artifacts ?? {}),
      ...artifactEvidence.artifacts
    },
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

function materializeCamoticsEvidenceArtifacts(result, sourcePath, outputDir) {
  const artifactSpec = result?.artifacts ?? {};
  const sourceDir = dirname(sourcePath);
  const expected = [
    { key: "screenshot", outputName: "camotics-preview.png" },
    { key: "materialMesh", outputName: "camotics-material-removal.stl" }
  ];
  const files = {};
  const artifacts = {};
  const missing = [];

  for (const item of expected) {
    const rawValue = artifactSpec[item.key];
    if (!nonEmptyString(rawValue)) continue;
    const resolved = resolveArtifactPath(rawValue, sourceDir, outputDir);
    if (!resolved || !existsSync(resolved)) {
      missing.push({ key: item.key, value: rawValue, reason: "artifact file not found" });
      artifacts[item.key] = rawValue;
      continue;
    }
    const outputName = item.outputName || basename(resolved);
    const outputPath = join(outputDir, outputName);
    if (resolved !== outputPath) {
      copyFileSync(resolved, outputPath);
    }
    const bytes = readFileSync(outputPath);
    const stats = statSync(outputPath);
    artifacts[item.key] = outputName;
    files[item.key] = {
      filename: outputName,
      sourcePath: resolved,
      copiedPath: outputPath,
      sizeBytes: stats.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }

  return {
    schema: "hediao3d.camotics-artifact-evidence.v1",
    complete: Boolean(files.screenshot || files.materialMesh),
    files,
    artifacts,
    missing,
    summary: files.screenshot || files.materialMesh
      ? "CAMotics visual/material-removal artifacts were copied into the job package and hashed."
      : "No verifiable CAMotics visual/material-removal artifact was found."
  };
}

function resolveArtifactPath(value, sourceDir, outputDir) {
  if (!nonEmptyString(value)) return null;
  if (isAbsolute(value) && existsSync(value)) return value;
  const fromSource = join(sourceDir, value);
  if (existsSync(fromSource)) return fromSource;
  const fromOutput = join(outputDir, value);
  if (existsSync(fromOutput)) return fromOutput;
  return isAbsolute(value) ? value : fromSource;
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
  const cliRunPackagePath = join(dir, "camotics-cli-run-package.json");
  const cliRunPackageIdentity = createCliRunPackageIdentity(cliRunPackagePath);
  if (!existsSync(previewPath)) {
    return {
      preferredGcode,
      previewPath,
      expectedPreferredGcodeSha256: null,
      cliRunPackageIdentity,
      status: "missing-preview",
      message: `Preferred CAMotics preview G-code does not exist: ${previewPath}`
    };
  }
  const bytes = readFileSync(previewPath);
  const text = bytes.toString("utf8");
  return {
    preferredGcode,
    previewPath,
    expectedPreferredGcodeSha256: createHash("sha256").update(bytes).digest("hex"),
    previewMotionProfile: createGcodeMotionProfile(text),
    machineContext: createMachineContextFromGcode(text),
    cliRunPackageIdentity,
    status: "ready",
    message: "Preferred CAMotics preview G-code identity hash computed."
  };
}

function createCliRunPackageIdentity(path) {
  if (!existsSync(path)) {
    return {
      exists: false,
      filename: "camotics-cli-run-package.json",
      path,
      sha256: null,
      status: "missing",
      message: "CAMotics CLI run package was not found; legacy adapter contract only."
    };
  }
  const bytes = readFileSync(path);
  let parsed = null;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = null;
  }
  return {
    exists: true,
    filename: "camotics-cli-run-package.json",
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    schema: parsed?.schema ?? null,
    status: parsed?.status ?? "unknown",
    createdAt: parsed?.createdAt ?? null,
    preferredGcodeSha256: parsed?.preferredGcodeIdentity?.sha256 ?? null,
    upstreamCamEvidence: parsed?.upstreamCamEvidence ?? null,
    message: "CAMotics CLI run package identity hash computed."
  };
}

function evaluateCamoticsEvidence(result, inputIdentity = null, artifactEvidence = null, adapterJob = null) {
  const metrics = result?.metrics ?? {};
  const importedHash = result?.inputs?.preferredGcodeSha256;
  const expectedHash = inputIdentity?.expectedPreferredGcodeSha256 ?? null;
  const importedCliPackageHash = result?.inputs?.camoticsCliRunPackageSha256;
  const expectedCliPackageHash = inputIdentity?.cliRunPackageIdentity?.sha256 ?? null;
  const motionConsistency = evaluateCamoticsMotionConsistency(metrics, inputIdentity?.previewMotionProfile ?? null);
  const machineContext = evaluateCamoticsMachineContext(result?.inputs?.machineContext ?? null, inputIdentity?.machineContext ?? null);
  const upstreamCamEvidence = evaluateUpstreamCamEvidenceBinding(result?.inputs?.upstreamCamEvidence ?? null, inputIdentity?.cliRunPackageIdentity?.upstreamCamEvidence ?? null);
  const bundleManifestIntegrity = result?.importBundleManifestIntegrity ?? null;
  const bundleManifestIntegrityOk = !bundleManifestIntegrity || bundleManifestIntegrity.status === "matched";
  const expectedJobId = adapterJob?.jobId ?? null;
  const importedJobId = result?.jobId ?? null;
  const jobIdentityOk = nonEmptyString(expectedJobId) && importedJobId === expectedJobId;
  const jobIdentityStatus = !nonEmptyString(expectedJobId)
    ? "missing-expected-job"
    : !nonEmptyString(importedJobId)
      ? "missing-imported-job"
      : jobIdentityOk
        ? "matched"
        : "mismatch";
  const identityOk = nonEmptyString(expectedHash) && importedHash === expectedHash;
  const cliPackageRequired = Boolean(inputIdentity?.cliRunPackageIdentity?.exists);
  const cliPackageOk = !cliPackageRequired || (nonEmptyString(expectedCliPackageHash) && importedCliPackageHash === expectedCliPackageHash);
  const cliPackageStatus = !cliPackageRequired
    ? "not-required"
    : !nonEmptyString(importedCliPackageHash)
      ? "missing-imported-hash"
      : cliPackageOk
        ? "matched"
        : "mismatch";
  const hasVerifiedArtifact = Boolean(artifactEvidence?.files?.screenshot || artifactEvidence?.files?.materialMesh);
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
      id: "jobIdentity",
      ok: jobIdentityOk,
      message: "jobId must match the current Orchestrator/CAMotics adapter job."
    },
    {
      id: "cliRunPackageIdentity",
      ok: cliPackageOk,
      message: "When camotics-cli-run-package.json exists, inputs.camoticsCliRunPackageSha256 must match it."
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
      id: "motionProfile",
      ok: motionConsistency.ok,
      message: motionConsistency.message
    },
    {
      id: "machineContext",
      ok: machineContext.ok,
      message: machineContext.message
    },
    {
      id: "upstreamCamEvidence",
      ok: upstreamCamEvidence.ok,
      message: upstreamCamEvidence.summary
    },
    {
      id: "upstreamMachineFit",
      ok: upstreamCamEvidence.machineFit?.ok !== false,
      message: upstreamCamEvidence.machineFit?.summary ?? "Upstream candidate machine-fit was not required."
    },
    {
      id: "bundleManifestIntegrity",
      ok: bundleManifestIntegrityOk,
      message: "When camotics-result-bundle-manifest.json is present, its file hashes and identity claims must match the ZIP entries and result JSON."
    },
    {
      id: "visualOrMeshArtifact",
      ok: hasVerifiedArtifact,
      message: "A screenshot or material-removal mesh file must exist, be copied into the job package and have a SHA-256 hash."
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
      job: {
        status: jobIdentityStatus,
        expectedJobId,
        importedJobId,
        message: jobIdentityStatus === "matched"
          ? "Imported CAMotics result is bound to the current job."
          : jobIdentityStatus === "mismatch"
            ? "Imported CAMotics result jobId does not match the current job."
            : "Imported CAMotics result is missing a jobId binding."
      },
      cliRunPackage: {
        status: cliPackageStatus,
        required: cliPackageRequired,
        expectedSha256: expectedCliPackageHash,
        importedSha256: importedCliPackageHash ?? null,
        packageStatus: inputIdentity?.cliRunPackageIdentity?.status ?? null,
        message: cliPackageStatus === "matched"
          ? "Imported CAMotics result is bound to the current Linux run package."
          : cliPackageStatus === "not-required"
            ? "No CAMotics Linux run package was present for this adapter contract."
            : cliPackageStatus === "mismatch"
              ? "Imported CAMotics result does not match the current Linux run package hash."
              : "Imported CAMotics result is missing inputs.camoticsCliRunPackageSha256."
      },
      previewMotionProfile: inputIdentity?.previewMotionProfile ?? null,
      message: identityStatus === "matched"
        ? "Imported CAMotics result matches the current preview G-code."
        : identityStatus === "mismatch"
          ? "Imported CAMotics result hash does not match the current preview G-code."
          : identityStatus === "missing-imported-hash"
            ? "Imported CAMotics result is missing inputs.preferredGcodeSha256."
            : inputIdentity?.message ?? "Preview G-code identity could not be verified."
    },
    motionConsistency,
    machineContext,
    upstreamCamEvidence,
    bundleManifestIntegrity,
    artifactEvidence,
    summary: missing.length === 0
      ? "CAMotics result includes matching G-code identity, material volume, Z range and visual/material mesh evidence."
      : `CAMotics result imported, but evidence is incomplete: ${missing.join(", ")}.`
  };
}

function evaluateUpstreamCamEvidenceBinding(imported, expected) {
  if (!expected?.required) {
    return {
      ok: true,
      status: "not-required",
      required: false,
      presentCount: Number(expected?.presentCount ?? 0),
      machineFit: {
        ok: true,
        status: "not-required",
        required: false,
        summary: "No upstream candidate machine-fit preflight was captured in the run package."
      },
      summary: "No upstream CAM/OpenCAMLib evidence was captured in the run package."
    };
  }
  const expectedFiles = Array.isArray(expected.files)
    ? expected.files.filter((file) => file.exists && file.sha256)
    : [];
  const importedFiles = Array.isArray(imported?.files) ? imported.files : [];
  const mismatches = expectedFiles
    .map((expectedFile) => {
      const actual = importedFiles.find((file) => file.key === expectedFile.key || file.filename === expectedFile.filename);
      return {
        key: expectedFile.key,
        filename: expectedFile.filename,
        expectedSha256: expectedFile.sha256,
        importedSha256: actual?.sha256 ?? null,
        matched: Boolean(actual && actual.exists !== false && actual.sha256 === expectedFile.sha256)
      };
    })
    .filter((item) => !item.matched);
  const ok = imported?.schema === "hediao3d.camotics-upstream-cam-evidence.v1"
    && expectedFiles.length > 0
    && mismatches.length === 0;
  const machineFit = evaluateUpstreamMachineFit(imported?.candidateMachineFit, expected?.candidateMachineFit);
  const allOk = ok && machineFit.ok;
  return {
    ok: allOk,
    status: allOk ? "matched" : "mismatch",
    required: true,
    expectedCount: expectedFiles.length,
    importedCount: importedFiles.length,
    mismatches,
    machineFit,
    summary: allOk
      ? "Imported CAMotics result is hash-bound to the upstream Native CAM/OpenCAMLib evidence captured by the run package."
      : machineFit.ok
        ? "Imported CAMotics result is missing or mismatching upstream Native CAM/OpenCAMLib evidence hashes."
        : `Imported CAMotics result is bound to an unacceptable upstream machine-fit: ${machineFit.summary}`
  };
}

function evaluateUpstreamMachineFit(importedMachineFit, expectedMachineFit) {
  if (!expectedMachineFit) {
    return {
      ok: true,
      status: "not-required",
      required: false,
      summary: "No upstream candidate machine-fit preflight was captured in the run package."
    };
  }
  const expectedLevel = expectedMachineFit.level ?? "missing";
  const importedLevel = importedMachineFit?.level ?? "missing";
  const expectedAxis = String(expectedMachineFit.targetMachine?.rotaryOutputAxis ?? "").toUpperCase();
  const importedAxis = String(importedMachineFit?.targetMachine?.rotaryOutputAxis ?? "").toUpperCase();
  const schemaOk = importedMachineFit?.schema === (expectedMachineFit.schema ?? "hediao3d.opencamlib-candidate-machine-fit-preflight.v1");
  const levelOk = importedLevel === expectedLevel;
  const notCritical = importedLevel !== "critical";
  const rotaryAxisOk = expectedAxis === importedAxis;
  const ok = schemaOk && levelOk && notCritical && rotaryAxisOk;
  return {
    ok,
    status: ok ? "matched" : "mismatch",
    required: true,
    expectedLevel,
    importedLevel,
    schemaOk,
    levelOk,
    notCritical,
    rotaryAxisOk,
    expected: summarizeMachineFitForEvidence(expectedMachineFit),
    imported: summarizeMachineFitForEvidence(importedMachineFit),
    summary: ok
      ? `Upstream OpenCAMLib candidate machine-fit is ${importedLevel} and matches the run package.`
      : `Expected machineFit level=${expectedLevel}, axis=${expectedAxis || "missing"}; got level=${importedLevel}, axis=${importedAxis || "missing"}.`
  };
}

function summarizeMachineFitForEvidence(machineFit) {
  if (!machineFit || typeof machineFit !== "object") return null;
  return {
    schema: machineFit.schema ?? null,
    level: machineFit.level ?? "missing",
    rotaryOutputAxis: machineFit.targetMachine?.rotaryOutputAxis ?? null,
    wrapPerRevolutionMm: Number.isFinite(Number(machineFit.targetMachine?.wrapPerRevolutionMm)) ? Number(machineFit.targetMachine.wrapPerRevolutionMm) : null,
    rotarySpanDeg: Number.isFinite(Number(machineFit.coverage?.rotarySpanDeg)) ? Number(machineFit.coverage.rotarySpanDeg) : null,
    expectedRotaryCoverageDeg: Number.isFinite(Number(machineFit.coverage?.expectedRotaryCoverageDeg)) ? Number(machineFit.coverage.expectedRotaryCoverageDeg) : null,
    holdZonePointCount: Number(machineFit.riskCounts?.holdZonePointCount ?? 0),
    deepPointCount: Number(machineFit.riskCounts?.deepPointCount ?? 0),
    missingRotaryCount: Number(machineFit.riskCounts?.missingRotaryCount ?? 0)
  };
}

function evaluateCamoticsMotionConsistency(metrics, previewProfile) {
  if (!previewProfile || !Number.isFinite(Number(previewProfile.motionLineCount))) {
    return {
      ok: false,
      status: "missing-preview-profile",
      message: "camotics-preview.nc motion profile could not be computed."
    };
  }
  const importedMotionCount = Number(metrics.motionLineCount);
  const importedZMin = Number(metrics.zMin);
  const importedZMax = Number(metrics.zMax);
  const expectedMotionCount = Number(previewProfile.motionLineCount);
  const expectedZMin = Number(previewProfile.zMin);
  const expectedZMax = Number(previewProfile.zMax);
  const motionTolerance = Math.max(2, Math.ceil(expectedMotionCount * 0.05));
  const zTolerance = 0.05;
  const motionDelta = Math.abs(importedMotionCount - expectedMotionCount);
  const zMinDelta = Math.abs(importedZMin - expectedZMin);
  const zMaxDelta = Math.abs(importedZMax - expectedZMax);
  const ok = Number.isFinite(importedMotionCount)
    && Number.isFinite(importedZMin)
    && Number.isFinite(importedZMax)
    && motionDelta <= motionTolerance
    && zMinDelta <= zTolerance
    && zMaxDelta <= zTolerance;
  return {
    ok,
    status: ok ? "matched" : "mismatch",
    expected: {
      motionLineCount: expectedMotionCount,
      zMin: expectedZMin,
      zMax: expectedZMax
    },
    imported: {
      motionLineCount: Number.isFinite(importedMotionCount) ? importedMotionCount : null,
      zMin: Number.isFinite(importedZMin) ? importedZMin : null,
      zMax: Number.isFinite(importedZMax) ? importedZMax : null
    },
    tolerance: {
      motionLineCount: motionTolerance,
      zMm: zTolerance
    },
    delta: {
      motionLineCount: Number.isFinite(importedMotionCount) ? motionDelta : null,
      zMin: Number.isFinite(importedZMin) ? zMinDelta : null,
      zMax: Number.isFinite(importedZMax) ? zMaxDelta : null
    },
    message: ok
      ? "Imported CAMotics motion metrics match the current camotics-preview.nc profile."
      : "Imported CAMotics motion metrics do not match the current camotics-preview.nc profile."
  };
}

function evaluateCamoticsMachineContext(importedContext, expectedContext) {
  if (!expectedContext) {
    return {
      ok: false,
      status: "missing-expected-context",
      expected: null,
      imported: importedContext ?? null,
      message: "camotics-preview.nc machine context could not be computed."
    };
  }
  const imported = importedContext && typeof importedContext === "object" ? importedContext : null;
  if (!imported) {
    return {
      ok: false,
      status: "missing-imported-context",
      expected: expectedContext,
      imported: null,
      message: "Imported CAMotics result is missing inputs.machineContext."
    };
  }
  const expectedAxis = String(expectedContext.rotaryWrapAxis ?? "").toUpperCase();
  const importedAxis = String(imported.rotaryWrapAxis ?? imported.rotaryOutputAxis ?? "").toUpperCase();
  const expectedLengthAxis = String(expectedContext.lengthAxis ?? "").toUpperCase();
  const importedLengthAxis = String(imported.lengthAxis ?? "").toUpperCase();
  const expectedWrap = Number(expectedContext.rotaryWrapPerRevolutionMm);
  const importedWrap = Number(imported.rotaryWrapPerRevolutionMm);
  const ok = String(imported.camMode ?? expectedContext.camMode) === String(expectedContext.camMode)
    && importedAxis === expectedAxis
    && importedLengthAxis === expectedLengthAxis
    && close(importedWrap, expectedWrap, 0.001);
  return {
    ok,
    status: ok ? "matched" : "mismatch",
    expected: expectedContext,
    imported,
    message: ok
      ? "Imported CAMotics result matches the current rotary-wrap machine context."
      : "Imported CAMotics result machine context does not match camotics-preview.nc."
  };
}

function close(actual, expectedValue, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expectedValue) && Math.abs(actual - expectedValue) <= tolerance;
}

function createGcodeMotionProfile(gcodeText) {
  const motionLines = String(gcodeText ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\([^)]*\)/g, "").trim().toUpperCase())
    .filter((line) => /\bG0?0\b|\bG0?1\b/.test(line));
  const zValues = motionLines
    .map((line) => parseWord(line, "Z"))
    .filter(Number.isFinite);
  return {
    motionLineCount: motionLines.length,
    zMin: zValues.length ? Math.min(...zValues) : null,
    zMax: zValues.length ? Math.max(...zValues) : null,
    machineContext: createMachineContextFromGcode(gcodeText)
  };
}

function createMachineContextFromGcode(gcodeText) {
  const text = String(gcodeText ?? "");
  const axis = matchHeader(text, "ROTARY_WRAP_AXIS");
  const rawPerRev = matchHeader(text, "ROTARY_WRAP_PER_REV_MM");
  const perRev = rawPerRev == null ? NaN : Number(rawPerRev);
  const lengthAxis = matchHeader(text, "LENGTH_AXIS");
  const rotaryMode = Boolean(axis || Number.isFinite(perRev));
  return {
    schema: "hediao3d.camotics-machine-context.v1",
    camMode: rotaryMode ? "rotaryWrap" : "3axis",
    rotaryWrapAxis: axis ? axis.toUpperCase() : null,
    rotaryOutputAxis: axis ? axis.toUpperCase() : null,
    rotaryWrapPerRevolutionMm: Number.isFinite(perRev) ? perRev : null,
    lengthAxis: lengthAxis ? lengthAxis.toUpperCase() : "X",
    simulationInterpretation: rotaryMode ? "linearized-rotary-wrap-as-3axis" : "plain-3axis"
  };
}

function matchHeader(text, key) {
  const match = String(text ?? "").match(new RegExp(`${key}\\s*=\\s*([^\\s)]+)`, "i"));
  return match ? match[1] : null;
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
