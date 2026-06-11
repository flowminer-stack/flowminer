import warnings
from typing import Annotated

from pydantic import Field, field_validator
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

    # Database backups — the nightly backup_database Celery task writes
    # pg_dump custom-format files here. Kept separate from UPLOAD_DIR so a
    # restore of one volume never clobbers the other (compose mounts the
    # dedicated `backup_data` volume at this path).
    BACKUP_DIR: str = "/data/backups"

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

    # SMTP settings for email alerts. SMTP_HOST defaults to empty so a
    # non-compose run (e.g. `uvicorn` direct, or a CI test harness)
    # doesn't silently retry connections to localhost:587 when the
    # operator never wired up an SMTP relay. The compose env-block in
    # docker-compose.yml passes `${SMTP_HOST:-}` which lands here as
    # the same empty string. Email is disabled when SMTP_HOST is empty.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASS: str = ""
    SMTP_FROM: str = "alerts@flowminer.io"

    # Observability
    SENTRY_DSN: str = ""

    # Application metadata
    APP_NAME: str = "FlowMiner"
    # Sourced from the FLOWMINER_VERSION env var, which the Docker images
    # bake from the release tag (see backend/Dockerfile ARG VERSION). A
    # *distinct* env name (not APP_VERSION) is deliberate: pydantic-settings
    # would let a stale APP_VERSION line in a copied .env shadow the baked-in
    # image value, so .env.example no longer ships one. Defaults to "dev"
    # for source/compose builds that don't pass the build arg.
    APP_VERSION: str = Field(default="dev", validation_alias="FLOWMINER_VERSION")

    # Demo mode — when on, the lifespan seeds a locked-down demo user +
    # preloaded event logs, exposes /api/v1/auth/demo for anonymous login,
    # and a middleware blocks writes (POST/PUT/PATCH/DELETE) for the demo
    # user outside an analytics allowlist. Designed for demo.flowminer.io.
    DEMO_MODE: bool = False
    DEMO_USER_EMAIL: str = "demo@demo.flowminer.io"
    DEMO_USER_NAME: str = "Demo Visitor"

    # Seed sample data without the lock-down. When DEMO_MODE is off but
    # this flag is on, the lifespan runs the same idempotent demo seeder
    # (creating the running-example, sepsis, and container-logistics
    # projects) but DOES NOT arm the write-guard middleware, expose
    # /auth/demo, or schedule the hourly purge. Useful for trial
    # deployments where customers want sample logs to click through
    # without the read-only sandbox. The seeded "demo" user lands as a
    # plain `viewer` and can be deleted by an admin once it's no
    # longer needed.
    SEED_SAMPLE_DATA_ON_FIRST_BOOT: bool = False

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
