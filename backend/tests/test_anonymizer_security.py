"""Regression tests for the anonymizer hardening (audit security finding).

The anonymizer is deterministic pseudonymisation, not anonymisation. The fix
made the per-column salt depend on the server SECRET_KEY (so an attacker who
doesn't know it can't pre-compute a rainbow table) and widened the digest from
8 to 16 hex chars. If any of these regress, the pseudonymisation is trivially
reversible again.
"""

from app.config import settings
from app.services.anonymizer import _derive_column_salt, _hash_value


def test_hash_is_deterministic():
    assert _hash_value("alice@corp.com", "resource") == _hash_value("alice@corp.com", "resource")


def test_hash_width_is_16_hex_chars():
    # Was truncated to 8 hex chars (32 bits — birthday-collidable / brute-forceable);
    # widened to 16. Output is "anon_<16 hex>".
    h = _hash_value("some-case-id", "case")
    assert h.startswith("anon_")
    hex_part = h[len("anon_"):]
    assert len(hex_part) == 16
    assert all(c in "0123456789abcdef" for c in hex_part)


def test_salt_depends_on_secret_key(monkeypatch):
    """Two servers with different SECRET_KEYs must produce different pseudonyms
    for the same input — proving the salt is keyed, not a public constant."""
    monkeypatch.setattr(settings, "SECRET_KEY", "secret-key-number-one-aaaaaaaa", raising=False)
    salt_a = _derive_column_salt("case")
    hash_a = _hash_value("order-42", "case")

    monkeypatch.setattr(settings, "SECRET_KEY", "secret-key-number-two-bbbbbbbb", raising=False)
    salt_b = _derive_column_salt("case")
    hash_b = _hash_value("order-42", "case")

    assert salt_a != salt_b, "per-column salt must change with SECRET_KEY"
    assert hash_a != hash_b, "pseudonym must change with SECRET_KEY"


def test_different_columns_produce_different_salts():
    # Same value in different columns must not collide to the same pseudonym.
    assert _derive_column_salt("resource") != _derive_column_salt("case")
    assert _hash_value("X", "resource") != _hash_value("X", "case")
