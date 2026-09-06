#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_NOTES_DIRECTORY = path.join(ROOT_DIRECTORY, 'docs', 'release-notes');
export const PACKAGE_FILE = path.join(ROOT_DIRECTORY, 'WealthWatcher.UI', 'package.json');
export const DEFAULT_RELEASE_URL_BASE = 'https://github.com/pe-engineering/wealth-watcher-public/releases/tag';
export const REQUIRED_RELEASE_SECTIONS = Object.freeze([
    'Highlights',
    'Fixes',
    'Upgrade notes',
    'Docker images',
    'Known issues'
]);

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeVersion(value) {
    const candidate = String(value ?? '').trim();
    const match = candidate.match(SEMVER_PATTERN);
    if (!match) return null;
    return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

export function versionTag(version) {
    const normalized = normalizeVersion(version);
    return normalized ? `v${normalized}` : null;
}

function parseBoolean(value, fieldName) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${fieldName} must be either true or false.`);
}

function parseFrontMatter(markdown) {
    const match = String(markdown ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
        throw new Error('Release notes must start with YAML-style front matter enclosed by --- markers.');
    }

    const fields = {};
    for (const line of match[1].split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator <= 0) throw new Error(`Invalid front matter line: ${line}`);
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!key || !value) throw new Error(`Front matter field ${key || '(unknown)'} must have a value.`);
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
            throw new Error(`Front matter field ${key} is duplicated.`);
        }
        fields[key] = value.replace(/^(['"])(.*)\1$/, '$2');
    }

    return {
        fields,
        body: markdown.slice(match[0].length).trim()
    };
}

function parseSections(body) {
    const headings = [];
    const lines = String(body ?? '').split(/\r?\n/);
    lines.forEach((line, index) => {
        const match = line.match(/^##\s+(.+?)\s*$/);
        if (match) headings.push({ title: match[1].trim(), line: index });
    });

    const sections = new Map();
    headings.forEach((heading, index) => {
        const endLine = headings[index + 1]?.line ?? lines.length;
        const content = lines.slice(heading.line + 1, endLine).join('\n').trim();
        if (sections.has(heading.title)) throw new Error(`Release note section ${heading.title} is duplicated.`);
        sections.set(heading.title, content);
    });

    return { headings, sections };
}

function validateDate(value) {
    if (!DATE_PATTERN.test(value)) throw new Error('date must use YYYY-MM-DD format.');
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`date is not a valid calendar date: ${value}`);
    }
}

export function parseReleaseDocument(markdown, expectedVersion = null) {
    const { fields, body } = parseFrontMatter(markdown);
    const version = normalizeVersion(fields.version);
    if (!version) throw new Error('version must be a valid Semantic Version.');
    if (expectedVersion && version !== normalizeVersion(expectedVersion)) {
        throw new Error(`Release note version ${version} does not match expected version ${expectedVersion}.`);
    }
    if (fields.channel !== 'stable') throw new Error('channel must be stable for a tagged application release.');
    if (!fields.date) throw new Error('date is required.');
    validateDate(fields.date);
    if (!Object.prototype.hasOwnProperty.call(fields, 'requiresMigration')) {
        throw new Error('requiresMigration is required.');
    }
    if (!Object.prototype.hasOwnProperty.call(fields, 'requiresConfigurationChange')) {
        throw new Error('requiresConfigurationChange is required.');
    }

    const requiresMigration = parseBoolean(fields.requiresMigration, 'requiresMigration');
    const requiresConfigurationChange = parseBoolean(
        fields.requiresConfigurationChange,
        'requiresConfigurationChange'
    );
    const { headings, sections } = parseSections(body);

    const titleMatch = body.match(/^#\s+Wealth Watcher\s+(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m);
    if (!titleMatch) throw new Error('Release notes must start with a title in the form # Wealth Watcher vMAJOR.MINOR.PATCH.');
    if (normalizeVersion(titleMatch[1]) !== version) {
        throw new Error(`Release note title version ${titleMatch[1]} does not match front matter version ${version}.`);
    }
    if (headings.length === 0) throw new Error('Release notes must contain level-two sections.');

    for (const requiredSection of REQUIRED_RELEASE_SECTIONS) {
        if (!sections.has(requiredSection)) throw new Error(`Missing required section: ${requiredSection}.`);
        if (!sections.get(requiredSection)) throw new Error(`Required section is empty: ${requiredSection}.`);
    }

    return {
        version,
        tag: versionTag(version),
        date: fields.date,
        channel: fields.channel,
        requiresMigration,
        requiresConfigurationChange,
        markdown: body,
        sections: Object.fromEntries(sections),
        headings: headings.map(heading => heading.title)
    };
}

export async function readReleaseDocument(version) {
    const normalizedVersion = normalizeVersion(version);
    if (!normalizedVersion) throw new Error(`Invalid release version: ${version}.`);

    const notePath = path.join(RELEASE_NOTES_DIRECTORY, `${versionTag(normalizedVersion)}.md`);
    let markdown;
    try {
        markdown = await readFile(notePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(`Missing release notes file: docs/release-notes/${versionTag(normalizedVersion)}.md`);
        }
        throw error;
    }

    return {
        ...parseReleaseDocument(markdown, normalizedVersion),
        path: notePath
    };
}

export async function readApplicationVersion() {
    const packageJson = JSON.parse(await readFile(PACKAGE_FILE, 'utf8'));
    const version = normalizeVersion(packageJson.version);
    if (!version) throw new Error(`WealthWatcher.UI/package.json has invalid version: ${packageJson.version}`);

    const lockFile = path.join(ROOT_DIRECTORY, 'WealthWatcher.UI', 'package-lock.json');
    const lockJson = JSON.parse(await readFile(lockFile, 'utf8'));
    const lockVersion = normalizeVersion(lockJson.packages?.['']?.version || lockJson.version);
    if (lockVersion !== version) {
        throw new Error(`WealthWatcher.UI/package-lock.json version ${lockVersion || '(missing)'} does not match package version ${version}.`);
    }

    return version;
}

export function createReleaseManifest(release) {
    return {
        schemaVersion: 1,
        name: 'Wealth Watcher',
        version: release.version,
        tag: release.tag,
        channel: release.channel,
        releasedAt: release.date,
        requiresMigration: release.requiresMigration,
        requiresConfigurationChange: release.requiresConfigurationChange,
        releaseUrl: `${DEFAULT_RELEASE_URL_BASE}/${release.tag}`,
        notesMarkdown: release.markdown
    };
}

export async function validateRelease({ tag = null, version = null } = {}) {
    const packageVersion = await readApplicationVersion();
    const requestedVersion = normalizeVersion(version || packageVersion);
    if (!requestedVersion) throw new Error(`Invalid requested release version: ${version}.`);
    if (requestedVersion !== packageVersion) {
        throw new Error(`Requested release ${requestedVersion} does not match package version ${packageVersion}.`);
    }

    if (tag && versionTag(tag) !== versionTag(packageVersion)) {
        throw new Error(`Git tag ${tag} does not match application version ${packageVersion}.`);
    }

    return createReleaseManifest(await readReleaseDocument(packageVersion));
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) continue;
        const key = argument.slice(2);
        options[key] = argv[index + 1]?.startsWith('--') ? true : argv[++index];
    }
    return options;
}

async function main() {
    const command = process.argv[2] || 'validate';
    const options = parseArguments(process.argv.slice(3));
    const manifest = await validateRelease({ tag: options.tag, version: options.version });

    if (command === 'validate') {
        console.log(`Release metadata is valid for ${manifest.tag}.`);
        return;
    }

    if (command === 'body') {
        process.stdout.write(`${manifest.notesMarkdown.trim()}\n`);
        return;
    }

    if (command === 'generate') {
        const output = path.resolve(ROOT_DIRECTORY, options.output || 'WealthWatcher.UI/public/release.json');
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        console.log(`Generated ${path.relative(ROOT_DIRECTORY, output)} for ${manifest.tag}.`);
        return;
    }

    throw new Error(`Unknown command: ${command}. Use validate, body, or generate.`);
}

const isMainModule = process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;

if (isMainModule) {
    main().catch(error => {
        console.error(`Release metadata validation failed: ${error.message}`);
        process.exitCode = 1;
    });
}
