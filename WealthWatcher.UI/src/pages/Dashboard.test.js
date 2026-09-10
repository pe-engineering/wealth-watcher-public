import test from 'node:test';
import assert from 'node:assert/strict';

// Helper to create mock DOM elements
function createElement(tagName = 'div') {
    const children = [];
    const eventListeners = new Map();
    const element = {
        tagName: tagName.toUpperCase(),
        innerHTML: '',
        innerText: '',
        style: {},
        className: '',
        disabled: false,
        children,
        classList: {
            add(...cls) {
                const current = element.className.split(' ').filter(Boolean);
                element.className = [...new Set([...current, ...cls])].join(' ');
            },
            remove(...cls) {
                const current = element.className.split(' ').filter(Boolean);
                element.className = current.filter(c => !cls.includes(c)).join(' ');
            }
        },
        appendChild(child) {
            children.push(child);
            return child;
        },
        setAttribute(name, val) {
            element[name] = val;
        },
        getAttribute(name) {
            return element[name] || null;
        },
        addEventListener(eventName, listener) {
            eventListeners.set(eventName, listener);
        },
        dispatchEvent(event) {
            return eventListeners.get(event.type)?.(event);
        },
        querySelector() {
            return null;
        }
    };
    return element;
}

// Registry for getElementById
const elements = new Map();
let periodButtons = [];
const documentListeners = new Map();

function getOrCreateElement(id, tagName = 'div') {
    if (!elements.has(id)) {
        elements.set(id, createElement(tagName));
    }
    return elements.get(id);
}

// Setup browser globals before importing modules
globalThis.window = globalThis;
globalThis.window.location = { hash: '' };
globalThis.window.openQuickAdd = () => {};
globalThis.window.showTooltip = () => {};
globalThis.window.hideTooltip = () => {};

globalThis.document = {
    visibilityState: 'visible',
    getElementById(id) {
        return getOrCreateElement(id);
    },
    querySelector(selector) {
        if (selector === '.period-btn.active' || selector === '#period-picker .period-btn.active') {
            return periodButtons.find(button => button.className.split(' ').includes('active'));
        }
        if (selector.startsWith('#')) {
            return getOrCreateElement(selector.slice(1));
        }
        if (selector.startsWith('.')) {
            return getOrCreateElement('mock-class-' + selector.slice(1));
        }
        return getOrCreateElement('mock-elem');
    },
    querySelectorAll(selector) {
        if (selector === '.period-btn' || selector === '#period-picker .period-btn') {
            return periodButtons;
        }
        return [getOrCreateElement('mock-query-btn', 'button')];
    },
    createElement(tagName) {
        return createElement(tagName);
    },
    addEventListener(eventName, listener) {
        documentListeners.set(eventName, listener);
    },
    dispatchEvent(event) {
        return documentListeners.get(event.type)?.(event);
    }
};

let chartConfigurations = [];
globalThis.Chart = function ChartMock(_ctx, configuration) {
    chartConfigurations.push(configuration);
    return {
        destroy() {}
    };
};

// Global fetch mock store
let mockApiResponses = {};
let fetchRequests = [];

globalThis.fetch = async (url) => {
    fetchRequests.push(url);
    if (url.includes('/dashboard')) {
        const period = new URL(url).searchParams.get('period') || '1M';
        const aggregateFor = (category, selectedPeriod) => Object.entries(mockApiResponses)
            .find(([pattern]) => pattern.includes(`/wealth/${category.Id}/aggregate?period=${selectedPeriod}`))?.[1]
            || {};
        const categories = store.state.CATEGORIES.map((category, index) => ({
            Id: category.Id,
            Label: category.Label,
            Color: category.Color,
            DisplayOrder: category.DisplayOrder || index,
            AssetGroupId: category.AssetGroupId,
            AssetGroupCode: category.AssetGroupCode,
            ClassificationValueId: category.ClassificationValueId,
            Aggregate: aggregateFor(category, period)
        }));
        const ytdCategories = store.state.CATEGORIES.map((category, index) => ({
            Id: category.Id,
            Label: category.Label,
            Color: category.Color,
            DisplayOrder: category.DisplayOrder || index,
            Aggregate: aggregateFor(category, 'YTD')
        }));
        const ytdStartTotal = ytdCategories.reduce((total, category) =>
            total + (Number(category.Aggregate?.Data?.[0]?.Value) || 0), 0);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                Period: period,
                Categories: categories,
                YtdCategories: ytdCategories,
                YtdStartTotal: ytdStartTotal,
                Timeline: []
            })
        };
    }
    for (const [pattern, response] of Object.entries(mockApiResponses)) {
        if (url.includes(pattern)) {
            return {
                ok: true,
                status: 200,
                json: async () => response
            };
        }
    }
    return {
        ok: true,
        status: 200,
        json: async () => ({})
    };
};

const { store } = await import('../store/store.js');
const {
    forceSync,
    loadDashboard,
    setupPeriodListeners,
    aggregateAssetCardHistory,
    buildAssetCardChartSeries,
    getDashboardAssetName,
    getActiveUnclassifiedAssetCount,
    renderUnclassifiedAssetBanner
} = await import('./Dashboard.js');

test('asset-card chart aggregation uses range-aware closing buckets and prefers observations', () => {
    const history = Array.from({ length: 15 }, (_, index) => ({
        Time: `2026-01-${String(index + 1).padStart(2, '0')}`,
        Value: 100 + index,
        HasObservation: index === 5
    }));

    assert.equal(aggregateAssetCardHistory(history, '1M').length, 15);

    const quarterly = aggregateAssetCardHistory(history, '3M');
    assert.equal(quarterly.length, 8);
    assert.equal(quarterly[2].Time, '2026-01-06');
    assert.equal(quarterly.at(-1).Time, '2026-01-15');

    const yearly = aggregateAssetCardHistory(history, '1Y');
    assert.equal(yearly.length, 3);
    assert.equal(yearly[0].Time, '2026-01-06');
    assert.equal(yearly.at(-1).Time, '2026-01-15');
});

test('property asset-card charts keep gross value and equity as separate series', () => {
    const history = [
        { Time: '2026-01-01', Value: 100, GrossValue: 200, Equity: 100 },
        { Time: '2026-01-02', Value: 125, GrossValue: 225, Equity: 125 }
    ];

    const series = buildAssetCardChartSeries('property', history, '#f59e0b');

    assert.equal(series.length, 2);
    assert.equal(series[0].label, 'Property value');
    assert.deepEqual(series[0].data, [200, 225]);
    assert.equal(series[1].label, 'Equity');
    assert.deepEqual(series[1].data, [100, 125]);
});

