// Resolve-before-mint planning.
//
// The planner decides, per record, one of four outcomes:
//
//   reuse    an exact alias lookup returned exactly one existing 4D-ID
//   mint     every prerequisite was met and no existing identity matched
//   review   a human must decide (ambiguity, weak binding, unverifiable claim)
//   blocked  we cannot proceed and must not guess (failed lookup, bad input)
//
// The order of checks matters and is fixed:
//
//   1. Input sanity. No local id, no plan.
//   2. Exact alias lookup FIRST — both on the local registry id and on the GERS
//      id when one is offered. Reuse beats everything; an identity we already
//      issued must never be minted a second time.
//   3. Lookup completeness. Any failed lookup blocks. A failure is not a no-match.
//   4. Ambiguity. Two or more distinct matches never mint and never auto-merge.
//   5. Mint prerequisites. Membership outcome must be in policy.mint_on, binding
//      trust must clear policy.min_binding_trust, minting must be allowed.
//
// Nothing in this file reads geometry.

import { MEMBERSHIP } from "./membership.mjs";
import { BINDING, classifyBinding, meetsBindingTrust } from "./trust.mjs";
import { mint4did } from "./identity.mjs";
import { identifiedAsEdge, describesEdge, containsEdge } from "./edges.mjs";

export const OUTCOME = Object.freeze({
  REUSE: "reuse",
  MINT: "mint",
  REVIEW: "review",
  BLOCKED: "blocked",
});

const GERS_REGISTRY = "overture.gers";

/**
 * Plan a bridge run.
 *
 * @param {object[]} records   normalized records from input.normalizeRecords
 * @param {object}   manifest  parsed manifest
 * @param {object}   deps
 * @param {object}   deps.reader    resolver reader (lookupAlias)
 * @param {object}   deps.verifier  registry-capture verifier (verify)
 * @param {Function} [deps.uuid]    injectable UUIDv4 source, for deterministic tests
 * @param {Function} [deps.now]     injectable clock
 */
