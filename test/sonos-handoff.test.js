import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonosBridge } from '../components/devices/sonos-bridge.js';
import { SpotifyApi } from '../api.js';
import { ConfigParser } from '../config_parser.js';

/*
 * sonos.follow_sonos_card: the sonos-card's CTA hands over its selected
 * speaker/group, and launches go there without the device picker.
 */

const SPOTIFY_CONTENT = 'x-sonos-spotify:spotify%3atrack%3a5HQVUIKwCEXpe7JIHyY734?sid=12';
const TV_CONTENT = 'x-sonos-htastream:RINCON_XXXXXXXX:spdif';

const DEVICE_MAP = [
    { spotify: 'Kitchen', entity: 'media_player.kitchen', is_sonos: true },
    { spotify: 'Living Room', entity: 'media_player.unnamed_room_2', is_sonos: true },
    { spotify: 'TV Room', entity: 'media_player.living_room', is_sonos: true },
];

const speaker = (friendly_name, state = 'idle', extra = {}) => ({
    state,
    attributes: { friendly_name, ...extra },
});

/** hass double that records every service call, by both call styles. */
function fakeHass(states = {}) {
    const calls = [];
    return {
        calls,
        states: {
            'media_player.kitchen': speaker('Kitchen'),
            'media_player.unnamed_room_2': speaker('Living Room'),
            'media_player.living_room': speaker('TV Room'),
            'media_player.office': speaker('Office'),
            'media_player.spotifyplus_chris': speaker('SpotifyPlus Chris'),
            ...states,
        },
        entities: {},
        connection: { connected: true, addEventListener() {}, removeEventListener() {} },
        async callService(domain, service, data) { calls.push({ domain, service, ...data }); },
        async callWS(payload) {
            calls.push({ domain: payload.domain, service: payload.service, ...payload.service_data });
            return {};
        },
    };
}

/** Service calls that do the work — scans are bookkeeping. */
const launches = (hass) => hass.calls.filter(c => c.service !== 'trigger_scan_interval');

function bridgeFor(sonos, hass) {
    const cfg = ConfigParser.parse({ entity: 'media_player.spotifyplus_chris', sonos });
    return new SonosBridge(hass, cfg.sonos);
}

const following = (hass, extra = {}) =>
    bridgeFor({ enabled: true, follow_sonos_card: true, prefer_sonos: true, device_map: DEVICE_MAP, ...extra }, hass);

/** An API whose resolver fails the test if it is ever consulted. */
function apiFor(hass, bridge) {
    const resolver = () => assert.fail('device picker must not be consulted during a handoff');
    const api = new SpotifyApi(hass, 'media_player.spotifyplus_chris', resolver, { fallback: 30 });
    api.setSonosBridge(bridge);
    return api;
}

/* ------------------------------ the bridge ------------------------------- */

test('follow_sonos_card is off by default and the handoff is then ignored', () => {
    const bridge = bridgeFor({ enabled: true, device_map: DEVICE_MAP }, fakeHass());
    bridge.setHandoff('media_player.kitchen');
    assert.equal(bridge.handoffTarget, null);
});

test('a handoff is ignored while the bridge itself is disabled', () => {
    const bridge = bridgeFor({ enabled: false, follow_sonos_card: true }, fakeHass());
    bridge.setHandoff('media_player.kitchen');
    assert.equal(bridge.handoffTarget, null);
});

test('the handed-off speaker beats prefer_sonos order while it plays Spotify', () => {
    const hass = fakeHass({
        // Kitchen is listed first in device_map and also playing Spotify.
        'media_player.kitchen': speaker('Kitchen', 'playing', { media_title: 'A', media_content_id: SPOTIFY_CONTENT }),
        'media_player.living_room': speaker('TV Room', 'paused', { media_title: 'B', media_content_id: SPOTIFY_CONTENT }),
    });
    const bridge = following(hass);
    bridge.setHandoff('media_player.living_room');
    assert.deepEqual(bridge.activeTarget({}), { isSonos: true, entity: 'media_player.living_room' });
});

