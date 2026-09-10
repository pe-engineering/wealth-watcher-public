import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getDemoStore,
    getDemoState,
    handleDemoRequest,
    resetDemoState,
    resetDemoClock,
    setDemoClock
} from './demoApi.js';

const BUDGET_CATEGORIES = ['income', 'bills', 'savings', 'spend'];
const CADENCE_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };
const DEMO_STORAGE_KEY = 'wealth-watcher:live-demo-ledger:v5';
const LEGACY_DEMO_STORAGE_KEY = 'wealth-watcher:live-demo-ledger:v4';
const DEMO_BANNER_KEY = 'wealthwatcher_demo_banner_collapsed';

const monthlyAmount = item => Number(item.amount || 0) / (CADENCE_MONTHS[item.cadence] || 1);
const budgetTotals = budget => Object.fromEntries(BUDGET_CATEGORIES.map(category => [
    category,
    Number((budget[category] || []).reduce((total, item) => total + monthlyAmount(item), 0).toFixed(2))
]));
const readBudgetSettings = async () => JSON.parse(
    (await handleDemoRequest('/api/settings').then(response => response.json())).wealthWatcherBudgetSettings
);

test.beforeEach(() => {
    resetDemoState();
});

test.afterEach(() => {
    resetDemoClock();
});

test('representative reads return response-like, coherent demo data', async () => {
    const settings = await handleDemoRequest('/api/settings');
    assert.equal(settings.ok, true);
    const settingsPayload = await settings.json();
    assert.equal(typeof settingsPayload.wealthWatcherGeneralSettings, 'string');
    assert.equal(settingsPayload.wealthWatcherMilestoneSettings, '{"targets":[]}');

    const dashboard = await handleDemoRequest('http://localhost:5000/api/dashboard?period=1M');
    const payload = await dashboard.json();
    assert.equal(dashboard.status, 200);
    assert.ok(payload.Categories.length >= 3);
    assert.ok(payload.Categories.every(category => category.Aggregate.Data.length > 0));
});

test('milestone settings persist through the demo contract and reset cleanly', async () => {
    const write = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherMilestoneSettings: JSON.stringify({ targets: [600000, 500000] })
        })
    });
    assert.equal(write.ok, true);
    assert.equal(await write.text(), '');

    const settings = await (await handleDemoRequest('/api/settings')).json();
    assert.deepEqual(JSON.parse(settings.wealthWatcherMilestoneSettings), { targets: [500000, 600000] });

    const invalid = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherMilestoneSettings: JSON.stringify({ targets: [500000, 500000] })
        })
    });
    assert.equal(invalid.status, 400);

    resetDemoState();
    const resetSettings = await (await handleDemoRequest('/api/settings')).json();
    assert.deepEqual(JSON.parse(resetSettings.wealthWatcherMilestoneSettings), { targets: [] });
});

test('default budget fixture is v2-shaped, seeded with useful groups, and exposes migration guidance', async () => {
    const seededState = getDemoState();
    const storedDocument = JSON.parse(seededState.settings.wealthWatcherBudgetSettings);
    assert.equal(storedDocument.version, 2);
    assert.equal(storedDocument.needsUpdate, true);
    assert.deepEqual(storedDocument.groups.map(group => ({
        id: group.id,
        name: group.name,
        builtIn: group.builtIn
    })), [
        { id: 'income', name: 'Income', builtIn: true },
        { id: 'bills', name: 'Bills', builtIn: false },
        { id: 'savings', name: 'Savings', builtIn: false },
        { id: 'spend', name: 'Spend', builtIn: false }
    ]);
    assert.equal(storedDocument.groups.find(group => group.name === 'Bills').items.find(item => item.name === 'Mortgage').category, 'Accommodation');

    const readDocument = await readBudgetSettings();
    assert.equal(readDocument.version, 2);
    assert.equal(readDocument.needsUpdate, true);
    assert.ok(readDocument.groups.every(group => Array.isArray(group.items)));
    assert.equal(readDocument.savings.find(item => item.name === 'Index fund contribution').assetId, 'asset-isa');
});

