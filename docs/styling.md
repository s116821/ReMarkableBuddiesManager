# Shared Tailwind styling

The browser and Electron load the same Angular template and generated stylesheet.
Do not add host-specific styles or a second UI. This increment implements central
[canonical capability `manager-shared-tailwind`](https://github.com/s116821/RemarkableBuddiesDocs/tree/main/openspec/specs/manager-shared-tailwind) (REM-54); release discovery/source semantics and
unavailable installation remain unchanged.

## Upstream integration and reproducibility

Angular's application builder reads `.postcssrc.json` with `@tailwindcss/postcss`;
`src/styles.css` imports `tailwindcss`. This is the supported
[Tailwind Angular integration](https://tailwindcss.com/docs/installation/framework-guides/angular)
and [Angular manual setup](https://angular.dev/guide/tailwind).
Existing exact Tailwind/PostCSS pins and the committed npm lockfile are retained;
`npm ci` with Node 24.21.0 installs them. Do not use a CDN, custom compiler/plugin,
force an unrelated dependency upgrade or generate CSS with a separate host script.

`npm start` uses Angular's development configuration. `npm run build:development`
builds the same configuration into ignored `test-results/development`, outside
packaged runtime files. `npm run build` retains the optimized production output
and notices under `dist/manager/browser`. Application versions come from existing
Git/build metadata; framework dependency versions are not application versions.

## Contribution conventions

Use literal Tailwind utilities for responsive layout, spacing and typography in
shared templates. Keep full class strings visible to Tailwind's source scanner;
do not concatenate utility names at runtime. For conditional classes, enumerate
complete literals. Theme tokens in `src/styles.css` express `forest` (brand),
`paper` (page), `surface`, `ink`, `muted`, `boundary` (controls), `divider`,
`warning`, `danger` and `focus`. These generate ordinary Tailwind utilities.

Use the small shared component classes: `ui-panel`, `ui-button` plus
`ui-button-primary` or `ui-button-secondary`, `ui-field`, `ui-eyebrow`, `ui-error`,
`ui-warning` and `ui-skip`. Layout remains explicit in templates. Keep component
selectors scoped; a bare `section`, `header` or `aside` must not silently style
future screens. Add reusable classes only for repeated component behavior.

Retain semantic headings/labels and live feedback, a visible skip link on focus,
keyboard order and focus outline, readable text, narrow layout without horizontal
overflow, and real disabled controls. Errors have a border and text as well as
color; disabled actions remain visibly unavailable. Do not replace a disabled
installation gate with a cosmetic class or infer compatibility from release tags.
The page uses one light theme; dark theme/user theme switching is not implemented.

## Verification

Run `npm run check`, `npm run package`, then `npm run test:package` (headless Linux
requires `xvfb-run -a` for Electron). `check` includes `test:styles`, which builds
and renders development browser CSS, plus the production browser/Electron checks.
Checks use deterministic intercepted release metadata and errors, no tablet/live
release calls. Context interception and an external-request deny guard are installed
before browser navigation. Electron tests defer UI loading under the two explicit
`MANAGER_TEST=1` and `MANAGER_TEST_DEFER_LOAD=1` flags until interception is ready;
The driver waits for the blank window's DOM-ready event before registering
interception, so the Electron target is already exposed. Normal launches load immediately. Both hosts assert that the first load receives
exactly one fixture request before any refresh/reload. They assert computed token/control/panel styles, one/three-column
layout and no overflow at 390/1280px, computed text contrast, keyboard focus,
focus thickness within one physical pixel of the intended 3 CSS pixels at the
actual display DPR (including browser DPR 1 and 1.25), pending disabled appearance and error presentation while preserving host isolation.
Packaged checks exercise the actual native executable, not only an unpackaged shell.
CI runs development and production checks on Windows and Linux; local Linux evidence
must not be described as a Windows pass before its independent result is observed.

Browser captures in ignored `test-results` show normal, focus, error and narrow
views; `MANAGER_CAPTURE=1` enables actual Electron captures where supported.
Screenshots complement mandatory computed-style/DOM/isolation assertions. No tablet,
installer, source-signing trust or native firmware behavior follows from UI checks.
