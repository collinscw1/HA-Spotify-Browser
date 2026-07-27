import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataCache } from '../metadata-cache.js';

/** Minimal localStorage double. `failWrites` simulates a full/blocked store. */
function fakeStorage({ failWrites = false } = {}) {
    const data = new Map();
    return {
        data,
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => {
            if (failWrites && !k.endsWith('__probe')) throw new Error('QuotaExceededError');
            data.set(k, String(v));
        },
        removeItem: (k) => { data.delete(k); },
    };
}

/** Run `fn` with globalThis.localStorage swapped out, then restore. */
function withStorage(store, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const prev = globalThis.localStorage;
    globalThis.localStorage = store;
    try { return fn(); } finally {
        if (had) globalThis.localStorage = prev;
        else delete globalThis.localStorage;
    }
}

test('values survive a new instance (i.e. a page reload)', () => {
    const store = fakeStorage();
    withStorage(store, () => {
        const a = new MetadataCache('track-art');
        a.set('track1', 'https://example/art1.jpg');
        a.set('track2', null); // "definitely has no artwork" is worth caching

        const b = new MetadataCache('track-art');
        assert.equal(b.get('track1'), 'https://example/art1.jpg');
        assert.equal(b.has('track2'), true);
        assert.equal(b.get('track2'), null);
        assert.equal(b.has('track3'), false);
    });
});

test('namespaces do not collide', () => {
    withStorage(fakeStorage(), () => {
        const art = new MetadataCache('track-art');
        const genres = new MetadataCache('artist-genres');
        art.set('x', 'art');
        genres.set('x', ['rock']);

        assert.equal(new MetadataCache('track-art').get('x'), 'art');
        assert.deepEqual(new MetadataCache('artist-genres').get('x'), ['rock']);
    });
});

test('evicts oldest entries past the cap', () => {
    withStorage(fakeStorage(), () => {
        const c = new MetadataCache('track-art', { maxEntries: 5 });
        for (let i = 0; i < 8; i++) c.set(`t${i}`, `art${i}`);

        assert.equal(c.size, 5);
        assert.equal(c.has('t0'), false, 'oldest should be evicted');
        assert.equal(c.has('t7'), true, 'newest should be kept');
    });
});

test('re-setting a key refreshes its position', () => {
    withStorage(fakeStorage(), () => {
        const c = new MetadataCache('track-art', { maxEntries: 3 });
        c.set('a', 1); c.set('b', 2); c.set('c', 3);
        c.set('a', 1);          // touch the oldest
        c.set('d', 4);          // forces one eviction

        assert.equal(c.has('a'), true, 'refreshed key should survive');
        assert.equal(c.has('b'), false, 'now-oldest key should be evicted');
    });
});

test('corrupt stored data is discarded rather than thrown', () => {
    const store = fakeStorage();
    store.data.set('spf-cache-v1:track-art', '{not json at all');
    withStorage(store, () => {
        const c = new MetadataCache('track-art');
        assert.equal(c.size, 0);
        c.set('t1', 'art');
        assert.equal(new MetadataCache('track-art').get('t1'), 'art', 'recovers and persists');
    });
});

test('a blocked or full store degrades to memory instead of failing', () => {
    withStorage(fakeStorage({ failWrites: true }), () => {
        const c = new MetadataCache('track-art');
        assert.doesNotThrow(() => c.set('t1', 'art'));
        assert.equal(c.get('t1'), 'art', 'still usable in memory');
    });
});

test('works with no localStorage at all (private mode / webview)', () => {
    withStorage(undefined, () => {
        const c = new MetadataCache('track-art');
        assert.doesNotThrow(() => c.set('t1', 'art'));
        assert.equal(c.get('t1'), 'art');
        assert.equal(c.has('nope'), false);
    });
});

test('clear empties both memory and storage', () => {
    const store = fakeStorage();
    withStorage(store, () => {
        const c = new MetadataCache('track-art');
        c.set('t1', 'art');
        c.clear();
        assert.equal(c.size, 0);
        assert.equal(new MetadataCache('track-art').size, 0);
    });
});