test('budget v2 settings round-trip groups, display names, colours, categories, cadence, and asset mappings', async () => {
    const document = {
        version: 2,
        needsUpdate: false,
        groups: [
            {
                id: 'income',
                name: 'Earnings',
                kind: 'income',
                role: 'income',
                builtIn: true,
                color: '#a78bfa',
                items: [{ id: 'income-round-trip', name: 'Salary', amount: 6000, cadence: 'monthly', assetId: null, category: 'Employment' }]
            },
            {
                id: 'custom-bills',
                name: 'Household bills',
                role: 'bills',
                builtIn: false,
                color: '#123ABC',
                items: [{ id: 'mortgage-round-trip', name: 'Mortgage', amount: 1450, cadence: 'monthly', assetId: null, category: 'Accommodation' }]
            },
            {
                id: 'custom-savings',
                name: 'Future plans',
                kind: 'custom',
                builtIn: false,
                color: '#abc',
                items: [{ id: 'saving-round-trip', name: 'ISA contribution', amount: 500, cadence: 'quarterly', assetId: 'asset-isa', category: 'Investing' }]
            }
        ]
    };
    const write = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify(document) })
    });
    assert.equal(write.status, 200);

    const read = await readBudgetSettings();
    assert.equal(read.version, 2);
    assert.equal(read.needsUpdate, false);
    assert.deepEqual(read.groups, [
        {
            id: 'income',
            name: 'Earnings',
            kind: 'income',
            role: 'income',
            builtIn: true,
            color: '#a78bfa',
            items: [{ id: 'income-round-trip', name: 'Salary', amount: 6000, cadence: 'monthly', assetId: null, category: 'Employment' }]
        },
        {
            id: 'custom-bills',
            name: 'Household bills',
            kind: 'custom',
            role: 'bills',
            builtIn: false,
            color: '#123abc',
            items: [{ id: 'mortgage-round-trip', name: 'Mortgage', amount: 1450, cadence: 'monthly', assetId: null, category: 'Accommodation' }]
        },
        {
            id: 'custom-savings',
            name: 'Future plans',
            kind: 'custom',
            role: 'custom',
            builtIn: false,
            color: '#aabbcc',
            items: [{ id: 'saving-round-trip', name: 'ISA contribution', amount: 500, cadence: 'quarterly', assetId: 'asset-isa', category: 'Investing' }]
        }
    ]);
    assert.equal(read.savings[0].name, 'ISA contribution');
    assert.equal(read.savings[0].assetId, 'asset-isa');
});

test('malformed budget v2 settings are rejected atomically', async () => {
    const before = await readBudgetSettings();
    const invalid = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherBudgetSettings: JSON.stringify({
                version: 2,
                needsUpdate: false,
                groups: [
                    {
                        id: 'income',
                        name: 'Income',
                        kind: 'income',
                        role: 'income',
                        builtIn: true,
                        items: [{ id: 'duplicate', name: 'Salary', amount: 100, cadence: 'weekly', assetId: null, category: null }]
                    },
                    {
                        id: 'income',
                        name: 'Renamed income',
                        kind: 'income',
                        role: 'income',
                        builtIn: true,
                        items: []
                    }
                ]
            })
        })
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await readBudgetSettings(), before);
});

test('legacy budget reads expose needsUpdate and the chosen reset seed is restored', async () => {
    resetDemoState('legacy');
    const legacy = await readBudgetSettings();
    assert.equal(legacy.version, 1);
    assert.equal(legacy.needsUpdate, true);
    assert.ok(legacy.income.some(item => item.name === 'Legacy salary'));

    await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify({
            version: 2,
            needsUpdate: false,
            groups: [{ id: 'income', name: 'Income', kind: 'income', role: 'income', builtIn: true, items: [] }]
        }) })
    });
    resetDemoState('legacy');
    assert.equal((await readBudgetSettings()).needsUpdate, true);
    resetDemoState();
    const defaultSeed = await readBudgetSettings();
    assert.equal(defaultSeed.version, 2);
    assert.equal(defaultSeed.needsUpdate, true);
    assert.equal(defaultSeed.groups.find(group => group.name === 'Bills').items[0].name, 'Mortgage');
});

test('seed budget settings expose the production-shaped monthly plan', async () => {
    const budget = await readBudgetSettings();
    for (const category of BUDGET_CATEGORIES) {
        assert.ok(Array.isArray(budget[category]));
        assert.ok(budget[category].every(item => (
            Object.keys(item).sort().join(',') === 'amount,assetId,cadence,id,name'
        )));
        assert.ok(budget[category].every(item => item.cadence === 'monthly'));
        assert.ok(budget[category].every(item => item.name === item.name.trim()));
    }
    assert.equal(budget.savings.find(item => item.name === 'Index fund contribution').assetId, 'asset-isa');
    assert.equal(budgetTotals(budget).income, 7150);
    assert.equal(budgetTotals(budget).bills, 1870);
    assert.equal(budgetTotals(budget).savings, 1950);
    assert.equal(budgetTotals(budget).spend, 1480);
    assert.equal(7150 - 1870 - 1950 - 1480, 1850);
});

