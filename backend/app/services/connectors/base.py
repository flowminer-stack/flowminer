"""
Abstract base class + self-registration registry for data-source connectors.

Every connector (CSV, XES, Database, SAP, …) implements ``BaseConnector``. A
connector that declares a ``meta`` class attribute is *auto-registered* under
each of its ids the moment its module is imported — there is no central
if/elif dispatcher to keep in sync. The package ``__init__`` imports every
connector module so the registry is fully populated; ``get_connector_class``
and ``validate_registry`` (in this package's ``__init__``) read from it.

This is the structural fix for the "dynamics365" class of bug: a connector
either exists as one registered artifact (enum value + meta + class) or it does
not exist at all — divergence is caught by ``validate_registry`` at boot.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from datetime import datetime
from typing import ClassVar

from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)


class ConnectorMeta(BaseModel):
    """Declarative metadata — the single source of truth for a connector's
    identity, UI presentation, and capabilities.

    ``id`` must equal a ``ConnectorType`` enum value. A connector that serves
    several enum values (the database connector covers postgresql / mysql /
    sqlserver / oracle) lists them in ``variants`` (id -> display label); the
    registry then maps every variant id to the same class.
    """

    id: str = Field(..., description="Primary ConnectorType value served")
    label: str
    category: str = "other"  # db|warehouse|file|api|itsm|crm|erp|procurement|hcm|devops|other
    mapping_mode: str = "manual"  # auto | manual | none — drives the UI column-mapping step
    supports_incremental: bool = False
    # False if the connector intentionally yields a raw table rather than an
    # event log (none today). Auto-mapped connectors with this True must declare
    # a default case/activity/timestamp mapping — enforced by a contract test.
    produces_event_log: bool = True
    # Write-back ("close the loop"): the connector can CREATE a record — an
    # issue / ticket / incident / case — back in the source system, not just
    # read from it. Drives the action-engine ``create_external_record`` action
    # and the connector picker in the action-rule UI. A connector that sets this
    # True MUST implement ``BaseConnector.create_record`` — enforced by a
    # contract test.
    supports_write_back: bool = False
    write_back_label: str | None = Field(
        default=None,
        description="UI label for the write-back action, e.g. 'Create Jira issue'.",
    )
    variants: dict[str, str] = Field(
        default_factory=dict,
        description="For multi-type connectors: {connector_type_id: label}. "
        "Empty means the connector serves only `id`.",
    )

    @model_validator(mode="after")
    def _check_variants(self) -> "ConnectorMeta":
        if self.variants and self.id not in self.variants:
            raise ValueError(
                f"ConnectorMeta(id={self.id!r}) must appear in its own variants map"
            )
        return self

    @property
    def ids(self) -> tuple[str, ...]:
        """Every ConnectorType value this connector services."""
        return tuple(self.variants) if self.variants else (self.id,)


# id -> connector class. Populated by ``__init_subclass__`` as modules import.
_REGISTRY: dict[str, type["BaseConnector"]] = {}


class BaseConnector(ABC):
    """Abstract base connector for data source integrations.

    Subclasses that set a ``meta = ConnectorMeta(...)`` class attribute are
    registered automatically under every id in ``meta.ids``. Subclasses without
    ``meta`` (e.g. the orphaned XES connector, ingested via the upload path
    rather than dispatched) are intentionally left unregistered.
    """

    meta: ClassVar[ConnectorMeta | None] = None

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        meta = cls.__dict__.get("meta")
        if meta is None:
            return  # not a dispatchable connector
        if not isinstance(meta, ConnectorMeta):
            raise TypeError(
                f"{cls.__name__}.meta must be a ConnectorMeta, got {type(meta)!r}"
            )
        for cid in meta.ids:
            existing = _REGISTRY.get(cid)
            if existing is not None and existing is not cls:
                raise RuntimeError(
                    f"Connector id {cid!r} already registered by "
                    f"{existing.__name__}; {cls.__name__} cannot reuse it."
                )
            _REGISTRY[cid] = cls
        logger.debug("registered connector %s under %s", cls.__name__, meta.ids)

    @abstractmethod
    async def test_connection(self, config: dict) -> dict:
        """
        Test if the connection works with the given configuration.

        Returns: {"success": bool, "message": str}
        """
        pass

    @abstractmethod
    async def fetch_data(
        self, config: dict, column_mapping: dict, since: datetime | None = None
    ) -> str:
        """
        Fetch data from the source and save it to a local file.

        Connectors that declare ``meta.supports_incremental`` are called with
        ``since`` (a datetime high-watermark, possibly rewound by an overlap
        window) and should fetch only rows changed at/after it. Connectors that
        do not are called without it, so they need not accept the parameter.

        Returns: file_path — path to the saved file on disk.
        """
        pass

    def get_default_column_mapping(self, config: dict) -> dict | None:
        """
        Return a pre-filled column mapping for connectors with known schemas.
        Returns None if the user must specify mapping manually.
        """
        return None

    @abstractmethod
    async def get_schema(self, config: dict) -> dict:
        """
        Get the available schema (tables/columns) from the data source.

        Returns: {"tables": [{"name": str, "columns": [{"name": str, "type": str}, ...]}, ...]}
        """
        pass

    async def create_record(self, config: dict, payload: dict) -> dict:
        """Write-back: create a record (issue / ticket / incident / case) in the
        source system. Only connectors that declare
        ``meta.supports_write_back = True`` override this.

        ``payload`` keys (all supplied by the action engine):
          * ``title``       — short summary / subject / title (already templated)
          * ``description`` — longer body (already templated)
          * ``priority``    — generic level ``low|medium|high|urgent`` or ``None``
          * ``case_id``     — the process-mining case that triggered the action
          * ``case``        — the full case snapshot dict
          * ``fields``      — connector-specific overrides (issue_type, labels, …)
          * ``rule_id``     — id of the firing action rule (may be ``None``)

        Returns ``{"external_id": str, "url": str, "raw": dict}`` on success.
        Raises on failure — the action engine catches it and records the error.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support write-back (create_record)"
        )
