# Adding an integration

Integrations are small provider adapters behind the application-owned `IIntegrationAdapter` contract. Keep provider-specific code in its own folder and leave only shared integration infrastructure directly under `WealthWatcher.Api/Integrations`.

## Folder layout

Use a lower-case provider folder for each provider:

```text
WealthWatcher.Api/Integrations/
├── docs/
├── trading212/
│   └── Trading212IntegrationAdapter.cs
├── snaptrade/
│   └── SnaptradeIntegrationAdapter.cs
├── IIntegrationAdapter.cs
├── IntegrationService.cs
└── ProviderRateLimiter.cs
```

The adapter should expose a stable provider key, a descriptor for the setup UI, and implementations of:

- `TestAsync` for validating credentials;
- `DiscoverAccountsAsync` for finding external accounts; and
- `PullAsync` for returning the values and positions that WealthWatcher stores.

Keep persistence, credential protection, account allocation, and connection lifecycle logic in the common integration services. The adapter should translate the provider’s API into the shared models.

## Rate limiting

Every outbound provider request must pass through the shared `IProviderRateLimiter`. Register the limiter as a singleton so all named instances of the same provider share its buckets. Do not create a limiter inside an adapter or key it by `ConnectionId`.

The provider’s rate-limit policy belongs beside its adapter. Include the provider-wide bucket and any documented endpoint or account buckets when calling `WaitAsync`. Call `Observe` with the response as well, so `429` responses and reset headers can pause the shared buckets.

## Webhook capability

Set `IntegrationDescriptor.SupportsWebhooks` to `true` only when the provider has a signed webhook contract and a stable identifier that can resolve an existing local account or connection. Webhook handlers belong in `WealthWatcher.WebhookRelay` behind `IWebhookProviderHandler`; the API receives the generic `WebhookEnvelope` and must call `IntegrationService.SyncConnectionAsync` rather than importing provider payload values directly. Providers without a relay handler or stable mapping should leave the capability disabled and continue using polling. Each saved connection has one automatic `SyncMode` (`Polling` or `Webhook`); scheduled polling and webhook dispatch must never both trigger the same connection. Polling schedules use the API host's local time and support fixed minutes, five-field cron, hourly minute offsets, hourly on-the-hour, daily, or weekly at a selected weekday and time.

The current provider documentation is the source of truth for the numbers and scopes:

- [Trading 212 rate limiting](https://docs.trading212.com/api/section/rate-limiting) — limits are per account and endpoints publish their specific limits in the API reference.
- [SnapTrade rate limiting](https://docs.snaptrade.com/docs/ratelimiting) — the customer-level limit is shared across requests and account-data endpoints also have a per-account limit.

When adding a new provider, make rate limiting part of the first implementation pass. A new provider must have:

1. a provider-wide bucket that covers every API call made by the adapter;
2. endpoint/account buckets where the provider documents additional limits;
3. cancellation-aware waits; and
4. adapter tests proving that the request path calls the limiter and handles a throttled response appropriately.

## Registration

Register the typed `HttpClient` and adapter in `Program.cs`, then add the adapter to the `IIntegrationAdapter` collection. The registry and setup catalog will pick up the descriptor automatically.

## Tests

Add adapter tests for credential translation, account discovery, pull mapping, and rate limiting. Use a queued `HttpMessageHandler` for provider responses and a fake or no-op limiter for tests that should not wait in real time. Also include a shared-limiter test that creates two provider instances and verifies their calls use the same provider bucket.
