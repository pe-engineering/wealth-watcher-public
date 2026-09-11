import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

globalThis.window = globalThis;
globalThis.window.location = { hostname: 'localhost' };

const elements = new Map();
const documentListeners = new Map();
const fetchRequests = [];
const integrationConnections = [
    {
        Id: 'connection-1',
        ProviderKey: 'snaptrade',
        DisplayName: 'SnapTrade ISA',
        Status: 'NeedsCredentials',
        SyncMode: 'Polling',
        PollingIntervalMinutes: 180,
        Enabled: false,
        OnlyPollDuringMarketTimes: true,
        Accounts: []
    },
    {
        Id: 'connection-2',
        ProviderKey: 'snaptrade',
        DisplayName: 'SnapTrade Invest',
        Status: 'NeedsCredentials',
        PollingIntervalMinutes: 180,
        Enabled: false,
        Accounts: []
    },
    {
        Id: 'connection-3',
        ProviderKey: 'trading212',
        DisplayName: 'Trading 212 ISA',
        Status: 'Active',
        SyncMode: 'Polling',
        PollingIntervalMinutes: 180,
        Enabled: true,
        OnlyPollDuringMarketTimes: true,
        Accounts: []
    }
];
const integrationAssets = [];
let webhookRelayResponse = {
    Enabled: true,
    Connected: true,
    RelayUrl: 'wss://relay.example.com/ws',
    RelayPublicBaseUrl: 'https://relay.example.com',
    LastConnectedAt: '2026-09-02T10:00:00Z',
    LastMessageAt: '2026-09-02T10:05:00Z'
};

