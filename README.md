# 4D-ID Adapters

Bridges that make existing tools emit and consume 4D-IDs, so the candidate standard can be tried at the edge. **The IFC adapter and the GERS bridge are implemented.** All other integrations listed below remain planned; each adapter is a worked example of one pattern: translate once, at the edge, to attach a name.

## Available

| Adapter | What it does | Status |
|---|---|---|
| [`ifc`](ifc/) | Import an IFC (BIM) file into 4D-ID entities: hierarchy, identity, IfcGlobalId, semantics. Emits schema-valid records that can be evaluated by the reference resolver. | **Implemented** |
| [`gers-bridge`](gers-bridge/) | Bridge Overture GERS identifiers to 4D-IDs. Verifies GERS membership against a registry capture, keeps source-binding trust separate from membership, and resolves before it mints. Emits non-spatial, reference-only identifiers and typed sidecar edges. | **Implemented** |

Both are reference implementations, not production-hardened software, and neither is published to npm. The GERS bridge in particular performs **no grounding**: it mints only non-spatial `4did:id:` identifiers marked reference-only and provisional, never infers GERS membership from UUID syntax, and treats a failed lookup as `unknown` rather than as a no-match. Its HTTP resolver adapter is read-only and will not call `/ingest`.

## Planned

These integrations are **planned, not implemented**. Each is a folder-per-integration; contributions welcome.

| Adapter | What it will do |
|---|---|
| `ros2-tf2` | Bridge a ROS 2 transform tree to 4D-IDs that survive map reloads and vendors. |
| `gltf` | A node-level `EXT_4did_anchor` extension: a glTF asset that knows where it belongs. |
| `3d-tiles` | Attach 4D-IDs to 3D Tiles tilesets and features. |
| `openxr` | Expose a 4D-ID for an OpenXR spatial entity or anchor. |

We ship one implemented adapter (IFC) and keep the rest explicitly planned. If you need one of the planned bridges, open an issue or a PR.

Apache-2.0. Built on the [4D-ID specification](https://github.com/4d-id/spec).
