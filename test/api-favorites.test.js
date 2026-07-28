import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApi, resetLearnedApiLimits } from '../api.js';

/*
 * The learned batch size persists via MetadataCache, which is module-level and
 * therefore shared across tests in this process. Clear it so each test starts
 * from the unprobed default rather than inheriting a neighbour's discovery.
 */
beforeEach(() => resetLearnedApiLimits());

/** Minimal hass double: records every call_service payload it is handed. */
function fakeHass(handler) {
    const calls = [];
    return {
        calls,
        states: {},
        connection: { connected: true, addEventListener() {}, removeEventListener() {} },
        async callWS(payload) {
            calls.push(payload);
            return handler(payload, calls.length - 1);
        },
        async callService() {},
    };
}

const ids = (n, prefix = 'id') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** All ids liked, echoed back as the {id: bool} dict shape SpotifyPlus uses. */
const echoLiked = (payload) => {
    const sent = payload.service_data.ids.split(',');
    return { response: { result: Object.fromEntries(sent.map(id => [id, true])) } };
};

test('splits a long id list into 50-id calls', async () => {
    const hass = fakeHass(echoLiked);
    const api = new SpotifyApi(hass, 'media_player.spotify');

    const result = await api.checkTrackFavorites(ids(120));

    assert.equal(hass.calls.length, 3, 'expected 120 ids to become 3 calls');
    const sizes = hass.calls.map(c => c.service_data.ids.split(',').length);
    assert.deepEqual(sizes, [50, 50, 20]);
    assert.ok(sizes.every(n => n <= 50), 'no call may exceed the 50-id ceiling');
    assert.equal(Object.keys(result).length, 120, 'every id should be resolved');
    assert.equal(result.id0, true);
    assert.equal(result.id119, true);
    api.destroy();
});

test('a single id still returns a plain boolean', async () => {
    const hass = fakeHass(() => ({ response: { result: { abc: true } } }));
    const api = new SpotifyApi(hass, 'media_player.spotify');

    assert.equal(await api.checkTrackFavorites('abc'), true);
    assert.equal(hass.calls.length, 1);
    api.destroy();
});

test('a comma string of ids is chunked too', async () => {
    const hass = fakeHass(echoLiked);
    const api = new SpotifyApi(hass, 'media_player.spotify');

    const result = await api.checkTrackFavorites(ids(60).join(','));

    assert.equal(hass.calls.length, 2);
    assert.equal(typeof result, 'object', 'multiple ids must return a map, not a boolean');
    assert.equal(Object.keys(result).length, 60);
    api.destroy();
});

