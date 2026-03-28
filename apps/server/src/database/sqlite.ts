import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

export const db = new DatabaseSync(config.DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
	CREATE TABLE IF NOT EXISTS conversations (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		last_preview TEXT
	);

	CREATE TABLE IF NOT EXISTS conversation_messages (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		run_id TEXT,
		role TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS message_parts (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		part_type TEXT NOT NULL,
		position INTEGER NOT NULL,
		content_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS conversation_runs (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		status TEXT NOT NULL,
		error_message TEXT,
		user_message_id TEXT NOT NULL,
		assistant_message_id TEXT,
		started_at TEXT,
		completed_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS run_events (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		sequence INTEGER NOT NULL,
		event_type TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (run_id) REFERENCES conversation_runs(id) ON DELETE CASCADE,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS conversation_summaries (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		summary_text TEXT NOT NULL,
		up_to_message_count INTEGER NOT NULL,
		token_estimate INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS embedding_links (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		entity_type TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		chroma_collection TEXT NOT NULL,
		chroma_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
		ON conversations(updated_at DESC);

	CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
		ON conversation_messages(conversation_id, created_at ASC);

	CREATE INDEX IF NOT EXISTS idx_message_parts_message_position
		ON message_parts(message_id, position ASC);

	CREATE INDEX IF NOT EXISTS idx_runs_conversation_created
		ON conversation_runs(conversation_id, created_at DESC);

	CREATE INDEX IF NOT EXISTS idx_runs_conversation_status
		ON conversation_runs(conversation_id, status);

	CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence
		ON run_events(run_id, sequence ASC);

	CREATE INDEX IF NOT EXISTS idx_run_events_conversation_created
		ON run_events(conversation_id, created_at DESC);

	CREATE INDEX IF NOT EXISTS idx_summaries_conversation_created
		ON conversation_summaries(conversation_id, created_at DESC);

	CREATE INDEX IF NOT EXISTS idx_embedding_links_lookup
		ON embedding_links(conversation_id, entity_type, entity_id);
`);
