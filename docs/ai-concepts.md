# AI Agents
Source: https://docs.openclaw.ai/concepts/ai-agents

An AI agent is a software system that uses a large language model (LLM) as its core reasoning engine to autonomously perceive its environment, make decisions, and take actions to achieve goals. Unlike simple chatbots that only respond to prompts, agents can plan multi-step tasks, use tools, maintain memory across interactions, and adapt their behavior based on feedback.

AI agents typically consist of several key components: a language model for reasoning and decision-making, a set of tools the agent can invoke (APIs, databases, code execution), a memory system for maintaining context, and an orchestration loop that coordinates planning and execution. OpenClaw provides a framework for building and deploying these agent systems.

Agents differ from traditional automation in that they can handle ambiguous instructions, recover from errors, and make judgment calls. They combine the flexibility of human reasoning (via LLMs) with the speed and reliability of software execution (via tool use).

Common agent architectures include ReAct (Reasoning + Acting), plan-and-execute, and multi-agent systems where specialized agents collaborate on complex tasks.


# Large Language Models (LLMs)
Source: https://docs.openclaw.ai/concepts/llms

Large language models are neural networks trained on vast amounts of text data to understand and generate human language. Models like GPT-5, Claude, Gemini, and Llama power modern AI applications by providing natural language understanding, reasoning, code generation, and more.

LLMs work by predicting the next token in a sequence, but through scale and training they develop emergent capabilities including logical reasoning, instruction following, and in-context learning. They process input as tokens (subword units) and have a context window that limits how much text they can consider at once.

Key LLM concepts relevant to agent development:

- **Context window**: The maximum number of tokens an LLM can process in a single request. Larger windows allow more information but increase cost and latency.
- **Temperature**: Controls randomness in generation. Lower values (0-0.3) produce more deterministic outputs suitable for factual tasks; higher values (0.7-1.0) encourage creativity.
- **System prompts**: Instructions that set the LLM's behavior, personality, and constraints for an entire conversation.
- **Function/tool calling**: A structured way for LLMs to request the execution of external tools, returning results back into the conversation.
- **Streaming**: Delivering tokens incrementally as they are generated, improving perceived latency for end users.

When building with OpenClaw, you can configure which LLM to use, adjust parameters like temperature, and leverage tool calling to give agents access to external capabilities.


# Retrieval-Augmented Generation (RAG)
Source: https://docs.openclaw.ai/concepts/rag

Retrieval-Augmented Generation (RAG) is a technique that enhances LLM responses by first retrieving relevant information from a knowledge base and then including that information in the prompt. This grounds the model's answers in specific, up-to-date data rather than relying solely on its training data.

A typical RAG pipeline consists of two phases:

**Indexing phase** (offline):
1. Documents are split into chunks (typically 500-1500 characters)
2. Each chunk is converted to a vector embedding using an embedding model
3. Vectors are stored in a vector database for fast similarity search
4. Optionally, a keyword index (like BM25) is built for hybrid search

**Query phase** (online):
1. The user's question is converted to a vector embedding
2. Similar chunks are retrieved from the vector database
3. Retrieved chunks are optionally reranked for relevance
4. The most relevant chunks are included in the LLM prompt as context
5. The LLM generates an answer grounded in the retrieved context

RAG solves several LLM limitations: it reduces hallucination by providing factual grounding, enables access to private or recent data not in training, and makes answers verifiable through source citations.

OpenClaw's documentation chat uses a hybrid RAG approach combining semantic search (vector similarity) with keyword search (BM25), followed by cross-encoder reranking for optimal retrieval quality.


# Vector Embeddings and Similarity Search
Source: https://docs.openclaw.ai/concepts/embeddings

Vector embeddings are numerical representations of text (or other data) in a high-dimensional space where semantically similar content is positioned close together. They are the foundation of semantic search in RAG systems.

Embedding models like OpenAI's text-embedding-3-large convert text into dense vectors (e.g., 3072 dimensions). These vectors capture meaning, so "How do I authenticate?" and "What's the login process?" would have similar embeddings even though they share few words.

**Similarity search** finds the closest vectors to a query vector using distance metrics like cosine similarity or dot product. Vector databases (Pinecone, Upstash Vector, Weaviate, Qdrant) are optimized for this operation, using approximate nearest neighbor (ANN) algorithms to search millions of vectors in milliseconds.

