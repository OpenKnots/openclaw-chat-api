/**
 * Health Check Endpoint
 * Returns system status and vector store stats.
 */
import { NextResponse } from "next/server";
import { DocsStore } from "@/rag/store-upstash";

export const runtime = "edge";

export async function GET() {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return NextResponse.json({ ok: true, chunks: count, mode: "upstash-vector" });
  } catch (err) {
    console.error("Health check error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to connect to vector store" },
      { status: 500 }
    );
  }
}
