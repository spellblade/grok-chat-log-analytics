import { Conversation, Message, AnalyticsStats, ModelDistribution, ActivityPoint, KeywordStats } from '../types';
import { processGrokRenderTags, resolveCitations, webSearchResultsToCitations } from './contentRender';
import { annotateBranches } from './branchTree';
import { formatThinkingTrace } from './formatThinking';

// Helper to generate a unique ID if none exists
const generateId = () => Math.random().toString(36).substring(2, 15);

// Helper to clean and extract think blocks from a message content string
export function parseThinkBlock(content: string): { cleanContent: string; thinkContent?: string } {
  if (!content) return { cleanContent: '' };

  const thinkRegExp = /<think>([\s\S]*?)<\/think>/i;
  const match = content.match(thinkRegExp);

  if (match) {
    const thinkContent = match[1].trim();
    const cleanContent = content.replace(thinkRegExp, '').trim();
    return { cleanContent, thinkContent };
  }

  // Sometimes thinking might be formatted with other markdown delimiters or just prefix-based,
  // but <think>...</think> is the standard for Grok 3 / other reasoning LLMs.
  return { cleanContent: content };
}

// Map various source keys to standard role
function normalizeRole(roleStr: string): 'user' | 'assistant' | 'system' {
  if (!roleStr) return 'user';
  const role = roleStr.toLowerCase();
  if (['user', 'you', 'me', 'human', 'caller', 'sender', 'customer'].includes(role)) {
    return 'user';
  }
  if (['assistant', 'grok', 'ai', 'bot', 'model', 'agent', 'system_assistant', 'response'].includes(role)) {
    return 'assistant';
  }
  if (['system', 'developer', 'instruction'].includes(role)) {
    return 'system';
  }
  return 'user';
}

/** True when an object looks like a Grok/X archive message document (not chat text). */
function looksLikeMessageDocument(obj: Record<string, unknown>): boolean {
  const hasMessage = typeof obj.message === 'string' || obj.message === null;
  const hasIdentity =
    'sender' in obj ||
    'conversation_id' in obj ||
    'conversationId' in obj ||
    ('_id' in obj && ('sender' in obj || 'role' in obj || 'model' in obj));
  return hasMessage && hasIdentity;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Incomplete or loosely escaped JSON — try a targeted message-field pull below.
  }
  return null;
}

/**
 * Pull the human-readable body out of a string that is actually a full export
 * document (or a partial dump of one). Used for both fresh imports and repairing
 * previously cached bad parses.
 */
export function unwrapMessageText(raw: string): string {
  if (!raw) return '';

  const trimmed = raw.trim();
  const parsed = tryParseJsonObject(trimmed);
  if (parsed && looksLikeMessageDocument(parsed)) {
    const inner = extractContent(parsed);
    if (inner) return inner;
  }

  // Partial/corrupt dumps still often contain a usable "message":"..." field.
  // Prefer the last match so nested previews don't win over the document body.
  if (
    (trimmed.startsWith('{') || trimmed.includes('"message"') || trimmed.includes('"sender"')) &&
    trimmed.includes('"message"')
  ) {
    const matches = [...trimmed.matchAll(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
    if (matches.length > 0) {
      const encoded = matches[matches.length - 1][1];
      try {
        return JSON.parse(`"${encoded}"`);
      } catch {
        return encoded
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    }
  }

  return raw;
}

/** Coerce a single field value into display text, or null if unusable. */
function coerceTextField(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Grok exports (and some bad cache entries) store a whole document as a string.
    if (trimmed.startsWith('{')) {
      const unwrapped = unwrapMessageText(trimmed);
      if (unwrapped && unwrapped !== trimmed) return unwrapped;
      const parsed = tryParseJsonObject(trimmed);
      if (parsed && looksLikeMessageDocument(parsed)) {
        const inner = coerceTextField(parsed.message) ?? coerceTextField(parsed.text) ?? coerceTextField(parsed.content);
        if (inner) return inner;
      }
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return coerceTextField((part as any).text) ??
            coerceTextField((part as any).content) ??
            coerceTextField((part as any).message) ??
            '';
        }
        return '';
      })
      .filter((p) => p.trim().length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.parts)) {
      return coerceTextField(obj.parts);
    }
    return (
      coerceTextField(obj.text) ??
      coerceTextField(obj.content) ??
      coerceTextField(obj.message) ??
      coerceTextField(obj.body) ??
      null
    );
  }

  return null;
}