test('Dashboard shows an accessible Unclassified banner only above the threshold', () => {
    const originalAssets = store.state.assets;
    const laneSections = document.getElementById('lane-sections');
    const originalHtml = laneSections.innerHTML;

    try {
        store.state.assets = [
            { Id: 'unclassified-one', AssetKindCode: 'unclassified' },
            { Id: 'unclassified-two', AssetKindCode: 'unclassified' },
            { Id: 'archived-unclassified', AssetKindCode: 'unclassified', ArchivedAt: '2026-01-01T00:00:00Z' },
            { Id: 'classified', AssetKindCode: 'cash' }
        ];
        assert.equal(getActiveUnclassifiedAssetCount(), 2);

        laneSections.innerHTML = '<div>dashboard lanes</div>';
        renderUnclassifiedAssetBanner(1);
        assert.doesNotMatch(laneSections.innerHTML, /unclassified-assets-banner/);

        laneSections.innerHTML = '<div>dashboard lanes</div>';
        renderUnclassifiedAssetBanner(getActiveUnclassifiedAssetCount());
        assert.match(laneSections.innerHTML, /role="alert"/);
        assert.match(laneSections.innerHTML, /2 assets are Unclassified/);
        assert.match(laneSections.innerHTML, /href="#settings"/);
        assert.match(laneSections.innerHTML, /Review Asset Kinds in Settings/);
    } finally {
        store.state.assets = originalAssets;
        laneSections.innerHTML = originalHtml;
    }
});

test('Dashboard escapes dynamic labels and rejects invalid card colors', async () => {
    const originals = {
        categories: store.state.CATEGORIES,
        settings: store.state.generalSettings,
        groups: store.state.classificationGroups,
        assets: store.state.assets,
        period: store.state.currentPeriod
    };

    try {
        elements.clear();
        store.clearCache();
        chartConfigurations = [];
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { showZeroValuesOnDashboard: true, showSparklines: true };
        store.state.classificationGroups = [];
        store.state.assets = [];
        store.state.CATEGORIES = [{
            Id: 'unsafe',
            Label: '<img src=x onerror=alert(1)>',
            Color: 'red; background: url(javascript:alert(1))'
        }];
        mockApiResponses = {
            '/wealth/unsafe/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 100, Invested: 100 }],
                IsManual: true,
                LatestBreakdown: { '<script>alert(1)</script>': 100 }
            },
            '/wealth/unsafe/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 100, Invested: 100 }]
            }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 20));

        const markup = elements.get('liquid-grid').innerHTML;
        assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(markup, /<img|<script|javascript:|onmouseenter=|onmouseleave=/);
        assert.equal(chartConfigurations.at(-1)?.data?.datasets?.[0]?.borderColor, '#06b6d4');
    } finally {
        store.clearCache();
        store.state.CATEGORIES = originals.categories;
        store.state.generalSettings = originals.settings;
        store.state.classificationGroups = originals.groups;
        store.state.assets = originals.assets;
        store.state.currentPeriod = originals.period;
        mockApiResponses = {};
        chartConfigurations = [];
        fetchRequests = [];
    }
});

test('Dashboard period selection reloads aggregates for 1D', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;

    try {
        elements.clear();
        store.clearCache();
        fetchRequests = [];
        store.state.currentPeriod = '1M';
        store.state.CATEGORIES = [
            { Id: 'cash', Label: 'Cash', Color: '#10b981' }
        ];

        const oneMonthButton = createElement('button');
        oneMonthButton.className = 'period-btn active';
        oneMonthButton.setAttribute('data-period', '1M');
        const oneDayButton = createElement('button');
        oneDayButton.className = 'period-btn';
        oneDayButton.setAttribute('data-period', '1D');
        periodButtons = [oneMonthButton, oneDayButton];

        mockApiResponses = {
            '/wealth/cash/aggregate?period=1D': {
                Data: [{ Time: '2026-07-30', Value: 1000, Invested: 1000 }],
                IsManual: true,
                LatestBreakdown: { 'Current Account': 1000 }
            },
            '/wealth/cash/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }]
            }
        };

        setupPeriodListeners();
        oneDayButton.dispatchEvent({ type: 'click', target: oneDayButton });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(store.state.currentPeriod, '1D');
        assert.ok(!oneMonthButton.className.split(' ').includes('active'));
        assert.ok(oneDayButton.className.split(' ').includes('active'));
        assert.ok(fetchRequests.some(url => url.includes('/dashboard?period=1D')));
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        mockApiResponses = {};
        fetchRequests = [];
        periodButtons = [];
    }
});

