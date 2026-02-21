/**
 * Documentation Indexer for OpenClaw docs.
 * Fetches documentation from docs.openclaw.ai/llms-full.txt,
 * chunks it, generates embeddings, and stores in Upstash Vector.
 * Also builds BM25 inverted index for keyword search.
 */
import { Embeddings } from "./embeddings";
import { DocsStore, DocsChunk } from "./store-upstash";
import { buildTermIndex, storeTermIndex } from "./bm25-searcher";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Web Crypto API helpers for Edge Runtime compatibility
async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBuffer = encoder.encode(key);
  const dataBuffer = encoder.encode(data);
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, dataBuffer);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

const DOCS_BASE_URL = "https://docs.openclaw.ai";
const LLMS_FULL_URL = `${DOCS_BASE_URL}/llms-full.txt`;
const SUPPLEMENTARY_DIR = join(process.cwd(), "docs");

interface DocPage {
  url: string;
  path: string;
  title: string;
  content: string;
}

interface IndexResult {
  success: boolean;
  pagesProcessed: number;
  chunksCreated: number;
  uniqueTerms: number;
  errors: string[];
  duration: number;
}

/**
 * Fetches and parses llms-full.txt which contains all documentation.
 * The format is markdown with sections separated by "# title" headers
 * and "Source: URL" lines.
 */
async function fetchDocsFromLlmsTxt(): Promise<DocPage[]> {
  console.log(`Fetching documentation from ${LLMS_FULL_URL}...`);

  const response = await fetch(LLMS_FULL_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch llms-full.txt: ${response.status}`);
  }

  const content = await response.text();
  const pages: DocPage[] = [];

  // Split by top-level headers (# title)
  // The format is:
  // # Title
  // Source: https://docs.openclaw.ai/path
  // 
  // Content...
  const sections = content.split(/\n(?=# [^\n]+\nSource:)/);

  for (const section of sections) {
    if (!section.trim()) continue;

    // Extract title (first line starting with #)
    const titleMatch = section.match(/^# ([^\n]+)/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();

    // Extract source URL
    const sourceMatch = section.match(/\nSource: (https?:\/\/[^\n]+)/);
    if (!sourceMatch) continue;
    const url = sourceMatch[1].trim();

    // Extract path from URL
    const urlObj = new URL(url);
    const path = urlObj.pathname;

    // Extract content (everything after the Source line)
    const contentStart = section.indexOf("\n", section.indexOf("Source:"));
    if (contentStart === -1) continue;

    let pageContent = section.slice(contentStart).trim();

    // Clean up markdown content
    pageContent = cleanMarkdown(pageContent);

    // Skip empty or very short content
    if (pageContent.length < 50) {
      console.warn(`Skipping ${title}: content too short (${pageContent.length} chars)`);
      continue;
    }

    pages.push({ url, path, title, content: pageContent });
  }

  console.log(`Parsed ${pages.length} documentation pages from llms-full.txt`);
  return pages;
}

/**
 * Loads supplementary knowledge base files from the local docs/ directory.
 * Files use the same format as llms-full.txt (# Title / Source: URL / content).
 */
function loadSupplementaryDocs(): DocPage[] {
  const pages: DocPage[] = [];

  let files: string[];
  try {
    files = readdirSync(SUPPLEMENTARY_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return pages;
  }

  for (const file of files) {
    const content = readFileSync(join(SUPPLEMENTARY_DIR, file), "utf-8");
    const sections = content.split(/\n(?=# [^\n]+\nSource:)/);

    for (const section of sections) {
      if (!section.trim()) continue;

      const titleMatch = section.match(/^# ([^\n]+)/);
      if (!titleMatch) continue;
      const title = titleMatch[1].trim();

      const sourceMatch = section.match(/\nSource: (https?:\/\/[^\n]+)/);
      if (!sourceMatch) continue;
      const url = sourceMatch[1].trim();

      const urlObj = new URL(url);
      const path = urlObj.pathname;

      const contentStart = section.indexOf("\n", section.indexOf("Source:"));
      if (contentStart === -1) continue;

      let pageContent = section.slice(contentStart).trim();
      pageContent = cleanMarkdown(pageContent);

      if (pageContent.length < 50) continue;

      pages.push({ url, path, title, content: pageContent });
    }
  }

  if (pages.length > 0) {
    console.log(`Loaded ${pages.length} supplementary knowledge pages from ${files.length} file(s)`);
  }

  return pages;
}

/**
 * Cleans up markdown content for embedding.
 */
function cleanMarkdown(markdown: string): string {
  return markdown
    // Remove code fence language identifiers
    .replace(/```\w+\s*/g, "```\n")
    // Remove excessive newlines
    .replace(/\n{3,}/g, "\n\n")
    // Normalize whitespace
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Splits content into chunks suitable for embedding.
 * Uses a sliding window approach with overlap for context.
 */
async function chunkContent(
  page: DocPage,
  chunkSize: number = 1000,
  overlap: number = 200
): Promise<DocsChunk[]> {
  const chunks: DocsChunk[] = [];
  const content = page.content;

  if (content.length <= chunkSize) {
    // Single chunk for short content
    chunks.push({
      id: await generateChunkId(page.url, 0),
      path: page.path,
      title: page.title,
      content: content,
      url: page.url,
      vector: [], // Will be filled by embeddings
    });
    return chunks;
  }

  // Split into overlapping chunks
  let start = 0;
  let chunkIndex = 0;

  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length);

    // Try to break at sentence or paragraph boundary
    if (end < content.length) {
      const breakPoints = [". ", ".\n", "\n\n", "\n", " "];
      for (const bp of breakPoints) {
        const lastBreak = content.lastIndexOf(bp, end);
        if (lastBreak > start + chunkSize / 2) {
          end = lastBreak + bp.length;
          break;
        }
      }
    }

    const chunkText = content.slice(start, end).trim();

    if (chunkText.length > 50) {
      chunks.push({
        id: await generateChunkId(page.url, chunkIndex),
        path: page.path,
        title: `${page.title}${chunkIndex > 0 ? ` (Part ${chunkIndex + 1})` : ""}`,
        content: chunkText,
        url: page.url,
        vector: [],
      });
      chunkIndex++;
    }

    start = end - overlap;
    if (start >= content.length - overlap) break;
  }

  return chunks;
}

