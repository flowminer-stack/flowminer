"""
Pydantic schemas for declarative / formal-methods endpoints (log skeleton,
DECLARE, SLA-aware Timed-Declare conformance).
"""

from typing import Literal

from pydantic import BaseModel, Field


# --- Log Skeleton ---


class LogSkeletonResponse(BaseModel):
    constraints: dict


# --- DECLARE ---


class DeclareRule(BaseModel):
    template: str
    activity_a: str
    activity_b: str | None = None
    support: float
    confidence: float | None = None
    narrative: str | None = None


class DeclareResponse(BaseModel):
    rules: list[DeclareRule]


# --- SLA-aware Timed-Declare conformance ---

# Constraint templates supported by check_timed_declare. Names mirror the
# DECLARE vocabulary but every relation carries an explicit time bound (the
# "SLA"). ``business_days`` switches the duration measurement to Mon–Fri
# working time so an SLA that elapses over a weekend is measured fairly.
TimedConstraintType = Literal[
    "response",    # whenever A occurs, B must follow within T
    "precedence",  # whenever B occurs, A must have preceded it within T
    "existence",   # A must occur within T of the case start
    "absence",     # A must NOT occur within T of the case start
]

BoundUnit = Literal["minutes", "hours", "days"]


class TimedConstraint(BaseModel):
    """A single time-bounded DECLARE-style SLA constraint.

    ``activity_b`` is required for binary templates (response, precedence)
    and ignored for the unary ones (existence, absence). ``bound_value`` +
    ``bound_unit`` express the SLA window T; ``business_days`` measures it in
    Mon–Fri working time when true.
    """

    type: TimedConstraintType
    activity_a: str
    activity_b: str | None = None
    bound_value: float = Field(..., gt=0, description="SLA window magnitude (T).")
    bound_unit: BoundUnit = "hours"
    business_days: bool = False
    # Optional human label so the UI can name a constraint without
    # re-deriving it from the activities.
    label: str | None = None


class TimedDeclareRequest(BaseModel):
    """Request body for the timed-declare conformance endpoint."""

    constraints: list[TimedConstraint] = Field(default_factory=list)


class TimeToViolationStats(BaseModel):
    """Distribution of how long each violating obligation actually took
    (or had elapsed by case end), measured in the constraint's bound_unit.

    For ``response`` this is the A→B gap; for ``precedence`` the A→B gap of
    the offending pair; for ``existence`` the elapsed time without A; for
    ``absence`` the time at which the forbidden A occurred.
    """

    count: int = 0
    mean: float | None = None
    median: float | None = None
    p95: float | None = None
    max: float | None = None
    unit: str = "hours"


class TimedConstraintResult(BaseModel):
    """Conformance result for one timed constraint."""

    type: str
    activity_a: str
    activity_b: str | None = None
    bound_value: float
    bound_unit: str
    business_days: bool
    label: str | None = None
    narrative: str

    # Population the constraint was evaluated over (cases that activate it).
    evaluated_cases: int
    satisfied_cases: int
    violating_cases: int
    violation_rate: float          # violating / evaluated (0.0 when none apply)
    violating_case_ids: list[str]  # bounded sample
    time_to_violation: TimeToViolationStats


class TimedDeclareResponse(BaseModel):
    total_cases: int
    results: list[TimedConstraintResult]
