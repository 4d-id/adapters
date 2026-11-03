// Deterministic tests for @4d-id/gers-bridge.
//
// Every test is deterministic: clocks and UUID sources are injected, no network
// is touched, and temp dirs are cleaned up. Run with `npm test`.

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  classifyGersSyntax,
  mint4did,
  isNonSpatial4did,
  parseNonSpatial4did,
  generateHomeToken,
  validateHomeToken,
  maxEntropyBits,
  homeTokenProvenance,
  MIN_HOME_TOKEN_BITS,
  MEMBERSHIP,
  createRegistryVerifier,
  createUnknownVerifier,
  BINDING,
  classifyBinding,
  meetsBindingTrust,
  parseManifest,
  parseInput,
  normalizeRecords,
  EDGE,
  edgeSemantics,
  containsEdge,
  representsEdge,
  OUTCOME,
  planImport,
  createMemoryResolverReader,
  createHttpResolverReader,
  assertReadOnly,
  createJsonFileStore,
  applyPlan,
  inspectPlan,
  exportBridge,
  serializeExport,
} from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, "..", "samples");

// --- tiny harness ----------------------------------------------------------
let fail = 0;
let count = 0;
const t = (name, cond, detail) => {
  count++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) {
    fail++;
    if (detail !== undefined) console.log(`       ${detail}`);
  }
};
const section = (s) => console.log(`\n${s}`);

// --- deterministic fixtures ------------------------------------------------
const CAPTURE = {
  capture_id: "cap-test",
  release: "2026-10-22.0",
  captured_at: "2026-10-22T00:00:00Z",
  themes: ["buildings"],
  max_age_days: 90,
  ids: [
    "08b2a1c4-5d6e-4f70-8192-a3b4c5d6e7f8", // present
    "1c9d4e2b-77a3-4b51-9e0c-2f6a8d13b4c5",
  ],
};
const NOW = () => new Date("2026-10-25T00:00:00Z"); // 3 days after capture

// A fixed, spec-valid home token: 32 hex chars = 128 bits, opaque, and encoding
// no place, person, or time. Fixed (not generated) so tests stay deterministic.
const HOME = "5a89fc81f07739510a815e8c202160ac";
const PRESENT = "08b2a1c4-5d6e-4f70-8192-a3b4c5d6e7f8";
const ABSENT = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b"; // valid UUIDv4, not in capture

