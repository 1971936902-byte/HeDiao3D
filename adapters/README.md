# HeDiao3D V3 CAM Adapter Protocol

V3 Orchestrator calls external CAM/simulation engines through small adapter scripts. Each adapter receives one JSON job file and writes one JSON result file. This keeps FreeCAD, BlenderCAM and CAMotics isolated from the UI and from the internal Mesh CAM fallback.

## Job Input

```json
{
  "jobId": "uuid",
  "engine": "freecad",
  "modelPath": "C:/.../public/imported-models/example.glb",
  "workDir": "C:/.../public/orchestrator-jobs/job-id",
  "settings": {
    "lengthMm": 38,
    "diameterMm": 15,
    "camMode": "rotaryWrap",
    "rotaryOutputAxis": "Y",
    "rotaryWrapPerRevolutionMm": 100
  },
  "outputs": {
    "gcode": "C:/.../toolpath.nc",
    "report": "C:/.../adapter-report.json",
    "preview": "C:/.../preview.json",
    "neutralToolpath": "C:/.../neutral-toolpath.json"
  },
  "externalCamRecipe": {
    "schema": "hediao3d.external-cam-recipe.v1",
    "engine": {},
    "model": {},
    "stock": {},
    "tool": {},
    "operations": [],
    "postprocess": {},
    "simulation": {}
  }
}
```

## Result Output

```json
{
  "status": "completed",
  "protocolVersion": "hediao3d.adapter.v1",
  "engine": "freecad",
  "jobId": "uuid",
  "gcodePath": "C:/.../toolpath.nc",
  "reportPath": "C:/.../adapter-report.json",
  "warnings": [],
  "metrics": {
    "points": 12000,
    "estimatedMinutes": 45.2,
    "recipe": {
      "present": true,
      "operationCount": 3,
      "enabledOperationCount": 3,
      "postprocessPolicy": "External CAM returns neutral/unwrapped path..."
    }
  }
}
```

Adapters may return either direct G-code or a neutral toolpath. For rotary-wrap
nuclear carving, neutral toolpath output is preferred because HeDiao3D owns the
final Y/A rotary fixture postprocessor:

```json
{
  "status": "completed",
  "protocolVersion": "hediao3d.adapter.v1",
  "engine": "opencamlib",
  "jobId": "uuid",
  "neutralToolpathPath": "C:/.../neutral-toolpath.json",
  "metrics": {
    "neutralToolpath": {
      "schema": "hediao3d.neutral-toolpath.v1",
      "path": "C:/.../neutral-toolpath.json"
    }
  }
}
```

The neutral file uses this minimal schema:

```json
{
  "schema": "hediao3d.neutral-toolpath.v1",
  "engine": "opencamlib",
  "coordinate": {
    "lengthAxis": "X",
    "rotaryAxis": "Y",
    "depthAxis": "Z",
    "rotaryUnit": "degree"
  },
  "points": [
    { "x": -12.5, "a": 0, "z": -0.8, "depth": 0.8 },
    { "x": -12.0, "a": 0, "z": -0.9, "depth": 0.9 }
  ]
}
```

For 3-axis relief, points may use `{ "x": 0, "y": 0, "z": -0.5 }`. For
rotary-wrap, `{ "x", "a", "z" }` is preferred; if an adapter emits linearized
rotary `{ "x", "y", "z" }`, Orchestrator converts `y` to degrees with
`rotaryWrapPerRevolutionMm` before final postprocessing.

## Current Adapter State