test('budget settings round-trip cadence, asset mappings, and discard derived Sankey fields', async () => {
    const write = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherFeatureSettings: JSON.stringify({ fire: true, tracker: true, forecast: true, budget: true, milestones: false }),
            wealthWatcherBudgetSettings: JSON.stringify({
                totals: { income: 999999 },
                sankey: { nodes: ['not persisted'] },
                income: [{ id: 'income-round-trip', name: '  Salary  ', amount: 6000, cadence: 'monthly', assetId: 'asset-isa', sankeyWidth: 42 }],
                bills: [{ id: 'bill-round-trip', name: 'Annual insurance', amount: 1200, cadence: 'annual' }],
                savings: [
                    { id: 'saving-linked', name: '  ISA contribution ', amount: 500, cadence: 'quarterly', assetId: 'asset-isa' },
                    { id: 'saving-unlinked', name: 'Rainy day fund', amount: 250, cadence: 'monthly', assetId: null }
                ],
                spend: [{ id: 'spend-round-trip', name: 'Groceries', amount: 450, cadence: 'monthly', assetId: null }]
            })
        })
    });
    assert.equal(write.status, 200);

    const settings = await (await handleDemoRequest('/api/settings')).json();
    assert.deepEqual(JSON.parse(settings.wealthWatcherFeatureSettings), {
        fire: true,
        tracker: true,
        forecast: true,
        budget: true,
        milestones: false
    });
    const budget = JSON.parse(settings.wealthWatcherBudgetSettings);
    assert.deepEqual(budget.income, [{ id: 'income-round-trip', name: 'Salary', amount: 6000, cadence: 'monthly', assetId: 'asset-isa' }]);
    assert.deepEqual(budget.bills, [{ id: 'bill-round-trip', name: 'Annual insurance', amount: 1200, cadence: 'annually', assetId: null }]);
    assert.deepEqual(budget.savings, [
        { id: 'saving-linked', name: 'ISA contribution', amount: 500, cadence: 'quarterly', assetId: 'asset-isa' },
        { id: 'saving-unlinked', name: 'Rainy day fund', amount: 250, cadence: 'monthly', assetId: null }
    ]);
    assert.deepEqual(budget.spend, [{ id: 'spend-round-trip', name: 'Groceries', amount: 450, cadence: 'monthly', assetId: null }]);
    assert.equal(Object.prototype.hasOwnProperty.call(budget, 'totals'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(budget, 'sankey'), false);
    assert.equal(Object.values(budget).flat().some(item => Object.prototype.hasOwnProperty.call(item, 'sankeyWidth')), false);
});

test('strict budget writes reject invalid cadence, amounts, and destinations atomically', async () => {
    const before = await readBudgetSettings();
    const write = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherBudgetSettings: JSON.stringify({
                income: [{ id: 'income-invalid', name: 'Invalid cadence', amount: 100, cadence: 'weekly' }],
                bills: [],
                savings: [],
                spend: []
            })
        })
    });
    assert.equal(write.status, 400);
    assert.deepEqual(await readBudgetSettings(), before);

    const amountWrite = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherBudgetSettings: JSON.stringify({
                income: [{ id: 'income-invalid', name: 'Invalid amount', amount: -1, cadence: 'monthly' }],
                bills: [],
                savings: [],
                spend: []
            })
        })
    });
    assert.equal(amountWrite.status, 400);
    assert.deepEqual(await readBudgetSettings(), before);

    const assetWrite = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherBudgetSettings: JSON.stringify({
                income: [],
                bills: [],
                savings: [{ id: 'saving-invalid', name: 'Unknown destination', amount: 1, cadence: 'monthly', assetId: 'missing-asset' }],
                spend: []
            })
        })
    });
    assert.equal(assetWrite.status, 400);
    assert.deepEqual(await readBudgetSettings(), before);
});

