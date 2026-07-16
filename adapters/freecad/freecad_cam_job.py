#!/usr/bin/env python3
"""FreeCAD CAM adapter for HeDiao3D V3.

Run target:
  FreeCADCmd adapters/freecad/freecad_cam_job.py job.json result.json

The adapter is intentionally conservative. It always validates the Orchestrator
job and writes an auditable FreeCAD CAM plan. It only attempts experimental
FreeCAD output when both conditions are true:

  1. It is running inside a Python environment that exposes FreeCAD modules.
  2. HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=true is set.

Without those conditions it returns adapter_not_ready, so HeDiao3D falls back to
the verified internal rotary-wrap baseline instead of pretending to have a
production CAM result.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


PROTOCOL_VERSION = "hediao3d.adapter.v1"
ENGINE = "freecad"
SUPPORTED_MESH_FORMATS = {".stl", ".obj", ".step", ".stp", ".iges", ".igs"}


def recipe_summary(job: Dict[str, Any]) -> Dict[str, Any]:
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


def detect_freecad_modules() -> Dict[str, Any]:
    modules = {}
    for name in ("FreeCAD", "Mesh", "Part", "Path", "PathScripts.PathJob", "PathScripts.PathPostProcessor"):
        spec = safe_find_spec(name)
        modules[name] = {
            "available": spec is not None,
            "origin": spec.origin if spec and spec.origin else None,
        }
    return {
        "freecadPythonAvailable": modules["FreeCAD"]["available"],
        "pathWorkbenchAvailable": modules["Path"]["available"] or modules["PathScripts.PathJob"]["available"],
        "modules": modules,
    }


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


def build_freecad_plan(job: Dict[str, Any], detection: Dict[str, Any]) -> Dict[str, Any]:
    settings = job.get("settings") or {}
    recipe = job.get("externalCamRecipe") or {}
    model_path = Path(str(job.get("modelPath") or ""))
    suffix = model_path.suffix.lower()
    operations = recipe.get("operations") or []
    enabled_operations = [operation for operation in operations if operation.get("enabled")]
    stock = recipe.get("stock") or {}
    tool = recipe.get("tool") or {}
    postprocess = recipe.get("postprocess") or {}

    return {
        "schema": "hediao3d.freecad-cam-plan.v1",
        "jobId": job.get("jobId"),
        "engine": ENGINE,
        "model": {
            "path": str(model_path),
            "format": suffix.lstrip(".") or None,
            "exists": model_path.exists(),
            "directlySupportedByAdapter": suffix in SUPPORTED_MESH_FORMATS,
            "requiresPreConversion": suffix not in SUPPORTED_MESH_FORMATS,
            "conversionHint": "Convert GLB/GLTF to STL or OBJ before FreeCAD Path, or route the job through BlenderCAM first."
            if suffix in {".glb", ".gltf"} else None,
        },
        "stock": {
            "lengthMm": stock.get("lengthMm") or settings.get("lengthMm"),
            "diameterMm": stock.get("diameterMm") or settings.get("diameterMm"),
            "leftHoldMm": stock.get("leftHoldMm") or settings.get("leftHoldMm"),
            "rightHoldMm": stock.get("rightHoldMm") or settings.get("rightHoldMm"),
        },
        "tool": {
            "toolProfileId": tool.get("toolProfileId") or settings.get("toolProfileId"),
            "diameterMm": tool.get("diameterMm") or settings.get("toolDiameter"),
            "description": tool.get("description"),
            "spindleRpm": settings.get("spindleRpm"),
            "feedRateMmMin": settings.get("feedRate"),
        },
        "operations": [
            {
                "id": operation.get("id"),
                "enabled": bool(operation.get("enabled")),
                "strategy": operation.get("strategy"),
                "allowAdapter": operation.get("allowAdapter", True),
                "parameters": operation.get("parameters") or {},
            }
            for operation in operations
        ],
        "operationCounts": {
            "total": len(operations),
            "enabled": len(enabled_operations),
        },
        "postprocess": {
            "policy": postprocess.get("policy"),
            "camMode": postprocess.get("camMode") or settings.get("camMode"),
            "postProcessor": postprocess.get("postProcessor") or settings.get("postProcessor"),
            "rotaryOutputAxis": settings.get("rotaryOutputAxis"),
            "rotaryWrapPerRevolutionMm": settings.get("rotaryWrapPerRevolutionMm"),
        },
        "freecad": {
            **detection,
            "experimentalOutputEnabled": is_true(os.environ.get("HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT")),
        },
        "expectedArtifacts": {
            "gcode": (job.get("outputs") or {}).get("gcode"),
            "report": (job.get("outputs") or {}).get("report"),
        },
        "limitations": [
            "FreeCAD Path is best used on STL/OBJ/STEP style geometry; Meshy GLB should be converted first.",
            "Rotary-wrap postprocessing remains owned by HeDiao3D; external CAM should return neutral/unwrapped motion.",
            "Production unlock still requires NC static analysis, controller dialect check, air-run and material-removal simulation.",
        ],
    }


def write_plan_artifacts(job: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, str]:
    work_dir = Path(str(job.get("workDir") or Path((job.get("outputs") or {}).get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    plan_path = work_dir / "freecad-cam-plan.json"
    script_path = work_dir / "freecad-run-template.py"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    script_path.write_text(create_freecad_run_template(plan), encoding="utf-8")
    return {
        "freecadCamPlan": str(plan_path),
        "freecadRunTemplate": str(script_path),
    }


def create_freecad_run_template(plan: Dict[str, Any]) -> str:
    return f'''# Auto-generated by HeDiao3D FreeCAD adapter.
# This is a reviewable template, not a standalone production guarantee.
import FreeCAD

try:
    import Mesh
except Exception:
    Mesh = None

PLAN = {json.dumps(plan, ensure_ascii=False, indent=2)}

doc = FreeCAD.newDocument("HeDiao3D_CAM")
model_path = PLAN["model"]["path"]

if PLAN["model"]["format"] in ("stl", "obj") and Mesh:
    mesh = Mesh.Mesh(model_path)
    obj = doc.addObject("Mesh::Feature", "ImportedMesh")
    obj.Mesh = mesh
else:
    raise RuntimeError("This template currently expects STL/OBJ mesh input. Convert GLB/GLTF before running FreeCAD Path.")

doc.recompute()

# Next implementation step:
# 1. Create Path Job from obj.
# 2. Create ToolController using PLAN["tool"].
# 3. Add roughing/finishing operations from PLAN["operations"].
# 4. Postprocess to PLAN["expectedArtifacts"]["gcode"] using a neutral post.
# 5. Return that neutral path to HeDiao3D for rotary-wrap Y/A postprocessing.
print("HeDiao3D FreeCAD CAM template prepared:", PLAN["jobId"])
'''


def attempt_experimental_freecad_output(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: Path) -> Dict[str, Any]:
    if not is_true(os.environ.get("HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT")):
        return {
            "status": "adapter_not_ready",
            "error": "FreeCAD adapter plan generated, but experimental output is disabled. Set HEDIAO3D_FREECAD_EXPERIMENTAL_OUTPUT=true after validating the server recipe.",
        }
    external_command = resolve_external_command()
    if external_command is not None:
        return run_external_freecad_command(job, plan, job_path, plan_path, external_command)
    if not plan["freecad"]["freecadPythonAvailable"]:
        return {
            "status": "adapter_not_ready",
            "error": "FreeCAD Python modules are not available in this process. Run with FreeCADCmd/freecadcmd.",
        }
    if plan["model"]["requiresPreConversion"]:
        return {
            "status": "adapter_not_ready",
            "error": f"Model format .{plan['model']['format']} requires conversion before FreeCAD Path adapter execution.",
        }

    # The production Path operation graph is intentionally not emitted until it
    # has been validated against a real FreeCAD server and target controller.
    return {
        "status": "adapter_not_ready",
        "error": "FreeCAD environment detected, but production Path operation creation is still locked pending server validation.",
    }


def resolve_external_command() -> Optional[List[str]]:
    command_json = os.environ.get("HEDIAO3D_FREECAD_EXTERNAL_COMMAND_JSON")
    if command_json:
        try:
            parsed = json.loads(command_json)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list) and all(isinstance(part, str) and part for part in parsed):
            return parsed
        return []
    command = os.environ.get("HEDIAO3D_FREECAD_EXTERNAL_COMMAND")
    if not command:
        return None
    return shlex.split(command, posix=os.name != "nt")


def run_external_freecad_command(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: Path, command_parts: List[str]) -> Dict[str, Any]:
    outputs = job.get("outputs") or {}
    work_dir = Path(str(job.get("workDir") or Path(outputs.get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    gcode_path = Path(str(outputs.get("gcode") or work_dir / "toolpath.nc"))
    gcode_path.parent.mkdir(parents=True, exist_ok=True)
    if not command_parts:
        return {
            "status": "adapter_not_ready",
            "error": "FreeCAD external command is empty or invalid.",
        }
    timeout_s = float(os.environ.get("HEDIAO3D_FREECAD_EXTERNAL_TIMEOUT_SEC") or 180)
    try:
        run = subprocess.run(
            [*command_parts, str(job_path), str(plan_path), str(gcode_path)],
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "status": "adapter_not_ready",
            "error": f"FreeCAD external command failed to start: {exc}",
        }
    command_report = {
        "command": " ".join(command_parts),
        "commandParts": command_parts,
        "exitCode": run.returncode,
        "stdoutTail": run.stdout[-1200:],
        "stderrTail": run.stderr[-1200:],
    }
    if run.returncode != 0:
        return {
            "status": "adapter_not_ready",
            "error": f"FreeCAD external command exited {run.returncode}: {(run.stderr or run.stdout or '').strip()[:1200]}",
            "externalCommand": command_report,
        }
    if not gcode_path.exists() or gcode_path.stat().st_size <= 0:
        return {
            "status": "adapter_not_ready",
            "error": f"FreeCAD external command completed but did not write G-code output: {gcode_path}",
            "externalCommand": command_report,
        }
    gcode = gcode_path.read_text(encoding="utf-8", errors="ignore")
    if "G0" not in gcode.upper() and "G1" not in gcode.upper():
        return {
            "status": "adapter_not_ready",
            "error": f"FreeCAD external command output does not contain G0/G1 motion: {gcode_path}",
            "externalCommand": command_report,
        }
    return {
        "status": "completed",
        "error": None,
        "gcodePath": str(gcode_path),
        "synthetic": False,
        "externalCommand": command_report,
    }


def base_report(job: Dict[str, Any], status: str, error: Optional[str], warnings: List[str], metrics: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": status,
        "protocolVersion": PROTOCOL_VERSION,
        "engine": ENGINE,
        "jobId": job.get("jobId"),
        "error": error,
        "warnings": warnings,
        "metrics": metrics,
    }


def is_true(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: freecad_cam_job.py <job.json> <result.json>", file=sys.stderr)
        return 2

    job_path = Path(sys.argv[-2])
    result_path = Path(sys.argv[-1])
    job = json.loads(job_path.read_text(encoding="utf-8"))
    detection = detect_freecad_modules()
    missing = [key for key in ("jobId", "modelPath", "settings", "outputs") if key not in job]

    if missing:
        result = base_report(
            job,
            "failed",
            f"Missing adapter job keys: {', '.join(missing)}",
            [],
            {
                "recipe": recipe_summary(job),
                "freecad": detection,
            },
        )
    else:
        plan = build_freecad_plan(job, detection)
        artifact_paths = write_plan_artifacts(job, plan)
        attempt = attempt_experimental_freecad_output(job, plan, job_path, Path(artifact_paths["freecadCamPlan"]))
        warnings = [
            "FreeCAD adapter now emits an auditable CAM plan and run template.",
            "Production G-code output remains locked until the FreeCAD Path operation recipe is validated on the deployment server.",
        ]
        if plan["model"]["requiresPreConversion"]:
            warnings.append(str(plan["model"]["conversionHint"] or "Model conversion is required before FreeCAD Path execution."))
        result = base_report(
            job,
            attempt["status"],
            attempt["error"],
            warnings,
            {
                "modelPath": job["modelPath"],
                "camMode": job["settings"].get("camMode"),
                "recipe": recipe_summary(job),
                "freecad": detection,
                "freecadPlan": {
                    "status": "generated",
                    "planPath": artifact_paths["freecadCamPlan"],
                    "runTemplatePath": artifact_paths["freecadRunTemplate"],
                    "supportedInput": plan["model"]["directlySupportedByAdapter"],
                    "requiresPreConversion": plan["model"]["requiresPreConversion"],
                    "operationCount": plan["operationCounts"]["total"],
                    "enabledOperationCount": plan["operationCounts"]["enabled"],
                },
                "externalCommand": attempt.get("externalCommand"),
                "gcode": {
                    "status": "generated" if attempt.get("gcodePath") else "not_generated",
                    "path": attempt.get("gcodePath"),
                    "synthetic": attempt.get("synthetic"),
                },
            },
        )
        if attempt.get("gcodePath"):
            result["gcodePath"] = attempt["gcodePath"]
            result["outputs"] = {
                "gcode": attempt["gcodePath"],
                "report": str(result_path),
            }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
