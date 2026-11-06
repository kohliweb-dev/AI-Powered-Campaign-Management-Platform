import json
from datetime import datetime, timezone
from prometheus_fastapi_instrumentator import Instrumentator
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    UploadFile,
    File
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel
from langchain_ollama import ChatOllama
from backend.config import settings
from backend.database import Base, engine, get_db
from backend import models, schemas
from backend.cache import redis_client
from backend.mongodb import chat_collection

from backend.rag import (
    add_pdf,
    search_documents,
    add_campaign,
    delete_campaign,
    search_campaigns
)

from backend.security import (
    hash_password,
    verify_password,
    create_access_token,
    verify_access_token
)


# ==========================================
# DATABASE AND FASTAPI INITIALIZATION
# ==========================================

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="AI-Powered Campaign Management Platform",
    description="Enterprise Capstone Project API",
    version="1.0.0"
)
# ==========================================
# PROMETHEUS MONITORING
# ==========================================

Instrumentator().instrument(app).expose(app, endpoint="/metrics")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# AI MODEL
# ==========================================

llm = ChatOllama(
    model="llama3.2",
    temperature=0.7,
    base_url=settings.OLLAMA_BASE_URL
)


# ==========================================
# REDIS CACHE
# ==========================================

CACHE_VERSION_KEY = "campaigns:version"


# ==========================================
# JWT AUTHENTICATION
# ==========================================

bearer_scheme = HTTPBearer(auto_error=False)


class ChatMessage(BaseModel):
    user_message: str


# New request model for semantic campaign search
class CampaignSearchRequest(BaseModel):
    query: str
    limit: int = 10


# ==========================================
# AUTHENTICATION FUNCTIONS
# ==========================================

def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db)
):
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required. Please log in."
        )

    token = credentials.credentials
    payload = verify_access_token(token)

    if payload is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token."
        )

    user_email = payload.get("sub")

    if user_email is None:
        raise HTTPException(
            status_code=401,
            detail="Invalid token."
        )

    user = db.query(models.User).filter(
        models.User.email == user_email
    ).first()

    if user is None:
        raise HTTPException(
            status_code=401,
            detail="User not found."
        )

    return user


def get_admin_user(
    current_user: models.User = Depends(get_authenticated_user)
):
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Admin access required."
        )

    return current_user


# ==========================================
# REDIS CAMPAIGN CACHE FUNCTIONS
# ==========================================

def get_campaign_cache_key(current_user: models.User):
    version = redis_client.get(CACHE_VERSION_KEY)

    if version is None:
        version = "1"

    if isinstance(version, bytes):
        version = version.decode("utf-8")

    if current_user.role == "admin":
        return f"campaigns:v{version}:admin"

    return f"campaigns:v{version}:user:{current_user.id}"


def invalidate_campaign_cache():
    redis_client.incr(CACHE_VERSION_KEY)


# ==========================================
# HOME AND HEALTH
# ==========================================

@app.get("/")
def home():
    return {
        "message": "Welcome to AI-Powered Campaign Management Platform",
        "status": "Running"
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}


# ==========================================
# USER MANAGEMENT
# ==========================================

@app.post(
    "/register",
    response_model=schemas.UserResponse,
    status_code=201
)
def register_user(
    user: schemas.UserCreate,
    db: Session = Depends(get_db)
):
    existing_user = db.query(models.User).filter(
        models.User.email == user.email
    ).first()

    if existing_user:
        raise HTTPException(
            status_code=400,
            detail="Email is already registered."
        )

    new_user = models.User(
        username=user.username,
        email=user.email,
        hashed_password=hash_password(user.password),
        role="user"
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return new_user


@app.post("/login")
def login_user(
    user: schemas.UserLogin,
    db: Session = Depends(get_db)
):
    existing_user = db.query(models.User).filter(
        models.User.email == user.email
    ).first()

    if not existing_user or not verify_password(
        user.password,
        existing_user.hashed_password
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid email or password."
        )

    access_token = create_access_token(
        data={
            "sub": existing_user.email,
            "role": existing_user.role
        }
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": existing_user.id,
            "username": existing_user.username,
            "email": existing_user.email,
            "role": existing_user.role
        }
    }


