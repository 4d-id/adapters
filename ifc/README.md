# @4d-id/ifc-adapter

Import an IFC (BIM) file into 4D-ID entities. The first working adapter, and a
worked example of the **translate once at the edge** pattern: an IFC file goes in,
a set of valid 4D-States comes out, hierarchy preserved, identity minted, IFC
GlobalId attached, geometry classes mapped to semantics.

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
- mints a 4D-ID for each spatial container and element, anchored at the site's
  georeference (or a `--lat`/`--lng` you supply),
- preserves parentage from `IfcRelAggregates` and `IfcRelContainedInSpatialStructure`,
- attaches each element's **IfcGlobalId** as an `identified_as` relation, so the same
  building resolves whether it is referenced from the BIM, a scan, or a listing,
- gives storeys a `floor.N` vertical reference,
- maps IFC classes to semantics (`built:window`, `built:door`, `built:wall`, …) with
  affordances (a window is `openable` and an `occluder`; a wall is `structural`).

Every emitted record validates against the 4D-ID state schema and ingests into the
[reference resolver](https://github.com/4d-id/reference-resolver) unchanged.

## It does not re-implement IFC geometry

The adapter lifts the spatial structure and identity, which is what a shared name
needs, not the meshes. Detailed geometry stays in the IFC/BIM tools that own it and
attaches as a representation. This is the point of translating at the edge: extract
the identity once, leave the heavy data where it lives.

## Options

```
4did-ifc <file.ifc> [--lat=<deg> --lng=<deg>] [--ingest=<resolver-base-url>]
```

- `--lat`/`--lng` — override the anchor if the IFC has no site georeference.
- `--ingest` — POST each entity to a resolver's `/ingest` endpoint instead of printing.

## License

Apache-2.0. Part of the [4D-ID adapters](https://github.com/4d-id/adapters).
