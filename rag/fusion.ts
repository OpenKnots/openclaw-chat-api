/**
 * Score Fusion for docs-chat RAG pipeline.
 * Combines results from multiple retrieval strategies using Reciprocal Rank Fusion (RRF).
 */
import type { RetrievalResult } from "./retriever-upstash";
import type { BM25Result } from "./bm25-searcher";
import type { DocsChunk } from "./store-upstash";

export interface FusedResult {
  id: string;
  chunk: Omit<DocsChunk, "vector">;
  semanticRank: number | null;
  semanticScore: number | null;
  keywordRank: number | null;
  keywordScore: number | null;
  fusedScore: number;
}

// RRF constant - controls how much to penalize lower ranks
// Higher k = more equal weighting; lower k = more emphasis on top ranks
const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion (RRF) to combine multiple result lists.
 * 
 * Formula: RRF(d) = Σ 1/(k + rank(d)) for each list containing d
 * 
 * This method is robust because:
 * - Doesn't require score normalization
 * - Works well with different scoring systems
 * - Naturally handles missing documents in some lists
 */
export function reciprocalRankFusion(
  semanticResults: RetrievalResult[],
  keywordResults: BM25Result[],
  chunks: Map<string, Omit<DocsChunk, "vector">>,
  k: number = DEFAULT_RRF_K
): FusedResult[] {
  const fusedScores = new Map<string, {
    semanticRank: number | null;
    semanticScore: number | null;
    keywordRank: number | null;
    keywordScore: number | null;
    rrfScore: number;
  }>();

  // Process semantic results
  semanticResults.forEach((result, index) => {
    const rank = index + 1;
    const rrfContribution = 1 / (k + rank);
    
    const existing = fusedScores.get(result.chunk.id);
    if (existing) {
      existing.semanticRank = rank;
      existing.semanticScore = result.score;
      existing.rrfScore += rrfContribution;
    } else {
      fusedScores.set(result.chunk.id, {
        semanticRank: rank,
        semanticScore: result.score,
        keywordRank: null,
        keywordScore: null,
        rrfScore: rrfContribution,
      });
    }
  });

  // Process keyword results
  keywordResults.forEach((result, index) => {
    const rank = index + 1;
    const rrfContribution = 1 / (k + rank);
    
    const existing = fusedScores.get(result.id);
    if (existing) {
      existing.keywordRank = rank;
      existing.keywordScore = result.score;
      existing.rrfScore += rrfContribution;
    } else {
      fusedScores.set(result.id, {
        semanticRank: null,
        semanticScore: null,
        keywordRank: rank,
        keywordScore: result.score,
        rrfScore: rrfContribution,
      });
    }
  });

  // Build final results with chunk data
  const results: FusedResult[] = [];
  
  for (const [id, scores] of fusedScores) {
    // Get chunk from semantic results or chunk map
    let chunk = semanticResults.find(r => r.chunk.id === id)?.chunk;
    
    if (!chunk) {
      chunk = chunks.get(id);
    }

    if (!chunk) {
      // Skip if we can't find the chunk (shouldn't happen in normal operation)
      console.warn(`Chunk not found for id: ${id}`);
      continue;
    }

    results.push({
      id,
      chunk: {
        id: chunk.id,
        path: chunk.path,
        title: chunk.title,
        content: chunk.content,
        url: chunk.url,
      },
      semanticRank: scores.semanticRank,
      semanticScore: scores.semanticScore,
      keywordRank: scores.keywordRank,
      keywordScore: scores.keywordScore,
      fusedScore: scores.rrfScore,
    });
  }

  // Sort by fused score (descending)
  results.sort((a, b) => b.fusedScore - a.fusedScore);

  return results;
}

/**
 * Weighted score fusion as an alternative to RRF.
 * Useful when you have calibrated scores from both systems.
 */
export function weightedScoreFusion(
  semanticResults: RetrievalResult[],
  keywordResults: BM25Result[],
  chunks: Map<string, Omit<DocsChunk, "vector">>,
  semanticWeight: number = 0.7,
  keywordWeight: number = 0.3
): FusedResult[] {
  // Normalize scores to 0-1 range
  const normalizedSemantic = normalizeScores(
    semanticResults.map(r => ({ id: r.chunk.id, score: r.score }))
  );
  const normalizedKeyword = normalizeScores(keywordResults);

  const fusedScores = new Map<string, {
    semanticRank: number | null;
    semanticScore: number | null;
    keywordRank: number | null;
    keywordScore: number | null;
    weightedScore: number;
  }>();

  // Process semantic results
  normalizedSemantic.forEach(({ id, score }, index) => {
    fusedScores.set(id, {
      semanticRank: index + 1,
      semanticScore: score,
      keywordRank: null,
      keywordScore: null,
      weightedScore: score * semanticWeight,
    });
  });

  // Process keyword results
  normalizedKeyword.forEach(({ id, score }, index) => {
    const existing = fusedScores.get(id);
    if (existing) {
      existing.keywordRank = index + 1;
      existing.keywordScore = score;
      existing.weightedScore += score * keywordWeight;
    } else {
      fusedScores.set(id, {
        semanticRank: null,
        semanticScore: null,
        keywordRank: index + 1,
        keywordScore: score,
        weightedScore: score * keywordWeight,
      });
    }
  });

  // Build final results
  const results: FusedResult[] = [];
  
  for (const [id, scores] of fusedScores) {
    let chunk = semanticResults.find(r => r.chunk.id === id)?.chunk;
    if (!chunk) {
      chunk = chunks.get(id);
    }
    if (!chunk) continue;

    results.push({
      id,
      chunk: {
        id: chunk.id,
        path: chunk.path,
        title: chunk.title,
        content: chunk.content,
        url: chunk.url,
      },
      semanticRank: scores.semanticRank,
      semanticScore: scores.semanticScore,
      keywordRank: scores.keywordRank,
      keywordScore: scores.keywordScore,
      fusedScore: scores.weightedScore,
    });
  }

  results.sort((a, b) => b.fusedScore - a.fusedScore);
  return results;
}

/**
 * Normalize scores to 0-1 range using min-max normalization.
 */
function normalizeScores(
  results: Array<{ id: string; score: number }>
): Array<{ id: string; score: number }> {
  if (results.length === 0) return [];
  if (results.length === 1) return [{ id: results[0].id, score: 1 }];

  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  if (range === 0) {
    return results.map(r => ({ id: r.id, score: 1 }));
  }

  return results.map(r => ({
    id: r.id,
    score: (r.score - minScore) / range,
  }));
}

/**
 * Simple deduplication utility.
 */
export function deduplicateResults(results: FusedResult[]): FusedResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}
