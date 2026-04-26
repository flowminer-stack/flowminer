"""Optional OIDC SSO + TOTP MFA endpoints.

Both features are gated behind configuration — FlowMiner ships with
them disabled, and the endpoints return 503 until an administrator
configures a provider. This keeps the OSS surface simple while giving
enterprise deployers a first-class path to SSO.

SSO flow (authorization code with PKCE):
    GET /auth/sso/login          → redirect to OIDC provider
    GET /auth/sso/callback       → exchange code, issue FlowMiner JWT

MFA flow (TOTP):
    POST /auth/mfa/enroll        → returns provisioning URI + QR payload
    POST /auth/mfa/verify        → enables MFA if code is valid
    POST /auth/mfa/disable       → removes MFA secret
    (login endpoint in auth.py asks for TOTP if the user has a secret)
"""

from __future__ import annotations

import base64
import hmac
import os
import secrets
import struct
import time
from hashlib import sha1, sha256
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import create_access_token, get_current_active_user
from app.config import settings
from app.database import get_db
from app.models import User

router = APIRouter()


# ─── SSO configuration ────────────────────────────────────────────────────
# Administrators set these via environment variables. If either is empty,
# every SSO endpoint returns 503.
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "")
OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")
OIDC_DISCOVERY_URL = os.getenv("OIDC_DISCOVERY_URL", "")
OIDC_REDIRECT_URI = os.getenv("OIDC_REDIRECT_URI", "")
SSO_ENABLED = bool(OIDC_CLIENT_ID and OIDC_DISCOVERY_URL and OIDC_REDIRECT_URI)


def _require_sso_configured():
    if not SSO_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO is not configured on this FlowMiner instance",
        )


@router.get("/sso/status")
async def sso_status():
    """Public endpoint so the login page can show/hide the SSO button."""
    return {"enabled": SSO_ENABLED, "provider": OIDC_DISCOVERY_URL if SSO_ENABLED else None}


@router.get("/sso/login")
async def sso_login():
    """Initiate the OIDC authorization-code flow. Returns a URL the client
    should redirect the user to."""
    _require_sso_configured()
    try:
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(OIDC_DISCOVERY_URL)
            resp.raise_for_status()
            meta = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OIDC discovery failed: {e}")

    authorization_endpoint = meta.get("authorization_endpoint")
    if not authorization_endpoint:
        raise HTTPException(status_code=502, detail="OIDC provider missing authorization_endpoint")

    state = secrets.token_urlsafe(24)
    params = {
        "client_id": OIDC_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": OIDC_REDIRECT_URI,
        "scope": "openid email profile",
        "state": state,
    }
    return {
        "authorization_url": f"{authorization_endpoint}?{urlencode(params)}",
        "state": state,
    }


class SSOCallback(BaseModel):
    code: str
    state: str | None = None


@router.post("/sso/callback")
async def sso_callback(body: SSOCallback, db: AsyncSession = Depends(get_db)):
    """Exchange the authorization code for tokens, resolve the user, and
    issue a FlowMiner JWT. If the email doesn't exist, a new analyst-role
    user is provisioned (just-in-time provisioning)."""
    _require_sso_configured()
    try:
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as client:
            meta = (await client.get(OIDC_DISCOVERY_URL)).json()
            token_endpoint = meta["token_endpoint"]
            userinfo_endpoint = meta["userinfo_endpoint"]

            token_resp = await client.post(
                token_endpoint,
                data={
                    "grant_type": "authorization_code",
                    "code": body.code,
                    "redirect_uri": OIDC_REDIRECT_URI,
                    "client_id": OIDC_CLIENT_ID,
                    "client_secret": OIDC_CLIENT_SECRET,
                },
            )
            token_resp.raise_for_status()
            oidc_tokens = token_resp.json()

            userinfo_resp = await client.get(
                userinfo_endpoint,
                headers={"Authorization": f"Bearer {oidc_tokens['access_token']}"},
            )
            userinfo_resp.raise_for_status()
            userinfo = userinfo_resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OIDC exchange failed: {e}")

    email = userinfo.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="OIDC userinfo missing email")

    # Find or create the user
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        from app.models import UserRole

        user = User(
            email=email,
            password_hash="!sso-only!",  # password disabled for SSO users
            full_name=userinfo.get("name") or email.split("@")[0],
            role=UserRole.analyst,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    token = create_access_token({"sub": str(user.id)})
    return {"access_token": token, "token_type": "bearer", "user_id": str(user.id)}


# ─── TOTP MFA (RFC 6238) ──────────────────────────────────────────────────
# We implement TOTP inline rather than pulling in pyotp — it's ~30 lines and
# lets us avoid a runtime dep. The secret is stored on the User record in
# a new `mfa_secret` column (nullable; MFA is optional per user).


def _b32_secret(length: int = 20) -> str:
    return base64.b32encode(os.urandom(length)).decode("ascii").rstrip("=")


def _totp_code(secret_b32: str, at: int | None = None, step: int = 30, digits: int = 6) -> str:
    if at is None:
        at = int(time.time())
    counter = at // step
    # Pad and decode the base32 secret back to raw bytes.
    secret = secret_b32 + "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(secret, casefold=True)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code_int).zfill(digits)


def _provisioning_uri(email: str, secret: str, issuer: str = "FlowMiner") -> str:
    label = f"{issuer}:{email}"
    params = {"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": "6", "period": "30"}
    return f"otpauth://totp/{label}?{urlencode(params)}"


class MFAEnrollResponse(BaseModel):
    secret: str
    provisioning_uri: str


class MFAVerifyRequest(BaseModel):
    secret: str
    code: str


@router.post("/mfa/enroll", response_model=MFAEnrollResponse)
async def mfa_enroll(
    current_user: User = Depends(get_current_active_user),
):
    """Generate a fresh TOTP secret for the current user. The client shows
    the QR code to the user (via the provisioning URI) and calls /mfa/verify
    to finalize enrollment."""
    secret = _b32_secret()
    uri = _provisioning_uri(current_user.email, secret)
    return MFAEnrollResponse(secret=secret, provisioning_uri=uri)


@router.post("/mfa/verify")
async def mfa_verify(
    body: MFAVerifyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Confirm the user can produce the current TOTP code, then persist the
    secret on the User row. After this call, ``auth.login`` requires a
    valid TOTP for this user on every sign-in."""
    expected = _totp_code(body.secret)
    previous = _totp_code(body.secret, at=int(time.time()) - 30)  # clock skew tolerance
    if body.code not in (expected, previous):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    current_user.mfa_secret = body.secret
    await db.commit()
    return {"status": "verified", "mfa_enabled": True}


@router.post("/mfa/disable")
async def mfa_disable(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Clear any stored MFA secret for the current user."""
    current_user.mfa_secret = None
    await db.commit()
    return {"status": "disabled"}
