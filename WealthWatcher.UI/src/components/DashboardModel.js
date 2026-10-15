export function getCurrentAggregateValue(data) {
    if (data?.Current) return Number(data.Current.Value) || 0;
    const history = data?.Data;
    if (!Array.isArray(history) || history.length === 0) return 0;
    return Number(history.at(-1)?.Value) || 0;
}

export function getAggregateBreakdown(point) {
    const breakdown = point?.Breakdown ?? point?.breakdown;
    return breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)
        ? breakdown
        : null;
}

export function calculateInvestedShare(sourceValue, sourceInvested, value) {
    const total = Number(sourceValue) || 0;
    const invested = Number(sourceInvested) || 0;
    const part = Number(value) || 0;
    if (total === 0) return 0;
    const result = invested * part / total;
    return Number.isFinite(result) ? result : 0;
}
