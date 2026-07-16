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
    "estimatedMinutes": 45.2
  }
}
```

## Current Adapter State

- `freecad/freecad_cam_job.py`: scriptable FreeCAD Path Workbench placeholder. It validates the protocol and reports that production toolpath generation still needs a server with FreeCAD installed and a finalized Path operation recipe.
- `blendercam/blendercam_job.py`: BlenderCAM/FabexCNC placeholder for artistic relief/surface milling.
- `camotics/camotics_job.js`: CAMotics placeholder for NC material-removal simulation.
- `opencamlib/opencamlib_job.py`: OpenCAMLib placeholder for drop-cutter, waterline and cutter-contact geometry calculations. OpenCAMLib is a geometry kernel rather than a full CAM application, so final NC output should still pass through HeDiao3D postprocessing.

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
- Non-completed adapters return a clear `error`.
- A completed adapter must declare a G-code path; the Orchestrator additionally checks that the file exists and is non-empty before accepting it.
