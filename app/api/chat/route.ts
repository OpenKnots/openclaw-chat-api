/**
 * Chat Endpoint
 * Handles hybrid RAG-based question answering with streaming responses.
 * Features: Multi-strategy retrieval, Cohere reranking, and observability.
 */
import { NextRequest } from "next/server";
import { Embeddings } from "@/rag/embeddings";
import { DocsStore } from "@/rag/store-upstash";
import { Retriever } from "@/rag/retriever-upstash";
import { checkRateLimit, getClientIp } from "@/rag/ratelimit";
import { classifyQuery, type ClassifiedQuery } from "@/rag/classifier";
import { BM25Searcher, loadTermIndex } from "@/rag/bm25-searcher";
import { reciprocalRankFusion, type FusedResult } from "@/rag/fusion";
import { getReranker, type RerankResult } from "@/rag/reranker";
import {
  getObservabilityService,
  generateQueryId,
  type QueryLog,
} from "@/rag/observability";

export const runtime = "edge";

const MAX_MESSAGE_LENGTH = 2000;
const ENABLE_HYBRID = process.env.ENABLE_HYBRID_SEARCH === "true";

const ALLOWED_ORIGINS = [
  "https://docs.openclaw.ai",
];

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin");
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin", // Important for caching
  };
}

// Handle preflight requests
export async function OPTIONS(request: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  });
}

function jsonResponse(
  request: Request,
  data: object,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request),
      ...headers,
    },
  });
}

// Enhanced system prompt for better answers
function buildSystemPrompt(context: string): string {
  return `You are an expert assistant for OpenClaw documentation.

INSTRUCTIONS:
1. Answer ONLY from the provided documentation excerpts
2. If the answer is not in the excerpts, clearly state this
3. Cite sources using [Source Title](URL) format
4. For code examples, use the exact code from docs when available
5. Be concise but complete
6. If multiple approaches exist, mention the recommended one first

CONFIDENCE:
- If you're highly confident, answer directly
- If partially confident, caveat with "Based on the available documentation..."
- If not confident, say "I couldn't find specific documentation for this..."

DOCUMENTATION EXCERPTS:
${context}`;
}

