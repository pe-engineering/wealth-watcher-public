import { store } from '../store/store.js';

// This is the canonical browser-demo provisioner. When a UI feature adds an
// API-backed request, update this adapter and demoContract.js together; the
// parity tests then fail if the UI or demo drifts from the shared request
// boundary.

const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_CONTRIBUTIONS_STACK = 'Unallocated Contributions';
const FORECAST_WINDFALLS_STACK = 'Unallocated Windfalls';
const DEFAULT_FORECAST_INCLUDED_ASSETS = ['investments', 'pensions', 'property'];
const FORECAST_STRATEGY_DESCRIPTIONS = {
    'fire-default': 'Uses the configured FIRE/default annual return; historical data is not extrapolated.',
    'cash-flow-adjusted-cagr': 'Links completed monthly returns after removing known invested-capital changes, then annualizes the compounded result.',
    'median-monthly-return': 'Annualizes the median completed-month return, reducing the influence of unusually strong or weak months.',
    'weighted-log-return': 'Averages monthly log returns with more weight on recent months, then annualizes the result.',
    'regression-trend': 'Fits a straight-line trend to cumulative cash-flow-adjusted log wealth; the slope is the annualized forecast rate.',
    'winsorized-monthly-return': 'Clamps extreme completed-month returns to the 10th/90th percentile before compounding, limiting outlier impact.',
    'first-last-annualized': 'Compares the first and last observed history values, annualizes the compounded change over the elapsed period, and applies that annual rate to the forecast.'
};
const PERSISTED_SETTING_KEYS = [
    'wealthWatcherGeneralSettings',
    'wealthWatcherFeatureSettings',
    'wealthWatcherForecastSettings',
    'wealthWatcherFireSettings',
    'wealthWatcherMilestoneSettings',
    'wealthWatcherBudgetSettings'
];
const SETTING_ARRAY_KEYS = {
    wealthWatcherForecastSettings: ['includedAssets', 'contributions', 'windfalls'],
    wealthWatcherFireSettings: ['includedAssets', 'windfalls'],
    wealthWatcherBudgetSettings: ['income', 'bills', 'savings', 'spend']
};
const SETTING_OBJECT_ARRAY_KEYS = {
    wealthWatcherForecastSettings: ['contributions', 'windfalls'],
    wealthWatcherFireSettings: ['windfalls'],
    wealthWatcherBudgetSettings: ['income', 'bills', 'savings', 'spend']
};
const BUDGET_V2_VERSION = 2;
const BUDGET_CATEGORIES = ['income', 'bills', 'savings', 'spend'];
const BUDGET_CATEGORY_LABELS = {
    income: 'Income',
    bills: 'Bills',
    savings: 'Savings',
    spend: 'Spend'
};
const BUDGET_V2_CADENCES = new Set([
    'month', 'monthly', '1m',
    'quarter', 'quarterly', '3m',
    'annual', 'annually', 'year', 'yearly', '12m'
]);
const DEFAULT_MARKET_HOURS = {
    Days: [
        { Day: 'Monday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Tuesday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Wednesday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Thursday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Friday', Enabled: true, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Saturday', Enabled: false, OpenTime: '08:00', CloseTime: '16:30' },
        { Day: 'Sunday', Enabled: false, OpenTime: '08:00', CloseTime: '16:30' }
    ]
};

const CATEGORY_SEEDS = [
    { Id: 'investments', Label: 'Investments', Color: '#22d3ee', DisplayOrder: 1, ClassificationValueId: 'kind-investments', AssetGroupId: 'group-investments', AssetGroupCode: 'investments' },
    { Id: 'pensions', Label: 'Pensions', Color: '#a78bfa', DisplayOrder: 2, ClassificationValueId: 'kind-pensions', AssetGroupId: 'group-investments', AssetGroupCode: 'investments' },
    { Id: 'property', Label: 'Property', Color: '#f59e0b', DisplayOrder: 3, ClassificationValueId: 'kind-property', AssetGroupId: 'group-property', AssetGroupCode: 'property' },
    { Id: 'cash', Label: 'Cash', Color: '#34d399', DisplayOrder: 4, ClassificationValueId: 'kind-cash', AssetGroupId: 'group-cash', AssetGroupCode: 'cash' }
];

const DEMO_STORAGE_KEY = 'wealth-watcher:live-demo-ledger:v5';
const LEGACY_DEMO_STORAGE_KEY = 'wealth-watcher:live-demo-ledger:v4';
const DEMO_HISTORY_DAYS = 366;
const DEMO_VALUE_BOUNDS = Object.freeze({ min: 400000, max: 500000, center: 450000 });
const GENERATED_ENTRY_ID_PREFIX = 'demo-seed-entry-';

let demoClock = () => new Date();

const clone = value => {
    if (value === undefined) return undefined;
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
};

function getDemoNow() {
    const candidate = typeof demoClock === 'function' ? demoClock() : demoClock;
    const parsed = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function setDemoClock(value) {
    if (typeof value === 'function') {
        demoClock = value;
        return todayKey();
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('The demo clock must resolve to a valid date.');
    demoClock = () => new Date(parsed.getTime());
    return todayKey();
}

export function resetDemoClock() {
    demoClock = () => new Date();
}

export function getDemoDateKey() {
    return todayKey();
}

const dateKey = date => new Date(date).toISOString().slice(0, 10);
const todayKey = (now = getDemoNow()) => dateKey(now);
const addDays = (date, days) => new Date(new Date(`${date}T12:00:00Z`).getTime() + days * DAY_MS);
const idFrom = (prefix, number) => `${prefix}-${number}`;
const numberValue = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const normalize = value => String(value ?? '').trim().toLowerCase();
const json = value => JSON.stringify(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const createDefaultBudgetSettings = () => ({
    version: BUDGET_V2_VERSION,
    // The demo deliberately represents a historic plan that has been loaded
    // into the v2 shape but still needs the user to review its settings.
    needsUpdate: true,
    groups: [
        {
            id: 'income',
            name: 'Income',
            kind: 'income',
            role: 'income',
            builtIn: true,
            items: [
                { id: 'income-demo-salary', name: 'Salary', amount: 6500, cadence: 'monthly', assetId: null, category: 'Employment' },
                { id: 'income-demo-freelance', name: 'Freelance design', amount: 650, cadence: 'monthly', assetId: null, category: 'Self-employment' }
            ]
        },
        {
            id: 'bills',
            name: 'Bills',
            kind: 'custom',
            role: 'custom',
            builtIn: false,
            items: [
                { id: 'bill-demo-mortgage', name: 'Mortgage', amount: 1450, cadence: 'monthly', assetId: null, category: 'Accommodation' },
                { id: 'bill-demo-council-tax', name: 'Council tax', amount: 190, cadence: 'monthly', assetId: null, category: 'Home' },
                { id: 'bill-demo-utilities', name: 'Utilities', amount: 230, cadence: 'monthly', assetId: null, category: 'Home' }
            ]
        },
        {
            id: 'savings',
            name: 'Savings',
            kind: 'custom',
            role: 'custom',
            builtIn: false,
            items: [
                { id: 'saving-demo-emergency', name: 'Emergency fund', amount: 450, cadence: 'monthly', assetId: 'asset-cash', category: 'Safety net' },
                { id: 'saving-demo-index', name: 'Index fund contribution', amount: 1500, cadence: 'monthly', assetId: 'asset-isa', category: 'Investing' }
            ]
        },
        {
            id: 'spend',
            name: 'Spend',
            kind: 'custom',
            role: 'custom',
            builtIn: false,
            items: [
                { id: 'spend-demo-groceries', name: 'Groceries', amount: 520, cadence: 'monthly', assetId: null, category: 'Food & household' },
                { id: 'spend-demo-travel', name: 'Travel', amount: 350, cadence: 'monthly', assetId: null, category: 'Leisure' },
                { id: 'spend-demo-everything-else', name: 'Everything else', amount: 610, cadence: 'monthly', assetId: null, category: null }
            ]
        }
    ]
});

const createLegacyBudgetSettings = () => ({
    income: [
        { name: 'Legacy salary', amount: 6500 }
    ],
    bills: [
        { name: 'Legacy mortgage', amount: 1450 }
    ],
    savings: [
        { name: 'Legacy emergency fund', amount: 450, cadence: 'monthly', assetId: 'asset-cash' }
    ],
    spend: [
        { name: 'Legacy groceries', amount: 520 }
    ]
});

function parseDateKey(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const parsed = new Date(`${raw}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) || dateKey(parsed) !== raw ? null : raw;
}

function entryTimestamp(entry) {
    const date = parseDateKey(entry?.Date);
    if (!date) return null;
    const time = String(entry?.Time || '23:59:59').trim();
    const normalizedTime = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
    if (!/^\d{2}:\d{2}:\d{2}$/.test(normalizedTime)) return null;
    const timestamp = new Date(`${date}T${normalizedTime}Z`);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function isEntryVisibleAt(entry, now = getDemoNow()) {
    const timestamp = entryTimestamp(entry);
    return timestamp !== null && timestamp <= now;
}

function firstOfNextMonth(date) {
    const parsed = new Date(`${date}T12:00:00Z`);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1, 12));
}

function monthKey(value) {
    const parsed = parseDateKey(value);
    return parsed ? parsed.slice(0, 7) : null;
}

function cadenceMonths(cadence) {
    const normalized = normalize(cadence);
    if (!normalized || ['month', 'monthly', '1m'].includes(normalized)) return 1;
    if (['quarter', 'quarterly', '3m'].includes(normalized)) return 3;
    if (['semiannual', 'semi-annual', 'half-yearly', '6m'].includes(normalized)) return 6;
    if (['annual', 'annually', 'year', 'yearly', '12m'].includes(normalized)) return 12;
    const numericToken = normalized.split(/\s+/).find(token => /^\d+$/.test(token));
    const parsed = Number(numericToken);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeForecastStrategy(strategy) {
    const normalized = normalize(strategy);
    return Object.prototype.hasOwnProperty.call(FORECAST_STRATEGY_DESCRIPTIONS, normalized)
        ? normalized
        : 'fire-default';
}

class DemoValidationError extends Error {}

function readProperty(record, ...names) {
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
    }
    const normalizedNames = names.map(name => normalize(name));
    const matchingKey = Object.keys(record).find(key => normalizedNames.includes(normalize(key)));
    if (matchingKey) return record[matchingKey];
    return undefined;
}

function normalizeBudgetCadence(value, { strict = false, path = 'cadence' } = {}) {
    const cadence = normalize(value);
    if (!cadence || cadence === 'monthly') return 'monthly';
    if (cadence === 'quarterly') return 'quarterly';
    if (['annually', 'annual', 'yearly'].includes(cadence)) return 'annually';
    if (strict) throw new DemoValidationError(`${path} must be monthly, quarterly, or annually.`);
    return 'monthly';
}

function normalizeBudgetAmount(value, { strict = false, path = 'amount' } = {}) {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value === 'boolean' || (typeof value === 'object' && value !== null)) {
        if (strict) throw new DemoValidationError(`${path} must be a finite number.`);
        return null;
    }
    const amount = Number(value);
    if (Number.isFinite(amount)) {
        if (strict && amount < 0) throw new DemoValidationError(`${path} must be zero or greater.`);
        if (strict && (amount > 99999999999999999.99
            || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8)) {
            throw new DemoValidationError(`${path} must fit the budget amount precision of decimal(18,2).`);
        }
        return amount;
    }
    if (strict) throw new DemoValidationError(`${path} must be a finite number.`);
    return null;
}

function normalizeBudgetAssetId(value, assets, { strict = false, path = 'assetId' } = {}) {
    const candidate = String(value ?? '').trim();
    if (!candidate) return null;
    const asset = (Array.isArray(assets) ? assets : []).find(item => (
        normalize(item?.Id ?? item?.id) === normalize(candidate)
    ));
    if (asset) return asset.Id ?? asset.id;
    if (strict) throw new DemoValidationError(`${path} references an unknown asset '${candidate}'.`);
    return null;
}

function hasBudgetDocumentMarker(document, marker) {
    return Object.prototype.hasOwnProperty.call(document, marker)
        || Object.prototype.hasOwnProperty.call(document, marker[0].toUpperCase() + marker.slice(1));
}

function normalizeBudgetV2AssetId(value, path) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim()) {
        throw new DemoValidationError(`${path} must be a non-empty asset id or null.`);
    }
    return value.trim();
}

function normalizeBudgetV2Category(value, path) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim()) {
        throw new DemoValidationError(`${path} must be a non-empty category or null.`);
    }
    return value.trim();
}

function normalizeBudgetV2Color(value) {
    if (value === undefined || value === null || value === '') return null;
    const candidate = String(value).trim();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)) return null;
    if (candidate.length === 4) {
        return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}`.toLowerCase();
    }
    return candidate.toLowerCase();
}

function normalizeBudgetV2SettingsDocument(document) {
    if (document.version !== BUDGET_V2_VERSION) {
        return { error: 'wealthWatcherBudgetSettings.version must be 2 when groups are supplied.' };
    }
    if (hasBudgetDocumentMarker(document, 'needsUpdate')
        && typeof readProperty(document, 'needsUpdate', 'NeedsUpdate') !== 'boolean') {
        return { error: 'wealthWatcherBudgetSettings.needsUpdate must be true or false.' };
    }
    if (!Array.isArray(document.groups) || document.groups.length === 0) {
        return { error: 'wealthWatcherBudgetSettings.groups must contain at least one group.' };
    }

    const groupIds = new Set();
    const itemIds = new Set();
    let incomeGroupCount = 0;
    const groups = [];

    for (const [groupIndex, group] of document.groups.entries()) {
        const groupPath = `wealthWatcherBudgetSettings.groups[${groupIndex}]`;
        if (!isRecord(group)) return { error: `${groupPath} must be a JSON object.` };

        const rawId = readProperty(group, 'id', 'Id');
        const rawName = readProperty(group, 'name', 'Name');
        if (typeof rawId !== 'string' || !rawId.trim()) return { error: `${groupPath}.id must not be blank.` };
        if (typeof rawName !== 'string' || !rawName.trim()) return { error: `${groupPath}.name must not be blank.` };

        const id = rawId.trim();
        const idKey = id.toLowerCase();
        if (groupIds.has(idKey)) return { error: `${groupPath}.id contains a duplicate group id '${id}'.` };
        groupIds.add(idKey);

        const rawBuiltIn = readProperty(group, 'builtIn', 'BuiltIn');
        if (typeof rawBuiltIn !== 'boolean') return { error: `${groupPath}.builtIn must be true or false.` };

        const rawKind = readProperty(group, 'kind', 'Kind');
        const rawRole = readProperty(group, 'role', 'Role');
        const kind = normalize(rawKind) || null;
        const role = normalize(rawRole) || null;
        if (!kind && !role) return { error: `${groupPath} must specify kind or role.` };
        if (kind === 'income' && role && role !== 'income') {
            return { error: `${groupPath}.kind and role must agree for the Income group.` };
        }

        const isIncome = kind === 'income' || role === 'income';
        if (isIncome) {
            incomeGroupCount += 1;
            if (!rawBuiltIn) return { error: `${groupPath} Income must remain builtIn.` };
        } else if (rawBuiltIn) {
            return { error: `${groupPath} custom groups must set builtIn to false.` };
        }

        if (!Array.isArray(group.items)) return { error: `${groupPath}.items must be a JSON array.` };
        const normalizedGroup = {
            id,
            name: rawName.trim(),
            kind: isIncome ? 'income' : 'custom',
            role: isIncome ? 'income' : (role || kind || 'custom'),
            builtIn: isIncome,
            color: normalizeBudgetV2Color(readProperty(group, 'color', 'Color')),
            items: []
        };

        for (const [itemIndex, item] of group.items.entries()) {
            const itemPath = `${groupPath}.items[${itemIndex}]`;
            if (!isRecord(item)) return { error: `${itemPath} must be a JSON object.` };

            const rawItemId = readProperty(item, 'id', 'Id');
            const rawItemName = readProperty(item, 'name', 'Name');
            if (typeof rawItemId !== 'string' || !rawItemId.trim()) return { error: `${itemPath}.id must not be blank.` };
            if (typeof rawItemName !== 'string' || !rawItemName.trim()) return { error: `${itemPath}.name must not be blank.` };

            const itemId = rawItemId.trim();
            const itemIdKey = itemId.toLowerCase();
            if (itemIds.has(itemIdKey)) return { error: `${itemPath}.id contains a duplicate item id '${itemId}'.` };
            itemIds.add(itemIdKey);

            const rawAmount = readProperty(item, 'amount', 'Amount');
            if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
                return { error: `${itemPath}.amount must be a finite number.` };
            }

            let amount;
            let cadence;
            let assetId;
            let category;
            try {
                amount = normalizeBudgetAmount(rawAmount, {
                    strict: true,
                    path: `${itemPath}.amount`
                });
                const rawCadence = readProperty(item, 'cadence', 'Cadence');
                if (typeof rawCadence !== 'string' || !BUDGET_V2_CADENCES.has(normalize(rawCadence))) {
                    throw new DemoValidationError(`${itemPath}.cadence must be monthly, quarterly, or annually.`);
                }
                cadence = normalizeBudgetCadence(rawCadence, {
                    strict: true,
                    path: `${itemPath}.cadence`
                });
                assetId = normalizeBudgetV2AssetId(
                    readProperty(item, 'assetId', 'AssetId'),
                    `${itemPath}.assetId`
                );
                category = normalizeBudgetV2Category(
                    readProperty(item, 'category', 'Category'),
                    `${itemPath}.category`
                );
            } catch (error) {
                return { error: error.message };
            }

            normalizedGroup.items.push({
                id: itemId,
                name: rawItemName.trim(),
                amount,
                cadence,
                assetId,
                category
            });
        }
        groups.push(normalizedGroup);
    }

    if (incomeGroupCount !== 1) {
        return { error: 'wealthWatcherBudgetSettings.groups must contain exactly one built-in Income group.' };
    }

    return {
        value: {
            version: BUDGET_V2_VERSION,
            needsUpdate: readProperty(document, 'needsUpdate', 'NeedsUpdate') === true,
            groups
        }
    };
}

function normalizeBudgetSettingsDocument(document, assets, { strict = false } = {}) {
    if (!isRecord(document)) return { error: 'wealthWatcherBudgetSettings must contain a JSON object.' };

    const documentVersion = readProperty(document, 'version', 'Version');
    const isLegacyVersionedDocument = documentVersion === 1 && !hasBudgetDocumentMarker(document, 'groups');
    if (!isLegacyVersionedDocument
        && (hasBudgetDocumentMarker(document, 'version') || hasBudgetDocumentMarker(document, 'groups'))) {
        return normalizeBudgetV2SettingsDocument(document);
    }

    const explicitNeedsUpdate = readProperty(document, 'needsUpdate', 'NeedsUpdate');
    if (explicitNeedsUpdate !== undefined && typeof explicitNeedsUpdate !== 'boolean') {
        return { error: 'wealthWatcherBudgetSettings.needsUpdate must be true or false.' };
    }

    const normalized = {};
    let hasHistoricData = false;
    for (const category of BUDGET_CATEGORIES) {
        const rawItems = readProperty(document, category, BUDGET_CATEGORY_LABELS[category]);
        if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
            return { error: `wealthWatcherBudgetSettings.${category} must be a JSON array.` };
        }
        if ((rawItems || []).length > 0) hasHistoricData = true;

        const items = [];
        for (const [index, item] of (rawItems || []).entries()) {
            if (item === null) {
                if (strict) return { error: `wealthWatcherBudgetSettings.${category}[${index}] must be a JSON object.` };
                continue;
            }
            if (!isRecord(item)) {
                return { error: `wealthWatcherBudgetSettings.${category}[${index}] must be a JSON object.` };
            }

            const name = String(readProperty(item, 'name', 'Name') ?? '').trim();
            if (!name) {
                if (strict) return { error: `wealthWatcherBudgetSettings.${category}[${index}].name must not be blank.` };
                continue;
            }

            let amount;
            try {
                amount = normalizeBudgetAmount(
                    readProperty(item, 'amount', 'Amount'),
                    { strict, path: `wealthWatcherBudgetSettings.${category}[${index}].amount` }
                );
            } catch (error) {
                return { error: error.message };
            }
            // A malformed legacy row should not make the demo unusable on read.
            // Writes remain strict so invalid UI input gets a response-like 400.
            if (amount === null) continue;

            const rawId = readProperty(item, 'id', 'Id');
            const id = String(rawId ?? '').trim() || `budget-${category}-${index + 1}`;
            const rawAssetId = readProperty(item, 'assetId', 'AssetId');
            try {
                const normalizedItem = {
                    id,
                    name,
                    amount,
                    cadence: normalizeBudgetCadence(
                        readProperty(item, 'cadence', 'Cadence'),
                        { strict, path: `wealthWatcherBudgetSettings.${category}[${index}].cadence` }
                    ),
                    assetId: normalizeBudgetAssetId(
                        rawAssetId,
                        assets,
                        { strict, path: `wealthWatcherBudgetSettings.${category}[${index}].assetId` }
                    )
                };
                const rawCategory = readProperty(item, 'category', 'Category');
                if (rawCategory !== undefined && rawCategory !== null && String(rawCategory).trim()) {
                    normalizedItem.category = String(rawCategory).trim();
                }
                items.push(normalizedItem);
            } catch (error) {
                return { error: error.message };
            }
        }

        normalized[category] = items.sort((left, right) => (
            left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
            || left.id.localeCompare(right.id)
        ));
    }

    return {
        value: {
            version: 1,
            needsUpdate: explicitNeedsUpdate === true || hasHistoricData,
            ...normalized
        }
    };
}

function legacyCategoryForBudgetGroup(group) {
    if (group?.builtIn === true || normalize(group?.kind) === 'income' || normalize(group?.role) === 'income') {
        return 'income';
    }
    const tokens = [group?.role, group?.kind, group?.id, group?.name].map(normalize);
    if (tokens.some(token => ['bills', 'bill', 'needs'].includes(token) || token.includes('bill') || token.includes('need'))) return 'bills';
    if (tokens.some(token => ['savings', 'saving'].includes(token) || token.includes('saving'))) return 'savings';
    if (tokens.some(token => ['spend', 'spending', 'wants'].includes(token) || token.includes('spend') || token.includes('want'))) return 'spend';
    return 'spend';
}

function budgetV2CompatibilityArrays(document) {
    const arrays = Object.fromEntries(BUDGET_CATEGORIES.map(category => [category, []]));
    for (const group of document.groups || []) {
        const category = legacyCategoryForBudgetGroup(group);
        for (const item of group.items || []) {
            // Keep compatibility rows deliberately free of v2-only Sankey
            // metadata; category assignments remain in the v2 group document.
            arrays[category].push({
                id: item.id,
                name: item.name,
                amount: item.amount,
                cadence: item.cadence,
                assetId: item.assetId ?? null
            });
        }
    }
    return arrays;
}

function normalizePersistedSetting(key, value, assets = [], { strictBudget = false } = {}) {
    const raw = value === null || value === undefined || value === '' ? '{}' : value;
    if (typeof raw !== 'string') return { error: `${key} must contain valid JSON.` };

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { error: `${key} must contain valid JSON.` };
    }
    if (!isRecord(parsed)) return { error: `${key} must contain a JSON object.` };

    for (const property of SETTING_ARRAY_KEYS[key] || []) {
        if (Object.prototype.hasOwnProperty.call(parsed, property)
            && parsed[property] !== null
            && !Array.isArray(parsed[property])) {
            return { error: `${key}.${property} must be a JSON array.` };
        }
    }
    for (const property of SETTING_OBJECT_ARRAY_KEYS[key] || []) {
        if (!Array.isArray(parsed[property])) continue;
        const invalidIndex = parsed[property].findIndex(item => item !== null && !isRecord(item));
        if (invalidIndex >= 0) return { error: `${key}.${property}[${invalidIndex}] must be a JSON object.` };
    }
    if (key === 'wealthWatcherBudgetSettings') {
        const budget = normalizeBudgetSettingsDocument(parsed, assets, { strict: strictBudget });
        if (budget.error) return { error: budget.error };
        return { value: json(budget.value), parsed: budget.value };
    }
    return { value: raw, parsed };
}

function safeSettingsSnapshot() {
    const settings = clone(demoState.settings) || {};
    PERSISTED_SETTING_KEYS.forEach(key => {
        const normalized = normalizePersistedSetting(key, settings[key], demoState.assets);
        if (key === 'wealthWatcherBudgetSettings' && normalized.parsed?.version === BUDGET_V2_VERSION) {
            settings[key] = json({
                ...normalized.parsed,
                ...budgetV2CompatibilityArrays(normalized.parsed)
            });
        } else {
            settings[key] = normalized.value || '{}';
        }
    });
    if (Object.prototype.hasOwnProperty.call(settings, 'wealthWatcherMilestoneSettings')) {
        try {
            settings.wealthWatcherMilestoneSettings = normalizeDemoMilestoneSettings(settings.wealthWatcherMilestoneSettings);
        } catch {
            settings.wealthWatcherMilestoneSettings = json({ targets: [] });
        }
    }
    return settings;
}

function seedState({ budgetSettings = createDefaultBudgetSettings(), asOfDate = getDemoNow() } = {}) {
    const today = todayKey(asOfDate);
    const groups = [
        {
            Id: 'group-investments', Key: 'asset-group', DisplayName: 'Asset Groups',
            Values: [
                { Id: 'group-investments', Key: 'investments', DisplayName: 'Investments', Color: '#22d3ee', DisplayOrder: 1 },
                { Id: 'group-property', Key: 'property', DisplayName: 'Property', Color: '#f59e0b', DisplayOrder: 2 },
                { Id: 'group-cash', Key: 'cash', DisplayName: 'Cash', Color: '#34d399', DisplayOrder: 3 }
            ]
        },
        {
            Id: 'group-kinds', Key: 'asset-kind', DisplayName: 'Asset Kinds',
            Values: [
                { Id: 'kind-investments', Key: 'investments', DisplayName: 'Stocks & Shares', AssetGroupId: 'group-investments', EntryKind: 'Investment', DisplayOrder: 1 },
                { Id: 'kind-pensions', Key: 'pensions', DisplayName: 'Pension', AssetGroupId: 'group-investments', EntryKind: 'Investment', DisplayOrder: 2 },
                { Id: 'kind-property', Key: 'property', DisplayName: 'Property', AssetGroupId: 'group-property', EntryKind: 'Property', DisplayOrder: 3 },
                { Id: 'kind-cash', Key: 'cash', DisplayName: 'Cash', AssetGroupId: 'group-cash', EntryKind: 'Cash', DisplayOrder: 4 }
            ]
        }
    ];
    const assets = [
        { Id: 'asset-isa', DisplayName: 'Stocks & Shares ISA', Name: 'Stocks & Shares ISA', AssetKindId: 'kind-investments', AssetGroupId: 'group-investments', EntryKind: 'Investment', Archived: false },
        { Id: 'asset-pension', DisplayName: 'Workplace Pension', Name: 'Workplace Pension', AssetKindId: 'kind-pensions', AssetGroupId: 'group-investments', EntryKind: 'Investment', Archived: false },
        { Id: 'asset-home', DisplayName: 'Primary Home', Name: 'Primary Home', AssetKindId: 'kind-property', AssetGroupId: 'group-property', EntryKind: 'Property', Archived: false },
        { Id: 'asset-cash', DisplayName: 'Emergency Cash', Name: 'Emergency Cash', AssetKindId: 'kind-cash', AssetGroupId: 'group-cash', EntryKind: 'Cash', Archived: false }
    ];
    const historyDays = DEMO_HISTORY_DAYS - 1;
    const gaussianPulse = (ageDays, center, width) => Math.exp(-((ageDays - center) ** 2) / (2 * width ** 2));
    const hashNoise = (seed, phase) => {
        const raw = Math.sin(((seed + 1) * 12.9898) + (phase * 78.233)) * 43758.5453;
        return ((raw - Math.floor(raw)) * 2) - 1;
    };
    const movementFactorAtAge = ({ phase = 0, shocks = [], noiseScale = 0 }, ageDays) => {
        const marketCycle =
            (Math.sin((ageDays / 29) + phase) * 0.58) +
            (Math.sin((ageDays / 73) + (phase * 0.61)) * 0.34) +
            (Math.sin((ageDays / 13) + (phase * 1.31)) * 0.12) +
            (Math.sin((ageDays / 5.7) + (phase * 2.1)) * 0.08);
        const eventPulse = shocks.reduce(
            (total, shock) => total + (shock.amount * gaussianPulse(ageDays, shock.center, shock.width)),
            0
        );
        const shortTermNoise = (
            (hashNoise(ageDays, phase) * 0.55) +
            (hashNoise(Math.floor(ageDays / 3), phase + 2.7) * 0.45)
        ) * noiseScale;
        return marketCycle + eventPulse + shortTermNoise;
    };
    const valueAtAge = ({ current, start, volatility = 0, phase = 0, shocks = [], noiseScale = 0 }, ageDays) => {
        const progress = Math.min(1, Math.max(0, ageDays / historyDays));
        const trend = current + ((start - current) * progress);
        const movement = (movementFactorAtAge({ phase, shocks, noiseScale }, ageDays) - movementFactorAtAge({ phase, shocks, noiseScale }, 0)) * volatility;
        return Math.max(0, Math.round(trend + movement));
    };
    const historyConfigs = [
        {
            type: 'investments', name: 'Stocks & Shares ISA', assetId: 'asset-isa', time: '16:00:00',
            current: 91800, start: 52000, volatility: 10500, phase: 0.4, noiseScale: 0.24,
            shocks: [
                { center: 330, width: 32, amount: -0.75 },
                { center: 195, width: 42, amount: 0.55 },
                { center: 95, width: 24, amount: -0.6 },
                { center: 14, width: 7, amount: -0.32 }
            ],
            investedCurrent: 70000, investedStart: 50000, investedVolatility: 900
        },
        {
            type: 'pensions', name: 'Workplace Pension', assetId: 'asset-pension', time: '16:00:00',
            current: 139500, start: 82000, volatility: 15000, phase: 1.2, noiseScale: 0.2,
            shocks: [
                { center: 330, width: 34, amount: -0.65 },
                { center: 195, width: 46, amount: 0.45 },
                { center: 95, width: 26, amount: -0.45 },
                { center: 15, width: 8, amount: -0.24 }
            ],
            investedCurrent: 105000, investedStart: 72000, investedVolatility: 1100
        },
        {
            type: 'property', name: 'Primary Home', assetId: 'asset-home', time: '12:00:00',
            current: 355000, start: 270000, volatility: 14000, phase: 2, noiseScale: 0.07,
            shocks: [
                { center: 315, width: 62, amount: -0.75 },
                { center: 150, width: 60, amount: 0.45 },
                { center: 18, width: 10, amount: -0.12 }
            ],
            mortgageCurrent: 175000, mortgageStart: 205000, mortgageVolatility: 1200
        },
        {
            type: 'cash', name: 'Emergency Cash', assetId: 'asset-cash', time: '16:00:00',
            current: 31200, start: 15500, volatility: 3800, phase: 2.6, noiseScale: 0.18,
            shocks: [
                { center: 250, width: 65, amount: -0.25 },
                { center: 110, width: 50, amount: 0.2 },
                { center: 9, width: 5, amount: -0.35 }
            ]
        }
    ];
    const todayDate = new Date(`${today}T12:00:00Z`);
    const historyStartDate = new Date(todayDate.getTime() - (DEMO_HISTORY_DAYS - 1) * DAY_MS);
    const historyStart = dateKey(historyStartDate);
    const observations = [];
    // Completed months get 14 snapshots spread across their days. The current
    // month is sampled through today so the calendar never contains future data.
    // The first and last dates are always included so the rolling window remains
    // date-relative even when the month starts or ends between sample points.
    let monthStart = new Date(Date.UTC(
        historyStartDate.getUTCFullYear(),
        historyStartDate.getUTCMonth(),
        1,
        12
    ));
    const currentMonthStart = new Date(Date.UTC(
        todayDate.getUTCFullYear(),
        todayDate.getUTCMonth(),
        1,
        12
    ));
    while (monthStart <= currentMonthStart) {
        const lastDay = new Date(Date.UTC(
            monthStart.getUTCFullYear(),
            monthStart.getUTCMonth() + 1,
            0,
            12
        )).getUTCDate();
        const isCurrentMonth = monthStart.getUTCFullYear() === todayDate.getUTCFullYear()
            && monthStart.getUTCMonth() === todayDate.getUTCMonth();
        const maximumDay = isCurrentMonth ? todayDate.getUTCDate() : lastDay;
        const observationCount = Math.min(14, maximumDay);
        const days = [...new Set(Array.from({ length: observationCount }, (_, index) => (
            observationCount === 1
                ? 1
                : Math.round(1 + (index * (maximumDay - 1) / (observationCount - 1)))
        )))];

        for (const day of days) {
            const observationDate = new Date(Date.UTC(
                monthStart.getUTCFullYear(),
                monthStart.getUTCMonth(),
                day,
                12
            ));
            const observationKey = dateKey(observationDate);
            if (observationKey >= historyStart && observationKey <= today) {
                observations.push({
                    ageDays: Math.round((todayDate - observationDate) / DAY_MS),
                    date: observationKey
                });
            }
        }
        monthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 12));
    }

    const ensureObservation = (date, ageDays) => {
        if (!observations.some(observation => observation.date === date)) observations.push({ date, ageDays });
    };
    ensureObservation(historyStart, DEMO_HISTORY_DAYS - 1);
    ensureObservation(today, 0);
    observations.sort((left, right) => left.date.localeCompare(right.date));

    let entryNumber = 1;
    const generatedEntryIds = [];
    const entries = historyConfigs.flatMap(config => observations.map(observation => {
        const entry = {
            Id: `${GENERATED_ENTRY_ID_PREFIX}${entryNumber++}`,
            Type: config.type,
            Name: config.name,
            AssetId: config.assetId,
            Value: valueAtAge(config, observation.ageDays),
            Date: observation.date,
            Time: config.time,
            Source: 'Demo'
        };
        if (config.investedCurrent !== undefined) {
            entry.InvestedCapital = valueAtAge({
                current: config.investedCurrent,
                start: config.investedStart,
                volatility: config.investedVolatility,
                phase: config.phase + 0.35
            }, observation.ageDays);
        }
        if (config.mortgageCurrent !== undefined) {
            entry.Mortgage = valueAtAge({
                current: config.mortgageCurrent,
                start: config.mortgageStart,
                volatility: config.mortgageVolatility,
                phase: config.phase + 0.5
            }, observation.ageDays);
        }
        return entry;
    }));

    // Normalize only the generated baseline to a readable net-worth band. The
    // per-date multiplier preserves the curve's direction changes and category
    // proportions while keeping property equity valid. User entries are added
    // later as an overlay and are deliberately never clamped.
    const rawTotals = new Map(observations.map(observation => {
        const total = entries
            .filter(entry => entry.Date === observation.date)
            .reduce((sum, entry) => sum + (entry.Type === 'property'
                ? numberValue(entry.Value) - numberValue(entry.Mortgage)
                : numberValue(entry.Value)), 0);
        return [observation.date, total];
    }));
    const rawValues = [...rawTotals.values()].filter(value => Number.isFinite(value));
    const rawMinimum = Math.min(...rawValues);
    const rawMaximum = Math.max(...rawValues);
    const rawCenter = (rawMinimum + rawMaximum) / 2;
    const rawRange = Math.max(rawMaximum - rawMinimum, 1);
    const targetHalfRange = (DEMO_VALUE_BOUNDS.max - DEMO_VALUE_BOUNDS.min) * 0.44;
    const scaleByDate = new Map([...rawTotals.entries()].map(([date, rawTotal]) => {
        const target = Math.min(
            DEMO_VALUE_BOUNDS.max - 1000,
            Math.max(
                DEMO_VALUE_BOUNDS.min + 1000,
                DEMO_VALUE_BOUNDS.center + ((rawTotal - rawCenter) / rawRange) * targetHalfRange
            )
        );
        return [date, rawTotal > 0 ? target / rawTotal : 1];
    }));

    entries.forEach(entry => {
        const scale = scaleByDate.get(entry.Date) || 1;
        entry.Value = Math.max(0, Math.round(numberValue(entry.Value) * scale));
        if (entry.InvestedCapital !== undefined) {
            entry.InvestedCapital = Math.max(0, Math.round(numberValue(entry.InvestedCapital) * scale));
        }
        if (entry.Mortgage !== undefined) {
            entry.Mortgage = Math.min(entry.Value, Math.max(0, Math.round(numberValue(entry.Mortgage) * scale)));
        }
        generatedEntryIds.push(entry.Id);
    });

    return {
        settings: {
            wealthWatcherGeneralSettings: json({ showZeroValuesOnDashboard: false, showZeroValuesOnHistory: false, showSparklines: true }),
            wealthWatcherFeatureSettings: json({ fire: true, tracker: true, forecast: true, budget: true, milestones: false }),
            wealthWatcherMilestoneSettings: json({ targets: [] }),
            wealthWatcherForecastSettings: json({ dateOfBirth: '1990-06-15', annualReturn: 4, monthlyContribution: 1500, forecastStrategy: 'fire-default' }),
            wealthWatcherFireSettings: json({ targetIncome: 4000, swr: 4, includeStatePension: false, statePensionAmount: 12547, includeWindfalls: false, expectedWindfalls: 0, includedAssets: ['investments', 'pensions', 'property'] }),
            wealthWatcherBudgetSettings: json(clone(budgetSettings))
        },
        groups,
        categories: clone(CATEGORY_SEEDS),
        assets,
        entries,
        audits: [{ Id: 'audit-1', StartTime: getDemoNow().toISOString(), ProviderName: 'Demo data', Status: 'Completed', StatusClass: 'success', RecordsAdded: entries.length, LogMessage: 'Demo portfolio loaded.' }],
        integrations: [],
        integrationCatalog: [
            { Key: 'snaptrade', DisplayName: 'SnapTrade', Description: 'Connect investment accounts', SupportsWebhooks: true, MinimumPollingIntervalMinutes: 60 },
            { Key: 'demo-bank', DisplayName: 'Demo Bank', Description: 'Connect a demonstration cash account', MinimumPollingIntervalMinutes: 30 }
        ],
        marketHours: clone(DEFAULT_MARKET_HOURS),
        webhookRelay: {
            Configured: false,
            Enabled: false,
            CanToggle: false,
            CanTest: false,
            Connected: false,
            RelayPublicBaseUrl: null,
            LastConnectedAt: null,
            LastMessageAt: null,
            LastTestAt: null,
            LastTestId: null,
            LastError: null
        },
        demoMeta: {
            schemaVersion: 5,
            generatedAsOf: today,
            generatedEntryIds,
            generatedEntryPrefix: GENERATED_ENTRY_ID_PREFIX,
            seedAuditId: 'audit-1'
        },
        nextIds: { asset: 5, entry: 1, value: 1, property: 2, connection: 1, account: 1, audit: 2 }
    };
}

