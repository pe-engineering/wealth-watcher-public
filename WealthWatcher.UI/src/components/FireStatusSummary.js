import { store } from '../store/store.js';
import { formatter } from '../utils/formatters.js';
import { escapeHtml } from '../utils/html.js';
import { calculateMilestoneProgress } from './Milestones.js';
import { isFeatureEnabled } from '../utils/featureFlags.js';
import { getBudgetGroupTotal, getBudgetGroups, isIncomeBudgetGroup } from '../pages/budgetConfig.js';

export const FIRE_STATUS_CARD_ID = 'fire-status-dashboard-card';
export const BUDGET_UNALLOCATED_PROMPT_THRESHOLD = 0.05;

const BUDGET_CADENCE_MONTHS = Object.freeze({
    monthly: 1,
    month: 1,
    '1m': 1,
    quarterly: 3,
    quarter: 3,
    '3m': 3,
    annually: 12,
    annual: 12,
    yearly: 12,
    year: 12,
    '12m': 12
});

function getMonthlyAmount(item) {
    const amount = Number.parseFloat(String(item?.amount ?? '').replace(/,/g, ''));
    if (!Number.isFinite(amount)) return 0;
    const cadence = String(item?.cadence || 'monthly').trim().toLowerCase();
    return amount / (BUDGET_CADENCE_MONTHS[cadence] || 1);
}

function getMonthlyBudgetAllocation(settings = store.state.budgetSettings || {}) {
    const groups = getBudgetGroups(settings);
    const totalFor = group => getBudgetGroupTotal(group, getMonthlyAmount);
    const income = groups.find(isIncomeBudgetGroup);
    const incomeAmount = income ? totalFor(income) : 0;
    const allocated = groups
        .filter(group => !isIncomeBudgetGroup(group))
        .reduce((total, group) => total + totalFor(group), 0);
    return {
        income: incomeAmount,
        allocated,
        unallocated: incomeAmount - allocated
    };
}

function getMonthlyBudgetUnallocated(settings = store.state.budgetSettings || {}) {
    return getMonthlyBudgetAllocation(settings).unallocated;
}

export function shouldPromptForUnallocatedBudget({ income, unallocated } = {}) {
    const monthlyIncome = Number(income);
    const monthlyUnallocated = Number(unallocated);
    return Number.isFinite(monthlyIncome)
        && monthlyIncome > 0
        && Number.isFinite(monthlyUnallocated)
        && monthlyUnallocated >= monthlyIncome * BUDGET_UNALLOCATED_PROMPT_THRESHOLD;
}

