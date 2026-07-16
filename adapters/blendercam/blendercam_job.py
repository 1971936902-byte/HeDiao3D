#!/usr/bin/env python3
"""BlenderCAM/FabexCNC adapter placeholder for HeDiao3D V3.

Run target:
  blender --background --python adapters/blendercam/blendercam_job.py -- job.json result.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def adapter_args() -> list[str]:
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return sys.argv[1:]


def main() -> int:
    args = adapter_args()
    if len(args) < 2:
        print("Usage: blendercam_job.py <job.json> <result.json>", file=sys.stderr)
        return 2

    job_path = Path(args[0])
    result_path = Path(args[1])
    job = json.loads(job_path.read_text(encoding="utf-8"))
    result = {
        "status": "adapter_not_ready",
        "engine": "blendercam",
        "error": "BlenderCAM/FabexCNC adapter is scaffolded but not enabled for production toolpath output.",
        "warnings": [
            "Install Blender and BlenderCAM/FabexCNC, then implement mesh import, operation setup and G-code export."
        ],
        "metrics": {
            "modelPath": job.get("modelPath"),
            "camMode": job.get("settings", {}).get("camMode")
        }
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
