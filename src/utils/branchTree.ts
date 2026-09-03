import { Message } from '../types';

function getTime(m: Message): number {
  if (!m.timestamp) return 0;
  const t = new Date(m.timestamp).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Annotate messages with branch metadata for regeneration siblings
 * (multiple children sharing the same parentId).
 */
export function annotateBranches(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const byParent = new Map<string, Message[]>();
  for (const m of messages) {
    if (!m.parentId) continue;
    const list = byParent.get(m.parentId) || [];
    list.push(m);
    byParent.set(m.parentId, list);
  }

  const meta = new Map<
    string,
    { branchIndex: number; branchCount: number; siblingGroupId: string; siblingIds: string[] }
  >();

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
    if (!b) {
      return {
        ...m,
        branchIndex: m.branchIndex ?? 0,
        branchCount: m.branchCount ?? 1,
      };
    }
    return {
      ...m,
      branchIndex: b.branchIndex,
      branchCount: b.branchCount,
      siblingGroupId: b.siblingGroupId,
      siblingIds: b.siblingIds,
    };
  });
}

/**
 * Linearize a single path through the message tree.
 * `choices` maps parentId → selected child message id.
 * Default at each branch: latest sibling (most recent regeneration).
 *
 * Important: at each parent with multiple children, pick exactly ONE child.
 * Non-selected siblings are NOT appended later (that made branch arrows look broken).
 */
export function linearizePath(
  messages: Message[],
  choices: Record<string, string> = {}
): Message[] {
  if (messages.length === 0) return [];

  const byId = new Map(messages.map((m) => [m.id, m]));
  const childrenOf = new Map<string, Message[]>();
  const hasParentInSet = new Set<string>();

  for (const m of messages) {
    if (m.parentId && byId.has(m.parentId)) {
      hasParentInSet.add(m.id);
      const list = childrenOf.get(m.parentId) || [];
      list.push(m);
      childrenOf.set(m.parentId, list);
    }
  }

  // Roots: messages whose parent is missing or outside the set
  let roots = messages.filter((m) => !hasParentInSet.has(m.id));
  if (roots.length === 0) {
    // Cycle / missing parents — fall back to chronological (no branch filtering possible)
    return [...messages].sort((a, b) => getTime(a) - getTime(b));
  }

  roots = roots.sort((a, b) => getTime(a) - getTime(b));

  const pickChild = (parentId: string, kids: Message[]): Message | null => {
    if (kids.length === 0) return null;
    const sorted = [...kids].sort((a, b) => getTime(a) - getTime(b));
    const chosenId = choices[parentId];
    if (chosenId) {
      const hit = sorted.find((k) => k.id === chosenId);
      if (hit) return hit;
    }
    // Default: latest regeneration
    return sorted[sorted.length - 1];
  };

  const path: Message[] = [];
  const visited = new Set<string>();

  const walk = (node: Message) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    path.push(node);

    const kids = childrenOf.get(node.id) || [];
    if (kids.length === 0) return;

    // Always follow exactly one child when siblings exist (regenerations are alternatives).
    // Sequential multi-turn is modeled as parent→child chains, not multi-child of one parent.
    if (kids.length === 1) {
      walk(kids[0]);
      return;
    }

    const chosen = pickChild(node.id, kids);
    if (chosen) walk(chosen);
  };

  // If multiple roots share the same parentId (parent missing from set), treat as branches
  const rootsByMissingParent = new Map<string, Message[]>();
  const trueRoots: Message[] = [];

  for (const r of roots) {
    if (r.parentId && !byId.has(r.parentId)) {
      // Parent id is set but not in this conversation — group by that external parent
      const list = rootsByMissingParent.get(r.parentId) || [];
      list.push(r);
      rootsByMissingParent.set(r.parentId, list);
    } else if (!r.parentId) {
      trueRoots.push(r);
    } else {
      trueRoots.push(r);
    }
  }

  // Roots with no parent (or parent in set — already filtered): walk each
  // But if multiple true roots exist without parent, they may be parallel top-level threads
  // — walk all in time order (disconnected conversations merged into one list is rare).
  for (const root of trueRoots) {
    walk(root);
  }

  // Multiple roots that share an external parentId → pick one (regens whose parent was dropped)
  for (const [extParent, group] of rootsByMissingParent) {
    if (group.length === 1) {
      walk(group[0]);
    } else {
      const chosen = pickChild(extParent, group);
      if (chosen) walk(chosen);
    }
  }

  // Do NOT append unvisited messages that have a parent in this set — those are
  // non-selected branch siblings. Omitting the old "orphan append" is the core fix.

  return path;
}

/** Cycle branch selection for a parent to previous/next sibling */
export function cycleBranchChoice(
  messages: Message[],
  parentId: string,
  currentChildId: string | undefined,
  direction: 1 | -1
): string | null {
  const siblings = messages
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => getTime(a) - getTime(b));
  if (siblings.length <= 1) return null;

  let idx = siblings.findIndex((s) => s.id === currentChildId);
  if (idx < 0) {
    // default was latest
    idx = siblings.length - 1;
  }
  const next = (idx + direction + siblings.length) % siblings.length;
  return siblings[next].id;
}
