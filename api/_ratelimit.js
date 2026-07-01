import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redisUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const redisToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const hasRedisConfig = !!(redisUrl && redisToken);

const redis = hasRedisConfig
  ? new Redis({
      url: redisUrl,
      token: redisToken,
    })
  : null;

function buildLimiter(prefix, count, window) {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(count, window),
    prefix,
  });
}

const limiters = {
  default: buildLimiter('rl:default', 10, '60 s'),
  chat: buildLimiter('rl:chat', 12, '60 s'),
  booking: buildLimiter('rl:booking', 5, '60 s'),
  apply: buildLimiter('rl:apply', 3, '300 s'),
  setup_intent: buildLimiter('rl:setup_intent', 3, '600 s'),
  setup_intent_email: buildLimiter('rl:setup_intent_email', 2, '600 s'),
};

export async function rateLimitKey(key, type = 'default') {
  const limiter = limiters[type] || limiters.default;
  if (!limiter) return true;
  const { success } = await limiter.limit(String(key || 'unknown'));
  return success;
}

export async function rateLimit(ip, type = 'default') {
  return rateLimitKey(ip, type);
}
