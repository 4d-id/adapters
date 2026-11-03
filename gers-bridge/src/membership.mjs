// GERS membership verification against a registry capture.
//
// The single most important rule in this package:
//
//     Membership in GERS is NEVER inferred from the syntax of an identifier.
//
// Overture assigns GERS IDs only to features in its reference map, and since the
// June 2025 release those IDs are plain UUIDv4 values. A UUIDv4 therefore tells
// you nothing about whether Overture ever issued it. Any tool that treats
// "looks like a UUID" as "is in GERS" is lying to its user. This module exists
// so that lie is structurally impossible here.
//
// Four outcomes, and they are not interchangeable:
//
//   verified_present  a registry capture we trust covers this ID and lists it
//   verified_absent   a registry capture we trust covers this ID and omits it
//   unknown           we could not establish coverage (no capture, capture does
//                     not cover this key space, capture is stale, lookup failed)
//   invalid           the identifier is not even syntactically a UUID
//
// `unknown` is the default and it is load-bearing: a failed lookup is NOT a
// no-match. Conflating the two is how bridges silently mint duplicates.

import { classifyGersSyntax } from "./identity.mjs";

export const MEMBERSHIP = Object.freeze({
  PRESENT: "verified_present",
  ABSENT: "verified_absent",
  UNKNOWN: "unknown",
  INVALID: "invalid",
});

/**
 * A registry capture: a point-in-time extract of the GERS registry (or a subset
 * of it) that we are willing to treat as authoritative for the IDs it covers.
 *
 * A capture must declare what it covers. A capture that lists 40 building IDs
 * from one release cannot answer "is this place ID absent from GERS?" — the
 * honest answer there is `unknown`, not `verified_absent`.
 *
 * @typedef {object} RegistryCapture
 * @property {string}   capture_id     identifier for this capture
 * @property {string}   release        Overture release label, e.g. "2026-10-22.0"
 * @property {string}   captured_at    ISO-8601 instant the capture was taken
 * @property {string[]} [themes]       themes covered; absent/empty means "unscoped"
 * @property {string[]} ids            GERS IDs present in the capture
 * @property {number}   [max_age_days] staleness budget; older captures answer `unknown`
 */

/**
 * Build a verifier over a registry capture.
 *
 * @param {RegistryCapture} capture
 * @param {{ now?: () => Date }} [opts]
 */
