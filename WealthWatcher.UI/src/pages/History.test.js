import test from 'node:test';
import assert from 'node:assert/strict';

const elements = new Map();
const localStorageStore = new Map();
const historyResponses = new Map();
let historyResponseOverride = null;
let historyFailure = null;

globalThis.localStorage = {
    getItem(key) {
        return localStorageStore.has(key) ? localStorageStore.get(key) : null;
    },
    setItem(key, value) {
        localStorageStore.set(key, String(value));
    },
    clear() {
        localStorageStore.clear();
    }
};

function createElement() {
    const eventListeners = new Map();
    const element = {
        innerHTML: '',
        textContent: '',
        className: '',
        dataset: {},
        children: [],
        classList: {
            toggle(className, force) {
                const classes = element.className.split(' ').filter(Boolean);
                const hasClass = classes.includes(className);
                if (force && !hasClass) classes.push(className);
                if (!force && hasClass) classes.splice(classes.indexOf(className), 1);
                element.className = classes.join(' ');
            }
        },
        setAttribute(name, value) {
            element[name] = value;
        },
        addEventListener(eventName, listener) {
            eventListeners.set(eventName, listener);
        },
        dispatchEvent(event) {
            const listener = eventListeners.get(event.type);
            return listener?.({ ...event, currentTarget: element });
        },
        appendChild(child) {
            this.children.push(child);
        },
        getContext() {
            return {};
        }
    };
    return element;
}

globalThis.window = globalThis;
globalThis.window.location = { hostname: 'localhost' };
globalThis.window.isObfuscated = false;
globalThis.document = {
    getElementById(id) {
        if (['history-empty-state', 'history-error-state'].includes(id) && !elements.has(id)) return null;
        if (!elements.has(id)) {
            const element = createElement();
            if (['history-current-value', 'history-period-change', 'history-peak-value'].includes(id)) {
                element.className = 'history-summary-value obfuscate-val';
            }
            elements.set(id, element);
        }
        return elements.get(id);
    },
    createElement
};

globalThis.Chart = function ChartMock(_context, config) {
    return {
        config,
        destroy() {}
    };
};

const requestedUrls = [];
globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    let response = [...historyResponses.entries()]
        .find(([pattern]) => url.includes(pattern))?.[1];
    if (url.includes('/history')) {
        if (historyFailure) throw historyFailure;
        if (historyResponseOverride !== null) {
            response = historyResponseOverride;
        } else {
        const period = new URL(url).searchParams.get('period') || '1M';
        const categories = store.state.CATEGORIES.map(category => {
            const categoryResponse = historyResponses.get(`/wealth/${category.Id}/aggregate`)
                || {
                    Data: [
                        { Time: '2024-01-01', Value: category.Id === 'cash' ? 300 : 100 },
                        { Time: '2026-01-01', Value: category.Id === 'cash' ? 300 : 100 }
                    ]
                };
            return {
                Id: category.Id,
                Label: category.Label,
                Color: category.Color,
                DisplayOrder: 0,
                Aggregate: categoryResponse
            };
        });
        response = {
            Period: period,
            Categories: categories,
            Timeline: []
        };
        }
    }
    return {
        ok: true,
        json: async () => response || {
            Data: [
                { Time: '2024-01-01', Value: 100 },
                { Time: '2026-01-01', Value: 200 }
            ]
        }
    };
};

const { store } = await import('../store/store.js');
const {
    buildHistorySnapshot,
    getHistoryTrendPreference,
    HISTORY_TREND_STORAGE_KEY,
    loadHistoryView,
    setHistoryTrendPreference
} = await import('./History.js');

test('history charts use the dashboard standard 1M period by default', async () => {
    store.clearCache();
    requestedUrls.length = 0;
    store.state.CATEGORIES = [
        { Id: 'pensions', Label: 'Pensions', Color: '#8b5cf6' },
        { Id: 'cash', Label: 'Cash', Color: '#10b981' }
    ];

    await loadHistoryView();

    assert.deepEqual(requestedUrls, [
        'http://localhost:5000/api/history?period=1M'
    ]);
});

test('history exposes an explicit empty page state when no history is returned', async () => {
    store.clearCache();
    historyResponseOverride = { Categories: [], Timeline: [] };

    await loadHistoryView();

    assert.equal(elements.get('history-view').dataset.pageStatus, 'empty');
    assert.equal(elements.get('history-content').hidden, true);

    historyResponseOverride = null;
    await loadHistoryView();
    assert.equal(elements.get('history-view').dataset.pageStatus, 'ready');
});

test('history exposes an actionable error state when the request fails', async () => {
    store.clearCache();
    historyFailure = new Error('history request failed');

    await loadHistoryView();
    historyFailure = null;

    assert.equal(elements.get('history-view').dataset.pageStatus, 'error');
    assert.equal(elements.get('history-content').hidden, true);
    assert.ok(elements.get('history-view').children.some(child => child.id === 'history-error-state'));

    await loadHistoryView();
    assert.equal(elements.get('history-view').dataset.pageStatus, 'ready');
});

test('history range buttons reload the selected standard period', async () => {
    store.clearCache();
    requestedUrls.length = 0;

    await elements.get('history-range-1d').dispatchEvent({ type: 'click' });

    assert.deepEqual(requestedUrls, [
        'http://localhost:5000/api/history?period=1D'
    ]);
});

test('history values use the shared class-based obfuscation styling', async () => {
    window.isObfuscated = true;
    store.clearCache();
    requestedUrls.length = 0;
    await loadHistoryView();

    assert.equal(elements.get('history-current-value').textContent, '£400');
    assert.match(elements.get('history-current-value').className, /obfuscate-val/);
    assert.notEqual(elements.get('history-last-updated').textContent, 'Hidden in privacy mode');

    window.isObfuscated = false;
});

