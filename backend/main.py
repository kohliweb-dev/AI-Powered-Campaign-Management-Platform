import logging
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.error import URLError
from urllib.request import urlopen
from prometheus_fastapi_instrumentator import Instrumentator
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    UploadFile,
    File
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from redis.exceptions import RedisError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from langchain_ollama import ChatOllama
from backend.config import settings
from backend.database import Base, engine, get_db
from backend import models, schemas
from backend.cache import check_redis, redis_client
from backend.mongodb import chat_collection, check_mongodb

from backend.rag import (
    add_pdf,
    list_documents,
    delete_document,
    delete_user_embeddings,
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

MAX_PDF_SIZE = 10 * 1024 * 1024
logger = logging.getLogger(__name__)


# ==========================================
# DATABASE AND FASTAPI INITIALIZATION
# ==========================================

@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(
    title="AI-Powered Campaign Management Platform",
    description="Enterprise Capstone Project API",
    version="1.0.0",
    lifespan=lifespan
)
# ==========================================
# PROMETHEUS MONITORING
# ==========================================

Instrumentator().instrument(app).expose(app, endpoint="/metrics")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:30082",
        "http://localhost:30082"
    ],
    allow_origin_regex=(
        r"https?://(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):"
        r"(?:5500|30082)"
    ),
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

# =========================================
# REDIS CACHE
# =========================================

CACHE_VERSION_KEY = "campaigns:version"


# ==========================================
# JWT AUTHENTICATION
# ==========================================

bearer_scheme = HTTPBearer(auto_error=False)


class ChatMessage(BaseModel):
    user_message: str
    document_hash: str | None = None


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

    if user.role == "deleting":
        raise HTTPException(
            status_code=403,
            detail="This account is being deleted."
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
    try:
        version = redis_client.get(CACHE_VERSION_KEY)
    except RedisError as error:
        logger.warning("Campaign cache unavailable; bypassing Redis: %s", error)
        return None

    if version is None:
        version = "1"

    if isinstance(version, bytes):
        version = version.decode("utf-8")

    if current_user.role == "admin":
        return f"campaigns:v{version}:admin"

    return f"campaigns:v{version}:user:{current_user.id}"


def invalidate_campaign_cache():
    try:
        redis_client.incr(CACHE_VERSION_KEY)
    except RedisError as error:
        logger.warning("Campaign cache invalidation failed: %s", error)


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
    dependencies = {}

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        dependencies["postgres"] = True
    except SQLAlchemyError as error:
        logger.warning("PostgreSQL health check failed: %s", error)
        dependencies["postgres"] = False

    dependencies["redis"] = check_redis()
    dependencies["mongodb"] = check_mongodb()

    try:
        with urlopen(
            f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/tags",
            timeout=2
        ) as response:
            dependencies["ollama"] = 200 <= response.status < 300
    except (URLError, TimeoutError, ValueError) as error:
        logger.warning("Ollama health check failed: %s", error)
        dependencies["ollama"] = False

    status = "healthy" if all(dependencies.values()) else "degraded"
    return JSONResponse(
        status_code=200 if dependencies["postgres"] else 503,
        content={
            "status": status,
            "dependencies": dependencies
        }
    )


@app.get("/health/live")
def liveness_check():
    return {"status": "alive"}


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

    if existing_user.role == "deleting":
        raise HTTPException(
            status_code=403,
            detail="This account is being deleted."
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

    if user.role == "deleting":
        raise HTTPException(
            status_code=409,
            detail="This account is being deleted."
        )

    user.role = role_data.role

    db.commit()
    db.refresh(user)
    invalidate_campaign_cache()

    return user


@app.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(get_admin_user)
):
    if user_id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="You cannot delete your own account."
        )

    user = db.query(models.User).filter(
        models.User.id == user_id
    ).first()

    if user is None:
        raise HTTPException(
            status_code=404,
            detail="User not found."
        )

    campaign_query = db.query(models.Campaign).filter(
        models.Campaign.owner_id == user_id
    )
    campaign_count = campaign_query.count()

    if user.role != "deleting":
        user.role = "deleting"
        campaign_query.delete(synchronize_session=False)
        try:
            db.commit()
        except SQLAlchemyError as error:
            db.rollback()
            logger.exception("Could not mark user deletion as pending.")
            raise HTTPException(
                status_code=503,
                detail="Could not start account cleanup. Please retry."
            ) from error

    try:
        embedding_counts = delete_user_embeddings(user_id)
        deleted_chats = chat_collection.delete_many(
            {"user_id": user_id}
        ).deleted_count
    except Exception as e:
        logger.exception("User data cleanup is pending for user_id=%s.", user_id)
        raise HTTPException(
            status_code=503,
            detail=(
                "Account access is disabled and data cleanup is pending. "
                "Retry deletion to finish cleanup."
            )
        ) from e

    try:
        db.delete(user)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        logger.exception(
            "External data was cleaned, but account finalization failed for user_id=%s.",
            user_id
        )
        raise HTTPException(
            status_code=503,
            detail="Data cleanup finished, but account removal is pending. Retry deletion."
        ) from error

    invalidate_campaign_cache()

    return {
        "message": "User and associated data deleted successfully.",
        "user_id": user_id,
        "campaigns_deleted": campaign_count,
        "chats_deleted": deleted_chats,
        **embedding_counts
    }


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
    try:
        db.commit()
        db.refresh(new_campaign)
    except SQLAlchemyError as error:
        db.rollback()
        logger.exception("Campaign database save failed.")
        raise HTTPException(
            status_code=503,
            detail="Campaign could not be saved to PostgreSQL."
        ) from error

    try:
        add_campaign(new_campaign)
    except Exception:
        logger.exception(
            "Campaign %s was saved but could not be indexed. "
            "Run the admin campaign reindex operation when search is available.",
            new_campaign.id
        )

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
    if cache_key is not None:
        try:
            cached_data = redis_client.get(cache_key)
        except RedisError as error:
            logger.warning("Campaign cache read failed: %s", error)
            cached_data = None

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

    if cache_key is not None:
        try:
            redis_client.setex(
                cache_key,
                60,
                json.dumps(result)
            )
        except RedisError as error:
            logger.warning("Campaign cache write failed: %s", error)

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

    try:
        db.commit()
        db.refresh(existing)
    except SQLAlchemyError as error:
        db.rollback()
        logger.exception("Campaign database update failed.")
        raise HTTPException(
            status_code=503,
            detail="Campaign changes could not be saved to PostgreSQL."
        ) from error

    try:
        add_campaign(existing)
    except Exception:
        logger.exception(
            "Campaign %s was updated but its search index is stale.",
            existing.id
        )

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

