from __future__ import annotations

import argparse
import json
from pathlib import Path

from .contract import DocumentType, ExtractionStatus
from .ocr.tesseract import TesseractProvider
from .service import extract_staged_document


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract bounded evidence from a trusted staging root")
    parser.add_argument("--staging-root", type=Path, required=True)
    parser.add_argument("--relative-path", required=True)
    parser.add_argument("--claimed-type", choices=[value.value for value in DocumentType])
    parser.add_argument("--ocr-provider", choices=["none", "tesseract"], default="none")
    parser.add_argument("--tesseract-executable", type=Path)
    parser.add_argument("--raster-dpi", type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    provider = None
    if args.ocr_provider == "tesseract":
        provider = TesseractProvider(executable=args.tesseract_executable)
    result = extract_staged_document(
        allowed_root=args.staging_root,
        relative_path=args.relative_path,
        claimed_media_type=DocumentType(args.claimed_type) if args.claimed_type else None,
        ocr_provider=provider,
        raster_dpi=args.raster_dpi,
    )
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    return 0 if result.status is not ExtractionStatus.FAILED else 1


if __name__ == "__main__":
    raise SystemExit(main())
