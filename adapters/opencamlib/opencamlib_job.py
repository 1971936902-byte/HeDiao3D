#!/usr/bin/env python3
"""OpenCAMLib adapter placeholder for HeDiao3D V3.

Run target:
  python adapters/opencamlib/opencamlib_job.py job.json result.json

OpenCAMLib is a geometry kernel, not a full CAM application. This adapter slot is
reserved for drop-cutter, waterline and cutter-contact calculations that can
later replace parts of the internal Mesh CAM sampler while HeDiao3D keeps its
own rotary-wrap postprocessor.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def detect_opencamlib() -> dict:
    module = importlib.util.find_spec("opencamlib") or importlib.util.find_spec("ocl")
    return {
        "available": module is not None,
        "module": module.name if module else None,
        "origin": module.origin if module and module.origin else None,
    }


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
        result = {
            "status": "failed",
            "protocolVersion": "hediao3d.adapter.v1",
            "engine": "opencamlib",
            "jobId": job.get("jobId"),
            "error": f"Missing adapter job keys: {', '.join(missing)}",
            "warnings": [],
            "metrics": detection,
        }
    else:
        result = {
            "status": "adapter_not_ready",
            "protocolVersion": "hediao3d.adapter.v1",
            "engine": "opencamlib",
            "jobId": job.get("jobId"),
            "error": "OpenCAMLib adapter is scaffolded but not enabled for production cutter-contact output.",
            "warnings": [
                "Install OpenCAMLib/ocl on the Linux CAM server, then implement drop-cutter or waterline sampling recipes.",
                "Use this adapter as a geometry kernel; final NC should still go through HeDiao3D rotary-wrap postprocessing."
            ],
            "metrics": {
                **detection,
                "modelPath": job.get("modelPath"),
                "camMode": job.get("settings", {}).get("camMode"),
                "toolDiameter": job.get("settings", {}).get("toolDiameter"),
            }
        }

    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
