"""Connector package.

Importing this package auto-imports every connector module so that each
``BaseConnector`` subclass self-registers (see ``base.py``). Callers dispatch
via :func:`get_connector_class` / :func:`get_connector` instead of a hand-kept
if/elif, and :func:`validate_registry` asserts the registry, the
``ConnectorType`` enum, and the UI stay in lock-step (called at app startup).
"""

from __future__ import annotations

import importlib
import logging
import pkgutil

from app.services.connectors.base import (  # noqa: F401
    BaseConnector,
    ConnectorMeta,
    _REGISTRY,
)

logger = logging.getLogger(__name__)

# ConnectorType values that intentionally have NO connector implementation.
# dynamics365 is selectable in the enum's history but unsupported; it must NOT
# silently 400 — validate_registry asserts it is the *only* such value.
INTENTIONALLY_UNREGISTERED: frozenset[str] = frozenset({"dynamics365"})


def _autoload() -> None:
    """Import every connector module so its subclass registers."""
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_") or mod.name == "base":
            continue
        try:
            importlib.import_module(f"{__name__}.{mod.name}")
        except Exception as exc:  # pragma: no cover - defensive
            # A connector module should be import-safe (heavy/optional client
            # libs are imported lazily inside methods). If one is not, log and
            # skip rather than breaking app boot.
            logger.warning("connector module %r failed to import: %s", mod.name, exc)


_autoload()


def get_connector_class(type_id: str) -> type[BaseConnector] | None:
    """Return the connector class registered for a ConnectorType id, or None."""
    return _REGISTRY.get(type_id)


def get_connector(type_id: str) -> BaseConnector:
    """Instantiate the connector for a ConnectorType id.

    Construction never imports a connector's optional client library (those are
    imported lazily inside methods), so this is safe even when e.g. ``snowflake``
    or ``pyrfc`` is absent. Raises KeyError for an unknown id.
    """
    cls = _REGISTRY.get(type_id)
    if cls is None:
        raise KeyError(type_id)
    return cls()


def registered_ids() -> set[str]:
    """All ConnectorType ids that have a registered connector."""
    return set(_REGISTRY)


def all_connector_classes() -> list[type[BaseConnector]]:
    """Each distinct connector class (deduped across multi-id connectors)."""
    seen: list[type[BaseConnector]] = []
    for cls in _REGISTRY.values():
        if cls not in seen:
            seen.append(cls)
    return seen


def connector_registry() -> list[ConnectorMeta]:
    """Metadata for every registered connector (one entry per class)."""
    return [cls.meta for cls in all_connector_classes() if cls.meta is not None]


def validate_registry() -> None:
    """Assert registry, ConnectorType enum, and intentional gaps are consistent.

    Raises RuntimeError if a connector registers under an unknown enum id, or if
    an enum value has neither a connector nor an entry in
    INTENTIONALLY_UNREGISTERED. Run at app startup so the "in the enum/UI but not
    dispatchable" (dynamics365) class of bug fails loudly at boot, not in prod.
    """
    from app.models.connector import ConnectorType

    enum_ids = {ct.value for ct in ConnectorType}
    reg_ids = registered_ids()

    unknown = reg_ids - enum_ids
    if unknown:
        raise RuntimeError(
            f"Connector(s) registered under non-ConnectorType id(s): {sorted(unknown)}"
        )

    missing = enum_ids - reg_ids - INTENTIONALLY_UNREGISTERED
    if missing:
        raise RuntimeError(
            f"ConnectorType value(s) with no registered connector: {sorted(missing)}. "
            "Add a connector whose meta.id matches, or add the value to "
            "INTENTIONALLY_UNREGISTERED in app/services/connectors/__init__.py."
        )

    stale = INTENTIONALLY_UNREGISTERED - enum_ids
    if stale:
        raise RuntimeError(
            f"INTENTIONALLY_UNREGISTERED lists value(s) not in ConnectorType: {sorted(stale)}"
        )
