# Helm — Memory System and RAG

Episodic memory is a core feature of Helm. Unlike single-session assistants, Helm can recall relevant context from past runs and use it to inform future actions. This document explains how the memory system works end-to-end.

## Why Memory Matters for Desktop Automation

Desktop automation tasks are often repetitive or contextually linked. A user might:
- Ask Helm to log into a web service (run 1), then later ask it to submit a form on that service (run 2).
- Have Helm learn the layout of a frequently used application once, then reference that knowledge implicitly in future runs.
- Build up a history of successful terminal commands so the agent doesn't have to rediscover them.

Without memory, each run starts from scratch and the model relies entirely on its training data. With episodic memory, Helm can retrieve specifically *what it did in this user's environment* and reason from that.

## Memory Architecture

```
Run completes
     │
     ├─► upsertMemory(entityType='run_user_input')
     │       text = user's goal text
     │       embedded → helm_memory collection
     │
     ├─► upsertMemory(entityType='run_assistant_output')
     │       text = reasoning + assistant final response
     │       embedded → helm_memory collection
     │
     └─► upsertRunEpisode()
             text = structured summary: user goal, tools called, outcome
             embedded → helm_episodes collection

Next run begins
     │
     ├─► queryMemories(query=userInput, topK=4)
     │       cosine similarity search in helm_memory
     │
     └─► queryRunEpisodes(query=userInput, topK=4)
             cosine similarity search in helm_episodes

Retrieved memories injected into system prompt
```

## Collections

### `helm_memory` — Semantic Memory

Stores individual user inputs and assistant outputs as dense vector embeddings. Each entry is a short piece of text derived from a single run side (what the user asked, or what the agent replied and reasoned about).

**When stored**: after every completed run (two entries per run — one for the user's input, one for the agent's reasoning + output).

**When retrieved**: at the start of every new run, queried against the user's current input. The top-K most semantically similar entries are injected into the system prompt under the heading *"Background context from past runs"*.

**ChromaDB record**:
```
id:        <UUID>
document:  <plain text of user input or assistant output>
metadata:  { conversationId, entityType, entityId, preview, attachmentCount? }
```

### `helm_episodes` — Episodic Memory

Stores a structured narrative of what happened in each run: the goal, the tools invoked (with their names), and the final outcome. This gives the model a higher-level "story" of past runs rather than raw text.

**When stored**: after every completed run (one entry per run).

**When retrieved**: at the start of every new run, queried against the user's current input. Top-K similar episodes are injected into the system prompt alongside semantic memories.

**Episode format** (illustrative):
```
Goal: Open Firefox and navigate to github.com
Tools used: open_application, capture_screenshot, click_mouse, type_text, capture_screenshot
Outcome: Successfully navigated Firefox to github.com. Home page loaded and visible.
```

### `helm_summaries` — Context Summaries

Stores LLM-generated summaries of long conversations used for context window compression (see [Context Compression](#context-compression)). These are stored in ChromaDB for retrieval but are primarily referenced through the SQLite `conversation_summaries` table.

## SQLite Tracking Table

A SQLite table `embedding_links` tracks every ChromaDB entry created by Helm:

```sql
CREATE TABLE embedding_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,   -- 'run_user_input' | 'run_assistant_output' | 'episode'
  entity_id TEXT NOT NULL,     -- run ID or message ID
  chroma_collection TEXT NOT NULL,
  chroma_id TEXT NOT NULL,     -- UUID used in ChromaDB
  created_at TEXT NOT NULL
);
```

This table enables the server to list, inspect, and delete memory entries through the `/api/memories` endpoints without querying ChromaDB for discovery (only for content retrieval).

## RAG Retrieval

Retrieval is performed using cosine similarity between the embedding of the current user input and all stored embeddings in the relevant collection. The top-K results (configurable via `MEMORY_TOP_K`, default 4) are returned.

**Implementation** (`services/memory.ts`, `services/episodic-memory.ts`):
1. Embed the user's input using the configured embedding model (`EMBED_MODEL`).
2. Call `collection.query({ queryEmbeddings, nResults })` on the ChromaDB collection.
3. Filter out entries from the current conversation (to avoid circular self-reference).
4. Return the top-K results as `{ text, distance }` objects.

The retrieved texts are formatted as bullet points and appended to the system prompt:
```
Background context from past runs (not current task state):
- distance=0.142 Successfully logged into the web portal using stored credentials.
- distance=0.218 The application shortcut is located at the bottom-left of the taskbar.
```

The `distance` value (lower = more similar) helps the model gauge how relevant each memory is.

## Context Compression

Conversations accumulate messages over time. To prevent the active context window from exceeding the model's token limit, Helm compresses older messages into a summary.

**Trigger**: when the estimated active context reaches about 80% of the model context window reported by the OpenAI-compatible `/models` endpoint. If that metadata is unavailable, Helm falls back to `SUMMARY_TRIGGER_TOKENS` (default 9,000 tokens).

**Process**:
1. `maybeSummarizeConversation()` is called before and after each run.
2. It estimates the token count of active, unsummarized messages plus the current summary.
3. If the threshold is exceeded, it calls the LLM to produce a concise summary of those messages.
4. The summary is stored in SQLite (`conversation_summaries` table) and ChromaDB.
5. Future runs include the summary in the system prompt and load only the most recent messages for full context, keeping the total token count bounded.

**System prompt injection**:
```
[Context summary — covers first N messages]
The user asked Helm to automate several tasks including opening Firefox, filling a web form, 
and saving a file to the desktop. All tasks were completed successfully...
[End of summary — subsequent messages follow]
```

## Memory Events in the UI

The client receives live memory events over the SSE stream and renders them as expandable status chips in the conversation:

| Event | Chip label | Expandable content |
|-------|-----------|-------------------|
| `memory_reading` | 🧠 Reading memory | Count of memories retrieved + query text |
| `memory_saved` | 💾 Memory saved | Number of tool calls recorded in the episode |
| `context_summarizing` | 📦 Compressing context | Estimated token count being compressed |
| `context_summarized` | ✅ Context compressed | Number of messages covered + summary token size |

These chips are collapsed by default and expand on click, giving the user transparency into the memory system's activity without cluttering the conversation view.
