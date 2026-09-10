# Changelog

All notable changes to this project will be documented here.

The latest stable release is `v0.12.0`. Changes that have not yet been released are grouped under `Unreleased`.

## 0.12.0 - 2026-09-10

- Replace the dashboard range controls with Day, Week, Month, 3 Months, Year To Date, and MAX; use available hourly observations for Day and daily aggregation for longer ranges.
- Expand primary asset-card charts across desktop cards and select representative observations without visually joining carried-forward values across longer buckets.
- Chart property value and linked equity as separate lines and surface mortgage-driven equity changes as first-class dashboard growth contributors.
- Make the Dashboard FIRE status snapshot collapsible, defaulting to compact on mobile while preserving the selected state during dashboard refreshes.
- Preserve existing databases and configuration without a migration, with expanded API, UI, responsive, and browser-demo regression coverage.

## 0.11.0 - 2026-09-09

- Keep the public browser demo populated with a rolling 366-day history derived from the current date, including generated rises and falls calibrated to an approximate £400k–£500k net-worth band.
- Rebase only generated demo rows when the date changes, preserving user-added entries, settings, catalogue changes, integrations, and other browser-local demo state across refreshes.
- Refresh cached and active demo views when the date rolls over or the page regains focus or visibility, so dashboard, history, calendar, forecast, FIRE, and budget surfaces continue to show current fictional data.
- Add an accessible collapsible public-demo banner that is expanded by default and stores its preference independently from the Reset demo action.
- Add regression coverage for date-relative fixture generation, manual-entry preservation, value bounds, banner persistence, and responsive layout contracts.

## 0.10.0 - 2026-09-06

- Fix release and container-image publishing after the organization transfer by aligning CI repository guards, GHCR image names, and OCI source metadata with `pe-engineering/wealth-watcher-public`.
- Refresh the GitHub Actions, Pages and CodeQL actions, pinned Docker base-image digests, and PostgreSQL image used by Compose, while retaining signed images with SBOM and provenance metadata.
- Update SnapTrade.Net to `6.0.14` and Vite to `8.2.2`, with the UI lockfile regenerated for the updated dependency graph.
- Add the release upgrade guidance for the new GHCR namespace; no database migration or new application setting is included.

## 0.9.0 - 2026-09-02

- Add an optional, separately deployed provider webhook relay with signed SnapTrade ingress, SQLite retry state, outbound WebSocket delivery, and a provider-handler boundary for future webhook providers.
- Add connection-scoped update modes so each integration uses either scheduled polling or webhook delivery, with provider capability checks and automatic fallback to polling when the relay is disabled through the application.
- Add Integrations controls for relay status, enable/disable, relay-to-API diagnostics, provider-specific setup guidance, and copyable public webhook URLs.
- Publish the API, web, and optional webhook-relay images through the same validated, signed, SBOM-producing release pipeline.
- Add the integration sync-mode and relay-setting database migration, expanded API/relay/UI regression coverage, and browser-demo parity for relay behavior.

## 0.8.0 - 2026-08-18

- Refine Budget flow presentation with compact inline labels, wider Sankey gaps, adaptive dense-list sizing, responsive width limits, and label-safe node placement.
- Add an over-budget alert and only prompt for meaningful unallocated funds when at least 5% of monthly income remains unallocated.
- Replace stacked delete/archive confirmation popups with inline two-step actions and keep the flow readable across desktop, mobile, accessible, legacy, and browser-demo views.
- Fix clipping for Income, Unallocated, and other long labels, including four-digit amounts and 20+ item group drill-downs.

## 0.7.0 - 2026-08-18

- Rebuild Budget as a group-based planner with custom group names and colours, item categories, monthly-equivalent flow drill-down, responsive views, and accessible list output.
- Add version-2 budget persistence with a database migration, legacy-array compatibility, stable item and Forecast asset-link handling, and atomic validation of grouped settings.
- Move application release information to a dedicated Application page with a direct app-bar link, legacy deep-link redirect, and explicit missing-metadata state.
- Update FIRE and Forecast budget calculations and milestone context for grouped budgets, and expand browser-demo, API, UI, routing, and responsive-layout coverage.
- Fix budget flow navigation, mobile colour accents, uncategorised item visibility, built-in Income editing, Forecast typeahead persistence, and responsive editor layout issues.

## 0.6.0 - 2026-08-17

- Add a Dashboard FIRE status summary that keeps selected FIRE assets separate from Holistic Net Worth, shows progress toward the configured target, and provides a context-aware next action.
- Add an optional projected FIRE date from the existing forecast endpoint, with shared FIRE/forecast target calculations and safe handling for disabled, incomplete, stale, or unavailable projections.
- Rebuild Budget as a page-owned planner with income, bills, savings, and spending lines, cadence-aware monthly equivalents, forecast-asset savings links, an interactive flow view, and browser-demo parity.
- Preserve budget line identifiers and asset mappings across edits, assign identifiers to new lines, remove omitted lines, and reject invalid or conflicting settings atomically.
- Refresh the pinned .NET SDK, API/test dependencies, GitHub Actions, and Docker metadata tooling, with expanded API, UI, demo-contract, routing, and responsive-layout regression coverage.

## 0.5.0 - 2026-08-16

- Harden API and browser-demo validation for settings, property values, archived assets, and forecast input and data handling, including safe fallbacks for malformed persisted settings.
- Improve accessibility and resilience across the dashboard, budget, calendar, history, forecast, FIRE, integrations, and asset catalogue with focus-managed modals, chart data alternatives, period controls, stale-response guards, and explicit empty/error states.
- Refine milestone and FIRE/forecast settings input handling and keep disabled milestone presentation hidden.
- Add a Docker-first Getting Started guide and clarify local/trusted-network setup, health checks, backups, and private configuration handling.

## 0.4.0 - 2026-08-15

- Add optional wealth milestones with persisted multi-target settings and dashboard progress states.
- Harden integration boundaries and sanitize provider failure details before they cross API or persistence boundaries.
- Improve UI resilience and safe rendering for persisted settings, forecast validation, dashboard content, budget controls, integrations, and sync audits.
- Improve public-site SEO, social previews, privacy-aware analytics measurement, and Pages artifact validation.
- Pin container base images and runtime dependencies, and publish signed images with SBOM and provenance metadata.

## 0.3.0 - 2026-08-14

- Make the browser-only demo banner and app bar opaque, visible, and consistently layered.
- Improve mobile containment for high-data views and budget controls, with responsive layout regression coverage.
- Publish tagged stable images with a moving `latest` alias for the latest successful release.

## 0.2.0 - 2026-08-13

- Add the browser-only live demo and refreshed responsive public landing page.
- Add standardized loading, empty, and error states across the main application views.
- Add in-app version display, bundled release notes, and an informational update checker.
- Publish versioned API and web images through the public release workflow.

## Unreleased

- Continue improving public application reliability, accessibility, and release automation.
- Maintain the public release policy, version-aligned UI metadata, release notes, release checks, and application SBOMs; tagged Docker images are published to GHCR while deployment data remains local.