function demoStorage() {
    try {
        return globalThis.window?.localStorage || globalThis.localStorage || null;
    } catch {
        return null;
    }
}

function mergeCollection(base, overlay, key = 'Id') {
    const merged = Array.isArray(base) ? clone(base) : [];
    if (!Array.isArray(overlay)) return merged;

    const indexes = new Map(merged
        .map((item, index) => [String(item?.[key] ?? ''), index])
        .filter(([id]) => id));
    overlay.forEach(item => {
        if (!isRecord(item)) return;
        const id = String(item[key] ?? '');
        if (!id) return;
        if (indexes.has(id)) {
            merged[indexes.get(id)] = { ...merged[indexes.get(id)], ...clone(item) };
            return;
        }
        indexes.set(id, merged.length);
        merged.push(clone(item));
    });
    return merged;
}

function storedGeneratedEntryIds(stored) {
    const declared = stored?.demoMeta?.generatedEntryIds;
    if (Array.isArray(declared) && declared.length) return new Set(declared.map(String));
    return new Set((Array.isArray(stored?.entries) ? stored.entries : [])
        .filter(entry => entry?.Source === 'Demo' || String(entry?.Id || '').startsWith(GENERATED_ENTRY_ID_PREFIX))
        .map(entry => String(entry.Id)));
}