test('Dashboard category cards render selected-period deltas and update them after period selection', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalSettings = store.state.generalSettings;

    try {
        elements.clear();
        store.clearCache();
        fetchRequests = [];
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: false };
        store.state.CATEGORIES = [
            { Id: 'cash', Label: 'Cash', Color: '#10b981' },
            { Id: 'pensions', Label: 'Pensions', Color: '#8b5cf6' },
            { Id: 'savings', Label: 'Savings', Color: '#f59e0b' }
        ];

        const oneMonthButton = createElement('button');
        oneMonthButton.className = 'period-btn active';
        oneMonthButton.setAttribute('data-period', '1M');
        const oneDayButton = createElement('button');
        oneDayButton.className = 'period-btn';
        oneDayButton.setAttribute('data-period', '1D');
        periodButtons = [oneMonthButton, oneDayButton];

        mockApiResponses = {
            '/wealth/cash/aggregate?period=1M': {
                Data: [
                    { Time: '2026-07-01', Value: 100, Invested: 100 },
                    { Time: '2026-07-30', Value: 120, Invested: 120 }
                ],
                IsManual: true,
                LatestBreakdown: { 'Current Account': 120 }
            },
            '/wealth/pensions/aggregate?period=1M': {
                Data: [
                    { Time: '2026-07-01', Value: 200, Invested: 200 },
                    { Time: '2026-07-30', Value: 150, Invested: 150 }
                ],
                IsManual: false,
                LatestBreakdown: { 'SIPP': 150 }
            },
            '/wealth/savings/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 500, Invested: 500 }],
                IsManual: true,
                LatestBreakdown: { 'Savings Account': 500 }
            },
            '/wealth/cash/aggregate?period=1D': {
                Data: [
                    { Time: '2026-07-30T11:00', Value: 120, Invested: 120 },
                    { Time: '2026-07-30T12:00', Value: 130, Invested: 130 }
                ],
                IsManual: true,
                LatestBreakdown: { 'Current Account': 130 }
            },
            '/wealth/pensions/aggregate?period=1D': {
                Data: [
                    { Time: '2026-07-30T11:00', Value: 150, Invested: 150 },
                    { Time: '2026-07-30T12:00', Value: 150, Invested: 150 }
                ],
                IsManual: false,
                LatestBreakdown: { 'SIPP': 150 }
            },
            '/wealth/savings/aggregate?period=1D': {
                Data: [{ Time: '2026-07-30T12:00', Value: 500, Invested: 500 }],
                IsManual: true,
                LatestBreakdown: { 'Savings Account': 500 }
            },
            '/wealth/cash/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 100, Invested: 100 }] },
            '/wealth/pensions/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 200, Invested: 200 }] },
            '/wealth/savings/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 500, Invested: 500 }] }
        };

        await loadDashboard();

        const initialHtml = elements.get('liquid-grid').innerHTML;
        assert.ok(initialHtml.includes('card-delta  obfuscate-val">+£20.00 (20.00%)'), 'positive card delta uses two decimal places');
        assert.ok(initialHtml.includes('card-delta neg obfuscate-val">-£50.00 (-25.00%)'), 'negative card delta has negative styling and text');
        assert.ok(initialHtml.includes('card-delta  obfuscate-val">+£0.00 (0.00%)'), 'zero-baseline card delta remains finite and non-negative');

        setupPeriodListeners();
        oneDayButton.dispatchEvent({ type: 'click', target: oneDayButton });
        await new Promise(resolve => setTimeout(resolve, 20));

        const dailyHtml = elements.get('liquid-grid').innerHTML;
        assert.ok(dailyHtml.includes('card-delta  obfuscate-val">+£10.00 (8.33%)'), 'card delta refreshes when the selected period changes');
        assert.ok(fetchRequests.some(url => url.includes('/dashboard?period=1D')));
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        store.state.generalSettings = originalSettings;
        mockApiResponses = {};
        fetchRequests = [];
        periodButtons = [];
    }
});

test('Dashboard breakdown filtering behavior based on hideZeroValues setting', async (t) => {
    await t.test('shows £0 value records when hideZeroValues is false (default)', async () => {
        elements.clear();
        store.clearCache();
        
        store.state.generalSettings = { hideZeroValues: false };
        store.state.CATEGORIES = [
            { Id: 'investments', Label: 'Investments', Color: '#3b82f6' }
        ];

        mockApiResponses = {
            '/wealth/investments/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 12500, Invested: 10000 }],
                IsManual: false,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: {
                    'Active Tech ETF': 12500,
                    'Closed Zero Position': 0
                }
            },
            '/wealth/investments/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 12500, Invested: 10000 }]
            }
        };

        await loadDashboard();
        await new Promise(r => setTimeout(r, 20));

        const liquidGridHtml = elements.get('liquid-grid').innerHTML;
        
        assert.ok(liquidGridHtml.includes('Active Tech ETF'), 'Active position should be displayed');
        assert.ok(liquidGridHtml.includes('Closed Zero Position'), '£0 value position should be displayed when hideZeroValues is false');
        assert.equal(elements.get('liquid-total').innerText, '£12,500.00', 'Liquid total should remain accurate');
    });

    await t.test('filters out £0 value records when hideZeroValues is true', async () => {
        elements.clear();
        store.clearCache();

        store.state.generalSettings = { hideZeroValues: true };
        store.state.CATEGORIES = [
            { Id: 'investments', Label: 'Investments', Color: '#3b82f6' }
        ];

        mockApiResponses = {
            '/wealth/investments/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 12500, Invested: 10000 }],
                IsManual: false,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: {
                    'Active Tech ETF': 12500,
                    'Closed Zero Position': 0
                }
            },
            '/wealth/investments/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 12500, Invested: 10000 }]
            }
        };

        await loadDashboard();
        await new Promise(r => setTimeout(r, 20));

        const liquidGridHtml = elements.get('liquid-grid').innerHTML;

        assert.ok(liquidGridHtml.includes('Active Tech ETF'), 'Active position should still be displayed');
        assert.ok(!liquidGridHtml.includes('Closed Zero Position'), '£0 value position should be filtered out when hideZeroValues is true');
        assert.equal(elements.get('liquid-total').innerText, '£12,500.00', 'Liquid total should remain accurate when hideZeroValues is true');
    });

    await t.test('handles multiple categories with mixed zero and non-zero balances', async () => {
        elements.clear();
        store.clearCache();

        store.state.generalSettings = { hideZeroValues: true };
        store.state.CATEGORIES = [
            { Id: 'cash', Label: 'Cash', Color: '#10b981' },
            { Id: 'pensions', Label: 'Pensions', Color: '#8b5cf6' }
        ];

        mockApiResponses = {
            '/wealth/cash/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 3000, Invested: 3000 }],
                IsManual: true,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: {
                    'Current Account': 3000,
                    'Empty Savings Pot': 0
                }
            },
            '/wealth/cash/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 3000, Invested: 3000 }]
            },
            '/wealth/pensions/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 50000, Invested: 30000 }],
                IsManual: false,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: {
                    'SIPP': 50000,
                    'Old Workplace Pension': 0
                }
            },
            '/wealth/pensions/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 50000, Invested: 30000 }]
            }
        };

        await loadDashboard();
        await new Promise(r => setTimeout(r, 20));

        const liquidGridHtml = elements.get('liquid-grid').innerHTML;

        assert.ok(liquidGridHtml.includes('Current Account'), 'Current Account should be shown');
        assert.ok(!liquidGridHtml.includes('Empty Savings Pot'), 'Empty Savings Pot (£0) should be hidden');

        assert.ok(liquidGridHtml.includes('SIPP'), 'SIPP should be shown in unassigned assets');
        assert.ok(!liquidGridHtml.includes('Old Workplace Pension'), 'Old Workplace Pension (£0) should be hidden');

        assert.equal(elements.get('liquid-total').innerText, '£53,000.00', 'Unassigned total accurate');
        assert.equal(elements.get('global-total').innerText, '£53,000.00', 'Global net worth total accurate');
    });
});

