# Wealth Watcher

Wealth Watcher is a self-hosted personal wealth dashboard for recording assets, tracking net worth, modelling forecasts, managing budgets, and optionally synchronising supported providers.

> **Status:** The original project code and documentation are licensed under the [MIT License](LICENSE). This is a local/trusted-network, single-user application with no built-in authentication, authorization, or tenant isolation. Do not expose the API or dashboard directly to the public Internet.

Project site: [wealthwatcher.co.uk](https://wealthwatcher.co.uk)

New here? Start with the [Getting Started guide](docs/GETTING_STARTED.md), or [try the fictional live demo](https://wealthwatcher.co.uk/demo/) before installing anything.

## What it does

- Tracks cash, investments, pensions, property, and other classified assets.
- Shows historical values, calendar views, forecasts, FIRE progress, and budgets.
- Stores integration credentials encrypted with ASP.NET Core Data Protection.
- Supports optional Trading 212 and SnapTrade integrations.
- Supports an optional, separately deployed webhook relay for near-real-time provider refreshes.
- Keeps the primary financial database local to the deployment; provider traffic is outbound only when configured.

Forecasts are illustrative estimates based on the inputs and assumptions shown in the application. Wealth Watcher is not financial advice.

## Requirements

- .NET SDK 10.0.302 (see [global.json](global.json)).
- Node.js 24.13.0 (see [.nvmrc](.nvmrc)).
- Docker and Docker Compose for the containerised setup.
- PostgreSQL 15 or a compatible PostgreSQL service for an external production database. The Compose setup uses PostgreSQL 18.

The recommended Docker Compose path only requires Docker and Docker Compose on the host; the .NET SDK and Node.js are needed for local development.

## Run locally for development

The development API uses an in-memory database, so this path is safe for a quick evaluation and does not require PostgreSQL.

These commands work in PowerShell, macOS, and Linux. The [Getting Started guide](docs/GETTING_STARTED.md) also includes the recommended Docker path and first-run steps.

Start the API in one terminal:

```powershell
dotnet run --project WealthWatcher.Api --environment Development --urls http://127.0.0.1:5200
```

Start the Vite UI in another terminal:

```powershell
npm ci --prefix WealthWatcher.UI
npm run dev --prefix WealthWatcher.UI -- --host 127.0.0.1 --port 5173
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` requests to the development API at `http://127.0.0.1:5200`.

## Run with Docker Compose

For a beginner-friendly walkthrough, see [Getting Started](docs/GETTING_STARTED.md).

Copy the example configuration, replace the placeholder database password, and keep the file private:

```powershell
Copy-Item .env.example .env
# Edit .env and set POSTGRES_PASSWORD to a long random value.
docker compose config --quiet
docker compose up --build
```

On macOS or Linux, the equivalent copy command is:

```sh
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD to a long random value.
docker compose config --quiet
docker compose up --build
```

Open <http://127.0.0.1:8182>. The database, API, and web ports bind to loopback by default. Set the `*_BIND_ADDRESS` values in `.env` only when a trusted-network deployment needs a different interface.

The `CONFIG_PATH` directory contains the Data Protection key ring used to decrypt stored integration credentials. Treat it as sensitive application data, back it up securely, and do not commit it.

### Use published container images

The published images are public and require no registry authentication to pull. Available tags are `main` (development), `latest` (stable release), `vMAJOR.MINOR.PATCH`, and `sha-<full-commit-sha>`.

Successful pushes to `main` and version tags publish the API, web, and optional relay images to GitHub Container Registry:

```text
ghcr.io/pe-engineering/wealth-watcher-public-api
ghcr.io/pe-engineering/wealth-watcher-public-web
ghcr.io/pe-engineering/wealth-watcher-public-webhook-relay
```

The Compose file defaults to local builds. To use the published `main` images instead, set these optional values in `.env`:

```dotenv
API_IMAGE=ghcr.io/pe-engineering/wealth-watcher-public-api:main
WEB_IMAGE=ghcr.io/pe-engineering/wealth-watcher-public-web:main
```

Then pull only the application images and start without rebuilding:

```powershell
docker compose pull api web
docker compose up -d --no-build --remove-orphans
```

For a reproducible deployment, use an immutable `sha-<commit>` tag or a release tag such as `v0.4.0` instead of `main`. The database image remains the official PostgreSQL image and its data remains in the persistent Compose volume.

### Optional webhook relay image

Webhook delivery is intentionally separate from the private application stack. Successful pushes also publish:

```text
ghcr.io/pe-engineering/wealth-watcher-public-webhook-relay
```

The relay accepts provider webhooks on a public HTTPS endpoint, stores them in a local SQLite queue, and forwards them over an outbound WebSocket connection to a configured Wealth Watcher API. The API does not need a public hostname or inbound port. Leave `WEBHOOK_RELAY_ENABLED=false` to keep webhook support disabled.

To run the optional relay as its own container, set these private values in `.env` (or supply equivalent environment variables):

```dotenv
RELAY_INSTALLATION_ID=replace-with-a-private-api-relay-pairing-id
RELAY_TOKEN=replace-with-a-long-random-secret
SNAPTRADE_CONSUMER_KEY=replace-with-the-same-snaptrade-consumer-key-used-by-the-api
RELAY_BIND_ADDRESS=0.0.0.0
RELAY_PORT=8080
```

Then configure the API in the main Compose stack:

```dotenv
WEBHOOK_RELAY_ENABLED=true
WEBHOOK_RELAY_URL=wss://relay.example.com/ws
# Optional API-to-relay diagnostic endpoint; derived from WEBHOOK_RELAY_URL when omitted.
# WEBHOOK_RELAY_HTTP_URL=https://relay.example.com
WEBHOOK_RELAY_INSTALLATION_ID=replace-with-a-private-api-relay-pairing-id
WEBHOOK_RELAY_TOKEN=replace-with-a-long-random-secret
WEBHOOK_RELAY_PUBLIC_BASE_URL=https://relay.example.com
```

Start the relay independently with the published image:

```powershell
$env:RELAY_IMAGE='ghcr.io/pe-engineering/wealth-watcher-public-webhook-relay:main'
docker compose -f docker-compose.relay.yml pull
docker compose -f docker-compose.relay.yml up -d
```

Register this provider-facing relay URL with SnapTrade through its webhook configuration. It must point to the relay's public HTTPS endpoint, never to the Wealth Watcher API:

```text
https://relay.example.com/webhooks/snaptrade
```

Put the relay behind HTTPS/WSS termination and keep `relay-data` private. Each self-hosted Wealth Watcher deployment has one relay and its public host identifies that deployment; a separate deployment uses a separate relay URL. The API/relay pairing id and token are private connection settings and are not part of provider webhook URLs. The relay configuration contains the pairing token and provider verification secret. The Integrations screen can enable or disable webhook delivery and run a relay-to-API diagnostic; the deployment flag remains the hard off switch. Each connection chooses exactly one automatic update mode—scheduled polling or webhook delivery—while explicit manual sync remains available. The API's existing polling worker remains enabled as a fallback and reconciliation mechanism for polling-mode connections.

### Release notes and updates

Each stable release has a reviewed Markdown note under [`docs/release-notes`](docs/release-notes). The note is also used as the GitHub Release body and is bundled into the web image, so the installed application can show the current release notes in Settings even when it cannot reach the Internet.

The Settings page and desktop app bar show the installed version. When a newer stable GitHub Release is available, Settings shows an update indicator and the associated release notes. The indicator is informational; it does not update Docker services automatically.

To apply a published image update manually, review the release note, back up PostgreSQL and the Data Protection key directory, then run:

```powershell
docker compose pull api web
docker compose up -d --no-build --remove-orphans
```

Keep release image tags or digests pinned when reproducible rollback matters. Database migrations run during API startup, so review the release note and retain a verified backup before upgrading.

## Configuration

Compose configuration is supplied through a private `.env` file. The supported variables are documented in [.env.example](.env.example). For a direct API process, use standard ASP.NET Core environment-variable configuration, for example `ConnectionStrings__DefaultConnection` and `Cors__AllowedOrigins__0`.

Provider setup guidance is in [WealthWatcher.Api/Integrations/docs/adding-integrations.md](WealthWatcher.Api/Integrations/docs/adding-integrations.md). Never place provider credentials in source code, issue reports, screenshots, logs, or committed configuration.

## Help, operations, and security

- [Getting Started](docs/GETTING_STARTED.md) — recommended first run and first asset.
- [Operations guide](docs/OPERATIONS.md) — backups, restores, and updates.
- [Support policy](SUPPORT.md) — what can be reported safely and what is out of scope.
- [Security policy](SECURITY.md) — the local/trusted-network boundary and private vulnerability reporting.

## Marketing-site analytics

The public landing page can use Microsoft Clarity and Google Analytics 4 after visitor consent. Neither service is included in the self-hosted dashboard or receives dashboard or financial data. To enable them for GitHub Pages, add `CLARITY_PROJECT_ID` and/or `GA4_MEASUREMENT_ID` as variables on the repository's `github-pages` Actions environment. The Pages workflow injects the values at deploy time; leave them unset to keep analytics disabled for forks and local previews.

The Clarity project ID and GA4 Measurement ID are public browser identifiers, not secrets. Keeping them out of source prevents other builds from reporting into the owner's projects. Never add Clarity API credentials, Google service-account credentials, or other private keys to the frontend.

## Verify changes

From the repository root:

```powershell
dotnet test WealthWatcher.Api.Tests/WealthWatcher.Api.Tests.csproj
npm ci --prefix WealthWatcher.UI
npm test --prefix WealthWatcher.UI
npm run build --prefix WealthWatcher.UI
docker compose config --quiet
```

The public pull-request workflow repeats the API, relay, and UI checks and validates all three Docker builds. Successful pushes to `main` and version tags also publish the application images described above, including the optional relay image.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Vulnerabilities must be reported privately using the process in [SECURITY.md](SECURITY.md), not through a public issue.

## License and release readiness

Original project code and documentation are released under the [MIT License](LICENSE). Third-party packages, Docker images, provider APIs, provider data, names, logos, and other external material remain subject to their own terms; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Release and versioning rules are documented in [RELEASE_POLICY.md](RELEASE_POLICY.md). The current stable release is `v0.10.0`. The UI package remains private and is not published as an npm library.

The project owner retains sole responsibility for merge decisions, release approval, and changing the release boundary.

## Leave a tip

If Wealth Watcher has been useful, you can leave an optional tip as thanks for the software already provided:

[![Leave a tip](https://img.buymeacoffee.com/button-api/?text=Leave%20a%20tip&emoji=%F0%9F%91%8D&slug=paevans87&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000)](https://buymeacoffee.com/paevans87)
