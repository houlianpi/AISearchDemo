import type { SessionSummary, StoredEntry } from "@wa/protocol";

/**
 * Durable, per-user session storage backed by the Durable Object's SQLite.
 *
 * The schema is an append-only entry log, mirroring pi's own session model:
 * every `SessionEntry` pi appends in memory is written here as one row. State
 * is never snapshotted; conversation history is rebuilt by replaying entries.
 * This is what makes a session survive DO eviction, hibernation and redeploys.
 */

/** DO SQLite caps a row at 2 MB. pi truncates tool output well below this. */
export const MAX_ENTRY_BYTES = 1_500_000;

export interface SessionRow {
	sessionId: string;
	title: string | null;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	entryCount: number;
}

export class SessionStore {
	private readonly sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.sql = sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				session_id  TEXT PRIMARY KEY,
				title       TEXT,
				cwd         TEXT NOT NULL,
				created_at  INTEGER NOT NULL,
				updated_at  INTEGER NOT NULL,
				next_seq    INTEGER NOT NULL DEFAULT 1
			);
			CREATE TABLE IF NOT EXISTS entries (
				session_id  TEXT NOT NULL,
				seq         INTEGER NOT NULL,
				entry_id    TEXT NOT NULL,
				type        TEXT NOT NULL,
				json        TEXT NOT NULL,
				created_at  INTEGER NOT NULL,
				PRIMARY KEY (session_id, seq)
			);
			CREATE INDEX IF NOT EXISTS idx_entries_by_id ON entries (session_id, entry_id);
		`);
	}

	createSession(sessionId: string, cwd: string, title: string | null): SessionRow {
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO sessions (session_id, title, cwd, created_at, updated_at, next_seq) VALUES (?, ?, ?, ?, ?, 1)",
			sessionId,
			title,
			cwd,
			now,
			now,
		);
		return { sessionId, title, cwd, createdAt: now, updatedAt: now, entryCount: 0 };
	}

	getSession(sessionId: string): SessionRow | undefined {
		const rows = this.sql
			.exec<{
				session_id: string;
				title: string | null;
				cwd: string;
				created_at: number;
				updated_at: number;
				next_seq: number;
			}>("SELECT * FROM sessions WHERE session_id = ?", sessionId)
			.toArray();
		const row = rows[0];
		if (!row) return undefined;
		return {
			sessionId: row.session_id,
			title: row.title,
			cwd: row.cwd,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			entryCount: row.next_seq - 1,
		};
	}

	listSessions(): SessionRow[] {
		return this.sql
			.exec<{
				session_id: string;
				title: string | null;
				cwd: string;
				created_at: number;
				updated_at: number;
				next_seq: number;
			}>("SELECT * FROM sessions ORDER BY updated_at DESC")
			.toArray()
			.map((row) => ({
				sessionId: row.session_id,
				title: row.title,
				cwd: row.cwd,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				entryCount: row.next_seq - 1,
			}));
	}

	deleteSession(sessionId: string): void {
		this.sql.exec("DELETE FROM entries WHERE session_id = ?", sessionId);
		this.sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
	}

	setTitle(sessionId: string, title: string): void {
		this.sql.exec("UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?", title, Date.now(), sessionId);
	}

	/** Appends one pi session entry. Returns the assigned sequence number. */
	appendEntry(sessionId: string, entryId: string, type: string, entry: unknown): number {
		let json = JSON.stringify(entry);
		if (json.length > MAX_ENTRY_BYTES) {
			json = JSON.stringify({
				type,
				id: entryId,
				truncated: true,
				note: `entry dropped: ${json.length} bytes exceeds the ${MAX_ENTRY_BYTES} byte row limit`,
			});
		}
		const now = Date.now();
		const seq = this.sql
			.exec<{
				next_seq: number;
			}>("UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE session_id = ? RETURNING next_seq - 1 AS next_seq", now, sessionId)
			.one().next_seq;
		this.sql.exec(
			"INSERT INTO entries (session_id, seq, entry_id, type, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			sessionId,
			seq,
			entryId,
			type,
			json,
			now,
		);
		return seq;
	}

	readEntries(sessionId: string, sinceSeq = 0): StoredEntry[] {
		return this.sql
			.exec<{
				seq: number;
				entry_id: string;
				type: string;
				json: string;
			}>("SELECT seq, entry_id, type, json FROM entries WHERE session_id = ? AND seq > ? ORDER BY seq", sessionId, sinceSeq)
			.toArray()
			.map((row) => ({
				seq: row.seq,
				entryId: row.entry_id,
				type: row.type,
				entry: JSON.parse(row.json) as unknown,
			}));
	}

	lastSeq(sessionId: string): number {
		const row = this.sql
			.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries WHERE session_id = ?", sessionId)
			.one();
		return row.seq ?? 0;
	}
}

export function toSummary(row: SessionRow, running: boolean): SessionSummary {
	return {
		sessionId: row.sessionId,
		title: row.title,
		cwd: row.cwd,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		entryCount: row.entryCount,
		running,
	};
}
