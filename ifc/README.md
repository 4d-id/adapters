# @4d-id/ifc-adapter

Import an IFC (BIM) file into 4D-ID entities. The first implemented adapter, and a
worked example of the **translate once at the edge** pattern: an IFC file goes in,
a set of valid 4D-States comes out, hierarchy preserved, and IFC GlobalIds carried
as aliases. The current standalone importer uses caller-supplied grounding and
creates fresh records; it does not query a resolver or establish identity truth.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

```bash
# emit 4D-ID entities as JSON
npx @4d-id/ifc-adapter building.ifc

# or push them straight into a running resolver
npx @4d-id/ifc-adapter building.ifc --ingest=http://localhost:4141
```

## What it does

IFC already is a spatial hierarchy: project → site → building → storey → space →
element. That maps directly onto the 4D-ID tree. The adapter:

- parses the IFC STEP file (no external IFC toolchain required),
- creates a fresh 4D-ID record for each spatial container and element using the site's supplied georeference,
- preserves each element's **IfcGlobalId** as an `identified_as` alias for downstream resolution,
- preserves parentage from `IfcRelAggregates` and `IfcRelContainedInSpatialStructure`,
- gives storeys a `floor.N` vertical reference,
- maps IFC classes to semantics (`built:window`, `built:door`, `built:wall`, …) with
  affordances (a window is `openable` and an `occluder`; a wall is `structural`).

Every emitted record validates against the 4D-ID state schema. The current
`--ingest` option posts those fresh records directly and is intended for an empty
or disposable resolver. Before importing into a populated deployment, resolve each
`IfcGlobalId` against existing identities and mint only when no acceptable match
exists. That resolve-first orchestration is not yet implemented by this CLI.

## It does not re-implement IFC geometry

The adapter lifts the supplied spatial structure and preserves identity aliases; it
does not ground or register geometry. Detailed geometry stays in the IFC/BIM tools
that own it and attaches as a representation. This is the point of translating at
the edge: carry the aliases once and leave the heavy data where it lives.

## Options

```
4did-ifc <file.ifc> [--lat=<deg> --lng=<deg>] [--ingest=<resolver-base-url>]
```

- `--lat`/`--lng` — override the anchor if the IFC has no site georeference.
- `--ingest` — POST each entity to a resolver's `/ingest` endpoint instead of printing.

## License

Apache-2.0. Part of the [4D-ID adapters](https://github.com/4d-id/adapters).
