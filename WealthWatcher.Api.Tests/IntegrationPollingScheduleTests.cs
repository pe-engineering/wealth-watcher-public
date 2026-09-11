using WealthWatcher.Api.Integrations;
using WealthWatcher.Api.Models;
using Xunit;

namespace WealthWatcher.Api.Tests;

public sealed class IntegrationPollingScheduleTests
{
    [Fact]
    public void Every_n_minutes_uses_the_legacy_interval_and_is_due_at_the_boundary()
    {
        var now = LocalTime(2026, 9, 11, 10, 15);
        var connection = new IntegrationConnection
        {
            PollingIntervalMinutes = 30,
            PollingScheduleType = IntegrationPollingScheduleType.EveryNMinutes,
            LastSyncedAt = now.AddMinutes(-30).ToUniversalTime()
        };

        Assert.True(IntegrationPollingSchedule.IsDue(connection, now));

        connection.LastSyncedAt = now.AddMinutes(-29).ToUniversalTime();
        Assert.False(IntegrationPollingSchedule.IsDue(connection, now));
    }

    [Fact]
    public void Hourly_daily_weekly_and_cron_schedules_compare_against_the_latest_occurrence()
    {
        var now = LocalTime(2026, 9, 11, 10, 15);
        var schedules = new[]
        {
            new IntegrationConnection
            {
                PollingScheduleType = IntegrationPollingScheduleType.Cron,
                PollingScheduleValue = "*/15 * * * *"
            },
            new IntegrationConnection
            {
                PollingScheduleType = IntegrationPollingScheduleType.HourlyAt,
                PollingScheduleValue = "15"
            },
            new IntegrationConnection
            {
                PollingScheduleType = IntegrationPollingScheduleType.HourlyOnTheHour
            },
            new IntegrationConnection
            {
                PollingScheduleType = IntegrationPollingScheduleType.DailyAt,
                PollingScheduleValue = "09:30"
            },
            new IntegrationConnection
            {
                PollingScheduleType = IntegrationPollingScheduleType.WeeklyAt,
                PollingScheduleValue = "09:30",
                PollingScheduleDay = DayOfWeek.Friday
            }
        };

        foreach (var connection in schedules)
        {
            var occurrence = IntegrationPollingSchedule.GetLatestOccurrence(connection, now);
            Assert.True(occurrence.HasValue);

            connection.LastSyncedAt = occurrence!.Value.AddMinutes(-1);
            Assert.True(IntegrationPollingSchedule.IsDue(connection, now));

            connection.LastSyncedAt = occurrence.Value;
            Assert.False(IntegrationPollingSchedule.IsDue(connection, now));
        }
    }

    [Fact]
    public void Schedule_values_are_normalized_and_invalid_values_are_rejected()
    {
        var cron = IntegrationPollingSchedule.NormalizeValue(
            IntegrationPollingScheduleType.Cron,
            "  */15 9-17 * * MON-FRI  ",
            null,
            180,
            5,
            out var cronDay);
        Assert.Equal("*/15 9-17 * * MON-FRI", cron);
        Assert.Null(cronDay);

        var weekly = IntegrationPollingSchedule.NormalizeValue(
            IntegrationPollingScheduleType.WeeklyAt,
            "09:05",
            DayOfWeek.Friday,
            180,
            5,
            out var weeklyDay);
        Assert.Equal("09:05", weekly);
        Assert.Equal(DayOfWeek.Friday, weeklyDay);

        Assert.Throws<ArgumentException>(() => IntegrationPollingSchedule.NormalizeValue(
            IntegrationPollingScheduleType.Cron,
            "0 * * *",
            null,
            180,
            5,
            out _));
        Assert.Throws<ArgumentException>(() => IntegrationPollingSchedule.NormalizeValue(
            IntegrationPollingScheduleType.WeeklyAt,
            "09:05",
            null,
            180,
            5,
            out _));
    }

    private static DateTimeOffset LocalTime(int year, int month, int day, int hour, int minute)
    {
        var wallClock = new DateTime(year, month, day, hour, minute, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(wallClock, TimeZoneInfo.Local.GetUtcOffset(wallClock));
    }
}