function createElement(tagName = 'div') {
    const listeners = new Map();
    const attributes = new Map();
    const children = [];
    const classNames = new Set();
    const element = {
        tagName: tagName.toUpperCase(),
        dataset: {},
        hidden: false,
        innerHTML: '',
        children,
        classList: {
            add(...names) { names.forEach(name => classNames.add(name)); },
            remove(...names) { names.forEach(name => classNames.delete(name)); },
            contains(name) { return classNames.has(name); }
        },
        append(...items) {
            children.push(...items.filter(Boolean));
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
            this[name === 'aria-hidden' ? 'ariaHidden' : name] = String(value);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        hasAttribute(name) {
            if (attributes.has(name)) return true;
            const datasetKey = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            return name.startsWith('data-') && this.dataset[datasetKey] !== undefined;
        },
        closest(selector) {
            return selector === 'button' && this.tagName === 'BUTTON' ? this : null;
        },
        focus() {
            this.focused = true;
        },
        querySelector(selector) {
            if (selector === '[data-integration-close]') {
                const match = children.find(child => child.dataset?.integrationClose);
                if (match) return match;
            }
            if (selector.startsWith('#')) {
                const match = children.find(child => child.id === selector.slice(1));
                if (match) return match;
            }
            for (const child of children) {
                const match = child.querySelector?.(selector);
                if (match) return match;
            }
            return null;
        },
        addEventListener(type, listener) {
            const typeListeners = listeners.get(type) || [];
            typeListeners.push(listener);
            listeners.set(type, typeListeners);
        },
        dispatch(type, event) {
            let result;
            for (const listener of listeners.get(type) || []) result = listener(event);
            return result;
        }
    };
    return element;
}

for (const id of [
    'integration-settings-pane',
    'integration-webhook-relay',
    'integration-market-hours',
    'integration-catalog',
    'integration-connections',
    'integration-wizard',
    'integration-wizard-body',
    'integration-wizard-steps'
]) {
    elements.set(id, createElement());
}

globalThis.document = {
    getElementById(id) {
        return elements.get(id) ?? null;
    },
    createElement(tagName) {
        return createElement(tagName);
    },
    addEventListener(type, listener) {
        documentListeners.set(type, listener);
    }
};

globalThis.fetch = async (url, options = {}) => {
    fetchRequests.push({ url, options });

    if (url.endsWith('/integrations/connection-1/credentials')) return response({});
    if (url.endsWith('/integrations/connection-1/test')) {
        return response({ Succeeded: true, Message: 'Test passed.' });
    }
    if (url.endsWith('/integrations/webhook-relay/settings')) {
        const body = JSON.parse(options.body || '{}');
        webhookRelayResponse = { ...webhookRelayResponse, Enabled: body.Enabled === true, Configured: true, CanToggle: true, CanTest: body.Enabled === true };
        if (body.Enabled !== true) {
            integrationConnections.forEach(connection => {
                if (connection.SyncMode === 'Webhook') connection.SyncMode = 'Polling';
            });
        }
        return response(webhookRelayResponse);
    }
    if (url.endsWith('/integrations/webhook-relay/test')) {
        return response({ Succeeded: true, Message: 'Relay test passed.' });
    }

    if (url.endsWith('/integrations/catalog')) {
        return response([
            {
                Key: 'trading212',
                DisplayName: 'Trading 212',
                Description: 'Trading accounts',
                CredentialFields: [],
                OptionFields: []
            },
            {
                Key: 'snaptrade',
                DisplayName: 'SnapTrade',
                Description: 'Brokerage accounts',
                SupportsWebhooks: true,
                CredentialFields: [],
                OptionFields: []
            }
        ]);
    }

    if (url.endsWith('/integrations/webhook-relay/status')) {
        return response(webhookRelayResponse);
    }

    if (url.endsWith('/integrations/settings')) {
        return response({
            Days: [
                { Day: 'Monday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Tuesday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Wednesday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Thursday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Friday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Saturday', Enabled: false, OpenTime: '08:00', CloseTime: '16:30' },
                { Day: 'Sunday', Enabled: false, OpenTime: '08:00', CloseTime: '16:30' }
            ]
        });
    }

    if (url.endsWith('/integrations')) {
        return response(integrationConnections);
    }

    if (url.endsWith('/assets')) return response(integrationAssets);
    throw new Error(`Unexpected request: ${url}`);
};

function response(payload) {
    return {
        ok: true,
        status: 200,
        async json() {
            return payload;
        }
    };
}

const { store } = await import('../store/store.js');
const { loadIntegrations, setupIntegrations } = await import('./Integrations.js');

store.state.classificationGroups = [{
    Key: 'asset-kind',
    Values: [
        { Id: 'kind-cash', Key: 'cash', DisplayName: 'Cash', DisplayOrder: 1 },
        { Id: 'kind-investments', Key: 'investments', DisplayName: 'Investments', DisplayOrder: 3 },
        { Id: 'kind-pensions', Key: 'pensions', DisplayName: 'Pensions', DisplayOrder: 5 },
        { Id: 'kind-unclassified', Key: 'unclassified', DisplayName: 'Unclassified', DisplayOrder: 99 }
    ]
}];

test('integration catalog allows additional named instances of a connected partner', async () => {
    await loadIntegrations();

    const catalog = elements.get('integration-catalog').innerHTML;
    const connections = elements.get('integration-connections').innerHTML;

    assert.match(catalog, /data-integration-enable="snaptrade">Add another<\/button>/);
    assert.doesNotMatch(catalog, /data-integration-enable="snaptrade"[^>]*disabled/);
    assert.match(catalog, /data-integration-enable="trading212"\s*>Add another<\/button>/);
    assert.match(connections, /class="integration-number-input"/);
    assert.match(connections, /Only poll during market times/);
    assert.match(connections, /data-integration-market-hours="connection-1"/);
    assert.match(connections, /data-integration-remove="connection-1"/);
    assert.match(connections, /SnapTrade ISA/);
    assert.match(connections, /SnapTrade Invest/);
    assert.match(connections, /class="integration-webhook-indicator"[^>]*aria-label="Webhook Capable"[^>]*title="Webhook Capable"[^>]*>w<\/span>SnapTrade ISA/);
    assert.doesNotMatch(connections, /class="integration-capability-badge"/);
    assert.match(catalog, /class="integration-capability-badge">Webhook-capable<\/span>/);
    assert.doesNotMatch(connections, />Updates via</);
    assert.doesNotMatch(connections, /SnapTrade provider setup/);
    const pollingOnlyConnection = connections.match(/<article class="integration-connection" data-connection-id="connection-3">[\s\S]*?<\/article>/)?.[0] || '';
    assert.ok(pollingOnlyConnection);
    assert.doesNotMatch(pollingOnlyConnection, /data-integration-sync-mode/);
    assert.doesNotMatch(pollingOnlyConnection, /integration-webhook-indicator/);
    assert.match(pollingOnlyConnection, /data-integration-polling="connection-3"/);
    const relay = elements.get('integration-webhook-relay').innerHTML;
    assert.match(relay, /Webhook relay/);
    assert.match(relay, /Connected/);
    assert.match(relay, /<span>Enabled<\/span>/);
    assert.match(relay, /data-integration-relay-enabled/);
    assert.doesNotMatch(relay, /Provider setup/);
    assert.match(relay, /Relay WebSocket/);
    assert.match(elements.get('integration-market-hours').innerHTML, /Market hours/);
    assert.match(elements.get('integration-market-hours').innerHTML, /<details[^>]+integration-market-hours-panel/);
    assert.match(elements.get('integration-market-hours').innerHTML, /Server local time/);
    assert.match(elements.get('integration-market-hours').innerHTML, /Changes save automatically\./);
    assert.doesNotMatch(elements.get('integration-market-hours').innerHTML, /Save market hours/);
});

test('polling controls expose every supported schedule type and render a weekly schedule', async () => {
    const connection = integrationConnections[2];
    const previousSchedule = {
        PollingScheduleType: connection.PollingScheduleType,
        PollingScheduleValue: connection.PollingScheduleValue,
        PollingScheduleDay: connection.PollingScheduleDay
    };

    try {
        connection.PollingScheduleType = 'WeeklyAt';
        connection.PollingScheduleValue = '09:30';
        connection.PollingScheduleDay = 'Friday';
        await loadIntegrations();

        const markup = elements.get('integration-connections').innerHTML;
        assert.match(markup, /value="EveryNMinutes"/);
        assert.match(markup, /value="Cron"/);
        assert.match(markup, /value="HourlyAt"/);
        assert.match(markup, /value="HourlyOnTheHour"/);
        assert.match(markup, /value="DailyAt"/);
        assert.match(markup, /value="WeeklyAt" selected/);
        assert.match(markup, /type="time" value="09:30"/);
        assert.match(markup, /data-integration-polling-schedule-day="connection-3"/);
        assert.match(markup, /value="Friday" selected/);
    } finally {
        Object.assign(connection, previousSchedule);
    }
});

test('disabled relay status explains that polling remains available', async () => {
    const previousRelayResponse = webhookRelayResponse;
    webhookRelayResponse = { Enabled: false, Connected: false, LastConnectedAt: null, LastMessageAt: null, LastError: null };
    try {
        await loadIntegrations();
        const relay = elements.get('integration-webhook-relay').innerHTML;
        assert.match(relay, /Disabled/);
        assert.match(relay, /scheduled polling remains available/);
        assert.doesNotMatch(relay, /Relay WebSocket/);
    } finally {
        webhookRelayResponse = previousRelayResponse;
    }
});

test('disabling the relay switches webhook connections to polling and hides their mode selector', async () => {
    const previousRelayResponse = webhookRelayResponse;
    const connection = integrationConnections[0];
    const previousMode = connection.SyncMode;
    webhookRelayResponse = { ...webhookRelayResponse, Enabled: true, Configured: true, CanToggle: true };
    connection.SyncMode = 'Webhook';
    try {
        await loadIntegrations();
        setupIntegrations();
        const panel = elements.get('integration-settings-pane');
        await panel.dispatch('change', {
            target: {
                dataset: { integrationRelayEnabled: 'true' },
                checked: false
            }
        });

        assert.equal(connection.SyncMode, 'Polling');
        const markup = elements.get('integration-connections').innerHTML;
        const connectionMarkup = markup.match(/<article class="integration-connection" data-connection-id="connection-1">[\s\S]*?<\/article>/)?.[0] || '';
        assert.ok(connectionMarkup);
        assert.match(connectionMarkup, /integration-webhook-indicator/);
        assert.doesNotMatch(connectionMarkup, /data-integration-sync-mode/);
        assert.match(connectionMarkup, /data-integration-polling="connection-1"/);
        assert.doesNotMatch(connectionMarkup, /integration-provider-setup/);
    } finally {
        connection.SyncMode = previousMode;
        webhookRelayResponse = previousRelayResponse;
    }
});

test('provider setup rejects a local relay address instead of presenting it for registration', async () => {
    const previousRelayResponse = webhookRelayResponse;
    const connection = integrationConnections[0];
    const previousMode = connection.SyncMode;
    webhookRelayResponse = {
        ...webhookRelayResponse,
        Configured: true,
        Enabled: true,
        RelayPublicBaseUrl: 'http://127.0.0.1:58081'
    };
    try {
        connection.SyncMode = 'Webhook';
        await loadIntegrations();
        const connections = elements.get('integration-connections').innerHTML;
        assert.match(connections, /configured relay address is local-only/);
        assert.doesNotMatch(connections, /127\.0\.0\.1:58081\/webhooks\/snaptrade/);
    } finally {
        connection.SyncMode = previousMode;
        webhookRelayResponse = previousRelayResponse;
    }
});

test('an integration exposes one automatic update mode and hides and disables polling controls for webhooks', async () => {
    const connection = integrationConnections[0];
    const previousMode = connection.SyncMode;
    try {
        connection.SyncMode = 'Webhook';
        await loadIntegrations();
        const markup = elements.get('integration-connections').innerHTML;
        assert.match(markup, /data-integration-sync-mode="connection-1"/);
        assert.match(markup, /value="Polling"/);
        assert.match(markup, /value="Webhook" selected/);
        assert.match(markup, /class="integration-provider-setup"/);
        assert.match(markup, /https:\/\/relay\.example\.com\/webhooks\/snaptrade/);
        assert.match(markup, /data-integration-copy-webhook="https:\/\/relay\.example\.com\/webhooks\/snaptrade"/);
        assert.match(markup, /class="integration-polling-controls" hidden aria-hidden="true"/);
        assert.match(markup, /data-integration-polling="connection-1"[^>]+disabled/);
        assert.match(markup, /data-integration-market-hours="connection-1"[^>]+disabled/);
    } finally {
        connection.SyncMode = previousMode;
    }
});

test('sync mode select uses the established dark form-control treatment', async () => {
    const stylesheet = await readFile(new URL('../../style.css', import.meta.url), 'utf8');
    const rule = stylesheet.match(/\.integration-sync-mode-control \.integration-select\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(rule, /background:\s*rgba\(2,\s*6,\s*23,\s*0\.65\)/);
    assert.match(rule, /border:\s*1px solid/);
    assert.match(rule, /color:\s*var\(--text-main\)/);
    assert.match(rule, /-webkit-appearance:\s*none/);
});

test('connected webhook capability uses a compact title indicator while the catalog keeps its pill', async () => {
    const stylesheet = await readFile(new URL('../../style.css', import.meta.url), 'utf8');
    const rule = stylesheet.match(/\.integration-connection-copy \.integration-webhook-indicator\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(rule, /border-radius:\s*50%/);
    assert.match(rule, /width:\s*1rem/);
    assert.match(rule, /height:\s*1rem/);
    assert.match(rule, /box-shadow:/);
});

test('provider webhook URL copies from its setup control', async () => {
    const connection = integrationConnections[0];
    const previousMode = connection.SyncMode;
    const navigatorObject = globalThis.navigator;
    const previousClipboard = Object.getOwnPropertyDescriptor(navigatorObject, 'clipboard');
    let copiedValue = '';
    Object.defineProperty(navigatorObject, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { copiedValue = value; } }
    });

    try {
        connection.SyncMode = 'Webhook';
        await loadIntegrations();
        setupIntegrations();
        const panel = elements.get('integration-settings-pane');
        const copyButton = {
            dataset: { integrationCopyWebhook: 'https://relay.example.com/webhooks/snaptrade' },
            disabled: false,
            hasAttribute() { return false; },
            closest() { return this; }
        };
        await panel.dispatch('click', { target: copyButton });
        assert.equal(copiedValue, 'https://relay.example.com/webhooks/snaptrade');
    } finally {
        connection.SyncMode = previousMode;
        if (previousClipboard) Object.defineProperty(navigatorObject, 'clipboard', previousClipboard);
        else delete navigatorObject.clipboard;
    }
});

test('relay settings and relay-to-api diagnostics are exposed through the integrations UI', async () => {
    fetchRequests.length = 0;
    await loadIntegrations();
    setupIntegrations();
    const panel = elements.get('integration-settings-pane');

    await panel.dispatch('change', {
        target: {
            dataset: { integrationRelayEnabled: 'true' },
            checked: false
        }
    });
    const settingsRequest = fetchRequests.find(item =>
        item.url.endsWith('/integrations/webhook-relay/settings'));
    assert.ok(settingsRequest);
    assert.deepEqual(JSON.parse(settingsRequest.options.body), { Enabled: false });

    webhookRelayResponse = { ...webhookRelayResponse, Enabled: true, Configured: true, CanToggle: true, CanTest: true };
    await loadIntegrations();
    const testButton = {
        dataset: {},
        disabled: false,
        innerHTML: 'Test relay → API',
        classList: { add() {}, remove() {} },
        setAttribute() {},
        removeAttribute() {},
        hasAttribute(attribute) {
            return attribute === 'data-integration-relay-test';
        },
        closest() {
            return this;
        }
    };
    await panel.dispatch('click', { target: testButton });
    assert.equal(fetchRequests.some(request => request.url.endsWith('/integrations/webhook-relay/test')), true);
    assert.match(elements.get('integration-webhook-relay').innerHTML, /Relay test passed./);
});

test('integration wizard opens as an accessible modal and advances a wizard step', async () => {
    await loadIntegrations();
    setupIntegrations();

    const panel = elements.get('integration-settings-pane');
    const manageButton = {
        dataset: { integrationManage: 'connection-1' },
        closest() {
            return this;
        }
    };
    await panel.dispatch('click', { target: manageButton });

    const wizard = elements.get('integration-wizard');
    assert.equal(wizard.hidden, false);
    assert.equal(wizard.classList.contains('modal-overlay'), true);
    assert.equal(wizard.classList.contains('active'), true);
    assert.equal(wizard.getAttribute('aria-hidden'), 'false');
    const dialog = wizard.children[0];
    assert.equal(dialog.className, 'modal-content glass-panel integration-wizard');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'integration-wizard-title');
    assert.equal(wizard.querySelector('[data-integration-close]').getAttribute('aria-label'), 'Close integration setup');
    assert.match(elements.get('integration-wizard-body').innerHTML, /Step 2 · Add keys/);

    await panel.dispatch('click', {
        target: {
            dataset: { integrationBack: '1' },
            disabled: false,
            hasAttribute(attribute) { return attribute === 'data-integration-back'; },
            closest() { return this; }
        }
    });
    assert.match(elements.get('integration-wizard-body').innerHTML, /Step 1 · Enable SnapTrade/);
});

