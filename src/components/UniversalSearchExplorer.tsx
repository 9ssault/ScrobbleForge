import React, { useState, useRef } from 'react';
import {
  Search,
  User,
  Disc,
  Music,
  PlusCircle,
  Zap,
  ExternalLink,
  Users,
  CheckCircle,
  Clock,
  Radio,
  ChevronRight,
} from 'lucide-react';
import { QueueTrack } from '../types';

interface UniversalSearchExplorerProps {
  apiKey: string;
  onAddTracksToQueue: (tracks: QueueTrack[]) => void;
  onInstantBatchScrobble: (tracks: QueueTrack[], spanHours: number) => Promise<boolean>;
  onStartStreamingQueue: (tracks: QueueTrack[], loop: boolean) => Promise<void>;
}

export const UniversalSearchExplorer: React.FC<UniversalSearchExplorerProps> = ({
  apiKey,
  onAddTracksToQueue,
  onInstantBatchScrobble,
  onStartStreamingQueue,
}) => {
  const searchRequest = useRef(0);
  const entityRequest = useRef(0);
  const [searchTarget, setSearchTarget] = useState<'user' | 'artist' | 'album' | 'track'>('artist');
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Search Results State
  const [artistResults, setArtistResults] = useState<any[]>([]);
  const [albumResults, setAlbumResults] = useState<any[]>([]);
  const [trackResults, setTrackResults] = useState<any[]>([]);
  const [userResult, setUserResult] = useState<any | null>(null);

  // Expanded Drilldown state (e.g. selected album tracklist or artist tracks)
  const [selectedEntityTitle, setSelectedEntityTitle] = useState<string | null>(null);
  const [entityTracks, setEntityTracks] = useState<QueueTrack[]>([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;
    if (!apiKey) { setFeedback('Connect Last.fm to search the catalog.'); return; }

    const request = ++searchRequest.current;
    ++entityRequest.current;
    setIsLoading(true);
    setFeedback(null);
    setSelectedEntityTitle(null);
    setEntityTracks([]);
    setArtistResults([]); setAlbumResults([]); setTrackResults([]); setUserResult(null);

    try {
      if (searchTarget === 'user') {
        const res = await fetch(
          `/api/lastfm/search-user?username=${encodeURIComponent(query.trim())}&apiKey=${apiKey}`
        );
        const data = await res.json();
        if (request !== searchRequest.current) return;
        if (data.ok && data.user) {
          setUserResult({ ...data.user, recentTracks: data.recentTracks || [] });
          setFeedback(`Found Last.fm user @${data.user.name}`);
        } else {
          setUserResult(null);
          setFeedback(`User not found: ${data.error || 'Please check username'}`);
        }
      } else if (searchTarget === 'artist') {
        const res = await fetch(
          `/api/lastfm/search-artist?query=${encodeURIComponent(query.trim())}&apiKey=${apiKey}`
        );
        const data = await res.json();
        if (request !== searchRequest.current) return;
        if (data.ok && data.artists) {
          setArtistResults(data.artists);
          setFeedback(`Found ${data.artists.length} artists matching "${query}"`);
        } else {
          setArtistResults([]);
          setFeedback(data.error || 'No matching artists found.');
        }
      } else if (searchTarget === 'album') {
        const res = await fetch(
          `/api/lastfm/search-album?query=${encodeURIComponent(query.trim())}&apiKey=${apiKey}`
        );
        const data = await res.json();
        if (request !== searchRequest.current) return;
        if (data.ok && data.albums) {
          setAlbumResults(data.albums);
          setFeedback(`Found ${data.albums.length} albums matching "${query}"`);
        } else {
          setAlbumResults([]);
          setFeedback(data.error || 'No matching albums found.');
        }
      } else if (searchTarget === 'track') {
        const res = await fetch(
          `/api/lastfm/search?track=${encodeURIComponent(query.trim())}&apiKey=${apiKey}`
        );
        const data = await res.json();
        if (request !== searchRequest.current) return;
        if (data.ok && data.tracks) {
          const list = Array.isArray(data.tracks) ? data.tracks : [data.tracks];
          setTrackResults(list);
          setFeedback(`Found ${list.length} tracks matching "${query}"`);
        } else {
          setTrackResults([]);
          setFeedback(data.error || 'No matching tracks found.');
        }
      }
    } catch (err: any) {
      if (request === searchRequest.current) setFeedback(`Search error: ${err.message}`);
    } finally {
      if (request === searchRequest.current) setIsLoading(false);
    }
  };

  // Inspect Album to load tracklist
  const handleInspectAlbum = async (artist: string, album: string) => {
    const request = ++entityRequest.current;
    setIsLoadingEntity(true);
    setEntityTracks([]);
    setSelectedEntityTitle(`Album: ${album} by ${artist}`);
    try {
      const res = await fetch(
        `/api/lastfm/fetch-album-tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&apiKey=${apiKey}`
      );
      const data = await res.json();
      if (request !== entityRequest.current) return;
      if (data.ok && data.tracks) {
        setEntityTracks(data.tracks);
        setFeedback(`Loaded ${data.tracks.length} tracks from album "${album}"`);
      } else {
        setEntityTracks([]);
        setFeedback('Could not fetch album tracks.');
      }
    } catch (err: any) {
      if (request === entityRequest.current) setFeedback(`Error: ${err.message}`);
    } finally {
      if (request === entityRequest.current) setIsLoadingEntity(false);
    }
  };

  // Inspect Artist to load top tracks
  const handleInspectArtist = async (artistName: string) => {
    const request = ++entityRequest.current;
    setIsLoadingEntity(true);
    setEntityTracks([]);
    setSelectedEntityTitle(`Artist: ${artistName} (Top Tracks)`);
    try {
      const res = await fetch(
        `/api/lastfm/fetch-artist-tracks?artist=${encodeURIComponent(artistName)}&limit=40&apiKey=${apiKey}`
      );
      const data = await res.json();
      if (request !== entityRequest.current) return;
      if (data.ok && data.tracks) {
        setEntityTracks(data.tracks);
        setFeedback(`Loaded ${data.tracks.length} top tracks for ${artistName}`);
      } else {
        setEntityTracks([]);
        setFeedback('Could not fetch artist tracks.');
      }
    } catch (err: any) {
      if (request === entityRequest.current) setFeedback(`Error: ${err.message}`);
    } finally {
      if (request === entityRequest.current) setIsLoadingEntity(false);
    }
  };

  return (
    <div className="studio-panel overflow-hidden p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2">
            <Search className="w-5 h-5 text-red-500" />
            <h3 className="text-base font-bold text-zinc-100">
              Universal Search & Scrobbler
            </h3>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Search any User profile, Artist discography, Album, or Track across Last.fm and scrobble from them immediately.
          </p>
        </div>
      </div>

      {/* Target Selector Bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
        <button
          type="button"
          onClick={() => {
            ++searchRequest.current; ++entityRequest.current; setIsLoading(false); setIsLoadingEntity(false); setSelectedEntityTitle(null); setEntityTracks([]);
            setSearchTarget('user');
            setQuery('');
            setFeedback(null);
          }}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            searchTarget === 'user'
              ? 'bg-red-600 text-white shadow-md'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <User className="w-3.5 h-3.5" />
          <span>User Profile</span>
        </button>

        <button
          type="button"
          onClick={() => {
            ++searchRequest.current; ++entityRequest.current; setIsLoading(false); setIsLoadingEntity(false); setSelectedEntityTitle(null); setEntityTracks([]);
            setSearchTarget('artist');
            setQuery('');
            setFeedback(null);
          }}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            searchTarget === 'artist'
              ? 'bg-red-600 text-white shadow-md'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Artist</span>
        </button>

        <button
          type="button"
          onClick={() => {
            ++searchRequest.current; ++entityRequest.current; setIsLoading(false); setIsLoadingEntity(false); setSelectedEntityTitle(null); setEntityTracks([]);
            setSearchTarget('album');
            setQuery('');
            setFeedback(null);
          }}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            searchTarget === 'album'
              ? 'bg-red-600 text-white shadow-md'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Disc className="w-3.5 h-3.5" />
          <span>Album</span>
        </button>

        <button
          type="button"
          onClick={() => {
            ++searchRequest.current; ++entityRequest.current; setIsLoading(false); setIsLoadingEntity(false); setSelectedEntityTitle(null); setEntityTracks([]);
            setSearchTarget('track');
            setQuery('');
            setFeedback(null);
          }}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            searchTarget === 'track'
              ? 'bg-red-600 text-white shadow-md'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Music className="w-3.5 h-3.5" />
          <span>Song / Track</span>
        </button>
      </div>

      {/* Search Input Form */}
      <form onSubmit={handleSearch} className="flex items-center space-x-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-3 text-zinc-500" />
          <input
            aria-label="Search Last.fm"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              searchTarget === 'user'
                ? 'Enter any Last.fm username...'
                : searchTarget === 'artist'
                ? 'Search any artist (e.g. SZA, Daft Punk, rvaia, The Weeknd)...'
                : searchTarget === 'album'
                ? 'Search any album name (e.g. SOS, Discovery, After Hours)...'
                : 'Search any track title...'
            }
            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-red-500"
          />
        </div>
        <button
          type="submit"
          disabled={isLoading || !query.trim()}
          className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-medium shadow-md shadow-red-950/50 transition-all disabled:opacity-50 shrink-0"
        >
          {isLoading ? 'Searching...' : `Search ${searchTarget.toUpperCase()}`}
        </button>
      </form>

      {/* Feedback message */}
      {feedback && (
        <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-xs font-mono text-zinc-300 flex items-center space-x-2">
          <Search className="w-4 h-4 text-zinc-400 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {/* TARGET 1: USER PROFILE RESULT */}
      {searchTarget === 'user' && userResult && (
        <div className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 space-y-4 animate-in fade-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-zinc-800">
            <div className="flex items-center space-x-3">
              {userResult.image?.[2]?.['#text'] ? (
                <img
                  src={userResult.image[2]['#text']}
                  alt={userResult.name}
                  className="w-12 h-12 rounded-xl object-cover border border-zinc-700"
                />
              ) : (
                <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center font-bold text-zinc-300">
                  {userResult.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div>
                <h4 className="text-sm font-bold text-zinc-100 flex items-center space-x-1.5">
                  <span>@{userResult.name}</span>
                  <a
                    href={userResult.url || `https://www.last.fm/user/${userResult.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-500 hover:text-red-400"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </h4>
                <p className="text-xs text-zinc-400 font-mono">
                  {parseInt(userResult.playcount || '0', 10).toLocaleString()} total scrobbles
                  {userResult.country ? ` · ${userResult.country}` : ''}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  const mapped: QueueTrack[] = (userResult.recentTracks || []).map((t: any, idx: number) => ({
                    id: `user-${t.name}-${idx}-${Date.now()}`,
                    name: t.name,
                    artist: t.artist?.['#text'] || t.artist?.name || 'Artist',
                    album: t.album?.['#text'] || '',
                    duration: 210,
                  }));
                  onAddTracksToQueue(mapped);
                  setFeedback(`Added ${mapped.length} recent songs from @${userResult.name} to Queue!`);
                }}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700"
              >
                + Queue Recents
              </button>

              <button
                onClick={() => {
                  const mapped: QueueTrack[] = (userResult.recentTracks || []).map((t: any, idx: number) => ({
                    id: `user-${t.name}-${idx}-${Date.now()}`,
                    name: t.name,
                    artist: t.artist?.['#text'] || t.artist?.name || 'Artist',
                    album: t.album?.['#text'] || '',
                    duration: 210,
                  }));
                  onInstantBatchScrobble(mapped, 24);
                }}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg shadow-md"
              >
                ⚡ Scrobble Recents
              </button>
            </div>
          </div>

          {/* User recent tracks preview */}
          <div className="space-y-1">
            <span className="text-[10px] uppercase font-mono text-zinc-500">Recent Plays:</span>
            {userResult.recentTracks?.map((t: any, idx: number) => (
              <div
                key={idx}
                className="flex items-center justify-between p-1.5 rounded hover:bg-zinc-900/60 text-xs text-zinc-300"
              >
                <div className="truncate">
                  <span className="font-medium text-zinc-200">{t.name}</span>
                  <span className="text-zinc-500 text-[11px]">
                    {' '}— {t.artist?.['#text'] || t.artist?.name}
                  </span>
                </div>
                <button
                  onClick={() => {
                    onInstantBatchScrobble(
                      [
                        {
                          id: `single-${Date.now()}`,
                          name: t.name,
                          artist: t.artist?.['#text'] || t.artist?.name,
                          album: t.album?.['#text'] || '',
                          duration: 210,
                        },
                      ],
                      1
                    );
                  }}
                  className="text-[11px] text-red-400 hover:underline shrink-0 ml-2"
                >
                  Scrobble 1x
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TARGET 2: ARTIST MATCHES */}
      {searchTarget === 'artist' && artistResults.length > 0 && !selectedEntityTitle && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-80 overflow-y-auto pr-1">
          {artistResults.map((artist, idx) => (
            <div
              key={idx}
              role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleInspectArtist(artist.name); } }}
              onClick={() => handleInspectArtist(artist.name)}
              className="p-3 bg-zinc-950/70 border border-zinc-800/80 hover:border-red-500/80 rounded-xl cursor-pointer transition-all flex items-center justify-between group hover:bg-zinc-850"
            >
              <div className="flex items-center space-x-3 min-w-0 pr-2">
                <div className="w-10 h-10 rounded-lg bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                  {artist.image ? (
                    <img src={artist.image} alt={artist.name} className="w-full h-full object-cover" />
                  ) : (
                    <Users className="w-5 h-5 text-zinc-600" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-zinc-200 truncate group-hover:text-red-400">
                    {artist.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 font-mono">
                    {parseInt(artist.listeners || '0', 10).toLocaleString()} listeners
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-200 shrink-0" />
            </div>
          ))}
        </div>
      )}

      {/* TARGET 3: ALBUM MATCHES */}
      {searchTarget === 'album' && albumResults.length > 0 && !selectedEntityTitle && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-80 overflow-y-auto pr-1">
          {albumResults.map((album, idx) => (
            <div
              key={idx}
              role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleInspectAlbum(album.artist, album.name); } }}
              onClick={() => handleInspectAlbum(album.artist, album.name)}
              className="p-2.5 bg-zinc-950/70 border border-zinc-800/80 hover:border-red-500/80 rounded-xl cursor-pointer transition-all flex flex-col group hover:bg-zinc-850"
            >
              <div className="aspect-square rounded-lg bg-zinc-800 overflow-hidden mb-2 flex items-center justify-center">
                {album.image ? (
                  <img src={album.image} alt={album.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                ) : (
                  <Disc className="w-8 h-8 text-zinc-600" />
                )}
              </div>
              <p className="text-xs font-semibold text-zinc-200 truncate group-hover:text-red-400">
                {album.name}
              </p>
              <p className="text-[10px] text-zinc-500 truncate">{album.artist}</p>
            </div>
          ))}
        </div>
      )}

      {/* TARGET 4: TRACK MATCHES */}
      {searchTarget === 'track' && trackResults.length > 0 && (
        <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {trackResults.map((track, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between p-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl text-xs hover:bg-zinc-850 transition-all"
            >
              <div className="min-w-0 pr-3">
                <p className="font-semibold text-zinc-200 truncate">{track.name}</p>
                <p className="text-[11px] text-zinc-400 truncate">{track.artist}</p>
              </div>

              <div className="flex items-center space-x-2 shrink-0">
                <button
                  onClick={() =>
                    onAddTracksToQueue([
                      {
                        id: `t-${track.name}-${Date.now()}`,
                        name: track.name,
                        artist: track.artist,
                        album: '',
                        duration: 210,
                      },
                    ])
                  }
                  className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700"
                >
                  + Queue
                </button>
                <button
                  onClick={() =>
                    onInstantBatchScrobble(
                      [
                        {
                          id: `t-${track.name}-${Date.now()}`,
                          name: track.name,
                          artist: track.artist,
                          album: '',
                          duration: 210,
                        },
                      ],
                      1
                    )
                  }
                  className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium shadow-md"
                >
                  Scrobble 1x
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* DRILLDOWN INSPECTOR (Loaded Album or Artist Tracks) */}
      {selectedEntityTitle && (
        <div className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 space-y-3 animate-in fade-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
            <div>
              <button
                onClick={() => { ++entityRequest.current; setSelectedEntityTitle(null); setIsLoadingEntity(false); }}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 underline mb-1"
              >
                ← Back to search results
              </button>
              <h4 className="text-sm font-bold text-zinc-100">{selectedEntityTitle}</h4>
              <p className="text-xs text-zinc-400">{entityTracks.length} tracks available</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                disabled={isLoadingEntity || entityTracks.length === 0}
                onClick={() => {
                  onAddTracksToQueue(entityTracks);
                  setFeedback(`Added all ${entityTracks.length} tracks to queue!`);
                }}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700"
              >
                + Queue All
              </button>

              <button
                onClick={() => onInstantBatchScrobble(entityTracks, 2)}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg shadow-md"
              >
                ⚡ Scrobble All ({entityTracks.length})
              </button>
            </div>
          </div>

          {/* Tracklist preview */}
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {isLoadingEntity ? (
              <div className="py-6 text-center text-zinc-500 text-xs">Loading tracks...</div>
            ) : (
              entityTracks.map((t, idx) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-1.5 hover:bg-zinc-900 rounded text-xs text-zinc-300"
                >
                  <div className="truncate">
                    <span className="font-mono text-[10px] text-zinc-500 mr-2">{idx + 1}.</span>
                    <span className="font-medium text-zinc-200">{t.name}</span>
                    <span className="text-zinc-500 text-[11px]"> — {t.artist}</span>
                  </div>
                  <button
                    onClick={() => onInstantBatchScrobble([t], 1)}
                    className="text-[11px] text-red-400 hover:underline shrink-0 ml-2"
                  >
                    Scrobble 1x
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
