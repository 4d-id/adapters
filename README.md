# 4D-ID Adapters

Bridges that make existing tools emit and consume 4D-IDs, so the standard spreads
through the tools people already use rather than through arguments. Each adapter is
a worked example of one pattern: **translate once, at the edge, to attach a name.**

## Available

| Adapter | What it does | Status |
|---|---|---|
| [`ifc`](ifc/) | Import an IFC (BIM) file into 4D-ID entities: hierarchy, identity, IfcGlobalId, semantics. Emits schema-valid records that ingest into the reference resolver. | **Working** |

## Planned

These are not built yet. Each is a folder-per-integration; contributions welcome.

| Adapter | What it will do |
|---|---|
| `ros2-tf2` | Bridge a ROS 2 transform tree to 4D-IDs that survive map reloads and vendors. |
| `gltf` | A node-level `EXT_4did_anchor` extension: a glTF asset that knows where it belongs. |
| `3d-tiles` | Attach 4D-IDs to 3D Tiles tilesets and features. |
| `openxr` | Expose a 4D-ID for an OpenXR spatial entity or anchor. |

We would rather ship one working adapter and the pattern for the rest than list
integrations we have not built. If you need one of the planned bridges, open an
issue or a PR.

Apache-2.0. Built on the [4D-ID specification](https://github.com/4d-id/spec).