test('market-hours changes save automatically after a short debounce', async () => {
    const panel = elements.get('integration-settings-pane');
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const form = {
        querySelectorAll() {
            return days.map(day => ({
                dataset: { integrationMarketDay: day },
                querySelector(selector) {
                    if (selector.includes('day-enabled')) return { checked: !['Saturday', 'Sunday'].includes(day) };
                    if (selector.includes('open')) return { value: '08:00' };
                    return { value: '16:30' };
                }
            }));
        }
    };
    const changedInput = {
        dataset: {},
        closest(selector) {
            return selector === '#integration-market-hours-form' ? form : null;
        }
    };

    await panel.dispatch('input', { target: changedInput });
    await new Promise(resolve => setTimeout(resolve, 550));

    const saveRequest = [...fetchRequests].reverse().find(item =>
        item.url.endsWith('/integrations/settings') && item.options.method === 'PUT');
    assert.ok(saveRequest);
    assert.equal(JSON.parse(saveRequest.options.body).Days.length, 7);
});

test('integration wizard closes from its close control, backdrop, and Escape', async () => {
    const panel = elements.get('integration-settings-pane');
    const wizard = elements.get('integration-wizard');
    const closeButton = wizard.querySelector('[data-integration-close]');

    await panel.dispatch('click', { target: closeButton });
    assert.equal(wizard.hidden, true);
    assert.equal(wizard.classList.contains('active'), false);

    await panel.dispatch('click', {
        target: {
            dataset: { integrationManage: 'connection-1' },
            closest() { return this; }
        }
    });
    assert.equal(wizard.hidden, false);
    await panel.dispatch('click', { target: wizard });
    assert.equal(wizard.hidden, true);

    await panel.dispatch('click', {
        target: {
            dataset: { integrationManage: 'connection-1' },
            closest() { return this; }
        }
    });
    documentListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
    assert.equal(wizard.hidden, true);
});

