using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WealthWatcher.Api.Caching;
using WealthWatcher.Api.Data;
using WealthWatcher.Api.Models;
using WealthWatcher.Api.Services;

namespace WealthWatcher.Api.Integrations;

public sealed class IntegrationService(
    WealthDbContext db,
    IntegrationRegistry registry,
    IIntegrationCredentialProtector credentialProtector,
    ILogger<IntegrationService> logger,
    IntegrationSettingsService integrationSettings,
    TimeProvider timeProvider,
    IWealthCacheInvalidator? invalidator = null)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly ConcurrentDictionary<Guid, SemaphoreSlim> SyncLocks = new();

    public IReadOnlyList<IntegrationDescriptor> GetCatalog() =>
        registry.All.Select(adapter => adapter.Descriptor).OrderBy(descriptor => descriptor.DisplayName).ToList();

    public async Task<IReadOnlyList<IntegrationConnectionResponse>> GetConnectionsAsync(
        CancellationToken cancellationToken = default)
    {
        var connections = await db.IntegrationConnections
            .AsNoTracking()
            .Include(connection => connection.IntegrationProvider)
            .Include(connection => connection.Accounts)
                .ThenInclude(account => account.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .Include(connection => connection.Accounts)
                .ThenInclude(account => account.ExternalValues)
                    .ThenInclude(value => value.AssetMappings)
                        .ThenInclude(mapping => mapping.Asset)
            .OrderBy(connection => connection.DisplayName)
            .ToListAsync(cancellationToken);

        return connections.Select(ToResponse).ToList();
    }

    public async Task<IntegrationConnection> CreateConnectionAsync(
        string providerKey,
        string? displayName,
        CancellationToken cancellationToken = default)
    {
        var adapter = registry.Get(providerKey);
        var provider = await IntegrationCatalogService.EnsureProviderAsync(db, adapter, cancellationToken);
        var name = await ResolveConnectionNameAsync(
            provider.Id,
            adapter.Descriptor.DisplayName,
            displayName,
            cancellationToken);

        var connection = new IntegrationConnection
        {
            IntegrationProviderId = provider.Id,
            IntegrationProvider = provider,
            Kind = adapter.Descriptor.Kind,
            DisplayName = name,
            Status = IntegrationConnectionStatus.NeedsCredentials,
            SyncMode = IntegrationSyncMode.Polling,
            PollingIntervalMinutes = adapter.Descriptor.DefaultPollingIntervalMinutes,
            PollingScheduleType = IntegrationPollingScheduleType.EveryNMinutes,
            PollingScheduleValue = adapter.Descriptor.DefaultPollingIntervalMinutes
                .ToString(CultureInfo.InvariantCulture),
            OptionsJson = JsonSerializer.Serialize(
                adapter.Descriptor.OptionFields
                    .Where(field => field.DefaultValue is not null)
                    .ToDictionary(field => field.Key, field => field.DefaultValue!),
                JsonOptions)
        };
        db.IntegrationConnections.Add(connection);
        await db.SaveChangesAsync(cancellationToken);
        return connection;
    }

    private async Task<string> ResolveConnectionNameAsync(
        Guid providerId,
        string providerDisplayName,
        string? requestedName,
        CancellationToken cancellationToken)
    {
        var baseName = string.IsNullOrWhiteSpace(requestedName)
            ? providerDisplayName
            : requestedName.Trim();
        var existingNames = await db.IntegrationConnections
            .AsNoTracking()
            .Where(connection => connection.IntegrationProviderId == providerId)
            .Select(connection => connection.DisplayName)
            .ToListAsync(cancellationToken);

        if (existingNames.All(name => !name.Equals(baseName, StringComparison.OrdinalIgnoreCase)))
            return baseName;

        for (var suffix = 2; ; suffix++)
        {
            var candidate = $"{baseName} {suffix}";
            if (existingNames.All(name => !name.Equals(candidate, StringComparison.OrdinalIgnoreCase)))
                return candidate;
        }
    }

    public async Task<bool> DeleteConnectionAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        var connection = await db.IntegrationConnections
            .FirstOrDefaultAsync(candidate => candidate.Id == connectionId, cancellationToken);
        if (connection is null)
            return false;

        db.IntegrationConnections.Remove(connection);
        await db.SaveChangesAsync(cancellationToken);
        await InvalidateWealthAsync(cancellationToken);
        return true;
    }

    public async Task<IntegrationConnectionResponse?> SaveCredentialsAsync(
        Guid connectionId,
        IReadOnlyDictionary<string, string> credentials,
        CancellationToken cancellationToken = default)
    {
        var connection = await LoadConnectionAsync(connectionId, cancellationToken);
        if (connection is null)
            return null;

        var adapter = registry.Get(connection.IntegrationProvider!.Code);
        var mergedCredentials = connection.CredentialsCiphertext.Length == 0
            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            : credentialProtector.Unprotect(connection.CredentialsCiphertext)
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        foreach (var pair in credentials.Where(pair => !string.IsNullOrWhiteSpace(pair.Value)))
            mergedCredentials[pair.Key] = pair.Value.Trim();

        ValidateFields(adapter.Descriptor.CredentialFields, mergedCredentials, "credentials");
        connection.CredentialsCiphertext = credentialProtector.Protect(mergedCredentials);
        connection.Status = IntegrationConnectionStatus.ReadyToTest;
        connection.LastError = null;
        connection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return ToResponse(connection);
    }

    public async Task<IntegrationOperationResponse?> TestAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        var connection = await LoadConnectionAsync(connectionId, cancellationToken);
        if (connection is null)
            return null;

        var adapter = registry.Get(connection.IntegrationProvider!.Code);
        try
        {
            var result = await adapter.TestAsync(BuildContext(connection), cancellationToken);
            connection.LastTestedAt = DateTimeOffset.UtcNow;
            connection.LastError = result.Succeeded ? null : IntegrationSecurityMessages.TestFailed;
            connection.Status = result.Succeeded
                ? IntegrationConnectionStatus.Tested
                : IntegrationConnectionStatus.Error;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);

            return new IntegrationOperationResponse
            {
                Succeeded = result.Succeeded,
                Message = result.Succeeded ? "Integration test succeeded." : IntegrationSecurityMessages.TestFailed,
                Accounts = result.Accounts
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            connection.LastTestedAt = DateTimeOffset.UtcNow;
            connection.LastError = IntegrationSecurityMessages.TestFailed;
            connection.Status = IntegrationConnectionStatus.Error;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            logger.LogWarning("Integration test failed for provider {ProviderCode} connection {ConnectionId}.",
                connection.IntegrationProvider.Code, connection.Id);
            return new IntegrationOperationResponse
            {
                Succeeded = false,
                Message = IntegrationSecurityMessages.TestFailed
            };
        }
    }

    public async Task<IntegrationOperationResponse?> DiscoverAccountsAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        var connection = await LoadConnectionAsync(connectionId, cancellationToken);
        if (connection is null)
            return null;

        var adapter = registry.Get(connection.IntegrationProvider!.Code);
        try
        {
            var accounts = await adapter.DiscoverAccountsAsync(BuildContext(connection), cancellationToken);
            var discoveredIds = accounts.Select(account => account.ExternalId)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            foreach (var existing in connection.Accounts.Where(account =>
                         !discoveredIds.Contains(account.ExternalId)))
            {
                existing.Status = IntegrationAccountStatus.Missing;
            }

            foreach (var external in accounts)
            {
                var account = connection.Accounts.FirstOrDefault(candidate =>
                    candidate.ExternalId.Equals(external.ExternalId, StringComparison.OrdinalIgnoreCase));
                if (account is null)
                {
                    account = new IntegrationAccount
                    {
                        IntegrationConnectionId = connection.Id,
                        ExternalId = external.ExternalId
                    };
                    connection.Accounts.Add(account);
                    db.IntegrationAccounts.Add(account);
                }

                account.DisplayName = external.DisplayName;
                account.AccountType = external.AccountType;
                account.Currency = external.Currency;
                account.Status = IsAllocationComplete(account, connection.IntegrationProvider?.Code)
                    ? IntegrationAccountStatus.Allocated
                    : IntegrationAccountStatus.Discovered;
                account.LastSeenAt = DateTimeOffset.UtcNow;
            }

            connection.Status = connection.Accounts.Any(account => RequiresAllocation(account, connection.IntegrationProvider?.Code))
                ? IntegrationConnectionStatus.NeedsAllocation
                : IntegrationConnectionStatus.Active;
            connection.LastError = null;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);

            return new IntegrationOperationResponse
            {
                Succeeded = true,
                Message = accounts.Count == 0 ? "No accounts were returned." : $"Discovered {accounts.Count} account(s).",
                Accounts = accounts
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            connection.Status = IntegrationConnectionStatus.Error;
            connection.LastError = IntegrationSecurityMessages.AccountDiscoveryFailed;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            logger.LogWarning("Account discovery failed for provider {ProviderCode} connection {ConnectionId}.",
                connection.IntegrationProvider.Code, connection.Id);
            return new IntegrationOperationResponse
            {
                Succeeded = false,
                Message = IntegrationSecurityMessages.AccountDiscoveryFailed
            };
        }
    }

    public async Task<IntegrationConnectionResponse?> UpdateConnectionAsync(
        Guid connectionId,
        IntegrationConnectionUpdate update,
        CancellationToken cancellationToken = default)
    {
        var connection = await LoadConnectionAsync(connectionId, cancellationToken);
        if (connection is null)
            return null;

        var adapter = registry.Get(connection.IntegrationProvider!.Code);
        if (update.DisplayName is not null)
        {
            if (string.IsNullOrWhiteSpace(update.DisplayName))
                throw new ArgumentException("A connection name is required.");

            var displayName = update.DisplayName.Trim();
            var duplicateName = await db.IntegrationConnections.AnyAsync(candidate =>
                candidate.Id != connection.Id &&
                candidate.IntegrationProviderId == connection.IntegrationProviderId &&
                candidate.DisplayName.ToUpper() == displayName.ToUpper(),
                cancellationToken);
            if (duplicateName)
                throw new ArgumentException($"An instance named '{displayName}' already exists for {adapter.Descriptor.DisplayName}.");
            connection.DisplayName = displayName;
        }

        if (update.SyncMode is not null)
        {
            if (!TryParseSyncMode(update.SyncMode, out var syncMode))
                throw new ArgumentException("Sync mode must be either Polling or Webhook.");
            if (syncMode == IntegrationSyncMode.Webhook && !adapter.Descriptor.SupportsWebhooks)
            {
                throw new ArgumentException(
                    $"{adapter.Descriptor.DisplayName} does not support webhook-driven updates.");
            }

            connection.SyncMode = syncMode;
        }

        if (update.PollingIntervalMinutes.HasValue)
        {
            if (update.PollingIntervalMinutes.Value < adapter.Descriptor.MinimumPollingIntervalMinutes)
                throw new ArgumentException($"Polling interval must be at least {adapter.Descriptor.MinimumPollingIntervalMinutes} minute(s).");
            connection.PollingIntervalMinutes = update.PollingIntervalMinutes.Value;
            connection.PollingScheduleType = IntegrationPollingScheduleType.EveryNMinutes;
            connection.PollingScheduleValue = update.PollingIntervalMinutes.Value
                .ToString(CultureInfo.InvariantCulture);
            connection.PollingScheduleDay = null;
        }

        if (update.PollingScheduleType is not null ||
            update.PollingScheduleValue is not null ||
            update.PollingScheduleDay is not null)
        {
            IntegrationPollingScheduleType scheduleType;
            if (update.PollingScheduleType is null)
                scheduleType = connection.PollingScheduleType;
            else if (!TryParsePollingScheduleType(update.PollingScheduleType, out scheduleType))
                throw new ArgumentException("Polling schedule type is not supported.");

            var scheduleTypeChanged = update.PollingScheduleType is not null &&
                                       scheduleType != connection.PollingScheduleType;
            var scheduleValue = update.PollingScheduleValue ?? connection.PollingScheduleValue;
            if (scheduleTypeChanged && string.IsNullOrWhiteSpace(update.PollingScheduleValue))
                scheduleValue = DefaultPollingScheduleValue(scheduleType);
            if (scheduleType == IntegrationPollingScheduleType.EveryNMinutes &&
                string.IsNullOrWhiteSpace(scheduleValue))
            {
                scheduleValue = connection.PollingIntervalMinutes.ToString(CultureInfo.InvariantCulture);
            }

            var scheduleDay = scheduleType == IntegrationPollingScheduleType.WeeklyAt
                ? update.PollingScheduleDay is not null
                    ? ParsePollingScheduleDay(update.PollingScheduleDay)
                    : connection.PollingScheduleDay
                : null;
            if (scheduleType == IntegrationPollingScheduleType.WeeklyAt && !scheduleDay.HasValue)
                scheduleDay = DayOfWeek.Monday;
            var normalizedValue = IntegrationPollingSchedule.NormalizeValue(
                scheduleType,
                scheduleValue,
                scheduleDay,
                connection.PollingIntervalMinutes,
                adapter.Descriptor.MinimumPollingIntervalMinutes,
                out var normalizedDay);

            connection.PollingScheduleType = scheduleType;
            connection.PollingScheduleValue = normalizedValue;
            connection.PollingScheduleDay = normalizedDay;
            if (scheduleType == IntegrationPollingScheduleType.EveryNMinutes)
                connection.PollingIntervalMinutes = int.Parse(normalizedValue, CultureInfo.InvariantCulture);
        }

        if (update.OnlyPollDuringMarketTimes.HasValue)
            connection.OnlyPollDuringMarketTimes = update.OnlyPollDuringMarketTimes.Value;

        if (update.Options is not null)
        {
            ValidateFields(adapter.Descriptor.OptionFields, update.Options, "options");
            connection.OptionsJson = JsonSerializer.Serialize(update.Options, JsonOptions);
        }

        if (update.Enabled.HasValue)
        {
            connection.Enabled = update.Enabled.Value;
            if (!connection.Enabled)
                connection.Status = IntegrationConnectionStatus.Disabled;
            else if (connection.Accounts.Any(account => RequiresAllocation(account, connection.IntegrationProvider?.Code)))
                connection.Status = IntegrationConnectionStatus.NeedsAllocation;
            else if (connection.CredentialsCiphertext.Length == 0)
                connection.Status = IntegrationConnectionStatus.NeedsCredentials;
            else
                connection.Status = IntegrationConnectionStatus.Active;
        }

        connection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        return ToResponse(connection);
    }

    public Task<IntegrationAccountResponse?> AllocateAccountAsync(
        Guid connectionId,
        Guid accountId,
        Guid assetId,
        CancellationToken cancellationToken = default) =>
        AllocateAccountAsync(
            connectionId,
            accountId,
            assetId,
            ExternalValueRole.Deployed,
            cancellationToken);

    public async Task<IntegrationAccountResponse?> AllocateAccountAsync(
        Guid connectionId,
        Guid accountId,
        Guid assetId,
        ExternalValueRole role,
        CancellationToken cancellationToken = default)
    {
        var account = await db.IntegrationAccounts
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.IntegrationProvider)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.AssetMappings)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.ExternalValues)
                        .ThenInclude(value => value.AssetMappings)
                            .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.AssetMappings)
                .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.ExternalValues)
                .ThenInclude(value => value.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .FirstOrDefaultAsync(candidate =>
                candidate.Id == accountId && candidate.IntegrationConnectionId == connectionId,
                cancellationToken);
        if (account is null)
            return null;

        var asset = await db.Assets.FindAsync([assetId], cancellationToken);
        if (asset is null)
            throw new ArgumentException("Asset not found.");
        if (asset.ArchivedAt.HasValue)
            throw new ArgumentException("Archived assets cannot receive integration values.");

        var mapping = account.AssetMappings.FirstOrDefault(candidate => candidate.Role == role);
        if (mapping is null)
        {
            mapping = new IntegrationAccountAssetMapping
            {
                IntegrationAccountId = account.Id,
                Role = role,
                AssetId = asset.Id,
                Asset = asset
            };
            db.IntegrationAccountAssetMappings.Add(mapping);
            account.AssetMappings.Add(mapping);
        }
        else
        {
            mapping.AssetId = asset.Id;
            mapping.Asset = asset;
        }

        await MapValuesToAssetAsync(account, role, asset);
        var connection = account.IntegrationConnection!;
        account.Status = IsAllocationComplete(account, ProviderCode(connection))
            ? IntegrationAccountStatus.Allocated
            : IntegrationAccountStatus.Discovered;
        UpdateConnectionStatus(connection);
        connection.Enabled = true;
        connection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        await InvalidateWealthAsync(cancellationToken);
        return ToResponse(account);
    }

    public Task<IntegrationAccountResponse?> CreateAndAllocateAccountAsync(
        Guid connectionId,
        Guid accountId,
        string displayName,
        string? entryKind,
        CancellationToken cancellationToken = default) =>
        CreateAndAllocateAccountAsync(
            connectionId,
            accountId,
            displayName,
            entryKind,
            null,
            ExternalValueRole.Deployed,
            cancellationToken);

    public async Task<IntegrationAccountResponse?> CreateAndAllocateAccountAsync(
        Guid connectionId,
        Guid accountId,
        string displayName,
        string? entryKind,
        Guid? assetKindId,
        ExternalValueRole role,
        CancellationToken cancellationToken = default)
    {
        var account = await db.IntegrationAccounts
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.IntegrationProvider)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.AssetMappings)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.ExternalValues)
                        .ThenInclude(value => value.AssetMappings)
                            .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.AssetMappings)
                .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.ExternalValues)
                .ThenInclude(value => value.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .FirstOrDefaultAsync(candidate =>
                candidate.Id == accountId && candidate.IntegrationConnectionId == connectionId,
                cancellationToken);
        if (account is null)
            return null;
        if (string.IsNullOrWhiteSpace(displayName))
            throw new ArgumentException("An asset name is required.");

        var selectedKind = assetKindId.HasValue
            ? await db.AssetKinds.FirstOrDefaultAsync(candidate =>
                candidate.Id == assetKindId.Value && candidate.ArchivedAt == null,
                cancellationToken)
            : null;
        if (assetKindId.HasValue && selectedKind is null)
            throw new ArgumentException("The selected Asset Kind is unavailable.", nameof(assetKindId));

        var kindCode = selectedKind?.Code
            ?? (entryKind?.Equals(AssetValueShape.Cash, StringComparison.OrdinalIgnoreCase) == true
                ? AssetKindCodes.Cash
                : AssetKindCodes.Investments);
        var template = new CashAssetValueEntry(
            displayName.Trim(),
            kindCode,
            0m,
            DateOnly.FromDateTime(DateTime.UtcNow),
            TimeOnly.MinValue);
        var asset = await AssetCatalogService.EnsureAssetForEntryAsync(
            db,
            template,
            displayName.Trim(),
            assetKindId.HasValue ? [assetKindId.Value] : null);

        var mapping = account.AssetMappings.FirstOrDefault(candidate => candidate.Role == role);
        if (mapping is null)
        {
            mapping = new IntegrationAccountAssetMapping
            {
                IntegrationAccountId = account.Id,
                Role = role,
                AssetId = asset.Id,
                Asset = asset
            };
            db.IntegrationAccountAssetMappings.Add(mapping);
            account.AssetMappings.Add(mapping);
        }
        else
        {
            mapping.AssetId = asset.Id;
            mapping.Asset = asset;
        }

        await MapValuesToAssetAsync(account, role, asset);
        var connection = account.IntegrationConnection!;
        account.Status = IsAllocationComplete(account, ProviderCode(connection))
            ? IntegrationAccountStatus.Allocated
            : IntegrationAccountStatus.Discovered;
        UpdateConnectionStatus(connection);
        connection.Enabled = true;
        connection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        await InvalidateCatalogueAsync(cancellationToken);
        await InvalidateWealthAsync(cancellationToken);
        return ToResponse(account);
    }

    public async Task<IntegrationAccountResponse?> ClearAccountAllocationAsync(
        Guid connectionId,
        Guid accountId,
        ExternalValueRole role,
        CancellationToken cancellationToken = default)
    {
        var account = await db.IntegrationAccounts
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.IntegrationProvider)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.AssetMappings)
            .Include(candidate => candidate.IntegrationConnection)
                .ThenInclude(connection => connection!.Accounts)
                    .ThenInclude(candidate => candidate.ExternalValues)
                        .ThenInclude(value => value.AssetMappings)
                            .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.AssetMappings)
                .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.ExternalValues)
                .ThenInclude(value => value.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .FirstOrDefaultAsync(candidate =>
                candidate.Id == accountId && candidate.IntegrationConnectionId == connectionId,
                cancellationToken);
        if (account is null)
            return null;

        var mapping = account.AssetMappings.FirstOrDefault(candidate => candidate.Role == role);
        if (mapping is not null)
        {
            db.IntegrationAccountAssetMappings.Remove(mapping);
            account.AssetMappings.Remove(mapping);
        }

        var externalValues = account.ExternalValues
            .Where(value => AllocationRoleForValue(value) == role)
            .ToList();
        var externalMappings = externalValues
            .SelectMany(value => value.AssetMappings)
            .ToList();
        if (externalMappings.Count > 0)
            db.ExternalValueAssetMappings.RemoveRange(externalMappings);

        var connection = account.IntegrationConnection!;
        account.Status = IsAllocationComplete(account, ProviderCode(connection))
            ? IntegrationAccountStatus.Allocated
            : IntegrationAccountStatus.Discovered;
        UpdateConnectionStatus(connection);
        connection.Enabled = true;
        connection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(cancellationToken);
        await InvalidateWealthAsync(cancellationToken);
        return ToResponse(account);
    }

    /// <summary>
    /// Synchronises one integration connection immediately.
    /// </summary>
    public async Task<IntegrationSyncResponse?> SyncConnectionAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default)
    {
        var syncLock = SyncLocks.GetOrAdd(connectionId, _ => new SemaphoreSlim(1, 1));
        await syncLock.WaitAsync(cancellationToken);
        try
        {
            return await SyncConnectionCoreAsync(connectionId, cancellationToken);
        }
        finally
        {
            syncLock.Release();
        }
    }

    private async Task<IntegrationSyncResponse?> SyncConnectionCoreAsync(
        Guid connectionId,
        CancellationToken cancellationToken)
    {
        var connection = await db.IntegrationConnections
            .Include(candidate => candidate.IntegrationProvider)
            .Include(candidate => candidate.Accounts)
                .ThenInclude(account => account.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .Include(candidate => candidate.Accounts)
                .ThenInclude(account => account.ExternalValues)
                    .ThenInclude(value => value.AssetMappings)
                        .ThenInclude(mapping => mapping.Asset)
            .FirstOrDefaultAsync(candidate => candidate.Id == connectionId, cancellationToken);
        if (connection is null)
            return null;

        if (connection.CredentialsCiphertext.Length == 0)
            return new IntegrationSyncResponse { Succeeded = false, Message = "Credentials are required before syncing." };

        var mappedAccounts = connection.Accounts
            .Where(account => IsAllocationComplete(account, ProviderCode(connection)) && account.Status != IntegrationAccountStatus.Missing)
            .ToList();
        if (mappedAccounts.Count == 0)
            return new IntegrationSyncResponse { Succeeded = false, Message = "At least one account must be allocated before syncing." };

        var adapter = registry.Get(connection.IntegrationProvider!.Code);
        var externalAccounts = mappedAccounts.Select(account => new ExternalAccount
        {
            ExternalId = account.ExternalId,
            DisplayName = account.DisplayName,
            AccountType = account.AccountType,
            Currency = account.Currency
        }).ToList();

        var run = new SyncRun
        {
            IntegrationConnectionId = connection.Id,
            IntegrationConnection = connection,
            ConnectionDisplayNameSnapshot = connection.DisplayName,
            StartTime = DateTimeOffset.UtcNow,
            Status = SyncRunStatus.Running
        };
        db.SyncRuns.Add(run);
        await db.SaveChangesAsync(cancellationToken);

        try
        {
            var result = await adapter.PullAsync(BuildContext(connection), externalAccounts, cancellationToken);
            var persisted = 0;
            var todayUtc = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            var historicalDataChanged = false;
            var isSnapTrade = IsSnapTradeProvider(ProviderCode(connection));
            foreach (var snapshot in result.Values)
            {
                var account = mappedAccounts.FirstOrDefault(candidate =>
                    candidate.ExternalId.Equals(snapshot.AccountExternalId, StringComparison.OrdinalIgnoreCase));
                if (account is null)
                {
                    result.Errors.Add(IntegrationSecurityMessages.UnmappedProviderValue);
                    continue;
                }

                var allocationRole = AllocationRoleForSnapshot(snapshot);
                var accountMapping = account.AssetMappings.FirstOrDefault(mapping => mapping.Role == allocationRole);
                if (accountMapping is null)
                {
                    result.Errors.Add(IntegrationSecurityMessages.MissingAssetAllocation);
                    continue;
                }

                var isCashSnapshot = snapshot.Role == ExternalValueRole.Undeployed ||
                                     IsCashSnapshot(snapshot);
                if (isCashSnapshot && !isSnapTrade)
                {
                    result.Errors.Add(IntegrationSecurityMessages.UnsupportedCashValue);
                    continue;
                }

                var externalValue = await AssetCatalogService.FindExternalValueAsync(
                    db,
                    account.Id,
                    snapshot.ExternalValueId);
                var externalMapping = externalValue is null
                    ? null
                    : await db.ExternalValueAssetMappings.FindAsync([externalValue.Id], cancellationToken);
                var mappedAssetId = externalMapping?.AssetId ?? accountMapping.AssetId;

                externalValue = await AssetCatalogService.UpsertExternalValueAsync(
                    db,
                    account,
                    snapshot.ExternalValueId,
                    snapshot.Name + (snapshot.NameSuffix ?? string.Empty),
                    snapshot.Role,
                    mappedAssetId);
                var asset = await db.Assets.FindAsync([mappedAssetId], cancellationToken);
                if (asset is null || asset.ArchivedAt.HasValue)
                {
                    result.Errors.Add(IntegrationSecurityMessages.MappedAssetUnavailable);
                    continue;
                }

                var observedAt = snapshot.ObservedAt.UtcDateTime;
                var date = DateOnly.FromDateTime(observedAt);
                var time = TimeOnly.FromDateTime(observedAt);
                historicalDataChanged |= date < todayUtc;
                var source = await db.AssetValueEntrySources
                    .Include(candidate => candidate.AssetValueEntry)
                    .FirstOrDefaultAsync(candidate =>
                        candidate.ExternalValueId == externalValue.Id &&
                        candidate.AssetValueEntry!.Date == date,
                        cancellationToken);

                // Removing a connection cascades its ExternalValue rows, but
                // deliberately retains the value entries as history. Adopt an
                // orphaned integration source for the same allocated asset and
                // day so replacing a connection updates that history instead
                // of creating a second balance for the asset.
                if (source is null)
                {
                    source = await db.AssetValueEntrySources
                        .Include(candidate => candidate.AssetValueEntry)
                        .Where(candidate =>
                            candidate.SourceKind == AssetValueEntrySourceKind.Integration &&
                            candidate.ExternalValueId == null &&
                            candidate.AssetValueEntry!.AssetId == mappedAssetId &&
                            candidate.AssetValueEntry.Date == date)
                        .OrderByDescending(candidate => candidate.AssetValueEntry!.Time)
                        .FirstOrDefaultAsync(cancellationToken);
                }

                var entry = CreateEntry(snapshot, asset, date, time);
                if (source?.AssetValueEntry is null)
                {
                    source = new AssetValueEntrySource
                    {
                        AssetValueEntry = entry,
                        ExternalValue = externalValue,
                        SyncRun = run,
                        SourceKind = AssetValueEntrySourceKind.Integration
                    };
                    entry.SourceLink = source;
                    db.AssetValueEntries.Add(entry);
                }
                else
                {
                    var existing = source.AssetValueEntry;
                    source.ExternalValueId = externalValue.Id;
                    source.ExternalValue = externalValue;
                    existing.Value = entry.Value;
                    existing.Time = entry.Time;
                    existing.Name = entry.Name;
                    existing.AssetId = entry.AssetId;
                    existing.AssetKindCode = entry.AssetKindCode;
                    source.SyncRunId = run.Id;
                    if (existing is InvestmentAssetValueEntry existingInvestment &&
                        entry is InvestmentAssetValueEntry incomingInvestment)
                    {
                        existingInvestment.InvestedCapital = incomingInvestment.InvestedCapital;
                        existingInvestment.Positions = incomingInvestment.Positions;
                    }
                }

                persisted++;
            }

            await db.SaveChangesAsync(cancellationToken);
            // A current-day snapshot cannot change an aggregate whose as-of date
            // is yesterday or earlier. Keep that historical cache warm during
            // normal polling; invalidate it only when a sync writes history.
            if (persisted > 0)
            {
                if (historicalDataChanged)
                    await InvalidateWealthAsync(cancellationToken);
                else
                    await InvalidateCurrentWealthAsync(cancellationToken);
            }
            connection.LastSyncedAt = DateTimeOffset.UtcNow;
            var safeErrors = result.Errors
                .Select(IntegrationSecurityMessages.SanitizeSyncError)
                .ToList();
            var hasErrors = safeErrors.Count > 0;
            var syncMessage = hasErrors
                ? $"{IntegrationSecurityMessages.SyncCompletedWithWarnings} {persisted} record(s) added."
                : $"{IntegrationSecurityMessages.SyncCompleted} {persisted} record(s) added.";
            connection.LastError = hasErrors ? IntegrationSecurityMessages.ConnectionOperationFailed : null;
            connection.Status = !hasErrors
                ? IntegrationConnectionStatus.Active
                : IntegrationConnectionStatus.Error;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            run.EndTime = DateTimeOffset.UtcNow;
            run.RecordsAdded = persisted;
            run.Status = !hasErrors ? SyncRunStatus.Success : SyncRunStatus.Partial;
            run.LogMessage = syncMessage;
            await db.SaveChangesAsync(cancellationToken);

            return new IntegrationSyncResponse
            {
                Succeeded = !hasErrors,
                Message = syncMessage,
                RecordsProcessed = persisted,
                Errors = safeErrors
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            connection.LastError = IntegrationSecurityMessages.SyncFailed;
            connection.Status = IntegrationConnectionStatus.Error;
            connection.UpdatedAt = DateTimeOffset.UtcNow;
            run.EndTime = DateTimeOffset.UtcNow;
            run.Status = SyncRunStatus.Failed;
            run.LogMessage = IntegrationSecurityMessages.SyncFailed;
            await db.SaveChangesAsync(cancellationToken);
            logger.LogError("Integration sync failed for provider {ProviderCode} connection {ConnectionId}.",
                connection.IntegrationProvider.Code, connection.Id);
            return new IntegrationSyncResponse
            {
                Succeeded = false,
                Message = IntegrationSecurityMessages.SyncFailed
            };
        }
    }

    public async Task<IReadOnlyList<IntegrationSyncResponse>> SyncEnabledAsync(
        bool ignoreSchedule = false,
        CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();
        var query = db.IntegrationConnections
            .AsNoTracking()
            .Where(connection => connection.Enabled &&
                                 connection.Status == IntegrationConnectionStatus.Active &&
                                 connection.SyncMode == IntegrationSyncMode.Polling);
        var connections = await query.ToListAsync(cancellationToken);
        var marketHours = !ignoreSchedule && connections.Any(connection => connection.OnlyPollDuringMarketTimes)
            ? await integrationSettings.GetMarketHoursAsync(cancellationToken)
            : null;
        var marketOpen = marketHours is not null && MarketHoursPolicy.IsWithinMarketHours(now, marketHours);
        var ids = connections
            .Where(connection => ignoreSchedule ||
                                 (IntegrationPollingSchedule.IsDue(connection, now) &&
                                  (!connection.OnlyPollDuringMarketTimes ||
                                   marketOpen)))
            .Select(connection => connection.Id)
            .ToList();
        var results = new List<IntegrationSyncResponse>();
        foreach (var id in ids)
        {
            var result = await SyncConnectionAsync(id, cancellationToken);
            if (result is not null)
                results.Add(result);
        }

        return results;
    }

    /// <summary>
    /// Retains the existing explicit-sync API while routing all work through the
    /// single-connection synchronization method used by polling and webhooks.
    /// </summary>
    public Task<IntegrationSyncResponse?> SyncAsync(
        Guid connectionId,
        CancellationToken cancellationToken = default) =>
        SyncConnectionAsync(connectionId, cancellationToken);

    private static bool TryParseSyncMode(string value, out IntegrationSyncMode mode)
    {
        if (Enum.TryParse(value, ignoreCase: true, out mode) &&
            Enum.IsDefined(mode))
            return true;

        if (int.TryParse(value, out var numeric) &&
            Enum.IsDefined(typeof(IntegrationSyncMode), numeric))
        {
            mode = (IntegrationSyncMode)numeric;
            return true;
        }

        mode = default;
        return false;
    }

    private static bool TryParsePollingScheduleType(
        string? value,
        out IntegrationPollingScheduleType scheduleType)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            scheduleType = IntegrationPollingScheduleType.EveryNMinutes;
            return false;
        }

        if (Enum.TryParse(value, ignoreCase: true, out scheduleType) &&
            Enum.IsDefined(scheduleType))
            return true;

        if (value.Equals("Interval", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("Every", StringComparison.OrdinalIgnoreCase))
        {
            scheduleType = IntegrationPollingScheduleType.EveryNMinutes;
            return true;
        }

        scheduleType = default;
        return false;
    }

    private static DayOfWeek ParsePollingScheduleDay(string value)
    {
        if (Enum.TryParse<DayOfWeek>(value, ignoreCase: true, out var day) &&
            Enum.IsDefined(day))
            return day;

        throw new ArgumentException("Weekly polling schedule day must be a valid weekday.");
    }

    private static string DefaultPollingScheduleValue(IntegrationPollingScheduleType scheduleType) =>
        scheduleType switch
        {
            IntegrationPollingScheduleType.Cron => "0 * * * *",
            IntegrationPollingScheduleType.HourlyAt => "0",
            IntegrationPollingScheduleType.HourlyOnTheHour => string.Empty,
            IntegrationPollingScheduleType.DailyAt => "08:00",
            IntegrationPollingScheduleType.WeeklyAt => "08:00",
            _ => string.Empty
        };

    private async Task<IntegrationConnection?> LoadConnectionAsync(
        Guid connectionId,
        CancellationToken cancellationToken)
    {
        return await db.IntegrationConnections
            .Include(connection => connection.IntegrationProvider)
            .Include(connection => connection.Accounts)
                .ThenInclude(account => account.AssetMappings)
                    .ThenInclude(mapping => mapping.Asset)
            .Include(connection => connection.Accounts)
                .ThenInclude(account => account.ExternalValues)
                    .ThenInclude(value => value.AssetMappings)
                        .ThenInclude(mapping => mapping.Asset)
            .FirstOrDefaultAsync(candidate => candidate.Id == connectionId, cancellationToken);
    }

    private IntegrationContext BuildContext(IntegrationConnection connection)
    {
        var options = JsonSerializer.Deserialize<JsonElement>(
            string.IsNullOrWhiteSpace(connection.OptionsJson) ? "{}" : connection.OptionsJson);
        return new IntegrationContext
        {
            ProviderKey = connection.IntegrationProvider!.Code,
            ConnectionId = connection.Id,
            DisplayName = connection.DisplayName,
            Credentials = credentialProtector.Unprotect(connection.CredentialsCiphertext),
            Options = options
        };
    }

    private static AssetValueEntry CreateEntry(
        ExternalValueSnapshot snapshot,
        Asset asset,
        DateOnly date,
        TimeOnly time)
    {
        var kindCode = AssetCatalogService.NormalizeAssetKindCode(snapshot.Type);
        var suffix = snapshot.NameSuffix ?? string.Empty;
        var entryName = suffix.Length > 0 && asset.DisplayName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
            ? asset.DisplayName
            : $"{asset.DisplayName}{suffix}";
        AssetValueEntry entry = AssetCatalogService.ValueShapeForKind(kindCode) == AssetValueShape.Investment
            ? new InvestmentAssetValueEntry(entryName, kindCode, snapshot.Value, snapshot.InvestedCapital, date, time, "Integration")
            : new CashAssetValueEntry(entryName, kindCode, snapshot.Value, date, time, "Integration");

        entry.AssetId = asset.Id;
        entry.AssetKindCode = kindCode;
        if (entry is InvestmentAssetValueEntry investment)
        {
            investment.Positions = snapshot.Positions.Select(position => new PortfolioPosition
            {
                Ticker = position.Ticker,
                Name = position.Name,
                Quantity = position.Quantity,
                AveragePrice = position.AveragePrice,
                CurrentPrice = position.CurrentPrice,
                CurrentValue = position.CurrentValue
            }).ToList();
        }

        return entry;
    }

    private static void ValidateFields(
        IReadOnlyList<IntegrationFieldDescriptor> fields,
        IReadOnlyDictionary<string, string> values,
        string noun)
    {
        foreach (var field in fields.Where(field => field.Required))
        {
            if (!values.TryGetValue(field.Key, out var value) || string.IsNullOrWhiteSpace(value))
                throw new ArgumentException($"{field.Label} is required for {noun}.");
        }
    }

    private static IntegrationConnectionResponse ToResponse(IntegrationConnection connection) => new()
    {
        Id = connection.Id,
        ProviderKey = connection.IntegrationProvider?.Code ?? string.Empty,
        IntegrationKind = connection.Kind,
        DisplayName = connection.DisplayName,
        Enabled = connection.Enabled,
        Status = connection.Status.ToString(),
        SyncMode = connection.SyncMode.ToString(),
        PollingIntervalMinutes = connection.PollingIntervalMinutes,
        PollingScheduleType = connection.PollingScheduleType.ToString(),
        PollingScheduleValue = connection.PollingScheduleType == IntegrationPollingScheduleType.EveryNMinutes
            ? connection.PollingIntervalMinutes.ToString(CultureInfo.InvariantCulture)
            : connection.PollingScheduleValue,
        PollingScheduleDay = connection.PollingScheduleDay?.ToString(),
        OnlyPollDuringMarketTimes = connection.OnlyPollDuringMarketTimes,
        LastTestedAt = connection.LastTestedAt,
        LastSyncedAt = connection.LastSyncedAt,
        LastError = string.IsNullOrWhiteSpace(connection.LastError)
            ? null
            : IntegrationSecurityMessages.ConnectionOperationFailed,
        HasCredentials = !string.IsNullOrWhiteSpace(connection.CredentialsCiphertext),
        Options = ParseOptions(connection.OptionsJson),
        Accounts = connection.Accounts.Select(ToResponse).ToList()
    };

    private static Dictionary<string, string> ParseOptions(string optionsJson)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(optionsJson, JsonOptions)
                   ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static IntegrationAccountResponse ToResponse(IntegrationAccount account)
    {
        var allocations = account.AssetMappings
            .OrderBy(mapping => mapping.Role)
            .Select(mapping => new IntegrationAssetAllocationResponse
            {
                Role = mapping.Role.ToString(),
                AssetId = mapping.AssetId,
                AssetDisplayName = mapping.Asset?.DisplayName ?? string.Empty
            })
            .ToList();
        var mapping = allocations.FirstOrDefault(allocation => allocation.Role == ExternalValueRole.Deployed.ToString())
                      ?? allocations.FirstOrDefault();
        return new IntegrationAccountResponse
        {
            Id = account.Id,
            ExternalId = account.ExternalId,
            DisplayName = account.DisplayName,
            AccountType = account.AccountType,
            Currency = account.Currency,
            AssetId = mapping?.AssetId,
            AssetDisplayName = mapping?.AssetDisplayName ?? string.Empty,
            AssetAllocations = allocations,
            Status = account.Status.ToString(),
            LastSeenAt = account.LastSeenAt
        };
    }

    private static string ProviderCode(IntegrationConnection? connection) =>
        connection?.IntegrationProvider?.Code ?? string.Empty;

    private static bool IsSnapTradeProvider(string? providerKey) =>
        string.Equals(providerKey, SnaptradeIntegrationAdapter.ProviderKey, StringComparison.OrdinalIgnoreCase);

    private static bool IsCashSnapshot(ExternalValueSnapshot snapshot) =>
        snapshot.Role == ExternalValueRole.Undeployed ||
        AssetCatalogService.NormalizeAssetKindCode(snapshot.Type) == AssetKindCodes.Cash;

    private static ExternalValueRole AllocationRoleForSnapshot(ExternalValueSnapshot snapshot) =>
        snapshot.Role == ExternalValueRole.Undeployed
            ? ExternalValueRole.Undeployed
            : ExternalValueRole.Deployed;

    private static bool IsAllocationComplete(IntegrationAccount account, string? providerKey = null)
    {
        var hasDeployedAllocation = account.AssetMappings.Any(mapping => mapping.Role == ExternalValueRole.Deployed);
        if (!IsSnapTradeProvider(providerKey ?? account.IntegrationConnection?.IntegrationProvider?.Code))
            return hasDeployedAllocation || account.AssetMappings.Any();

        return hasDeployedAllocation &&
               account.AssetMappings.Any(mapping => mapping.Role == ExternalValueRole.Undeployed);
    }

    private static bool RequiresAllocation(IntegrationAccount account, string? providerKey = null) =>
        account.Status != IntegrationAccountStatus.Missing && !IsAllocationComplete(account, providerKey);

    private static void UpdateConnectionStatus(IntegrationConnection connection)
    {
        connection.Status = connection.Accounts.Any(account =>
                RequiresAllocation(account, ProviderCode(connection)))
            ? IntegrationConnectionStatus.NeedsAllocation
            : IntegrationConnectionStatus.Active;
    }

    private async Task MapValuesToAssetAsync(
        IntegrationAccount account,
        ExternalValueRole role,
        Asset asset)
    {
        var externalValues = account.ExternalValues
            .Where(value => AllocationRoleForValue(value) == role)
            .ToList();
        foreach (var value in externalValues)
        {
            var mapping = value.AssetMappings.FirstOrDefault();
            if (mapping is null)
            {
                db.ExternalValueAssetMappings.Add(new ExternalValueAssetMapping
                {
                    ExternalValueId = value.Id,
                    AssetId = asset.Id,
                    ExternalValue = value
                });
            }
            else
            {
                mapping.AssetId = asset.Id;
            }
        }

        var externalValueIds = externalValues.Select(value => value.Id).ToArray();
        if (externalValueIds.Length == 0) return;

        var sources = await db.AssetValueEntrySources
            .Include(source => source.AssetValueEntry)
            .Where(source => source.ExternalValueId.HasValue &&
                             externalValueIds.Contains(source.ExternalValueId.Value))
            .ToListAsync();
        foreach (var source in sources)
        {
            if (source.AssetValueEntry is null) continue;
            source.AssetValueEntry.AssetId = asset.Id;
            source.AssetValueEntry.Name = asset.DisplayName;
        }
    }

    private static ExternalValueRole AllocationRoleForValue(ExternalValue value) =>
        value.Role == ExternalValueRole.Undeployed ||
        value.ExternalId.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) ||
        value.DisplayName.EndsWith("(undeployed)", StringComparison.OrdinalIgnoreCase)
            ? ExternalValueRole.Undeployed
            : ExternalValueRole.Deployed;

    private Task InvalidateWealthAsync(CancellationToken cancellationToken) =>
        invalidator?.InvalidateWealthAsync(cancellationToken) ?? Task.CompletedTask;

    private Task InvalidateCurrentWealthAsync(CancellationToken cancellationToken) =>
        invalidator?.InvalidateCurrentWealthAsync(cancellationToken) ?? Task.CompletedTask;

    private Task InvalidateCatalogueAsync(CancellationToken cancellationToken) =>
        invalidator?.InvalidateCatalogueAsync(cancellationToken) ?? Task.CompletedTask;
}

