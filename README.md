# 4D-ID Adapters

Bridges that make existing tools emit and consume 4D-IDs against the working draft offered for community review. **The IFC adapter and the GERS bridge are implemented.** All other integrations listed below remain planned.

## Available

| Adapter | What it does | Version | Tests |
|---|---|---:|---:|
| [`ifc`](ifc/) | Import an IFC (BIM) file into 4D-ID entities: hierarchy, identity, IfcGlobalId, semantics. Emits schema-valid records that can be evaluated by the reference resolver. | 0.3.0 | 10/10 |
| [`gers-bridge`](gers-bridge/) | Bridge Overture GERS identifiers to 4D-IDs. Verifies GERS membership against a registry capture, keeps source-binding trust separate from membership, and resolves before it mints. Emits non-spatial, reference-only identifiers and typed sidecar edges. | 0.1.0 | 48/48 |

Both are reference implementations, not production-hardened software, and neither is published to npm. The GERS bridge in particular performs **no grounding**: it mints only non-spatial `4did:id:` identifiers marked reference-only and provisional, never infers GERS membership from UUID syntax, and treats a failed lookup as `unknown` rather than as a no-match. Its home tokens carry at least 128 bits from a CSPRNG and encode no place, person, or time, per 4D-ID 2.4 `/req/core/genesis-privacy`. Its HTTP resolver adapter is read-only and will not call `/ingest`.

## Planned

These integrations are **planned, not implemented**. Each is a folder-per-integration; contributions welcome.

| Adapter | What it will do |
|---|---|
| `ros2-tf2` | Bridge a ROS 2 transform tree to 4D-IDs that survive map reloads and vendors. |
| `gltf` | A node-level `EXT_4did_anchor` extension: a glTF asset that knows where it belongs. |
| `3d-tiles` | Attach 4D-IDs to 3D Tiles tilesets and features. |
| `openxr` | Expose a 4D-ID for an OpenXR spatial entity or anchor. |

We ship two implemented reference adapters and keep the rest explicitly planned. If you need one of the planned bridges, open an issue or a PR.

Apache-2.0. Built on the [4D-ID specification](https://github.com/4d-id/spec).