/**
 * Map various source keys to standard message body text.
 *
 * Grok/X archives commonly look like:
 *   { message: "hello", content: null, sender: "human", conversation_id, ... }
 * Preferring a null/empty `content` over `message` used to dump the entire
 * document via JSON.stringify into the UI.
 */
function extractContent(msgObj: any): string {
  if (!msgObj) return '';

  if (typeof msgObj === 'string') {
    return unwrapMessageText(msgObj);
  }

  // OpenAI-style parts on the root object
  if (Array.isArray(msgObj.parts)) {
    return coerceTextField(msgObj.parts) ?? '';
  }

  // Priority order matters:
  // - `message` first: Grok/X export documents
  // - then common chat keys
  // - `content` last among peers: often null/empty on Grok rows while `message` is populated
  const fieldOrder = [
    'message',
    'text',
    'body',
    'response',
    'answer',
    'reply',
    'prompt',
    'query',
    'content',
  ] as const;

  for (const key of fieldOrder) {
    if (!(key in msgObj)) continue;
    const text = coerceTextField(msgObj[key]);
    if (text) return text;
  }

  // Never surface the raw export document as chat text.
  if (looksLikeMessageDocument(msgObj)) {
    return '';
  }

  return '';
}

/**
 * Repair conversations that were previously cached with full export JSON
 * dumped into message.content (from the content:null bug). Safe to run on load.
 */
export function repairConversationMessages(conversations: Conversation[]): Conversation[] {
  return conversations.map((conv) => {
    let changed = false;
    const messages = conv.messages.map((msg) => {
      let nextContent = msg.content || '';
      let nextThink = msg.thinkContent;
      let contentChanged = false;
      let thinkChanged = false;

      if (msg.content) {
        let next = unwrapMessageText(msg.content);
        const { cleanContent, citationIds } = processGrokRenderTags(next);
        next = cleanContent;
        if (next !== msg.content || citationIds.length > 0) {
          contentChanged = true;
          nextContent = next;
        }
        const citations =
          citationIds.length > 0
            ? resolveCitations(citationIds, msg.webSearchResults)
            : msg.citations;

        if (msg.thinkContent) {
          const formatted = formatThinkingTrace(msg.thinkContent);
          if (formatted && formatted !== msg.thinkContent) {
            thinkChanged = true;
            nextThink = formatted;
          }
        }

        if (!contentChanged && !thinkChanged) return msg;
        changed = true;
        return {
          ...msg,
          content: nextContent,
          thinkContent: nextThink,
          isThink: !!(nextThink || msg.isThink),
          citations: citations && citations.length > 0 ? citations : msg.citations,
        };
      }

      if (msg.thinkContent) {
        const formatted = formatThinkingTrace(msg.thinkContent);
        if (formatted && formatted !== msg.thinkContent) {
          changed = true;
          return {
            ...msg,
            thinkContent: formatted,
            isThink: true,
          };
        }
      }

      return msg;
    });
    if (!changed) return conv;

    // Recompute basic character stats after repair
    let totalCharacters = 0;
    let userCharacters = 0;
    let assistantCharacters = 0;
    messages.forEach((m) => {
      const len = m.content.length + (m.thinkContent?.length || 0);
      totalCharacters += len;
      if (m.role === 'user') userCharacters += len;
      else if (m.role === 'assistant') assistantCharacters += len;
    });

    return {
      ...conv,
      messages: annotateBranches(messages),
      stats: {
        ...conv.stats,
        totalCharacters,
        userCharacters,
        assistantCharacters,
        avgMessageLength: messages.length > 0 ? Math.round(totalCharacters / messages.length) : 0,
      },
    };
  });
}

