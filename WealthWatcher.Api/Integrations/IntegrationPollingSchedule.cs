using System.Collections.Concurrent;
using System.Globalization;
using WealthWatcher.Api.Models;

namespace WealthWatcher.Api.Integrations;

/// <summary>
/// Validates and evaluates the polling schedules supported by integration
/// connections. All time-based schedules use the API host's local time, which
/// is also the time zone used by the existing market-hours setting.
/// </summary>
public static class IntegrationPollingSchedule
{
    private const int CronSearchDays = 366 * 5;
    private static readonly ConcurrentDictionary<string, CronExpression> CronCache = new(StringComparer.Ordinal);

    public static string NormalizeValue(
        IntegrationPollingScheduleType type,
        string? value,
        DayOfWeek? day,
        int fallbackIntervalMinutes,
        int minimumIntervalMinutes,
        out DayOfWeek? normalizedDay)
    {
        normalizedDay = null;
        switch (type)
        {
            case IntegrationPollingScheduleType.EveryNMinutes:
            {
                var rawValue = string.IsNullOrWhiteSpace(value)
                    ? fallbackIntervalMinutes.ToString(CultureInfo.InvariantCulture)
                    : value.Trim();
                if (!int.TryParse(rawValue, NumberStyles.None, CultureInfo.InvariantCulture, out var minutes) || minutes <= 0)
                    throw new ArgumentException("Polling interval must be a positive whole number of minutes.");
                if (minutes < minimumIntervalMinutes)
                    throw new ArgumentException($"Polling interval must be at least {minimumIntervalMinutes} minute(s).");
                return minutes.ToString(CultureInfo.InvariantCulture);
            }
            case IntegrationPollingScheduleType.Cron:
            {
                var cron = NormalizeCron(value);
                return cron;
            }
            case IntegrationPollingScheduleType.HourlyAt:
            {
                var minute = ParseMinute(value);
                return minute.ToString(CultureInfo.InvariantCulture);
            }
            case IntegrationPollingScheduleType.HourlyOnTheHour:
                return string.Empty;
            case IntegrationPollingScheduleType.DailyAt:
                return ParseTime(value).ToString("HH:mm", CultureInfo.InvariantCulture);
            case IntegrationPollingScheduleType.WeeklyAt:
                if (!day.HasValue)
                    throw new ArgumentException("A weekday is required for a weekly polling schedule.");
                normalizedDay = day;
                return ParseTime(value).ToString("HH:mm", CultureInfo.InvariantCulture);
            default:
                throw new ArgumentException("Polling schedule type is not supported.");
        }
    }

    public static bool IsDue(IntegrationConnection connection, DateTimeOffset now)
    {
        if (connection.PollingScheduleType == IntegrationPollingScheduleType.EveryNMinutes)
        {
            var interval = connection.PollingIntervalMinutes > 0
                ? connection.PollingIntervalMinutes
                : ParsePositiveInteger(connection.PollingScheduleValue, 1);
            return connection.LastSyncedAt is null ||
                   connection.LastSyncedAt <= now.AddMinutes(-interval);
        }

        var occurrence = GetLatestOccurrence(connection, now);
        return occurrence.HasValue &&
               (connection.LastSyncedAt is null || connection.LastSyncedAt.Value < occurrence.Value);
    }

    public static DateTimeOffset? GetLatestOccurrence(
        IntegrationConnection connection,
        DateTimeOffset now)
    {
        var localNow = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local).DateTime;
        var localOccurrence = connection.PollingScheduleType switch
        {
            IntegrationPollingScheduleType.Cron => GetLatestCronOccurrence(
                connection.PollingScheduleValue,
                localNow),
            IntegrationPollingScheduleType.HourlyAt => GetLatestHourlyOccurrence(
                localNow,
                ParseMinuteOrNull(connection.PollingScheduleValue) ?? 0),
            IntegrationPollingScheduleType.HourlyOnTheHour => localNow.Date.AddHours(localNow.Hour),
            IntegrationPollingScheduleType.DailyAt => GetLatestDailyOccurrence(
                localNow,
                ParseTimeOrNull(connection.PollingScheduleValue) ?? TimeOnly.MinValue),
            IntegrationPollingScheduleType.WeeklyAt => GetLatestWeeklyOccurrence(
                localNow,
                connection.PollingScheduleDay ?? DayOfWeek.Monday,
                ParseTimeOrNull(connection.PollingScheduleValue) ?? TimeOnly.MinValue),
            _ => null
        };

