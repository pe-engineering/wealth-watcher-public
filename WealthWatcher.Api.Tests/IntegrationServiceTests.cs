using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using WealthWatcher.Api.Caching;
using WealthWatcher.Api.Data;
using WealthWatcher.Api.Integrations;
using WealthWatcher.Api.Models;
using WealthWatcher.Api.Services;
using Xunit;

namespace WealthWatcher.Api.Tests;

public sealed class IntegrationServiceTests
{
    [Fact]
    public void Credential_protector_encrypts_values_before_storage()
    {
        var path = Path.Combine(Path.GetTempPath(), $"wealth-watcher-keys-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);

        try
        {
            var provider = DataProtectionProvider.Create(path);
            var protector = new IntegrationCredentialProtector(provider);
            var ciphertext = protector.Protect(new Dictionary<string, string> { ["apiKey"] = "top-secret-value" });

            Assert.DoesNotContain("top-secret-value", ciphertext, StringComparison.Ordinal);
            Assert.Equal("top-secret-value", protector.Unprotect(ciphertext)["apiKey"]);
        }
        finally
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
    }

    [Fact]
    public async Task Integration_lifecycle_tests_discovers_allocates_syncs_and_removes_an_account()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-tests");
        var registry = new IntegrationRegistry([new TestAdapter(" (undeployed)")]);
        var service = CreateService(
            db,
            registry,
            new IntegrationCredentialProtector(provider));

        var connection = await service.CreateConnectionAsync("test", "Test connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        var stored = await db.IntegrationConnections.SingleAsync();
        Assert.NotEqual("secret", stored.CredentialsCiphertext);

        var test = await service.TestAsync(connection.Id);
        Assert.NotNull(test);
        Assert.True(test!.Succeeded);

        var discovered = await service.DiscoverAccountsAsync(connection.Id);
        Assert.NotNull(discovered);
        Assert.True(discovered!.Succeeded);
        var account = await db.IntegrationAccounts.SingleAsync();
        Assert.Equal(IntegrationConnectionStatus.NeedsAllocation, stored.Status);

        var asset = new Asset { DisplayName = "Test investment" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();

        await service.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        Assert.Equal(IntegrationConnectionStatus.Active, stored.Status);

        var sync = await service.SyncAsync(connection.Id);
        Assert.NotNull(sync);
        Assert.True(sync!.Succeeded);
        var entry = await db.AssetValueEntries
            .Include(candidate => candidate.SourceLink)
                .ThenInclude(source => source!.ExternalValue)
                    .ThenInclude(value => value!.IntegrationAccount)
                        .ThenInclude(account => account!.IntegrationConnection)
                            .ThenInclude(connection => connection!.IntegrationProvider)
            .SingleAsync();
        Assert.Equal(asset.Id, entry.AssetId);
        Assert.Equal(125m, entry.Value);
        Assert.Equal("Test investment (undeployed)", entry.Name);
        Assert.Equal("test", entry.SourceLink!.ExternalValue!.IntegrationAccount!.IntegrationConnection!
            .IntegrationProvider!.Code);

        Assert.True(await service.DeleteConnectionAsync(connection.Id));
        Assert.Empty(await db.IntegrationConnections.ToListAsync());
        Assert.Empty(await db.IntegrationAccounts.ToListAsync());
        Assert.Single(await db.AssetValueEntries.ToListAsync());
        Assert.False(await service.DeleteConnectionAsync(connection.Id));
    }

    [Fact]
    public async Task Provider_failure_details_are_not_returned_or_persisted()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-security-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-security-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter(throwOnPull: true)]),
            new IntegrationCredentialProtector(provider));

        var connection = await service.CreateConnectionAsync("test", "Security test connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Security test asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await service.AllocateAccountAsync(connection.Id, account.Id, asset.Id);

        var sync = await service.SyncAsync(connection.Id);

        Assert.NotNull(sync);
        Assert.False(sync!.Succeeded);
        Assert.Equal(IntegrationSecurityMessages.SyncFailed, sync.Message);
        Assert.DoesNotContain("provider.example", sync.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-token", sync.Message, StringComparison.Ordinal);

        var storedConnection = await db.IntegrationConnections.SingleAsync();
        Assert.Equal(IntegrationSecurityMessages.SyncFailed, storedConnection.LastError);
        var run = await db.SyncRuns.SingleAsync();
        Assert.Equal(IntegrationSecurityMessages.SyncFailed, run.LogMessage);
        Assert.DoesNotContain("provider.example", run.LogMessage, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-token", run.LogMessage, StringComparison.Ordinal);

        storedConnection.LastError = "provider.example returned secret-token";
        await db.SaveChangesAsync();
        var connectionResponse = Assert.Single(await service.GetConnectionsAsync());
        Assert.Equal(IntegrationSecurityMessages.ConnectionOperationFailed, connectionResponse.LastError);
        Assert.DoesNotContain("provider.example", connectionResponse.LastError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Replacing_a_connection_and_reallocating_the_same_asset_does_not_duplicate_the_value()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-replacement-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-replacement-tests");
        var observedAt = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter(observedAt: observedAt)]),
            new IntegrationCredentialProtector(provider),
            new FixedTimeProvider(observedAt));

        var firstConnection = await service.CreateConnectionAsync("test", "First connection");
        await service.SaveCredentialsAsync(firstConnection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(firstConnection.Id);
        var firstAccount = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Existing investment" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await service.AllocateAccountAsync(firstConnection.Id, firstAccount.Id, asset.Id);
        Assert.True((await service.SyncAsync(firstConnection.Id))!.Succeeded);

        Assert.True(await service.DeleteConnectionAsync(firstConnection.Id));

        var replacementConnection = await service.CreateConnectionAsync("test", "Replacement connection");
        await service.SaveCredentialsAsync(
            replacementConnection.Id,
            new Dictionary<string, string> { ["apiKey"] = "replacement-secret" });
        await service.DiscoverAccountsAsync(replacementConnection.Id);
        var replacementAccount = await db.IntegrationAccounts
            .SingleAsync(account => account.IntegrationConnectionId == replacementConnection.Id);
        await service.AllocateAccountAsync(replacementConnection.Id, replacementAccount.Id, asset.Id);

        Assert.True((await service.SyncAsync(replacementConnection.Id))!.Succeeded);

        var entries = await db.AssetValueEntries.ToListAsync();
        var entry = Assert.Single(entries);
        Assert.Equal(asset.Id, entry.AssetId);
        Assert.Equal(125m, entry.Value);
    }

    [Fact]
    public async Task Current_day_sync_does_not_invalidate_historical_wealth_cache()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-current-day-cache-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-current-day-cache-tests");
        var now = new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);
        var invalidator = new TestCacheInvalidator();
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter(observedAt: now)]),
            new IntegrationCredentialProtector(provider),
            new FixedTimeProvider(now),
            invalidator);

        var connection = await service.CreateConnectionAsync("test", "Current-day cache connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Current-day asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await service.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        var invalidationsBeforeSync = invalidator.WealthInvalidations;

        var sync = await service.SyncAsync(connection.Id);

        Assert.True(sync!.Succeeded);
        Assert.Equal(invalidationsBeforeSync, invalidator.WealthInvalidations);
        Assert.True(invalidator.CurrentWealthInvalidations > 0);
    }

    [Fact]
    public async Task Scheduled_sync_skips_closed_market_hours_but_forced_sync_ignores_them()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"market-hours-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-market-hours-tests");
        var adapter = new TestAdapter();
        var service = CreateService(
            db,
            new IntegrationRegistry([adapter]),
            new IntegrationCredentialProtector(provider),
            new FixedTimeProvider(new DateTimeOffset(2026, 8, 9, 12, 0, 0, TimeSpan.Zero)));

        var connection = await service.CreateConnectionAsync("test", "Market-hours connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var asset = new Asset { DisplayName = "Market-hours asset" };
        db.Assets.Add(asset);
        await db.SaveChangesAsync();
        await service.AllocateAccountAsync(connection.Id, account.Id, asset.Id);
        await service.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            OnlyPollDuringMarketTimes = true
        });

        await new IntegrationSettingsService(db, NullLogger<IntegrationSettingsService>.Instance)
            .SaveMarketHoursAsync(CreateMarketHours());

        Assert.Empty(await service.SyncEnabledAsync());
        Assert.Equal(0, adapter.PullCount);

        var forcedResults = await service.SyncEnabledAsync(ignoreSchedule: true);

        Assert.Single(forcedResults);
        Assert.True(forcedResults[0].Succeeded);
        Assert.Equal(1, adapter.PullCount);
    }

    [Fact]
    public async Task Snaptrade_sync_preserves_deployed_and_undeployed_values_on_separate_account_assets()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-cash-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-cash-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter(includeCash: true, providerKey: SnaptradeIntegrationAdapter.ProviderKey)]),
            new IntegrationCredentialProtector(provider));

        var connection = await service.CreateConnectionAsync(SnaptradeIntegrationAdapter.ProviderKey, "Cash test connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();
        var investedAsset = new Asset { DisplayName = "Invested asset" };
        var cashAsset = new Asset { DisplayName = "Undeployed cash" };
        db.Assets.AddRange(investedAsset, cashAsset);
        await db.SaveChangesAsync();

        await service.AllocateAccountAsync(connection.Id, account.Id, investedAsset.Id);
        await service.AllocateAccountAsync(
            connection.Id,
            account.Id,
            cashAsset.Id,
            ExternalValueRole.Undeployed);
        var sync = await service.SyncAsync(connection.Id);
        Assert.True(sync!.Succeeded);

        var entries = await db.AssetValueEntries.OrderBy(entry => entry.AssetId).ToListAsync();
        Assert.Equal(2, entries.Count);
        Assert.Equal(investedAsset.Id, Assert.Single(entries, entry => entry.Value == 100m).AssetId);
        Assert.Equal(cashAsset.Id, Assert.Single(entries, entry => entry.Value == 25m).AssetId);
        var undeployed = await db.ExternalValues
            .Include(value => value.AssetMappings)
            .SingleAsync(value => value.Role == ExternalValueRole.Undeployed);
        Assert.Equal(cashAsset.Id, Assert.Single(undeployed.AssetMappings).AssetId);

        var replacementCashAsset = new Asset { DisplayName = "Replacement undeployed cash" };
        db.Assets.Add(replacementCashAsset);
        undeployed.Role = ExternalValueRole.Other;
        undeployed.DisplayName = "Test account";
        await db.SaveChangesAsync();

        await service.AllocateAccountAsync(
            connection.Id,
            account.Id,
            replacementCashAsset.Id,
            ExternalValueRole.Undeployed);

        var movedCashEntry = await db.AssetValueEntries.SingleAsync(entry => entry.Value == 25m);
        Assert.Equal(replacementCashAsset.Id, movedCashEntry.AssetId);
        Assert.Equal(replacementCashAsset.DisplayName, movedCashEntry.Name);
    }

    [Fact]
    public async Task Created_allocation_uses_selected_asset_kind_and_can_be_cleared()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-kind-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-kind-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter()]),
            new IntegrationCredentialProtector(provider));

        var connection = await service.CreateConnectionAsync("test", "Kind test connection");
        await service.SaveCredentialsAsync(connection.Id, new Dictionary<string, string> { ["apiKey"] = "secret" });
        await service.DiscoverAccountsAsync(connection.Id);
        var account = await db.IntegrationAccounts.SingleAsync();

        AssetCatalogService.EnsureDefaults(db);
        var pensionKind = await db.AssetKinds.SingleAsync(kind => kind.Code == AssetKindCodes.Pensions);
        var allocation = await service.CreateAndAllocateAccountAsync(
            connection.Id,
            account.Id,
            "Pension allocation",
            null,
            pensionKind.Id,
            ExternalValueRole.Deployed);

        Assert.NotNull(allocation);
        var createdAsset = await db.Assets
            .Include(asset => asset.AssetKindAssignments)
            .SingleAsync(asset => asset.DisplayName == "Pension allocation");
        Assert.Equal(pensionKind.Id, Assert.Single(createdAsset.AssetKindAssignments).AssetKindId);

        await service.ClearAccountAllocationAsync(connection.Id, account.Id, ExternalValueRole.Deployed);

        Assert.Empty(await db.IntegrationAccountAssetMappings
            .Where(mapping => mapping.IntegrationAccountId == account.Id &&
                              mapping.Role == ExternalValueRole.Deployed)
            .ToListAsync());
    }

    [Fact]
    public async Task Integration_provider_supports_multiple_named_connections()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-duplicate-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-duplicate-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter()]),
            new IntegrationCredentialProtector(provider));

        var first = await service.CreateConnectionAsync("test", null);
        var second = await service.CreateConnectionAsync("test", null);

        Assert.Equal("Test partner", first.DisplayName);
        Assert.Equal("Test partner 2", second.DisplayName);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal(2, await db.IntegrationConnections.CountAsync());
    }

    [Fact]
    public async Task Polling_schedule_settings_are_normalized_and_returned()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-schedule-settings-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-schedule-settings-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter()]),
            new IntegrationCredentialProtector(provider));

        var connection = await service.CreateConnectionAsync("test", "Schedule settings connection");
        var weekly = await service.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            PollingScheduleType = nameof(IntegrationPollingScheduleType.WeeklyAt),
            PollingScheduleValue = "09:05",
            PollingScheduleDay = nameof(DayOfWeek.Friday)
        });

        Assert.NotNull(weekly);
        Assert.Equal(nameof(IntegrationPollingScheduleType.WeeklyAt), weekly!.PollingScheduleType);
        Assert.Equal("09:05", weekly.PollingScheduleValue);
        Assert.Equal(nameof(DayOfWeek.Friday), weekly.PollingScheduleDay);

        var stored = await db.IntegrationConnections.SingleAsync();
        Assert.Equal(IntegrationPollingScheduleType.WeeklyAt, stored.PollingScheduleType);
        Assert.Equal("09:05", stored.PollingScheduleValue);
        Assert.Equal(DayOfWeek.Friday, stored.PollingScheduleDay);

        var daily = await service.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            PollingScheduleType = nameof(IntegrationPollingScheduleType.DailyAt)
        });

        Assert.NotNull(daily);
        Assert.Equal(nameof(IntegrationPollingScheduleType.DailyAt), daily!.PollingScheduleType);
        Assert.Equal("08:00", daily.PollingScheduleValue);
        Assert.Null(daily.PollingScheduleDay);

        var interval = await service.UpdateConnectionAsync(connection.Id, new IntegrationConnectionUpdate
        {
            PollingIntervalMinutes = 15
        });

        Assert.NotNull(interval);
        Assert.Equal(nameof(IntegrationPollingScheduleType.EveryNMinutes), interval!.PollingScheduleType);
        Assert.Equal("15", interval.PollingScheduleValue);
        Assert.Null(interval.PollingScheduleDay);
    }

    [Fact]
    public async Task Integration_instances_keep_provider_links_separate()
    {
        var options = new DbContextOptionsBuilder<WealthDbContext>()
            .UseInMemoryDatabase($"integration-instance-tests-{Guid.NewGuid():N}")
            .Options;
        await using var db = new WealthDbContext(options);
        var provider = DataProtectionProvider.Create("wealth-watcher-integration-instance-tests");
        var service = CreateService(
            db,
            new IntegrationRegistry([new TestAdapter()]),
            new IntegrationCredentialProtector(provider));

        var first = await service.CreateConnectionAsync("test", "Test ISA");
        var second = await service.CreateConnectionAsync("test", "Test Invest");
        await service.SaveCredentialsAsync(first.Id, new Dictionary<string, string> { ["apiKey"] = "isa-secret" });
        await service.SaveCredentialsAsync(second.Id, new Dictionary<string, string> { ["apiKey"] = "invest-secret" });
        await service.DiscoverAccountsAsync(first.Id);
        await service.DiscoverAccountsAsync(second.Id);

        var firstAsset = new Asset { DisplayName = "ISA asset" };
        var secondAsset = new Asset { DisplayName = "Invest asset" };
        db.Assets.AddRange(firstAsset, secondAsset);
        await db.SaveChangesAsync();

        var firstAccount = await db.IntegrationAccounts.SingleAsync(account => account.IntegrationConnectionId == first.Id);
        var secondAccount = await db.IntegrationAccounts.SingleAsync(account => account.IntegrationConnectionId == second.Id);
        await service.AllocateAccountAsync(first.Id, firstAccount.Id, firstAsset.Id);
        await service.AllocateAccountAsync(second.Id, secondAccount.Id, secondAsset.Id);

        Assert.True((await service.SyncAsync(first.Id))!.Succeeded);
        Assert.True((await service.SyncAsync(second.Id))!.Succeeded);

        var values = await db.ExternalValues
            .Include(value => value.IntegrationAccount)
            .Include(value => value.AssetMappings)
            .ToListAsync();
        Assert.Equal(2, values.Count);
        Assert.Contains(values, value => value.IntegrationAccount!.IntegrationConnectionId == first.Id &&
                                        value.AssetMappings.Any(mapping => mapping.AssetId == firstAsset.Id));
        Assert.Contains(values, value => value.IntegrationAccount!.IntegrationConnectionId == second.Id &&
                                        value.AssetMappings.Any(mapping => mapping.AssetId == secondAsset.Id));
        Assert.Equal(2, await db.AssetValueEntries.CountAsync());

    }

    private static IntegrationService CreateService(
        WealthDbContext db,
        IntegrationRegistry registry,
        IIntegrationCredentialProtector credentialProtector,
        TimeProvider? timeProvider = null,
        IWealthCacheInvalidator? invalidator = null) =>
        new(
            db,
            registry,
            credentialProtector,
            NullLogger<IntegrationService>.Instance,
            new IntegrationSettingsService(db, NullLogger<IntegrationSettingsService>.Instance),
            timeProvider ?? TimeProvider.System,
            invalidator);

    private static MarketHoursSettings CreateMarketHours() => new()
    {
        Days = Enum.GetValues<DayOfWeek>()
            .Select(day => new MarketHoursDaySettings
            {
                Day = day.ToString(),
                Enabled = day is not (DayOfWeek.Saturday or DayOfWeek.Sunday),
                OpenTime = "08:00",
                CloseTime = "16:30"
            })
            .ToList()
    };

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TestAdapter(
        string? snapshotNameSuffix = null,
        bool includeCash = false,
        string providerKey = "test",
        DateTimeOffset? observedAt = null,
        bool throwOnPull = false) : IIntegrationAdapter
    {
        public string Key => providerKey;

        public IntegrationDescriptor Descriptor { get; } = new()
        {
            Key = providerKey,
            DisplayName = providerKey == SnaptradeIntegrationAdapter.ProviderKey ? "SnapTrade" : "Test partner",
            CredentialFields = [new IntegrationFieldDescriptor { Key = "apiKey", Label = "API key", Required = true }]
        };

        public int PullCount { get; private set; }

        public Task<IntegrationTestResult> TestAsync(IntegrationContext context, CancellationToken cancellationToken) =>
            Task.FromResult(new IntegrationTestResult { Succeeded = true, Message = "Test passed." });

        public Task<IReadOnlyList<ExternalAccount>> DiscoverAccountsAsync(IntegrationContext context, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ExternalAccount>>([new ExternalAccount
            {
                ExternalId = "account-1",
                DisplayName = "Test account",
                AccountType = "Investment",
                Currency = "GBP"
            }]);

        public Task<IntegrationPullResult> PullAsync(
            IntegrationContext context,
            IReadOnlyCollection<ExternalAccount> accounts,
            CancellationToken cancellationToken)
        {
            PullCount++;
            if (throwOnPull)
                throw new InvalidOperationException("provider.example returned secret-token for account SIPP with value £1234.56");

            return Task.FromResult(CreatePullResult(snapshotNameSuffix, includeCash, observedAt));
        }

        private static IntegrationPullResult CreatePullResult(
            string? snapshotNameSuffix,
            bool includeCash,
            DateTimeOffset? observedAtOverride = null)
        {
            var observedAt = observedAtOverride ?? DateTimeOffset.UtcNow;
            var values = new List<ExternalValueSnapshot>
            {
                new()
                {
                    AccountExternalId = "account-1",
                    ExternalValueId = "value-1",
                    Name = "Test account",
                    NameSuffix = snapshotNameSuffix,
                    Type = "investments",
                    Role = ExternalValueRole.Deployed,
                    Value = includeCash ? 100m : 125m,
                    ObservedAt = observedAt
                }
            };
            if (includeCash)
            {
                values.Add(new ExternalValueSnapshot
                {
                    AccountExternalId = "account-1",
                    ExternalValueId = "value-1:cash",
                    Name = "Test account",
                    NameSuffix = " (undeployed)",
                    Type = "cash",
                    Role = ExternalValueRole.Undeployed,
                    Value = 25m,
                    ObservedAt = observedAt
                });
            }

            return new IntegrationPullResult { Values = values };
        }
    }

    private sealed class TestCacheInvalidator : IWealthCacheInvalidator
    {
        public int WealthInvalidations { get; private set; }
        public int CurrentWealthInvalidations { get; private set; }

        public Task InvalidateWealthAsync(CancellationToken cancellationToken = default)
        {
            WealthInvalidations++;
            return Task.CompletedTask;
        }

        public Task InvalidateCurrentWealthAsync(CancellationToken cancellationToken = default)
        {
            CurrentWealthInvalidations++;
            return Task.CompletedTask;
        }

        public Task InvalidateCatalogueAsync(CancellationToken cancellationToken = default) =>
            Task.CompletedTask;
    }
}
