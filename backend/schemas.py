
from pydantic import BaseModel, EmailStr
from typing import Optional


# ---------------- CAMPAIGN SCHEMAS ----------------

class CampaignCreate(BaseModel):
    name: str
    description: Optional[str] = None
    target_audience: Optional[str] = None
    budget: float = 0


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    target_audience: Optional[str] = None
    budget: Optional[float] = None


class CampaignResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    target_audience: Optional[str] = None
    budget: float
    status: str

    model_config = {"from_attributes": True}


class CampaignGenerateRequest(BaseModel):
    product: str
    objective: str
    target_audience: str
    budget: float
    platform: str


class CampaignGenerateResponse(BaseModel):
    campaign_name: str
    strategy: str
    ad_headline: str
    ad_description: str
    target_audience: str
    call_to_action: str


# ---------------- USER SCHEMAS ----------------

class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: EmailStr
    role: str

    model_config = {"from_attributes": True}

class UserRoleUpdate(BaseModel):
    role: str