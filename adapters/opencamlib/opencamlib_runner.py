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
import struct
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
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT")):
        neutral = create_heightfield_neutral_toolpath(job, plan, detection, geometry)
        if neutral is None:
            print("STL heightfield output requested, but no valid surface samples could be generated.", file=sys.stderr)
            return 5
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "mode": "stl-heightfield-preview",
            "schema": neutral["schema"],
            "points": len(neutral["points"]),
            "missCount": neutral["runner"]["heightfield"]["missCount"],
            "output": str(output_path),
            "opencamlibAvailable": detection["available"],
        }, ensure_ascii=False))
        return 0
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
        "parser": None,
        "warnings": [],
    }
    if not model_path.exists():
        summary["warnings"].append("model file does not exist; runner can only emit fixture geometry until model conversion is wired.")
        return summary
    if fmt != "stl":
        summary["warnings"].append(f"runner geometry parser currently supports STL only, got {fmt or 'unknown'}.")
        return summary
    vertices, parser, warning = load_stl_vertices(model_path)
    if warning:
        summary["warnings"].append(warning)
    if not vertices:
        summary["warnings"].append("no STL vertices parsed.")
        return summary
    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    min_bounds = {"x": min(xs), "y": min(ys), "z": min(zs)}
    max_bounds = {"x": max(xs), "y": max(ys), "z": max(zs)}
    summary.update({
        "triangleCount": len(vertices) // 3,
        "vertexCount": len(vertices),
        "parser": parser,
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


def parse_binary_stl_vertices(data: bytes) -> List[List[float]]:
    if len(data) < 84:
        return []
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    expected_size = 84 + triangle_count * 50
    if triangle_count <= 0 or expected_size > len(data):
        return []
    vertices: List[List[float]] = []
    offset = 84
    for _ in range(triangle_count):
        offset += 12
        for _vertex_index in range(3):
            x, y, z = struct.unpack_from("<fff", data, offset)
            vertices.append([float(x), float(y), float(z)])
            offset += 12
        offset += 2
    return vertices


def load_stl_vertices(path: Path) -> List[Any]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        return [], None, f"failed to read model: {exc}"
    text = data[: min(len(data), 2_000_000)].decode("utf-8", errors="ignore")
    ascii_vertices = parse_ascii_stl_vertices(text)
    if ascii_vertices:
        return ascii_vertices, "ascii-stl", None
    binary_vertices = parse_binary_stl_vertices(data)
    if binary_vertices:
        return binary_vertices, "binary-stl", None
    return [], None, "STL parser could not detect ASCII or binary triangle records."


def parse_ascii_stl_triangles(plan: Dict[str, Any]) -> List[List[List[float]]]:
    model = plan.get("model") or {}
    model_path = Path(str(model.get("path") or ""))
    fmt = str(model.get("format") or model_path.suffix.lower().lstrip(".")).lower()
    if fmt != "stl" or not model_path.exists():
        return []
    vertices, _parser, _warning = load_stl_vertices(model_path)
    if not vertices:
        return []
    return [vertices[index:index + 3] for index in range(0, len(vertices) - 2, 3)]


def create_heightfield_neutral_toolpath(job: Dict[str, Any], plan: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    triangles = parse_ascii_stl_triangles(plan)
    bounds = geometry.get("bounds") or {}
    min_bounds = bounds.get("min") or {}
    max_bounds = bounds.get("max") or {}
    if not triangles or not min_bounds or not max_bounds:
        return None
    settings = job.get("settings") or {}
    stock = plan.get("stock") or {}
    sampling = plan.get("sampling") or {}
    axis_mapping = sampling.get("axisMapping") or {}
    safe_z = float(settings.get("safeZ") or 22)
    output_length = float(stock.get("lengthMm") or settings.get("lengthMm") or max(0.001, float(geometry.get("dimensions", {}).get("x") or 1)))
    output_depth = max(0.001, float(settings.get("depthMm") or settings.get("maxCutDepth") or max(0.001, float(geometry.get("dimensions", {}).get("z") or 1))))
    rotary_axis = axis_mapping.get("rotaryAxis") or settings.get("rotaryOutputAxis") or "Y"
    cols = max(2, int(float(os.environ.get("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS") or 8)))
    rows = max(2, int(float(os.environ.get("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS") or 6)))
    x_min = float(min_bounds["x"])
    x_max = float(max_bounds["x"])
    y_min = float(min_bounds["y"])
    y_max = float(max_bounds["y"])
    z_min = float(min_bounds["z"])
    z_max = float(max_bounds["z"])
    z_span = max(1e-9, z_max - z_min)
    points: List[Dict[str, Any]] = []
    miss_count = 0
    fallback_count = 0
    cell_radius = max(
        abs(x_max - x_min) / max(1, cols - 1),
        abs(y_max - y_min) / max(1, rows - 1),
    ) * 1.75
    for row in range(rows):
        row_t = row / (rows - 1)
        y = y_min + (y_max - y_min) * row_t
        angle = round(row_t * 360, 6)
        for col in range(cols):
            col_t = col / (cols - 1)
            x = x_min + (x_max - x_min) * col_t
            surface_z = sample_projected_surface_z(triangles, x, y, cell_radius)
            if surface_z is None:
                miss_count += 1
                continue
            if isinstance(surface_z, dict):
                if surface_z.get("fallback"):
                    fallback_count += 1
                surface_z = surface_z["z"]
            output_x = -output_length / 2 + output_length * col_t
            normalized_surface = max(0.0, min(1.0, (z_max - surface_z) / z_span))
            depth = output_depth * normalized_surface
            points.append({
                "x": round(output_x, 4),
                "a": angle,
                "z": round(safe_z - depth, 4),
                "depth": round(depth, 4),
                "surfaceZ": round(surface_z, 6),
                "modelX": round(x, 6),
                "modelY": round(y, 6),
                "source": "stl-heightfield-preview",
            })
    if not points:
        return None
    return {
        "schema": NEUTRAL_SCHEMA,
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "synthetic": False,
        "fixture": False,
        "experimentalHeightfield": True,
        "generatedBy": "adapters/opencamlib/opencamlib_runner.py",
        "generatedByExternalCommand": True,
        "coordinate": {
            "lengthAxis": "X",
            "rotaryAxis": rotary_axis,
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        },
        "estimatedMinutes": max(0.5, len(points) / 36),
        "points": points,
        "runner": {
            "mode": "stl-heightfield-preview",
            "opencamlibAvailable": detection["available"],
            "opencamlibModule": detection["module"],
            "geometry": geometry,
            "heightfield": {
                "rows": rows,
                "cols": cols,
                "pointCount": len(points),
                "missCount": miss_count,
                "fallbackCount": fallback_count,
                "fallbackRadius": cell_radius,
                "surfaceZMax": z_max,
                "surfaceZMin": z_min,
                "outputLengthMm": output_length,
                "outputDepthMm": output_depth,
            },
            "warning": "STL heightfield mode is geometry-derived but still a preview scaffold; replace with validated OpenCAMLib cutter-contact before production unlock.",
        },
        "planEcho": {
            "schema": plan.get("schema"),
            "recommendedPrimary": (plan.get("sampling") or {}).get("recommendedPrimary"),
            "operationCount": len(plan.get("operations") or []),
        },
    }


def sample_projected_surface_z(triangles: List[List[List[float]]], x: float, y: float, fallback_radius: float = 0.0) -> Optional[Any]:
    hits: List[float] = []
    for tri in triangles:
        z = interpolate_triangle_z(tri, x, y)
        if z is not None:
            hits.append(z)
    if hits:
        return {"z": max(hits), "fallback": False}
    fallback = nearest_projected_triangle_z(triangles, x, y, fallback_radius)
    if fallback is None:
        return None
    return {"z": fallback, "fallback": True}


def nearest_projected_triangle_z(triangles: List[List[List[float]]], x: float, y: float, fallback_radius: float) -> Optional[float]:
    if fallback_radius <= 0:
        return None
    best_distance = float("inf")
    best_z: Optional[float] = None
    radius_sq = fallback_radius * fallback_radius
    for tri in triangles:
        cx = sum(vertex[0] for vertex in tri) / 3
        cy = sum(vertex[1] for vertex in tri) / 3
        dx = cx - x
        dy = cy - y
        distance_sq = dx * dx + dy * dy
        if distance_sq > radius_sq or distance_sq >= best_distance:
            continue
        best_distance = distance_sq
        best_z = sum(vertex[2] for vertex in tri) / 3
    return best_z


def interpolate_triangle_z(tri: List[List[float]], x: float, y: float) -> Optional[float]:
    (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = tri
    denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    if abs(denom) < 1e-9:
        return None
    a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / denom
    b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / denom
    c = 1 - a - b
    tolerance = 1e-7
    if a < -tolerance or b < -tolerance or c < -tolerance:
        return None
    return a * z1 + b * z2 + c * z3


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
