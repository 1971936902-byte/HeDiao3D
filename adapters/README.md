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
  "engine": "freecad",
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
