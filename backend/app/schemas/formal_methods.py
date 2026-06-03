"""
Pydantic schemas for declarative / formal-methods endpoints (log skeleton, DECLARE).
"""

from pydantic import BaseModel


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
