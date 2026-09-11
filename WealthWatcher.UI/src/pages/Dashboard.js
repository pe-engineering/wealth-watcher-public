import { store } from '../store/store.js';
import { fetchCached, API_BASE_URL, apiRequest } from '../api/apiClient.js';
import { formatter } from '../utils/formatters.js';
import { renderFireView } from './FireTracker.js';
import { requestConfirmation, requestNotification } from '../components/ConfirmationModal.js';
import { showToast } from '../components/Toast.js';
import { setPageLoading } from '../components/PageLoading.js';
import { PAGE_STATUS, setPageStatus } from '../components/PageState.js';
import { bindPeriodPicker, normalizePeriod } from '../components/PeriodPicker.js';
import { escapeHtml, safeCssColor } from '../utils/html.js';
import {
    buildFireStatusViewModel,
    clearFireStatusSummary,
    renderFireStatusSummary,
    renderPendingFireStatusSummary
} from '../components/FireStatusSummary.js';
import { calculateFireSummary } from '../components/FireModel.js';
import { loadForecastSnapshot } from './ForecastV2.js';
import { renderAccessibleChartData } from '../components/AccessibleChartData.js';
import { calculateInvestedShare, getAggregateBreakdown, getCurrentAggregateValue } from '../components/DashboardModel.js';
import pluralize from 'pluralize';

let charts = {};
let xrayChartInstance = null;
let dashboardLoadPromise = null;
let dashboardLoadPeriod = null;
let dashboardReloadPending = false;
let dashboardHasData = false;
let dashboardPageState = PAGE_STATUS.LOADING;
let dashboardPageError = null;
let dashboardActionsSetup = false;
let collapsedAssetGroupKeys = new Set();
let refreshDashboardData = async () => {};
let fireStatusRequestId = 0;

export function setupDashboardActions({ refresh } = {}) {
    if (refresh) refreshDashboardData = refresh;
    if (dashboardActionsSetup) return;
    dashboardActionsSetup = true;

    document.addEventListener('click', async event => {
        const action = event.target?.closest?.('[data-dashboard-action]');
        if (!action) return;

        const actionName = action.dataset.dashboardAction;
        if (actionName === 'retry') {
            event.preventDefault();
            await loadDashboard({ force: true });
            return;
        }

        if (actionName === 'entry') {
            event.preventDefault();
            if (action.dataset.categoryId === 'property') {
                const propertyName = action.dataset.entryName || '';
                const property = propertyName
                    ? {
                        Id: action.dataset.entryId,
                        Name: propertyName,
                        Value: Number(action.dataset.entryValue),
                        Mortgage: Number(action.dataset.entryMortgage)
                    }
                    : null;
                window.openPropertyEntry?.(property);
                return;
            }
            window.openQuickAdd?.(
                action.dataset.categoryId,
                action.dataset.entryName || '',
                action.dataset.entryValue === '' ? null : Number(action.dataset.entryValue),
                null);
            return;
        }

        if (actionName === 'archive-child') {
            event.preventDefault();
            event.stopPropagation();
            await archiveDashboardChild(
                action.dataset.assetId,
                action.dataset.assetName,
                action.dataset.categoryId);
            return;
        }

        if (actionName === 'archive-property') {
            event.preventDefault();
            event.stopPropagation();
            await archiveDashboardProperty(action.dataset.propertyId, action.dataset.propertyName);
            return;
        }

        if (actionName !== 'archive') return;

        event.preventDefault();
        event.stopPropagation();
        await archiveDashboardAsset(action.dataset.classificationValueId, action.dataset.assetName);
    });
}

async function archiveDashboardAsset(valueId, name) {
    if (!valueId) return;
    await archiveDashboardResource({
        url: `${API_BASE_URL}/classification-values/${encodeURIComponent(valueId)}`,
        method: 'DELETE',
        name,
        errorTitle: 'Unable to archive asset'
    });
}

async function archiveDashboardChild(assetId, name, categoryId) {
    const resolvedAssetId = assetId || await resolveDashboardAssetId(categoryId, name);
    if (!resolvedAssetId) {
        await requestNotification({
            title: 'Unable to archive asset',
            message: `No active asset was found for ${name || 'this entry'}.`
        });
        return;
    }

    await archiveDashboardResource({
        url: `${API_BASE_URL}/assets/${encodeURIComponent(resolvedAssetId)}`,
        method: 'PATCH',
        body: { Archived: true },
        name,
        errorTitle: 'Unable to archive asset'
    });
}

async function archiveDashboardProperty(propertyId, name) {
    if (!propertyId) {
        await requestNotification({
            title: 'Unable to archive property',
            message: 'This property does not have an active definition to archive.'
        });
        return;
    }

    await archiveDashboardResource({
        url: `${API_BASE_URL}/properties/${encodeURIComponent(propertyId)}`,
        method: 'PATCH',
        body: { Archived: true },
        name,
        errorTitle: 'Unable to archive property'
    });
}

async function archiveDashboardResource({ url, method, body, name, errorTitle }) {
    if (!await requestConfirmation({
        title: `Archive ${name || 'asset'}?`,
        message: `Archive ${name || 'this asset'}? Existing history will be retained and the asset can be restored later.`,
        confirmLabel: 'Archive asset'
    })) return;

    try {
        const options = { method };
        if (body) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(body);
        }
        const response = await apiRequest(url, options);
        if (isDemoActionDisabled(response)) return;
        if (!response.ok) {
            await requestNotification({
                title: errorTitle,
                message: await readApiError(response, 'The asset could not be archived.')
            });
            return;
        }

        store.clearCache();
        await refreshDashboardData();
        showToast({
            title: 'Asset archived',
            message: `${name || 'The asset'} was archived successfully.`,
            type: 'success',
            key: 'dashboard-archive'
        });
    } catch (error) {
        console.error(error);
        await requestNotification({
            title: errorTitle,
            message: 'There was a problem communicating with the API.'
        });
    }
}

async function readApiError(response, fallback) {
    if (typeof response?.text !== 'function') return fallback;
    const responseText = await response.text();
    if (!responseText) return fallback;
    try {
        const body = JSON.parse(responseText);
        return body?.Error || body?.error || fallback;
    } catch {
        return responseText.slice(0, 300) || fallback;
    }
}

export function setupPeriodListeners() {
    store.state.currentPeriod = normalizePeriod(store.state.currentPeriod);
    bindPeriodPicker('period-picker', {
        selectedPeriod: store.state.currentPeriod,
        onChange: async period => {
            store.state.currentPeriod = normalizePeriod(period);
            store.state.isDashboardLoaded = false;
            await loadDashboard({ force: true });
            store.state.isDashboardLoaded = true;
        }
    });
}

export async function forceSync() {
    const btn = document.getElementById('btn-force-sync');
    if (!btn) return;
    
    const svg = btn.querySelector('svg');
    if (svg) svg.style.animation = 'spin 1s linear infinite';
    btn.disabled = true;
    
    try {
        const res = await apiRequest(`${API_BASE_URL}/sync`, { method: 'POST' });
        if (isDemoActionDisabled(res)) return;
        if (res.ok) {
            store.clearCache();
            await loadDashboard();
            store.state.isDashboardLoaded = true;
            showToast({
                title: 'Sync complete',
                message: 'The dashboard has been refreshed with the latest data.',
                type: 'success',
                key: 'dashboard-sync'
            });
        } else {
            await requestNotification({
                title: 'Sync failed',
                message: 'The latest data could not be synced.'
            });
        }
    } catch (e) {
        console.error(e);
        await requestNotification({
            title: 'Sync error',
            message: 'There was a problem communicating with the API.'
        });
    } finally {
        if (svg) svg.style.animation = '';
        btn.disabled = false;
    }
}

function isDemoActionDisabled(response) {
    return response == null
        || response.demoDisabled === true
        || response.actionDisabled === true
        || response.disabled === true;
}

export function loadDashboard({ force = false } = {}) {
    if (dashboardLoadPromise) {
        if (force || dashboardLoadPeriod !== store.state.currentPeriod) {
            dashboardReloadPending = true;
        }
        return dashboardLoadPromise;
    }

    dashboardHasData = false;
    dashboardPageState = PAGE_STATUS.LOADING;
    dashboardPageError = null;
    fireStatusRequestId += 1;
    clearFireStatusSummary();
    setPageLoading('dashboard-view', true);
    renderDashboardPageState();
    dashboardLoadPromise = (async () => {
        try {
            do {
                dashboardReloadPending = false;
                dashboardLoadPeriod = store.state.currentPeriod;
                await loadDashboardInternal();
            } while (dashboardReloadPending || dashboardLoadPeriod !== store.state.currentPeriod);
        } catch (error) {
            dashboardPageState = PAGE_STATUS.ERROR;
            dashboardPageError = error;
            console.error('Dashboard load failed:', error);
        }
    })().finally(() => {
        setPageLoading('dashboard-view', false);
        renderDashboardPageState();
        dashboardLoadPromise = null;
        dashboardLoadPeriod = null;
    });

    return dashboardLoadPromise;
}

