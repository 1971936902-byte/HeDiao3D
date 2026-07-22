#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const workDir = mkdtempSync(join(tmpdir(), "hediao3d-opencamlib-runner-contract-"));
const runnerPath = resolve("adapters", "opencamlib", "opencamlib_runner.py");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

try {
  const jobPath = join(workDir, "job.json");
  const planPath = join(workDir, "opencamlib-kernel-plan.json");
  const outputPath = join(workDir, "neutral-toolpath.json");
  const job = createJob();
  const plan = createPlan(job);
  writeFileSync(job.modelPath, createAsciiStl());
  writeFileSync(jobPath, JSON.stringify(job, null, 2));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const fixtureRun = spawnSync(python, [runnerPath, jobPath, planPath, outputPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT: "true"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(fixtureRun.status === 0, `fixture runner exited ${fixtureRun.status}: ${fixtureRun.stderr || fixtureRun.stdout}`);
  assert(existsSync(outputPath), "fixture runner did not write neutral output");
  const neutral = JSON.parse(readFileSync(outputPath, "utf8"));
  assert(neutral.schema === "hediao3d.neutral-toolpath.v1", "neutral schema mismatch");
  assert(neutral.synthetic === false, "runner fixture must be non-synthetic for adapter import classification");
  assert(neutral.fixture === true, "runner fixture marker missing");
  assert(neutral.generatedByExternalCommand === true, "external command marker missing");
  assert(Array.isArray(neutral.points) && neutral.points.length === 48, "runner fixture point count mismatch");
  assert(neutral.coordinate?.rotaryAxis === "Y", "runner fixture rotary axis mismatch");
  assert(neutral.runner?.geometry?.triangleCount === 2, "runner geometry triangle count mismatch");
  assert(neutral.runner?.geometry?.dimensions?.x === 10, "runner geometry X dimension mismatch");
  assert(neutral.runner?.geometry?.dimensions?.y === 5, "runner geometry Y dimension mismatch");

  const heightfieldOutput = join(workDir, "neutral-heightfield.json");
  const heightfieldRun = spawnSync(python, [runnerPath, jobPath, planPath, heightfieldOutput], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS: "3",
      HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS: "4"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(heightfieldRun.status === 0, `heightfield runner exited ${heightfieldRun.status}: ${heightfieldRun.stderr || heightfieldRun.stdout}`);
  const heightfield = JSON.parse(readFileSync(heightfieldOutput, "utf8"));
  assert(heightfield.schema === "hediao3d.neutral-toolpath.v1", "heightfield neutral schema mismatch");
  assert(heightfield.synthetic === false, "heightfield neutral must be non-synthetic");
  assert(heightfield.fixture === false, "heightfield neutral must not be fixture output");
  assert(heightfield.experimentalHeightfield === true, "heightfield marker missing");
  assert(heightfield.runner?.heightfield?.pointCount === 12, "heightfield point count mismatch");
  assert(heightfield.runner?.heightfield?.missCount === 0, "heightfield should sample the whole rectangle");
  assert(heightfield.runner?.heightfield?.cutterEnvelope === true, "heightfield should enable cutter envelope sampling");
  assert(heightfield.runner?.heightfield?.cutterRadiusMm > 0, "heightfield cutter radius should be derived from the tool profile");
  assert(heightfield.runner?.heightfield?.cutterSampleCount >= heightfield.points.length, "heightfield should report cutter contact sample count");
  assert(heightfield.points.every((point) => point.cutterRadiusMm === heightfield.runner.heightfield.cutterRadiusMm), "heightfield points should echo cutter radius");
  assert(heightfield.points.some((point) => point.contactSamples > 1), "heightfield should include multi-contact cutter envelope samples");
  assert(heightfield.points.some((point) => point.source === "stl-heightfield-preview"), "heightfield point source missing");
  assert(new Set(heightfield.points.map((point) => point.depth)).size > 1, "heightfield should contain varying depths from STL Z interpolation");
  assert(heightfield.runner?.heightfield?.cutterEnvelopeReport, "heightfield should reference cutter envelope report");
  assert(existsSync(heightfield.runner.heightfield.cutterEnvelopeReport), "cutter envelope report should be written beside neutral output");
  const envelopeReport = JSON.parse(readFileSync(heightfield.runner.heightfield.cutterEnvelopeReport, "utf8"));
  assert(envelopeReport.schema === "hediao3d.opencamlib-cutter-envelope-report.v1", "cutter envelope report schema mismatch");
  assert(envelopeReport.sampling?.pointCount === heightfield.points.length, "cutter envelope report point count mismatch");
  assert(envelopeReport.sampling?.hitRate === 1, "cutter envelope report hit rate mismatch");
  assert(envelopeReport.tool?.previewCutterRadiusMm === heightfield.runner.heightfield.cutterRadiusMm, "cutter envelope report radius mismatch");
  assert(envelopeReport.inputIdentity?.neutralToolpathSha256 === sha256File(heightfieldOutput), "cutter envelope report should bind neutral output hash");
  assert(envelopeReport.inputIdentity?.planSha256 === sha256File(planPath), "cutter envelope report should bind kernel plan hash");
  assert(envelopeReport.inputIdentity?.modelSha256 === sha256File(job.modelPath), "cutter envelope report should bind model hash");
  assert(envelopeReport.quality?.productionCandidate === false, "heightfield envelope report must not be production candidate");
  assert(/preview/i.test(envelopeReport.quality?.level ?? ""), "cutter envelope report should remain preview-scaffold");

  const fakeOclRoot = join(workDir, "fake-pythonpath");
  installFakeOfficialOcl(fakeOclRoot);
  const pathDropOutput = join(workDir, "neutral-path-dropcutter.json");
  const pathDropRun = spawnSync(python, [runnerPath, jobPath, planPath, pathDropOutput], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: `${fakeOclRoot}${process.env.PYTHONPATH ? `${process.platform === "win32" ? ";" : ":"}${process.env.PYTHONPATH}` : ""}`,
      HEDIAO3D_OPENCAMLIB_RUNNER_PATH_DROPCUTTER_OUTPUT: "true",
      HEDIAO3D_OPENCAMLIB_PATH_DROPCUTTER_ROWS: "3"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(pathDropRun.status === 0, `fake PathDropCutter runner exited ${pathDropRun.status}: ${pathDropRun.stderr || pathDropRun.stdout}`);
  const pathDrop = JSON.parse(readFileSync(pathDropOutput, "utf8"));
  assert(pathDrop.schema === "hediao3d.neutral-toolpath.v1", "PathDropCutter neutral schema mismatch");
  assert(pathDrop.synthetic === false, "PathDropCutter neutral must be non-synthetic");
  assert(pathDrop.fixture === false, "PathDropCutter neutral must not be fixture output");
  assert(pathDrop.experimentalOpenCamLibPathDropCutter === true, "PathDropCutter experimental marker missing");
  assert(pathDrop.productionCandidate === false, "PathDropCutter runner output must not be production candidate yet");
  assert(pathDrop.runner?.mode === "opencamlib-path-drop-cutter-experimental", "PathDropCutter runner mode mismatch");
  assert(pathDrop.runner?.opencamlibModule === "opencamlib.ocl", "PathDropCutter runner should select official opencamlib.ocl binding");
  assert(pathDrop.runner?.pathDropCutter?.algorithm === "opencamlib-path-drop-cutter", "PathDropCutter algorithm summary mismatch");
  assert(pathDrop.runner?.pathDropCutter?.pathRows === 3, "PathDropCutter row count should honor env override");
  assert(pathDrop.runner?.pathDropCutter?.pathGrid?.schema === "hediao3d.opencamlib-path-dropcutter-grid.v1", "PathDropCutter should expose adaptive grid schema");
  assert(pathDrop.runner?.pathDropCutter?.pathGrid?.samplingSource === "env-override", "PathDropCutter env row override should be recorded");
  assert(pathDrop.runner?.pathDropCutter?.pathGrid?.targetStepoverMm > 0, "PathDropCutter should expose target stepover");
  assert(Array.isArray(pathDrop.points) && pathDrop.points.length >= 6, "PathDropCutter runner should emit neutral points");
  assert(pathDrop.points.every((point) => point.source === "opencamlib-path-drop-cutter-experimental"), "PathDropCutter point source mismatch");
  assert(existsSync(pathDrop.cutterContactReportPath), "PathDropCutter contact report should be written");
  const pathDropContact = JSON.parse(readFileSync(pathDrop.cutterContactReportPath, "utf8"));
  assert(pathDropContact.schema === "hediao3d.opencamlib-cutter-contact-report.v1", "PathDropCutter contact report schema mismatch");
  assert(pathDropContact.contactSampling?.algorithm === "opencamlib-path-drop-cutter", "PathDropCutter contact algorithm mismatch");
  assert(pathDropContact.contactSampling?.contactPointCount === pathDrop.points.length, "PathDropCutter contact point count should match neutral points");
  assert(pathDropContact.contactSampling?.samplingSource === "env-override", "PathDropCutter contact report should expose sampling source");
  assert(pathDropContact.contactSampling?.pathCoverage?.xCoverageRatio === 1, "PathDropCutter contact report should expose full X path coverage");
  assert(pathDropContact.contactSampling?.pathCoverage?.crossCoverageRatio === 1, "PathDropCutter contact report should expose full cross path coverage");
  assert(pathDropContact.contactSampling?.pathCoverage?.xCoverageDomain === "protected-machinable-span", "PathDropCutter contact report should measure X coverage against protected machinable span");
  assert(Number.isFinite(pathDropContact.contactSampling?.stepToCutterRatio), "PathDropCutter contact report should expose step-to-cutter ratio");
  assert(pathDropContact.residualMaterial?.evidenceClass === "engineering-estimate", "PathDropCutter contact report should expose conservative residual estimate");
  assert(pathDropContact.residualMaterial?.validationBasis === "engineering-estimate-only", "PathDropCutter residual evidence should be explicitly marked as estimate-only");
  assert(pathDropContact.residualMaterial?.productionUse === "blocked-until-measured-or-swept-volume-validated", "PathDropCutter residual estimate should remain blocked for production use");
  assert(Number.isFinite(pathDropContact.residualMaterial?.maxGougeMm), "PathDropCutter contact report should expose max gouge estimate");
  assert(Number.isFinite(pathDropContact.residualMaterial?.maxUndercutMm), "PathDropCutter contact report should expose max undercut estimate");
  assert(pathDropContact.protectedZones?.enabled === true, "PathDropCutter contact report should declare protected end zones");
  assert(pathDropContact.protectedZones?.leftHoldMm === 2, "PathDropCutter protected zone should echo left hold");
  assert(pathDropContact.protectedZones?.rightHoldMm === 2, "PathDropCutter protected zone should echo right hold");
  assert(pathDropContact.protectedZones?.endTransitionMm === 1.2, "PathDropCutter protected zone should echo end transition");
  assert(pathDropContact.protectedZones?.violationCount === 0, "PathDropCutter sampling must stay outside protected end zones");
  assert(Math.min(...pathDrop.points.map((point) => point.x)) >= pathDropContact.protectedZones.safeMinX - 0.001, "PathDropCutter neutral X min should stay inside safe zone");
  assert(Math.max(...pathDrop.points.map((point) => point.x)) <= pathDropContact.protectedZones.safeMaxX + 0.001, "PathDropCutter neutral X max should stay inside safe zone");
  assert(pathDropContact.candidateMachineFit?.schema === "hediao3d.opencamlib-candidate-machine-fit-preflight.v1", "PathDropCutter contact report should embed target machine-fit preflight");
  assert(pathDropContact.candidateMachineFit?.targetMachine?.controllerClass === "3axis-controller-with-rotary-fixture", "PathDropCutter machine-fit should target the user's rotary fixture class");
  assert(pathDropContact.candidateMachineFit?.targetMachine?.rotaryOutputAxis === "Y", "PathDropCutter machine-fit should preserve Y rotary fixture output");
  assert(pathDropContact.candidateMachineFit?.checks?.rotaryCoordinatePresent === true, "PathDropCutter machine-fit should confirm rotary coordinates");
  assert(pathDropContact.candidateMachineFit?.checks?.protectedZoneClean === true, "PathDropCutter machine-fit should confirm protected zones");
  assert(pathDropContact.candidateMachineFit?.riskCounts?.holdZonePointCount === 0, "PathDropCutter machine-fit should expose protected-zone risk counts");
  assert(pathDropContact.materialRemovalReadiness?.schema === "hediao3d.opencamlib-material-removal-readiness.v1", "PathDropCutter contact report should expose material-removal readiness");
  assert(pathDropContact.materialRemovalReadiness?.readyForMaterialRemovalSimulation === true, "PathDropCutter output should be eligible for CAMotics/equivalent engineering simulation");
  assert(pathDropContact.materialRemovalReadiness?.simulationQuality?.schema === "hediao3d.opencamlib-material-removal-simulation-quality.v1", "PathDropCutter material-removal readiness should expose simulation quality");
  assert(pathDropContact.materialRemovalReadiness?.simulationQuality?.engineeringSimulationAllowed === true, "PathDropCutter simulation quality should allow engineering simulation");
  assert(pathDropContact.materialRemovalReadiness?.simulationQuality?.productionEvidenceAllowed === false, "PathDropCutter simulation quality must not allow production evidence by itself");
  assert(pathDropContact.materialRemovalReadiness?.simulationQuality?.risks?.includes("residual-material-estimate-only"), "PathDropCutter simulation quality should flag residual estimate risk");
  assert(Number.isFinite(pathDropContact.materialRemovalReadiness?.simulationQuality?.stepToCutterRatio), "PathDropCutter simulation quality should expose step ratio");
  assert(pathDropContact.materialRemovalReadiness?.productionResidualEvidenceReady === false, "PathDropCutter residual evidence must remain unready for production");
  assert(pathDropContact.materialRemovalReadiness?.missingForProduction?.some((item) => /residual/i.test(item)), "PathDropCutter material-removal readiness should name missing residual evidence");
  assert(pathDropContact.tolerances?.maxGougeMm === 0.03, "PathDropCutter contact report should expose gouge tolerance");
  assert(pathDropContact.quality?.productionCandidate === false, "PathDropCutter contact report must not be production candidate yet");
  assert(pathDropContact.quality?.level === "experimental-real-api", "PathDropCutter contact report level mismatch");
  assert(pathDropContact.quality?.productionCandidateBlockers?.includes("experimental-real-api-boundary"), "PathDropCutter contact report should explain experimental boundary");

  const noFixtureOutput = join(workDir, "neutral-no-fixture.json");
  const readinessPath = join(workDir, "opencamlib-runner-readiness.json");
  const spikePrecheckPath = join(workDir, "opencamlib-real-contact-spike.json");
  const noFixtureRun = spawnSync(python, [runnerPath, jobPath, planPath, noFixtureOutput], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT: "false"
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert(noFixtureRun.status !== 0, "runner should fail closed without fixture mode or validated real OpenCAMLib implementation");
  assert(existsSync(readinessPath), "fail-closed runner should write opencamlib-runner-readiness.json");
  assert(existsSync(spikePrecheckPath), "fail-closed runner should write contact spike precheck report");
  const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
  assert(readiness.schema === "hediao3d.opencamlib-runner-readiness-report.v1", "runner readiness schema mismatch");
  assert(readiness.canEmitProductionCandidate === false, "runner readiness must not unlock production candidate output");
  assert(readiness.checks?.some((check) => check.id === "real-contact-spike"), "runner readiness should include contact spike check");
  assert(readiness.geometry?.triangleCount === 2, "runner readiness should preserve parsed model geometry");
  assert(readiness.target?.machineProfileId === "desktop-3axis-rotary-y", "runner readiness should preserve target machine profile");
  assert(Array.isArray(readiness.blockers), "runner readiness should expose blockers array");
  if (readiness.level === "blocked") {
    assert(readiness.blockers.length > 0, "blocked runner readiness should explain fail-closed blockers");
  } else {
    assert(readiness.level === "ready-for-real-contact-runner", `unexpected non-blocked readiness level: ${readiness.level}`);
    assert(readiness.checks?.every((check) => check.status === "pass"), "ready runner readiness should only contain passing preflight checks");
    assert(/Production remains locked/i.test(readiness.productionBoundary ?? ""), "ready runner readiness should still state production lock boundary");
  }

  console.log(JSON.stringify({
    ok: true,
    runner: runnerPath,
    fixturePoints: neutral.points.length,
    heightfieldPoints: heightfield.points.length,
    pathDropCutterPoints: pathDrop.points.length,
    fixtureMode: neutral.runner?.mode,
    failClosedExit: noFixtureRun.status,
    readinessLevel: readiness.level
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function createJob() {
  return {
    jobId: "opencamlib-runner-contract-test",
    engine: "opencamlib",
    modelPath: join(workDir, "sample.stl"),
    workDir,
    settings: {
      camMode: "rotaryWrap",
      lengthMm: 38,
      diameterMm: 15,
      depthMm: 1.25,
      safeZ: 22,
      feedRate: 180,
      spindleRpm: 12000,
      rotaryOutputAxis: "Y",
      rotaryWrapPerRevolutionMm: 100,
      leftHoldMm: 2,
      rightHoldMm: 2,
      endTransitionMm: 1.2,
      toolProfileId: "vflat-4mm-25deg",
      toolDiameter: 4,
      stepoverMm: 0.28,
      stepoverDeg: 5,
      maxCutDepth: 0.45,
      stockAllowance: 0.08,
      postProcessor: "wrapY"
    },
    outputs: {
      neutralToolpath: join(workDir, "neutral-toolpath.json")
    }
  };
}

function createPlan(job) {
  return {
    schema: "hediao3d.opencamlib-kernel-plan.v1",
    jobId: job.jobId,
    engine: "opencamlib",
    model: {
      path: job.modelPath,
      format: "stl",
      exists: true
    },
    stock: {
      lengthMm: 38,
      diameterMm: 15
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
}

function createAsciiStl() {
  return `solid sample
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 1
      vertex 0 5 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 10 0 1
      vertex 10 5 1
      vertex 0 5 0
    endloop
  endfacet
endsolid sample
`;
}

function installFakeOfficialOcl(root) {
  const packageDir = join(root, "opencamlib");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "__init__.py"), "from . import ocl\n", "utf8");
  writeFileSync(join(packageDir, "ocl.py"), String.raw`
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
        self.z = 22.0
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
        for segment in getattr(self.path, "segments", []):
            for index in range(3):
                t = index / 2.0
                x = segment.start.x + (segment.end.x - segment.start.x) * t
                y = segment.start.y + (segment.end.y - segment.start.y) * t
                z = self.z - 0.25 - 0.02 * len(self.points)
                self.points.append(Point(x, y, z))
    def getCLPoints(self):
        return self.points
`, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
