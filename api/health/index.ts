/**
 * Health Check Endpoint
 * Returns system status and vector store stats.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/vercel";
import { DocsStore } from "../../rag/store-upstash.js";

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

/**
 * GET /api/health - Health check endpoint
 */
app.get("/", async (c) => {
  try {
    const store = new DocsStore();
    const count = await store.count();
    return c.json({ ok: true, chunks: count, mode: "upstash-vector" });
  } catch (err) {
    console.error("Health check error:", err);
    return c.json(
      { ok: false, error: "Failed to connect to vector store" },
      500
    );
  }
});

// Use Edge Runtime for Web API Request compatibility with Hono
export const config = {
  runtime: 'edge',
};

// Export handlers for Vercel
const handler = handle(app);
export const GET = handler;
export default handler;
