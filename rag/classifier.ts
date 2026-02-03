/**
 * Query Understanding Layer for docs-chat RAG pipeline.
 * Classifies query intent, expands queries, and extracts keywords.
 */

export type QueryIntent = "lookup" | "conceptual" | "troubleshooting" | "comparison";
export type RetrievalStrategy = "semantic" | "keyword" | "hybrid";

export interface ClassifiedQuery {
  original: string;
  expanded: string;
  intent: QueryIntent;
  strategy: RetrievalStrategy;
  keywords: string[];
}

// Patterns for intent detection
const LOOKUP_PATTERNS = [
  /`[^`]+`/,                                    // backticks (code refs)
  /\.(ts|tsx|js|jsx|py|rs|go|md)\b/i,          // file extensions
  /\b(function|class|const|var|let|type|interface)\s+\w+/i,
  /\b(find|where is|show me|locate)\b.*\b(file|function|class|method|config)\b/i,
  /error\s*(code|:)?\s*\d+/i,                   // error codes
  /\b(api|endpoint|route|path)\s*[:=]?\s*[\/\w]+/i,
];

const CONCEPTUAL_PATTERNS = [
  /^(how|what|why|when|explain|describe)\b/i,
  /\b(overview|introduction|getting started|basics)\b/i,
  /\b(understand|learn|concept|idea)\b/i,
];

const TROUBLESHOOTING_PATTERNS = [
  /\b(error|bug|issue|problem|fail|broken|not working|doesn't work)\b/i,
  /\b(fix|solve|resolve|debug|troubleshoot)\b/i,
  /\b(help|stuck|can't|cannot|unable)\b/i,
];

const COMPARISON_PATTERNS = [
  /\b(vs|versus|compared to|difference between|or)\b/i,
  /\b(better|best|recommend|should i use|which)\b/i,
  /\b(pros|cons|advantages|disadvantages)\b/i,
];

// Domain-specific synonyms for query expansion
const SYNONYMS: Record<string, string[]> = {
  "auth": ["authentication", "login", "sign in", "credentials"],
  "config": ["configuration", "settings", "options", "setup"],
  "api": ["endpoint", "route", "interface"],
  "db": ["database", "storage", "data"],
  "env": ["environment", "variables", "secrets"],
  "deploy": ["deployment", "hosting", "publish"],
  "err": ["error", "exception", "failure"],
};

// Stop words to filter from keywords
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "just",
  "and", "but", "if", "or", "because", "until", "while", "it",
  "this", "that", "these", "those", "i", "me", "my", "we", "you",
]);

/**
 * Classifies a query and determines optimal retrieval strategy.
 */
export function classifyQuery(query: string): ClassifiedQuery {
  const intent = detectIntent(query);
  const strategy = determineStrategy(query, intent);
  const keywords = extractKeywords(query);
  const expanded = expandQuery(query);

  return {
    original: query,
    expanded,
    intent,
    strategy,
    keywords,
  };
}

/**
 * Detects the intent of the query.
 */
function detectIntent(query: string): QueryIntent {
  // Check patterns in order of specificity
  if (TROUBLESHOOTING_PATTERNS.some(p => p.test(query))) {
    return "troubleshooting";
  }
  if (COMPARISON_PATTERNS.some(p => p.test(query))) {
    return "comparison";
  }
  if (LOOKUP_PATTERNS.some(p => p.test(query))) {
    return "lookup";
  }
  if (CONCEPTUAL_PATTERNS.some(p => p.test(query))) {
    return "conceptual";
  }

  // Default based on query length - short queries are usually lookups
  return query.split(/\s+/).length <= 3 ? "lookup" : "conceptual";
}

/**
 * Determines the optimal retrieval strategy based on query and intent.
 */
function determineStrategy(query: string, intent: QueryIntent): RetrievalStrategy {
  // Lookup queries benefit from keyword matching
  if (intent === "lookup") {
    // Check if it has specific code references
    const hasCodeRefs = /`[^`]+`/.test(query) || /\b(function|class|const)\s+\w+/i.test(query);
    return hasCodeRefs ? "keyword" : "hybrid";
  }

  // Conceptual and comparison queries benefit from semantic search
  if (intent === "conceptual" || intent === "comparison") {
    return "semantic";
  }

  // Troubleshooting needs both - error messages + context
  if (intent === "troubleshooting") {
    return "hybrid";
  }

  return "hybrid";
}

/**
 * Extracts keywords from the query for BM25 search.
 */
function extractKeywords(query: string): string[] {
  // Extract code references in backticks
  const codeRefs: string[] = [];
  const backtickMatches = query.match(/`([^`]+)`/g);
  if (backtickMatches) {
    codeRefs.push(...backtickMatches.map(m => m.replace(/`/g, "")));
  }

  // Tokenize and filter
  const words = query
    .toLowerCase()
    .replace(/[^\w\s\-_]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Combine code refs (high priority) with filtered words
  const allKeywords = [...codeRefs, ...words];

  // Deduplicate while preserving order
  return [...new Set(allKeywords)];
}

/**
 * Expands the query with synonyms for better semantic matching.
 */
function expandQuery(query: string): string {
  let expanded = query;

  // Add synonyms for known abbreviations
  for (const [abbrev, synonyms] of Object.entries(SYNONYMS)) {
    const pattern = new RegExp(`\\b${abbrev}\\b`, "gi");
    if (pattern.test(query)) {
      // Add the primary synonym to expand meaning
      expanded += ` ${synonyms[0]}`;
    }
  }

  return expanded.trim();
}

/**
 * Utility: Check if a query is likely about a specific file or function.
 */
export function isSpecificLookup(query: string): boolean {
  return LOOKUP_PATTERNS.some(p => p.test(query));
}

/**
 * Utility: Check if a query needs troubleshooting context.
 */
export function isTroubleshootingQuery(query: string): boolean {
  return TROUBLESHOOTING_PATTERNS.some(p => p.test(query));
}
