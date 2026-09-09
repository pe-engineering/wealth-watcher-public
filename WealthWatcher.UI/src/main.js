import { Chart } from 'chart.js/auto';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import flatpickr from 'flatpickr';
import { store } from './store/store.js';
import * as apiClient from './api/apiClient.js';
import { setupRouter, handleRouting } from './router/router.js';
import { loadDashboard, setupPeriodListeners, setupHourlyRefreshLifecycle, setupDashboardActions } from './pages/Dashboard.js';
import { openModal, setupModals } from './components/Modals.js';
import { setupForecast } from './pages/ForecastV2.js';
import { setupCurrencyInputs } from './utils/formatters.js';
import { initAllCollapsiblePanes } from './components/CollapsiblePane.js';
import { setupBudgetSettings } from './pages/Budget.js';
import { loadIntegrations, setupIntegrations } from './components/Integrations.js';
import { setupFireFeatureSettings } from './components/FireSettings.js';
import { MILESTONE_SETTINGS_KEY, normalizeMilestoneSettings, setupMilestoneSettings } from './components/Milestones.js';
import { setupPropertyPanel, getPropertyFormState, resetPropertyFormState } from './components/Properties.js';
import { FEATURE_SETTINGS_KEY, normalizeFeatureSettings, applyFeatureVisibility } from './utils/featureFlags.js';
import { setupPwa } from './pwa.js';
import { setupReleaseInfo } from './release.js';
import { setupAssetCatalog } from './components/AssetCatalog.js';
import { requestNotification } from './components/ConfirmationModal.js';
import { showToast } from './components/Toast.js';
import { createAuditLogController } from './components/AuditLog.js';
import { parseJsonObject } from './utils/persistedSettings.js';
import { getDemoBannerCollapsed, setDemoBannerCollapsed } from './utils/demoBannerPreference.js';
import {
    getAssetTypeaheadState,
    renderAssetTypeahead,
    setupAssetTypeahead
} from './components/AssetTypeahead.js';

// Keep the existing page modules' browser-facing globals while resolving all
// runtime assets through the package lock instead of third-party CDNs.
globalThis.Chart = Chart;
globalThis.ChartDataLabels = ChartDataLabels;
globalThis.flatpickr = flatpickr;

function createBudgetLineId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
        const random = Math.random() * 16 | 0;
        const value = character === 'x' ? random : (random & 0x3 | 0x8);
        return value.toString(16);
    });
}

const { API_BASE_URL } = apiClient;
const fetchCached = apiClient.fetchCached;
const requestJson = apiClient.requestJson;

// Keep this entry point compatible with the current client while allowing the
// shared request boundary to provide demo fixtures and mutations.
const apiRequest = (...args) => {
    if (typeof apiClient.apiRequest === 'function') return apiClient.apiRequest(...args);
    return apiClient.fetchCached(...args);
};

function isDemoModeEnabled() {
    if (typeof apiClient.isDemoMode === 'function') return apiClient.isDemoMode();
    return apiClient.isDemoMode === true;
}

async function readApiPayload(result) {
    if (result && typeof result.json === 'function') return result.json();
    return result;
}

function apiResultSucceeded(result, payload) {
    return result?.ok ?? payload !== null;
}

function syncDemoChromeOffsets(banner, topNav, demoMode) {
    const root = document.documentElement;
    if (!root?.style) return;
    const bannerBounds = banner?.getBoundingClientRect?.();
    const bannerHeight = demoMode && banner && !banner.hidden
        ? Math.ceil(bannerBounds?.height || banner.offsetHeight || 0)
        : 0;
    const topNavBounds = topNav?.getBoundingClientRect?.();
    const topNavHeight = demoMode && topNav
        ? Math.ceil(topNavBounds?.height || topNav.offsetHeight || 0)
        : 0;
    root.style.setProperty('--demo-banner-height', `${bannerHeight}px`);
    root.style.setProperty('--demo-app-bar-height', `${topNavHeight}px`);
}

