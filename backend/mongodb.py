
from pymongo import MongoClient

from backend.config import settings

# Connect to MongoDB using credentials from .env
client = MongoClient(
    settings.MONGO_URL,
    serverSelectionTimeoutMS=5000
)

# Select database
mongo_db = client["campaign_platform"]

# Collection for chatbot conversations
chat_collection = mongo_db["chat_history"]

# Collection for AI documents
documents_collection = mongo_db["documents"]


# Check MongoDB connection
def check_mongodb():
    try:
        client.admin.command("ping")
        return True
    except Exception as e:
        print("MongoDB connection error:", repr(e))
        return False