test('one failing chunk does not discard the chunks that resolved', async () => {
    const hass = fakeHass((payload, i) => {
        if (i === 1) throw Object.assign(new Error('Validation error: boom'), {
            code: 'service_validation_error',
        });
        return echoLiked(payload);
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    const result = await api.checkTrackFavorites(ids(120));

    assert.equal(Object.keys(result).length, 70, 'chunks 1 and 3 should survive');
    assert.equal(result.id0, true);
    assert.equal(result.id60, undefined, 'the failed chunk contributes nothing');
    api.destroy();
});

test('shrinks the batch when SpotifyPlus rejects it as too large', async () => {
    // SpotifyPlus enforces a lower ceiling than Spotify's documented 50.
    const ACCEPTS = 25;
    const hass = fakeHass((payload) => {
        const sent = payload.service_data.ids.split(',');
        if (sent.length > ACCEPTS) {
            throw Object.assign(new Error('Validation error: Too many uris requested'),
                { code: 'service_validation_error' });
        }
        return echoLiked(payload);
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    const result = await api.checkTrackFavorites(ids(100));

    assert.equal(Object.keys(result).length, 100, 'every id should still resolve');
    const sizes = hass.calls.map(c => c.service_data.ids.split(',').length);
    assert.ok(sizes.every(n => n <= 50), 'never exceeds the documented ceiling');
    assert.ok(sizes.filter(n => n <= ACCEPTS).length >= 4, 'settles on an accepted size');
    api.destroy();
});

test('the reduced batch size is remembered for later calls', async () => {
    const ACCEPTS = 25;
    const hass = fakeHass((payload) => {
        const sent = payload.service_data.ids.split(',');
        if (sent.length > ACCEPTS) {
            throw Object.assign(new Error('Validation error: Too many uris requested'),
                { code: 'service_validation_error' });
        }
        return echoLiked(payload);
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    await api.checkTrackFavorites(ids(60));
    const rejectionsFirst = hass.calls.length;
    hass.calls.length = 0;

    await api.checkTrackFavorites(ids(60, 'second'));
    const sizes = hass.calls.map(c => c.service_data.ids.split(',').length);

    assert.ok(sizes.every(n => n <= ACCEPTS),
        'second call should start at the learned size, not re-probe the ceiling');
    assert.ok(rejectionsFirst > sizes.length, 'first call paid the discovery cost');
    api.destroy();
});

test('the learned batch size survives a new session', async () => {
    const ACCEPTS = 25;
    const handler = (payload) => {
        const sent = payload.service_data.ids.split(',');
        if (sent.length > ACCEPTS) {
            throw Object.assign(new Error('Validation error: Too many uris requested'),
                { code: 'service_validation_error' });
        }
        return echoLiked(payload);
    };

    // First "page load" discovers the ceiling.
    const first = new SpotifyApi(fakeHass(handler), 'media_player.spotify');
    await first.checkTrackFavorites(ids(60));
    first.destroy();

    // A brand-new instance (i.e. after a reload) should not pay for it again.
    const hass2 = fakeHass(handler);
    const second = new SpotifyApi(hass2, 'media_player.spotify');
    await second.checkTrackFavorites(ids(60, 'b'));

    const sizes = hass2.calls.map(c => c.service_data.ids.split(',').length);
    assert.ok(sizes.every(n => n <= ACCEPTS),
        'a fresh instance should start from the persisted size, not re-probe');
    second.destroy();
});

test('a corrupt persisted limit falls back to the default', async () => {
    const hass = fakeHass(echoLiked);
    const api = new SpotifyApi(hass, 'media_player.spotify');
    // Simulate a garbage entry surviving from an older build.
    api._favoriteBatchSize = null;
    const { MetadataCache } = await import('../metadata-cache.js');
    new MetadataCache('api-limits').set('favorite-batch', 'not-a-number');

    await api.checkTrackFavorites(ids(10));

    assert.ok(hass.calls.length >= 1, 'still made the call');
    assert.ok(hass.calls[0].service_data.ids.split(',').length <= 50);
    api.destroy();
});

test('gives up rather than spinning if even the smallest batch is refused', async () => {
    const hass = fakeHass(() => {
        throw Object.assign(new Error('Validation error: Too many uris requested'),
            { code: 'service_validation_error' });
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    const result = await api.checkTrackFavorites(ids(20));

    assert.equal(result, null);
    assert.ok(hass.calls.length < 15, `made ${hass.calls.length} calls — should not spin`);
    api.destroy();
});

test('returns null only when every chunk fails', async () => {
    const hass = fakeHass(() => { throw new Error('nope'); });
    const api = new SpotifyApi(hass, 'media_player.spotify');
    assert.equal(await api.checkTrackFavorites(ids(10)), null);
    api.destroy();
});

test('search_all uses limit_total, never limit', async () => {
    // Per SpotifyPlus services.yaml, search_all accepts entity_id, criteria,
    // criteria_type, market, include_external and limit_total — no `limit`.
    // Sending `limit` fails with "extra keys not allowed @ data['limit']".
    const hass = fakeHass(() => ({ response: { result: {} } }));
    const api = new SpotifyApi(hass, 'media_player.spotify');

    await api.searchAll('daft punk');

    const sent = hass.calls[0].service_data;
    assert.equal(hass.calls[0].service, 'search_all');
    assert.equal(sent.criteria, 'daft punk');
    assert.equal('limit' in sent, false, 'search_all rejects a `limit` key outright');
    assert.ok(Number.isInteger(sent.limit_total), 'limit_total must be an integer');
    assert.ok(sent.limit_total >= 1 && sent.limit_total <= SpotifyApi.SEARCH_MAX_LIMIT);
    api.destroy();
});

test('every search wrapper clamps to the 1..10 SpotifyPlus range', async () => {
    const hass = fakeHass(() => ({ response: { result: { items: [] } } }));
    const api = new SpotifyApi(hass, 'media_player.spotify');
    const field = { search_all: 'limit_total' };

    const calls = [
        ['searchAll', (v) => api.searchAll('q', v)],
        ['searchTracks', (v) => api.searchTracks('q', v)],
        ['searchArtists', (v) => api.searchArtists('q', v)],
        ['searchPlaylists', (v) => api.searchPlaylists('q', v)],
    ];

    for (const [name, run] of calls) {
        for (const bad of [0, -5, 12, 20, 999, NaN, undefined, 'abc']) {
            hass.calls.length = 0;
            await run(bad);
            const call = hass.calls[0];
            const value = call.service_data[field[call.service] || 'limit'];
            assert.ok(Number.isInteger(value) && value >= 1 && value <= SpotifyApi.SEARCH_MAX_LIMIT,
                `${name}(${String(bad)}) sent ${value}, outside 1..${SpotifyApi.SEARCH_MAX_LIMIT}`);
        }
    }
    api.destroy();
});

test('search is user-priority, so it is not shed by failing background work', async () => {
    const hass = fakeHass((payload) => {
        if (payload.service === 'get_track') {
            throw Object.assign(new Error('Connection lost'), { code: 3 });
        }
        return { response: { result: { artists: { items: [] } } } };
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
        api.fetchSpotifyPlus('get_track', { track_id: `t${i}` })));
    assert.equal(api.governorStats.open, true);

    const res = await api.searchAll('daft punk');
    assert.ok(res?.result, 'a search the user just typed must still go out');
    api.destroy();
});

test('reads are held to the governor concurrency cap', async () => {
    let active = 0, peak = 0;
    const hass = fakeHass(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        return { response: { result: {} } };
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    await Promise.all(Array.from({ length: 12 }, (_, i) =>
        api.fetchSpotifyPlus('get_track', { track_id: `t${i}` })));

    assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
    assert.equal(hass.calls.length, 12);
    api.destroy();
});

test('a sustained failure trips the breaker instead of hammering the socket', async () => {
    const hass = fakeHass(() => { throw Object.assign(new Error('Connection lost'), { code: 3 }); });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    // 40 background reads, the shape of a pager fanning out over a dead socket.
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        api.fetchSpotifyPlus('get_track', { track_id: `t${i}` })));

    assert.ok(results.every(r => r === null), 'failed reads resolve to null as before');
    // Ceiling is failureThreshold (5) plus whatever was already in flight when
    // it tripped (maxConcurrent, 3). The point is that it's a small constant,
    // not the 40 the card would previously have pushed onto a dead socket.
    assert.ok(hass.calls.length <= 8,
        `${hass.calls.length} calls reached hass; the breaker should have stopped the burst`);
    assert.equal(api.governorStats.open, true);
    api.destroy();
});

test('page navigation still gets through while background reads are failing', async () => {
    let failBackground = true;
    const hass = fakeHass((payload) => {
        // Artwork lookups fail; the album the user tapped would succeed.
        if (payload.service === 'get_track' && failBackground) {
            throw Object.assign(new Error('Connection lost'), { code: 3 });
        }
        return { response: { result: { name: 'An Album' } } };
    });
    const api = new SpotifyApi(hass, 'media_player.spotify');

    // Background artwork enrichment fails enough to trip the breaker.
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
        api.fetchSpotifyPlus('get_track', { track_id: `t${i}` })));
    assert.equal(api.governorStats.open, true, 'breaker should be open');

    // A background read is refused outright...
    assert.equal(await api.fetchSpotifyPlus('get_album', { album_id: 'x' }), null);

    // ...but the same read as user-initiated navigation probes and succeeds.
    const res = await api.fetchForUser('get_album', { album_id: 'x' });
    assert.equal(res?.result?.name, 'An Album',
        'tapping an album must not be starved by failing background work');
    api.destroy();
});

test('shed calls do not open the device picker', async () => {
    const hass = fakeHass(() => { throw Object.assign(new Error('Connection lost'), { code: 3 }); });
    let reportedErrors = 0;
    const api = new SpotifyApi(hass, 'media_player.spotify', null, null, null, () => { reportedErrors++; });

    await Promise.all(Array.from({ length: 40 }, (_, i) =>
        api.fetchSpotifyPlus('get_track', { track_id: `t${i}` })));

    assert.equal(reportedErrors, 0, 'background reads must never surface the device picker');
    api.destroy();
});