export async function planImport(records, manifest, { reader, verifier, uuid, now = () => new Date() }) {
  if (!reader) throw new Error("planImport requires a resolver reader");
  if (!verifier) throw new Error("planImport requires a registry verifier");

  const localRegistry = manifest.source.registry;
  const items = [];
  // 4D-IDs assigned within this plan, so a declared parent minted in the same
  // run can still be referenced by its children.
  const assigned = new Map();

  for (const record of records) {
    items.push(await planOne(record));
  }

  // Second pass: parentage. Done after all ids are known so forward references
  // resolve. A parent we could not identify yields no edge and a note, never a
  // guessed one.
  for (const item of items) {
    const parentLocal = item.record.parent_local_id;
    if (!parentLocal) continue;
    if (!item.id) {
      item.notes.push(`parentage skipped: this record has no 4D-ID (${item.outcome})`);
      continue;
    }
    const parentId = assigned.get(parentLocal);
    if (!parentId) {
      item.notes.push(
        `parentage skipped: declared parent "${parentLocal}" has no 4D-ID in this plan`
      );
      continue;
    }
    if (parentId === item.id) {
      item.notes.push(`parentage skipped: declared parent "${parentLocal}" resolves to this entity`);
      continue;
    }
    item.edges.push(containsEdge({ from: parentId, to: item.id }));
  }

  const counts = { reuse: 0, mint: 0, review: 0, blocked: 0 };
  for (const i of items) counts[i.outcome]++;

  return {
    plan_version: 1,
    reference_only: true,
    source: { ...manifest.source },
    home_token: manifest.home_token,
    policy: { ...manifest.policy, mint_on: [...manifest.policy.mint_on] },
    registry_capture: {
      capture_id: verifier.capture_id ?? null,
      release: verifier.release ?? null,
      size: verifier.size ?? 0,
      themes: verifier.themes ?? null,
      stale: Boolean(verifier.stale),
    },
    counts,
    items,
  };

  // -------------------------------------------------------------------------

  async function planOne(record) {
    const notes = [];
    const edges = [];
    const base = {
      source_index: record.source_index,
      local_id: record.local_id,
      record,
      id: null,
      edges,
      notes,
    };

    if (record.has_geometry) {
      notes.push(
        `geometry (${record.geometry_type}) present and ignored: this bridge performs no grounding`
      );
    }

    // --- 1. input sanity -------------------------------------------------
    if (!record.local_id) {
      return {
        ...base,
        outcome: OUTCOME.BLOCKED,
        reason: `record has no value for manifest field "${manifest.fields.local_id}"`,
        membership: null,
        binding: null,
      };
    }

    // --- membership (evidence, gathered before decisions) -----------------
    const membership = record.gers_id
      ? verifier.verify(record.gers_id, { theme: record.theme })
      : {
          membership: MEMBERSHIP.UNKNOWN,
          gers_id: null,
          reason: "record offers no GERS identifier",
          capture_id: verifier.capture_id ?? null,
          release: verifier.release ?? null,
          evidence: { capture_id: verifier.capture_id ?? null },
        };

    const binding = classifyBinding(record);

    // --- 2. exact aliases first ------------------------------------------
    const lookups = [];
    const localLookup = await reader.lookupAlias({
      registry: localRegistry,
      external_id: record.local_id,
    });
    lookups.push({ registry: localRegistry, external_id: record.local_id, ...localLookup });

    // Only look up a GERS id we consider usable as a key. An `invalid` string
    // is not a key; querying on it would be noise.
    if (membership.gers_id && membership.membership !== MEMBERSHIP.INVALID) {
      const gersLookup = await reader.lookupAlias({
        registry: GERS_REGISTRY,
        external_id: membership.gers_id,
      });
      lookups.push({
        registry: GERS_REGISTRY,
        external_id: membership.gers_id,
        ...gersLookup,
      });
    }

    const matchIds = new Set();
    for (const l of lookups) {
      if (l.ok) for (const m of l.matches) matchIds.add(m.id);
    }

    // --- 4. ambiguity (checked before reuse: 2+ distinct ids is never a reuse)
    if (matchIds.size > 1) {
      return {
        ...base,
        outcome: OUTCOME.REVIEW,
        reason:
          `ambiguous: exact alias lookup matched ${matchIds.size} distinct 4D-IDs ` +
          `(${[...matchIds].sort().join(", ")}); ambiguity never mints and never auto-merges`,
        membership,
        binding,
        candidates: [...matchIds].sort(),
        lookups,
      };
    }

    if (matchIds.size === 1) {
      const id = [...matchIds][0];
      assigned.set(record.local_id, id);
      // A reuse still records its identifier edges, so the existing entity picks
      // up any alias it was missing.
      appendIdentifierEdges(id, edges, record, membership, binding, notes);
      // Note, but do not block on, an incomplete lookup: we already have a
      // definite single match, and reuse is the safe direction.
      const failed = lookups.filter((l) => !l.ok);
      for (const f of failed) {
        notes.push(`lookup on ${f.registry} did not complete (${f.reason}); reuse unaffected`);
      }
      return {
        ...base,
        id,
        outcome: OUTCOME.REUSE,
        reason: `exact alias match on existing identity ${id}`,
        membership,
        binding,
        lookups,
      };
    }

    // --- 3. lookup completeness ------------------------------------------
    // No match found — but only trust that if every lookup actually completed.
    const failed = lookups.filter((l) => !l.ok);
    if (failed.length > 0) {
      return {
        ...base,
        outcome: OUTCOME.BLOCKED,
        reason:
          `resolver lookup did not complete (${failed.map((f) => `${f.registry}: ${f.reason}`).join("; ")}); ` +
          `a failed lookup is not a no-match, so minting is refused`,
        membership,
        binding,
        lookups,
      };
    }

    // --- 5. mint prerequisites -------------------------------------------
    if (!manifest.policy.allow_mint) {
      return {
        ...base,
        outcome: OUTCOME.REVIEW,
        reason: "no existing identity matched and manifest policy disallows minting",
        membership,
        binding,
        lookups,
      };
    }

    if (membership.membership === MEMBERSHIP.INVALID) {
      return {
        ...base,
        outcome: OUTCOME.BLOCKED,
        reason: `record carries an unusable GERS identifier: ${membership.reason}`,
        membership,
        binding,
        lookups,
      };
    }

    if (!manifest.policy.mint_on.includes(membership.membership)) {
      return {
        ...base,
        outcome: OUTCOME.REVIEW,
        reason:
          `membership is "${membership.membership}" (${membership.reason}) and policy mints only on ` +
          `[${manifest.policy.mint_on.join(", ")}]`,
        membership,
        binding,
        lookups,
      };
    }

    // Binding trust only gates records that actually carry a GERS id. A record
    // with no GERS id has nothing to bind and is judged on membership alone.
    if (binding.tier !== BINDING.NONE && !meetsBindingTrust(binding.tier, manifest.policy.min_binding_trust)) {
      return {
        ...base,
        outcome: OUTCOME.REVIEW,
        reason:
          `source binding is "${binding.tier}" (${binding.reason}) and policy requires at least ` +
          `"${manifest.policy.min_binding_trust}"`,
        membership,
        binding,
        lookups,
      };
    }

    const id = mint4did({ homeToken: manifest.home_token, ...(uuid ? { uuid } : {}) });
    assigned.set(record.local_id, id);
    appendIdentifierEdges(id, edges, record, membership, binding, notes);

    return {
      ...base,
      id,
      outcome: OUTCOME.MINT,
      reason: `no existing identity matched; membership "${membership.membership}", binding "${binding.tier}"`,
      membership,
      binding,
      lookups,
      marking: {
        reference_only: true,
        status: "provisional",
        grounded: false,
        note:
          "minted by a reference-only bridge from registry correspondence; carries no grounding " +
          "and is provisional until promoted by an authority",
      },
      aliases: aliasesFor(record, membership, binding),
    };
  }

  /**
   * Attach identifier edges.
   *
   * The local registry id is always an `identified_as`: it is the record's own
   * key in its own registry, which we are not second-guessing.
   *
   * The GERS id is an `identified_as` only when membership is verified_present
   * AND binding clears the policy bar. Otherwise it degrades to `describes`:
   * the attributes may still be useful, but we will not assert the two records
   * are the same thing on evidence that thin.
   */
  function appendIdentifierEdges(id, edges, record, membership, binding, notes) {
    edges.push(
      identifiedAsEdge({
        from: id,
        registry: localRegistry,
        external_id: record.local_id,
        membership: null,
        binding: { tier: "source_of_record", reason: "record's own key in its own registry" },
      })
    );

    if (!membership.gers_id) return;

    const trusted = meetsBindingTrust(binding.tier, manifest.policy.min_binding_trust);
    const present = membership.membership === MEMBERSHIP.PRESENT;

    if (present && trusted) {
      edges.push(
        identifiedAsEdge({
          from: id,
          registry: GERS_REGISTRY,
          external_id: membership.gers_id,
          membership: membership.membership,
          binding,
        })
      );
      return;
    }

    edges.push(
      describesEdge({
        from: id,
        registry: GERS_REGISTRY,
        external_id: membership.gers_id,
        membership: membership.membership,
        binding,
      })
    );
    notes.push(
      `GERS correspondence recorded as "describes" rather than "identified_as": ` +
        `membership=${membership.membership}, binding=${binding.tier}`
    );
  }

  function aliasesFor(record, membership, binding) {
    const out = [{ registry: localRegistry, external_id: record.local_id }];
    if (
      membership.membership === MEMBERSHIP.PRESENT &&
      meetsBindingTrust(binding.tier, manifest.policy.min_binding_trust)
    ) {
      out.push({ registry: GERS_REGISTRY, external_id: membership.gers_id });
    }
    return out;
  }
}
