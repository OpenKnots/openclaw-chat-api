/**
 * Observability Layer for docs-chat RAG pipeline.
 * Provides query logging, feedback collection, and analytics.
 */
import { Redis } from "@upstash/redis";
import type { QueryIntent, RetrievalStrategy } from "./classifier";

// Key prefixes for Redis storage
const KEYS = {
  QUERY: "obs:query:",
  FEEDBACK: "obs:feedback:",
  STATS_DAILY: "obs:stats:daily:",
  COVERAGE_GAPS: "obs:gaps",
  LOW_CONFIDENCE: "obs:low_confidence",
} as const;

// Retention settings
const QUERY_LOG_TTL = 60 * 60 * 24 * 30; // 30 days
const STATS_TTL = 60 * 60 * 24 * 90; // 90 days

export interface QueryLog {
  id: string;
  timestamp: number;
  query: string;
  intent: QueryIntent;
  strategy: RetrievalStrategy;
  retrievalMs: number;
  rerankMs: number;
  totalMs: number;
  resultCount: number;
  topChunkIds: string[];
  topScores: number[];
  model: string;
  success: boolean;
  errorMessage?: string;
  clientIp?: string;
}

export interface FeedbackEntry {
  queryId: string;
  rating: "helpful" | "not_helpful" | "partial";
  comment?: string;
  timestamp: number;
}

export interface QueryStats {
  period: string;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  strategyDistribution: Record<RetrievalStrategy, number>;
  intentDistribution: Record<QueryIntent, number>;
  feedbackSummary: {
    helpful: number;
    notHelpful: number;
    partial: number;
  };
}

export interface CoverageGap {
  query: string;
  count: number;
  lastSeen: number;
  avgScore: number;
}

/**
 * Observability service for tracking and analyzing RAG performance.
 */
export class ObservabilityService {
  private redis: Redis | null = null;
  private enabled: boolean;

  constructor() {
    this.enabled = process.env.ENABLE_OBSERVABILITY === "true";

    if (this.enabled) {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;

      if (url && token) {
        this.redis = new Redis({ url, token });
      } else {
        console.warn("Observability enabled but Redis not configured");
        this.enabled = false;
      }
    }
  }

  /**
   * Log a query and its results.
   */
  async logQuery(log: QueryLog): Promise<void> {
    if (!this.enabled || !this.redis) return;

    try {
      const key = `${KEYS.QUERY}${log.id}`;

      // Store the query log
      await this.redis.set(key, JSON.stringify(log), { ex: QUERY_LOG_TTL });

      // Update daily stats
      await this.updateDailyStats(log);

      // Track low-confidence queries for coverage analysis
      if (log.resultCount === 0 || (log.topScores[0] && log.topScores[0] < 0.5)) {
        await this.trackCoverageGap(log);
      }
    } catch (error) {
      console.error("Failed to log query:", error);
    }
  }

  /**
   * Record user feedback for a query.
   */
  async recordFeedback(feedback: FeedbackEntry): Promise<void> {
    if (!this.enabled || !this.redis) return;

    try {
      const key = `${KEYS.FEEDBACK}${feedback.queryId}`;
      await this.redis.set(key, JSON.stringify(feedback), { ex: QUERY_LOG_TTL });

      // Update feedback counts in daily stats
      const dateKey = this.getDateKey(feedback.timestamp);
      const statsKey = `${KEYS.STATS_DAILY}${dateKey}`;

      await this.redis.hincrby(statsKey, `feedback:${feedback.rating}`, 1);
    } catch (error) {
      console.error("Failed to record feedback:", error);
    }
  }