function storedOverlayEntries(stored) {
    const generatedIds = storedGeneratedEntryIds(stored);
    return (Array.isArray(stored?.entries) ? stored.entries : [])
        .filter(entry => isRecord(entry) && !generatedIds.has(String(entry.Id)))
        .map(clone);
}

function storedOverlayAudits(stored) {
    const seedAuditId = stored?.demoMeta?.seedAuditId || 'audit-1';
    return (Array.isArray(stored?.audits) ? stored.audits : [])
        .filter(audit => isRecord(audit) && String(audit.Id) !== String(seedAuditId))
        .map(clone);
}

function nextNumericId(items, kind, fallback) {
    const pattern = new RegExp(`^${kind}-(\\d+)$`);
    const highest = (Array.isArray(items) ? items : []).reduce((max, item) => {
        const match = String(item?.Id || '').match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
    }, fallback - 1);
    return highest + 1;
}

function recomputeNextIds(state) {
    const minimums = { asset: 5, entry: 1, value: 1, property: 2, connection: 1, account: 1, audit: 2 };
    const collections = {
        asset: state.assets,
        entry: state.entries,
        value: state.groups?.flatMap(group => group.Values || []),
        property: state.assets,
        connection: state.integrations,
        account: state.integrations?.flatMap(integration => integration.Accounts || []),
        audit: state.audits
    };
    state.nextIds = Object.fromEntries(Object.entries(minimums).map(([kind, fallback]) => [
        kind,
        Math.max(Number(state.nextIds?.[kind]) || 0, nextNumericId(collections[kind], kind, fallback))
    ]));
    return state;
}

