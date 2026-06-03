"""FlowMiner ops CLI.

A small, sync-only Typer app for routine operator tasks that previously
required hand-written SQL — listing users, promoting/demoting roles,
resetting passwords, toggling activation.

Run from inside the backend container::

    docker compose exec backend python -m app.cli user list
    docker compose exec backend python -m app.cli user promote --email alice@corp.com
    docker compose exec backend python -m app.cli user demote --email alice@corp.com
    docker compose exec backend python -m app.cli user reset-password --email alice@corp.com
    docker compose exec backend python -m app.cli user reset-password --email alice@corp.com --password 'newpw123'

The CLI uses the synchronous SQLAlchemy session factory exposed by
``app.database.SessionLocal`` (the same one Celery workers use), so
there's no asyncio event loop to manage.
"""

from __future__ import annotations

import secrets
import sys
from datetime import datetime
from typing import Optional

import typer
from passlib.context import CryptContext
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User, UserRole
from app.services.infra.password_policy import assert_strong_password


app = typer.Typer(help="FlowMiner ops CLI.", no_args_is_help=True)
user_app = typer.Typer(help="User management.", no_args_is_help=True)
app.add_typer(user_app, name="user")


# Match app/api/auth.py — same hashing scheme, same defaults, so
# passwords set by the CLI verify cleanly via the login endpoint.
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Helpers ──────────────────────────────────────────────────────────


def _err(msg: str) -> None:
    """Print an error to stderr without exiting."""
    typer.echo(msg, err=True)


def _abort(msg: str, code: int = 1) -> "typer.Exit":
    """Print an error and raise Typer's Exit so the process returns
    non-zero. Returned (rather than raised) so the caller can ``raise``
    it themselves and keep type-checkers happy with control flow."""
    _err(msg)
    return typer.Exit(code=code)


def _get_user(db: Session, email: str) -> User:
    """Look up a user by email (case-insensitive). Aborts the CLI if
    no match is found."""
    needle = email.strip().lower()
    user = (
        db.execute(select(User).where(func.lower(User.email) == needle))
        .scalar_one_or_none()
    )
    if user is None:
        raise _abort(f"No user found with email {email!r}.")
    return user


def _admin_count(db: Session) -> int:
    """Count active admins. ``is_active=False`` admins don't count —
    a deactivated admin can't actually log in to do admin things."""
    return int(
        db.execute(
            select(func.count())
            .select_from(User)
            .where(User.role == UserRole.admin)
            .where(User.is_active.is_(True))
        ).scalar_one()
    )


def _format_dt(value: Optional[datetime]) -> str:
    if value is None:
        return "-"
    # Trim sub-second precision; the table doesn't need it.
    return value.replace(microsecond=0).isoformat()


def _print_table(rows: list[list[str]], headers: list[str]) -> None:
    """Plain stdlib table printer — no rich, no tabulate."""
    cols = list(zip(*([headers] + rows))) if rows else [[h] for h in headers]
    widths = [max(len(str(cell)) for cell in col) for col in cols]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    typer.echo(fmt.format(*headers))
    typer.echo(fmt.format(*["-" * w for w in widths]))
    for row in rows:
        typer.echo(fmt.format(*row))


def _apply_password_policy(password: str, user: User) -> None:
    """Run the registration-time password policy and translate the
    HTTPException into a clean CLI error."""
    from fastapi import HTTPException

    try:
        assert_strong_password(
            password,
            hint_fields=(user.email or "", user.full_name or ""),
        )
    except HTTPException as exc:
        # ``exc.detail`` already concatenates the violations.
        raise _abort(f"Password rejected: {exc.detail}") from exc


# ── Commands ─────────────────────────────────────────────────────────


@user_app.command("list")
def cmd_user_list() -> None:
    """List every user with id, email, role, active, MFA, created_at."""
    with SessionLocal() as db:
        users = (
            db.execute(select(User).order_by(User.created_at.asc()))
            .scalars()
            .all()
        )

    rows: list[list[str]] = []
    for u in users:
        role_value = u.role.value if hasattr(u.role, "value") else str(u.role)
        rows.append(
            [
                str(u.id),
                u.email or "",
                role_value,
                "yes" if bool(u.is_active) else "no",
                "yes" if u.mfa_secret else "no",
                _format_dt(u.created_at),
            ]
        )
    _print_table(
        rows,
        headers=["id", "email", "role", "active", "mfa", "created_at"],
    )
    typer.echo(f"\n{len(rows)} user(s).")


