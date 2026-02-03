# OpenClaw Docs Agent API

![OpenClaw Docs Agent](public/og-image.png)

AI-powered documentation chatbot API for [OpenClaw](https://openclaw.ai) and threaded by [OpenKnot](https://openknot.ai). 

This powers the embedded docs agent that helps users navigate and understand OpenClaw's documentation through natural conversation.

## Overview

This API serves as the backend for OpenClaw's docs chat widget. It uses RAG (Retrieval-Augmented Generation) to:

1. Index OpenClaw documentation into a vector store
2. Retrieve relevant docs based on user questions
3. Stream AI-generated answers with context from the documentation

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Deployment**: [Vercel](https://vercel.com) serverless functions
- **Vector Store**: [Upstash Vector](https://upstash.com/vector)
- **AI**: [OpenAI](https://openai.com) (gpt-4o-mini for chat, text-embedding-3-small for embeddings)
- **Language**: TypeScript

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send a question, get a streaming response |
| `/api/health` | GET | Health check |
| `/api/webhook` | POST | GitHub docs webhook for re-indexing |

### POST /api/chat

```json
{
  "message": "How do I get started with OpenClaw?"
}
```

Returns a streaming `text/plain` response with an AI-generated answer grounded in OpenClaw documentation.

## Setup

1. Install dependencies:

```sh
bun install
```

2. Copy `.env.example` to `.env` and fill in your credentials:

```sh
cp .env.example .env
```

Required environment variables:

- `OPENAI_API_KEY` - OpenAI API key
- `UPSTASH_VECTOR_REST_URL` - Upstash Vector endpoint
- `UPSTASH_VECTOR_REST_TOKEN` - Upstash Vector auth token

3. Build the vector index (indexes documentation into Upstash):

```sh
bun run build:index
```

## Development

```sh
bun run dev
```

Runs locally using Vercel CLI at http://localhost:3000.

## Deploy

```sh
bun run deploy
```

Deploys to Vercel.

## License

MIT
