#!/usr/bin/env python3
"""BlenderCAM/FabexCNC adapter for HeDiao3D V3.

Run target:
  blender --background --python adapters/blendercam/blendercam_job.py -- job.json result.json

The adapter prepares an auditable artistic-surface CAM plan for BlenderCAM or
FabexCNC. Production G-code output is still locked behind
HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=true because BlenderCAM operation setup,
tool libraries and postprocessors must be validated on the deployment server.
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
ENGINE = "blendercam"
SUPPORTED_MODEL_FORMATS = {".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx"}


def adapter_args() -> List[str]:
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return sys.argv[1:]


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


def detect_blendercam_environment() -> Dict[str, Any]:
    bpy_spec = safe_find_spec("bpy")
    module_candidates = ["cam", "blendercam", "fabex", "cam.ui", "cam.ops"]
    modules = {
        name: {
            "available": (spec := safe_find_spec(name)) is not None,
            "origin": spec.origin if spec and spec.origin else None,
        }
        for name in module_candidates
    }
    return {
        "blenderPythonAvailable": bpy_spec is not None,
        "bpyOrigin": bpy_spec.origin if bpy_spec and bpy_spec.origin else None,
        "camAddonDetected": any(item["available"] for item in modules.values()),
        "modules": modules,
        "experimentalOutputEnabled": is_true(os.environ.get("HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT")),
    }


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


def build_blendercam_plan(job: Dict[str, Any], detection: Dict[str, Any]) -> Dict[str, Any]:
    settings = job.get("settings") or {}
    recipe = job.get("externalCamRecipe") or {}
    operations = recipe.get("operations") or []
    enabled_operations = [operation for operation in operations if operation.get("enabled")]
    model_path = Path(str(job.get("modelPath") or ""))
    suffix = model_path.suffix.lower()
    stock = recipe.get("stock") or {}
    tool = recipe.get("tool") or {}
    postprocess = recipe.get("postprocess") or {}
    cam_mode = settings.get("camMode")
    rotary_axis = settings.get("rotaryOutputAxis") if cam_mode == "rotaryWrap" else None

    return {
        "schema": "hediao3d.blendercam-cam-plan.v1",
        "jobId": job.get("jobId"),
        "engine": ENGINE,
        "model": {
            "path": str(model_path),
            "format": suffix.lstrip(".") or None,
            "exists": model_path.exists(),
            "directlySupportedByAdapter": suffix in SUPPORTED_MODEL_FORMATS,
            "preferredForMeshyOutput": suffix in {".glb", ".gltf", ".obj", ".stl"},
            "conversionHint": None if suffix in SUPPORTED_MODEL_FORMATS else "Convert the source model to GLB, OBJ or STL before BlenderCAM execution.",
        },
        "stock": {
            "lengthMm": stock.get("lengthMm") or settings.get("lengthMm"),
            "diameterMm": stock.get("diameterMm") or settings.get("diameterMm"),
            "blankShape": "olive-core-rotary-wrap" if cam_mode == "rotaryWrap" else "rectangular-relief",
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
                "blendercamStrategyHint": blendercam_strategy_hint(operation, cam_mode),
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
            "camMode": postprocess.get("camMode") or cam_mode,
            "postProcessor": postprocess.get("postProcessor") or settings.get("postProcessor"),
            "rotaryOutputAxis": rotary_axis,
            "rotaryWrapPerRevolutionMm": settings.get("rotaryWrapPerRevolutionMm"),
            "handoff": "External BlenderCAM should export neutral/unwrapped G-code or sampled cutter path; HeDiao3D owns final Y/A rotary-wrap postprocess.",
        },
        "blendercam": detection,
        "expectedArtifacts": {
            "gcode": (job.get("outputs") or {}).get("gcode"),
            "report": (job.get("outputs") or {}).get("report"),
            "blendFile": str(Path(str(job.get("workDir") or ".")) / "blendercam-job.blend"),
        },
        "limitations": [
            "The adapter plan is for artistic mesh/surface machining, especially Meshy GLB/OBJ/STL assets.",
            "BlenderCAM/FabexCNC add-on names differ by installation; deployment validation must confirm the actual Python API.",
            "Production unlock still requires HeDiao3D postprocessing, NC static analysis, controller dialect check and material-removal simulation.",
        ],
    }


def blendercam_strategy_hint(operation: Dict[str, Any], cam_mode: Any) -> str:
    strategy = str(operation.get("strategy") or "").lower()
    if "rough" in strategy:
        return "waterline-or-pocket-roughing"
    if "rest" in strategy or "detail" in strategy:
        return "pencil/rest-detail-pass"
    if cam_mode == "rotaryWrap":
        return "parallel-finish-on-unwrapped-surface"
    return "parallel-finish-or-projection"


def write_plan_artifacts(job: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, str]:
    work_dir = Path(str(job.get("workDir") or Path((job.get("outputs") or {}).get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    plan_path = work_dir / "blendercam-cam-plan.json"
    script_path = work_dir / "blendercam-run-template.py"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    script_path.write_text(create_blendercam_run_template(plan), encoding="utf-8")
    return {
        "blendercamCamPlan": str(plan_path),
        "blendercamRunTemplate": str(script_path),
    }


def create_blendercam_run_template(plan: Dict[str, Any]) -> str:
    return f'''# Auto-generated by HeDiao3D BlenderCAM adapter.
# Run with: blender --background --python blendercam-run-template.py
# This template documents the expected Blender/FabexCNC setup. It does not
# guarantee production G-code until validated on the deployment server.
import json

try:
    import bpy
except Exception as exc:
    raise RuntimeError("This template must run inside Blender Python") from exc

PLAN = {json.dumps(plan, ensure_ascii=False, indent=2)}

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

model_path = PLAN["model"]["path"]
fmt = PLAN["model"]["format"]

if fmt in ("glb", "gltf"):
    bpy.ops.import_scene.gltf(filepath=model_path)
elif fmt == "obj":
    bpy.ops.import_scene.obj(filepath=model_path)
elif fmt == "stl":
    bpy.ops.import_mesh.stl(filepath=model_path)
else:
    raise RuntimeError("Unsupported BlenderCAM template input format: %s" % fmt)

# Next implementation step:
# 1. Enable/verify BlenderCAM or FabexCNC add-on in this Blender install.
# 2. Create CAM operation(s) from PLAN["operations"].
# 3. Assign PLAN["tool"] and stock bounds.
# 4. Export neutral/unwrapped G-code or cutter path.
# 5. Return that path to HeDiao3D for final rotary-wrap postprocessing.
print("HeDiao3D BlenderCAM template prepared:", PLAN["jobId"])
'''


def attempt_experimental_blendercam_output(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: Path) -> Dict[str, Any]:
    if not is_true(os.environ.get("HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT")):
        return {
            "status": "adapter_not_ready",
            "error": "BlenderCAM adapter plan generated, but experimental output is disabled. Set HEDIAO3D_BLENDERCAM_EXPERIMENTAL_OUTPUT=true after validating the server recipe.",
        }
    external_command = resolve_external_command()
    if external_command is not None:
        return run_external_blendercam_command(job, plan, job_path, plan_path, external_command)
    if not plan["blendercam"]["blenderPythonAvailable"]:
        return {
            "status": "adapter_not_ready",
            "error": "Blender Python bpy module is not available. Run with blender --background --python.",
        }
    if not plan["blendercam"]["camAddonDetected"]:
        return {
            "status": "adapter_not_ready",
            "error": "Blender Python is available, but BlenderCAM/FabexCNC add-on modules were not detected.",
        }
    if not plan["model"]["directlySupportedByAdapter"]:
        return {
            "status": "adapter_not_ready",
            "error": "Model format requires conversion before BlenderCAM execution.",
        }
    return {
        "status": "adapter_not_ready",
        "error": "BlenderCAM/FabexCNC environment detected, but operation creation is still locked pending server validation.",
    }


def resolve_external_command() -> Optional[List[str]]:
    command_json = os.environ.get("HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND_JSON")
    if command_json:
        try:
            parsed = json.loads(command_json)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list) and all(isinstance(part, str) and part for part in parsed):
            return parsed
        return []
    command = os.environ.get("HEDIAO3D_BLENDERCAM_EXTERNAL_COMMAND")
    if not command:
        return None
    return shlex.split(command, posix=os.name != "nt")


def run_external_blendercam_command(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: Path, command_parts: List[str]) -> Dict[str, Any]:
    outputs = job.get("outputs") or {}
    work_dir = Path(str(job.get("workDir") or Path(outputs.get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    gcode_path = Path(str(outputs.get("gcode") or work_dir / "toolpath.nc"))
    gcode_path.parent.mkdir(parents=True, exist_ok=True)
    if not command_parts:
        return {
            "status": "adapter_not_ready",
            "error": "BlenderCAM external command is empty or invalid.",
        }
    timeout_s = float(os.environ.get("HEDIAO3D_BLENDERCAM_EXTERNAL_TIMEOUT_SEC") or 240)
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
            "error": f"BlenderCAM external command failed to start: {exc}",
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
            "error": f"BlenderCAM external command exited {run.returncode}: {(run.stderr or run.stdout or '').strip()[:1200]}",
            "externalCommand": command_report,
        }
    if not gcode_path.exists() or gcode_path.stat().st_size <= 0:
        return {
            "status": "adapter_not_ready",
            "error": f"BlenderCAM external command completed but did not write G-code output: {gcode_path}",
            "externalCommand": command_report,
        }
    gcode = gcode_path.read_text(encoding="utf-8", errors="ignore")
    if "G0" not in gcode.upper() and "G1" not in gcode.upper():
        return {
            "status": "adapter_not_ready",
            "error": f"BlenderCAM external command output does not contain G0/G1 motion: {gcode_path}",
            "externalCommand": command_report,
        }
    output_evidence = classify_gcode_output(gcode, command_parts)
    return {
        "status": "completed",
        "error": None,
        "gcodePath": str(gcode_path),
        "synthetic": False,
        "fixture": output_evidence["fixture"],
        "previewScaffold": output_evidence["previewScaffold"],
        "handoffEvidence": output_evidence,
        "externalCommand": command_report,
    }


def classify_gcode_output(gcode: str, command_parts: List[str]) -> Dict[str, Any]:
    upper = gcode.upper()
    fixture = is_true(os.environ.get("HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT")) or "BLENDERCAM EXTERNAL RUNNER FIXTURE" in upper
    preview_scaffold = "PREVIEW" in upper or "SCAFFOLD" in upper
    motion_count = len([line for line in upper.splitlines() if line.strip().startswith(("G0", "G1"))])
    return {
        "schema": "hediao3d.adapter-handoff-evidence.v1",
        "engine": ENGINE,
        "outputKind": "gcode",
        "classification": "fixture-contract" if fixture else "preview-scaffold" if preview_scaffold else "production-candidate",
        "fixture": fixture,
        "synthetic": False,
        "previewScaffold": preview_scaffold,
        "generatedByExternalCommand": True,
        "motionCount": motion_count,
        "commandHead": command_parts[:3],
        "productionCandidate": motion_count > 0 and not fixture and not preview_scaffold,
        "productionBoundary": "This evidence classifies adapter output only; HeDiao3D production gates still require CAMotics/material removal, static NC analysis, air-run, trial feedback and machine acceptance.",
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
    args = adapter_args()
    if len(args) < 2:
        print("Usage: blendercam_job.py <job.json> <result.json>", file=sys.stderr)
        return 2

    job_path = Path(args[0])
    result_path = Path(args[1])
    job = json.loads(job_path.read_text(encoding="utf-8"))
    detection = detect_blendercam_environment()
    missing = [key for key in ("jobId", "modelPath", "settings", "outputs") if key not in job]

    if missing:
        result = base_report(
            job,
            "failed",
            f"Missing adapter job keys: {', '.join(missing)}",
            [],
            {
                "recipe": recipe_summary(job),
                "blendercam": detection,
            },
        )
    else:
        plan = build_blendercam_plan(job, detection)
        artifact_paths = write_plan_artifacts(job, plan)
        attempt = attempt_experimental_blendercam_output(job, plan, job_path, Path(artifact_paths["blendercamCamPlan"]))
        warnings = [
            "BlenderCAM adapter now emits an auditable artistic-surface CAM plan and run template.",
            "Production G-code output remains locked until the BlenderCAM/FabexCNC recipe is validated on the deployment server.",
        ]
        if not plan["model"]["directlySupportedByAdapter"]:
            warnings.append(str(plan["model"]["conversionHint"] or "Model conversion is required before BlenderCAM execution."))
        result = base_report(
            job,
            attempt["status"],
            attempt["error"],
            warnings,
            {
                "modelPath": job.get("modelPath"),
                "camMode": job.get("settings", {}).get("camMode"),
                "recipe": recipe_summary(job),
                "blendercam": detection,
                "blendercamPlan": {
                    "status": "generated",
                    "planPath": artifact_paths["blendercamCamPlan"],
                    "runTemplatePath": artifact_paths["blendercamRunTemplate"],
                    "supportedInput": plan["model"]["directlySupportedByAdapter"],
                    "operationCount": plan["operationCounts"]["total"],
                    "enabledOperationCount": plan["operationCounts"]["enabled"],
                    "preferredForMeshyOutput": plan["model"]["preferredForMeshyOutput"],
                },
                "externalCommand": attempt.get("externalCommand"),
                "gcode": {
                    "status": "generated" if attempt.get("gcodePath") else "not_generated",
                    "path": attempt.get("gcodePath"),
                    "synthetic": attempt.get("synthetic"),
                    "fixture": bool(attempt.get("fixture")),
                    "previewScaffold": bool(attempt.get("previewScaffold")),
                },
                "handoffEvidence": attempt.get("handoffEvidence") or create_missing_handoff_evidence(ENGINE, "gcode", attempt),
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


def create_missing_handoff_evidence(engine: str, output_kind: str, attempt: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema": "hediao3d.adapter-handoff-evidence.v1",
        "engine": engine,
        "outputKind": output_kind,
        "classification": "not-generated",
        "fixture": False,
        "synthetic": False,
        "previewScaffold": False,
        "generatedByExternalCommand": bool(attempt.get("externalCommand")),
        "motionCount": 0,
        "productionCandidate": False,
        "productionBoundary": "No external CAM output was generated; production NC remains locked.",
    }


if __name__ == "__main__":
    raise SystemExit(main())
