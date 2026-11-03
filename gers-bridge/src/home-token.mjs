// Non-spatial home tokens, per 4D-ID 2.4 /req/core/genesis-privacy (Part 1, 7.2).
//
// The spec is strict about what may sit in the `cell` slot of an `id`-variant
// identifier, and the strictness is the entire point of the mode:
//
//   "Its `cell` slot SHALL be an opaque home token generated independently with
//    at least 128 bits of entropy from a documented cryptographically secure
//    source; it SHALL encode no place, person, or time, including encoded or
//    hashed derivatives of those values."
//
// Two consequences this module enforces rather than assumes:
//
//   1. **At least 128 bits of entropy, from a CSPRNG.** We generate tokens with
//      `randomBytes` (OpenSSL CSPRNG, the documented source) and we *reject*
//      caller-supplied tokens that cannot carry 128 bits.
//
//   2. **No place, person, or time — including hashed derivatives.** This is the
//      part a naive implementation gets wrong. Hashing a customer name or a
//      lat/lng into the token still *encodes* it: it is a derivative, it is
//      stable, and it is correlatable by anyone who can guess the input. We
//      cannot detect a hash by looking at it — a SHA-256 prefix and a CSPRNG
//      draw are indistinguishable — so the defense is structural: this module
//      offers **no** way to derive a token from an input. There is one
//      generator, it takes no seed, and it is the only blessed path.
//
// A human-meaningful token like "acme" is rejected outright. It has nothing like
// 128 bits, and it names a person/organization.

import { randomBytes } from "node:crypto";

/** Documented entropy source for the generated tokens. */
export const ENTROPY_SOURCE =
  "node:crypto randomBytes (OpenSSL CSPRNG), 16 bytes = 128 bits, hex-encoded";

export const HOME_TOKEN_BYTES = 16; // 128 bits
export const MIN_HOME_TOKEN_BITS = 128;

// The spec grammar allows [A-Za-z0-9.-]{1,64} in the cell slot. We additionally
// require the token be a single opaque run: dots are the legacy domain-root
// separator and hyphens invite structure, and structure is where place/person
// data hides.
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9]{22,64}$/;
const HEX_TOKEN_RE = /^[0-9a-f]{32,}$/;

/**
 * Generate a fresh non-spatial home token.
 *
 * Takes no arguments on purpose. There is deliberately no `deriveHomeToken`,
 * no seed parameter, and no namespacing hook: every such affordance is a way to
 * smuggle place, person, or time into the token.
 *
 * Rejected draws are retried. A random 128-bit hex string lands on something
 * that *looks* like a date roughly once in 1,500 draws, and on an epoch-shaped
 * run more often than that. Such a token is refused even though it is genuinely
 * random, because a consumer inspecting it cannot tell that it is — and a name
 * that looks like it leaks a timestamp will be read as one. Redrawing is free;
 * shipping an ambiguous token is not.
 *
 * @param {{ random?: (n: number) => Buffer, maxAttempts?: number }} [opts]
 * @returns {string} 32 hex chars carrying 128 bits of entropy
 */
export function generateHomeToken({ random = randomBytes, maxAttempts = 16 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = Buffer.from(random(HOME_TOKEN_BYTES)).toString("hex");
    const check = validateHomeToken(token);
    if (check.ok) return token;
    last = check.reason;
  }
  throw new Error(
    `could not generate a clean home token in ${maxAttempts} attempts (last: ${last}); ` +
      `this strongly suggests the supplied random source is not random`
  );
}

/**
 * Estimate the entropy a token could *at most* carry, from its alphabet and
 * length.
 *
 * This is a strict upper bound and nothing more. A 32-character string drawn
 * from a 16-symbol alphabet can carry at most 128 bits; it carries that much
 * only if the draws were actually random. We can refute "this token has 128
 * bits" but we can never confirm it by inspection — which is why generation is
 * the blessed path and validation is only a floor.
 */
export function maxEntropyBits(token) {
  const s = String(token);
  if (s.length === 0) return 0;
  let alphabet;
  if (/^[0-9a-f]+$/.test(s)) alphabet = 16;
  else if (/^[0-9a-zA-Z]+$/.test(s)) alphabet = 62;
  else alphabet = 64;
  return Math.floor(s.length * Math.log2(alphabet));
}

