#!/usr/bin/env python3
"""Deployable FreeCAD external-command runner scaffold for HeDiao3D V3.

The adapter calls this command as:

  python freecad_runner.py job.json freecad-cam-plan.json toolpath.nc

This scaffold validates the handoff and fails closed by default. The gated
fixture mode is only for adapter contract tests; real deployment should replace
it with FreeCAD Path operation creation and postprocessing.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: freecad_runner.py <job.json> <freecad-cam-plan.json> <toolpath.nc>", file=sys.stderr)
        return 2

    job_path = Path(sys.argv[-3])
    plan_path = Path(sys.argv[-2])
    output_path = Path(sys.argv[-1])
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"failed to read job/plan: {exc}", file=sys.stderr)
        return 3

    if not is_true(os.environ.get("HEDIAO3D_FREECAD_RUNNER_FIXTURE_OUTPUT")):
        print("FreeCAD runner fixture output is disabled; real FreeCAD Path output is not implemented in this scaffold.", file=sys.stderr)
        return 4

    output_path.parent.mkdir(parents=True, exist_ok=True)
    gcode = create_fixture_gcode(job, plan)
    output_path.write_text(gcode, encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "mode": "freecad-fixture-gcode",
        "jobId": job.get("jobId"),
        "output": str(output_path),
        "bytes": len(gcode.encode("utf-8")),
    }, ensure_ascii=False))
    return 0


def create_fixture_gcode(job: Dict[str, Any], plan: Dict[str, Any]) -> str:
    settings = job.get("settings") or {}
    stock = plan.get("stock") or {}
    length = float(stock.get("lengthMm") or settings.get("lengthMm") or 38)
    safe_z = float(settings.get("safeZ") or 22)
    depth = min(1.2, max(0.2, float(settings.get("depthMm") or settings.get("maxCutDepth") or 0.8)))
    feed = int(float(settings.get("feedRate") or 180))
    spindle = int(float(settings.get("spindleRpm") or 12000))
    x0 = round(-length / 2, 4)
    x1 = round(length / 2, 4)
    return "\n".join([
        "(HeDiao3D FreeCAD external runner fixture)",
        f"(JOB_ID={job.get('jobId')})",
        "(SOURCE=FreeCAD adapter external command contract)",
        "G21",
        "G90",
        f"S{spindle} M3",
        f"G0 X{x0:.4f} Y0.0000 Z{safe_z:.4f}",
        f"G1 X{x0:.4f} Y0.0000 Z{-depth:.4f} F{feed}",
        f"G1 X0.0000 Y2.0000 Z{-depth * 0.75:.4f} F{feed}",
        f"G1 X{x1:.4f} Y0.0000 Z{-depth:.4f} F{feed}",
        f"G0 Z{safe_z:.4f}",
        "M5",
        "M30",
        "",
    ])


def is_true(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    raise SystemExit(main())
