"""Config-level guards: production refuses to start with insecure defaults."""

import os

import pytest


def test_production_rejects_default_secret_key(monkeypatch):
    from app.config import InsecureConfigurationError, Settings

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SECRET_KEY", "change-me-in-production")

    s = Settings()
    with pytest.raises(InsecureConfigurationError):
        s.validate_production_secrets()


def test_production_rejects_short_secret_key(monkeypatch):
    from app.config import InsecureConfigurationError, Settings

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SECRET_KEY", "short")

    s = Settings()
    with pytest.raises(InsecureConfigurationError):
        s.validate_production_secrets()


def test_production_accepts_real_secret_key(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SECRET_KEY", "a-real-secret-key-used-in-tests-01")
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://real:real@db/real")
    monkeypatch.setenv("SYNC_DATABASE_URL", "postgresql://real:real@db/real")

    s = Settings()
    # No exception expected
    s.validate_production_secrets()


def test_development_only_warns(monkeypatch, recwarn):
    """In development mode, insecure defaults should warn but not raise."""
    from app.config import Settings

    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("SECRET_KEY", "change-me-in-production")

    s = Settings()
    s.validate_production_secrets()  # should NOT raise

    assert any("Insecure configuration" in str(w.message) for w in recwarn.list)