export async function POST(request: NextRequest) {
  const queryId = generateQueryId();
  const startTime = Date.now();
  let retrievalMs = 0;
  let rerankMs = 0;

  try {
    // Rate limiting
    const headersObj: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headersObj[key] = value;
    });
    const clientIp = getClientIp(headersObj);
    const rateLimitResult = await checkRateLimit(clientIp);

    const rateLimitHeaders: Record<string, string> = {};
    if (rateLimitResult) {
      rateLimitHeaders["X-RateLimit-Limit"] = rateLimitResult.limit.toString();
      rateLimitHeaders["X-RateLimit-Remaining"] =
        rateLimitResult.remaining.toString();
      rateLimitHeaders["X-RateLimit-Reset"] = rateLimitResult.reset.toString();

      if (!rateLimitResult.success) {
        rateLimitHeaders["Retry-After"] = Math.ceil(
          (rateLimitResult.reset - Date.now()) / 1000
        ).toString();
        return jsonResponse(
          request,
          { error: "Too many requests. Please try again later.", status: 429 },
          429,
          rateLimitHeaders
        );
      }
    }

    // Validate environment
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return jsonResponse(
        request,
        { error: "Server configuration error", status: 500 },
        500,
        rateLimitHeaders
      );
    }

    // Parse body
    let message = "";
    const ALLOWED_MODELS = [
      "gpt-5-nano",
      "gpt-5-mini",
      "gpt-5",
      "gpt-5.1",
      "gpt-5.2",
    ];
    const ALLOWED_STRATEGIES = ["auto", "hybrid", "semantic", "keyword"] as const;
    type UserStrategy = (typeof ALLOWED_STRATEGIES)[number];

    const defaultModel = process.env.DEFAULT_CHAT_MODEL || "gpt-5-mini";
    let model = ALLOWED_MODELS.includes(defaultModel)
      ? defaultModel
      : "gpt-5-mini";
    let userStrategy: UserStrategy = "auto";

    try {
      const body = await request.json();
      message = body?.message;
      if (
        body?.model &&
        typeof body.model === "string" &&
        ALLOWED_MODELS.includes(body.model)
      ) {
        model = body.model;
      }
      if (
        body?.retrieval &&
        typeof body.retrieval === "string" &&
        ALLOWED_STRATEGIES.includes(body.retrieval as UserStrategy)
      ) {
        userStrategy = body.retrieval as UserStrategy;
      }
    } catch {
      return jsonResponse(
        request,
        { error: "Invalid JSON", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    if (!message || typeof message !== "string") {
      return jsonResponse(
        request,
        { error: "message required", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return jsonResponse(
        request,
        { error: "message required", status: 400 },
        400,
        rateLimitHeaders
      );
    }

    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse(
        request,
        {
          error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
          status: 400,
        },
        400,
        rateLimitHeaders
      );
    }

    // Classify query for optimal retrieval strategy
    const classified: ClassifiedQuery = classifyQuery(trimmedMessage);

    // Override strategy if user explicitly selected one (not "auto")
    if (userStrategy !== "auto") {
      classified.strategy = userStrategy;
    }

    // Initialize RAG components
    const embeddings = new Embeddings(apiKey);
    const store = new DocsStore();
    const retriever = new Retriever(store, embeddings);

    let finalResults: Array<{
      id: string;
      content: string;
      title: string;
      url: string;
      score: number;
    }> = [];
    let topScores: number[] = [];

    const retrievalStart = Date.now();

    if (ENABLE_HYBRID) {
      // ===== HYBRID SEARCH PIPELINE =====

      // Load BM25 index
      const termIndex = await loadTermIndex();
      const bm25Searcher = termIndex ? new BM25Searcher(termIndex) : null;

      // Retrieve based on strategy
      let semanticResults: Awaited<ReturnType<typeof retriever.retrieve>> = [];
      let keywordResults: Array<{ id: string; score: number }> = [];

      // Semantic search (for semantic and hybrid strategies)
      if (classified.strategy !== "keyword") {
        semanticResults = await retriever.retrieve(classified.expanded, 20);
      }

      // Keyword search (for keyword and hybrid strategies)
      if (bm25Searcher && classified.strategy !== "semantic") {
        const keywordQuery = classified.keywords.join(" ");
        keywordResults = bm25Searcher.search(keywordQuery, 20);
      }

      retrievalMs = Date.now() - retrievalStart;

      // Build chunk map for fusion (from semantic results)
      const chunkMap = new Map(
        semanticResults.map((r) => [r.chunk.id, r.chunk])
      );

      // Fuse results based on strategy
      let fusedResults: FusedResult[];

      if (classified.strategy === "hybrid" && keywordResults.length > 0 && semanticResults.length > 0) {
        // Hybrid: combine both using RRF
        fusedResults = reciprocalRankFusion(
          semanticResults,
          keywordResults,
          chunkMap
        );
      } else if (classified.strategy === "keyword" && keywordResults.length > 0) {
        // Keyword only: need to fetch chunk data for keyword results
        // For now, fall back to semantic if we have no chunk data
        if (semanticResults.length > 0) {
          // Use semantic results that match keyword IDs, prioritized by keyword rank
          const keywordIds = new Set(keywordResults.map(r => r.id));
          const matchingResults = semanticResults.filter(r => keywordIds.has(r.chunk.id));
          fusedResults = matchingResults.map((r, idx) => ({
            id: r.chunk.id,
            chunk: r.chunk,
            semanticRank: null,
            semanticScore: null,
            keywordRank: idx + 1,
            keywordScore: keywordResults.find(kr => kr.id === r.chunk.id)?.score || 0,
            fusedScore: keywordResults.find(kr => kr.id === r.chunk.id)?.score || 0,
          }));
        } else {
          // No semantic results, need to do a semantic search to get chunk data
          const semanticFallback = await retriever.retrieve(classified.expanded, 20);
          semanticFallback.forEach(r => chunkMap.set(r.chunk.id, r.chunk));
          fusedResults = reciprocalRankFusion(
            semanticFallback,
            keywordResults,
            chunkMap
          );
        }
      } else {
        // Semantic only or fallback
        fusedResults = semanticResults.map((r, idx) => ({
          id: r.chunk.id,
          chunk: r.chunk,
          semanticRank: idx + 1,
          semanticScore: r.score,
          keywordRank: null,
          keywordScore: null,
          fusedScore: r.score,
        }));
      }

      // Rerank with Cohere
      const rerankStart = Date.now();
      const reranker = getReranker();

      const docsToRerank = fusedResults.slice(0, 25).map((r) => ({
        id: r.id,
        content: r.chunk.content,
        title: r.chunk.title,
        url: r.chunk.url,
      }));

      const reranked: RerankResult[] = await reranker.rerank(
        classified.original,
        docsToRerank,
        8
      );

      rerankMs = Date.now() - rerankStart;

      // Map reranked results back with metadata
      finalResults = reranked.map((r) => {
        const original = docsToRerank.find((d) => d.id === r.id)!;
        return {
          id: r.id,
          content: original.content,
          title: original.title,
          url: original.url,
          score: r.relevanceScore,
        };
      });

      topScores = finalResults.map((r) => r.score);
    } else {
      // ===== LEGACY SEMANTIC-ONLY PIPELINE =====
      const results = await retriever.retrieve(trimmedMessage, 8);
      retrievalMs = Date.now() - retrievalStart;

      finalResults = results.map((r) => ({
        id: r.chunk.id,
        content: r.chunk.content,
        title: r.chunk.title,
        url: r.chunk.url,
        score: r.score,
      }));

      topScores = finalResults.map((r) => r.score);
    }

    // Handle no results
    if (finalResults.length === 0) {
      // Log the failed query
      logQueryAsync(queryId, {
        timestamp: startTime,
        query: trimmedMessage,
        intent: classified.intent,
        strategy: classified.strategy,
        retrievalMs,
        rerankMs,
        totalMs: Date.now() - startTime,
        resultCount: 0,
        topChunkIds: [],
        topScores: [],
        model,
        success: false,
        errorMessage: "No results found",
        clientIp,
      });

      return new Response(
        "I couldn't find relevant documentation excerpts for that question. Try rephrasing or search the docs.",
        {
          headers: {
            "Content-Type": "text/plain",
            ...getCorsHeaders(request),
            ...rateLimitHeaders,
            "X-Query-Id": queryId,
          },
        }
      );
    }

    // Build context from retrieved chunks
    const context = finalResults
      .map((result) => `[${result.title}](${result.url})\n${result.content.slice(0, 1200)}`)
      .join("\n\n---\n\n");

    const systemPrompt = buildSystemPrompt(context);

    // Stream response from OpenAI
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: trimmedMessage },
          ],
        }),
      }
    );

    if (!openaiResponse.ok || !openaiResponse.body) {
      return jsonResponse(
        request,
        { error: `OpenAI API error: ${openaiResponse.status}`, status: 502 },
        502,
        rateLimitHeaders
      );
    }

    // Log successful query (async, non-blocking)
    logQueryAsync(queryId, {
      timestamp: startTime,
      query: trimmedMessage,
      intent: classified.intent,
      strategy: classified.strategy,
      retrievalMs,
      rerankMs,
      totalMs: Date.now() - startTime,
      resultCount: finalResults.length,
      topChunkIds: finalResults.slice(0, 5).map((r) => r.id),
      topScores: topScores.slice(0, 5),
      model,
      success: true,
      clientIp,
    });

    // Create a TransformStream to process SSE data
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");

        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      },
      flush() {
        // Process any remaining buffered data on stream end
        if (buffer.trim().startsWith("data:")) {
          const data = buffer.trim().slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                encoder.encode(delta);
              }
            } catch {
              // Ignore
            }
          }
        }
      },
    });

    // Pipe the OpenAI response through our transform
    const readable = openaiResponse.body.pipeThrough(transformStream);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        ...getCorsHeaders(request),
        ...rateLimitHeaders,
        "X-Query-Id": queryId,
      },
    });
  } catch (error) {
    console.error("[Error]", error);
    return jsonResponse(request, { error: "Internal Server Error", status: 500 }, 500);
  }
}

/**
 * Log query asynchronously without blocking the response.
 */
function logQueryAsync(
  queryId: string,
  data: Omit<QueryLog, "id">
): void {
  const observability = getObservabilityService();
  observability.logQuery({ id: queryId, ...data }).catch((err) => {
    console.error("Failed to log query:", err);
  });
}
