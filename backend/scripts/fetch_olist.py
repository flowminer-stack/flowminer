"""Fetch the Olist e-commerce dataset into tests/fixtures/olist/.

Real-world relational order-to-cash data for the log-join tests. Two sources:

  * Kaggle CLI (default): needs ``~/.kaggle/kaggle.json`` — see
    https://www.kaggle.com/docs/api
  * A direct zip URL via ``OLIST_ZIP_URL`` (any mirror).

The data is CC BY-NC-SA (non-commercial) and is git-ignored — this script just
makes a local copy. Re-running is idempotent.

    python backend/scripts/fetch_olist.py
    OLIST_ZIP_URL="https://…/archive.zip" python backend/scripts/fetch_olist.py
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "olist"
REQUIRED = (
    "olist_orders_dataset.csv",
    "olist_order_items_dataset.csv",
    "olist_order_payments_dataset.csv",
)
KAGGLE_SLUG = "olistbr/brazilian-ecommerce"


def _have_all() -> bool:
    return all((DEST / f).exists() for f in REQUIRED)


def _from_url(url: str) -> None:
    print(f"Downloading {url} …")
    with urllib.request.urlopen(url) as resp:  # noqa: S310 - user-supplied mirror
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        zf.extractall(DEST)
    print(f"Extracted to {DEST}")


def _from_kaggle() -> None:
    print(f"Fetching '{KAGGLE_SLUG}' via the Kaggle CLI …")
    subprocess.run(
        ["kaggle", "datasets", "download", "-d", KAGGLE_SLUG, "-p", str(DEST), "--unzip"],
        check=True,
    )


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    if _have_all():
        print(f"✓ Olist data already present in {DEST}")
        return 0

    url = os.environ.get("OLIST_ZIP_URL")
    try:
        if url:
            _from_url(url)
        else:
            _from_kaggle()
    except FileNotFoundError:
        print(
            "ERROR: 'kaggle' CLI not found. Install it (`pip install kaggle`) and add "
            "~/.kaggle/kaggle.json, or set OLIST_ZIP_URL to a mirror zip.",
            file=sys.stderr,
        )
        return 1
    except subprocess.CalledProcessError as e:
        print(f"ERROR: kaggle download failed ({e}). See the README for options.", file=sys.stderr)
        return 1

    missing = [f for f in REQUIRED if not (DEST / f).exists()]
    if missing:
        print(f"WARNING: still missing {missing} after fetch.", file=sys.stderr)
        return 1
    print(f"✓ Olist data ready in {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
