from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw


def _pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _assemble_pdf(objects: list[bytes]) -> bytes:
    output = bytearray(b"%PDF-1.4\n%PP1 Phase 1 synthetic\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


def born_digital_pdf(pages: list[list[str]]) -> bytes:
    page_numbers = [4 + index * 2 for index in range(len(pages))]
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{' '.join(f'{number} 0 R' for number in page_numbers)}] /Count {len(pages)} >>".encode("ascii"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, lines in enumerate(pages):
        page_number = page_numbers[index]
        content_number = page_number + 1
        commands = ["BT", "/F1 18 Tf"]
        y = 740
        for line in lines:
            commands.extend([f"1 0 0 1 54 {y} Tm", f"({_pdf_escape(line)}) Tj"])
            y -= 28
        commands.append("ET")
        stream = "\n".join(commands).encode("ascii")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_number} 0 R >>".encode("ascii")
        )
        objects.append(b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream")
    return _assemble_pdf(objects)


def _image_bytes(fmt: str, size: tuple[int, int], text: str) -> bytes:
    image = Image.new("RGB", size, (248, 248, 244))
    draw = ImageDraw.Draw(image)
    draw.text((12, 12), text, fill=(20, 35, 50))
    output = BytesIO()
    if fmt == "JPEG":
        image.save(output, "JPEG", quality=85, subsampling=1, optimize=False, progressive=False)
    else:
        image.save(output, "PNG", optimize=False, compress_level=6)
    image.close()
    return output.getvalue()


def scanned_pdf(jpeg: bytes, width: int, height: int) -> bytes:
    content = b"q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
        (
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>\nstream\n".encode("ascii")
            + jpeg
            + b"\nendstream"
        ),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    ]
    return _assemble_pdf(objects)


def oversized_png_header(width: int, height: int) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    return signature + chunk(b"IHDR", ihdr_data) + chunk(b"IEND", b"")


def generate(output_dir: Path) -> dict[str, dict[str, str | int]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    png = _image_bytes("PNG", (640, 480), "Synthetic PNG poster")
    jpeg = _image_bytes("JPEG", (640, 480), "Synthetic JPEG poster")
    low = _image_bytes("PNG", (64, 64), "Low")
    scanned_jpeg = _image_bytes("JPEG", (320, 220), "Scanned raster only")
    assets = {
        "born-digital-one-page.pdf": born_digital_pdf(
            [["Synthetic Native Extraction Poster", "Bounded evidence for Phase 1 validation."]]
        ),
        "born-digital-multi-page.pdf": born_digital_pdf(
            [
                ["Synthetic Multi Page Poster", "Page one native text."],
                ["Second Evidence Page", "Page two native text remains ordered."],
            ]
        ),
        "scanned-raster.pdf": scanned_pdf(scanned_jpeg, 320, 220),
        "corrupt.pdf": b"%PDF-1.4\n1 0 obj\n<< deliberately truncated synthetic fixture",
        "empty.pdf": b"",
        "valid.png": png,
        "valid.jpg": jpeg,
        "low-resolution.png": low,
        "oversized-dimensions.png": oversized_png_header(50_000, 50_000),
        "unsupported.txt": b"Synthetic unsupported document type.",
    }
    manifest: dict[str, dict[str, str | int]] = {}
    for name, data in sorted(assets.items()):
        (output_dir / name).write_bytes(data)
        manifest[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    (output_dir / "generation.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(generate(args.output_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
