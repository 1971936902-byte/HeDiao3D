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
import hashlib
import json
import math
import os
import re
import struct
import sys
from datetime import datetime, timezone
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
    readiness_path = output_path.with_name("opencamlib-runner-readiness.json")
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_RUNNER_PATH_DROPCUTTER_OUTPUT")):
        neutral = create_path_dropcutter_neutral_toolpath(job, plan, detection, geometry)
        if neutral is None:
            readiness = create_runner_readiness_report(job, plan, detection, geometry, readiness_path)
            readiness["pathDropCutterAttempted"] = True
            readiness["pathDropCutterFailure"] = "real OpenCAMLib PathDropCutter output requested, but the runtime/model/API mapping did not produce cutter-location points"
            write_json(readiness_path, readiness)
            print(f"OpenCAMLib PathDropCutter output requested but no real cutter-location points were produced. Readiness report: {readiness_path}", file=sys.stderr)
            return 6
        contact_path = output_path.with_name("opencamlib-cutter-contact-report.json")
        contact_report = create_path_dropcutter_contact_report(job, plan, neutral, detection, geometry, plan_path)
        neutral["cutterContactReport"] = contact_report
        neutral["cutterContactReportPath"] = str(contact_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
        contact_path.write_text(json.dumps(contact_report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "mode": neutral["runner"]["mode"],
            "schema": neutral["schema"],
            "points": len(neutral["points"]),
            "cutterContactReport": str(contact_path),
            "output": str(output_path),
            "opencamlibAvailable": detection["available"],
            "productionCandidate": False,
        }, ensure_ascii=False))
        return 0
    if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT")):
        if is_true(os.environ.get("HEDIAO3D_OPENCAMLIB_ROTARY_HEIGHTFIELD_OUTPUT")):
            neutral = create_rotary_heightfield_neutral_toolpath(job, plan, detection, geometry)
        else:
            neutral = create_heightfield_neutral_toolpath(job, plan, detection, geometry)
        if neutral is None:
            print("STL heightfield output requested, but no valid surface samples could be generated.", file=sys.stderr)
            return 5
        envelope_path = output_path.with_name("opencamlib-cutter-envelope-report.json")
        contact_path = output_path.with_name("opencamlib-cutter-contact-report.json")
        neutral["runner"]["heightfield"]["cutterEnvelopeReport"] = str(envelope_path)
        neutral["cutterEnvelopeReportPath"] = str(envelope_path)
        contact_report = create_cutter_contact_report(job, plan, neutral, detection, geometry, plan_path)
        neutral["cutterContactReport"] = contact_report
        neutral["cutterContactReportPath"] = str(contact_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
        envelope_report = create_cutter_envelope_report(job, plan, neutral, detection, geometry, plan_path, output_path)
        envelope_path.write_text(json.dumps(envelope_report, ensure_ascii=False, indent=2), encoding="utf-8")
        contact_path.write_text(json.dumps(contact_report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "mode": "stl-heightfield-preview",
            "schema": neutral["schema"],
            "points": len(neutral["points"]),
            "missCount": neutral["runner"]["heightfield"]["missCount"],
            "cutterEnvelopeReport": str(envelope_path),
            "cutterContactReport": str(contact_path),
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

    readiness = create_runner_readiness_report(job, plan, detection, geometry, readiness_path)
    write_json(readiness_path, readiness)
    if not detection["available"]:
        print(f"OpenCAMLib/ocl Python module is not available. Readiness report: {readiness_path}", file=sys.stderr)
        return 3

    print(
        "OpenCAMLib module detected, but real drop-cutter generation is not implemented in this runner yet. "
        f"Keep production NC locked until this runner writes validated cutter-contact neutral output. Readiness report: {readiness_path}",
        file=sys.stderr,
    )
    return 4


def read_json(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


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
    for name in ("opencamlib.ocl", "opencamlib", "ocl"):
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


def create_runner_readiness_report(job: Dict[str, Any], plan: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any], readiness_path: Path) -> Dict[str, Any]:
    probe = load_runtime_probe_report()
    spike_report = run_contact_spike_precheck(readiness_path.with_name("opencamlib-real-contact-spike.json"))
    model_ready = bool(geometry.get("exists")) and bool(geometry.get("supportedParser")) and int(geometry.get("triangleCount") or 0) > 0
    tool = plan.get("tool") if isinstance(plan.get("tool"), dict) else {}
    sampling = plan.get("sampling") if isinstance(plan.get("sampling"), dict) else {}
    axis_mapping = sampling.get("axisMapping") if isinstance(sampling.get("axisMapping"), dict) else {}
    tool_ready = (
        str(tool.get("toolProfileId") or "") in {"vflat-4mm-25deg", "vbit-flat-4mm-25deg"}
        and is_positive_number(tool.get("diameterMm"))
        and is_positive_number(tool.get("angleDeg"))
        and tool.get("flatTipMm") is not None
    )
    rotary_ready = axis_mapping.get("lengthAxis") == "X" and axis_mapping.get("depthAxis") == "Z" and axis_mapping.get("rotaryAxis") == "Y"
    probe_ready = bool(((probe or {}).get("runnerReadiness") or {}).get("canAttemptRealContactSpike"))
    spike_ready = bool((spike_report or {}).get("ok"))
    blockers: List[str] = []
    if not detection.get("available"):
        blockers.append("opencamlib-module-missing")
    if not probe_ready:
        blockers.append("runtime-probe-not-ready-for-contact-spike")
    if not spike_ready:
        blockers.append("real-contact-spike-not-ready")
    if not model_ready:
        blockers.append("source-model-not-ready")
    if not tool_ready:
        blockers.append("target-tool-not-ready")
    if not rotary_ready:
        blockers.append("rotary-y-axis-mapping-not-ready")

    can_attempt_candidate = not blockers
    return {
        "schema": "hediao3d.opencamlib-runner-readiness-report.v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "jobId": job.get("jobId"),
        "level": "ready-for-real-contact-runner" if can_attempt_candidate else "blocked",
        "canAttemptRealContactRunner": can_attempt_candidate,
        "canEmitProductionCandidate": False,
        "checks": [
            {"id": "opencamlib-module", "status": "pass" if detection.get("available") else "fail", "summary": detection.get("module") or "missing"},
            {"id": "runtime-probe", "status": "pass" if probe_ready else "fail", "summary": ((probe or {}).get("runnerReadiness") or {}).get("level") or "missing"},
            {"id": "real-contact-spike", "status": "pass" if spike_ready else "fail", "summary": (spike_report or {}).get("level") or "missing"},
            {"id": "source-model", "status": "pass" if model_ready else "fail", "summary": f"{geometry.get('format') or 'unknown'} triangles={geometry.get('triangleCount') or 0}"},
            {"id": "target-tool", "status": "pass" if tool_ready else "fail", "summary": f"{tool.get('toolProfileId')} diameter={tool.get('diameterMm')} angle={tool.get('angleDeg')} flatTip={tool.get('flatTipMm')}"},
            {"id": "rotary-y-axis-mapping", "status": "pass" if rotary_ready else "fail", "summary": json.dumps(axis_mapping, ensure_ascii=False)},
        ],
        "blockers": blockers,
        "probe": summarize_probe_for_readiness(probe),
        "contactSpike": summarize_spike_for_readiness(spike_report),
        "geometry": {
            "path": geometry.get("path"),
            "format": geometry.get("format"),
            "parser": geometry.get("parser"),
            "triangleCount": geometry.get("triangleCount"),
            "dimensions": geometry.get("dimensions"),
            "warnings": geometry.get("warnings") or [],
        },
        "target": {
            "machineProfileId": "desktop-3axis-rotary-y",
            "toolProfileId": tool.get("toolProfileId"),
            "axisMapping": axis_mapping,
            "recommendedPrimary": sampling.get("recommendedPrimary"),
        },
        "nextActions": [
            "Install or map OpenCAMLib/ocl Python bindings until runtime probe and real contact spike both pass.",
            "Implement the real model drop-cutter/cutter-contact loop in opencamlib_runner.py using the proven binding sequence.",
            "Emit neutral-toolpath.json plus opencamlib-cutter-contact-report.json and run opencamlib-contact-output-validate.mjs.",
            "Keep HeDiao3D production NC locked until CAMotics/material-removal, air-run, trial feedback and machine acceptance evidence are bound.",
        ],
        "productionBoundary": "This readiness report is diagnostic evidence only. It does not generate machine NC and must not unlock trial or production output.",
    }


def load_runtime_probe_report() -> Optional[Dict[str, Any]]:
    try:
        from opencamlib_probe import create_probe_report  # type: ignore
        report = create_probe_report()
        return report if isinstance(report, dict) else None
    except Exception:
        return None


def run_contact_spike_precheck(out_path: Path) -> Optional[Dict[str, Any]]:
    try:
        from opencamlib_contact_spike import run_spike  # type: ignore
        report = run_spike(neutral_path=out_path.with_name("neutral-toolpath-spike.json"), force=False)
        write_json(out_path, report)
        return report if isinstance(report, dict) else None
    except Exception as exc:  # noqa: BLE001 - readiness must capture deployment mismatch.
        report = {
            "schema": "hediao3d.opencamlib-real-contact-spike.v1",
            "ok": False,
            "level": "precheck-error",
            "summary": f"contact spike precheck failed inside runner readiness: {type(exc).__name__}: {exc}",
            "productionLocked": True,
        }
        write_json(out_path, report)
        return report


def summarize_probe_for_readiness(probe: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not probe:
        return {
            "schema": "hediao3d.opencamlib-runtime-probe-summary.v1",
            "status": "missing",
            "selectedModule": None,
            "canAttemptRealContactSpike": False,
        }
    return {
        "schema": "hediao3d.opencamlib-runtime-probe-summary.v1",
        "status": probe.get("level"),
        "selectedModule": probe.get("selectedModule"),
        "canAttemptRealContactSpike": bool(((probe.get("runnerReadiness") or {}).get("canAttemptRealContactSpike"))),
        "recommendedBindingsStatus": (probe.get("recommendedBindings") or {}).get("status"),
    }


def summarize_spike_for_readiness(spike_report: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not spike_report:
        return {
            "schema": "hediao3d.opencamlib-real-contact-spike-summary.v1",
            "status": "missing",
            "ok": False,
        }
    return {
        "schema": "hediao3d.opencamlib-real-contact-spike-summary.v1",
        "status": spike_report.get("level"),
        "ok": bool(spike_report.get("ok")),
        "selectedModule": spike_report.get("selectedModule"),
        "checkCount": len(spike_report.get("checks") or []),
        "productionLocked": spike_report.get("productionLocked") is not False,
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
    tool = plan.get("tool") or {}
    safe_z = float(settings.get("safeZ") or 22)
    output_length = float(stock.get("lengthMm") or settings.get("lengthMm") or max(0.001, float(geometry.get("dimensions", {}).get("x") or 1)))
    output_depth = max(0.001, float(settings.get("depthMm") or settings.get("maxCutDepth") or max(0.001, float(geometry.get("dimensions", {}).get("z") or 1))))
    rotary_axis = axis_mapping.get("rotaryAxis") or settings.get("rotaryOutputAxis") or "Y"
    cutter_radius = compute_preview_cutter_radius(tool, settings)
    grid = resolve_heightfield_grid(job, plan, geometry, output_length, output_depth, cutter_radius, rotary=False, default_cols=8, default_rows=6)
    cols = int(grid["cols"])
    rows = int(grid["rows"])
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
    cutter_sample_count = 0
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
            contact = sample_cutter_envelope_surface_z(triangles, x, y, cell_radius, cutter_radius)
            if contact is None:
                miss_count += 1
                continue
            if contact.get("fallback"):
                fallback_count += 1
            cutter_sample_count += int(contact.get("samples") or 1)
            surface_z = contact["z"]
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
                "contactSamples": int(contact.get("samples") or 1),
                "cutterRadiusMm": round(cutter_radius, 6),
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
                "adaptiveSampling": grid["adaptiveSampling"],
                "samplingSource": grid["samplingSource"],
                "targetStepoverMm": grid["targetStepoverMm"],
                "targetStepoverDeg": grid["targetStepoverDeg"],
                "maxRows": grid["maxRows"],
                "maxCols": grid["maxCols"],
                "pointCount": len(points),
                "missCount": miss_count,
                "fallbackCount": fallback_count,
                "fallbackRadius": cell_radius,
                "cutterRadiusMm": cutter_radius,
                "cutterSampleCount": cutter_sample_count,
                "cutterEnvelope": cutter_radius > 0,
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


def create_rotary_heightfield_neutral_toolpath(job: Dict[str, Any], plan: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
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
    tool = plan.get("tool") or {}
    safe_z = float(settings.get("safeZ") or 22)
    output_length = float(stock.get("lengthMm") or settings.get("lengthMm") or max(0.001, float(geometry.get("dimensions", {}).get("x") or 1)))
    output_depth = max(0.001, float(settings.get("depthMm") or settings.get("maxCutDepth") or max(0.001, float(geometry.get("dimensions", {}).get("z") or 1))))
    stock_radius = max(0.001, float(stock.get("diameterMm") or settings.get("diameterMm") or 15) / 2)
    rotary_axis = axis_mapping.get("rotaryAxis") or settings.get("rotaryOutputAxis") or "Y"
    cutter_radius = compute_preview_cutter_radius(tool, settings)
    grid = resolve_heightfield_grid(job, plan, geometry, output_length, output_depth, cutter_radius, rotary=True, default_cols=8, default_rows=12)
    cols = int(grid["cols"])
    rows = int(grid["rows"])

    x_min = float(min_bounds["x"])
    x_max = float(max_bounds["x"])
    y_min = float(min_bounds["y"])
    y_max = float(max_bounds["y"])
    z_min = float(min_bounds["z"])
    z_max = float(max_bounds["z"])
    center_y = (y_min + y_max) / 2
    center_z = (z_min + z_max) / 2
    model_radius = max(
        0.001,
        max(abs(y_min - center_y), abs(y_max - center_y), abs(z_min - center_z), abs(z_max - center_z)),
    )
    angular_tolerance_deg = math.degrees(math.asin(min(0.95, cutter_radius / model_radius))) if cutter_radius > 0 else 0.0
    ray_start_radius = model_radius * 3 + stock_radius
    radial_samples: List[Dict[str, Any]] = []
    miss_count = 0

    for row in range(rows):
        row_t = row / (rows - 1)
        angle = row_t * 360
        angle_rad = math.radians(angle)
        radial_dir = [0.0, math.cos(angle_rad), math.sin(angle_rad)]
        ray_direction = [0.0, -radial_dir[1], -radial_dir[2]]
        for col in range(cols):
            col_t = col / (cols - 1)
            x = x_min + (x_max - x_min) * col_t
            origin = [
                x,
                center_y + radial_dir[1] * ray_start_radius,
                center_z + radial_dir[2] * ray_start_radius,
            ]
            hit = sample_rotary_surface_radius(triangles, origin, ray_direction, [0.0, center_y, center_z], radial_dir)
            if hit is None:
                miss_count += 1
                continue
            radial_samples.append({
                "row": row,
                "col": col,
                "rowT": row_t,
                "colT": col_t,
                "angle": angle,
                "modelX": x,
                **hit,
            })

    if not radial_samples:
        return None

    for sample in radial_samples:
        enveloped = apply_rotary_cutter_envelope(sample, radial_samples, cutter_radius, angular_tolerance_deg)
        sample["rawRadius"] = sample["radius"]
        sample["radius"] = enveloped["radius"]
        sample["envelopeSampleCount"] = enveloped["sampleCount"]
        sample["envelopeLiftMm"] = max(0.0, float(sample["radius"]) - float(sample["rawRadius"]))

    radii = [float(sample["radius"]) for sample in radial_samples]
    raw_radii = [float(sample["rawRadius"]) for sample in radial_samples]
    envelope_lifts = [float(sample["envelopeLiftMm"]) for sample in radial_samples]
    min_radius = min(radii)
    max_radius = max(radii)
    raw_min_radius = min(raw_radii)
    raw_max_radius = max(raw_radii)
    radius_span = max(1e-9, max_radius - min_radius)
    points: List[Dict[str, Any]] = []
    for sample in radial_samples:
        col_t = float(sample["colT"])
        output_x = -output_length / 2 + output_length * col_t
        normalized_depth = max(0.0, min(1.0, (max_radius - float(sample["radius"])) / radius_span))
        depth = output_depth * normalized_depth
        points.append({
            "x": round(output_x, 4),
            "a": round(float(sample["angle"]), 6),
            "z": round(safe_z - depth, 4),
            "depth": round(depth, 4),
            "surfaceRadius": round(float(sample["radius"]), 6),
            "rawSurfaceRadius": round(float(sample["rawRadius"]), 6),
            "cutterEnvelopeLiftMm": round(float(sample["envelopeLiftMm"]), 6),
            "envelopeSampleCount": int(sample["envelopeSampleCount"]),
            "cutterRadiusMm": round(cutter_radius, 6),
            "surfaceY": round(float(sample["point"][1]), 6),
            "surfaceZ": round(float(sample["point"][2]), 6),
            "modelX": round(float(sample["modelX"]), 6),
            "rotarySample": True,
            "source": "stl-rotary-heightfield-preview",
        })

    return {
        "schema": NEUTRAL_SCHEMA,
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "synthetic": False,
        "fixture": False,
        "experimentalHeightfield": True,
        "experimentalRotaryHeightfield": True,
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
            "mode": "stl-rotary-heightfield-preview",
            "opencamlibAvailable": detection["available"],
            "opencamlibModule": detection["module"],
            "geometry": geometry,
            "heightfield": {
                "rows": rows,
                "cols": cols,
                "adaptiveSampling": grid["adaptiveSampling"],
                "samplingSource": grid["samplingSource"],
                "targetStepoverMm": grid["targetStepoverMm"],
                "targetStepoverDeg": grid["targetStepoverDeg"],
                "maxRows": grid["maxRows"],
                "maxCols": grid["maxCols"],
                "pointCount": len(points),
                "missCount": miss_count,
                "fallbackCount": 0,
                "rotaryEnvelope": True,
                "cutterEnvelope": cutter_radius > 0,
                "cutterRadiusMm": round(cutter_radius, 6),
                "rotaryCutterAngularToleranceDeg": round(angular_tolerance_deg, 6),
                "cutterEnvelopeSampleCount": sum(int(sample["envelopeSampleCount"]) for sample in radial_samples),
                "cutterEnvelopeLiftMaxMm": round(max(envelope_lifts) if envelope_lifts else 0, 6),
                "cutterEnvelopeLiftAvgMm": round(sum(envelope_lifts) / len(envelope_lifts), 6) if envelope_lifts else 0,
                "center": {"xAxis": "X", "y": center_y, "z": center_z},
                "stockRadiusMm": stock_radius,
                "rawSurfaceRadiusMin": round(raw_min_radius, 6),
                "rawSurfaceRadiusMax": round(raw_max_radius, 6),
                "surfaceRadiusMin": round(min_radius, 6),
                "surfaceRadiusMax": round(max_radius, 6),
                "outputLengthMm": output_length,
                "outputDepthMm": output_depth,
            },
            "warning": "Rotary heightfield mode samples the STL by X + rotary angle rays. It is closer to the rotary fixture workflow than flat Z projection, but still remains a preview scaffold until validated OpenCAMLib cutter-contact replaces it.",
        },
        "planEcho": {
            "schema": plan.get("schema"),
            "recommendedPrimary": (plan.get("sampling") or {}).get("recommendedPrimary"),
            "operationCount": len(plan.get("operations") or []),
        },
    }


def create_path_dropcutter_neutral_toolpath(job: Dict[str, Any], plan: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not detection.get("available") or not detection.get("module"):
        return None
    triangles = parse_ascii_stl_triangles(plan)
    bounds = geometry.get("bounds") or {}
    min_bounds = bounds.get("min") or {}
    max_bounds = bounds.get("max") or {}
    if not triangles or not min_bounds or not max_bounds:
        return None
    try:
        module = __import__(str(detection["module"]), fromlist=["*"])
        result = run_path_dropcutter_api(module, triangles, job, plan, geometry)
    except Exception:
        return None
    if not result or not result.get("points"):
        return None

    settings = job.get("settings") or {}
    sampling = plan.get("sampling") or {}
    axis_mapping = sampling.get("axisMapping") or {}
    stock = plan.get("stock") or {}
    output_length = float(stock.get("lengthMm") or settings.get("lengthMm") or max(0.001, float((geometry.get("dimensions") or {}).get("x") or 1)))
    safe_z = float(settings.get("safeZ") or 22)
    y_min = float(min_bounds["y"])
    y_max = float(max_bounds["y"])
    y_span = max(1e-9, y_max - y_min)
    points: List[Dict[str, Any]] = []
    for point in result["points"]:
        model_x = float(point["x"])
        model_y = float(point["y"])
        model_z = float(point["z"])
        x_t = normalize_between(model_x, float(min_bounds["x"]), float(max_bounds["x"]))
        output_x = -output_length / 2 + output_length * x_t
        angle = ((model_y - y_min) / y_span) * 360.0
        depth = max(0.0, safe_z - model_z)
        points.append({
            "x": round(output_x, 4),
            "a": round(angle, 6),
            "z": round(model_z, 4),
            "depth": round(depth, 4),
            "modelX": round(model_x, 6),
            "modelY": round(model_y, 6),
            "modelZ": round(model_z, 6),
            "source": "opencamlib-path-drop-cutter-experimental",
        })
    if not points:
        return None
    return {
        "schema": NEUTRAL_SCHEMA,
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "synthetic": False,
        "fixture": False,
        "experimentalOpenCamLibPathDropCutter": True,
        "productionCandidate": False,
        "generatedBy": "adapters/opencamlib/opencamlib_runner.py",
        "generatedByExternalCommand": True,
        "coordinate": {
            "lengthAxis": "X",
            "rotaryAxis": axis_mapping.get("rotaryAxis") or settings.get("rotaryOutputAxis") or "Y",
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        },
        "estimatedMinutes": max(0.5, len(points) / 36),
        "points": points,
        "runner": {
            "mode": "opencamlib-path-drop-cutter-experimental",
            "opencamlibAvailable": detection["available"],
            "opencamlibModule": detection["module"],
            "geometry": geometry,
            "pathDropCutter": {
                "algorithm": result.get("algorithm"),
                "pathRows": result.get("pathRows"),
                "pathSegments": result.get("pathSegments"),
                "inputPointCount": result.get("inputPointCount"),
                "pointCount": len(points),
                "modelBounds": geometry.get("bounds"),
                "outputLengthMm": output_length,
            },
            "warning": "This output uses a real OpenCAMLib PathDropCutter-style API on the source STL, but remains experimental and non-production until strict contact validation, material-removal simulation and machine evidence pass.",
        },
        "planEcho": {
            "schema": plan.get("schema"),
            "recommendedPrimary": (plan.get("sampling") or {}).get("recommendedPrimary"),
            "operationCount": len(plan.get("operations") or []),
        },
    }


def run_path_dropcutter_api(module: Any, triangles: List[List[List[float]]], job: Dict[str, Any], plan: Dict[str, Any], geometry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    point_cls = find_attr(module, ["Point"])
    triangle_cls = find_attr(module, ["Triangle"])
    surface_cls = find_attr(module, ["STLSurf", "STLSurface"])
    cutter_cls = find_attr(module, ["CylCutter", "FlatCutter", "BallCutter"])
    line_cls = find_attr(module, ["Line"])
    path_cls = find_attr(module, ["Path"])
    dropper_cls = find_attr(module, ["PathDropCutter", "AdaptivePathDropCutter"])
    if not all([point_cls, triangle_cls, surface_cls, cutter_cls, line_cls, path_cls, dropper_cls]):
        return None
    surface = surface_cls()
    triangle_limit = read_positive_env_int("HEDIAO3D_OPENCAMLIB_PATH_DROPCUTTER_TRIANGLE_LIMIT") or len(triangles)
    for tri in triangles[:triangle_limit]:
        add_opencamlib_triangle(surface, triangle_cls, point_cls, tri)
    cutter = instantiate_opencamlib_cutter(cutter_cls, plan, job)
    path, input_points, row_count, segment_count = create_opencamlib_path(module, point_cls, line_cls, path_cls, job, plan, geometry)
    dropper = dropper_cls()
    call_first_method(dropper, ["setSTL", "setSTLSurf", "setSurface"], surface)
    call_first_method(dropper, ["setCutter"], cutter)
    call_first_method(dropper, ["setPath"], path)
    call_optional_method(dropper, ["setZ"], float((job.get("settings") or {}).get("safeZ") or 22))
    call_first_method(dropper, ["run", "dropCutter", "runDropCutter"])
    output = get_opencamlib_points(dropper)
    if not output:
        return None
    return {
        "algorithm": "opencamlib-path-drop-cutter",
        "points": output,
        "inputPointCount": len(input_points),
        "pathRows": row_count,
        "pathSegments": segment_count,
    }


def create_opencamlib_path(module: Any, point_cls: Any, line_cls: Any, path_cls: Any, job: Dict[str, Any], plan: Dict[str, Any], geometry: Dict[str, Any]) -> List[Any]:
    bounds = geometry.get("bounds") or {}
    min_bounds = bounds.get("min") or {}
    max_bounds = bounds.get("max") or {}
    settings = job.get("settings") or {}
    rows = read_positive_env_int("HEDIAO3D_OPENCAMLIB_PATH_DROPCUTTER_ROWS") or 8
    z_clear = float(settings.get("safeZ") or 22)
    x_min = float(min_bounds.get("x") or 0)
    x_max = float(max_bounds.get("x") or 1)
    y_min = float(min_bounds.get("y") or 0)
    y_max = float(max_bounds.get("y") or 1)
    path = path_cls()
    input_points: List[List[float]] = []
    segment_count = 0
    for row in range(rows):
        t = row / max(1, rows - 1)
        y = y_min + (y_max - y_min) * t
        start_x, end_x = (x_min, x_max) if row % 2 == 0 else (x_max, x_min)
        start = point_cls(start_x, y, z_clear)
        end = point_cls(end_x, y, z_clear)
        line = line_cls(start, end)
        append_path_segment(path, line)
        input_points.extend([[start_x, y, z_clear], [end_x, y, z_clear]])
        segment_count += 1
    return [path, input_points, rows, segment_count]


def create_path_dropcutter_contact_report(job: Dict[str, Any], plan: Dict[str, Any], neutral: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any], plan_path: Path) -> Dict[str, Any]:
    points = neutral.get("points") if isinstance(neutral.get("points"), list) else []
    path_report = ((neutral.get("runner") or {}).get("pathDropCutter") or {})
    return {
        "schema": "hediao3d.opencamlib-cutter-contact-report.v1",
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "mode": "opencamlib-path-drop-cutter-experimental",
        "createdBy": "adapters/opencamlib/opencamlib_runner.py",
        "inputIdentity": {
            "modelSha256": sha256_file(Path(str((plan.get("model") or {}).get("path") or ""))),
            "planSha256": sha256_file(plan_path),
            "sourceNeutralToolpathSha256": sha256_json_without_contact_report(neutral),
            "neutralToolpathWithoutContactReportSha256": sha256_json_without_contact_report(neutral),
        },
        "opencamlib": detection,
        "model": {
            "format": (plan.get("model") or {}).get("format"),
            "geometry": geometry,
        },
        "tool": {
            "toolProfileId": ((plan.get("tool") or {}).get("toolProfileId") or (job.get("settings") or {}).get("toolProfileId")),
            "diameterMm": (plan.get("tool") or {}).get("diameterMm") or (job.get("settings") or {}).get("toolDiameter"),
            "flatTipMm": (plan.get("tool") or {}).get("flatTipMm"),
            "angleDeg": (plan.get("tool") or {}).get("angleDeg"),
        },
        "contactSampling": {
            "algorithm": "opencamlib-path-drop-cutter",
            "pointCount": len(points),
            "pathRows": path_report.get("pathRows"),
            "pathSegments": path_report.get("pathSegments"),
            "inputPointCount": path_report.get("inputPointCount"),
            "hitRate": 1.0 if points else 0.0,
            "samplingQuality": {
                "level": "experimental-real-api",
                "summary": "Real OpenCAMLib PathDropCutter-style API returned cutter-location points, but rotary wrap production quality is not yet proven.",
            },
        },
        "quality": {
            "level": "experimental-real-api",
            "previewScaffold": False,
            "postprocessEligible": False,
            "productionCandidate": False,
            "summary": "OpenCAMLib PathDropCutter API executed against the source STL and returned neutral points. This is stronger than heightfield preview, but remains non-production until strict residual metrics, CAMotics material removal, air-run and machine acceptance are bound.",
            "requiredUpgrade": "Bind residual gouge/undercut metrics and target rotary fixture sampling before declaring production-candidate output.",
        },
        "productionBoundary": [
            "This report proves the real OpenCAMLib PathDropCutter API can be called from the runner.",
            "It is not yet a production candidate because rotary fixture residual metrics and material-removal evidence are missing.",
        ],
    }


def apply_rotary_cutter_envelope(sample: Dict[str, Any], samples: List[Dict[str, Any]], cutter_radius: float, angular_tolerance_deg: float) -> Dict[str, Any]:
    if cutter_radius <= 1e-9:
        return {"radius": float(sample["radius"]), "sampleCount": 1}
    x = float(sample["modelX"])
    angle = float(sample["angle"])
    best_radius = float(sample["radius"])
    sample_count = 0
    for candidate in samples:
        if abs(float(candidate["modelX"]) - x) > cutter_radius:
            continue
        if circular_angle_distance_deg(float(candidate["angle"]), angle) > angular_tolerance_deg:
            continue
        sample_count += 1
        best_radius = max(best_radius, float(candidate["radius"]))
    return {
        "radius": best_radius,
        "sampleCount": max(1, sample_count),
    }


def circular_angle_distance_deg(a: float, b: float) -> float:
    distance = abs((a - b) % 360.0)
    return min(distance, 360.0 - distance)


def compute_preview_cutter_radius(tool: Dict[str, Any], settings: Dict[str, Any]) -> float:
    diameter = float(tool.get("diameterMm") or settings.get("toolDiameter") or 0)
    flat_tip = float(tool.get("flatTipMm") or 0)
    scale = float(os.environ.get("HEDIAO3D_OPENCAMLIB_CUTTER_RADIUS_SCALE") or 1.0)
    radius = max(flat_tip / 2, diameter / 2 * max(0.0, scale))
    return max(0.0, radius)


def resolve_heightfield_grid(
    job: Dict[str, Any],
    plan: Dict[str, Any],
    geometry: Dict[str, Any],
    output_length: float,
    output_depth: float,
    cutter_radius: float,
    rotary: bool,
    default_cols: int,
    default_rows: int,
) -> Dict[str, Any]:
    settings = job.get("settings") or {}
    stock = plan.get("stock") or {}
    env_cols = read_positive_env_int("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_COLS")
    env_rows = read_positive_env_int("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_ROWS")
    max_cols = read_positive_env_int("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_MAX_COLS") or 121
    max_rows = read_positive_env_int("HEDIAO3D_OPENCAMLIB_HEIGHTFIELD_MAX_ROWS") or (181 if rotary else 121)

    tool_diameter = max(0.001, cutter_radius * 2)
    target_stepover_mm = read_positive_number(
        settings.get("stepoverMm"),
        find_operation_positive_number(plan, "stepoverMm"),
        (plan.get("sampling") or {}).get("stepoverMm"),
        tool_diameter * 0.12,
    )
    target_stepover_deg = read_positive_number(
        settings.get("stepoverDeg"),
        find_operation_positive_number(plan, "stepoverDeg"),
        (plan.get("sampling") or {}).get("stepoverDeg"),
    )
    x_span = max(0.001, float(output_length or 0) or float((geometry.get("dimensions") or {}).get("x") or 1))
    y_span = max(0.001, float((geometry.get("dimensions") or {}).get("y") or stock.get("diameterMm") or settings.get("diameterMm") or 1))
    stock_radius = max(0.001, float(stock.get("diameterMm") or settings.get("diameterMm") or y_span) / 2)
    circumference = max(0.001, 2 * math.pi * stock_radius)

    adaptive_cols = math.ceil(x_span / target_stepover_mm) + 1
    if rotary:
        if target_stepover_deg is not None:
            adaptive_rows = math.ceil(360.0 / target_stepover_deg) + 1
            row_source = "settings-stepover-deg"
        else:
            adaptive_rows = math.ceil(circumference / target_stepover_mm) + 1
            row_source = "settings-stepover-mm-circumference"
    else:
        adaptive_rows = math.ceil(y_span / target_stepover_mm) + 1
        row_source = "settings-stepover-mm-yspan"

    cols = clamp_int(env_cols if env_cols is not None else adaptive_cols, 2, max_cols)
    rows = clamp_int(env_rows if env_rows is not None else adaptive_rows, 2, max_rows)
    env_override = env_cols is not None or env_rows is not None
    capped = cols < int(env_cols if env_cols is not None else adaptive_cols) or rows < int(env_rows if env_rows is not None else adaptive_rows)
    if env_override:
        source = "env-override"
    elif capped:
        source = f"adaptive-capped:{row_source}"
    else:
        source = f"adaptive:{row_source}"

    return {
        "rows": rows,
        "cols": cols,
        "adaptiveSampling": not env_override,
        "samplingSource": source,
        "targetStepoverMm": round(target_stepover_mm, 6),
        "targetStepoverDeg": round(target_stepover_deg, 6) if target_stepover_deg is not None else None,
        "maxRows": max_rows,
        "maxCols": max_cols,
        "outputDepthMm": round(float(output_depth or 0), 6),
    }


def read_positive_env_int(name: str) -> Optional[int]:
    value = os.environ.get(name)
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def read_positive_number(*values: Any) -> float:
    for value in values:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return 0.5


def find_operation_positive_number(plan: Dict[str, Any], key: str) -> Optional[float]:
    for operation in plan.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        value = operation.get(key)
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return None


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(value)))


def create_cutter_envelope_report(job: Dict[str, Any], plan: Dict[str, Any], neutral: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any], plan_path: Path, neutral_path: Path) -> Dict[str, Any]:
    points = neutral.get("points") if isinstance(neutral.get("points"), list) else []
    heightfield = ((neutral.get("runner") or {}).get("heightfield") or {})
    depths = [float(point.get("depth")) for point in points if is_number(point.get("depth"))]
    contact_samples = [int(point.get("contactSamples") or point.get("envelopeSampleCount") or 0) for point in points]
    fallback_count = int(heightfield.get("fallbackCount") or 0)
    miss_count = int(heightfield.get("missCount") or 0)
    point_count = len(points)
    total_sites = point_count + miss_count
    hit_rate = point_count / total_sites if total_sites else 0
    fallback_rate = fallback_count / point_count if point_count else 0
    model_path = Path(str((plan.get("model") or {}).get("path") or ""))
    mode = str(((neutral.get("runner") or {}).get("mode") or "stl-heightfield-preview"))
    rotary_envelope = bool(heightfield.get("rotaryEnvelope"))
    envelope_lifts = [float(point.get("cutterEnvelopeLiftMm")) for point in points if is_number(point.get("cutterEnvelopeLiftMm"))]
    surface_radii = [float(point.get("surfaceRadius")) for point in points if is_number(point.get("surfaceRadius"))]
    raw_surface_radii = [float(point.get("rawSurfaceRadius")) for point in points if is_number(point.get("rawSurfaceRadius"))]
    sampling_quality = compute_heightfield_sampling_quality(heightfield, point_count, miss_count, rotary_envelope)
    return {
        "schema": "hediao3d.opencamlib-cutter-envelope-report.v1",
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "mode": mode,
        "createdBy": "adapters/opencamlib/opencamlib_runner.py",
        "inputIdentity": {
            "modelSha256": sha256_file(model_path),
            "planSha256": sha256_file(plan_path),
            "neutralToolpathSha256": sha256_file(neutral_path),
        },
        "opencamlib": detection,
        "model": {
            "path": str(model_path) if str(model_path) else (plan.get("model") or {}).get("path"),
            "format": (plan.get("model") or {}).get("format"),
            "geometry": geometry,
        },
        "tool": {
            "toolProfileId": ((plan.get("tool") or {}).get("toolProfileId") or (job.get("settings") or {}).get("toolProfileId")),
            "diameterMm": (plan.get("tool") or {}).get("diameterMm") or (job.get("settings") or {}).get("toolDiameter"),
            "flatTipMm": (plan.get("tool") or {}).get("flatTipMm"),
            "angleDeg": (plan.get("tool") or {}).get("angleDeg"),
            "previewCutterRadiusMm": heightfield.get("cutterRadiusMm"),
            "rotaryCutterAngularToleranceDeg": heightfield.get("rotaryCutterAngularToleranceDeg"),
            "envelopeSamplePattern": "X/angle neighbor max-radius envelope" if rotary_envelope else "center + 8 offsets at 0.5R + 8 offsets at 1.0R",
        },
        "sampling": {
            "rows": heightfield.get("rows"),
            "cols": heightfield.get("cols"),
            "pointCount": point_count,
            "missCount": miss_count,
            "hitRate": round(hit_rate, 6),
            "rotaryEnvelope": rotary_envelope,
            "fallbackCount": fallback_count,
            "fallbackRate": round(fallback_rate, 6),
            "fallbackRadius": heightfield.get("fallbackRadius"),
            "cutterSampleCount": heightfield.get("cutterSampleCount") or heightfield.get("cutterEnvelopeSampleCount"),
            "contactSamplesMin": min(contact_samples) if contact_samples else 0,
            "contactSamplesMax": max(contact_samples) if contact_samples else 0,
            "contactSamplesAvg": round(sum(contact_samples) / len(contact_samples), 6) if contact_samples else 0,
            "quality": sampling_quality,
        },
        "rotaryEnvelope": {
            "enabled": rotary_envelope,
            "stockRadiusMm": heightfield.get("stockRadiusMm"),
            "surfaceRadiusMin": min(surface_radii) if surface_radii else None,
            "surfaceRadiusMax": max(surface_radii) if surface_radii else None,
            "rawSurfaceRadiusMin": min(raw_surface_radii) if raw_surface_radii else None,
            "rawSurfaceRadiusMax": max(raw_surface_radii) if raw_surface_radii else None,
            "cutterEnvelopeLiftMaxMm": max(envelope_lifts) if envelope_lifts else 0,
            "cutterEnvelopeLiftAvgMm": round(sum(envelope_lifts) / len(envelope_lifts), 6) if envelope_lifts else 0,
        },
        "depth": {
            "zMin": min((float(point.get("z")) for point in points if is_number(point.get("z"))), default=None),
            "zMax": max((float(point.get("z")) for point in points if is_number(point.get("z"))), default=None),
            "depthMin": min(depths) if depths else None,
            "depthMax": max(depths) if depths else None,
            "depthAvg": round(sum(depths) / len(depths), 6) if depths else None,
        },
        "quality": {
            "level": "preview-scaffold",
            "postprocessEligible": False,
            "productionCandidate": False,
            "samplingReadyForUpgrade": sampling_quality["level"] in {"fine", "production-sampling-candidate"},
            "summary": "Geometry-derived STL rotary envelope was generated for trial visualization, but it is not validated OpenCAMLib drop-cutter output." if rotary_envelope else "Geometry-derived STL heightfield envelope was generated for trial visualization, but it is not validated OpenCAMLib drop-cutter output.",
            "requiredUpgrade": "Replace rotary heightfield preview with real OpenCAMLib/ocl cutter-contact or drop-cutter sampling before production unlock." if rotary_envelope else "Replace heightfield preview with real OpenCAMLib/ocl cutter-contact or drop-cutter sampling before production unlock.",
        },
        "productionBoundary": [
            "This report audits preview cutter-envelope sampling only.",
            "It must not unlock production NC without non-preview neutral-toolpath, CAMotics material-removal evidence, air-run, trial feedback and machine acceptance.",
        ],
    }


def create_cutter_contact_report(job: Dict[str, Any], plan: Dict[str, Any], neutral: Dict[str, Any], detection: Dict[str, Any], geometry: Dict[str, Any], plan_path: Path) -> Dict[str, Any]:
    points = neutral.get("points") if isinstance(neutral.get("points"), list) else []
    heightfield = ((neutral.get("runner") or {}).get("heightfield") or {})
    mode = str(((neutral.get("runner") or {}).get("mode") or "stl-heightfield-preview"))
    rotary_envelope = bool(heightfield.get("rotaryEnvelope"))
    point_count = len(points)
    miss_count = int(heightfield.get("missCount") or 0)
    total_sites = point_count + miss_count
    hit_rate = point_count / total_sites if total_sites else 0
    preview_scaffold = "preview" in mode.lower() or bool(neutral.get("experimentalHeightfield")) or bool(neutral.get("experimentalRotaryHeightfield"))
    neutral_without_contact_sha = sha256_json_without_contact_report(neutral)
    sampling_quality = compute_heightfield_sampling_quality(heightfield, point_count, miss_count, rotary_envelope)
    return {
        "schema": "hediao3d.opencamlib-cutter-contact-report.v1",
        "jobId": job.get("jobId"),
        "engine": "opencamlib",
        "mode": mode,
        "createdBy": "adapters/opencamlib/opencamlib_runner.py",
        "inputIdentity": {
            "modelSha256": sha256_file(Path(str((plan.get("model") or {}).get("path") or ""))),
            "planSha256": sha256_file(plan_path),
            "sourceNeutralToolpathSha256": neutral_without_contact_sha,
            "neutralToolpathWithoutContactReportSha256": neutral_without_contact_sha,
        },
        "opencamlib": detection,
        "model": {
            "format": (plan.get("model") or {}).get("format"),
            "geometry": geometry,
        },
        "tool": {
            "toolProfileId": ((plan.get("tool") or {}).get("toolProfileId") or (job.get("settings") or {}).get("toolProfileId")),
            "diameterMm": (plan.get("tool") or {}).get("diameterMm") or (job.get("settings") or {}).get("toolDiameter"),
            "flatTipMm": (plan.get("tool") or {}).get("flatTipMm"),
            "angleDeg": (plan.get("tool") or {}).get("angleDeg"),
            "previewCutterRadiusMm": heightfield.get("cutterRadiusMm"),
        },
        "contactSampling": {
            "algorithm": "rotary-ray-heightfield-envelope-preview" if rotary_envelope else "projected-heightfield-envelope-preview",
            "rows": heightfield.get("rows"),
            "cols": heightfield.get("cols"),
            "pointCount": point_count,
            "missCount": miss_count,
            "hitRate": round(hit_rate, 6),
            "rotaryEnvelope": rotary_envelope,
            "cutterEnvelope": bool(heightfield.get("cutterEnvelope")),
            "cutterEnvelopeSampleCount": heightfield.get("cutterSampleCount") or heightfield.get("cutterEnvelopeSampleCount"),
            "cutterEnvelopeLiftMaxMm": heightfield.get("cutterEnvelopeLiftMaxMm"),
            "cutterEnvelopeLiftAvgMm": heightfield.get("cutterEnvelopeLiftAvgMm"),
            "samplingQuality": sampling_quality,
        },
        "quality": {
            "level": "preview-scaffold" if preview_scaffold else "review",
            "previewScaffold": preview_scaffold,
            "postprocessEligible": False,
            "productionCandidate": False,
            "samplingReadyForUpgrade": sampling_quality["level"] in {"fine", "production-sampling-candidate"},
            "summary": "OpenCAMLib contact-report contract is present and hash-bound, but current output is still heightfield preview scaffold rather than validated drop-cutter/cutter-contact output.",
            "requiredUpgrade": "Replace this preview contact sampler with OpenCAMLib drop-cutter/cutter-contact calculation and independent material-removal simulation before production unlock.",
        },
        "productionBoundary": [
            "This contact report proves adapter-to-Orchestrator identity binding only.",
            "It intentionally remains non-production while the runner mode is preview/scaffold.",
            "Production still requires validated cutter-contact output, CAMotics/equivalent material removal evidence, air-run, trial feedback and machine acceptance.",
        ],
    }


def compute_heightfield_sampling_quality(heightfield: Dict[str, Any], point_count: int, miss_count: int, rotary_envelope: bool) -> Dict[str, Any]:
    rows = int(heightfield.get("rows") or 0)
    cols = int(heightfield.get("cols") or 0)
    output_length = float(heightfield.get("outputLengthMm") or 0)
    cutter_radius = float(heightfield.get("cutterRadiusMm") or 0)
    stock_radius = float(heightfield.get("stockRadiusMm") or 0)
    cutter_diameter = cutter_radius * 2
    total_sites = point_count + miss_count
    hit_rate = point_count / total_sites if total_sites else 0.0
    x_step = output_length / max(1, cols - 1) if cols > 1 and output_length > 0 else None
    angle_step_deg = 360.0 / max(1, rows - 1) if rotary_envelope and rows > 1 else None
    rotary_surface_step = (2 * math.pi * stock_radius) / max(1, rows - 1) if rotary_envelope and rows > 1 and stock_radius > 0 else None
    y_step = None if rotary_envelope else x_step
    effective_cross_step = rotary_surface_step if rotary_envelope else y_step
    linear_steps = [step for step in (x_step, effective_cross_step) if step is not None]
    max_linear_step = max(linear_steps) if linear_steps else None
    step_to_cutter_ratio = max_linear_step / cutter_diameter if max_linear_step is not None and cutter_diameter > 0 else None
    adaptive_sampling = bool(heightfield.get("adaptiveSampling"))
    sampling_source = heightfield.get("samplingSource")
    target_stepover_mm = heightfield.get("targetStepoverMm")
    target_stepover_deg = heightfield.get("targetStepoverDeg")
    max_rows = heightfield.get("maxRows")
    max_cols = heightfield.get("maxCols")
    row_cap_hit = bool(max_rows and rows >= int(max_rows) and adaptive_sampling)
    col_cap_hit = bool(max_cols and cols >= int(max_cols) and adaptive_sampling)

    blockers: List[str] = []
    warnings: List[str] = []
    if hit_rate < 0.98:
        blockers.append("hit-rate-below-98-percent")
    if step_to_cutter_ratio is None:
        warnings.append("step-to-cutter-ratio-unavailable")
    elif step_to_cutter_ratio > 0.25:
        blockers.append("sampling-step-larger-than-quarter-cutter-diameter")
    elif step_to_cutter_ratio > 0.12:
        warnings.append("sampling-step-larger-than-fine-finishing-target")
    if rotary_envelope and (angle_step_deg is None or angle_step_deg > 3.0):
        warnings.append("rotary-angle-step-above-3deg")
    if rows < 2 or cols < 2:
        blockers.append("sampling-grid-too-small")
    if row_cap_hit or col_cap_hit:
        warnings.append("adaptive-sampling-grid-capped")

    if blockers:
        level = "coarse"
    elif warnings:
        level = "fine"
    else:
        level = "production-sampling-candidate"

    return {
        "schema": "hediao3d.opencamlib-heightfield-sampling-quality.v1",
        "level": level,
        "hitRate": round(hit_rate, 6),
        "rows": rows,
        "cols": cols,
        "xStepMm": round(x_step, 6) if x_step is not None else None,
        "rotaryAngleStepDeg": round(angle_step_deg, 6) if angle_step_deg is not None else None,
        "rotarySurfaceStepMm": round(rotary_surface_step, 6) if rotary_surface_step is not None else None,
        "maxLinearStepMm": round(max_linear_step, 6) if max_linear_step is not None else None,
        "cutterDiameterMm": round(cutter_diameter, 6) if cutter_diameter > 0 else None,
        "stepToCutterRatio": round(step_to_cutter_ratio, 6) if step_to_cutter_ratio is not None else None,
        "adaptiveSampling": adaptive_sampling,
        "samplingSource": str(sampling_source) if sampling_source else None,
        "targetStepoverMm": round(float(target_stepover_mm), 6) if is_number(target_stepover_mm) else None,
        "targetStepoverDeg": round(float(target_stepover_deg), 6) if is_number(target_stepover_deg) else None,
        "maxRows": int(max_rows) if is_number(max_rows) else None,
        "maxCols": int(max_cols) if is_number(max_cols) else None,
        "rowCapHit": row_cap_hit,
        "colCapHit": col_cap_hit,
        "blockers": blockers,
        "warnings": warnings,
        "summary": "Preview sampling is dense enough to be considered for a real OpenCAMLib cutter-contact upgrade." if level == "production-sampling-candidate" else "Preview sampling is useful for visualization/air-run review, but should be refined or replaced before real cutter-contact production.",
    }


def is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def find_attr(module: Any, names: List[str]) -> Any:
    for name in names:
        value = getattr(module, name, None)
        if value is not None:
            return value
    return None


def add_opencamlib_triangle(surface: Any, triangle_cls: Any, point_cls: Any, coords: List[List[float]]) -> None:
    triangle = triangle_cls(*(point_cls(*coord) for coord in coords))
    for method in ("addTriangle", "add_triangle", "add"):
        if hasattr(surface, method):
            getattr(surface, method)(triangle)
            return
    raise RuntimeError("surface object does not expose addTriangle/add_triangle/add")


def instantiate_opencamlib_cutter(cutter_cls: Any, plan: Dict[str, Any], job: Dict[str, Any]) -> Any:
    tool = plan.get("tool") if isinstance(plan.get("tool"), dict) else {}
    settings = job.get("settings") if isinstance(job.get("settings"), dict) else {}
    diameter = float(tool.get("diameterMm") or settings.get("toolDiameter") or 4.0)
    attempts = [
        (diameter, 20.0),
        (diameter,),
        (),
    ]
    last_error: Optional[Exception] = None
    for args in attempts:
        try:
            return cutter_cls(*args)
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"could not instantiate OpenCAMLib cutter: {last_error}")


def call_first_method(obj: Any, methods: List[str], *args: Any) -> Any:
    for method in methods:
        if hasattr(obj, method):
            return getattr(obj, method)(*args)
    raise RuntimeError(f"object {type(obj).__name__} missing methods {methods}")


def call_optional_method(obj: Any, methods: List[str], *args: Any) -> bool:
    for method in methods:
        if hasattr(obj, method):
            getattr(obj, method)(*args)
            return True
    return False


def append_path_segment(path: Any, segment: Any) -> None:
    for method in ("append", "push_back", "add", "addLine"):
        if hasattr(path, method):
            getattr(path, method)(segment)
            return
    raise RuntimeError("path object does not expose append/push_back/add/addLine")


def get_opencamlib_points(dropper: Any) -> List[Dict[str, float]]:
    for method in ("getCLPoints", "getPoints", "getCL"):
        if not hasattr(dropper, method):
            continue
        raw_points = getattr(dropper, method)()
        return [normalize_opencamlib_point(point) for point in list(raw_points)]
    return []


def normalize_opencamlib_point(point: Any) -> Dict[str, float]:
    values: Dict[str, float] = {}
    for axis in ("x", "y", "z"):
        attr = getattr(point, axis, None)
        if callable(attr):
            attr = attr()
        if attr is None and hasattr(point, axis.upper()):
            attr = getattr(point, axis.upper())
            if callable(attr):
                attr = attr()
        values[axis] = float(attr if attr is not None else 0.0)
    return values


def normalize_between(value: float, lower: float, upper: float) -> float:
    span = upper - lower
    if abs(span) < 1e-9:
        return 0.0
    return max(0.0, min(1.0, (value - lower) / span))


def sha256_file(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, TypeError, ValueError):
        return None


def sha256_json_without_contact_report(value: Dict[str, Any]) -> str:
    copy = dict(value)
    copy.pop("cutterContactReport", None)
    copy.pop("cutterContactReportPath", None)
    copy.pop("cutterEnvelopeReportPath", None)
    return hashlib.sha256(json.dumps(copy, ensure_ascii=False, indent=2).encode("utf-8")).hexdigest()


def sample_cutter_envelope_surface_z(triangles: List[List[List[float]]], x: float, y: float, fallback_radius: float, cutter_radius: float) -> Optional[Dict[str, Any]]:
    offsets = create_cutter_sample_offsets(cutter_radius)
    hits: List[Dict[str, Any]] = []
    for dx, dy in offsets:
        hit = sample_projected_surface_z(triangles, x + dx, y + dy, fallback_radius)
        if hit is not None:
            hits.append(hit)
    if not hits:
        return None
    best = max(hits, key=lambda item: item["z"])
    return {
        "z": best["z"],
        "fallback": any(bool(item.get("fallback")) for item in hits),
        "samples": len(hits),
    }


def create_cutter_sample_offsets(cutter_radius: float) -> List[List[float]]:
    if cutter_radius <= 1e-9:
        return [[0.0, 0.0]]
    offsets = [[0.0, 0.0]]
    for radius in (cutter_radius * 0.5, cutter_radius):
        for dx, dy in (
            (radius, 0.0),
            (-radius, 0.0),
            (0.0, radius),
            (0.0, -radius),
            (radius * 0.70710678, radius * 0.70710678),
            (-radius * 0.70710678, radius * 0.70710678),
            (radius * 0.70710678, -radius * 0.70710678),
            (-radius * 0.70710678, -radius * 0.70710678),
        ):
            offsets.append([dx, dy])
    return offsets


def sample_projected_surface_z(triangles: List[List[List[float]]], x: float, y: float, fallback_radius: float = 0.0) -> Optional[Dict[str, Any]]:
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


def sample_rotary_surface_radius(triangles: List[List[List[float]]], origin: List[float], direction: List[float], center: List[float], radial_dir: List[float]) -> Optional[Dict[str, Any]]:
    best_radius = -float("inf")
    best_point: Optional[List[float]] = None
    for tri in triangles:
        hit = intersect_ray_triangle(origin, direction, tri)
        if hit is None:
            continue
        radius = (
            (hit[1] - center[1]) * radial_dir[1]
            + (hit[2] - center[2]) * radial_dir[2]
        )
        if radius > best_radius:
            best_radius = radius
            best_point = hit
    if best_point is None:
        return None
    return {
        "radius": max(0.0, best_radius),
        "point": best_point,
    }


def intersect_ray_triangle(origin: List[float], direction: List[float], tri: List[List[float]]) -> Optional[List[float]]:
    epsilon = 1e-9
    v0, v1, v2 = tri
    edge1 = vec_sub(v1, v0)
    edge2 = vec_sub(v2, v0)
    h = vec_cross(direction, edge2)
    a = vec_dot(edge1, h)
    if -epsilon < a < epsilon:
        return None
    f = 1.0 / a
    s = vec_sub(origin, v0)
    u = f * vec_dot(s, h)
    if u < -epsilon or u > 1.0 + epsilon:
        return None
    q = vec_cross(s, edge1)
    v = f * vec_dot(direction, q)
    if v < -epsilon or u + v > 1.0 + epsilon:
        return None
    t = f * vec_dot(edge2, q)
    if t < -epsilon:
        return None
    return [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t,
    ]


def vec_sub(a: List[float], b: List[float]) -> List[float]:
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def vec_dot(a: List[float], b: List[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vec_cross(a: List[float], b: List[float]) -> List[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


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
