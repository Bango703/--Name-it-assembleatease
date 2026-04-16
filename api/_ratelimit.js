const rateLimitMap = new Map();

export function rateLimit(ip, maxRequests = 5, windowMs = 60000) {
  const now = Date.now();
  const windowStart = now - windowMs;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const requests = rateLimitMap.get(ip).filter(time => time > windowStart);
  requests.push(now);
  rateLimitMap.set(ip, requests);

  if (requests.length > maxRequests) {
    return false;
  }
  return true;
}
