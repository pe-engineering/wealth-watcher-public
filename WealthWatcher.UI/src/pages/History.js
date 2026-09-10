import { store } from '../store/store.js';
import { fetchFreshStrict, API_BASE_URL } from '../api/apiClient.js';
import { setPageLoading } from '../components/PageLoading.js';
import { PAGE_STATUS, setPageStatus } from '../components/PageState.js';
import { createPageRequestController } from '../components/PageRequest.js';
import { bindPeriodPicker, normalizePeriod, syncPeriodPicker } from '../components/PeriodPicker.js';
import { chartDataRows, renderAccessibleChartData } from '../components/AccessibleChartData.js';
import { normalizeTimelineEntries } from '../components/TimelineModel.js';
import { compactCurrencyFormatter, currencyFormatter, percentFormatter } from '../utils/formatters.js';
import { escapeHtml, safeCssColor } from '../utils/html.js';

let historyChartInstances = [];
let historySnapshot = null;
let historyPeriod = '1M';
let showHistoryTrend = false;
let historyControlsBound = false;
let historyPageState = PAGE_STATUS.LOADING;
const historyRequests = createPageRequestController();

const HISTORY_PERIODS = ['1D', '1W', '1M', '3M', 'YTD', 'MAX'];
export const HISTORY_TREND_STORAGE_KEY = 'wealthwatcher_history_show_trend';

export async function loadHistoryView() {
    const storedTrend = readStoredHistoryTrend();
    if (storedTrend !== null) showHistoryTrend = storedTrend;
    bindHistoryControls();
    return loadHistoryPeriod(historyPeriod);
}

function getHistoryTrendStorage() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
        if (typeof localStorage !== 'undefined') return localStorage;
    } catch {
        return null;
    }
    return null;
}

function readStoredHistoryTrend() {
    const storage = getHistoryTrendStorage();
    if (!storage) return null;
    try {
        return storage.getItem(HISTORY_TREND_STORAGE_KEY) === 'true';
    } catch {
        return null;
    }
}

