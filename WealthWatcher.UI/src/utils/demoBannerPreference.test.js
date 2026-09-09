import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEMO_BANNER_COLLAPSED_STORAGE_KEY,
    getDemoBannerCollapsed,
    setDemoBannerCollapsed
} from './demoBannerPreference.js';

test('demo banner preference defaults to expanded and persists independently', () => {
    const previousWindow = globalThis.window;
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
    globalThis.window = { localStorage: storage };
    delete globalThis.localStorage;

    try {
        assert.equal(getDemoBannerCollapsed(), false);
        setDemoBannerCollapsed(true);
        assert.equal(getDemoBannerCollapsed(), true);
        assert.equal(values.get(DEMO_BANNER_COLLAPSED_STORAGE_KEY), 'true');
        setDemoBannerCollapsed(false);
        assert.equal(getDemoBannerCollapsed(), false);
        assert.equal(values.get(DEMO_BANNER_COLLAPSED_STORAGE_KEY), 'false');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});