export function createRegistryVerifier(capture, { now = () => new Date() } = {}) {
  if (!capture || typeof capture !== "object") {
    throw new Error("registry capture required");
  }
  if (!Array.isArray(capture.ids)) {
    throw new Error("registry capture must carry an ids array");
  }
  if (!capture.capture_id || !capture.release || !capture.captured_at) {
    throw new Error("registry capture must carry capture_id, release and captured_at");
  }

  // Normalize once. Entries that are not UUIDs are dropped from the present-set
  // and reported, rather than silently trusted.
  const present = new Set();
  const malformedEntries = [];
  for (const raw of capture.ids) {
    const s = classifyGersSyntax(raw);
    if (s.wellFormed) present.add(s.normalized);
    else malformedEntries.push(raw);
  }

  const themes = Array.isArray(capture.themes) ? capture.themes.filter(Boolean) : [];
  const scoped = themes.length > 0;

  function staleness() {
    const capturedAt = Date.parse(capture.captured_at);
    if (Number.isNaN(capturedAt)) {
      return { stale: true, reason: "capture has an unparseable captured_at", ageDays: null };
    }
    const ageDays = (now().getTime() - capturedAt) / 86_400_000;
    if (capture.max_age_days != null && ageDays > capture.max_age_days) {
      return {
        stale: true,
        reason: `capture is ${ageDays.toFixed(1)}d old, past its ${capture.max_age_days}d budget`,
        ageDays,
      };
    }
    return { stale: false, reason: null, ageDays };
  }

  /**
   * Verify one candidate GERS ID.
   *
   * @param {string} candidate
   * @param {{ theme?: string }} [ctx] the theme the caller believes the feature
   *        belongs to; required to claim `verified_absent` against a scoped capture
   * @returns {{ membership: string, gers_id: string|null, reason: string,
   *             capture_id: string, release: string, evidence: object }}
   */
  function verify(candidate, { theme } = {}) {
    const syntax = classifyGersSyntax(candidate);
    const base = {
      capture_id: capture.capture_id,
      release: capture.release,
      evidence: {
        capture_id: capture.capture_id,
        release: capture.release,
        captured_at: capture.captured_at,
        themes: scoped ? themes : null,
        checked_at: now().toISOString(),
      },
    };

    if (!syntax.wellFormed) {
      return {
        ...base,
        membership: MEMBERSHIP.INVALID,
        gers_id: null,
        reason: `not a syntactically valid GERS identifier (${syntax.reason})`,
      };
    }

    const gersId = syntax.normalized;

    // Staleness gates BOTH answers. A stale capture can still be wrong in either
    // direction, so it yields `unknown`, not a present/absent claim.
    const age = staleness();
    if (age.stale) {
      return {
        ...base,
        membership: MEMBERSHIP.UNKNOWN,
        gers_id: gersId,
        reason: `coverage not established: ${age.reason}`,
        evidence: { ...base.evidence, stale: true, age_days: age.ageDays },
      };
    }

    if (present.has(gersId)) {
      // A hit is a hit regardless of declared theme: the capture demonstrably
      // lists the ID. Theme scope only constrains absence claims.
      return {
        ...base,
        membership: MEMBERSHIP.PRESENT,
        gers_id: gersId,
        reason: `listed in registry capture ${capture.capture_id} (release ${capture.release})`,
      };
    }

    // Not listed. We may only call that `verified_absent` if this capture
    // actually covers the key space the candidate lives in.
    if (scoped) {
      if (!theme) {
        return {
          ...base,
          membership: MEMBERSHIP.UNKNOWN,
          gers_id: gersId,
          reason:
            `capture covers only [${themes.join(", ")}] and no theme was declared for this ` +
            `record, so absence cannot be established`,
        };
      }
      if (!themes.includes(theme)) {
        return {
          ...base,
          membership: MEMBERSHIP.UNKNOWN,
          gers_id: gersId,
          reason:
            `capture covers [${themes.join(", ")}] and does not cover theme "${theme}", ` +
            `so absence cannot be established`,
        };
      }
    }

    return {
      ...base,
      membership: MEMBERSHIP.ABSENT,
      gers_id: gersId,
      reason:
        `not listed in registry capture ${capture.capture_id} (release ${capture.release})` +
        (scoped ? `, which covers theme "${theme}"` : ""),
    };
  }

  return {
    verify,
    capture_id: capture.capture_id,
    release: capture.release,
    size: present.size,
    themes: scoped ? [...themes] : null,
    malformedEntries: [...malformedEntries],
    get stale() {
      return staleness().stale;
    },
  };
}

/**
 * A verifier for when no registry capture is available at all.
 *
 * Every well-formed identifier comes back `unknown`. This is the correct default
 * for a bridge run without registry evidence: it does not pretend the IDs are
 * real, and it does not pretend they are absent either.
 */
export function createUnknownVerifier({ reason = "no registry capture supplied" } = {}) {
  return {
    verify(candidate) {
      const syntax = classifyGersSyntax(candidate);
      if (!syntax.wellFormed) {
        return {
          membership: MEMBERSHIP.INVALID,
          gers_id: null,
          reason: `not a syntactically valid GERS identifier (${syntax.reason})`,
          capture_id: null,
          release: null,
          evidence: { capture_id: null },
        };
      }
      return {
        membership: MEMBERSHIP.UNKNOWN,
        gers_id: syntax.normalized,
        reason,
        capture_id: null,
        release: null,
        evidence: { capture_id: null },
      };
    },
    capture_id: null,
    release: null,
    size: 0,
    themes: null,
    malformedEntries: [],
    stale: false,
  };
}
