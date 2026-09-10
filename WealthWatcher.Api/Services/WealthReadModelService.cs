using Microsoft.EntityFrameworkCore;
using WealthWatcher.Api.Data;
using WealthWatcher.Api.Models;

namespace WealthWatcher.Api.Services;

/// <summary>
/// Builds the daily wealth read model used by the BFF endpoints. The legacy
/// category aggregate endpoint remains available for compatibility, while new
/// page endpoints can load and calculate all categories from one database
/// read.
/// </summary>
public sealed class WealthReadModelService(
    WealthDbContext db,
    TimeProvider timeProvider)
{
    public async Task<IReadOnlyList<WealthCategoryAggregate>> GetAggregatesAsync(
        string? period,
        DateOnly? asOfDate,
        CancellationToken cancellationToken = default)
    {
        var kinds = await db.AssetKinds
            .AsNoTracking()
            .Include(kind => kind.GroupMappings)
                .ThenInclude(mapping => mapping.AssetGroup)
            .Where(kind => kind.ArchivedAt == null)
            .OrderBy(kind => kind.DisplayOrder)
            .ThenBy(kind => kind.DisplayName)
            .ToListAsync(cancellationToken);

        var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
        var effectiveNowUtc = asOfDate?.ToDateTime(TimeOnly.MaxValue) ?? nowUtc;
        var providerCodes = (await db.IntegrationProviders
                .AsNoTracking()
                .Select(provider => provider.Code)
                .ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var entries = await LoadEntriesAsync(effectiveNowUtc, cancellationToken);
        var entriesByKind = new Dictionary<Guid, List<AssetValueEntry>>();
        foreach (var entry in entries)
        {
            foreach (var kindId in GetCategoryIds(entry))
            {
                if (!entriesByKind.TryGetValue(kindId, out var categoryEntries))
                {
                    categoryEntries = new List<AssetValueEntry>();
                    entriesByKind[kindId] = categoryEntries;
                }

                categoryEntries.Add(entry);
            }
        }

        return kinds
            .Select(kind =>
            {
                var categoryEntries = entriesByKind.TryGetValue(kind.Id, out var entriesForKind)
                    ? entriesForKind
                    : [];
                return new WealthCategoryAggregate
                {
                    Category = kind.Code,
                    Label = kind.DisplayName,
                    Color = kind.Color,
                    DisplayOrder = kind.DisplayOrder,
                    AssetGroupId = kind.GroupMappings.FirstOrDefault()?.AssetGroupId,
                    AssetGroupCode = kind.GroupMappings.FirstOrDefault()?.AssetGroup?.Code,
                    ClassificationValueId = kind.Id,
                    Response = BuildAggregate(
                        kind,
                        categoryEntries,
                        period,
                        effectiveNowUtc,
                        providerCodes)
                };
            })
            .ToList();
    }

    private async Task<List<AssetValueEntry>> LoadEntriesAsync(
        DateTime effectiveNowUtc,
        CancellationToken cancellationToken)
    {
        var effectiveDate = DateOnly.FromDateTime(effectiveNowUtc);
        var effectiveTime = TimeOnly.FromDateTime(effectiveNowUtc);
        var entries = await db.AssetValueEntries
            .AsNoTracking()
            .AsSplitQuery()
            .Include(entry => entry.Asset)
                .ThenInclude(asset => asset!.AssetKindAssignments)
                    .ThenInclude(assignment => assignment.AssetKind)
            .Include(entry => entry.SourceLink)
                .ThenInclude(source => source!.ExternalValue)
                    .ThenInclude(value => value!.IntegrationAccount)
                    .ThenInclude(account => account!.IntegrationConnection)
                        .ThenInclude(connection => connection!.IntegrationProvider)
            .Include(entry => entry.SourceLink)
                .ThenInclude(source => source!.ExternalValue)
                    .ThenInclude(value => value!.IntegrationAccount)
                        .ThenInclude(account => account!.AssetMappings)
                            .ThenInclude(mapping => mapping.Asset)
                                .ThenInclude(asset => asset!.AssetKindAssignments)
                                    .ThenInclude(assignment => assignment.AssetKind)
            .Include(entry => entry.SourceLink)
                .ThenInclude(source => source!.ExternalValue)
                    .ThenInclude(value => value!.AssetMappings)
                        .ThenInclude(mapping => mapping.Asset)
                            .ThenInclude(asset => asset!.AssetKindAssignments)
                                .ThenInclude(assignment => assignment.AssetKind)
            .Where(entry => entry.Date < effectiveDate ||
                            entry.Date == effectiveDate && entry.Time <= effectiveTime)
            .OrderBy(entry => entry.Date)
            .ThenBy(entry => entry.Time)
            .ToListAsync(cancellationToken);

        foreach (var entry in entries)
        {
            var externalValue = entry.SourceLink?.ExternalValue;
            var role = IsUndeployed(externalValue)
                ? ExternalValueRole.Undeployed
                : ExternalValueRole.Deployed;
            var accountMapping = externalValue?.IntegrationAccount?.AssetMappings
                .FirstOrDefault(mapping => mapping.Role == role)?.Asset;
            var externalMapping = externalValue?.AssetMappings.FirstOrDefault()?.Asset;
            var currentAsset = accountMapping ?? externalMapping;
            if (currentAsset is not null)
            {
                entry.AssetId = currentAsset.Id;
                entry.Asset = currentAsset;
            }

            entry.AssetKindCode = entry.Asset?.AssetKindAssignments.FirstOrDefault()?.AssetKind?.Code
                                  ?? entry.AssetKindCode;
        }

        return entries;
    }

    private static IEnumerable<Guid> GetCategoryIds(AssetValueEntry entry)
    {
        var ids = new HashSet<Guid>();
        AddAssetKindIds(entry.Asset, ids);

        var externalValue = entry.SourceLink?.ExternalValue;
        if (externalValue?.IntegrationAccount?.AssetMappings is not null)
        {
            foreach (var mapping in externalValue.IntegrationAccount.AssetMappings)
                AddAssetKindIds(mapping.Asset, ids);
        }

        if (externalValue?.AssetMappings is not null)
        {
            foreach (var mapping in externalValue.AssetMappings)
                AddAssetKindIds(mapping.Asset, ids);
        }

        return ids;
    }

    private static void AddAssetKindIds(Asset? asset, ISet<Guid> ids)
    {
        if (asset?.AssetKindAssignments is null) return;
        foreach (var assignment in asset.AssetKindAssignments)
            ids.Add(assignment.AssetKindId);
    }

    private static WealthAggregateResponse BuildAggregate(
        AssetKind categoryKind,
        IReadOnlyList<AssetValueEntry> allEntries,
        string? period,
        DateTime effectiveNowUtc,
        IReadOnlySet<string> configuredProviderCodes)
    {
        if (allEntries.Count == 0)
            return new WealthAggregateResponse();

        var isPropertyCategory = categoryKind.Code.Equals(AssetKindCodes.Property, StringComparison.OrdinalIgnoreCase);
        var lastVisibleEntry = allEntries.LastOrDefault(entry => EntryTimestampUtc(entry) <= effectiveNowUtc)
                               ?? allEntries.Last();
        var lastSync = new DateTimeOffset(EntryTimestampUtc(lastVisibleEntry), TimeSpan.Zero);
        var runningBalances = new Dictionary<string, decimal>();
        var runningBalanceNames = new Dictionary<string, string>();
        var runningBalanceIsIntegration = new Dictionary<string, bool>();
        var runningInvested = new Dictionary<string, decimal>();
        var runningPropertyValues = new Dictionary<string, decimal>();

        bool IsIntegrationEntry(AssetValueEntry entry)
        {
            var providerCode = entry.SourceLink?.ExternalValue?.IntegrationAccount?.IntegrationConnection
                ?.IntegrationProvider?.Code;
            return (entry.SourceLink?.SourceKind == AssetValueEntrySourceKind.Integration &&
                    (string.IsNullOrWhiteSpace(providerCode) || configuredProviderCodes.Contains(providerCode))) ||
                   (!string.IsNullOrWhiteSpace(entry.ProviderKey) &&
                    configuredProviderCodes.Contains(entry.ProviderKey));
        }

        string EntryIdentity(AssetValueEntry entry)
        {
            if (entry.AssetId == Guid.Empty)
                return $"entry:{entry.Id}";
            var externalId = entry.SourceLink?.ExternalValueId;
            if (externalId.HasValue)
                return $"{entry.AssetId:D}:{externalId.Value:D}";
            return entry.AssetId.ToString("D");
        }

        var archiveEvents = allEntries
            .Where(entry => entry.Asset?.ArchivedAt is not null)
            .Select(entry => (Timestamp: entry.Asset!.ArchivedAt!.Value.UtcDateTime, Key: EntryIdentity(entry)))
            .OrderBy(item => item.Timestamp)
            .ToArray();
        var nextArchiveEvent = 0;

        string EntryName(AssetValueEntry entry)
        {
            var name = entry.Asset?.DisplayName ?? entry.Name;
            return IsUndeployed(entry.SourceLink?.ExternalValue) &&
                   !name.EndsWith("(undeployed)", StringComparison.OrdinalIgnoreCase)
                ? $"{name} (undeployed)"
                : name;
        }

        void RemoveRunningBalance(string key)
        {
            runningBalances.Remove(key);
            runningBalanceNames.Remove(key);
            runningBalanceIsIntegration.Remove(key);
            runningInvested.Remove(key);
            runningPropertyValues.Remove(key);
        }

        bool HasIntegrationBalance(string name) => runningBalanceNames.Any(pair =>
            pair.Value.Equals(name, StringComparison.OrdinalIgnoreCase) &&
            runningBalanceIsIntegration.TryGetValue(pair.Key, out var integration) && integration);

        void SetRunningBalance(AssetValueEntry entry)
        {
            if (entry.Asset?.ArchivedAt is { } archivedAt && EntryTimestampUtc(entry) >= archivedAt.UtcDateTime)
                return;

            var key = EntryIdentity(entry);
            var name = EntryName(entry);
            var isIntegration = IsIntegrationEntry(entry);
            if (isIntegration)
            {
                var manualKeys = runningBalanceNames
                    .Where(pair => pair.Value.Equals(name, StringComparison.OrdinalIgnoreCase) &&
                        (!runningBalanceIsIntegration.TryGetValue(pair.Key, out var current) || !current))
                    .Select(pair => pair.Key)
                    .ToList();
                foreach (var manualKey in manualKeys)
                    RemoveRunningBalance(manualKey);
            }
            else if (HasIntegrationBalance(name))
            {
                return;
            }

            var value = entry.Value;
            if (isPropertyCategory && entry is PropertyAssetValueEntry property)
            {
                runningPropertyValues[key] = entry.Value;
                value -= property.Mortgage ?? 0m;
            }
            runningBalances[key] = value;
            runningBalanceNames[key] = name;
            runningBalanceIsIntegration[key] = isIntegration;
        }

        void RemoveArchivedBalances(DateTime timestamp)
        {
            while (nextArchiveEvent < archiveEvents.Length &&
                   archiveEvents[nextArchiveEvent].Timestamp <= timestamp)
            {
                RemoveRunningBalance(archiveEvents[nextArchiveEvent].Key);
                nextArchiveEvent++;
            }
        }

        Dictionary<string, decimal> BuildBreakdown() => runningBalances
            .GroupBy(pair => runningBalanceNames.TryGetValue(pair.Key, out var name) ? name : pair.Key)
            .ToDictionary(group => group.Key, group => group.Sum(pair => pair.Value));

        Dictionary<string, decimal>? BuildPropertyValues() => !isPropertyCategory
            ? null
            : runningPropertyValues
                .GroupBy(pair => runningBalanceNames.TryGetValue(pair.Key, out var name) ? name : pair.Key)
                .ToDictionary(group => group.Key, group => group.Sum(pair => pair.Value));

        var cutoff = ResolveCutoff(period, effectiveNowUtc, allEntries);
        var resultData = new List<WealthAggregatePoint>();
        var cutoffDate = DateOnly.FromDateTime(cutoff);
        var todayDate = DateOnly.FromDateTime(effectiveNowUtc);
        foreach (var entry in allEntries.Where(entry => entry.Date < cutoffDate))
            RecordEntry(entry, SetRunningBalance, runningInvested, EntryIdentity);
        RemoveArchivedBalances(cutoff);

        var entriesFromCutoff = allEntries
            .Where(entry => entry.Date >= cutoffDate &&
                            (entry.Date < todayDate || EntryTimestampUtc(entry) <= effectiveNowUtc))
            .GroupBy(entry => entry.Date)
            .ToDictionary(group => group.Key, group => group.ToList());
        for (var currentDate = cutoffDate; currentDate <= todayDate; currentDate = currentDate.AddDays(1))
        {
            RemoveArchivedBalances(currentDate.ToDateTime(TimeOnly.MinValue));
            var hasObservation = entriesFromCutoff.TryGetValue(currentDate, out var dayEntries);
            if (dayEntries is not null)
                foreach (var entry in dayEntries)
                    RecordEntry(entry, SetRunningBalance, runningInvested, EntryIdentity);
            RemoveArchivedBalances(currentDate.ToDateTime(TimeOnly.MaxValue));
            resultData.Add(new WealthAggregatePoint
            {
                Time = currentDate.ToString("yyyy-MM-dd"),
                Value = runningBalances.Values.Sum(),
                GrossValue = isPropertyCategory ? runningPropertyValues.Values.Sum() : null,
                Equity = isPropertyCategory ? runningBalances.Values.Sum() : null,
                PropertyValues = BuildPropertyValues(),
                Invested = runningInvested.Values.Sum(),
                HasObservation = hasObservation,
                Breakdown = BuildBreakdown()
            });
        }

        PropertyAggregateDetails? propertyDetails = null;
        if (isPropertyCategory)
        {
            var latestProperties = allEntries
                .Where(entry => entry.DateTime <= effectiveNowUtc && entry is PropertyAssetValueEntry)
                .GroupBy(EntryIdentity)
                .Select(group => group.Last())
                .Where(entry => entry.Asset?.ArchivedAt is null)
                .Select(entry =>
                {
                    var property = (PropertyAssetValueEntry)entry;
                    var mortgage = property.Mortgage ?? 0m;
                    return new PropertyAggregateItem
                    {
                        Id = entry.AssetId,
                        Name = entry.Asset?.DisplayName ?? entry.Name,
                        Value = entry.Value,
                        Mortgage = mortgage,
                        Equity = entry.Value - mortgage
                    };
                })
                .ToList();
            var value = latestProperties.Sum(property => property.Value);
            var mortgageTotal = latestProperties.Sum(property => property.Mortgage);
            propertyDetails = new PropertyAggregateDetails
            {
                Properties = latestProperties,
                Totals = new PropertyAggregateTotals
                {
                    Value = value,
                    Mortgage = mortgageTotal,
                    Equity = value - mortgageTotal
                }
            };
        }

        Dictionary<string, List<PortfolioPosition>>? investmentDetails = null;
        if (categoryKind.Code.Equals(AssetKindCodes.Investments, StringComparison.OrdinalIgnoreCase))
        {
            var positions = allEntries
                .Where(entry => entry.DateTime <= effectiveNowUtc && entry is InvestmentAssetValueEntry)
                .GroupBy(EntryIdentity)
                .Select(group => group.Last())
                .OfType<InvestmentAssetValueEntry>()
                .Where(entry => entry.Positions.Count > 0)
                .ToDictionary(entry => IsUndeployed(entry.SourceLink?.ExternalValue)
                        ? $"{entry.Asset?.DisplayName ?? entry.Name} (undeployed)"
                        : entry.Asset?.DisplayName ?? entry.Name,
                    entry => entry.Positions.OrderByDescending(position => position.CurrentValue).ToList());
            if (positions.Count > 0)
                investmentDetails = positions;
        }

        return new WealthAggregateResponse
        {
            Data = resultData,
            LastSyncDateTime = lastSync,
            IsManual = allEntries.All(entry => !IsIntegrationEntry(entry)),
            LatestBreakdown = BuildBreakdown(),
            PropertyDetails = propertyDetails,
            InvestmentDetails = investmentDetails
        };
    }

    private static DateTime ResolveCutoff(
        string? period,
        DateTime nowUtc,
        IReadOnlyList<AssetValueEntry> entries)
    {
        if (!string.IsNullOrWhiteSpace(period) &&
            !period.Equals("MAX", StringComparison.OrdinalIgnoreCase) &&
            !period.Equals("ALL", StringComparison.OrdinalIgnoreCase))
        {
            if (period.Equals("YTD", StringComparison.OrdinalIgnoreCase))
                return new DateTime(nowUtc.Year, 1, 1);
            var days = period.ToUpperInvariant() switch
            {
                "1D" => 1,
                "1W" => 7,
                "1M" => 30,
                "3M" => 90,
                "1Y" => 365,
                _ => 30
            };
            return nowUtc.Date.AddDays(-days);
        }
        return entries.Count > 0 ? entries[0].Date.ToDateTime(TimeOnly.MinValue) : nowUtc.Date;
    }

    private static void RecordEntry(
        AssetValueEntry entry,
        Action<AssetValueEntry> setBalance,
        IDictionary<string, decimal> invested,
        Func<AssetValueEntry, string> identity)
    {
        setBalance(entry);
        if (entry is InvestmentAssetValueEntry investment && investment.InvestedCapital.HasValue)
            invested[identity(entry)] = investment.InvestedCapital.Value;
    }

    private static DateTime EntryTimestampUtc(AssetValueEntry entry) =>
        DateTime.SpecifyKind(entry.Date.ToDateTime(entry.Time), DateTimeKind.Utc);

    private static bool IsUndeployed(ExternalValue? value) =>
        value?.Role == ExternalValueRole.Undeployed ||
        value?.ExternalId.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) == true ||
        value?.DisplayName.EndsWith("(undeployed)", StringComparison.OrdinalIgnoreCase) == true;
}

public sealed class WealthCategoryAggregate
{
    public string Category { get; init; } = string.Empty;
    public string Label { get; init; } = string.Empty;
    public string Color { get; init; } = string.Empty;
    public int DisplayOrder { get; init; }
    public Guid? AssetGroupId { get; init; }
    public string? AssetGroupCode { get; init; }
    public Guid ClassificationValueId { get; init; }
    public WealthAggregateResponse Response { get; init; } = new();
}