function finalizeLoadedState(state, seeded) {
    state.settings = { ...seeded.settings, ...(isRecord(state.settings) ? state.settings : {}) };
    const budget = normalizePersistedSetting(
        'wealthWatcherBudgetSettings',
        state.settings.wealthWatcherBudgetSettings,
        state.assets
    );
    state.settings.wealthWatcherBudgetSettings = budget.value || seeded.settings.wealthWatcherBudgetSettings;
    state.demoMeta = state.demoMeta || clone(seeded.demoMeta);
    return recomputeNextIds(state);
}

function hydrateStoredState(stored, seeded) {
    const hydrated = {
        ...seeded,
        ...clone(stored),
        settings: { ...seeded.settings, ...(isRecord(stored?.settings) ? clone(stored.settings) : {}) },
        groups: Array.isArray(stored?.groups) ? clone(stored.groups) : seeded.groups,
        categories: Array.isArray(stored?.categories) && stored.categories.length
            ? clone(stored.categories)
            : seeded.categories,
        assets: Array.isArray(stored?.assets) ? clone(stored.assets) : seeded.assets,
        entries: Array.isArray(stored?.entries) ? clone(stored.entries) : seeded.entries,
        audits: Array.isArray(stored?.audits) ? clone(stored.audits) : seeded.audits,
        integrations: Array.isArray(stored?.integrations) ? clone(stored.integrations) : [],
        integrationCatalog: Array.isArray(stored?.integrationCatalog)
            ? clone(stored.integrationCatalog)
            : seeded.integrationCatalog,
        marketHours: isRecord(stored?.marketHours) ? clone(stored.marketHours) : seeded.marketHours,
        webhookRelay: { ...seeded.webhookRelay, ...(isRecord(stored?.webhookRelay) ? clone(stored.webhookRelay) : {}) },
        demoMeta: isRecord(stored?.demoMeta) ? clone(stored.demoMeta) : clone(seeded.demoMeta)
    };
    return finalizeLoadedState(hydrated, seeded);
}

function rebaseStoredState(stored, asOfDate = getDemoNow()) {
    const seeded = seedState({ asOfDate });
    const rebased = {
        ...seeded,
        settings: { ...seeded.settings, ...(isRecord(stored?.settings) ? clone(stored.settings) : {}) },
        groups: mergeCollection(seeded.groups, stored?.groups),
        categories: Array.isArray(stored?.categories) && stored.categories.length
            ? clone(stored.categories)
            : seeded.categories,
        assets: mergeCollection(seeded.assets, stored?.assets),
        entries: [...seeded.entries, ...storedOverlayEntries(stored)],
        audits: [...storedOverlayAudits(stored), ...seeded.audits],
        integrations: Array.isArray(stored?.integrations) ? clone(stored.integrations) : [],
        integrationCatalog: mergeCollection(seeded.integrationCatalog, stored?.integrationCatalog, 'Key'),
        marketHours: isRecord(stored?.marketHours) ? clone(stored.marketHours) : seeded.marketHours,
        webhookRelay: { ...seeded.webhookRelay, ...(isRecord(stored?.webhookRelay) ? clone(stored.webhookRelay) : {}) }
    };
    return finalizeLoadedState(rebased, seeded);
}

