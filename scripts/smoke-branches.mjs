/**
 * Smoke tests for branch path linearization.
 * Mirrors src/utils/branchTree.ts logic for CI-less verification.
 * Run: node scripts/smoke-branches.mjs
 */

function getTime(m) {
  if (!m.timestamp) return 0;
  const t = new Date(m.timestamp).getTime();
  return Number.isFinite(t) ? t : 0;
}

function annotateBranches(messages) {
  const byParent = new Map();
  for (const m of messages) {
    if (!m.parentId) continue;
    const list = byParent.get(m.parentId) || [];
    list.push(m);
    byParent.set(m.parentId, list);
  }
  const meta = new Map();
  for (const [parentId, siblings] of byParent) {
    if (siblings.length <= 1) continue;
    const sorted = [...siblings].sort((a, b) => getTime(a) - getTime(b));
    const siblingIds = sorted.map((s) => s.id);
    sorted.forEach((s, idx) => {
      meta.set(s.id, {
        branchIndex: idx,
        branchCount: sorted.length,
        siblingGroupId: parentId,
        siblingIds,
      });
    });
  }
  return messages.map((m) => {
    const b = meta.get(m.id);
    return b
      ? { ...m, ...b }
      : { ...m, branchIndex: 0, branchCount: 1 };
  });
}

function linearizePath(messages, choices = {}) {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const childrenOf = new Map();
  const hasParentInSet = new Set();

  for (const m of messages) {
    if (m.parentId && byId.has(m.parentId)) {
      hasParentInSet.add(m.id);
      const list = childrenOf.get(m.parentId) || [];
      list.push(m);
      childrenOf.set(m.parentId, list);
    }
  }

  let roots = messages.filter((m) => !hasParentInSet.has(m.id));
  if (roots.length === 0) {
    return [...messages].sort((a, b) => getTime(a) - getTime(b));
  }
  roots = roots.sort((a, b) => getTime(a) - getTime(b));

  const pickChild = (parentId, kids) => {
    if (kids.length === 0) return null;
    const sorted = [...kids].sort((a, b) => getTime(a) - getTime(b));
    const chosenId = choices[parentId];
    if (chosenId) {
      const hit = sorted.find((k) => k.id === chosenId);
      if (hit) return hit;
    }
    return sorted[sorted.length - 1];
  };

  const path = [];
  const visited = new Set();

  const walk = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    path.push(node);
    const kids = childrenOf.get(node.id) || [];
    if (kids.length === 0) return;
    if (kids.length === 1) {
      walk(kids[0]);
      return;
    }
    const chosen = pickChild(node.id, kids);
    if (chosen) walk(chosen);
  };

  const rootsByMissingParent = new Map();
  const trueRoots = [];
  for (const r of roots) {
    if (r.parentId && !byId.has(r.parentId)) {
      const list = rootsByMissingParent.get(r.parentId) || [];
      list.push(r);
      rootsByMissingParent.set(r.parentId, list);
    } else {
      trueRoots.push(r);
    }
  }
  for (const root of trueRoots) walk(root);
  for (const [extParent, group] of rootsByMissingParent) {
    if (group.length === 1) walk(group[0]);
    else {
      const chosen = pickChild(extParent, group);
      if (chosen) walk(chosen);
    }
  }
  // NO orphan append
  return path;
}

function cycleBranchChoice(messages, parentId, currentChildId, direction) {
  const siblings = messages
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => getTime(a) - getTime(b));
  if (siblings.length <= 1) return null;
  let idx = siblings.findIndex((s) => s.id === currentChildId);
  if (idx < 0) idx = siblings.length - 1;
  const next = (idx + direction + siblings.length) % siblings.length;
  return siblings[next].id;
}

// --- fixtures ---
const msgs = annotateBranches([
  { id: 'h1', role: 'user', content: 'hi', parentId: undefined, timestamp: '2026-01-01T00:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'v1', parentId: 'h1', timestamp: '2026-01-01T00:01:00Z' },
  { id: 'a2', role: 'assistant', content: 'v2', parentId: 'h1', timestamp: '2026-01-01T00:02:00Z' },
]);

// Longer chain under one branch
const deep = annotateBranches([
  { id: 'h1', role: 'user', content: 'q1', parentId: undefined, timestamp: '2026-01-01T00:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'a1', parentId: 'h1', timestamp: '2026-01-01T00:01:00Z' },
  { id: 'a2', role: 'assistant', content: 'a2-regen', parentId: 'h1', timestamp: '2026-01-01T00:02:00Z' },
  { id: 'h2', role: 'user', content: 'q2', parentId: 'a2', timestamp: '2026-01-01T00:03:00Z' },
  { id: 'a3', role: 'assistant', content: 'a3', parentId: 'h2', timestamp: '2026-01-01T00:04:00Z' },
]);

let failed = 0;
const assert = (n, c, detail) => {
  if (c) console.log('PASS', n);
  else {
    failed++;
    console.log('FAIL', n, detail || '');
  }
};

const def = linearizePath(msgs, {});
assert('default is latest only', def.map((m) => m.id).join('>') === 'h1>a2', def.map((m) => m.id));
assert('default excludes a1', !def.some((m) => m.id === 'a1'));

const chooseA1 = linearizePath(msgs, { h1: 'a1' });
assert('choice a1 only', chooseA1.map((m) => m.id).join('>') === 'h1>a1', chooseA1.map((m) => m.id));
assert('choice excludes a2', !chooseA1.some((m) => m.id === 'a2'));

const next = cycleBranchChoice(msgs, 'h1', 'a2', -1);
assert('cycle prev from a2 is a1', next === 'a1', next);

const afterCycle = linearizePath(msgs, { h1: next });
assert('after cycle path is a1', afterCycle.map((m) => m.id).join('>') === 'h1>a1');

const deepDef = linearizePath(deep, {});
assert(
  'deep default follows a2 branch',
  deepDef.map((m) => m.id).join('>') === 'h1>a2>h2>a3',
  deepDef.map((m) => m.id)
);
const deepA1 = linearizePath(deep, { h1: 'a1' });
assert(
  'deep a1 has no h2/a3 under a2',
  deepA1.map((m) => m.id).join('>') === 'h1>a1',
  deepA1.map((m) => m.id)
);
assert('a2 has branchCount 2', msgs.find((m) => m.id === 'a2')?.branchCount === 2);

process.exit(failed ? 1 : 0);
