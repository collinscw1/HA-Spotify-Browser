import { mapLimit } from '../../utils.js';

/**
 * Builds the "Made For You" item list from the home.made_for_you config.
 * Shared by the home screen carousel and the "See All" section view.
 *
 * Config entries may be:
 *  - { likedsongs: true }
 *  - { playlists_recommended: [{ id, title }] }  (cover image fetched per playlist)
 *  - { playlists: ['playlistId', ...] }
 *  - 'playlistId' (raw string)
 *  - a full item object with an id
 */
/**
 * Collapses a recent-tracks history list into unique albums
 * (keeping the most recent track's name/artists per album).
 */
export function dedupeRecentAlbums(historyItems = []) {
    const seenAlbumIds = new Set();
    const uniqueItems = [];
    historyItems.forEach(h => {
        if (h.track && h.track.album && !seenAlbumIds.has(h.track.album.id)) {
            seenAlbumIds.add(h.track.album.id);
            uniqueItems.push({ ...h.track.album, name: h.track.name, artists: h.track.artists, type: 'album', uri: h.track.album.uri });
        }
    });
    return uniqueItems;
}

export async function loadMadeForYouItems(api, config) {
    const configList = config?.home?.made_for_you?.content;
    if (!api || !Array.isArray(configList) || configList.length === 0) return [];

    const items = [];

    for (const entry of configList) {
        if (entry.likedsongs) {
            items.push({
                id: 'me-liked', type: 'likedsongs', name: 'Liked Songs', subtitle: 'Your Favorites',
                uri: 'spotify:user:me:collection', images: [{ url: 'https://t.scdn.co/images/3099b3803ad9496896c43f22fe9be8c4.png' }]
            });
        }
        else if (entry.playlists_recommended && Array.isArray(entry.playlists_recommended)) {
            // Rate-limited: a long made_for_you list would otherwise put one
            // call per entry on the shared HA WebSocket simultaneously.
            const results = await mapLimit(entry.playlists_recommended, 4, async (mfy) => {
                const res = await api.fetchSpotifyPlus('get_playlist_cover_image', { playlist_id: mfy.id });
                const imgUrl = (res && res.result && res.result.url) ? res.result.url : '';
                return {
                    id: mfy.id, type: 'playlist-recommended', name: mfy.title,
                    uri: `spotify:playlist:${mfy.id}`,
                    images: [{ url: imgUrl }],
                    owner: { display_name: 'Spotify' }
                };
            });
            items.push(...results.filter(Boolean));
        }
        else if (entry.playlists && Array.isArray(entry.playlists)) {
            const results = await mapLimit(entry.playlists, 4,
                id => api.fetchSpotifyPlus('get_playlist', { playlist_id: id }));
            items.push(...results.filter(res => res && res.result).map(res => res.result));
        }
        else if (typeof entry === 'string') {
            try {
                const res = await api.fetchSpotifyPlus('get_playlist', { playlist_id: entry });
                if (res && res.result) items.push(res.result);
            } catch (e) { }
        }
        else if (typeof entry === 'object' && entry.id) {
            items.push(entry);
        }
    }

    return items;
}