test('a handed-off soundbar on TV audio does not hijack now-playing', () => {
    const hass = fakeHass({
        'media_player.kitchen': speaker('Kitchen', 'playing', { media_title: 'A', media_content_id: SPOTIFY_CONTENT }),
        'media_player.living_room': speaker('TV Room', 'playing', { media_title: 'TV', media_content_id: TV_CONTENT }),
    });
    const bridge = following(hass);
    bridge.setHandoff('media_player.living_room');
    assert.deepEqual(bridge.activeTarget({}), { isSonos: true, entity: 'media_player.kitchen' });
});

test('spotifyDeviceFor prefers the device_map name, else the room name', () => {
    const bridge = following(fakeHass());
    assert.equal(bridge.spotifyDeviceFor('media_player.unnamed_room_2'), 'Living Room');
    assert.equal(bridge.spotifyDeviceFor('media_player.office'), 'Office');
});

/* ------------------------------ playMedia -------------------------------- */

test('a playlist launches locally on the handoff speaker, with no picker and no default volume', async () => {
    const hass = fakeHass();
    const bridge = following(hass);
    bridge.setHandoff('media_player.kitchen');

    const res = await apiFor(hass, bridge).playMedia('spotify:playlist:abc', 'playlist');

    assert.equal(res.success, true);
    assert.deepEqual(launches(hass), [{
        domain: 'media_player', service: 'play_media', entity_id: 'media_player.kitchen',
        media_content_id: 'spotify:playlist:abc', media_content_type: 'playlist', enqueue: 'replace',
    }]);
    assert.equal(bridge.activeTarget({}).entity, 'media_player.kitchen', 'launch grace keeps it the target');
});

test('a grouped handoff plays on the group coordinator', async () => {
    const hass = fakeHass({
        'media_player.kitchen': speaker('Kitchen', 'idle', {
            group_members: ['media_player.kitchen', 'media_player.unnamed_room_2'],
        }),
    });
    const bridge = following(hass);
    bridge.setHandoff('media_player.kitchen');

    await apiFor(hass, bridge).playMedia('spotify:album:xyz', 'album');

    assert.equal(launches(hass)[0].entity_id, 'media_player.kitchen');
});

test('the handoff wins even when SpotifyPlus is active on another device', async () => {
    const hass = fakeHass({
        'media_player.spotifyplus_chris': speaker('SpotifyPlus Chris', 'playing', { sp_device_name: 'Chris iPhone' }),
    });
    const bridge = following(hass);
    bridge.setHandoff('media_player.living_room');

    await apiFor(hass, bridge).playMedia('spotify:album:xyz', 'album');

    assert.equal(launches(hass)[0].entity_id, 'media_player.living_room');
});

test('a single track goes to the speaker locally', async () => {
    const hass = fakeHass();
    const bridge = following(hass);
    bridge.setHandoff('media_player.kitchen');

    await apiFor(hass, bridge).playMedia('spotify:track:t1', 'track');

    assert.deepEqual(launches(hass), [{
        domain: 'media_player', service: 'play_media', entity_id: 'media_player.kitchen',
        media_content_id: 'spotify:track:t1', media_content_type: 'music', enqueue: 'play',
    }]);
});

test('an artist (no local form) falls back to SpotifyPlus, naming the speaker', async () => {
    const hass = fakeHass();
    const bridge = following(hass);
    bridge.setHandoff('media_player.unnamed_room_2');

    await apiFor(hass, bridge).playMedia('spotify:artist:a1', 'artist');

    const [call] = launches(hass);
    assert.equal(call.service, 'player_media_play_context');
    assert.equal(call.context_uri, 'spotify:artist:a1');
    assert.equal(call.device_id, 'Living Room');
});

test('an explicit device pick still bypasses the handoff', async () => {
    const hass = fakeHass();
    const bridge = following(hass);
    bridge.setHandoff('media_player.kitchen');

    await apiFor(hass, bridge).playMedia('spotify:track:t1', 'track', 'some-device-id');

    const [call] = launches(hass);
    assert.equal(call.service, 'player_media_play_tracks');
    assert.equal(call.device_id, 'some-device-id');
});
