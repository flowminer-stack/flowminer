"""
Authentication router: registration, login, activation, and current-user retrieval.
"""

import hashlib
import hmac
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User, UserRole
from app.schemas.user import ActivateRequest, Token, UserCreate, UserLogin, UserResponse
from app.api.deps import create_access_token, get_current_active_user, oauth2_scheme
from app.services.infra.password_policy import assert_strong_password
from app.services.infra.rate_limit import limiter
from app.services.infra.token_revocation import revoke_jti

router = APIRouter()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def register(
    request: Request,
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
):
    """Register a new user account.

    The very first registration on a fresh deployment is auto-promoted
    to ``admin`` so the operator doesn't need to run a manual SQL
    UPDATE to bootstrap the instance. Every later registration lands
    as ``analyst``; role changes after that require an existing admin
    hitting ``PUT /users/{id}/role``.
    """
    # Enforce the shared password policy (length + complexity +
    # common-password blocklist) before anything else.
    assert_strong_password(body.password, hint_fields=(body.email, body.full_name))

    # Check for existing email
    result = await db.execute(select(User).where(User.email == body.email))
    existing = result.scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this email already exists",
        )

    # First-user-becomes-admin bootstrap. The window between checking
    # the count and inserting the row is tiny; on a self-hosted instance
    # the operator who runs `docker compose up` is the same person
    # registering immediately afterwards, so concurrent registrations
    # racing for admin in practice don't happen. If they ever do, the
    # second admin can be demoted via the user-management UI.
    count_result = await db.execute(select(func.count()).select_from(User))
    is_first_user = (count_result.scalar() or 0) == 0
    new_role = UserRole.admin if is_first_user else UserRole.analyst

    user = User(
        email=body.email,
        password_hash=_hash_password(body.password),
        full_name=body.full_name,
        role=new_role,
    )

    db.add(user)
    await db.commit()
    await db.refresh(user)

    return user


@router.post("/activate", response_model=Token)
@limiter.limit("5/minute")
async def activate(
    request: Request,
    body: ActivateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Activate a pending account via a single-use, expiring token.

    Created by the bootstrap-admin-from-env flow (or any operator who sets a
    user's activation_token_hash). Validates the token, enforces the password
    policy, sets the password, marks the user active + verified, burns the
    token, and returns a JWT so the SPA can sign the user straight in.
    """
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    result = await db.execute(
        select(User).where(User.activation_token_hash == token_hash)
    )
    user = result.scalar_one_or_none()

    invalid = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid or expired activation link.",
    )
    # Lookup is by hash; the constant-time compare is defense-in-depth.
    if user is None or not user.activation_token_hash or not hmac.compare_digest(
        user.activation_token_hash, token_hash
    ):
        raise invalid

    expires = user.activation_token_expires_at
    if expires is None:
        raise invalid
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= datetime.now(timezone.utc):
        raise invalid

    assert_strong_password(body.password, hint_fields=(user.email, user.full_name))

    user.password_hash = _hash_password(body.password)
    user.is_active = True
    user.email_verified = True
    user.activation_token_hash = None  # single-use
    user.activation_token_expires_at = None
    await db.commit()

    return Token(access_token=create_access_token({"sub": str(user.id)}))


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    """
    Authenticate a user and return a JWT access token.

    Accepts the standard OAuth2 password form (username field contains the email).
    If the user has MFA enabled, the TOTP code must be passed as the ``scope``
    field of the form (this is how fastapi.security's OAuth2PasswordRequestForm
    exposes arbitrary side-channel data without breaking the OAuth2 flow).
    """
    email = form_data.username

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if user is None or not _verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    # MFA enforcement: if the user has a TOTP secret, require a valid code.
    if getattr(user, "mfa_secret", None):
        from app.api.sso import _totp_code
        import time as _time

        totp_code = (form_data.scopes[0] if form_data.scopes else "").strip()
        if not totp_code:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="MFA code required — pass the 6-digit TOTP code in the OAuth2 scope field.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        expected = _totp_code(user.mfa_secret)
        previous = _totp_code(user.mfa_secret, at=int(_time.time()) - 30)
        if totp_code not in (expected, previous):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid MFA code",
                headers={"WWW-Authenticate": "Bearer"},
            )

    access_token = create_access_token(data={"sub": str(user.id)})
    return Token(access_token=access_token, token_type="bearer")


@router.post("/login/json", response_model=Token)
@limiter.limit("10/minute")
async def login_json(
    request: Request,
    body: UserLogin,
    db: AsyncSession = Depends(get_db),
):
    """
    Authenticate a user using a JSON body with email and password.
    Returns a JWT access token. Rate-limited to match the form-based
    /login endpoint — otherwise this alternate path was a trivial
    brute-force bypass.
    """
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if user is None or not _verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    access_token = create_access_token(data={"sub": str(user.id)})
    return Token(access_token=access_token, token_type="bearer")


@router.get("/me", response_model=UserResponse)
async def read_current_user(
    current_user: User = Depends(get_current_active_user),
):
    """Return the currently authenticated user's profile."""
    return current_user


@router.post("/demo", response_model=Token)
@limiter.limit("30/minute")
async def demo_login(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Issue a JWT for the demo user without credentials.

    Only enabled when ``settings.DEMO_MODE`` is true — returns 404
    otherwise so normal deployments don't expose an unauthenticated
    token factory. The write-guard middleware makes sure the returned
    token can only hit read endpoints + the analytics allowlist, so
    anonymous visitors can't mutate anything the seeder restored.
    """
    if not settings.DEMO_MODE:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Demo mode is not enabled on this deployment.",
        )

    result = await db.execute(
        select(User).where(User.email == settings.DEMO_USER_EMAIL)
    )
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Demo user has not been provisioned yet. Try again shortly.",
        )

    access_token = create_access_token(data={"sub": str(user.id)})
    return Token(access_token=access_token, token_type="bearer")


@router.post("/logout", status_code=status.HTTP_200_OK)
@limiter.limit("60/minute")
async def logout(
    request: Request,
    token: str = Depends(oauth2_scheme),
):
    """Revoke the caller's current JWT by adding its jti to the
    Redis blocklist. Subsequent requests that present the same token
    will be rejected with 401 by ``get_current_user``.

    The blocklist entry auto-expires in Redis at the token's original
    ``exp`` so the keyspace never grows unboundedly. This turns a
    24-hour access token from "valid until expiry regardless" into
    "valid until logout OR expiry", closing the window where a
    compromised token stayed usable after an obvious incident.
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
    except JWTError:
        # Don't leak whether the token was valid — callers only need
        # to know their session is gone as of this call.
        return {"detail": "Logged out"}

    jti = payload.get("jti")
    exp = payload.get("exp")
    if jti and exp:
        remaining = int(exp) - int(datetime.now(timezone.utc).timestamp())
        if remaining > 0:
            revoke_jti(jti, remaining)
    return {"detail": "Logged out"}