test('Dashboard hides unadded and zero-value AssetKinds and groups cards by AssetGroup', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalGroups = store.state.classificationGroups;
    const originalAssets = store.state.assets;
    const originalAssetsLoaded = store.state.assetsLoaded;
    const originalSettings = store.state.generalSettings;

    try {
        elements.clear();
        store.clearCache();
        fetchRequests = [];
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: true };
        store.state.assetsLoaded = true;
        store.state.classificationGroups = [{
            Key: 'asset-kind',
            Values: [
                { Id: 'kind-investments', Key: 'investments', DisplayName: 'Investments', AssetGroupId: 'group-liquid' },
                { Id: 'kind-property', Key: 'property', DisplayName: 'Property', AssetGroupId: 'group-illiquid' },
                { Id: 'kind-bonds', Key: 'bonds', DisplayName: 'Bonds', AssetGroupId: 'group-liquid' }
            ]
        }, {
            Key: 'asset-group',
            Values: [
                { Id: 'group-liquid', Key: 'liquid', DisplayName: 'Liquid', DisplayOrder: 1 },
                { Id: 'group-illiquid', Key: 'illiquid', DisplayName: 'Illiquid', DisplayOrder: 2 }
            ]
        }];
        store.state.assets = [
            { Id: 'asset-investments', AssetKindId: 'kind-investments', AssetKindCode: 'investments', AssetGroupCode: 'liquid' },
            { Id: 'asset-property', AssetKindId: 'kind-property', AssetKindCode: 'property', AssetGroupCode: 'illiquid' },
            { Id: 'asset-bonds', AssetKindId: 'kind-bonds', AssetKindCode: 'bonds', AssetGroupCode: 'liquid' }
        ];
        store.state.CATEGORIES = [
            { Id: 'cash', Label: 'Cash', Color: '#06b6d4', ClassificationValueId: 'kind-cash', AssetGroupCode: 'liquid' },
            { Id: 'savings', Label: 'Savings', Color: '#3b82f6', ClassificationValueId: 'kind-savings', AssetGroupCode: 'liquid' },
            { Id: 'investments', Label: 'Investments', Color: '#10b981', ClassificationValueId: 'kind-investments', AssetGroupId: 'group-liquid', AssetGroupCode: 'liquid' },
            { Id: 'property', Label: 'Property', Color: '#f59e0b', ClassificationValueId: 'kind-property', AssetGroupId: 'group-illiquid', AssetGroupCode: 'illiquid' },
            { Id: 'bonds', Label: 'Bonds', Color: '#ec4899', ClassificationValueId: 'kind-bonds', AssetGroupId: 'group-liquid', AssetGroupCode: 'liquid' },
            { Id: 'unclassified', Label: 'Unclassified', Color: '#64748b', ClassificationValueId: 'kind-unclassified' }
        ];

        mockApiResponses = {
            '/wealth/investments/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 100, Invested: 100 }],
                IsManual: false,
                LatestBreakdown: { ISA: 100 }
            },
            '/wealth/property/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 200, Invested: 0 }],
                IsManual: true,
                LatestBreakdown: { Home: 200 }
            },
            '/wealth/bonds/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 0, Invested: 0 }],
                IsManual: true,
                LatestBreakdown: {}
            },
            '/wealth/investments/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 100 }] },
            '/wealth/property/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 200 }] }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 20));

        const sections = elements.get('lane-sections').innerHTML;
        assert.match(sections, /Liquid/);
        assert.match(sections, /Illiquid/);
        assert.doesNotMatch(sections, /Cash|Savings|Bonds|Unclassified/);
        assert.ok(elements.get('liquid-grid').innerHTML.includes('Investments'));
        assert.ok(!elements.get('liquid-grid').innerHTML.includes('Bonds'));
        assert.ok(elements.get('illiquid-grid').innerHTML.includes('Property'));
        assert.ok(!fetchRequests.some(url => /\/wealth\/(cash|savings|unclassified)\//.test(url)));
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        store.state.classificationGroups = originalGroups;
        store.state.assets = originalAssets;
        store.state.assetsLoaded = originalAssetsLoaded;
        store.state.generalSettings = originalSettings;
        mockApiResponses = {};
        fetchRequests = [];
    }
});

test('Dashboard respects an explicit Asset Group assignment over the Type default', async () => {
    const originals = {
        period: store.state.currentPeriod,
        categories: store.state.CATEGORIES,
        groups: store.state.classificationGroups,
        assets: store.state.assets,
        assetsLoaded: store.state.assetsLoaded,
        settings: store.state.generalSettings
    };

    try {
        elements.clear();
        store.clearCache();
        fetchRequests = [];
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: true };
        store.state.assetsLoaded = true;
        store.state.classificationGroups = [{
            Key: 'asset-kind',
            Values: [{
                Id: 'kind-bonds',
                Key: 'bonds',
                DisplayName: 'Bonds',
                AssetGroupId: 'group-liquid'
            }]
        }, {
            Key: 'asset-group',
            Values: [
                { Id: 'group-liquid', Key: 'liquid', DisplayName: 'Liquid', DisplayOrder: 1 },
                { Id: 'group-illiquid', Key: 'illiquid', DisplayName: 'Illiquid', DisplayOrder: 2 }
            ]
        }];
        store.state.assets = [{
            Id: 'asset-bonds',
            AssetKindId: 'kind-bonds',
            AssetKindCode: 'bonds',
            AssetGroupId: 'group-illiquid',
            AssetGroupCode: 'illiquid',
            AssetGroupAssignmentSet: true
        }];
        store.state.CATEGORIES = [{
            Id: 'bonds',
            Label: 'Bonds',
            Color: '#ec4899',
            ClassificationValueId: 'kind-bonds',
            AssetGroupId: 'group-liquid',
            AssetGroupCode: 'liquid'
        }];
        mockApiResponses = {
            '/wealth/bonds/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 100, Invested: 100 }],
                IsManual: true,
                LatestBreakdown: { 'NS&I': 100 }
            },
            '/wealth/bonds/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 100 }]
            }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.doesNotMatch(elements.get('liquid-grid')?.innerHTML || '', /Bonds/);
        assert.match(elements.get('illiquid-grid')?.innerHTML || '', /Bonds/);
    } finally {
        store.clearCache();
        store.state.currentPeriod = originals.period;
        store.state.CATEGORIES = originals.categories;
        store.state.classificationGroups = originals.groups;
        store.state.assets = originals.assets;
        store.state.assetsLoaded = originals.assetsLoaded;
        store.state.generalSettings = originals.settings;
        mockApiResponses = {};
        fetchRequests = [];
    }
});