// Normalize a single conversation object
export function normalizeConversation(raw: any, index: number = 0): Conversation {
  // If raw is a string, try to parse it first
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        raw = parsed;
      }
    } catch (e) {
      // Keep as string
    }
  }

  const id = raw.id || raw._id || raw.conversationId || raw.conversation_id || raw.key || `conv_${generateId()}_${index}`;
  const rawTitle = raw.title || raw.name || raw.subject;
  
  // Normalize messages
  let rawMessages = raw.messages || raw.chat || raw.chat_messages || raw.history || raw.interactions || raw.turns || raw.dialog || raw.dialogue || raw.events || [];
  
  // If we couldn't find an array, check if it's ChatGPT mapping format
  if ((!Array.isArray(rawMessages) || rawMessages.length === 0) && raw.mapping && typeof raw.mapping === 'object') {
    const nodes = Object.values(raw.mapping);
    const extractedMsgs: any[] = [];
    nodes.forEach((node: any) => {
      if (node && node.message) {
        const msg = node.message;
        const role = msg.author?.role || 'user';
        const contentParts = msg.content?.parts || [];
        const content = contentParts.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join('\n');
        const timestamp = msg.create_time ? new Date(msg.create_time * 1000).toISOString() : undefined;
        
        extractedMsgs.push({
          id: msg.id,
          role,
          content,
          timestamp,
          senderName: role === 'user' ? 'You' : (role === 'system' ? 'System' : 'Assistant')
        });
      }
    });
    // Sort chronologically by timestamp
    extractedMsgs.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      }
      return 0;
    });
    if (extractedMsgs.length > 0) {
      rawMessages = extractedMsgs;
    }
  }

  // If still empty/not an array, let's look for any array property on raw that contains message-like objects
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (Array.isArray(val) && val.length > 0) {
        const firstItem = val[0];
        if (firstItem && typeof firstItem === 'object') {
          const hasMsgKeys = ['role', 'sender', 'author', 'text', 'content', 'message', 'parts', 'body', 'response', 'request', 'prompt'].some(k => k in firstItem);
          if (hasMsgKeys) {
            rawMessages = val;
            break;
          }
        }
      }
    }
  }

  if (!Array.isArray(rawMessages) && typeof rawMessages === 'object') {
    // If messages is an object map, convert to array
    rawMessages = Object.values(rawMessages);
  }

  // Flatten turns (e.g. if the objects have request/response or prompt/response or query/answer style)
  let flatMessages: any[] = [];
  if (Array.isArray(rawMessages)) {
    rawMessages.forEach((msg: any, mIdx: number) => {
      // Parse if stringified JSON
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          if (parsed && typeof parsed === 'object') {
            msg = parsed;
          }
        } catch (e) {
          // Keep as is
        }
      }

      if (msg && typeof msg === 'object') {
        const userContent = msg.request || msg.prompt || msg.query || msg.question;
        const assistantContent = msg.response || msg.answer || msg.reply || msg.text || msg.message;
        
        // If it has BOTH user and assistant content in the same object, treat it as a turn and split it!
        if (userContent && assistantContent) {
          flatMessages.push({
            id: msg.id ? `${msg.id}_user` : `msg_${generateId()}_${mIdx}_user`,
            role: 'user',
            content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent),
            timestamp: msg.timestamp || msg.created_at || msg.createdAt || msg.time || msg.date || msg.create_time
          });
          flatMessages.push({
            id: msg.id ? `${msg.id}_assistant` : `msg_${generateId()}_${mIdx}_assistant`,
            role: 'assistant',
            content: typeof assistantContent === 'string' ? assistantContent : JSON.stringify(assistantContent),
            timestamp: msg.timestamp || msg.created_at || msg.createdAt || msg.time || msg.date || msg.create_time
          });
        } else {
          // Otherwise keep it as is
          flatMessages.push(msg);
        }
      } else {
        flatMessages.push(msg);
      }
    });
    rawMessages = flatMessages;
  }

  let messages: Message[] = rawMessages.map((msg: any, mIdx: number) => {
    // If msg is still a string, parse it
    if (typeof msg === 'string') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          msg = parsed;
        }
      } catch (e) {
        // Keep as is
      }
    }

    const mId = msg.id || msg._id || msg.messageId || `msg_${generateId()}_${mIdx}`;
    const rawRole = msg.role || msg.sender || msg.author || msg.speaker || msg.from || (msg.is_bot ? 'assistant' : 'user');
    const role = normalizeRole(String(rawRole));
    
    const senderName = msg.senderName || msg.sender_name || (role === 'user' ? 'You' : 'Grok');
    const rawContent = extractContent(msg);
    const { cleanContent: afterThink, thinkContent: rawThink } = parseThinkBlock(rawContent);
    const thinkContent = rawThink ? formatThinkingTrace(rawThink) || rawThink : undefined;
    const { cleanContent, citationIds } = processGrokRenderTags(afterThink);

    const webSearchResults = webSearchResultsToCitations(
      msg.web_search_results || msg.webSearchResults || msg.citations || msg.metadata?.web_search_results
    );
    const citations = resolveCitations(citationIds, webSearchResults);

    const parentId =
      msg.parent_response_id ||
      msg.parent_id ||
      msg.parentId ||
      msg.parent ||
      msg.in_reply_to ||
      msg.inReplyTo ||
      undefined;

    // Parse date/timestamp
    let timestamp = msg.timestamp || msg.created_at || msg.createdAt || msg.time || msg.date || msg.create_time;
    if (timestamp) {
      try {
        if (typeof timestamp === 'object') {
          if (timestamp.$date) {
            if (typeof timestamp.$date === 'object' && timestamp.$date.$numberLong) {
              timestamp = new Date(parseInt(timestamp.$date.$numberLong)).toISOString();
            } else {
              timestamp = new Date(timestamp.$date).toISOString();
            }
          } else {
            timestamp = undefined;
          }
        } else if (typeof timestamp === 'number' || !isNaN(Number(timestamp))) {
          const num = Number(timestamp);
          if (num < 10000000000) {
            timestamp = new Date(num * 1000).toISOString();
          } else {
            timestamp = new Date(num).toISOString();
          }
        } else {
          timestamp = new Date(timestamp).toISOString();
        }
      } catch (e) {
        timestamp = undefined;
      }
    }

    // Carry through media if already resolved by archive import
    const media = Array.isArray(msg.media) ? msg.media : undefined;

    return {
      id: String(mId),
      role,
      senderName,
      content: cleanContent,
      thinkContent,
      isThink: !!thinkContent,
      timestamp,
      parentId: parentId ? String(parentId) : undefined,
      citations: citations.length > 0 ? citations : undefined,
      webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
      media,
    };
  });

  // Annotate regeneration siblings
  messages = annotateBranches(messages);

  // Infer title if not set
  let title = rawTitle ? String(rawTitle).trim() : '';
  let titleSource: 'export' | 'inferred' | undefined = rawTitle ? 'export' : undefined;
  if (!title) {
    titleSource = 'inferred';
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      title = firstUserMsg.content.substring(0, 50);
      if (firstUserMsg.content.length > 50) title += '...';
    } else {
      title = `Conversation #${index + 1}`;
    }
  }

  // Normalize created date
  let createdAt = raw.createdAt || raw.created_at || raw.timestamp || raw.time || raw.date || raw.updatedAt || raw.updated_at || raw.create_time;
  if (createdAt) {
    try {
      if (typeof createdAt === 'object') {
        if (createdAt.$date) {
          if (typeof createdAt.$date === 'object' && createdAt.$date.$numberLong) {
            createdAt = new Date(parseInt(createdAt.$date.$numberLong)).toISOString();
          } else {
            createdAt = new Date(createdAt.$date).toISOString();
          }
        } else {
          createdAt = new Date().toISOString();
        }
      } else if (typeof createdAt === 'number' || !isNaN(Number(createdAt))) {
        const num = Number(createdAt);
        if (num < 10000000000) {
          createdAt = new Date(num * 1000).toISOString();
        } else {
          createdAt = new Date(num).toISOString();
        }
      } else {
        createdAt = new Date(createdAt).toISOString();
      }
    } catch (e) {
      createdAt = new Date().toISOString();
    }
  } else {
    // Fallback to first message's timestamp or current time
    const firstMsgTime = messages.find(m => m.timestamp)?.timestamp;
    createdAt = firstMsgTime || new Date(Date.now() - index * 3600000 * 24).toISOString(); // stagger historical dates
  }

  // Infer model and mode
  let model = raw.model || raw.metadata?.model || 'Grok 2';
  let mode: 'Normal' | 'Think' | 'Fun' | 'DeepSearch' = 'Normal';

  // Check if we have think contents
  const hasThink = messages.some(m => m.isThink);
  if (hasThink) {
    mode = 'Think';
    model = raw.model || 'Grok 3 (Reasoning)';
  } else if (raw.mode?.toLowerCase() === 'fun' || String(title).toLowerCase().includes('roast') || String(id).includes('fun')) {
    mode = 'Fun';
    model = raw.model || 'Grok 2 (Fun)';
  } else if (raw.mode?.toLowerCase() === 'deepsearch' || raw.mode?.toLowerCase() === 'deep_search') {
    mode = 'DeepSearch';
    model = raw.model || 'Grok 3 (DeepSearch)';
  }

  // Calculate conversational statistics
  let userMessagesCount = 0;
  let assistantMessagesCount = 0;
  let totalCharacters = 0;
  let userCharacters = 0;
  let assistantCharacters = 0;

  messages.forEach(m => {
    const charLen = m.content.length + (m.thinkContent?.length || 0);
    totalCharacters += charLen;

    if (m.role === 'user') {
      userMessagesCount++;
      userCharacters += charLen;
    } else if (m.role === 'assistant') {
      assistantMessagesCount++;
      assistantCharacters += charLen;
    }
  });

  const stats = {
    messageCount: messages.length,
    userMessagesCount,
    assistantMessagesCount,
    totalCharacters,
    userCharacters,
    assistantCharacters,
    avgMessageLength: messages.length > 0 ? Math.round(totalCharacters / messages.length) : 0
  };

  return {
    id: String(id),
    title,
    createdAt,
    messages,
    model,
    mode,
    titleSource,
    stats
  };
}

