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
