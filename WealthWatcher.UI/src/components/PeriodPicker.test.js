import test from 'node:test';
import assert from 'node:assert/strict';

function createButton(period) {
    const attributes = new Map([['data-period', period]]);
    const classes = new Set(['period-btn']);
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

globalThis.document = {
    getElementById(id) {
        return pickers.get(id) || null;
    }
};

const { syncAggregatePeriodPickers } = await import('./PeriodPicker.js');

test('syncAggregatePeriodPickers updates both route-local control groups', () => {
    assert.equal(syncAggregatePeriodPickers('1W'), '1W');

    for (const picker of pickers.values()) {
        const selected = picker.buttons.filter(button => button.hasClass('active'));
        assert.equal(selected.length, 1);
        assert.equal(selected[0].getAttribute('data-period'), '1W');
        assert.equal(selected[0].getAttribute('aria-pressed'), 'true');
        assert.equal(picker.buttons.find(button => button.getAttribute('data-period') === '1M')
            .getAttribute('aria-pressed'), 'false');
    }
});

test('syncAggregatePeriodPickers normalizes unknown values to the standard default', () => {
    assert.equal(syncAggregatePeriodPickers('not-a-period'), '1M');
    assert.ok(pickers.get('period-picker').buttons
        .find(button => button.getAttribute('data-period') === '1M')
        .hasClass('active'));
    assert.ok(pickers.get('history-range-picker').buttons
        .find(button => button.getAttribute('data-period') === '1M')
        .hasClass('active'));
});
