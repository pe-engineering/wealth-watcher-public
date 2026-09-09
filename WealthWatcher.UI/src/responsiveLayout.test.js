import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const [indexMarkup, stylesheet] = await Promise.all([
    readFile(path.join(sourceDirectory, '..', 'index.html'), 'utf8'),
    readFile(path.join(sourceDirectory, '..', 'style.css'), 'utf8')
]);

test('responsive shell and navigation contracts are present', () => {
    assert.match(stylesheet, /html\s*\{[\s\S]*overflow-x:\s*clip/);
    assert.match(stylesheet, /\.asset-group-section:not\(\[open\]\)\s*>\s*\.grid-container/);
    assert.match(stylesheet, /#calendar-view\s+\.calendar-grid-content\s*\{[\s\S]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(stylesheet, /\.presentation-empty-state-layout\s*\{[\s\S]*overflow:\s*hidden/);
    assert.match(stylesheet, /\.page-state-error\s*\{[\s\S]*background/);
    assert.match(stylesheet, /\.page-state-retry\s*\{/);
    assert.match(stylesheet, /\[data-page-state="loading"\][\s\S]*\.page-state-error/);

    for (const label of ['Dashboard', 'History', 'Calendar', 'Forecast', 'Tracker', 'Budget', 'Settings']) {
        assert.match(indexMarkup, new RegExp(`<a[^>]+aria-label="${label}"`));
    }

    assert.match(indexMarkup, /id="entry-modal"[\s\S]*?role="dialog"\s+aria-modal="true"/);
    assert.match(indexMarkup, /id="entry-modal"[^>]*data-form-flyout/);
    assert.match(indexMarkup, /id="audit-modal"[\s\S]*?role="dialog"\s+aria-modal="true"/);
});

test('public demo banner is fixed above the page and preserves its layout space', () => {
    const bannerRule = stylesheet.match(/\.demo-mode-banner\s*\{[\s\S]*?\}/)?.[0];
    const topNavRule = stylesheet.match(/(?:^|\r?\n)\.top-nav\s*\{[\s\S]*?\}/)?.[0];

    assert.match(stylesheet, /\.demo-mode-banner\s*\{[\s\S]*position:\s*fixed[\s\S]*top:\s*0[\s\S]*left:\s*0[\s\S]*right:\s*0/);
    assert.ok(bannerRule);
    assert.match(bannerRule, /background:\s*linear-gradient\(90deg,\s*#[0-9a-f]{6},\s*#[0-9a-f]{6}\)/i);
    assert.match(bannerRule, /border-bottom:\s*1px solid/);
    assert.match(bannerRule, /box-shadow:\s*0 4px 18px/);
    assert.doesNotMatch(bannerRule, /background:\s*(?:transparent|rgba)/);
    assert.match(stylesheet, /html:not\(\[data-demo-mode="true"\]\)\s+\.demo-mode-banner\s*\{\s*display:\s*none;\s*\}/);
    assert.match(stylesheet, /body\.demo-mode\s*\{[\s\S]*padding-top:\s*calc\(var\(--demo-banner-height[\s\S]*var\(--demo-app-bar-height/);
    assert.match(stylesheet, /\.demo-mode \.top-nav\s*\{[\s\S]*position:\s*fixed[\s\S]*top:\s*var\(--demo-banner-height[\s\S]*z-index:\s*100/);
    assert.ok(topNavRule);
    assert.match(topNavRule, /background:\s*#0f172a/);
    assert.match(topNavRule, /backdrop-filter:\s*none/);
    assert.match(topNavRule, /-webkit-backdrop-filter:\s*none/);
    assert.doesNotMatch(topNavRule, /background:\s*(?:transparent|rgba)/);
    assert.match(stylesheet, /\.demo-mode-banner\s*\{[\s\S]*z-index:\s*110/);
    assert.match(indexMarkup, /<html\s+lang="en"\s+data-demo-mode="false">/);
    assert.match(indexMarkup, /<aside id="demo-mode-banner" class="demo-mode-banner" data-demo-banner\s+role="status"/);
    assert.match(indexMarkup, /class="action-btn demo-main-site-link"\s+href="https:\/\/wealthwatcher\.co\.uk\/"/);
    assert.match(indexMarkup, /id="demo-mode-banner-content"/);
    assert.match(indexMarkup, /id="demo-banner-toggle"[^>]+aria-expanded="true"[^>]+aria-controls="demo-mode-banner-content"/);
    assert.match(stylesheet, /\.demo-mode-banner\[data-collapsed="true"\]/);
});

test('feature-gated Milestones card stays under its renderer visibility contract', () => {
    const milestoneCard = indexMarkup.match(/<section id="milestones-dashboard-card"[^>]*>/)?.[0];

    assert.equal(milestoneCard, undefined, 'the standalone dashboard milestones card is replaced by Fire Status');
    assert.match(indexMarkup, /<section id="fire-status-dashboard-card"[^>]*\shidden(?:\s|>)/);
});

test('high-data pages have explicit mobile containment contracts', () => {
    assert.match(stylesheet, /#forecast-view\s+\.forecast-control-actions\s*\{[\s\S]*flex:\s*0 1 auto/);
    assert.match(stylesheet, /#fire-view\s+\.fire-dashboard\s*>\s*\.grid-container\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(stylesheet, /@media\s*\(max-width:\s*640px\)[\s\S]*\.budget-flow-visual\s*\{[\s\S]*min-height:\s*0/);
    assert.match(stylesheet, /@media\s*\(max-width:\s*640px\)[\s\S]*\.budget-flow-mobile-view\s*\{\s*display:\s*block/);
    assert.match(stylesheet, /\.budget-editor-grid\s*\{[\s\S]*align-items:\s*start/);
    assert.match(stylesheet, /\.budget-editor-column\s*\{[\s\S]*display:\s*grid[\s\S]*gap:\s*1rem/);
    assert.match(stylesheet, /\.budget-category-editor\s*\{[\s\S]*align-self:\s*start[\s\S]*min-height:\s*0/);
    assert.doesNotMatch(stylesheet, /#budget-view\s+#budget-overview-content\s*>\s*\.card\s*>\s*div\s*\{[\s\S]*height:\s*(?:300|360)px/);
    assert.match(stylesheet, /@media\s*\(min-width:\s*769px\)[\s\S]*\.property-table-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(90px,\s*1\.25fr\)/);
});

test('Budget configuration uses always-reachable group editing and a responsive flow', () => {
    assert.match(indexMarkup, /id="budget-flow-renderer"[^>]*class="[^"]*budget-v2-flow-renderer/);
    assert.doesNotMatch(indexMarkup, /id="budgetChart"/, 'the v2 page should not mount the retired doughnut chart');
    assert.match(indexMarkup, /id="budget-groups-editor"[^>]*class="[^"]*budget-groups-editor/);
    assert.match(indexMarkup, /id="budget-migration-note"/);
    assert.match(indexMarkup, /id="budget-group-editor"[^>]*data-form-flyout/);
    assert.match(indexMarkup, /id="budget-group-editor-form"[^>]*data-budget-group-editor-form/);
    assert.match(indexMarkup, /id="budget-line-editor"[^>]*data-form-flyout/);
    assert.match(indexMarkup, /id="budget-line-editor-form"[^>]*data-budget-line-editor-form/);
    assert.doesNotMatch(indexMarkup, /budget-summary-grid|budget-summary-card/);
    assert.doesNotMatch(indexMarkup, /budget-setting-enabled-toggle|budget-disabled-description/);
    assert.doesNotMatch(indexMarkup, /budget-edit-plan-button|Done editing|Unlock editing/);
    assert.match(stylesheet, /\.budget-groups-editor\s*\{[\s\S]*display:\s*grid/);
    assert.match(stylesheet, /\.budget-group-header\s*\{[\s\S]*cursor:\s*pointer/);
    assert.match(stylesheet, /\.budget-v2-table-container\s*\{[^}]*overflow-x:\s*hidden/);
    assert.match(stylesheet, /\.budget-v2-table\s*\{[^}]*table-layout:\s*fixed/);
    assert.match(stylesheet, /\.budget-item-edit-button\s*\{/);
    assert.match(stylesheet, /\.budget-group-editor-color-control\s+input\[type="color"\]/);
    assert.match(stylesheet, /\.budget-add-item-action\s*\{/);
    assert.match(stylesheet, /\.budget-v2-flow-svg\s*\{/);
    assert.match(stylesheet, /\.budget-flow-accessible-list/);
    assert.match(stylesheet, /\.budget-flow-accessible-list\s*\{[\s\S]*position:\s*absolute/);
    assert.match(stylesheet, /@media\s*\(max-width:\s*640px\)[\s\S]*\.budget-flow-mobile-view\s*\{\s*display:\s*block/);
    assert.match(stylesheet, /@media\s*\(max-width:\s*640px\)[\s\S]*\.budget-v2-table\s*\{/);
});

test('settings controls and integrations cannot establish a narrow-screen min-content width', () => {
    assert.match(stylesheet, /#settings-view\s+\.settings-toggle-list\s+\.feature-toggle\s*\{[\s\S]*width:\s*100%[\s\S]*min-width:\s*0/);
    assert.match(stylesheet, /#settings-view\s+\.catalog-kind-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(stylesheet, /#settings-view\s+\.integration-connection\s*\{[\s\S]*width:\s*100%/);
    assert.match(stylesheet, /#settings-view\s+\.integration-market-hours-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
