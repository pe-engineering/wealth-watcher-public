export const STANDARD_PERIODS = Object.freeze(['1D', '1W', '1M', '3M', 'YTD', 'MAX']);

export function normalizePeriod(period, fallback = '1M') {
    const normalized = String(period || '').toUpperCase();
    if (STANDARD_PERIODS.includes(normalized)) return normalized;
    return normalized === '1H' ? '1D' : fallback;
}

function resolveContainer(container) {
    if (!container) return null;
    if (typeof container === 'string') return document.getElementById(container) || document.querySelector(container);
    return container;
}

function getButtons(container, target) {
    if (target?.querySelectorAll) return Array.from(target.querySelectorAll('[data-period]'));
    if (typeof document === 'undefined') return [];
    if (!document.querySelectorAll && typeof container === 'string') {
        const prefix = container.replace(/^#/, '');
        return STANDARD_PERIODS
            .map(period => {
                const button = document.getElementById?.(`${prefix === 'history-range-picker' ? 'history-range-' : ''}${period.toLowerCase()}`);
                // Keep the contract usable with lightweight DOM adapters that do not
                // implement getAttribute, while real browsers continue to read markup.
                if (button && !button.getAttribute && !button.dataset?.period) {
                    button.dataset ??= {};
                    button.dataset.period = period;
                    button['data-period'] = period;
                }
                return button;
            })
            .filter(Boolean);
    }
    if (!document.querySelectorAll) return [];
    const selector = typeof container === 'string'
        ? (container.startsWith('#') ? `${container} [data-period]` : `#${container} .period-btn`)
        : '.period-btn';
    return Array.from(document.querySelectorAll(selector));
}

function setActive(button, selected) {
    if (button.classList?.toggle) {
        button.classList.toggle('active', selected);
    } else if (selected) {
        button.classList?.add?.('active');
    } else {
        button.classList?.remove?.('active');
    }
}

export function syncPeriodPicker(container, selectedPeriod) {
    const target = resolveContainer(container);
    getButtons(container, target).forEach(button => {
        const buttonPeriod = button.getAttribute?.('data-period') || button.dataset?.period || button['data-period'];
        const selected = buttonPeriod === selectedPeriod;
        setActive(button, selected);
        button.setAttribute?.('aria-pressed', String(selected));
    });
}

/**
 * Binds the standard period button contract used by Dashboard and History.
 * The callback owns data loading; this helper owns selection and ARIA state.
 */
export function bindPeriodPicker(container, {
    selectedPeriod = '',
    onChange = null
} = {}) {
    const target = resolveContainer(container);
    const buttons = getButtons(container, target);
    const handlers = buttons.map(button => {
        const handler = event => {
            const nextPeriod = event.currentTarget?.getAttribute?.('data-period')
                || event.currentTarget?.dataset?.period
                || event.currentTarget?.['data-period']
                || button.getAttribute?.('data-period')
                || button.dataset?.period
                || button['data-period'];
            syncPeriodPicker(container, nextPeriod);
            return onChange?.(nextPeriod, event);
        };
        button.addEventListener?.('click', handler);
        return [button, handler];
    });
    if (selectedPeriod) syncPeriodPicker(container, selectedPeriod);

    return () => handlers.forEach(([button, handler]) => button.removeEventListener?.('click', handler));
}
