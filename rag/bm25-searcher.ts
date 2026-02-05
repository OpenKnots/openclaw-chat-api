/**
 * BM25 (Okapi BM25) Keyword Search for docs-chat RAG pipeline.
 * Implements the classic probabilistic retrieval model for exact term matching.
 */
import { Redis } from "@upstash/redis";

export interface TermPosting {
  id: string;
  freq: number;
  positions: number[];
}

export interface TermIndex {
  terms: Map<string, TermPosting[]>;
  docLengths: Map<string, number>;
  avgDocLength: number;
  totalDocs: number;
}

export interface BM25Result {
  id: string;
  score: number;
}

// BM25 parameters (tuned for documentation)
const DEFAULT_K1 = 1.5;  // Term frequency saturation
const DEFAULT_B = 0.75;  // Length normalization

// Stop words to filter during tokenization
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "and", "but", "if", "or", "because", "until", "while", "it", "this",
  "that", "these", "those", "i", "me", "my", "we", "you", "your",
]);

/**
 * BM25 Searcher for keyword-based retrieval.
 */
export class BM25Searcher {
  private index: TermIndex;
  private k1: number;
  private b: number;

  constructor(index: TermIndex, k1: number = DEFAULT_K1, b: number = DEFAULT_B) {
    this.index = index;
    this.k1 = k1;
    this.b = b;
  }