test('legacy budget rows normalize on read and retain only valid destinations', async () => {
    getDemoStore().settings.wealthWatcherBudgetSettings = JSON.stringify({
        income: [{ Name: '  Legacy salary ', Amount: '1200', Cadence: 'weekly', AssetId: 'missing-asset', Sankey: { width: 9 } }],
        Bills: [{ Name: 'Legacy bill', Amount: 300, Cadence: 'yearly' }],
        savings: [{ Name: 'Legacy saving', Amount: 100, Cadence: 'quarterly', AssetId: 'asset-cash' }],
        spend: [{ Name: 'Legacy spend', Amount: 50, Cadence: 'monthly' }],
        totals: { income: 12345 }
    });

    const budget = await readBudgetSettings();
    assert.deepEqual(budget.income, [{
        id: 'budget-income-1',
        name: 'Legacy salary',
        amount: 1200,
        cadence: 'monthly',
        assetId: null
    }]);
    assert.deepEqual(budget.bills, [{
        id: 'budget-bills-1',
        name: 'Legacy bill',
        amount: 300,
        cadence: 'annually',
        assetId: null
    }]);
    assert.equal(budget.savings[0].assetId, 'asset-cash');
    assert.equal(Object.prototype.hasOwnProperty.call(budget, 'totals'), false);
    assert.equal(Object.values(budget).flat().some(item => Object.prototype.hasOwnProperty.call(item, 'Sankey')), false);
});

test('budget fixture supports empty, cadence, funding-gap, and disabled states without losing rows', async () => {
    const emptyWrite = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify({ income: [], bills: [], savings: [], spend: [] }) })
    });
    assert.equal(emptyWrite.status, 200);
    assert.deepEqual(await readBudgetSettings(), {
        version: 1,
        needsUpdate: false,
        income: [],
        bills: [],
        savings: [],
        spend: []
    });

    const cadenceBudget = {
        income: [
            { id: 'income-monthly', name: 'Monthly income', amount: 6000, cadence: 'monthly' },
            { id: 'income-quarterly', name: 'Quarterly income', amount: 3000, cadence: 'quarterly' }
        ],
        bills: [
            { id: 'bill-monthly', name: 'Monthly bills', amount: 1800, cadence: 'monthly' },
            { id: 'bill-annual', name: 'Annual bills', amount: 1200, cadence: 'annually' }
        ],
        savings: [
            { id: 'saving-monthly', name: 'Monthly saving', amount: 300, cadence: 'monthly', assetId: null },
            { id: 'saving-annual', name: 'Annual saving', amount: 1200, cadence: 'annually', assetId: 'asset-isa' }
        ],
        spend: [
            { id: 'spend-quarterly', name: 'Quarterly spend', amount: 900, cadence: 'quarterly' },
            { id: 'spend-monthly', name: 'Monthly spend', amount: 400, cadence: 'monthly' }
        ]
    };
    const cadenceWrite = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify(cadenceBudget) })
    });
    assert.equal(cadenceWrite.status, 200);
    const cadenceTotals = budgetTotals(await readBudgetSettings());
    assert.deepEqual(cadenceTotals, { income: 7000, bills: 1900, savings: 400, spend: 700 });
    assert.equal(7000 - 1900 - 400 - 700, 4000);

    const fundingGapBudget = {
        income: [{ id: 'income-gap', name: 'Income', amount: 7150, cadence: 'monthly' }],
        bills: [{ id: 'bill-gap', name: 'Bills', amount: 1870, cadence: 'monthly' }],
        savings: [{ id: 'saving-gap', name: 'Savings', amount: 1950, cadence: 'monthly', assetId: 'asset-isa' }],
        spend: [
            { id: 'spend-gap-baseline', name: 'Planned spend', amount: 1480, cadence: 'monthly' },
            { id: 'spend-gap', name: 'Gap fixture', amount: 2000, cadence: 'monthly' }
        ]
    };
    const gapWrite = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify(fundingGapBudget) })
    });
    assert.equal(gapWrite.status, 200);
    const gapTotals = budgetTotals(await readBudgetSettings());
    assert.equal(gapTotals.spend, 3480);
    assert.equal(7150 - 1870 - 1950 - 3480, -150);

    const disabled = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherFeatureSettings: JSON.stringify({ fire: true, tracker: true, forecast: true, budget: false, milestones: false }) })
    });
    assert.equal(disabled.status, 200);
    const disabledSettings = await (await handleDemoRequest('/api/settings')).json();
    assert.equal(JSON.parse(disabledSettings.wealthWatcherFeatureSettings).budget, false);
    assert.equal(JSON.parse(disabledSettings.wealthWatcherBudgetSettings).spend.length, 2);
});