test('test connection action posts to the selected integration', async () => {
    fetchRequests.length = 0;
    await loadIntegrations();
    setupIntegrations();

    const panel = elements.get('integration-settings-pane');
    const manageButton = {
        dataset: { integrationManage: 'connection-1' },
        closest() {
            return this;
        }
    };
    await panel.dispatch('click', { target: manageButton });

    const credentialsForm = {
        id: 'integration-credentials-form',
        querySelectorAll() {
            return [];
        }
    };
    await panel.dispatch('submit', {
        target: credentialsForm,
        preventDefault() {}
    });

    const testButton = {
        dataset: {},
        disabled: false,
        innerHTML: 'Test connection',
        classList: { add() {}, remove() {} },
        setAttribute() {},
        removeAttribute() {},
        hasAttribute(attribute) {
            return attribute === 'data-integration-test';
        },
        closest() {
            return this;
        }
    };
    await panel.dispatch('click', { target: testButton });

    assert.equal(fetchRequests.some(request => request.url.endsWith('/integrations/connection-1/test')), true);
    assert.equal(fetchRequests.filter(request => request.url.endsWith('/assets')).length, 1);
    assert.equal(testButton.disabled, false);
    assert.equal(testButton.innerHTML, 'Test connection');
    assert.match(elements.get('integration-wizard-body').innerHTML, /Step 4 · Pull accounts/);
});

