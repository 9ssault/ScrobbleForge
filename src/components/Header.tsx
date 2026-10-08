import React from 'react';
import { Radio, ExternalLink, Key, RefreshCw, UserCheck, ShieldAlert } from 'lucide-react';
import { LastFmUser } from '../types';

interface HeaderProps {
  user: LastFmUser | null;
  isConnected: boolean;
  onOpenAuth: () => void;
  onRefreshUser: () => void;
  isRefreshingUser: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  isConnected,
  onOpenAuth,
  onRefreshUser,
  isRefreshingUser,
}) => {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 min-h-18 py-3 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center shadow-lg shadow-red-950/40 text-white">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-base sm:text-lg text-zinc-100 tracking-tight">
                Scrobble<span className="text-red-500">Forge</span>
              </span>
              <span className="hidden sm:inline text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-red-950/60 text-red-400 border border-red-900/40">
                STUDIO
              </span>
            </div>
            <p className="text-xs text-zinc-400 hidden sm:block">
              A clearer view of your listening history
            </p>
          </div>
        </div>

        {/* User Account / Auth Status */}
        <div className="flex items-center space-x-3">
          {isConnected && user ? (
            <div className="flex items-center space-x-2 bg-zinc-900/90 border border-zinc-800 rounded-xl p-1.5 pr-3 shadow-inner">
              {user.image?.[1]?.['#text'] ? (
                <img
                  src={user.image[1]['#text']}
                  alt={user.name}
                  className="w-8 h-8 rounded-lg object-cover border border-zinc-700"
                />
              ) : (
                <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-300 font-bold text-xs uppercase">
                  {user.name.slice(0, 2)}
                </div>
              )}
              <div className="text-left hidden sm:block">
                <div className="flex items-center space-x-1.5">
                  <span className="text-xs font-semibold text-zinc-200">
                    {user.name}
                  </span>
                  <a
                    href={user.url || `https://www.last.fm/user/${user.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-500 hover:text-red-400 transition-colors"
                    title="View Profile on Last.fm"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="text-[11px] text-zinc-400 font-mono flex items-center space-x-1">
                  <span>{parseInt(user.playcount || '0', 10).toLocaleString()} scrobbles</span>
                </div>
              </div>
              <button
                aria-label="Refresh Last.fm profile"
                onClick={onRefreshUser}
                disabled={isRefreshingUser}
                className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
                title="Refresh Last.fm Stats"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isRefreshingUser ? 'animate-spin text-red-400' : ''}`}
                />
              </button>
              <button
                onClick={onOpenAuth}
                className="px-2.5 py-1 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
              >
                Settings
              </button>
            </div>
          ) : (
            <button
              onClick={onOpenAuth}
              className="flex items-center space-x-2 px-3.5 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-xl shadow-md shadow-red-900/30 transition-all hover:scale-[1.02]"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Connect Last.fm</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
