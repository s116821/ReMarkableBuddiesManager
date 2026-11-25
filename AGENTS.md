# Manager contribution entry

Read [central public guidance](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/AGENTS.md)
and [Manager guide](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/docs/manager-foundation.md).
All OpenSpec canonical specs, changes, archives, config and workflow skills live
ONLY in Docs. Use central change `manager-foundation` for this bounded foundation;
future work follows a linked central change and implementation PR.

Read current public requirements and available timestamped issue comments before
changes. Private Linear/Mem tools, a specific agent and the maintainer's tablet
are optional, never public prerequisites. Preserve manual/fork workflows.

Follow the shared [development validation policy](https://github.com/s116821/RemarkableBuddiesDocs/blob/main/CONTRIBUTING.md#development-validation).
Build the changed app and exercise relevant end-to-end behavior with the authorized
development tablet when available. Use local emulation or simulation only while the
coordinated operator is using the tablet or when you lack authorized hardware.
Keep automated checks and release fixtures in existing CI. Source review and
formatting may proceed locally.

Keep scoped semantic PR titles, exactly `# Summary` plus concise bullets in PR
bodies, and evidence in comments.
Coordinate exact Docs/code heads and merge order with independent review and CI.
Do not archive unfinished work or equate foundation delivery with REM-41/42.

Keep the renderer sandboxed; expose narrow host capabilities only. Never add a
Buddy admin API. Git tags remain the version authority. Do not create 1.0 tags
before REM-35.