test('invalid budget input fails atomically and reset keeps unrelated localStorage preferences', async () => {
    const before = await readBudgetSettings();
    const invalid = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify({
            income: [{ name: 'Invalid amount', amount: 'not-a-number', cadence: 'monthly' }],
            bills: [],
            savings: [],
            spend: []
        }) })
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await readBudgetSettings(), before);

    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
    try {
        values.set('wealthwatcher_pane_monthly-budget', 'open');
        values.set(DEMO_BANNER_KEY, 'true');
        const saved = await handleDemoRequest('/api/settings', {
            method: 'POST',
            body: JSON.stringify({ wealthWatcherBudgetSettings: JSON.stringify({ income: [{ name: 'Temporary', amount: 10 }], bills: [], savings: [], spend: [] }) })
        });
        assert.equal(saved.status, 200);
        assert.ok(values.has(DEMO_STORAGE_KEY));
        resetDemoState();
        assert.equal(values.has(DEMO_STORAGE_KEY), false);
        assert.equal(values.has(LEGACY_DEMO_STORAGE_KEY), false);
        assert.equal(values.get('wealthwatcher_pane_monthly-budget'), 'open');
        assert.equal(values.get(DEMO_BANNER_KEY), 'true');
        assert.equal((await readBudgetSettings()).income.some(item => item.name === 'Temporary'), false);
    } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});

test('seed data provides dense history across the past year and a bit', () => {
    const state = getDemoState();
    const dates = [...new Set(state.entries.map(entry => entry.Date))].sort();
    const latestDate = new Date(`${dates.at(-1)}T12:00:00Z`);
    const earliestDate = new Date(`${dates[0]}T12:00:00Z`);
    const historyAgeDays = Math.round((latestDate - earliestDate) / (24 * 60 * 60 * 1000));
    const observationsByMonth = dates.reduce((months, date) => {
        const month = date.slice(0, 7);
        months[month] = (months[month] || 0) + 1;
        return months;
    }, {});
    const currentMonth = dates.at(-1).slice(0, 7);
    const completedMonthObservationCounts = Object.entries(observationsByMonth)
        .filter(([month]) => month !== currentMonth)
        .map(([, count]) => count);

    assert.ok(state.entries.length >= 650);
    assert.ok(dates.length >= 170);
    assert.ok(historyAgeDays >= 360);
    assert.ok(completedMonthObservationCounts.every(count => count >= 10 && count <= 20));
    for (const assetId of ['asset-isa', 'asset-pension', 'asset-home', 'asset-cash']) {
        assert.ok(state.entries.filter(entry => entry.AssetId === assetId).length >= 160);
    }

    const isaValues = state.entries
        .filter(entry => entry.AssetId === 'asset-isa')
        .sort((a, b) => a.Date.localeCompare(b.Date))
        .map(entry => entry.Value);
    const changes = isaValues.slice(1).map((value, index) => value - isaValues[index]);
    const directionChanges = changes.slice(1).filter((change, index) => (
        Math.sign(change) !== 0 &&
        Math.sign(changes[index]) !== 0 &&
        Math.sign(change) !== Math.sign(changes[index])
    ));
    assert.ok(changes.some(change => change > 0));
    assert.ok(changes.some(change => change < 0));
    assert.ok(directionChanges.length >= 3);
});

test('generated demo history is date-relative and stays inside the target value band', async () => {
    setDemoClock('2026-09-09T12:00:00Z');
    resetDemoState();

    const state = getDemoState();
    const generatedIds = new Set(state.demoMeta.generatedEntryIds);
    const history = await (await handleDemoRequest('/api/history?period=MAX')).json();
    const generatedEntries = state.entries.filter(entry => generatedIds.has(entry.Id));
    const generatedDates = [...new Set(generatedEntries.map(entry => entry.Date))].sort();
    const totals = history.Timeline.map(point => point.Value);

    assert.equal(state.demoMeta.generatedAsOf, '2026-09-09');
    assert.equal(generatedDates.at(-1), '2026-09-09');
    assert.ok(generatedDates[0] >= '2025-09-09');
    assert.ok(generatedDates.length >= 170);
    assert.ok(Math.min(...totals) >= 400000);
    assert.ok(Math.max(...totals) <= 500000);
    assert.ok(totals.some((value, index) => index > 0 && value > totals[index - 1]));
    assert.ok(totals.some((value, index) => index > 0 && value < totals[index - 1]));
});

test('Day dashboard data uses hourly buckets within configured market hours', async () => {
    setDemoClock('2026-09-09T12:30:00Z');
    resetDemoState();

    const dashboard = await (await handleDemoRequest('/api/dashboard?period=1D')).json();
    const investment = dashboard.Categories.find(category => category.Id === 'investments');
    const points = investment.Aggregate.Data;
    const expectedLastHour = new Date('2026-09-09T12:30:00Z').getHours();

    assert.equal(points[0].Time, '2026-09-09T08:00:00');
    assert.equal(points.at(-1).Time, `2026-09-09T${String(expectedLastHour).padStart(2, '0')}:00:00`);
    assert.equal(points.length, expectedLastHour - 7);
});

