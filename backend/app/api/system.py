"""System info endpoints.

``GET /api/v1/system/version`` is public and unauthenticated — the managed-cloud
fleet upgrader and reconciler poll it to confirm which image a running instance
is on (plan §9.3).
"""

from fastapi import APIRouter

from app.config import settings

router = APIRouter()


@router.get("/version")
async def version() -> dict:
    # version and image_tag are the same here: the image bakes FLOWMINER_VERSION
    # from its release tag, which is exactly the deployed image tag.
    return {"version": settings.APP_VERSION, "image_tag": settings.APP_VERSION}