Key considerations for embeddings in production:
- **Chunk size**: Smaller chunks are more precise but may lack context; larger chunks provide more context but dilute relevance signals
- **Overlap**: Sliding window overlap between chunks prevents information from being split across boundaries
- **Embedding model choice**: Larger models produce better embeddings but cost more and are slower
- **Dimensionality**: Higher dimensions capture more nuance but require more storage and compute


# Hybrid Search and Reranking
Source: https://docs.openclaw.ai/concepts/hybrid-search

Hybrid search combines multiple retrieval strategies to achieve better recall and precision than any single method alone. The two most common strategies are:

- **Semantic search**: Uses vector embeddings to find conceptually similar content. Excels at understanding intent and paraphrases but can miss exact keyword matches.
- **Keyword search (BM25)**: Uses term frequency and inverse document frequency to find exact word matches. Excels at specific terms, error codes, and proper nouns but misses paraphrases.

**Reciprocal Rank Fusion (RRF)** is a technique for combining results from multiple retrieval systems. It assigns scores based on each result's rank position across different systems, then merges and re-sorts. RRF is simple, effective, and doesn't require tuning weights.

**Cross-encoder reranking** (e.g., using Cohere Rerank) is a second-stage process that scores each retrieved document against the query using a more powerful model. Unlike bi-encoder embeddings (which encode query and document independently), cross-encoders process query-document pairs together, producing more accurate relevance scores at the cost of higher latency. Reranking typically improves precision by 10-20%.

OpenClaw's chat pipeline uses all three: semantic search via Upstash Vector, BM25 keyword search, RRF fusion, and Cohere reranking.


# Prompt Engineering
Source: https://docs.openclaw.ai/concepts/prompt-engineering

Prompt engineering is the practice of designing effective instructions and context for LLMs to produce desired outputs. For AI agents and RAG systems, prompt engineering is critical to controlling behavior, accuracy, and tone.

Key techniques:

- **System prompts**: Define the agent's role, constraints, and output format. A well-structured system prompt is the most impactful lever for quality.
- **Few-shot examples**: Including example input-output pairs in the prompt helps the model understand the expected format and reasoning pattern.
- **Chain-of-thought (CoT)**: Asking the model to "think step by step" improves reasoning accuracy on complex tasks.
- **Structured output**: Requesting JSON, markdown, or other structured formats makes responses easier to parse programmatically.
- **Grounding instructions**: Telling the model to answer only from provided context (as in RAG) reduces hallucination.
- **Confidence calibration**: Instructing the model to express uncertainty when appropriate improves trustworthiness.

When building agents with OpenClaw, prompts should clearly specify the agent's tools, when to use them, and how to format tool calls. For RAG applications, prompts should instruct the model to cite sources and distinguish between documented facts and inferences.


# Tool Use and Function Calling
Source: https://docs.openclaw.ai/concepts/tool-use

Tool use (also called function calling) allows AI agents to interact with external systems by invoking predefined functions. The LLM decides when and which tool to call based on the user's request, and the tool's output is fed back into the conversation for the model to interpret.

Common tools in agent systems include:
- **API calls**: Querying external services (weather, search, databases)
- **Code execution**: Running Python, JavaScript, or other code in a sandbox
- **File operations**: Reading, writing, and searching files
- **Database queries**: Executing SQL or NoSQL queries
- **Web browsing**: Fetching and parsing web pages

The tool use cycle works as follows:
1. The user sends a message
2. The LLM analyzes the message and decides if a tool is needed
3. If yes, the LLM outputs a structured tool call (function name + arguments)
4. The application executes the tool and returns the result
5. The LLM incorporates the tool result and generates a final response

OpenClaw supports defining custom tools that agents can use, with type-safe schemas and automatic validation. Tools can be composed into toolkits for specific domains.


# Agent Memory and Context Management
Source: https://docs.openclaw.ai/concepts/memory

Memory systems allow AI agents to maintain information across interactions, enabling more coherent and personalized experiences. There are several types of memory in agent systems:

- **Short-term (working) memory**: The current conversation context within the LLM's context window. This is automatically managed by including recent messages in each API call.
- **Long-term memory**: Persistent storage of facts, preferences, and past interactions. Typically implemented using vector databases or key-value stores.
- **Episodic memory**: Records of specific past interactions or events that the agent can recall when relevant.
- **Semantic memory**: General knowledge and facts extracted from interactions, stored as embeddings for retrieval.