function writeStateToStorage(storage, state) {
    try {
        storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Browser storage is an enhancement; the in-memory demo remains usable.
    }
}

function loadStoredState() {
    const storage = demoStorage();
    if (!storage) return seedState();
    try {
        const currentRaw = storage.getItem(DEMO_STORAGE_KEY);
        const legacyRaw = storage.getItem(LEGACY_DEMO_STORAGE_KEY);
        const raw = currentRaw || legacyRaw;
        if (!raw) return seedState();

        const stored = JSON.parse(raw);
        if (!isRecord(stored)) return seedState();

        const now = getDemoNow();
        const seeded = seedState({ asOfDate: now });
        const storedAsOf = stored.demoMeta?.generatedAsOf;
        if (currentRaw && stored.demoMeta?.schemaVersion === 5 && storedAsOf === todayKey(now)) {
            return hydrateStoredState(stored, seeded);
        }

        const rebased = rebaseStoredState(stored, now);
        writeStateToStorage(storage, rebased);
        return rebased;
    } catch {
        return seedState();
    }
}

function persistState() {
    const storage = demoStorage();
    if (!storage) return;
    writeStateToStorage(storage, demoState);
}

let demoState = loadStoredState();

export function ensureDemoStateFresh(asOfDate = getDemoNow()) {
    const targetDate = todayKey(asOfDate);
    if (demoState.demoMeta?.generatedAsOf === targetDate) return false;
    demoState = rebaseStoredState(demoState, asOfDate);
    persistState();
    return true;
}

function resolveBudgetSeed(seed) {
    if (seed === 'legacy') return createLegacyBudgetSettings();
    if (seed === 'v2' || seed === 'default' || seed === undefined || seed === null) {
        return createDefaultBudgetSettings();
    }
    if (isRecord(seed?.budgetSettings)) return clone(seed.budgetSettings);
    if (isRecord(seed)) return clone(seed);
    return createDefaultBudgetSettings();
}

/**
 * Reset to the default v2 fixture, or to the explicit legacy fixture used by
 * migration/read-parity tests. A document object may also be supplied when a
 * caller needs a deterministic custom seed.
 */
export function resetDemoState(seed = 'default', { asOfDate = getDemoNow() } = {}) {
    demoState = seedState({ budgetSettings: resolveBudgetSeed(seed), asOfDate });
    const storage = demoStorage();
    try {
        storage?.removeItem(DEMO_STORAGE_KEY);
        storage?.removeItem(LEGACY_DEMO_STORAGE_KEY);
    } catch { /* storage is optional */ }
    return clone(demoState);
}

export function getDemoState() {
    ensureDemoStateFresh();
    return clone(demoState);
}

export function getDemoStore() {
    return demoState;
}

class DemoResponse {
    constructor(payload, status = 200, statusText = '') {
        this.status = status;
        this.statusText = statusText || (status >= 200 && status < 300 ? 'OK' : 'Error');
        this.ok = status >= 200 && status < 300;
        this.headers = new Map([['content-type', 'application/json']]);
        this.headers.get = this.headers.get.bind(this.headers);
        this._text = payload === undefined ? '' : typeof payload === 'string' ? payload : json(payload);
        this.body = this._text;
    }

    async json() {
        if (!this._text) throw new SyntaxError('The demo response has no JSON body.');
        return JSON.parse(this._text);
    }

    async text() {
        return this._text;
    }
}

const response = (payload, status = 200) => new DemoResponse(payload, status);
const errorResponse = (message, status = 404) => response({ Error: message }, status);

function parseRequestUrl(input) {
    const raw = input instanceof URL ? input.toString() : String(input ?? '');
    const parsed = new URL(raw, 'http://wealthwatcher.demo');
    let path = parsed.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    if (path === '/api') path = '/';
    else if (path.startsWith('/api/')) path = path.slice(4);
    return { parsed, path };
}

function readBody(options) {
    if (!options || options.body === undefined || options.body === null || options.body === '') return {};
    if (typeof options.body === 'object') return clone(options.body);
    try {
        return JSON.parse(options.body);
    } catch (error) {
        throw new Error(`Invalid JSON body for demo request: ${error.message}`);
    }
}

function nextId(kind) {
    const number = demoState.nextIds[kind]++;
    return idFrom(kind, number);
}

function findGroup(key) {
    const normalizedKey = normalize(key);
    return demoState.groups.find(group => normalize(group.Key) === normalizedKey || String(group.Id) === String(key));
}

function findValue(id) {
    return demoState.groups.flatMap(group => group.Values || []).find(value => String(value.Id) === String(id));
}

function findAsset(id) {
    return demoState.assets.find(asset => String(asset.Id) === String(id));
}

function categoryForType(type) {
    const normalizedType = normalize(type).replace(/\s+/g, '-');
    return demoState.categories.find(category => normalize(category.Id) === normalizedType || normalize(category.Label) === normalizedType)
        || demoState.categories.find(category => normalizedType.startsWith(normalize(category.Id)));
}

function categoryForAsset(asset) {
    if (!asset) return null;
    const kind = findValue(asset.AssetKindId);
    return categoryForType(kind?.Key)
        || categoryForType(asset.EntryKind)
        || categoryForType(asset.AssetGroupCode);
}

function categoryForEntry(entry) {
    const asset = entry.AssetId ? findAsset(entry.AssetId) : null;
    return categoryForAsset(asset) || categoryForType(entry.Type) || demoState.categories[0];
}

function entryValue(entry) {
    const value = numberValue(entry.Value);
    return categoryForEntry(entry)?.Id === 'property' ? value - numberValue(entry.Mortgage) : value;
}

function entityKey(entry) {
    return String(entry.AssetId || `${categoryForEntry(entry)?.Id || 'other'}:${entry.Name || entry.Id}`);
}

function visibleEntries(now = getDemoNow()) {
    return demoState.entries.filter(entry => isEntryVisibleAt(entry, now));
}

function allObservationDates(now = getDemoNow()) {
    return [...new Set([...visibleEntries(now).map(entry => entry.Date), todayKey()])].sort();
}

function periodStart(period) {
    const days = ({ '1D': 1, '1W': 7, '1M': 31, '3M': 93, '6M': 186, '1Y': 366 }[String(period).toUpperCase()] ?? null);
    return days ? dateKey(addDays(todayKey(), -days)) : null;
}

function buildCategoryHistory(category, period) {
    const now = getDemoNow();
    const entries = demoState.entries
        .filter(entry => categoryForEntry(entry)?.Id === category.Id && isEntryVisibleAt(entry, now))
        .sort((left, right) => `${left.Date}T${left.Time || ''}`.localeCompare(`${right.Date}T${right.Time || ''}`));
    const start = periodStart(period);
    const dates = allObservationDates(now).filter(date => !start || date >= start);
    const latest = new Map();
    const data = [];
    dates.forEach(date => {
        entries.filter(entry => entry.Date <= date).forEach(entry => latest.set(entityKey(entry), entry));
        const currentEntries = [...latest.values()];
        const value = currentEntries.reduce((total, entry) => total + entryValue(entry), 0);
        if (currentEntries.length || date === todayKey()) {
            const invested = currentEntries.reduce((total, entry) => total + numberValue(entry.InvestedCapital), 0);
            const breakdown = currentEntries.reduce((values, entry) => {
                const name = entry.Name || entry.Id;
                values[name] = numberValue(values[name]) + entryValue(entry);
                return values;
            }, {});
            const point = { Time: date, Value: Number(value.toFixed(2)), Invested: Number(invested.toFixed(2)), Breakdown: breakdown, HasObservation: entries.some(entry => entry.Date === date) };
            if (category.Id === 'property') {
                point.GrossValue = Number(currentEntries.reduce((total, entry) => total + numberValue(entry.Value), 0).toFixed(2));
                point.Equity = point.Value;
            }
            data.push(point);
        }
    });
    const aggregate = {
        Data: data,
        LastSyncDateTime: getDemoNow().toISOString(),
        LatestBreakdown: data.at(-1)?.Breakdown || {}
    };
    if (category.Id === 'property') {
        const properties = demoState.assets
            .filter(asset => asset.EntryKind === 'Property' && !asset.Archived)
            .map(asset => {
                const entry = latest.get(asset.Id);
                const value = entry ? numberValue(entry.Value) : 0;
                const mortgage = entry ? numberValue(entry.Mortgage) : 0;
                return { Id: asset.Id, Name: asset.DisplayName, Value: value, Mortgage: mortgage, Equity: value - mortgage };
            });
        const value = properties.reduce((total, property) => total + property.Value, 0);
        const mortgage = properties.reduce((total, property) => total + property.Mortgage, 0);
        aggregate.PropertyDetails = {
            Properties: properties,
            Totals: { Value: value, Mortgage: mortgage, Equity: value - mortgage }
        };
    }
    if (category.Id === 'investments' || category.Id === 'pensions') {
        aggregate.InvestmentDetails = currentInvestmentDetails(category, entries);
    }
    return aggregate;
}

function currentInvestmentDetails(category, categoryEntries) {
    const latest = new Map();
    categoryEntries.forEach(entry => {
        if (!latest.has(entityKey(entry)) || `${entry.Date}T${entry.Time || ''}` >= `${latest.get(entityKey(entry)).Date}T${latest.get(entityKey(entry)).Time || ''}`) latest.set(entityKey(entry), entry);
    });
    return [...latest.values()].reduce((details, entry) => {
        const currentValue = entryValue(entry);
        const growthValue = Number((currentValue * 0.62).toFixed(2));
        const defensiveValue = Number((currentValue - growthValue).toFixed(2));
        const positions = [
            {
                Ticker: 'DEMO-GROWTH',
                Name: 'Global equity fund',
                Quantity: 100,
                AveragePrice: Number((growthValue * 0.92 / 100).toFixed(2)),
                CurrentPrice: Number((growthValue / 100).toFixed(2)),
                CurrentValue: growthValue
            },
            {
                Ticker: 'DEMO-BALANCED',
                Name: 'Global bond fund',
                Quantity: 100,
                AveragePrice: Number((defensiveValue * 0.98 / 100).toFixed(2)),
                CurrentPrice: Number((defensiveValue / 100).toFixed(2)),
                CurrentValue: defensiveValue
            }
        ];
        const name = entry.Name || entry.Id;
        details[name] = [...(details[name] || []), ...positions];
        return details;
    }, {});
}

function buildDashboard(period) {
    const categories = demoState.categories.map(category => ({
        ...clone(category),
        Aggregate: buildCategoryHistory(category, period)
    }));
    const ytdCategories = demoState.categories.map(category => ({
        ...clone(category),
        Aggregate: buildCategoryHistory(category, '1Y')
    }));
    const timeline = buildTimeline(categories);
    const ytdTimeline = buildTimeline(ytdCategories);
    const currentTotal = timeline.at(-1)?.Value || 0;
    const previousTotal = timeline.at(-2)?.Value ?? currentTotal;
    const ytdStartTotal = ytdTimeline[0]?.Value || 0;
    return {
        Categories: categories,
        Timeline: timeline,
        YtdCategories: ytdCategories,
        CurrentTotal: currentTotal,
        PreviousTotal: previousTotal,
        YtdStartTotal: ytdStartTotal,
        Contributors: categories.map(category => {
            const data = category.Aggregate?.Data || [];
            const current = data.at(-1)?.Value || 0;
            const first = data[0]?.Value || 0;
            return {
                Name: category.Label,
                Color: category.Color,
                CurrentValue: current,
                Delta: current - first,
                DeltaInvested: (data.at(-1)?.Invested || 0) - (data[0]?.Invested || 0)
            };
        }).filter(item => item.CurrentValue !== 0 || item.Delta !== 0),
        LastSyncDateTime: getDemoNow().toISOString()
    };
}