test('Dashboard splits mixed AssetKind balances across each asset group', async () => {
    const originals = {
        period: store.state.currentPeriod,
        categories: store.state.CATEGORIES,
        groups: store.state.classificationGroups,
        assets: store.state.assets,
        assetsLoaded: store.state.assetsLoaded,
        settings: store.state.generalSettings
    };

    try {
        elements.clear();
        store.clearCache();
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: false, showSparklines: false };
        store.state.assetsLoaded = true;
        store.state.classificationGroups = [{
            Key: 'asset-kind',
            Values: [{
                Id: 'kind-investments',
                Key: 'investments',
                DisplayName: 'Investments',
                AssetGroupId: 'group-liquid'
            }]
        }, {
            Key: 'asset-group',
            Values: [
                { Id: 'group-liquid', Key: 'liquid', DisplayName: 'Liquid', DisplayOrder: 1 },
                { Id: 'group-illiquid', Key: 'illiquid', DisplayName: 'Illiquid', DisplayOrder: 2 }
            ]
        }];
        store.state.assets = [
            {
                Id: 'asset-isa',
                DisplayName: 'ISA',
                AssetKindId: 'kind-investments',
                AssetKindCode: 'investments',
                AssetGroupId: 'group-liquid',
                AssetGroupCode: 'liquid',
                AssetGroupAssignmentSet: true
            },
            {
                Id: 'asset-pension',
                DisplayName: 'Pension portfolio',
                AssetKindId: 'kind-investments',
                AssetKindCode: 'investments',
                AssetGroupId: 'group-illiquid',
                AssetGroupCode: 'illiquid',
                AssetGroupAssignmentSet: true
            }
        ];
        store.state.CATEGORIES = [{
            Id: 'investments',
            Label: 'Investments',
            Color: '#10b981',
            ClassificationValueId: 'kind-investments',
            AssetGroupId: 'group-liquid',
            AssetGroupCode: 'liquid'
        }];
        mockApiResponses = {
            '/wealth/investments/aggregate?period=1M': {
                Data: [
                    {
                        Time: '2026-07-01',
                        Value: 250,
                        Invested: 200,
                        Breakdown: { ISA: 100, 'Pension portfolio': 150 }
                    },
                    {
                        Time: '2026-07-30',
                        Value: 300,
                        Invested: 240,
                        Breakdown: { ISA: 120, 'Pension portfolio': 180 }
                    }
                ],
                IsManual: true,
                LatestBreakdown: { ISA: 120, 'Pension portfolio': 180 }
            },
            '/wealth/investments/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 250, Invested: 200 }]
            }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(elements.get('liquid-total').innerText, '£120.00');
        assert.equal(elements.get('illiquid-total').innerText, '£180.00');
        assert.equal(elements.get('global-total').innerText, '£300.00');
        assert.match(elements.get('liquid-grid').innerHTML, /ISA/);
        assert.doesNotMatch(elements.get('liquid-grid').innerHTML, /Pension portfolio/);
        assert.match(elements.get('illiquid-grid').innerHTML, /Pension portfolio/);
        assert.doesNotMatch(elements.get('illiquid-grid').innerHTML, />ISA</);
    } finally {
        store.clearCache();
        store.state.currentPeriod = originals.period;
        store.state.CATEGORIES = originals.categories;
        store.state.classificationGroups = originals.groups;
        store.state.assets = originals.assets;
        store.state.assetsLoaded = originals.assetsLoaded;
        store.state.generalSettings = originals.settings;
        mockApiResponses = {};
        fetchRequests = [];
    }
});

test('Dashboard targets the live Asset Group grids after rendering the unclassified banner', async () => {
    const originals = {
        period: store.state.currentPeriod,
        categories: store.state.CATEGORIES,
        groups: store.state.classificationGroups,
        assets: store.state.assets,
        assetsLoaded: store.state.assetsLoaded,
        settings: store.state.generalSettings
    };
    elements.clear();
    store.clearCache();
    const laneSections = document.getElementById('lane-sections');
    const originalLaneDescriptor = Object.getOwnPropertyDescriptor(laneSections, 'innerHTML');
    let laneHtml = laneSections.innerHTML;

    try {
        Object.defineProperty(laneSections, 'innerHTML', {
            configurable: true,
            get: () => laneHtml,
            set: value => {
                laneHtml = value;
                elements.delete('liquid-grid');
            }
        });
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { showZeroValuesOnDashboard: true };
        store.state.assetsLoaded = true;
        store.state.classificationGroups = [{
            Key: 'asset-group',
            Values: [
                { Id: 'group-liquid', Key: 'liquid', DisplayName: 'Liquid', DisplayOrder: 1 },
                { Id: 'group-illiquid', Key: 'illiquid', DisplayName: 'Illiquid', DisplayOrder: 2 }
            ]
        }];
        store.state.assets = [
            { Id: 'cash-asset', AssetKindCode: 'cash' },
            { Id: 'unclassified-one', AssetKindCode: 'unclassified' },
            { Id: 'unclassified-two', AssetKindCode: 'unclassified' }
        ];
        store.state.CATEGORIES = [{
            Id: 'cash',
            Label: 'Cash',
            Color: '#10b981',
            ClassificationValueId: 'kind-cash',
            AssetGroupId: 'group-liquid',
            AssetGroupCode: 'liquid'
        }];
        mockApiResponses = {
            '/wealth/cash/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 1000, Invested: 1000 }],
                IsManual: true,
                LatestBreakdown: { 'Current Account': 1000 }
            },
            '/wealth/cash/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }]
            }
        };

        await loadDashboard({ force: true });

        assert.match(laneSections.innerHTML, /unclassified-assets-banner/);
        assert.match(elements.get('liquid-grid').innerHTML, /Cash/);
    } finally {
        if (originalLaneDescriptor) {
            Object.defineProperty(laneSections, 'innerHTML', originalLaneDescriptor);
        }
        store.clearCache();
        store.state.currentPeriod = originals.period;
        store.state.CATEGORIES = originals.categories;
        store.state.classificationGroups = originals.groups;
        store.state.assets = originals.assets;
        store.state.assetsLoaded = originals.assetsLoaded;
        store.state.generalSettings = originals.settings;
        mockApiResponses = {};
        fetchRequests = [];
    }
});

