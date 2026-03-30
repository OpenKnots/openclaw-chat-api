/**
 * Gemini Embeddings wrapper for docs-chat RAG pipeline.
 * Provides single and batch embedding generation.
 *
 * Switched from OpenAI text-embedding-3-large to Gemini gemini-embedding-001
 * to eliminate dependency on the frequently-revoked OPENAI_API_KEY.
 * The OpenClaw memory-search layer already uses Gemini successfully.
 *
 * Gemini gemini-embedding-001 produces 3072-dimensional vectors —
 * identical dimensionality to OpenAI text-embedding-3-large, so
 * the Upstash Vector index schema is unchanged.
 */

const DEFAULT_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "gemini-embedding-001": 3072,
  "text-embedding-004": 768,
};

// Gemini free tier: 100 embed requests per minute per project
// Each batchEmbedContents call counts as 1 request per text in the batch.
// To stay within the free tier: send batches of 50 with a 35s delay between batches.
// This is conservative — upgrade to paid tier to remove the delay.
const MAX_BATCH_SIZE = 50;
const BATCH_DELAY_MS = 35_000; // 35s between batches (~80 req/min, safely under 100)

const GEMINI_EMBED_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

export class Embeddings {
  private apiKey: string;
  private model: string;
  public readonly dimensions: number;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for embeddings");
    }
    const dims = EMBEDDING_DIMENSIONS[model];
    if (!dims) {
      throw new Error(`Unsupported embedding model: ${model}`);
    }
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dims;
  }

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    const url = `${GEMINI_EMBED_BASE}/${this.model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini embed failed (${response.status}): ${err}`);
    }
    const data = (await response.json()) as {
      embedding: { values: number[] };
    };
    return data.embedding.values;
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * Returns embeddings in the same order as input texts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      // Rate-limit: wait between batches to respect Gemini free tier quota
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }

      const batch = texts.slice(i, i + MAX_BATCH_SIZE);

      // Gemini batchEmbedContents endpoint
      const url = `${GEMINI_EMBED_BASE}/${this.model}:batchEmbedContents?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          })),
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(
          `Gemini batchEmbed failed (${response.status}): ${err}`
        );
      }

      const data = (await response.json()) as {
        embeddings: Array<{ values: number[] }>;
      };
      results.push(...data.embeddings.map((e) => e.values));
    }

    return results;
  }
}