public sealed class IntegrationConnectionUpdate
{
    public string? DisplayName { get; init; }
    public bool? Enabled { get; init; }
    public string? SyncMode { get; init; }
    public int? PollingIntervalMinutes { get; init; }
    public string? PollingScheduleType { get; init; }
    public string? PollingScheduleValue { get; init; }
    public string? PollingScheduleDay { get; init; }
    public bool? OnlyPollDuringMarketTimes { get; init; }
    public Dictionary<string, string>? Options { get; init; }
}

public sealed class IntegrationConnectionResponse
{
    public Guid Id { get; init; }
    public string ProviderKey { get; init; } = string.Empty;
    public IntegrationKind IntegrationKind { get; init; }
    public string DisplayName { get; init; } = string.Empty;
    public bool Enabled { get; init; }
    public string Status { get; init; } = string.Empty;
    public string SyncMode { get; init; } = nameof(IntegrationSyncMode.Polling);
    public int PollingIntervalMinutes { get; init; }
    public string PollingScheduleType { get; init; } = nameof(IntegrationPollingScheduleType.EveryNMinutes);
    public string PollingScheduleValue { get; init; } = string.Empty;
    public string? PollingScheduleDay { get; init; }
    public bool OnlyPollDuringMarketTimes { get; init; }
    public bool HasCredentials { get; init; }
    public DateTimeOffset? LastTestedAt { get; init; }
    public DateTimeOffset? LastSyncedAt { get; init; }
    public string? LastError { get; init; }
    public Dictionary<string, string> Options { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public IReadOnlyList<IntegrationAccountResponse> Accounts { get; init; } = [];
}

public sealed class IntegrationAccountResponse
{
    public Guid Id { get; init; }
    public string ExternalId { get; init; } = string.Empty;
    public string DisplayName { get; init; } = string.Empty;
    public string AccountType { get; init; } = string.Empty;
    public string Currency { get; init; } = string.Empty;
    public Guid? AssetId { get; init; }
    public string AssetDisplayName { get; init; } = string.Empty;
    public IReadOnlyList<IntegrationAssetAllocationResponse> AssetAllocations { get; init; } = [];
    public string Status { get; init; } = string.Empty;
    public DateTimeOffset LastSeenAt { get; init; }
}

public sealed class IntegrationAssetAllocationResponse
{
    public string Role { get; init; } = string.Empty;
    public Guid AssetId { get; init; }
    public string AssetDisplayName { get; init; } = string.Empty;
}

public sealed class IntegrationOperationResponse
{
    public bool Succeeded { get; init; }
    public string Message { get; init; } = string.Empty;
    public IReadOnlyList<ExternalAccount> Accounts { get; init; } = [];
}

public sealed class IntegrationSyncResponse
{
    public bool Succeeded { get; init; }
    public string Message { get; init; } = string.Empty;
    public int RecordsProcessed { get; init; }
    public IReadOnlyList<string> Errors { get; init; } = [];
}