function buildTimeline(categories) {
    const totals = new Map();
    categories.forEach(category => (category.Aggregate?.Data || []).forEach(point => {
        totals.set(point.Time, Number(((totals.get(point.Time) || 0) + numberValue(point.Value)).toFixed(2)));
    }));
    return [...totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([Time, Value]) => ({ Time, Value }));
}

function buildCurrentObservation(categoryId = null) {
    const categories = demoState.categories
        .filter(category => !categoryId || category.Id === categoryId)
        .map(category => ({ ...clone(category), ...buildCategoryHistory(category, '1D') }));
    return categoryId ? (categories[0] || null) : { Categories: categories, Data: categories.flatMap(category => category.Data || []) };
}

function namesForCategory(categoryId) {
    const category = categoryForType(categoryId);
    const names = new Map();
    demoState.assets.filter(asset => !asset.Archived && categoryForAsset(asset)?.Id === category?.Id)
        .forEach(asset => names.set(asset.Id, { ...clone(asset), Name: asset.DisplayName }));
    visibleEntries().filter(entry => categoryForEntry(entry)?.Id === category?.Id)
        .forEach(entry => names.set(entityKey(entry), { Id: entry.AssetId || entityKey(entry), Name: entry.Name, DisplayName: entry.Name, AssetId: entry.AssetId }));
    return [...names.values()];
}

function catalogueAssets(searchParams) {
    let assets = demoState.assets.slice();
    const classificationValueId = searchParams.get('classificationValueId');
    if (classificationValueId) assets = assets.filter(asset => String(asset.AssetKindId) === String(classificationValueId) || String(asset.AssetGroupId) === String(classificationValueId));
    return clone(assets);
}

function createAudit(message, providerName = 'Demo data', recordsAdded = 0) {
    demoState.audits.unshift({ Id: nextId('audit'), StartTime: getDemoNow().toISOString(), ProviderName: providerName, Status: 'Completed', StatusClass: 'success', RecordsAdded: recordsAdded, LogMessage: message });
}

function addEntry(payload, defaults = {}) {
    const entry = {
        Id: nextId('entry'),
        Type: payload.Type || defaults.Type || 'cash',
        Name: payload.Name || defaults.Name || 'Demo entry',
        AssetId: payload.AssetId || defaults.AssetId,
        Value: numberValue(payload.Value),
        Mortgage: numberValue(payload.Mortgage),
        InvestedCapital: numberValue(payload.InvestedCapital),
        Date: payload.Date || todayKey(),
        Time: payload.Time || '12:00:00',
        Source: payload.Source || 'Manual'
    };
    demoState.entries.push(entry);
    return entry;
}

function propertyValuesAreValid(payload) {
    const value = payload?.Value;
    const mortgage = payload?.Mortgage;
    const validNumber = candidate => candidate === undefined || candidate === null || candidate === '' || Number.isFinite(Number(candidate));
    return validNumber(value) && validNumber(mortgage) && numberValue(value) >= 0 && numberValue(mortgage) >= 0;
}

function propertyValidationResponse(payload) {
    return propertyValuesAreValid(payload)
        ? null
        : errorResponse('Property value and mortgage must be zero or greater.', 400);
}

function createAsset(payload, type = 'cash') {
    const requestedKind = payload.AssetKindId || payload.ClassificationValueId;
    const kind = findValue(requestedKind) || findValue(`kind-${normalize(type)}`) || findValue('kind-cash');
    const asset = {
        Id: nextId('asset'),
        DisplayName: payload.DisplayName || payload.Name || 'New asset',
        Name: payload.DisplayName || payload.Name || 'New asset',
        AssetKindId: kind.Id,
        AssetGroupId: payload.AssetGroupId ?? kind.AssetGroupId ?? null,
        EntryKind: kind.EntryKind || 'Cash',
        Archived: false
    };
    demoState.assets.push(asset);
    return asset;
}

function updateObject(target, payload) {
    Object.entries(payload || {}).forEach(([key, value]) => {
        if (key !== 'Id') target[key] = clone(value);
    });
    return target;
}

function findIntegration(id) {
    return demoState.integrations.find(item => String(item.Id) === String(id));
}

function normalizeDemoMilestoneSettings(value) {
    let parsed;
    try {
        parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        throw new Error('Milestone settings must be valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.targets)) {
        throw new Error('Milestone targets must be an array.');
    }

    const targets = parsed.targets.map(target => Number(target));
    if (targets.some(target => !Number.isFinite(target) || target <= 0)) {
        throw new Error('Milestone targets must be greater than £0.');
    }
    if (targets.length > 50) throw new Error('You can configure up to 50 milestones.');

    const normalized = targets.map(target => Number(target.toFixed(2))).sort((left, right) => left - right);
    if (normalized.some((target, index) => index > 0 && target === normalized[index - 1])) {
        throw new Error('Milestone targets must be unique.');
    }
    if (targets.some(target => Math.abs(target * 100 - Math.round(target * 100)) > 1e-8)) {
        throw new Error('Milestone targets can have no more than two decimal places.');
    }
    return json({ targets: normalized });
}

function mutateSettings(body) {
    if (Object.prototype.hasOwnProperty.call(body, 'wealthWatcherMilestoneSettings')) {
        try {
            body.wealthWatcherMilestoneSettings = normalizeDemoMilestoneSettings(body.wealthWatcherMilestoneSettings);
        } catch (error) {
            return error.message;
        }
    }

    Object.entries(body).forEach(([key, value]) => {
        demoState.settings[key] = value;
        try {
            const parsed = JSON.parse(demoState.settings[key]);
            if (key === 'wealthWatcherGeneralSettings') store.state.generalSettings = parsed;
            if (key === 'wealthWatcherFeatureSettings') store.state.featureSettings = parsed;
            if (key === 'wealthWatcherForecastSettings') store.state.forecastSettings = parsed;
            if (key === 'wealthWatcherFireSettings') store.state.fireSettings = parsed;
            if (key === 'wealthWatcherBudgetSettings') store.state.budgetSettings = parsed;
            if (key === 'wealthWatcherMilestoneSettings') store.state.milestoneSettings = parsed;
        } catch {
            // Settings are persisted as opaque JSON strings by the real API.
        }
    });
    return null;
}

function handleGet(path, searchParams) {
    if (path === '/settings') return response(safeSettingsSnapshot());
    if (path === '/classification-groups') return response(clone(demoState.groups));
    const groupValuesMatch = path.match(/^\/classification-groups\/([^/]+)\/values$/);
    if (groupValuesMatch) {
        const group = findGroup(decodeURIComponent(groupValuesMatch[1]));
        return group ? response(clone(group.Values || [])) : errorResponse(`Classification group '${groupValuesMatch[1]}' was not found.`);
    }
    if (path === '/categories') return response(clone(demoState.categories));
    if (path === '/assets') return response(catalogueAssets(searchParams));
    const assetMatch = path.match(/^\/assets\/([^/]+)$/);
    if (assetMatch) {
        const asset = findAsset(decodeURIComponent(assetMatch[1]));
        return asset ? response(clone(asset)) : errorResponse(`Asset '${assetMatch[1]}' was not found.`);
    }
    const valueMatch = path.match(/^\/classification-values\/([^/]+)$/);
    if (valueMatch) {
        const value = findValue(decodeURIComponent(valueMatch[1]));
        return value ? response(clone(value)) : errorResponse(`Classification value '${valueMatch[1]}' was not found.`);
    }
    const namesMatch = path.match(/^\/wealth\/([^/]+)\/names$/);
    if (namesMatch) return response(namesForCategory(decodeURIComponent(namesMatch[1])));
    if (path === '/dashboard') return response(buildDashboard(searchParams.get('period') || '1M'));
    if (path === '/history') return response(buildDashboard(searchParams.get('period') || '1Y'));
    if (path === '/audits') {
        const page = Math.max(1, Number(searchParams.get('page')) || 1);
        const pageSize = Math.max(1, Number(searchParams.get('pageSize')) || 10);
        return response({ Rows: clone(demoState.audits.slice((page - 1) * pageSize, page * pageSize)), Total: demoState.audits.length, Page: page, PageSize: pageSize });
    }
    if (path === '/calendar') return response(buildCalendar(searchParams.get('year'), searchParams.get('month')));
    if (path === '/integrations/catalog') return response(clone(demoState.integrationCatalog));
    if (path === '/integrations') return response(clone(demoState.integrations));
    if (path === '/integrations/webhook-relay/status') return response(clone(demoState.webhookRelay));
    if (path === '/integrations/settings') return response(clone(demoState.marketHours));
    const integrationMatch = path.match(/^\/integrations\/([^/]+)$/);
    if (integrationMatch) {
        const integration = findIntegration(decodeURIComponent(integrationMatch[1]));
        return integration ? response(clone(integration)) : errorResponse(`Integration '${integrationMatch[1]}' was not found.`);
    }
    const propertyMatch = path.match(/^\/properties\/([^/]+)$/);
    if (propertyMatch) {
        const asset = findAsset(decodeURIComponent(propertyMatch[1]));
        if (!asset || asset.EntryKind !== 'Property') return errorResponse(`Property '${propertyMatch[1]}' was not found.`);
        const entry = demoState.entries
            .filter(item => item.AssetId === asset.Id && isEntryVisibleAt(item))
            .sort((a, b) => entryTimestamp(b) - entryTimestamp(a))[0];
        return response({ Id: asset.Id, Name: asset.DisplayName, Value: entry?.Value || 0, Mortgage: entry?.Mortgage || 0, Archived: asset.Archived });
    }
    const categoryAggregateMatch = path.match(/^\/wealth\/([^/]+)\/(aggregate|current|current-observation)$/);
    if (categoryAggregateMatch) return response(buildCurrentObservation(decodeURIComponent(categoryAggregateMatch[1])));
    if (path === '/wealth/aggregate' || path === '/wealth/current' || path === '/current-observation' || path === '/wealth/current-observations') return response({ Date: todayKey(), Categories: demoState.categories.map(category => category.Id) });
    throw new Error(`Unsupported demo GET route: ${path}`);
}

function buildCalendar(yearValue, monthValue) {
    const now = getDemoNow();
    const year = Number(yearValue) || now.getUTCFullYear();
    const month = Number(monthValue) || now.getUTCMonth() + 1;
    const first = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const allDates = allObservationDates();
    const days = Array.from({ length: lastDay }, (_, index) => {
        const date = dateKey(new Date(first.getTime() + index * DAY_MS));
        const total = portfolioTotalAtDate(date);
        const previousDate = dateKey(new Date(first.getTime() + (index - 1) * DAY_MS));
        const previousTotal = portfolioTotalAtDate(previousDate);
        const hasObservation = demoState.entries.some(entry => entry.Date === date);
        const hasPreviousObservation = demoState.entries.some(entry => entry.Date === previousDate);
        const changeAvailable = hasObservation && hasPreviousObservation && total !== null && previousTotal !== null;
        const change = changeAvailable ? Number((total - previousTotal).toFixed(2)) : null;
        const percentage = changeAvailable && previousTotal !== 0
            ? Number(((change / previousTotal) * 100).toFixed(4))
            : changeAvailable ? 0 : null;
        return {
            Date: date,
            Total: total === null ? null : Number(total.toFixed(2)),
            HasObservation: hasObservation,
            ChangeAvailable: changeAvailable,
            Change: change,
            Percentage: percentage,
            IsFuture: date > todayKey()
        };
    });
    const previousMonth = new Date(Date.UTC(year, month - 2, 1));
    const previous = buildCalendarTotals(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth() + 1);
    const current = [...days].reverse().find(day => day.HasObservation && day.Total !== null);
    const prior = [...previous].reverse().find(day => day.HasObservation && day.Total !== null);
    return {
        Days: days,
        EarliestHistoryDate: allDates[0] || null,
        MonthComparison: current && prior ? {
            Available: true,
            CurrentTotal: current.Total,
            PreviousTotal: prior.Total,
            Change: Number((current.Total - prior.Total).toFixed(2)),
            Percentage: prior.Total === 0 ? 0 : Number((((current.Total - prior.Total) / prior.Total) * 100).toFixed(4)),
            CurrentDate: current.Date,
            PreviousDate: prior.Date
        } : null
    };
}

function buildCalendarTotals(year, month) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({ length: lastDay }, (_, index) => {
        const date = dateKey(new Date(Date.UTC(year, month - 1, index + 1)));
        return { Date: date, Total: portfolioTotalAtDate(date), HasObservation: demoState.entries.some(entry => entry.Date === date) };
    });
}

