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
import hashlib
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
                "freecadOperationHint": freecad_operation_hint(operation, settings),
                "validationState": freecad_operation_validation_state(operation, settings),
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


def freecad_operation_hint(operation: Dict[str, Any], settings: Dict[str, Any]) -> str:
    strategy = str(operation.get("strategy") or "").lower()
    cam_mode = settings.get("camMode")
    if "rough" in strategy:
        return "Path Surface roughing or Pocket/Profile roughing on prepared relief stock"
    if "rest" in strategy or "detail" in strategy:
        return "Path Engrave/Pocket rest-detail pass after verified finishing stock"
    if cam_mode == "rotaryWrap":
        return "Path Surface/Parallel finishing on unwrapped X/Y heightfield; HeDiao3D performs final Y/A rotary wrap"
    return "Path Surface parallel finishing or Profile finishing on 3-axis relief"


def freecad_operation_validation_state(operation: Dict[str, Any], settings: Dict[str, Any]) -> str:
    if not operation.get("enabled"):
        return "disabled"
    strategy = str(operation.get("strategy") or "").lower()
    cam_mode = settings.get("camMode")
    if cam_mode == "rotaryWrap":
        return "requires-unwrapped-heightfield-validation"
    if "rest" in strategy or "detail" in strategy:
        return "requires-rest-machining-validation"
    return "ready-for-cam-server-mapping-test"


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
    return "\n".join([
        "# Auto-generated by HeDiao3D FreeCAD adapter.",
        "# Review and run with FreeCADCmd/freecadcmd on the CAM server.",
        "# This template is fail-closed: it prepares a real Path Job skeleton but",
        "# does not claim production readiness until the operation recipe is validated.",
        "from pathlib import Path",
        "import os",
        "import FreeCAD",
        "",
        "try:",
        "    import Mesh",
        "except Exception:",
        "    Mesh = None",
        "",
        "try:",
        "    import Part",
        "except Exception:",
        "    Part = None",
        "",
        "try:",
        "    import Path",
        "    from PathScripts import PathJob",
        "    from PathScripts import PathToolController",
        "    from PathScripts import PathPostProcessor",
        "except Exception as exc:",
        "    raise RuntimeError(f'FreeCAD Path/CAM Workbench is unavailable: {exc}')",
        "",
        f"PLAN = {json.dumps(plan, ensure_ascii=False, indent=2)}",
        "OUTPUT_GCODE = Path(PLAN['expectedArtifacts']['gcode'])",
        "",
        "def import_model(doc):",
        "    model_path = PLAN['model']['path']",
        "    fmt = PLAN['model']['format']",
        "    if fmt in ('stl', 'obj'):",
        "        if Mesh is None:",
        "            raise RuntimeError('Mesh module is unavailable; cannot import STL/OBJ.')",
        "        mesh = Mesh.Mesh(model_path)",
        "        obj = doc.addObject('Mesh::Feature', 'HeDiao3D_ImportedMesh')",
        "        obj.Mesh = mesh",
        "        return obj",
        "    if fmt in ('step', 'stp', 'iges', 'igs'):",
        "        if Part is None:",
        "            raise RuntimeError('Part module is unavailable; cannot import CAD solids.')",
        "        shape = Part.Shape()",
        "        shape.read(model_path)",
        "        obj = doc.addObject('Part::Feature', 'HeDiao3D_ImportedSolid')",
        "        obj.Shape = shape",
        "        return obj",
        "    raise RuntimeError(f'Unsupported FreeCAD CAM input format: {fmt}. Convert GLB/GLTF before this step.')",
        "",
        "def create_path_job(doc, base_obj):",
        "    job = PathJob.Create('HeDiao3D_FreeCAD_Job', [base_obj], None)",
        "    job.Label = f\"HeDiao3D CAM {PLAN['jobId']}\"",
        "    stock = PLAN.get('stock') or {}",
        "    job.PostProcessor = 'linuxcnc'",
        "    job.PostProcessorArgs = '--no-show-editor'",
        "    job.SetupSheet.HorizRapid = float((PLAN.get('tool') or {}).get('feedRateMmMin') or 300)",
        "    job.SetupSheet.VertRapid = float((PLAN.get('tool') or {}).get('feedRateMmMin') or 300)",
        "    job.SetupSheet.SafeHeight = 5.0",
        "    job.SetupSheet.ClearanceHeight = 8.0",
        "    job.Stock.ExtXneg = 0",
        "    job.Stock.ExtXpos = 0",
        "    job.Stock.ExtYneg = 0",
        "    job.Stock.ExtYpos = 0",
        "    job.Stock.ExtZneg = 0",
        "    job.Stock.ExtZpos = 0",
        "    job.Proxy.execute(job)",
        "    return job",
        "",
        "def create_tool_controller(doc, job):",
        "    tool = PLAN.get('tool') or {}",
        "    controller = PathToolController.Create('HeDiao3D_ToolController')",
        "    controller.Label = f\"{tool.get('toolProfileId') or 'tool'} {tool.get('diameterMm') or ''}mm\"",
        "    controller.HorizFeed = float(tool.get('feedRateMmMin') or 180)",
        "    controller.VertFeed = float(tool.get('feedRateMmMin') or 180)",
        "    controller.SpindleSpeed = int(float(tool.get('spindleRpm') or 12000))",
        "    if hasattr(job, 'Tools') and controller not in job.Tools:",
        "        job.Tools = list(job.Tools) + [controller]",
        "    return controller",
        "",
        "def add_operations(doc, job, controller):",
        "    enabled = [op for op in PLAN.get('operations', []) if op.get('enabled')]",
        "    if not enabled:",
        "        raise RuntimeError('No enabled CAM operations in FreeCAD plan.')",
        "    mapping_rows = []",
        "    for op in enabled:",
        "        mapping_rows.append(f\"{op.get('id')} -> {op.get('freecadOperationHint')} [{op.get('validationState')}]\")",
        "    print('HeDiao3D FreeCAD operation mapping:')",
        "    for row in mapping_rows:",
        "        print(' -', row)",
        "    # Deployment TODO: replace this guard with validated FreeCAD Path",
        "    # operation creation for the exact installed FreeCAD version. Do not",
        "    # silently emit a generic path: the mapping must match the stock, tool,",
        "    # controller dialect and HeDiao3D rotary-wrap postprocess policy.",
        "    if os.environ.get('HEDIAO3D_FREECAD_TEMPLATE_ALLOW_UNVALIDATED_OPS', '').lower() not in ('1', 'true', 'yes', 'on'):",
        "        raise RuntimeError('FreeCAD Path operation mapping is not validated yet: ' + '; '.join(mapping_rows) + '. Set HEDIAO3D_FREECAD_TEMPLATE_ALLOW_UNVALIDATED_OPS only on a CAM test server.')",
        "    return enabled",
        "",
        "def postprocess(job):",
        "    OUTPUT_GCODE.parent.mkdir(parents=True, exist_ok=True)",
        "    processor = (PLAN.get('postprocess') or {}).get('postProcessor') or 'linuxcnc'",
        "    # FreeCAD postprocessor APIs vary by version; the deployment server must",
        "    # validate this call with its installed Path Workbench before production use.",
        "    PathPostProcessor.export([job], str(OUTPUT_GCODE), processor, '--no-show-editor')",
        "    if not OUTPUT_GCODE.exists() or OUTPUT_GCODE.stat().st_size <= 0:",
        "        raise RuntimeError(f'FreeCAD postprocess did not write G-code: {OUTPUT_GCODE}')",
        "",
        "doc = FreeCAD.newDocument('HeDiao3D_CAM')",
        "base_obj = import_model(doc)",
        "doc.recompute()",
        "job = create_path_job(doc, base_obj)",
        "tool_controller = create_tool_controller(doc, job)",
        "enabled_operations = add_operations(doc, job, tool_controller)",
        "doc.recompute()",
        "postprocess(job)",
        "print('HeDiao3D FreeCAD CAM template finished:', PLAN['jobId'], 'operations=', len(enabled_operations), 'gcode=', OUTPUT_GCODE)",
        "",
    ])


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
    proof = load_cam_output_proof(gcode_path)
    output_evidence = classify_gcode_output(gcode, command_parts, proof, gcode_path, job, plan_path)
    return {
        "status": "completed",
        "error": None,
        "gcodePath": str(gcode_path),
        "synthetic": False,
        "fixture": output_evidence["fixture"],
        "previewScaffold": output_evidence["previewScaffold"],
        "handoffEvidence": output_evidence,
        "camOutputProof": output_evidence.get("camOutputProof"),
        "externalCommand": command_report,
    }


