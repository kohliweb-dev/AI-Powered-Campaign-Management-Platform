from pathlib import Path
import tempfile
import hashlib
import time
from backend.config import settings
import chromadb
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
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


text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP
)


def split_text(text):
    """Split PDF text into smaller overlapping chunks using LangChain."""
    return text_splitter.split_text(text)


# ==========================================
# PDF UPLOAD AND EMBEDDING
# ==========================================

def add_pdf(file_bytes, filename, owner_id):
    """Extract PDF text, generate embeddings and save in ChromaDB."""

    start_time = time.perf_counter()

    file_hash = hashlib.sha256(file_bytes).hexdigest()

    existing = collection.get(
        where={
            "$and": [
                {"file_hash": file_hash},
                {"owner_id": int(owner_id)}
            ]
        },
        limit=1
    )

    if existing["ids"]:
        return {
            "filename": filename,
            "chunks": 0,
            "message": "This PDF has already been uploaded.",
            "file_hash": file_hash,
            "already_exists": True
        }

    # PyPDFLoader needs a file path, so temporarily save the uploaded PDF bytes.
    temp_pdf_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as temp_file:
            temp_file.write(file_bytes)
            temp_pdf_path = temp_file.name

        loader = PyPDFLoader(temp_pdf_path)
        documents = loader.load()

    finally:
        # Remove the temporary PDF after the pages have been loaded.
        if temp_pdf_path:
            Path(temp_pdf_path).unlink(missing_ok=True)

    # Combine text from all pages.
    page_texts = [
        document.page_content
        for document in documents
        if document.page_content.strip()
    ]

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
        f"{owner_id}_{file_hash}_{index}"
        for index in range(len(chunks))
    ]

    metadatas = [
        {
            "filename": filename,
            "file_hash": file_hash,
            "owner_id": int(owner_id),
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
        "file_hash": file_hash,
        "already_exists": False
    }


# ==========================================
# PDF SEMANTIC SEARCH
# ==========================================

def list_documents(owner_id=None):
    """Return indexed PDFs, scoped to an owner when one is provided."""

    where = {"owner_id": int(owner_id)} if owner_id is not None else None
    results = collection.get(include=["metadatas"], where=where)
    documents_by_hash = {}

    for metadata in results.get("metadatas") or []:
        if not metadata:
            continue

        file_hash = metadata.get("file_hash")
        if not file_hash:
            continue

        document = documents_by_hash.setdefault(
            file_hash,
            {
                "file_hash": file_hash,
                "filename": metadata.get("filename") or "Uploaded PDF",
                "chunks": 0
            }
        )
        document["chunks"] += 1

    return sorted(
        documents_by_hash.values(),
        key=lambda document: document["filename"].casefold()
    )


def delete_document(file_hash, owner_id=None):
    """Delete indexed chunks for a PDF, optionally scoped to its owner."""
    where = {"file_hash": file_hash}
    if owner_id is not None:
        where = {
            "$and": [
                where,
                {"owner_id": int(owner_id)}
            ]
        }

    results = collection.get(where=where, include=["metadatas"])
    ids = results.get("ids") or []

    if not ids:
        return None

    metadatas = results.get("metadatas") or []
    filename = next(
        (
            metadata.get("filename")
            for metadata in metadatas
            if metadata and metadata.get("filename")
        ),
        "Uploaded PDF"
    )

    collection.delete(ids=ids)

    return {
        "file_hash": file_hash,
        "filename": filename,
        "chunks_deleted": len(ids)
    }


def delete_user_embeddings(owner_id):
    """Delete PDF and campaign embeddings belonging to a user."""
    owner_filter = {"owner_id": int(owner_id)}

    pdf_ids = collection.get(where=owner_filter).get("ids") or []
    campaign_ids = collection2.get(where=owner_filter).get("ids") or []

    if pdf_ids:
        collection.delete(ids=pdf_ids)

    if campaign_ids:
        collection2.delete(ids=campaign_ids)

    return {
        "pdf_chunks_deleted": len(pdf_ids),
        "campaign_embeddings_deleted": len(campaign_ids)
    }


def search_documents(question, file_hash=None, owner_id=None, limit=5):
    """Search PDFs within an owner scope, optionally selecting one PDF."""

    filters = []
    if owner_id is not None:
        filters.append({"owner_id": int(owner_id)})
    if file_hash:
        filters.append({"file_hash": file_hash})

    where = None
    if len(filters) == 1:
        where = filters[0]
    elif filters:
        where = {"$and": filters}

    total_chunks = collection.count()

    if total_chunks == 0:
        return ""

    question_vector = embeddings.embed_query(question)

    if where is not None:
        results = collection.query(
            query_embeddings=[question_vector],
            n_results=min(limit, total_chunks),
            where=where
        )
    else:
        results = collection.query(
            query_embeddings=[question_vector],
            n_results=min(limit, total_chunks)
        )

    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]

    formatted_documents = []
    for index, document in enumerate(documents):
        if not document:
            continue

        metadata = metadatas[index] if index < len(metadatas) else {}
        filename = (metadata or {}).get("filename")
        source = f"[Source: {filename}]\n" if filename else ""
        formatted_documents.append(f"{source}{document}")

    return "\n\n".join(formatted_documents)


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
