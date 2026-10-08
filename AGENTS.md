# Manager contribution entry

Read [central public guidance](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/AGENTS.md)
and [Manager guide](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/docs/manager-foundation.md).
All OpenSpec canonical specs, changes, archives, config and workflow skills live
ONLY in Docs. Use central change `manager-foundation` for this bounded foundation;
future work follows a linked central change and implementation PR.

Read current public requirements and available timestamped issue comments before
changes. Private Linear/Mem tools, a specific agent and the maintainer's tablet
are optional, never public prerequisites. Preserve manual/fork workflows.

Run README checks and relevant release fixtures. Keep scoped semantic PR titles,
exactly `# Summary` plus concise bullets in PR bodies, and evidence in comments.
Coordinate exact Docs/code heads and merge order with independent review and CI.
Do not archive unfinished work or equate foundation delivery with REM-41/42.

Keep the renderer sandboxed; expose narrow host capabilities only. Never add a
Buddy admin API. Git tags remain the version authority. Do not create 1.0 tags
before REM-35. No tablet operations are needed for foundation changes.

## Documentation layout

Put documentation under `docs/`, including reusable technical findings, research,
reference and tool guides. Genuine OpenSpec change-specific artifacts stay in the
standard `openspec/` structure in the repository that owns that workflow. Root
README/CONTRIBUTING/AGENTS, license/security files and conventional tool-discovery
files (GitHub templates, skills) are exceptions. Test data remains fixtures, not
documentation by default. Preserve evidence/provenance and link canonical bodies;
do not sweep unrelated historical archives or private task outputs.
