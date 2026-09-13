import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    location: { hostname: 'localhost', hash: '#settings' },
    addEventListener() {}
};

const originalDocument = globalThis.document;
globalThis.document = {};

const {
    clearSettingsPanelQuery,
    getDeprecatedRouteRedirect,
    getLegacyApplicationRedirect,
    getSettingsPanelTarget,
    isAggregatePeriodLoaded,
    revealSettingsPanel,
    shouldRedirectDisabledFeatureRoute
} = await import('./router.js');

test.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
});

test('settings route targets preserve the panel and optional subsection', () => {
    assert.deepEqual(getSettingsPanelTarget('#settings?panel=monthly-budget'), {
        panelId: 'monthly-budget',
        focusId: null
    });
    assert.deepEqual(getSettingsPanelTarget('#settings?panel=fire-settings&focus=fire-forecast-settings'), {
        panelId: 'fire-settings',
        focusId: 'fire-forecast-settings'
    });
    assert.equal(getSettingsPanelTarget('#settings'), null);
    assert.equal(getSettingsPanelTarget('#budget?panel=monthly-budget'), null);
});

test('retired Budget Settings deep links redirect to the Budget page', () => {
    assert.equal(getDeprecatedRouteRedirect('#settings?panel=monthly-budget'), '#budget');
    assert.equal(getDeprecatedRouteRedirect('#settings?panel=monthly-budget&focus=budget-settings-pane'), '#budget');
    assert.equal(getDeprecatedRouteRedirect('#settings?panel=fire-settings'), null);
    assert.equal(getDeprecatedRouteRedirect('#budget'), null);
});

test('disabled Budget stays on its route while other disabled feature routes fall back', () => {
    assert.equal(shouldRedirectDisabledFeatureRoute('#budget', 'budget', false), false);
    assert.equal(shouldRedirectDisabledFeatureRoute('#budget', 'budget', true), false);
    assert.equal(shouldRedirectDisabledFeatureRoute('#forecast', 'forecast', false), true);
    assert.equal(shouldRedirectDisabledFeatureRoute('#forecast', 'forecast', true), false);
    assert.equal(shouldRedirectDisabledFeatureRoute('#dashboard', null, false), false);
});

test('route freshness requires a loaded period that matches the shared selection', () => {
    assert.equal(isAggregatePeriodLoaded(true, '1W', '1W'), true);
    assert.equal(isAggregatePeriodLoaded(true, '1W', '1M'), false);
    assert.equal(isAggregatePeriodLoaded(false, '1W', '1W'), false);
    assert.equal(isAggregatePeriodLoaded(true, '1D', '1H'), true);
});

test('legacy Application settings hashes redirect to the dedicated route', () => {
    assert.equal(getLegacyApplicationRedirect('#settings?panel=application-version'), '#application');
    assert.equal(getLegacyApplicationRedirect('#settings?panel=application-version&focus=release-notes'), '#application');
    assert.equal(getLegacyApplicationRedirect('#settings?panel=monthly-budget'), null);
    assert.equal(getLegacyApplicationRedirect('#application'), null);
});

test('settings route expands a closed pane and scrolls to its requested subsection', () => {
    const attributes = {};
    const pane = {
        dataset: { paneId: 'fire-settings' },
        classList: {
            classes: new Set(['collapsed']),
            contains(name) { return this.classes.has(name); },
            add(name) { this.classes.add(name); },
            remove(name) { this.classes.delete(name); }
        },
        querySelector(selector) {
            return selector === '.collapsible-header'
                ? { setAttribute(name, value) { attributes[name] = value; } }
                : null;
        }
    };
    const section = { scrollIntoView(options) { this.options = options; } };

    globalThis.document.getElementById = id => id === 'fire-forecast-settings' ? section : null;
    globalThis.document.querySelector = selector => selector === '[data-pane-id="fire-settings"]' ? pane : null;

    const result = revealSettingsPanel({ panelId: 'fire-settings', focusId: 'fire-forecast-settings' });

    assert.equal(result, pane);
    assert.equal(pane.classList.contains('collapsed'), false);
    assert.equal(attributes['aria-expanded'], 'true');
    assert.deepEqual(section.options, { block: 'start', behavior: 'smooth' });
});

test('settings panel query is consumed after the one-time reveal', () => {
    const originalHistory = globalThis.window.history;
    const calls = [];
    globalThis.window.history = {
        state: { route: 'settings' },
        replaceState(...args) {
            calls.push(args);
        }
    };

    try {
        assert.equal(clearSettingsPanelQuery('#settings?panel=monthly-budget'), true);
        assert.deepEqual(calls, [[{ route: 'settings' }, '', '#settings']]);
        assert.equal(clearSettingsPanelQuery('#settings'), false);
        assert.equal(clearSettingsPanelQuery('#dashboard?panel=application-version'), false);
    } finally {
        if (originalHistory === undefined) delete globalThis.window.history;
        else globalThis.window.history = originalHistory;
    }
});
