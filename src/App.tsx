import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import appVersion from '../VERSION?raw';
import { Conversation } from './types';
import { SAMPLE_CONVERSATIONS } from './data/sampleData';
import { parseUploadedJson, aggregateAnalytics, repairConversationMessages } from './utils/parser';
import { importExportFolder } from './utils/archiveImport';
import {
  saveConversationsToIdb,
  loadConversationsFromIdb,
  clearConversationsIdb,
  rehydrateMediaUrls,
} from './utils/storage';
import {
  downloadRemoteImages,
  formatDownloadStats,
  countRemoteImageCandidates,
} from './utils/downloadRemoteImages';
import Dashboard from './components/Dashboard';
import ChatExplorer from './components/ChatExplorer';
import {
  Upload,
  FileJson,
  RefreshCw,
  BarChart3,
  MessageSquare,
  Check,
  AlertCircle,
  Flame,
  Info,
  X,
  FolderOpen,
  Loader2,
  Download,
} from 'lucide-react';

const STORAGE_KEY = 'grok_analyzer_conversations_v1';

export default function App() {
  const version = appVersion.trim();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'explorer'>('dashboard');
  const [hydrated, setHydrated] = useState(false);

  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadStats, setUploadStats] = useState<{
    count: number;
    messages: number;
    detail?: string;
  } | null>(null);
  const [showUploadInfo, setShowUploadInfo] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDownloadingImages, setIsDownloadingImages] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [infoToast, setInfoToast] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const persistConversations = useCallback(async (list: Conversation[]) => {
    try {
      await saveConversationsToIdb(list);
    } catch (e) {
      console.error('IndexedDB save failed', e);
    }
    try {
      // Best-effort localStorage for small sets / sample data
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
      // Quota exceeded is expected for large archives — IDB is source of truth
      console.warn('localStorage save skipped (likely quota)', e);
    }
  }, []);

  // Hydrate from IndexedDB → localStorage → sample
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const fromIdb = await loadConversationsFromIdb();
        if (!cancelled && fromIdb && fromIdb.length > 0) {
          const repaired = repairConversationMessages(fromIdb);
          const withMedia = await rehydrateMediaUrls(repaired);
          if (!cancelled) {
            setConversations(withMedia);
            setHydrated(true);
            return;
          }
        }
      } catch (e) {
        console.error('Failed to load from IndexedDB', e);
      }

      try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const repaired = repairConversationMessages(parsed);
            if (!cancelled) {
              setConversations(repaired);
              await persistConversations(repaired);
              setHydrated(true);
              return;
            }
          }
        }
      } catch (e) {
        console.error('Failed to load cached conversations', e);
      }

      if (!cancelled) {
        setConversations(SAMPLE_CONVERSATIONS);
        setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [persistConversations]);

  const analyticsStats = useMemo(() => aggregateAnalytics(conversations), [conversations]);

  const applyImportedConversations = useCallback(
    async (
      normalized: Conversation[],
      detail?: string
    ) => {
      if (normalized.length === 0) {
        throw new Error(
          'No conversations could be extracted. Verify the export matches Grok/X archive formats.'
        );
      }

      setConversations(normalized);
      await persistConversations(normalized);

      const msgCount = normalized.reduce((acc, c) => acc + c.stats.messageCount, 0);
      setUploadStats({ count: normalized.length, messages: msgCount, detail });
      setUploadSuccess(true);
      setUploadError(null);
      setSelectedId(null);
      setActiveTab('dashboard');

      setTimeout(() => {
        setUploadSuccess(false);
        setUploadStats(null);
      }, 6000);
    },
    [persistConversations]
  );

  const processJsonText = async (text: string) => {
    try {
      setIsImporting(true);
      const rawJson = JSON.parse(text);
      const normalized = parseUploadedJson(rawJson);
      await applyImportedConversations(normalized);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Invalid JSON file. Please check formatting.');
      setUploadSuccess(false);
      setTimeout(() => setUploadError(null), 7000);
    } finally {
      setIsImporting(false);
    }
  };

  const processFolderFiles = async (files: File[]) => {
    try {
      setIsImporting(true);
      setUploadError(null);

      if (files.length === 0) {
        throw new Error('No files found in the selected folder.');
      }

      // Single JSON shortcut when only one json and no assets
      const jsonOnly = files.filter(
        (f) =>
          f.type === 'application/json' ||
          f.name.endsWith('.json') ||
          (f as File & { webkitRelativePath?: string }).webkitRelativePath?.endsWith('.json')
      );
      const hasAssets = files.some((f) => {
        const p = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        return p.includes('prod-mc-asset-server') || f.type.startsWith('image/');
      });

      if (jsonOnly.length === 1 && !hasAssets && files.length === 1) {
        const text = await jsonOnly[0].text();
        await processJsonText(text);
        return;
      }

      const result = await importExportFolder(files);
      const detail = [
        result.stats.format,
        `${result.stats.jsonFiles} JSON files`,
        `${result.stats.messageRecords} messages`,
        result.stats.titleHits ? `${result.stats.titleHits} titled chats` : null,
        result.stats.assetsIndexed ? `${result.stats.assetsIndexed} assets indexed` : null,
        result.stats.assetsDecoded ? `${result.stats.assetsDecoded} images decoded` : null,
        result.stats.assetsLinked ? `${result.stats.assetsLinked} images linked` : null,
        result.stats.messagesWithMedia
          ? `${result.stats.messagesWithMedia} msgs with media`
          : null,
        result.stats.branchGroups ? `${result.stats.branchGroups} branch points` : null,
        result.stats.assetsIndexed > 0 && result.stats.assetsLinked === 0
          ? '⚠ assets found but not linked to messages'
          : null,
      ]
        .filter(Boolean)
        .join(' · ');

      await applyImportedConversations(result.conversations, detail);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Failed to import export folder. Check the folder structure.'
      );
      setUploadSuccess(false);
      setTimeout(() => setUploadError(null), 8000);
    } finally {
      setIsImporting(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const items = e.dataTransfer.items;
    const filesFromEntries: File[] = [];

    // Prefer directory entry when dropping a folder
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      if (entries.some((en) => en.isDirectory) || entries.length > 1) {
        const readEntry = async (entry: FileSystemEntry, path = ''): Promise<void> => {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => {
              (entry as FileSystemFileEntry).file(resolve, reject);
            });
            // Attach relative path for asset indexing
            Object.defineProperty(file, 'webkitRelativePath', {
              value: path + entry.name,
              writable: false,
            });
            filesFromEntries.push(file);
          } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            const readBatch = (): Promise<FileSystemEntry[]> =>
              new Promise((resolve, reject) => {
                reader.readEntries(resolve, reject);
              });
            let batch = await readBatch();
            while (batch.length > 0) {
              for (const child of batch) {
                await readEntry(child, path + entry.name + '/');
              }
              batch = await readBatch();
            }
          }
        };

        try {
          for (const entry of entries) {
            await readEntry(entry);
          }
          if (filesFromEntries.length > 0) {
            await processFolderFiles(filesFromEntries);
            return;
          }
        } catch (err) {
          console.error('Folder drop failed, falling back to files', err);
        }
      }
    }

    const fileList = e.dataTransfer.files;
    if (fileList.length > 1) {
      await processFolderFiles(Array.from(fileList));
      return;
    }

    const file = fileList[0];
    if (file && (file.type === 'application/json' || file.name.endsWith('.json'))) {
      const text = await file.text();
      await processJsonText(text);
    } else if (fileList.length > 0) {
      await processFolderFiles(Array.from(fileList));
    } else {
      setUploadError('Please drop a Grok export folder or a .json file.');
      setTimeout(() => setUploadError(null), 5000);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const text = await file.text();
      await processJsonText(text);
    }
    e.target.value = '';
  };

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) {
      await processFolderFiles(Array.from(list));
    }
    e.target.value = '';
  };

  const handleRestoreDefaults = async () => {
    if (
      window.confirm(
        'This will overwrite your current logs and restore the original sample data. Continue?'
      )
    ) {
      setConversations(SAMPLE_CONVERSATIONS);
      await persistConversations(SAMPLE_CONVERSATIONS);
      setSelectedId(null);
      setUploadSuccess(false);
      setUploadError(null);
    }
  };

  const handleClearAll = async () => {
    if (
      window.confirm(
        'Are you sure you want to clear all conversations? Your dashboard will be empty until you upload a file.'
      )
    ) {
      setConversations([]);
      await clearConversationsIdb();
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setSelectedId(null);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    const updated = conversations.filter((c) => c.id !== id);
    setConversations(updated);
    await persistConversations(updated);
    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  const handleSelectFromDashboard = (id: string) => {
    setSelectedId(id);
    setActiveTab('explorer');
  };

  const showInfoToast = useCallback((msg: string, ms = 7000) => {
    setInfoToast(msg);
    setTimeout(() => setInfoToast(null), ms);
  }, []);

  const handleRetryRemoteImages = useCallback(
    async (scope: 'all' | 'conversation', conversationId?: string) => {
      const id = scope === 'conversation' ? conversationId : undefined;
      const count = countRemoteImageCandidates(conversations, id);
      if (count === 0) {
        showInfoToast('No remote images to download in this scope.');
        return;
      }

      const label =
        scope === 'conversation'
          ? `Download up to ${count} remote image(s) for this chat? Successful ones are saved locally; failures stay as-is.`
          : `Download up to ${count} remote image(s) across all chats? Successful ones are saved locally; failures stay as-is.`;

      if (!window.confirm(label)) return;

      setIsDownloadingImages(true);
      setDownloadProgress({ done: 0, total: count });
      try {
        const { conversations: updated, stats } = await downloadRemoteImages(conversations, {
          conversationId: id,
          onProgress: (p) => setDownloadProgress({ done: p.done, total: p.total }),
        });
        setConversations(updated);
        await persistConversations(updated);
        showInfoToast(formatDownloadStats(stats), 9000);
      } catch (e) {
        showInfoToast(
          e instanceof Error ? e.message : 'Remote image download failed unexpectedly.'
        );
      } finally {
        setIsDownloadingImages(false);
        setDownloadProgress(null);
      }
    },
    [conversations, persistConversations, showInfoToast]
  );

  return (
    <div
      className={`h-screen overflow-hidden bg-elegant-bg text-elegant-text flex flex-col font-sans transition-colors duration-150 relative ${
        isDragOver ? 'ring-4 ring-elegant-gold/50 ring-inset' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      id="app-root"
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json,application/json"
        className="hidden"
      />
      <input
        type="file"
        ref={(el) => {
          folderInputRef.current = el;
          if (el) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
          }
        }}
        onChange={handleFolderChange}
        multiple
        className="hidden"
      />

      {isDragOver && (
        <div className="absolute inset-0 bg-elegant-dark/95 z-50 flex flex-col items-center justify-center space-y-4 pointer-events-none animate-fade-in">
          <div className="p-6 bg-elegant-panel border border-elegant-gold/40 rounded-full text-elegant-gold animate-bounce">
            <Upload className="w-12 h-12" />
          </div>
          <h2 className="text-xl font-display font-bold text-white tracking-wider">
            Drop your Grok export here
          </h2>
          <p className="text-sm text-elegant-muted">
            Folder (export data) or a single .json file
          </p>
        </div>
      )}

      {isImporting && (
        <div className="absolute inset-0 bg-elegant-dark/80 z-50 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="w-10 h-10 text-elegant-gold animate-spin" />
          <p className="text-sm text-white font-display tracking-wide uppercase">Importing archive…</p>
          <p className="text-xxs text-elegant-muted">Parsing JSON, titles, branches & assets locally</p>
        </div>
      )}

      {isDownloadingImages && (
        <div className="absolute inset-0 bg-elegant-dark/80 z-50 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="w-10 h-10 text-elegant-gold animate-spin" />
          <p className="text-sm text-white font-display tracking-wide uppercase">
            Downloading remote images…
          </p>
          <p className="text-xxs text-elegant-muted font-mono">
            {downloadProgress
              ? `${downloadProgress.done} / ${downloadProgress.total}`
              : 'Starting…'}
          </p>
          <p className="text-xxs text-elegant-muted max-w-sm text-center">
            Saved images are kept locally. Failed URLs are left unchanged (CORS/expired links cannot
            be fixed in-browser).
          </p>
        </div>
      )}

      <header className="bg-elegant-panel border-b border-elegant-border shrink-0 shadow-md" id="main-header">
        <div className="max-w-[90rem] mx-auto px-4 py-3.5 md:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-3.5" id="logo-container">
            <div className="p-2.5 bg-gradient-to-tr from-elegant-gold to-elegant-gold-light rounded-lg text-elegant-dark font-bold flex items-center justify-center shadow-lg">
              <Flame className="w-5 h-5 fill-elegant-dark" />
            </div>
            <div>
              <h1 className="text-base font-display font-bold text-white tracking-wide uppercase">
                Grok Chat Log Analytics v{version}
              </h1>
              <p className="text-xxs text-elegant-gold/80 font-mono tracking-widest uppercase">
                Analyze usage patterns & search historical logs
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2" id="header-actions">
            <button
              onClick={() => setShowUploadInfo(!showUploadInfo)}
              className="px-3.5 py-1.5 hover:bg-elegant-hover border border-elegant-border text-elegant-muted hover:text-elegant-gold rounded-lg text-xs flex items-center space-x-1.5 transition-colors cursor-pointer"
              title="How to export Grok logs"
            >
              <Info className="w-3.5 h-3.5" />
              <span>How to Export</span>
            </button>

            <button
              onClick={() => folderInputRef.current?.click()}
              disabled={isImporting}
              className="px-4 py-1.5 bg-elegant-gold hover:bg-elegant-gold-light text-elegant-dark text-xs font-bold tracking-wide uppercase rounded-lg flex items-center space-x-1.5 transition-all duration-200 shadow-lg cursor-pointer hover:scale-[1.02] disabled:opacity-50"
            >
              <FolderOpen className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Import Export Folder</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="px-3.5 py-1.5 bg-elegant-hover hover:bg-elegant-card border border-elegant-border text-elegant-text hover:text-white text-xs rounded-lg flex items-center space-x-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>JSON File</span>
            </button>

            {conversations.length > 0 && (
              <button
                onClick={() => handleRetryRemoteImages('all')}
                disabled={isImporting || isDownloadingImages}
                title="Try to download remote image URLs and save them locally"
                className="px-3.5 py-1.5 bg-elegant-hover hover:bg-elegant-card border border-elegant-border text-elegant-text hover:text-elegant-gold text-xs rounded-lg flex items-center space-x-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Retry Remote Images</span>
              </button>
            )}

            <button
              onClick={handleRestoreDefaults}
              title="Restore sample chats"
              className="p-2 hover:bg-elegant-hover border border-elegant-border hover:border-elegant-gold/40 text-elegant-muted hover:text-white rounded-lg transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {conversations.length > 0 && (
              <button
                onClick={handleClearAll}
                title="Clear all cached logs"
                className="p-2 hover:bg-elegant-hover border border-elegant-border hover:border-red-500/50 text-elegant-muted hover:text-red-400 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      {showUploadInfo && (
        <div className="bg-elegant-panel/90 border-b border-elegant-border p-6 shrink-0" id="info-drawer">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex justify-between items-start">
              <h3 className="text-sm font-display font-semibold tracking-wide text-white flex items-center uppercase">
                <FileJson className="w-4 h-4 text-elegant-gold mr-2" />
                How to Export & Import Your Grok Chat Logs
              </h3>
              <button
                onClick={() => setShowUploadInfo(false)}
                className="text-elegant-muted hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-elegant-text leading-relaxed">
              To obtain your data directly from X (formerly Twitter) / x.ai:
            </p>

            <ul className="list-decimal pl-5 space-y-2 text-xs text-elegant-muted leading-relaxed">
              <li>
                Open <strong>X.com</strong>, navigate to <strong>Settings and privacy</strong> &gt;{' '}
                <strong>Your Account</strong> &gt; <strong>Download an archive of your data</strong>.
              </li>
              <li>Once your archive is prepared (typically 24 hours), download and unzip it.</li>
              <li>
                Locate the export tree, often under something like{' '}
                <code className="bg-elegant-dark text-elegant-gold font-mono px-1.5 py-0.5 rounded text-xxs border border-elegant-border">
                  ttl / 30d / export data / &lt;id&gt;
                </code>
                .
              </li>
              <li>
                That folder should contain <code className="bg-elegant-dark text-elegant-gold font-mono px-1 py-0.5 rounded text-xxs">prod-grok-backend.json</code>{' '}
                (messages), other service JSONs, and{' '}
                <code className="bg-elegant-dark text-elegant-gold font-mono px-1 py-0.5 rounded text-xxs">prod-mc-asset-server</code>{' '}
                (generated images).
              </li>
              <li>
                Click <strong>Import Export Folder</strong> and select that folder (or the parent{' '}
                <em>export data</em> folder). The app reads titles, branches, citations, and images
                locally.
              </li>
              <li>
                <em>Alternative:</em> upload a single JSON export if you only have messages.
              </li>
            </ul>

            <p className="text-xxs text-elegant-muted/80 bg-elegant-dark/50 p-2.5 border border-elegant-border rounded flex items-center italic">
              🔒 <strong>Privacy Note:</strong> All parsing, indexing, and statistics calculation
              occur 100% locally in your browser. None of your conversations or private data are ever
              uploaded or transmitted to any external servers.
            </p>
          </div>
        </div>
      )}

      <div className="max-w-[90rem] mx-auto w-full px-4 md:px-6 shrink-0 mt-3" id="notifications-container">
        {uploadSuccess && uploadStats && (
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/30 text-elegant-gold-light rounded-lg text-xs flex items-center space-x-2.5 animate-slide-down">
            <Check className="w-4 h-4 text-elegant-gold shrink-0" />
            <span>
              <strong>Success!</strong> Indexed <strong>{uploadStats.count}</strong> conversations
              containing <strong>{uploadStats.messages}</strong> total messages.
              {uploadStats.detail ? ` (${uploadStats.detail})` : ''} Your metrics have been
              re-indexed.
            </span>
          </div>
        )}

        {infoToast && (
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/30 text-elegant-gold-light rounded-lg text-xs flex items-center space-x-2.5 animate-slide-down">
            <Download className="w-4 h-4 text-elegant-gold shrink-0" />
            <span>{infoToast}</span>
          </div>
        )}

        {uploadError && (
          <div className="p-3.5 bg-red-950/20 border border-red-500/30 text-red-300 rounded-lg text-xs flex items-center space-x-2.5 animate-slide-down">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>
              <strong>Import Failed:</strong> {uploadError}
            </span>
          </div>
        )}
      </div>

      <main
        className="flex-1 max-w-[90rem] mx-auto w-full px-4 py-4 md:px-6 flex flex-col overflow-hidden"
        id="main-content"
      >
        {!hydrated ? (
          <div className="flex-1 flex items-center justify-center text-elegant-muted text-xs">
            <Loader2 className="w-5 h-5 animate-spin mr-2 text-elegant-gold" />
            Loading…
          </div>
        ) : conversations.length === 0 ? (
          <div
            className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-elegant-panel border border-elegant-border rounded-2xl my-6"
            id="empty-workspace-state"
          >
            <div className="p-6 bg-elegant-dark border border-elegant-border rounded-full mb-5 text-elegant-gold animate-pulse">
              <FolderOpen className="w-12 h-12 stroke-[1.5]" />
            </div>
            <h3 className="text-base font-display font-semibold text-white tracking-wide uppercase">
              Your Dashboard is Empty
            </h3>
            <p className="text-xs text-elegant-muted mt-2.5 max-w-md leading-relaxed">
              Import your full X/Grok export folder (with{' '}
              <code className="bg-elegant-dark text-elegant-gold border border-elegant-border px-1.5 py-0.5 rounded font-mono text-xxs">
                prod-grok-backend.json
              </code>{' '}
              + assets), or a single JSON file. You can also restore sample chats.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
              <button
                onClick={() => folderInputRef.current?.click()}
                className="px-5 py-2.5 bg-elegant-gold hover:bg-elegant-gold-light text-elegant-dark text-xs font-bold tracking-wide uppercase rounded-lg transition-colors cursor-pointer"
              >
                Import Export Folder
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-5 py-2.5 bg-elegant-hover hover:bg-elegant-card text-elegant-text border border-elegant-border text-xs rounded-lg transition-colors cursor-pointer"
              >
                Browse JSON File
              </button>
              <button
                onClick={handleRestoreDefaults}
                className="px-5 py-2.5 bg-elegant-hover hover:bg-elegant-card text-elegant-text border border-elegant-border text-xs rounded-lg transition-colors cursor-pointer"
              >
                Restore Sample Data
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col space-y-5 overflow-hidden" id="workspace-layout">
            <div
              className="flex items-center space-x-2 border-b border-elegant-border pb-2 shrink-0"
              id="tabs-switcher"
            >
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`px-4 py-2.5 text-xs font-bold tracking-wider uppercase rounded-md flex items-center space-x-2 transition-all cursor-pointer ${
                  activeTab === 'dashboard'
                    ? 'bg-elegant-panel text-white shadow-md border border-elegant-border-light text-elegant-gold'
                    : 'text-elegant-muted hover:text-white hover:bg-elegant-panel/40'
                }`}
              >
                <BarChart3 className="w-4 h-4 text-elegant-gold" />
                <span>Analytics Dashboard</span>
              </button>
              <button
                onClick={() => setActiveTab('explorer')}
                className={`px-4 py-2.5 text-xs font-bold tracking-wider uppercase rounded-md flex items-center space-x-2 transition-all cursor-pointer ${
                  activeTab === 'explorer'
                    ? 'bg-elegant-panel text-white shadow-md border border-elegant-border-light text-elegant-gold'
                    : 'text-elegant-muted hover:text-white hover:bg-elegant-panel/40'
                }`}
              >
                <MessageSquare className="w-4 h-4 text-elegant-gold" />
                <span>Conversations Explorer</span>
              </button>
            </div>

            <div
              className={`flex-1 min-h-0 ${activeTab === 'dashboard' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}
              id="views-viewport"
            >
              {activeTab === 'dashboard' ? (
                <Dashboard
                  stats={analyticsStats}
                  conversations={conversations}
                  onSelectConversation={handleSelectFromDashboard}
                />
              ) : (
                <ChatExplorer
                  conversations={conversations}
                  selectedId={selectedId}
                  onSelectConversation={setSelectedId}
                  onDeleteConversation={handleDeleteConversation}
                  onRetryRemoteImages={(conversationId) =>
                    handleRetryRemoteImages('conversation', conversationId)
                  }
                  isDownloadingImages={isDownloadingImages}
                />
              )}
            </div>
          </div>
        )}
      </main>

      <footer
        className="bg-elegant-dark border-t border-elegant-border py-4 text-center text-xxs text-elegant-muted shrink-0"
        id="main-footer"
      >
        <p className="tracking-widest uppercase font-mono text-[10px]">
          © 2026 Grok Log Dashboard • Created locally & securely • Port 3000 Ingress Ready
        </p>
      </footer>
    </div>
  );
}
