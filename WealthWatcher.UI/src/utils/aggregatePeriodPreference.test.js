import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AGGREGATE_PERIOD_STORAGE_KEY,
    DEFAULT_AGGREGATE_PERIOD,
    applyAggregatePeriodSelection,
    hydrateAggregatePeriodPreference,
    readAggregatePeriodPreference,
    writeAggregatePeriodPreference
} from './aggregatePeriodPreference.js';

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

test('aggregate period preference defaults safely and normalizes stored values', () => {
    const storage = createStorage();

    assert.equal(readAggregatePeriodPreference(storage), DEFAULT_AGGREGATE_PERIOD);

    storage.setItem(AGGREGATE_PERIOD_STORAGE_KEY, '1w');
    assert.equal(readAggregatePeriodPreference(storage), '1W');

    storage.setItem(AGGREGATE_PERIOD_STORAGE_KEY, '1H');
    assert.equal(readAggregatePeriodPreference(storage), '1D');

    storage.setItem(AGGREGATE_PERIOD_STORAGE_KEY, 'not-a-period');
    assert.equal(readAggregatePeriodPreference(storage), DEFAULT_AGGREGATE_PERIOD);
});

test('aggregate period preference writes only normalized supported tokens', () => {
    const storage = createStorage();

    assert.equal(writeAggregatePeriodPreference('3m', storage), '3M');
    assert.equal(storage.values.get(AGGREGATE_PERIOD_STORAGE_KEY), '3M');

    assert.equal(writeAggregatePeriodPreference('unknown', storage), DEFAULT_AGGREGATE_PERIOD);
    assert.equal(storage.values.get(AGGREGATE_PERIOD_STORAGE_KEY), DEFAULT_AGGREGATE_PERIOD);
});

test('aggregate period preference applies and hydrates the shared state', () => {
    const storage = createStorage({ [AGGREGATE_PERIOD_STORAGE_KEY]: '1W' });
    const state = { currentPeriod: '1M' };

    assert.equal(hydrateAggregatePeriodPreference(state, storage), '1W');
    assert.equal(state.currentPeriod, '1W');

    assert.equal(applyAggregatePeriodSelection('max', state, storage), 'MAX');
    assert.equal(state.currentPeriod, 'MAX');
    assert.equal(storage.values.get(AGGREGATE_PERIOD_STORAGE_KEY), 'MAX');
});

test('aggregate period preference remains usable when storage throws', () => {
    const unavailableStorage = {
        getItem() {
            throw new Error('Storage unavailable');
        },
        setItem() {
            throw new Error('Storage unavailable');
        }
    };
    const state = { currentPeriod: '1M' };

    assert.equal(readAggregatePeriodPreference(unavailableStorage), DEFAULT_AGGREGATE_PERIOD);
    assert.equal(writeAggregatePeriodPreference('1W', unavailableStorage), '1W');
    assert.equal(applyAggregatePeriodSelection('1W', state, unavailableStorage), '1W');
    assert.equal(state.currentPeriod, '1W');
});