- `freecad/freecad_cam_job.py`: scriptable FreeCAD Path Workbench adapter skeleton. It validates the protocol, detects FreeCAD/Path Python modules, writes `freecad-cam-plan.json`, and writes a reviewable `freecad-run-template.py`. Production G-code remains locked unless the deployment server sets `HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=true` and the Path operation recipe has been validated.
- `blendercam/blendercam_job.py`: BlenderCAM/FabexCNC artistic-surface adapter skeleton. It validates the protocol, detects Blender Python and possible CAM add-on modules, writes `blendercam-cam-plan.json`, and writes `blendercam-run-template.py`. Production G-code remains locked unless the deployment server sets `HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=true` and the operation recipe has been validated.
- `camotics/camotics_job.js`: CAMotics simulation adapter. It validates the protocol, detects `camotics-cli`/`camotics`, writes `camotics-simulation-plan.json`, and writes `camotics-project-template.json`. It can also write `camotics-result.json` back to Orchestrator. The gated `HEDIAO3D_CAMOTICS_SYNTHETIC_RESULT=true` mode only validates the Orchestrator simulation handoff; real material-removal execution remains locked unless the deployment server sets `HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true` and CAMotics result extraction has been validated.
- `opencamlib/opencamlib_job.py`: OpenCAMLib geometry-kernel adapter skeleton. It validates the protocol, detects `opencamlib`/`ocl`, writes `opencamlib-kernel-plan.json`, and writes `opencamlib-run-template.py`. It supports importing real non-synthetic `hediao3d.neutral-toolpath.v1` via `HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON=/path/to/neutral-toolpath.json`, and also supports a gated synthetic handoff for contract tests via `HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=true` plus `HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT=true`; synthetic output validates Orchestrator ingestion only and is not real CAM output.

The internal Mesh CAM fallback remains the verified V3 small-loop implementation until the external engines are installed and the adapter recipes are completed.

When an adapter returns `"status": "completed"` and writes a non-empty G-code file to `outputs.gcode`/`gcodePath`, the Orchestrator ingests that file as the job toolpath, parses G0/G1 motion points for preview/reporting, and then continues through the shared simulation summary, production gate and delivery manifest pipeline. When it writes `neutralToolpathPath` instead, Orchestrator converts the neutral points through the HeDiao3D postprocessor to produce the final machine NC. If the adapter is missing, not ready, fails, or does not write G-code/neutral toolpath, the job falls back to the internal Mesh CAM baseline.

CAMotics is called as an independent simulation adapter after `toolpath.nc`,
`air-run.nc` and `camotics-preview.nc` are written. It writes:

```json
{
  "status": "completed",
  "protocolVersion": "hediao3d.adapter.v1",
  "engine": "camotics",
  "simulationResultPath": "C:/.../camotics-result.json",
  "outputs": {
    "simulationResult": "C:/.../camotics-result.json"
  }
}
```

The result artifact uses `hediao3d.camotics-result.v1`. In synthetic mode it
only records preview-G-code envelope metrics and must not unlock production NC.

## Contract Test

Run the adapter protocol test before enabling external CAM execution:

```bash
npm run test:v3:adapters
```

Run the deployment validation suite on a CAM server when you want to keep each
adapter's generated plan artifacts and inspect native-tool readiness:

```bash
npm run test:v3:external-adapters
V3_ADAPTER_USE_NATIVE_COMMANDS=true npm run test:v3:external-adapters
```

The validation suite writes `v3-external-adapter-validation.json` and
`v3-external-adapter-validation.md` under
`public/orchestrator-adapter-validation/<timestamp>/`.

The test runs each adapter script with a synthetic job and verifies:

- `protocolVersion` is `hediao3d.adapter.v1`.
- `engine` matches the selected adapter.
- `jobId`, `warnings[]` and `metrics{}` are present.
- `externalCamRecipe` is accepted and summarized into `metrics.recipe`.
- The FreeCAD adapter writes a CAM plan and run template, even when it safely returns `adapter_not_ready`.
- The BlenderCAM adapter writes an artistic-surface CAM plan and run template, even when it safely returns `adapter_not_ready`.
- The CAMotics adapter writes a simulation plan and project template, even when it safely returns `adapter_not_ready`.
- The OpenCAMLib adapter writes a cutter-contact kernel plan and run template, even when it safely returns `adapter_not_ready`.
- Non-completed adapters return a clear `error`.
- A completed adapter must declare either a non-empty G-code path or a non-empty neutral toolpath path.
