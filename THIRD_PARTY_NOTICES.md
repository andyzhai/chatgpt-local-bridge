# Third-party notices

The root MIT license applies to original LocalBridge contributions. It does not replace licenses or notices for third-party material, including adapted code.

The official MCP filesystem server is preserved under `vendor/upstream/`, including its complete [license notice and texts](vendor/upstream/LICENSE). That notice describes MIT and Apache-2.0 code contributions and CC-BY-4.0 documentation. The pinned revision, file hashes, and modifications are documented in [vendor/UPSTREAM.md](vendor/UPSTREAM.md) and [vendor/MANIFEST.json](vendor/MANIFEST.json).

`src/filesystem/server.ts`, `lib.ts`, `path-utils.ts`, and `path-validation.ts` derive from that baseline. `test/upstream/` contains adapted upstream tests. These files remain subject to applicable upstream terms. The preserved upstream files are unchanged; adaptations and their differences are identified in the provenance document.

Installed dependencies retain their respective package licenses and notices.