@user_app.command("promote")
def cmd_user_promote(
    email: str = typer.Option(..., "--email", "-e", help="User email."),
) -> None:
    """Set the user's role to admin. Idempotent."""
    with SessionLocal() as db:
        user = _get_user(db, email)
        if user.role == UserRole.admin:
            typer.echo(f"{user.email} is already an admin. Nothing to do.")
            return
        user.role = UserRole.admin
        db.commit()
        typer.echo(f"Promoted {user.email} to admin.")


@user_app.command("demote")
def cmd_user_demote(
    email: str = typer.Option(..., "--email", "-e", help="User email."),
    to: UserRole = typer.Option(
        UserRole.analyst,
        "--to",
        help="Target role (analyst or viewer). Default: analyst.",
        case_sensitive=False,
    ),
) -> None:
    """Demote an admin to a non-admin role. Refuses to demote the last
    remaining active admin."""
    if to == UserRole.admin:
        raise _abort("--to admin doesn't make sense for demote. Use 'promote' instead.")

    with SessionLocal() as db:
        user = _get_user(db, email)
        if user.role != UserRole.admin:
            current = user.role.value if hasattr(user.role, "value") else str(user.role)
            typer.echo(
                f"{user.email} is currently {current}, not admin. Setting to {to.value}."
            )
            user.role = to
            db.commit()
            return

        # Demoting an admin — make sure at least one active admin remains.
        remaining = _admin_count(db) - (1 if user.is_active else 0)
        if remaining < 1:
            raise _abort(
                f"Refusing to demote {user.email}: they are the last active admin. "
                "Promote another user first."
            )
        user.role = to
        db.commit()
        typer.echo(f"Demoted {user.email} to {to.value}.")


@user_app.command("reset-password")
def cmd_user_reset_password(
    email: str = typer.Option(..., "--email", "-e", help="User email."),
    password: Optional[str] = typer.Option(
        None,
        "--password",
        "-p",
        help="New password. If omitted, a strong random one is generated.",
    ),
) -> None:
    """Reset a user's password. If --password is omitted, generate a
    strong random one and print it once at the end."""
    generated = False
    if password is None:
        password = secrets.token_urlsafe(16)
        generated = True

    with SessionLocal() as db:
        user = _get_user(db, email)
        _apply_password_policy(password, user)
        user.password_hash = _pwd_context.hash(password)
        db.commit()
        typer.echo(f"Password reset for {user.email}.")

    if generated:
        # Printed AFTER the commit so we never claim success then fail.
        # Single line, no log decoration — the operator copies this once.
        typer.echo("")
        typer.echo("Generated password (copy now, it will not be shown again):")
        typer.echo(f"  {password}")


@user_app.command("activate")
def cmd_user_activate(
    email: str = typer.Option(..., "--email", "-e", help="User email."),
) -> None:
    """Mark the user active (allow login)."""
    with SessionLocal() as db:
        user = _get_user(db, email)
        if bool(user.is_active):
            typer.echo(f"{user.email} is already active. Nothing to do.")
            return
        user.is_active = True
        db.commit()
        typer.echo(f"Activated {user.email}.")


@user_app.command("deactivate")
def cmd_user_deactivate(
    email: str = typer.Option(..., "--email", "-e", help="User email."),
) -> None:
    """Mark the user inactive (block login). Refuses to deactivate the
    last remaining active admin."""
    with SessionLocal() as db:
        user = _get_user(db, email)
        if not bool(user.is_active):
            typer.echo(f"{user.email} is already inactive. Nothing to do.")
            return

        if user.role == UserRole.admin:
            remaining = _admin_count(db) - 1
            if remaining < 1:
                raise _abort(
                    f"Refusing to deactivate {user.email}: they are the last "
                    "active admin. Promote or activate another admin first."
                )
        user.is_active = False
        db.commit()
        typer.echo(f"Deactivated {user.email}.")


# ── Entry point ──────────────────────────────────────────────────────


def main() -> None:
    """Entry point for ``python -m app.cli``."""
    try:
        app()
    except typer.Exit:
        raise
    except Exception as e:  # pragma: no cover — last-resort safety net
        _err(f"Unexpected error: {type(e).__name__}: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
