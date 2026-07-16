#!/usr/bin/env python3
"""FreeCAD CAM adapter placeholder for HeDiao3D V3.

Run target:
  FreeCADCmd adapters/freecad/freecad_cam_job.py job.json result.json

The script intentionally validates the adapter protocol and returns a clear
"not implemented" result until FreeCAD Path operation recipes are finalized on
the deployment server.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def recipe_summary(job: dict) -> dict:
    recipe = job.get("externalCamRecipe") or {}
    operations = recipe.get("operations") or []
    enabled_operations = [operation for operation in operations if operation.get("enabled")]
    return {
        "present": bool(recipe),
        "status": recipe.get("status"),
        "selectedEngine": (recipe.get("engine") or {}).get("selectedEngine"),
        "engineFamily": (recipe.get("engine") or {}).get("engineFamily"),
        "operationCount": len(operations),
        "enabledOperationCount": len(enabled_operations),
        "postprocessPolicy": (recipe.get("postprocess") or {}).get("policy"),
        "toolProfileId": (recipe.get("tool") or {}).get("toolProfileId"),
    }


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: freecad_cam_job.py <job.json> <result.json>", file=sys.stderr)
        return 2

    job_path = Path(sys.argv[-2])
    result_path = Path(sys.argv[-1])
    job = json.loads(job_path.read_text(encoding="utf-8"))

    missing = [key for key in ("jobId", "modelPath", "settings", "outputs") if key not in job]
    if missing:
        result = {
            "status": "failed",
            "protocolVersion": "hediao3d.adapter.v1",
            "engine": "freecad",
            "jobId": job.get("jobId"),
            "error": f"Missing adapter job keys: {', '.join(missing)}",
            "warnings": [],
            "metrics": {}
        }
    else:
        result = {
            "status": "adapter_not_ready",
            "protocolVersion": "hediao3d.adapter.v1",
            "engine": "freecad",
            "jobId": job.get("jobId"),
            "error": "FreeCAD Path Workbench adapter is scaffolded but not enabled for production toolpath output.",
            "warnings": [
                "Install FreeCAD on the server, then implement model import, stock setup, tool controller, Path operation and post-processing recipe."
            ],
            "metrics": {
                "modelPath": job["modelPath"],
                "camMode": job["settings"].get("camMode"),
                "recipe": recipe_summary(job)
            }
        }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