/**
 * Generates a deterministic chunk ID based on URL and position.
 */
async function generateChunkId(url: string, index: number): Promise<string> {
  const hash = await sha256Hex(`${url}:${index}`);
  return hash.slice(0, 16);
}

/**
 * Main indexing function.
 * Fetches all docs, chunks them, generates embeddings, and stores in vector DB.
 */
export async function indexDocs(): Promise<IndexResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  console.log("Starting documentation indexing...");

  // Validate environment
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      pagesProcessed: 0,
      chunksCreated: 0,
      uniqueTerms: 0,
      errors: ["OPENAI_API_KEY is required"],
      duration: Date.now() - startTime,
    };
  }

  try {
    // Initialize components
    const embeddings = new Embeddings(apiKey);
    const store = new DocsStore();

    // Fetch documentation from llms-full.txt
    const pages = await fetchDocsFromLlmsTxt();

    if (pages.length === 0) {
      return {
        success: false,
        pagesProcessed: 0,
        chunksCreated: 0,
        uniqueTerms: 0,
        errors: ["No documentation pages could be fetched from llms-full.txt"],
        duration: Date.now() - startTime,
      };
    }


    // Merge supplementary knowledge base (local docs/ directory)
    const supplementary = loadSupplementaryDocs();
    pages.push(...supplementary);

    console.log(`Fetched ${pages.length - supplementary.length} documentation pages + ${supplementary.length} supplementary pages`);

    // Chunk all pages
    console.log("Chunking content...");
    const allChunks: DocsChunk[] = [];
    for (const page of pages) {
      const chunks = await chunkContent(page);
      allChunks.push(...chunks);
    }
    console.log(`Created ${allChunks.length} chunks from ${pages.length} pages`);

    // Generate embeddings in batches
    console.log("Generating embeddings...");
    const texts = allChunks.map((chunk) => chunk.content);
    const vectors = await embeddings.embedBatch(texts);

    // Attach vectors to chunks
    for (let i = 0; i < allChunks.length; i++) {
      allChunks[i].vector = vectors[i];
    }

    // Store in vector database
    console.log("Storing in vector database...");
    await store.replaceAll(allChunks);

    // Build and store BM25 index for keyword search
    console.log("Building BM25 index...");
    const termIndex = buildTermIndex(
      allChunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        title: chunk.title,
      }))
    );
    await storeTermIndex(termIndex);
    console.log(
      `BM25 index built with ${termIndex.totalDocs} documents and ${termIndex.terms.size} unique terms`
    );

    const duration = Date.now() - startTime;
    console.log(`Indexing complete in ${duration}ms`);

    return {
      success: true,
      pagesProcessed: pages.length,
      chunksCreated: allChunks.length,
      uniqueTerms: termIndex.terms.size,
      errors,
      duration,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(errorMessage);
    console.error("Indexing failed:", error);

    return {
      success: false,
      pagesProcessed: 0,
      chunksCreated: 0,
      uniqueTerms: 0,
      errors,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Verifies GitHub webhook signature.
 */
export async function verifyGitHubSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  try {
    const expectedSignature = `sha256=${await hmacSha256Hex(secret, payload)}`;
    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(signature, expectedSignature);
  } catch {
    return false;
  }
}

/**
 * Parses GitHub push event to determine if it's a main branch update.
 */
export function isMainBranchPush(event: string | null, payload: unknown): boolean {
  if (event !== "push") return false;

  const data = payload as { ref?: string };
  return data.ref === "refs/heads/main" || data.ref === "refs/heads/master";
}