@app.get("/documents")
def get_documents(
    current_user: models.User = Depends(get_authenticated_user)
):
    owner_id = None if current_user.role == "admin" else current_user.id
    return list_documents(owner_id=owner_id)


@app.post("/documents/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_authenticated_user)
):
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail="Only PDF files are allowed."
            )

        file_bytes = await file.read(MAX_PDF_SIZE + 1)

        if not file_bytes:
            raise HTTPException(
                status_code=400,
                detail="The uploaded PDF is empty."
            )

        if len(file_bytes) > MAX_PDF_SIZE:
            raise HTTPException(
                status_code=413,
                detail="PDF size must be 10 MB or less."
            )

        result = add_pdf(
            file_bytes,
            file.filename,
            owner_id=current_user.id
        )

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


@app.delete("/documents/{file_hash}")
def delete_pdf(
    file_hash: str,
    current_user: models.User = Depends(get_authenticated_user)
):
    try:
        result = delete_document(
            file_hash,
            owner_id=(
                None if current_user.role == "admin" else current_user.id
            )
        )
    except Exception as e:
        print("PDF DELETE ERROR:", repr(e))
        raise HTTPException(
            status_code=500,
            detail="PDF deletion failed. Check ChromaDB."
        ) from e

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="PDF not found."
        )

    return {
        "message": "PDF deleted successfully.",
        **result
    }




# ==========================================
# AI CHATBOT WITH RAG
# ==========================================

@app.post("/chat")
def save_chat(
    message: ChatMessage,
    current_user: models.User = Depends(get_authenticated_user)
):
    try:
        owner_id = None if current_user.role == "admin" else current_user.id
        context = search_documents(
            message.user_message,
            file_hash=message.document_hash,
            owner_id=owner_id
        )

        if context:
            prompt = f"""
You are an AI marketing assistant.

Answer using the relevant information retrieved from the uploaded PDF.
Do not claim information came from the PDF unless it is supported by
the context. If the context does not contain the answer, say so clearly.

PDF CONTEXT:
{context}

USER QUESTION:
{message.user_message}
"""
        else:
            prompt = f"""
You are an AI marketing assistant. No relevant information was retrieved
from the uploaded PDF documents for this question. Tell the user this,
then provide a general answer only if useful and clearly label it as
general information rather than information from the PDF.

USER QUESTION:
{message.user_message}
"""

        ai_result = llm.invoke(prompt)
        ai_response = ai_result.content

        chat_record = {
            "user_id": current_user.id,
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
def get_chat_history(
    current_user: models.User = Depends(get_authenticated_user)
):
    query = (
        chat_collection.find()
        if current_user.role == "admin"
        else chat_collection.find({"user_id": current_user.id})
    )
    history = list(
        query.sort("_id", -1).limit(50)
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
def generate_campaign(
    request: schemas.CampaignGenerateRequest,
    _: models.User = Depends(get_authenticated_user)
):
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
         format="json",
          base_url=settings.OLLAMA_BASE_URL
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