        return localOccurrence.HasValue
            ? ToServerUtc(localOccurrence.Value)
            : null;
    }

    private static DateTime GetLatestHourlyOccurrence(DateTime localNow, int minute)
    {
        var occurrence = localNow.Date.AddHours(localNow.Hour).AddMinutes(minute);
        return occurrence > localNow ? occurrence.AddHours(-1) : occurrence;
    }

    private static DateTime GetLatestDailyOccurrence(DateTime localNow, TimeOnly time)
    {
        var occurrence = localNow.Date.Add(time.ToTimeSpan());
        return occurrence > localNow ? occurrence.AddDays(-1) : occurrence;
    }

    private static DateTime GetLatestWeeklyOccurrence(DateTime localNow, DayOfWeek day, TimeOnly time)
    {
        var daysSinceTarget = (7 + (int)localNow.DayOfWeek - (int)day) % 7;
        var occurrence = localNow.Date.AddDays(-daysSinceTarget).Add(time.ToTimeSpan());
        return occurrence > localNow ? occurrence.AddDays(-7) : occurrence;
    }

    private static DateTime? GetLatestCronOccurrence(string? value, DateTime localNow)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        CronExpression cron;
        try
        {
            cron = CronCache.GetOrAdd(value.Trim(), CronExpression.Parse);
        }
        catch (ArgumentException)
        {
            return null;
        }

        var candidate = new DateTime(
            localNow.Year,
            localNow.Month,
            localNow.Day,
            localNow.Hour,
            localNow.Minute,
            0,
            DateTimeKind.Unspecified);
        for (var index = 0; index <= CronSearchDays * 24 * 60; index++)
        {
            if (cron.Matches(candidate)) return candidate;
            candidate = candidate.AddMinutes(-1);
        }

        return null;
    }

    private static DateTimeOffset? ToServerUtc(DateTime localTime)
    {
        var unspecified = DateTime.SpecifyKind(localTime, DateTimeKind.Unspecified);
        if (TimeZoneInfo.Local.IsInvalidTime(unspecified)) return null;
        var utc = TimeZoneInfo.ConvertTimeToUtc(unspecified, TimeZoneInfo.Local);
        return new DateTimeOffset(utc, TimeSpan.Zero);
    }

    private static string NormalizeCron(string? value)
    {
        var normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length == 0)
            throw new ArgumentException("A cron schedule is required.");

        _ = CronCache.GetOrAdd(normalized, CronExpression.Parse);
        return normalized;
    }

    private static int ParseMinute(string? value)
    {
        if (!int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var minute) ||
            minute < 0 || minute > 59)
            throw new ArgumentException("Hourly schedule minute must be between 0 and 59.");
        return minute;
    }

    private static int? ParseMinuteOrNull(string? value) =>
        int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var minute) &&
        minute is >= 0 and <= 59
            ? minute
            : null;

    private static TimeOnly ParseTime(string? value)
    {
        if (!TimeOnly.TryParseExact(
                value?.Trim(),
                "HH:mm",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var time))
            throw new ArgumentException("Polling schedule time must use the HH:mm format.");
        return time;
    }

    private static TimeOnly? ParseTimeOrNull(string? value) =>
        TimeOnly.TryParseExact(
            value?.Trim(),
            "HH:mm",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out var time)
            ? time
            : null;

    private static int ParsePositiveInteger(string? value, int fallback)
    {
        return int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : fallback;
    }

    private sealed class CronExpression
    {
        private static readonly IReadOnlyDictionary<string, int> MonthNames =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                ["JAN"] = 1, ["FEB"] = 2, ["MAR"] = 3, ["APR"] = 4,
                ["MAY"] = 5, ["JUN"] = 6, ["JUL"] = 7, ["AUG"] = 8,
                ["SEP"] = 9, ["OCT"] = 10, ["NOV"] = 11, ["DEC"] = 12
            };

        private static readonly IReadOnlyDictionary<string, int> DayNames =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                ["SUN"] = 0, ["MON"] = 1, ["TUE"] = 2, ["WED"] = 3,
                ["THU"] = 4, ["FRI"] = 5, ["SAT"] = 6
            };

        private CronExpression(
            HashSet<int> minutes,
            HashSet<int> hours,
            HashSet<int> daysOfMonth,
            HashSet<int> months,
            HashSet<int> daysOfWeek)
        {
            Minutes = minutes;
            Hours = hours;
            DaysOfMonth = daysOfMonth;
            Months = months;
            DaysOfWeek = daysOfWeek;
        }

        private HashSet<int> Minutes { get; }
        private HashSet<int> Hours { get; }
        private HashSet<int> DaysOfMonth { get; }
        private HashSet<int> Months { get; }
        private HashSet<int> DaysOfWeek { get; }

        public static CronExpression Parse(string value)
        {
            var fields = value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length != 5)
                throw new ArgumentException("Cron schedule must contain five fields: minute hour day-of-month month day-of-week.");

            return new CronExpression(
                ParseField(fields[0], 0, 59),
                ParseField(fields[1], 0, 23),
                ParseField(fields[2], 1, 31),
                ParseField(fields[3], 1, 12, MonthNames),
                ParseField(fields[4], 0, 7, DayNames, normalizeSunday: true));
        }

        public bool Matches(DateTime value)
        {
            if (!Minutes.Contains(value.Minute) ||
                !Hours.Contains(value.Hour) ||
                !Months.Contains(value.Month))
                return false;

            var dayOfMonthMatches = DaysOfMonth.Contains(value.Day);
            var dayOfWeekMatches = DaysOfWeek.Contains((int)value.DayOfWeek);
            var dayOfMonthIsAny = DaysOfMonth.Count == 31;
            var dayOfWeekIsAny = DaysOfWeek.Count == 7;
            var dayMatches = dayOfMonthIsAny && dayOfWeekIsAny
                ? true
                : dayOfMonthIsAny
                    ? dayOfWeekMatches
                    : dayOfWeekIsAny
                        ? dayOfMonthMatches
                        : dayOfMonthMatches || dayOfWeekMatches;

            return dayMatches;
        }

        private static HashSet<int> ParseField(
            string field,
            int minimum,
            int maximum,
            IReadOnlyDictionary<string, int>? names = null,
            bool normalizeSunday = false)
        {
            if (string.IsNullOrWhiteSpace(field))
                throw new ArgumentException("Cron schedule contains an empty field.");

            var values = new HashSet<int>();
            foreach (var rawPart in field.Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = rawPart.Split('/');
                if (parts.Length > 2 || parts.Any(string.IsNullOrWhiteSpace))
                    throw new ArgumentException($"Cron field '{field}' contains an invalid step.");

                var step = 1;
                if (parts.Length == 2 &&
                    (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out step) || step <= 0))
                    throw new ArgumentException($"Cron field '{field}' contains an invalid step.");

                var range = parts[0];
                int start;
                int end;
                if (range == "*")
                {
                    start = minimum;
                    end = maximum;
                }
                else if (range.Contains('-', StringComparison.Ordinal))
                {
                    var bounds = range.Split('-', StringSplitOptions.None);
                    if (bounds.Length != 2 ||
                        !TryParseValue(bounds[0], names, out start) ||
                        !TryParseValue(bounds[1], names, out end))
                        throw new ArgumentException($"Cron field '{field}' contains an invalid range.");
                    if (start > end)
                        throw new ArgumentException($"Cron field '{field}' contains a descending range.");
                }
                else
                {
                    if (!TryParseValue(range, names, out start))
                        throw new ArgumentException($"Cron field '{field}' contains an invalid value.");
                    end = parts.Length == 2 ? maximum : start;
                }

                if (start < minimum || end > maximum)
                    throw new ArgumentException($"Cron field '{field}' contains a value outside {minimum}-{maximum}.");

                for (var value = start; value <= end; value += step)
                {
                    values.Add(normalizeSunday && value == 7 ? 0 : value);
                    if (value > maximum - step) break;
                }
            }

            if (values.Count == 0)
                throw new ArgumentException($"Cron field '{field}' contains no values.");
            return values;
        }

        private static bool TryParseValue(
            string value,
            IReadOnlyDictionary<string, int>? names,
            out int parsed)
        {
            if (names is not null && names.TryGetValue(value, out parsed)) return true;
            return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed);
        }
    }
}
