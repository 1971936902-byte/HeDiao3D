#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-rotary-heightfield-"));

try {
  const modelPath = join(workDir, "rotary-relief-cylinder.stl");
  const jobPath = join(workDir, "job.json");
  const planPath = join(workDir, "opencamlib-kernel-plan.json");
  const outputPath = join(workDir, "neutral-toolpath.json");
  writeFileSync(modelPath, createRotaryReliefStl(), "utf8");

  const job = {
    jobId: "v3-rotary-heightfield-runner-test",
    settings: {
      lengthMm: 30,
      diameterMm: 12,
      depthMm: 1.2,
      safeZ: 18,
      toolDiameter: 4,
      toolProfileId: "vflat-4mm-25deg",
      stepoverMm: 0.28,
      stepoverDeg: 5,
      camMode: "rotaryWrap",
      rotaryOutputAxis: "Y",
      rotaryWrapPerRevolutionMm: 100,
      postProcessor: "wrapY"
    },
    outputs: {
      neutralToolpath: outputPath
    }
  };
  const plan = {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: job.jobId,
    engine: "opencamlib",
    model: {
      path: modelPath,
      format: "stl",
      exists: true
    },
    stock: {
      lengthMm: 30,
      diameterMm: 12
    },
    tool: {
      toolProfileId: "vflat-4mm-25deg",
      diameterMm: 4,
      flatTipMm: 0.4,
      angleDeg: 25
    },
    sampling: {
      recommendedPrimary: "unwrapped-rotary-drop-cutter",
      axisMapping: {
        lengthAxis: "X",
        depthAxis: "Z",
        rotaryAxis: "Y",
        rotaryWrapPerRevolutionMm: 100
      }
    },
    operations: [
      { id: "finishing", enabled: true, strategy: "unwrapped-rotary-drop-cutter" }
    ]
  };
  writeFileSync(jobPath, JSON.stringify(job, null, 2), "utf8");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");

  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const run = spawnSync(python, [resolve("adapters", "opencamlib", "opencamlib_runner.py"), jobPath, planPath, outputPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "33",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "7"
    },
    encoding: "utf8"
  });

  assert(run.status === 0, `runner failed: ${run.stderr || run.stdout}`);
  assert(existsSync(outputPath), "runner did not write neutral output");
  const neutral = JSON.parse(readFileSync(outputPath, "utf8"));
  assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
  assert(neutral.experimentalRotaryHeightfield === true, "neutral should mark rotary heightfield mode");
  assert(neutral.runner?.mode === "stl-rotary-heightfield-preview", "runner mode mismatch");
  assert(neutral.coordinate?.rotaryAxis === "Y", "rotary axis should remain Y");
  assert(neutral.runner?.heightfield?.rotaryEnvelope === true, "heightfield should mark rotary envelope");
  assert(neutral.runner?.heightfield?.cutterEnvelope === true, "rotary heightfield should apply cutter envelope");
  assert(neutral.runner?.heightfield?.cutterRadiusMm === 2, `4mm cutter should use 2mm envelope radius, got ${neutral.runner?.heightfield?.cutterRadiusMm}`);
  assert(neutral.runner?.heightfield?.rotaryCutterAngularToleranceDeg > 0, "rotary cutter angular tolerance should be reported");
  assert(neutral.runner?.heightfield?.cutterEnvelopeSampleCount > neutral.points?.length, "rotary cutter envelope should sample neighboring X/angle points");
  assert(neutral.runner?.heightfield?.missCount === 0, `closed rotary STL should have no misses, got ${neutral.runner?.heightfield?.missCount}`);
  assert(Array.isArray(neutral.points) && neutral.points.length === 231, `expected 231 rotary samples, got ${neutral.points?.length}`);

  const angles = new Set(neutral.points.map((point) => Number(point.a)));
  assert(angles.has(0) && angles.has(180) && angles.has(360), "rotary samples should cover 0/180/360 degrees");
  const depthValues = neutral.points.map((point) => Number(point.depth));
  const minDepth = Math.min(...depthValues);
  const maxDepth = Math.max(...depthValues);
  assert(maxDepth > minDepth + 0.2, `rotary relief should produce a meaningful depth range, got ${minDepth}..${maxDepth}`);
  assert(neutral.points.every((point) => point.rotarySample === true), "all points should be marked as rotary samples");
  assert(neutral.points.every((point) => point.cutterRadiusMm === 2), "all rotary points should echo 4mm cutter radius");
  assert(neutral.points.some((point) => point.envelopeSampleCount > 1), "rotary points should include multi-sample cutter envelope");
  assert(neutral.points.some((point) => point.cutterEnvelopeLiftMm > 0), "rotary cutter envelope should lift at least one valley sample");
  assert(neutral.cutterContactReport?.schema === "hediao3d.opencamlib-cutter-contact-report.v1", "neutral should embed cutter contact report");
  assert(neutral.cutterContactReport.quality?.previewScaffold === true, "heightfield contact report must stay preview scaffold");
  assert(neutral.cutterContactReport.quality?.productionCandidate === false, "heightfield contact report must not be production candidate");
  assert(neutral.cutterContactReport.inputIdentity?.sourceNeutralToolpathSha256, "contact report should bind neutral hash");
  assert(existsSync(neutral.cutterContactReportPath), "cutter contact report file should be written");
  assert(existsSync(neutral.runner.heightfield.cutterEnvelopeReport), "rotary cutter envelope report should be written");
  const envelopeReport = JSON.parse(readFileSync(neutral.runner.heightfield.cutterEnvelopeReport, "utf8"));
  assert(envelopeReport.mode === "stl-rotary-heightfield-preview", "envelope report should echo rotary heightfield mode");
  assert(envelopeReport.sampling?.rotaryEnvelope === true, "envelope report should mark rotary envelope");
  assert(envelopeReport.rotaryEnvelope?.enabled === true, "envelope report rotary section should be enabled");
  assert(envelopeReport.tool?.previewCutterRadiusMm === 2, "envelope report should bind 4mm cutter radius");
  assert(envelopeReport.tool?.angleDeg === 25, "envelope report should include 25 degree tool angle");
  assert(envelopeReport.tool?.flatTipMm === 0.4, "envelope report should include flat tip");
  assert(envelopeReport.rotaryEnvelope?.cutterEnvelopeLiftMaxMm > 0, "envelope report should expose cutter envelope lift");
  assert(envelopeReport.sampling?.quality?.schema === "hediao3d.opencamlib-heightfield-sampling-quality.v1", "envelope report should include sampling quality schema");
  assert(envelopeReport.sampling.quality.level === "coarse", `7x33 preview sampling should remain coarse, got ${envelopeReport.sampling.quality.level}`);
  assert(envelopeReport.sampling.quality.adaptiveSampling === false, "env override sampling should not be marked adaptive");
  assert(envelopeReport.sampling.quality.samplingSource === "env-override", `env override sampling source expected, got ${envelopeReport.sampling.quality.samplingSource}`);
  assert(envelopeReport.sampling.quality.blockers?.includes("sampling-step-larger-than-quarter-cutter-diameter"), "sampling quality should block overly large stepover");
  assert(envelopeReport.quality?.productionCandidate === false, "rotary preview envelope must not be production candidate");
  assert(envelopeReport.quality?.samplingReadyForUpgrade === false, "coarse preview sampling must not be marked ready for cutter-contact upgrade");
  assert(neutral.cutterContactReport.contactSampling?.samplingQuality?.level === "coarse", "contact report should echo coarse sampling quality");
  assert(neutral.cutterContactReport.quality?.samplingReadyForUpgrade === false, "contact report should keep coarse sampling below upgrade threshold");

  const adaptiveOutputPath = join(workDir, "neutral-toolpath-adaptive.json");
  const adaptiveJob = {
    ...job,
    jobId: "v3-rotary-heightfield-runner-adaptive-test",
    outputs: {
      neutralToolpath: adaptiveOutputPath
    }
  };
  const adaptiveJobPath = join(workDir, "job-adaptive.json");
  writeFileSync(adaptiveJobPath, JSON.stringify(adaptiveJob, null, 2), "utf8");
  const adaptiveRun = spawnSync(python, [resolve("adapters", "opencamlib", "opencamlib_runner.py"), adaptiveJobPath, planPath, adaptiveOutputPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_OUTPUT: "true"
    },
    encoding: "utf8"
  });

  assert(adaptiveRun.status === 0, `adaptive runner failed: ${adaptiveRun.stderr || adaptiveRun.stdout}`);
  const adaptiveNeutral = JSON.parse(readFileSync(adaptiveOutputPath, "utf8"));
  const adaptiveHeightfield = adaptiveNeutral.runner?.heightfield;
  assert(adaptiveHeightfield?.adaptiveSampling === true, "adaptive run should mark adaptive sampling");
  assert(/^adaptive/.test(adaptiveHeightfield?.samplingSource ?? ""), `adaptive sampling source expected, got ${adaptiveHeightfield?.samplingSource}`);
  assert(adaptiveHeightfield.cols > 8, `adaptive cols should exceed old default 8, got ${adaptiveHeightfield.cols}`);
  assert(adaptiveHeightfield.rows > 12, `adaptive rows should exceed old default 12, got ${adaptiveHeightfield.rows}`);
  assert(adaptiveNeutral.points.length > neutral.points.length, "adaptive run should create denser samples than explicit coarse grid");
  const adaptiveEnvelope = JSON.parse(readFileSync(adaptiveHeightfield.cutterEnvelopeReport, "utf8"));
  assert(adaptiveEnvelope.sampling?.quality?.level !== "coarse", `adaptive sampling should remove coarse blockers, got ${adaptiveEnvelope.sampling?.quality?.level}`);
  assert(adaptiveEnvelope.sampling?.quality?.adaptiveSampling === true, "adaptive sampling quality should expose adaptiveSampling");
  assert(/^adaptive/.test(adaptiveEnvelope.sampling?.quality?.samplingSource ?? ""), `adaptive sampling quality source expected, got ${adaptiveEnvelope.sampling?.quality?.samplingSource}`);
  assert(adaptiveEnvelope.sampling?.quality?.targetStepoverMm === 0.28, `adaptive target stepover should come from settings, got ${adaptiveEnvelope.sampling?.quality?.targetStepoverMm}`);
  assert(adaptiveEnvelope.sampling?.quality?.targetStepoverDeg === 5, `adaptive target angular stepover should come from settings, got ${adaptiveEnvelope.sampling?.quality?.targetStepoverDeg}`);
  assert(!adaptiveEnvelope.sampling?.quality?.blockers?.includes("sampling-step-larger-than-quarter-cutter-diameter"), "adaptive sampling should not exceed quarter-cutter blocker");

  console.log(JSON.stringify({
    ok: true,
    mode: neutral.runner.mode,
    points: neutral.points.length,
    adaptivePoints: adaptiveNeutral.points.length,
    missCount: neutral.runner.heightfield.missCount,
    angleCount: angles.size,
    cutterRadiusMm: neutral.runner.heightfield.cutterRadiusMm,
    cutterEnvelopeLiftMaxMm: neutral.runner.heightfield.cutterEnvelopeLiftMaxMm,
    depthRange: {
      min: minDepth,
      max: maxDepth
    }
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createRotaryReliefStl() {
  const xs = [0, 5, 10, 15, 20, 25, 30];
  const segments = 32;
  const vertices = [];
  for (let xi = 0; xi < xs.length; xi += 1) {
    const x = xs[xi];
    const xT = xi / (xs.length - 1);
    const ring = [];
    for (let ai = 0; ai < segments; ai += 1) {
      const angle = (Math.PI * 2 * ai) / segments;
      const relief = 0.75 * Math.sin(Math.PI * xT) * Math.max(0, Math.cos(angle));
      const radius = 5 + relief;
      ring.push([x, Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    vertices.push(ring);
  }

  const facets = [];
  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let ai = 0; ai < segments; ai += 1) {
      const next = (ai + 1) % segments;
      facets.push([vertices[xi][ai], vertices[xi + 1][ai], vertices[xi + 1][next]]);
      facets.push([vertices[xi][ai], vertices[xi + 1][next], vertices[xi][next]]);
    }
  }
  return `solid rotary_relief\n${facets.map(formatFacet).join("")}endsolid rotary_relief\n`;
}

function formatFacet([a, b, c]) {
  return `  facet normal 0 0 0
    outer loop
      vertex ${a[0].toFixed(6)} ${a[1].toFixed(6)} ${a[2].toFixed(6)}
      vertex ${b[0].toFixed(6)} ${b[1].toFixed(6)} ${b[2].toFixed(6)}
      vertex ${c[0].toFixed(6)} ${c[1].toFixed(6)} ${c[2].toFixed(6)}
    endloop
  endfacet
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
