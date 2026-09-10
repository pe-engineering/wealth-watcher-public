import assert from 'node:assert/strict';
import test from 'node:test';

import {
    REQUIRED_RELEASE_SECTIONS,
    createReleaseManifest,
    parseReleaseDocument,
    validateRelease
} from './release-notes.mjs';

test('the current release notes follow the required format', async () => {
    const manifest = await validateRelease({ tag: 'v0.12.0' });

    assert.equal(manifest.version, '0.12.0');
    assert.equal(manifest.tag, 'v0.12.0');
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.requiresMigration, false);
    assert.equal(manifest.requiresConfigurationChange, false);
    assert.match(manifest.notesMarkdown, /^# Wealth Watcher v0\.12\.0/m);
});

test('release validation rejects a tag that does not match the application version', async () => {
    await assert.rejects(
        () => validateRelease({ tag: 'v0.2.0' }),
        /Git tag v0\.2\.0 does not match application version 0\.12\.0/
    );
});

test('release notes require every standard section', () => {
    const content = `---\nversion: 0.2.0\ndate: 2026-08-14\nchannel: stable\nrequiresMigration: false\nrequiresConfigurationChange: false\n---\n\n# Wealth Watcher v0.2.0\n\n## Highlights\n\n- A highlight\n`;

    assert.throws(
        () => parseReleaseDocument(content, '0.2.0'),
        new RegExp(`Missing required section: ${REQUIRED_RELEASE_SECTIONS[1]}`)
    );
});

test('release note title version must match front matter', () => {
    const content = `---\nversion: 0.2.0\ndate: 2026-08-14\nchannel: stable\nrequiresMigration: false\nrequiresConfigurationChange: false\n---\n\n# Wealth Watcher v0.1.0\n\n## Highlights\n\n- A highlight\n\n## Fixes\n\n- A fix\n\n## Upgrade notes\n\n- Back up first\n\n## Docker images\n\n- Pull the tagged images\n\n## Known issues\n\n- None\n`;

    assert.throws(
        () => parseReleaseDocument(content, '0.2.0'),
        /Release note title version v0\.1\.0 does not match front matter version 0\.2\.0/
    );
});

test('release manifest keeps the release notes as Markdown for the UI renderer', () => {
    const release = parseReleaseDocument(`---\nversion: 0.2.0\ndate: 2026-08-14\nchannel: stable\nrequiresMigration: true\nrequiresConfigurationChange: true\n---\n\n# Wealth Watcher v0.2.0\n\n## Highlights\n\n- A highlight\n\n## Fixes\n\n- A fix\n\n## Upgrade notes\n\n- Back up first\n\n## Docker images\n\n- Pull the tagged images\n\n## Known issues\n\n- None\n`, '0.2.0');
    const manifest = createReleaseManifest(release);

    assert.equal(manifest.notesMarkdown, release.markdown);
    assert.equal(manifest.releaseUrl.endsWith('/v0.2.0'), true);
    assert.equal(manifest.requiresMigration, true);
});
