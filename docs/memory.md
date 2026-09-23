# Persistent memory

Helm's persistent memory is a small global store for information that can help
with later tasks. It is separate from message history and from run-local
context compaction. A recalled memory is a contextual hint; it does not prove
that an external fact, page, or resource is still current.

## Explicit memory in the acting loop

The production acting agent has four native host tools:

- `memory.search` performs the same hybrid search as automatic recall.
- `memory.remember` creates a memory or updates an existing keyed or clearly
  equivalent item.
- `memory.update` changes a stored item by ID or stable key.
- `memory.forget` deletes an item by ID or stable key.

All four use validated schemas and return structured tool results to the same
acting-agent conversation. Persistence errors return tool failures, so Helm
cannot claim an explicit memory write succeeded without a successful result.
The model includes a successful memory tool in `helm.complete.requiredEffects`
when the user explicitly requested that operation. The regular runtime effect
check verifies that the call succeeded.

When the requested memory depends on research or another action, the model can
perform that work first and call `memory.remember` afterward. Observed memories
must cite IDs from successful tool receipts already returned during the current
run. This keeps the memory's `sourceUrl` and `evidenceIds` traceable to real
actions; it does not make the saved value current forever.

Stable optional keys identify facts that may be corrected later. Remembering a
new value under an existing key updates that row, preserving its ID and
removing its old content from full-text search. Without a key, Helm first checks
for exact content, then same-kind lexical similarity, and then optional vector
similarity. The current conservative thresholds are Jaccard similarity of at
least `0.9` or vector distance at most `0.36`. Equivalent passive candidates are
ignored; explicit user or agent saves update the existing match. Different
kinds are not merged by this deduplication.

## Passive extraction

After a successfully completed run, Helm may ask its memory extractor to find
durable user preferences, project facts, or instructions in user-authored
conversation. A cheap gate skips the optional model call for messages that do
not look memory-relevant. The extractor may return at most three upsert
operations. It is instructed to exclude one-off task details, transient web
observations, and claims made only by the assistant. Passive memories use the
`passive-extraction` source and `durable` durability. If the acting agent used a
memory management tool during the run, passive extraction is skipped so it
cannot race or overwrite the explicit operation.

## Retrieval and ranking

At run start, recall builds a bounded query from the current request and up to
four recent preceding user/assistant messages. The current request is not
duplicated, each context message is limited to 650 characters, the current
request to 1,600 characters, and the whole query to 3,000 characters. Tool
traces and older thread history are excluded. Production recall returns at most
six memories. The acting model can search deeper with `memory.search` when
needed.

Full-text search and optional embedding search independently rank candidates.
Helm fuses their ranks with reciprocal rank fusion (`k = 60`), de-duplicates by
memory ID, and filters distant vector matches (default distance limit `0.95`).
Importance, source, update recency, and verification freshness provide small
secondary adjustments after relevance. Importance therefore helps order
similarly relevant memories but cannot make an unrelated high-importance item a
match. If embeddings are unavailable, full-text search still works; either
retrieval enhancement may fail without making the SQLite memory rows
unavailable.

Successful searches update `lastAccessedAt` and `accessCount`. The agent sees a
bounded set of up to six recalled entries with their IDs, keys, kinds, content,
importance, source, source URL, durability, verification time, and update time.

## Provenance and lifetime

Each memory can carry:

- `source`: `user`, `observed`, `manual`, or `passive-extraction`;
- `sourceUrl` and `evidenceIds` for traceable observed information;
- `durability`: `durable` or `refreshable`;
- `lastVerifiedAt` for the latest observation;
- `lastAccessedAt` and `accessCount` for retrieval activity.

Durable information is expected to remain useful without routine rechecking.
Refreshable information may become stale, so a new observed value should
refresh its verification time and evidence. The UI labels source and lifetime
and exposes available provenance while editing or deleting a memory.

The Memory dialog supports manual creation and editing of content, kind,
importance, stable key, source URL, and durability. It shows source, key,
source URL, verification time, and update time when present. Add, edit, and
delete actions update the server-backed memory list. Memory tool activity also
appears in the run activity feed, including a summary event when memories are
recalled for a run.

Forgetting removes the SQLite row, its FTS entry, and its vector entry when
available. Context compaction is unrelated: it summarizes older exchanges for
the current run only and is never copied into persistent memory.

## Storage

SQLite remains authoritative. Migration 5 adds keys, source and provenance,
durability, verification/access metadata, and indexes; it backfills legacy
source information and rebuilds the FTS index to include keys. A partial unique
index allows multiple unkeyed memories while enforcing one row per stable key.
