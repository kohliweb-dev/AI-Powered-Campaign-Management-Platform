
from pathlib import Path
from io import BytesIO
import hashlib
import time
from backend.config import settings
import chromadb
from pypdf import PdfReader
from langchain_ollama import OllamaEmbeddings


# ==========================================
# CHROMADB CONFIGURATION
# ==========================================

BASE_PATH = Path(__file__).resolve().parent.parent

# PDF document storage
CHROMA_PATH = BASE_PATH / "chroma_db"

# Campaign semantic search storage
CHROMA_PATH2 = BASE_PATH / "campaign_search"

client = chromadb.PersistentClient(path=str(CHROMA_PATH))
client2 = chromadb.PersistentClient(path=str(CHROMA_PATH2))


# Separate collections
collection = client.get_or_create_collection(
    name="campaign_documents"
)

collection2 = client2.get_or_create_collection(
    name="campaign_documents2"
)


# ==========================================
# OLLAMA EMBEDDING MODEL
# ==========================================

embeddings = OllamaEmbeddings(
    model="nomic-embed-text",
    base_url=settings.OLLAMA_BASE_URL
)


# ==========================================
# PDF PROCESSING SETTINGS
# ==========================================

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 100
BATCH_SIZE = 32


def split_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split PDF text into smaller overlapping chunks."""

    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        start += chunk_size - overlap

    return chunks


# ==========================================
# PDF UPLOAD AND EMBEDDING
# ==========================================

def add_pdf(file_bytes, filename):
    """Extract PDF text, generate embeddings and save in ChromaDB."""

    start_time = time.perf_counter()

    file_hash = hashlib.sha256(file_bytes).hexdigest()

    existing = collection.get(
        where={"file_hash": file_hash},
        limit=1
    )

    if existing["ids"]:
        return {
            "filename": filename,
            "chunks": 0,
            "message": "This PDF has already been uploaded.",
            "already_exists": True
        }

    reader = PdfReader(BytesIO(file_bytes))

    page_texts = []

    for page in reader.pages:
        page_text = page.extract_text() or ""

        if page_text.strip():
            page_texts.append(page_text)

    full_text = "\n".join(page_texts)

    if not full_text.strip():
        raise ValueError("No readable text found in this PDF.")

    chunks = split_text(full_text)

    if not chunks:
        raise ValueError("No readable text chunks found in this PDF.")

    print(f"PDF contains {len(chunks)} chunks.")

    vectors = []

    for start in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[start:start + BATCH_SIZE]

        batch_vectors = embeddings.embed_documents(batch)

        vectors.extend(batch_vectors)

        print(
            f"Embedded {len(vectors)} / {len(chunks)} chunks"
        )

    ids = [
        f"{file_hash}_{index}"
        for index in range(len(chunks))
    ]

    metadatas = [
        {
            "filename": filename,
            "file_hash": file_hash,
            "chunk_index": index
        }
        for index in range(len(chunks))
    ]

    collection.add(
        ids=ids,
        documents=chunks,
        embeddings=vectors,
        metadatas=metadatas
    )

    elapsed_time = round(time.perf_counter() - start_time, 2)

    print(f"PDF processing completed in {elapsed_time} seconds.")

    return {
        "filename": filename,
        "chunks": len(chunks),
        "processing_time": elapsed_time,
        "message": "PDF uploaded and processed successfully.",
        "already_exists": False
    }


# ==========================================
# PDF SEMANTIC SEARCH
# ==========================================

def search_documents(question):
    """Find the most relevant PDF text for a question."""

    total_chunks = collection.count()

    if total_chunks == 0:
        return ""

    question_vector = embeddings.embed_query(question)

    results = collection.query(
        query_embeddings=[question_vector],
        n_results=min(3, total_chunks)
    )

    documents = results.get("documents", [[]])[0]

    return "\n\n".join(documents)


# ==========================================
# CAMPAIGN TEXT PREPARATION
# ==========================================

def prepare_campaign_text(campaign):
    """Convert campaign details into searchable text."""

    return (
        f"Campaign Name: {campaign.name}\n"
        f"Description: {campaign.description or ''}\n"
        f"Target Audience: {campaign.target_audience or ''}\n"
        f"Budget: {campaign.budget or 0}\n"
        f"Status: {campaign.status or 'Draft'}"
    )


# ==========================================
# ADD OR UPDATE CAMPAIGN EMBEDDING
# ==========================================

def add_campaign(campaign):
    """Generate and store a campaign embedding in ChromaDB."""

    campaign_id = str(campaign.id)

    campaign_text = prepare_campaign_text(campaign)

    campaign_vector = embeddings.embed_documents(
        [campaign_text]
    )[0]

    metadata = {
        "campaign_id": int(campaign.id),
        "budget": float(campaign.budget or 0),
        "status": str(campaign.status or "Draft")
    }

    if campaign.owner_id is not None:
        metadata["owner_id"] = int(campaign.owner_id)

    collection2.upsert(
        ids=[campaign_id],
        documents=[campaign_text],
        embeddings=[campaign_vector],
        metadatas=[metadata]
    )

    print(f"Campaign {campaign_id} indexed successfully.")

    return True


# ==========================================
# DELETE CAMPAIGN EMBEDDING
# ==========================================

def delete_campaign(campaign_id):
    """Delete a campaign from the semantic search collection."""

    collection2.delete(
        ids=[str(campaign_id)]
    )

    print(f"Campaign {campaign_id} removed from search.")

    return True


# ==========================================
# AI-POWERED CAMPAIGN SEARCH
# ==========================================

def search_campaigns(query, owner_id=None, limit=10):
    """
    Search campaigns using semantic similarity.

    owner_id:
        Provide a user ID to search only that user's campaigns.
        Use None for admin searches across all campaigns.
    """

    total_campaigns = collection2.count()

    if total_campaigns == 0:
        return []

    query_vector = embeddings.embed_query(query)

    search_filter = None

    if owner_id is not None:
        search_filter = {
            "owner_id": int(owner_id)
        }

    results = collection2.query(
        query_embeddings=[query_vector],
        n_results=min(limit, total_campaigns),
        where=search_filter
    )

    campaign_ids = results.get("ids", [[]])[0]
    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    matching_campaigns = []

    for index, campaign_id in enumerate(campaign_ids):
        metadata = metadatas[index] or {}

        matching_campaigns.append({
            "id": int(campaign_id),
            "campaign_id": int(metadata.get("campaign_id", campaign_id)),
            "owner_id": metadata.get("owner_id"),
            "content": documents[index],
            "status": metadata.get("status"),
            "budget": metadata.get("budget"),
            "distance": distances[index] if distances else None
        })

    return matching_campaigns