  /**
   * Get a specific query log.
   */
  async getQueryLog(queryId: string): Promise<QueryLog | null> {
    if (!this.redis) return null;

    try {
      const data = await this.redis.get<string>(`${KEYS.QUERY}${queryId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get query statistics for a time range.
   */
  async getQueryStats(timeRange: "day" | "week" | "month" = "day"): Promise<QueryStats | null> {
    if (!this.redis) return null;

    try {
      const days = timeRange === "day" ? 1 : timeRange === "week" ? 7 : 30;
      const stats: QueryStats = {
        period: timeRange,
        totalQueries: 0,
        successfulQueries: 0,
        failedQueries: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        strategyDistribution: { semantic: 0, keyword: 0, hybrid: 0 },
        intentDistribution: { lookup: 0, conceptual: 0, troubleshooting: 0, comparison: 0 },
        feedbackSummary: { helpful: 0, notHelpful: 0, partial: 0 },
      };

      const latencies: number[] = [];

      for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = this.getDateKey(date.getTime());
        const statsKey = `${KEYS.STATS_DAILY}${dateKey}`;

        const dayStats = await this.redis.hgetall(statsKey);
        if (!dayStats) continue;

        stats.totalQueries += parseInt(dayStats.total as string || "0", 10);
        stats.successfulQueries += parseInt(dayStats.success as string || "0", 10);
        stats.failedQueries += parseInt(dayStats.failed as string || "0", 10);

        // Strategy distribution
        stats.strategyDistribution.semantic += parseInt(dayStats["strategy:semantic"] as string || "0", 10);
        stats.strategyDistribution.keyword += parseInt(dayStats["strategy:keyword"] as string || "0", 10);
        stats.strategyDistribution.hybrid += parseInt(dayStats["strategy:hybrid"] as string || "0", 10);

        // Intent distribution
        stats.intentDistribution.lookup += parseInt(dayStats["intent:lookup"] as string || "0", 10);
        stats.intentDistribution.conceptual += parseInt(dayStats["intent:conceptual"] as string || "0", 10);
        stats.intentDistribution.troubleshooting += parseInt(dayStats["intent:troubleshooting"] as string || "0", 10);
        stats.intentDistribution.comparison += parseInt(dayStats["intent:comparison"] as string || "0", 10);

        // Feedback
        stats.feedbackSummary.helpful += parseInt(dayStats["feedback:helpful"] as string || "0", 10);
        stats.feedbackSummary.notHelpful += parseInt(dayStats["feedback:not_helpful"] as string || "0", 10);
        stats.feedbackSummary.partial += parseInt(dayStats["feedback:partial"] as string || "0", 10);

        // Latency tracking (stored as JSON array)
        const latencyData = dayStats.latencies as string;
        if (latencyData) {
          try {
            latencies.push(...JSON.parse(latencyData));
          } catch {
            // Ignore parsing errors
          }
        }
      }

      // Calculate latency stats
      if (latencies.length > 0) {
        stats.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        latencies.sort((a, b) => a - b);
        stats.p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] || 0;
      }

      return stats;
    } catch (error) {
      console.error("Failed to get query stats:", error);
      return null;
    }
  }

  /**
   * Get queries that consistently return low scores (coverage gaps).
   */
  async getCoverageGaps(limit: number = 20): Promise<CoverageGap[]> {
    if (!this.redis) return [];

    try {
      // Get top queries by count from sorted set
      const results = await this.redis.zrange(KEYS.COVERAGE_GAPS, 0, limit - 1, {
        rev: true,
        withScores: true,
      });

      const gaps: CoverageGap[] = [];

      for (let i = 0; i < results.length; i += 2) {
        const query = results[i] as string;
        const count = results[i + 1] as number;

        // Get additional metadata
        const metaKey = `${KEYS.COVERAGE_GAPS}:meta:${this.hashQuery(query)}`;
        const meta = await this.redis.hgetall(metaKey);

        gaps.push({
          query,
          count,
          lastSeen: parseInt(meta?.lastSeen as string || "0", 10),
          avgScore: parseFloat(meta?.avgScore as string || "0"),
        });
      }

      return gaps;
    } catch (error) {
      console.error("Failed to get coverage gaps:", error);
      return [];
    }
  }

  /**
   * Get queries with low user ratings.
   */
  async getLowRatedQueries(limit: number = 20): Promise<QueryLog[]> {
    if (!this.redis) return [];

    try {
      // Get low-rated query IDs
      const queryIds = await this.redis.zrange(KEYS.LOW_CONFIDENCE, 0, limit - 1, {
        rev: true,
      });

      const queries: QueryLog[] = [];

      for (const queryId of queryIds) {
        const log = await this.getQueryLog(queryId as string);
        if (log) {
          queries.push(log);
        }
      }

      return queries;
    } catch (error) {
      console.error("Failed to get low-rated queries:", error);
      return [];
    }
  }

  /**
   * Update daily statistics.
   */
  private async updateDailyStats(log: QueryLog): Promise<void> {
    if (!this.redis) return;

    const dateKey = this.getDateKey(log.timestamp);
    const statsKey = `${KEYS.STATS_DAILY}${dateKey}`;

    const pipeline = this.redis.pipeline();

    pipeline.hincrby(statsKey, "total", 1);
    pipeline.hincrby(statsKey, log.success ? "success" : "failed", 1);
    pipeline.hincrby(statsKey, `strategy:${log.strategy}`, 1);
    pipeline.hincrby(statsKey, `intent:${log.intent}`, 1);
    pipeline.expire(statsKey, STATS_TTL);

    await pipeline.exec();
  }

  /**
   * Track a query as a potential coverage gap.
   */
  private async trackCoverageGap(log: QueryLog): Promise<void> {
    if (!this.redis) return;

    const normalizedQuery = log.query.toLowerCase().trim();
    const queryHash = this.hashQuery(normalizedQuery);
    const metaKey = `${KEYS.COVERAGE_GAPS}:meta:${queryHash}`;

    // Increment count in sorted set
    await this.redis.zincrby(KEYS.COVERAGE_GAPS, 1, normalizedQuery);

    // Update metadata
    const currentAvg = parseFloat((await this.redis.hget(metaKey, "avgScore")) as string || "0");
    const currentCount = parseInt((await this.redis.hget(metaKey, "count")) as string || "0", 10);
    const topScore = log.topScores[0] || 0;
    const newAvg = (currentAvg * currentCount + topScore) / (currentCount + 1);

    await this.redis.hset(metaKey, {
      lastSeen: log.timestamp.toString(),
      avgScore: newAvg.toString(),
      count: (currentCount + 1).toString(),
    });
    await this.redis.expire(metaKey, STATS_TTL);
  }

  /**
   * Get date key for daily stats.
   */
  private getDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  /**
   * Simple hash for query normalization.
   */
  private hashQuery(query: string): string {
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}

/**
 * Generate a unique query ID.
 */
export function generateQueryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

/**
 * Singleton instance for the observability service.
 */
let observabilityInstance: ObservabilityService | null = null;

export function getObservabilityService(): ObservabilityService {
  if (!observabilityInstance) {
    observabilityInstance = new ObservabilityService();
  }
  return observabilityInstance;
}
