import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Lock,
  Key,
  User,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
} from 'lucide-react';
import { LastFmCredentials } from '../types';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  credentials: LastFmCredentials;
  onSaveCredentials: (creds: LastFmCredentials) => Promise<boolean>;
  isConnected: boolean;
  onDisconnect: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  credentials,
  onSaveCredentials,
  isConnected,
  onDisconnect,
}) => {
  const [apiKey, setApiKey] = useState(credentials.apiKey || '');
  const [apiSecret, setApiSecret] = useState(credentials.apiSecret || '');
  const [username, setUsername] = useState(credentials.username || '');
  const [password, setPassword] = useState(credentials.password || '');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    setApiKey(credentials.apiKey || ''); setUsername(credentials.username || ''); setPassword(''); setError(null); setSuccess(null);
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const node = dialog.current;
    node?.querySelector<HTMLInputElement>('input')?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onClose();
      if (e.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a, input, select')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [isOpen]);
  if (!isOpen) return null;

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      const ok = await onSaveCredentials({
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        username: username.trim(),
        password: password,
      });

      setPassword('');
      setApiSecret('');
      if (ok) {
        setSuccess('Successfully authenticated with Last.fm!');
        onClose();
      } else {
        setError('Authentication failed. Please verify your API Key, Shared Secret, username, and password.');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to authenticate.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="auth-heading" className="max-h-[90dvh] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/60">
          <div className="flex items-center space-x-2">
            <Shield className="w-5 h-5 text-red-500" />
            <h3 id="auth-heading" className="font-semibold text-zinc-100 text-base">Last.fm API Credentials</h3>
          </div>
          <button
            aria-label="Close account settings"
            disabled={loading}
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleFormSubmit} className="p-6 space-y-4">
          <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex items-start justify-between text-xs text-zinc-400">
            <div className="space-y-1">
              <p className="font-medium text-zinc-300 flex items-center space-x-1.5">
                <Info className="w-3.5 h-3.5 text-red-400" />
                <span>Need Last.fm API keys?</span>
              </p>
              <p className="text-zinc-400 leading-relaxed text-[11px]">
                You can create a free API account in 1 minute. No credit card required.
              </p>
            </div>
            <a
              href="https://www.last.fm/api/account/create"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium border border-zinc-700 transition-colors shrink-0 ml-3"
            >
              <span>Create Key</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {error && (
            <div className="p-3 bg-red-950/50 border border-red-900/60 rounded-xl text-xs text-red-300 flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="p-3 bg-emerald-950/50 border border-emerald-900/60 rounded-xl text-xs text-emerald-300 flex items-start space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{success}</span>
            </div>
          )}

<p className="text-[11px] text-zinc-500 leading-relaxed">Passwords, secrets, and session keys are not saved in browser storage or activity records. Reconnect after reloading. This personal server forwards credentials to Last.fm over HTTPS.</p>
          <div className="space-y-3">
            <div>
              <label htmlFor="auth-key" className="block text-xs font-medium text-zinc-400 mb-1">
                Last.fm API Key
              </label>
              <div className="relative">
                <Key className="w-4 h-4 absolute left-3 top-3 text-zinc-500" />
                <input
                  id="auth-key"
                  type="text"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste your 32-character API key"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                Last.fm API Secret
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-3 text-zinc-500" />
                <input
                  aria-label="Last.fm shared secret"
                  autoComplete="off"
                  type="password"
                  required
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Paste your API shared secret"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Last.fm Username
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3 top-3 text-zinc-500" />
                  <input
                    aria-label="Last.fm username"
                    autoComplete="username"
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Your Last.fm username"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  Last.fm Password
                </label>
                <div className="relative">
                  <input
                    aria-label="Last.fm password"
                    autoComplete="current-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-3 pr-9 py-2 text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-300"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between border-t border-zinc-800 mt-4">
            {isConnected ? (
              <button
                type="button"
                onClick={onDisconnect}
                className="text-xs text-zinc-400 hover:text-red-400 transition-colors"
              >
                Disconnect Account
              </button>
            ) : <div />}

            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-5 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-xl shadow-lg shadow-red-950/50 transition-all flex items-center space-x-2 disabled:opacity-50"
              >
                {loading ? (
                  <span>Authenticating...</span>
                ) : (
                  <span>Authenticate & Connect</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
