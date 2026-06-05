"""Fetch the BPI Challenge 2019 event log into tests/fixtures/bpic/.

Real SAP purchase-to-pay data (~1.6M events, CC BY 4.0, free, no login). The
file is git-ignored (728 MB uncompressed) — this just makes a local copy.

    python backend/scripts/fetch_bpic.py
    BPIC2019_XES_URL="https://…/BPI_Challenge_2019.xes.gz" python backend/scripts/fetch_bpic.py

Dataset page (stable reference if the direct URL rots):
    https://data.4tu.nl/articles/dataset/BPI_Challenge_2019/12715853
"""

from __future__ import annotations

import gzip
import os
import shutil
import sys
import urllib.request
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "bpic"
TARGET = DEST / "BPI_Challenge_2019.xes"
# Direct download from 4TU (may change; override with BPIC2019_XES_URL).
DEFAULT_URL = (
    "https://data.4tu.nl/file/35ed7122-966a-484e-a0e1-749b64e3366d/"
    "864493d1-3a58-47f6-ad6f-27f95f995828"
)


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    if TARGET.exists():
        print(f"✓ BPIC 2019 already present at {TARGET}")
        return 0

    url = os.environ.get("BPIC2019_XES_URL", DEFAULT_URL)
    gz_path = DEST / "bpic2019.xes.gz"
    print(f"Downloading {url} …\n(≈17 MB compressed; decompresses to ~728 MB)")
    try:
        urllib.request.urlretrieve(url, gz_path)  # noqa: S310 - known dataset host
    except Exception as e:
        print(
            f"ERROR: download failed ({e}).\nGet the XES manually from "
            "https://data.4tu.nl/articles/dataset/BPI_Challenge_2019/12715853 "
            f"and place it at {TARGET}, or set BPIC2019_XES_URL.",
            file=sys.stderr,
        )
        return 1

    # The download may be gzip or already-plain XES; handle both.
    try:
        with gzip.open(gz_path, "rb") as f_in, open(TARGET, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        gz_path.unlink(missing_ok=True)
    except OSError:
        # Not gzip — treat the downloaded bytes as the XES itself.
        gz_path.rename(TARGET)

    print(f"✓ BPIC 2019 ready at {TARGET} ({TARGET.stat().st_size // (1024*1024)} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