// Convert any uploaded JSON into a clean list of Conversations
export function parseUploadedJson(jsonData: any): Conversation[] {
  if (!jsonData) return [];

  // Parse if stringified
  if (typeof jsonData === 'string') {
    try {
      jsonData = JSON.parse(jsonData);
    } catch (e) {
      return [];
    }
  }

  // Let's normalize elements if they are stringified JSON strings
  if (Array.isArray(jsonData)) {
    jsonData = jsonData.map(item => {
      if (typeof item === 'string') {
        try {
          return JSON.parse(item);
        } catch (e) {
          return item;
        }
      }
      return item;
    });
  }

  // If the array itself is a list of messages, check if they have conversation_id to group by!
  if (Array.isArray(jsonData) && jsonData.length > 0) {
    const first = jsonData[0];
    if (first && typeof first === 'object') {
      const isMessageObj = 'message' in first || 'role' in first || 'sender' in first || 'content' in first || 'text' in first;
      const conversationId = first.conversation_id || first.conversationId || first.convo_id;
      
      if (isMessageObj && conversationId) {
        // Group messages by conversation_id!
        const grouped: { [key: string]: any[] } = {};
        jsonData.forEach(msg => {
          const cId = msg.conversation_id || msg.conversationId || msg.convo_id || 'default_convo';
          if (!grouped[cId]) {
            grouped[cId] = [];
          }
          grouped[cId].push(msg);
        });

        // Convert grouped messages into conversation objects
        const convs = Object.entries(grouped).map(([cId, msgs], idx) => {
          // Sort messages chronologically if possible
          msgs.sort((a, b) => {
            const timeA = a.create_time || a.created_at || a.timestamp || a.time;
            const timeB = b.create_time || b.created_at || b.timestamp || b.time;
            
            // Helper to get milliseconds from various types of timestamps
            const getMs = (t: any) => {
              if (!t) return 0;
              if (typeof t === 'object') {
                if (t.$date) {
                  if (typeof t.$date === 'object' && t.$date.$numberLong) {
                    return parseInt(t.$date.$numberLong);
                  }
                  return new Date(t.$date).getTime();
                }
                return 0;
              }
              if (typeof t === 'number') return t;
              if (!isNaN(Number(t))) return Number(t);
              return new Date(t).getTime();
            };
            return getMs(timeA) - getMs(timeB);
          });

          // Prefer Grok-generated titles on any message in the thread
          let title = '';
          for (const m of msgs) {
            const candidates = [
              m.conversation_title,
              m.conversationTitle,
              m.title,
              m.metadata?.title,
              m.metadata?.conversation_title,
              m.metadata?.summary,
            ];
            for (const c of candidates) {
              if (typeof c === 'string' && c.trim() && c.trim().length > 1) {
                title = c.trim();
                break;
              }
            }
            if (title) break;
          }

          // Fallback: first user message text
          if (!title) {
            const firstUser = msgs.find(m => {
              const r = m.role || m.sender || m.author;
              return r && ['user', 'human', 'you'].includes(String(r).toLowerCase());
            });
            if (firstUser) {
              const rawText = firstUser.message || firstUser.content || firstUser.text || '';
              let cleanText = '';
              if (typeof rawText === 'string') {
                const trimmed = rawText.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    cleanText = parsed.message || parsed.content || parsed.text || rawText;
                  } catch (e) {
                    cleanText = rawText;
                  }
                } else {
                  cleanText = rawText;
                }
              } else if (rawText && typeof rawText === 'object') {
                cleanText = rawText.message || rawText.content || rawText.text || JSON.stringify(rawText);
              }
              title = String(cleanText).substring(0, 50);
              if (String(cleanText).length > 50) title += '...';
            }
          }
          if (!title) {
            title = `Conversation ${cId.substring(0, 8)}`;
          }

          // Use the timestamp of the first message as createdAt
          const firstMsgTime = msgs[0]?.create_time || msgs[0]?.created_at || msgs[0]?.timestamp || msgs[0]?.time;
          let createdAt = new Date().toISOString();
          if (firstMsgTime) {
            if (typeof firstMsgTime === 'object' && firstMsgTime.$date) {
              if (firstMsgTime.$date.$numberLong) {
                createdAt = new Date(parseInt(firstMsgTime.$date.$numberLong)).toISOString();
              } else {
                createdAt = new Date(firstMsgTime.$date).toISOString();
              }
            } else if (typeof firstMsgTime === 'number' || !isNaN(Number(firstMsgTime))) {
              const num = Number(firstMsgTime);
              if (num < 10000000000) {
                createdAt = new Date(num * 1000).toISOString();
              } else {
                createdAt = new Date(num).toISOString();
              }
            } else {
              createdAt = new Date(firstMsgTime).toISOString();
            }
          }

          return {
            id: cId,
            title,
            createdAt,
            messages: msgs,
            model: msgs[0]?.model || msgs[0]?.metadata?.model || 'Grok 2'
          };
        });

        // Parse and normalize grouped conversations
        return convs.map((c, idx) => normalizeConversation(c, idx));
      } else if (isMessageObj) {
        // Flat message list but no conversation ID, wrap in single conversation
        jsonData = {
          title: "Imported Conversation",
          messages: jsonData
        };
      }
    }
  }

  let rawConversations: any[] = [];

  // 1. Check if the structure is direct array of conversations
  if (Array.isArray(jsonData)) {
    rawConversations = jsonData;
  }
  // 2. Check if it's an object with a conversation list key
  else if (jsonData && typeof jsonData === 'object') {
    const listKeys = ['conversations', 'grok_conversations', 'chats', 'history', 'data', 'items'];
    const foundKey = listKeys.find(k => Array.isArray(jsonData[k]));
    
    if (foundKey) {
      rawConversations = jsonData[foundKey];
    } else {
      // 3. Check if it looks like a single conversation object
      const isSingleConv = jsonData.messages || jsonData.chat || jsonData.chat_messages || jsonData.history || jsonData.interactions || jsonData.turns || jsonData.mapping;
      if (isSingleConv) {
        rawConversations = [jsonData];
      } else {
        // Just try values if they are objects
        const values = Object.values(jsonData);
        if (values.some(v => typeof v === 'object' && v !== null)) {
          rawConversations = values.filter(v => typeof v === 'object' && v !== null);
        } else {
          // Fallback, wrap in array
          rawConversations = [jsonData];
        }
      }
    }
  }

  return rawConversations.map((c, idx) => normalizeConversation(c, idx));
}

