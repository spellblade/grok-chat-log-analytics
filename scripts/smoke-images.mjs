// Smoke: hex-encoded PNG decode + asset id extraction
function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  return null;
}
function hexToBytes(hex) {
  const cleaned = hex.replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Minimal PNG header as hex
const pngHex =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
const bytes = hexToBytes(pngHex);
const mime = sniffMime(bytes);
console.log('mime', mime);

function extractAssetIdsFromString(s) {
  const ids = new Set();
  for (const m of s.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
    ids.add(m[0].toLowerCase());
  }
  for (const m of s.matchAll(/(?:prod-mc-asset-server|asset-server)\/([^/\s"'?]+)/gi)) {
    if (m[1]) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

const url =
  'https://cdn.example.com/prod-mc-asset-server/a1b2c3d4-e5f6-7890-abcd-ef1234567890/content';
const ids = extractAssetIdsFromString(url);
console.log('ids', ids);

let failed = 0;
const assert = (n, c) => {
  if (c) console.log('PASS', n);
  else {
    failed++;
    console.log('FAIL', n);
  }
};
assert('hex png sniffs', mime === 'image/png');
assert('uuid from url', ids.some((i) => i.includes('a1b2c3d4')));
process.exit(failed ? 1 : 0);
