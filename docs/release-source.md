# Release-source preview

REM-41/42 share read-only official stable metadata discovery and an app-local source
preference in browser and Electron. Refresh and five-minute polling use the canonical
public GitHub release API, with a 15-second bound. Faults retain metadata only with
a visible stale label. Drafts and prereleases remain excluded.

An official candidate is not a qualified available install. The preview has no
tablet transport, installed observation, signed APK verification, source/SDK
compatibility or Vellum ownership proof. Installation remains unavailable even
when uploaded assets exist. Do not infer device state or package equivalence from tags.
Community is unavailable until actual listing (delayed REM-55). A saved unavailable
policy is retained; changing policy never changes packages/data. Storage faults are
visible. Browser storage belongs to its origin; desktop storage to its app profile.

Shared UI styling follows [Tailwind integration and contribution conventions](styling.md).
Central change `manager-release-source` owns release semantics; `manager-shared-tailwind`
owns shared styling. Full REM-41/42 installation/data gates remain open.

References: [GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release),
[Tailwind Angular integration](https://tailwindcss.com/docs/installation/framework-guides/angular),
[reManager version separation](https://github.com/rmitchellscott/reManager/blob/main/app_packages.go).

GitHub unauthenticated public requests share a 60/hour IP budget. Both automatic and manual refresh honor Retry-After and X-RateLimit-Reset; missing headers use a conservative five-minute delay. See https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api .