async function loadDashboardInternal() {
    const currentFireStatusRequestId = ++fireStatusRequestId;
    const selectedPeriod = normalizePeriod(store.state.currentPeriod);
    store.state.currentPeriod = selectedPeriod;

    destroyDashboardCharts();
    store.state.categories = {};
    const assetGroupDescriptors = getAssetGroupDescriptors();

    const dashboardTimeZone = selectedPeriod === '1D'
        ? `&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`
        : '';
    const dashboardUrl = `${API_BASE_URL}/dashboard?period=${encodeURIComponent(selectedPeriod)}${dashboardTimeZone}`;
    const dashboardResponse = await requestDashboardData(dashboardUrl);
    const results = (dashboardResponse?.Categories || []).map(category => ({
        cat: {
            Id: category.Id,
            Label: category.Label,
            Color: category.Color,
            DisplayOrder: category.DisplayOrder,
            AssetGroupId: category.AssetGroupId,
            AssetGroupCode: category.AssetGroupCode,
            ClassificationValueId: category.ClassificationValueId
        },
        data: category.Aggregate || category
    }));
    let globalTotal = 0;
    let globalPast = 0;
    let contributors = [];
    const visibleResults = results.filter(({ cat, data }) => !shouldHideDashboardCategory(cat, data));
    dashboardHasData = visibleResults.some(({ data }) =>
        Array.isArray(data?.Data) && data.Data.length > 0);
    if (!dashboardHasData) {
        dashboardPageState = PAGE_STATUS.EMPTY;
        clearDashboardLiveContent();
        return;
    }

    dashboardPageState = PAGE_STATUS.READY;
    const visibleAssetGroupDescriptors = getVisibleAssetGroupDescriptors(
        assetGroupDescriptors,
        visibleResults.map(result => result.cat));
    renderAssetGroupSections(visibleAssetGroupDescriptors);
    renderUnclassifiedAssetBanner(getActiveUnclassifiedAssetCount());
    // The banner may rewrite lane-sections, so resolve the live grids before rendering cards.
    const assetGroupTargets = new Map(visibleAssetGroupDescriptors.map(descriptor => [
        descriptor.key,
        document.getElementById(descriptor.gridId)
    ]));
    const assetGroupTotals = new Map(visibleAssetGroupDescriptors.map(descriptor => [descriptor.key, 0]));

    const globalTimeline = new Map();
    visibleResults.forEach(({data}) => {
        const history = data?.Data || [];
        history.forEach(h => {
            const current = globalTimeline.get(h.Time) || 0;
            globalTimeline.set(h.Time, current + h.Value);
        });
    });

    const sortedTimeline = Array.from(globalTimeline.entries()).sort((a,b) => a[0].localeCompare(b[0]));
    
    let firstValidDate = null;
    for (let [date, val] of sortedTimeline) {
        if (val > 0) {
            firstValidDate = date;
            globalPast = val;
            break;
        }
    }
    
    if (!firstValidDate && sortedTimeline.length > 0) {
        firstValidDate = sortedTimeline[0][0];
        globalPast = sortedTimeline[0][1];
    }

    visibleResults.forEach(({cat, data}) => {
        const history = data?.Data || [];
        const isManual = data?.IsManual;
        const lastSync = data?.LastSyncDateTime ? new Date(data.LastSyncDateTime) : null;

        let currentVal = 0;
        let pastVal = 0;
        let currentInvested = 0;
        let pastInvested = 0;

        if (history.length > 0) {
            currentVal = history[history.length - 1].Value;
            currentInvested = history[history.length - 1].Invested || 0;
            if (firstValidDate) {
                const pastEntry = history.find(h => h.Time === firstValidDate);
                if (pastEntry) {
                    pastVal = pastEntry.Value;
                    pastInvested = pastEntry.Invested || 0;
                } else {
                    pastVal = history[0].Value;
                    pastInvested = history[0].Invested || 0;
                }
            } else {
                pastVal = history[0].Value;
                pastInvested = history[0].Invested || 0;
            }
        }

        globalTotal += currentVal;
        
        const catId = cat.Id.toLowerCase();
        store.state.categories[catId] = (store.state.categories[catId] || 0) + currentVal;

        const delta = currentVal - pastVal;
        const deltaInvested = currentInvested - pastInvested;
        const insightChildren = normalizeCode(cat.Id) === 'property'
            ? buildPropertyInsightContributors(history.at(-1), firstValidDate
                ? history.find(point => point.Time === firstValidDate) || history[0]
                : history[0], cat.Color)
            : [];
        contributors.push({ name: cat.Label, delta: delta, deltaInvested: deltaInvested, currentVal: currentVal, color: cat.Color, insightChildren });

        const groupParts = getCategoryGroupParts(cat, data, assetGroupDescriptors);
        groupParts.forEach((part, index) => {
            const partHistory = part.history;
            const partCurrentVal = Number(partHistory.at(-1)?.Value) || 0;
            const partPastEntry = firstValidDate
                ? partHistory.find(point => point.Time === firstValidDate) || partHistory[0]
                : partHistory[0];
            const partPastVal = Number(partPastEntry?.Value) || 0;
            const partCurrentInvested = Number(partHistory.at(-1)?.Invested) || 0;
            const partPastInvested = Number(partPastEntry?.Invested) || 0;
            const partDelta = partCurrentVal - partPastVal;
            const partAssetGroup = part.descriptor || resolveAssetGroupDescriptor(cat, assetGroupDescriptors);
            assetGroupTotals.set(
                partAssetGroup.key,
                (assetGroupTotals.get(partAssetGroup.key) || 0) + partCurrentVal);

            renderCard(
                cat,
                partCurrentVal,
                partPastVal,
                partDelta,
                partHistory,
                part.breakdown,
                lastSync,
                isManual,
                part.propertyDetails,
                part.investmentDetails,
                selectedPeriod,
                assetGroupTargets.get(partAssetGroup.key),
                groupParts.length > 1 ? `${cat.Id}-${partAssetGroup.key}` : cat.Id);
        });
    });

    const ytdResults = (dashboardResponse?.YtdCategories || [])
        .filter(category => visibleResults.some(result =>
            String(result.cat.Id).toLowerCase() === String(category.Id).toLowerCase()))
        .map(category => category.Aggregate || category);
    let ytdStartVal = Number(dashboardResponse?.YtdStartTotal);
    if (!Number.isFinite(ytdStartVal)) {
        ytdStartVal = 0;
        ytdResults.forEach(data => {
            if (data?.Data && data.Data.length > 0) ytdStartVal += Number(data.Data[0].Value) || 0;
        });
    }

    assetGroupDescriptors.forEach(descriptor => {
        const totalElement = document.getElementById(descriptor.totalId);
        if (totalElement) totalElement.innerText = formatter.format(assetGroupTotals.get(descriptor.key) || 0);
    });

    const ytdDelta = globalTotal - (ytdStartVal || 0);
    const ytdScorecard = document.getElementById('ytd-scorecard');
    if (ytdStartVal !== null) {
        const sign = ytdDelta >= 0 ? '+' : '';
        const perc = ytdStartVal > 0 ? (ytdDelta / ytdStartVal) * 100 : 0;
        ytdScorecard.innerHTML = `YTD: <span style="color: ${ytdDelta < 0 ? '#ef4444' : '#10b981'}">${sign}${formatter.format(ytdDelta)} (${perc.toFixed(2)}%)</span>`;
    } else {
        ytdScorecard.innerHTML = '';
    }

    updateGlobalHeader(globalTotal, globalPast, contributors);
    renderDashboardFireStatus(globalTotal, currentFireStatusRequestId);
    renderXrayChart();
    
    if (window.location.hash === '#fire') {
        renderFireView();
    }
}

async function requestDashboardData(url) {
    let response;
    try {
        response = await apiRequest(url);
    } catch (error) {
        throw new Error('The dashboard request could not be completed.', { cause: error });
    }

    if (!response?.ok) {
        const status = response?.status ? ` (${response.status})` : '';
        throw new Error(`The dashboard request failed${status}.`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw new Error('The dashboard response could not be read.', { cause: error });
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.Categories)) {
        throw new Error('The dashboard response was not in the expected format.');
    }

    return payload;
}

function clearDashboardLiveContent() {
    const laneSections = document.getElementById('lane-sections');
    if (laneSections) laneSections.innerHTML = '';
    fireStatusRequestId += 1;
    clearFireStatusSummary();
}

function getDashboardFireSummary() {
    return calculateFireSummary({
        categories: store.state.categories || {},
        fire: store.state.fireSettings || {},
        categoryDefinitions: Array.isArray(store.state.CATEGORIES) ? store.state.CATEGORIES : []
    });
}

function renderDashboardFireStatus(holisticNetWorth, requestId) {
    const fireSummary = getDashboardFireSummary();
    renderPendingFireStatusSummary({ holisticNetWorth, fireSummary });

    if (fireSummary.state !== 'ready') return;
    if (!store.state.featureSettings?.forecast || !store.state.featureSettings?.fire) {
        renderFireStatusSummary(buildFireStatusViewModel({
            holisticNetWorth,
            fireSummary,
            projection: { status: 'disabled' }
        }));
        return;
    }

    void loadForecastSnapshot().then(projection => {
        if (requestId !== fireStatusRequestId || dashboardPageState !== PAGE_STATUS.READY) return;
        renderFireStatusSummary(buildFireStatusViewModel({
            holisticNetWorth,
            fireSummary: getDashboardFireSummary(),
            projection
        }));
    });
}

