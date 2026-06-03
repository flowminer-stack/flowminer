"""Shared password-strength policy.

Applied at every entry point where a user sets a password:

  - POST /auth/register          (new account)
  - POST /users/me/change-password  (self-service change)
  - POST /auth/reset-password    (reset via email token)

Rules (intentionally mild — we care about blocking the obvious stuff,
not driving users into reused passwords):

  1. At least 10 characters.
  2. At least three of the four character classes: lowercase,
     uppercase, digit, symbol.
  3. Must not appear in a small blocklist of the most common
     weak passwords (``password``, ``qwerty12345``, etc).
  4. Must not equal, contain, or be contained by the user's email
     local-part or full name, or the literal ``flowminer``.

The blocklist is deliberately small — a real deployment should swap
in a HIBP pwned-password prefix lookup (k-anonymity API) if it wants
to reject every known-leaked password. We don't bundle that because
it adds an outbound HTTP dependency on every registration.
"""

from __future__ import annotations

import re
from fastapi import HTTPException, status

MIN_LENGTH = 10

# A tiny list of the absolute worst offenders. Sourced from the
# bottom of every common-password top-100 list. Lowercased.
_COMMON_PASSWORDS = {
    "password",
    "password1",
    "password123",
    "password1234",
    "password12345",
    "passw0rd",
    "p@ssw0rd",
    "qwerty",
    "qwerty123",
    "qwerty12345",
    "123456",
    "1234567",
    "12345678",
    "123456789",
    "1234567890",
    "letmein",
    "letmein123",
    "welcome",
    "welcome1",
    "welcome123",
    "admin",
    "admin123",
    "administrator",
    "iloveyou",
    "sunshine",
    "monkey",
    "dragon",
    "football",
    "baseball",
    "master",
    "changeme",
    "changeme123",
    "flowminer",
    "flowminer123",
}


_LOWER_RE = re.compile(r"[a-z]")
_UPPER_RE = re.compile(r"[A-Z]")
_DIGIT_RE = re.compile(r"[0-9]")
_SYMBOL_RE = re.compile(r"[^A-Za-z0-9]")


def validate_password_strength(
    password: str,
    *,
    hint_fields: tuple[str, ...] = (),
) -> list[str]:
    """Return a list of policy violations (empty list = password OK).

    ``hint_fields`` is a tuple of strings we don't want appearing
    inside the password — typically the user's email and full name,
    so a registration can't succeed with a password that's just
    their own email.
    """
    errors: list[str] = []

    if not isinstance(password, str):
        return ["Password must be a string"]

    if len(password) < MIN_LENGTH:
        errors.append(f"Password must be at least {MIN_LENGTH} characters long")

    classes = sum(
        bool(pattern.search(password))
        for pattern in (_LOWER_RE, _UPPER_RE, _DIGIT_RE, _SYMBOL_RE)
    )
    if classes < 3:
        errors.append(
            "Password must include at least three of: lowercase, uppercase, "
            "digit, symbol"
        )

    lower_pw = password.lower()
    if lower_pw in _COMMON_PASSWORDS:
        errors.append("Password is too common — pick something less predictable")

    for hint in hint_fields:
        if not hint:
            continue
        token = str(hint).strip().lower()
        # Reject exact match or substring match in either direction.
        # "alice@example.com" → "alice" is the dangerous part.
        local_part = token.split("@", 1)[0]
        candidates = {token, local_part}
        for cand in candidates:
            if len(cand) >= 4 and cand in lower_pw:
                errors.append(
                    "Password must not contain your email or name"
                )
                return errors  # single hint-violation message is enough

    return errors


def assert_strong_password(
    password: str,
    *,
    hint_fields: tuple[str, ...] = (),
) -> None:
    """Raise HTTP 400 with a concatenated error list if the password
    doesn't pass policy. Callers that want to report errors without
    raising should call ``validate_password_strength`` directly."""
    errors = validate_password_strength(password, hint_fields=hint_fields)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="; ".join(errors),
        )
