#!/usr/bin/env python3
"""OpenCAMLib/ocl runtime capability probe for HeDiao3D V3.

This probe is intentionally read-only. It does not generate toolpaths and it
does not unlock production. Its job is to capture what the deployment Python
environment actually exposes so the real drop-cutter/cutter-contact runner can
be implemented against evidence instead of guesses.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import importlib.util
import inspect
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


SCHEMA = "hediao3d.opencamlib-runtime-probe.v1"
MODULE_CANDIDATES = ("opencamlib", "ocl")


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe OpenCAMLib/ocl runtime capabilities.")
    parser.add_argument("--out", help="Optional JSON output path.")
    args = parser.parse_args()

    report = create_probe_report()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
    print(text)
    return 0


def create_probe_report() -> Dict[str, Any]:
    module_reports = [probe_module(name) for name in MODULE_CANDIDATES]
    selected = next((item for item in module_reports if item["imported"]), None)
    capability_summary = summarize_capabilities(selected)
    recommended_bindings = create_recommended_bindings(selected)
    runner_readiness = create_runner_readiness(selected, capability_summary, recommended_bindings)
    level = "ready" if capability_summary["dropCutterReady"] else "partial" if selected else "missing"
    blockers: List[str] = []
    warnings: List[str] = []
    if not selected:
        blockers.append("Neither opencamlib nor ocl can be imported in this Python environment.")
    elif not capability_summary["dropCutterReady"]:
        warnings.append("OpenCAMLib module imported, but expected surface/cutter/drop-cutter symbols were not all found by introspection.")

    return {
        "schema": SCHEMA,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "python": {
            "executable": sys.executable,
            "version": sys.version,
            "platform": platform.platform(),
        },
        "modules": module_reports,
        "selectedModule": selected["name"] if selected else None,
        "capabilitySummary": capability_summary,
        "recommendedBindings": recommended_bindings,
        "runnerReadiness": runner_readiness,
        "integrationPlan": create_integration_plan(level, selected, recommended_bindings),
        "blockers": blockers,
        "warnings": warnings,
        "nextActions": create_next_actions(level, selected, capability_summary),
        "productionBoundary": "This probe is runtime evidence only. It must not be used as cutter-contact output or production NC evidence.",
    }


def probe_module(name: str) -> Dict[str, Any]:
    spec = safe_find_spec(name)
    base: Dict[str, Any] = {
        "name": name,
        "available": spec is not None,
        "origin": spec.origin if spec and spec.origin else None,
        "imported": False,
        "version": detect_distribution_version(name),
        "error": None,
        "symbolCount": 0,
        "symbols": [],
        "candidateSymbols": {},
        "callableSamples": [],
    }
    if spec is None:
        return base
    try:
        module = importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001 - probe must report import-time failures.
        base["error"] = f"{type(exc).__name__}: {exc}"
        return base
    symbols = sorted(dir(module))
    base.update({
        "imported": True,
        "symbolCount": len(symbols),
        "symbols": symbols[:300],
        "candidateSymbols": classify_symbols(symbols),
        "callableSamples": create_callable_samples(module, symbols),
    })
    return base


def create_recommended_bindings(selected: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not selected:
        return {
            "schema": "hediao3d.opencamlib-recommended-bindings.v1",
            "module": None,
            "status": "missing-module",
            "surface": None,
            "cutter": None,
            "dropCutter": None,
            "waterline": None,
            "notes": ["No importable OpenCAMLib/ocl module was found."],
        }
    candidates = selected.get("candidateSymbols") or {}
    samples = {item.get("name"): item for item in selected.get("callableSamples") or []}
    surface = choose_symbol(candidates.get("surfaces") or [], ["STLSurf", "STLSurface", "Surface", "Triangle"])
    cutter = choose_symbol(candidates.get("cutters") or [], ["CylCutter", "BallCutter", "BullCutter", "ConeCutter", "FlatCutter"])
    drop = choose_symbol(candidates.get("dropCutter") or [], ["BatchDropCutter", "DropCutter", "CLPoint", "CutterLocation", "Contact"])
    waterline = choose_symbol(candidates.get("waterline") or [], ["Waterline", "Weave", "Fiber"])
    required = [surface, cutter, drop]
    status = "candidate-complete" if all(required) else "candidate-incomplete"
    notes: List[str] = []
    if not surface:
        notes.append("No surface/STL mesh binding candidate found.")
    if not cutter:
        notes.append("No cutter geometry binding candidate found.")
    if not drop:
        notes.append("No drop-cutter/cutter-contact binding candidate found.")
    if not waterline:
        notes.append("No waterline binding candidate found; this is acceptable for the first drop-cutter finishing pass.")
    return {
        "schema": "hediao3d.opencamlib-recommended-bindings.v1",
        "module": selected.get("name"),
        "status": status,
        "surface": describe_binding(surface, samples),
        "cutter": describe_binding(cutter, samples),
        "dropCutter": describe_binding(drop, samples),
        "waterline": describe_binding(waterline, samples),
        "notes": notes,
    }


def choose_symbol(symbols: List[str], preferred_patterns: List[str]) -> Optional[str]:
    for pattern in preferred_patterns:
        for symbol in symbols:
            if re.search(pattern, symbol, re.I):
                return symbol
    return symbols[0] if symbols else None


def describe_binding(symbol: Optional[str], samples: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not symbol:
        return None
    sample = samples.get(symbol) or {}
    return {
        "symbol": symbol,
        "kind": sample.get("kind") or "unknown",
        "signature": sample.get("signature"),
        "doc": sample.get("doc"),
    }


def create_runner_readiness(selected: Optional[Dict[str, Any]], capability_summary: Dict[str, Any], recommended_bindings: Dict[str, Any]) -> Dict[str, Any]:
    missing: List[str] = []
    if not selected:
        missing.append("module")
    for key in ("surface", "cutter", "dropCutter"):
        if not recommended_bindings.get(key):
            missing.append(key)
    level = "ready-for-runner-spike" if not missing and capability_summary.get("dropCutterReady") else "blocked" if not selected else "needs-api-mapping"
    return {
        "schema": "hediao3d.opencamlib-runner-readiness.v1",
        "level": level,
        "canAttemptRealContactSpike": level == "ready-for-runner-spike",
        "missing": missing,
        "requiredOutputFiles": [
            "neutral-toolpath.json",
            "opencamlib-cutter-contact-report.json",
            "opencamlib-candidate-package-validation.json",
        ],
        "productionBoundary": "Even ready-for-runner-spike only permits a Linux experiment. Production remains locked until strict validator, CAMotics/material evidence and machine acceptance pass.",
    }


def create_integration_plan(level: str, selected: Optional[Dict[str, Any]], recommended_bindings: Dict[str, Any]) -> List[Dict[str, Any]]:
    module = selected.get("name") if selected else None
    return [
        {
            "id": "api-map",
            "status": "ready" if recommended_bindings.get("status") == "candidate-complete" else "blocked",
            "summary": f"Map {module or 'OpenCAMLib'} surface/cutter/drop-cutter symbols into adapters/opencamlib/opencamlib_runner.py.",
        },
        {
            "id": "real-contact-spike",
            "status": "ready" if level == "ready" else "blocked",
            "summary": "Generate a tiny non-production neutral-toolpath and cutter-contact report from a closed STL using real OpenCAMLib calls.",
        },
        {
            "id": "strict-validate",
            "status": "pending",
            "summary": "Run opencamlib-contact-output-validate.mjs and opencamlib-candidate-package-validate.mjs on the real output directory.",
        },
        {
            "id": "orchestrator-import",
            "status": "pending",
            "summary": "Import validated neutral-toolpath into HeDiao3D, then keep trial/production locked until CAMotics and machine evidence are bound.",
        },
    ]


def classify_symbols(symbols: List[str]) -> Dict[str, List[str]]:
    groups = {
        "surfaces": r"(STL|Surf|Surface|Triangle|Mesh)",
        "cutters": r"(Cutter|Ball|Bull|Cyl|Cone|Flat|V)",
        "dropCutter": r"(Drop|BatchDrop|CLPoint|CutterLocation|Contact)",
        "waterline": r"(Waterline|Weave|Path|Fiber)",
        "utilities": r"(Point|Vector|Line|Interval|Adaptive|Batch)",
    }
    return {
        group: [symbol for symbol in symbols if re.search(pattern, symbol, re.I)][:80]
        for group, pattern in groups.items()
    }


def create_callable_samples(module: Any, symbols: List[str]) -> List[Dict[str, Any]]:
    samples: List[Dict[str, Any]] = []
    for symbol in symbols:
        if len(samples) >= 80:
            break
        if symbol.startswith("_"):
            continue
        try:
            value = getattr(module, symbol)
        except Exception:
            continue
        if not callable(value):
            continue
        signature: Optional[str] = None
        try:
            signature = str(inspect.signature(value))
        except (TypeError, ValueError):
            signature = None
        samples.append({
            "name": symbol,
            "kind": "class" if inspect.isclass(value) else "function" if inspect.isfunction(value) else "callable",
            "signature": signature,
            "doc": first_doc_line(value),
        })
    return samples


def summarize_capabilities(selected: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not selected:
        return {
            "moduleImported": False,
            "surfaceCandidateCount": 0,
            "cutterCandidateCount": 0,
            "dropCutterCandidateCount": 0,
            "waterlineCandidateCount": 0,
            "dropCutterReady": False,
            "summary": "OpenCAMLib/ocl module is not importable.",
        }
    candidates = selected.get("candidateSymbols") or {}
    surface_count = len(candidates.get("surfaces") or [])
    cutter_count = len(candidates.get("cutters") or [])
    drop_count = len(candidates.get("dropCutter") or [])
    waterline_count = len(candidates.get("waterline") or [])
    ready = surface_count > 0 and cutter_count > 0 and drop_count > 0
    return {
        "moduleImported": True,
        "surfaceCandidateCount": surface_count,
        "cutterCandidateCount": cutter_count,
        "dropCutterCandidateCount": drop_count,
        "waterlineCandidateCount": waterline_count,
        "dropCutterReady": ready,
        "summary": "Runtime exposes surface, cutter and drop-cutter/contact candidates." if ready else "Runtime imported, but introspection did not find a complete surface+cutter+drop-cutter candidate set.",
    }


def create_next_actions(level: str, selected: Optional[Dict[str, Any]], capability_summary: Dict[str, Any]) -> List[str]:
    if level == "missing":
        return [
            "Install OpenCAMLib/ocl in the same Python environment used by the HeDiao3D external adapter.",
            "Rerun python adapters/opencamlib/opencamlib_probe.py --out opencamlib-runtime-probe.json.",
        ]
    if level == "partial":
        return [
            f"Inspect opencamlib-runtime-probe.json candidateSymbols for module {selected['name'] if selected else 'unknown'}.",
            "Map the exposed surface/cutter/drop-cutter API into opencamlib_runner.py before enabling production-candidate output.",
            "Keep HEDIAO3D_OPENCAMLIB_RUNNER_HEIGHTFIELD_OUTPUT as preview-only until strict contact validation is ready.",
        ]
    return [
        f"Implement real drop-cutter/cutter-contact sampling against module {selected['name']}.",
        "Write neutral-toolpath.json plus hediao3d.opencamlib-cutter-contact-report.v1.",
        "Run opencamlib-contact-output-validate.mjs and opencamlib-candidate-package-validate.mjs before importing output into HeDiao3D.",
    ]


def safe_find_spec(name: str) -> Any:
    try:
        return importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None


def detect_distribution_version(name: str) -> Optional[str]:
    candidates = [name, "OpenCAMLib", "opencamlib"]
    for candidate in candidates:
        try:
            return importlib.metadata.version(candidate)
        except importlib.metadata.PackageNotFoundError:
            continue
    return None


def first_doc_line(value: Any) -> Optional[str]:
    doc = inspect.getdoc(value)
    if not doc:
        return None
    return doc.splitlines()[0][:240]


if __name__ == "__main__":
    raise SystemExit(main())