export function refreshDashboardFireStatus() {
    if (dashboardPageState !== PAGE_STATUS.READY) return Promise.resolve();
    return loadDashboard({ force: true });
}

globalThis.refreshDashboardFireStatus = refreshDashboardFireStatus;

function insertDashboardState(view, stateElement) {
    if (!view || !stateElement) return;
    const header = view.querySelector?.(':scope > header') || view.querySelector?.('header');
    if (header && typeof view.insertBefore === 'function') {
        view.insertBefore(stateElement, header.nextElementSibling || null);
    } else if (typeof view.prepend === 'function') {
        view.prepend(stateElement);
    } else if (typeof view.insertBefore === 'function') {
        view.insertBefore(stateElement, view.firstChild || null);
    } else if (typeof view.appendChild === 'function') {
        view.appendChild(stateElement);
    }
}

function createDashboardEmptyState(view) {
    if (typeof document.createElement !== 'function') return null;

    const emptyState = document.createElement('div');
    emptyState.id = 'dashboard-empty-state';
    emptyState.className = 'catalog-workspace presentation-empty-state dashboard-empty-state';
    emptyState.setAttribute?.('role', 'status');
    emptyState.setAttribute?.('data-page-empty', '');
    emptyState.innerHTML = `
        <div class="presentation-empty-state-layout">
            <div class="presentation-empty-copy">
                <span class="presentation-empty-kicker">Portfolio dashboard</span>
                <h2>Make your whole picture visible.</h2>
                <p>No portfolio data yet. Add your first asset to see net worth, allocation, and the changes shaping your wealth in one calm view.</p>
                <p class="presentation-empty-note">The illustrative preview is not your data. Add an asset in Settings, then record a value or connect an integration to replace it with your live dashboard.</p>
                <a class="action-btn" href="#settings?panel=asset-catalog&focus=catalog-add-asset-button" aria-controls="asset-catalog-pane">Add your first asset</a>
            </div>
            <div class="presentation-preview dashboard-preview" role="img" aria-label="Illustrative static preview of a configured wealth dashboard; not your data">
                <div class="presentation-preview-header">
                    <div>
                        <span class="presentation-preview-label">Illustrative preview</span>
                        <strong>Wealth Watcher</strong>
                    </div>
                    <span class="presentation-preview-status">Month example</span>
                </div>
                <div class="dashboard-preview-toolbar" aria-hidden="true">
                    <div class="dashboard-preview-periods"><span>Day</span><span>Week</span><span class="active">Month</span><span>3 Months</span><span title="Year To Date">YTD</span><span>MAX</span></div>
                    <div class="dashboard-preview-actions"><i>↻</i><i>◌</i></div>
                </div>
                <div class="dashboard-preview-total">
                    <span>Holistic net worth</span>
                    <strong>£428,640</strong>
                    <small>+£12,480 <b>(3.0%)</b> this month</small>
                    <em>YTD: +£12,480 (3.0%)</em>
                    <div class="dashboard-preview-proportion" aria-hidden="true"><i class="preview-dot-cash"></i><i class="preview-dot-investments"></i><i class="preview-dot-property"></i></div>
                </div>
                <div class="dashboard-preview-lanes">
                    <div class="dashboard-preview-lane-heading"><span>Liquid Assets</span><strong>£297,360</strong></div>
                    <div class="dashboard-preview-card-grid">
                        <div class="dashboard-preview-asset-card">
                            <div class="dashboard-preview-card-header"><span><i class="preview-dot preview-dot-cash"></i>Cash <b class="dashboard-preview-freshness"></b></span><strong>+£2,160</strong></div>
                            <div class="dashboard-preview-card-value">£82,400</div>
                            <svg class="dashboard-preview-sparkline" viewBox="0 0 180 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,25 20,22 42,24 64,16 86,19 108,11 132,14 156,7 180,9"></polyline></svg>
                            <div class="dashboard-preview-card-breakdown"><span>Current Account</span><strong>£82,400</strong></div>
                        </div>
                        <div class="dashboard-preview-asset-card">
                            <div class="dashboard-preview-card-header"><span><i class="preview-dot preview-dot-investments"></i>Investments <b class="dashboard-preview-freshness"></b></span><strong>+£10,320</strong></div>
                            <div class="dashboard-preview-card-value">£214,960</div>
                            <svg class="dashboard-preview-sparkline dashboard-preview-sparkline-investments" viewBox="0 0 180 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,27 18,25 39,24 58,20 79,22 98,16 120,17 141,10 160,12 180,4"></polyline></svg>
                            <div class="dashboard-preview-card-breakdown"><span>Global Index Fund</span><strong>£214,960</strong></div>
                        </div>
                    </div>
                    <div class="dashboard-preview-lane-heading"><span>Illiquid Assets</span><strong>£131,280</strong></div>
                    <div class="dashboard-preview-asset-card dashboard-preview-property-card">
                        <div class="dashboard-preview-card-header"><span><i class="preview-dot preview-dot-property"></i>Properties <b class="dashboard-preview-freshness"></b></span><strong>+£0</strong></div>
                        <div class="dashboard-preview-card-value">£131,280</div>
                        <div class="dashboard-preview-card-breakdown"><span>Home</span><strong>£131,280</strong></div>
                    </div>
                </div>
            </div>
        </div>`;
    insertDashboardState(view, emptyState);
    return emptyState;
}

function createDashboardErrorState(view) {
    if (typeof document.createElement !== 'function') return null;

    const errorState = document.createElement('div');
    errorState.id = 'dashboard-error-state';
    errorState.className = 'catalog-workspace presentation-empty-state dashboard-error-state';
    errorState.setAttribute?.('role', 'alert');
    errorState.setAttribute?.('data-page-error', '');
    errorState.innerHTML = `
        <div class="presentation-empty-state-layout">
            <div class="presentation-empty-copy">
                <span class="presentation-empty-kicker">Portfolio dashboard</span>
                <h2>We couldn’t load your dashboard.</h2>
                <p>There was a problem retrieving your portfolio data. Try again, and if the problem continues check your connection or API status.</p>
                <button class="action-btn" type="button" data-dashboard-action="retry">Try again</button>
            </div>
        </div>`;
    insertDashboardState(view, errorState);
    return errorState;
}

function renderDashboardPageState() {
    const view = document.getElementById('dashboard-view');
    if (!view || typeof document.createElement !== 'function') return;

    setPageStatus(view, dashboardPageState);

    const header = view.querySelector?.(':scope > header') || view.querySelector?.('header');
    const laneSections = document.getElementById('lane-sections');
    const fireStatusCard = document.getElementById('fire-status-dashboard-card');
    let emptyState = document.getElementById('dashboard-empty-state');
    let errorState = document.getElementById('dashboard-error-state');

    if (dashboardPageState === PAGE_STATUS.EMPTY && !emptyState) emptyState = createDashboardEmptyState(view);
    if (dashboardPageState === PAGE_STATUS.ERROR && !errorState) errorState = createDashboardErrorState(view);

    if (dashboardPageState === PAGE_STATUS.LOADING) {
        if (header) header.hidden = false;
        if (laneSections) laneSections.hidden = true;
        if (fireStatusCard) fireStatusCard.hidden = true;
    } else if (dashboardPageState === PAGE_STATUS.READY) {
        if (header) header.hidden = false;
        if (laneSections) laneSections.hidden = false;
    } else {
        clearDashboardLiveContent();
        if (header) header.hidden = true;
        if (laneSections) laneSections.hidden = true;
        if (fireStatusCard) fireStatusCard.hidden = true;
    }

    if (emptyState) emptyState.hidden = dashboardPageState !== PAGE_STATUS.EMPTY;
    if (errorState) errorState.hidden = dashboardPageState !== PAGE_STATUS.ERROR;
}

function shouldHideDashboardCategory(category, data) {
    if (store.state.assetsLoaded === true && !findAssetForCategory(category)) return true;
    return store.state.generalSettings?.showZeroValuesOnDashboard !== true && getCurrentAggregateValue(data) === 0;
}

function getAssetGroupDescriptors() {
    const assetGroup = (store.state.classificationGroups || [])
        .find(group => normalizeCode(getRecordValue(group, 'Key')) === 'asset-group');
    const assetGroupValues = assetGroup
        ? (Array.isArray(getRecordValue(assetGroup, 'Values')) ? getRecordValue(assetGroup, 'Values') : [])
            .sort((left, right) => (getRecordValue(left, 'DisplayOrder') || 0) - (getRecordValue(right, 'DisplayOrder') || 0))
            .map(value => ({
                key: `value:${getRecordValue(value, 'Id')}`,
                valueId: String(getRecordValue(value, 'Id')),
                valueKey: normalizeCode(getRecordValue(value, 'Key') || getRecordValue(value, 'Code')),
                title: getRecordValue(value, 'DisplayName') || getRecordValue(value, 'Key'),
                color: getRecordValue(value, 'Color') || '#64748b'
            }))
        : [];

    if (assetGroupValues.length === 0) {
        return [
            { key: 'unassigned', valueId: null, title: '', groupName: '', gridId: 'liquid-grid', totalId: 'liquid-total' }
        ];
    }

    const descriptors = assetGroupValues.map((value, index) => ({
        ...value,
        gridId: value.valueKey === 'liquid' ? 'liquid-grid' : value.valueKey === 'illiquid' ? 'illiquid-grid' : `lane-grid-${index}`,
        totalId: value.valueKey === 'liquid' ? 'liquid-total' : value.valueKey === 'illiquid' ? 'illiquid-total' : `lane-total-${index}`
    }));
    descriptors.push({
        key: 'unassigned',
        valueId: null,
        title: 'No asset group',
        groupName: '',
        gridId: `lane-grid-unassigned`,
        totalId: `lane-total-unassigned`
    });
    return descriptors;
}

