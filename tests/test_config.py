from backend.config import get_service_url


def test_get_service_url_uses_explicit_host_override(monkeypatch):
    monkeypatch.setenv(
        "POSTGRES_URL",
        "postgresql+psycopg://user:password@localhost:5432/campaigns?sslmode=disable"
    )
    monkeypatch.setenv(
        "POSTGRES_HOST",
        "capstone-postgres-service.enterprise-capstone.svc.cluster.local"
    )
    monkeypatch.setenv("DOCKER_ENV", "true")

    assert get_service_url("POSTGRES_URL") == (
        "postgresql+psycopg://user:password@"
        "capstone-postgres-service.enterprise-capstone.svc.cluster.local:5432/"
        "campaigns?sslmode=disable"
    )


def test_get_service_url_preserves_docker_host_fallback(monkeypatch):
    monkeypatch.setenv("POSTGRES_URL", "postgresql://user:password@localhost:5432/db")
    monkeypatch.delenv("POSTGRES_HOST", raising=False)
    monkeypatch.setenv("DOCKER_ENV", "true")

    assert get_service_url("POSTGRES_URL") == (
        "postgresql://user:password@host.docker.internal:5432/db"
    )


def test_get_service_url_applies_mongodb_host_override(monkeypatch):
    monkeypatch.setenv(
        "MONGO_URL",
        "mongodb://admin:password@localhost:27017/?authSource=admin"
    )
    monkeypatch.setenv(
        "MONGO_HOST",
        "capstone-mongodb-service.enterprise-capstone.svc.cluster.local"
    )
    monkeypatch.setenv("DOCKER_ENV", "true")

    assert get_service_url("MONGO_URL") == (
        "mongodb://admin:password@"
        "capstone-mongodb-service.enterprise-capstone.svc.cluster.local:27017/"
        "?authSource=admin"
    )
