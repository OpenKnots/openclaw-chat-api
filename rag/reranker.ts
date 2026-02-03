/**
 * Cohere Rerank Integration for docs-chat RAG pipeline.
 * Uses cross-encoder model for high-precision relevance scoring.
 */

export interface RerankDocument {
  id: string;
  content: string;
}

export interface RerankResult {
  id: string;
  content: string;
  relevanceScore: number;
  originalRank: number;
}

// Cohere rerank model options
const RERANK_MODEL = "rerank-v3.5";

/**
 * Reranker using Cohere's cross-encoder model.
 */
export class Reranker {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = RERANK_MODEL) {
    if (!apiKey) {
      throw new Error("COHERE_API_KEY is required for reranking");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Rerank documents by relevance to the query.
   * Returns the top N most relevant documents.
   */
  async rerank(
    query: string,
    documents: RerankDocument[],
    topN: number = 8
  ): Promise<RerankResult[]> {
    if (documents.length === 0) {
      return [];
    }

    // If fewer documents than requested, just score them all
    const effectiveTopN = Math.min(topN, documents.length);

    try {
      const response = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: documents.map(d => d.content),
          top_n: effectiveTopN,
          return_documents: false,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Cohere rerank error:", error);
        throw new Error(`Cohere API error: ${response.status}`);
      }

      const data = await response.json() as CohereRerankResponse;

      // Map results back to original documents
      return data.results.map(result => ({
        id: documents[result.index].id,
        content: documents[result.index].content,
        relevanceScore: result.relevance_score,
        originalRank: result.index,
      }));
    } catch (error) {
      console.error("Reranking failed:", error);
      // Fallback: return documents in original order with decreasing scores
      return documents.slice(0, effectiveTopN).map((doc, index) => ({
        id: doc.id,
        content: doc.content,
        relevanceScore: 1 - (index / documents.length),
        originalRank: index,
      }));
    }
  }

  /**
   * Rerank with metadata preserved.
   * Useful when you need to keep additional fields through the reranking.
   */
  async rerankWithMetadata<T extends RerankDocument>(
    query: string,
    documents: T[],
    topN: number = 8
  ): Promise<Array<T & { relevanceScore: number; originalRank: number }>> {
    const results = await this.rerank(query, documents, topN);
    
    return results.map(result => {
      const originalDoc = documents.find(d => d.id === result.id)!;
      return {
        ...originalDoc,
        relevanceScore: result.relevanceScore,
        originalRank: result.originalRank,
      };
    });
  }
}

/**
 * Cohere API response type.
 */
interface CohereRerankResponse {
  id: string;
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
  meta: {
    api_version: { version: string };
    billed_units: { search_units: number };
  };
}

/**
 * Factory function to create a Reranker with optional fallback.
 * Returns null if Cohere is not configured.
 */
export function createReranker(): Reranker | null {
  const apiKey = process.env.COHERE_API_KEY;
  
  if (!apiKey) {
    console.warn("COHERE_API_KEY not set, reranking will be disabled");
    return null;
  }

  return new Reranker(apiKey);
}

/**
 * Simple passthrough reranker for when Cohere is not available.
 * Maintains the same interface but just returns documents in original order.
 */
export class PassthroughReranker {
  async rerank(
    _query: string,
    documents: RerankDocument[],
    topN: number = 8
  ): Promise<RerankResult[]> {
    return documents.slice(0, topN).map((doc, index) => ({
      id: doc.id,
      content: doc.content,
      relevanceScore: 1 - (index / Math.max(documents.length, 1)),
      originalRank: index,
    }));
  }
}

/**
 * Get a reranker instance (Cohere if available, passthrough otherwise).
 */
export function getReranker(): Reranker | PassthroughReranker {
  const cohereReranker = createReranker();
  return cohereReranker || new PassthroughReranker();
}