function getVisibleAssetGroupDescriptors(descriptors, categories) {
    const visibleKeys = new Set();
    (Array.isArray(categories) ? categories : []).forEach(category => {
        getAssetGroupDescriptorsForCategory(category, descriptors)
            .forEach(descriptor => visibleKeys.add(descriptor.key));
    });
    return descriptors.filter(descriptor => visibleKeys.has(descriptor.key));
}

export function getActiveUnclassifiedAssetCount() {
    return (Array.isArray(store.state.assets) ? store.state.assets : [])
        .filter(asset => !asset?.ArchivedAt && isUnclassifiedAsset(asset))
        .length;
}

function isUnclassifiedAsset(asset) {
    if (normalizeCode(getRecordValue(asset, 'AssetKindCode')) === 'unclassified') return true;

    const kindId = getRecordValue(asset, 'AssetKindId');
    const kindGroup = (store.state.classificationGroups || [])
        .find(group => normalizeCode(getRecordValue(group, 'Key')) === 'asset-kind');
    const kind = (getRecordValue(kindGroup, 'Values') || []).find(value =>
        (kindId && String(getRecordValue(value, 'Id')) === String(kindId)) ||
        normalizeCode(getRecordValue(value, 'Key') || getRecordValue(value, 'Code')) === 'unclassified');
    if (normalizeCode(getRecordValue(kind, 'Key') || getRecordValue(kind, 'Code')) === 'unclassified') return true;

    const classifications = getRecordValue(asset, 'Classifications');
    return Array.isArray(classifications) && classifications.some(value =>
        normalizeCode(getRecordValue(value, 'Key') || getRecordValue(value, 'Code')) === 'unclassified');
}

export function renderUnclassifiedAssetBanner(count) {
    const laneSections = document.getElementById('lane-sections');
    if (!laneSections) return;

    if (count <= 1) {
        laneSections.innerHTML = laneSections.innerHTML
            .replace(/<aside id="unclassified-assets-banner"[\s\S]*?<\/aside>/, '');
        return;
    }
    const banner = `<aside id="unclassified-assets-banner" class="dashboard-alert unclassified-assets-banner" role="alert" aria-labelledby="unclassified-assets-banner-title">
        <strong id="unclassified-assets-banner-title">${count} assets are Unclassified</strong>
        <span>Assign each asset an Asset Kind so your dashboard stays organised.</span>
        <a href="#settings">Review Asset Kinds in Settings</a>
    </aside>`;
    laneSections.innerHTML = banner + laneSections.innerHTML;
}

function renderAssetGroupSections(descriptors) {
    const assetGroupSections = document.getElementById('lane-sections');
    if (!assetGroupSections) {
        return new Map(descriptors.map(descriptor => [descriptor.key, document.getElementById(descriptor.gridId)]));
    }

    const existingSections = typeof assetGroupSections.querySelectorAll === 'function'
        ? assetGroupSections.querySelectorAll('[data-asset-group-key]')
        : [];
    existingSections.forEach(section => {
        if (section.open) collapsedAssetGroupKeys.delete(section.dataset.assetGroupKey);
        else collapsedAssetGroupKeys.add(section.dataset.assetGroupKey);
    });

    assetGroupSections.innerHTML = descriptors.map(descriptor => {
        const title = descriptor.title || 'Assets';
        const openAttribute = collapsedAssetGroupKeys.has(descriptor.key) ? '' : ' open';
        return `<details class="asset-group-section lane-section" data-asset-group-key="${escapeHtml(descriptor.key)}"${openAttribute}>
            <summary class="asset-group-summary section-title">
                <span>${escapeHtml(title)}</span>
                <span class="asset-group-summary-total">
                    <span id="${escapeHtml(descriptor.totalId)}" class="obfuscate-val lane-total"></span>
                    <span class="asset-group-summary-chevron" aria-hidden="true">⌄</span>
                </span>
            </summary>
            <div class="grid-container" id="${escapeHtml(descriptor.gridId)}"></div>
        </details>`;
    }).join('');

    const renderedSections = typeof assetGroupSections.querySelectorAll === 'function'
        ? assetGroupSections.querySelectorAll('details[data-asset-group-key]')
        : [];
    renderedSections.forEach(section => {
        section.addEventListener?.('toggle', () => {
            if (section.open) collapsedAssetGroupKeys.delete(section.dataset.assetGroupKey);
            else collapsedAssetGroupKeys.add(section.dataset.assetGroupKey);
        });
    });

    return new Map(descriptors.map(descriptor => [descriptor.key, document.getElementById(descriptor.gridId)]));
}

function findAssetsForCategory(category) {
    const kindId = getRecordValue(category, 'ClassificationValueId') || getRecordValue(category, 'AssetKindId');
    const kindCode = normalizeCode(getRecordValue(category, 'Id') || getRecordValue(category, 'AssetKindCode'));
    return (store.state.assets || []).filter(asset => {
        if (kindId && String(getRecordValue(asset, 'AssetKindId')) === String(kindId)) return true;
        if (kindCode && normalizeCode(getRecordValue(asset, 'AssetKindCode')) === kindCode) return true;
        const classifications = getRecordValue(asset, 'Classifications');
        return kindId && Array.isArray(classifications) && classifications.some(classification =>
            String(getRecordValue(classification, 'Id')) === String(kindId));
    });
}

function findAssetForCategory(category) {
    return findAssetsForCategory(category)[0] || null;
}

function resolveAssetGroupDescriptorForAsset(asset, category, descriptors) {
    const hasExplicitAssetGroup = asset && (
        getRecordValue(asset, 'AssetGroupAssignmentSet') === true ||
        (getRecordValue(asset, 'AssetGroupAssignmentSet') === undefined &&
            Object.prototype.hasOwnProperty.call(asset, 'AssetGroupId')));
    if (hasExplicitAssetGroup) {
        const assetGroupValueId = getRecordValue(asset, 'AssetGroupId');
        if (assetGroupValueId) {
            const mapped = descriptors.find(descriptor => descriptor.valueId === String(assetGroupValueId));
            if (mapped) return mapped;
        }
        return descriptors.find(descriptor => descriptor.key === 'unassigned') || descriptors[descriptors.length - 1];
    }

    return resolveCategoryAssetGroupDescriptor(category, descriptors, asset);
}

function getAssetGroupDescriptorsForCategory(category, descriptors) {
    const assets = findAssetsForCategory(category);
    const candidates = assets.length > 0
        ? assets.map(asset => resolveAssetGroupDescriptorForAsset(asset, category, descriptors))
        : [resolveCategoryAssetGroupDescriptor(category, descriptors)];
    const defaultDescriptor = resolveCategoryAssetGroupDescriptor(category, descriptors);
    if (assets.length > 1 && candidates.length > 1 && defaultDescriptor &&
        !candidates.some(descriptor => descriptor?.key === defaultDescriptor.key)) {
        candidates.push(defaultDescriptor);
    }
    const unique = new Map(candidates
        .filter(Boolean)
        .map(descriptor => [descriptor.key, descriptor]));
    return [...unique.values()];
}

function resolveAssetGroupDescriptor(category, descriptors) {
    const categoryGroups = getAssetGroupDescriptorsForCategory(category, descriptors);
    if (categoryGroups.length === 1) return categoryGroups[0];
    return resolveCategoryAssetGroupDescriptor(category, descriptors);
}

