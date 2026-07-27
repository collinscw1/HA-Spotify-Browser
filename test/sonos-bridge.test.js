import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonosBridge } from '../components/devices/sonos-bridge.js';
import { ConfigParser } from '../config_parser.js';

/*
 * Fixture mirrors a real installation where the entity ids drifted from the
 * friendly names after speakers were moved between rooms:
 *   media_player.kitchen        -> "Kitchen"
 *   media_player.living_room    -> "TV Room"      (id is a leftover)
 *   media_player.unnamed_room   -> "Living Room"  (stale, unavailable ghost)
 *   media_player.unnamed_room_2 -> "Living Room"  (the live stereo pair)
 * Two entities share the friendly name "Living Room", and the ghost is listed
 * first — exactly the ambiguity auto-detection cannot resolve on its own.
 */
function fakeHass(overrides = {}) {
    const states = {
        'media_player.kitchen': {
            state: 'paused',
            attributes: { friendly_name: 'Kitchen', group_members: ['media_player.kitchen'] },
        },
        'media_player.living_room': {
            state: 'idle',
            attributes: { friendly_name: 'TV Room', group_members: ['media_player.living_room'] },
        },
        'media_player.unnamed_room': {
            state: 'unavailable',
            attributes: { friendly_name: 'Living Room', restored: true },
        },
        'media_player.unnamed_room_2': {
            state: 'idle',
            attributes: { friendly_name: 'Living Room', group_members: ['media_player.unnamed_room_2'] },
        },
        'media_player.spotifyplus_chris': {
            state: 'idle',
            attributes: { friendly_name: 'SpotifyPlus Chris' },
        },
        ...overrides,
    };
    const entities = {
        'media_player.kitchen': { platform: 'sonos' },
        'media_player.living_room': { platform: 'sonos' },
        'media_player.unnamed_room': { platform: 'sonos' },
        'media_player.unnamed_room_2': { platform: 'sonos' },
        'media_player.spotifyplus_chris': { platform: 'spotifyplus' },
    };
    return { states, entities };
}

/** Build a bridge from real YAML-shaped config, through the real parser. */
function bridgeFor(sonosConfig, hass = fakeHass()) {
    const cfg = ConfigParser.parse({
        entity: 'media_player.spotifyplus_chris',
        sonos: sonosConfig,
    });
    return new SonosBridge(hass, cfg.sonos);
}

/** The mapping from the deployed dashboard config. */
const DEVICE_MAP = [
    { spotify: 'Kitchen', entity: 'media_player.kitchen', is_sonos: true },
    { spotify: 'Living Room', entity: 'media_player.unnamed_room_2', is_sonos: true },
    { spotify: 'TV Room', entity: 'media_player.living_room', is_sonos: true },
];

const enabled = (extra = {}) => bridgeFor({ enabled: true, device_map: DEVICE_MAP, ...extra });

/* ------------------------- group coordinator ---------------------------- */