function applyDemoBannerState(banner, collapsed) {
    if (!banner) return;
    const toggle = banner.querySelector?.('#demo-banner-toggle');
    const content = banner.querySelector?.('#demo-mode-banner-content');
    const collapsedLabel = banner.querySelector?.('.demo-mode-banner-collapsed-label');
    banner.dataset.collapsed = String(collapsed);
    if (content) {
        content.hidden = collapsed;
        content.setAttribute('aria-hidden', String(collapsed));
    }
    if (collapsedLabel) collapsedLabel.setAttribute('aria-hidden', String(!collapsed));
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        const label = collapsed ? 'Show demo information' : 'Hide demo information';
        toggle.setAttribute('aria-label', label);
    }
}

let demoFreshnessTimer = null;
let demoFreshnessEventsAttached = false;
let demoFreshnessCheckRunning = false;

function scheduleDemoFreshnessCheck() {
    if (!isDemoModeEnabled()) return;
    if (demoFreshnessTimer) clearTimeout(demoFreshnessTimer);
    demoFreshnessTimer = setTimeout(() => {
        demoFreshnessTimer = null;
        void refreshDemoUiIfNeeded();
    }, 60 * 1000);
}

async function refreshDemoUiIfNeeded() {
    if (!isDemoModeEnabled() || typeof apiClient.ensureDemoFresh !== 'function' || demoFreshnessCheckRunning) return false;
    demoFreshnessCheckRunning = true;
    try {
        const changed = await apiClient.ensureDemoFresh();
        if (!changed) return false;

        const route = (window.location?.hash || '#dashboard').split('?')[0];
        if (route === '#dashboard' || route === '#fire') await loadDashboard({ force: true });
        if (route !== '#dashboard') handleRouting();
        return true;
    } finally {
        demoFreshnessCheckRunning = false;
        scheduleDemoFreshnessCheck();
    }
}

function setupDemoFreshnessLifecycle() {
    if (!isDemoModeEnabled()) return;
    if (!demoFreshnessEventsAttached) {
        const refresh = () => {
            if (document.hidden) return;
            void refreshDemoUiIfNeeded();
        };
        if (typeof window.addEventListener === 'function') window.addEventListener('focus', refresh);
        if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', refresh);
        demoFreshnessEventsAttached = true;
    }
    scheduleDemoFreshnessCheck();
}

function setupDemoModeUi(demoMode) {
    document.documentElement.dataset.demoMode = String(demoMode);
    document.body?.classList.toggle('demo-mode', demoMode);

    const banner = document.querySelector('[data-demo-banner], .demo-banner, #demo-banner, #demo-mode-banner');
    const topNav = document.querySelector('.top-nav');
    if (banner) {
        banner.hidden = !demoMode;
        banner.dataset.demoMode = String(demoMode);
        banner.classList.toggle('is-visible', demoMode);
        banner.setAttribute('aria-hidden', String(!demoMode));

        if (demoMode) {
            applyDemoBannerState(banner, getDemoBannerCollapsed());
            const toggle = banner.querySelector?.('#demo-banner-toggle');
            if (toggle && toggle.dataset.demoBannerToggleReady !== 'true') {
                toggle.addEventListener('click', event => {
                    event.preventDefault();
                    const collapsed = toggle.getAttribute('aria-expanded') === 'true';
                    setDemoBannerCollapsed(collapsed);
                    applyDemoBannerState(banner, collapsed);
                    syncDemoChromeOffsets(banner, topNav, demoMode);
                });
                toggle.dataset.demoBannerToggleReady = 'true';
            }
        }
    }
    syncDemoChromeOffsets(banner, topNav, demoMode);

    if (demoMode && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => syncDemoChromeOffsets(banner, topNav, demoMode));
        if (banner) observer.observe(banner);
        if (topNav) observer.observe(topNav);
    }

    if (!demoMode) return;

    document.querySelectorAll(
        '#btn-force-sync, [data-force-sync], [data-real-sync], [data-integration-entry]'
    ).forEach(control => {
        control.disabled = true;
        control.hidden = true;
        control.setAttribute('aria-disabled', 'true');
    });

    const integrations = document.getElementById('integration-settings-pane');
    if (integrations) {
        integrations.hidden = true;
        integrations.setAttribute('aria-hidden', 'true');
        integrations.querySelectorAll('button, input, select, textarea').forEach(control => {
            control.disabled = true;
        });
    }

    const resetDemo = async () => {
        store.clearCache();
        if (typeof apiClient.resetDemoData === 'function') {
            await apiClient.resetDemoData();
        }
        window.location?.reload?.();
    };
    window.resetDemo = resetDemo;
    document.querySelectorAll('[data-reset-demo], [data-demo-reset], #reset-demo, #demo-reset').forEach(control => {
        control.addEventListener('click', event => {
            event.preventDefault();
            void resetDemo();
        });
    });
    setupDemoFreshnessLifecycle();
}