Context management strategies for agents:
- **Sliding window**: Keep the N most recent messages, dropping older ones
- **Summarization**: Periodically summarize older conversation history to compress context
- **Retrieval-augmented memory**: Store all interactions in a vector database and retrieve relevant past context based on the current query
- **Structured state**: Maintain a structured representation of key facts (user preferences, task progress) separate from raw conversation history

Effective memory management is essential for agents that handle multi-turn conversations or long-running tasks, as it prevents context window overflow while preserving important information.


# Multi-Agent Systems
Source: https://docs.openclaw.ai/concepts/multi-agent

Multi-agent systems use multiple specialized AI agents that collaborate to solve complex tasks. Instead of one general-purpose agent, the work is divided among agents with different capabilities, knowledge, or perspectives.

Common multi-agent patterns:

- **Supervisor pattern**: A coordinator agent delegates tasks to specialized worker agents and synthesizes their results. Useful for complex workflows with distinct subtasks.
- **Debate/critique pattern**: Multiple agents review and critique each other's outputs, improving quality through adversarial collaboration.
- **Pipeline pattern**: Agents are arranged in a sequence where each agent's output feeds into the next. Useful for multi-stage processing like research → analysis → writing.
- **Swarm pattern**: Agents dynamically hand off to each other based on the conversation topic, each specializing in a different domain.

Benefits of multi-agent architectures:
- Separation of concerns — each agent can have focused instructions and tools
- Reduced prompt complexity — smaller, specialized prompts outperform large monolithic ones
- Parallel execution — independent subtasks can run simultaneously
- Easier testing — individual agents can be tested and improved in isolation

OpenClaw supports building multi-agent systems with inter-agent communication, shared state, and configurable orchestration strategies.


# AI Safety and Responsible Use
Source: https://docs.openclaw.ai/concepts/safety

Building safe and responsible AI agent systems requires addressing several categories of risk:

- **Hallucination mitigation**: Use RAG with source citations, constrain outputs to verified data, and implement confidence thresholds. OpenClaw's RAG pipeline includes reranking and score-based confidence to reduce hallucinated answers.
- **Prompt injection defense**: Sanitize user inputs, use system prompts that resist manipulation, and validate tool call arguments before execution.
- **Rate limiting and abuse prevention**: Implement per-user and per-IP rate limits to prevent abuse. OpenClaw includes built-in rate limiting via Upstash Redis.
- **Output filtering**: Screen generated content for harmful, biased, or inappropriate material before delivery to users.
- **Scope limitation**: Clearly define what the agent can and cannot do. Restrict tool access to the minimum necessary for the task.
- **Observability**: Log queries, responses, and tool calls for monitoring, debugging, and continuous improvement. OpenClaw includes an observability layer for query analytics and coverage gap detection.
- **Human oversight**: For high-stakes actions, require human approval before execution. Implement confirmation steps for irreversible operations.

These practices should be integrated throughout the development lifecycle, not added as an afterthought.


# Evaluation and Observability
Source: https://docs.openclaw.ai/concepts/evaluation

Evaluating AI agent and RAG system quality requires measuring multiple dimensions:

**Retrieval quality metrics:**
- **Recall@k**: What fraction of relevant documents appear in the top-k results?
- **Precision@k**: What fraction of the top-k results are actually relevant?
- **MRR (Mean Reciprocal Rank)**: How high does the first relevant result appear on average?
- **NDCG**: Measures the quality of the full ranking, weighting higher positions more

**Generation quality metrics:**
- **Faithfulness**: Does the answer accurately reflect the retrieved context without hallucination?
- **Relevance**: Does the answer address the user's actual question?
- **Completeness**: Does the answer cover all aspects of the question?
- **Citation accuracy**: Are sources correctly attributed?

**Operational metrics:**
- **Latency**: End-to-end response time including retrieval, reranking, and generation
- **Coverage gaps**: Which user questions have no relevant documents in the knowledge base?
- **User feedback**: Explicit signals (thumbs up/down) and implicit signals (follow-up questions)

OpenClaw's observability layer tracks query patterns, retrieval scores, and response metrics to identify areas for improvement. Coverage gap analysis reveals topics that should be added to the documentation.
