/*
 * Durable cache for immutable Spotify metadata.
 *
 * Album artwork, artist genres and similar facts never change for a given id,
 * yet the card re-fetched them on every page load because the caches were
 * plain in-memory Maps. On a 96-track Sonos queue that meant a dozen
 * `get_track` calls every single time the card opened, forever — requests that
 * cost real quota against the user's Spotify developer app and buy nothing.
 *
 * That quota is finite and shared: exhausting it makes Spotify return
 * 429/QUOTA_EXCEEDED, and SpotifyPlus responds by sleeping for the (multi-hour)
 * Retry-After, which presents as every call hanging. The cheapest defence is
 * simply not making the request twice.
 *
 * Backed by localStorage, which persists across reloads and is shared by every
 * dashboard on the same origin. Deliberately conservative:
 *   - only for values that cannot change for a given key (see CACHES)
 *   - bounded, with oldest-first eviction, so it can't grow without limit
 *   - versioned, so a shape change invalidates cleanly
 *   - every access is failure-tolerant (private mode, quota-full, corrupt
 *     JSON) and degrades to an in-memory Map rather than throwing
 */

const STORAGE_PREFIX = 'spf-cache-v1:';
const DEFAULT_MAX_ENTRIES = 600;

/** localStorage, or null when unavailable (private mode, embedded webviews). */
function storage() {
    try {
        const s = globalThis.localStorage;
        if (!s) return null;
        // Safari in private mode exposes localStorage but throws on write.
        const probe = `${STORAGE_PREFIX}__probe`;
        s.setItem(probe, '1');
        s.removeItem(probe);
        return s;
    } catch (_) {
        return null;
    }
}

export class MetadataCache {
    /**
     * @param {string} name    Namespace, e.g. 'track-art'.
     * @param {object} [opts]
     * @param {number} [opts.maxEntries] Eviction threshold.
     */
    constructor(name, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
        this.key = STORAGE_PREFIX + name;
        this.maxEntries = maxEntries;
        this._store = storage();
        this._mem = this._load();
    }

    _load() {
        if (!this._store) return new Map();
        try {
            const raw = this._store.getItem(this.key);
            if (!raw) return new Map();
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') return new Map();
            return new Map(Object.entries(obj));
        } catch (_) {
            // Corrupt or unreadable — start clean rather than fail.
            try { this._store.removeItem(this.key); } catch (_) { /* ignore */ }
            return new Map();
        }
    }

    _persist() {
        if (!this._store) return;
        try {
            this._store.setItem(this.key, JSON.stringify(Object.fromEntries(this._mem)));
        } catch (_) {
            // Storage full or blocked. Trim hard and retry once; if that also
            // fails, carry on in memory — a cache miss is never fatal.
            try {
                const keep = [...this._mem.entries()].slice(-Math.floor(this.maxEntries / 2));
                this._mem = new Map(keep);
                this._store.setItem(this.key, JSON.stringify(Object.fromEntries(this._mem)));
            } catch (_) { /* in-memory only from here */ }
        }
    }

    has(id) { return this._mem.has(id); }

    get(id) { return this._mem.get(id); }

    /**
     * Store a value. Insertion order drives eviction, so re-setting an existing
     * key refreshes its position.
     */
    set(id, value) {
        if (!id) return value;
        if (this._mem.has(id)) this._mem.delete(id);
        this._mem.set(id, value);
        if (this._mem.size > this.maxEntries) {
            const overflow = this._mem.size - this.maxEntries;
            const keys = [...this._mem.keys()].slice(0, overflow);
            keys.forEach(k => this._mem.delete(k));
        }
        this._persist();
        return value;
    }

    get size() { return this._mem.size; }

    clear() {
        this._mem = new Map();
        if (!this._store) return;
        try { this._store.removeItem(this.key); } catch (_) { /* ignore */ }
    }
}
