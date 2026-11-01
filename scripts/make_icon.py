"""Generate the small native app icon without image dependencies."""

from pathlib import Path
import struct
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def main():
    side = 64
    rows = bytearray()
    for vertical in range(side):
        rows.append(0)
        for horizontal in range(side):
            shirt = (
                20 <= horizontal <= 43 and 22 <= vertical <= 49
                or 12 <= horizontal <= 22 and 17 <= vertical <= 29
                or 41 <= horizontal <= 51 and 17 <= vertical <= 29
                or 19 <= horizontal <= 44 and 15 <= vertical <= 24
            )
            neckline = 27 <= horizontal <= 36 and 14 <= vertical <= 21
            color = (165, 225, 204, 255) if shirt and not neckline else (19, 26, 33, 255)
            rows.extend(color)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b"")
    icons = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    (icons / "icon.png").write_bytes(png)
    ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(png), 22) + png
    (icons / "icon.ico").write_bytes(ico)
    print("Native icons generated")


if __name__ == "__main__":
    main()
