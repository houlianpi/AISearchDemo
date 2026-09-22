export interface DisposableSession { dispose(): void }

interface CacheEntry<T> { value: T; lastUsedAt: number }

export class SessionCache<T extends DisposableSession> {
	private readonly entries = new Map<string, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(ttlMs: number, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	get(id: string): T | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		const now = this.now();
		if (now - entry.lastUsedAt >= this.ttlMs) {
			entry.value.dispose();
			this.entries.delete(id);
			return undefined;
		}
		entry.lastUsedAt = now;
		return entry.value;
	}

	set(id: string, value: T): void {
		this.entries.set(id, { value, lastUsedAt: this.now() });
	}
}
