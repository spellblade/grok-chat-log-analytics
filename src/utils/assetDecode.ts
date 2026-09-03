/**
 * Decode Grok export asset files (often extensionless `content`).
 * Handles: raw image bytes, hex-encoded images, base64 images.
 */

export type DecodedAsset = {
  blob: Blob;
  mime: string;
  kind: 'image' | 'file';
};

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

function hexToBytes(hex: string): Uint8Array | null {
  const cleaned = hex.replace(/\s+/g, '').replace(/^0x/i, '');
  if (cleaned.length < 16 || cleaned.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  // Cap absurd sizes (e.g. > 50MB hex)
  if (cleaned.length > 100_000_000) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function tryBase64ToBytes(text: string): Uint8Array | null {
  let s = text.trim().replace(/\s+/g, '');
  // data URL
  const dataMatch = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataMatch) s = dataMatch[2];
  if (s.length < 32 || s.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Decode a File from prod-mc-asset-server into a typed Blob when possible.
 */
export async function decodeAssetFile(file: File): Promise<DecodedAsset> {
  const buf = await file.arrayBuffer();
  const raw = new Uint8Array(buf);

  const toBlob = (bytes: Uint8Array, type: string) =>
    new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
      type,
    });

  // 1) Raw binary image
  let mime = sniffMime(raw);
  if (mime) {
    return {
      blob: toBlob(raw, mime),
      mime,
      kind: 'image',
    };
  }

  // 2) If File already claims image/*
  if (file.type.startsWith('image/')) {
    return {
      blob: toBlob(raw, file.type),
      mime: file.type,
      kind: 'image',
    };
  }

  // 3) Text decode: hex or base64 image payload
  // Only attempt if buffer is mostly printable
  let asText: string;
  try {
    asText = new TextDecoder('utf-8', { fatal: false }).decode(raw.slice(0, Math.min(raw.length, 8_000_000)));
  } catch {
    asText = '';
  }

  const looksText =
    asText.length > 0 &&
    raw.length < 20_000_000 &&
    // high ratio of printable / hex chars
    (() => {
      let ok = 0;
      const n = Math.min(raw.length, 2000);
      for (let i = 0; i < n; i++) {
        const c = raw[i];
        if (
          (c >= 0x30 && c <= 0x39) ||
          (c >= 0x41 && c <= 0x46) ||
          (c >= 0x61 && c <= 0x66) ||
          (c >= 0x2b && c <= 0x2f) || // +,/
          c === 0x3d || // =
          c === 0x0a ||
          c === 0x0d ||
          c === 0x20
        ) {
          ok++;
        }
      }
      return ok / n > 0.9;
    })();

  if (looksText) {
    const fullText = new TextDecoder('utf-8', { fatal: false }).decode(raw);

    const hexBytes = hexToBytes(fullText);
    if (hexBytes) {
      mime = sniffMime(hexBytes);
      if (mime) {
        return {
          blob: toBlob(hexBytes, mime),
          mime,
          kind: 'image',
        };
      }
    }

    const b64 = tryBase64ToBytes(fullText);
    if (b64) {
      mime = sniffMime(b64);
      if (mime) {
        return {
          blob: toBlob(b64, mime),
          mime,
          kind: 'image',
        };
      }
    }
  }

  // 4) Unknown binary — keep as generic file
  const fallbackType = file.type || 'application/octet-stream';
  return {
    blob: toBlob(raw, fallbackType),
    mime: fallbackType,
    kind: 'file',
  };
}

/** Extract UUID-like ids from an arbitrary string (URLs, paths). */
export function extractAssetIdsFromString(s: string): string[] {
  if (!s) return [];
  const ids = new Set<string>();
  const uuidRe =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const m of s.matchAll(uuidRe)) {
    ids.add(m[0].toLowerCase());
  }
  // path segment after asset-server
  const pathRe = /(?:prod-mc-asset-server|asset-server)\/([^/\s"'?]+)/gi;
  for (const m of s.matchAll(pathRe)) {
    if (m[1]) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}