test('Dashboard property card renders multiple properties with shared entry and archive actions', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalSettings = store.state.generalSettings;

    try {
        elements.clear();
        store.clearCache();
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: false };
        store.state.CATEGORIES = [
            { Id: 'property', Label: 'Property', Color: '#f59e0b' }
        ];

        mockApiResponses = {
            '/wealth/property/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 220, Invested: 0 }],
                IsManual: true,
                LastSyncDateTime: '2026-07-30T12:00:00Z',
                LatestBreakdown: { Home: 120, Rental: 100 },
                PropertyDetails: {
                    Properties: [
                        { Id: 'home-id', Name: 'Home', Value: 210, Mortgage: 90, Equity: 120 },
                        { Id: 'rental-id', Name: 'Rental', Value: 300, Mortgage: 200, Equity: 100 }
                    ],
                    Totals: { Value: 510, Mortgage: 290, Equity: 220 }
                }
            },
            '/wealth/property/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 220, Invested: 0 }]
            }
        };

        await loadDashboard();
        await new Promise(resolve => setTimeout(resolve, 10));

        const html = elements.get('liquid-grid').innerHTML;
        assert.match(html, /<span class="card-label">\s*Properties\s*<div class="freshness-badge/);
        assert.ok(!html.includes('property-panel-title'));
        assert.ok(html.includes('Home'));
        assert.ok(html.includes('Rental'));
        assert.ok(!html.includes('data-property-action="add"'));
        assert.ok(html.includes('Add Property'));
        assert.ok(html.includes('data-dashboard-action="entry"'));
        assert.ok(html.includes('Add entry'));
        assert.ok(html.includes('data-property-id="home-id"'));
        assert.ok(html.includes('data-dashboard-action="archive-property"'));
        assert.match(html, /asset-archive-action icon-only property-archive-btn/);
        assert.ok(html.includes('>&times;</button>'));
        assert.ok(html.includes('£210.00'));
        assert.ok(html.includes('£300.00'));
        assert.ok(html.includes('£90.00'));
        assert.ok(html.includes('£200.00'));
        assert.ok(!html.includes('property-table-total'));
        assert.ok(!html.includes('LTV'));
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        store.state.generalSettings = originalSettings;
        mockApiResponses = {};
    }
});

test('Dashboard derives singular asset action labels dynamically', () => {
    assert.equal(getDashboardAssetName({ Id: 'categories', Label: 'Categories' }), 'Category');
    assert.equal(getDashboardAssetName({ Id: 'bonds', Label: 'Bonds' }), 'Bond');
    assert.equal(getDashboardAssetName({ Id: 'cash', Label: 'Cash', SingularName: 'Money' }), 'Money');
});

test('Dashboard asset cards place the type-specific Add action in the header without a card-level archive action', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalGroups = store.state.classificationGroups;
    const originalAssets = store.state.assets;
    const originalSettings = store.state.generalSettings;

    try {
        elements.clear();
        store.clearCache();
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: false, showSparklines: true };
        store.state.classificationGroups = [];
        store.state.assets = [{
            Id: 'asset-sipp',
            DisplayName: 'SIPP',
            Classifications: [{ Id: 'asset-pensions' }]
        }];
        store.state.CATEGORIES = [{
            Id: 'pensions',
            Label: 'Pensions',
            Color: '#8b5cf6',
            ClassificationValueId: 'asset-pensions'
        }];

        mockApiResponses = {
            '/wealth/pensions/aggregate?period=1M': {
                Data: [
                    { Time: '2026-01-01', Value: 100, Invested: 100, Breakdown: { SIPP: 100 } },
                    { Time: '2026-07-30', Value: 125, Invested: 125, Breakdown: { SIPP: 125 } }
                ],
                IsManual: true,
                LatestBreakdown: { SIPP: 125 }
            },
            '/wealth/pensions/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 100, Invested: 100 }]
            }
        };

        await loadDashboard();
        await new Promise(resolve => setTimeout(resolve, 20));

        const childHtml = elements.get('liquid-grid').innerHTML;
        assert.ok(childHtml.includes('Add Pension'));
        const childHeaderStart = childHtml.indexOf('<div class="card-header dashboard-card-header');
        const childOverviewStart = childHtml.indexOf('<div class="card-overview', childHeaderStart);
        const childHeaderHtml = childHtml.slice(childHeaderStart, childOverviewStart);
        assert.match(childHeaderHtml, /data-dashboard-card-actions[\s\S]*data-dashboard-action="entry"[\s\S]*aria-label="Add Pension"/);
        assert.doesNotMatch(childHeaderHtml, /data-dashboard-action="archive"/);
        assert.doesNotMatch(childHeaderHtml, /asset-archive-action/);
        assert.ok(childHtml.indexOf('Add Pension') < childHtml.indexOf('mini-chart-container'));
        assert.doesNotMatch(childHtml, /data-dashboard-card-archive-action/);
        assert.doesNotMatch(childHtml, /data-classification-value-id=/);
        assert.ok(childHtml.includes('data-dashboard-action="archive-child"'));
        assert.match(childHtml, /asset-entry-action/);
        assert.match(childHtml, /asset-archive-action/);
        assert.match(childHtml, /data-dashboard-card-actions/);
        assert.match(childHtml, /aria-label="Add Pension"/);
        assert.match(childHtml, /aria-label="Archive SIPP"/);
        assert.doesNotMatch(childHtml, /quick-add-val/);
        assert.ok(childHtml.indexOf('breakdown-name') < childHtml.indexOf('breakdown-val'));
        assert.ok(childHtml.indexOf('breakdown-val') < childHtml.indexOf('breakdown-sparkline'));

        elements.clear();
        store.clearCache();
        store.state.CATEGORIES = [{
            Id: 'savings',
            Label: 'Savings',
            Color: '#3b82f6',
            ClassificationValueId: 'asset-savings'
        }];
        mockApiResponses = {
            '/wealth/savings/aggregate?period=1M': {
                Data: [{ Time: '2026-07-30', Value: 0, Invested: 0 }],
                IsManual: true,
                LatestBreakdown: {}
            },
            '/wealth/savings/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 0, Invested: 0 }]
            }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 20));

        const emptyHtml = elements.get('liquid-grid').innerHTML;
        assert.ok(emptyHtml.includes('Add Saving'));
        const emptyHeaderStart = emptyHtml.indexOf('<div class="card-header dashboard-card-header');
        const emptyOverviewStart = emptyHtml.indexOf('<div class="card-overview', emptyHeaderStart);
        const emptyHeaderHtml = emptyHtml.slice(emptyHeaderStart, emptyOverviewStart);
        assert.match(emptyHeaderHtml, /data-dashboard-card-actions[\s\S]*data-dashboard-action="entry"[\s\S]*aria-label="Add Saving"/);
        assert.doesNotMatch(emptyHeaderHtml, /data-dashboard-action="archive"/);
        assert.doesNotMatch(emptyHeaderHtml, /asset-archive-action/);
        assert.doesNotMatch(emptyHtml, /data-dashboard-card-archive-action/);
        assert.doesNotMatch(emptyHtml, /card-archive-btn/);
        assert.match(emptyHtml, /class="card-header dashboard-card-header"/);
        assert.match(emptyHtml, /data-dashboard-card-header/);
        assert.match(emptyHtml, /grid-template-areas: 'heading actions'/);
        assert.ok(emptyHtml.indexOf('data-dashboard-card-actions') < emptyHtml.indexOf('mini-chart-container'));
        assert.match(emptyHtml, /aria-label="Add Saving"/);
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        store.state.classificationGroups = originalGroups;
        store.state.assets = originalAssets;
        store.state.generalSettings = originalSettings;
        mockApiResponses = {};
    }
});

