#!/usr/bin/env python3
"""Fail-closed OpenCAMLib real cutter-contact spike for HeDiao3D V3.

This script is the first Linux-side bridge from runtime introspection to a
real OpenCAMLib/ocl drop-cutter call. It deliberately runs a tiny synthetic
geometry probe, not a production model. Success proves the deployed Python API
can be called; it does not unlock production NC.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


SCHEMA = "hediao3d.opencamlib-real-contact-spike.v1"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a tiny real OpenCAMLib drop-cutter spike when the runtime supports it.")
    parser.add_argument("--out", default="opencamlib-real-contact-spike.json", help="Output JSON report path.")
    parser.add_argument("--neutral-out", default="neutral-toolpath-spike.json", help="Optional neutral spike output path.")
    parser.add_argument("--force", action="store_true", help="Try the spike even when the probe says runner readiness is incomplete.")
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    neutral_path = Path(args.neutral_out).resolve()
    report = run_spike(neutral_path=neutral_path, force=args.force)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"],
        "schema": report["schema"],
        "level": report["level"],
        "selectedModule": report.get("selectedModule"),
        "neutralOutput": str(neutral_path) if report.get("neutralOutput") else None,
        "productionLocked": report["productionLocked"],
    }, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 4


def run_spike(neutral_path: Path, force: bool) -> Dict[str, Any]:
    create_probe_report = load_probe_factory()
    probe = create_probe_report()
    selected_module = probe.get("selectedModule")
    runner_readiness = probe.get("runnerReadiness") or {}
    bindings = probe.get("recommendedBindings") or {}
    checks: List[Dict[str, Any]] = []

    add_check(checks, "probe-schema", probe.get("schema") == "hediao3d.opencamlib-runtime-probe.v1", "runtime probe schema must match")
    add_check(checks, "module-imported", bool(selected_module), "opencamlib/ocl module must import")
    add_check(checks, "runner-spike-ready", bool(runner_readiness.get("canAttemptRealContactSpike")) or force, "probe must expose a complete surface+cutter+dropCutter candidate set")
    add_check(checks, "bindings-surface", bool(bindings.get("surface")), "probe must recommend a surface binding")
    add_check(checks, "bindings-cutter", bool(bindings.get("cutter")), "probe must recommend a cutter binding")
    add_check(checks, "bindings-drop-cutter", bool(bindings.get("dropCutter")), "probe must recommend a drop-cutter binding")

    if not selected_module or (not runner_readiness.get("canAttemptRealContactSpike") and not force):
        return create_report("blocked", False, probe, checks, None, "Runtime is not ready for a real contact spike.")

    try:
        module = importlib.import_module(str(selected_module))
        spike = try_common_batch_drop_cutter(module, bindings)
        add_check(checks, "real-drop-cutter-call", spike is not None, "common BatchDropCutter/drop-cutter API call must complete")
    except Exception as exc:  # noqa: BLE001 - report exact deployment API mismatch.
        add_check(checks, "real-drop-cutter-call", False, "common BatchDropCutter/drop-cutter API call must complete", {"error": f"{type(exc).__name__}: {exc}"})
        spike = None

    if spike is None:
        return create_report("api-mapping-required", False, probe, checks, None, "OpenCAMLib module imports, but the common Python binding sequence did not run.")

    neutral = create_neutral_spike(spike, selected_module)
    neutral_path.parent.mkdir(parents=True, exist_ok=True)
    neutral_path.write_text(json.dumps(neutral, ensure_ascii=False, indent=2), encoding="utf-8")
    add_check(checks, "neutral-spike-written", neutral_path.exists(), "neutral spike JSON should be written")
    report = create_report("ready", True, probe, checks, neutral_path, "Real OpenCAMLib drop-cutter spike completed on tiny synthetic geometry.")
    report["spikeMetrics"] = spike.get("metrics")
    return report


def try_common_batch_drop_cutter(module: Any, bindings: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    path_spike = try_common_path_drop_cutter(module, bindings)
    if path_spike is not None:
        return path_spike

    point_cls = find_attr(module, ["Point"])
    triangle_cls = find_attr(module, ["Triangle"])
    surface_cls = find_attr(module, ["STLSurf", "STLSurface"])
    cutter_cls = find_attr(module, ["CylCutter", "FlatCutter", "BallCutter"])
    batch_cls = find_attr(module, ["BatchDropCutter", "DropCutter"])
    cl_point_cls = find_attr(module, ["CLPoint"])
    if not all([point_cls, triangle_cls, surface_cls, cutter_cls, batch_cls]):
        return None

    surface = surface_cls()
    add_triangle(surface, triangle_cls, point_cls, [[0, 0, 0], [20, 0, 0], [0, 20, 0]])
    add_triangle(surface, triangle_cls, point_cls, [[20, 0, 0], [20, 20, 1.2], [0, 20, 0]])
    cutter = instantiate_cutter(cutter_cls)
    dropper = batch_cls()
    call_first(dropper, ["setSTL", "setSTLSurf", "setSurface"], surface)
    call_first(dropper, ["setCutter"], cutter)
    input_points = []
    for x in [2.0, 8.0, 14.0, 18.0]:
        for y in [2.0, 10.0, 18.0]:
            input_points.append((x, y, 10.0))
            append_drop_point(dropper, point_cls, cl_point_cls, x, y, 10.0)
    call_first(dropper, ["run", "dropCutter", "runDropCutter"])
    output = get_points(dropper)
    if not output:
        return None
    return {
        "inputPoints": input_points,
        "outputPoints": output,
        "metrics": {
            "algorithm": "opencamlib-batch-drop-cutter-spike",
            "pointCount": len(output),
            "contactPointCount": len(output),
            "hitRate": 1.0 if output else 0.0,
            "bindings": {
                "surface": bindings.get("surface", {}).get("symbol") if isinstance(bindings.get("surface"), dict) else None,
                "cutter": bindings.get("cutter", {}).get("symbol") if isinstance(bindings.get("cutter"), dict) else None,
                "dropCutter": bindings.get("dropCutter", {}).get("symbol") if isinstance(bindings.get("dropCutter"), dict) else None,
            },
        },
    }


def try_common_path_drop_cutter(module: Any, bindings: Dict[str, Any]) -> Optional[Dict[str, Any]]:
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
    add_triangle(surface, triangle_cls, point_cls, [[0, 0, 0], [20, 0, 0], [0, 20, 0]])
    add_triangle(surface, triangle_cls, point_cls, [[20, 0, 0], [20, 20, 1.2], [0, 20, 0]])
    cutter = instantiate_cutter(cutter_cls)
    path = path_cls()
    input_points = []
    for y in [2.0, 10.0, 18.0]:
        start = point_cls(2.0, y, 10.0)
        end = point_cls(18.0, y, 10.0)
        line = line_cls(start, end)
        append_path_segment(path, line)
        input_points.append((2.0, y, 10.0))
        input_points.append((18.0, y, 10.0))

    dropper = dropper_cls()
    call_first(dropper, ["setSTL", "setSTLSurf", "setSurface"], surface)
    call_first(dropper, ["setCutter"], cutter)
    call_first(dropper, ["setPath"], path)
    call_optional(dropper, ["setZ"], 10.0)
    call_first(dropper, ["run", "dropCutter", "runDropCutter"])
    output = get_points(dropper)
    if not output:
        return None
    return {
        "inputPoints": input_points,
        "outputPoints": output,
        "metrics": {
            "algorithm": "opencamlib-path-drop-cutter-spike",
            "pointCount": len(output),
            "contactPointCount": len(output),
            "hitRate": 1.0 if output else 0.0,
            "bindings": {
                "surface": bindings.get("surface", {}).get("symbol") if isinstance(bindings.get("surface"), dict) else None,
                "cutter": bindings.get("cutter", {}).get("symbol") if isinstance(bindings.get("cutter"), dict) else None,
                "dropCutter": bindings.get("dropCutter", {}).get("symbol") if isinstance(bindings.get("dropCutter"), dict) else None,
            },
        },
    }


def find_attr(module: Any, names: List[str]) -> Any:
    for name in names:
        value = getattr(module, name, None)
        if value is not None:
            return value
    return None


def add_triangle(surface: Any, triangle_cls: Any, point_cls: Any, coords: List[List[float]]) -> None:
    triangle = triangle_cls(*(point_cls(*coord) for coord in coords))
    for method in ("addTriangle", "add_triangle", "add"):
        if hasattr(surface, method):
            getattr(surface, method)(triangle)
            return
    raise RuntimeError("surface object does not expose addTriangle/add_triangle/add")


def instantiate_cutter(cutter_cls: Any) -> Any:
    attempts = [
        (4.0, 20.0),
        (4.0,),
        (),
    ]
    last_error: Optional[Exception] = None
    for args in attempts:
        try:
            return cutter_cls(*args)
        except Exception as exc:  # noqa: BLE001 - try common constructor overloads.
            last_error = exc
    raise RuntimeError(f"could not instantiate cutter: {last_error}")


def call_first(obj: Any, methods: List[str], *args: Any) -> Any:
    for method in methods:
        if hasattr(obj, method):
            return getattr(obj, method)(*args)
    raise RuntimeError(f"object {type(obj).__name__} missing methods {methods}")


def call_optional(obj: Any, methods: List[str], *args: Any) -> bool:
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


def append_drop_point(dropper: Any, point_cls: Any, cl_point_cls: Any, x: float, y: float, z: float) -> None:
    point_attempts = []
    if cl_point_cls is not None:
        point_attempts.append(lambda: cl_point_cls(x, y, z))
    point_attempts.append(lambda: point_cls(x, y, z))
    last_error: Optional[Exception] = None
    for create in point_attempts:
        try:
            point = create()
            for method in ("appendPoint", "appendCLPoint", "append", "addPoint"):
                if hasattr(dropper, method):
                    getattr(dropper, method)(point)
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
    raise RuntimeError(f"could not append drop point: {last_error}")


def get_points(dropper: Any) -> List[Dict[str, float]]:
    for method in ("getCLPoints", "getPoints", "getCL"):
        if not hasattr(dropper, method):
            continue
        raw_points = getattr(dropper, method)()
        return [normalize_point(point) for point in list(raw_points)]
    return []


def normalize_point(point: Any) -> Dict[str, float]:
    values = {}
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


def create_neutral_spike(spike: Dict[str, Any], selected_module: str) -> Dict[str, Any]:
    points = []
    for item in spike["outputPoints"]:
        points.append({
            "x": round(float(item["x"]), 6),
            "a": round(float(item["y"]) / 20.0 * 360.0, 6),
            "z": round(float(item["z"]), 6),
            "depth": round(max(0.0, 10.0 - float(item["z"])), 6),
            "source": "opencamlib-real-contact-spike",
        })
    return {
        "schema": "hediao3d.neutral-toolpath.v1",
        "jobId": "opencamlib-real-contact-spike",
        "engine": "opencamlib",
        "synthetic": True,
        "fixture": True,
        "generatedBy": "adapters/opencamlib/opencamlib_contact_spike.py",
        "generatedByExternalCommand": True,
        "productionCandidate": False,
        "coordinate": {
            "lengthAxis": "X",
            "rotaryAxis": "Y",
            "depthAxis": "Z",
            "rotaryUnit": "degree",
        },
        "points": points,
        "runner": {
            "mode": "opencamlib-real-contact-spike",
            "opencamlibModule": selected_module,
            "operationMetrics": spike.get("metrics"),
            "productionBoundary": "Tiny synthetic geometry spike only; not a production candidate and not usable as machine NC.",
        },
    }


def create_report(level: str, ok: bool, probe: Dict[str, Any], checks: List[Dict[str, Any]], neutral_path: Optional[Path], summary: str) -> Dict[str, Any]:
    return {
        "schema": SCHEMA,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "ok": ok,
        "level": level,
        "summary": summary,
        "selectedModule": probe.get("selectedModule"),
        "probe": {
            "level": probe.get("level"),
            "runnerReadiness": probe.get("runnerReadiness"),
            "recommendedBindings": probe.get("recommendedBindings"),
        },
        "checks": checks,
        "neutralOutput": str(neutral_path) if ok and neutral_path else None,
        "productionLocked": True,
        "productionBoundary": "This spike proves only that a tiny OpenCAMLib drop-cutter call can run. It is not production CAM output and must not unlock trial or production NC.",
        "nextActions": next_actions(level),
    }


def next_actions(level: str) -> List[str]:
    if level == "ready":
        return [
            "Map the proven call sequence into opencamlib_runner.py for real job STL input.",
            "Generate neutral-toolpath.json plus opencamlib-cutter-contact-report.json from the real Buddha model.",
            "Run opencamlib-contact-output-validate.mjs and opencamlib-candidate-package-validate.mjs.",
        ]
    if level == "api-mapping-required":
        return [
            "Inspect opencamlib-runtime-probe.json callableSamples and update opencamlib_contact_spike.py with this deployment's binding names.",
            "Keep preview heightfield and all production NC locked.",
        ]
    return [
        "Install OpenCAMLib/ocl in the Linux CAM Python environment.",
        "Run python3 opencamlib-probe.py --out opencamlib-runtime-probe.json.",
        "Rerun python3 opencamlib-contact-spike.py --out opencamlib-real-contact-spike.json.",
    ]


def load_probe_factory() -> Any:
    try:
        from opencamlib_probe import create_probe_report  # type: ignore
        return create_probe_report
    except ModuleNotFoundError:
        sibling = Path(__file__).with_name("opencamlib-probe.py")
        if not sibling.exists():
            raise
        spec = importlib.util.spec_from_file_location("opencamlib_probe_from_package", sibling)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load probe module from {sibling}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.create_probe_report


def add_check(checks: List[Dict[str, Any]], check_id: str, ok: bool, summary: str, details: Optional[Dict[str, Any]] = None) -> None:
    checks.append({
        "id": check_id,
        "status": "pass" if ok else "fail",
        "ok": bool(ok),
        "severity": "info" if ok else "critical",
        "summary": summary,
        **(details or {}),
    })


if __name__ == "__main__":
    raise SystemExit(main())