@app.get(
    "/users/me",
    response_model=schemas.UserResponse
)
def get_current_user(
    current_user: models.User = Depends(get_authenticated_user)
):
    return current_user


@app.get(
    "/admin/users",
    response_model=list[schemas.UserResponse]
)
def get_all_users(
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_admin_user)
):
    return db.query(models.User).order_by(models.User.id).all()


@app.put(
    "/admin/users/{user_id}/role",
    response_model=schemas.UserResponse
)
def update_user_role(
    user_id: int,
    role_data: schemas.UserRoleUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_admin_user)
):
    if role_data.role not in ["user", "admin"]:
        raise HTTPException(
            status_code=400,
            detail="Role must be either user or admin."
        )

    if user_id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="You cannot change your own role."
        )

    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(
            status_code=404,
            detail="User not found."
        )

    user.role = role_data.role

    db.commit()
    db.refresh(user)

    return user


# ==========================================
# CAMPAIGN MANAGEMENT
# ==========================================

@app.post(
    "/campaigns",
    response_model=schemas.CampaignResponse
)
def create_campaign(
    campaign: schemas.CampaignCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_authenticated_user)
):
    new_campaign = models.Campaign(
        **campaign.model_dump(),
        owner_id=current_user.id
    )

    db.add(new_campaign)
    db.flush()

    # Generate and store the campaign embedding
    try:
        add_campaign(new_campaign)
    except Exception as e:
        db.rollback()
        print("CAMPAIGN EMBEDDING ERROR:", repr(e))

        raise HTTPException(
            status_code=503,
            detail="Campaign could not be added to AI search. Check Ollama and ChromaDB."
        )

    db.commit()
    db.refresh(new_campaign)

    invalidate_campaign_cache()

    return new_campaign


@app.get(
    "/campaigns",
    response_model=list[schemas.CampaignResponse]
)
def get_campaigns(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_authenticated_user)
):
    cache_key = get_campaign_cache_key(current_user)

    cached_data = redis_client.get(cache_key)

    if cached_data:
        return json.loads(cached_data)

    query = db.query(models.Campaign)

    if current_user.role != "admin":
        query = query.filter(
            models.Campaign.owner_id == current_user.id
        )

    campaigns = query.all()

    result = [
        schemas.CampaignResponse.model_validate(c).model_dump(mode="json")
        for c in campaigns
    ]

    redis_client.setex(
        cache_key,
        60,
        json.dumps(result)
    )

    return result


# ==========================================
# AI-POWERED CAMPAIGN SEMANTIC SEARCH
# ==========================================

@app.post(
    "/campaigns/search",
    response_model=list[schemas.CampaignResponse]
)
def semantic_campaign_search(
    request: CampaignSearchRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_authenticated_user)
):
    query_text = request.query.strip()

    if not query_text:
        raise HTTPException(
            status_code=400,
            detail="Please enter a campaign search query."
        )

    limit = max(1, min(request.limit, 50))

    try:
        # Admin searches all campaigns.
        # Normal users search only their own campaigns.
        owner_id = (
            None
            if current_user.role == "admin"
            else current_user.id
        )

        matches = search_campaigns(
            query=query_text,
            owner_id=owner_id,
            limit=limit
        )

    except Exception as e:
        print("CAMPAIGN SEARCH ERROR:", repr(e))

        raise HTTPException(
            status_code=503,
            detail="AI campaign search is unavailable. Check Ollama and ChromaDB."
        )

    if not matches:
        return []

    # Get campaign IDs in semantic search ranking order.
    campaign_ids = [
        match["campaign_id"]
        for match in matches
    ]

    # Fetch actual campaign records from PostgreSQL.
    query = db.query(models.Campaign).filter(
        models.Campaign.id.in_(campaign_ids)
    )

    # Apply database-level permission check too.
    if current_user.role != "admin":
        query = query.filter(
            models.Campaign.owner_id == current_user.id
        )

    campaigns = query.all()

    # Build a lookup so results retain semantic ranking order.
    campaigns_by_id = {
        campaign.id: campaign
        for campaign in campaigns
    }

    return [
        campaigns_by_id[campaign_id]
        for campaign_id in campaign_ids
        if campaign_id in campaigns_by_id
    ]


