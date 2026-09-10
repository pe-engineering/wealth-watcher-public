using System.Text.Json.Serialization;

namespace WealthWatcher.Api.Models;

public sealed class WealthAggregateResponse
{
    public List<WealthAggregatePoint> Data { get; init; } = new();
    public DateTimeOffset? LastSyncDateTime { get; init; }
    public bool IsManual { get; init; }
    public Dictionary<string, decimal> LatestBreakdown { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public PropertyAggregateDetails? PropertyDetails { get; init; }
    public Dictionary<string, List<PortfolioPosition>>? InvestmentDetails { get; init; }
}

public sealed class WealthAggregatePoint
{
    public string Time { get; init; } = string.Empty;
    public decimal Value { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public decimal? GrossValue { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public decimal? Equity { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, decimal>? PropertyValues { get; init; }
    public decimal Invested { get; init; }
    public bool HasObservation { get; init; }
    public Dictionary<string, decimal> Breakdown { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class PropertyAggregateDetails
{
    public List<PropertyAggregateItem> Properties { get; init; } = new();
    public PropertyAggregateTotals Totals { get; init; } = new();
}

public sealed class PropertyAggregateItem
{
    public Guid Id { get; init; }
    public string Name { get; init; } = string.Empty;
    public decimal Value { get; init; }
    public decimal Mortgage { get; init; }
    public decimal Equity { get; init; }
}

public sealed class PropertyAggregateTotals
{
    public decimal Value { get; init; }
    public decimal Mortgage { get; init; }
    public decimal Equity { get; init; }
}
