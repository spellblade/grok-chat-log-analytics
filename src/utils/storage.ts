import { Conversation } from '../types';

const DB_NAME = 'grok_chat_log_analytics';
const DB_VERSION = 1;
const STORE_CONVERSATIONS = 'conversations';
const STORE_ASSETS = 'assets';
const META_KEY = 'conversations';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS);
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS);
      }
    };
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveConversationsToIdb(conversations: Conversation[]): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    store.put(conversations, META_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadConversationsFromIdb(): Promise<Conversation[] | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const result = await idbRequest(store.get(META_KEY));
      if (Array.isArray(result) && result.length >= 0) {
        return result as Conversation[];
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function clearConversationsIdb(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_CONVERSATIONS, STORE_ASSETS], 'readwrite');
    tx.objectStore(STORE_CONVERSATIONS).clear();
    tx.objectStore(STORE_ASSETS).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveAssetToIdb(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    tx.objectStore(STORE_ASSETS).put(blob, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAssetFromIdb(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_ASSETS, 'readonly');
      const result = await idbRequest(tx.objectStore(STORE_ASSETS).get(key));
      return result instanceof Blob ? result : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Rehydrate blob: URLs for media that only has assetKey after reload.
 * Mutates conversations in place for media.url fields.
 */
export async function rehydrateMediaUrls(
  conversations: Conversation[]
): Promise<Conversation[]> {
  const next = conversations.map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      media: m.media ? [...m.media] : m.media,
    })),
  }));

  for (const conv of next) {
    for (const msg of conv.messages) {
      if (!msg.media) continue;
      for (let i = 0; i < msg.media.length; i++) {
        const media = msg.media[i];
        // Keep remote https URLs; refresh blob: URLs from IndexedDB via assetKey
        if (media.url && /^https?:\/\//i.test(media.url)) continue;
        if (!media.assetKey) continue;
        const blob = await loadAssetFromIdb(media.assetKey);
        if (blob) {
          msg.media[i] = {
            ...media,
            url: URL.createObjectURL(blob),
          };
        }
      }
    }
  }

  return next;
}