# ==========================================
# ADMIN: INDEX EXISTING CAMPAIGNS
# ==========================================

@app.post("/admin/campaigns/reindex")
def reindex_campaign_search(
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_admin_user)
):
    """
    Add existing PostgreSQL campaigns to the ChromaDB search collection.
    Admin only.
    """

    campaigns = db.query(models.Campaign).all()

    indexed_count = 0

    try:
        for campaign in campaigns:
            add_campaign(campaign)
            indexed_count += 1

    except Exception as e:
        print("CAMPAIGN REINDEX ERROR:", repr(e))

        raise HTTPException(
            status_code=503,
            detail="Campaign indexing failed. Check Ollama and ChromaDB."
        )

    return {
        "message": "Campaign search indexing completed successfully.",
        "indexed_campaigns": indexed_count
    }


# ==========================================
# UPDATE CAMPAIGN
# ==========================================

@app.put(
    "/campaigns/{campaign_id}",
    response_model=schemas.CampaignResponse
)
def update_campaign(
    campaign_id: int,
    campaign: schemas.CampaignUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_authenticated_user)
):
    updates = campaign.model_dump(exclude_unset=True)

    if not updates:
        raise HTTPException(
            status_code=422,
            detail="Provide at least one campaign field to update"
        )

    for field in ("name", "budget"):
        if field in updates and updates[field] is None:
            raise HTTPException(
                status_code=422,
                detail=f"{field} cannot be null"
            )

    query = db.query(models.Campaign).filter(
        models.Campaign.id == campaign_id
    )

    if current_user.role != "admin":
        query = query.filter(
            models.Campaign.owner_id == current_user.id
        )

    existing = query.first()

    if existing is None:
        raise HTTPException(
            status_code=404,
            detail="Campaign not found or you do not have permission to access it."
        )

    for key, value in updates.items():
        setattr(existing, key, value)

    # Update the campaign embedding after changing campaign details.
    try:
        add_campaign(existing)
    except Exception as e:
        db.rollback()
        print("CAMPAIGN EMBEDDING UPDATE ERROR:", repr(e))

        raise HTTPException(
            status_code=503,
            detail="Campaign update could not be added to AI search. Check Ollama and ChromaDB."
        )

    db.commit()
    db.refresh(existing)

    invalidate_campaign_cache()

    return existing


# ==========================================
# DELETE CAMPAIGN
# ==========================================

@app.delete("/campaigns/{campaign_id}")
def delete_campaign_endpoint(
    campaign_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_authenticated_user)
):
    query = db.query(models.Campaign).filter(
        models.Campaign.id == campaign_id
    )

    if current_user.role != "admin":
        query = query.filter(
            models.Campaign.owner_id == current_user.id
        )

    campaign = query.first()

    if campaign is None:
        raise HTTPException(
            status_code=404,
            detail="Campaign not found or you do not have permission to access it."
        )

    db.delete(campaign)
    db.commit()

    # Remove the campaign from the AI search collection.
    try:
        delete_campaign(campaign_id)
    except Exception as e:
        # The SQL campaign is already deleted.
        # Search results are also checked against PostgreSQL.
        print("CAMPAIGN EMBEDDING DELETE ERROR:", repr(e))

    invalidate_campaign_cache()

    return {
        "message": "Campaign deleted successfully"
    }


# ==========================================
# PDF UPLOAD
# ==========================================