test('history cards escape category labels and reject invalid accent colors', async () => {
    const originalCategories = store.state.CATEGORIES;
    const originalSettings = store.state.generalSettings;

    try {
        store.clearCache();
        store.state.generalSettings = { showZeroValuesOnHistory: true };
        store.state.CATEGORIES = [{
            Id: 'unsafe',
            Label: '<img src=x onerror=alert(1)>',
            Color: 'red; background: url(javascript:alert(1))'
        }];
        historyResponses.set('/wealth/unsafe/aggregate', {
            Data: [
                { Time: '2024-01-01', Value: 100 },
                { Time: '2026-01-01', Value: 200 }
            ]
        });

        await loadHistoryView();

        const markup = elements.get('history-grid').children.at(-1).innerHTML;
        assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(markup, /--history-accent: #06b6d4/);
        assert.doesNotMatch(markup, /<img|<script|javascript:/);
    } finally {
        historyResponses.clear();
        store.clearCache();
        store.state.CATEGORIES = originalCategories;
        store.state.generalSettings = originalSettings;
    }
});

test('history filters zero values at the data boundary while preserving aligned category data', () => {
    store.state.CATEGORIES = [
        { Id: 'pensions', Label: 'Pensions', Color: '#8b5cf6' },
        { Id: 'cash', Label: 'Cash', Color: '#10b981' }
    ];
    store.state.generalSettings = { showZeroValuesOnHistory: false };

    let snapshot = buildHistorySnapshot([
        { cat: store.state.CATEGORIES[0], data: { Data: [
            { Time: '2024-01-01', Value: 0 },
            { Time: '2024-01-02', Value: 100 },
            { Time: '2024-01-03', Value: 0 }
        ] } },
        { cat: store.state.CATEGORIES[1], data: { Data: [
            { Time: '2024-01-01', Value: 0 },
            { Time: '2024-01-02', Value: 0 },
            { Time: '2024-01-03', Value: 200 }
        ] } }
    ]);

    assert.deepEqual(snapshot.dates, ['2024-01-02', '2024-01-03']);
    assert.deepEqual(snapshot.totalData, [100, 200]);
    assert.deepEqual(snapshot.categories.map(category => category.fullData), [[100, null], [null, 200]]);

    store.state.generalSettings = { showZeroValuesOnHistory: true };
    snapshot = buildHistorySnapshot([
        { cat: store.state.CATEGORIES[0], data: { Data: [{ Time: '2024-01-01', Value: 0 }] } },
        { cat: store.state.CATEGORIES[1], data: { Data: [{ Time: '2024-01-01', Value: 25 }] } }
    ]);

    assert.deepEqual(snapshot.dates, ['2024-01-01']);
    assert.deepEqual(snapshot.totalData, [25]);
    assert.deepEqual(snapshot.categories.map(category => category.fullData), [[0], [25]]);
});

test('history persists Show trend and safely falls back when storage is unavailable', async () => {
    localStorageStore.clear();
    setHistoryTrendPreference(false);

    await loadHistoryView();
    const trendButton = elements.get('history-trend-toggle');
    assert.equal(trendButton.textContent, 'Show trend');

    await trendButton.dispatchEvent({ type: 'click' });
    assert.equal(localStorageStore.get(HISTORY_TREND_STORAGE_KEY), 'true');
    assert.equal(trendButton.textContent, 'Hide trend');

    await loadHistoryView();
    assert.equal(getHistoryTrendPreference(), true);
    assert.equal(trendButton.textContent, 'Hide trend');

    const unavailableStorage = {
        getItem() {
            throw new Error('Storage unavailable');
        },
        setItem() {
            throw new Error('Storage unavailable');
        }
    };
    assert.doesNotThrow(() => {
        assert.equal(getHistoryTrendPreference(unavailableStorage), false);
        setHistoryTrendPreference(true, unavailableStorage);
    });

    localStorageStore.clear();
});

test('history Asset Breakdown hides zero-only categories by default and shows them when enabled', async () => {
    store.state.CATEGORIES = [
        { Id: 'pensions', Label: 'Pensions', Color: '#8b5cf6' },
        { Id: 'cash', Label: 'Cash', Color: '#10b981' }
    ];
    store.state.generalSettings = { showZeroValuesOnHistory: false };
    historyResponses.clear();
    historyResponses.set('/wealth/pensions/aggregate', {
        Data: [{ Time: '2024-01-01', Value: 0 }]
    });
    historyResponses.set('/wealth/cash/aggregate', {
        Data: [{ Time: '2024-01-01', Value: 25 }]
    });

    const grid = elements.get('history-grid');
    grid.children.length = 0;
    await elements.get('history-range-1m').dispatchEvent({ type: 'click' });

    assert.equal(grid.children.length, 1);
    assert.match(grid.children[0].innerHTML, /Cash/);
    assert.doesNotMatch(grid.children[0].innerHTML, /Pensions/);
    assert.doesNotMatch(grid.children[0].innerHTML, /£0/);

    store.state.generalSettings = { showZeroValuesOnHistory: true };
    grid.children.length = 0;
    await loadHistoryView();

    assert.equal(grid.children.length, 2);
    const pensionsCard = grid.children.find(card => card.innerHTML.includes('Pensions'));
    assert.ok(pensionsCard);
    assert.match(pensionsCard.innerHTML, /£0/);

    historyResponses.clear();
    store.state.generalSettings = {};
});
