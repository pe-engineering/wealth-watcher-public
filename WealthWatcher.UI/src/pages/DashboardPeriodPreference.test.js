import test from 'node:test';
import assert from 'node:assert/strict';

const periodStorage = new Map([
    ['wealthwatcher_aggregate_period', '1W']
]);

function createButton(period) {
    const attributes = new Map([['data-period', period]]);
    const classes = new Set(['period-btn']);
    const listeners = new Map();
    return {
        classList: {
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
            }
        },
        getAttribute(name) {
            return attributes.get(name) || null;
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
        addEventListener(name, listener) {
            listeners.set(name, listener);
        },
        removeEventListener(name, listener) {
            if (listeners.get(name) === listener) listeners.delete(name);
        },
        hasClass(name) {
            return classes.has(name);
        }
    };
}

function createPicker() {
    const buttons = ['1D', '1W', '1M', '3M', 'YTD', 'MAX'].map(createButton);
    return {
        querySelectorAll(selector) {
            return selector === '[data-period]' ? buttons : [];
        },
        buttons
    };
}

const pickers = new Map([
    ['period-picker', createPicker()],
    ['history-range-picker', createPicker()]
]);

globalThis.window = globalThis;
globalThis.window.localStorage = {
    getItem(key) {
        return periodStorage.has(key) ? periodStorage.get(key) : null;
    },
    setItem(key, value) {
        periodStorage.set(key, String(value));
    }
};
globalThis.document = {
    getElementById(id) {
        return pickers.get(id) || null;
    }
};

const { store } = await import('../store/store.js');
const { setupPeriodListeners } = await import('./Dashboard.js');

test('Dashboard setup hydrates the shared period before binding controls', () => {
    store.state.currentPeriod = '1M';

    setupPeriodListeners();

    assert.equal(store.state.currentPeriod, '1W');
    for (const picker of pickers.values()) {
        const selected = picker.buttons.find(button => button.hasClass('active'));
        assert.equal(selected?.getAttribute('data-period'), '1W');
        assert.equal(selected?.getAttribute('aria-pressed'), 'true');
    }
});
