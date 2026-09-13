import { normalizePeriod } from '../components/PeriodPicker.js';

export const AGGREGATE_PERIOD_STORAGE_KEY = 'wealthwatcher_aggregate_period';
export const DEFAULT_AGGREGATE_PERIOD = '1M';

function getAggregatePeriodStorage() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
        if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
    } catch {
        return null;
    }
    return null;
}

/**
 * Reads the browser-local aggregate period preference without allowing storage
 * availability or malformed values to make the UI unusable.
 */
export function readAggregatePeriodPreference(storage = getAggregatePeriodStorage()) {
    try {
        return normalizePeriod(storage?.getItem(AGGREGATE_PERIOD_STORAGE_KEY), DEFAULT_AGGREGATE_PERIOD);
    } catch {
        return DEFAULT_AGGREGATE_PERIOD;
    }
}

/**
 * Persists only a normalized period token. Storage is deliberately best-effort
 * because the in-memory selection remains useful when browser storage is
 * blocked, private, or full.
 */
export function writeAggregatePeriodPreference(period, storage = getAggregatePeriodStorage()) {
    const normalized = normalizePeriod(period, DEFAULT_AGGREGATE_PERIOD);
    try {
        storage?.setItem(AGGREGATE_PERIOD_STORAGE_KEY, normalized);
    } catch {
        // Keep the current in-memory selection when localStorage is unavailable.
    }
    return normalized;
}

/**
 * Applies a selection to the shared runtime state and browser-local
 * preference in one place. The state object is injected to keep this helper
 * independent from the application store module.
 */
export function applyAggregatePeriodSelection(
    period,
    state,
    storage = getAggregatePeriodStorage()
) {
    const normalized = writeAggregatePeriodPreference(period, storage);
    if (state && typeof state === 'object') state.currentPeriod = normalized;
    return normalized;
}

/**
 * Hydrates the shared runtime period before the first page request.
 */
export function hydrateAggregatePeriodPreference(
    state,
    storage = getAggregatePeriodStorage()
) {
    const normalized = readAggregatePeriodPreference(storage);
    if (state && typeof state === 'object') state.currentPeriod = normalized;
    return normalized;
}