function formatMoney(value) {
    return formatter.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(number % 1 === 0 ? 0 : 1)}%` : '—';
}

export function formatProjectionDate(value) {
    const date = String(value ?? '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) return null;
    const parsed = new Date(`${date}-01T00:00:00`);
    if (Number.isNaN(parsed.valueOf())) return null;
    return parsed.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function getProjectionDescription(projection = {}) {
    switch (projection.status) {
        case 'projected':
            return 'Based on current forecast assumptions.';
        case 'achieved':
            return 'Current FIRE assets meet the configured target.';
        case 'unreachable':
            return 'Review return, contribution, and target assumptions.';
        case 'unavailable':
        case 'empty':
            return 'Your FIRE figures remain available while the projection is unavailable.';
        case 'pending':
            return 'The Dashboard is checking the existing forecast.';
        default:
            return 'Open the FIRE Tracker to review the assumptions.';
    }
}

function getProjectionLabel(projection = {}) {
    if (projection.status === 'projected') {
        return formatProjectionDate(projection.date) || 'Projection unavailable';
    }
    if (projection.status === 'achieved') return 'Target reached';
    if (projection.status === 'unreachable') return 'No projected date';
    if (projection.status === 'pending') return 'Calculating…';
    return 'Projection unavailable';
}

export function getFireStatusAction({ fireSummary, projection = {} } = {}) {
    if (!fireSummary?.configured || !fireSummary?.hasUsableSelectedAssetData) {
        return {
            label: 'Configure FIRE settings',
            href: '#settings?panel=fire-settings&focus=fire-tracker-settings'
        };
    }

    if (!isFeatureEnabled('forecast')) {
        return {
            label: 'Enable Forecast',
            href: '#settings?panel=fire-settings&focus=fire-forecast-settings'
        };
    }

    if (['unavailable', 'empty', 'unreachable'].includes(projection.status)) {
        return { label: 'Review Forecast assumptions', href: '#forecast' };
    }

    if (fireSummary.targetReached) {
        return { label: 'Review FIRE assumptions', href: '#fire' };
    }

    const budgetAllocation = getMonthlyBudgetAllocation();
    const unallocated = budgetAllocation.unallocated;
    if (isFeatureEnabled('budget') && fireSummary.gap > 0 && shouldPromptForUnallocatedBudget(budgetAllocation)) {
        return {
            label: `Review ${formatMoney(unallocated)} unallocated in Budget`,
            href: '#budget'
        };
    }

    return { label: 'Review FIRE plan', href: '#fire' };
}

export function buildFireStatusViewModel({
    holisticNetWorth = 0,
    fireSummary = {},
    projection = { status: 'pending' }
} = {}) {
    const milestone = isFeatureEnabled('milestones')
        ? calculateMilestoneProgress(holisticNetWorth, store.state.milestoneSettings?.targets)
        : null;

    return {
        holisticNetWorth: Number.isFinite(Number(holisticNetWorth)) ? Number(holisticNetWorth) : 0,
        fireSummary,
        projection,
        action: getFireStatusAction({ fireSummary, projection }),
        milestone
    };
}

function renderSetupCard(card, model) {
    const action = model.action;
    const message = model.fireSummary.state === 'empty'
        ? 'Add portfolio data and choose the assets to include in FIRE calculations.'
        : 'Choose a valid target and at least one tracked FIRE asset to see your progress.';
    card.innerHTML = `
        <div class="fire-status-card-header">
            <div>
                <span class="fire-status-card-kicker">FIRE status</span>
                <h4>Set up your FIRE snapshot</h4>
                <p class="fire-status-card-scope">${escapeHtml(message)} Holistic Net Worth remains separate and includes all tracked categories.</p>
            </div>
            <div class="fire-status-card-actions">
                <button class="fire-status-collapse-toggle" type="button" aria-expanded="true" aria-controls="fire-status-card-details">Hide details</button>
                <a class="action-btn fire-status-card-link" href="${action.href}" aria-controls="fire-settings-pane">${escapeHtml(action.label)}</a>
            </div>
        </div>
        <div id="fire-status-card-details" class="fire-status-card-details">
            ${renderMilestoneContext(model.milestone)}
        </div>`;
}

function renderMilestoneContext(milestone) {
    if (!milestone) {
        return `<div class="fire-status-milestone fire-status-milestone-disabled">
            <div class="fire-status-milestone-copy"><span class="fire-status-milestone-label">Holistic milestones</span><strong>Not enabled</strong></div>
            <a href="#settings?panel=milestones&focus=milestone-new-target">Manage milestones</a>
        </div>`;
    }
    if (milestone.state === 'unconfigured') {
        return `<div class="fire-status-milestone fire-status-milestone-unconfigured">
            <div class="fire-status-milestone-copy"><span class="fire-status-milestone-label">Holistic milestones</span><strong>No targets configured</strong></div>
            <a href="#settings?panel=milestones&focus=milestone-new-target">Set a milestone</a>
        </div>`;
    }
    if (milestone.state === 'unavailable') return '';
    if (milestone.state === 'complete') {
        return `<div class="fire-status-milestone">
            <div class="fire-status-milestone-copy"><span class="fire-status-milestone-label">Holistic milestones</span><strong>Complete</strong></div>
            <div class="fire-status-milestone-progress" role="progressbar" aria-label="Holistic milestone progress, complete" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span style="width: 100%"></span></div>
            <a href="#settings?panel=milestones&focus=milestone-new-target">Manage milestones</a>
        </div>`;
    }
    const progress = Math.max(0, Math.min(100, Number(milestone.progress) || 0));
    return `<div class="fire-status-milestone">
        <div class="fire-status-milestone-copy">
            <span class="fire-status-milestone-label">Next holistic milestone</span>
            <strong class="fire-status-milestone-target obfuscate-val">${escapeHtml(formatMoney(milestone.nextTarget))}</strong>
            <span class="fire-status-milestone-remaining obfuscate-val">${escapeHtml(formatMoney(milestone.remaining))} to go</span>
        </div>
        <div class="fire-status-milestone-progress" role="progressbar" aria-label="Holistic milestone progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width: ${progress}%"></span></div>
        <a href="#settings?panel=milestones&focus=milestone-new-target">Manage milestones</a>
    </div>`;
}

function renderReadyCard(card, model) {
    const { fireSummary, projection, action } = model;
    const percentage = Math.max(0, Math.min(100, Number(fireSummary.completion) || 0));
    const projectionLabel = getProjectionLabel(projection);
    const projectionDescription = getProjectionDescription(projection);
    const trackerHref = isFeatureEnabled('tracker') ? '#fire' : '#settings?panel=fire-settings&focus=fire-tracker-settings';
    const trackerLabel = isFeatureEnabled('tracker') ? 'Open FIRE Tracker' : 'Open FIRE settings';

    card.innerHTML = `
        <div class="fire-status-card-header">
            <div>
                <span class="fire-status-card-kicker">FIRE status</span>
                <h4>Financial independence snapshot</h4>
                <p class="fire-status-card-scope">Uses selected FIRE assets. Holistic Net Worth is <span class="obfuscate-val">${escapeHtml(formatMoney(model.holisticNetWorth))}</span> and includes all tracked categories.</p>
            </div>
            <div class="fire-status-card-actions">
                <button class="fire-status-collapse-toggle" type="button" aria-expanded="true" aria-controls="fire-status-card-details">Hide details</button>
                <a class="action-btn fire-status-card-link" href="${trackerHref}">${trackerLabel}</a>
            </div>
        </div>
        <div id="fire-status-card-details" class="fire-status-card-details">
            <div class="fire-status-card-metrics">
                <div><span>FIRE assets</span><strong class="obfuscate-val">${escapeHtml(formatMoney(fireSummary.investableAssets))}</strong></div>
                <div><span>FIRE target</span><strong class="obfuscate-val">${escapeHtml(formatMoney(fireSummary.target))}</strong></div>
                <div><span>Remaining</span><strong class="obfuscate-val">${escapeHtml(formatMoney(fireSummary.gap))}</strong></div>
                <div><span>Progress</span><strong class="obfuscate-val">${escapeHtml(formatPercent(percentage))}</strong></div>
            </div>
            <div class="fire-status-progress-track" role="progressbar" aria-label="Progress toward the FIRE target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}">
                <span class="fire-status-progress-fill" style="width: ${percentage}%"></span>
            </div>
            <div class="fire-status-card-lower">
                <div class="fire-status-projection">
                    <span>Projected FIRE date</span>
                    <strong class="obfuscate-val">${escapeHtml(projectionLabel)}</strong>
                    <small>${escapeHtml(projectionDescription)}</small>
                </div>
                <div class="fire-status-next-action">
                    <span>Next action</span>
                    <a id="fire-status-next-action-link" href="${action.href}">${escapeHtml(action.label)}</a>
                </div>
            </div>
            ${renderMilestoneContext(model.milestone)}
        </div>
        `;
}

function initialiseCollapsibleCard(card) {
    if (typeof card.querySelector !== 'function') return;
    const toggle = card.querySelector('.fire-status-collapse-toggle');
    const details = card.querySelector('.fire-status-card-details');
    if (!toggle || !details) return;

    const hasPreference = card.dataset?.fireStatusCollapsed !== undefined;
    const defaultsCollapsed = typeof globalThis.matchMedia === 'function'
        && globalThis.matchMedia('(max-width: 768px)').matches;
    let collapsed = hasPreference
        ? card.dataset.fireStatusCollapsed === 'true'
        : defaultsCollapsed;

    const applyState = () => {
        details.hidden = collapsed;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = collapsed ? 'Show details' : 'Hide details';
        if (card.dataset) card.dataset.fireStatusCollapsed = String(collapsed);
    };

    toggle.addEventListener('click', () => {
        collapsed = !collapsed;
        applyState();
    });
    applyState();
}

export function renderFireStatusSummary(model, card = null) {
    const target = card || (typeof document !== 'undefined'
        ? document.getElementById(FIRE_STATUS_CARD_ID)
        : null);
    if (!target) return;

    if (!isFeatureEnabled('fire') || !isFeatureEnabled('tracker')) {
        clearFireStatusSummary(target);
        return;
    }

    target.hidden = false;
    if (target.dataset) target.dataset.fireStatusState = model?.fireSummary?.state || 'setup';
    if (!model?.fireSummary || model.fireSummary.state !== 'ready') renderSetupCard(target, model);
    else renderReadyCard(target, model);
    initialiseCollapsibleCard(target);
}

export function renderPendingFireStatusSummary({ holisticNetWorth, fireSummary } = {}, card = null) {
    renderFireStatusSummary(buildFireStatusViewModel({
        holisticNetWorth,
        fireSummary,
        projection: { status: 'pending' }
    }), card);
}

export function clearFireStatusSummary(card = null) {
    const target = card || (typeof document !== 'undefined'
        ? document.getElementById(FIRE_STATUS_CARD_ID)
        : null);
    if (!target) return;
    target.hidden = true;
    target.innerHTML = '';
    if (target.dataset) delete target.dataset.fireStatusState;
}
