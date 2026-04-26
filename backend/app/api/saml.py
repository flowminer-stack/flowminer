"""SAML SSO endpoints — optional, disabled by default.

Gated on ``SAML_ENABLED=1`` + IdP metadata URL/XML. Uses python3-saml
(lazy-imported so the OSS install doesn't pull in xmlsec).

Endpoints:
  GET  /auth/saml/status      — is SAML configured?
  GET  /auth/saml/login       — return the SAML AuthnRequest URL
  POST /auth/saml/acs         — Assertion Consumer Service; exchange
                                the SAMLResponse for a FlowMiner JWT
"""

from __future__ import annotations

import os
from base64 import b64decode

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import create_access_token
from app.config import settings
from app.database import get_db
from app.models import User, UserRole

router = APIRouter()


def _saml_enabled() -> bool:
    return bool(os.getenv("SAML_ENABLED"))


def _require_saml():
    if not _saml_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SAML SSO is not configured on this FlowMiner instance",
        )


def _saml_settings() -> dict:
    """Minimal python3-saml settings dict built from env vars."""
    return {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": os.getenv("SAML_SP_ENTITY_ID", "flowminer"),
            "assertionConsumerService": {
                "url": os.getenv("SAML_SP_ACS_URL", ""),
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        },
        "idp": {
            "entityId": os.getenv("SAML_IDP_ENTITY_ID", ""),
            "singleSignOnService": {
                "url": os.getenv("SAML_IDP_SSO_URL", ""),
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": os.getenv("SAML_IDP_X509_CERT", ""),
        },
    }


@router.get("/saml/status")
async def saml_status():
    """Public endpoint so the login page can show the SAML button."""
    return {
        "enabled": _saml_enabled(),
        "entity_id": os.getenv("SAML_SP_ENTITY_ID", "") if _saml_enabled() else None,
    }


@router.get("/saml/login")
async def saml_login(request: Request):
    """Return the SAML AuthnRequest redirect URL."""
    _require_saml()
    try:
        from onelogin.saml2.auth import OneLogin_Saml2_Auth
    except ImportError:
        raise HTTPException(status_code=500, detail="python3-saml is not installed")

    req_data = {
        "https": "on" if request.url.scheme == "https" else "off",
        "http_host": request.url.hostname or "",
        "server_port": str(request.url.port or ""),
        "script_name": request.url.path,
        "get_data": dict(request.query_params),
        "post_data": {},
    }
    auth = OneLogin_Saml2_Auth(req_data, _saml_settings())
    return {"authn_request_url": auth.login()}


@router.post("/saml/acs")
async def saml_acs(
    request: Request,
    db: AsyncSession = Depends(get_db),
    SAMLResponse: str = Form(...),
):
    """Assertion Consumer Service — validate the SAMLResponse, find or
    create the matching user, and return a FlowMiner JWT."""
    _require_saml()
    try:
        from onelogin.saml2.auth import OneLogin_Saml2_Auth
    except ImportError:
        raise HTTPException(status_code=500, detail="python3-saml is not installed")

    req_data = {
        "https": "on" if request.url.scheme == "https" else "off",
        "http_host": request.url.hostname or "",
        "server_port": str(request.url.port or ""),
        "script_name": request.url.path,
        "get_data": {},
        "post_data": {"SAMLResponse": SAMLResponse},
    }
    auth = OneLogin_Saml2_Auth(req_data, _saml_settings())
    auth.process_response()
    errors = auth.get_errors()
    if errors:
        raise HTTPException(status_code=400, detail=f"SAML errors: {errors}")
    if not auth.is_authenticated():
        raise HTTPException(status_code=401, detail="SAML response is not authenticated")

    email = auth.get_nameid() or auth.get_attribute("email")
    if isinstance(email, list):
        email = email[0] if email else None
    if not email:
        raise HTTPException(status_code=400, detail="SAML response has no email")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            email=email,
            password_hash="!saml-only!",
            full_name=(auth.get_attribute("name") or [email.split("@")[0]])[0],
            role=UserRole.analyst,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    token = create_access_token({"sub": str(user.id)})
    return {"access_token": token, "token_type": "bearer", "user_id": str(user.id)}
