using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using WealthWatcher.Api.Caching;
using WealthWatcher.Api.Data;
using WealthWatcher.Api.Integrations;
using WealthWatcher.Api.Models;
using WealthWatcher.Api.Services;

namespace WealthWatcher.Api.Extensions;

public static class EndpointExtensions
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static WebApplication MapWealthEndpoints(this WebApplication app)
    {
        app.MapAssetEndpoints();

        app.MapGet("/api/categories", async (WealthDbContext db) =>
        {
            AssetCatalogService.EnsureDefaults(db);
            var kinds = await db.AssetKinds
                .AsNoTracking()
                .Include(kind => kind.GroupMappings)
                    .ThenInclude(mapping => mapping.AssetGroup)
                .Where(kind => kind.ArchivedAt == null)
                .OrderBy(kind => kind.DisplayOrder)
                .ThenBy(kind => kind.DisplayName)
                .ToListAsync();

            return Results.Ok(kinds.Select(kind =>
            {
                var group = kind.GroupMappings.FirstOrDefault()?.AssetGroup;
                return new
                {
                    Id = kind.Code,
                    Label = kind.DisplayName,
                    kind.Color,
                    kind.DisplayOrder,
                    ClassificationValueId = kind.Id,
                    GroupKey = AssetClassificationKeys.Assets,
                    AssetGroupId = group?.Id,
                    AssetGroupCode = group?.Code,
                    AssetGroupName = group?.DisplayName,
                    AssetGroupClassificationKey = AssetClassificationKeys.AssetClasses
                };
            }));
        });

        app.MapGet("/api/wealth/{category}/names", async (string category, WealthDbContext db) =>
        {
            AssetCatalogService.EnsureDefaults(db);
            var kind = await db.AssetKinds.FirstOrDefaultAsync(candidate =>
                candidate.ArchivedAt == null &&
                candidate.Code.ToLower() == category.Trim().ToLower());
            if (kind is null)
                return Results.Ok(Array.Empty<object>());

            var assets = await db.Assets
                .AsNoTracking()
                .Where(asset => asset.ArchivedAt == null &&
                    asset.AssetKindAssignments.Any(assignment => assignment.AssetKindId == kind.Id))
                .OrderBy(asset => asset.DisplayName)
                .Select(asset => new
                {
                    asset.Id,
                    Name = asset.DisplayName,
                    asset.DisplayName,
                    AssetKindCode = kind.Code
                })
                .ToListAsync();
            return Results.Ok(assets);
        });

        app.MapPost("/api/properties", async (
            PropertyCreateDto dto,
            WealthDbContext db,
            TimeProvider timeProvider,
            IWealthCacheInvalidator invalidator,
            CancellationToken cancellationToken) =>
        {
            var name = dto.Name.Trim();
            if (string.IsNullOrWhiteSpace(name))
                return Results.BadRequest(new { Error = "A property name is required." });
            var validationError = ValidatePropertyValues(dto.Value, dto.Mortgage);
            if (validationError is not null)
                return Results.BadRequest(new { Error = validationError });

            AssetCatalogService.EnsureDefaults(db);
            var propertyExists = await db.Assets.AnyAsync(asset =>
                asset.ArchivedAt == null &&
                asset.DisplayName.ToLower() == name.ToLower() &&
                asset.AssetKindAssignments.Any(assignment => assignment.AssetKind!.Code == AssetKindCodes.Property));
            if (propertyExists)
                return Results.Conflict(new { Error = "An active property with this name already exists." });

            var now = timeProvider.GetUtcNow().UtcDateTime;
            var entryDate = dto.Date == default ? DateOnly.FromDateTime(now) : dto.Date;
            var asset = new Asset { DisplayName = name };
            db.Assets.Add(asset);
            await AssetCatalogService.EnsurePropertyAssetAsync(db, asset);
            var entry = new PropertyAssetValueEntry(
                name,
                AssetKindCodes.Property,
                dto.Value,
                dto.Mortgage,
                entryDate,
                dto.Time == default ? TimeOnly.FromDateTime(now) : dto.Time)
            {
                AssetId = asset.Id
            };
            AddManualEntry(db, entry);
            await db.SaveChangesAsync();
            await InvalidateWealthIfHistoricalAsync(invalidator, entryDate, timeProvider, cancellationToken);
            await invalidator.InvalidateCatalogueAsync(cancellationToken);

            return Results.Ok(new
            {
                Id = asset.Id,
                Name = asset.DisplayName,
                Value = dto.Value,
                Mortgage = dto.Mortgage,
                Equity = dto.Value - dto.Mortgage
            });
        });

        app.MapPost("/api/properties/{id:guid}/entries", async (
            Guid id,
            PropertySnapshotDto dto,
            WealthDbContext db,
            TimeProvider timeProvider,
            IWealthCacheInvalidator invalidator,
            CancellationToken cancellationToken) =>
        {
            var asset = await LoadPropertyAssetAsync(db, id);
            if (asset is null)
                return Results.NotFound(new { Error = "Property not found." });
            if (asset.ArchivedAt.HasValue)
                return Results.BadRequest(new { Error = "Archived properties cannot receive new entries." });
            var validationError = ValidatePropertyValues(dto.Value, dto.Mortgage);
            if (validationError is not null)
                return Results.BadRequest(new { Error = validationError });

            var now = timeProvider.GetUtcNow().UtcDateTime;
            var entryDate = dto.Date == default ? DateOnly.FromDateTime(now) : dto.Date;
            await AssetCatalogService.EnsurePropertyAssetAsync(db, asset);
            var entry = new PropertyAssetValueEntry(
                asset.DisplayName,
                AssetKindCodes.Property,
                dto.Value,
                dto.Mortgage,
                entryDate,
                dto.Time == default ? TimeOnly.FromDateTime(now) : dto.Time)
            {
                AssetId = asset.Id
            };
            AddManualEntry(db, entry);
            await db.SaveChangesAsync();
            await InvalidateWealthIfHistoricalAsync(invalidator, entryDate, timeProvider, cancellationToken);

            return Results.Ok(new
            {
                Id = asset.Id,
                Name = asset.DisplayName,
                Value = dto.Value,
                Mortgage = dto.Mortgage,
                Equity = dto.Value - dto.Mortgage
            });
        });

        app.MapPatch("/api/properties/{id:guid}", async (
            Guid id,
            PropertyUpdateDto dto,
            WealthDbContext db,
            TimeProvider timeProvider,
            IWealthCacheInvalidator invalidator,
            CancellationToken cancellationToken) =>
        {
            var asset = await LoadPropertyAssetAsync(db, id);
            if (asset is null)
                return Results.NotFound(new { Error = "Property not found." });

            if (dto.Name is not null)
            {
                var name = dto.Name.Trim();
                if (string.IsNullOrWhiteSpace(name))
                    return Results.BadRequest(new { Error = "A property name is required." });
                var nameExists = await db.Assets.AnyAsync(existing =>
                    existing.Id != id && existing.ArchivedAt == null &&
                    existing.DisplayName.ToLower() == name.ToLower() &&
                    existing.AssetKindAssignments.Any(assignment => assignment.AssetKind!.Code == AssetKindCodes.Property));
                if (nameExists)
                    return Results.Conflict(new { Error = "An active property with this name already exists." });
                asset.DisplayName = name;
            }

            if (dto.Archived.HasValue)
                asset.ArchivedAt = dto.Archived.Value
                    ? asset.ArchivedAt ?? timeProvider.GetUtcNow()
                    : null;

            await db.SaveChangesAsync();
            await invalidator.InvalidateWealthAsync(cancellationToken);
            await invalidator.InvalidateCatalogueAsync(cancellationToken);
            return Results.Ok(new { Id = asset.Id, Name = asset.DisplayName, asset.ArchivedAt });
        });

        app.MapPost("/api/wealth", async (
            WealthEntryDto dto,
            WealthDbContext db,
            ILogger<AssetValueEntry> logger,
            TimeProvider timeProvider,
            IWealthCacheInvalidator invalidator,
            CancellationToken cancellationToken) =>
        {
            var requestedKindCode = string.IsNullOrWhiteSpace(dto.AssetKindCode)
                ? dto.Type
                : dto.AssetKindCode;
            logger.LogInformation("Received manual wealth entry for {AssetKind}.", requestedKindCode);
            var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
            var entryDate = dto.Date == default ? DateOnly.FromDateTime(nowUtc) : dto.Date;
            var entryTime = dto.Time == default ? TimeOnly.FromDateTime(nowUtc) : dto.Time;

            AssetCatalogService.EnsureDefaults(db);
            var asset = dto.AssetId.HasValue
                ? await LoadAssetForEntryAsync(db, dto.AssetId.Value)
                : null;
            if (dto.AssetId.HasValue && asset is null)
                return Results.NotFound(new { Error = "Asset not found." });
            if (asset?.ArchivedAt.HasValue == true)
                return Results.BadRequest(new { Error = "Archived assets cannot receive new entries." });

            var entryName = string.IsNullOrWhiteSpace(dto.Name)
                ? asset?.DisplayName ?? string.Empty
                : dto.Name.Trim();
            if (string.IsNullOrWhiteSpace(entryName))
                return Results.BadRequest(new { Error = "An asset display name is required." });

            var assignedKind = asset?.AssetKindAssignments.FirstOrDefault()?.AssetKind;
            var kindCode = assignedKind?.Code ?? AssetCatalogService.NormalizeAssetKindCode(requestedKindCode);
            if (dto.AssetKindId.HasValue || dto.AssetKindIds is not null || dto.ClassificationValueIds is not null)
            {
                try
                {
                    var explicitKindId = await ResolveKindIdAsync(
                        db,
                        dto.AssetKindId,
                        dto.AssetKindIds ?? dto.ClassificationValueIds,
                        requestedKindCode);
                    if (explicitKindId.HasValue)
                    {
                        var explicitKind = await db.AssetKinds.FindAsync(explicitKindId.Value);
                        kindCode = explicitKind?.Code ?? kindCode;
                    }
                }
                catch (ArgumentException exception)
                {
                    return Results.BadRequest(new { Error = exception.Message });
                }
            }

            if (string.Equals(kindCode, AssetKindCodes.Property, StringComparison.OrdinalIgnoreCase))
            {
                var validationError = ValidatePropertyValues(dto.Value, dto.Mortgage);
                if (validationError is not null)
                    return Results.BadRequest(new { Error = validationError });

                var propertyId = dto.PropertyId ?? dto.AssetId;
                asset = propertyId.HasValue
                    ? await LoadPropertyAssetAsync(db, propertyId.Value)
                    : asset;
                if (propertyId.HasValue && asset is null)
                    return Results.NotFound(new { Error = "Property not found." });
                if (asset is null)
                {
                    asset = new Asset { DisplayName = entryName };
                    db.Assets.Add(asset);
                }
                if (asset.ArchivedAt.HasValue)
                    return Results.BadRequest(new { Error = "Archived properties cannot receive new entries." });

                await AssetCatalogService.EnsurePropertyAssetAsync(db, asset);
                var mortgage = dto.Mortgage;
                if (!mortgage.HasValue)
                {
                    mortgage = await db.PropertyAssetValueEntries
                        .Where(entry => entry.AssetId == asset.Id)
                        .OrderByDescending(entry => entry.Date)
                        .ThenByDescending(entry => entry.Time)
                        .Select(entry => entry.Mortgage)
                        .FirstOrDefaultAsync();
                }

                validationError = ValidatePropertyValues(dto.Value, mortgage);
                if (validationError is not null)
                    return Results.BadRequest(new { Error = validationError });

                var propertyEntry = new PropertyAssetValueEntry(
                    asset.DisplayName,
                    AssetKindCodes.Property,
                    dto.Value,
                    mortgage,
                    entryDate,
                    entryTime)
                {
                    AssetId = asset.Id
                };
                AddManualEntry(db, propertyEntry);
                await db.SaveChangesAsync();
                await InvalidateWealthIfHistoricalAsync(invalidator, entryDate, timeProvider, cancellationToken);
                await invalidator.InvalidateCatalogueAsync(cancellationToken);
                return Results.Ok(propertyEntry);
            }

            AssetValueEntry entry = AssetCatalogService.ValueShapeForKind(kindCode) switch
            {
                AssetValueShape.Investment => new InvestmentAssetValueEntry(
                    entryName,
                    kindCode,
                    dto.Value,
                    dto.InvestedCapital,
                    entryDate,
                    entryTime),
                _ => new CashAssetValueEntry(
                    entryName,
                    kindCode,
                    dto.Value,
                    entryDate,
                    entryTime)
            };

            if (asset is not null)
                entry.AssetId = asset.Id;
            try
            {
                asset = await AssetCatalogService.EnsureAssetForEntryAsync(
                    db,
                    entry,
                    entryName,
                    await ResolveKindIdsAsync(db, dto.AssetKindId, dto.AssetKindIds ?? dto.ClassificationValueIds, kindCode));
            }
            catch (ArgumentException exception)
            {
                return Results.BadRequest(new { Error = exception.Message });
            }

            entry.Name = asset.DisplayName;
            AddManualEntry(db, entry);
            await db.SaveChangesAsync();
            await InvalidateWealthIfHistoricalAsync(invalidator, entryDate, timeProvider, cancellationToken);
            await invalidator.InvalidateCatalogueAsync(cancellationToken);
            return Results.Ok(entry);
        });

        app.MapGet("/api/audits", async (int page, int pageSize, WealthDbContext db) =>
        {
            page = Math.Max(1, page);
            pageSize = Math.Clamp(pageSize, 1, 250);
            var query = db.SyncRuns.AsNoTracking().OrderByDescending(run => run.StartTime);
            var total = await query.CountAsync();
            var audits = (await query
                    .Skip((page - 1) * pageSize)
                    .Take(pageSize)
                    .ToListAsync())
                .Select(SyncAuditResponse.From)
                .ToList();
            return Results.Ok(new { Total = total, Page = page, PageSize = pageSize, Audits = audits });
        });

        app.MapPost("/api/sync", async (IntegrationService service, CancellationToken cancellationToken) =>
        {
            var results = await service.SyncEnabledAsync(ignoreSchedule: true, cancellationToken);
            return Results.Ok(new
            {
                Success = results.All(result => result.Succeeded),
                NewRecords = results.Sum(result => result.RecordsProcessed),
                Results = results
            });
        });

        app.MapGet("/api/wealth/current-observations", async (
            DateOnly? date,
            WealthDbContext db,
            TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            var observationDate = date ?? DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            AssetCatalogService.EnsureDefaults(db);

            var categories = await db.AssetKinds
                .AsNoTracking()
                .Where(kind => kind.ArchivedAt == null &&
                    db.AssetValueEntries.Any(entry => entry.Date == observationDate &&
                        (entry.Asset != null && entry.Asset.AssetKindAssignments.Any(assignment =>
                            assignment.AssetKindId == kind.Id) ||
                         entry.SourceLink != null && entry.SourceLink.ExternalValue != null &&
                         entry.SourceLink.ExternalValue.IntegrationAccount != null &&
                         entry.SourceLink.ExternalValue.IntegrationAccount.AssetMappings.Any(mapping =>
                             mapping.Asset != null && mapping.Asset.AssetKindAssignments.Any(assignment =>
                                 assignment.AssetKindId == kind.Id)) ||
                         entry.SourceLink != null && entry.SourceLink.ExternalValue != null &&
                         entry.SourceLink.ExternalValue.AssetMappings.Any(mapping =>
                             mapping.Asset != null && mapping.Asset.AssetKindAssignments.Any(assignment =>
                                 assignment.AssetKindId == kind.Id)))))
                .OrderBy(kind => kind.DisplayOrder)
                .ThenBy(kind => kind.DisplayName)
                .Select(kind => kind.Code)
                .ToListAsync(cancellationToken);

            return Results.Ok(new { Date = observationDate, Categories = categories });
        });

        app.MapGet("/api/calendar", async (
            int? year,
            int? month,
            [FromServices] WealthReadModelService readModel,
            [FromServices] IApplicationCache cache,
            [FromServices] TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            var selectedYear = year ?? today.Year;
            var selectedMonth = month ?? today.Month;
            if (selectedYear is < 1 or > 9999)
                return Results.BadRequest(new { Error = "year must be between 1 and 9999." });
            if (selectedMonth is < 1 or > 12)
                return Results.BadRequest(new { Error = "month must be between 1 and 12." });

            var historicalThrough = today.AddDays(-1);
            var cacheKey = CacheKeys.Calendar(selectedYear, selectedMonth, historicalThrough);
            var historical = await cache.GetOrCreateAsync(
                cacheKey,
                async factoryCancellationToken =>
                {
                    var aggregates = await GetHistoricalAggregatesAsync(
                        cache,
                        readModel,
                        "MAX",
                        historicalThrough,
                        factoryCancellationToken);
                    return BuildCalendarResponse(selectedYear, selectedMonth, today, aggregates);
                },
                CacheDurations.HistoricalAggregate,
                tags: [CacheTags.Wealth],
                cancellationToken);

            if (selectedYear != today.Year || selectedMonth != today.Month)
                return Results.Ok(historical);

            var current = await readModel.GetAggregatesAsync(
                "1D",
                null,
                cancellationToken);
            return Results.Ok(MergeCurrentCalendar(historical, current, today));
        });

        app.MapGet("/api/history", async (
            string? period,
            [FromServices] WealthReadModelService readModel,
            [FromServices] IApplicationCache cache,
            [FromServices] TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            var selectedPeriod = string.IsNullOrWhiteSpace(period) ? "1M" : period.Trim();
            if (!IsSupportedPeriod(selectedPeriod))
                return UnsupportedPeriod(selectedPeriod);

            var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            var historicalThrough = today.AddDays(-1);
            var historical = await GetHistoricalAggregatesAsync(
                cache,
                readModel,
                selectedPeriod,
                historicalThrough,
                cancellationToken);
            var aggregates = MergeCurrentAggregates(
                historical,
                await readModel.GetAggregatesAsync("1D", null, cancellationToken),
                today);

            return Results.Ok(BuildHistoryResponse(selectedPeriod, aggregates));
        });

        app.MapGet("/api/dashboard", async (
            string? period,
            [FromServices] WealthReadModelService readModel,
            [FromServices] IApplicationCache cache,
            [FromServices] TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            var selectedPeriod = string.IsNullOrWhiteSpace(period) ? "1M" : period.Trim();
            if (!IsSupportedPeriod(selectedPeriod))
                return UnsupportedPeriod(selectedPeriod);

            var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            var historicalThrough = today.AddDays(-1);
            var current = await readModel.GetAggregatesAsync(
                "1D",
                null,
                cancellationToken);
            var historical = await GetHistoricalAggregatesAsync(
                cache,
                readModel,
                selectedPeriod,
                historicalThrough,
                cancellationToken);
            var aggregates = MergeCurrentAggregates(historical, current, today);

            var ytdHistorical = await GetHistoricalAggregatesAsync(
                cache,
                readModel,
                "YTD",
                historicalThrough,
                cancellationToken);
            var ytd = MergeCurrentAggregates(
                ytdHistorical,
                current,
                today);

            return Results.Ok(BuildDashboardResponse(selectedPeriod, aggregates, ytd, today));
        });

        app.MapGet("/api/wealth/{category}/aggregate", async (
            string category,
            string? period,
            string? timeZone,
            DateOnly? asOfDate,
            WealthDbContext db,
            TimeProvider timeProvider,
            IApplicationCache cache,
            CancellationToken cancellationToken) =>
        {
            var nowUtc = timeProvider.GetUtcNow().UtcDateTime;
            var todayUtc = DateOnly.FromDateTime(nowUtc);
            var selectedPeriod = string.IsNullOrWhiteSpace(period) ? "1M" : period.Trim();
            if (!IsSupportedPeriod(selectedPeriod))
                return UnsupportedPeriod(selectedPeriod);
            if (period?.Equals("1H", StringComparison.OrdinalIgnoreCase) == true)
            {
                if (asOfDate.HasValue)
                    return Results.BadRequest(new { Error = "An asOfDate query parameter cannot be used for 1H aggregation." });
                if (string.IsNullOrWhiteSpace(timeZone))
                    return Results.BadRequest(new { Error = "A timeZone query parameter is required for 1H aggregation." });
                try
                {
                    TimeZoneInfo.FindSystemTimeZoneById(timeZone);
                }
                catch (TimeZoneNotFoundException)
                {
                    return Results.BadRequest(new { Error = "The supplied timeZone is not supported." });
                }
                catch (InvalidTimeZoneException)
                {
                    return Results.BadRequest(new { Error = "The supplied timeZone is invalid." });
                }
            }

            if (asOfDate.HasValue && asOfDate.Value >= todayUtc)
                return Results.BadRequest(new { Error = "asOfDate must be before the current UTC date." });

            var effectiveNowUtc = asOfDate?.ToDateTime(TimeOnly.MaxValue) ?? nowUtc;
            var cacheKey = CacheKeys.WealthAggregate(category, period, timeZone, asOfDate ?? todayUtc);
            var buildAggregate = async (CancellationToken _) =>
            {
                    AssetCatalogService.EnsureDefaults(db);
                    var categoryKind = await db.AssetKinds.FirstOrDefaultAsync(kind =>
                        kind.ArchivedAt == null && kind.Code.ToLower() == category.Trim().ToLower());
                    if (categoryKind is null)
                        return new WealthAggregateResponse();

                    var allEntries = await db.AssetValueEntries
                .AsNoTracking()
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
                .Where(entry => entry.Asset != null && entry.Asset.AssetKindAssignments
                    .Any(assignment => assignment.AssetKindId == categoryKind.Id) ||
                    entry.SourceLink != null && entry.SourceLink.ExternalValue != null &&
                    entry.SourceLink.ExternalValue.IntegrationAccount != null &&
                    entry.SourceLink.ExternalValue.IntegrationAccount.AssetMappings.Any(mapping =>
                        mapping.Asset != null && mapping.Asset.AssetKindAssignments
                            .Any(assignment => assignment.AssetKindId == categoryKind.Id)) ||
                    entry.SourceLink != null && entry.SourceLink.ExternalValue != null &&
                    entry.SourceLink.ExternalValue.AssetMappings.Any(mapping =>
                        mapping.Asset != null && mapping.Asset.AssetKindAssignments
                            .Any(assignment => assignment.AssetKindId == categoryKind.Id)))
                .OrderBy(entry => entry.Date)
                .ThenBy(entry => entry.Time)
                .ToListAsync();

                    foreach (var entry in allEntries)
                    {
                var externalValue = entry.SourceLink?.ExternalValue;
                var role = externalValue is not null &&
                           (externalValue.Role == ExternalValueRole.Undeployed ||
                            externalValue.ExternalId.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) ||
                            externalValue.DisplayName.EndsWith("(undeployed)", StringComparison.OrdinalIgnoreCase))
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
                    }

                    foreach (var entry in allEntries)
                        entry.AssetKindCode = entry.Asset?.AssetKindAssignments.FirstOrDefault()?.AssetKind?.Code
                                              ?? categoryKind.Code;
                    if (allEntries.Count == 0)
                        return new WealthAggregateResponse();

                    var lastVisibleEntry = allEntries.LastOrDefault(entry => EntryTimestampUtc(entry) <= effectiveNowUtc)
                                           ?? allEntries.Last();
                    var lastSync = new DateTimeOffset(EntryTimestampUtc(lastVisibleEntry), TimeSpan.Zero);
                    var isPropertyCategory = categoryKind.Code.Equals(AssetKindCodes.Property, StringComparison.OrdinalIgnoreCase);
                    var isOneHourPeriod = period?.Equals("1H", StringComparison.OrdinalIgnoreCase) == true;

                    TimeZoneInfo? localTimeZone = isOneHourPeriod
                        ? TimeZoneInfo.FindSystemTimeZoneById(timeZone!)
                        : null;

                    var configuredProviderCodes = (await db.IntegrationProviders
                    .AsNoTracking()
                    .Select(provider => provider.Code)
                    .ToListAsync())
                        .ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var runningBalances = new Dictionary<string, decimal>();
            var runningBalanceNames = new Dictionary<string, string>();
            var runningBalanceIsIntegration = new Dictionary<string, bool>();
            var runningInvested = new Dictionary<string, decimal>();
            var runningPropertyValues = new Dictionary<string, decimal>();

            bool IsIntegrationEntry(AssetValueEntry entry)
            {
                var providerCode = entry.SourceLink?.ExternalValue?.IntegrationAccount?.IntegrationConnection
                    ?.IntegrationProvider?.Code;
                return entry.SourceLink?.SourceKind == AssetValueEntrySourceKind.Integration &&
                       (string.IsNullOrWhiteSpace(providerCode) || configuredProviderCodes.Contains(providerCode));
            }

            bool IsUndeployedEntry(AssetValueEntry entry) =>
                entry.SourceLink?.ExternalValue?.Role == ExternalValueRole.Undeployed ||
                entry.SourceLink?.ExternalValue?.ExternalId.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) == true ||
                entry.SourceLink?.ExternalValue?.DisplayName.EndsWith("(undeployed)", StringComparison.OrdinalIgnoreCase) == true ||
                entry.ExternalAssetId?.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) == true;

            string EntryIdentity(AssetValueEntry entry)
            {
                if (entry.AssetId == Guid.Empty)
                    return $"entry:{entry.Id}";
                var externalId = entry.SourceLink?.ExternalValueId;
                if (externalId.HasValue)
                    return $"{entry.AssetId:D}:{externalId.Value:D}";
                if (!string.IsNullOrWhiteSpace(entry.ExternalAssetId))
                    return $"{entry.AssetId:D}:legacy:{entry.ExternalAssetId}";
                return entry.AssetId.ToString("D");
            }

            string EntryName(AssetValueEntry entry)
            {
                var name = entry.Asset?.DisplayName ?? entry.Name;
                return IsUndeployedEntry(entry) &&
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
                runningBalanceIsIntegration.TryGetValue(pair.Key, out var isIntegration) && isIntegration);

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
                foreach (var entry in allEntries.Where(candidate =>
                             candidate.Asset?.ArchivedAt?.UtcDateTime <= timestamp))
                    RemoveRunningBalance(EntryIdentity(entry));
            }

            Dictionary<string, decimal> BuildBreakdown() => runningBalances
                .GroupBy(pair => runningBalanceNames.TryGetValue(pair.Key, out var name) ? name : pair.Key)
                .ToDictionary(group => group.Key, group => group.Sum(pair => pair.Value));

            Dictionary<string, decimal>? BuildPropertyValues() => !isPropertyCategory
                ? null
                : runningPropertyValues
                    .GroupBy(pair => runningBalanceNames.TryGetValue(pair.Key, out var name) ? name : pair.Key)
                    .ToDictionary(group => group.Key, group => group.Sum(pair => pair.Value));

            var cutoff = ResolveCutoff(period, isOneHourPeriod, effectiveNowUtc, localTimeZone, allEntries);
                    var resultData = new List<WealthAggregatePoint>();
            if (isOneHourPeriod)
            {
                var entriesBeforeDay = allEntries.Where(entry => EntryTimestampUtc(entry) < cutoff).ToList();
                foreach (var entry in entriesBeforeDay)
                    RecordEntry(entry, SetRunningBalance, runningInvested, EntryIdentity);
                RemoveArchivedBalances(cutoff);

                var currentInstant = new DateTimeOffset(effectiveNowUtc, TimeSpan.Zero);
                var entriesForToday = allEntries
                    .Select(entry => (Entry: entry, Timestamp: new DateTimeOffset(EntryTimestampUtc(entry), TimeSpan.Zero)))
                    .Where(item => item.Timestamp.UtcDateTime >= cutoff && item.Timestamp <= currentInstant)
                    .OrderBy(item => item.Timestamp)
                    .ToList();
                var nextEntryIndex = 0;
                for (var bucketStart = new DateTimeOffset(cutoff, TimeSpan.Zero);
                     bucketStart <= currentInstant;
                     bucketStart = bucketStart.AddHours(1))
                {
                    var bucketEnd = bucketStart.AddHours(1);
                    var hasObservation = false;
                    while (nextEntryIndex < entriesForToday.Count && entriesForToday[nextEntryIndex].Timestamp < bucketEnd)
                    {
                        var item = entriesForToday[nextEntryIndex++];
                        hasObservation = true;
                        RecordEntry(item.Entry, SetRunningBalance, runningInvested, EntryIdentity);
                    }
                    RemoveArchivedBalances(bucketStart.UtcDateTime);
                    if (runningBalances.Count > 0)
                        resultData.Add(new WealthAggregatePoint
                        {
                            Time = TimeZoneInfo.ConvertTime(bucketStart, localTimeZone!).ToString("o"),
                            Value = runningBalances.Values.Sum(),
                            GrossValue = isPropertyCategory ? runningPropertyValues.Values.Sum() : null,
                            Equity = isPropertyCategory ? runningBalances.Values.Sum() : null,
                            PropertyValues = BuildPropertyValues(),
                            Invested = runningInvested.Values.Sum(),
                            HasObservation = hasObservation,
                            Breakdown = BuildBreakdown()
                        });
                }
            }
            else
            {
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
                var mortgage = latestProperties.Sum(property => property.Mortgage);
                    propertyDetails = new PropertyAggregateDetails
                {
                    Properties = latestProperties,
                        Totals = new PropertyAggregateTotals { Value = value, Mortgage = mortgage, Equity = value - mortgage }
                };
            }

                    Dictionary<string, List<PortfolioPosition>>? investmentDetails = null;
            if (categoryKind.Code.Equals(AssetKindCodes.Investments, StringComparison.OrdinalIgnoreCase) && allEntries.Count > 0)
            {
                var positions = allEntries
                    .Where(entry => entry.DateTime <= effectiveNowUtc && entry is InvestmentAssetValueEntry)
                    .GroupBy(EntryIdentity)
                    .Select(group => group.Last())
                    .OfType<InvestmentAssetValueEntry>()
                    .Where(entry => entry.Positions.Count > 0)
                    .ToDictionary(entry => entry.SourceLink?.ExternalValue?.Role == ExternalValueRole.Undeployed
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
            };
            var response = asOfDate.HasValue
                ? await cache.GetOrCreateAsync(
                    cacheKey,
                    buildAggregate,
                    CacheDurations.HistoricalAggregate,
                    tags: [CacheTags.Wealth],
                    cancellationToken)
                : await buildAggregate(cancellationToken);
            return Results.Ok(response);
        });

        app.MapPost("/api/wealth/forecast", async (
            ForecastRequest request,
            WealthDbContext db,
            TimeProvider timeProvider,
            IApplicationCache cache,
            CancellationToken cancellationToken) =>
        {
            var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);
            // JSON null is valid for nullable collection values even though
            // the request model exposes non-null defaults. Normalize it at
            // the HTTP boundary so malformed persisted/client payloads are
            // handled as an ordinary validation failure instead of a 500.
            request.Contributions ??= [];
            request.Windfalls ??= [];
            request.IncludedAssets ??= [];
            var cacheKey = CacheKeys.Forecast(request, today);
            try
            {
                var forecast = await cache.GetOrCreateAsync(
                    cacheKey,
                    async factoryCancellationToken =>
                    {
                        var entries = await db.AssetValueEntries
                .AsNoTracking()
                .Include(entry => entry.Asset)
                    .ThenInclude(asset => asset!.AssetKindAssignments)
                        .ThenInclude(assignment => assignment.AssetKind)
                .Include(entry => entry.SourceLink)
                    .ThenInclude(source => source!.ExternalValue)
                .OrderBy(entry => entry.Date)
                .ThenBy(entry => entry.Time)
                .ToListAsync(factoryCancellationToken);
                        if (entries.Count == 0)
                            return new ForecastResponse();

            foreach (var entry in entries)
            {
                var kind = entry.Asset?.AssetKindAssignments.FirstOrDefault()?.AssetKind;
                entry.AssetKindCode = kind?.Code ?? entry.AssetKindCode;
                if (entry.Asset is not null)
                {
                    var isUndeployed = entry.SourceLink?.ExternalValue?.Role == ExternalValueRole.Undeployed ||
                                       entry.ExternalAssetId?.EndsWith(":cash", StringComparison.OrdinalIgnoreCase) == true ||
                                       entry.Name.EndsWith(" (undeployed)", StringComparison.OrdinalIgnoreCase);
                    entry.Name = isUndeployed
                        ? $"{entry.Asset.DisplayName} (undeployed)"
                        : entry.Asset.DisplayName;
                }
            }

            var requestedAssets = request.IncludedAssets
                .Select(value => value.ToLowerInvariant())
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var kindById = await db.AssetKinds.AsNoTracking().ToDictionaryAsync(kind => kind.Id);
            foreach (var kind in kindById.Values)
            {
                if (requestedAssets.Contains(kind.Id.ToString().ToLowerInvariant()))
                    requestedAssets.Add(kind.Code);
            }
            request.IncludedAssets = requestedAssets.ToList();

                        return ForecastCalculator.Calculate(
                    entries,
                    request,
                    today);
                    },
                    CacheDurations.HistoricalAggregate,
                    tags: [CacheTags.Wealth, CacheTags.WealthCurrent],
                    cancellationToken);
                return Results.Ok(forecast);
            }
            catch (InvalidOperationException exception)
            {
                return Results.BadRequest(exception.Message);
            }
        });

        app.MapGet("/api/settings", async (
            WealthDbContext db,
            ILogger<AppPreference> logger) =>
        {
            var preference = await db.AppPreferences.FindAsync(1) ?? new AppPreference();
            var budget = await BuildBudgetSettingsAsync(db, preference);
            return Results.Ok(new Dictionary<string, string>
            {
                ["wealthWatcherGeneralSettings"] = ReadPersistedSettingsJson(
                    preference.GeneralJson,
                    "wealthWatcherGeneralSettings",
                    logger),
                ["wealthWatcherFeatureSettings"] = ReadPersistedSettingsJson(
                    preference.FeatureJson,
                    "wealthWatcherFeatureSettings",
                    logger),
                ["wealthWatcherForecastSettings"] = ReadPersistedSettingsJson(
                    preference.ForecastJson,
                    "wealthWatcherForecastSettings",
                    logger),
                ["wealthWatcherFireSettings"] = ReadPersistedSettingsJson(
                    preference.FireJson,
                    "wealthWatcherFireSettings",
                    logger),
                ["wealthWatcherMilestoneSettings"] = ReadPersistedMilestoneSettingsJson(
                    preference.MilestoneJson,
                    logger),
                ["wealthWatcherBudgetSettings"] = budget
            });
        });

        app.MapPost("/api/settings", async (
            Dictionary<string, string?>? settings,
            WealthDbContext db,
            ILogger<AppPreference> logger,
            IWealthCacheInvalidator invalidator,
            CancellationToken cancellationToken) =>
        {
            if (settings is null)
                return Results.BadRequest(new { Error = "A settings object is required." });

            // Validate and normalize the complete request before touching the
            // tracked preference or budget entities. This keeps a malformed
            // setting from partially applying a multi-setting save and gives
            // clients an explicit failure they can use to retain/restore the
            // last known persisted state.
            var normalizedSettings = new Dictionary<string, string>(StringComparer.Ordinal);
            BudgetSettingsRequest? budgetRequest = null;
            var hasBudgetSettings = false;
            foreach (var pair in settings)
            {
                switch (pair.Key)
                {
                    case "wealthWatcherGeneralSettings":
                    case "wealthWatcherFeatureSettings":
                    case "wealthWatcherForecastSettings":
                    case "wealthWatcherFireSettings":
                        if (!TryNormalizeSettingsJson(
                                pair.Value,
                                pair.Key,
                                out var normalized,
                                out var validationError))
                            return Results.BadRequest(new { Error = validationError });
                        normalizedSettings[pair.Key] = normalized;
                        break;
                    case "wealthWatcherBudgetSettings":
                        if (!TryNormalizeSettingsJson(
                                pair.Value,
                                pair.Key,
                                out var normalizedBudget,
                                out var budgetValidationError))
                            return Results.BadRequest(new { Error = budgetValidationError });
                        if (!TryDeserializeBudgetSettings(
                                normalizedBudget,
                                out budgetRequest,
                                out var budgetError))
                            return Results.BadRequest(new { Error = budgetError });
                        hasBudgetSettings = true;
                        break;
                }
            }

            logger.LogInformation("Updating {Count} user settings", settings.Count);

            string? normalizedMilestoneJson = null;
            if (settings.TryGetValue("wealthWatcherMilestoneSettings", out var milestoneJson))
            {
                if (!MilestoneSettingsPolicy.TryNormalize(milestoneJson, out normalizedMilestoneJson, out var milestoneError))
                    return Results.BadRequest(new { Error = milestoneError });
            }

            BudgetSettingsPlan? budgetPlan = null;
            BudgetV2SettingsPlan? budgetV2Plan = null;
            var preference = await db.AppPreferences.FindAsync(1);
            if (hasBudgetSettings)
            {
                if (budgetRequest!.V2 is not null)
                {
                    var preparation = await PrepareBudgetV2SettingsAsync(
                        db,
                        preference,
                        budgetRequest.V2,
                        cancellationToken);
                    if (preparation.Plan is null)
                        return Results.BadRequest(new { Error = preparation.Error });

                    budgetV2Plan = preparation.Plan;
                }
                else
                {
                    if (TryReadPersistedBudgetV2(preference?.BudgetJson, out _))
                    {
                        return Results.Conflict(new
                        {
                            Error = "The saved budget uses the v2 group format. Refresh budget settings before submitting the legacy array format."
                        });
                    }

                    var preparation = await PrepareBudgetSettingsAsync(db, budgetRequest.Legacy!);
                    if (preparation.Plan is null)
                        return Results.BadRequest(new { Error = preparation.Error });

                    budgetPlan = preparation.Plan;
                }
            }

            if (preference is null)
            {
                preference = new AppPreference();
                db.AppPreferences.Add(preference);
            }

            foreach (var pair in normalizedSettings)
            {
                switch (pair.Key)
                {
                    case "wealthWatcherGeneralSettings":
                        preference.GeneralJson = pair.Value;
                        break;
                    case "wealthWatcherFeatureSettings":
                        preference.FeatureJson = pair.Value;
                        break;
                    case "wealthWatcherForecastSettings":
                        preference.ForecastJson = pair.Value;
                        break;
                    case "wealthWatcherFireSettings":
                        preference.FireJson = pair.Value;
                        break;
                }
            }

            if (normalizedMilestoneJson is not null)
                preference.MilestoneJson = normalizedMilestoneJson;

            if (budgetPlan is not null)
            {
                ApplyBudgetSettings(db, budgetPlan);
                preference.BudgetJson = null;
            }

            if (budgetV2Plan is not null)
            {
                ApplyBudgetSettings(db, budgetV2Plan.CompatibilityPlan);
                preference.BudgetJson = JsonSerializer.Serialize(budgetV2Plan.Document, JsonOptions);
            }

            await using var transaction = db.Database.IsRelational()
                ? await db.Database.BeginTransactionAsync(cancellationToken)
                : null;
            try
            {
                await db.SaveChangesAsync(cancellationToken);
                if (transaction is not null)
                    await transaction.CommitAsync(cancellationToken);
            }
            catch
            {
                if (transaction is not null)
                    await transaction.RollbackAsync(cancellationToken);
                throw;
            }

            await invalidator.InvalidateWealthAsync(cancellationToken);
            return Results.Ok();
        });

        return app;
    }

    private static readonly string[] SupportedPeriods = ["1D", "1W", "1M", "3M", "1Y", "YTD", "MAX"];

    private static bool IsSupportedPeriod(string period) =>
        SupportedPeriods.Contains(period, StringComparer.OrdinalIgnoreCase);

    private static IResult UnsupportedPeriod(string period) => Results.BadRequest(new
    {
        Error = $"The period '{period}' is not supported.",
        SupportedPeriods
    });

    private static Task<IReadOnlyList<WealthCategoryAggregate>> GetHistoricalAggregatesAsync(
        IApplicationCache cache,
        WealthReadModelService readModel,
        string? period,
        DateOnly asOfDate,
        CancellationToken cancellationToken)
    {
        var cacheKey = CacheKeys.HistoricalAggregates(period, null, asOfDate);
        return cache.GetOrCreateAsync(
            cacheKey,
            factoryCancellationToken => readModel.GetAggregatesAsync(
                period,
                asOfDate,
                factoryCancellationToken),
            CacheDurations.HistoricalAggregate,
            tags: [CacheTags.Wealth],
            cancellationToken);
    }

    private static WealthBffHistoryResponse BuildHistoryResponse(
        string period,
        IReadOnlyList<WealthCategoryAggregate> aggregates) =>
        new()
        {
            Period = period,
            Categories = aggregates.Select(ToCategoryResponse).ToList(),
            Timeline = BuildTimeline(aggregates)
        };

    private static WealthBffDashboardResponse BuildDashboardResponse(
        string period,
        IReadOnlyList<WealthCategoryAggregate> aggregates,
        IReadOnlyList<WealthCategoryAggregate> ytd,
        DateOnly today)
    {
        var timeline = BuildTimeline(aggregates);
        var ytdTimeline = BuildTimeline(ytd);
        var currentTotal = timeline.LastOrDefault()?.Value ?? 0m;
        var previousTotal = timeline
            .Where(point => !TryGetAggregateDate(point.Time, out var date) || date < today)
            .LastOrDefault()?.Value ?? (timeline.Count > 1 ? timeline[^2].Value : currentTotal);
        var ytdStartTotal = ytdTimeline.FirstOrDefault()?.Value ?? 0m;
        var ytdByCategory = ytd.ToDictionary(item => item.Category, StringComparer.OrdinalIgnoreCase);

        var contributors = aggregates
            .Select(category =>
            {
                var currentPoint = category.Response.Data.LastOrDefault();
                var startingPoint = ytdByCategory.TryGetValue(category.Category, out var ytdCategory)
                    ? ytdCategory.Response.Data.FirstOrDefault()
                    : null;
                var currentValue = currentPoint?.Value ?? 0m;
                var startingValue = startingPoint?.Value ?? 0m;
                var currentInvested = currentPoint?.Invested ?? 0m;
                var startingInvested = startingPoint?.Invested ?? 0m;
                return new WealthBffContributor
                {
                    Name = category.Label,
                    Color = category.Color,
                    CurrentValue = currentValue,
                    Delta = currentValue - startingValue,
                    DeltaInvested = currentInvested - startingInvested
                };
            })
            .Where(contributor => contributor.CurrentValue != 0m || contributor.Delta != 0m)
            .ToList();

        return new WealthBffDashboardResponse
        {
            Period = period,
            Categories = aggregates.Select(ToCategoryResponse).ToList(),
            Timeline = timeline,
            YtdCategories = ytd.Select(ToCategoryResponse).ToList(),
            CurrentTotal = currentTotal,
            PreviousTotal = previousTotal,
            YtdStartTotal = ytdStartTotal,
            Contributors = contributors
        };
    }

    private static WealthBffCategoryResponse ToCategoryResponse(WealthCategoryAggregate aggregate) =>
        new()
        {
            Id = aggregate.Category,
            Label = aggregate.Label,
            Color = aggregate.Color,
            DisplayOrder = aggregate.DisplayOrder,
            AssetGroupId = aggregate.AssetGroupId,
            AssetGroupCode = aggregate.AssetGroupCode,
            ClassificationValueId = aggregate.ClassificationValueId,
            Aggregate = aggregate.Response
        };

    private static List<WealthBffTimelinePoint> BuildTimeline(
        IReadOnlyList<WealthCategoryAggregate> aggregates) =>
        aggregates
            .SelectMany(aggregate => aggregate.Response.Data)
            .GroupBy(point => point.Time, StringComparer.Ordinal)
            .Select(group => new WealthBffTimelinePoint
            {
                Time = group.Key,
                Value = group.Sum(point => point.Value)
            })
            .OrderBy(point => point.Time, StringComparer.Ordinal)
            .ToList();

    private static IReadOnlyList<WealthCategoryAggregate> MergeCurrentAggregates(
        IReadOnlyList<WealthCategoryAggregate> historical,
        IReadOnlyList<WealthCategoryAggregate> current,
        DateOnly today)
    {
        var currentByCategory = current.ToDictionary(
            aggregate => aggregate.Category,
            StringComparer.OrdinalIgnoreCase);
        var historicalCategories = historical
            .Select(aggregate =>
            {
                if (!currentByCategory.TryGetValue(aggregate.Category, out var currentAggregate))
                    return aggregate;
                return MergeCategory(aggregate, currentAggregate, today);
            })
            .ToList();

        foreach (var currentAggregate in current)
        {
            if (historical.Any(aggregate => aggregate.Category.Equals(
                    currentAggregate.Category,
                    StringComparison.OrdinalIgnoreCase)))
                continue;

            historicalCategories.Add(MergeCategory(
                new WealthCategoryAggregate
                {
                    Category = currentAggregate.Category,
                    Label = currentAggregate.Label,
                    Color = currentAggregate.Color,
                    DisplayOrder = currentAggregate.DisplayOrder,
                    AssetGroupId = currentAggregate.AssetGroupId,
                    AssetGroupCode = currentAggregate.AssetGroupCode,
                    ClassificationValueId = currentAggregate.ClassificationValueId,
                    Response = new WealthAggregateResponse()
                },
                currentAggregate,
                today));
        }

        return historicalCategories
            .OrderBy(aggregate => aggregate.DisplayOrder)
            .ThenBy(aggregate => aggregate.Label)
            .ToList();
    }

    private static WealthCategoryAggregate MergeCategory(
        WealthCategoryAggregate historical,
        WealthCategoryAggregate current,
        DateOnly today)
    {
        var currentData = current.Response.Data
            .Where(point => IsOnOrAfterDate(point.Time, today))
            .ToList();
        var mergedData = historical.Response.Data
            .Concat(currentData)
            .GroupBy(point => point.Time, StringComparer.Ordinal)
            .Select(group => group.Last())
            .OrderBy(point => point.Time, StringComparer.Ordinal)
            .ToList();
        var currentIsAvailable = currentData.Count > 0;

        return new WealthCategoryAggregate
        {
            Category = historical.Category,
            Label = historical.Label,
            Color = historical.Color,
            DisplayOrder = historical.DisplayOrder,
            AssetGroupId = historical.AssetGroupId,
            AssetGroupCode = historical.AssetGroupCode,
            ClassificationValueId = historical.ClassificationValueId,
            Response = new WealthAggregateResponse
            {
                Data = mergedData,
                LastSyncDateTime = currentIsAvailable
                    ? current.Response.LastSyncDateTime ?? historical.Response.LastSyncDateTime
                    : historical.Response.LastSyncDateTime,
                IsManual = currentIsAvailable ? current.Response.IsManual : historical.Response.IsManual,
                LatestBreakdown = currentIsAvailable && current.Response.LatestBreakdown.Count > 0
                    ? current.Response.LatestBreakdown
                    : historical.Response.LatestBreakdown,
                PropertyDetails = currentIsAvailable
                    ? current.Response.PropertyDetails ?? historical.Response.PropertyDetails
                    : historical.Response.PropertyDetails,
                InvestmentDetails = currentIsAvailable
                    ? current.Response.InvestmentDetails ?? historical.Response.InvestmentDetails
                    : historical.Response.InvestmentDetails
            }
        };
    }

    private static WealthBffCalendarResponse BuildCalendarResponse(
        int year,
        int month,
        DateOnly today,
        IReadOnlyList<WealthCategoryAggregate> aggregates)
    {
        var dailyTotals = BuildDailyTotals(aggregates);
        var firstDay = new DateOnly(year, month, 1);
        var lastDay = firstDay.AddMonths(1).AddDays(-1);
        var days = new List<WealthBffCalendarDay>();
        for (var date = firstDay; date <= lastDay; date = date.AddDays(1))
        {
            var hasTotal = dailyTotals.TryGetValue(date, out var summary);
            var isFuture = date > today;
            var previousAvailable = dailyTotals.TryGetValue(date.AddDays(-1), out var previous);
            var changeAvailable = !isFuture && hasTotal && summary!.HasObservation &&
                previousAvailable && previous!.HasObservation;
            decimal? change = changeAvailable ? summary!.Total - previous!.Total : null;
            decimal? percentage = changeAvailable && previous!.Total != 0m
                ? change!.Value / previous.Total * 100m
                : null;
            days.Add(new WealthBffCalendarDay
            {
                Date = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                Total = hasTotal ? summary!.Total : null,
                HasObservation = hasTotal && summary!.HasObservation,
                IsFuture = isFuture,
                ChangeAvailable = changeAvailable,
                Change = change,
                Percentage = percentage
            });
        }

        var currentDate = dailyTotals.Keys
            .Where(date => date.Year == year && date.Month == month && date <= today && dailyTotals[date].HasObservation)
            .OrderByDescending(date => date)
            .FirstOrDefault();
        var hasCurrentDate = dailyTotals.ContainsKey(currentDate) && currentDate != default;
        var previousMonthDate = firstDay.AddMonths(-1);
        var previousDate = dailyTotals.Keys
            .Where(date => date.Year == previousMonthDate.Year && date.Month == previousMonthDate.Month && dailyTotals[date].HasObservation)
            .OrderByDescending(date => date)
            .FirstOrDefault();
        var hasPreviousDate = dailyTotals.ContainsKey(previousDate) && previousDate != default;
        var currentSummary = hasCurrentDate ? dailyTotals[currentDate] : null;
        var previousSummary = hasPreviousDate ? dailyTotals[previousDate] : null;
        decimal? comparisonChange = currentSummary is not null && previousSummary is not null
            ? currentSummary.Total - previousSummary.Total
            : null;

        return new WealthBffCalendarResponse
        {
            Year = year,
            Month = month,
            Today = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            EarliestHistoryDate = dailyTotals.Count == 0
                ? null
                : dailyTotals.Keys.Min().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            Days = days,
            MonthComparison = new WealthBffMonthComparison
            {
                Available = currentSummary is not null && previousSummary is not null,
                CurrentDate = hasCurrentDate ? currentDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null,
                CurrentTotal = currentSummary?.Total,
                PreviousDate = hasPreviousDate ? previousDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null,
                PreviousTotal = previousSummary?.Total,
                Change = comparisonChange,
                Percentage = comparisonChange.HasValue && previousSummary!.Total != 0m
                    ? comparisonChange.Value / previousSummary.Total * 100m
                    : null
            }
        };
    }

    private static WealthBffCalendarResponse MergeCurrentCalendar(
        WealthBffCalendarResponse historical,
        IReadOnlyList<WealthCategoryAggregate> current,
        DateOnly today)
    {
        var currentPoints = current
            .SelectMany(aggregate => aggregate.Response.Data)
            .Where(point => DateOnly.TryParseExact(
                point.Time,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var date) && date == today)
            .ToList();
        if (currentPoints.Count == 0)
            return historical;

        var total = currentPoints.Sum(point => point.Value);
        var hasObservation = currentPoints.Any(point => point.HasObservation);
        var previousDate = today.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var previousDay = historical.Days.FirstOrDefault(day => day.Date == previousDate);
        var previousTotal = previousDay?.Total;
        var previousObserved = previousDay?.HasObservation == true;
        if (!previousTotal.HasValue && historical.MonthComparison.PreviousDate == previousDate)
        {
            previousTotal = historical.MonthComparison.PreviousTotal;
            previousObserved = historical.MonthComparison.Available && previousTotal.HasValue;
        }
        var changeAvailable = hasObservation && previousObserved && previousTotal.HasValue;
        decimal? change = changeAvailable ? total - previousTotal!.Value : null;
        decimal? percentage = changeAvailable && previousTotal!.Value != 0m
            ? change!.Value / previousTotal.Value * 100m
            : null;
        var todayText = today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var days = historical.Days
            .Select(day => day.Date == todayText
                ? new WealthBffCalendarDay
                {
                    Date = todayText,
                    Total = total,
                    HasObservation = hasObservation,
                    IsFuture = false,
                    ChangeAvailable = changeAvailable,
                    Change = change,
                    Percentage = percentage
                }
                : day)
            .ToList();

        var comparison = historical.MonthComparison;
        if (hasObservation && historical.Year == today.Year && historical.Month == today.Month)
        {
            var comparisonPrevious = comparison.PreviousTotal ?? previousTotal;
            decimal? comparisonChange = comparisonPrevious.HasValue ? total - comparisonPrevious.Value : null;
            comparison = new WealthBffMonthComparison
            {
                Available = comparisonPrevious.HasValue,
                CurrentDate = todayText,
                CurrentTotal = total,
                PreviousDate = comparison.PreviousDate ?? previousDate,
                PreviousTotal = comparisonPrevious,
                Change = comparisonChange,
                Percentage = comparisonPrevious.HasValue && comparisonPrevious.Value != 0m
                    ? comparisonChange!.Value / comparisonPrevious.Value * 100m
                    : null
            };
        }

        return new WealthBffCalendarResponse
        {
            Year = historical.Year,
            Month = historical.Month,
            Today = historical.Today,
            EarliestHistoryDate = historical.EarliestHistoryDate,
            Days = days,
            MonthComparison = comparison
        };
    }

    private static Dictionary<DateOnly, CalendarDaySummary> BuildDailyTotals(
        IReadOnlyList<WealthCategoryAggregate> aggregates)
    {
        var totals = new Dictionary<DateOnly, CalendarDaySummary>();
        foreach (var point in aggregates.SelectMany(aggregate => aggregate.Response.Data))
        {
            if (!DateOnly.TryParseExact(
                    point.Time,
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var date))
                continue;

            if (totals.TryGetValue(date, out var existing))
                totals[date] = new CalendarDaySummary(
                    existing.Total + point.Value,
                    existing.HasObservation || point.HasObservation);
            else
                totals[date] = new CalendarDaySummary(point.Value, point.HasObservation);
        }

        return totals;
    }

    private static bool IsOnOrAfterDate(string time, DateOnly date) =>
        DateOnly.TryParseExact(
            time,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out var parsed) && parsed >= date;

    private static bool TryGetAggregateDate(string time, out DateOnly date)
    {
        if (DateOnly.TryParseExact(
                time,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out date))
            return true;

        if (DateTimeOffset.TryParse(
                time,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var timestamp))
        {
            date = DateOnly.FromDateTime(timestamp.DateTime);
            return true;
        }

        date = default;
        return false;
    }

    private sealed record CalendarDaySummary(decimal Total, bool HasObservation);

    private static Task InvalidateWealthIfHistoricalAsync(
        IWealthCacheInvalidator invalidator,
        DateOnly entryDate,
        TimeProvider timeProvider,
        CancellationToken cancellationToken) =>
        entryDate < DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime)
            ? invalidator.InvalidateWealthAsync(cancellationToken)
            : invalidator.InvalidateCurrentWealthAsync(cancellationToken);

    private static void AddManualEntry(WealthDbContext db, AssetValueEntry entry)
    {
        entry.SourceLink = new AssetValueEntrySource
        {
            AssetValueEntry = entry,
            SourceKind = AssetValueEntrySourceKind.Manual
        };
        db.AssetValueEntries.Add(entry);
    }

    private static async Task<Asset?> LoadAssetForEntryAsync(WealthDbContext db, Guid id) =>
        await db.Assets
            .Include(asset => asset.AssetKindAssignments)
                .ThenInclude(assignment => assignment.AssetKind)
            .FirstOrDefaultAsync(asset => asset.Id == id);

    private static async Task<Asset?> LoadPropertyAssetAsync(WealthDbContext db, Guid id) =>
        await db.Assets
            .Include(asset => asset.AssetKindAssignments)
                .ThenInclude(assignment => assignment.AssetKind)
            .Include(asset => asset.PropertyDetail)
            .FirstOrDefaultAsync(asset => asset.Id == id && asset.AssetKindAssignments
                .Any(assignment => assignment.AssetKind!.Code == AssetKindCodes.Property));

    private static async Task<Guid?> ResolveKindIdAsync(
        WealthDbContext db,
        Guid? explicitKindId,
        IReadOnlyCollection<Guid>? selectedIds,
        string? entryKind)
    {
        var ids = explicitKindId.HasValue
            ? [explicitKindId.Value]
            : selectedIds?.Distinct().ToArray() ?? [];
        if (ids.Length > 1)
            throw new ArgumentException("Only one asset kind may be selected for an asset.");
        if (ids.Length == 1)
        {
            var kind = await db.AssetKinds.FirstOrDefaultAsync(candidate =>
                candidate.Id == ids[0] && candidate.ArchivedAt == null);
            if (kind is not null)
            {
                if (AssetCatalogService.IsUnclassified(kind))
                    throw new ArgumentException(
                        "Unclassified is a system fallback and cannot be selected explicitly.");
                return kind.Id;
            }
            throw new ArgumentException("One or more asset kinds are invalid.");
        }
        if (string.IsNullOrWhiteSpace(entryKind))
            return null;

        var normalized = AssetCatalogService.NormalizeAssetKindCode(entryKind);
        if (normalized == AssetKindCodes.Unclassified)
            throw new ArgumentException(
                "Unclassified is a system fallback and cannot be selected explicitly.");
        var fallbackCode = normalized switch
        {
            AssetValueShape.Investment => AssetKindCodes.Investments,
            AssetValueShape.Property => AssetKindCodes.Property,
            AssetValueShape.Cash => AssetKindCodes.Cash,
            _ => normalized
        };
        return await db.AssetKinds
            .Where(kind => kind.ArchivedAt == null && kind.Code.ToLower() == fallbackCode.ToLower())
            .Select(kind => (Guid?)kind.Id)
            .FirstOrDefaultAsync();
    }

    private static async Task<IReadOnlyCollection<Guid>?> ResolveKindIdsAsync(
        WealthDbContext db,
        Guid? explicitKindId,
        IReadOnlyCollection<Guid>? selectedIds,
        string? entryKind)
    {
        var kindId = await ResolveKindIdAsync(db, explicitKindId, selectedIds, entryKind);
        return kindId.HasValue ? [kindId.Value] : null;
    }

    private static DateTime EntryTimestampUtc(AssetValueEntry entry) =>
        DateTime.SpecifyKind(entry.Date.ToDateTime(entry.Time), DateTimeKind.Utc);

    private static DateTime ResolveCutoff(
        string? period,
        bool isOneHourPeriod,
        DateTime nowUtc,
        TimeZoneInfo? localTimeZone,
        IReadOnlyList<AssetValueEntry> entries)
    {
        if (isOneHourPeriod)
        {
            var localNow = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, localTimeZone!);
            return TimeZoneInfo.ConvertTimeToUtc(
                DateTime.SpecifyKind(localNow.Date, DateTimeKind.Unspecified),
                localTimeZone!);
        }
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
        return entries.Count > 0
            ? entries[0].Date.ToDateTime(TimeOnly.MinValue)
            : nowUtc.Date;
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

    private static string? ValidatePropertyValues(decimal value, decimal? mortgage)
    {
        return value < 0 || mortgage is < 0
            ? "Property value and mortgage must be zero or greater."
            : null;
    }

    private static string ReadPersistedSettingsJson(
        string? json,
        string settingKey,
        ILogger<AppPreference> logger)
    {
        if (TryNormalizeSettingsJson(json, settingKey, out var normalized, out _))
            return normalized;

        logger.LogWarning("Ignoring malformed persisted {SettingKey}.", settingKey);
        return "{}";
    }

    private static string ReadPersistedMilestoneSettingsJson(
        string? json,
        ILogger<AppPreference> logger)
    {
        if (MilestoneSettingsPolicy.TryNormalize(json, out var normalized, out _))
            return normalized;

        logger.LogWarning("Ignoring malformed persisted milestone settings.");
        return MilestoneSettingsPolicy.DefaultJson;
    }

    private static bool TryNormalizeSettingsJson(
        string? json,
        string settingKey,
        out string normalized,
        out string error)
    {
        normalized = "{}";
        error = $"{settingKey} must contain a JSON object.";
        if (string.IsNullOrWhiteSpace(json))
            return true;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            error = $"{settingKey} must contain valid JSON.";
            return false;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return false;

            if (!ValidateSettingsArrayShapes(document.RootElement, settingKey, out error))
                return false;

            normalized = document.RootElement.GetRawText();
            return true;
        }
    }

    private static bool ValidateSettingsArrayShapes(
        JsonElement root,
        string settingKey,
        out string error)
    {
        HashSet<string> arrayProperties = settingKey switch
        {
            "wealthWatcherBudgetSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "income", "bills", "savings", "spend", "groups"
            },
            "wealthWatcherForecastSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "includedAssets", "contributions", "windfalls"
            },
            "wealthWatcherFireSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "includedAssets", "windfalls"
            },
            _ => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        };
        HashSet<string> objectArrayProperties = settingKey switch
        {
            "wealthWatcherBudgetSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "income", "bills", "savings", "spend", "groups"
            },
            "wealthWatcherForecastSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "contributions", "windfalls"
            },
            "wealthWatcherFireSettings" => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "windfalls"
            },
            _ => new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        };

        foreach (var property in root.EnumerateObject())
        {
            if (!arrayProperties.Contains(property.Name))
                continue;
            if (property.Value.ValueKind != JsonValueKind.Array)
            {
                error = $"{settingKey}.{property.Name} must be a JSON array.";
                return false;
            }

            if (!objectArrayProperties.Contains(property.Name))
                continue;
            var index = 0;
            foreach (var item in property.Value.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    error = $"{settingKey}.{property.Name}[{index}] must be a JSON object.";
                    return false;
                }
                index++;
            }
        }

        error = string.Empty;
        return true;
    }

    private static bool TryDeserializeBudgetSettings(
        string json,
        out BudgetSettingsRequest? request,
        out string error)
    {
        request = null;
        using JsonDocument parsed = JsonDocument.Parse(json);
        var root = parsed.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            error = "wealthWatcherBudgetSettings must contain a valid budget object.";
            return false;
        }

        var hasVersion = false;
        var versionElement = default(JsonElement);
        var hasGroups = false;
        foreach (var property in root.EnumerateObject())
        {
            if (property.Name.Equals("version", StringComparison.OrdinalIgnoreCase))
            {
                hasVersion = true;
                versionElement = property.Value;
            }

            if (property.Name.Equals("groups", StringComparison.OrdinalIgnoreCase))
                hasGroups = true;
        }
        var version = 1;
        if (hasVersion &&
            (versionElement.ValueKind != JsonValueKind.Number ||
             !versionElement.TryGetInt32(out version) ||
             version is not 1 and not 2))
        {
            error = "wealthWatcherBudgetSettings.version must be 1 or 2.";
            return false;
        }

        if (hasGroups || version == 2)
        {
            if (!hasVersion || version != 2)
            {
                error = "wealthWatcherBudgetSettings.version must be 2 when groups are supplied.";
                return false;
            }

            BudgetV2Document? v2Document;
            try
            {
                v2Document = JsonSerializer.Deserialize<BudgetV2Document>(json, JsonOptions);
            }
            catch (JsonException)
            {
                v2Document = null;
            }

            if (v2Document is null)
            {
                error = "wealthWatcherBudgetSettings must contain a valid v2 budget object.";
                return false;
            }

            request = new BudgetSettingsRequest(null, v2Document);
            error = string.Empty;
            return true;
        }

        try
        {
            var document = JsonSerializer.Deserialize<BudgetSettingsDocument>(json, JsonOptions);
            request = new BudgetSettingsRequest(document, null);
        }
        catch (JsonException)
        {
            request = null;
        }

        if (request?.Legacy is null)
        {
            error = "wealthWatcherBudgetSettings must contain a valid budget object.";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static async Task<string> BuildBudgetSettingsAsync(
        WealthDbContext db,
        AppPreference preference)
    {
        var lines = await db.BudgetLines
            .AsNoTracking()
            .Include(line => line.AssetMappings)
            .OrderBy(line => line.Name)
            .ToListAsync();

        var legacy = new BudgetSettingsResponse
        {
            Version = 1,
            NeedsUpdate = lines.Count > 0,
            Income = lines
                .Where(line => line.Category == BudgetLineCategory.Income)
                .Select(ToBudgetItem)
                .ToList(),
            Bills = lines
                .Where(line => line.Category == BudgetLineCategory.Bills)
                .Select(ToBudgetItem)
                .ToList(),
            Savings = lines
                .Where(line => line.Category == BudgetLineCategory.Savings)
                .Select(ToBudgetItem)
                .ToList(),
            Spend = lines
                .Where(line => line.Category == BudgetLineCategory.Spend)
                .Select(ToBudgetItem)
                .ToList()
        };

        if (TryReadPersistedBudgetV2(preference.BudgetJson, out var v2Document))
        {
            legacy.Version = 2;
            legacy.NeedsUpdate = v2Document.NeedsUpdate ?? false;
            legacy.Groups = v2Document.Groups;
        }

        return JsonSerializer.Serialize(legacy, JsonOptions);
    }

    private static BudgetItemDocument ToBudgetItem(BudgetLine line) => new()
    {
        Id = line.Id,
        Name = line.Name,
        Amount = line.Amount,
        Cadence = line.Cadence.ToString().ToLowerInvariant(),
        AssetId = line.AssetMappings.FirstOrDefault()?.AssetId,
        Category = line.Category.ToString().ToLowerInvariant()
    };

    private static bool TryReadPersistedBudgetV2(
        string? json,
        out BudgetV2Document document)
    {
        document = null!;
        if (string.IsNullOrWhiteSpace(json))
            return false;

        try
        {
            var parsed = JsonSerializer.Deserialize<BudgetV2Document>(json, JsonOptions);
            if (parsed?.Version != 2 || parsed.Groups is null)
                return false;

            document = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<(BudgetSettingsPlan? Plan, string? Error)> PrepareBudgetSettingsAsync(
        WealthDbContext db,
        BudgetSettingsDocument document)
    {
        var existingLines = await db.BudgetLines
            .Include(line => line.AssetMappings)
            .ToListAsync();
        var existingById = existingLines.ToDictionary(line => line.Id);
        var validAssetIds = (await db.Assets.Select(asset => asset.Id).ToListAsync()).ToHashSet();
        var submittedIds = new HashSet<Guid>();
        var submittedLines = new List<BudgetLineRequest>();

        var categories = new[]
        {
            (Name: "income", Items: document.Income, Category: BudgetLineCategory.Income),
            (Name: "bills", Items: document.Bills, Category: BudgetLineCategory.Bills),
            (Name: "savings", Items: document.Savings, Category: BudgetLineCategory.Savings),
            (Name: "spend", Items: document.Spend, Category: BudgetLineCategory.Spend)
        };

        foreach (var category in categories)
        {
            if (category.Items is null)
            {
                return (null,
                    $"wealthWatcherBudgetSettings.{category.Name} must be a JSON array.");
            }

            var index = 0;
            foreach (var item in category.Items)
            {
                if (item is null)
                {
                    return (null,
                        $"wealthWatcherBudgetSettings.{category.Name}[{index}] must be a JSON object.");
                }

                var itemPath = $"wealthWatcherBudgetSettings.{category.Name}[{index}]";
                if (item.Id is Guid id)
                {
                    if (id == Guid.Empty)
                    {
                        return (null, $"{itemPath}.id must be a non-empty UUID.");
                    }

                    if (!submittedIds.Add(id))
                    {
                        return (null,
                            $"{itemPath}.id contains a duplicate budget line id '{id:D}'.");
                    }

                    if (!existingById.TryGetValue(id, out var existing))
                    {
                        return (null,
                            $"{itemPath}.id references an unknown budget line '{id:D}'.");
                    }

                    if (existing.Category != category.Category)
                    {
                        return (null,
                            $"{itemPath}.id belongs to category '{existing.Category.ToString().ToLowerInvariant()}', " +
                            $"but was submitted under '{category.Name}'.");
                    }
                }

                if (!string.IsNullOrWhiteSpace(item.Category) &&
                    (!TryParseBudgetCategory(item.Category, out var declaredCategory) ||
                     declaredCategory != category.Category))
                {
                    return (null,
                        $"{itemPath}.category must match the budget category '{category.Name}'.");
                }

                if (string.IsNullOrWhiteSpace(item.Name))
                {
                    return (null, $"{itemPath}.name must not be blank.");
                }

                if (item.Amount < 0)
                {
                    return (null, $"{itemPath}.amount must be zero or greater.");
                }

                if (item.Amount > 99_999_999_999_999_999.99m ||
                    decimal.Round(item.Amount, 2) != item.Amount)
                {
                    return (null,
                        $"{itemPath}.amount must fit the budget amount precision of decimal(18,2).");
                }

                if (!TryParseCadence(item.Cadence, out var cadence))
                {
                    return (null,
                        $"{itemPath}.cadence must be monthly, quarterly, or annually.");
                }

                if (item.AssetId is Guid assetId)
                {
                    if (assetId == Guid.Empty || !validAssetIds.Contains(assetId))
                    {
                        return (null,
                            $"{itemPath}.assetId references an unknown asset '{assetId:D}'.");
                    }
                }

                submittedLines.Add(new BudgetLineRequest
                {
                    Id = item.Id,
                    Category = category.Category,
                    Name = item.Name.Trim(),
                    Amount = item.Amount,
                    Cadence = cadence,
                    AssetId = item.AssetId,
                    AssetIdSpecified = item.AssetIdSpecified
                });
                index++;
            }
        }

        return (new BudgetSettingsPlan(existingLines, existingById, submittedLines), null);
    }

    private static async Task<(BudgetV2SettingsPlan? Plan, string? Error)> PrepareBudgetV2SettingsAsync(
        WealthDbContext db,
        AppPreference? preference,
        BudgetV2Document document,
        CancellationToken cancellationToken)
    {
        if (document.Version != 2)
            return (null, "wealthWatcherBudgetSettings.version must be 2.");

        if (document.Groups is null || document.Groups.Count == 0)
            return (null, "wealthWatcherBudgetSettings.groups must contain at least one group.");

        var existingLines = await db.BudgetLines
            .Include(line => line.AssetMappings)
            .ToListAsync(cancellationToken);
        var existingById = existingLines.ToDictionary(line => line.Id);
        var validAssetIds = (await db.Assets
                .Select(asset => asset.Id)
                .ToListAsync(cancellationToken))
            .ToHashSet();
        var submittedIds = new HashSet<Guid>();
        var submittedItemIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var normalizedGroups = new List<BudgetV2GroupDocument>(document.Groups.Count);
        var submittedLines = new List<BudgetLineRequest>();
        BudgetV2GroupDocument? incomeGroup = null;
        var groupIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var groupIndex = 0; groupIndex < document.Groups.Count; groupIndex++)
        {
            var group = document.Groups[groupIndex];
            var groupPath = $"wealthWatcherBudgetSettings.groups[{groupIndex}]";
            if (group is null)
                return (null, $"{groupPath} must be a JSON object.");

            if (string.IsNullOrWhiteSpace(group.Id))
                return (null, $"{groupPath}.id must not be blank.");

            var groupId = group.Id.Trim();
            if (!groupIds.Add(groupId))
                return (null, $"{groupPath}.id contains a duplicate group id '{groupId}'.");

            if (string.IsNullOrWhiteSpace(group.Name))
                return (null, $"{groupPath}.name must not be blank.");

            if (group.BuiltIn is not bool builtIn)
                return (null, $"{groupPath}.builtIn must be true or false.");

            var kind = NormalizeBudgetGroupValue(group.Kind);
            var role = NormalizeBudgetGroupValue(group.Role);
            if (kind is null && role is null)
                return (null, $"{groupPath} must specify kind or role.");

            if (kind == "income" && role is not null && role != "income")
                return (null, $"{groupPath}.kind and role must agree for the Income group.");
            if (role == "income" && kind is not null && kind != "income")
                return (null, $"{groupPath}.kind and role must agree for the Income group.");

            var isIncome = kind == "income" || role == "income";
            if (isIncome)
            {
                if (!builtIn)
                    return (null, $"{groupPath} Income must remain builtIn.");
                if (incomeGroup is not null)
                    return (null, "wealthWatcherBudgetSettings.groups must contain exactly one Income group.");

                incomeGroup = group;
            }
            else if (builtIn)
            {
                return (null, $"{groupPath} custom groups must set builtIn to false.");
            }

            if (group.Items is null)
                return (null, $"{groupPath}.items must be a JSON array.");

            var normalizedGroup = new BudgetV2GroupDocument
            {
                Id = groupId,
                Name = group.Name.Trim(),
                Kind = isIncome ? "income" : "custom",
                Role = isIncome ? "income" : role ?? kind ?? "custom",
                BuiltIn = isIncome,
                Color = string.IsNullOrWhiteSpace(group.Color) ? null : group.Color.Trim(),
                Items = new List<BudgetV2ItemDocument>(group.Items.Count)
            };
            var compatibilityCategory = isIncome
                ? BudgetLineCategory.Income
                : ParseCompatibilityBudgetCategory(role ?? kind);

            for (var itemIndex = 0; itemIndex < group.Items.Count; itemIndex++)
            {
                var item = group.Items[itemIndex];
                var itemPath = $"{groupPath}.items[{itemIndex}]";
                if (item is null)
                    return (null, $"{itemPath} must be a JSON object.");

                if (string.IsNullOrWhiteSpace(item.Id))
                    return (null, $"{itemPath}.id must not be blank.");
                var itemId = item.Id.Trim();
                if (!submittedItemIds.Add(itemId))
                    return (null, $"{itemPath}.id contains a duplicate item id '{itemId}'.");

                if (string.IsNullOrWhiteSpace(item.Name))
                    return (null, $"{itemPath}.name must not be blank.");
                if (item.Amount < 0)
                    return (null, $"{itemPath}.amount must be zero or greater.");
                if (item.Amount > 99_999_999_999_999_999.99m ||
                    decimal.Round(item.Amount, 2) != item.Amount)
                {
                    return (null,
                        $"{itemPath}.amount must fit the budget amount precision of decimal(18,2).");
                }

                if (string.IsNullOrWhiteSpace(item.Cadence) ||
                    !TryParseCadence(item.Cadence, out var cadence))
                {
                    return (null,
                        $"{itemPath}.cadence must be monthly, quarterly, or annually.");
                }

                var stableLineId = GetStableBudgetLineId(itemId);
                if (!submittedIds.Add(stableLineId))
                {
                    return (null, $"{itemPath}.id resolves to a duplicate budget line id.");
                }

                var existingLine = existingById.GetValueOrDefault(stableLineId);
                var effectiveAssetId = item.AssetIdSpecified
                    ? item.AssetId
                    : existingLine?.AssetMappings.FirstOrDefault()?.AssetId;
                if (effectiveAssetId is Guid assetId &&
                    (assetId == Guid.Empty || !validAssetIds.Contains(assetId)))
                {
                    return (null,
                        $"{itemPath}.assetId references an unknown asset '{assetId:D}'.");
                }

                var normalizedItem = new BudgetV2ItemDocument
                {
                    Id = itemId,
                    Name = item.Name.Trim(),
                    Amount = item.Amount,
                    Cadence = cadence.ToString().ToLowerInvariant(),
                    Category = string.IsNullOrWhiteSpace(item.Category)
                        ? null
                        : item.Category.Trim()
                };
                normalizedItem.AssetId = effectiveAssetId;
                normalizedGroup.Items.Add(normalizedItem);

                submittedLines.Add(new BudgetLineRequest
                {
                    Id = stableLineId,
                    Category = compatibilityCategory,
                    Name = normalizedItem.Name,
                    Amount = normalizedItem.Amount,
                    Cadence = cadence,
                    AssetId = effectiveAssetId,
                    AssetIdSpecified = true
                });
            }

            normalizedGroups.Add(normalizedGroup);
        }

        if (incomeGroup is null)
            return (null, "wealthWatcherBudgetSettings.groups must contain the built-in Income group.");

        if (TryReadPersistedBudgetV2(preference?.BudgetJson, out var previousDocument))
        {
            var previousIncome = previousDocument.Groups!
                .FirstOrDefault(IsIncomeBudgetGroup);
            if (previousIncome is not null &&
                !string.Equals(previousIncome.Id, incomeGroup.Id?.Trim(), StringComparison.Ordinal))
            {
                return (null, "The built-in Income group cannot be replaced.");
            }
        }

        document.Version = 2;
        document.NeedsUpdate = false;
        document.Groups = normalizedGroups;
        return (
            new BudgetV2SettingsPlan(
                document,
                new BudgetSettingsPlan(existingLines, existingById, submittedLines)),
            null);
    }

    private static bool IsIncomeBudgetGroup(BudgetV2GroupDocument group)
    {
        var kind = NormalizeBudgetGroupValue(group.Kind);
        var role = NormalizeBudgetGroupValue(group.Role);
        return kind == "income" || role == "income";
    }

    private static string? NormalizeBudgetGroupValue(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static BudgetLineCategory ParseCompatibilityBudgetCategory(string? role)
        => NormalizeBudgetGroupValue(role) switch
        {
            "bills" or "needs" => BudgetLineCategory.Bills,
            "savings" or "saving" => BudgetLineCategory.Savings,
            "spend" or "spending" or "wants" => BudgetLineCategory.Spend,
            _ => BudgetLineCategory.Spend
        };

    private static Guid GetStableBudgetLineId(string itemId)
    {
        if (Guid.TryParse(itemId, out var parsed) && parsed != Guid.Empty)
            return parsed;

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(
            $"wealth-watcher:budget-v2:item:{itemId}"));
        var bytes = hash[..16];
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes);
    }

    private static void ApplyBudgetSettings(
        WealthDbContext db,
        BudgetSettingsPlan plan)
    {
        var submittedIds = plan.SubmittedLines
            .Where(line => line.Id.HasValue)
            .Select(line => line.Id!.Value)
            .ToHashSet();

        foreach (var line in plan.ExistingLines.Where(line => !submittedIds.Contains(line.Id)))
        {
            db.BudgetLineAssetMappings.RemoveRange(line.AssetMappings.ToList());
            db.BudgetLines.Remove(line);
        }

        var reservedIds = plan.ExistingLines.Select(line => line.Id).ToHashSet();
        foreach (var request in plan.SubmittedLines)
        {
            BudgetLine line;
            if (request.Id is Guid id)
            {
                if (plan.ExistingById.TryGetValue(id, out var existing))
                {
                    line = existing;
                }
                else
                {
                    line = new BudgetLine { Id = id };
                    db.BudgetLines.Add(line);
                    reservedIds.Add(id);
                }
            }
            else
            {
                var newId = Guid.NewGuid();
                while (!reservedIds.Add(newId))
                    newId = Guid.NewGuid();

                line = new BudgetLine { Id = newId };
                db.BudgetLines.Add(line);
            }

            line.Category = request.Category;
            line.Name = request.Name;
            line.Amount = request.Amount;
            line.Cadence = request.Cadence;

            if (request.AssetIdSpecified)
                ReplaceBudgetLineAssetMapping(db, line, request.AssetId);
        }
    }

    private static void ReplaceBudgetLineAssetMapping(
        WealthDbContext db,
        BudgetLine line,
        Guid? assetId)
    {
        var currentMappings = line.AssetMappings.ToList();
        if (assetId.HasValue &&
            currentMappings.Count == 1 &&
            currentMappings[0].AssetId == assetId.Value)
        {
            return;
        }

        if (!assetId.HasValue && currentMappings.Count == 0)
            return;

        db.BudgetLineAssetMappings.RemoveRange(currentMappings);
        if (assetId.HasValue)
        {
            db.BudgetLineAssetMappings.Add(new BudgetLineAssetMapping
            {
                BudgetLine = line,
                BudgetLineId = line.Id,
                AssetId = assetId.Value
            });
        }
    }

    private static bool TryParseBudgetCategory(
        string category,
        out BudgetLineCategory parsed)
    {
        parsed = category.Trim().ToLowerInvariant() switch
        {
            "income" => BudgetLineCategory.Income,
            "bills" => BudgetLineCategory.Bills,
            "savings" => BudgetLineCategory.Savings,
            "spend" => BudgetLineCategory.Spend,
            _ => (BudgetLineCategory)0
        };
        return parsed != 0;
    }

    private static bool TryParseCadence(
        string? cadence,
        out BudgetCadence parsed)
    {
        parsed = cadence?.Trim().ToLowerInvariant() switch
        {
            "quarterly" => BudgetCadence.Quarterly,
            "annually" or "annual" or "yearly" => BudgetCadence.Annually,
            null or "" or "monthly" => BudgetCadence.Monthly,
            _ => (BudgetCadence)0
        };
        return parsed != 0;
    }

    private sealed class BudgetSettingsPlan(
        IReadOnlyList<BudgetLine> existingLines,
        IReadOnlyDictionary<Guid, BudgetLine> existingById,
        IReadOnlyList<BudgetLineRequest> submittedLines)
    {
        public IReadOnlyList<BudgetLine> ExistingLines { get; } = existingLines;
        public IReadOnlyDictionary<Guid, BudgetLine> ExistingById { get; } = existingById;
        public IReadOnlyList<BudgetLineRequest> SubmittedLines { get; } = submittedLines;
    }

    private sealed record BudgetV2SettingsPlan(
        BudgetV2Document Document,
        BudgetSettingsPlan CompatibilityPlan);

    private sealed record BudgetSettingsRequest(
        BudgetSettingsDocument? Legacy,
        BudgetV2Document? V2);

    private sealed class BudgetLineRequest
    {
        public Guid? Id { get; init; }
        public BudgetLineCategory Category { get; init; }
        public string Name { get; init; } = string.Empty;
        public decimal Amount { get; init; }
        public BudgetCadence Cadence { get; init; }
        public Guid? AssetId { get; init; }
        public bool AssetIdSpecified { get; init; }
    }

    private sealed class BudgetSettingsResponse
    {
        public int Version { get; set; }
        public bool NeedsUpdate { get; set; }

        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<BudgetV2GroupDocument>? Groups { get; set; }

        public List<BudgetItemDocument> Income { get; init; } = new();
        public List<BudgetItemDocument> Bills { get; init; } = new();
        public List<BudgetItemDocument> Savings { get; init; } = new();
        public List<BudgetItemDocument> Spend { get; init; } = new();
    }
}

