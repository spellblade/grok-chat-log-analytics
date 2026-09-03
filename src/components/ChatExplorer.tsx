import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Conversation, Message } from '../types';
import MessageContent from './markdown/MessageContent';
import { linearizePath, cycleBranchChoice } from '../utils/branchTree';
import { formatThinkingTrace } from '../utils/formatThinking';
import {
  Search,
  Brain,
  Flame,
  Sparkles,
  MessageSquare,
  Trash2,
  ArrowLeft,
  Calendar,
  X,
  FileDown,
  ChevronLeft,
  ChevronRight,
  Download,
} from 'lucide-react';

interface ChatExplorerProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelectConversation: (id: string | null) => void;
  onDeleteConversation: (id: string) => void;
  onRetryRemoteImages?: (conversationId: string) => void;
  isDownloadingImages?: boolean;
}

export default function ChatExplorer({
  conversations,
  selectedId,
  onSelectConversation,
  onDeleteConversation,
  onRetryRemoteImages,
  isDownloadingImages = false,
}: ChatExplorerProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMode, setSelectedMode] = useState<string>('all');
  const [selectedModel, setSelectedModel] = useState<string>('all');
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [isReasoningExpanded, setIsReasoningExpanded] = useState<Record<string, boolean>>({});
  /** parentId → chosen child message id */
  const [branchChoices, setBranchChoices] = useState<Record<string, string>>({});

  const chatContainerRef = useRef<HTMLDivElement>(null);

  const uniqueModels = useMemo(() => {
    const models = new Set<string>();
    conversations.forEach((c) => {
      if (c.model) models.add(c.model);
    });
    return Array.from(models);
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      const matchesSearch =
        searchTerm === '' ||
        c.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.messages.some((m) => m.content.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesMode = selectedMode === 'all' || c.mode === selectedMode;
      const matchesModel = selectedModel === 'all' || c.model === selectedModel;
      return matchesSearch && matchesMode && matchesModel;
    });
  }, [conversations, searchTerm, selectedMode, selectedModel]);

  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedId) || null;
  }, [conversations, selectedId]);

  // Visible path through the message tree for the open chat
  const visibleMessages = useMemo(() => {
    if (!activeConversation) return [] as Message[];
    return linearizePath(activeConversation.messages, branchChoices);
  }, [activeConversation, branchChoices]);

  useEffect(() => {
    setChatSearchQuery('');
    setBranchChoices({});
    setIsReasoningExpanded({});
  }, [selectedId]);

  const toggleReasoning = (messageId: string) => {
    setIsReasoningExpanded((prev) => ({
      ...prev,
      [messageId]: !prev[messageId],
    }));
  };

  const handleBranchStep = (message: Message, direction: 1 | -1) => {
    if (!activeConversation || !message.parentId || !message.branchCount || message.branchCount <= 1) {
      return;
    }
    const parentId = message.parentId;
    const currentId = branchChoices[parentId] || message.id;
    const nextId = cycleBranchChoice(
      activeConversation.messages,
      parentId,
      currentId,
      direction
    );
    if (nextId) {
      setBranchChoices((prev) => ({ ...prev, [parentId]: nextId }));
    }
  };

  const handleExportTxt = (conv: Conversation) => {
    const path = linearizePath(conv.messages, branchChoices);
    let output = `=========================================\n`;
    output += `Title: ${conv.title}\n`;
    output += `Date: ${new Date(conv.createdAt).toLocaleString()}\n`;
    output += `Model: ${conv.model} (Mode: ${conv.mode})\n`;
    output += `=========================================\n\n`;

    path.forEach((m) => {
      output += `[${m.role.toUpperCase()}] ${m.senderName} (${m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ''}):\n`;
      if (m.isThink && m.thinkContent) {
        output += `--- Thought Process ---\n${formatThinkingTrace(m.thinkContent)}\n-----------------------\n`;
      }
      // Strip citation placeholders for plain text
      const plain = m.content.replace(/⟦cite:(\d+)⟧/g, '[$1]');
      output += `${plain}\n\n`;
      output += `-----------------------------------------\n\n`;
    });

    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${conv.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_transcript.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="grid grid-cols-1 lg:grid-cols-12 border border-elegant-border rounded-xl overflow-hidden bg-elegant-panel flex-1 h-full min-h-0 shadow-lg"
      id="chat-explorer-container"
    >
      {/* LEFT COLUMN: Sidebar */}
      <div
        className={`lg:col-span-3 h-full min-h-0 overflow-hidden border-r border-elegant-border flex flex-col bg-elegant-panel/95 ${selectedId ? 'hidden lg:flex' : 'flex'}`}
        id="chats-sidebar"
      >
        <div className="p-4 border-b border-elegant-border space-y-3.5 bg-elegant-panel" id="sidebar-filters">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-elegant-muted" />
            <input
              type="text"
              placeholder="Search chats & terms..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-elegant-dark border border-elegant-border rounded-lg pl-9 pr-4 py-2.5 text-xs text-white placeholder-elegant-muted focus:outline-none focus:border-elegant-gold transition-colors shadow-inner"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-3.5 text-elegant-muted hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5" id="filter-dropdowns">
            <div className="flex flex-col space-y-1">
              <label className="text-xxxs font-mono uppercase tracking-widest text-elegant-muted">Mode</label>
              <select
                value={selectedMode}
                onChange={(e) => setSelectedMode(e.target.value)}
                className="bg-elegant-dark border border-elegant-border rounded-md px-2.5 py-1.5 text-xxs font-mono uppercase tracking-wider text-elegant-text focus:outline-none focus:border-elegant-gold cursor-pointer"
              >
                <option value="all">All Modes</option>
                <option value="Normal">Normal</option>
                <option value="Think">Reasoning</option>
                <option value="Fun">Fun Mode</option>
                <option value="DeepSearch">DeepSearch</option>
              </select>
            </div>

            <div className="flex flex-col space-y-1">
              <label className="text-xxxs font-mono uppercase tracking-widest text-elegant-muted">Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-elegant-dark border border-elegant-border rounded-md px-2.5 py-1.5 text-xxs font-mono uppercase tracking-wider text-elegant-text focus:outline-none focus:border-elegant-gold cursor-pointer"
              >
                <option value="all">All Models</option>
                {uniqueModels.map((m, idx) => (
                  <option key={idx} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-elegant-border/70 bg-elegant-dark/20" id="chats-list-scroller">
          {filteredConversations.length === 0 ? (
            <div className="text-center py-20 text-elegant-muted px-4 space-y-2.5">
              <MessageSquare className="w-9 h-9 mx-auto stroke-1 opacity-40 text-elegant-gold" />
              <p className="text-xs font-display font-medium text-white uppercase tracking-wider">No chats found</p>
              <p className="text-xxs text-elegant-muted leading-relaxed max-w-xs mx-auto">
                Try adjusting your filters or search keywords to locate historical logs.
              </p>
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isActive = conv.id === selectedId;
              const dateStr = new Date(conv.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              });

              return (
                <div
                  key={conv.id}
                  onClick={() => onSelectConversation(conv.id)}
                  className={`p-4 cursor-pointer transition-all flex flex-col justify-between group relative select-none ${
                    isActive
                      ? 'bg-elegant-card border-l-3 border-elegant-gold shadow-md'
                      : 'hover:bg-elegant-hover/30 border-l-3 border-transparent'
                  }`}
                >
                  <div className="flex items-start justify-between space-x-2">
                    <h5
                      className={`text-xs font-semibold leading-snug line-clamp-2 ${
                        isActive ? 'text-white' : 'text-elegant-text group-hover:text-white'
                      }`}
                    >
                      {conv.title}
                    </h5>
                    <span className="text-xxs font-mono text-elegant-muted shrink-0">{dateStr}</span>
                  </div>

                  <p className="text-xxs text-elegant-muted line-clamp-1 my-2 leading-relaxed italic font-sans">
                    {conv.messages.find((m) => m.role === 'user')?.content || 'No messages'}
                  </p>

                  <div className="flex items-center justify-between mt-1 text-xxs font-mono text-elegant-muted uppercase">
                    <span className="flex items-center space-x-1.5 shrink-0">
                      {conv.mode === 'Think' && <Brain className="w-3 h-3 text-elegant-gold" />}
                      {conv.mode === 'Fun' && <Flame className="w-3 h-3 text-elegant-gold" />}
                      {conv.mode === 'DeepSearch' && <Sparkles className="w-3 h-3 text-elegant-gold" />}
                      {conv.mode === 'Normal' && <MessageSquare className="w-3 h-3 text-elegant-muted" />}
                      <span className="truncate max-w-[130px] font-semibold">{conv.model}</span>
                    </span>

                    <span className="shrink-0 bg-elegant-dark/60 border border-elegant-border px-1.5 py-0.25 rounded text-[10px]">
                      {conv.stats.messageCount} msg
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {(searchTerm || selectedMode !== 'all' || selectedModel !== 'all') && (
          <div className="p-3.5 border-t border-elegant-border bg-elegant-dark/50 text-center">
            <button
              onClick={() => {
                setSearchTerm('');
                setSelectedMode('all');
                setSelectedModel('all');
              }}
              className="text-xxs font-mono font-bold uppercase tracking-wider text-elegant-gold hover:text-elegant-gold-light hover:underline cursor-pointer"
            >
              Reset Filters ({filteredConversations.length} showing)
            </button>
          </div>
        )}
      </div>

      {/* RIGHT COLUMN: Transcript */}
      <div
        className={`lg:col-span-9 h-full min-h-0 overflow-hidden flex flex-col bg-elegant-dark ${!selectedId ? 'hidden lg:flex' : 'flex'}`}
        id="chat-transcripts-viewer"
      >
        {activeConversation ? (
          <div className="flex flex-col h-full overflow-hidden" id="active-chat-subcontainer">
            <div
              className="p-4 border-b border-elegant-border bg-elegant-panel flex items-center justify-between shrink-0"
              id="chat-header"
            >
              <div className="flex items-center space-x-3.5 min-w-0">
                <button
                  onClick={() => onSelectConversation(null)}
                  className="lg:hidden p-1.5 hover:bg-elegant-hover border border-elegant-border text-elegant-muted hover:text-white rounded-md cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>

                <div className="min-w-0">
                  <h4
                    className="text-sm font-display font-semibold text-white leading-snug truncate tracking-wide"
                    title={activeConversation.title}
                  >
                    {activeConversation.title}
                  </h4>
                  <div className="flex items-center space-x-2.5 mt-1 text-xxs font-mono text-elegant-muted uppercase tracking-wider">
                    <span className="flex items-center">
                      <Calendar className="w-3 h-3 mr-1 text-elegant-gold" />
                      {new Date(activeConversation.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                    <span>•</span>
                    <span className="text-elegant-gold font-bold">{activeConversation.model}</span>
                    <span>•</span>
                    <span>Mode: {activeConversation.mode}</span>
                    {activeConversation.titleSource === 'export' && (
                      <>
                        <span>•</span>
                        <span className="text-elegant-gold/70">Named by Grok</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-2" id="chat-header-actions">
                {onRetryRemoteImages && (
                  <button
                    onClick={() => onRetryRemoteImages(activeConversation.id)}
                    disabled={isDownloadingImages}
                    title="Retry downloading remote image URLs for this chat (save if OK, leave unchanged if fail)"
                    className="p-2 hover:bg-elegant-hover border border-elegant-border hover:text-elegant-gold text-elegant-muted rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}

                <button
                  onClick={() => handleExportTxt(activeConversation)}
                  title="Export plaintext transcript"
                  className="p-2 hover:bg-elegant-hover border border-elegant-border hover:text-elegant-gold text-elegant-muted rounded-lg transition-colors cursor-pointer"
                >
                  <FileDown className="w-4 h-4" />
                </button>

                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Are you sure you want to delete this chat history? This cannot be undone.'
                      )
                    ) {
                      onDeleteConversation(activeConversation.id);
                    }
                  }}
                  title="Delete chat log"
                  className="p-2 hover:bg-elegant-hover border border-elegant-border hover:text-red-400 text-elegant-muted rounded-lg transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div
              className="bg-elegant-panel border-b border-elegant-border px-4 py-2.5 flex items-center shrink-0 justify-between"
              id="chat-inner-search-bar"
            >
              <div className="relative flex-1 max-w-sm">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-elegant-muted" />
                <input
                  type="text"
                  placeholder="Find keywords in this transcript..."
                  value={chatSearchQuery}
                  onChange={(e) => setChatSearchQuery(e.target.value)}
                  className="w-full bg-elegant-dark border border-elegant-border rounded-md pl-8 pr-7 py-1.5 text-xxs text-white placeholder-elegant-muted focus:outline-none focus:border-elegant-gold transition-colors"
                />
                {chatSearchQuery && (
                  <button
                    onClick={() => setChatSearchQuery('')}
                    className="absolute right-2.5 top-2.5 text-elegant-muted hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {chatSearchQuery && (
                <span className="text-xxs font-mono text-elegant-gold uppercase tracking-wider text-[10px]">
                  Highlighting matching terms
                </span>
              )}
            </div>

            <div
              ref={chatContainerRef}
              className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth bg-elegant-dark"
              id="chat-messages-thread"
            >
              {visibleMessages.map((message) => {
                const isUser = message.role === 'user';
                const isExpanded = !!isReasoningExpanded[message.id];
                const showBranch =
                  !!message.branchCount &&
                  message.branchCount > 1 &&
                  !!message.parentId;

                return (
                  <div
                    key={message.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <span className="text-xxs font-mono text-elegant-muted mb-1.5 px-1.5 flex items-center space-x-1.5 uppercase tracking-wider">
                      <span className={isUser ? 'font-bold text-white/80' : 'font-bold text-elegant-gold'}>
                        {message.senderName}
                      </span>
                      {message.timestamp && (
                        <>
                          <span>•</span>
                          <span>
                            {new Date(message.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </>
                      )}
                    </span>

                    <div className="max-w-[90%] md:max-w-[85%] w-full flex flex-col">
                      {showBranch && (
                        <div className="mb-2 flex items-center gap-1 self-start">
                          <button
                            type="button"
                            onClick={() => handleBranchStep(message, -1)}
                            className="p-1 rounded border border-elegant-border bg-elegant-panel text-elegant-muted hover:text-elegant-gold hover:border-elegant-gold/40 cursor-pointer"
                            title="Previous branch"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-elegant-gold bg-elegant-panel border border-elegant-border rounded">
                            {(message.branchIndex ?? 0) + 1} / {message.branchCount}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleBranchStep(message, 1)}
                            className="p-1 rounded border border-elegant-border bg-elegant-panel text-elegant-muted hover:text-elegant-gold hover:border-elegant-gold/40 cursor-pointer"
                            title="Next branch"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}

                      {message.isThink && message.thinkContent && (
                        <div className="mb-2.5 border border-elegant-gold/20 bg-elegant-gold/5 rounded-lg overflow-hidden max-w-xl self-start shadow-sm">
                          <button
                            onClick={() => toggleReasoning(message.id)}
                            className="w-full px-3.5 py-2 flex items-center justify-between text-xxs font-mono text-elegant-gold hover:text-white bg-elegant-gold/10 hover:bg-elegant-gold/15 transition-colors cursor-pointer uppercase tracking-wider"
                          >
                            <span className="flex items-center space-x-1.5">
                              <Brain className="w-3.5 h-3.5 animate-pulse" />
                              <span>Thought Process</span>
                            </span>
                            <span className="font-bold underline">
                              {isExpanded ? 'Collapse' : 'Expand'}
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="p-3.5 bg-elegant-panel text-elegant-gold/90 text-xxs border-t border-elegant-gold/10 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto font-sans">
                              {formatThinkingTrace(message.thinkContent)
                                .split('\n')
                                .map((line, i) => (
                                  <div key={i} className="py-0.5 flex gap-2">
                                    <span className="text-elegant-gold/50 shrink-0 select-none">•</span>
                                    <span>{line}</span>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div
                        className={`p-4 rounded-xl border leading-relaxed text-xs md:text-sm shadow-sm break-words [overflow-wrap:anywhere] max-w-full ${
                          isUser
                            ? 'bg-elegant-panel border-elegant-border text-white rounded-tr-xs self-end'
                            : 'bg-elegant-card border-elegant-border text-elegant-text rounded-tl-xs'
                        }`}
                      >
                        <MessageContent
                          content={message.content}
                          highlightQuery={chatSearchQuery}
                          messageId={message.id}
                          citations={message.citations}
                          media={message.media}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            className="flex-1 flex flex-col items-center justify-center text-center p-8 text-elegant-muted bg-elegant-dark"
            id="chat-empty-state"
          >
            <div className="p-4 bg-elegant-panel border border-elegant-border rounded-full mb-4">
              <MessageSquare className="w-9 h-9 stroke-1 text-elegant-gold" />
            </div>
            <h4 className="text-sm font-display font-semibold text-white uppercase tracking-wider">
              No conversation selected
            </h4>
            <p className="text-xs text-elegant-muted mt-1 max-w-sm leading-relaxed">
              Choose a conversation from the sidebar list, or switch filters to find historical chat
              records.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