function portfolioTotalAtDate(date) {
    const totals = demoState.categories.map(category => {
        const points = buildCategoryHistory(category, 'ALL').Data.filter(point => point.Time <= date);
        return points.at(-1)?.Value;
    }).filter(value => value !== undefined);
    return totals.length ? Number(totals.reduce((total, value) => total + numberValue(value), 0).toFixed(2)) : null;
}

function handleWrite(path, method, body, searchParams) {
    if (path === '/settings' && method === 'POST') {
        if (!isRecord(body)) return errorResponse('A settings object is required.', 400);
        const normalized = {};
        for (const [key, value] of Object.entries(body)) {
            if (!PERSISTED_SETTING_KEYS.includes(key)) continue;
            const result = normalizePersistedSetting(key, value, demoState.assets, { strictBudget: true });
            if (result.error) return errorResponse(result.error, 400);
            normalized[key] = result.value;
        }
        const error = mutateSettings(normalized);
        if (error) return errorResponse(error, 400);
        return response();
    }
    if (path === '/sync' && method === 'POST') {
        createAudit('Demo sync completed.', 'Demo sync', 0);
        return response({ Succeeded: true, Message: 'Demo data synchronized successfully.', LastSyncDateTime: getDemoNow().toISOString() });
    }
    if (path === '/wealth' && method === 'POST') {
        if (!isRecord(body)) return errorResponse('A wealth entry object is required.', 400);
        let asset = body.AssetId ? findAsset(body.AssetId) : null;
        if (body.AssetId && !asset) return errorResponse('Asset not found.', 404);
        if (asset?.Archived) return errorResponse('Archived assets cannot receive new entries.', 400);
        const requestedCategory = categoryForAsset(asset)
            || categoryForType(body.AssetKindCode)
            || categoryForType(body.Type);
        if (requestedCategory?.Id === 'property') {
            const validation = propertyValidationResponse(body);
            if (validation) return validation;
        }
        if (!asset) asset = createAsset({ DisplayName: body.Name, AssetKindId: body.ClassificationValueIds?.[0] }, body.Type);
        const entry = addEntry(body, { AssetId: asset.Id, Type: categoryForType(body.Type)?.Id || body.Type, Name: asset.DisplayName });
        createAudit(`Added ${entry.Name}.`, 'Manual entry', 1);
        return response(clone(entry), 201);
    }
    if (path === '/properties' && method === 'POST') {
        if (!isRecord(body) || !String(body.Name || '').trim()) return errorResponse('A property name is required.', 400);
        const validation = propertyValidationResponse(body);
        if (validation) return validation;
        const asset = createAsset({ DisplayName: body.Name, AssetKindId: 'kind-property' }, 'property');
        const entry = addEntry(body, { AssetId: asset.Id, Type: 'property', Name: asset.DisplayName });
        createAudit(`Added property ${asset.DisplayName}.`, 'Manual entry', 1);
        return response({ ...clone(asset), Entry: clone(entry) }, 201);
    }
    const propertyEntryMatch = path.match(/^\/properties\/([^/]+)\/entries$/);
    if (propertyEntryMatch && method === 'POST') {
        const asset = findAsset(decodeURIComponent(propertyEntryMatch[1]));
        if (!asset || asset.EntryKind !== 'Property') return errorResponse(`Property '${propertyEntryMatch[1]}' was not found.`);
        if (!isRecord(body)) return errorResponse('A property entry object is required.', 400);
        if (asset.Archived) return errorResponse('Archived properties cannot receive new entries.', 400);
        const validation = propertyValidationResponse(body);
        if (validation) return validation;
        const entry = addEntry(body, { AssetId: asset.Id, Type: 'property', Name: asset.DisplayName });
        createAudit(`Added property entry for ${asset.DisplayName}.`, 'Manual entry', 1);
        return response(clone(entry), 201);
    }
    const propertyMatch = path.match(/^\/properties\/([^/]+)$/);
    if (propertyMatch && method === 'PATCH') {
        const asset = findAsset(decodeURIComponent(propertyMatch[1]));
        if (!asset || asset.EntryKind !== 'Property') return errorResponse(`Property '${propertyMatch[1]}' was not found.`);
        if (body.Archived !== undefined) asset.Archived = body.Archived === true;
        createAudit(`${asset.Archived ? 'Archived' : 'Restored'} property ${asset.DisplayName}.`, 'Catalogue', 0);
        return response(clone(asset));
    }
    if (path === '/assets' && method === 'POST') {
        const asset = createAsset(body);
        createAudit(`Created asset ${asset.DisplayName}.`, 'Catalogue', 0);
        return response(clone(asset), 201);
    }
    const assetMatch = path.match(/^\/assets\/([^/]+)$/);
    if (assetMatch && method === 'PATCH') {
        const asset = findAsset(decodeURIComponent(assetMatch[1]));
        if (!asset) return errorResponse(`Asset '${assetMatch[1]}' was not found.`);
        updateObject(asset, body);
        if (body.DisplayName) asset.Name = body.DisplayName;
        createAudit(`${asset.Archived ? 'Archived' : 'Updated'} asset ${asset.DisplayName}.`, 'Catalogue', 0);
        return response(clone(asset));
    }
    const valuesMatch = path.match(/^\/classification-groups\/([^/]+)\/values$/);
    if (valuesMatch && method === 'POST') {
        const group = findGroup(decodeURIComponent(valuesMatch[1]));
        if (!group) return errorResponse(`Classification group '${valuesMatch[1]}' was not found.`);
        const value = { ...clone(body), Id: nextId('value'), DisplayName: body.DisplayName || body.Name || 'New value', ArchivedAt: null };
        group.Values = group.Values || [];
        group.Values.push(value);
        createAudit(`Created catalogue value ${value.DisplayName}.`, 'Catalogue', 0);
        return response(clone(value), 201);
    }
    const valueMatch = path.match(/^\/classification-values\/([^/]+)$/);
    if (valueMatch && (method === 'PATCH' || method === 'DELETE')) {
        const value = findValue(decodeURIComponent(valueMatch[1]));
        if (!value) return errorResponse(`Classification value '${valueMatch[1]}' was not found.`);
        if (method === 'DELETE') value.ArchivedAt = getDemoNow().toISOString();
        else updateObject(value, body);
        createAudit(`${method === 'DELETE' ? 'Archived' : 'Updated'} catalogue value ${value.DisplayName || value.Key}.`, 'Catalogue', 0);
        return response(clone(value));
    }
    if (path === '/wealth/forecast' && method === 'POST') {
        try {
            return response(buildForecast(body));
        } catch (error) {
            if (error instanceof DemoValidationError) return errorResponse(error.message, 400);
            throw error;
        }
    }
    if (path === '/integrations/settings' && method === 'PUT') {
        demoState.marketHours = updateObject(demoState.marketHours, body);
        return response(clone(demoState.marketHours));
    }
    if (path === '/integrations/webhook-relay/settings' && method === 'PUT') {
        if (body.Enabled && !demoState.webhookRelay.Configured)
            return errorResponse('The demo webhook relay is not configured.', 400);
        demoState.webhookRelay.Enabled = body.Enabled === true;
        demoState.webhookRelay.CanTest = demoState.webhookRelay.Enabled;
        return response(clone(demoState.webhookRelay));
    }
    if (path === '/integrations/webhook-relay/test' && method === 'POST') {
        if (!demoState.webhookRelay.Enabled)
            return response({ Succeeded: false, Message: 'The demo webhook relay is disabled.' });
        const testId = `demo-relay-test-${Date.now()}`;
        demoState.webhookRelay.LastTestId = testId;
        demoState.webhookRelay.LastTestAt = getDemoNow().toISOString();
        return response({
            Succeeded: true,
            Message: 'The demo relay delivered a test event to the API.',
            TestId: testId,
            RelayAccepted: true,
            RelayStatusCode: 202,
            ApiReceivedAt: demoState.webhookRelay.LastTestAt
        });
    }
    const providerMatch = path.match(/^\/integrations\/([^/]+)$/);
    if (providerMatch && method === 'POST') {
        const providerKey = decodeURIComponent(providerMatch[1]);
        const descriptor = demoState.integrationCatalog.find(item => item.Key === providerKey);
        if (!descriptor) return errorResponse(`Integration provider '${providerKey}' was not found.`);
        const integration = { Id: nextId('connection'), ProviderKey: providerKey, DisplayName: descriptor.DisplayName, Status: 'NeedsCredentials', SyncMode: 'Polling', PollingIntervalMinutes: descriptor.MinimumPollingIntervalMinutes || 60, Enabled: false, OnlyPollDuringMarketTimes: true, Accounts: [] };
        demoState.integrations.push(integration);
        return response(clone(integration), 201);
    }
    const integrationCredentialsMatch = path.match(/^\/integrations\/([^/]+)\/credentials$/);
    if (integrationCredentialsMatch && method === 'PUT') {
        const integration = findIntegration(decodeURIComponent(integrationCredentialsMatch[1]));
        if (!integration) return errorResponse(`Integration '${integrationCredentialsMatch[1]}' was not found.`);
        integration.Status = 'Ready';
        integration.CredentialsConfigured = true;
        return response(clone(integration));
    }
    const integrationTestMatch = path.match(/^\/integrations\/([^/]+)\/test$/);
    if (integrationTestMatch && method === 'POST') {
        const integration = findIntegration(decodeURIComponent(integrationTestMatch[1]));
        if (!integration) return errorResponse(`Integration '${integrationTestMatch[1]}' was not found.`);
        integration.Status = 'Connected';
        return response({ Succeeded: true, Message: 'The demo connection is working.' });
    }
    const discoverMatch = path.match(/^\/integrations\/([^/]+)\/accounts\/discover$/);
    if (discoverMatch && method === 'POST') {
        const integration = findIntegration(decodeURIComponent(discoverMatch[1]));
        if (!integration) return errorResponse(`Integration '${discoverMatch[1]}' was not found.`);
        if (!integration.Accounts.length) integration.Accounts.push({ Id: nextId('account'), Name: `${integration.DisplayName} demo account`, DisplayName: `${integration.DisplayName} demo account`, AssetAllocations: [] });
        integration.Status = 'AccountsDiscovered';
        return response({ Succeeded: true, Message: 'Demo accounts were discovered successfully.', Accounts: clone(integration.Accounts) });
    }
    const allocationMatch = path.match(/^\/integrations\/([^/]+)\/accounts\/([^/]+)\/allocation$/);
    if (allocationMatch && method === 'PUT') {
        const integration = findIntegration(decodeURIComponent(allocationMatch[1]));
        const account = integration?.Accounts.find(item => String(item.Id) === String(decodeURIComponent(allocationMatch[2])));
        if (!account) return errorResponse(`Integration account '${allocationMatch[2]}' was not found.`);
        const role = body.Role || 'Deployed';
        account.AssetAllocations = account.AssetAllocations || [];
        account.AssetAllocations = account.AssetAllocations.filter(item => item.Role !== role);
        if (!body.Clear) {
            const asset = body.AssetId ? findAsset(body.AssetId) : createAsset({ DisplayName: body.AssetName, AssetKindId: body.AssetKindId });
            if (!asset) return errorResponse(`Asset '${body.AssetId}' was not found.`);
            account.AssetAllocations.push({ Role: role, AssetId: asset.Id, AssetDisplayName: asset.DisplayName });
        }
        return response(clone(account));
    }
    if (providerMatch && method === 'PATCH') {
        const integration = findIntegration(decodeURIComponent(providerMatch[1]));
        if (!integration) return errorResponse(`Integration '${providerMatch[1]}' was not found.`);
        updateObject(integration, body);
        return response(clone(integration));
    }
    if (providerMatch && method === 'DELETE') {
        const index = demoState.integrations.findIndex(item => String(item.Id) === String(decodeURIComponent(providerMatch[1])));
        if (index < 0) return errorResponse(`Integration '${providerMatch[1]}' was not found.`);
        demoState.integrations.splice(index, 1);
        return response({ Succeeded: true });
    }
    throw new Error(`Unsupported demo ${method} route: ${path}`);
}