function resolveCategoryAssetGroupDescriptor(category, descriptors, fallbackAsset = null) {

    const assetGroupValueId = getRecordValue(category, 'AssetGroupId') || getRecordValue(category, 'AssetClassValueId');
    if (assetGroupValueId) {
        const mapped = descriptors.find(descriptor => descriptor.valueId === String(assetGroupValueId));
        if (mapped) return mapped;
    }

    const assetGroupValueKey = normalizeCode(
        getRecordValue(category, 'AssetGroupCode') || getRecordValue(category, 'AssetClassValueKey'));
    if (assetGroupValueKey) {
        const mapped = descriptors.find(descriptor => descriptor.valueKey === assetGroupValueKey);
        if (mapped) return mapped;
    }

    const kindId = getRecordValue(category, 'ClassificationValueId') || getRecordValue(category, 'AssetKindId');
    const kindCode = normalizeCode(getRecordValue(category, 'Id') || getRecordValue(category, 'AssetKindCode'));
    const assetKindGroup = (store.state.classificationGroups || [])
        .find(group => normalizeCode(getRecordValue(group, 'Key')) === 'asset-kind');
    const assetKind = (getRecordValue(assetKindGroup, 'Values') || []).find(value =>
        (kindId && String(getRecordValue(value, 'Id')) === String(kindId)) ||
        (kindCode && normalizeCode(getRecordValue(value, 'Key') || getRecordValue(value, 'Code')) === kindCode));
    const mappedKindGroupId = getRecordValue(assetKind, 'AssetGroupId');
    const mappedKindGroupCode = normalizeCode(getRecordValue(assetKind, 'AssetGroupCode'));
    const mapped = descriptors.find(descriptor =>
        (mappedKindGroupId && descriptor.valueId === String(mappedKindGroupId)) ||
        (mappedKindGroupCode && descriptor.valueKey === mappedKindGroupCode));
    if (mapped) return mapped;

    const assetGroupCode = normalizeCode(
        getRecordValue(category, 'AssetGroupCode') || getRecordValue(fallbackAsset, 'AssetGroupCode'));
    if (assetGroupCode) {
        const assetMapped = descriptors.find(descriptor => descriptor.valueKey === assetGroupCode);
        if (assetMapped) return assetMapped;
    }

    if (assetKind) {
        const parentValueId = getRecordValue(assetKind, 'ParentValueId');
        const parentMapped = descriptors.find(descriptor => descriptor.valueId === String(parentValueId));
        if (parentMapped) return parentMapped;
    }

    if (kindId) {
        const assetClassification = getRecordValue(fallbackAsset, 'Classifications');
        const groupClassification = Array.isArray(assetClassification)
            ? assetClassification.find(value => normalizeCode(getRecordValue(value, 'GroupKey')) === 'asset-group')
            : null;
        const classificationMapped = descriptors.find(descriptor =>
            descriptor.valueId === String(getRecordValue(groupClassification, 'Id')) ||
            descriptor.valueKey === normalizeCode(getRecordValue(groupClassification, 'Key')));
        if (classificationMapped) return classificationMapped;
    }

    const unassigned = descriptors.find(descriptor => descriptor.key === 'unassigned');
    if (unassigned) return unassigned;
    return descriptors[descriptors.length - 1];
}

function getAssetDisplayName(asset) {
    return getRecordValue(asset, 'DisplayName') || getRecordValue(asset, 'Name') || '';
}

function findUniqueAssetForBreakdownName(category, name) {
    const normalizedName = normalizeCode(String(name || '').replace(/\s+\(undeployed\)$/i, ''));
    if (!normalizedName) return null;

    const matches = findAssetsForCategory(category).filter(asset =>
        normalizeCode(getAssetDisplayName(asset)) === normalizedName);
    return matches.length === 1 ? matches[0] : null;
}

function splitBreakdownByAssetGroup(breakdown, category, descriptors, fallbackDescriptor) {
    const groups = new Map();
    Object.entries(breakdown || {}).forEach(([name, rawValue]) => {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return;

        const asset = findUniqueAssetForBreakdownName(category, name);
        const descriptor = asset
            ? resolveAssetGroupDescriptorForAsset(asset, category, descriptors)
            : fallbackDescriptor;
        if (!descriptor) return;

        const group = groups.get(descriptor.key) || { value: 0, breakdown: {} };
        group.value += value;
        group.breakdown[name] = value;
        groups.set(descriptor.key, group);
    });
    return groups;
}

function getInvestmentDetailsForBreakdown(investmentDetails, breakdown) {
    if (!investmentDetails || typeof investmentDetails !== 'object') return investmentDetails;
    const names = new Set(Object.keys(breakdown || {}).map(name => normalizeCode(name.replace(/\s+\(undeployed\)$/i, ''))));
    const matching = Object.entries(investmentDetails)
        .filter(([name]) => names.has(normalizeCode(name.replace(/\s+\(undeployed\)$/i, ''))));
    return matching.length > 0 ? Object.fromEntries(matching) : undefined;
}

function getPropertyDetailsForGroup(propertyDetails, category, descriptor, fallbackDescriptor, descriptors) {
    const properties = Array.isArray(propertyDetails?.Properties) ? propertyDetails.Properties : [];
    if (properties.length === 0) return propertyDetails;

    const assets = findAssetsForCategory(category);
    const selected = properties.filter(property => {
        const asset = assets.find(candidate =>
            String(getRecordValue(candidate, 'Id')) === String(getRecordValue(property, 'Id')));
        const propertyGroup = asset
            ? resolveAssetGroupDescriptorForAsset(asset, category, descriptors)
            : fallbackDescriptor;
        return propertyGroup?.key === descriptor.key;
    });
    const value = selected.reduce((total, property) => total + (Number(property.Value) || 0), 0);
    const mortgage = selected.reduce((total, property) => total + (Number(property.Mortgage) || 0), 0);
    return {
        ...propertyDetails,
        Properties: selected,
        Totals: {
            Value: value,
            Mortgage: mortgage,
            Equity: value - mortgage
        }
    };
}

function getCategoryGroupParts(category, data, descriptors) {
    const history = Array.isArray(data?.Data) ? data.Data : [];
    const groupDescriptors = getAssetGroupDescriptorsForCategory(category, descriptors);
    const fallbackDescriptor = resolveCategoryAssetGroupDescriptor(category, descriptors);
    if (groupDescriptors.length <= 1) {
        const latestPoint = history[history.length - 1];
        return [{
            descriptor: groupDescriptors[0] || fallbackDescriptor,
            history,
            breakdown: data?.LatestBreakdown || getAggregateBreakdown(latestPoint) || {},
            propertyDetails: data?.PropertyDetails,
            investmentDetails: data?.InvestmentDetails
        }];
    }

    const groupedHistory = new Map(groupDescriptors.map(descriptor => [descriptor.key, []]));
    history.forEach((point, index) => {
        const pointBreakdown = getAggregateBreakdown(point)
            || (index === history.length - 1 && data?.LatestBreakdown ? data.LatestBreakdown : null);
        const grouped = pointBreakdown && Object.keys(pointBreakdown).length > 0
            ? splitBreakdownByAssetGroup(pointBreakdown, category, descriptors, fallbackDescriptor)
            : new Map([[fallbackDescriptor.key, {
                value: Number(point.Value) || 0,
                breakdown: {}
            }]]);
            const sourceValue = Number(point.Value) || 0;
            const sourceInvested = Number(point.Invested) || 0;

        groupDescriptors.forEach(descriptor => {
            const group = grouped.get(descriptor.key);
            const value = group?.value || 0;
                const invested = calculateInvestedShare(sourceValue, sourceInvested, value);
                groupedHistory.get(descriptor.key).push({
                ...point,
                Value: value,
                Invested: Number.isFinite(invested) ? invested : 0,
                Breakdown: group?.breakdown || {}
            });
        });
    });

    const latestBreakdown = data?.LatestBreakdown && Object.keys(data.LatestBreakdown).length > 0
        ? splitBreakdownByAssetGroup(data.LatestBreakdown, category, descriptors, fallbackDescriptor)
        : new Map();

    return groupDescriptors
        .map(descriptor => {
            const partHistory = groupedHistory.get(descriptor.key) || [];
            const partBreakdown = latestBreakdown.get(descriptor.key)?.breakdown
                || partHistory.at(-1)?.Breakdown
                || {};
            return {
                descriptor,
                history: partHistory,
                breakdown: partBreakdown,
                propertyDetails: getPropertyDetailsForGroup(
                    data?.PropertyDetails,
                    category,
                    descriptor,
                    fallbackDescriptor,
                    descriptors),
                investmentDetails: getInvestmentDetailsForBreakdown(data?.InvestmentDetails, partBreakdown)
            };
        })
        .filter(part => store.state.generalSettings?.showZeroValuesOnDashboard === true
            || Number(part.history.at(-1)?.Value) !== 0
            || Object.keys(part.breakdown).length > 0);
}

function normalizeCode(value) {
    return String(value || '').trim().toLowerCase();
}

function getRecordValue(record, propertyName) {
    if (!record) return undefined;
    return record[propertyName];
}

