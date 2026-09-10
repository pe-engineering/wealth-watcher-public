export const DEFAULT_GENERAL_SETTINGS = Object.freeze({
    showZeroValuesOnDashboard: false,
    showZeroValuesOnHistory: false,
    showSparklines: true
});

function withLegacyGeneralSettingsAlias(settings) {
    const normalized = {
        ...settings,
        showZeroValuesOnDashboard: settings.showZeroValuesOnDashboard === true,
        showZeroValuesOnHistory: settings.showZeroValuesOnHistory === true,
        showSparklines: settings.showSparklines !== false
    };

    Object.defineProperty(normalized, 'hideZeroValues', {
        configurable: true,
        enumerable: false,
        get() {
            return !normalized.showZeroValuesOnDashboard;
        },
        set(value) {
            normalized.showZeroValuesOnDashboard = value !== true;
        }
    });

    return normalized;
}

export function normalizeGeneralSettings(settings = {}) {
    const source = settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings
        : {};
    const hasDashboardSetting = Object.prototype.hasOwnProperty.call(source, 'showZeroValuesOnDashboard');
    const showZeroValuesOnDashboard = hasDashboardSetting
        ? source.showZeroValuesOnDashboard === true
        : source.hideZeroValues !== undefined
            ? source.hideZeroValues !== true
            : DEFAULT_GENERAL_SETTINGS.showZeroValuesOnDashboard;

    return withLegacyGeneralSettingsAlias({
        ...source,
        showZeroValuesOnDashboard,
        showZeroValuesOnHistory: source.showZeroValuesOnHistory === true,
        showSparklines: source.showSparklines !== false
    });
}

const state = {
        categories: {},
        generalSettings: normalizeGeneralSettings(DEFAULT_GENERAL_SETTINGS),
        featureSettings: { fire: true, tracker: true, forecast: true, budget: true, milestones: false },
        milestoneSettings: { targets: [] },
        forecastSettings: {
            annualReturn: 4.0,
            monthlyContribution: 1500,
            forecastStrategy: 'fire-default'
        },
        fireSettings: {
            targetIncome: 4000,
            swr: 4.0,
            includeStatePension: false,
            statePensionAmount: 12547,
            includeWindfalls: false,
            expectedWindfalls: 0,
            includedAssets: ['investments','pensions','property']
        },
        budgetSettings: { income: [], bills: [], savings: [], spend: [] },
        integrationCatalog: [],
        integrations: [],
        CATEGORIES: [],
        classificationGroups: [],
        assets: [],
        assetsLoaded: false,
        currentPeriod: '1M',
        auditPage: 1,
        isDashboardLoaded: false,
        isHistoryLoaded: false,
        isCalendarLoaded: false,
        isForecastLoaded: false,
        fireStatusForecast: { key: '', status: 'idle', target: 0, data: null, date: null }
};

let generalSettings = state.generalSettings;
Object.defineProperty(state, 'generalSettings', {
    configurable: true,
    enumerable: true,
    get() {
        return generalSettings;
    },
    set(value) {
        generalSettings = normalizeGeneralSettings(value);
    }
});

export const store = {
    state,
    
    apiCache: {},
    apiCacheMeta: {},
    apiCacheTags: {},
    apiInflight: {},
    cacheGeneration: 0,

    clearCache({ preserveTags = [] } = {}) {
        this.cacheGeneration += 1;
        const preservedTags = new Set(preserveTags);
        Object.keys(this.apiCache).forEach(key => {
            if (this.apiCacheTags[key]?.some(tag => preservedTags.has(tag))) return;
            delete this.apiCache[key];
            delete this.apiCacheMeta[key];
            delete this.apiCacheTags[key];
        });
        this.apiInflight = {};
        this.state.isDashboardLoaded = false;
        this.state.isHistoryLoaded = false;
        this.state.isCalendarLoaded = false;
        this.state.isForecastLoaded = false;
        this.state.fireStatusForecast = { key: '', status: 'idle', target: 0, data: null, date: null };
    },

    invalidateCacheTag(tag) {
        this.cacheGeneration += 1;
        this.apiInflight = {};
        Object.keys(this.apiCacheTags).forEach(key => {
            if (!this.apiCacheTags[key]?.includes(tag)) return;
            delete this.apiCache[key];
            delete this.apiCacheMeta[key];
            delete this.apiCacheTags[key];
        });
        if (tag === 'fire-status') {
            this.state.fireStatusForecast = { key: '', status: 'idle', target: 0, data: null, date: null };
        }
    }
};

// Expose shared runtime values used by the app's window-level callbacks.
if (typeof window !== 'undefined') {
    window.wealthState = store.state;
    window.tempWindfalls = [];
    window.investmentXrayData = [];
    window.currentCategoryNames = [];
}
