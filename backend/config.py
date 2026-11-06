
import os
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv

load_dotenv()


def get_service_url(env_name):
    """
    Read a service URL from environment variables.

    When running inside Docker, replace localhost with
    host.docker.internal so the container can reach Windows services.
    """
    url = os.getenv(env_name)

    if not url:
        return None

    if os.getenv("DOCKER_ENV", "").lower() == "true":
        parts = urlsplit(url)

        if parts.hostname in ("localhost", "127.0.0.1"):
            username_password = ""

            if "@" in parts.netloc:
                username_password = parts.netloc.rsplit("@", 1)[0] + "@"

            port = f":{parts.port}" if parts.port else ""

            new_netloc = (
                username_password
                + "host.docker.internal"
                + port
            )

            url = urlunsplit((
                parts.scheme,
                new_netloc,
                parts.path,
                parts.query,
                parts.fragment
            ))

    return url


class Settings:
    APP_NAME = "AI-Powered Campaign Management Platform"

    POSTGRES_URL = get_service_url("POSTGRES_URL")
    MONGO_URL = get_service_url("MONGO_URL")
    REDIS_URL = get_service_url("REDIS_URL")

    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

    # Ollama configuration
    OLLAMA_BASE_URL = os.getenv(
        "OLLAMA_BASE_URL",
        "http://localhost:11434"
    )

    # JWT configuration
    SECRET_KEY = os.getenv("SECRET_KEY")
    ALGORITHM = "HS256"


settings = Settings()

# Make JWT settings available directly to security.py
SECRET_KEY = settings.SECRET_KEY
ALGORITHM = settings.ALGORITHM
