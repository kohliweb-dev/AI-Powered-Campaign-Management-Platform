import hashlib
from pathlib import Path

import backend.rag as rag


class FakeCollection:
    def __init__(self, count=1, results=None):
        self.chunk_count = count
        self.results = results or {}
        self.query_arguments = None

    def count(self):
        return self.chunk_count

    def query(self, **kwargs):
        self.query_arguments = kwargs
        return self.results


class FakeEmbeddings:
    def embed_query(self, question):
        return [0.1, 0.2]


def test_add_pdf_stores_chunks_under_owner(monkeypatch):
    class UploadCollection:
        def get(self, where, limit):
            self.lookup_filter = where
            return {"ids": []}

        def add(self, ids, documents, embeddings, metadatas):
            self.added = {
                "ids": ids,
                "documents": documents,
                "metadatas": metadatas
            }

    class Document:
        page_content = "Private document contents."

    class UploadLoader:
        def __init__(self, path):
            assert Path(path).is_file()

        def load(self):
            return [Document()]

    class UploadEmbeddings:
        def embed_documents(self, documents):
            return [[0.1, 0.2] for _ in documents]

    collection = UploadCollection()
    monkeypatch.setattr(rag, "collection", collection)
    monkeypatch.setattr(rag, "PyPDFLoader", UploadLoader)
    monkeypatch.setattr(rag, "embeddings", UploadEmbeddings())

    file_bytes = b"private pdf"
    file_hash = hashlib.sha256(file_bytes).hexdigest()

    rag.add_pdf(file_bytes, "private.pdf", owner_id=17)

    assert collection.lookup_filter == {
        "$and": [
            {"file_hash": file_hash},
            {"owner_id": 17}
        ]
    }
    assert collection.added["ids"] == [f"17_{file_hash}_0"]
    assert collection.added["metadatas"][0]["owner_id"] == 17


def test_search_documents_filters_to_selected_pdf(monkeypatch):
    collection = FakeCollection(
        count=8,
        results={
            "documents": [["Relevant PDF text"]],
            "metadatas": [[{"filename": "guide.pdf"}]]
        }
    )
    monkeypatch.setattr(rag, "collection", collection)
    monkeypatch.setattr(rag, "embeddings", FakeEmbeddings())

    context = rag.search_documents(
        "What is the budget?",
        file_hash="pdf-hash",
        owner_id=17
    )

    assert context == "[Source: guide.pdf]\nRelevant PDF text"
    assert collection.query_arguments["where"] == {
        "$and": [
            {"owner_id": 17},
            {"file_hash": "pdf-hash"}
        ]
    }
    assert collection.query_arguments["n_results"] == 5


def test_search_documents_returns_empty_when_index_is_empty(monkeypatch):
    collection = FakeCollection(count=0)
    monkeypatch.setattr(rag, "collection", collection)

    assert rag.search_documents("Question") == ""
    assert collection.query_arguments is None


def test_search_documents_scopes_all_pdf_searches_to_owner(monkeypatch):
    collection = FakeCollection(
        count=4,
        results={
            "documents": [["User's PDF text"]],
            "metadatas": [[{"filename": "private.pdf"}]]
        }
    )
    monkeypatch.setattr(rag, "collection", collection)
    monkeypatch.setattr(rag, "embeddings", FakeEmbeddings())

    context = rag.search_documents("Question", owner_id=17)

    assert "User's PDF text" in context
    assert collection.query_arguments["where"] == {"owner_id": 17}


def test_list_documents_groups_chunks_by_pdf(monkeypatch):
    class MetadataCollection:
        def get(self, include, where):
            assert include == ["metadatas"]
            assert where == {"owner_id": 17}
            metadata = [
                {"owner_id": 17, "file_hash": "pdf-hash", "filename": "guide.pdf"},
                {"owner_id": 17, "file_hash": "pdf-hash", "filename": "guide.pdf"},
                {"owner_id": 29, "file_hash": "other-hash", "filename": "report.pdf"}
            ]
            return {
                "metadatas": [
                    item
                    for item in metadata
                    if item["owner_id"] == where["owner_id"]
                ]
            }

    monkeypatch.setattr(rag, "collection", MetadataCollection())

    assert rag.list_documents(owner_id=17) == [
        {"file_hash": "pdf-hash", "filename": "guide.pdf", "chunks": 2}
    ]


def test_delete_document_deletes_only_owner_chunks(monkeypatch):
    class DeletionCollection:
        def get(self, where, include):
            assert where == {
                "$and": [
                    {"file_hash": "pdf-hash"},
                    {"owner_id": 17}
                ]
            }
            assert include == ["metadatas"]
            return {
                "ids": ["17_pdf-hash_0", "17_pdf-hash_1"],
                "metadatas": [
                    {"filename": "guide.pdf"},
                    {"filename": "guide.pdf"}
                ]
            }

        def delete(self, ids):
            self.deleted_ids = ids

    collection = DeletionCollection()
    monkeypatch.setattr(rag, "collection", collection)

    result = rag.delete_document("pdf-hash", owner_id=17)

    assert collection.deleted_ids == ["17_pdf-hash_0", "17_pdf-hash_1"]
    assert result == {
        "file_hash": "pdf-hash",
        "filename": "guide.pdf",
        "chunks_deleted": 2
    }


def test_delete_document_returns_none_when_pdf_not_owned(monkeypatch):
    class EmptyCollection:
        def get(self, where, include):
            return {"ids": [], "metadatas": []}

        def delete(self, ids):
            raise AssertionError("Should not delete when there are no matches.")

    monkeypatch.setattr(rag, "collection", EmptyCollection())

    assert rag.delete_document("other-users-pdf", owner_id=17) is None


def test_delete_document_without_owner_scope_deletes_all_matching_chunks(monkeypatch):
    class AdminDeletionCollection:
        def get(self, where, include):
            assert where == {"file_hash": "shared-hash"}
            assert include == ["metadatas"]
            return {
                "ids": ["17_shared-hash_0", "29_shared-hash_0"],
                "metadatas": [
                    {"filename": "guide.pdf"},
                    {"filename": "guide.pdf"}
                ]
            }

        def delete(self, ids):
            self.deleted_ids = ids

    collection = AdminDeletionCollection()
    monkeypatch.setattr(rag, "collection", collection)

    result = rag.delete_document("shared-hash")

    assert collection.deleted_ids == [
        "17_shared-hash_0",
        "29_shared-hash_0"
    ]
    assert result["chunks_deleted"] == 2


def test_delete_user_embeddings_removes_pdf_and_campaign_vectors(monkeypatch):
    class OwnedCollection:
        def __init__(self, ids):
            self.ids = ids
            self.deleted_ids = []

        def get(self, where):
            assert where == {"owner_id": 17}
            return {"ids": self.ids}

        def delete(self, ids):
            self.deleted_ids.extend(ids)

    pdf_collection = OwnedCollection(["pdf-chunk-1", "pdf-chunk-2"])
    campaign_collection = OwnedCollection(["campaign-4"])
    monkeypatch.setattr(rag, "collection", pdf_collection)
    monkeypatch.setattr(rag, "collection2", campaign_collection)

    result = rag.delete_user_embeddings(owner_id=17)

    assert pdf_collection.deleted_ids == ["pdf-chunk-1", "pdf-chunk-2"]
    assert campaign_collection.deleted_ids == ["campaign-4"]
    assert result == {
        "pdf_chunks_deleted": 2,
        "campaign_embeddings_deleted": 1
    }
