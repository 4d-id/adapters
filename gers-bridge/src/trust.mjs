// Source-binding trust.
//
// Membership (membership.mjs) answers: "is this GERS ID real?"
// Binding trust answers:               "do we believe THIS record is THAT feature?"
//
// They are independent and must stay independent. The failure mode this guards
// against is the common one: a real GERS ID is pasted into a spreadsheet column
// by hand, the ID verifies as present, and the tool concludes the row is that
// building. The ID being real says nothing about whether the binding is right.
//
// Conversely a record can carry an impeccable binding — straight out of an
// Overture-published bridge file — whose ID our capture does not list, usually
// because the capture and the bridge file are from different releases. That is a
// review item, not an absence.

/**
 * Binding tiers, ordered. Higher means we have better evidence that this
 * particular record corresponds to that particular GERS feature.
 */
export const BINDING = Object.freeze({
  /** From an Overture-published bridge file: source record_id -> GERS ID. */
  BRIDGE_FILE: "bridge_file",
  /** From a third-party onboarding/matching service that reports a method. */
  ONBOARDING_SERVICE: "onboarding_service",
  /** The data owner asserted the GERS ID themselves, unverified. */
  SELF_ASSERTED: "self_asserted",
  /** A GERS ID is present but nothing says where it came from. */
  UNATTRIBUTED: "unattributed",
  /** No GERS ID offered at all. */
  NONE: "none",
});

const RANK = Object.freeze({
  [BINDING.BRIDGE_FILE]: 40,
  [BINDING.ONBOARDING_SERVICE]: 30,
  [BINDING.SELF_ASSERTED]: 20,
  [BINDING.UNATTRIBUTED]: 10,
  [BINDING.NONE]: 0,
});

/** Numeric rank for a binding tier; unknown tiers rank 0. */
export function bindingRank(tier) {
  return RANK[tier] ?? 0;
}

/** True when `tier` meets or exceeds `minimum`. */
export function meetsBindingTrust(tier, minimum) {
  return bindingRank(tier) >= bindingRank(minimum);
}

/**
 * Classify how a record came to carry its GERS ID.
 *
 * Reads the explicit `gers_binding` block when the producer supplied one, and
 * otherwise degrades to `unattributed` — never upward. A record cannot earn a
 * better tier by omitting information.
 *
 * @param {object} record a normalized bridge record (see input.mjs)
 * @returns {{ tier: string, method: string|null, attributed_to: string|null, reason: string }}
 */
export function classifyBinding(record) {
  const candidate = record?.gers_id;
  if (candidate == null || String(candidate).trim() === "") {
    return {
      tier: BINDING.NONE,
      method: null,
      attributed_to: null,
      reason: "record carries no GERS identifier",
    };
  }

  const b = record?.gers_binding;
  if (!b || typeof b !== "object") {
    return {
      tier: BINDING.UNATTRIBUTED,
      method: null,
      attributed_to: null,
      reason: "GERS identifier present with no binding provenance",
    };
  }

  const source = String(b.source ?? "").trim();
  const method = b.method ? String(b.method) : null;
  const attributedTo = b.attributed_to ? String(b.attributed_to) : null;

  if (source === BINDING.BRIDGE_FILE) {
    // A bridge file claim is only as good as its identification. Without the
    // release and the source record id it is not a bridge-file claim, it is a
    // self-assertion wearing one.
    if (!b.release || !b.source_record_id) {
      return {
        tier: BINDING.SELF_ASSERTED,
        method,
        attributed_to: attributedTo,
        reason:
          "claims bridge_file provenance but omits release and/or source_record_id; " +
          "demoted to self_asserted",
      };
    }
    return {
      tier: BINDING.BRIDGE_FILE,
      method: method ?? "bridge-file-join",
      attributed_to: attributedTo,
      reason: `bridge file for release ${b.release}, source record ${b.source_record_id}`,
    };
  }

  if (source === BINDING.ONBOARDING_SERVICE) {
    if (!attributedTo) {
      return {
        tier: BINDING.SELF_ASSERTED,
        method,
        attributed_to: null,
        reason:
          "claims onboarding_service provenance but names no service; demoted to self_asserted",
      };
    }
    return {
      tier: BINDING.ONBOARDING_SERVICE,
      method: method ?? "external-match",
      attributed_to: attributedTo,
      reason: `matched by onboarding service ${attributedTo}`,
    };
  }

  if (source === BINDING.SELF_ASSERTED) {
    return {
      tier: BINDING.SELF_ASSERTED,
      method,
      attributed_to: attributedTo,
      reason: "GERS identifier asserted by the data owner",
    };
  }

  return {
    tier: BINDING.UNATTRIBUTED,
    method,
    attributed_to: attributedTo,
    reason: source
      ? `unrecognized binding source ${JSON.stringify(source)}`
      : "binding block carries no source",
  };
}