/** Deterministic UUIDv4 source. */
function seqUuid(start = 0) {
  let n = start;
  return () => {
    const h = (n++).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${h}`;
  };
}

const MANIFEST = parseManifest({
  manifest_version: 1,
  source: { registry: "acme.facilities", dataset: "test", theme: "buildings" },
  home_token: HOME,
  fields: {
    local_id: "facility_id",
    gers_id: "gers_id",
    label: "name",
    parent_local_id: "campus_id",
    theme: "overture_theme",
  },
  policy: { min_binding_trust: BINDING.ONBOARDING_SERVICE, mint_on: [MEMBERSHIP.PRESENT, MEMBERSHIP.ABSENT] },
});

const verifier = createRegistryVerifier(CAPTURE, { now: NOW });

/** Build records from inline feature objects. */
const recs = (features) => normalizeRecords(features, MANIFEST);
const feat = (props) => ({ type: "Feature", properties: props });
const goodBinding = {
  source: "onboarding_service",
  method: "geometry-match",
  attributed_to: "example-onboarding-co",
};

const tmpDirs = [];
async function tempStorePath(name = "store.json") {
  const dir = await mkdtemp(join(tmpdir(), "gers-bridge-test-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

// ===========================================================================
section("membership: syntax is never membership");
// ===========================================================================

{
  // 1
  const syn = classifyGersSyntax(ABSENT);
  const v = verifier.verify(ABSENT, { theme: "buildings" });
  t(
    "a well-formed UUIDv4 that is not in the capture is verified_absent, not present",
    syn.wellFormed === true && v.membership === MEMBERSHIP.ABSENT,
    `syntax=${syn.wellFormed} membership=${v.membership}`
  );

  // 2
  const present = verifier.verify(PRESENT, { theme: "buildings" });
  t(
    "an id listed in the capture is verified_present and cites the capture",
    present.membership === MEMBERSHIP.PRESENT &&
      present.capture_id === "cap-test" &&
      present.release === "2026-10-22.0",
    JSON.stringify(present)
  );

  // 3
  const bad = verifier.verify("not-a-uuid", { theme: "buildings" });
  t(
    "a malformed identifier is invalid, distinct from absent",
    bad.membership === MEMBERSHIP.INVALID && bad.gers_id === null,
    JSON.stringify(bad)
  );

  // 4
  const unknownVerifier = createUnknownVerifier();
  const u = unknownVerifier.verify(PRESENT);
  t(
    "with no registry capture, even a real GERS id is unknown (never inferred present)",
    u.membership === MEMBERSHIP.UNKNOWN,
    JSON.stringify(u)
  );

  // 5 — scope: capture covers buildings only, so a places record cannot be absent
  const outOfScope = verifier.verify(ABSENT, { theme: "places" });
  t(
    "an unlisted id outside the capture's theme scope is unknown, not absent",
    outOfScope.membership === MEMBERSHIP.UNKNOWN,
    JSON.stringify(outOfScope)
  );

  // 6 — staleness
  const staleVerifier = createRegistryVerifier(CAPTURE, {
    now: () => new Date("2027-06-01T00:00:00Z"), // way past the 90d budget
  });
  const stalePresent = staleVerifier.verify(PRESENT, { theme: "buildings" });
  const staleAbsent = staleVerifier.verify(ABSENT, { theme: "buildings" });
  t(
    "a stale capture yields unknown for both present and absent lookups",
    stalePresent.membership === MEMBERSHIP.UNKNOWN &&
      staleAbsent.membership === MEMBERSHIP.UNKNOWN &&
      staleVerifier.stale === true,
    `${stalePresent.membership}/${staleAbsent.membership}`
  );
}

// ===========================================================================
section("home tokens: >=128 bits, no place/person/time (/req/core/genesis-privacy)");
// ===========================================================================

{
  // A — generated tokens meet the floor and are unique
  const tokens = new Set();
  let allValid = true;
  let minBits = Infinity;
  for (let i = 0; i < 200; i++) {
    const tk = generateHomeToken();
    tokens.add(tk);
    const v = validateHomeToken(tk);
    if (!v.ok) allValid = false;
    minBits = Math.min(minBits, v.bits);
  }
  t(
    "generateHomeToken yields unique tokens carrying at least 128 bits",
    tokens.size === 200 && allValid && minBits >= MIN_HOME_TOKEN_BITS,
    `unique=${tokens.size} valid=${allValid} minBits=${minBits}`
  );

  // B — short / human-meaningful tokens are rejected on the entropy floor.
  // "acme" is the exact mistake this guards: meaningful, and nowhere near 128 bits.
  const shortCases = ["acme", "acme-facilities", "a", "0123456789abcdef"]; // last = 64 bits
  t(
    "rejects short and human-meaningful home tokens below the 128-bit floor",
    shortCases.every((c) => validateHomeToken(c).ok === false),
    JSON.stringify(shortCases.map((c) => [c, validateHomeToken(c).reason]))
  );

  // C — entropy accounting is by alphabet and length
  t(
    "entropy is bounded by alphabet and length, not assumed",
    maxEntropyBits("0".repeat(32)) === 128 && // 32 hex chars = 128 bits
      maxEntropyBits("0".repeat(31)) === 124 && // one short -> under the floor
      validateHomeToken("0".repeat(31)).ok === false,
    `${maxEntropyBits("0".repeat(32))}/${maxEntropyBits("0".repeat(31))}`
  );

  // D — tokens that encode place or time are refused even at full length.
  // Note these are mid-token, not at the ends: a home token is one continuous
  // alphanumeric run, so a word-boundary-anchored check would miss all of them.
  const leaky = [
    "zzzz20260503T141500Zzzzzzzzzzzzzzz", // ISO basic timestamp
    "zzzzzzzzzzzzzz20260503zzzzzzzzzzzz", // a date
    "zzzzzzzz8928308280fffffzzzzzzzzzzz", // an H3 cell index
    "zzzzzzzzzzzzzzzzzzgeozzzzzzzzzzzzz", // a place keyword
    "zzzzzzzzzzzzzzz1760000000zzzzzzzzz", // a unix epoch
    "zzzzzzzzzzzzzzzzzpostcodezzzzzzzzz", // a postcode keyword
  ];
  t(
    "refuses home tokens that encode a place or a time mid-token, at full length",
    leaky.every((c) => validateHomeToken(c).ok === false),
    JSON.stringify(leaky.filter((c) => validateHomeToken(c).ok))
  );

  // D2 — the generator redraws rather than emitting a token that merely *looks*
  // like it leaks a timestamp, even though such a draw is genuinely random.
  {
    const dateish = Buffer.from("aa20260503aabbccddeeff00112233445566", "hex");
    let calls = 0;
    const scripted = (n) => {
      calls++;
      // first draw looks like a date; subsequent draws are clean
      return calls === 1 ? dateish.subarray(0, n) : Buffer.alloc(n, 0xab);
    };
    const tk = generateHomeToken({ random: scripted });
    t(
      "the generator redraws past a token that merely looks like it encodes a date",
      calls === 2 && validateHomeToken(tk).ok === true && tk === "ab".repeat(16),
      JSON.stringify({ calls, tk })
    );
  }

  // D3 — a broken random source fails loudly instead of emitting a weak token
  {
    let threw = false;
    let msg = "";
    try {
      generateHomeToken({ random: (n) => Buffer.alloc(n, 0), maxAttempts: 3 });
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    // all-zero bytes -> "000...0", which trips the epoch/date shapes or floors
    t(
      "a degenerate random source either yields a valid token or fails loudly, never silently",
      threw ? /not random/.test(msg) : validateHomeToken("0".repeat(32)).ok === true,
      msg
    );
  }

  // E — structure is refused: dots/hyphens are where place and person data hides
  t(
    "refuses structured tokens with dots or hyphens",
    validateHomeToken("5a89fc81f0773951.0a815e8c202160ac").ok === false &&
      validateHomeToken("5a89fc81f0773951-0a815e8c202160ac").ok === false &&
      validateHomeToken(HOME).ok === true
  );

  // F — provenance is honest about what it can and cannot verify
  const gen = homeTokenProvenance(generateHomeToken(), { generated: true });
  const sup = homeTokenProvenance(HOME);
  t(
    "provenance distinguishes a CSPRNG draw from an unverifiable caller-supplied token",
    gen.verified_random === true &&
      /CSPRNG/.test(gen.source) &&
      sup.verified_random === false &&
      sup.source === "caller-supplied" &&
      /cannot be verified/.test(sup.note) &&
      sup.valid === true,
    JSON.stringify({ gen: gen.verified_random, sup: sup.verified_random })
  );

  // G — there is deliberately no derivation path
  const mod = await import("../src/home-token.mjs");
  t(
    "the module exposes no way to derive a token from an input",
    !("deriveHomeToken" in mod) &&
      !("homeTokenFrom" in mod) &&
      generateHomeToken.length <= 1, // options bag only; no seed parameter
    JSON.stringify(Object.keys(mod))
  );
}

// ===========================================================================
section("identity: non-spatial minting");
// ===========================================================================

{
  // 7
  const id = mint4did({ homeToken: HOME, uuid: seqUuid(1) });
  t(
    "mints 4did:id:<home-token>:<uuidv4-base64url> with no cell or pose",
    id === `4did:id:${HOME}:AAAAAAAAQACAAAAAAAAAAQ` &&
      isNonSpatial4did(id) &&
      !id.includes(";v=") &&
      !id.includes(":h3:"),
    id
  );

  // bad home token must throw
  const mintThrows = (opts) => {
    try {
      mint4did(opts);
      return false;
    } catch {
      return true;
    }
  };
  t(
    "minting rejects an invalid or under-entropy home token",
    mintThrows({ homeToken: "bad token!", uuid: seqUuid() }) &&
      mintThrows({ homeToken: "acme", uuid: seqUuid() }) &&
      mintThrows({ homeToken: undefined, uuid: seqUuid() })
  );

  // UUIDv7 descriptors are forbidden: their timestamp would encode mint time
  const v7 = () => "01927a3c-1f2e-7abc-8def-0123456789ab";
  let v7Msg = "";
  try {
    mint4did({ homeToken: HOME, uuid: v7 });
  } catch (e) {
    v7Msg = e.message;
  }
  t(
    "refuses a UUIDv7 descriptor because it would encode mint time",
    /UUIDv4/.test(v7Msg) && /mint time/.test(v7Msg),
    v7Msg
  );

  // the minted form carries no vref and no genesis marker
  const parsed = parseNonSpatial4did(id);
  t(
    "minted ids carry no vertical reference and no genesis marker",
    !id.includes(";v=") &&
      id.split(":").length === 4 &&
      parsed.variant === "id" &&
      parsed.home_token === HOME &&
      // a genesis-suffixed or vref-bearing id is not accepted
      isNonSpatial4did(`${id}:20260503T141500Z`) === false &&
      isNonSpatial4did(`4did:id:${HOME};v=floor.2:AAAAAAAAQACAAAAAAAAAAQ`) === false,
    JSON.stringify(parsed)
  );

  // an id whose home token is under-entropy is not a valid non-spatial id
  t(
    "validation rejects an id whose home token misses the entropy floor",
    isNonSpatial4did("4did:id:acme:AAAAAAAAQACAAAAAAAAAAQ") === false &&
      isNonSpatial4did(id) === true
  );
}

// ===========================================================================
section("trust: source binding is separate from membership");
// ===========================================================================

{
  // 8
  const selfAsserted = classifyBinding({
    gers_id: PRESENT,
    gers_binding: { source: "self_asserted" },
  });
  const bridgeFile = classifyBinding({
    gers_id: PRESENT,
    gers_binding: {
      source: "bridge_file",
      release: "2026-10-22.0",
      source_record_id: "osm:way/1",
    },
  });
  const unattributed = classifyBinding({ gers_id: PRESENT });
  const none = classifyBinding({ gers_id: null });
  t(
    "binding tiers are independent of membership and ordered bridge > service > self > unattributed",
    bridgeFile.tier === BINDING.BRIDGE_FILE &&
      selfAsserted.tier === BINDING.SELF_ASSERTED &&
      unattributed.tier === BINDING.UNATTRIBUTED &&
      none.tier === BINDING.NONE &&
      meetsBindingTrust(BINDING.BRIDGE_FILE, BINDING.ONBOARDING_SERVICE) &&
      !meetsBindingTrust(BINDING.SELF_ASSERTED, BINDING.ONBOARDING_SERVICE),
    JSON.stringify({ bridgeFile, selfAsserted, unattributed, none })
  );

  // 9 — an unsubstantiated bridge_file claim must be demoted, not trusted
  const demoted = classifyBinding({
    gers_id: PRESENT,
    gers_binding: { source: "bridge_file" },
  });
  t(
    "a bridge_file claim without release/source_record_id is demoted to self_asserted",
    demoted.tier === BINDING.SELF_ASSERTED,
    JSON.stringify(demoted)
  );

  // 10 — verified_present + weak binding must NOT become identified_as.
  //
  // This is the hand-typed-GERS-ID case: the id is real, but nothing says this
  // record is that feature. Exercised on the reuse path, because that is a path
  // that actually yields an identity to hang edges off — a `review` item has no
  // identity yet and so correctly carries no edges at all.
  const existing = `4did:id:${HOME}:WEAKBINDxxxxxxxxxxxxxx`;
  const plan = await planImport(
    recs([
      feat({
        facility_id: "F-WEAK",
        name: "Present id, hand-typed",
        overture_theme: "buildings",
        gers_id: PRESENT,
      }),
    ]),
    MANIFEST,
    {
      reader: createMemoryResolverReader([
        { id: existing, registry: "acme.facilities", external_id: "F-WEAK" },
      ]),
      verifier,
      uuid: seqUuid(10),
    }
  );
  const item = plan.items[0];
  const gersEdges = item.edges.filter((e) => e.registry === "overture.gers");
  t(
    "verified_present with untrusted binding records 'describes', never 'identified_as'",
    item.outcome === OUTCOME.REUSE &&
      item.membership.membership === MEMBERSHIP.PRESENT &&
      item.binding.tier === BINDING.UNATTRIBUTED &&
      gersEdges.length === 1 &&
      gersEdges[0].type === EDGE.DESCRIBES,
    JSON.stringify({ outcome: item.outcome, edges: gersEdges.map((e) => e.type) })
  );

  // 10b — and a review item yields no identity and therefore no edges
  const reviewPlan = await planImport(
    recs([
      feat({
        facility_id: "F-REVIEW",
        name: "Present id, no match, weak binding",
        overture_theme: "buildings",
        gers_id: PRESENT,
      }),
    ]),
    MANIFEST,
    { reader: createMemoryResolverReader([]), verifier, uuid: seqUuid(15) }
  );
  t(
    "a review item mints no identity and emits no edges",
    reviewPlan.items[0].outcome === OUTCOME.REVIEW &&
      reviewPlan.items[0].id === null &&
      reviewPlan.items[0].edges.length === 0,
    JSON.stringify({
      outcome: reviewPlan.items[0].outcome,
      edges: reviewPlan.items[0].edges.length,
    })
  );
}

// ===========================================================================
section("planning: resolve before mint");
// ===========================================================================

{
  // 11 — exact alias reuse wins
  const existing = `4did:id:${HOME}:EXISTINGxxxxxxxxxxxxxx`;
  const reader = createMemoryResolverReader([
    { id: existing, registry: "acme.facilities", external_id: "F-1" },
  ]);
  const plan = await planImport(
    recs([
      feat({
        facility_id: "F-1",
        name: "Already known",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
    ]),
    MANIFEST,
    { reader, verifier, uuid: seqUuid(20) }
  );
  t(
    "an exact alias match reuses the existing 4D-ID instead of minting",
    plan.items[0].outcome === OUTCOME.REUSE && plan.items[0].id === existing,
    JSON.stringify({ outcome: plan.items[0].outcome, id: plan.items[0].id })
  );
}

{
  // 12 — ambiguity cannot mint
  const reader = createMemoryResolverReader([
    { id: `4did:id:${HOME}:AAAAAAAAAAAAAAAAAAAAAA`, registry: "acme.facilities", external_id: "F-2" },
    { id: `4did:id:${HOME}:BBBBBBBBBBBBBBBBBBBBBB`, registry: "overture.gers", external_id: ABSENT },
  ]);
  const plan = await planImport(
    recs([
      feat({
        facility_id: "F-2",
        name: "Two different identities claim this",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
    ]),
    MANIFEST,
    { reader, verifier, uuid: seqUuid(30) }
  );
  const item = plan.items[0];
  t(
    "two distinct alias matches produce review with candidates, never a mint or auto-merge",
    item.outcome === OUTCOME.REVIEW && item.id === null && item.candidates.length === 2,
    JSON.stringify({ outcome: item.outcome, id: item.id, candidates: item.candidates })
  );
}

{
  // 13 — a failed lookup is not a no-match
  const reader = createMemoryResolverReader([], {
    failOn: ({ registry }) => (registry === "acme.facilities" ? "connection reset" : null),
  });
  const plan = await planImport(
    recs([
      feat({
        facility_id: "F-3",
        name: "Lookup blew up",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
    ]),
    MANIFEST,
    { reader, verifier, uuid: seqUuid(40) }
  );
  const item = plan.items[0];
  t(
    "a failed resolver lookup blocks rather than being treated as a no-match",
    item.outcome === OUTCOME.BLOCKED && item.id === null && /not a no-match/.test(item.reason),
    JSON.stringify({ outcome: item.outcome, reason: item.reason })
  );
}

{
  // 14 — mint prerequisites: permitted verified membership + sufficient binding
  const reader = createMemoryResolverReader([]);
  const plan = await planImport(
    recs([
      // absent + good binding => mint
      feat({
        facility_id: "F-MINT",
        name: "Genuinely new",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
      // present + good binding => mint a provisional reference identity
      feat({
        facility_id: "F-PRESENT",
        name: "Already in Overture",
        overture_theme: "buildings",
        gers_id: PRESENT,
        gers_binding: goodBinding,
      }),
      // absent but weak binding => review
      feat({
        facility_id: "F-WEAKBIND",
        name: "Absent but hand-typed",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: { source: "self_asserted" },
      }),
      // unknown membership (out of capture scope) => review
      feat({
        facility_id: "F-UNKNOWN",
        name: "A place, capture covers buildings",
        overture_theme: "places",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
      // invalid gers id => blocked
      feat({
        facility_id: "F-INVALID",
        name: "Garbage id",
        overture_theme: "buildings",
        gers_id: "nope",
      }),
      // no local id => blocked
      feat({ name: "No key at all", overture_theme: "buildings" }),
    ]),
    MANIFEST,
    { reader, verifier, uuid: seqUuid(50) }
  );
  // Keyed on a Map, not a plain object: the keyless record has local_id === null,
  // which a plain object would silently coerce to the string key "null".
  const by = new Map(plan.items.map((i) => [i.local_id, i]));
  const g = (k) => by.get(k).outcome;
  t(
    "mint requires a policy-permitted membership outcome AND sufficient binding",
    g("F-MINT") === OUTCOME.MINT &&
      g("F-PRESENT") === OUTCOME.MINT &&
      g("F-WEAKBIND") === OUTCOME.REVIEW &&
      g("F-UNKNOWN") === OUTCOME.REVIEW &&
      g("F-INVALID") === OUTCOME.BLOCKED &&
      g(null) === OUTCOME.BLOCKED,
    JSON.stringify(plan.items.map((i) => [i.local_id, i.outcome]))
  );

  // 15 — a mint is marked reference-only and provisional
  const minted = by.get("F-MINT");
  t(
    "a minted identity is marked reference-only, provisional and ungrounded",
    isNonSpatial4did(minted.id) &&
      minted.marking.reference_only === true &&
      minted.marking.status === "provisional" &&
      minted.marking.grounded === false,
    JSON.stringify(minted.marking)
  );

  // 16 — unknown membership must never mint, even with perfect binding
  t(
    "unknown membership never mints regardless of binding strength",
    by.get("F-UNKNOWN").membership.membership === MEMBERSHIP.UNKNOWN &&
      by.get("F-UNKNOWN").binding.tier === BINDING.ONBOARDING_SERVICE &&
      by.get("F-UNKNOWN").outcome === OUTCOME.REVIEW,
    JSON.stringify({
      m: by.get("F-UNKNOWN").membership.membership,
      b: by.get("F-UNKNOWN").binding.tier,
      o: by.get("F-UNKNOWN").outcome,
    })
  );
}

// ===========================================================================
section("relationship semantics");
// ===========================================================================

{
  // 17 — the four edge types mean different things
  t(
    "contains is parentage-only and no edge type implies a pose",
    edgeSemantics(EDGE.CONTAINS).is_parentage === true &&
      edgeSemantics(EDGE.IDENTIFIED_AS).is_parentage === false &&
      edgeSemantics(EDGE.DESCRIBES).is_parentage === false &&
      edgeSemantics(EDGE.REPRESENTS).is_parentage === false &&
      edgeSemantics(EDGE.REPRESENTS).implies_geometry === true &&
      [EDGE.IDENTIFIED_AS, EDGE.DESCRIBES, EDGE.CONTAINS, EDGE.REPRESENTS].every(
        (ty) => edgeSemantics(ty).implies_pose === false
      )
  );

  // 18 — contains comes only from declared parentage; represents is never inferred
  let selfThrew = false;
  try {
    containsEdge({ from: "a", to: "a" });
  } catch {
    selfThrew = true;
  }
  let repThrew = false;
  try {
    representsEdge({ from: "a", to: "b" });
  } catch {
    repThrew = true;
  }
  t(
    "contains rejects self-parentage and represents requires an explicit declaration",
    selfThrew && repThrew
  );

  // 19 — declared parentage produces exactly one contains edge, in-plan
  const plan = await planImport(
    recs([
      feat({
        facility_id: "P",
        name: "Campus",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
      feat({
        facility_id: "C",
        campus_id: "P",
        name: "Child building",
        overture_theme: "buildings",
        gers_id: "3a2b1c0d-4e5f-4061-8273-849506a7b8c9",
        gers_binding: goodBinding,
      }),
      feat({
        facility_id: "ORPHAN",
        campus_id: "NOT-IN-THIS-RUN",
        name: "Parent not present",
        overture_theme: "buildings",
        gers_id: "5c4d3e2f-1a0b-4c9d-8e7f-605f4e3d2c1b",
        gers_binding: goodBinding,
      }),
    ]),
    MANIFEST,
    { reader: createMemoryResolverReader([]), verifier, uuid: seqUuid(60) }
  );
  const byId = Object.fromEntries(plan.items.map((i) => [i.local_id, i]));
  const childContains = byId["C"].edges.filter((e) => e.type === EDGE.CONTAINS);
  const orphanContains = byId["ORPHAN"].edges.filter((e) => e.type === EDGE.CONTAINS);
  t(
    "declared parentage emits one contains edge; an unresolvable parent emits none and notes why",
    childContains.length === 1 &&
      childContains[0].from === byId["P"].id &&
      childContains[0].to === byId["C"].id &&
      childContains[0].parentage_only === true &&
      orphanContains.length === 0 &&
      byId["ORPHAN"].notes.some((n) => /parentage skipped/.test(n)),
    JSON.stringify({ child: childContains.length, orphan: orphanContains.length })
  );

  // 20 — geometry is explicitly ignored, never used for grounding
  const geoPlan = await planImport(
    normalizeRecords(
      [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
          properties: {
            facility_id: "G-1",
            name: "Has geometry",
            overture_theme: "buildings",
            gers_id: ABSENT,
            gers_binding: goodBinding,
          },
        },
      ],
      MANIFEST
    ),
    MANIFEST,
    { reader: createMemoryResolverReader([]), verifier, uuid: seqUuid(70) }
  );
  const g = geoPlan.items[0];
  t(
    "geometry is noted as ignored and no pose, cell or anchor is emitted",
    g.notes.some((n) => /no grounding/.test(n)) &&
      isNonSpatial4did(g.id) &&
      // the record carries no pose/anchor/cell fields of its own
      g.marking.grounded === false &&
      !("pose" in g.record) &&
      !("anchor" in g.record) &&
      !("cell" in g.record) &&
      g.edges.every((e) => e.implies_pose === false),
    JSON.stringify(g.notes)
  );
}

// ===========================================================================
section("input: geojson, jsonl, manifest");
// ===========================================================================

{
  // 21
  const geojsonText = await readFile(join(samples, "facilities.geojson"), "utf8");
  const jsonlText = await readFile(join(samples, "facilities.jsonl"), "utf8");
  const g = parseInput(geojsonText);
  const j = parseInput(jsonlText);
  t(
    "auto-detects FeatureCollection and JSONL and reads manifest-declared fields",
    g.format === "geojson" &&
      g.features.length === 7 &&
      j.format === "jsonl" &&
      j.features.length === 3 &&
      recs(g.features)[0].local_id === "ACME-CAMPUS-01" &&
      recs(j.features)[1].parent_local_id === "ACME-CAMPUS-01",
    `${g.format}/${g.features.length} ${j.format}/${j.features.length}`
  );

  // 22 — manifest validation refuses dangerous policy
  let mintOnInvalidThrew = false;
  try {
    parseManifest({
      manifest_version: 1,
      source: { registry: "r" },
      home_token: "h",
      fields: { local_id: "id" },
      policy: { mint_on: ["invalid"] },
    });
  } catch {
    mintOnInvalidThrew = true;
  }
  let noRegistryThrew = false;
  try {
    parseManifest({ manifest_version: 1, home_token: "h", fields: { local_id: "id" } });
  } catch {
    noRegistryThrew = true;
  }
  t(
    "manifest requires a registry and refuses to mint on 'invalid'",
    mintOnInvalidThrew && noRegistryThrew
  );
}

// ===========================================================================
section("store: idempotence, concurrency, alias uniqueness");
// ===========================================================================

{
  // 23 — rerun idempotence
  const storePath = await tempStorePath();
  const store = createJsonFileStore(storePath);
  const reader = createMemoryResolverReader([]);
  const input = recs([
    feat({
      facility_id: "R-1",
      name: "Rerun me",
      overture_theme: "buildings",
      gers_id: ABSENT,
      gers_binding: goodBinding,
    }),
  ]);
  const planA = await planImport(input, MANIFEST, { reader, verifier, uuid: seqUuid(100) });
  const planB = await planImport(input, MANIFEST, { reader, verifier, uuid: seqUuid(100) });

  const first = await applyPlan(planA, store);
  const second = await applyPlan(planB, store);
  const state = await store.read();
  t(
    "rerunning the same plan is a no-op: one entity, replayed result, no duplicate mint",
    first.replayed === false &&
      second.replayed === true &&
      first.operation_id === second.operation_id &&
      Object.keys(state.entities).length === 1 &&
      state.edges.length === first.edges_added,
    JSON.stringify({
      first: first.replayed,
      second: second.replayed,
      entities: Object.keys(state.entities).length,
    })
  );
}

{
  // 24 — concurrency: alias uniqueness under parallel applies
  const storePath = await tempStorePath();
  const store = createJsonFileStore(storePath);

  // Eight distinct operations all trying to bind the SAME alias to DIFFERENT ids.
  const ops = Array.from({ length: 8 }, (_, k) => ({
    operation_id: `race-${k}`,
    mints: [
      {
        local_id: "RACE",
        id: `4did:id:${HOME}:RACE${String(k).padStart(18, "0")}`,
        aliases: [{ registry: "acme.facilities", external_id: "RACE" }],
        record: { id: `4did:id:${HOME}:RACE${String(k).padStart(18, "0")}` },
      },
    ],
    edges: [],
  }));

  const results = await Promise.all(ops.map((o) => store.apply(o)));
  const state = await store.read();
  const minted = results.flatMap((r) => r.applied).filter((a) => a.outcome === "minted");
  const reused = results.flatMap((r) => r.applied).filter((a) => a.outcome === "reused");
  t(
    "concurrent applies racing one alias produce exactly one mint and the rest reuse",
    minted.length === 1 &&
      reused.length === 7 &&
      Object.keys(state.entities).length === 1 &&
      Object.keys(state.aliases).length === 1 &&
      reused.every((r) => r.id === minted[0].id),
    JSON.stringify({ minted: minted.length, reused: reused.length })
  );

  // 25 — the lock directory is released
  let lockGone = false;
  try {
    await readFile(join(`${storePath}.lock`, "owner.json"), "utf8");
  } catch {
    lockGone = true;
  }
  t("the lock directory is released after the transaction", lockGone);
}

{
  // 26 — a half-written temp file never becomes visible state
  const storePath = await tempStorePath();
  const store = createJsonFileStore(storePath);
  await store.apply({
    operation_id: "atomic-1",
    mints: [
      {
        local_id: "A",
        id: `4did:id:${HOME}:AAAAAAAAAAAAAAAAAAAAAA`,
        aliases: [{ registry: "acme.facilities", external_id: "A" }],
        record: { id: `4did:id:${HOME}:AAAAAAAAAAAAAAAAAAAAAA` },
      },
    ],
  });
  // Simulate crash debris: a stray temp file alongside the real store.
  await writeFile(join(storePath, "..", `.${"store.json"}.9999.deadbeef.tmp`), "{ partial", "utf8");
  const state = await store.read();
  t(
    "a leftover temp file does not corrupt the published store",
    state.entities[`4did:id:${HOME}:AAAAAAAAAAAAAAAAAAAAAA`] !== undefined &&
      Object.keys(state.entities).length === 1
  );
}

// ===========================================================================
section("export & inspect determinism");
// ===========================================================================

{
  // 27 — byte-identical export across runs and input orderings
  const reader = createMemoryResolverReader([]);
  const features = [
    feat({
      facility_id: "E-1",
      name: "One",
      overture_theme: "buildings",
      gers_id: ABSENT,
      gers_binding: goodBinding,
    }),
    feat({
      facility_id: "E-2",
      name: "Two",
      overture_theme: "buildings",
      gers_id: PRESENT,
      gers_binding: goodBinding,
    }),
    feat({ facility_id: "E-3", name: "Three", overture_theme: "buildings" }),
  ];

  const p1 = await planImport(recs(features), MANIFEST, { reader, verifier, uuid: seqUuid(200) });
  const p2 = await planImport(recs(features), MANIFEST, { reader, verifier, uuid: seqUuid(200) });
  const s1 = serializeExport(exportBridge(p1));
  const s2 = serializeExport(exportBridge(p2));

  // Same records, reversed input order: entity/edge sets must still serialize identically.
  const pRev = await planImport(recs([...features].reverse()), MANIFEST, {
    reader,
    verifier,
    uuid: seqUuid(200),
  });
  const sRevDoc = exportBridge(pRev);
  const s1Doc = exportBridge(p1);
  const sameEntities =
    JSON.stringify(sRevDoc.entities.map((e) => e.local_id)) ===
    JSON.stringify(s1Doc.entities.map((e) => e.local_id));

  t(
    "export is byte-identical across runs and stable under input reordering",
    s1 === s2 && s1.endsWith("\n") && sameEntities,
    `identical=${s1 === s2} sameEntities=${sameEntities}`
  );

  // 28 — export carries the honesty markings
  const doc = exportBridge(p1);
  t(
    "export marks itself reference-only and ungrounded and never claims membership it lacks",
    doc.reference_only === true &&
      doc.grounded === false &&
      doc.entities.every((e) => e.reference_only === true && e.grounded === false) &&
      doc.registry_capture.capture_id === "cap-test",
    JSON.stringify({ ro: doc.reference_only, g: doc.grounded })
  );

  // 29 — inspect separates membership from binding
  const report = inspectPlan(p1);
  t(
    "inspect reports membership and binding as separate distributions",
    report.membership[MEMBERSHIP.PRESENT] === 1 &&
      report.membership[MEMBERSHIP.ABSENT] === 1 &&
      report.membership[MEMBERSHIP.UNKNOWN] === 1 &&
      report.binding[BINDING.ONBOARDING_SERVICE] === 2 &&
      report.binding[BINDING.NONE] === 1 &&
      report.counts.mint === 2,
    JSON.stringify({ m: report.membership, b: report.binding, c: report.counts })
  );
}

// ===========================================================================
section("http resolver is read-only");
// ===========================================================================

{
  // 30 — apply() refuses outright
  const http = createHttpResolverReader("http://localhost:4141");
  let refused = false;
  let msg = "";
  try {
    await http.apply({ operation_id: "x", mints: [] });
  } catch (e) {
    refused = true;
    msg = e.message;
  }
  t(
    "the HTTP resolver adapter refuses to write and says so",
    refused && /read-only/.test(msg) && /ingest/.test(msg),
    msg
  );

  // 31 — the guard rejects writes and /ingest specifically
  const check = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  t(
    "the read-only guard rejects POST and any /ingest path",
    check(() => assertReadOnly("POST", "http://localhost:4141/resolve")) &&
      check(() => assertReadOnly("GET", "http://localhost:4141/ingest")) &&
      check(() => assertReadOnly("PUT", "http://localhost:4141/entity/x")) &&
      assertReadOnly("GET", "http://localhost:4141/resolve?registry=a&external_id=b") === true
  );

  // 32 — only GET /resolve is ever issued, and transport failure != no-match
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method });
    return {
      ok: true,
      status: 200,
      json: async () => ({ matches: [] }),
    };
  };
  const spy = createHttpResolverReader("http://localhost:4141", { fetchImpl });
  await spy.lookupAlias({ registry: "acme.facilities", external_id: "F-1" });

  const failing = createHttpResolverReader("http://localhost:4141", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const failed = await failing.lookupAlias({ registry: "r", external_id: "x" });

  t(
    "only GET /resolve is issued; a transport failure reports ok:false, not an empty match set",
    calls.length === 1 &&
      calls[0].method === "GET" &&
      calls[0].url.includes("/resolve?") &&
      !calls.some((c) => c.url.includes("/ingest")) &&
      failed.ok === false &&
      failed.matches.length === 0,
    JSON.stringify({ calls, failed })
  );

  // 33 — end to end: a failing resolver blocks the whole run rather than minting
  const plan = await planImport(
    recs([
      feat({
        facility_id: "H-1",
        name: "Resolver down",
        overture_theme: "buildings",
        gers_id: ABSENT,
        gers_binding: goodBinding,
      }),
    ]),
    MANIFEST,
    { reader: failing, verifier, uuid: seqUuid(300) }
  );
  t(
    "with the resolver unreachable, nothing mints and everything blocks",
    plan.counts.mint === 0 && plan.counts.blocked === 1,
    JSON.stringify(plan.counts)
  );
}

// ===========================================================================
section("apply refuses non-reference-only");
// ===========================================================================

{
  // 34
  const storePath = await tempStorePath();
  const store = createJsonFileStore(storePath);
  const plan = await planImport(recs([]), MANIFEST, {
    reader: createMemoryResolverReader([]),
    verifier,
    uuid: seqUuid(400),
  });
  let threw = false;
  let msg = "";
  try {
    await applyPlan(plan, store, { referenceOnly: false });
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  t(
    "applyPlan refuses any non-reference-only mode",
    threw && /reference-only/.test(msg),
    msg
  );
}

// --- cleanup ---------------------------------------------------------------
for (const d of tmpDirs) await rm(d, { recursive: true, force: true });

console.log(`\n${fail ? "FAIL" : "PASS"}: ${count - fail}/${count} checks passed.`);
process.exit(fail ? 1 : 0);
