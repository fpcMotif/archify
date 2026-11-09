# Vendored Pele

Pele 1.13.0 (MIT, <https://github.com/obsidianmd/pele>), from the npm tarball `pele-1.13.0.tgz` (sha256 `00f879d86c5a6ece897ef70e18fd228a9952bba338a0cb1293b373900d7414bd`).

Only `dist/esm/core.js`, the diagram entries `flowchart`, `sequence`, `state`, `er`, `class`, `timeline`, `mindmap` and `architecture`, and the chunks they import are copied, unmodified. `schematics import mermaid` uses their parsers to read Mermaid source into Schematics JSON; it does not use Pele's renderer, and no Pele code ships inside a delivered page.