test('Dashboard optional AssetGroup handling for Bonds', async (t) => {
    await t.test('renders bonds under the unassigned group when no AssetGroup is configured', async () => {
        elements.clear();
        store.clearCache();

        store.state.generalSettings = { hideZeroValues: false };
        store.state.CATEGORIES = [
            { Id: 'bonds', Label: 'Bonds', Color: '#ec4899' }
        ];

        mockApiResponses = {
            '/wealth/bonds/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 550, Invested: 550 }],
                IsManual: true,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: {
                    'NS&I': 550
                }
            },
            '/wealth/bonds/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 550, Invested: 550 }]
            }
        };

        await loadDashboard();
        await new Promise(r => setTimeout(r, 20));

        const liquidGridHtml = elements.get('liquid-grid').innerHTML;

        assert.doesNotMatch(elements.get('lane-sections').innerHTML, /Unassigned assets/);
        assert.doesNotMatch(elements.get('lane-sections').innerHTML, /Liquid Assets|Illiquid Assets/);
        assert.ok(liquidGridHtml.includes('NS&amp;I'), 'Bonds entry should be rendered in unassigned assets');
        assert.equal(elements.get('liquid-total').innerText, '£550.00', 'Unassigned total should include bonds');
    });

    await t.test('calculates liquid total combining cash and bonds', async () => {
        elements.clear();
        store.clearCache();

        store.state.generalSettings = { hideZeroValues: false };
        store.state.CATEGORIES = [
            { Id: 'cash', Label: 'Cash', Color: '#10b981' },
            { Id: 'bonds', Label: 'Bonds', Color: '#ec4899' }
        ];

        mockApiResponses = {
            '/wealth/cash/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }],
                IsManual: true,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: { 'Bank Account': 1000 }
            },
            '/wealth/cash/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }]
            },
            '/wealth/bonds/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 550, Invested: 550 }],
                IsManual: true,
                LastSyncDateTime: '2026-07-25T12:00:00Z',
                LatestBreakdown: { 'NS&I': 550 }
            },
            '/wealth/bonds/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 550, Invested: 550 }]
            }
        };

        await loadDashboard();
        await new Promise(r => setTimeout(r, 20));

        const liquidGridHtml = elements.get('liquid-grid').innerHTML;

        assert.ok(liquidGridHtml.includes('Bank Account'), 'Cash entry rendered in liquid grid');
        assert.ok(liquidGridHtml.includes('NS&amp;I'), 'Bonds entry rendered in liquid grid');
        assert.equal(elements.get('liquid-total').innerText, '£1,550.00', 'Liquid total should sum cash and bonds');
    });
});

test('Dashboard renders configured AssetGroup values without liquid or illiquid assumptions', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalGroups = store.state.classificationGroups;
    const originalSettings = store.state.generalSettings;

    try {
        elements.clear();
        store.clearCache();
        store.state.currentPeriod = '1M';
        store.state.generalSettings = { hideZeroValues: false };
        store.state.classificationGroups = [{
            Key: 'asset-group',
            DisplayName: 'AssetGroup',
            DisplayOrder: 1,
            Values: [
                { Id: 'lane-now', Key: 'now', DisplayName: 'Now', DisplayOrder: 1 },
                { Id: 'lane-later', Key: 'later', DisplayName: 'Later', DisplayOrder: 2 }
            ]
        }, {
            Key: 'asset-kind',
            Values: [
                { Id: 'asset-crypto', Key: 'crypto', DisplayName: 'Crypto', AssetGroupId: 'lane-now' }
            ]
        }];
        store.state.CATEGORIES = [{
            Id: 'crypto',
            Label: 'Crypto',
            Color: '#22c55e',
            ClassificationValueId: 'asset-crypto',
            AssetGroupId: 'lane-now',
            AssetGroupCode: 'now'
        }];

        mockApiResponses = {
            '/wealth/crypto/aggregate?period=1M': {
                Data: [{ Time: '2026-01-01', Value: 250, Invested: 250 }],
                IsManual: true,
                LatestBreakdown: { Wallet: 250 }
            },
            '/wealth/crypto/aggregate?period=YTD': {
                Data: [{ Time: '2026-01-01', Value: 250, Invested: 250 }]
            }
        };

        await loadDashboard();
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.match(elements.get('lane-sections').innerHTML, /Now/);
        assert.doesNotMatch(elements.get('lane-sections').innerHTML, /AssetGroup/);
        assert.doesNotMatch(elements.get('lane-sections').innerHTML, /Unassigned/);
        assert.ok(elements.get('lane-grid-0').innerHTML.includes('Crypto'));
        assert.doesNotMatch(elements.get('lane-sections').innerHTML, /id="lane-grid-1"/);
    } finally {
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        store.state.classificationGroups = originalGroups;
        store.state.generalSettings = originalSettings;
        mockApiResponses = {};
    }
});

