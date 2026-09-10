# Release policy

This policy applies to the public Wealth Watcher repository and its self-managed, local/trusted-network application boundary.

## Versioning

- Use Semantic Versioning for application releases.
- The first public release was `0.1.0`, published with the annotated Git tag `v0.1.0`; the current stable release is `0.12.0`, published with `v0.12.0`.
- While the major version is `0`, a minor release may still contain breaking changes. Release notes must call out migrations, configuration changes, and upgrade risks.
- Move to `1.0.0` only when the application, data migrations, deployment procedure, and support expectations are considered stable.
- `main` is the development branch. The latest tagged release is the supported release; support is best-effort with no service-level agreement.

## Release contents

Each release should include:

- a GitHub release with concise release notes and a `CHANGELOG.md` entry;
- a reviewed `docs/release-notes/vMAJOR.MINOR.PATCH.md` source note;
- the exact Git tag and source archive;
- SHA-256 checksums for the source archive and any published release artefacts;
- the API, web, and optional webhook-relay container image digests for tagged releases; and
- an SBOM for the application dependency graph.

The project owner retains responsibility for dependency, security, provider-integration, and release decisions.

## Release-note standard and tag enforcement

The release-note source of truth is one Markdown file per stable release at `docs/release-notes/vMAJOR.MINOR.PATCH.md`. The file must begin with front matter containing:

- `version`, matching `WealthWatcher.UI/package.json` and the Git tag without the leading `v`;
- `date` in `YYYY-MM-DD` format;
- `channel: stable`;
- `requiresMigration: true|false`; and
- `requiresConfigurationChange: true|false`.

The body must contain a level-one title and the following level-two sections: `Highlights`, `Fixes`, `Upgrade notes`, `Docker images`, and `Known issues`. Use the checked-in `docs/release-notes/_template.md` when starting a release note.

The CI release-metadata job validates the format on every change and validates the exact `vMAJOR.MINOR.PATCH` match on tag pushes. Tagged images are not published when that validation fails. The tag workflow uses the validated Markdown body to create or refresh the matching GitHub Release.

Before creating a release tag, update `WealthWatcher.UI/package.json` and `WealthWatcher.UI/package-lock.json`, add the matching release note, and run `node scripts/release-notes.mjs validate --tag vMAJOR.MINOR.PATCH`. Create the tag only after that versioned commit is on `main`; a tag created before the package version changes will build an image with stale UI metadata and will fail the tag workflow.

The UI build converts the validated current note into bundled `release.json` metadata. The application displays that metadata in Settings and checks the latest stable GitHub Release for an available update. This check is informational only; it never modifies Docker services.

## Container images and local Docker deployment

Maintainers must set newly created GHCR packages to Public for anonymous pulls. Subsequent versions retain the package's visibility.

Successful pushes to `main` and version tags publish the API, web, and optional webhook-relay container images to the public GitHub Container Registry packages associated with this repository. The images contain application code only; deployment configuration, database data, Data Protection keys, and provider credentials remain local to each installation.

The image tags follow this policy:

- `main` is a moving development image published from successful pushes to the development branch.
- `latest` is a moving alias published only from successful version-tagged releases and identifies the latest stable release.
- `sha-<full-commit-sha>` identifies an immutable source commit and is suitable for rollback or reproducible deployment.
- `vMAJOR.MINOR.PATCH` identifies a tagged application release.

The Git tag and source archive remain the release identity. Image digests should be recorded for tagged releases and may be used instead of tags by installations requiring stronger deployment pinning. The main Compose file continues to support local builds by default; installations can opt into the published API/web images through `API_IMAGE` and `WEB_IMAGE`, and can run the independently configured relay through `docker-compose.relay.yml` and `RELAY_IMAGE`.

## UI package

`WealthWatcher.UI` is an application bundle, not a reusable npm library. Its package remains marked `private` and is not published to npm. Its package version is the application release source of truth; release-note and tag validation keep build metadata consistent with the application release.

## Support and security

Support is limited to the latest tagged release on a best-effort basis. Vulnerabilities must be reported privately through the process in `SECURITY.md`; public issues should not contain credentials, account identifiers, or personal financial data. The local/trusted-network boundary and its deployment responsibilities remain documented separately from this release policy.
