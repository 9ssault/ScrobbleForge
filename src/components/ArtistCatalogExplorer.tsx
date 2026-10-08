import React, { useState, useRef } from 'react';
import {
  Disc,
  Music,
  Search,
  ListMusic,
  PlusCircle,
  Zap,
  Clock,
  Layers,
  ChevronRight,
  ExternalLink,
  CheckCircle,
} from 'lucide-react';
import { QueueTrack } from '../types';

interface ArtistCatalogExplorerProps {
  apiKey: string;
  onAddTracksToQueue: (tracks: QueueTrack[]) => void;
  onInstantBatchScrobble: (tracks: QueueTrack[], spanHours: number) => Promise<boolean>;
  onStartStreamingQueue: (tracks: QueueTrack[], loop: boolean) => Promise<void>;
}

export const ArtistCatalogExplorer: React.FC<ArtistCatalogExplorerProps> = ({
  apiKey,
  onAddTracksToQueue,
  onInstantBatchScrobble,
  onStartStreamingQueue,
}) => {
  const albumRequest = useRef(0);
  const searchRequest = useRef(0);
  const [loadedArtist, setLoadedArtist] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [artistQuery, setArtistQuery] = useState('rvaia');
  const [activeTab, setActiveTab] = useState<'tracks' | 'albums'>('tracks');
  const [isLoading, setIsLoading] = useState(false);
  const [artistTracks, setArtistTracks] = useState<QueueTrack[]>([]);
  const [artistAlbums, setArtistAlbums] = useState<any[]>([]);

  // Selected Album details
  const [selectedAlbumName, setSelectedAlbumName] = useState<string | null>(null);
  const [albumTracklist, setAlbumTracklist] = useState<QueueTrack[]>([]);
  const [isLoadingAlbum, setIsLoadingAlbum] = useState(false);
  const [albumArt, setAlbumArt] = useState<string | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSearchArtist = async (targetArtist?: string) => {
    const artist = (targetArtist || artistQuery).trim();
    if (!artist) return;
    if (!apiKey) { setStatusMessage('Connect Last.fm before exploring a catalog.'); return; }
    const request = ++searchRequest.current; ++albumRequest.current;
    setIsLoading(true);
    setStatusMessage(null);
    setArtistTracks([]); setArtistAlbums([]); setLoadedArtist(artist);
    setSelectedAlbumName(null);
    setAlbumTracklist([]);

    try {
      // 1. Fetch Top Tracks
      const tracksRes = await fetch(
        `/api/lastfm/fetch-artist-tracks?artist=${encodeURIComponent(artist)}&limit=60&apiKey=${apiKey}`
      );
      const tracksData = await tracksRes.json();
      if (request !== searchRequest.current) return;
      if (tracksData.ok && tracksData.tracks) {
        setArtistTracks(tracksData.tracks);
      }

      // 2. Fetch Top Albums
      const albumsRes = await fetch(
        `/api/lastfm/fetch-artist-albums?artist=${encodeURIComponent(artist)}&limit=24&apiKey=${apiKey}`
      );
      const albumsData = await albumsRes.json();
      if (request !== searchRequest.current) return;
      if (albumsData.ok && albumsData.albums) {
        setArtistAlbums(albumsData.albums);
      }

      if (!tracksData.ok || !albumsData.ok) { setStatusMessage(tracksData.error || albumsData.error || 'Some catalog results could not be loaded.'); return; }
      setStatusMessage(
        `Loaded artist catalog for "${artist}": ${tracksData.tracks?.length || 0} top tracks & ${albumsData.albums?.length || 0} albums.`
      );
    } catch (e: any) {
      if (request === searchRequest.current) setStatusMessage(`Error fetching artist: ${e.message}`);
    } finally {
      if (request === searchRequest.current) setIsLoading(false);
    }
  };

  const handleSelectAlbum = async (albumName: string) => {
    if (!loadedArtist || !apiKey) return;
    setAlbumTracklist([]); setAlbumArt(null);
    const request = ++albumRequest.current;
    setSelectedAlbumName(albumName);
    setIsLoadingAlbum(true);

    try {
      const res = await fetch(
        `/api/lastfm/fetch-album-tracks?artist=${encodeURIComponent(
          loadedArtist
        )}&album=${encodeURIComponent(albumName)}&apiKey=${apiKey}`
      );
      const data = await res.json();
      if (request !== albumRequest.current) return;
      if (data.ok && data.tracks) {
        setAlbumTracklist(data.tracks);
        setAlbumArt(data.image || null);
        setStatusMessage(
          `Loaded full album "${albumName}" (${data.tracks.length} tracks in track order).`
        );
      } else {
        setStatusMessage(`Could not load album tracklist: ${data.error}`);
      }
    } catch (e: any) {
      if (request === albumRequest.current) setStatusMessage(`Error loading album: ${e.message}`);
    } finally {
      if (request === albumRequest.current) setIsLoadingAlbum(false);
    }
  };

  const handleScrobbleAllArtistTracks = async () => {
    if (artistTracks.length === 0) return;
    if (batchSubmitting) return; setBatchSubmitting(true);
    setStatusMessage(`Submitting all ${artistTracks.length} tracks for ${artistQuery}...`);
    const ok = await onInstantBatchScrobble(artistTracks, 24);
    setBatchSubmitting(false);
    if (!ok) setStatusMessage('Batch was not fully accepted. See the activity journal.');
    if (ok) {
      setStatusMessage(`🎉 Successfully scrobbled all ${artistTracks.length} tracks!`);
    }
  };

  const handleScrobbleFullAlbum = async () => {
    if (albumTracklist.length === 0) return;
    if (batchSubmitting) return; setBatchSubmitting(true);
    setStatusMessage(`Submitting full album "${selectedAlbumName}" (${albumTracklist.length} tracks)...`);
    const ok = await onInstantBatchScrobble(albumTracklist, 2);
    setBatchSubmitting(false);
    if (!ok) setStatusMessage('Batch was not fully accepted. See the activity journal.');
    if (ok) {
      setStatusMessage(`🎉 Successfully scrobbled full album "${selectedAlbumName}"!`);
    }
  };

  return (
    <div className="studio-panel overflow-hidden p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2">
            <Disc className="w-5 h-5 text-red-500" />
            <h3 className="text-base font-bold text-zinc-100">
              Artist Discography & Full Album Scrobbler
            </h3>
          </div>
          <p className="text-xs text-zinc-400 mt-0.5">
            Explore full artist pages, complete album tracklists in original order, and scrobble everything in one click.
          </p>
        </div>
      </div>

      {/* Artist Search Bar */}
      <div className="flex items-center space-x-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-3 text-zinc-500" />
          <input
            aria-label="Artist name to explore"
            type="text"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearchArtist()}
            placeholder="Enter any artist name (e.g. rvaia, SZA, The Weeknd, Daft Punk)..."
            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs font-medium text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-red-500"
          />
        </div>
        <button
          type="button"
          disabled={isLoading || !artistQuery.trim()}
          onClick={() => handleSearchArtist()}
          className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-medium shadow-md shadow-red-950/50 transition-all disabled:opacity-50"
        >
          {isLoading ? 'Exploring...' : 'Search Artist'}
        </button>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-xs font-mono text-zinc-300">
          {statusMessage}
        </div>
      )}

      {/* Tabs: Artist Top Tracks vs Top Albums */}
      <div className="flex flex-wrap gap-3 items-center justify-between border-b border-zinc-800 pb-2">
        <div className="flex space-x-1 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
          <button
            type="button"
            onClick={() => setActiveTab('tracks')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              activeTab === 'tracks'
                ? 'bg-red-600 text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Top Tracks ({artistTracks.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('albums')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              activeTab === 'albums'
                ? 'bg-red-600 text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Albums & Discography ({artistAlbums.length})
          </button>
        </div>

        {activeTab === 'tracks' && artistTracks.length > 0 && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onAddTracksToQueue(artistTracks)}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition-colors"
            >
              + Queue All Top Tracks
            </button>
            <button
              disabled={batchSubmitting}
              onClick={handleScrobbleAllArtistTracks}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg shadow-md transition-colors"
            >
              ⚡ Scrobble All Artist Tracks
            </button>
          </div>
        )}
      </div>

      {/* Tab Content: Top Tracks */}
      {activeTab === 'tracks' && (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {artistTracks.length === 0 ? (
            <div className="py-12 text-center text-zinc-500 text-xs italic">
              Search for an artist above to browse top tracks.
            </div>
          ) : (
            artistTracks.map((item, idx) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-850 hover:bg-zinc-850/40 rounded-xl transition-all"
              >
                <div className="flex items-center space-x-3 min-w-0 pr-2">
                  <span className="text-zinc-500 font-mono text-xs w-5 text-center">
                    {idx + 1}
                  </span>
                  <div className="w-9 h-9 rounded-lg bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                    {item.image ? (
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Music className="w-4 h-4 text-zinc-600" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-zinc-200 truncate">
                      {item.name}
                    </p>
                    <p className="text-[11px] text-zinc-400 truncate">
                      {item.artist}
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2 shrink-0">
                  {item.playcount && (
                    <span className="text-[10px] font-mono text-zinc-500 hidden sm:inline">
                      {parseInt(String(item.playcount), 10).toLocaleString()} plays
                    </span>
                  )}
                  <button
                    onClick={() => onAddTracksToQueue([item])}
                    className="p-1.5 text-zinc-400 hover:text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-xs transition-colors"
                    title="Add to queue"
                  >
                    + Queue
                  </button>
                  <button
                    onClick={() => onInstantBatchScrobble([item], 1)}
                    className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
                  >
                    Scrobble 1x
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab Content: Albums Grid */}
      {activeTab === 'albums' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 gap-3 max-h-72 overflow-y-auto pr-1">
            {artistAlbums.length === 0 ? (
              <div className="col-span-full py-12 text-center text-zinc-500 text-xs italic">
                Search for an artist above to browse discography.
              </div>
            ) : (
              artistAlbums.map((album, idx) => (
                <div
                  key={idx}
                  role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handleSelectAlbum(album.name); } }}
                  onClick={() => handleSelectAlbum(album.name)}
                  className={`p-2.5 rounded-xl border cursor-pointer transition-all flex flex-col group ${
                    selectedAlbumName === album.name
                      ? 'bg-zinc-800 border-red-500 shadow-lg shadow-red-950/40'
                      : 'bg-zinc-950/60 border-zinc-800/80 hover:bg-zinc-850 hover:border-zinc-700'
                  }`}
                >
                  <div className="aspect-square rounded-lg bg-zinc-850 overflow-hidden relative mb-2 flex items-center justify-center">
                    {album.image ? (
                      <img
                        src={album.image}
                        alt={album.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        loading="lazy"
                      />
                    ) : (
                      <Disc className="w-8 h-8 text-zinc-600" />
                    )}
                  </div>
                  <p className="text-xs font-semibold text-zinc-200 truncate group-hover:text-red-400 transition-colors">
                    {album.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 truncate mt-0.5">
                    {album.playcount ? `${parseInt(album.playcount, 10).toLocaleString()} plays` : 'Album'}
                  </p>
                </div>
              ))
            )}
          </div>

          {/* Selected Album Tracklist Inspector */}
          {selectedAlbumName && (
            <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl space-y-4 animate-in fade-in">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                <div className="flex items-center space-x-3">
                  {albumArt && (
                    <img
                      src={albumArt}
                      alt={selectedAlbumName}
                      className="w-12 h-12 rounded-lg object-cover border border-zinc-800 shrink-0"
                    />
                  )}
                  <div>
                    <h4 className="text-sm font-bold text-zinc-100">{selectedAlbumName}</h4>
                    <p className="text-xs text-zinc-400">
                      {albumTracklist.length} tracks in official tracklist sequence
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => onAddTracksToQueue(albumTracklist)}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition-colors"
                  >
                    + Add Album to Queue
                  </button>
                  <button
                    disabled={batchSubmitting || isLoadingAlbum || !albumTracklist.length}
                    onClick={handleScrobbleFullAlbum}
                    className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg shadow-md transition-colors flex items-center space-x-1.5"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>Scrobble Full Album</span>
                  </button>
                </div>
              </div>

              {/* Album track rows */}
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {isLoadingAlbum ? (
                  <div className="py-8 text-center text-zinc-500 text-xs">
                    Loading tracklist from Last.fm...
                  </div>
                ) : (
                  albumTracklist.map((track, idx) => (
                    <div
                      key={track.id}
                      className="flex items-center justify-between p-1.5 hover:bg-zinc-900/60 rounded text-xs text-zinc-300"
                    >
                      <div className="flex items-center space-x-2 truncate">
                        <span className="font-mono text-[10px] text-zinc-500 w-5">
                          {idx + 1}.
                        </span>
                        <span className="font-medium text-zinc-200">{track.name}</span>
                        <span className="text-zinc-500 text-[11px]">— {track.artist}</span>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500">
                        {track.duration ? `${Math.floor(track.duration / 60)}:${(track.duration % 60).toString().padStart(2, '0')}` : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
