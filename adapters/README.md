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
    "preview": "C:/.../preview.json"
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

## Current Adapter State

- `freecad/freecad_cam_job.py`: scriptable FreeCAD Path Workbench adapter skeleton. It validates the protocol, detects FreeCAD/Path Python modules, writes `freecad-cam-plan.json`, and writes a reviewable `freecad-run-template.py`. Production G-code remains locked unless the deployment server sets `HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=true` and the Path operation recipe has been validated.
- `blendercam/blendercam_job.py`: BlenderCAM/FabexCNC artistic-surface adapter skeleton. It validates the protocol, detects Blender Python and possible CAM add-on modules, writes `blendercam-cam-plan.json`, and writes `blendercam-run-template.py`. Production G-code remains locked unless the deployment server sets `HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=true` and the operation recipe has been validated.
- `camotics/camotics_job.js`: CAMotics simulation adapter skeleton. It validates the protocol, detects `camotics-cli`/`camotics`, writes `camotics-simulation-plan.json`, and writes `camotics-project-template.json`. Material-removal execution remains locked unless the deployment server sets `HEDIAO3D_CAMOTICS_EXPERIMENTAL_RUN=true` and result extraction has been validated.
- `opencamlib/opencamlib_job.py`: OpenCAMLib geometry-kernel adapter skeleton. It validates the protocol, detects `opencamlib`/`ocl`, writes `opencamlib-kernel-plan.json`, and writes `opencamlib-run-template.py`. Cutter-contact output remains locked unless the deployment server sets `HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=true` and the kernel recipe has been validated.

The internal Mesh CAM fallback remains the verified V3 small-loop implementation until the external engines are installed and the adapter recipes are completed.

When an adapter returns `"status": "completed"` and writes a non-empty G-code file to `outputs.gcode` or `gcodePath`, the Orchestrator ingests that file as the job toolpath, parses G0/G1 motion points for preview/reporting, and then continues through the shared simulation summary, production gate and delivery manifest pipeline. If the adapter is missing, not ready, fails, or does not write G-code, the job falls back to the internal Mesh CAM baseline.

## Contract Test

Run the adapter protocol test before enabling external CAM execution:

```bash
npm run test:v3:adapters
```

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
- A completed adapter must declare a G-code path; the Orchestrator additionally checks that the file exists and is non-empty before accepting it.