test('coordinatorFor reads the modern group_members attribute', () => {
    const hass = fakeHass({
        'media_player.living_room': {
            state: 'playing',
            attributes: {
                friendly_name: 'TV Room',
                // Kitchen is coordinating a group that TV Room joined.
                group_members: ['media_player.kitchen', 'media_player.living_room'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, device_map: DEVICE_MAP }, hass);

    assert.equal(bridge.coordinatorFor('media_player.living_room'), 'media_player.kitchen');
});

test('coordinatorFor still honours the legacy sonos_group attribute', () => {
    const hass = fakeHass({
        'media_player.living_room': {
            state: 'playing',
            attributes: {
                friendly_name: 'TV Room',
                sonos_group: ['media_player.kitchen', 'media_player.living_room'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, device_map: DEVICE_MAP }, hass);

    assert.equal(bridge.coordinatorFor('media_player.living_room'), 'media_player.kitchen');
});

test('coordinatorFor returns the entity itself when it is the coordinator', () => {
    const hass = fakeHass({
        'media_player.kitchen': {
            state: 'playing',
            attributes: {
                friendly_name: 'Kitchen',
                group_members: ['media_player.kitchen', 'media_player.living_room'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, device_map: DEVICE_MAP }, hass);

    assert.equal(bridge.coordinatorFor('media_player.kitchen'), 'media_player.kitchen');
});

test('coordinatorFor returns the entity when ungrouped or unknown', () => {
    const bridge = enabled();
    assert.equal(bridge.coordinatorFor('media_player.kitchen'), 'media_player.kitchen');
    assert.equal(bridge.coordinatorFor('media_player.unnamed_room'), 'media_player.unnamed_room');
    assert.equal(bridge.coordinatorFor('media_player.nope'), 'media_player.nope');
    assert.equal(bridge.coordinatorFor(null), null);
});

/* ---------------------- explicit is_sonos override ----------------------- */

test('an explicit is_sonos:false rules Sonos out despite a fuzzy name match', () => {
    // "Google Living room" is a Chromecast. Its name substring-matches the
    // "Living Room" Sonos speaker, so the heuristics would claim it.
    const bridge = enabled({
        device_map: [...DEVICE_MAP, { spotify: 'Google Living room', is_sonos: false }],
    });

    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Google Living room' }), false);
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Google Kitchen Display' }), true,
        'unmapped Google devices still fall through to the heuristics');
});

test('without the override, a Chromecast is misdetected as Sonos', () => {
    // Documents exactly why the override is needed — this is the old behaviour.
    const bridge = enabled();
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Google Living room' }), true);
});

test('is_sonos:true still forces Sonos handling', () => {
    const bridge = enabled();
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Kitchen' }), true);
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'TV Room' }), true);
});

test('an omitted is_sonos falls through to auto-detection', () => {
    const bridge = enabled({
        device_map: [{ spotify: 'Kitchen', entity: 'media_player.kitchen' }],
    });
    // No explicit flag, but the resolved entity is on the sonos platform.
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Kitchen' }), true);
    // And a genuinely non-Sonos device is still rejected.
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'PS5-539' }), false);
});

test('the parser keeps is_sonos tri-state', () => {
    const cfg = ConfigParser.parse({
        entity: 'media_player.spotifyplus_chris',
        sonos: {
            enabled: true,
            device_map: [
                { spotify: 'A', entity: 'media_player.a', is_sonos: true },
                { spotify: 'B', entity: 'media_player.b', is_sonos: false },
                { spotify: 'C', entity: 'media_player.c' },
            ],
        },
    });
    assert.equal(cfg.sonos.device_map[0].is_sonos, true);
    assert.equal(cfg.sonos.device_map[1].is_sonos, false, 'explicit false must survive parsing');
    assert.equal(cfg.sonos.device_map[2].is_sonos, null, 'omitted must be distinguishable from false');
});

/* ------------------------- entity resolution ----------------------------- */

test('an explicit mapping wins over an ambiguous friendly name', () => {
    const bridge = enabled();
    // Two entities are named "Living Room"; the unavailable ghost is listed
    // first, so auto-detection alone could pick it.
    assert.equal(
        bridge.resolveSonosEntity(null, { sp_device_name: 'Living Room' }),
        'media_player.unnamed_room_2'
    );
});

test('entity ids that disagree with room names still resolve correctly', () => {
    const bridge = enabled();
    assert.equal(
        bridge.resolveSonosEntity(null, { sp_device_name: 'TV Room' }),
        'media_player.living_room'
    );
    assert.equal(
        bridge.resolveSonosEntity(null, { sp_device_name: 'Kitchen' }),
        'media_player.kitchen'
    );
});

/* --------------------- prefer_sonos content check ------------------------ */

const SPOTIFY_CONTENT = 'x-sonos-spotify:spotify%3atrack%3a5HQVUIKwCEXpe7JIHyY734?sid=12';
const TV_CONTENT = 'x-sonos-htastream:RINCON_XXXXXXXX:spdif';

test('prefer_sonos ignores a soundbar playing TV audio', () => {
    const hass = fakeHass({
        'media_player.living_room': {
            state: 'playing',
            attributes: {
                friendly_name: 'TV Room',
                media_title: 'TV',
                media_content_id: TV_CONTENT,
                group_members: ['media_player.living_room'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, prefer_sonos: true, device_map: DEVICE_MAP }, hass);

    // No mapped speaker is playing Spotify, so fall through to Connect detection.
    assert.deepEqual(bridge.activeTarget({}), { isSonos: false, entity: null });
});

test('prefer_sonos still adopts a speaker playing Spotify', () => {
    const hass = fakeHass({
        'media_player.kitchen': {
            state: 'playing',
            attributes: {
                friendly_name: 'Kitchen',
                media_title: 'Young, Wild & Free',
                media_content_id: SPOTIFY_CONTENT,
                group_members: ['media_player.kitchen'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, prefer_sonos: true, device_map: DEVICE_MAP }, hass);

    assert.deepEqual(bridge.activeTarget({}), { isSonos: true, entity: 'media_player.kitchen' });
});

test('prefer_sonos picks the Spotify speaker over a louder TV soundbar', () => {
    const hass = fakeHass({
        // Listed third, but it's the one actually playing Spotify.
        'media_player.living_room': {
            state: 'playing',
            attributes: {
                friendly_name: 'TV Room',
                media_title: 'TV',
                media_content_id: TV_CONTENT,
                group_members: ['media_player.living_room'],
            },
        },
        'media_player.unnamed_room_2': {
            state: 'playing',
            attributes: {
                friendly_name: 'Living Room',
                media_title: 'Some Song',
                media_content_id: SPOTIFY_CONTENT,
                group_members: ['media_player.unnamed_room_2'],
            },
        },
    });
    const bridge = bridgeFor({ enabled: true, prefer_sonos: true, device_map: DEVICE_MAP }, hass);

    assert.deepEqual(bridge.activeTarget({}),
        { isSonos: true, entity: 'media_player.unnamed_room_2' });
});

test('a disabled bridge is inert', () => {
    const bridge = bridgeFor({ enabled: false, device_map: DEVICE_MAP });
    assert.equal(bridge.isSonosTarget(null, { sp_device_name: 'Kitchen' }), false);
    assert.deepEqual(bridge.activeTarget({ sp_device_name: 'Kitchen' }), { isSonos: false, entity: null });
});