// --- BOOT ANIMATION ---
function runBootSequence() {
    const log = document.getElementById('boot-log');
    const bar = document.getElementById('boot-bar');
    const messages = ["Establishing secure uplink...", "Parsing asset vectors...", "Decrypting simulations...", "Syncing with orbital ledger...", "ACCESS GRANTED."];
    let step = 0;
    const interval = setInterval(() => {
        if(step >= messages.length) {
            clearInterval(interval);
            setTimeout(() => {
                const boot = document.getElementById('system-boot');
                boot.style.opacity = '0';
                setTimeout(() => boot.style.display = 'none', 800);
            }, 500);
            return;
        }
        log.innerHTML += `> ${messages[step]}<br>`;
        log.scrollTop = log.scrollHeight;
        bar.style.width = `${((step + 1) / messages.length) * 100}%`;
        step++;
    }, 200);
}

// --- INIT ---
async function init() {
    runBootSequence();
    try {
        const demoMode = isDemoModeEnabled();
        setupDemoModeUi(demoMode);
        void setupReleaseInfo({ checkForUpdates: !demoMode }).catch(error => {
            console.error('Release information setup failed', error);
        });

        // Keep the integration panel usable even if another optional dashboard
        // bootstrap step fails. The shared asset catalogue is loaded separately
        // below, so this initial integration load does not fetch assets twice.
        if (!demoMode) {
            setupIntegrations();
            loadIntegrations({ includeAssets: false });
        }

        let dbSettings = {};
        try {
            dbSettings = requestJson
                ? (await requestJson(`${API_BASE_URL}/settings`) || {})
                : (await readApiPayload(await apiRequest(`${API_BASE_URL}/settings`)) || {});
        } catch (error) {
            // Settings are optional at boot. Keep the shell, router, and page
            // error states usable when the API is offline or not configured.
            console.error('Unable to load saved settings; using defaults.', error);
        }
        
        if (dbSettings['wealthWatcherGeneralSettings']) {
            store.state.generalSettings = parseJsonObject(dbSettings['wealthWatcherGeneralSettings']);
        }
        if (dbSettings[FEATURE_SETTINGS_KEY]) {
            store.state.featureSettings = normalizeFeatureSettings(
                parseJsonObject(dbSettings[FEATURE_SETTINGS_KEY])
            );
        } else {
            store.state.featureSettings = normalizeFeatureSettings();
        }
        applyFeatureVisibility();
        if (dbSettings[MILESTONE_SETTINGS_KEY]) {
            store.state.milestoneSettings = normalizeMilestoneSettings(
                parseJsonObject(dbSettings[MILESTONE_SETTINGS_KEY])
            );
        } else {
            store.state.milestoneSettings = { targets: [] };
        }
        if (dbSettings['wealthWatcherForecastSettings']) {
            const forecastSettings = parseJsonObject(dbSettings['wealthWatcherForecastSettings']);
            store.state.forecastSettings = {
                dateOfBirth: forecastSettings.dateOfBirth || '',
                annualReturn: forecastSettings.annualReturn ?? 4,
                monthlyContribution: forecastSettings.monthlyContribution ?? 1500,
                forecastStrategy: forecastSettings.forecastStrategy || 'fire-default'
            };
        }
        if (dbSettings['wealthWatcherFireSettings']) {
            store.state.fireSettings = parseJsonObject(dbSettings['wealthWatcherFireSettings']);
        }
        if (dbSettings['wealthWatcherBudgetSettings']) {
            let budget = parseJsonObject(dbSettings['wealthWatcherBudgetSettings']);
            if (!Array.isArray(budget.bills)) budget.bills = [];
            if (!Array.isArray(budget.savings)) budget.savings = [];
            if (!Array.isArray(budget.spend)) budget.spend = [];
            if (!Array.isArray(budget.income)) budget.income = [];
            ['income', 'bills', 'savings', 'spend'].forEach(category => {
                budget[category] = budget[category].map(item => ({
                    ...(item || {}),
                    id: item?.id || createBudgetLineId(),
                    cadence: item?.cadence || 'monthly',
                    ...(category === 'savings' ? { assetId: item?.assetId || null } : {})
                }));
            });
            store.state.budgetSettings = budget;
        } else {
            store.state.budgetSettings = { income: [], bills: [], savings: [], spend: [] };
        }

        await refreshAssetCatalog();
        setupEntryAssetTypeahead();
        
        setupPeriodListeners();
        setupModals();
        const refreshDashboardData = async () => {
            store.invalidateCacheTag('catalogue');
            await refreshAssetCatalog();
            await loadDashboard({ force: true });
            store.state.isDashboardLoaded = true;
        };
        setupAssetCatalog({ refresh: refreshDashboardData });
        setupDashboardActions({ refresh: refreshDashboardData });
        setupPropertyPanel({ refresh: loadDashboard });
        setupForecast();
        if (!demoMode) setupIntegrations({ refresh: refreshDashboardData });
        setupFireFeatureSettings();
        setupBudgetSettings();
        setupMilestoneSettings();
        setupRouter();
        setupHourlyRefreshLifecycle();
        setupCurrencyInputs();
        initAllCollapsiblePanes();
        
        if (!store.state.isDashboardLoaded) {
            await loadDashboard();
            store.state.isDashboardLoaded = true;
        }
        
        handleRouting();
    } catch (e) {
        console.error("Init Error", e);
    }
}

