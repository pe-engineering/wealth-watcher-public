using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace WealthWatcher.Api.Models;

public enum IntegrationKind
{
    Investment = 1
}

public enum IntegrationConnectionStatus
{
    NeedsCredentials = 1,
    ReadyToTest = 2,
    Tested = 3,
    NeedsAllocation = 4,
    Active = 5,
    Disabled = 6,
    Error = 7
}

public enum IntegrationSyncMode
{
    Polling = 1,
    Webhook = 2
}

public enum IntegrationPollingScheduleType
{
    EveryNMinutes = 1,
    Cron = 2,
    HourlyAt = 3,
    HourlyOnTheHour = 4,
    DailyAt = 5,
    WeeklyAt = 6
}

/// <summary>
/// Installed adapter/provider identity. The adapter code is a boundary value;
/// local relationships use Id.
/// </summary>
public sealed class IntegrationProvider
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Code { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;

    [JsonIgnore]
    public ICollection<IntegrationConnection> Connections { get; set; } =
        new List<IntegrationConnection>();
}

/// <summary>
/// A saved integration connection, including credentials and options.
/// </summary>
public sealed class IntegrationConnection
{
    [NotMapped]
    private string? legacyProviderKey;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid IntegrationProviderId { get; set; }
    public IntegrationKind Kind { get; set; } = IntegrationKind.Investment;
    public string DisplayName { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public IntegrationConnectionStatus Status { get; set; } = IntegrationConnectionStatus.NeedsCredentials;
    public IntegrationSyncMode SyncMode { get; set; } = IntegrationSyncMode.Polling;
    public int PollingIntervalMinutes { get; set; } = 180;
    public IntegrationPollingScheduleType PollingScheduleType { get; set; } = IntegrationPollingScheduleType.EveryNMinutes;
    public string PollingScheduleValue { get; set; } = string.Empty;
    public DayOfWeek? PollingScheduleDay { get; set; }
    public bool OnlyPollDuringMarketTimes { get; set; }
    public string OptionsJson { get; set; } = "{}";
    public string CredentialsCiphertext { get; set; } = string.Empty;
    public DateTimeOffset? LastTestedAt { get; set; }
    public DateTimeOffset? LastSyncedAt { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    [JsonIgnore]
    public IntegrationProvider? IntegrationProvider { get; set; }

    [JsonIgnore]
    public ICollection<IntegrationAccount> Accounts { get; set; } = new List<IntegrationAccount>();

    [JsonIgnore]
    public ICollection<SyncRun> SyncRuns { get; set; } = new List<SyncRun>();

    [JsonIgnore]
    [Obsolete("Use IntegrationProvider.Code.")]
    [NotMapped]
    public string ProviderKey
    {
        get => IntegrationProvider?.Code ?? legacyProviderKey ?? string.Empty;
        set
        {
            legacyProviderKey = value;
        }
    }
}
