import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEMO_API_CONTRACT } from './demoContract.js';
import { handleDemoRequest, resetDemoState } from './demoApi.js';

async function readJavaScriptFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await readJavaScriptFiles(path));
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(path);
    }
    return files;
}

test.beforeEach(() => resetDemoState());

test('the demo adapter explicitly covers the current API-backed UI contract', async () => {
    for (const operation of DEMO_API_CONTRACT) {
        const response = await handleDemoRequest(operation.path, {
            method: operation.method,
            body: operation.body ? JSON.stringify(operation.body) : undefined
        });
        assert.equal(response.ok, true, `${operation.method} ${operation.path} returned ${response.status}`);
    }
});

test('budget contract stays on /api/settings and returns v2 groups plus compatibility rows', async () => {
    const featureWrite = DEMO_API_CONTRACT.find(operation => (
        operation.method === 'POST'
        && operation.path === '/api/settings'
        && Object.prototype.hasOwnProperty.call(operation.body || {}, 'wealthWatcherFeatureSettings')
    ));
    const budgetWrite = DEMO_API_CONTRACT.find(operation => (
        operation.method === 'POST'
        && operation.path === '/api/settings'
        && Object.prototype.hasOwnProperty.call(operation.body || {}, 'wealthWatcherBudgetSettings')
    ));
    assert.ok(featureWrite);
    assert.ok(budgetWrite);
    assert.equal(DEMO_API_CONTRACT.some(operation => operation.path === '/api/budget'), false);

    assert.equal((await handleDemoRequest(featureWrite.path, {
        method: featureWrite.method,
        body: JSON.stringify(featureWrite.body)
    })).status, 200);
    assert.equal((await handleDemoRequest(budgetWrite.path, {
        method: budgetWrite.method,
        body: JSON.stringify(budgetWrite.body)
    })).status, 200);

    const settings = await (await handleDemoRequest('/api/settings')).json();
    const budget = JSON.parse(settings.wealthWatcherBudgetSettings);
    assert.equal(budget.version, 2);
    assert.equal(budget.needsUpdate, false);
    assert.equal(budget.groups.find(group => group.name === 'Income').builtIn, true);
    assert.ok(budget.groups.filter(group => group.name !== 'Income').every(group => group.builtIn === false));
    assert.equal(budget.groups.find(group => group.name === 'Savings').items[0].category, 'Investing');
    assert.ok(budget.income.every(item => item.cadence));
    assert.equal(budget.savings.find(item => item.name === 'ISA contribution').assetId, 'asset-isa');
    assert.equal(budget.savings.find(item => item.name === 'Rainy day fund').assetId, null);
});

test('core demo response shapes remain usable by their pages', async () => {
    const dashboard = await (await handleDemoRequest('/api/dashboard?period=1M')).json();
    assert.ok(Array.isArray(dashboard.Categories));
    assert.ok(dashboard.Categories.some(category => category.Aggregate?.Data?.length));
    assert.ok(Array.isArray(dashboard.YtdCategories));
    const investmentDetails = dashboard.Categories.find(category => category.Id === 'investments')?.Aggregate?.InvestmentDetails;
    assert.ok(investmentDetails && Object.values(investmentDetails).every(positions => Array.isArray(positions)));
    const propertyDetails = dashboard.Categories.find(category => category.Id === 'property')?.Aggregate?.PropertyDetails;
    assert.ok(Array.isArray(propertyDetails?.Properties));
    const propertyHistory = dashboard.Categories.find(category => category.Id === 'property')?.Aggregate?.Data || [];
    assert.ok(propertyHistory.length > 0);
    assert.equal(typeof propertyHistory.at(-1).GrossValue, 'number');
    assert.equal(typeof propertyHistory.at(-1).Equity, 'number');

    const history = await (await handleDemoRequest('/api/history?period=1M')).json();
    assert.ok(Array.isArray(history.Categories));
    assert.ok(Array.isArray(history.Timeline));

    const calendar = await (await handleDemoRequest('/api/calendar?year=2026&month=8')).json();
    assert.ok(Array.isArray(calendar.Days));
    assert.ok(calendar.Days.every(day => typeof day.Date === 'string'));
    assert.ok(calendar.Days.some(day => day.ChangeAvailable === true));
    assert.equal(calendar.MonthComparison?.Available, true);

    const forecast = await (await handleDemoRequest('/api/wealth/forecast', {
        method: 'POST',
        body: JSON.stringify({ target: 1200000, annualReturn: 4, monthlyContribution: 1500 })
    })).json();
    assert.ok(Array.isArray(forecast.Projection));
    assert.ok(forecast.Projection.every(point => point.Values && Number.isFinite(point.Total)));

    const settings = await (await handleDemoRequest('/api/settings')).json();
    const budget = JSON.parse(settings.wealthWatcherBudgetSettings);
    assert.equal(budget.version, 2);
    assert.ok(budget.groups.every(group => group.items.every(item => (
        typeof item.id === 'string'
        && typeof item.name === 'string'
        && Number.isFinite(item.amount)
        && ['monthly', 'quarterly', 'annually'].includes(item.cadence)
        && (item.assetId === null || typeof item.assetId === 'string')
        && (item.category === null || typeof item.category === 'string')
    ))));
    assert.ok(['income', 'bills', 'savings', 'spend'].flatMap(category => budget[category] || []).every(item => (
        typeof item.id === 'string'
        && typeof item.name === 'string'
        && Number.isFinite(item.amount)
        && ['monthly', 'quarterly', 'annually'].includes(item.cadence)
        && (item.assetId === null || typeof item.assetId === 'string')
    )));
});

test('demo requests remain local and do not require live provider/API traffic', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('The browser demo must not call live fetch.');
    };
    try {
        const settings = await handleDemoRequest('/api/settings');
        const dashboard = await handleDemoRequest('/api/dashboard?period=1M');
        const forecast = await handleDemoRequest('/api/wealth/forecast', {
            method: 'POST',
            body: JSON.stringify({ target: 1200000, annualReturn: 4, monthlyContribution: 0, includedAssets: ['investments'] })
        });
        assert.equal(settings.status, 200);
        assert.equal(dashboard.status, 200);
        assert.equal(forecast.status, 200);
        assert.equal(fetchCalls, 0);
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
    }
});

test('application source has one browser-network boundary', async () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const files = await readJavaScriptFiles(sourceRoot);
    const bypasses = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/\bfetch\s*\(/.test(source) && !file.endsWith(join('api', 'apiClient.js'))) {
            bypasses.push(file);
        }
    }
    assert.deepEqual(bypasses, [], `Direct fetch calls bypass the provider: ${bypasses.join(', ')}`);
});