// --- TOOLTIPS ---
window.showTooltip = function(e, text) {
    const tooltip = document.getElementById('custom-tooltip');
    tooltip.innerText = text;
    tooltip.classList.add('visible');
    
    const rect = e.target.getBoundingClientRect();
    tooltip.style.left = rect.left + 'px';
    tooltip.style.top = (rect.top - 35) + 'px';
};

window.hideTooltip = function() {
    document.getElementById('custom-tooltip').classList.remove('visible');
};

// --- OBFUSCATION ---
window.toggleObfuscate = function() {
    document.body.classList.toggle('obfuscated');
    const btn = document.getElementById('obfuscate-btn');
    window.isObfuscated = document.body.classList.contains('obfuscated');
    const status = document.getElementById('obfuscation-status');

    if (status) status.hidden = !window.isObfuscated;
    if (btn) {
        const privacyLabel = window.isObfuscated ? 'Disable privacy mode' : 'Enable privacy mode';
        btn.title = privacyLabel;
        btn.setAttribute('aria-label', privacyLabel);
        btn.setAttribute('aria-pressed', String(window.isObfuscated));
    }
    
    // Force all charts to redraw to respect obfuscation on axes and tooltips
    if (typeof Chart !== 'undefined' && Chart.instances) {
        Object.values(Chart.instances).forEach(chart => chart.update());
    }
    if (window.isObfuscated) {
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
    } else {
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
    }
};

// --- AUDIT LOG ---
const auditLogController = createAuditLogController({
    request: async (page, pageSize) => {
        const url = `${API_BASE_URL}/audits?page=${page}&pageSize=${pageSize}`;
        return requestJson
            ? requestJson(url)
            : readApiPayload(await apiRequest(url));
    },
    onError: error => console.error('Error loading audits', error)
});

window.openAuditModal = async function() {
    await auditLogController.open();
    window.openModal('audit-modal');
};

