#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(rootDir, "public", "v3-fixtures", "buddha-baseline.json");

function main() {
  const baseline = readJson(baselinePath);
  assert(baseline.schema === "hediao3d.v3-buddha-fixture-baseline.v1", "baseline schema mismatch");
  assert(baseline.id === "buddha-material01-multiview-meshy-2026-07-16", "baseline id mismatch");

  const glbPath = localPublicUrlToPath(baseline.model.glbUrl);
  const stlPath = localPublicUrlToPath(baseline.model.stlUrl);
  assertFileIdentity(glbPath, baseline.model.glbBytes, baseline.model.glbSha256, "GLB");
  assertFileIdentity(stlPath, baseline.model.stlBytes, baseline.model.stlSha256, "STL");

  const stlStats = inspectBinaryStl(stlPath);
  assert(stlStats.triangles === baseline.model.stlTriangles, `STL triangle count mismatch: ${stlStats.triangles}`);
  assert(stlStats.longAxis === baseline.model.stlBoundsRaw.longAxis, `STL long axis mismatch: ${stlStats.longAxis}`);
  assertVectorClose(stlStats.min, baseline.model.stlBoundsRaw.min, 0.001, "STL min bounds");
  assertVectorClose(stlStats.max, baseline.model.stlBoundsRaw.max, 0.001, "STL max bounds");
  assertVectorClose(stlStats.span, baseline.model.stlBoundsRaw.span, 0.001, "STL span bounds");

  assert(baseline.model.meshQualityFromReport.status === "ready", "fixture mesh quality should be ready");
  assert(baseline.model.meshQualityFromReport.boundaryEdges === 0, "fixture should have zero boundary edges");
  assert(baseline.model.meshQualityFromReport.nonManifoldEdges === 0, "fixture should have zero non-manifold edges");
  assert(baseline.reportedCamEnvelope.missedSamples < 700, "fixture CAM envelope missed samples regressed above 700");
  assert(baseline.reportedCamEnvelope.criticalRiskCells === 0, "fixture should not have critical heatmap cells");

  assert(baseline.targetMachine.controllerClass === "3axis-controller-with-rotary-fixture", "target controller mismatch");
  assert(baseline.targetMachine.lengthAxis === "X", "length axis must be X");
  assert(baseline.targetMachine.rotaryOutputAxis === "Y", "rotary output axis must be Y");
  assert(baseline.targetMachine.depthAxis === "Z", "depth axis must be Z");
  assert(baseline.targetMachine.toolProfileId === "vflat-4mm-25deg", "tool profile mismatch");
  assert(baseline.targetMachine.toolDiameterMm === 4, "tool diameter mismatch");
  assert(baseline.targetMachine.toolAngleDeg === 25, "tool angle mismatch");
  assert(baseline.productionBoundary.allowProductionNc === false, "fixture baseline must not unlock production");

  for (const image of baseline.sourceImages.files) {
    const imagePath = localPublicUrlToPath(`${baseline.sourceImages.directory}/${image.filename}`);
    assertFileIdentity(imagePath, image.bytes, image.sha256, image.filename);
  }

  console.log(JSON.stringify({
    ok: true,
    fixtureId: baseline.id,
    glbUrl: baseline.model.glbUrl,
    stlUrl: baseline.model.stlUrl,
    triangles: stlStats.triangles,
    longAxis: stlStats.longAxis,
    stlSpan: stlStats.span,
    sourceImages: baseline.sourceImages.files.length,
    targetMachine: `${baseline.targetMachine.controllerClass}/${baseline.targetMachine.rotaryOutputAxis}`,
    tool: baseline.targetMachine.toolProfileId,
    productionAllowed: baseline.productionBoundary.allowProductionNc
  }, null, 2));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function localPublicUrlToPath(url) {
  assert(typeof url === "string" && url.startsWith("/"), `invalid public URL: ${url}`);
  assert(!url.includes(".."), `unsafe public URL: ${url}`);
  return join(rootDir, "public", url.replace(/^\//, ""));
}

function assertFileIdentity(path, expectedBytes, expectedSha256, label) {
  assert(existsSync(path), `${label} missing: ${path}`);
  const stat = statSync(path);
  assert(stat.size === expectedBytes, `${label} byte size mismatch: ${stat.size} !== ${expectedBytes}`);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  assert(hash === expectedSha256, `${label} sha256 mismatch: ${hash} !== ${expectedSha256}`);
}

function inspectBinaryStl(path) {
  const buffer = readFileSync(path);
  assert(buffer.length >= 84, "STL too small");
  const triangles = buffer.readUInt32LE(80);
  const expectedBytes = 84 + triangles * 50;
  assert(buffer.length >= expectedBytes, `STL truncated: ${buffer.length} < ${expectedBytes}`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, offset = 84; i < triangles; i += 1, offset += 50) {
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const base = offset + 12 + vertex * 12;
      const point = [
        buffer.readFloatLE(base),
        buffer.readFloatLE(base + 4),
        buffer.readFloatLE(base + 8)
      ];
      for (let axis = 0; axis < 3; axis += 1) {
        if (point[axis] < min[axis]) min[axis] = point[axis];
        if (point[axis] > max[axis]) max[axis] = point[axis];
      }
    }
  }
  const span = max.map((value, index) => value - min[index]);
  const axisNames = ["X", "Y", "Z"];
  const longAxisIndex = span.reduce((best, value, index) => value > span[best] ? index : best, 0);
  return {
    triangles,
    min,
    max,
    span,
    longAxis: axisNames[longAxisIndex]
  };
}

function assertVectorClose(actual, expected, tolerance, label) {
  assert(Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length, `${label} length mismatch`);
  for (let index = 0; index < expected.length; index += 1) {
    const delta = Math.abs(actual[index] - expected[index]);
    assert(delta <= tolerance, `${label}[${index}] mismatch: ${actual[index]} !== ${expected[index]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
