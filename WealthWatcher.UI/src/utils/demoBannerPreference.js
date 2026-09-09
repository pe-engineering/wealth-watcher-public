export const DEMO_BANNER_COLLAPSED_STORAGE_KEY = 'wealthwatcher_demo_banner_collapsed';

function demoStorage() {
    try {
        return globalThis.window?.localStorage || globalThis.localStorage || null;
    } catch {
        return null;
    }
}

export function getDemoBannerCollapsed() {
    try {
        return demoStorage()?.getItem(DEMO_BANNER_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setDemoBannerCollapsed(collapsed) {
    try {
        demoStorage()?.setItem(DEMO_BANNER_COLLAPSED_STORAGE_KEY, String(collapsed === true));
    } catch {
        // Browser storage is an enhancement; the banner remains usable in memory.
    }
}
