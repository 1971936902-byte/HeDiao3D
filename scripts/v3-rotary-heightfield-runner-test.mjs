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
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "9",
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
  assert(neutral.runner?.heightfield?.missCount === 0, `closed rotary STL should have no misses, got ${neutral.runner?.heightfield?.missCount}`);
  assert(Array.isArray(neutral.points) && neutral.points.length === 63, `expected 63 rotary samples, got ${neutral.points?.length}`);

  const angles = new Set(neutral.points.map((point) => Number(point.a)));
  assert(angles.has(0) && angles.has(180) && angles.has(360), "rotary samples should cover 0/180/360 degrees");
  const depthValues = neutral.points.map((point) => Number(point.depth));
  const minDepth = Math.min(...depthValues);
  const maxDepth = Math.max(...depthValues);
  assert(maxDepth > minDepth + 0.2, `rotary relief should produce a meaningful depth range, got ${minDepth}..${maxDepth}`);
  assert(neutral.points.every((point) => point.rotarySample === true), "all points should be marked as rotary samples");

  console.log(JSON.stringify({
    ok: true,
    mode: neutral.runner.mode,
    points: neutral.points.length,
    missCount: neutral.runner.heightfield.missCount,
    angleCount: angles.size,
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
