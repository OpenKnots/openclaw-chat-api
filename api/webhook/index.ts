/**
 * GitHub Webhook Handler for docs updates.
 * Triggers re-indexing when docs.openclaw.ai main branch is updated.
 * 
 * Setup:
 * 1. Add GITHUB_WEBHOOK_SECRET to environment variables
 * 2. Create a webhook in your docs repo pointing to /api/webhook
 * 3. Select "push" events and set content type to application/json
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/vercel";
import { HTTPException } from "hono/http-exception";
import { indexDocs, verifyGitHubSignature, isMainBranchPush } from "../../rag/indexer.js";

const app = new Hono();

// CORS middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? [];
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin || allowedOrigins.length === 0) return origin ?? "*";
      return allowedOrigins.includes(origin) ? origin : null;
    },
  })
);

// Store indexing status
let indexingStatus = {
  isIndexing: false,
  lastIndexed: null as Date | null,
  lastResult: null as {
    success: boolean;
    pagesProcessed: number;
    chunksCreated: number;
    duration: number;
    errors: string[];
  } | null,
};

/**
 * GET /api/webhook - Status endpoint
 */
app.get("/", (c) => {
  return c.json({
    status: "ok",
    webhook: "GitHub docs update webhook",
    isIndexing: indexingStatus.isIndexing,
    lastIndexed: indexingStatus.lastIndexed?.toISOString() || null,
    lastResult: indexingStatus.lastResult,
  });
});

/**
 * POST /api/webhook - GitHub webhook handler
 */
app.post("/", async (c) => {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Verify webhook secret is configured
  if (!webhookSecret) {
    console.error("GITHUB_WEBHOOK_SECRET not configured");
    throw new HTTPException(500, {
      message: "Webhook not configured",
    });
  }

  // Get raw body for signature verification
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event") ?? null;
  const deliveryId = c.req.header("X-GitHub-Delivery");

  console.log(`Webhook received: event=${event}, delivery=${deliveryId}`);

  // Verify signature
  if (!await verifyGitHubSignature(rawBody, signature, webhookSecret)) {
    console.error("Invalid webhook signature");
    throw new HTTPException(401, {
      message: "Invalid signature",
    });
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, {
      message: "Invalid JSON payload",
    });
  }

  // Handle ping event (GitHub sends this when webhook is created)
  if (event === "ping") {
    console.log("Webhook ping received");
    return c.json({
      status: "ok",
      message: "Webhook configured successfully",
    });
  }

  // Check if this is a main branch push
  if (!isMainBranchPush(event, payload)) {
    console.log(`Ignoring event: ${event} (not a main branch push)`);
    return c.json({
      status: "ignored",
      message: "Not a main branch push event",
    });
  }

  // Prevent concurrent indexing
  if (indexingStatus.isIndexing) {
    console.log("Indexing already in progress, skipping");
    return c.json({
      status: "skipped",
      message: "Indexing already in progress",
    });
  }

  // Trigger indexing
  console.log("Starting documentation re-index...");
  indexingStatus.isIndexing = true;

  try {
    const result = await indexDocs();

    indexingStatus.lastIndexed = new Date();
    indexingStatus.lastResult = result;
    indexingStatus.isIndexing = false;

    if (result.success) {
      console.log(`Indexing complete: ${result.chunksCreated} chunks from ${result.pagesProcessed} pages`);
      return c.json({
        status: "success",
        message: "Documentation re-indexed successfully",
        result: {
          pagesProcessed: result.pagesProcessed,
          chunksCreated: result.chunksCreated,
          duration: result.duration,
        },
      });
    } else {
      console.error("Indexing failed:", result.errors);
      return c.json({
        status: "error",
        message: "Indexing failed",
        errors: result.errors,
      }, 500);
    }
  } catch (error) {
    indexingStatus.isIndexing = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Indexing error:", error);
    throw new HTTPException(500, {
      message: `Indexing failed: ${errorMessage}`,
    });
  }
});

// Use Edge Runtime for Web API Request compatibility with Hono
export const config = {
  runtime: 'edge',
};

// Export handlers for Vercel
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export default handler;