test('date rollover replaces only generated rows and preserves user entries', async () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
    try {
        setDemoClock('2026-09-09T12:00:00Z');
        resetDemoState();
        const manual = await handleDemoRequest('/api/wealth', {
            method: 'POST',
            body: JSON.stringify({
                Type: 'cash',
                AssetId: 'asset-cash',
                Name: 'Emergency Cash',
                Value: 42000,
                Date: '2026-09-01'
            })
        });
        assert.equal(manual.status, 201);
        const manualEntry = await manual.json();
        assert.ok(values.has(DEMO_STORAGE_KEY));

        setDemoClock('2026-09-10T12:00:00Z');
        const dashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
        const state = getDemoState();
        const generatedIds = new Set(state.demoMeta.generatedEntryIds);

        assert.equal(state.demoMeta.generatedAsOf, '2026-09-10');
        assert.ok(state.entries.some(entry => entry.Id === manualEntry.Id));
        assert.ok(state.entries.filter(entry => generatedIds.has(entry.Id)).every(entry => entry.Date <= '2026-09-10'));
        assert.equal(dashboard.LastSyncDateTime.slice(0, 10), '2026-09-10');
        assert.equal(JSON.parse(state.settings.wealthWatcherBudgetSettings).version, 2);
        assert.equal(JSON.parse(values.get(DEMO_STORAGE_KEY)).demoMeta.generatedAsOf, '2026-09-10');
    } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});

test('seed forecast settings provide a birth date and a reachable target date', async () => {
    const settings = await (await handleDemoRequest('/api/settings')).json();
    const forecastSettings = JSON.parse(settings.wealthWatcherForecastSettings);
    assert.match(forecastSettings.dateOfBirth, /^\d{4}-\d{2}-\d{2}$/);

    const forecast = await (await handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({
            target: 1200000,
            annualReturn: forecastSettings.annualReturn,
            monthlyContribution: 0,
            includedAssets: ['investments', 'pensions', 'property']
        })
    })).json();
    assert.ok(forecast.TargetHitMonth > 0);
    assert.match(forecast.TargetHitDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('future-dated snapshots are excluded from dashboard and forecast current values', async () => {
    const request = {
        method: 'POST',
        body: JSON.stringify({
            target: 1000000000,
            annualReturn: 0,
            monthlyContribution: 0,
            includedAssets: ['investments']
        })
    };
    const before = await (await handleDemoRequest('/api/wealth/forecast', request)).json();
    const write = await handleDemoRequest('/api/wealth', {
        method: 'POST',
        body: JSON.stringify({
            Type: 'investments',
            AssetId: 'asset-isa',
            Name: 'Stocks & Shares ISA',
            Value: 999999,
            Date: '2099-01-01',
            Time: '12:00:00'
        })
    });
    assert.equal(write.status, 201);

    const after = await (await handleDemoRequest('/api/wealth/forecast', request)).json();
    const dashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
    const investments = dashboard.Categories.find(category => category.Id === 'investments').Aggregate;
    assert.equal(after.CurrentNW, before.CurrentNW);
    assert.equal(investments.Data.at(-1).Value, before.CurrentNW);
    assert.notEqual(investments.LatestBreakdown['Stocks & Shares ISA'], 999999);
});

test('forecast keeps future windfalls out of current net worth and applies them in the first period', async () => {
    const now = new Date();
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    if (now.getUTCDate() >= lastDay) return;
    const futureDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
        .toISOString().slice(0, 10);
    const forecastRequest = windfalls => handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({
            target: 1000000000,
            annualReturn: 0,
            monthlyContribution: 0,
            includedAssets: ['investments'],
            windfalls
        })
    });
    const withoutWindfall = await (await forecastRequest([])).json();
    const future = await (await forecastRequest([{ Amount: 50000, ExpectedDate: futureDate, IncludeInCalculation: true }])).json();
    const pastDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
        .toISOString().slice(0, 10);
    const past = await (await forecastRequest([{ Amount: 50000, ExpectedDate: pastDate, IncludeInCalculation: true }])).json();

    assert.equal(future.CurrentNW, withoutWindfall.CurrentNW);
    assert.equal(future.Projection[0].Values['Unallocated Windfalls'], 0);
    assert.ok(future.Projection.some(point => point.Values['Unallocated Windfalls'] >= 50000));
    assert.equal(past.CurrentNW, withoutWindfall.CurrentNW + 50000);
});

