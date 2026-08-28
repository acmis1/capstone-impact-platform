from __future__ import annotations

import argparse
from pathlib import Path

from ..ocr_title_latency.schema import canonical_json_bytes, tool_root
from .one_shot import check_result, run_once
from .seal import check_seal, prepare_holdout


def main() -> int:
    parser = argparse.ArgumentParser(description="Sealed PP1 title-latency fresh holdout")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--freeze-commit", required=True)
    prepare.add_argument("--assets-dir", type=Path, required=True)
    check = sub.add_parser("check-seal")
    check.add_argument("--assets-dir", type=Path)
    check.add_argument("--allow-consumed", action="store_true")
    run = sub.add_parser("run-once")
    run.add_argument("--assets-dir", type=Path, required=True)
    run.add_argument("--run-dir", type=Path, default=tool_root() / "artifacts" / "ocr-title-latency-holdout-run")
    run.add_argument("--models-dir", type=Path, required=True)
    sub.add_parser("check-result")
    args = parser.parse_args()
    if args.command == "prepare":
        print(prepare_holdout(args.freeze_commit, args.assets_dir))
        return 0
    if args.command == "check-seal":
        print(
            canonical_json_bytes(
                check_seal(assets_dir=args.assets_dir, require_unconsumed=not args.allow_consumed)
            ).decode(),
            end="",
        )
        return 0
    if args.command == "run-once":
        print(canonical_json_bytes(run_once(assets_dir=args.assets_dir, run_dir=args.run_dir, models_dir=args.models_dir)).decode(), end="")
        return 0
    print(canonical_json_bytes(check_result()).decode(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
