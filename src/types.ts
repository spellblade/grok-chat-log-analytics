export interface Citation {
  id: string;
  url?: string;
  title?: string;
  preview?: string;
  siteName?: string;
}

export interface MessageMedia {
  id: string;
  kind: 'image' | 'file';
  /** In-session object URL or remote https URL */
  url?: string;
  fileName?: string;
  alt?: string;
  /** Asset key used to rehydrate from IndexedDB after refresh */
  assetKey?: string;
  /** Original remote URL after a successful download-to-local promotion */
  remoteUrl?: string;
  /** Last remote fetch attempt (for retry UI) */
  fetchStatus?: 'ok' | 'failed' | 'cors' | 'pending';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  senderName: string;
  content: string;
  timestamp?: string; // ISO string
  thinkContent?: string; // Grok's thought process
  isThink?: boolean;
  /** parent_response_id / parent_id from export */
  parentId?: string;
  /** Shared parent id among regeneration siblings */
  siblingGroupId?: string;
  /** 0-based index within siblings */
  branchIndex?: number;
  /** Total siblings under the same parent (1 = no branch UI) */
  branchCount?: number;
  /** Sibling message ids ordered by time */
  siblingIds?: string[];
  citations?: Citation[];
  media?: MessageMedia[];
  webSearchResults?: Citation[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string; // ISO string
  messages: Message[];
  model: string;
  mode: 'Normal' | 'Think' | 'Fun' | 'DeepSearch';
  titleSource?: 'export' | 'inferred';
  stats: {
    messageCount: number;
    userMessagesCount: number;
    assistantMessagesCount: number;
    totalCharacters: number;
    userCharacters: number;
    assistantCharacters: number;
    avgMessageLength: number;
  };
}

export interface ModelDistribution {
  name: string;
  count: number;
  color: string;
}

export interface ActivityPoint {
  label: string; // Month name, day of week, hour
  count: number;
}

export interface KeywordStats {
  word: string;
  count: number;
  category: 'tech' | 'creative' | 'general' | 'query';
}

export interface AnalyticsStats {
  totalConversations: number;
  totalMessages: number;
  totalCharacters: number;
  userMessagesCount: number;
  assistantMessagesCount: number;
  avgMessagesPerChat: number;
  modelDistribution: ModelDistribution[];
  monthlyActivity: ActivityPoint[];
  weekdayActivity: ActivityPoint[];
  hourlyActivity: ActivityPoint[];
  topKeywords: KeywordStats[];
  avgConversationLength: number;
}