test('forecast applies linked contributions using their configured cadence', async () => {
    const makeForecast = contributions => handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({
            target: 1000000000,
            annualReturn: 0,
            monthlyContribution: 0,
            includedAssets: ['investments'],
            contributions
        })
    });
    const baseline = await (await makeForecast([])).json();
    const monthly = await (await makeForecast([{ amount: 100, assetId: 'asset-isa', cadence: 'monthly' }])).json();
    const quarterly = await (await makeForecast([{ amount: 100, assetId: 'asset-isa', cadence: 'quarterly' }])).json();
    const annually = await (await makeForecast([{ amount: 1200, assetId: 'asset-isa', cadence: 'annually' }])).json();
    const baselineJanuary = baseline.Projection.find((point, index) => index > 0 && point.Date.endsWith('-01-01'))
        || baseline.Projection.at(-1);
    const monthlyJanuary = monthly.Projection.find(point => point.Date === baselineJanuary.Date);
    const quarterlyJanuary = quarterly.Projection.find(point => point.Date === baselineJanuary.Date);
    const annualJanuary = annually.Projection.find(point => point.Date === baselineJanuary.Date);

    assert.ok(monthlyJanuary.Values.Investments > quarterlyJanuary.Values.Investments);
    assert.ok(quarterlyJanuary.Values.Investments > baselineJanuary.Values.Investments);
    assert.ok(annualJanuary.Values.Investments > quarterlyJanuary.Values.Investments);
});

test('demo settings preserve intentional zero values and tolerate malformed JSON', async () => {
    const saved = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
            wealthWatcherFireSettings: JSON.stringify({ targetIncome: 0, swr: 0, statePensionAmount: 0 }),
            wealthWatcherForecastSettings: JSON.stringify({ annualReturn: 0, monthlyContribution: 0 }),
            wealthWatcherBudgetSettings: JSON.stringify({ income: [], bills: [], savings: [{ name: 'Zero saving', amount: 0, cadence: 'annually' }], spend: [] })
        })
    });
    assert.equal(saved.status, 200);
    const settings = await (await handleDemoRequest('/api/settings')).json();
    assert.deepEqual(JSON.parse(settings.wealthWatcherFireSettings), { targetIncome: 0, swr: 0, statePensionAmount: 0 });
    assert.deepEqual(JSON.parse(settings.wealthWatcherForecastSettings), { annualReturn: 0, monthlyContribution: 0 });

    const malformed = await handleDemoRequest('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ wealthWatcherForecastSettings: 'not-json' })
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse((await (await handleDemoRequest('/api/settings')).json()).wealthWatcherForecastSettings), {
        annualReturn: 0,
        monthlyContribution: 0
    });

    getDemoStore().settings.wealthWatcherForecastSettings = '[]';
    const safeSettings = await (await handleDemoRequest('/api/settings')).json();
    assert.equal(safeSettings.wealthWatcherForecastSettings, '{}');
    const forecast = await handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({ target: 0, annualReturn: 0, monthlyContribution: 0, includedAssets: ['investments'] })
    });
    assert.equal(forecast.status, 200);
    assert.equal((await forecast.json()).TargetHitMonth, 0);
});

test('demo returns API-like validation responses for invalid financial requests', async () => {
    const property = await handleDemoRequest('/api/properties', {
        method: 'POST',
        body: JSON.stringify({ Name: 'Invalid rental', Value: -1, Mortgage: 0 })
    });
    assert.equal(property.status, 400);

    const genericProperty = await handleDemoRequest('/api/wealth', {
        method: 'POST',
        body: JSON.stringify({ Type: 'property', AssetId: 'asset-home', Name: 'Primary Home', Value: 1, Mortgage: -1 })
    });
    assert.equal(genericProperty.status, 400);

    const invalidForecast = await handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({ Target: 100, IncludedAssets: null, Contributions: null, Windfalls: null })
    });
    assert.equal(invalidForecast.status, 400);

    const nullCollections = await handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({ Target: 100, IncludedAssets: ['investments'], Contributions: null, Windfalls: null })
    });
    assert.equal(nullCollections.status, 200);

    const invalidJson = await handleDemoRequest('/api/wealth/forecast', { method: 'POST', body: '{' });
    assert.equal(invalidJson.status, 400);
});

