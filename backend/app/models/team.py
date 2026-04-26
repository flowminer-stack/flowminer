import uuid

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Team(Base):
    __tablename__ = "teams"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    # Subscription tier — controls rate limits and quotas:
    #   "free"       —  basic limits
    #   "standard"   —  higher limits
    #   "enterprise" —  effectively unlimited
    plan = Column(String, nullable=False, default="free", server_default="free")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    members = relationship("User", back_populates="team")
