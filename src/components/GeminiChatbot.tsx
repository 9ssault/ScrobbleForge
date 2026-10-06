import React, { useState, useRef, useEffect } from 'react';
import {
  Bot,
  Send,
  Sparkles,
  Trash2,
  PlusCircle,
  Zap,
  ListMusic,
  RotateCcw,
  Music,
  Radio,
  Cpu,
  Flame,
  Lightbulb,
} from 'lucide-react';
import { QueueTrack, RecentTrack } from '../types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  modelUsed?: string;
  suggestedTracks?: Array<{ artist: string; name: string; album?: string }>;
}

interface GeminiChatbotProps {
  onAddTracksToQueue: (tracks: QueueTrack[]) => void;
  onInstantBatchScrobble: (tracks: QueueTrack[], spanHours: number) => Promise<boolean>;
  activeTrack?: { artist: string; track: string; album?: string };
  recentTracks?: RecentTrack[];
  queueCount?: number;
}

export const GeminiChatbot: React.FC<GeminiChatbotProps> = ({
  onAddTracksToQueue,
  onInstantBatchScrobble,
  activeTrack,
  recentTracks = [],
  queueCount = 0,
}) => {
  // Model selector: gemini-3.5-flash (general), gemini-3.1-flash-lite (fast), gemini-3.1-pro-preview (complex)
  const [selectedModel, setSelectedModel] = useState<'gemini-3.5-flash' | 'gemini-3.1-flash-lite' | 'gemini-3.1-pro-preview'>('gemini-3.5-flash');
  const [selectedRole, setSelectedRole] = useState<'curator' | 'fast_recommender' | 'analyst'>('curator');
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem('scrobbleforge_chat_history');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [
      {
        id: 'initial-greeting',
        role: 'model',
        text: `Hey there! I'm **ScrobbleAI**, your music curator and Last.fm scrobbler copilot.\n\nAsk me for custom playlists, deep discography recommendations, or genre discoveries. Any tracks I suggest can be added directly to your Scrobble queue with one click!`,
        timestamp: Date.now(),
        modelUsed: 'gemini-3.5-flash',
      },
    ];
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Save conversation history to local storage
  useEffect(() => {
    try {
      localStorage.setItem('scrobbleforge_chat_history', JSON.stringify(messages));
    } catch {}
  }, [messages]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSendMessage = async (customPrompt?: string) => {
    const textToSend = (customPrompt || inputMessage).trim();
    if (!textToSend || isLoading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: textToSend,
      timestamp: Date.now(),
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInputMessage('');
    setIsLoading(true);

    try {
      // Prepare contextual metadata
      const context = {
        activeTrack: activeTrack?.track ? activeTrack : undefined,
        currentQueueCount: queueCount,
        recentListening: recentTracks.slice(0, 8).map((t) => ({
          name: t.name,
          artist: t.artist?.['#text'] || t.artist?.name,
        })),
      };

      const res = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newHistory.map((m) => ({ role: m.role, text: m.text })),
          model: selectedModel,
          role: selectedRole,
          context,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        const assistantMsg: ChatMessage = {
          id: `model-${Date.now()}`,
          role: 'model',
          text: data.text,
          timestamp: Date.now(),
          modelUsed: data.modelUsed,
          suggestedTracks: data.suggestedTracks,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        const errorMsg: ChatMessage = {
          id: `error-${Date.now()}`,
          role: 'model',
          text: `⚠️ **Error**: ${data.error || 'Failed to get a response from Gemini.'}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'model',
        text: `⚠️ **Network Error**: ${err.message || 'Could not reach server'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearHistory = () => {
    const fresh: ChatMessage[] = [
      {
        id: `greeting-${Date.now()}`,
        role: 'model',
        text: `Chat history cleared. How can I help you curate your next scrobbles?`,
        timestamp: Date.now(),
        modelUsed: selectedModel,
      },
    ];
    setMessages(fresh);
    localStorage.removeItem('scrobbleforge_chat_history');
  };

  const handleQueueAllSuggested = (tracks?: Array<{ artist: string; name: string; album?: string }>) => {
    if (!tracks || tracks.length === 0) return;
    const mapped: QueueTrack[] = tracks.map((t, idx) => ({
      id: `ai-${t.name}-${idx}-${Date.now()}`,
      name: t.name,
      artist: t.artist,
      album: t.album || '',
      duration: 210,
    }));
    onAddTracksToQueue(mapped);
  };

  const handleScrobbleAllSuggested = (tracks?: Array<{ artist: string; name: string; album?: string }>) => {
    if (!tracks || tracks.length === 0) return;
    const mapped: QueueTrack[] = tracks.map((t, idx) => ({
      id: `ai-scrobble-${t.name}-${idx}-${Date.now()}`,
      name: t.name,
      artist: t.artist,
      album: t.album || '',
      duration: 210,
    }));
    onInstantBatchScrobble(mapped, 2);
  };

  const quickPrompts = [
    'Recommend 8 modern synthwave tracks like Daft Punk',
    'Suggest 10 chill R&B songs similar to SZA & Frank Ocean',
    'Build a 12-track French House playlist',
    'What should I scrobble next based on my recent history?',
  ];

  return (
    <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-[620px]">
      {/* Header & Model/Role Selectors */}
      <div className="px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/60 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center text-white shadow-md shadow-red-950/50">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-bold text-zinc-100">ScrobbleAI</h3>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-red-950/80 text-red-400 border border-red-900">
                Gemini
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Music discovery copilot & queue generator
            </p>
          </div>
        </div>

        {/* Model & Role Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Model Selector */}
          <div className="flex items-center space-x-1 p-0.5 bg-zinc-950 rounded-lg border border-zinc-800 text-[11px]">
            <button
              onClick={() => setSelectedModel('gemini-3.5-flash')}
              className={`px-2 py-1 rounded font-medium transition-colors ${
                selectedModel === 'gemini-3.5-flash'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="General tasks: Balanced speed and musical knowledge"
            >
              Flash (General)
            </button>
            <button
              onClick={() => setSelectedModel('gemini-3.1-flash-lite')}
              className={`px-2 py-1 rounded font-medium transition-colors ${
                selectedModel === 'gemini-3.1-flash-lite'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Fast tasks: Ultra rapid responses"
            >
              Lite (Fast)
            </button>
            <button
              onClick={() => setSelectedModel('gemini-3.1-pro-preview')}
              className={`px-2 py-1 rounded font-medium transition-colors ${
                selectedModel === 'gemini-3.1-pro-preview'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Complex tasks: In-depth music analysis & deep catalog curation"
            >
              Pro (Complex)
            </button>
          </div>

          <button
            onClick={handleClearHistory}
            className="p-1.5 text-zinc-400 hover:text-red-400 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded-lg transition-colors"
            title="Clear Chat History"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Message Thread */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4 font-sans text-xs">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';

          return (
            <div
              key={msg.id}
              className={`flex items-start space-x-3 ${isUser ? 'flex-row-reverse space-x-reverse' : ''}`}
            >
              {/* Avatar */}
              <div
                className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center text-xs font-semibold ${
                  isUser
                    ? 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                    : 'bg-red-950/80 text-red-400 border border-red-800/80'
                }`}
              >
                {isUser ? 'You' : <Sparkles className="w-3.5 h-3.5" />}
              </div>

              {/* Message Bubble */}
              <div
                className={`max-w-[85%] rounded-2xl p-3.5 space-y-2 leading-relaxed ${
                  isUser
                    ? 'bg-red-600 text-white shadow-md shadow-red-950/40 rounded-tr-none'
                    : 'bg-zinc-950/90 border border-zinc-800/90 text-zinc-200 rounded-tl-none shadow-sm'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.text}</div>

                {/* Structured Track Recommendations Card */}
                {msg.suggestedTracks && msg.suggestedTracks.length > 0 && (
                  <div className="mt-3 p-3 bg-zinc-900 border border-zinc-750 rounded-xl space-y-2 text-zinc-300">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                      <span className="font-semibold text-zinc-100 flex items-center space-x-1.5 text-xs">
                        <Music className="w-3.5 h-3.5 text-red-400" />
                        <span>Recommended Tracks ({msg.suggestedTracks.length})</span>
                      </span>

                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleQueueAllSuggested(msg.suggestedTracks)}
                          className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[11px] font-medium border border-zinc-700 flex items-center space-x-1"
                        >
                          <PlusCircle className="w-3 h-3" />
                          <span>Queue All</span>
                        </button>
                        <button
                          onClick={() => handleScrobbleAllSuggested(msg.suggestedTracks)}
                          className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded-lg text-[11px] font-medium shadow-sm flex items-center space-x-1"
                        >
                          <Zap className="w-3 h-3" />
                          <span>Scrobble All</span>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1 max-h-36 overflow-y-auto">
                      {msg.suggestedTracks.map((t, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-1.5 rounded hover:bg-zinc-850 text-[11px]"
                        >
                          <div className="truncate pr-2">
                            <span className="font-medium text-zinc-200">{t.name}</span>
                            <span className="text-zinc-500"> — {t.artist}</span>
                          </div>
                          <button
                            onClick={() =>
                              onAddTracksToQueue([
                                {
                                  id: `single-ai-${t.name}-${Date.now()}`,
                                  name: t.name,
                                  artist: t.artist,
                                  album: t.album || '',
                                  duration: 210,
                                },
                              ])
                            }
                            className="text-red-400 hover:underline shrink-0"
                          >
                            + Queue
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Footer metadata */}
                {!isUser && msg.modelUsed && (
                  <div className="pt-1 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                    <span>Generated by {msg.modelUsed}</span>
                    <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div className="flex items-start space-x-3">
            <div className="w-7 h-7 rounded-lg bg-red-950/80 text-red-400 border border-red-800/80 flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5 animate-spin" />
            </div>
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl rounded-tl-none p-3.5 text-zinc-400 flex items-center space-x-2">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
              <span>ScrobbleAI is curating recommendations...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Prompts Bar */}
      <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-950/40 flex items-center space-x-2 overflow-x-auto">
        <span className="text-[10px] font-mono text-zinc-500 shrink-0">Ideas:</span>
        {quickPrompts.map((p, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => handleSendMessage(p)}
            className="text-[10px] px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 transition-colors shrink-0"
          >
            {p}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSendMessage();
        }}
        className="p-3 border-t border-zinc-800 bg-zinc-950 flex items-center space-x-2"
      >
        <input
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder={`Ask ScrobbleAI for music recommendations, playlists, or album breakdowns (${selectedModel})...`}
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-red-500"
        />
        <button
          type="submit"
          disabled={isLoading || !inputMessage.trim()}
          className="p-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl shadow-md transition-colors disabled:opacity-50 shrink-0"
          title="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
