#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-contact-spike-"));
const python = process.env.PYTHON ?? "python";
const spikePath = resolve("adapters", "opencamlib", "opencamlib_contact_spike.py");
const outPath = join(workDir, "opencamlib-real-contact-spike.json");
const neutralPath = join(workDir, "neutral-toolpath-spike.json");

try {
  const run = spawnSync(python, [spikePath, "--out", outPath, "--neutral-out", neutralPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert([0, 4].includes(run.status), `spike exited ${run.status}: ${run.stderr || run.stdout}`);
  assert(existsSync(outPath), "contact spike did not write report JSON");
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  assert(report.schema === "hediao3d.opencamlib-real-contact-spike.v1", "spike schema mismatch");
  assert(report.productionLocked === true, "contact spike must keep production locked");
  assert(/not production/i.test(report.productionBoundary), "contact spike must state production boundary");
  assert(report.probe?.runnerReadiness?.schema === "hediao3d.opencamlib-runner-readiness.v1", "spike should embed runner readiness");
  assert(report.probe?.recommendedBindings?.schema === "hediao3d.opencamlib-recommended-bindings.v1", "spike should embed recommended bindings");
  assert(Array.isArray(report.checks) && report.checks.some((check) => check.id === "real-drop-cutter-call" || check.id === "module-imported"), "spike should report module/drop-cutter checks");
  assert(Array.isArray(report.nextActions) && report.nextActions.length > 0, "spike should include next actions");
  const stdout = JSON.parse(run.stdout);
  assert(stdout.schema === report.schema, "stdout summary schema should match report");
  if (report.ok) {
    assert(run.status === 0, "ready spike should exit 0");
    assertNeutralSpike(neutralPath);
  } else {
    assert(run.status === 4, "blocked spike should exit 4");
    assert(["blocked", "api-mapping-required"].includes(report.level), `blocked spike level mismatch: ${report.level}`);
  }

  const fakeReady = runWithFakeOfficialOclBinding();

  console.log(JSON.stringify({
    ok: true,
    spikeOk: report.ok,
    level: report.level,
    selectedModule: report.selectedModule,
    checks: report.checks.length,
    fakeOcl: fakeReady
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function runWithFakeOfficialOclBinding() {
  const fakeRoot = join(workDir, "fake-pythonpath");
  const fakePackage = join(fakeRoot, "opencamlib");
  mkdirSync(fakePackage, { recursive: true });
  writeFileSync(join(fakePackage, "__init__.py"), "from . import ocl\n", "utf8");
  writeFileSync(join(fakePackage, "ocl.py"), createFakeOclModule(), "utf8");
  const fakeOut = join(workDir, "fake-opencamlib-real-contact-spike.json");
  const fakeNeutral = join(workDir, "fake-neutral-toolpath-spike.json");
  const env = {
    ...process.env,
    PYTHONPATH: `${fakeRoot}${process.env.PYTHONPATH ? `${process.platform === "win32" ? ";" : ":"}${process.env.PYTHONPATH}` : ""}`
  };
  const run = spawnSync(python, [spikePath, "--out", fakeOut, "--neutral-out", fakeNeutral], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(run.status === 0, `fake official ocl spike should exit 0: ${run.stderr || run.stdout}`);
  assert(existsSync(fakeOut), "fake official ocl spike did not write report JSON");
  const report = JSON.parse(readFileSync(fakeOut, "utf8"));
  assert(report.ok === true, "fake official ocl spike should be ok");
  assert(report.level === "ready", `fake official ocl spike level mismatch: ${report.level}`);
  assert(report.selectedModule === "opencamlib.ocl", `fake official ocl spike should select opencamlib.ocl, got ${report.selectedModule}`);
  assert(report.spikeMetrics?.algorithm === "opencamlib-path-drop-cutter-spike", "fake official ocl spike should exercise PathDropCutter path");
  assert(report.spikeMetrics?.pointCount >= 6, "fake official ocl spike should return cutter-location points");
  assertNeutralSpike(fakeNeutral);
  return {
    ok: report.ok,
    level: report.level,
    selectedModule: report.selectedModule,
    algorithm: report.spikeMetrics.algorithm
  };
}

function assertNeutralSpike(path) {
  assert(existsSync(path), "ready spike should write neutral output");
  const neutral = JSON.parse(readFileSync(path, "utf8"));
  assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral spike schema mismatch");
  assert(neutral.productionCandidate === false, "neutral spike must not be production candidate");
  assert(neutral.runner?.mode === "opencamlib-real-contact-spike", "neutral spike runner mode mismatch");
  assert(Array.isArray(neutral.points) && neutral.points.length > 0, "neutral spike should contain points");
}

function createFakeOclModule() {
  return String.raw`
class Point:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = float(x)
        self.y = float(y)
        self.z = float(z)

class Triangle:
    def __init__(self, a, b, c):
        self.a = a
        self.b = b
        self.c = c

class STLSurf:
    def __init__(self):
        self.triangles = []
    def addTriangle(self, triangle):
        self.triangles.append(triangle)

class CylCutter:
    def __init__(self, diameter=4.0, length=20.0):
        self.diameter = diameter
        self.length = length

class Line:
    def __init__(self, start, end):
        self.start = start
        self.end = end

class Path:
    def __init__(self):
        self.segments = []
    def append(self, segment):
        self.segments.append(segment)

class PathDropCutter:
    def __init__(self):
        self.surface = None
        self.cutter = None
        self.path = None
        self.z = 10.0
        self.points = []
    def setSTL(self, surface):
        self.surface = surface
    def setCutter(self, cutter):
        self.cutter = cutter
    def setPath(self, path):
        self.path = path
    def setZ(self, z):
        self.z = float(z)
    def run(self):
        self.points = []
        segments = getattr(self.path, "segments", [])
        for segment in segments:
            for index in range(3):
                t = index / 2.0
                x = segment.start.x + (segment.end.x - segment.start.x) * t
                y = segment.start.y + (segment.end.y - segment.start.y) * t
                z = self.z - 0.15 - 0.01 * len(self.points)
                self.points.append(Point(x, y, z))
    def getCLPoints(self):
        return self.points
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