// Calculate top terms or keywords
export function calculateTopKeywords(conversations: Conversation[]): KeywordStats[] {
  const wordCounts: { [key: string]: number } = {};
  const stopWords = new Set([
    'the', 'a', 'to', 'and', 'of', 'in', 'is', 'for', 'that', 'on', 'this', 'it', 'i', 'you', 'with', 'as', 'at', 'by', 'an', 'be', 'are', 'from',
    'have', 'has', 'had', 'was', 'were', 'or', 'but', 'not', 'your', 'my', 'we', 'they', 'he', 'she', 'his', 'her', 'how', 'what', 'why', 'can',
    'about', 'there', 'their', 'will', 'would', 'should', 'could', 'me', 'them', 'us', 'an', 'if', 'then', 'else', 'do', 'does', 'did', 'just',
    'like', 'so', 'get', 'make', 'use', 'know', 'think', 'see', 'some', 'any', 'one', 'two', 'new', 'time', 'more', 'about', 'some', 'out', 'up', 'down'
  ]);

  conversations.forEach(conv => {
    conv.messages.forEach(msg => {
      // Analyze user messages for interest/intent keywords
      if (msg.role === 'user') {
        const words = msg.content
          .toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/);

        words.forEach(word => {
          if (word.length > 3 && !stopWords.has(word) && !/^\d+$/.test(word)) {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
          }
        });
      }
    });
  });

  const sorted = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const techKeys = ['react', 'typescript', 'api', 'code', 'function', 'database', 'html', 'css', 'js', 'json', 'python', 'git', 'node', 'express', 'sql', 'state', 'component', 'query'];
  const creativeKeys = ['roast', 'joke', 'story', 'write', 'creative', 'poem', 'funny', 'fun', 'generate', 'create'];

  return sorted.map(([word, count]) => {
    let category: 'tech' | 'creative' | 'general' | 'query' = 'general';
    if (techKeys.some(tk => word.includes(tk))) category = 'tech';
    else if (creativeKeys.some(ck => word.includes(ck))) category = 'creative';
    else if (word.startsWith('how') || word.startsWith('why') || word.startsWith('explain') || word.startsWith('what')) category = 'query';

    return { word, count, category };
  });
}