@app.post("/documents/upload")
async def upload_pdf(file: UploadFile = File(...)):
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail="Only PDF files are allowed."
            )

        file_bytes = await file.read()

        if not file_bytes:
            raise HTTPException(
                status_code=400,
                detail="The uploaded PDF is empty."
            )

        if len(file_bytes) > 10 * 1024 * 1024:
            raise HTTPException(
                status_code=400,
                detail="PDF size must be 10 MB or less."
            )

        result = add_pdf(file_bytes, file.filename)

        return result

    except HTTPException:
        raise

    except Exception as e:
        print("PDF UPLOAD ERROR:", repr(e))

        raise HTTPException(
            status_code=500,
            detail="PDF processing failed. Check Ollama and ChromaDB."
        )

    finally:
        await file.close()


# ==========================================
# AI CHATBOT WITH RAG
# ==========================================

@app.post("/chat")
def save_chat(message: ChatMessage):
    try:
        context = search_documents(message.user_message)

        if context:
            prompt = f"""
You are an AI marketing assistant.

Answer the user's question using the following information
retrieved from uploaded PDF documents.

PDF CONTEXT:
{context}

USER QUESTION:
{message.user_message}

If the answer is not available in the PDF context,
clearly tell the user that the uploaded documents
do not contain that information.
"""
        else:
            prompt = message.user_message

        ai_result = llm.invoke(prompt)
        ai_response = ai_result.content

        chat_record = {
            "user_message": message.user_message,
            "ai_response": ai_response,
            "created_at": datetime.now(timezone.utc)
        }

        result = chat_collection.insert_one(chat_record)

        return {
            "message": "AI response generated successfully",
            "user_message": message.user_message,
            "ai_response": ai_response,
            "chat_id": str(result.inserted_id),
            "used_documents": bool(context)
        }

    except Exception as e:
        print("CHAT ERROR:", repr(e))

        raise HTTPException(
            status_code=500,
            detail="Chatbot error. Check that Ollama is running and required models are available."
        )


# ==========================================
# CHAT HISTORY
# ==========================================

@app.get("/chat/history")
def get_chat_history():
    history = list(
        chat_collection.find().sort("_id", -1).limit(50)
    )

    for item in history:
        item["_id"] = str(item["_id"])

    return history


# ==========================================
# AI CAMPAIGN GENERATOR
# ==========================================

@app.post(
    "/campaigns/generate",
    response_model=schemas.CampaignGenerateResponse
)
def generate_campaign(request: schemas.CampaignGenerateRequest):
    try:
        prompt = f"""
You are an expert digital marketing campaign strategist.

Create a practical marketing campaign using these details:

Product: {request.product}
Objective: {request.objective}
Target Audience: {request.target_audience}
Budget: {request.budget}
Platform: {request.platform}

Return a JSON object containing exactly these six fields:

{{
    "campaign_name": "A creative campaign name",
    "strategy": "Marketing strategy",
    "ad_headline": "Advertisement headline",
    "ad_description": "Advertisement description",
    "target_audience": "Target audience description",
    "call_to_action": "Call to action"
}}

All six values must be strings.
Return only the JSON object.
Do not use Markdown or add explanations.
Do not invent discounts or special offers that were not provided.
"""

        campaign_llm = ChatOllama(
            model="llama3.2",
            temperature=0.2,
            format="json"
        )

        ai_result = campaign_llm.invoke(prompt)
        ai_response = ai_result.content.strip()

        campaign_data = json.loads(ai_response)

        if not isinstance(campaign_data, dict):
            raise ValueError("AI response is not a JSON object.")

        required_fields = [
            "campaign_name",
            "strategy",
            "ad_headline",
            "ad_description",
            "target_audience",
            "call_to_action"
        ]

        for field in required_fields:
            if field not in campaign_data:
                raise ValueError(f"Missing required field: {field}")

            if not isinstance(campaign_data[field], str):
                raise ValueError(f"Invalid value for field: {field}")

            if not campaign_data[field].strip():
                raise ValueError(f"Empty value for field: {field}")

        return campaign_data

    except Exception as e:
        print("CAMPAIGN GENERATOR ERROR:", repr(e))

        raise HTTPException(
            status_code=500,
            detail=f"AI campaign generation failed: {str(e)}"
        )
