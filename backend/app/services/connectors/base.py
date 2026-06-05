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