function requestField(request, lowerName, upperName) {
    if (Object.prototype.hasOwnProperty.call(request, lowerName)) return request[lowerName];
    if (Object.prototype.hasOwnProperty.call(request, upperName)) return request[upperName];
    return undefined;
}

function forecastCategoryValue(category) {
    const aggregate = buildCategoryHistory(category, 'ALL');
    return {
        hasData: aggregate.Data.length > 0,
        value: numberValue(aggregate.Data.at(-1)?.Value)
    };
}

function normalizeForecastCollection(request, lowerName, upperName) {
    const raw = requestField(request, lowerName, upperName);
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new DemoValidationError(`${upperName} must be an array.`);
    if (raw.some(item => !isRecord(item))) throw new DemoValidationError(`${upperName} must contain objects.`);
    return raw;
}

function buildForecast(request) {
    if (!isRecord(request)) throw new DemoValidationError('A forecast request object is required.');

    const rawIncluded = requestField(request, 'includedAssets', 'IncludedAssets');
    if (rawIncluded !== undefined && rawIncluded !== null && !Array.isArray(rawIncluded)) {
        throw new DemoValidationError('IncludedAssets must be an array.');
    }
    const includedValues = rawIncluded === undefined
        ? DEFAULT_FORECAST_INCLUDED_ASSETS
        : Array.isArray(rawIncluded) ? rawIncluded : [];
    const includedIds = new Set(includedValues.map(value => normalize(value)).filter(Boolean));
    const selectedCategories = demoState.categories.filter(category =>
        includedIds.has(normalize(category.Id)) ||
        includedIds.has(normalize(category.Label)) ||
        includedIds.has(normalize(category.ClassificationValueId)));

    const rawContributions = normalizeForecastCollection(request, 'contributions', 'Contributions');
    const rawWindfalls = normalizeForecastCollection(request, 'windfalls', 'Windfalls');
    const contributions = rawContributions
        .map(item => ({
            amount: numberValue(item.amount ?? item.Amount),
            assetId: item.assetId ?? item.AssetId ?? null,
            intervalMonths: cadenceMonths(item.cadence ?? item.Cadence)
        }))
        .filter(item => item.amount > 0);
    const windfalls = rawWindfalls
        .map((item, index) => ({
            index,
            amount: numberValue(item.amount ?? item.Amount),
            date: parseDateKey(item.expectedDate ?? item.ExpectedDate),
            include: (item.includeInCalculation ?? item.IncludeInCalculation) === true
        }))
        .filter(item => item.include);

    const allocationCategories = new Set();
    const allocated = new Map();
    const unallocated = [];
    const monthlyContribution = numberValue(requestField(request, 'monthlyContribution', 'MonthlyContribution'));
    if (monthlyContribution !== 0) unallocated.push({ amount: monthlyContribution, intervalMonths: 1 });
    contributions.forEach(contribution => {
        const category = contribution.assetId ? categoryForAsset(findAsset(contribution.assetId)) : null;
        if (category) {
            allocationCategories.add(category.Id);
            const categoryContributions = allocated.get(category.Id) || [];
            categoryContributions.push(contribution);
            allocated.set(category.Id, categoryContributions);
        } else {
            unallocated.push(contribution);
        }
    });

    const currentValues = new Map(selectedCategories
        .map(category => [category.Id, forecastCategoryValue(category)])
        .filter(([, result]) => result.hasData)
        .map(([categoryId, result]) => [categoryId, result.value]));
    allocationCategories.forEach(categoryId => {
        if (selectedCategories.some(category => category.Id === categoryId) && !currentValues.has(categoryId)) currentValues.set(categoryId, 0);
    });
    const forecastCategories = selectedCategories.filter(category => currentValues.has(category.Id));
    if (forecastCategories.length === 0) throw new DemoValidationError('No included asset data');

    const annualReturn = numberValue(requestField(request, 'annualReturn', 'AnnualReturn') ?? 4) / 100;
    const monthlyRate = annualReturn <= -1 ? -1 : Math.pow(1 + annualReturn, 1 / 12) - 1;
    const target = numberValue(requestField(request, 'target', 'Target') ?? 1000000);
    const today = todayKey();
    const currentWindfallIndexes = new Set();
    let windfallBalance = windfalls
        .filter(windfall => windfall.date && windfall.date <= today)
        .reduce((total, windfall) => {
            currentWindfallIndexes.add(windfall.index);
            return total + windfall.amount;
        }, 0);
    let unallocatedBalance = 0;
    const categoryValues = new Map(currentValues);
    const stackOrder = forecastCategories.map(category => category.Label);
    stackOrder.push(FORECAST_CONTRIBUTIONS_STACK);
    if (windfalls.some(windfall => windfall.include)) stackOrder.push(FORECAST_WINDFALLS_STACK);

    const buildPoint = (date) => {
        const values = Object.fromEntries(forecastCategories.map(category => [category.Label,
            Number((categoryValues.get(category.Id) || 0).toFixed(2))]));
        values[FORECAST_CONTRIBUTIONS_STACK] = Number(unallocatedBalance.toFixed(2));
        if (stackOrder.includes(FORECAST_WINDFALLS_STACK)) values[FORECAST_WINDFALLS_STACK] = Number(windfallBalance.toFixed(2));
        const total = Number(Object.values(values).reduce((sum, value) => sum + numberValue(value), 0).toFixed(2));
        return { Date: date, Values: values, Total: total };
    };

    const projection = [buildPoint(today)];
    let currentTotal = projection[0].Total;
    let targetHitMonth = currentTotal >= target ? 0 : -1;
    let targetHitDate = targetHitMonth === 0 ? today : null;
    let date = firstOfNextMonth(today);

    for (let month = 1; month <= 1200 && targetHitMonth < 0; month += 1) {
        const monthContributions = unallocated
            .filter(contribution => (month - 1) % contribution.intervalMonths === 0)
            .reduce((total, contribution) => total + contribution.amount, 0);
        unallocatedBalance = (unallocatedBalance + monthContributions) * (1 + monthlyRate);

        forecastCategories.forEach(category => {
            const additions = (allocated.get(category.Id) || [])
                .filter(contribution => (month - 1) % contribution.intervalMonths === 0)
                .reduce((total, contribution) => total + contribution.amount, 0);
            categoryValues.set(category.Id, (categoryValues.get(category.Id) + additions) * (1 + monthlyRate));
        });

        const currentMonth = monthKey(dateKey(date));
        let windfallAppliedThisPeriod = false;
        windfalls.forEach(windfall => {
            const isCurrentMonthFuture = month === 1 && windfall.date > today && monthKey(windfall.date) === monthKey(today);
            const isProjectionMonth = windfall.date && monthKey(windfall.date) === currentMonth;
            if (!currentWindfallIndexes.has(windfall.index) && (isCurrentMonthFuture || isProjectionMonth)) {
                windfallBalance += windfall.amount;
                currentWindfallIndexes.add(windfall.index);
                windfallAppliedThisPeriod = true;
            }
        });

        const point = buildPoint(dateKey(date));
        currentTotal = point.Total;
        if (currentTotal >= target) {
            targetHitMonth = month;
            targetHitDate = point.Date;
        }
        if (date.getUTCMonth() === 0 || targetHitMonth >= 0 || month === 1200 || windfallAppliedThisPeriod) {
            projection.push(point);
        }
        date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 12));
    }

    const strategy = normalizeForecastStrategy(requestField(request, 'forecastStrategy', 'ForecastStrategy'));
    return {
        CurrentNW: Number((currentValues.values().reduce((sum, value) => sum + numberValue(value), 0) +
            windfalls.filter(windfall => windfall.date && windfall.date <= today).reduce((sum, windfall) => sum + windfall.amount, 0)).toFixed(2)),
        Projection: projection,
        StackOrder: stackOrder,
        SelectedStrategy: strategy,
        SelectedStrategyDescription: FORECAST_STRATEGY_DESCRIPTIONS[strategy],
        TargetHitMonth: targetHitMonth,
        TargetHitDate: targetHitDate,
        RateSources: forecastCategories.map(category => ({
            AssetName: category.Label,
            AssetType: category.Id,
            AnnualRatePercent: annualReturn * 100,
            Source: strategy === 'fire-default' ? 'fire-default' : strategy,
            HistoricalPeriodCount: strategy === 'fire-default' ? 0 : 12
        }))
    };
}

export async function handleDemoRequest(url, options = {}) {
    ensureDemoStateFresh();
    const { path, parsed } = parseRequestUrl(url);
    const method = String(options.method || 'GET').toUpperCase();
    let body;
    try {
        body = readBody(options);
    } catch (error) {
        return errorResponse(error.message, 400);
    }
    if (method === 'GET' || method === 'HEAD') {
        const result = handleGet(path, parsed.searchParams);
        return method === 'HEAD' ? response(undefined, result.status) : result;
    }
    const result = handleWrite(path, method, body, parsed.searchParams);
    persistState();
    return result;
}

export { DemoResponse };
