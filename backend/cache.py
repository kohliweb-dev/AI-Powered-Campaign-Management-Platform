
import redis

from backend.config import settings

# Connect to Redis
redis_client = redis.Redis.from_url(
    settings.REDIS_URL,
    decode_responses=True
)


# Check Redis connection
def check_redis():
    try:
        return redis_client.ping()
    except redis.RedisError:
        return False




# redis.Redis.from_url() connects our application to Redis.
# settings.REDIS_URL reads the connection URL from .env.
# ping() checks whether Redis is responding.
# decode_responses=True makes returned values readable strings.