  /**
   * Search for documents matching the query terms.
   */
  search(query: string, limit: number = 20): BM25Result[] {
    const tokens = this.tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    const scores = new Map<string, number>();
    const N = this.index.totalDocs;
    const avgDL = this.index.avgDocLength;

    for (const token of tokens) {
      const postings = this.index.terms.get(token);
      if (!postings || postings.length === 0) {
        continue;
      }

      // IDF: Inverse Document Frequency
      const df = postings.length;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const posting of postings) {
        const docLength = this.index.docLengths.get(posting.id) || avgDL;

        // TF component with length normalization
        const tf = posting.freq;
        const tfNorm = (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (docLength / avgDL)));

        const termScore = idf * tfNorm;
        scores.set(posting.id, (scores.get(posting.id) || 0) + termScore);
      }
    }

    // Sort by score and return top-k
    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search for documents containing an exact phrase.
   * Uses position data for proximity matching.
   */
  searchPhrase(phrase: string, limit: number = 20): BM25Result[] {
    const tokens = this.tokenize(phrase);
    if (tokens.length < 2) {
      return this.search(phrase, limit);
    }

    // Find documents containing all tokens
    const candidateDocs = this.findDocsWithAllTokens(tokens);
    if (candidateDocs.length === 0) {
      // Fall back to regular search if no exact matches
      return this.search(phrase, limit);
    }

    const scores = new Map<string, number>();

    for (const docId of candidateDocs) {
      const phraseScore = this.calculatePhraseScore(docId, tokens);
      if (phraseScore > 0) {
        scores.set(docId, phraseScore);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Find documents containing all query tokens.
   */
  private findDocsWithAllTokens(tokens: string[]): string[] {
    if (tokens.length === 0) return [];

    // Start with docs containing the first token
    const firstPostings = this.index.terms.get(tokens[0]);
    if (!firstPostings) return [];

    let candidateDocs = new Set(firstPostings.map(p => p.id));

    // Intersect with docs containing subsequent tokens
    for (let i = 1; i < tokens.length; i++) {
      const postings = this.index.terms.get(tokens[i]);
      if (!postings) return [];

      const docsWithToken = new Set(postings.map(p => p.id));
      candidateDocs = new Set([...candidateDocs].filter(d => docsWithToken.has(d)));

      if (candidateDocs.size === 0) return [];
    }

    return Array.from(candidateDocs);
  }

  /**
   * Calculate phrase proximity score for a document.
   */
  private calculatePhraseScore(docId: string, tokens: string[]): number {
    // Get positions for each token in this document
    const tokenPositions: number[][] = [];

    for (const token of tokens) {
      const postings = this.index.terms.get(token);
      const posting = postings?.find(p => p.id === docId);
      if (!posting || posting.positions.length === 0) {
        return 0;
      }
      tokenPositions.push(posting.positions);
    }

    // Find minimum span containing all tokens in order
    let minSpan = Infinity;

    // Simple approach: for each position of first token, find closest sequence
    for (const firstPos of tokenPositions[0]) {
      let currentPos = firstPos;
      let valid = true;

      for (let i = 1; i < tokenPositions.length; i++) {
        // Find next position after currentPos for token i
        const nextPos = tokenPositions[i].find(p => p > currentPos);
        if (nextPos === undefined) {
          valid = false;
          break;
        }
        currentPos = nextPos;
      }

      if (valid) {
        const span = currentPos - firstPos;
        minSpan = Math.min(minSpan, span);
      }
    }

    if (minSpan === Infinity) {
      // No valid sequence found, but all tokens are present
      // Give a lower score based on regular BM25
      return this.search(tokens.join(" "), 1)[0]?.score * 0.5 || 0;
    }

    // Score inversely proportional to span (tighter = better)
    // Exact phrase (span = tokens.length - 1) gets max score
    const idealSpan = tokens.length - 1;
    const spanPenalty = idealSpan / (minSpan + 1);

    // Base BM25 score multiplied by proximity boost
    const baseScore = this.search(tokens.join(" "), 1)[0]?.score || 0;
    return baseScore * (1 + spanPenalty);
  }

  /**
   * Tokenize text into searchable terms.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\-_]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }
}

/**
 * Build a BM25 term index from document chunks.
 */
export function buildTermIndex(
  chunks: Array<{ id: string; content: string; title: string }>
): TermIndex {
  const terms = new Map<string, TermPosting[]>();
  const docLengths = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const text = `${chunk.title} ${chunk.content}`.toLowerCase();
    const tokens = text
      .replace(/[^\w\s\-_]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));

    docLengths.set(chunk.id, tokens.length);
    totalLength += tokens.length;

    // Build term frequencies and positions
    const termFreqs = new Map<string, { freq: number; positions: number[] }>();

    tokens.forEach((token, position) => {
      const existing = termFreqs.get(token);
      if (existing) {
        existing.freq++;
        existing.positions.push(position);
      } else {
        termFreqs.set(token, { freq: 1, positions: [position] });
      }
    });

    // Add to global index
    for (const [token, data] of termFreqs) {
      const postings = terms.get(token) || [];
      postings.push({
        id: chunk.id,
        freq: data.freq,
        positions: data.positions,
      });
      terms.set(token, postings);
    }
  }

  return {
    terms,
    docLengths,
    avgDocLength: chunks.length > 0 ? totalLength / chunks.length : 0,
    totalDocs: chunks.length,
  };
}

/**
 * Serialize term index for storage in Upstash KV.
 */
export function serializeTermIndex(index: TermIndex): string {
  return JSON.stringify({
    terms: Array.from(index.terms.entries()),
    docLengths: Array.from(index.docLengths.entries()),
    avgDocLength: index.avgDocLength,
    totalDocs: index.totalDocs,
  });
}

/**
 * Deserialize term index from Upstash KV storage.
 * Handles both string (needs parsing) and object (already parsed by Upstash) inputs.
 */
export function deserializeTermIndex(data: string | object): TermIndex {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return {
    terms: new Map(parsed.terms),
    docLengths: new Map(parsed.docLengths),
    avgDocLength: parsed.avgDocLength,
    totalDocs: parsed.totalDocs,
  };
}

/**
 * Store term index in Upstash Redis.
 */
export async function storeTermIndex(index: TermIndex): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn("Upstash Redis not configured, skipping BM25 index storage");
    return;
  }

  const redis = new Redis({ url, token });
  const serialized = serializeTermIndex(index);

  await redis.set("bm25:index", serialized);
  console.log(`Stored BM25 index with ${index.totalDocs} documents and ${index.terms.size} unique terms`);
}

/**
 * Load term index from Upstash Redis.
 */
export async function loadTermIndex(): Promise<TermIndex | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  const redis = new Redis({ url, token });
  // Upstash may return parsed JSON object or string depending on how it was stored
  const data = await redis.get<string | object>("bm25:index");

  if (!data) {
    return null;
  }

  return deserializeTermIndex(data);
}
