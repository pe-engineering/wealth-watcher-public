using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using WealthWatcher.Api.Caching;
using WealthWatcher.Api.Data;
using WealthWatcher.Api.Integrations;
using WealthWatcher.Api.Integrations.Webhooks;
using WealthWatcher.Api.Models;
using WealthWatcher.Api.Services;
using Xunit;

namespace WealthWatcher.Api.Tests;

public sealed class WebhookDispatcherTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Account_webhook_resolves_and_syncs_the_matching_connection(bool testActiveConnection)
    {
        await using var db = CreateDatabase();
        var adapter = new TestAdapter();
        var registry = new IntegrationRegistry([adapter]);
        var protector = CreateProtector();
        var setup = CreateIntegrationService(db, registry, protector);
        var connection = await setup.CreateConnectionAsync("test", "Webhook connection");
        await setup.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await setup.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Webhook asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await setup.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        await setup.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            Enabled = true,
            SyncMode = nameof(IntegrationSyncMode.Webhook)
        });

        if (testActiveConnection)
        {
            Assert.True((await setup.TestAsync(connection.Id))!.Succeeded);
            var stored = await db.IntegrationConnections.SingleAsync();
            Assert.Equal(IntegrationConnectionStatus.Active, stored.Status);
            Assert.NotNull(stored.LastTestedAt);
            Assert.Null(stored.LastError);
        }

        await using var serviceProvider = BuildDispatcherProvider(db, registry, protector);
        var dispatcher = serviceProvider.GetRequiredService<IWebhookDispatcher>();
        using var document = JsonDocument.Parse("{\"accountId\":\"account-1\",\"eventType\":\"VALUE_UPDATED\"}");
        var envelope = new WebhookEnvelope
        {
            Id = "webhook-1",
            Provider = "test",
            EventType = "VALUE_UPDATED",
            ReceivedAt = DateTimeOffset.UtcNow,
            Payload = document.RootElement.Clone()
        };

        var result = await dispatcher.DispatchAsync(envelope);

        Assert.Equal(WebhookDispatchStatus.Processed, result.Status);
        Assert.Equal(1, adapter.PullCount);
        Assert.Single(await db.AssetValueEntries.ToListAsync());
    }

    [Fact]
    public async Task Concurrent_duplicate_delivery_is_coalesced_for_one_connection()
    {
        await using var db = CreateDatabase();
        var adapter = new TestAdapter(delayPull: true);
        var registry = new IntegrationRegistry([adapter]);
        var protector = CreateProtector();
        var setup = CreateIntegrationService(db, registry, protector);
        var connection = await setup.CreateConnectionAsync("test", "Concurrent webhook connection");
        await setup.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await setup.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Concurrent webhook asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await setup.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        await setup.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            Enabled = true,
            SyncMode = nameof(IntegrationSyncMode.Webhook)
        });

        await using var serviceProvider = BuildDispatcherProvider(db, registry, protector);
        var dispatcher = serviceProvider.GetRequiredService<IWebhookDispatcher>();
        using var document = JsonDocument.Parse("{\"accountId\":\"account-1\"}");
        var envelope = new WebhookEnvelope
        {
            Id = "duplicate-webhook",
            Provider = "test",
            ReceivedAt = DateTimeOffset.UtcNow,
            Payload = document.RootElement.Clone()
        };

        var results = await Task.WhenAll(
            dispatcher.DispatchAsync(envelope),
            dispatcher.DispatchAsync(envelope));

        Assert.All(results, result => Assert.Equal(WebhookDispatchStatus.Processed, result.Status));
        Assert.Equal(1, adapter.PullCount);
    }

    [Fact]
    public async Task Polling_connection_is_not_triggered_by_a_webhook()
    {
        await using var db = CreateDatabase();
        var adapter = new TestAdapter();
        var registry = new IntegrationRegistry([adapter]);
        var protector = CreateProtector();
        var setup = CreateIntegrationService(db, registry, protector);
        var connection = await setup.CreateConnectionAsync("test", "Polling connection");
        await setup.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await setup.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Polling asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await setup.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        await setup.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate { Enabled = true });

        await using var serviceProvider = BuildDispatcherProvider(db, registry, protector);
        var dispatcher = serviceProvider.GetRequiredService<IWebhookDispatcher>();
        using var document = JsonDocument.Parse("{\"accountId\":\"account-1\"}");

        var result = await dispatcher.DispatchAsync(new WebhookEnvelope
        {
            Id = "polling-webhook",
            Provider = "test",
            ReceivedAt = DateTimeOffset.UtcNow,
            Payload = document.RootElement.Clone()
        });

        Assert.Equal(WebhookDispatchStatus.Ignored, result.Status);
        Assert.Contains("scheduled polling", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, adapter.PullCount);
    }

    [Fact]
    public async Task Webhook_mode_is_rejected_for_providers_without_webhook_support()
    {
        await using var db = CreateDatabase();
        var registry = new IntegrationRegistry([new TestAdapter(supportsWebhooks: false)]);
        var setup = CreateIntegrationService(db, registry, CreateProtector());
        var connection = await setup.CreateConnectionAsync("test", "Polling-only connection");

        var exception = await Assert.ThrowsAsync<ArgumentException>(() =>
            setup.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
            {
                SyncMode = nameof(IntegrationSyncMode.Webhook)
            }));

        Assert.Contains("does not support webhook", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Unknown_provider_is_terminally_ignored()
    {
        await using var db = CreateDatabase();
        var registry = new IntegrationRegistry([new TestAdapter()]);
        var protector = CreateProtector();
        await using var serviceProvider = BuildDispatcherProvider(db, registry, protector);
        var dispatcher = serviceProvider.GetRequiredService<IWebhookDispatcher>();
        using var document = JsonDocument.Parse("{}");

        var result = await dispatcher.DispatchAsync(new WebhookEnvelope
        {
            Id = "unknown-provider-webhook",
            Provider = "unknown",
            ReceivedAt = DateTimeOffset.UtcNow,
            Payload = document.RootElement.Clone()
        });

        Assert.Equal(WebhookDispatchStatus.Ignored, result.Status);
    }

    private static WealthDbContext CreateDatabase()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"webhook-tests-{Guid.NewGuid():N}")
            .Options;
        return new WealthDbContext(options);
    }

    private static IntegrationCredentialProtector CreateProtector() =>
        new(DataProtectionProvider.Create($"webhook-tests-{Guid.NewGuid():N}"));

    private static IntegrationService CreateIntegrationService(
        WealthDbContext db,
        IntegrationRegistry registry,
        IIntegrationCredentialProtector protector) =>
        new(
            db,
            registry,
            protector,
            NullLogger<IntegrationService>.Instance,
            new IntegrationSettingsService(db, NullLogger<IntegrationSettingsService>.Instance),
            TimeProvider.System);

    private static ServiceProvider BuildDispatcherProvider(
        WealthDbContext db,
        IntegrationRegistry registry,
        IIntegrationCredentialProtector protector)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(db);
        services.AddSingleton(registry);
        services.AddSingleton(protector);
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddScoped<IntegrationSettingsService>();
        services.AddScoped<IntegrationService>();
        services.AddSingleton<IWebhookConnectionResolver, DefaultWebhookConnectionResolver>();
        services.AddSingleton<IWebhookConnectionResolver, SnaptradeWebhookConnectionResolver>();
        services.AddSingleton<IWebhookDispatcher, WebhookDispatcher>();
        return services.BuildServiceProvider();
    }

    private sealed class TestAdapter(bool delayPull = false, bool supportsWebhooks = true) : IIntegrationAdapter
    {
        public string Key => "test";

        public IntegrationDescriptor Descriptor { get; } = new()
        {
            Key = "test",
            DisplayName = "Test provider",
            SupportsWebhooks = supportsWebhooks,
            CredentialFields = [new IntegrationFieldDescriptor { Key = "apiKey", Label = "API key", Required = true }]
        };

        public int PullCount { get; private set; }

        public Task<IntegrationTestResult> TestAsync(
            IntegrationContext context,
            CancellationToken cancellationToken) =>
            Task.FromResult(new IntegrationTestResult { Succeeded = true });

        public Task<IReadOnlyList<ExternalAccount>> DiscoverAccountsAsync(
            IntegrationContext context,
            CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ExternalAccount>>([new ExternalAccount
            {
                ExternalId = "account-1",
                DisplayName = "Test account",
                AccountType = "Investment",
                Currency = "GBP"
            }]);

        public async Task<IntegrationPullResult> PullAsync(
            IntegrationContext context,
            IReadOnlyCollection<ExternalAccount> accounts,
            CancellationToken cancellationToken)
        {
            PullCount++;
            if (delayPull)
                await Task.Delay(50, cancellationToken);
            return new IntegrationPullResult
            {
                Values =
                [
                    new ExternalValueSnapshot
                    {
                        AccountExternalId = "account-1",
                        ExternalValueId = "value-1",
                        Name = "Test account",
                        Type = "investments",
                        Role = ExternalValueRole.Deployed,
                        Value = 100m,
                        ObservedAt = DateTimeOffset.UtcNow
                    }
                ]
            };
        }
    }
}
