import enum
import uuid

from sqlalchemy import Boolean, Column, DateTime, Enum as SQLEnum, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    analyst = "analyst"
    viewer = "viewer"


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(SQLEnum(UserRole), default=UserRole.analyst, nullable=False)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    # TOTP MFA secret (base32). Null means MFA is disabled for this user.
    mfa_secret = Column(String, nullable=True)
    # Whether the user has completed email verification. Default True so
    # existing accounts don't get locked out by the new flow.
    email_verified = Column(Boolean, default=True, nullable=False, server_default="true")
    # Pending-activation support (managed-cloud bootstrap + self-host operators):
    # a user can be created inactive with a hashed, single-use, expiring
    # activation token. POST /auth/activate sets the password and clears these.
    # Only the SHA-256 hash of the raw token is ever stored.
    activation_token_hash = Column(String, nullable=True, index=True)
    activation_token_expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    team = relationship("Team", back_populates="members")
    projects = relationship("Project", back_populates="creator")