def load_cam_output_proof(gcode_path: Path) -> Optional[Dict[str, Any]]:
    proof_override = os.environ.get("HEDIAO3D_FREECAD_CAM_OUTPUT_PROOF_JSON")
    candidates = [Path(proof_override)] if proof_override else [Path(f"{gcode_path}.cam-proof.json")]
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            proof = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return {
                "schema": "hediao3d.freecad-cam-output-report.v1",
                "path": str(candidate),
                "valid": False,
                "error": f"failed to read CAM output proof: {exc}",
            }
        if isinstance(proof, dict):
            proof["path"] = str(candidate)
            return proof
        return {
            "schema": "hediao3d.freecad-cam-output-report.v1",
            "path": str(candidate),
            "valid": False,
            "error": "CAM output proof must be a JSON object.",
        }
    return None


def evaluate_cam_output_proof(proof: Optional[Dict[str, Any]], gcode: str, gcode_path: Path, motion_count: int, fixture: bool, preview_scaffold: bool, job: Dict[str, Any], plan_path: Path) -> Dict[str, Any]:
    if not proof:
        return {
            "present": False,
            "status": "missing-cam-proof",
            "productionCandidate": False,
            "postprocessEligible": False,
            "issues": ["External FreeCAD G-code needs a companion CAM output proof before it can be a production candidate."],
        }
    allowed_schemas = {"hediao3d.freecad-cam-output-report.v1", "hediao3d.external-cam-output-report.v1"}
    quality = proof.get("quality") if isinstance(proof.get("quality"), dict) else {}
    artifacts = proof.get("artifacts") if isinstance(proof.get("artifacts"), dict) else {}
    expected_hash = str(proof.get("gcodeSha256") or artifacts.get("gcodeSha256") or "").lower()
    actual_hash = hashlib.sha256(gcode.encode("utf-8")).hexdigest()
    expected_job_id = str(proof.get("jobId") or artifacts.get("jobId") or "")
    actual_job_id = str(job.get("jobId") or "")
    expected_model_hash = str(proof.get("modelSha256") or artifacts.get("modelSha256") or "").lower()
    actual_model_hash = sha256_file(Path(str(job.get("modelPath") or "")))
    expected_plan_hash = str(proof.get("planSha256") or artifacts.get("planSha256") or "").lower()
    actual_plan_hash = sha256_file(plan_path)
    issues: List[str] = []
    if proof.get("schema") not in allowed_schemas:
        issues.append("unsupported CAM output proof schema")
    if str(proof.get("engine") or "").lower() not in {ENGINE, "freecad cam", "freecad path"}:
        issues.append("CAM output proof engine does not match FreeCAD")
    if not expected_hash:
        issues.append("CAM output proof must include gcodeSha256")
    if expected_hash and expected_hash != actual_hash:
        issues.append("CAM output proof G-code SHA-256 does not match current output")
    if not expected_job_id:
        issues.append("CAM output proof must include jobId")
    if expected_job_id and expected_job_id != actual_job_id:
        issues.append("CAM output proof jobId does not match current adapter job")
    if not expected_model_hash:
        issues.append("CAM output proof must include modelSha256")
    if expected_model_hash and expected_model_hash != actual_model_hash:
        issues.append("CAM output proof model SHA-256 does not match current model")
    if not expected_plan_hash:
        issues.append("CAM output proof must include planSha256")
    if expected_plan_hash and expected_plan_hash != actual_plan_hash:
        issues.append("CAM output proof plan SHA-256 does not match current CAM plan")
    if fixture or bool(proof.get("fixture")) or bool(quality.get("fixture")):
        issues.append("fixture output cannot be a production candidate")
    if preview_scaffold or bool(proof.get("previewScaffold")) or bool(quality.get("previewScaffold")):
        issues.append("preview/scaffold output cannot be a production candidate")
    if motion_count <= 0:
        issues.append("G-code contains no G0/G1 motion")
    production_candidate = bool(quality.get("productionCandidate")) and bool(quality.get("postprocessEligible")) and not issues
    return {
        "present": True,
        "status": "production-candidate" if production_candidate else "cam-proof-review",
        "path": proof.get("path"),
        "schema": proof.get("schema"),
        "engine": proof.get("engine"),
        "gcodeSha256": actual_hash,
        "declaredGcodeSha256": expected_hash or None,
        "jobId": actual_job_id,
        "declaredJobId": expected_job_id or None,
        "modelSha256": actual_model_hash,
        "declaredModelSha256": expected_model_hash or None,
        "planSha256": actual_plan_hash,
        "declaredPlanSha256": expected_plan_hash or None,
        "productionCandidate": production_candidate,
        "postprocessEligible": bool(quality.get("postprocessEligible")),
        "quality": quality,
        "issues": issues,
    }


