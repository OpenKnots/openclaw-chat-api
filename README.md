# OpenClaw Chat API

RAG-based documentation chat API for [OpenClaw](https://openclaw.org). Uses vector search to retrieve relevant documentation chunks and streams AI-generated answers.

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **Deployment**: [Vercel](https://vercel.com) serverless functions
- **Vector Store**: [Upstash Vector](https://upstash.com/vector)
- **AI**: [OpenAI](https://openai.com) (gpt-4o-mini for chat, text-embedding-3-small for embeddings)
- **Language**: TypeScript

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat` | POST | Send a question, get a streaming response |
| `/health` | GET | Health check |

### POST /chat

```json
{
  "message": "How do I get started with OpenClaw?"
}
```

Returns a streaming `text/plain` response with the AI-generated answer.

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
