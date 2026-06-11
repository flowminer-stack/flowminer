from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserCreate(BaseModel):
    email: str = Field(..., description="User email address")
    password: str = Field(..., min_length=8, description="User password (min 8 chars)")
    full_name: str = Field(..., min_length=1, description="User full name")
    # Role is intentionally NOT accepted at registration. New accounts always
    # start as `analyst` — an admin has to promote them via /users/{id}/role.
    # Allowing user-supplied role here would be a trivial privilege-escalation
    # vector (security audit finding).


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, description="Updated full name")
    email: str | None = Field(default=None, description="Updated email")
    role: str | None = Field(default=None, description="Updated role")
    is_active: bool | None = Field(default=None, description="Whether user is active")


class PasswordChange(BaseModel):
    current_password: str = Field(..., description="Current password for verification")
    new_password: str = Field(..., min_length=10, description="New password (min 10 chars)")


class UserResponse(BaseModel):
    id: UUID
    email: str
    full_name: str
    role: str
    team_id: UUID | None = None
    is_active: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UserLogin(BaseModel):
    email: str = Field(..., description="User email address")
    password: str = Field(..., description="User password")


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ActivateRequest(BaseModel):
    token: str = Field(..., description="Raw single-use activation token from the email link")
    password: str = Field(..., min_length=1, description="Password to set (policy enforced server-side)")


class TokenPayload(BaseModel):
    sub: str
    exp: int


class TeamCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Team name")


class TeamResponse(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    member_count: int = 0

    model_config = ConfigDict(from_attributes=True)