def classify_gcode_output(gcode: str, command_parts: List[str], proof: Optional[Dict[str, Any]], gcode_path: Path, job: Dict[str, Any], plan_path: Path) -> Dict[str, Any]:
    upper = gcode.upper()
    fixture = is_true(os.environ.get("HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT")) or "FREECAD EXTERNAL RUNNER FIXTURE" in upper
    preview_scaffold = "PREVIEW" in upper or "SCAFFOLD" in upper
    motion_count = len([line for line in upper.splitlines() if line.strip().startswith(("G0", "G1"))])
    proof_evaluation = evaluate_cam_output_proof(proof, gcode, gcode_path, motion_count, fixture, preview_scaffold, job, plan_path)
    classification = "fixture-contract" if fixture else "preview-scaffold" if preview_scaffold else proof_evaluation["status"]
    production_candidate = motion_count > 0 and classification == "production-candidate" and bool(proof_evaluation["productionCandidate"])
    return {
        "schema": "hediao3d.adapter-handoff-evidence.v1",
        "engine": ENGINE,
        "outputKind": "gcode",
        "classification": classification,
        "fixture": fixture,
        "synthetic": False,
        "previewScaffold": preview_scaffold,
        "generatedByExternalCommand": True,
        "motionCount": motion_count,
        "commandHead": command_parts[:3],
        "productionCandidate": production_candidate,
        "camOutputProof": proof_evaluation,
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


def sha256_file(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, ValueError):
        return None


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
