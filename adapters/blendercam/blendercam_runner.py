#!/usr/bin/env python3
"""Deployable BlenderCAM/FabexCNC external-command runner scaffold.

The adapter calls this command as:

  python blendercam_runner.py job.json blendercam-cam-plan.json toolpath.nc

Production deployment should run an equivalent command inside Blender
(`blender --background --python ...`) and replace the fixture with real
BlenderCAM/FabexCNC operation setup and postprocessing.
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: blendercam_runner.py <job.json> <blendercam-cam-plan.json> <toolpath.nc>", file=sys.stderr)
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

    if not is_true(os.environ.get("HEDIAO3D_BLENDERCAM_RUNNER_FIXTURE_OUTPUT")):
        print("BlenderCAM runner fixture output is disabled; real BlenderCAM/FabexCNC output is not implemented in this scaffold.", file=sys.stderr)
        return 4

    output_path.parent.mkdir(parents=True, exist_ok=True)
    gcode = create_fixture_gcode(job, plan)
    output_path.write_text(gcode, encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "mode": "blendercam-fixture-gcode",
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
    depth = min(1.4, max(0.25, float(settings.get("depthMm") or settings.get("maxCutDepth") or 0.9)))
    feed = int(float(settings.get("feedRate") or 180))
    spindle = int(float(settings.get("spindleRpm") or 12000))
    x0 = -length / 2
    x1 = length / 2
    lines = [
        "(HeDiao3D BlenderCAM external runner fixture)",
        f"(JOB_ID={job.get('jobId')})",
        "(SOURCE=BlenderCAM adapter external command contract)",
        *rotary_header(settings),
        "G21",
        "G90",
        f"S{spindle} M3",
        f"G0 X{x0:.4f} Y0.0000 Z{safe_z:.4f}",
    ]
    steps = 8
    for index in range(steps + 1):
        t = index / steps
        x = x0 + (x1 - x0) * t
        y = math.sin(t * math.pi * 2) * 2.4
        z = -depth * (0.55 + 0.35 * math.sin(t * math.pi))
        command = "G1" if index else "G0"
        lines.append(f"{command} X{x:.4f} Y{y:.4f} Z{z:.4f} F{feed}")
    lines.extend([
        f"G0 Z{safe_z:.4f}",
        "M5",
        "M30",
        "",
    ])
    return "\n".join(lines)


def rotary_header(settings: Dict[str, Any]) -> list[str]:
    if settings.get("camMode") != "rotaryWrap":
        return []
    rotary_axis = str(settings.get("rotaryOutputAxis") or "Y").upper()
    wrap = float(settings.get("rotaryWrapPerRevolutionMm") or 100)
    return [
        f"(ROTARY_WRAP_AXIS={rotary_axis} ROTARY_WRAP_PER_REV_MM={wrap:.6f} LENGTH_AXIS=X)",
    ]


def is_true(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    raise SystemExit(main())
