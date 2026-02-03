/**
 * Upstash Vector storage layer for docs-chat RAG pipeline.
 * Stores document chunks with vector embeddings for semantic search.
 * Replaces LanceDB for serverless deployment compatibility.
 */
import { Index } from "@upstash/vector";

export interface DocsChunk {
  id: string;
  path: string;
  title: string;
  content: string;
  url: string;
  vector: number[];
}

export interface SearchResult {
  chunk: DocsChunk;
  distance: number;
  similarity: number;
}

interface ChunkMetadata {
  path: string;
  title: string;
  content: string;
  url: string;
  [key: string]: unknown; // Index signature for Upstash Dict compatibility
}

// Upstash Vector has a limit of 1000 vectors per upsert batch
const UPSERT_BATCH_SIZE = 1000;

export class DocsStore {
  private index: Index<ChunkMetadata>;

  constructor() {
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        "UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN are required",
      );
    }

    this.index = new Index<ChunkMetadata>({ url, token });
  }

  /**
   * Drop existing vectors and upsert new chunks.
   * Used during index rebuild.
   */
  async replaceAll(chunks: DocsChunk[]): Promise<void> {
    // Reset the index (delete all vectors)
    await this.index.reset();

    if (chunks.length === 0) {
      return;
    }

    // Upsert in batches to respect API limits
    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
      const vectors = batch.map((chunk) => ({
        id: chunk.id,
        vector: chunk.vector,
        metadata: {
          path: chunk.path,
          title: chunk.title,
          content: chunk.content,
          url: chunk.url,
        },
      }));

      await this.index.upsert(vectors);
      console.error(
        `Upserted batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / UPSERT_BATCH_SIZE)}`,
      );
    }
  }

  /**
   * Search for similar chunks using vector similarity.
   */
  async search(vector: number[], limit: number = 8): Promise<SearchResult[]> {
    const results = await this.index.query<ChunkMetadata>({
      vector,
      topK: limit,
      includeMetadata: true,
      includeVectors: false,
    });

    return results.map((result) => {
      // Upstash returns cosine similarity score (0-1, higher is more similar)
      const similarity = result.score;
      // Convert to distance for compatibility with existing code
      const distance = 1 - similarity;

      const metadata = result.metadata!;
      return {
        chunk: {
          id: result.id as string,
          path: metadata.path,
          title: metadata.title,
          content: metadata.content,
          url: metadata.url,
          vector: [], // Don't return vector to save memory
        },
        distance,
        similarity,
      };
    });
  }

  /**
   * Get count of stored chunks.
   */
  async count(): Promise<number> {
    const info = await this.index.info();
    return info.vectorCount;
  }
}
