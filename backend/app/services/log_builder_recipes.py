"""Prebuilt process content packs ("recipes") for the Event Log Builder.

A recipe is a system-specific template — table list + joins + a case id + a set
of activity/timestamp events — that collapses the relational→event-log ETL step
(the #1 process-mining buyer pain) from a months-long project into "upload your
tables, confirm, mine". It rides on top of the existing log builder: a recipe
maps directly onto ``BuildRequest`` (BuilderEvent / BuilderJoin), so no new
extraction engine is needed.

Recipes are intentionally a *validated hypothesis*, not a frozen artifact:
real SAP installs have Z-tables, ServiceNow state IDs are per-instance, and
Salesforce orgs are bespoke — so every recipe carries an ``additional_columns``
override layer and is editable in the builder before running.

Each recipe targets the builder's fixed-activity model (one literal activity per
timestamp column). Transition-style events where the activity comes from a value
column (SAP CDHDR/CDPOS, Salesforce stage history) are handled by the connector
change-document mode or the Extraction Copilot, noted per recipe.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)

RECIPES_DIR = Path(__file__).resolve().parent / "recipes"


class RecipeTable(BaseModel):
    name: str  # logical name, referenced by joins/events
    description: str = ""
    role: str = "additional"  # "primary" | "additional"
    source_hint: str | None = None  # how the user obtains this table


class RecipeJoin(BaseModel):
    left_table: str
    right_table: str
    left_on: list[str]
    right_on: list[str] | None = None
    how: str = "left"


class RecipeEvent(BaseModel):
    activity_name: str  # literal activity (the builder's fixed-activity model)
    source_table: str
    timestamp_column: str
    resource_column: str | None = None
    filter: str | None = None  # advisory note; not executed by the builder


class RecipeKPI(BaseModel):
    """A default KPI definition that mirrors the ProcessTemplate kpis shape."""

    name: str
    metric: str  # one of the metrics known to AlertEngine / AlertEvaluator
    target: float
    unit: str  # "hours" | "percent" | "ratio" | …


class RecipeAlertRule(BaseModel):
    """A default alert rule expressed in the Alert model / AlertEngine shape."""

    name: str
    metric: str
    condition: str  # gt | lt | eq | gte | lte
    threshold: float


class ProcessRecipe(BaseModel):
    id: str
    process_name: str
    description: str
    connector_type: str | None = None  # which system this typically comes from
    category: str = "other"  # p2p | o2c | itsm | crm | ecommerce | logistics | …
    required_tables: list[RecipeTable]
    joins: list[RecipeJoin] = Field(default_factory=list)
    case_id_column: str
    events: list[RecipeEvent]
    # Override/escape hatch: logical name -> "table.column". Z-tables, custom
    # fields, per-instance values map through here without editing the recipe.
    additional_columns: dict[str, str] = Field(default_factory=dict)
    sample_kpis: list[str] = Field(default_factory=list)
    notes: str | None = None

    # ── Optional enrichment fields (additive, backward-compatible) ──────────
    # Structured KPIs — mirrors ProcessTemplate.kpis, used to pre-fill
    # the conformance/KPI dashboard when a recipe is applied.
    default_kpis: list[RecipeKPI] = Field(default_factory=list)
    # Reference happy-path Petri net — passed directly to
    # ConformanceService._reference_model_to_petri_net (transitions/places/arcs
    # /initial_marking/final_marking). Empty dict means "discover from data".
    reference_model: dict = Field(default_factory=dict)
    # Default alert rules that should be created when the recipe is applied.
    # Each entry maps onto the Alert model: {name, metric, condition, threshold}.
    default_alert_rules: list[RecipeAlertRule] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_refs(self) -> "ProcessRecipe":
        names = {t.name for t in self.required_tables}
        if not names:
            raise ValueError(f"recipe {self.id}: no required_tables")
        primaries = [t for t in self.required_tables if t.role == "primary"]
        if len(primaries) != 1:
            raise ValueError(
                f"recipe {self.id}: exactly one primary table required, got {len(primaries)}"
            )
        for j in self.joins:
            for tbl in (j.left_table, j.right_table):
                if tbl not in names:
                    raise ValueError(
                        f"recipe {self.id}: join references unknown table {tbl!r}"
                    )
        if not self.events:
            raise ValueError(f"recipe {self.id}: no events")
        for e in self.events:
            if e.source_table not in names:
                raise ValueError(
                    f"recipe {self.id}: event {e.activity_name!r} references unknown "
                    f"table {e.source_table!r}"
                )
        return self

    def primary_table(self) -> RecipeTable:
        return next(t for t in self.required_tables if t.role == "primary")

    def builder_events(self) -> list[dict]:
        """Map recipe events onto the builder's BuilderEvent shape."""
        return [
            {
                "activity_name": e.activity_name,
                "timestamp_column": e.timestamp_column,
                "resource_column": e.resource_column,
            }
            for e in self.events
        ]


