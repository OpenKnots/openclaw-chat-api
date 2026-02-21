/**
 * GitHub Webhook Handler for docs updates.
 * Triggers re-indexing when docs.openclaw.ai main branch is updated.
 * 
 * Setup:
 * 1. Add GITHUB_WEBHOOK_SECRET to environment variables
 * 2. Create a webhook in your docs repo pointing to /api/webhook
 * 3. Select "push" events and set content type to application/json
 */
import { NextRequest, NextResponse } from "next/server";
import { indexDocs, verifyGitHubSignature, isMainBranchPush } from "@/rag/indexer";

export const runtime = "nodejs";

// Store indexing status (note: in edge runtime, this won't persist across invocations)
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
export async function GET() {
  return NextResponse.json({
    status: "ok",
    webhook: "GitHub docs update webhook",
    isIndexing: indexingStatus.isIndexing,
    lastIndexed: indexingStatus.lastIndexed?.toISOString() || null,
    lastResult: indexingStatus.lastResult,
  });
}

/**
 * POST /api/webhook - GitHub webhook handler
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Verify webhook secret is configured
  if (!webhookSecret) {
    console.error("GITHUB_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook not configured", status: 500 },
      { status: 500 }
    );
  }

  // Get raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256");
  const event = request.headers.get("X-GitHub-Event");
  const deliveryId = request.headers.get("X-GitHub-Delivery");

  console.log(`Webhook received: event=${event}, delivery=${deliveryId}`);

  // Verify signature
  if (!await verifyGitHubSignature(rawBody, signature, webhookSecret)) {
    console.error("Invalid webhook signature");
    return NextResponse.json(
      { error: "Invalid signature", status: 401 },
      { status: 401 }
    );
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload", status: 400 },
      { status: 400 }
    );
  }

  // Handle ping event (GitHub sends this when webhook is created)
  if (event === "ping") {
    console.log("Webhook ping received");
    return NextResponse.json({
      status: "ok",
      message: "Webhook configured successfully",
    });
  }

  // Check if this is a main branch push
  if (!isMainBranchPush(event, payload)) {
    console.log(`Ignoring event: ${event} (not a main branch push)`);
    return NextResponse.json({
      status: "ignored",
      message: "Not a main branch push event",
    });
  }

  // Prevent concurrent indexing
  if (indexingStatus.isIndexing) {
    console.log("Indexing already in progress, skipping");
    return NextResponse.json({
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
      return NextResponse.json({
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
      return NextResponse.json(
        {
          status: "error",
          message: "Indexing failed",
          errors: result.errors,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    indexingStatus.isIndexing = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Indexing error:", error);
    return NextResponse.json(
      { error: `Indexing failed: ${errorMessage}`, status: 500 },
      { status: 500 }
    );
  }
}
