#!/usr/bin/env python3
"""Deployable OpenCAMLib neutral-toolpath runner scaffold for HeDiao3D V3.

Run target:
  python adapters/opencamlib/opencamlib_runner.py job.json opencamlib-kernel-plan.json neutral-toolpath.json

This script is the command target for HEDIAO3D_OPENCAMLIB_EXTERNAL_COMMAND_JSON.
It owns the server-side boundary between a real OpenCAMLib/drop-cutter
implementation and the HeDiao3D adapter contract.

Current state:
- validates job/plan/output arguments;
- detects opencamlib/ocl Python modules;
- writes a strict non-synthetic neutral-toolpath fixture only when
  HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT=true is set;
- otherwise fails closed until the deployment server implements and validates
  the real OpenCAMLib surface/cutter-contact algorithm.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


NEUTRAL_SCHEMA = "hediao3d.neutral-toolpath.v1"
PLAN_SCHEMA = "hediao3d.opencamlib-kernel-plan.v1"


def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: opencamlib_runner.py <job.json> <opencamlib-kernel-plan.json> <neutral-toolpath.json>", file=sys.stderr)
        return 2

    job_path = Path(sys.argv[1])
    plan_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    try:
        job = read_json(job_path)
        plan = read_json(plan_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Failed to read runner input JSON: {exc}", file=sys.stderr)
        return 2

    errors = validate_inputs(job, plan)
    if errors:
        print("Invalid OpenCAMLib runner input: " + "; ".join(errors), file=sys.stderr)
        return 2

    detection = detect_opencamlib()
    geometry = analyze_model_geometry(plan)
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_RUNNER_FIXTURE_OUTPUT")):
        neutral = create_fixture_neutral_toolpath(job, plan, detection, geometry)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "mode": "fixture",
            "schema": neutral["schema"],
            "points": len(neutral["points"]),
            "output": str(output_path),
            "opencamlibAvailable": detection["available"],
            "geometry": geometry,
        }, ensure_ascii=False))
        return 0

    if not detection["available"]:
        print("OpenCAMLib/ocl Python module is not available. Install it or use fixture mode only for contract tests.", file=sys.stderr)
        return 3

    print(
        "OpenCAMLib module detected, but real drop-cutter generation is not implemented in this runner yet. "
        "Keep production NC locked until this runner writes validated cutter-contact neutral output.",
        file=sys.stderr,
    )
    return 4


def read_json(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def validate_inputs(job: Dict[str, Any], plan: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if not job.get("jobId"):
        errors.append("job.jobId is required")
    if not isinstance(job.get("settings"), dict):
        errors.append("job.settings object is required")
    if plan.get("schema") != PLAN_SCHEMA:
        errors.append(f"plan.schema must be {PLAN_SCHEMA}")
    if plan.get("engine") != "opencamlib":
        errors.append("plan.engine must be opencamlib")
    model = plan.get("model") or {}
    if not model.get("path"):
        errors.append("plan.model.path is required")
    tool = plan.get("tool") or {}
    if not is_positive_number(tool.get("diameterMm")):
        errors.append("plan.tool.diameterMm must be positive")
    sampling = plan.get("sampling") or {}
    axis_mapping = sampling.get("axisMapping") or {}
    if axis_mapping.get("depthAxis") != "Z":
        errors.append("plan.sampling.axisMapping.depthAxis must be Z")
    if not isinstance(plan.get("operations"), list):
        errors.append("plan.operations array is required")
    return errors


def detect_opencamlib() -> Dict[str, Any]:
    modules: Dict[str, Any] = {}
    selected: Optional[Dict[str, Any]] = None
    for name in ("opencamlib", "ocl"):
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
    }


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


def analyze_model_geometry(plan: Dict[str, Any]) -> Dict[str, Any]:
    model = plan.get("model") or {}
    model_path = Path(str(model.get("path") or ""))
    fmt = str(model.get("format") or model_path.suffix.lower().lstrip(".")).lower()
    summary: Dict[str, Any] = {
        "schema": "hediao3d.opencamlib-runner-geometry.v1",
        "path": str(model_path),
        "format": fmt or None,
        "exists": model_path.exists(),
        "supportedParser": fmt == "stl",
        "triangleCount": 0,
        "vertexCount": 0,
        "bounds": None,
        "dimensions": None,
        "warnings": [],
    }
    if not model_path.exists():
        summary["warnings"].append("model file does not exist; runner can only emit fixture geometry until model conversion is wired.")
        return summary
    if fmt != "stl":
        summary["warnings"].append(f"runner geometry parser currently supports ASCII STL only, got {fmt or 'unknown'}.")
        return summary
    try:
        text = model_path.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        summary["warnings"].append(f"failed to read model: {exc}")
        return summary
    vertices = parse_ascii_stl_vertices(text)
    if not vertices:
        summary["warnings"].append("no ASCII STL vertices parsed; binary STL parsing is not implemented in this runner scaffold.")
        return summary
    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    min_bounds = {"x": min(xs), "y": min(ys), "z": min(zs)}
    max_bounds = {"x": max(xs), "y": max(ys), "z": max(zs)}
    summary.update({
        "triangleCount": len(vertices) // 3,
        "vertexCount": len(vertices),
        "bounds": {
            "min": min_bounds,
            "max": max_bounds,
        },
        "dimensions": {
            "x": round(max_bounds["x"] - min_bounds["x"], 6),
            "y": round(max_bounds["y"] - min_bounds["y"], 6),
            "z": round(max_bounds["z"] - min_bounds["z"], 6),
        },
    })
    return summary


def parse_ascii_stl_vertices(text: str) -> List[List[float]]:
    vertices: List[List[float]] = []
    for match in re.finditer(r"vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", text):
        vertices.append([float(match.group(1)), float(match.group(2)), float(match.group(3))])
    return vertices


def create_fixture_neutral_toolpath(job: Dict[str, Any], plan: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any]) -> Dict[str, Any]:
    settings = job.get("settings") or {}
    stock = plan.get("stock") or {}
    sampling = plan.get("sampling") or {}
    axis_mapping = sampling.get("axisMapping") or {}
    length = float(stock.get("lengthMm") or settings.get("lengthMm") or 38)
    safe_z = float(settings.get("safeZ") or 22)
    depth = max(0.1, float(settings.get("depthMm") or settings.get("maxCutDepth") or 1.2))
    rotary_axis = axis_mapping.get("rotaryAxis") or settings.get("rotaryOutputAxis") or "Y"
    angles = [0, 60, 120, 180, 240, 300]
    cols = 8
    points: List[Dict[str, Any]] = []
    for angle_index, angle in enumerate(angles):
        for col in range(cols):
            t = col / (cols - 1)
            x = -length / 2 + length * t
            center_weight = max(0.0, 1 - abs(0.5 - t) * 1.65)
            ring_weight = 0.92 + 0.08 * ((angle_index % 2) * 2 - 1)
            cut_depth = depth * (0.28 + 0.64 * center_weight * ring_weight)
            points.append({
                "x": round(x, 4),
                "a": angle,
                "z": round(safe_z - cut_depth, 4),
                "depth": round(cut_depth, 4),
                "source": "opencamlib-runner-fixture",
            })

    return {
        "schema": NEUTRAL_SCHEMA,
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "synthetic": False,
        "fixture": True,
        "generatedBy": "adapters/opencamlib/opencamlib_runner.py",
        "generatedByExternalCommand": True,
        "coordinate": {
            "lengthAxis": "X",
            "rotaryAxis": rotary_axis,
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        },
        "estimatedMinutes": 1.4,
        "points": points,
        "runner": {
            "mode": "fixture-contract",
            "opencamlibAvailable": detection["available"],
            "opencamlibModule": detection["module"],
            "geometry": geometry,
            "warning": "Fixture mode validates the external command contract only; it is not real OpenCAMLib cutter-contact output.",
        },
        "planEcho": {
            "schema": plan.get("schema"),
            "recommendedPrimary": (plan.get("sampling") or {}).get("recommendedPrimary"),
            "operationCount": len(plan.get("operations") or []),
        },
    }


def is_positive_number(value: Any) -> bool:
    try:
        return float(value) > 0
    except (TypeError, ValueError):
        return False


def is_true(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    raise SystemExit(main())
