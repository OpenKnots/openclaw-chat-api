/**
 * Documentation Indexer for OpenClaw docs.
 * Fetches documentation from docs.openclaw.ai/llms-full.txt,
 * chunks it, generates embeddings, and stores in Upstash Vector.
 */
import { Embeddings } from "./embeddings.js";
import { DocsStore, DocsChunk } from "./store-upstash.js";
import crypto from "crypto";

const DOCS_BASE_URL = "https://docs.openclaw.ai";
const LLMS_FULL_URL = `${DOCS_BASE_URL}/llms-full.txt`;

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
function chunkContent(
  page: DocPage,
  chunkSize: number = 1000,
  overlap: number = 200
): DocsChunk[] {
  const chunks: DocsChunk[] = [];
  const content = page.content;

  if (content.length <= chunkSize) {
    // Single chunk for short content
    chunks.push({
      id: generateChunkId(page.url, 0),
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

    const chunkContent = content.slice(start, end).trim();

    if (chunkContent.length > 50) {
      chunks.push({
        id: generateChunkId(page.url, chunkIndex),
        path: page.path,
        title: `${page.title}${chunkIndex > 0 ? ` (Part ${chunkIndex + 1})` : ""}`,
        content: chunkContent,
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
function generateChunkId(url: string, index: number): string {
  const hash = crypto.createHash("sha256").update(`${url}:${index}`).digest("hex");
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
        errors: ["No documentation pages could be fetched from llms-full.txt"],
        duration: Date.now() - startTime,
      };
    }

    console.log(`Fetched ${pages.length} documentation pages`);

    // Chunk all pages
    console.log("Chunking content...");
    const allChunks: DocsChunk[] = [];
    for (const page of pages) {
      const chunks = chunkContent(page);
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

    const duration = Date.now() - startTime;
    console.log(`Indexing complete in ${duration}ms`);

    return {
      success: true,
      pagesProcessed: pages.length,
      chunksCreated: allChunks.length,
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
      errors,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Verifies GitHub webhook signature.
 */
export function verifyGitHubSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuffer = new Uint8Array(Buffer.from(signature));
    const expectedBuffer = new Uint8Array(Buffer.from(expectedSignature));

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
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
