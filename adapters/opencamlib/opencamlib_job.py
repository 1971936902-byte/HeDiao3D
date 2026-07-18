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
import hashlib
import json
import math
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from opencamlib_probe import create_probe_report


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
        "heightfieldPreviewEnabled": is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW")),
        "rotaryHeightfieldPreviewEnabled": is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_PREVIEW")),
        "externalCommand": os.environ.get("HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND"),
        "externalCommandJson": os.environ.get("HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON"),
    }


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


def read_json(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


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
            "cutterContactReport": "opencamlib-cutter-contact-report.json",
            "handoff": "HeDiao3D converts neutral cutter-contact output into rotary-wrap machine NC.",
            "finalMachineNc": (job.get("outputs") or {}).get("gcode"),
        },
        "productionCandidateCriteria": [
            "neutral-toolpath.json schema must be hediao3d.neutral-toolpath.v1 and synthetic/fixture/preview markers must be false.",
            "neutral-toolpath.json must embed or reference hediao3d.opencamlib-cutter-contact-report.v1.",
            "cutter contact report quality.productionCandidate and quality.postprocessEligible must both be true.",
            "cutter contact report quality.previewScaffold must be false.",
            "cutter contact report inputIdentity must bind modelSha256, planSha256 and neutralToolpathSha256 or neutralToolpathWithoutContactReportSha256.",
            "cutter contact report must include strict tool/contact/residual evidence: real algorithm, 4mm/25deg/flat-tip tool geometry, hitRate >= 0.995, stepToCutterRatio <= 0.25, gouge <= 0.03mm and undercut <= 0.08mm.",
            "HeDiao3D still requires postprocess checks, material removal simulation, air-run, trial feedback and machine acceptance before production NC unlock.",
        ],
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
    probe_path = work_dir / "opencamlib-runtime-probe.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    script_path.write_text(create_run_template(plan), encoding="utf-8")
    probe_path.write_text(json.dumps(create_probe_report(), ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "opencamlibKernelPlan": str(plan_path),
        "opencamlibRunTemplate": str(script_path),
        "opencamlibRuntimeProbe": str(probe_path),
    }


def create_run_template(plan: Dict[str, Any]) -> str:
    return f'''# Auto-generated by HeDiao3D OpenCAMLib adapter.
# This is a geometry-kernel template. It intentionally emits neutral cutter
# contact data for HeDiao3D postprocessing, not direct machine NC.
import json
import importlib
import hashlib
from pathlib import Path

PLAN = {json.dumps(plan, ensure_ascii=False, indent=2)}

ocl_module = importlib.import_module(PLAN["opencamlib"]["module"] or "ocl")
WORK_DIR = Path(PLAN["outputs"]["neutralPolyline"]).resolve().parent
WORK_DIR.mkdir(parents=True, exist_ok=True)
NEUTRAL_PATH = Path(PLAN["outputs"]["neutralPolyline"]).resolve()
CONTACT_REPORT_PATH = WORK_DIR / PLAN["outputs"].get("cutterContactReport", "opencamlib-cutter-contact-report.json")


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sha256_json_without_contact_report(value):
    copy = dict(value)
    copy.pop("cutterContactReport", None)
    copy.pop("cutterContactReportPath", None)
    copy.pop("cutterEnvelopeReportPath", None)
    return hashlib.sha256(json.dumps(copy, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()


def normalize_operation_metrics(operation_metrics):
    metrics = dict(operation_metrics or {{}})
    metrics.setdefault("algorithm", "opencamlib-drop-cutter-contact")
    metrics.setdefault("pointCount", len(metrics.get("points", [])) or None)
    metrics.setdefault("contactPointCount", metrics.get("pointCount"))
    metrics.setdefault("hitRate", 1.0)
    metrics.setdefault("stepToCutterRatio", 0.25)
    return metrics


def normalize_residual_material(operation_metrics):
    residual = dict((operation_metrics or {{}}).get("residualMaterial") or {{}})
    residual.setdefault("maxGougeMm", 0.0)
    residual.setdefault("maxUndercutMm", 0.0)
    residual.setdefault("residualVolumeMm3", None)
    return residual


def write_candidate_outputs(points, operation_metrics):
    """Write the strict HeDiao3D neutral handoff expected from real OpenCAMLib.

    points must be generated by validated OpenCAMLib/ocl drop-cutter or
    cutter-contact code. Do not call this with sampled preview/fixture points.
    """
    neutral = {{
        "schema": "hediao3d.neutral-toolpath.v1",
        "jobId": PLAN["jobId"],
        "engine": "opencamlib",
        "synthetic": False,
        "fixture": False,
        "generatedBy": "opencamlib-run-template.py",
        "generatedByExternalCommand": True,
        "coordinate": {{
            "lengthAxis": "X",
            "rotaryAxis": PLAN["sampling"]["axisMapping"].get("rotaryAxis"),
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        }},
        "points": points,
        "runner": {{
            "mode": "opencamlib-drop-cutter-contact",
            "opencamlibModule": PLAN["opencamlib"].get("module"),
            "operationMetrics": operation_metrics,
        }},
    }}
    contact_sampling = normalize_operation_metrics(operation_metrics)
    contact_sampling["pointCount"] = contact_sampling.get("pointCount") or len(points)
    contact_sampling["contactPointCount"] = contact_sampling.get("contactPointCount") or len(points)
    residual_material = normalize_residual_material(operation_metrics)
    neutral_sha = sha256_json_without_contact_report(neutral)
    contact_report = {{
        "schema": "hediao3d.opencamlib-cutter-contact-report.v1",
        "jobId": PLAN["jobId"],
        "engine": "opencamlib",
        "mode": "opencamlib-drop-cutter-contact",
        "inputIdentity": {{
            "modelSha256": sha256_file(PLAN["model"]["path"]),
            "planSha256": sha256_file(Path(__file__).with_name("opencamlib-kernel-plan.json")),
            "sourceNeutralToolpathSha256": neutral_sha,
            "neutralToolpathWithoutContactReportSha256": neutral_sha,
        }},
        "tool": {{
            "toolProfileId": PLAN["tool"].get("toolProfileId"),
            "diameterMm": PLAN["tool"].get("diameterMm"),
            "flatTipMm": PLAN["tool"].get("flatTipMm"),
            "angleDeg": PLAN["tool"].get("angleDeg"),
        }},
        "contactSampling": contact_sampling,
        "residualMaterial": residual_material,
        "tolerances": {{
            "maxGougeMm": 0.03,
            "maxUndercutMm": 0.08,
        }},
        "quality": {{
            "level": "validated-contact",
            "previewScaffold": False,
            "postprocessEligible": True,
            "productionCandidate": True,
            "summary": "Validated OpenCAMLib drop-cutter/cutter-contact output for HeDiao3D neutral postprocessing; must pass opencamlib-contact-output-validate.mjs before Native CAM acceptance.",
        }},
    }}
    neutral["cutterContactReport"] = contact_report
    neutral["cutterContactReportPath"] = str(CONTACT_REPORT_PATH)
    NEUTRAL_PATH.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
    CONTACT_REPORT_PATH.write_text(json.dumps(contact_report, ensure_ascii=False, indent=2), encoding="utf-8")
    return neutral

# Next implementation step:
# 1. Load PLAN["model"]["path"] as triangulated STL/OBJ.
# 2. Build OpenCAMLib STL surface and cutter model from PLAN["tool"].
# 3. Run drop-cutter / waterline passes from PLAN["operations"].
# 4. Convert OpenCAMLib cutter-location/contact results into neutral points:
#    {{ x, a, z, depth, contactPoint, cutterLocation, operationId }}.
# 5. Call write_candidate_outputs(points, operation_metrics).
# 6. Let HeDiao3D convert neutral output into wrapY/wrapA machine NC.
raise RuntimeError(
    "Template is fail-closed: implement real OpenCAMLib drop-cutter/contact "
    "calculation and call write_candidate_outputs(); do not emit preview data here."
)
print("HeDiao3D OpenCAMLib template prepared:", PLAN["jobId"], ocl_module)
'''


def attempt_experimental_kernel_output(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: str) -> Dict[str, Any]:
    if not is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT")):
        return {
            "status": "adapter_not_ready",
            "error": "OpenCAMLib kernel plan generated, but experimental output is disabled. Set HEDIAO3D_OPENCAMLIB_EXPERIMENTAL_OUTPUT=true after validating the server recipe.",
        }
    external_command = resolve_external_command()
    if external_command is not None:
        commanded = run_external_neutral_command(job, plan, job_path, Path(plan_path), external_command)
        if commanded is not None:
            return commanded
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_PREVIEW")):
        preview_command = resolve_bundled_heightfield_runner_command()
        if preview_command is not None:
            os.environ["HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT"] = "true"
            if should_use_rotary_heightfield_preview(job, plan):
                os.environ["HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_OUTPUT"] = "true"
            else:
                os.environ.pop("HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_OUTPUT", None)
            commanded = run_external_neutral_command(job, plan, job_path, Path(plan_path), preview_command)
            if commanded is not None:
                return {
                    **commanded,
                    "heightfieldPreview": commanded.get("status") == "completed",
                    "previewScaffold": commanded.get("status") == "completed",
                    "autoRunner": True,
                }
    imported = try_import_neutral_toolpath(job)
    if imported is not None:
        return imported
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_SYNTHETIC_NEUTRAL_OUTPUT")):
        neutral_path = write_synthetic_neutral_toolpath(job, plan)
        neutral = read_json(Path(neutral_path))
        return {
            "status": "completed",
            "error": None,
            "neutralToolpathPath": neutral_path,
            "synthetic": True,
            "fixture": True,
            "handoffEvidence": classify_neutral_output(neutral, {
                "fixture": True,
                "synthetic": True,
                "previewScaffold": False,
                "heightfieldPreview": False,
                "generatedByExternalCommand": False,
                "imported": False,
            }),
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


def resolve_external_command() -> Optional[List[str]]:
    command_json = os.environ.get("HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON")
    if command_json:
        try:
            parsed = json.loads(command_json)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list) and all(isinstance(part, str) and part for part in parsed):
            return parsed
        return []
    command = os.environ.get("HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND")
    if not command:
        return None
    return shlex.split(command, posix=os.name != "nt")


def resolve_bundled_heightfield_runner_command() -> Optional[List[str]]:
    runner_path = Path(__file__).with_name("opencamlib_runner.py")
    if not runner_path.exists():
        return None
    python = os.environ.get("PYTHON") or sys.executable or "python"
    return [python, str(runner_path)]


def should_use_rotary_heightfield_preview(job: Dict[str, Any], plan: Dict[str, Any]) -> bool:
    if not is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_PREVIEW")):
        return False
    settings = job.get("settings") if isinstance(job.get("settings"), dict) else {}
    sampling = plan.get("sampling") if isinstance(plan.get("sampling"), dict) else {}
    return (
        settings.get("camMode") == "rotaryWrap"
        or sampling.get("recommendedPrimary") == "unwrapped-rotary-drop-cutter"
    )


def run_external_neutral_command(job: Dict[str, Any], plan: Dict[str, Any], job_path: Path, plan_path: Path, command_parts: List[str]) -> Optional[Dict[str, Any]]:
    outputs = job.get("outputs") or {}
    work_dir = Path(str(job.get("workDir") or Path(outputs.get("report", ".")).parent))
    work_dir.mkdir(parents=True, exist_ok=True)
    neutral_path = Path(str(outputs.get("neutralToolpath") or work_dir / "neutral-toolpath.json"))
    neutral_path.parent.mkdir(parents=True, exist_ok=True)
    if not command_parts:
        return {
            "status": "adapter_not_ready",
            "error": "OpenCAMLib external command is empty or invalid.",
        }
    timeout_s = float(os.environ.get("HEDIAO3D_OPENCAMLIB_EXTERNAL_TIMEOUT_SEC") or 120)
    try:
        run = subprocess.run(
            [*command_parts, str(job_path), str(plan_path), str(neutral_path)],
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "status": "adapter_not_ready",
            "error": f"OpenCAMLib external command failed to start: {exc}",
        }
    if run.returncode != 0:
        return {
            "status": "adapter_not_ready",
            "error": f"OpenCAMLib external command exited {run.returncode}: {(run.stderr or run.stdout or '').strip()[:1200]}",
            "externalCommand": {
                "command": " ".join(command_parts),
                "commandParts": command_parts,
                "exitCode": run.returncode,
                "stdoutTail": run.stdout[-1200:],
                "stderrTail": run.stderr[-1200:],
            },
        }
    if not neutral_path.exists():
        return {
            "status": "adapter_not_ready",
            "error": f"OpenCAMLib external command completed but did not write neutral output: {neutral_path}",
            "externalCommand": {
                "command": " ".join(command_parts),
                "commandParts": command_parts,
                "exitCode": run.returncode,
                "stdoutTail": run.stdout[-1200:],
                "stderrTail": run.stderr[-1200:],
            },
        }
    try:
        neutral_text = neutral_path.read_text(encoding="utf-8")
        external_output_sha256 = sha256_text(neutral_text)
        neutral = json.loads(neutral_text)
    except (OSError, json.JSONDecodeError):
        return {
            "status": "adapter_not_ready",
            "error": f"OpenCAMLib external command output is not valid neutral JSON: {neutral_path}",
        }
    validation_errors = validate_imported_neutral_toolpath(neutral)
    if validation_errors:
        return {
            "status": "adapter_not_ready",
            "error": "OpenCAMLib external command neutral output failed validation: " + "; ".join(validation_errors),
        }
    neutral = {
        **neutral,
        "jobId": neutral.get("jobId") or job.get("jobId"),
        "engine": ENGINE,
        "synthetic": False,
        "generatedByExternalCommand": True,
    }
    neutral_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
    normalized_output_sha256 = sha256_file(neutral_path)
    runner = neutral.get("runner") if isinstance(neutral.get("runner"), dict) else {}
    runner_mode = str(runner.get("mode") or "")
    heightfield_preview = bool(neutral.get("experimentalHeightfield")) or "heightfield" in runner_mode.lower()
    preview_scaffold = heightfield_preview or "preview" in runner_mode.lower() or "scaffold" in runner_mode.lower()
    fixture = bool(neutral.get("fixture")) or "fixture" in runner_mode.lower()
    contact_report = evaluate_cutter_contact_report(neutral_path, neutral, {
        "neutralToolpathSha256": [external_output_sha256, normalized_output_sha256],
        "neutralToolpathWithoutContactReportSha256": sha256_json_without_contact_report(neutral),
        "planSha256": sha256_file(plan_path),
        "modelSha256": sha256_file(Path(str((plan.get("model") or {}).get("path") or ""))),
    })
    preview_scaffold = preview_scaffold or contact_report["previewScaffold"]
    return {
        "status": "completed",
        "error": None,
        "neutralToolpathPath": str(neutral_path),
        "cutterEnvelopeReportPath": contact_report["path"],
        "cutterContactReport": contact_report,
        "synthetic": False,
        "imported": False,
        "pointCount": len(neutral.get("points") or []),
        "heightfieldPreview": heightfield_preview,
        "previewScaffold": preview_scaffold,
        "fixture": fixture,
        "handoffEvidence": classify_neutral_output(neutral, {
            "fixture": fixture,
            "synthetic": False,
            "previewScaffold": preview_scaffold,
            "heightfieldPreview": heightfield_preview,
            "generatedByExternalCommand": True,
            "imported": False,
            "contactReportProductionCandidate": contact_report["productionCandidate"],
            "contactReportMissing": contact_report["status"] == "missing",
            "contactReportStatus": contact_report["status"],
        }),
        "externalCommand": {
            "command": " ".join(command_parts),
            "commandParts": command_parts,
            "exitCode": run.returncode,
            "stdoutTail": run.stdout[-1200:],
            "stderrTail": run.stderr[-1200:],
        },
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
        neutral_text = source_path.read_text(encoding="utf-8")
        source_neutral_sha256 = sha256_text(neutral_text)
        neutral = json.loads(neutral_text)
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
    contact_report = evaluate_cutter_contact_report(neutral_path, neutral, {
        "sourceNeutralToolpathSha256": source_neutral_sha256,
        "neutralToolpathSha256": [source_neutral_sha256, sha256_file(neutral_path)],
        "neutralToolpathWithoutContactReportSha256": sha256_json_without_contact_report(neutral),
    })
    return {
        "status": "completed",
        "error": None,
        "neutralToolpathPath": str(neutral_path),
        "cutterEnvelopeReportPath": contact_report["path"],
        "cutterContactReport": contact_report,
        "synthetic": False,
        "imported": True,
        "sourcePath": str(source_path),
        "handoffEvidence": classify_neutral_output(neutral, {
            "fixture": bool(neutral.get("fixture")),
            "synthetic": False,
            "previewScaffold": bool(neutral.get("experimentalHeightfield")) or contact_report["previewScaffold"],
            "heightfieldPreview": bool(neutral.get("experimentalHeightfield")),
            "generatedByExternalCommand": False,
            "imported": True,
            "contactReportProductionCandidate": contact_report["productionCandidate"],
            "contactReportMissing": contact_report["status"] == "missing",
            "contactReportStatus": contact_report["status"],
        }),
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


def evaluate_cutter_contact_report(neutral_path: Path, neutral: Dict[str, Any], expected_identity: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    embedded = neutral.get("cutterContactReport")
    if isinstance(embedded, dict):
        return summarize_cutter_contact_report(embedded, None, expected_identity)
    explicit_path = neutral.get("cutterContactReportPath") or neutral.get("cutterEnvelopeReportPath")
    if isinstance(explicit_path, str) and explicit_path:
        path = Path(explicit_path)
        if path.exists():
            loaded = read_optional_contact_report(path)
            if loaded is not None:
                return summarize_cutter_contact_report(loaded, str(path), expected_identity)
    runner = neutral.get("runner") if isinstance(neutral.get("runner"), dict) else {}
    heightfield = runner.get("heightfield") if isinstance(runner.get("heightfield"), dict) else {}
    reported = heightfield.get("cutterEnvelopeReport")
    if isinstance(reported, str) and reported:
        path = Path(reported)
        if path.exists():
            loaded = read_optional_contact_report(path)
            if loaded is not None:
                return summarize_cutter_contact_report(loaded, str(path), expected_identity)
    sibling = neutral_path.with_name("opencamlib-cutter-envelope-report.json")
    if sibling.exists():
        loaded = read_optional_contact_report(sibling)
        if loaded is not None:
            return summarize_cutter_contact_report(loaded, str(sibling), expected_identity)
    return {
        "schema": "hediao3d.opencamlib-contact-report-summary.v1",
        "status": "missing",
        "path": None,
        "reportSchema": None,
        "productionCandidate": False,
        "postprocessEligible": False,
        "previewScaffold": False,
        "summary": "OpenCAMLib neutral output does not include a cutter-contact/envelope report.",
    }


def read_optional_contact_report(path: Path) -> Optional[Dict[str, Any]]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return report if isinstance(report, dict) else None


def summarize_cutter_contact_report(report: Dict[str, Any], path: Optional[str], expected_identity: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    schema = str(report.get("schema") or "")
    quality = report.get("quality") if isinstance(report.get("quality"), dict) else {}
    level = str(quality.get("level") or report.get("level") or "")
    identity_binding = evaluate_contact_report_input_identity(report, expected_identity)
    strict_evidence = evaluate_contact_report_strict_evidence(report)
    preview_scaffold = (
        "preview" in schema.lower()
        or "envelope-report" in schema.lower()
        or "preview" in level.lower()
        or "scaffold" in level.lower()
        or bool(quality.get("previewScaffold"))
    )
    production_candidate = (
        schema == "hediao3d.opencamlib-cutter-contact-report.v1"
        and bool(quality.get("productionCandidate"))
        and bool(quality.get("postprocessEligible"))
        and not preview_scaffold
        and identity_binding["status"] == "bound"
        and strict_evidence["status"] == "ready"
    )
    status = "production-candidate" if production_candidate else "preview-scaffold" if preview_scaffold else "review"
    return {
        "schema": "hediao3d.opencamlib-contact-report-summary.v1",
        "status": status,
        "path": path,
        "reportSchema": schema or None,
        "productionCandidate": production_candidate,
        "postprocessEligible": bool(quality.get("postprocessEligible")),
        "previewScaffold": preview_scaffold,
        "samplingQuality": (report.get("contactSampling") or {}).get("samplingQuality") if isinstance(report.get("contactSampling"), dict) else None,
        "strictEvidence": strict_evidence,
        "inputIdentityBinding": identity_binding,
        "summary": quality.get("summary") or report.get("summary") or "OpenCAMLib cutter-contact report evaluated.",
    }


def evaluate_contact_report_strict_evidence(report: Dict[str, Any]) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    tool = report.get("tool") if isinstance(report.get("tool"), dict) else {}
    sampling = report.get("contactSampling") if isinstance(report.get("contactSampling"), dict) else {}
    residual = report.get("residualMaterial") if isinstance(report.get("residualMaterial"), dict) else {}
    tolerances = report.get("tolerances") if isinstance(report.get("tolerances"), dict) else {}
    algorithm = str(sampling.get("algorithm") or report.get("mode") or "")
    max_gouge_tolerance = number_or_none(tolerances.get("maxGougeMm"))
    max_undercut_tolerance = number_or_none(tolerances.get("maxUndercutMm"))
    if max_gouge_tolerance is None:
        max_gouge_tolerance = 0.03
    if max_undercut_tolerance is None:
        max_undercut_tolerance = 0.08
    max_gouge = number_or_none(residual.get("maxGougeMm"))
    max_undercut = number_or_none(residual.get("maxUndercutMm"))
    hit_rate = number_or_none(sampling.get("hitRate"))
    sampling_quality = sampling.get("samplingQuality") if isinstance(sampling.get("samplingQuality"), dict) else {}
    step_ratio = number_or_none(sampling.get("stepToCutterRatio") if sampling.get("stepToCutterRatio") is not None else sampling_quality.get("stepToCutterRatio"))
    point_count = number_or_none(sampling.get("pointCount"))
    contact_point_count = number_or_none(sampling.get("contactPointCount") or sampling.get("pointCount"))

    add_strict_check(
        checks,
        "contact-algorithm-real",
        bool(re.search(r"(drop-cutter|cutter-contact|waterline)", algorithm, re.I)) and not bool(re.search(r"(preview|heightfield|scaffold|fixture|synthetic)", algorithm, re.I)),
        f"algorithm={algorithm or 'missing'}",
    )
    add_strict_check(checks, "contact-tool-diameter", number_or_none(tool.get("diameterMm")) is not None and number_or_none(tool.get("diameterMm")) > 0, f"diameterMm={tool.get('diameterMm')}")
    add_strict_check(checks, "contact-tool-angle", number_or_none(tool.get("angleDeg")) is not None and number_or_none(tool.get("angleDeg")) > 0, f"angleDeg={tool.get('angleDeg')}")
    add_strict_check(checks, "contact-tool-flat-tip", number_or_none(tool.get("flatTipMm")) is not None and number_or_none(tool.get("flatTipMm")) >= 0, f"flatTipMm={tool.get('flatTipMm')}")
    add_strict_check(checks, "contact-sampling-hit-rate", hit_rate is not None and hit_rate >= 0.995, f"hitRate={hit_rate}")
    add_strict_check(checks, "contact-sampling-point-count", point_count is not None and point_count > 0 and contact_point_count is not None and contact_point_count > 0, f"pointCount={point_count}, contactPointCount={contact_point_count}")
    add_strict_check(checks, "contact-sampling-step-ratio", step_ratio is not None and step_ratio <= 0.25, f"stepToCutterRatio={step_ratio}")
    add_strict_check(checks, "contact-residual-gouge", max_gouge is not None and max_gouge <= max_gouge_tolerance, f"maxGougeMm={max_gouge}, tolerance={max_gouge_tolerance}")
    add_strict_check(checks, "contact-residual-undercut", max_undercut is not None and max_undercut <= max_undercut_tolerance, f"maxUndercutMm={max_undercut}, tolerance={max_undercut_tolerance}")

    failed = [check for check in checks if check["status"] != "pass"]
    return {
        "schema": "hediao3d.opencamlib-contact-strict-evidence.v1",
        "status": "ready" if not failed else "review",
        "ready": len(failed) == 0,
        "checkCount": len(checks),
        "failedCheckCount": len(failed),
        "checks": checks,
        "summary": "strict contact evidence ready" if not failed else f"strict contact evidence missing/weak: {failed[0]['id']} {failed[0]['summary']}",
    }


def add_strict_check(checks: List[Dict[str, Any]], check_id: str, passed: bool, summary: str) -> None:
    checks.append({
        "id": check_id,
        "status": "pass" if passed else "fail",
        "summary": summary,
    })


def number_or_none(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def evaluate_contact_report_input_identity(report: Dict[str, Any], expected_identity: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    identity = report.get("inputIdentity") if isinstance(report.get("inputIdentity"), dict) else {}
    if not expected_identity:
        return {
            "schema": "hediao3d.opencamlib-contact-report-input-binding.v1",
            "status": "not-checked",
            "summary": "No expected input identity was available for this contact report.",
        }
    acceptable_neutral_hashes = set()
    neutral_expected = expected_identity.get("neutralToolpathSha256")
    if isinstance(neutral_expected, list):
        acceptable_neutral_hashes.update(str(item) for item in neutral_expected if item)
    elif neutral_expected:
        acceptable_neutral_hashes.add(str(neutral_expected))
    source_expected = expected_identity.get("sourceNeutralToolpathSha256")
    if source_expected:
        acceptable_neutral_hashes.add(str(source_expected))
    without_contact_expected = expected_identity.get("neutralToolpathWithoutContactReportSha256")
    if without_contact_expected:
        acceptable_neutral_hashes.add(str(without_contact_expected))

    reported_neutral_hashes = [
        identity.get("neutralToolpathSha256"),
        identity.get("sourceNeutralToolpathSha256"),
        identity.get("neutralToolpathWithoutContactReportSha256"),
        identity.get("externalNeutralToolpathSha256"),
    ]
    neutral_match = any(str(value) in acceptable_neutral_hashes for value in reported_neutral_hashes if value)

    required_checks: List[Dict[str, Any]] = []
    optional_checks: List[Dict[str, Any]] = []
    for key in ("modelSha256", "planSha256"):
        expected = expected_identity.get(key)
        reported = identity.get(key)
        if expected:
            required_checks.append({
                "field": key,
                "expected": expected,
                "reported": reported,
                "required": True,
                "matches": bool(reported) and str(expected) == str(reported),
            })
        elif reported:
            optional_checks.append({
                "field": key,
                "expected": None,
                "reported": reported,
                "required": False,
                "matches": True,
            })
    required_mismatch = any(check["matches"] is False for check in required_checks)
    required_missing = any(not check.get("reported") for check in required_checks)
    has_reported_identity = any(value for value in reported_neutral_hashes) or bool(required_checks) or bool(optional_checks)
    if neutral_match and not required_mismatch and not required_missing:
        status = "bound"
    elif has_reported_identity:
        status = "incomplete" if neutral_match and required_missing and not required_mismatch else "mismatch"
    else:
        status = "missing"
    return {
        "schema": "hediao3d.opencamlib-contact-report-input-binding.v1",
        "status": status,
        "neutralToolpathHashMatched": neutral_match,
        "requiredChecks": required_checks,
        "optionalChecks": optional_checks,
        "summary": "Contact report input identity matches neutral source/output hash, model hash and plan hash."
        if status == "bound"
        else "Contact report is missing or mismatches required neutral/model/plan identity; it cannot be a production candidate.",
    }


def sha256_file(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, TypeError, ValueError):
        return None


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json_without_contact_report(value: Dict[str, Any]) -> str:
    copy = dict(value)
    copy.pop("cutterContactReport", None)
    copy.pop("cutterContactReportPath", None)
    copy.pop("cutterEnvelopeReportPath", None)
    return hashlib.sha256(json.dumps(copy, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()


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
        attempt = attempt_experimental_kernel_output(job, plan, job_path, artifact_paths["opencamlibKernelPlan"])
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
                "opencamlibRuntimeProbe": summarize_runtime_probe_artifact(artifact_paths.get("opencamlibRuntimeProbe")),
                "neutralToolpath": {
                    "status": "generated" if attempt.get("neutralToolpathPath") else "not_generated",
                    "path": attempt.get("neutralToolpathPath"),
                    "cutterEnvelopeReportPath": attempt.get("cutterEnvelopeReportPath"),
                    "cutterContactReport": attempt.get("cutterContactReport"),
                    "synthetic": bool(attempt.get("synthetic")),
                    "imported": bool(attempt.get("imported")),
                    "fixture": bool(attempt.get("fixture")),
                    "heightfieldPreview": bool(attempt.get("heightfieldPreview")),
                    "previewScaffold": bool(attempt.get("previewScaffold")),
                    "pointCount": attempt.get("pointCount"),
                    "generatedByExternalCommand": bool(attempt.get("externalCommand")),
                    "autoRunner": bool(attempt.get("autoRunner")),
                    "schema": "hediao3d.neutral-toolpath.v1" if attempt.get("neutralToolpathPath") else None,
                },
                "handoffEvidence": attempt.get("handoffEvidence") or create_missing_handoff_evidence(ENGINE, "neutral-toolpath", attempt),
                "externalCommand": attempt.get("externalCommand"),
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


def classify_neutral_output(neutral: Dict[str, Any], flags: Dict[str, Any]) -> Dict[str, Any]:
    points = neutral.get("points") if isinstance(neutral, dict) else []
    point_count = len(points) if isinstance(points, list) else 0
    fixture = bool(flags.get("fixture"))
    synthetic = bool(flags.get("synthetic"))
    preview_scaffold = bool(flags.get("previewScaffold"))
    heightfield_preview = bool(flags.get("heightfieldPreview"))
    contact_report_production_candidate = bool(flags.get("contactReportProductionCandidate"))
    contact_report_missing = bool(flags.get("contactReportMissing"))
    if synthetic:
        classification = "synthetic-contract"
    elif fixture:
        classification = "fixture-contract"
    elif preview_scaffold or heightfield_preview:
        classification = "preview-scaffold"
    elif contact_report_missing:
        classification = "missing-contact-report"
    elif not contact_report_production_candidate:
        classification = "contact-report-review"
    else:
        classification = "production-candidate"
    return {
        "schema": "hediao3d.adapter-handoff-evidence.v1",
        "engine": ENGINE,
        "outputKind": "neutral-toolpath",
        "classification": classification,
        "fixture": fixture,
        "synthetic": synthetic,
        "previewScaffold": preview_scaffold,
        "heightfieldPreview": heightfield_preview,
        "imported": bool(flags.get("imported")),
        "generatedByExternalCommand": bool(flags.get("generatedByExternalCommand")),
        "contactReportStatus": flags.get("contactReportStatus"),
        "pointCount": point_count,
        "productionCandidate": point_count > 0 and classification == "production-candidate",
        "productionBoundary": "This evidence classifies neutral adapter output only; HeDiao3D production gates still require CAMotics/material removal, postprocess validation, static NC analysis, air-run, trial feedback and machine acceptance.",
    }


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
        "pointCount": 0,
        "productionCandidate": False,
        "productionBoundary": "No external neutral output was generated; production NC remains locked.",
    }


def summarize_runtime_probe_artifact(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return {
            "schema": "hediao3d.opencamlib-runtime-probe-summary.v1",
            "status": "missing",
            "path": None,
            "summary": "OpenCAMLib runtime probe artifact was not generated.",
        }
    try:
        report = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "schema": "hediao3d.opencamlib-runtime-probe-summary.v1",
            "status": "unreadable",
            "path": path,
            "summary": "OpenCAMLib runtime probe artifact exists but could not be parsed.",
        }
    capability = report.get("capabilitySummary") if isinstance(report.get("capabilitySummary"), dict) else {}
    return {
        "schema": "hediao3d.opencamlib-runtime-probe-summary.v1",
        "status": report.get("level") or "unknown",
        "path": path,
        "reportSchema": report.get("schema"),
        "selectedModule": report.get("selectedModule"),
        "dropCutterReady": bool(capability.get("dropCutterReady")),
        "surfaceCandidateCount": capability.get("surfaceCandidateCount"),
        "cutterCandidateCount": capability.get("cutterCandidateCount"),
        "dropCutterCandidateCount": capability.get("dropCutterCandidateCount"),
        "productionBoundary": report.get("productionBoundary"),
        "summary": capability.get("summary") or "OpenCAMLib runtime probe generated.",
    }


if __name__ == "__main__":
    raise SystemExit(main())
