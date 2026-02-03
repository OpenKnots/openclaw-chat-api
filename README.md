# OpenClaw Docs Agent API

![OpenClaw Docs Agent](public/og-image.png)

AI-powered documentation chatbot API for [OpenClaw](https://openclaw.ai), built by [OpenKnot](https://openknot.ai).

This powers the embedded docs agent that helps users navigate and understand OpenClaw's documentation through natural conversation.

## Overview

This API serves as the backend for OpenClaw's docs chat widget. It uses RAG (Retrieval-Augmented Generation) to:

1. Index OpenClaw documentation into a vector store
2. Retrieve relevant docs based on user questions
3. Stream AI-generated answers with context from the documentation

## Stack

- **Framework**: [Next.js](https://nextjs.org) 16 with Edge Runtime
- **Runtime**: [Bun](https://bun.sh)
- **Deployment**: [Vercel](https://vercel.com) Edge Functions
- **Vector Store**: [Upstash Vector](https://upstash.com/vector)
- **Rate Limiting**: [Upstash Redis](https://upstash.com/redis)
- **AI**: [OpenAI](https://openai.com) (gpt-4o-mini for chat, text-embedding-3-small for embeddings)
- **Language**: TypeScript

## API Endpoints

| Endpoint       | Method | Description                               |
| -------------- | ------ | ----------------------------------------- |
| `/api/chat`    | POST   | Send a question, get a streaming response |
| `/api/health`  | GET    | Health check                              |
| `/api/webhook` | POST   | GitHub docs webhook for re-indexing       |

### POST /api/chat

```json
{
  "message": "How do I get started with OpenClaw?"
}
```

Returns a streaming `text/plain` response with an AI-generated answer grounded in OpenClaw documentation.

**Rate Limit Headers:**

- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Requests remaining in window
- `X-RateLimit-Reset` - Timestamp when the limit resets

**CORS:** The API allows requests from configured origins. To add your domain, update the `ALLOWED_ORIGINS` array in `app/api/chat/route.ts`.

## Setup

1. Install dependencies:

```sh
bun install
```

2. Copy `.env.example` to `.env` and fill in your credentials:

```sh
cp .env.example .env
```

### Environment Variables

| Variable                    | Required | Description                              |
| --------------------------- | -------- | ---------------------------------------- |
| `OPENAI_API_KEY`            | Yes      | OpenAI API key                           |
| `UPSTASH_VECTOR_REST_URL`   | Yes      | Upstash Vector endpoint                  |
| `UPSTASH_VECTOR_REST_TOKEN` | Yes      | Upstash Vector auth token                |
| `UPSTASH_REDIS_REST_URL`    | Yes      | Upstash Redis endpoint (rate limiting)   |
| `UPSTASH_REDIS_REST_TOKEN`  | Yes      | Upstash Redis auth token                 |
| `GITHUB_WEBHOOK_SECRET`     | No       | Secret for GitHub webhook verification   |

3. Build the vector index (indexes documentation into Upstash):

```sh
bun run build:index
```

## Development

```sh
bun run dev
```

Runs locally at http://localhost:3000.

## Scripts

| Script               | Description                            |
| -------------------- | -------------------------------------- |
| `bun run dev`        | Start development server               |
| `bun run build`      | Build for production                   |
| `bun run start`      | Start production server                |
| `bun run lint`       | Run ESLint                             |
| `bun run build:index`| Index documentation into vector store  |
| `bun run deploy`     | Deploy to Vercel                       |

## Deploy

```sh
bun run deploy
```

Deploys to Vercel.

## License

MIT
