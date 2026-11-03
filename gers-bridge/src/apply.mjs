// Apply a plan to a durable store, inspect the result, and export it.
//
// `applyPlan` is reference-only: it writes to a local durable store, never to a
// resolver. Promotion from this store into an authoritative resolver is an
// operator action performed by an authority, not something a bridge does.

import { createHash } from "node:crypto";
import { OUTCOME } from "./plan.mjs";

/**
 * Derive a stable operation id for a plan.
 *
 * Hashing the decided content (not the clock) means rerunning the same plan
 * produces the same operation id, which is what makes the store's idempotence
 * check fire on a rerun.
 */
export function planOperationId(plan) {
  const material = JSON.stringify({
    source: plan.source,
    home_token: plan.home_token,
    policy: plan.policy,
    items: plan.items.map((i) => ({
      local_id: i.local_id,
      outcome: i.outcome,
      id: i.id,
      edges: i.edges.map((e) => [e.type, e.from, e.to, e.registry, e.external_id]),
    })),
  });
  return `op-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * Apply a plan's mints and edges to a durable store.
 *
 * Only `mint` and `reuse` items contribute. `review` and `blocked` items are
 * carried into the report untouched — they are the operator's queue.
 *
 * @param {object} plan
 * @param {object} store  durable writer with apply()
 * @param {{ referenceOnly?: boolean, operationId?: string }} [opts]
 */
export async function applyPlan(plan, store, { referenceOnly = true, operationId } = {}) {
  if (!referenceOnly) {
    throw new Error(
      "applyPlan supports reference-only application. This package does not write authoritative " +
        "identity state; promotion is an authority's action."
    );
  }
  if (!store || typeof store.apply !== "function") {
    throw new Error("applyPlan requires a store with an apply() method");
  }

  const mints = [];
  const edges = [];

  for (const item of plan.items) {
    if (item.outcome === OUTCOME.MINT) {
      mints.push({
        local_id: item.local_id,
        id: item.id,
        aliases: item.aliases ?? [],
        record: {
          id: item.id,
          reference_only: true,
          status: "provisional",
          grounded: false,
          home_token: plan.home_token,
          label: item.record.label ?? null,
          source_registry: plan.source.registry,
          local_id: item.local_id,
          membership: item.membership?.membership ?? null,
          binding_tier: item.binding?.tier ?? null,
        },
      });
    }
    if (item.outcome === OUTCOME.MINT || item.outcome === OUTCOME.REUSE) {
      for (const e of item.edges) edges.push(e);
    }
  }

  const opId = operationId ?? planOperationId(plan);
  const result = await store.apply({ operation_id: opId, mints, edges });

  return {
    operation_id: opId,
    replayed: result.replayed,
    applied: result.applied,
    edges_added: result.edges_added,
    reference_only: true,
    deferred: {
      review: plan.items.filter((i) => i.outcome === OUTCOME.REVIEW).map(summarize),
      blocked: plan.items.filter((i) => i.outcome === OUTCOME.BLOCKED).map(summarize),
    },
  };
}

function summarize(i) {
  return {
    local_id: i.local_id,
    outcome: i.outcome,
    reason: i.reason,
    membership: i.membership?.membership ?? null,
    binding: i.binding?.tier ?? null,
  };
}

/**
 * Inspect a plan (and optionally a store) and return a machine-readable summary.
 *
 * Reports membership and binding as separate distributions on purpose: a run
 * can be all-verified-present and still all-untrusted-binding, and an operator
 * needs to see that rather than a single blended "confidence".
 */
export function inspectPlan(plan, storeState = null) {
  const membership = {};
  const binding = {};
  const edgeTypes = {};

  for (const i of plan.items) {
    const m = i.membership?.membership ?? "none";
    membership[m] = (membership[m] ?? 0) + 1;
    const b = i.binding?.tier ?? "none";
    binding[b] = (binding[b] ?? 0) + 1;
    for (const e of i.edges) edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1;
  }

  const report = {
    reference_only: true,
    source: { ...plan.source },
    registry_capture: { ...plan.registry_capture },
    counts: { ...plan.counts },
    membership: sortKeys(membership),
    binding: sortKeys(binding),
    edge_types: sortKeys(edgeTypes),
    needs_attention: plan.items
      .filter((i) => i.outcome === OUTCOME.REVIEW || i.outcome === OUTCOME.BLOCKED)
      .map(summarize)
      .sort((a, b) => String(a.local_id).localeCompare(String(b.local_id))),
  };

  if (storeState) {
    report.store = {
      entities: Object.keys(storeState.entities ?? {}).length,
      aliases: Object.keys(storeState.aliases ?? {}).length,
      edges: (storeState.edges ?? []).length,
      operations: Object.keys(storeState.operations ?? {}).length,
    };
  }

  return report;
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Deterministically export a plan (and optionally store state).
 *
 * Determinism here means: the same inputs produce byte-identical output. No
 * timestamps, no iteration-order dependence, no random ids. Everything is sorted
 * by a stable key and object keys are emitted in fixed order. This is what makes
 * an export diffable and safe to commit as a fixture.
 */
export function exportBridge(plan, storeState = null) {
  const entities = plan.items
    .filter((i) => i.id)
    .map((i) => ({
      id: i.id,
      local_id: i.local_id,
      outcome: i.outcome,
      label: i.record.label ?? null,
      membership: i.membership?.membership ?? null,
      binding: i.binding?.tier ?? null,
      reference_only: true,
      grounded: false,
      status: i.outcome === OUTCOME.MINT ? "provisional" : "existing",
    }))
    .sort(byKey((e) => `${e.local_id}\u0000${e.id}`));

  const edges = plan.items
    .flatMap((i) => i.edges)
    .map((e) => ({
      type: e.type,
      from: e.from,
      to: e.to ?? null,
      registry: e.registry ?? null,
      external_id: e.external_id ?? null,
      membership: e.membership ?? null,
      binding: e.binding?.tier ?? null,
    }))
    .sort(byKey((e) => [e.type, e.from, e.to ?? "", e.registry ?? "", e.external_id ?? ""].join("\u0000")));

  const deferred = plan.items
    .filter((i) => i.outcome === OUTCOME.REVIEW || i.outcome === OUTCOME.BLOCKED)
    .map((i) => ({
      local_id: i.local_id,
      outcome: i.outcome,
      reason: i.reason,
      membership: i.membership?.membership ?? null,
      binding: i.binding?.tier ?? null,
    }))
    .sort(byKey((d) => `${d.local_id}\u0000${d.outcome}`));

  const doc = {
    export_version: 1,
    reference_only: true,
    grounded: false,
    source: {
      registry: plan.source.registry,
      dataset: plan.source.dataset ?? null,
      theme: plan.source.theme ?? null,
    },
    home_token: plan.home_token,
    registry_capture: {
      capture_id: plan.registry_capture.capture_id ?? null,
      release: plan.registry_capture.release ?? null,
      size: plan.registry_capture.size ?? 0,
      stale: Boolean(plan.registry_capture.stale),
    },
    counts: {
      reuse: plan.counts.reuse,
      mint: plan.counts.mint,
      review: plan.counts.review,
      blocked: plan.counts.blocked,
    },
    entities,
    edges,
    deferred,
  };

  if (storeState) {
    doc.store = {
      entities: Object.keys(storeState.entities ?? {}).sort(),
      aliases: Object.keys(storeState.aliases ?? {})
        .sort()
        .map((k) => {
          const [registry, external_id] = k.split("\u0000");
          return { registry, external_id, id: storeState.aliases[k] };
        }),
    };
  }

  return doc;
}

function byKey(fn) {
  return (a, b) => {
    const ka = fn(a);
    const kb = fn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** Serialize an export deterministically (stable key order, trailing newline). */
export function serializeExport(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
