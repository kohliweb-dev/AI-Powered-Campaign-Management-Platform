
import redis

from backend.config import settings

# Connect to Redis
redis_client = redis.Redis.from_url(
    settings.REDIS_URL,
    decode_responses=True,
    socket_connect_timeout=1,
    socket_timeout=1
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



# Redis is used mainly as a temporary cache for campaign 
# lists. When /campaigns is requested, the app first checks Redis;
#  if a cached result exists, it returns that instead of querying the database. 
# Otherwise, it fetches campaigns from the database, stores the result in Redis for 60 seconds,
#  and returns it (campaign endpoint).