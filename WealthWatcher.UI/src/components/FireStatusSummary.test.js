import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../store/store.js';
import { calculateFireSummary } from './FireModel.js';
import {
    buildFireStatusViewModel,
    formatProjectionDate,
    getFireStatusAction,
    renderFireStatusSummary,
    shouldPromptForUnallocatedBudget
} from './FireStatusSummary.js';

const originalFeatureSettings = { ...store.state.featureSettings };
const originalBudgetSettings = store.state.budgetSettings;
const originalMilestoneSettings = store.state.milestoneSettings;

test.afterEach(() => {
    store.state.featureSettings = { ...originalFeatureSettings };
    store.state.budgetSettings = originalBudgetSettings;
    store.state.milestoneSettings = originalMilestoneSettings;
});

function readySummary() {
    return calculateFireSummary({
        categories: { cash: 32000, investments: 411300, property: 31000 },
        fire: { targetIncome: 4000, swr: 4, includedAssets: ['investments'] }
    });
}

test('FIRE status card keeps the FIRE scope distinct from holistic net worth', () => {
    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true, budget: true, milestones: false };
    store.state.budgetSettings = {
        income: [{ amount: 7150 }],
        bills: [{ amount: 3000 }],
        savings: [{ amount: 1950 }],
        spend: [{ amount: 350 }]
    };
    const card = { hidden: true, innerHTML: '', dataset: {} };
    const summary = readySummary();

    renderFireStatusSummary(buildFireStatusViewModel({
        holisticNetWorth: 442500,
        fireSummary: summary,
        projection: { status: 'projected', date: '2043-02' }
    }), card);

    assert.equal(card.hidden, false);
    assert.match(card.innerHTML, /FIRE assets/);
    assert.match(card.innerHTML, /Holistic Net Worth is/);
    assert.match(card.innerHTML, /Projected FIRE date/);
    assert.match(card.innerHTML, /February 2043/);
    assert.match(card.innerHTML, /Review £1,850.00 unallocated in Budget/);
    assert.match(card.innerHTML, /class="fire-status-collapse-toggle"/);
    assert.match(card.innerHTML, /aria-controls="fire-status-card-details"/);
    assert.match(card.innerHTML, /id="fire-status-card-details"/);
    assert.doesNotMatch(card.innerHTML, /On track/);
    assert.equal(card.dataset.fireStatusState, 'ready');
});

test('FIRE status next action prioritises setup and forecast recovery', () => {
    const summary = readySummary();
    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: false, budget: true };
    assert.deepEqual(getFireStatusAction({ fireSummary: summary, projection: { status: 'projected' } }), {
        label: 'Enable Forecast',
        href: '#settings?panel=fire-settings&focus=fire-forecast-settings'
    });

    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true, budget: true };
    assert.deepEqual(getFireStatusAction({ fireSummary: summary, projection: { status: 'unreachable' } }), {
        label: 'Review Forecast assumptions',
        href: '#forecast'
    });

    const setup = calculateFireSummary({ categories: { cash: 32000 }, fire: { targetIncome: 0, swr: 4 } });
    assert.deepEqual(getFireStatusAction({ fireSummary: setup, projection: { status: 'projected' } }), {
        label: 'Configure FIRE settings',
        href: '#settings?panel=fire-settings&focus=fire-tracker-settings'
    });
});

test('FIRE status only prompts for a meaningful unallocated budget balance', () => {
    assert.equal(shouldPromptForUnallocatedBudget({ income: 5000, unallocated: 38.54 }), false);
    assert.equal(shouldPromptForUnallocatedBudget({ income: 5000, unallocated: 250 }), true);

    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true, budget: true };
    store.state.budgetSettings = {
        income: [{ amount: 5000 }],
        bills: [{ amount: 4961.46 }],
        savings: [],
        spend: []
    };
    assert.deepEqual(getFireStatusAction({ fireSummary: readySummary(), projection: { status: 'projected' } }), {
        label: 'Review FIRE plan',
        href: '#fire'
    });
});

test('FIRE status renders a setup state without inventing progress', () => {
    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true };
    const card = { hidden: true, innerHTML: '', dataset: {} };
    const summary = calculateFireSummary({ categories: { cash: 32000 }, fire: { targetIncome: 0, swr: 4 } });

    renderFireStatusSummary(buildFireStatusViewModel({
        holisticNetWorth: 32000,
        fireSummary: summary,
        projection: { status: 'pending' }
    }), card);

    assert.equal(card.hidden, false);
    assert.match(card.innerHTML, /Set up your FIRE snapshot/);
    assert.match(card.innerHTML, /class="fire-status-collapse-toggle"/);
    assert.doesNotMatch(card.innerHTML, /role="progressbar"/);
});

test('FIRE status details default closed on mobile and toggle accessibly', () => {
    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true };
    const originalMatchMedia = globalThis.matchMedia;
    const details = { hidden: false };
    const attributes = {};
    let clickHandler = null;
    const toggle = {
        textContent: '',
        setAttribute(name, value) { attributes[name] = value; },
        addEventListener(type, handler) { if (type === 'click') clickHandler = handler; }
    };
    const card = {
        hidden: true,
        innerHTML: '',
        dataset: {},
        querySelector(selector) {
            if (selector === '.fire-status-collapse-toggle') return toggle;
            if (selector === '.fire-status-card-details') return details;
            return null;
        }
    };

    try {
        globalThis.matchMedia = () => ({ matches: true });
        renderFireStatusSummary(buildFireStatusViewModel({
            holisticNetWorth: 442500,
            fireSummary: readySummary(),
            projection: { status: 'projected', date: '2043-02' }
        }), card);

        assert.equal(details.hidden, true);
        assert.equal(attributes['aria-expanded'], 'false');
        assert.equal(toggle.textContent, 'Show details');
        clickHandler();
        assert.equal(details.hidden, false);
        assert.equal(attributes['aria-expanded'], 'true');
        assert.equal(toggle.textContent, 'Hide details');
        assert.equal(card.dataset.fireStatusCollapsed, 'false');
    } finally {
        globalThis.matchMedia = originalMatchMedia;
    }
});

test('FIRE status includes holistic milestone progress in the shared card', () => {
    store.state.featureSettings = { ...originalFeatureSettings, fire: true, tracker: true, forecast: true, budget: true, milestones: true };
    store.state.milestoneSettings = { targets: [500000, 1000000] };
    const card = { hidden: true, innerHTML: '', dataset: {} };

    renderFireStatusSummary(buildFireStatusViewModel({
        holisticNetWorth: 600000,
        fireSummary: readySummary(),
        projection: { status: 'projected', date: '2043-02' }
    }), card);

    assert.match(card.innerHTML, /Next holistic milestone/);
    assert.match(card.innerHTML, /fire-status-milestone-label/);
    assert.match(card.innerHTML, /fire-status-milestone-remaining/);
    assert.match(card.innerHTML, /Holistic milestone progress/);
    assert.match(card.innerHTML, /aria-valuenow="20"/);
});

test('projection dates are formatted as month and year', () => {
    assert.equal(formatProjectionDate('2043-02'), 'February 2043');
    assert.equal(formatProjectionDate('not-a-date'), null);
});