function updateGlobalHeader(total, past, contributors) {
    document.getElementById('global-total').innerText = formatter.format(total);
    const diff = total - past;
    const perc = past !== 0 ? (diff / past) * 100 : 0;
    
    const deltaEl = document.getElementById('global-delta');
    deltaEl.innerText = `${diff>=0?'+':''}${formatter.format(diff)} (${perc.toFixed(2)}%)`;
    deltaEl.className = `global-delta ${diff < 0 ? 'neg' : ''} obfuscate-val`;

    const explainerEl = document.getElementById('delta-explainer');
    if (Math.abs(diff) < 1) {
        explainerEl.innerHTML = '';
    } else {
        const insightContributors = contributors.flatMap(contributor =>
            contributor.insightChildren?.length ? contributor.insightChildren : [contributor]);
        const positives = insightContributors.filter(c => c.delta > 0).sort((a,b) => b.delta - a.delta);
        const negatives = insightContributors.filter(c => c.delta < 0).sort((a,b) => a.delta - b.delta);
        
        const totalPos = positives.reduce((sum, c) => sum + c.delta, 0);
        const totalNeg = negatives.reduce((sum, c) => sum + Math.abs(c.delta), 0);
        
        const renderDriver = (c) => {
            const sign = c.delta > 0 ? '+' : '';
            const color = safeCssColor(c.color, '#06b6d4');
            let tooltip = '';
            if (c.explanation) {
                tooltip = ` title="${escapeHtml(c.explanation)}"`;
            } else if (c.deltaInvested !== 0) {
                const organicDelta = c.delta - c.deltaInvested;
                tooltip = ` title="${escapeHtml(`Deposits: ${formatter.format(c.deltaInvested)} | Market: ${organicDelta >= 0 ? '+' : ''}${formatter.format(organicDelta)}`)}"`;
            }
            return `<span class="insight-pill" style="color: ${color}; border: 1px solid ${color}30; background-color: ${color}15;"${tooltip}>
                        ${escapeHtml(c.name)}
                        <span class="obfuscate-val" style="opacity: 0.8; margin-left: 6px; font-weight: 400;">${sign}${formatter.format(c.delta)}</span>
                    </span>`;
        };

        let html = '';
        if (diff > 0 && positives.length > 0) {
            if (positives.length > 2 && positives[0].delta < totalPos * 0.4) {
                html = `Growth broadly distributed across your portfolio.`;
            } else {
                html = `Growth driven by ${renderDriver(positives[0])}`;
                if (positives.length > 1 && positives[1].delta > positives[0].delta * 0.6) {
                    html += ` & ${renderDriver(positives[1])}`;
                }
                if (negatives.length > 0 && Math.abs(negatives[0].delta) > totalPos * 0.15) {
                    html += `, offset by ${renderDriver(negatives[0])}`;
                }
            }
        } else if (diff < 0 && negatives.length > 0) {
            if (negatives.length > 2 && Math.abs(negatives[0].delta) < totalNeg * 0.4) {
                html = `Losses broadly distributed across your portfolio.`;
            } else {
                html = `Drop driven by ${renderDriver(negatives[0])}`;
                if (negatives.length > 1 && Math.abs(negatives[1].delta) > Math.abs(negatives[0].delta) * 0.6) {
                    html += ` & ${renderDriver(negatives[1])}`;
                }
                if (positives.length > 0 && positives[0].delta > totalNeg * 0.15) {
                    html += `, offset by ${renderDriver(positives[0])}`;
                }
            }
        }
        explainerEl.innerHTML = html;
    }

    const propBar = document.getElementById('proportion-bar');
    propBar.innerHTML = '';
    
    if (total > 0) {
        const sorted = [...contributors].sort((a,b) => b.currentVal - a.currentVal);
        sorted.forEach(c => {
            if (c.currentVal > 0) {
                const width = (c.currentVal / total) * 100;
                const segment = document.createElement('div');
                segment.className = 'prop-segment';
                segment.style.width = `${width}%`;
                segment.style.backgroundColor = safeCssColor(c.color, '#06b6d4');
                segment.title = `${c.name}: ${formatter.format(c.currentVal)}`;
                propBar.appendChild(segment);
            }
        });
    }
}

export function buildPropertyInsightContributors(currentPoint, pastPoint, color) {
    const currentValues = currentPoint?.PropertyValues;
    const pastValues = pastPoint?.PropertyValues;
    if (!currentValues || !pastValues) return [];

    const currentEquity = currentPoint?.Breakdown || {};
    const pastEquity = pastPoint?.Breakdown || {};
    const names = new Set([
        ...Object.keys(currentValues),
        ...Object.keys(pastValues),
        ...Object.keys(currentEquity),
        ...Object.keys(pastEquity)
    ]);
    const contributors = [];
    names.forEach(name => {
        const valueDelta = Number(currentValues[name] || 0) - Number(pastValues[name] || 0);
        const equityDelta = Number(currentEquity[name] || 0) - Number(pastEquity[name] || 0);
        const financingDelta = equityDelta - valueDelta;
        if (Math.abs(valueDelta) >= 0.01) {
            contributors.push({
                name: `${name} value`,
                delta: valueDelta,
                deltaInvested: 0,
                color,
                explanation: 'Change in the property’s gross value.'
            });
        }
        if (Math.abs(financingDelta) >= 0.01) {
            contributors.push({
                name: `${name} equity`,
                delta: financingDelta,
                deltaInvested: 0,
                color: '#e2e8f0',
                explanation: 'Equity gained or released through a change in the linked mortgage balance.'
            });
        }
    });
    return contributors;
}

function getPropertyField(property, name, fallback = 0) {
    return property?.[name] ?? property?.[name.charAt(0).toLowerCase() + name.slice(1)] ?? fallback;
}

function getPropertyEntries(propertyDetails) {
    const rawProperties = Array.isArray(propertyDetails?.Properties)
        ? propertyDetails.Properties
        : propertyDetails?.Name
            ? [propertyDetails]
            : [];
    return rawProperties.slice().sort((a, b) =>
        String(getPropertyField(a, 'Name', 'Property')).localeCompare(String(getPropertyField(b, 'Name', 'Property'))));
}

function renderDashboardEntryAction({ categoryId, name = '', value = null, mortgage = null, entryId = '' }) {
    const hasValue = value !== null && value !== undefined;
    const hasMortgage = mortgage !== null && mortgage !== undefined;
    const entryLabel = name ? `Add entry for ${name}` : 'Add entry';
    return `<button type="button" class="property-action-btn asset-entry-action" data-dashboard-action="entry" data-category-id="${escapeHtml(categoryId)}" data-entry-name="${escapeHtml(name)}" data-entry-id="${escapeHtml(entryId)}" data-entry-value="${hasValue ? Number(value) : ''}"${hasMortgage ? ` data-entry-mortgage="${Number(mortgage)}"` : ''} aria-label="${escapeHtml(entryLabel)}" title="Add entry">Add entry</button>`;
}

function renderDashboardArchiveAction({ action, name, idAttribute, id, categoryId = '', propertyName = '', icon = false, className = '' }) {
    const identifier = idAttribute
        ? ` ${idAttribute}="${escapeHtml(id || '')}"`
        : '';
    const category = categoryId
        ? ` data-category-id="${escapeHtml(categoryId)}"`
        : '';
    const property = propertyName
        ? ` data-property-name="${escapeHtml(propertyName)}"`
        : '';
    const label = `Archive ${name || 'asset'}`;
    return `<button type="button" class="property-action-btn asset-archive-action${icon ? ' icon-only' : ''}${className ? ` ${className}` : ''}" data-dashboard-action="${escapeHtml(action)}"${identifier}${category}${property} data-asset-name="${escapeHtml(name || '')}" aria-label="${escapeHtml(label)}" title="Archive asset">${icon ? '&times;' : 'Archive'}</button>`;
}

function renderPropertyPanel(propertyDetails) {
    const properties = getPropertyEntries(propertyDetails);

    if (properties.length === 0) {
        return '<div class="property-empty-state">No properties added yet.</div>';
    }

    let html = `
        <div class="property-table" role="table" aria-label="Properties">
            <div class="property-table-row property-table-header" role="row">
                <span role="columnheader">Name</span>
                <span role="columnheader">Value</span>
                <span role="columnheader">Mortgage</span>
                <span role="columnheader">Equity</span>
                <span role="columnheader">Actions</span>
            </div>`;

    for (const property of properties) {
        const id = getPropertyField(property, 'Id', '');
        const name = getPropertyField(property, 'Name', 'Property');
        const value = Number(getPropertyField(property, 'Value', 0));
        const mortgage = Number(getPropertyField(property, 'Mortgage', 0));
        const equity = Number(getPropertyField(property, 'Equity', value - mortgage));

        html += `
            <div class="property-table-row" role="row">
                <span class="property-name" role="cell" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <span class="property-number obfuscate-val" role="cell">${formatter.format(value)}</span>
                <span class="property-number text-red obfuscate-val" role="cell">${formatter.format(mortgage)}</span>
                <span class="property-number text-green obfuscate-val" role="cell">${formatter.format(equity)}</span>
                <span class="property-actions" role="cell">
                    ${renderDashboardEntryAction({ categoryId: 'property', name, value, mortgage, entryId: id })}
                    ${renderDashboardArchiveAction({ action: 'archive-property', name, idAttribute: 'data-property-id', id, propertyName: name, icon: true, className: 'property-archive-btn' })}
                </span>
            </div>`;
    }

    html += `
        </div>`;

    return html;
}