_cache: Optional[dict[str, ProcessRecipe]] = None


def load_recipes(force: bool = False) -> dict[str, ProcessRecipe]:
    """Load + validate every recipe JSON in RECIPES_DIR (cached)."""
    global _cache
    if _cache is not None and not force:
        return _cache
    out: dict[str, ProcessRecipe] = {}
    if RECIPES_DIR.is_dir():
        for path in sorted(RECIPES_DIR.glob("*.json")):
            try:
                recipe = ProcessRecipe.model_validate(json.loads(path.read_text()))
            except Exception as exc:
                raise ValueError(f"invalid recipe {path.name}: {exc}") from exc
            if recipe.id in out:
                raise ValueError(f"duplicate recipe id {recipe.id!r} ({path.name})")
            out[recipe.id] = recipe
    _cache = out
    return out


def list_recipes(
    connector_type: str | None = None, category: str | None = None
) -> list[ProcessRecipe]:
    recipes = list(load_recipes().values())
    if connector_type:
        recipes = [r for r in recipes if r.connector_type == connector_type]
    if category:
        recipes = [r for r in recipes if r.category == category]
    return sorted(recipes, key=lambda r: r.process_name)


def get_recipe(recipe_id: str) -> Optional[ProcessRecipe]:
    return load_recipes().get(recipe_id)


# ──────────────────────────────────────────────────────────────────────────
# Reference-model persistence (recipe → conformance)
#
# A recipe's ``reference_model`` is the happy-path Petri net the conformance
# checker should replay traces against. The conformance endpoint loads an
# EventLog by id and only receives a reference model when the *caller* passes
# one as a query string — it has no server-side store. Rather than add a DB
# column + migration (and touch the EventLog model), we persist the model as a
# small sidecar JSON file next to the built log's ``file_path``. The conformance
# endpoint already has ``event_log.file_path`` in hand, so it can read this
# sidecar and prefer it when the caller did not supply an explicit model.
# ──────────────────────────────────────────────────────────────────────────

REFERENCE_MODEL_SIDECAR_SUFFIX = ".refmodel.json"


def reference_model_sidecar_path(log_file_path: str) -> str:
    """Path of the reference-model sidecar for a built log's ``file_path``."""
    return f"{log_file_path}{REFERENCE_MODEL_SIDECAR_SUFFIX}"


def write_reference_model_sidecar(log_file_path: str, reference_model: dict) -> bool:
    """Persist ``reference_model`` next to the log so conformance can load it.

    Returns True if a (non-empty) model was written, False if there was nothing
    to write. Raises on I/O errors so the caller can decide how to handle them.
    """
    if not reference_model:
        return False
    sidecar = reference_model_sidecar_path(log_file_path)
    with open(sidecar, "w", encoding="utf-8") as fh:
        json.dump(reference_model, fh)
    return True


def read_reference_model_sidecar(log_file_path: str | None) -> Optional[dict]:
    """Load a previously-persisted reference model, or None if absent/invalid."""
    if not log_file_path:
        return None
    sidecar = reference_model_sidecar_path(log_file_path)
    try:
        with open(sidecar, encoding="utf-8") as fh:
            model = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return model if isinstance(model, dict) and model else None