test('account allocation uses a searchable asset typeahead', async () => {
    integrationAssets.push(
        { Id: 'asset-road', DisplayName: '49 Hillsley Road' },
        { Id: 'asset-aj', DisplayName: 'AJ Bell - SIPP' }
    );
    const connection = integrationConnections[0];
    const previousStatus = connection.Status;
    const previousAccounts = connection.Accounts;
    connection.Status = 'NeedsAllocation';
    connection.Accounts = [{
        Id: 'account-1',
        DisplayName: 'Trading 212 account 31879328',
        AccountType: 'Invest / Stocks ISA',
        Currency: 'GBP',
        AssetId: null,
        AssetDisplayName: null
    }];

    try {
        await loadIntegrations();
        const panel = elements.get('integration-settings-pane');
        const manageButton = {
            dataset: { integrationManage: 'connection-1' },
            closest() {
                return this;
            }
        };
        await panel.dispatch('click', { target: manageButton });

        const markup = elements.get('integration-wizard-body').innerHTML;
        assert.match(markup, /class="asset-typeahead-search integration-asset-search"/);
        assert.match(markup, /class="asset-typeahead-options integration-asset-options"/);
        assert.match(markup, /data-asset-typeahead/);
        assert.match(markup, /aria-autocomplete="list"/);
        assert.match(markup, /Invested asset/);
        assert.match(markup, /Undeployed cash asset/);
        assert.match(markup, /data-account-allocation-role="Deployed"/);
        assert.match(markup, /data-account-allocation-role="Undeployed"/);
        assert.match(markup, /data-account-asset-kind="account-1"/);
        assert.match(markup, /Asset Kind/);
        assert.match(markup, />Pensions<\/option>/);
        assert.doesNotMatch(markup, /value="kind-unclassified"/);
        assert.doesNotMatch(markup, /data-account-cash-asset/);
        assert.doesNotMatch(markup, /data-account-cash-handling/);
        assert.doesNotMatch(markup, /<select[^>]+data-account-asset=/);

        const options = { hidden: true, innerHTML: '' };
        const hiddenAsset = { value: '' };
        const newName = { hidden: false };
        const assetKind = { hidden: false };
        const status = { hidden: true, textContent: '' };
        const row = {
            querySelector(selector) {
                if (selector.includes('data-account-asset="account-1"')) return hiddenAsset;
                if (selector.includes('data-account-asset-search="account-1"')) return search;
                if (selector.includes('data-account-new-asset="account-1"')) return newName;
                if (selector.includes('data-account-asset-kind="account-1"')) return assetKind;
                if (selector.includes('data-account-allocation-status="account-1"')) return status;
                return null;
            },
            closest() {
                return row;
            }
        };
        const picker = {
            dataset: { accountAssetPicker: 'account-1' },
            classList: { toggle() {} },
            querySelector(selector) {
                if (selector === '[data-account-asset-options]') return options;
                if (selector === '[data-account-asset-search]') return search;
                return null;
            },
            closest() {
                return row;
            }
        };
        const search = {
            dataset: { accountAssetSearch: 'account-1' },
            value: '49',
            setAttribute() {},
            closest(selector) {
                if (selector === '.integration-asset-typeahead') return picker;
                if (selector === '.integration-account') return row;
                return null;
            }
        };

        panel.dispatch('input', { target: search });
        assert.match(options.innerHTML, /49 Hillsley Road/);
        assert.doesNotMatch(options.innerHTML, /AJ Bell - SIPP/);
    } finally {
        connection.Status = previousStatus;
        connection.Accounts = previousAccounts;
        integrationAssets.length = 0;
    }
});

test('integration load failures remain actionable and distinct from a valid empty connection list', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('Integration service unavailable.');
    };

    try {
        await loadIntegrations();

        const connections = elements.get('integration-connections').innerHTML;
        assert.match(connections, /role="alert"/);
        assert.match(connections, /Integration service unavailable\./);
        assert.match(connections, /data-integration-retry/);
        assert.doesNotMatch(connections, /No integrations are enabled yet/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