export function getHistoryTrendPreference(storage = getHistoryTrendStorage()) {
    try {
        return storage?.getItem(HISTORY_TREND_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setHistoryTrendPreference(value, storage = getHistoryTrendStorage()) {
    showHistoryTrend = value === true;
    try {
        storage?.setItem(HISTORY_TREND_STORAGE_KEY, String(showHistoryTrend));
    } catch {
        // localStorage can be unavailable or restricted; the in-memory choice remains usable.
    }
    return showHistoryTrend;
}

async function loadHistoryPeriod(period) {
    period = normalizePeriod(period);
    const requestId = historyRequests.next();
    historyPageState = PAGE_STATUS.LOADING;
    historySnapshot = null;
    renderHistoryPageState();
    setPageLoading('history-view', true);
    const requestUrl = `${API_BASE_URL}/history?period=${encodeURIComponent(period)}`;
    try {
        const response = await fetchFreshStrict(requestUrl);
        const categories = Array.isArray(response?.Categories) ? response.Categories : [];
        const results = categories.map(category => ({
            cat: {
                Id: category.Id,
                Label: category.Label,
                Color: category.Color,
                DisplayOrder: category.DisplayOrder,
                ClassificationValueId: category.ClassificationValueId
            },
            data: category.Aggregate || category
        }));
        if (!historyRequests.isCurrent(requestId)) return;

        historySnapshot = buildHistorySnapshot(results);
        renderHistoryView();
    } catch {
        if (!historyRequests.isCurrent(requestId)) return;
        historySnapshot = null;
        historyPageState = PAGE_STATUS.ERROR;
        clearHistoryLiveContent();
        renderHistoryPageState();
    } finally {
        if (historyRequests.isCurrent(requestId)) {
            setPageLoading('history-view', false);
            renderHistoryPageState();
        }
    }
}

export function buildHistorySnapshot(results) {
    const globalTimeline = new Map();
    const categoryDefinitions = results.length > 0
        ? results.map(result => result.cat)
        : store.state.CATEGORIES;
    const categoryDatasets = categoryDefinitions.map(cat => ({
        id: cat.Id,
        label: cat.Label,
        borderColor: safeCssColor(cat.Color, '#06b6d4'),
        backgroundColor: hexToRgba(safeCssColor(cat.Color, '#06b6d4'), 0.16),
        dataMap: new Map(),
        fullData: [],
        lastRecordedValue: null,
        lastRecordedTime: null
    }));
    let latestSync = null;

    results.forEach(({ cat, data }) => {
        const history = normalizeTimelineEntries(data?.Data, {
            getDate: entry => entry?.Time,
            getValue: entry => entry?.Value,
            validateDate: date => Boolean(date)
        });
        const dataset = categoryDatasets.find(d => String(d.id) === String(cat.Id))
            || categoryDatasets.find(d => d.label === cat.Label);

        if (data?.LastSyncDateTime) {
            const sync = new Date(data.LastSyncDateTime);
            if (!Number.isNaN(sync.getTime()) && (!latestSync || sync > latestSync)) {
                latestSync = sync;
            }
        }

        history.forEach(h => {
            const value = h.value;
            if (dataset && (!dataset.lastRecordedTime || h.date >= dataset.lastRecordedTime)) {
                dataset.lastRecordedTime = h.date;
                dataset.lastRecordedValue = value;
            }
            if (!shouldIncludeHistoryValue(value)) {
                return;
            }

            const currentGlobal = globalTimeline.get(h.date) || 0;
            globalTimeline.set(h.date, currentGlobal + value);
            dataset?.dataMap.set(h.date, value);
        });
    });

    const dates = Array.from(globalTimeline.keys()).sort();
    const totalData = dates.map(date => globalTimeline.get(date) || 0);

    categoryDatasets.forEach(dataset => {
        dataset.fullData = dates.map(date => (
            dataset.dataMap.has(date) ? dataset.dataMap.get(date) : null
        ));
        delete dataset.dataMap;
    });

    return { dates, totalData, categories: categoryDatasets, latestSync };
}

function getVisibleHistoryData() {
    if (!historySnapshot || historySnapshot.dates.length === 0) {
        return { dates: [], totalData: [], categories: [], startIndex: 0 };
    }

    const categories = historySnapshot.categories
        .map(category => ({
            ...category,
            data: category.fullData.map(value => (
                shouldIncludeHistoryValue(value) ? Number(value) : null
            ))
        }))
        .filter(category => category.data.some(value => value !== null))
        .filter(category => store.state.generalSettings?.showZeroValuesOnHistory === true
            || category.lastRecordedValue !== 0);

    return {
        dates: historySnapshot.dates,
        totalData: historySnapshot.totalData,
        categories,
        startIndex: 0
    };
}

function shouldIncludeHistoryValue(value) {
    if (value === null || value === undefined) return false;
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
        && (numericValue !== 0 || store.state.generalSettings?.showZeroValuesOnHistory === true);
}

function renderHistoryView() {
    historyChartInstances.forEach(chart => chart.destroy());
    historyChartInstances = [];

    const visible = getVisibleHistoryData();
    updateRangeButtonState();
    syncHistoryLegend();

    if (visible.dates.length === 0) {
        historyPageState = PAGE_STATUS.EMPTY;
        updateHistorySummary(visible);
        clearHistoryLiveContent();
        renderHistoryPageState();
        return;
    }

    historyPageState = PAGE_STATUS.READY;
    updateHistorySummary(visible);
    const grid = document.getElementById('history-grid');
    if (grid) grid.innerHTML = '';
    renderNetWorthChart(visible);
    renderCategoryCharts(visible);
    renderHistoryPageState();
}

function clearHistoryLiveContent() {
    historyChartInstances.forEach(chart => chart.destroy());
    historyChartInstances = [];

    const grid = document.getElementById('history-grid');
    if (grid) grid.innerHTML = '';
    renderAccessibleChartData(document.getElementById('history-chart-data'), {
        summary: 'View chart data',
        headers: [{ key: 'date', label: 'Date' }, { key: 'value', label: 'Net worth' }],
        rows: []
    });
}

function createHistoryEmptyState(view) {
    if (!view || typeof document.createElement !== 'function') return null;

    const emptyState = document.createElement('div');
    emptyState.id = 'history-empty-state';
    emptyState.className = 'catalog-workspace presentation-empty-state history-presentation-empty-state';
    emptyState.setAttribute?.('role', 'status');
    emptyState.innerHTML = `
        <div class="presentation-empty-state-layout">
            <div class="presentation-empty-copy">
                <span class="presentation-empty-kicker">Portfolio history</span>
                <h2>Give your wealth a story.</h2>
                <p>No historical data yet. Record your first asset value and this view will reveal the shape of your net worth over time.</p>
                <p class="presentation-empty-note">Add an asset value or connect an integration in Settings to replace this preview with your live wealth journey.</p>
                <a class="action-btn" href="#settings?panel=asset-catalog&focus=catalog-add-asset-button" aria-controls="asset-catalog-pane">Start tracking history</a>
            </div>
            <div class="presentation-preview history-preview" role="img" aria-label="Illustrative example of a configured portfolio history, not your data">
                <div class="presentation-preview-header">
                    <div>
                        <span class="presentation-preview-label">Illustrative example</span>
                        <strong>Wealth journey</strong>
                    </div>
                    <span class="presentation-preview-status">1M range</span>
                </div>
                <div class="history-preview-summary">
                    <div><span>Current net worth</span><strong>£428,640</strong></div>
                    <div><span>Range change</span><strong class="history-preview-positive">+£74,280</strong></div>
                    <div><span>Peak value</span><strong>£428,640</strong></div>
                </div>
                <div class="history-preview-chart" aria-hidden="true">
                    <div class="history-preview-chart-label">Net worth over time</div>
                    <svg viewBox="0 0 560 180" preserveAspectRatio="none">
                        <defs>
                            <linearGradient id="history-preview-fill" x1="0" x2="0" y1="0" y2="1">
                                <stop offset="0%" stop-color="#67e8f9" stop-opacity="0.28"></stop>
                                <stop offset="100%" stop-color="#67e8f9" stop-opacity="0"></stop>
                            </linearGradient>
                        </defs>
                        <path class="history-preview-area" d="M0 145 C58 139, 98 124, 146 132 S225 111, 276 117 S340 90, 390 96 S468 58, 560 26 L560 180 L0 180 Z"></path>
                        <polyline class="history-preview-line" points="0,145 55,139 98,125 146,132 206,119 276,117 330,92 390,96 450,72 505,50 560,26"></polyline>
                        <line class="history-preview-trend" x1="0" y1="148" x2="560" y2="38"></line>
                    </svg>
                    <div class="history-preview-axis"><span>1 month ago</span><span>Today</span></div>
                </div>
                <div class="history-preview-legend"><span><i class="preview-dot preview-dot-history"></i>Net worth</span><span><i class="preview-dot preview-dot-history-trend"></i>Start to latest trend</span></div>
            </div>
        </div>`;
    view.appendChild?.(emptyState);
    return emptyState;
}

function createHistoryErrorState(view) {
    if (!view || typeof document.createElement !== 'function') return null;

    const errorState = document.createElement('div');
    errorState.id = 'history-error-state';
    errorState.className = 'page-state-error history-page-error';
    errorState.setAttribute?.('role', 'alert');

    const title = document.createElement('strong');
    title.textContent = 'History is unavailable right now';
    const message = document.createElement('span');
    message.textContent = 'We could not load your historical data. Try again in a moment.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'action-btn page-state-retry';
    retry.textContent = 'Try again';
    retry.addEventListener?.('click', () => void loadHistoryPeriod(historyPeriod));

    errorState.appendChild?.(title);
    errorState.appendChild?.(message);
    errorState.appendChild?.(retry);
    view.appendChild?.(errorState);
    return errorState;
}

function renderHistoryPageState() {
    const view = document.getElementById('history-view');
    if (!view) return;

    const header = view.querySelector?.(':scope > header') || view.querySelector?.('header');
    const content = document.getElementById('history-content');
    let emptyState = document.getElementById('history-empty-state');
    if (!emptyState) emptyState = createHistoryEmptyState(view);
    let errorState = document.getElementById('history-error-state');
    if (!errorState) errorState = createHistoryErrorState(view);

    setPageStatus(view, historyPageState);
    const hasLiveData = historyPageState === PAGE_STATUS.READY;
    if (header) header.hidden = !hasLiveData;
    if (content) content.hidden = !hasLiveData;
    if (emptyState) emptyState.hidden = historyPageState !== PAGE_STATUS.EMPTY;
    if (errorState) errorState.hidden = historyPageState !== PAGE_STATUS.ERROR;
}

function renderNetWorthChart(visible) {
    const canvas = document.getElementById('netWorthChart');
    if (!canvas) return;

    const importantIndices = getImportantPointIndices(visible.totalData);
    const trendData = getTrendData(visible.totalData);
    const netWorthChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: visible.dates,
            datasets: [
                {
                    label: 'Total net worth',
                    data: visible.totalData,
                    borderColor: '#dbeafe',
                    backgroundColor: 'rgba(103, 232, 249, 0.10)',
                    fill: true,
                    tension: 0.18,
                    borderWidth: 2.5,
                    pointRadius: context => importantIndices.has(context.dataIndex) ? 3.5 : 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#0f172a',
                    pointBorderColor: '#e0f2fe',
                    pointBorderWidth: 2
                },
                {
                    label: 'Start to latest trend',
                    data: trendData,
                    borderColor: '#22d3ee',
                    borderWidth: 1.5,
                    borderDash: [6, 6],
                    tension: 0,
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    hidden: !showHistoryTrend
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 450, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#111c31',
                    titleColor: '#94a3b8',
                    bodyColor: '#f8fafc',
                    borderColor: 'rgba(148, 163, 184, 0.18)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    callbacks: {
                        title: contexts => formatFullDate(visible.dates[contexts[0]?.dataIndex]),
                        label: context => {
                            if (window.isObfuscated) return context.datasetIndex === 1 ? 'Trend: £***' : 'Net worth: £***';
                            const label = context.datasetIndex === 1 ? 'Trend' : 'Net worth';
                            return `${label}: ${currencyFormatter.format(context.parsed.y)}`;
                        },
                        afterLabel: context => {
                            if (context.datasetIndex !== 0 || window.isObfuscated) return '';
                            const index = context.dataIndex;
                            if (index === 0) return 'Start of selected range';
                            const change = visible.totalData[index] - visible.totalData[index - 1];
                            return `Daily change: ${formatSignedMoney(change)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(148, 163, 184, 0.07)', drawBorder: false },
                    border: { display: false },
                    ticks: {
                        color: '#8190a8',
                        maxTicksLimit: 9,
                        maxRotation: 0,
                        padding: 8,
                        callback: historyTickCallback
                    }
                },
                y: {
                    grace: '8%',
                    grid: { color: 'rgba(148, 163, 184, 0.08)', drawBorder: false },
                    border: { display: false },
                    ticks: {
                        color: '#8190a8',
                        maxTicksLimit: 6,
                        padding: 8,
                        callback: value => window.isObfuscated ? '£***' : compactCurrencyFormatter.format(value)
                    }
                }
            }
        }
    });
    historyChartInstances.push(netWorthChart);
    renderAccessibleChartData(document.getElementById('history-chart-data'), {
        summary: 'View net worth data',
        caption: 'The same values shown in the net worth chart for the selected range.',
        headers: [{ key: 'date', label: 'Date' }, { key: 'value', label: 'Net worth' }],
        rows: chartDataRows(visible.dates, visible.totalData, 'date', 'value'),
        formatCell: (row, key) => key === 'date'
            ? formatFullDate(row.date)
            : (window.isObfuscated ? '£***' : currencyFormatter.format(row.value))
    });
}

function renderCategoryCharts(visible) {
    const grid = document.getElementById('history-grid');
    if (!grid) return;

    visible.categories.forEach((dataset, index) => {
        const latest = getLastNumber(dataset.data);
        const first = getFirstNumber(dataset.data);
        const change = latest !== null && first !== null ? latest - first : null;
        const displayChange = change !== null && shouldIncludeHistoryValue(change) ? change : null;
        const total = visible.totalData[visible.totalData.length - 1] || 0;
        const share = latest !== null && total > 0 ? latest / total : null;
        const accent = safeCssColor(dataset.borderColor, '#06b6d4');

        const card = document.createElement('div');
        card.className = 'card glass-panel history-chart-card';
        card.innerHTML = `
            <div class="history-card-header" style="--history-accent: ${accent}">
                <div class="history-card-title">
                    <span class="history-card-dot" aria-hidden="true"></span>
                    <h4>${escapeHtml(dataset.label)}</h4>
                </div>
                <span class="history-card-share obfuscate-val">${formatShare(share)}</span>
            </div>
            <div class="history-card-value obfuscate-val">${formatMoney(latest)}</div>
            <div class="history-card-meta ${displayChange !== null && displayChange < 0 ? 'negative' : ''}">
                <span><span class="obfuscate-val">${formatSignedMoney(displayChange)}</span> over range</span>
                <span class="obfuscate-val">${formatPercentChange(displayChange, first)}</span>
            </div>
            <div class="history-canvas-container">
                <canvas id="historyChart-${index}" role="img" aria-label="${escapeHtml(dataset.label)} value over the selected range"></canvas>
            </div>
            <details class="chart-data-alternative" data-history-chart-data>
                <summary>View ${escapeHtml(dataset.label)} data</summary>
            </details>
        `;
        grid.appendChild(card);

        const canvas = document.getElementById(`historyChart-${index}`);
        if (!canvas) return;

        const catChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: visible.dates,
                datasets: [{
                    label: dataset.label,
                    data: dataset.data,
                    borderColor: accent,
                    backgroundColor: dataset.backgroundColor,
                    fill: true,
                    tension: 0.18,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 350, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#111c31',
                        titleColor: '#94a3b8',
                        bodyColor: accent,
                        borderColor: 'rgba(148, 163, 184, 0.18)',
                        borderWidth: 1,
                        padding: 9,
                        displayColors: false,
                        callbacks: {
                            title: contexts => formatFullDate(visible.dates[contexts[0]?.dataIndex]),
                            label: context => window.isObfuscated ? '£***' : currencyFormatter.format(context.parsed.y)
                        }
                    }
                },
                scales: {
                    x: { display: false },
                    y: {
                        grace: '10%',
                        grid: { color: 'rgba(148, 163, 184, 0.07)', drawBorder: false },
                        border: { display: false },
                        ticks: {
                            color: '#8190a8',
                            maxTicksLimit: 4,
                            padding: 6,
                            callback: value => window.isObfuscated ? '£***' : compactCurrencyFormatter.format(value)
                        }
                    }
                }
            }
        });
        historyChartInstances.push(catChart);
        renderAccessibleChartData(card.querySelector?.('[data-history-chart-data]'), {
            summary: `View ${dataset.label} data`,
            headers: [{ key: 'date', label: 'Date' }, { key: 'value', label: dataset.label }],
            rows: chartDataRows(visible.dates, dataset.data, 'date', 'value'),
            formatCell: (row, key) => key === 'date'
                ? formatFullDate(row.date)
                : (window.isObfuscated ? '£***' : currencyFormatter.format(row.value))
        });
    });
}

function updateHistorySummary(visible) {
    const current = getLastNumber(visible.totalData);
    const first = getFirstNumber(visible.totalData);
    const change = current !== null && first !== null ? current - first : null;
    const peak = visible.totalData.length ? Math.max(...visible.totalData) : null;

    setText('history-current-value', formatMoney(current));
    setText('history-period-change', `${formatSignedMoney(change)} (${formatPercentChange(change, first)})`);
    setText('history-peak-value', formatMoney(peak));
    setText('history-last-updated', formatLastUpdated());

    const rangeLabel = visible.dates.length > 0
        ? `${formatFullDate(visible.dates[0])} – ${formatFullDate(visible.dates[visible.dates.length - 1])}`
        : 'No data available';
    setText('history-range-caption', rangeLabel);

    const changeElement = document.getElementById('history-period-change');
    if (changeElement?.classList?.toggle) {
        changeElement.classList.toggle('negative', change !== null && change < 0);
    }
}

function formatLastUpdated() {
    if (historySnapshot?.latestSync) {
        return `Updated ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(historySnapshot.latestSync)}`;
    }
    const lastDate = historySnapshot?.dates?.at(-1);
    return lastDate ? `Updated ${formatFullDate(lastDate)}` : 'Awaiting first sync';
}

function bindHistoryControls() {
    if (historyControlsBound) return;

    bindPeriodPicker('history-range-picker', {
        selectedPeriod: historyPeriod,
        onChange: async period => {
            if (!HISTORY_PERIODS.includes(period)) return;
            historyPeriod = period;
            updateRangeButtonState();
            await loadHistoryPeriod(period);
        }
    });

    const trendButton = document.getElementById('history-trend-toggle');
    if (trendButton && typeof trendButton.addEventListener === 'function') {
        trendButton.addEventListener('click', () => {
            showHistoryTrend = !showHistoryTrend;
            setHistoryTrendPreference(showHistoryTrend);
            renderHistoryView();
        });
    }

    historyControlsBound = true;
}

function updateRangeButtonState() {
    syncPeriodPicker('history-range-picker', historyPeriod);

    const trendButton = document.getElementById('history-trend-toggle');
    if (trendButton) {
        trendButton.classList?.toggle?.('active', showHistoryTrend);
        trendButton.setAttribute?.('aria-pressed', String(showHistoryTrend));
        if ('textContent' in trendButton) trendButton.textContent = showHistoryTrend ? 'Hide trend' : 'Show trend';
    }
}

function syncHistoryLegend() {
    const trendKey = document.querySelector?.('[data-history-trend-key]');
    if (!trendKey) return;
    trendKey.hidden = !showHistoryTrend;
    trendKey.setAttribute?.('aria-hidden', String(!showHistoryTrend));
}

function getImportantPointIndices(data) {
    const indices = new Set();
    if (data.length === 0) return indices;

    indices.add(0);
    indices.add(data.length - 1);

    let minIndex = 0;
    let maxIndex = 0;
    let largestMoveIndex = null;
    let largestMove = -1;

    data.forEach((value, index) => {
        if (value < data[minIndex]) minIndex = index;
        if (value > data[maxIndex]) maxIndex = index;
        if (index > 0) {
            const move = Math.abs(value - data[index - 1]);
            if (move > largestMove) {
                largestMove = move;
                largestMoveIndex = index;
            }
        }
    });

    indices.add(minIndex);
    indices.add(maxIndex);
    if (largestMoveIndex !== null) indices.add(largestMoveIndex);
    return indices;
}

function getTrendData(data) {
    if (data.length < 2) return data.slice();
    const start = data[0];
    const end = data[data.length - 1];
    return data.map((_, index) => start + ((end - start) * index) / (data.length - 1));
}

function monthTickCallback(value, index, ticks) {
    const currentLabel = this.getLabelForValue(value);
    const previousTick = ticks[index - 1];
    const previousLabel = previousTick ? this.getLabelForValue(previousTick.value) : null;
    const currentDate = parseHistoryDate(currentLabel);
    const previousDate = previousLabel ? parseHistoryDate(previousLabel) : null;

    if (previousDate
        && currentDate.getMonth() === previousDate.getMonth()
        && currentDate.getFullYear() === previousDate.getFullYear()) {
        return '';
    }
    return formatAxisDate(currentLabel);
}

function historyTickCallback(value, index, ticks) {
    const dateValue = this.getLabelForValue(value);
    if (historyPeriod === '1D') {
        return formatTimeAxisDate(dateValue);
    }
    if (historyPeriod === '1W' || historyPeriod === '1M' || historyPeriod === '3M') {
        return formatDayAxisDate(dateValue);
    }
    return monthTickCallback.call(this, value, index, ticks);
}

function getFirstNumber(values) {
    return values.find(value => typeof value === 'number' && Number.isFinite(value)) ?? null;
}

function getLastNumber(values) {
    for (let index = values.length - 1; index >= 0; index--) {
        if (typeof values[index] === 'number' && Number.isFinite(values[index])) return values[index];
    }
    return null;
}

function formatMoney(value) {
    return value === null || value === undefined ? '—' : currencyFormatter.format(value);
}

function formatSignedMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${currencyFormatter.format(Math.abs(value))}`;
}

function formatPercentChange(change, base) {
    if (change === null || base === null || !Number.isFinite(change) || !Number.isFinite(base) || base === 0) return '—';
    return percentFormatter.format(change / base);
}

function formatShare(share) {
    if (share === null || !Number.isFinite(share)) return '—';
    return `${(share * 100).toFixed(1)}%`;
}

function formatAxisDate(dateValue) {
    if (!dateValue) return '';
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(parseHistoryDate(dateValue));
}

function formatDayAxisDate(dateValue) {
    if (!dateValue) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parseHistoryDate(dateValue));
}

function formatTimeAxisDate(dateValue) {
    if (!dateValue) return '';
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(parseHistoryDate(dateValue));
}

function formatFullDate(dateValue) {
    if (!dateValue) return '';
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    return new Intl.DateTimeFormat('en-GB', options).format(parseHistoryDate(dateValue));
}

function parseHistoryDate(dateValue) {
    if (dateValue instanceof Date) return dateValue;
    if (!dateValue) return new Date(NaN);
    return new Date(dateValue.includes('T') ? dateValue : `${dateValue}T00:00:00`);
}

function hexToRgba(color, alpha) {
    if (!color || !color.startsWith('#')) return `rgba(6, 182, 212, ${alpha})`;
    const hex = color.length === 4
        ? color.slice(1).split('').map(part => part + part).join('')
        : color.slice(1);
    const value = Number.parseInt(hex, 16);
    if (Number.isNaN(value)) return `rgba(6, 182, 212, ${alpha})`;
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}