function renderCard(cat, currentVal, pastVal, delta, history, breakdown, lastSync, isManual, propertyDetails, investmentDetails, selectedPeriod, container, renderKey = cat.Id) {
    if (!container) return;
    const chartKey = String(renderKey || cat.Id).replace(/[^a-zA-Z0-9_-]/g, '-');
    
    let freshClass = 'fresh-good';
    if (lastSync) {
        const hoursAgo = (new Date() - lastSync) / (1000 * 60 * 60);
        if (isManual) {
            if (hoursAgo > 24 * 30) freshClass = 'fresh-bad';
            else if (hoursAgo > 24 * 14) freshClass = 'fresh-warn';
        } else {
            if (hoursAgo > 72) freshClass = 'fresh-bad';
            else if (hoursAgo > 24) freshClass = 'fresh-warn';
        }
    } else {
        freshClass = 'fresh-bad';
    }

    const breakdownEntries = breakdown && typeof breakdown === 'object' ? breakdown : {};
    const propertyEntries = getPropertyEntries(propertyDetails);
    const showSparklines = store.state.generalSettings?.showSparklines !== false;
    const chartHistory = aggregateAssetCardHistory(history, selectedPeriod);
    const isPropertyCard = normalizeCode(cat.Id) === 'property';

    let breakdownHtml = '<div class="breakdown-list">';
    
    let undeployedFunds = 0;
    if (breakdownEntries) {
        Object.keys(breakdownEntries).forEach(name => {
            if (name.toLowerCase().includes('(undeployed)') && breakdownEntries[name] > 0) {
                undeployedFunds += breakdownEntries[name];
            }
        });
    }

    if (undeployedFunds > 0) {
        breakdownHtml += `
            <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 6px; padding: 10px; margin-bottom: 12px; display: flex; align-items: flex-start; gap: 8px;">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="#f59e0b" stroke-width="2" fill="none" style="flex-shrink: 0; margin-top: 2px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                <div style="font-size: 0.8rem; color: #fcd34d; line-height: 1.4;">
                    <strong style="color: #f59e0b;">Action Required</strong><br>
                    You have <span class="obfuscate-val">${formatter.format(undeployedFunds)}</span> sitting as undeployed cash. Consider investing it!
                </div>
            </div>`;
    }

    if (cat.Id === 'property') {
        breakdownHtml += renderPropertyPanel(propertyDetails);
    } else {
        Object.keys(breakdownEntries).forEach(name => {
            const val = breakdownEntries[name];
            if (store.state.generalSettings?.showZeroValuesOnDashboard !== true && Number(val) === 0) {
                return;
            }
            const assetHistory = getBreakdownHistory(history, name);
            const sparkline = showSparklines
                ? renderSparkline(assetHistory, cat.Color, `${name} trend`)
                : '';
            const childAssetId = findDashboardAssetId(cat, name);
            const archiveChild = renderDashboardArchiveAction({
                action: 'archive-child',
                name,
                idAttribute: 'data-asset-id',
                id: childAssetId,
                categoryId: cat.Id,
                icon: true,
                className: 'breakdown-archive-btn'
            });
            breakdownHtml += `
                <div class="breakdown-item${showSparklines ? '' : ' no-sparkline'}">
                    <span class="breakdown-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="breakdown-val obfuscate-val">${formatter.format(val)}</span>
                    ${sparkline}
                    ${renderDashboardEntryAction({ categoryId: cat.Id, name, value: val })}
                    ${archiveChild}
                </div>`;
        });
        
        if (cat.Id === 'investments' && investmentDetails) {
            let allPositions = {};
            Object.values(investmentDetails).forEach(accPositions => {
                accPositions.forEach(p => {
                    const name = p.name || p.Name || p.ticker || p.Ticker;
                    const v = p.currentValue || p.CurrentValue;
                    if (!allPositions[name]) allPositions[name] = { ticker: name, value: 0 };
                    allPositions[name].value += v;
                });
            });
            window.investmentXrayData = Object.values(allPositions).sort((a,b) => b.value - a.value);
            
            breakdownHtml += `
                <div class="xray-container" style="margin-top: 15px; border-top: 1px solid #ffffff15; padding-top: 10px;">
                    <div style="font-size: 0.75rem; text-transform: uppercase; color: #a1a1aa; margin-bottom: 10px; font-weight: 600; letter-spacing: 0.05em;">Portfolio X-Ray</div>
                    <div style="display: flex; align-items: center; gap: 20px;">
                        <div style="position: relative; height: 120px; width: 120px; flex-shrink: 0;">
                            <canvas id="xray-chart" role="img" aria-label="Investment portfolio composition"></canvas>
                        </div>
                        <div id="xray-legend" style="flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;">
                        </div>
                    </div>
                </div>`;
        }
    }
    breakdownHtml += '</div>';

    const safeDelta = Number.isFinite(delta) ? delta : 0;
    const safePastVal = Number.isFinite(pastVal) ? pastVal : 0;
    const calculatedPercentage = safePastVal !== 0 ? (safeDelta / safePastVal) * 100 : 0;
    const deltaPercentage = Number.isFinite(calculatedPercentage) ? calculatedPercentage : 0;
    const deltaSign = safeDelta >= 0 ? '+' : '';
    const displayLabel = cat.Id === 'property' ? 'Properties' : String(cat.Label || cat.Id || 'Assets');
    const cardColor = safeCssColor(cat.Color, '#06b6d4');
    const lastSyncLabel = `Last Synced: ${lastSync ? lastSync.toLocaleString() : 'Never'}`;
    const addLabel = `Add ${getDashboardAssetName(cat)}`;
    const cardActions = `
        <div class="card-header-actions dashboard-card-actions" data-dashboard-card-actions>
            <button type="button" class="property-action-btn asset-entry-action card-entry-btn" data-dashboard-action="entry" data-category-id="${escapeHtml(cat.Id)}" data-entry-name="" data-entry-value="" aria-label="${escapeHtml(addLabel)}" title="${escapeHtml(addLabel)}">${escapeHtml(addLabel)}</button>
        </div>`;
    const headerLayout = "grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'heading actions';";

    const cardHtml = `
        <div class="card glass-panel" data-cat="${escapeHtml(cat.Id)}">
            <div class="card-header dashboard-card-header${showSparklines ? '' : ' no-sparkline'}" data-dashboard-card-header style="${headerLayout}">
                <div class="card-heading">
                    <span class="card-label">
                        ${escapeHtml(displayLabel)}
                        <div class="freshness-badge ${freshClass}" title="${escapeHtml(lastSyncLabel)}"></div>
                    </span>
                    <div class="card-delta ${safeDelta < 0 ? 'neg' : ''} obfuscate-val">${deltaSign}${formatter.format(safeDelta)} (${deltaPercentage.toFixed(2)}%)</div>
                </div>
                ${cardActions}
            </div>
            <div class="card-overview${showSparklines ? '' : ' no-chart'}">
                <div class="card-value obfuscate-val">${formatter.format(currentVal)}</div>
                ${showSparklines ? `<div class="mini-chart-container" aria-label="${escapeHtml(displayLabel)} trend"><canvas id="chart-${escapeHtml(chartKey)}" role="img" aria-label="${escapeHtml(displayLabel)} trend"></canvas></div>` : ''}
            </div>
            ${showSparklines ? `<details class="chart-data-alternative" data-dashboard-chart-data><summary>View ${escapeHtml(displayLabel)} trend data</summary></details>` : ''}
            ${breakdownHtml}
        </div>
    `;
    
    container.innerHTML += cardHtml;
    const renderedCard = container.lastElementChild;
    const accessibleHeaders = isPropertyCard
        ? [{ key: 'date', label: 'Date' }, { key: 'grossValue', label: 'Property value' }, { key: 'equity', label: 'Equity' }]
        : [{ key: 'date', label: 'Date' }, { key: 'value', label: 'Value' }];
    renderAccessibleChartData(renderedCard?.querySelector?.('[data-dashboard-chart-data]'), {
        summary: `View ${displayLabel} trend data`,
        headers: accessibleHeaders,
        rows: chartHistory.map(point => ({
            date: point?.Time,
            value: Number(point?.Value ?? 0),
            grossValue: Number(point?.GrossValue ?? point?.Value ?? 0),
            equity: Number(point?.Equity ?? point?.Value ?? 0)
        })),
        formatCell: (row, key) => key === 'date'
            ? formatDashboardTooltipTitle(row.date, selectedPeriod)
            : (globalThis.window?.isObfuscated ? '£***' : formatter.format(row[key]))
    });

    setTimeout(() => {
        const ctx = document.getElementById(`chart-${chartKey}`);
        if (!ctx || store.state.generalSettings?.showSparklines === false) return;
        if(charts[chartKey]) charts[chartKey].destroy();
        charts[chartKey] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartHistory.map(h => h.Time),
                datasets: buildAssetCardChartSeries(cat.Id, chartHistory, cardColor)
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { 
                    legend: {
                        display: isPropertyCard,
                        labels: { color: '#cbd5e1', usePointStyle: true, pointStyle: 'line', boxWidth: 24, boxHeight: 2 }
                    },
                    tooltip: { 
                        enabled: true, backgroundColor: '#1e293b', titleColor: '#94a3b8', bodyColor: '#f8fafc', displayColors: false,
                        callbacks: {
                            title: contexts => formatDashboardTooltipTitle(
                                chartHistory[contexts[0]?.dataIndex]?.Time,
                                selectedPeriod),
                            label: function(context) {
                                if (window.isObfuscated) return `${context.dataset.label || 'Total'}: £***`;
                                if (isPropertyCard) return `${context.dataset.label}: ${formatter.format(context.raw)}`;
                                const dataPoint = chartHistory[context.dataIndex];
                                let lines = [`Total: ${formatter.format(context.raw)}`];
                                if (dataPoint && dataPoint.Breakdown) {
                                    lines.push('------------------------');
                                    Object.keys(dataPoint.Breakdown).forEach(k => {
                                        lines.push(`${k}: ${formatter.format(dataPoint.Breakdown[k])}`);
                                    });
                                }
                                return lines;
                            }
                        }
                    } 
                },
                scales: { x: { display: false }, y: { display: false } }
            }
        });
    }, 0);
}

