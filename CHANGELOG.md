# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-02-03

### Added
- **Hybrid Search**: Introduced hybrid retrieval strategies combining semantic and keyword (BM25) searches for improved response accuracy
- **Feedback System**: New `/api/feedback` endpoint to collect user ratings and comments on chat responses
- **Query Classifier**: Intelligent query intent detection to optimize retrieval strategy
- **Observability**: Comprehensive logging for queries and feedback with analytics capabilities
- **Model Selection**: User-selectable AI models in chat form (gpt-4o-mini, gpt-4.1-mini)
- **GitHub Webhook**: Automatic documentation re-indexing via GitHub webhooks
- **CORS Support**: Cross-origin request handling with preflight support
- **Streaming Response Buffer**: Improved streaming with buffered line handling for data integrity
- **Rate Limiting**: Upstash Redis-based rate limiting for API protection
- **Reranking**: Search result reranking for improved relevance
- **Reciprocal Rank Fusion**: Result fusion from multiple search strategies

### Changed
- Migrated from Hono to Next.js framework for improved functionality
- Enhanced Vercel configuration with Edge Runtime support
- Updated default chat model to gpt-4o-mini
- Improved README with comprehensive setup instructions

### Infrastructure
- Next.js 16 with App Router
- Vercel Edge Functions deployment
- Upstash Vector for embeddings storage
- Upstash Redis for rate limiting and caching
- OpenAI API integration for embeddings and chat

[2.0.0]: https://github.com/OpenKnots/openclaw-chat-api/releases/tag/v2.0.0