window.loadAudits = function(pageDelta) {
    return auditLogController.load(pageDelta);
};

// --- ADD ENTRY AND CATEGORY LOGIC ---
// Category selection is a native select. Keep these globals as small
// compatibility shims for existing dashboard actions while the actual field
// remains accessible without a bespoke dropdown implementation.
window.toggleCategoryDropdown = function() {
    document.getElementById('entry-category')?.focus?.();
};

window.hideCategoryDropdown = function() {};

window.selectCategory = function(val) {
    const category = document.getElementById('entry-category');
    if (category) category.value = val || '';
    const assetIdInput = document.getElementById('entry-asset-id');
    if (assetIdInput) assetIdInput.value = '';
    window.selectedEntryAssetId = '';
    window.onCategoryChange?.();
};

function isUnclassifiedCategory(category) {
    return [category?.Id, category?.Key, category?.Code]
        .some(value => String(value ?? '').trim().toLowerCase() === 'unclassified');
}

export function getInteractiveCategoryOptions(categories) {
    const seenIds = new Set();
    return (Array.isArray(categories) ? categories : [])
        .filter(category => category && String(category.Id || '').trim())
        .filter(category => !isUnclassifiedCategory(category))
        .filter(category => {
            const id = String(category.Id).toLowerCase();
            if (seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
        });
}

export function populateCategoryOptions(categories) {
    const container = document.getElementById('entry-category');
    if (!container) return;

    container.innerHTML = '';
    const availableAssets = getInteractiveCategoryOptions(categories);

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = availableAssets.length === 0 ? 'No assets have been added yet.' : 'Select Asset...';
    placeholder.disabled = true;
    placeholder.selected = true;
    container.appendChild(placeholder);

    availableAssets.forEach(category => {
        const option = document.createElement('option');
        option.value = category.Id;
        option.textContent = category.Label || category.DisplayName || category.Id;
        container.appendChild(option);
    });

    if (container.dataset.categorySelectInit !== 'true') {
        container.dataset.categorySelectInit = 'true';
        container.addEventListener('change', () => window.onCategoryChange?.());
    }
}

async function refreshAssetCatalog() {
    const [groupRes, assetRes, catRes] = await Promise.all([
        fetchCached(`${API_BASE_URL}/classification-groups`, null, { ttlMs: 30 * 60 * 1000, tags: ['catalogue'] }),
        fetchCached(`${API_BASE_URL}/assets`, null, { ttlMs: 30 * 60 * 1000, tags: ['catalogue'] }),
        fetchCached(`${API_BASE_URL}/categories`, null, { ttlMs: 30 * 60 * 1000, tags: ['catalogue'] })
    ]);

    store.state.classificationGroups = Array.isArray(groupRes) ? groupRes : [];
    store.state.assets = Array.isArray(assetRes) ? assetRes : [];
    store.state.assetsLoaded = Array.isArray(assetRes);
    store.state.CATEGORIES = Array.isArray(catRes) ? catRes : [];
    populateCategoryOptions(store.state.CATEGORIES);
}

window.onCategoryChange = async function() {
    const cat = document.getElementById('entry-category').value.toLowerCase();
    const selectedAssetId = document.getElementById('entry-asset-id')?.value;
    const selectedAsset = (store.state.assets || []).find(asset => String(asset.Id) === String(selectedAssetId));
    const entryKind = selectedAsset?.EntryKind?.toLowerCase()
        || (cat === 'property' ? 'property' : (cat === 'investments' || cat === 'pensions' ? 'investment' : 'cash'));
    const mortgageGroup = document.getElementById('mortgage-group');
    const investedGroup = document.getElementById('invested-group');
    
    mortgageGroup.style.display = 'none';
    investedGroup.style.display = 'none';

    if (entryKind === 'property') {
        mortgageGroup.style.display = 'block';
    } else if (entryKind === 'investment') {
        investedGroup.style.display = 'block';
    }

    window.currentCategoryNames = [];
    if (cat) {
        try {
            window.currentCategoryNames = await fetchCached(
                `${API_BASE_URL}/wealth/${cat}/names`,
                null,
                { ttlMs: 30 * 60 * 1000, tags: ['catalogue'] });
        } catch (e) { console.error("Error loading names", e); }
    }
}

function chooseEntryAsset(picker, assetId) {
    const state = getAssetTypeaheadState(picker);
    const selected = (window.currentCategoryNames || []).find(asset =>
        String(asset?.Id || '') === String(assetId || ''));
    if (state.value) state.value.value = assetId || '';
    if (state.search) state.search.value = selected?.DisplayName || selected?.Name || '';
    window.selectedEntryAssetId = assetId || '';
    window.onCategoryChange?.();
}

function setupEntryAssetTypeahead() {
    const target = document.getElementById('entry-asset-picker-control');
    if (!target || target.dataset.assetTypeaheadReady === 'true') return;

    target.innerHTML = renderAssetTypeahead({
        id: 'entry',
        ariaLabel: 'Search existing assets or enter a new asset name',
        placeholder: 'Search existing assets or enter a new asset name',
        pickerClass: 'entry-asset-typeahead',
        valueAttributes: { id: 'entry-asset-id' },
        searchAttributes: { id: 'entry-name' },
        optionsAttributes: { id: 'entry-asset-options' },
        emptyChoiceLabel: 'Create a new asset…'
    });
    setupAssetTypeahead(target, {
        emptyChoiceLabel: 'Create a new asset…',
        getAssets: () => window.currentCategoryNames || [],
        onClear: () => {
            window.selectedEntryAssetId = '';
        },
        onChoose: chooseEntryAsset
    });
    target.dataset.assetTypeaheadReady = 'true';
}

// Quick Add
window.openQuickAdd = function(catId, itemName, currentValue, currentMortgage) {
    const modal = document.getElementById('entry-modal');
    if (!modal) return;

    openModal('entry-modal');
    resetPropertyFormState();
    
    document.getElementById('entry-category').value = catId;
    const category = (store.state.CATEGORIES || []).find(item => item.Id === catId);
    window.selectCategory(catId);
    
    document.getElementById('entry-name').value = itemName;
    window.selectedEntryAssetId = '';
    const categoryValueId = category?.ClassificationValueId;
    const matchingAsset = (store.state.assets || []).find(asset => {
        const sameName = (asset.Name || asset.DisplayName || '').toLowerCase() === itemName.toLowerCase();
        const sameCategory = !categoryValueId || (asset.Classifications || []).some(value =>
            String(value.Id) === String(categoryValueId));
        return sameName && sameCategory;
    });
    const assetIdInput = document.getElementById('entry-asset-id');
    if (assetIdInput) assetIdInput.value = matchingAsset?.Id || '';
    window.selectedEntryAssetId = matchingAsset?.Id || '';
    window.onCategoryChange();
    document.getElementById('entry-value').value = currentValue;
    if (catId === 'property' && currentMortgage !== null) {
        document.getElementById('entry-mortgage').value = currentMortgage;
    }
    
    document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];
};

