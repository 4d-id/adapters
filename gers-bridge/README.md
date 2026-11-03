# @4d-id/gers-bridge

A **reference-only** bridge between Overture [GERS](https://docs.overturemaps.org/gers/)
identifiers and 4D-IDs. It resolves before it mints, verifies GERS membership against
a registry capture instead of guessing from identifier syntax, keeps *source-binding
trust* separate from *membership*, and records what it did in typed sidecar edges.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

```bash
# plan a run: decide, but change nothing
node src/cli.mjs plan \
  --input=samples/facilities.geojson \
  --manifest=samples/manifest.json \
  --capture=samples/registry-capture.json \
  --out=plan.json

# apply the plan to a local reference store
node src/cli.mjs apply --plan=plan.json --store=store.json --reference-only
```

Node 18+, ESM, no dependencies, no native code.

## The problem this exists to solve

Since the June 2025 release, a GERS ID is a plain UUIDv4. That has one consequence
most bridges get wrong:

> **A UUIDv4 tells you nothing about whether Overture ever issued it.**

Overture assigns GERS IDs only to features in its reference map. Any random UUIDv4 is
syntactically a perfect GERS ID and almost certainly isn't one. A tool that treats
"parses as a UUID" as "is in GERS" is lying to its user, and the lie is invisible
until someone tries to join on it.

So this package never infers membership from syntax. Membership is a fact about a
**registry capture**, and the verifier returns one of four outcomes that are *not*
interchangeable:

| Outcome | Meaning |
|---|---|
| `verified_present` | A capture we trust covers this ID and lists it. |
| `verified_absent` | A capture we trust covers this ID and omits it. |
| `unknown` | Coverage could not be established: no capture, wrong theme scope, stale capture, or the lookup failed. |
| `invalid` | Not even syntactically a UUID. |

`unknown` is the default, and it is load-bearing. **A failed lookup is not a
no-match.** Conflating the two is exactly how a bridge silently mints a duplicate for
every identity it already had.

## Membership and trust are different questions

Two independent axes, deliberately never blended into one "confidence" score:

- **Membership** answers *"is this GERS ID real?"*
- **Binding trust** answers *"do we believe **this record** is **that feature**?"*

The failure this guards against is mundane: someone pastes a real GERS ID into a
spreadsheet column by hand. The ID verifies `verified_present` — and that says nothing
about whether the row is that building.

Binding tiers, strongest first: `bridge_file` → `onboarding_service` → `self_asserted`
→ `unattributed` → `none`. A `bridge_file` claim missing its release or source record
id is **demoted** to `self_asserted`, never trusted on assertion alone. A record can
never earn a better tier by omitting information.

When membership is `verified_present` **and** binding clears policy, the GERS
correspondence is recorded as `identified_as`. Otherwise it degrades to `describes`:
the attributes may still be useful, but sameness is not asserted on thin evidence.

## Resolve before mint

Per record, in fixed order:

1. **Input sanity.** No local id, no plan.
2. **Exact aliases first**, on the local registry id and the GERS id. Reuse beats
   everything; an identity we already issued is never minted twice.
3. **Lookup completeness.** Any failed lookup → `blocked`.
4. **Ambiguity.** Two or more distinct matches → `review`. Never mints, never auto-merges.
5. **Mint prerequisites.** Membership must be in `policy.mint_on` (default:
   `verified_absent` only) and binding must clear `policy.min_binding_trust`.

Outcomes are `reuse`, `mint`, `review`, `blocked`. Only `mint` and `reuse` write
anything; `review` and `blocked` are the operator's queue.

## Grounding boundary

**This bridge performs no grounding and emits no pose.**

A GERS registry row and a bridge file give an identifier correspondence, not a
georeferenced pose. So the identifiers minted here are the non-spatial `id` variant
of 4D-ID 2.4:

```
4did:id:<home-token>:<uuidv4-base64url>
```

No cell, no vertical reference, no anchor, no genesis marker, no pose. Input
geometry is explicitly *noted and ignored* — the plan records that it was present
and that nothing was derived from it.

Everything minted is marked `reference_only: true`, `status: "provisional"`, and
`grounded: false`. Automation proposes; an authority promotes.

### Home tokens

Per [`/req/core/genesis-privacy`](https://github.com/4d-id/spec) (Part 1, 7.2), the
home token in the `cell` slot must carry **at least 128 bits of entropy from a
documented cryptographically secure source** and must **encode no place, person, or
time — including encoded or hashed derivatives**.

Generate one; don't invent one:

```bash
4did-gers home-token          # -> 5a89fc81f07739510a815e8c202160ac
4did-gers home-token --json   # with entropy accounting and provenance
```

A human-meaningful token like `acme` is **rejected**: it names an organization and
carries nowhere near 128 bits. Dots and hyphens are rejected too, because structure
is where place and person data hides.

Two deliberate design choices follow from the "no hashed derivatives" rule:

- **There is no `deriveHomeToken`.** `generateHomeToken()` takes no seed and no
  namespace. Every such affordance is a way to smuggle place, person, or time into
  a token, and a SHA-256 of a customer name is indistinguishable from a CSPRNG draw.
  Generation is the blessed path precisely because validation cannot catch that.
- **The generator redraws** past any token that merely *looks* like it encodes a
  date or epoch (about 1 draw in 1,500). Such a token is genuinely random, but a
  consumer inspecting it cannot tell — and a name that looks like it leaks a
  timestamp will be read as one. Redrawing is free.

`validateHomeToken` enforces the floor on caller-supplied tokens but is honest about
its limits: it cannot prove randomness, and it cannot find a place or time encoded
*inside* a hex token, because any pattern sensitive enough would also reject a large
fraction of legitimate tokens. Plans therefore record a `home_token_provenance` block
showing whether randomness was verified or merely asserted.

UUIDv7 descriptors are refused: their embedded timestamp would encode mint time,
which is exactly what this mode exists to avoid.

## Edge semantics

Four types, not substitutes for one another:

| Type | Means | Parentage? | Implies geometry? | Implies pose? |
|---|---|---|---|---|
| `identified_as` | Known in registry R as X. | no | no | no |
| `describes` | Carries attributes about this entity, without asserting sameness. | no | no | no |
| `contains` | **Parentage only** — a tree edge. Not a spatial overlap predicate. | yes | no | no |
| `represents` | Is a representation (model/scan/tileset) of the target. | no | yes | no |

`contains` is emitted **only** from an explicit `parent_local_id` field, never from
geometry — which this bridge does not read. `represents` requires an explicit
`declared_by` and is never inferred.

## The import manifest is explicit on purpose

No field sniffing. "The column is called `gers_id` so it must be a GERS ID" is how a
bridge starts inventing identity. The operator states which field means what:

```json
{
  "manifest_version": 1,
  "source": { "registry": "acme.facilities", "theme": "buildings" },
  "home_token": "5a89fc81f07739510a815e8c202160ac",
  "fields": {
    "local_id": "facility_id",
    "gers_id": "gers_id",
    "label": "name",
    "parent_local_id": "campus_id",
    "theme": "overture_theme"
  },
  "policy": {
    "min_binding_trust": "onboarding_service",
    "mint_on": ["verified_absent"],
    "allow_mint": true
  }
}
```

Input is GeoJSON (`Feature` or `FeatureCollection`) or JSONL, auto-detected.

## The HTTP resolver adapter is read-only

It talks to a running reference resolver over `GET /resolve` and nothing else. The
refusal is **enforced, not documented**: every request passes a guard that throws on
any non-GET method and on any path touching a write endpoint, and `apply()` exists
only to refuse with a message pointing at a real writer. It will not call `/ingest`.

"The adapter only does reads" is precisely the kind of claim that quietly stops being
true, so it is a test, not a sentence.

## The durable store

`createJsonFileStore` is a single-host, single-file JSON store for reference runs and
fixtures. On a POSIX filesystem on one machine it guarantees:

- **Mutual exclusion** via an atomic lock *directory* (`mkdir` either creates or
  fails — no check-then-create window).
- **Atomic publication** via write-to-temp + `rename`, so a reader sees the whole
  previous state or the whole next one, never a half-written file.
- **Idempotent operations** keyed on an `operation_id` derived from plan content, so
  a rerun replays the recorded result instead of minting again.
- **Alias uniqueness**: one `(registry, external_id)` binds to exactly one 4D-ID.
  Concurrent callers racing the same alias yield one mint and the rest reuse, because
  the binding check happens inside the lock. Verified across ten OS processes.

It is **not** a database. See Limitations.

## CLI

```
4did-gers home-token [--json]
4did-gers plan    --input=<file> --manifest=<file> [--capture=<file>]
                  [--resolver=<url> | --aliases=<file>] [--format=auto|geojson|jsonl] [--out=<file>]
4did-gers apply   --plan=<file> --store=<file> --reference-only
4did-gers inspect --plan=<file> [--store=<file>]
4did-gers export  --plan=<file> [--store=<file>] [--out=<file>]
```

All commands emit machine-readable JSON on stdout and human notes on stderr.
`export` is deterministic: same inputs, byte-identical bytes — no timestamps, no
iteration-order dependence — so an export is diffable and safe to commit.

Without `--capture`, every membership answer is `unknown` and nothing mints. That is
the honest default, not a degraded one.

## Limitations

- **Not production-hardened, and not published to npm.** This is a reference
  implementation that demonstrates a set of identity-safety properties.
- Home-token validation enforces an entropy *floor* and screens obvious place/time
  shapes. It cannot prove a token was drawn from a CSPRNG rather than hashed from a
  customer id, and it cannot detect place or time encoded inside a hex token. Use
  `4did-gers home-token` and the compliance burden is discharged by construction.
- The store is single-host. No multi-host coordination; correctness over NFS or other
  filesystems with weak `rename`/`mkdir` semantics is not claimed. Durability across
  power loss would need directory `fsync`.
- Registry captures are supplied by the caller. This package does not fetch, parse, or
  validate Overture Parquet registry/bridge artifacts; converting those into a capture
  is the operator's job.
- No geometric matching or conflation. If you need to *find* the GERS ID for a feature,
  use an onboarding service; this bridge consumes the result and records how it got it.
- `represents` edges are only ever created from explicit operator declarations.
- Stale-capture handling degrades to `unknown`; it does not attempt reconciliation
  across releases via the changelog.

## License

Apache-2.0. Part of the [4D-ID adapters](https://github.com/4d-id/adapters).