export function buildAssetCardChartSeries(categoryId, history, cardColor) {
    const points = Array.isArray(history) ? history : [];
    const common = {
        borderWidth: 2,
        backgroundColor: 'transparent',
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.4
    };
    if (normalizeCode(categoryId) === 'property') {
        return [
            {
                ...common,
                label: 'Property value',
                data: points.map(point => Number(point?.GrossValue ?? point?.Value ?? 0)),
                borderColor: cardColor
            },
            {
                ...common,
                label: 'Equity',
                data: points.map(point => Number(point?.Equity ?? point?.Value ?? 0)),
                borderColor: '#e2e8f0'
            }
        ];
    }
    return [{
        ...common,
        label: 'Total',
        data: points.map(point => Number(point?.Value ?? 0)),
        borderColor: cardColor
    }];
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function formatDashboardTooltipTitle(value, period = store.state.currentPeriod) {
    if (!value) return '';
    const date = parseDashboardDate(value);
    if (Number.isNaN(date.getTime())) return String(value);

    if (normalizePeriod(period) === '1D') {
        return formatDashboardHourlyInterval(date);
    }

    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    }).format(date);
}

function parseDashboardDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    const text = String(value);
    const localDateValue = text.includes('T')
        ? text.replace(/\.(\d{3})\d+/, '.$1')
        : `${text}T00:00:00`;
    return new Date(localDateValue);
}

function formatDashboardHourlyInterval(start) {
    const formatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    };
    const timeFormatter = new Intl.DateTimeFormat(undefined, formatOptions);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const startLabel = timeFormatter.format(start);
    const endLabel = timeFormatter.format(end);

    if (startLabel !== endLabel) return `${startLabel}\u2013${endLabel}`;

    const zoneFormatter = new Intl.DateTimeFormat(undefined, {
        ...formatOptions,
        timeZoneName: 'short'
    });
    return `${zoneFormatter.format(start)}\u2013${zoneFormatter.format(end)}`;
}

/**
 * Keeps dashboard asset charts readable at every range without changing the
 * denser History-page timeline. Short ranges retain daily closes; longer
 * ranges use progressively wider closing buckets, preferring a real provider
 * or manual observation over a carried-forward point within each bucket.
 */
export function aggregateAssetCardHistory(history, period = '1M') {
    const points = (Array.isArray(history) ? history : [])
        .map((point, index) => ({ point, index, timestamp: Date.parse(point?.Time) }))
        .filter(item => Number.isFinite(item.timestamp) && Number.isFinite(Number(item.point?.Value)))
        .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);

    if (points.length <= 2) return points.map(item => item.point);

    const normalizedPeriod = normalizePeriod(period);
    const spanDays = Math.max(1, Math.ceil((points.at(-1).timestamp - points[0].timestamp) / DAY_IN_MILLISECONDS));
    const bucketDays = normalizedPeriod === '3M'
        ? 2
        : normalizedPeriod === 'YTD' || normalizedPeriod === '1Y'
            ? 7
            : normalizedPeriod === 'MAX'
                ? Math.max(1, Math.ceil(spanDays / 90))
                : 1;

    if (bucketDays === 1) return points.map(item => item.point);

    const origin = points[0].timestamp;
    const buckets = new Map();
    for (const item of points) {
        const bucket = Math.floor((item.timestamp - origin) / (bucketDays * DAY_IN_MILLISECONDS));
        const current = buckets.get(bucket);
        if (!current || item.point?.HasObservation === true || current.point?.HasObservation !== true) {
            buckets.set(bucket, item);
        }
    }

    const aggregated = [...buckets.values()]
        .sort((left, right) => left.timestamp - right.timestamp)
        .map(item => item.point);
    const lastPoint = points.at(-1).point;
    if (aggregated.at(-1) !== lastPoint) aggregated.push(lastPoint);
    return aggregated;
}

export function getDashboardAssetName(category) {
    const categoryId = String(getRecordValue(category, 'Id') || '').toLowerCase();
    const configuredName = String(
        getRecordValue(category, 'SingularName') ||
        getRecordValue(category, 'ActionName') ||
        '').trim();
    if (configuredName) return configuredName;

    const label = String(getRecordValue(category, 'Label') || categoryId || 'Asset').trim();
    return pluralize.singular(label) || label;
}

function findDashboardAssetId(category, name) {
    const categoryValueId = getRecordValue(category, 'ClassificationValueId');
    const normalizedName = String(name || '').trim().toLowerCase();
    if (!normalizedName) return '';

    const matchingAsset = (store.state.assets || []).find(asset => {
        const assetName = String(getRecordValue(asset, 'DisplayName') || getRecordValue(asset, 'Name') || '').trim().toLowerCase();
        if (assetName !== normalizedName) return false;

        if (!categoryValueId) return true;
        const classifications = getRecordValue(asset, 'Classifications');
        return Array.isArray(classifications) && classifications.some(classification =>
            String(getRecordValue(classification, 'Id')) === String(categoryValueId));
    });

    return String(getRecordValue(matchingAsset, 'Id') || '');
}

async function resolveDashboardAssetId(categoryId, name) {
    if (!categoryId || !name) return '';

    const category = (store.state.CATEGORIES || []).find(candidate =>
        String(getRecordValue(candidate, 'Id') || '').toLowerCase() === String(categoryId).toLowerCase());
    const categoryValueId = getRecordValue(category, 'ClassificationValueId');
    const url = categoryValueId
        ? `${API_BASE_URL}/assets?classificationValueId=${encodeURIComponent(categoryValueId)}`
        : `${API_BASE_URL}/wealth/${encodeURIComponent(categoryId)}/names`;
    const assets = await fetchCached(url, null, { ttlMs: 30 * 60 * 1000, tags: ['catalogue'] });
    if (!Array.isArray(assets)) return '';

    const normalizedName = String(name).trim().toLowerCase();
    const matchingAsset = assets.find(asset =>
        String(getRecordValue(asset, 'DisplayName') || getRecordValue(asset, 'Name') || '').trim().toLowerCase() === normalizedName);
    return String(getRecordValue(matchingAsset, 'Id') || '');
}

function destroyDashboardCharts() {
    Object.values(charts).forEach(chart => chart?.destroy?.());
    charts = {};
    if (xrayChartInstance) {
        xrayChartInstance.destroy();
        xrayChartInstance = null;
    }
}

function getBreakdownHistory(history, name) {
    return (Array.isArray(history) ? history : [])
        .map(point => {
            const pointBreakdown = point?.Breakdown || point?.breakdown || {};
            const value = pointBreakdown[name] ?? pointBreakdown[String(name)];
            return Number.isFinite(Number(value)) ? Number(value) : 0;
        });
}

function renderSparkline(values, color, label) {
    if (!Array.isArray(values) || values.length < 2) return '';
    const width = 72;
    const height = 24;
    const padding = 2;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((value, index) => {
        const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * (width - padding * 2) + padding;
        const y = height - padding - ((value - min) / range) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="breakdown-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${safeCssColor(color, '#06b6d4')}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}

function renderXrayChart() {
    if (!window.investmentXrayData || window.investmentXrayData.length === 0) return;
    
    const ctx = document.getElementById('xray-chart');
    if (!ctx) return;

    if (xrayChartInstance) {
        xrayChartInstance.destroy();
    }

    const data = window.investmentXrayData.slice(0, 7);
    const otherVal = window.investmentXrayData.slice(7).reduce((sum, p) => sum + p.value, 0);
    
    const fullLabels = data.map(d => d.ticker);
    const values = data.map(d => d.value);
    
    if (otherVal > 0) {
        fullLabels.push('Other');
        values.push(otherVal);
    }
    
    const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#f43f5e', '#64748b'];

    xrayChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: fullLabels,
            datasets: [{
                data: values,
                backgroundColor: colors.slice(0, fullLabels.length),
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (window.isObfuscated) return ` ${context.label}: £***`;
                            return ` ${context.label}: ${formatter.format(context.raw)}`;
                        }
                    }
                }
            }
        }
    });

    const legendContainer = document.getElementById('xray-legend');
    if (legendContainer) {
        let legendHtml = '';
        fullLabels.forEach((label, i) => {
            const color = colors[i % colors.length];
            const value = values[i];
            legendHtml += `
                <div style="display: flex; align-items: center; gap: 8px; font-size: 0.75rem; color: #a1a1aa; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" title="${escapeHtml(label)}: ${formatter.format(value)}">
                    <span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background-color: ${safeCssColor(color)}; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis;">${escapeHtml(label)}</span>
                </div>
            `;
        });
        legendContainer.innerHTML = legendHtml;
    }
}

// Make accessible to inline handlers
window.forceSync = forceSync;
