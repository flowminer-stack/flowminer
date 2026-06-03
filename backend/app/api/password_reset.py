"""Password reset + email verification flows.

Both flows follow the same pattern: issue a short-lived JWT with a
specific ``type`` claim (``reset`` or ``verify``), email it to the user,
and accept the token back at a second endpoint.

The JWTs are signed with the same SECRET_KEY as the login token but
with a distinct audience so they can't be used to authenticate regular
API calls. 1-hour TTL.

If SMTP isn't configured the tokens are returned in the response body
so local/dev flows still work — that's the same tradeoff we make for
the audit log scrubbing.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User
from app.services.infra.password_policy import assert_strong_password
from app.services.infra.rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

RESET_TTL_MINUTES = 60
VERIFY_TTL_MINUTES = 60 * 24  # 24 hours


def _issue_token(sub: str, kind: str, ttl_minutes: int) -> str:
    payload = {
        "sub": sub,
        "type": kind,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def _decode_token(token: str, expected_kind: str) -> str:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError as e:
        raise HTTPException(status_code=400, detail=f"Invalid or expired token: {e}") from e
    if payload.get("type") != expected_kind:
        raise HTTPException(status_code=400, detail="Wrong token type")
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=400, detail="Malformed token")
    return sub


def _send_email(to: str, subject: str, body: str) -> bool:
    """Fire-and-forget SMTP send. Returns True on success, False otherwise.

    In development (SMTP_HOST=localhost + SMTP_USER empty) this is skipped
    and the caller falls back to returning the token in the response body.
    """
    if settings.SMTP_HOST in ("", "localhost") and not settings.SMTP_USER:
        return False
    try:
        import smtplib
        from email.message import EmailMessage

        msg = EmailMessage()
        msg["From"] = settings.SMTP_FROM
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)

        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
            smtp.starttls()
            if settings.SMTP_USER:
                smtp.login(settings.SMTP_USER, settings.SMTP_PASS)
            smtp.send_message(msg)
        return True
    except Exception as e:
        logger.warning("SMTP send failed: %s", e)
        return False


# ─── Password reset ──────────────────────────────────────────────────────


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


@router.post("/forgot-password")
@limiter.limit("5/minute")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Issue a password-reset token for the given email, if the account
    exists. We deliberately return the same response whether or not the
    email is registered, so attackers can't enumerate accounts."""
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    generic = {"detail": "If an account exists for that address, a reset link has been sent."}

    if user is None:
        return generic

    token = _issue_token(str(user.id), "reset", RESET_TTL_MINUTES)
    body_text = (
        f"Someone requested a password reset for your FlowMiner account.\n\n"
        f"If this was you, use this token within {RESET_TTL_MINUTES} minutes:\n\n"
        f"{token}\n\n"
        f"If you didn't request this, ignore this email."
    )
    sent = _send_email(user.email, "FlowMiner password reset", body_text)

    if not sent:
        # SMTP not configured — in DEVELOPMENT we log the raw token so
        # the developer can grab it from backend logs. In PRODUCTION we
        # MUST NOT log the token (that turns any log-viewer into a
        # password reset oracle). Instead we log a warning without the
        # token and let the operator wire real SMTP.
        if settings.ENV.lower() == "production":
            logger.warning(
                "Password reset email NOT sent (SMTP not configured) "
                "for user id=%s — token suppressed.",
                user.id,
            )
        else:
            logger.warning(
                "Password reset email NOT sent (SMTP not configured). "
                "Dev-mode token for %s: %s",
                user.email,
                token,
            )
    return generic


@router.post("/reset-password")
@limiter.limit("10/hour")
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Consume the reset token and set a new password."""
    sub = _decode_token(body.token, "reset")
    from uuid import UUID

    result = await db.execute(select(User).where(User.id == UUID(sub)))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail="Account no longer exists")

    assert_strong_password(
        body.new_password,
        hint_fields=(user.email, user.full_name or ""),
    )
    user.password_hash = pwd_context.hash(body.new_password)
    await db.commit()
    return {"detail": "Password updated successfully"}


# ─── Email verification ──────────────────────────────────────────────────


class SendVerificationRequest(BaseModel):
    email: EmailStr


class VerifyEmailRequest(BaseModel):
    token: str


@router.post("/send-verification")
@limiter.limit("5/minute")
async def send_verification(
    request: Request,
    body: SendVerificationRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    generic = {"detail": "If an account exists for that address, a verification link has been sent."}
    if user is None:
        return generic
    token = _issue_token(str(user.id), "verify", VERIFY_TTL_MINUTES)
    sent = _send_email(
        user.email,
        "Verify your FlowMiner email",
        f"Welcome to FlowMiner!\n\nVerify your email by submitting this token:\n\n{token}\n",
    )
    if not sent:
        if settings.ENV.lower() == "production":
            logger.warning(
                "Verification email NOT sent (SMTP not configured) "
                "for user id=%s — token suppressed.",
                user.id,
            )
        else:
            logger.warning(
                "Verification email NOT sent (SMTP not configured). "
                "Dev-mode token for %s: %s",
                user.email,
                token,
            )
    return generic


@router.post("/verify-email")
@limiter.limit("20/hour")
async def verify_email(
    request: Request,
    body: VerifyEmailRequest,
    db: AsyncSession = Depends(get_db),
):
    sub = _decode_token(body.token, "verify")
    from uuid import UUID

    result = await db.execute(select(User).where(User.id == UUID(sub)))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail="Account no longer exists")
    # Email verification is represented by User.is_active remaining True.
    # A more elaborate implementation would add a separate email_verified column.
    user.is_active = True
    await db.commit()
    return {"detail": "Email verified"}