// Aggregate overall statistics from normalized conversations
export function aggregateAnalytics(conversations: Conversation[]): AnalyticsStats {
  const totalConversations = conversations.length;
  let totalMessages = 0;
  let totalCharacters = 0;
  let userMessagesCount = 0;
  let assistantMessagesCount = 0;

  const modelCounts: { [key: string]: number } = {};
  const monthCounts: { [key: string]: number } = {};
  const weekdayCounts: { [key: string]: number } = {};
  const hourCounts: { [key: string]: number } = {};

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Initialize distributions
  weekdays.forEach(day => { weekdayCounts[day] = 0; });
  months.forEach(m => { monthCounts[m] = 0; });
  for (let h = 0; h < 24; h++) {
    const label = `${h.toString().padStart(2, '0')}:00`;
    hourCounts[label] = 0;
  }

  conversations.forEach(conv => {
    totalMessages += conv.stats.messageCount;
    totalCharacters += conv.stats.totalCharacters;
    userMessagesCount += conv.stats.userMessagesCount;
    assistantMessagesCount += conv.stats.assistantMessagesCount;

    // Model aggregation
    const model = conv.model || 'Grok 2';
    modelCounts[model] = (modelCounts[model] || 0) + 1;

    // Temporal aggregation
    const date = new Date(conv.createdAt);
    if (!isNaN(date.getTime())) {
      const monthLabel = months[date.getMonth()];
      const dayLabel = weekdays[date.getDay()];
      const hourLabel = `${date.getHours().toString().padStart(2, '0')}:00`;

      monthCounts[monthLabel] = (monthCounts[monthLabel] || 0) + 1;
      weekdayCounts[dayLabel] = (weekdayCounts[dayLabel] || 0) + 1;
      hourCounts[hourLabel] = (hourCounts[hourLabel] || 0) + 1;
    }
  });

  // Convert model counts to list
  const modelColors = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899'];
  const modelDistribution: ModelDistribution[] = Object.entries(modelCounts).map(([name, count], idx) => ({
    name,
    count,
    color: modelColors[idx % modelColors.length]
  })).sort((a, b) => b.count - a.count);

  // Convert activity structures
  const monthlyActivity: ActivityPoint[] = months.map(m => ({ label: m, count: monthCounts[m] || 0 }));
  const weekdayActivity: ActivityPoint[] = weekdays.map(day => ({ label: day, count: weekdayCounts[day] || 0 }));
  const hourlyActivity: ActivityPoint[] = Object.entries(hourCounts).map(([label, count]) => ({ label, count }));

  // Keywords
  const topKeywords = calculateTopKeywords(conversations);

  return {
    totalConversations,
    totalMessages,
    totalCharacters,
    userMessagesCount,
    assistantMessagesCount,
    avgMessagesPerChat: totalConversations > 0 ? parseFloat((totalMessages / totalConversations).toFixed(1)) : 0,
    modelDistribution,
    monthlyActivity,
    weekdayActivity,
    hourlyActivity,
    topKeywords,
    avgConversationLength: totalConversations > 0 ? Math.round(totalCharacters / totalConversations) : 0
  };
}
