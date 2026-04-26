import warnings
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode


# Sentinel defaults — if any of these end up in `settings` the app
# refuses to start in production. The DATABASE_URL defaults are
# intentionally empty strings: we want a loud failure on a missing
# DB URL rather than a silent connection attempt against a baked-in
# dev credential string. (Previously this file shipped
# ``postgresql+asyncpg://flowminer:flowminer@db:5432/flowminer``
# directly — fine for Docker Compose dev, but it meant the commit
# history contained a literal credential pair that would show up in
# GitHub code search, which is not acceptable for an open-source
# release even if the creds are not real.)
_INSECURE_DEFAULTS = {
    "SECRET_KEY": "change-me-in-production",
    "DATABASE_URL": "",
    "SYNC_DATABASE_URL": "",
}


class InsecureConfigurationError(RuntimeError):
    """Raised at startup when a required production secret is still a default."""


class Settings(BaseSettings):
    """Application settings loaded from environment variables with sensible defaults."""

    # Environment: "development" (default) | "production"
    # In production mode, insecure defaults raise at startup instead of warning.
    ENV: str = "development"

    # Database — the empty default triggers ``validate_production_secrets``
    # at startup. The Docker Compose file always injects real values, so
    # operators must either use the compose file or set them in ``.env``
    # before starting. Shipping literal credentials in source is forbidden
    # by the open-source release policy; use ``.env.example`` for the
    # reference copy.
    DATABASE_URL: str = ""
    SYNC_DATABASE_URL: str = ""

    # Redis
    REDIS_URL: str = "redis://redis:6379/0"

    # Auth / JWT
    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440
    ALGORITHM: str = "HS256"

    # File uploads
    UPLOAD_DIR: str = "/data/uploads"
    MAX_UPLOAD_SIZE: int = 500 * 1024 * 1024  # 500 MB

    # CORS — NoDecode prevents pydantic-settings 2.x from trying to JSON-parse
    # the env value; our validator then splits the comma-separated form.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost",
    ]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_cors_origins(cls, v):
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    # SMTP settings for email alerts
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASS: str = ""
    SMTP_FROM: str = "alerts@flowminer.io"

    # Observability
    SENTRY_DSN: str = ""

    # Application metadata
    APP_NAME: str = "FlowMiner"
    APP_VERSION: str = "0.1.0"

    # Demo mode — when on, the lifespan seeds a locked-down demo user +
    # preloaded event logs, exposes /api/v1/auth/demo for anonymous login,
    # and a middleware blocks writes (POST/PUT/PATCH/DELETE) for the demo
    # user outside an analytics allowlist. Designed for demo.flowminer.io.
    DEMO_MODE: bool = False
    DEMO_USER_EMAIL: str = "demo@demo.flowminer.io"
    DEMO_USER_NAME: str = "Demo Visitor"

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
    }

    def validate_production_secrets(self) -> None:
        """Fail fast in production if any mandatory secret still holds its
        insecure default. In development, downgrade to a warning so local
        docker-compose still boots with the stock values."""
        offending: list[str] = []
        for field, default in _INSECURE_DEFAULTS.items():
            if getattr(self, field, None) == default:
                offending.append(field)

        # Also reject an empty / too-short SECRET_KEY outright, production or not.
        if len(self.SECRET_KEY) < 16:
            offending.append("SECRET_KEY (too short — need at least 16 chars)")

        if not offending:
            return

        msg = (
            "Insecure configuration detected — the following env vars still "
            "hold insecure defaults: " + ", ".join(offending) + ". "
            "Set them to real values before starting FlowMiner."
        )

        if self.ENV.lower() == "production":
            raise InsecureConfigurationError(msg)

        warnings.warn(msg, UserWarning, stacklevel=2)


settings = Settings()
settings.validate_production_secrets()