test('demo aggregates same-name entries instead of dropping the later asset', async () => {
    const beforeDashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
    const beforeBreakdown = beforeDashboard.Categories.find(category => category.Id === 'investments').Aggregate.LatestBreakdown;
    const created = await handleDemoRequest('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ DisplayName: 'Second ISA', AssetKindId: 'kind-investments' })
    });
    const asset = await created.json();
    const today = new Date().toISOString().slice(0, 10);
    await handleDemoRequest('/api/wealth', {
        method: 'POST',
        body: JSON.stringify({ Type: 'cash', AssetId: asset.Id, Name: 'Stocks & Shares ISA', Value: 123, Date: today, Time: '00:00:00' })
    });

    const dashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
    const breakdown = dashboard.Categories.find(category => category.Id === 'investments').Aggregate.LatestBreakdown;
    assert.equal(breakdown['Stocks & Shares ISA'], beforeBreakdown['Stocks & Shares ISA'] + 123);
});

test('demo keeps explicit per-asset groups available for mixed-group dashboard splitting', async () => {
    const reassigned = await handleDemoRequest('/api/assets/asset-isa', {
        method: 'PATCH',
        body: JSON.stringify({ AssetGroupId: 'group-property' })
    });
    assert.equal(reassigned.status, 200);

    const assets = await (await handleDemoRequest('/api/assets')).json();
    const isa = assets.find(asset => asset.Id === 'asset-isa');
    const created = await handleDemoRequest('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ DisplayName: 'Second ISA', AssetKindId: 'kind-investments', AssetGroupId: 'group-investments' })
    });
    const secondIsa = await created.json();
    await handleDemoRequest('/api/wealth', {
        method: 'POST',
        body: JSON.stringify({ Type: 'investments', AssetId: secondIsa.Id, Name: 'Second ISA', Value: 123, Date: new Date().toISOString().slice(0, 10), Time: '00:00:00' })
    });
    const assetsAfter = await (await handleDemoRequest('/api/assets')).json();
    const secondIsaRead = assetsAfter.find(asset => asset.Id === secondIsa.Id);
    assert.equal(isa.AssetGroupId, 'group-property');
    assert.equal(secondIsaRead.AssetGroupId, 'group-investments');

    const dashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
    const aggregate = dashboard.Categories.find(category => category.Id === 'investments').Aggregate;
    assert.ok(aggregate.LatestBreakdown['Stocks & Shares ISA'] > 0);
    assert.equal(aggregate.LatestBreakdown['Second ISA'], 123);
    assert.equal(
        Object.values(aggregate.LatestBreakdown).reduce((total, value) => total + value, 0),
        aggregate.Data.at(-1).Value
    );
});

test('writes update the shared ledger and are visible through later reads', async () => {
    const before = await (await handleDemoRequest('/api/assets')).json();
    const created = await handleDemoRequest('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ DisplayName: 'Demo ISA', AssetKindId: 'kind-investments' })
    });
    const createdAsset = await created.json();
    assert.equal(created.status, 201);

    const after = await (await handleDemoRequest('/api/assets')).json();
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1).Id, createdAsset.Id);

    await handleDemoRequest('/api/wealth', {
        method: 'POST',
        body: JSON.stringify({ Type: 'investments', AssetId: createdAsset.Id, Name: 'Demo ISA', Value: 12345, Date: new Date().toISOString().slice(0, 10), Time: '12:00:00' })
    });
    const names = await (await handleDemoRequest('/api/wealth/investments/names')).json();
    assert.ok(names.some(item => item.Id === createdAsset.Id));
});

test('reset restores the initial state after mutations', async () => {
    await handleDemoRequest('/api/assets', { method: 'POST', body: JSON.stringify({ DisplayName: 'Temporary', AssetKindId: 'kind-cash' }) });
    assert.equal((await (await handleDemoRequest('/api/assets')).json()).some(asset => asset.DisplayName === 'Temporary'), true);
    resetDemoState();
    assert.equal((await (await handleDemoRequest('/api/assets')).json()).some(asset => asset.DisplayName === 'Temporary'), false);
    assert.equal(getDemoState().integrations.length, 0);
});

test('unsupported routes and methods fail loudly with route context', async () => {
    await assert.rejects(
        () => handleDemoRequest('/api/not-an-endpoint'),
        /Unsupported demo GET route: \/not-an-endpoint/
    );
    await assert.rejects(
        () => handleDemoRequest('/api/dashboard', { method: 'DELETE' }),
        /Unsupported demo DELETE route: \/dashboard/
    );
});