document.getElementById('add-entry-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('entry-submit-btn');
    btn.innerText = 'Saving...';
    btn.disabled = true;

    const cat = document.getElementById('entry-category').value.toLowerCase();
    const val = document.getElementById('entry-value').value;
    const mortgage = document.getElementById('entry-mortgage').value;
    const invested = document.getElementById('entry-invested').value;
    const dt = document.getElementById('entry-date').value;
    const propertyFormState = getPropertyFormState();
    const wasAddingProperty = cat === 'property' && propertyFormState.mode === 'add';
    const numericValue = parseFloat(val);
    const numericMortgage = mortgage === '' ? 0 : parseFloat(mortgage);

    const assetKindGroup = (store.state.classificationGroups || []).find(group =>
        (group.Key || '').toLowerCase() === 'asset-kind');
    const selectedAssetKind = assetKindGroup?.Values?.find(value =>
        (value.Key || '').toLowerCase() === cat);
    if (!selectedAssetKind?.Id || (selectedAssetKind.Key || selectedAssetKind.Code || '').toLowerCase() === 'unclassified') {
        await requestNotification({
            title: 'Select an asset',
            message: 'Please select a classified asset before saving the entry.'
        });
        btn.innerText = 'Save Entry';
        btn.disabled = false;
        return;
    }

    if (cat === 'property' && (!Number.isFinite(numericValue) || !Number.isFinite(numericMortgage))) {
        await requestNotification({
            title: 'Invalid property details',
            message: 'Please provide a valid property value and mortgage.'
        });
        btn.innerText = propertyFormState.mode === 'add' ? 'Add Property' : 'Add Entry';
        btn.disabled = false;
        return;
    }

    const payload = {
        Type: document.getElementById('entry-category').value,
        Name: document.getElementById('entry-name').value,
        Value: parseFloat(val).toFixed(2),
        Date: dt,
        // WealthEntry timestamps are stored as UTC date/time pairs. Using the
        // browser's local clock here can make a new entry look like it is in
        // the future to the 1H aggregate endpoint.
        Time: new Date().toISOString().slice(11, 19),
        Source: 'Manual'
    };

    const assetId = document.getElementById('entry-asset-id')?.value;
    if (assetId) payload.AssetId = assetId;
    if (!assetId) {
        payload.ClassificationValueIds = [selectedAssetKind.Id];
    }

    if (cat === 'property' && mortgage) {
        payload.Mortgage = parseFloat(mortgage).toFixed(2);
    }
    
    if ((cat === 'pensions' || cat === 'investments') && invested) {
        payload.InvestedCapital = parseFloat(invested).toFixed(2);
    }

    try {
        let endpoint = `${API_BASE_URL}/wealth`;
        let requestPayload = payload;

        if (cat === 'property' && propertyFormState.mode === 'add') {
            endpoint = `${API_BASE_URL}/properties`;
            requestPayload = {
                Name: payload.Name,
                Value: numericValue,
                Mortgage: numericMortgage,
                Date: dt,
                Time: payload.Time
            };
        } else if (cat === 'property' && propertyFormState.mode === 'entry' && propertyFormState.propertyId) {
            endpoint = `${API_BASE_URL}/properties/${encodeURIComponent(propertyFormState.propertyId)}/entries`;
            requestPayload = {
                Value: numericValue,
                Mortgage: numericMortgage,
                Date: dt,
                Time: payload.Time
            };
        }

        const result = await apiRequest(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload)
        });
        const responsePayload = await readApiPayload(result);

        if (apiResultSucceeded(result, responsePayload)) {
            window.closeModal('entry-modal');
            e.target.reset();
            resetPropertyFormState();
            window.onCategoryChange(); 
            const todayUtc = new Date().toISOString().slice(0, 10);
            store.clearCache({
                preserveTags: dt === todayUtc ? ['wealth-historical'] : []
            });
            await refreshAssetCatalog();
            await loadDashboard(); 
            showToast({
                title: wasAddingProperty ? 'Property added' : 'Entry saved',
                message: `${payload.Name} was saved successfully.`,
                type: 'success',
                key: 'manual-entry-save'
            });
        } else {
            await requestNotification({
                title: 'Unable to save entry',
                message: 'The entry could not be saved.'
            });
        }
    } catch (err) {
        console.error(err);
        await requestNotification({
            title: 'Unable to save entry',
            message: 'There was a problem communicating with the API.'
        });
    } finally {
        btn.innerText = 'Save Entry';
        btn.disabled = false;
    }
});

// The production document always contains the boot screen. Keeping bootstrap
// behind that marker also lets the entry-point's pure helpers be tested without
// starting the application lifecycle in Node.
if (document.getElementById('system-boot')) {
    void import('./styles/toast.css');
    void import('flatpickr/dist/flatpickr.min.css');
    void import('flatpickr/dist/themes/dark.css');
    if (!isDemoModeEnabled()) setupPwa();
    init();
}

window.showToast = showToast;



// --- INIT FLATPICKR ---
if (typeof flatpickr !== 'undefined') {
    flatpickr('.flatpickr-input', {
        dateFormat: 'Y-m-d',
        disableMobile: true
    });
}