public class WealthEntryDto
{
    public string Name { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public string AssetKindCode { get; set; } = string.Empty;
    public Guid? AssetId { get; set; }
    public Guid? AssetKindId { get; set; }
    public IReadOnlyCollection<Guid>? AssetKindIds { get; set; }
    public IReadOnlyCollection<Guid>? ClassificationValueIds { get; set; }
    public decimal Value { get; set; }
    public decimal? Mortgage { get; set; }
    public Guid? PropertyId { get; set; }
    public decimal? InvestedCapital { get; set; }
    public DateOnly Date { get; set; }
    public TimeOnly Time { get; set; }
    public string? Source { get; set; }
}

public class PropertyCreateDto
{
    public string Name { get; set; } = string.Empty;
    public decimal Value { get; set; }
    public decimal Mortgage { get; set; }
    public DateOnly Date { get; set; }
    public TimeOnly Time { get; set; }
}

public class PropertySnapshotDto
{
    public decimal Value { get; set; }
    public decimal Mortgage { get; set; }
    public DateOnly Date { get; set; }
    public TimeOnly Time { get; set; }
}

public class PropertyUpdateDto
{
    public string? Name { get; set; }
    public bool? Archived { get; set; }
}

public class ForecastRequest
{
    public decimal Target { get; set; }
    public decimal AnnualReturn { get; set; }
    public decimal MonthlyContribution { get; set; }
    public string ForecastStrategy { get; set; } = ForecastCalculator.FireDefaultStrategy;
    public List<ForecastContributionDto> Contributions { get; set; } = new();
    public List<WindfallDto> Windfalls { get; set; } = new();
    public List<string> IncludedAssets { get; set; } = new() { "investments", "pensions", "property" };
}

public class ForecastContributionDto
{
    public string Name { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public Guid? AssetId { get; set; }
    public string Cadence { get; set; } = "monthly";
}

public class WindfallDto
{
    public string Name { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string ExpectedDate { get; set; } = string.Empty;
    public bool IncludeInCalculation { get; set; }
}

public sealed class BudgetSettingsDocument
{
    public List<BudgetItemDocument> Income { get; set; } = new();
    public List<BudgetItemDocument> Bills { get; set; } = new();
    public List<BudgetItemDocument> Savings { get; set; } = new();
    public List<BudgetItemDocument> Spend { get; set; } = new();
}

public sealed class BudgetItemDocument
{
    public Guid? Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string Cadence { get; set; } = "monthly";
    public string? Category { get; set; }

    private Guid? assetId;

    public Guid? AssetId
    {
        get => assetId;
        set
        {
            assetId = value;
            AssetIdSpecified = true;
        }
    }

    [JsonIgnore]
    public bool AssetIdSpecified { get; private set; }
}