test.skip('retired 1H timezone behavior', async () => {
    const originalPeriod = store.state.currentPeriod;
    const originalCategories = store.state.CATEGORIES;
    const originalObfuscation = window.isObfuscated;

    try {
        elements.clear();
        store.clearCache();
        fetchRequests = [];
        chartConfigurations = [];
        store.state.currentPeriod = '1H';
        store.state.CATEGORIES = [{ Id: 'cash', Label: 'Cash', Color: '#10b981' }];
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const hourlyData = {
            Data: [{
                Time: '2026-07-30T14:00:00+01:00',
                Value: 1200,
                Invested: 1000,
                Breakdown: { 'Current Account': 1200 }
            }],
            IsManual: true,
            LatestBreakdown: { 'Current Account': 1200 }
        };
        mockApiResponses = {
            '/wealth/cash/aggregate?period=1H': hourlyData,
            '/wealth/cash/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }] }
        };

        await loadDashboard({ force: true });
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.ok(fetchRequests.some(url => url.includes(`period=1H&timeZone=${encodeURIComponent(timeZone)}`)));
        const tooltip = chartConfigurations.at(-1).options.plugins.tooltip.callbacks;
        assert.match(tooltip.title([{ dataIndex: 0 }]), /^\d{2}:\d{2}–\d{2}:\d{2}/);
        assert.deepEqual(tooltip.label({ dataIndex: 0, raw: 1200 }), [
            'Total: £1,200.00',
            '------------------------',
            'Current Account: £1,200.00'
        ]);
        window.isObfuscated = true;
        assert.equal(tooltip.label({ dataIndex: 0, raw: 1200 }), 'Total: £***');

        store.clearCache();
        fetchRequests = [];
        store.state.currentPeriod = '1M';
        mockApiResponses['/wealth/cash/aggregate?period=1M'] = hourlyData;
        await loadDashboard({ force: true });
        assert.ok(fetchRequests.some(url => url.includes('period=1M') && !url.includes('timeZone=')));
    } finally {
        window.isObfuscated = originalObfuscation;
        store.clearCache();
        store.state.currentPeriod = originalPeriod;
        store.state.CATEGORIES = originalCategories;
        mockApiResponses = {};
        fetchRequests = [];
        chartConfigurations = [];
        updateHourlyRefreshLifecycle();
    }
});

test.skip('retired hourly refresh lifecycle', async () => {
    const originals = {
        categories: store.state.CATEGORIES,
        period: store.state.currentPeriod,
        hash: window.location.hash,
        visibility: document.visibilityState,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        clearHourlyAggregateCache: store.clearHourlyAggregateCache
    };
    const intervals = new Map();
    const timeouts = new Map();
    let timerId = 0;
    let hourlyCacheInvalidations = 0;
    const hourlyBoundaryTimers = () => [...timeouts.values()].filter(timer => timer.delay > 0);

    try {
        globalThis.setInterval = (callback, delay) => {
            const id = ++timerId;
            intervals.set(id, { callback, delay });
            return id;
        };
        globalThis.clearInterval = id => intervals.delete(id);
        globalThis.setTimeout = (callback, delay) => {
            const id = ++timerId;
            timeouts.set(id, { callback, delay });
            return id;
        };
        globalThis.clearTimeout = id => timeouts.delete(id);
        store.clearHourlyAggregateCache = function () {
            hourlyCacheInvalidations++;
            return originals.clearHourlyAggregateCache.call(this);
        };

        elements.clear();
        store.clearCache();
        fetchRequests = [];
        window.location.hash = '#dashboard';
        document.visibilityState = 'visible';
        store.state.currentPeriod = '1H';
        store.state.CATEGORIES = [{ Id: 'cash', Label: 'Cash', Color: '#10b981' }];
        mockApiResponses = {
            '/wealth/cash/aggregate?period=1H': {
                Data: [{ Time: '2026-07-30T14:00:00Z', Value: 1000, Invested: 1000 }],
                IsManual: true,
                LatestBreakdown: { 'Current Account': 1000 }
            },
            '/wealth/cash/aggregate?period=YTD': { Data: [{ Time: '2026-01-01', Value: 1000, Invested: 1000 }] },
            '/sync': {}
        };

        setupHourlyRefreshLifecycle();
        updateHourlyRefreshLifecycle({ immediate: true });
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(intervals.size, 1, 'creates one minute polling timer');
        assert.equal([...intervals.values()][0].delay, 60_000);
        assert.equal(hourlyBoundaryTimers().length, 1, 'creates one next-hour timer');
        assert.ok(hourlyBoundaryTimers()[0].delay <= 60 * 60 * 1000);
        assert.ok(!Object.keys(store.apiCache).some(key => key.includes('period=1H')));

        [...intervals.values()][0].callback();
        assert.equal(hourlyCacheInvalidations, 2, 'polling clears the hourly aggregate cache before reload');

        document.visibilityState = 'hidden';
        document.dispatchEvent({ type: 'visibilitychange' });
        assert.equal(intervals.size, 0);
        assert.equal(hourlyBoundaryTimers().length, 0);

        document.visibilityState = 'visible';
        document.dispatchEvent({ type: 'visibilitychange' });
        await Promise.resolve();
        assert.equal(intervals.size, 1, 'visibility restore restarts one polling timer');
        assert.equal(hourlyBoundaryTimers().length, 1, 'visibility restore restarts one hour-boundary timer');

        await forceSync();
        assert.ok(fetchRequests.some(url => url.includes('/sync')), 'successful manual sync refreshes the active 1H dashboard');

        window.location.hash = '#history';
        updateHourlyRefreshLifecycle();
        assert.equal(intervals.size, 0, 'leaving dashboard stops polling');
        assert.equal(hourlyBoundaryTimers().length, 0, 'leaving dashboard cancels hour-boundary timer');
    } finally {
        document.visibilityState = originals.visibility;
        window.location.hash = originals.hash;
        store.state.currentPeriod = originals.period;
        store.state.CATEGORIES = originals.categories;
        mockApiResponses = {};
        fetchRequests = [];
        globalThis.setInterval = originals.setInterval;
        globalThis.clearInterval = originals.clearInterval;
        globalThis.setTimeout = originals.setTimeout;
        globalThis.clearTimeout = originals.clearTimeout;
        store.clearHourlyAggregateCache = originals.clearHourlyAggregateCache;
        updateHourlyRefreshLifecycle();
        store.clearCache();
    }
});

