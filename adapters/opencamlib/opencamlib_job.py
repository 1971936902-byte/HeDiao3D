#!/usr/bin/env python3
"""OpenCAMLib geometry-kernel adapter for HeDiao3D V3.

Run target:
  python adapters/opencamlib/opencamlib_job.py job.json result.json

OpenCAMLib is a cutter-contact/drop-cutter geometry kernel, not a full CAM
application. This adapter prepares an auditable kernel plan that can later
replace internal mesh sampling while HeDiao3D keeps final rotary-wrap
postprocessing and safety gates.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


PROTOCOL_VERSION = "hediao3d.adapter.v1"
ENGINE = "opencamlib"


def detect_opencamlib() -> Dict[str, Any]:
    candidates = ["opencamlib", "ocl"]
    modules: Dict[str, Any] = {}
    selected = None
    for name in candidates:
        spec = safe_find_spec(name)
        modules[name] = {
            "available": spec is not None,
            "origin": spec.origin if spec and spec.origin else None,
        }
        if spec is not None and selected is None:
            selected = {"module": name, "origin": spec.origin if spec.origin else None}
    return {
        "available": selected is not None,
        "module": selected["module"] if selected else None,
        "origin": selected["origin"] if selected else None,
        "modules": modules,
        "experimentalOutputEnabled": is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT")),
    }


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


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


def build_kernel_plan(job: Dict[str, Any], detection: Dict[str, Any]) -> Dict[str, Any]:
    settings = job.get("settings") or {}
    recipe = job.get("externalCamRecipe") or {}
    operations = recipe.get("operations") or []
    enabled_operations = [operation for operation in operations if operation.get("enabled")]
    model_path = Path(str(job.get("modelPath") or ""))
    tool = recipe.get("tool") or {}
    stock = recipe.get("stock") or {}
    cam_mode = settings.get("camMode")
    stepover_mm = settings.get("stepoverMm")
    stepover_deg = settings.get("stepoverDeg")
    rotary_axis = settings.get("rotaryOutputAxis") if cam_mode == "rotaryWrap" else None

    return {
        "schema": "hediao3d.opencamlib-kernel-plan.v1",
        "jobId": job.get("jobId"),
        "engine": ENGINE,
        "model": {
            "path": str(model_path),
            "format": model_path.suffix.lower().lstrip(".") or None,
            "exists": model_path.exists(),
            "requiredMeshState": "triangulated-manifold-or-repaired-mesh",
            "conversionHint": "Use STL/OBJ triangulated mesh after mesh-quality and repair-plan gates.",
        },
        "stock": {
            "lengthMm": stock.get("lengthMm") or settings.get("lengthMm"),
            "diameterMm": stock.get("diameterMm") or settings.get("diameterMm"),
            "blankShape": "olive-core-rotary-wrap" if cam_mode == "rotaryWrap" else "rectangular-relief",
        },
        "tool": {
            "toolProfileId": tool.get("toolProfileId") or settings.get("toolProfileId"),
            "diameterMm": tool.get("diameterMm") or settings.get("toolDiameter"),
            "flatTipMm": 0.4 if is_vflat_25(settings) else None,
            "angleDeg": 25 if is_vflat_25(settings) else None,
            "cutterModel": "ball/flat approximated cutter contact; V-bit flat-tip support needs local calibration.",
        },
        "sampling": {
            "strategies": [
                "drop-cutter-z-map",
                "waterline-steep-region",
                "rest-detail-contact-pass",
            ],
            "recommendedPrimary": "drop-cutter-z-map" if cam_mode != "rotaryWrap" else "unwrapped-rotary-drop-cutter",
            "stepoverMm": stepover_mm,
            "stepoverDeg": stepover_deg,
            "maxCutDepthMm": settings.get("maxCutDepth"),
            "stockAllowanceMm": settings.get("stockAllowance"),
            "axisMapping": {
                "lengthAxis": "X",
                "depthAxis": "Z",
                "rotaryAxis": rotary_axis,
                "rotaryWrapPerRevolutionMm": settings.get("rotaryWrapPerRevolutionMm") if cam_mode == "rotaryWrap" else None,
            },
        },
        "operations": [
            {
                "id": operation.get("id"),
                "enabled": bool(operation.get("enabled")),
                "strategy": operation.get("strategy"),
                "kernelRole": kernel_role(operation),
                "parameters": operation.get("parameters") or {},
            }
            for operation in operations
        ],
        "operationCounts": {
            "total": len(operations),
            "enabled": len(enabled_operations),
        },
        "outputs": {
            "neutralPointCloud": "opencamlib-cutter-contact-points.json",
            "neutralPolyline": (job.get("outputs") or {}).get("neutralToolpath") or "neutral-toolpath.json",
            "handoff": "HeDiao3D converts neutral cutter-contact output into rotary-wrap machine NC.",
            "finalMachineNc": (job.get("outputs") or {}).get("gcode"),
        },
        "opencamlib": detection,
        "limitations": [
            "OpenCAMLib is a geometry kernel and does not replace CAM project setup, postprocessing or machine safety checks.",
            "The first production target should be neutral cutter-contact points, not direct machine G-code.",
            "V-bit flat-tip geometry must be calibrated against real material before production use.",
        ],
    }


def kernel_role(operation: Dict[str, Any]) -> str:
    strategy = str(operation.get("strategy") or "").lower()
    if "rough" in strategy:
        return "coarse-drop-cutter-clearance"
    if "rest" in strategy or "detail" in strategy:
        return "local-cutter-contact-rest-pass"
    if "water" in strategy:
        return "waterline-steep-region"
    return "finish-drop-cutter-surface"


def write_plan_artifacts(job: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, str]:
    work_dir = Path(str(job.get("workDir") or Path((job.get("outputs") or {}).get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    plan_path = work_dir / "opencamlib-kernel-plan.json"
    script_path = work_dir / "opencamlib-run-template.py"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    script_path.write_text(create_run_template(plan), encoding="utf-8")
    return {
        "opencamlibKernelPlan": str(plan_path),
        "opencamlibRunTemplate": str(script_path),
    }


def create_run_template(plan: Dict[str, Any]) -> str:
    return f'''# Auto-generated by HeDiao3D OpenCAMLib adapter.
# This is a geometry-kernel template. It intentionally emits neutral cutter
# contact data for HeDiao3D postprocessing, not direct machine NC.
import json
import importlib

PLAN = {json.dumps(plan, ensure_ascii=False, indent=2)}

ocl_module = importlib.import_module(PLAN["opencamlib"]["module"] or "ocl")

# Next implementation step:
# 1. Load PLAN["model"]["path"] as triangulated STL/OBJ.
# 2. Build OpenCAMLib STL surface and cutter model from PLAN["tool"].
# 3. Run drop-cutter / waterline passes from PLAN["operations"].
# 4. Write PLAN["outputs"]["neutralPointCloud"] and neutral polyline JSON.
# 5. Let HeDiao3D convert neutral output into wrapY/wrapA machine NC.
print("HeDiao3D OpenCAMLib template prepared:", PLAN["jobId"], ocl_module)
'''


def attempt_experimental_kernel_output(job: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
    if not is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT")):
        return {
            "status": "adapter_not_ready",
            "error": "OpenCAMLib kernel plan generated, but experimental output is disabled. Set HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=true after validating the server recipe.",
        }
    imported = try_import_neutral_toolpath(job)
    if imported is not None:
        return imported
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT")):
        neutral_path = write_synthetic_neutral_toolpath(job, plan)
        return {
            "status": "completed",
            "error": None,
            "neutralToolpathPath": neutral_path,
            "synthetic": True,
        }
    if not plan["opencamlib"]["available"]:
        return {
            "status": "adapter_not_ready",
            "error": "OpenCAMLib/ocl Python module is not available.",
        }
    return {
        "status": "adapter_not_ready",
        "error": "OpenCAMLib module detected, but cutter-contact output is still locked pending server validation.",
    }


def try_import_neutral_toolpath(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source = os.environ.get("HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON")
    if not source:
        return None
    source_path = Path(source)
    if not source_path.exists():
        return {
            "status": "adapter_not_ready",
            "error": f"HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON does not exist: {source}",
        }
    try:
        neutral = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "status": "adapter_not_ready",
            "error": f"HEDIAO3D_OPENCAMLIB_NEUTRAL_JSON is not valid JSON: {source}",
        }
    validation_errors = validate_imported_neutral_toolpath(neutral)
    if validation_errors:
        return {
            "status": "adapter_not_ready",
            "error": "Imported neutral toolpath failed validation: " + "; ".join(validation_errors),
        }

    outputs = job.get("outputs") or {}
    work_dir = Path(str(job.get("workDir") or Path(outputs.get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    neutral_path = Path(str(outputs.get("neutralToolpath") or work_dir / "neutral-toolpath.json"))
    neutral_path.parent.mkdir(parents=True, exist_ok=True)
    neutral = {
        **neutral,
        "jobId": neutral.get("jobId") or job.get("jobId"),
        "engine": ENGINE,
        "synthetic": False,
        "importedFrom": str(source_path),
    }
    neutral_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "status": "completed",
        "error": None,
        "neutralToolpathPath": str(neutral_path),
        "synthetic": False,
        "imported": True,
        "sourcePath": str(source_path),
    }


def validate_imported_neutral_toolpath(neutral: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if not isinstance(neutral, dict):
        return ["neutral toolpath is not an object"]
    if neutral.get("schema") != "hediao3d.neutral-toolpath.v1":
        errors.append("schema must be hediao3d.neutral-toolpath.v1")
    if neutral.get("synthetic") is True:
        errors.append("synthetic neutral toolpath cannot be imported as real OpenCAMLib output")
    points = neutral.get("points")
    if not isinstance(points, list) or not points:
        errors.append("points must be a non-empty array")
    else:
        first = points[0]
        if not isinstance(first, dict):
            errors.append("points must contain objects")
        elif "x" not in first or "z" not in first:
            errors.append("points must include at least x and z values")
    return errors


def write_synthetic_neutral_toolpath(job: Dict[str, Any], plan: Dict[str, Any]) -> str:
    """Write a tiny neutral handoff fixture for adapter/orchestrator contract tests.

    This is deliberately gated by HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT
    and must not be treated as real OpenCAMLib cutter-contact output.
    """

    settings = job.get("settings") or {}
    outputs = job.get("outputs") or {}
    work_dir = Path(str(job.get("workDir") or Path(outputs.get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    neutral_path = Path(str(outputs.get("neutralToolpath") or work_dir / "neutral-toolpath.json"))
    length = float(settings.get("lengthMm") or 38)
    safe_z = float(settings.get("safeZ") or 2)
    max_depth = float(settings.get("depthMm") or settings.get("maxCutDepth") or 1.2)
    rows = []
    for row_index, angle in enumerate((0, 90, 180, 270, 360)):
        for col_index in range(6):
            t = col_index / 5
            x = -length / 2 + length * t
            scallop = abs(0.5 - t) * 0.35
            depth = max_depth * (0.35 + 0.55 * (1 - scallop)) + row_index * 0.02
            rows.append({
                "x": round(x, 4),
                "a": angle,
                "z": round(safe_z - depth, 4),
                "depth": round(depth, 4),
                "source": "synthetic-contract-fixture",
            })

    neutral = {
        "schema": "hediao3d.neutral-toolpath.v1",
        "jobId": job.get("jobId"),
        "engine": ENGINE,
        "createdBy": "opencamlib synthetic neutral contract fixture",
        "synthetic": True,
        "coordinate": {
            "lengthAxis": "X",
            "rotaryAxis": settings.get("rotaryOutputAxis") or "Y",
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        },
        "estimatedMinutes": 0.8,
        "points": rows,
        "warnings": [
            "Synthetic neutral output validates the HeDiao3D adapter handoff only; it is not real CAM cutter-contact output."
        ],
        "plan": {
            "schema": plan.get("schema"),
            "recommendedPrimary": (plan.get("sampling") or {}).get("recommendedPrimary"),
        },
    }
    neutral_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(neutral_path)


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


def is_vflat_25(settings: Dict[str, Any]) -> bool:
    return settings.get("toolProfileId") in {"vflat-4mm-25deg", "vbit-flat-4mm-25deg"}


def is_true(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: opencamlib_job.py <job.json> <result.json>", file=sys.stderr)
        return 2

    job_path = Path(sys.argv[-2])
    result_path = Path(sys.argv[-1])
    job = json.loads(job_path.read_text(encoding="utf-8"))
    detection = detect_opencamlib()
    missing = [key for key in ("jobId", "modelPath", "settings", "outputs") if key not in job]

    if missing:
        result = base_report(
            job,
            "failed",
            f"Missing adapter job keys: {', '.join(missing)}",
            [],
            {
                "recipe": recipe_summary(job),
                "opencamlib": detection,
            },
        )
    else:
        plan = build_kernel_plan(job, detection)
        artifact_paths = write_plan_artifacts(job, plan)
        attempt = attempt_experimental_kernel_output(job, plan)
        result = base_report(
            job,
            attempt["status"],
            attempt["error"],
            [
                "OpenCAMLib adapter now emits an auditable cutter-contact kernel plan and run template.",
                "Production cutter-contact output remains locked until the OpenCAMLib recipe is validated on the deployment server.",
                "Final machine NC must still go through HeDiao3D postprocessing and safety gates.",
            ],
            {
                "modelPath": job.get("modelPath"),
                "camMode": job.get("settings", {}).get("camMode"),
                "toolDiameter": job.get("settings", {}).get("toolDiameter"),
                "recipe": recipe_summary(job),
                "opencamlib": detection,
                "opencamlibPlan": {
                    "status": "generated",
                    "planPath": artifact_paths["opencamlibKernelPlan"],
                    "runTemplatePath": artifact_paths["opencamlibRunTemplate"],
                    "operationCount": plan["operationCounts"]["total"],
                    "enabledOperationCount": plan["operationCounts"]["enabled"],
                    "recommendedPrimary": plan["sampling"]["recommendedPrimary"],
                },
                "neutralToolpath": {
                    "status": "generated" if attempt.get("neutralToolpathPath") else "not_generated",
                    "path": attempt.get("neutralToolpathPath"),
                    "synthetic": bool(attempt.get("synthetic")),
                    "imported": bool(attempt.get("imported")),
                    "schema": "hediao3d.neutral-toolpath.v1" if attempt.get("neutralToolpathPath") else None,
                },
            },
        )
        if attempt.get("neutralToolpathPath"):
            result["neutralToolpathPath"] = attempt["neutralToolpathPath"]
            result["outputs"] = {
                "neutralToolpath": attempt["neutralToolpathPath"],
            }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
