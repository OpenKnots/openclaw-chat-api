/**
 * Rate limiting using Upstash Redis.
 *
 * Environment variables:
 *   UPSTASH_REDIS_REST_URL - Upstash Redis endpoint
 *   UPSTASH_REDIS_REST_TOKEN - Upstash Redis auth token
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Sliding window: 10 requests per 60 seconds per IP
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW = "60 s";

let ratelimit: Ratelimit | null = null;

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn("Rate limiting disabled: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set");
    return null;
  }

  const redis = new Redis({ url, token });

  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW),
    analytics: true,
    prefix: "openclaw-chat",
  });

  return ratelimit;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Check rate limit for a given identifier (typically IP address).
 * Returns null if rate limiting is not configured.
 */
export async function checkRateLimit(identifier: string): Promise<RateLimitResult | null> {
  const limiter = getRatelimit();
  if (!limiter) return null;

  const result = await limiter.limit(identifier);

  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

/**
 * Extract client IP from Vercel request headers.
 */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  // Vercel provides the real client IP in x-forwarded-for
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return ip.trim();
  }

  // Fallback to x-real-ip
  const realIp = headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return "unknown";
}