// Shapes that betray encoded place or time.
//
// These are deliberately NOT anchored on word boundaries. A valid home token is
// one continuous alphanumeric run, so `\b` would only ever match at the string
// ends and a timestamp buried mid-token would sail through. We scan anywhere.
//
// This catches honest mistakes, not a determined adversary: a hashed derivative
// is undetectable by construction, which is why generation — not validation — is
// the blessed path.
const TIME_SHAPES = [
  { re: /(19|20|21)\d{2}[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])/, what: "a date" },
  { re: /\d{8}T\d{6}Z?/, what: "an ISO basic timestamp" },
  { re: /(?<!\d)1[0-9]{9}(?!\d)/, what: "a unix epoch timestamp" },
];
const PLACE_SHAPES = [
  { re: /-?\d{1,3}\.\d{3,}[,_ ]+-?\d{1,3}\.\d{3,}/, what: "a lat/lng pair" },
  // Bounded by non-hex on both sides. An H3 index buried inside a longer *hex*
  // string is NOT detectable: any pattern sensitive enough also matches a large
  // fraction of genuinely random hex. See "what this cannot catch" below.
  { re: /(?<![0-9a-f])8[0-9a-f]{14}(?![0-9a-f])/, what: "an H3 cell index" },
  { re: /(geo|lat|lon|lng|utm|mgrs|quadkey|postcode)/i, what: "a place keyword" },
];

/**
 * Validate a home token against /req/core/genesis-privacy.
 *
 * Enforces what is mechanically checkable: grammar, length, an entropy floor,
 * and the absence of obvious place/time encodings.
 *
 * **What this cannot catch.** Two classes of leak are invisible to inspection:
 *
 *   * *Hashed derivatives.* A SHA-256 of a customer name is indistinguishable
 *     from a CSPRNG draw. The spec forbids it; no validator can detect it.
 *   * *Place or time embedded in a hex token.* Any pattern sensitive enough to
 *     find an H3 index inside 32 random hex characters also matches a large
 *     fraction of legitimate tokens, so such a check would reject good names.
 *     Only non-hex-bounded occurrences are caught.
 *
 * This is why generation, not validation, is the blessed path: `generateHomeToken`
 * takes no seed, so there is no supported way to derive a token from anything.
 * Validation is a floor for caller-supplied tokens, not a proof of compliance.
 *
 * @returns {{ ok: boolean, reason: string|null, bits: number }}
 */
export function validateHomeToken(token) {
  if (typeof token !== "string") {
    return { ok: false, reason: "home token must be a string", bits: 0 };
  }
  const s = token.trim();
  if (s === "") return { ok: false, reason: "home token is empty", bits: 0 };

  if (s.length > 64) {
    return { ok: false, reason: `home token exceeds the 64-char cell slot (${s.length})`, bits: 0 };
  }
  if (!OPAQUE_TOKEN_RE.test(s)) {
    return {
      ok: false,
      reason:
        `home token must be 22-64 opaque alphanumeric characters (got ${JSON.stringify(
          s.length > 24 ? `${s.slice(0, 24)}\u2026` : s
        )}); ` +
        `dots and hyphens are not permitted because structure is where place and person data hides`,
      bits: 0,
    };
  }

  const bits = maxEntropyBits(s);
  if (bits < MIN_HOME_TOKEN_BITS) {
    return {
      ok: false,
      reason:
        `home token carries at most ${bits} bits, below the ${MIN_HOME_TOKEN_BITS}-bit floor ` +
        `required by /req/core/genesis-privacy`,
      bits,
    };
  }

  for (const { re, what } of [...TIME_SHAPES, ...PLACE_SHAPES]) {
    if (re.test(s)) {
      return {
        ok: false,
        reason: `home token appears to encode ${what}; it SHALL encode no place, person, or time`,
        bits,
      };
    }
  }

  return { ok: true, reason: null, bits };
}

/**
 * Describe a token's provenance for the record.
 *
 * `generated` means this process drew it from the documented CSPRNG. `supplied`
 * means a caller handed it over and we verified only its shape and entropy
 * floor — we are trusting them that it was not derived from place, person, or
 * time, because that is not checkable.
 */
export function homeTokenProvenance(token, { generated = false } = {}) {
  const v = validateHomeToken(token);
  return {
    home_token: token,
    valid: v.ok,
    reason: v.reason,
    max_entropy_bits: v.bits,
    min_required_bits: MIN_HOME_TOKEN_BITS,
    source: generated ? ENTROPY_SOURCE : "caller-supplied",
    verified_random: Boolean(generated),
    note: generated
      ? "drawn from the documented CSPRNG in this process"
      : "shape and entropy floor checked; randomness and absence of hashed place/person/time " +
        "derivatives are asserted by the caller and cannot be verified by inspection",
  };
}

/** True when `token` satisfies the home-token rules. */
export function isValidHomeToken(token) {
  return validateHomeToken(token).ok;
}
