/**
 * Feedback Endpoint
 * Collects user feedback on chat responses for quality improvement.
 */
import { NextRequest } from "next/server";
import { getObservabilityService, type FeedbackEntry } from "@/rag/observability";

export const runtime = "edge";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://claw.openknot.ai",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle preflight requests
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function jsonResponse(data: object, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

const VALID_RATINGS = ["helpful", "not_helpful", "partial"] as const;
type Rating = typeof VALID_RATINGS[number];

export async function POST(request: NextRequest) {
  try {
    // Parse body
    let body: {
      queryId?: string;
      rating?: string;
      comment?: string;
    };

    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    // Validate queryId
    if (!body.queryId || typeof body.queryId !== "string") {
      return jsonResponse({ error: "queryId is required" }, 400);
    }

    // Validate rating
    if (!body.rating || !VALID_RATINGS.includes(body.rating as Rating)) {
      return jsonResponse(
        { error: `rating must be one of: ${VALID_RATINGS.join(", ")}` },
        400
      );
    }

    // Validate optional comment
    const comment = body.comment?.trim();
    if (comment && comment.length > 1000) {
      return jsonResponse({ error: "comment must be 1000 characters or less" }, 400);
    }

    // Record feedback
    const observability = getObservabilityService();
    
    const feedback: FeedbackEntry = {
      queryId: body.queryId,
      rating: body.rating as Rating,
      comment: comment || undefined,
      timestamp: Date.now(),
    };

    await observability.recordFeedback(feedback);

    return jsonResponse({
      success: true,
      message: "Feedback recorded",
      queryId: body.queryId,
    });
  } catch (error) {
    console.error("[Feedback Error]", error);
    return jsonResponse({ error: "Internal Server Error" }, 500);
  }
}
