import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const limiters = {
  default: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '60 s'),
    prefix: 'rl:default',
  }),
  booking: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, '60 s'),
    prefix: 'rl:booking',
  }),
  apply: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '300 s'),
    prefix: 'rl:apply',
  }),
};

export async function rateLimit(ip, type = 'default') {
  const limiter = limiters[type] || limiters.default;
  const { success } = await limiter.limit(ip);
  return success;
}

