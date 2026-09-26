import { store } from '../store/store.js';
import { requestJson, API_BASE_URL } from '../api/apiClient.js';
import { requestConfirmation, requestNotification } from './ConfirmationModal.js';
import { showToast } from './Toast.js';
import { renderCatalogInputField, renderSelectField, escapeHtml } from './FormFields.js';
import { PAGE_STATUS, setPageStatus } from './PageState.js';
import { safeCssColor } from '../utils/html.js';
import { createAssetCatalogApi } from './assetCatalogApi.js';

const ASSET_GROUPS_KEY = 'asset-group';
const ASSET_KINDS_KEY = 'asset-kind';
const NO_GROUP_FILTER = '__no-group__';

let editorState = null;
let dragState = null;
let suppressNextAssetClickId = null;
let suppressNextAssetClickTimer = null;
let catalogLoadError = null;
let catalogRefresh = async () => {};
const catalogState = {
    query: '',
    assetKindId: '',
    assetGroupId: '',
    view: 'board'
};
const catalogFilterState = {
    kind: { query: '', open: false, activeIndex: -1 },
    group: { query: '', open: false, activeIndex: -1 }
};
const catalogFilterDefinitions = {
    kind: {
        stateKey: 'assetKindId',
        inputId: 'catalog-asset-kind-filter',
        optionsId: 'catalog-asset-kind-options',
        allLabel: 'All Types'
    },
    group: {
        stateKey: 'assetGroupId',
        inputId: 'catalog-asset-group-filter',
        optionsId: 'catalog-asset-group-options',
        allLabel: 'All Groups'
    }
};

async function request(path, options = {}) {
    return requestJson(`${API_BASE_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
}

const catalogApi = createAssetCatalogApi(request);

function createCatalogRefresh(refresh) {
    return async (...args) => {
        try {
            const result = typeof refresh === 'function' ? await refresh(...args) : undefined;
            catalogLoadError = null;
            renderAssetCatalog();
            return result;
        } catch (error) {
            catalogLoadError = error;
            renderAssetCatalog();
            throw error;
        }
    };
}

export function renderCatalogLoadError(error) {
    const message = error?.message || 'There was a problem communicating with the API.';
    return `<div class="catalog-empty-message catalog-load-error" role="alert">
        <strong>Unable to load the asset catalogue.</strong>
        <span>${escapeHtml(message)}</span>
        <button type="button" class="action-btn" data-catalog-retry>Retry loading catalogue</button>
    </div>`;
}

function renderCatalogForms() {
    const target = document.getElementById('asset-catalog-create-forms');
    if (!target || target.dataset.rendered === 'true') return;

    target.innerHTML = `
        <form id="asset-kind-form" data-group-key="asset-kind" class="catalog-value-form catalog-create-form asset-kind-create-form">
            <div class="catalog-create-form-heading">
                <strong>Asset Type</strong>
                <span>Classification and default Group for new assets</span>
            </div>
            ${renderCatalogInputField({ name: 'displayName', label: 'Name', required: true, placeholder: 'e.g. Pensions' })}
            ${renderCatalogInputField({ name: 'displayOrder', label: 'Order', type: 'number', className: 'catalog-field catalog-field-order', value: '10', min: '0' })}
            ${renderCatalogInputField({ name: 'color', label: 'Colour', type: 'color', className: 'catalog-field catalog-field-color', value: '#64748b', title: 'Asset Type colour' })}
            ${renderSelectField({ id: 'asset-kind-group-value', name: 'parentValueId', label: 'Default Group (optional)', ariaLabel: 'Default Group' })}
            <button class="action-btn catalog-add-button" type="submit">Add Type</button>
        </form>
        <form id="asset-group-form" data-group-key="asset-group" class="catalog-value-form catalog-create-form">
            <div class="catalog-create-form-heading">
                <strong>Asset Group</strong>
                <span>Independent grouping for tracked assets</span>
            </div>
            ${renderCatalogInputField({ name: 'displayName', label: 'Name', required: true, placeholder: 'e.g. Liquid' })}
            ${renderCatalogInputField({ name: 'displayOrder', label: 'Order', type: 'number', className: 'catalog-field catalog-field-order', value: '10', min: '0' })}
            ${renderCatalogInputField({ name: 'color', label: 'Colour', type: 'color', className: 'catalog-field catalog-field-color', value: '#64748b', title: 'Asset Group colour' })}
            <button class="action-btn catalog-add-button" type="submit">Add Group</button>
        </form>`;
    target.dataset.rendered = 'true';
}

function renderClassificationEditorFields() {
    const target = document.getElementById('classification-edit-fields');
    if (!target || target.dataset.rendered === 'true') return;

    target.innerHTML = `
        ${renderCatalogInputField({ id: 'classification-edit-name', name: 'displayName', label: 'Name', wrapperId: 'classification-edit-name-field', required: true })}
        ${renderCatalogInputField({ id: 'classification-edit-order', name: 'displayOrder', label: 'Order', type: 'number', className: 'catalog-field catalog-field-order', wrapperId: 'classification-edit-order-field', min: '0' })}
        ${renderCatalogInputField({ id: 'classification-edit-color', name: 'color', label: 'Colour', type: 'color', className: 'catalog-field catalog-field-color', wrapperId: 'classification-edit-color-field', value: '#64748b', title: 'Value colour' })}
        ${renderSelectField({ id: 'classification-edit-parent', name: 'parentValueId', label: 'Asset Type (required)', wrapperId: 'classification-edit-parent-field', labelSpanId: 'classification-edit-parent-label', ariaLabel: 'Asset Type' })}
        ${renderSelectField({ id: 'classification-edit-group', name: 'assetGroupId', label: 'Asset Group (required)', wrapperId: 'classification-edit-group-field', labelSpanId: 'classification-edit-group-label', ariaLabel: 'Asset Group' })}`;
    target.dataset.rendered = 'true';
}

export function setupAssetCatalog({ refresh } = {}) {
    catalogRefresh = createCatalogRefresh(refresh);
    renderCatalogForms();
    renderClassificationEditorFields();
    const assetGroupForm = document.getElementById('asset-group-form');
    const assetKindForm = document.getElementById('asset-kind-form');
    const catalogue = document.getElementById('asset-catalogue-list');
    if (!assetGroupForm || !assetKindForm || !catalogue || catalogue.dataset.initialized === 'true') return;

    catalogue.dataset.initialized = 'true';
    setupClassificationEditor(catalogRefresh);
    setupAssetDragAndDrop(catalogue, catalogRefresh);
    setupCatalogControls(catalogue);

    [assetGroupForm, assetKindForm].forEach(form => {
        form.addEventListener('submit', async event => {
            event.preventDefault();
            await addValue(form, catalogRefresh);
        });
    });

    catalogue.addEventListener('click', event => {
        const retryTarget = event.target.closest?.('[data-catalog-retry]');
        if (retryTarget) {
            event.preventDefault();
            catalogRefresh().catch(() => {});
            return;
        }

        const archiveTarget = event.target.closest?.('[data-archive-value]');
        if (archiveTarget) {
            event.preventDefault();
            event.stopPropagation();
            const asset = findAsset(archiveTarget.dataset.archiveValue);
            if (asset) {
                archiveValue({
                    id: String(asset.Id),
                    name: asset.DisplayName || asset.Name,
                    isAssetGroup: false,
                    isAsset: true
                }, catalogRefresh);
            } else {
                const valueInfo = findValue(archiveTarget.dataset.archiveValue);
                if (valueInfo) {
                    const groupKey = normalizeCode(valueInfo.group.Key);
                    archiveValue({
                        id: String(valueInfo.value.Id),
                        name: valueInfo.value.DisplayName || valueInfo.value.Key,
                        isAssetGroup: groupKey === ASSET_GROUPS_KEY,
                        isAssetKind: groupKey === ASSET_KINDS_KEY,
                        isAsset: false
                    }, catalogRefresh);
                }
            }
            return;
        }

        const moveTarget = event.target.closest?.('[data-move-asset]');
        if (moveTarget) {
            event.preventDefault();
            event.stopPropagation();
            openValueEditor(moveTarget.dataset.moveAsset, { focusGroup: true });
            return;
        }

        const editTarget = event.target.closest?.('[data-edit-value]');
        const assetTarget = event.target.closest?.('[data-asset-id]');
        if (assetTarget && suppressNextAssetClickId === String(assetTarget.dataset.assetId)) {
            clearTimeout(suppressNextAssetClickTimer);
            suppressNextAssetClickTimer = null;
            suppressNextAssetClickId = null;
            event.preventDefault();
            return;
        }
        if (editTarget) openValueEditor(editTarget.dataset.editValue);
    });
    catalogue.addEventListener('keydown', event => {
        if (event.target.closest?.('[data-archive-value]')) return;
        const moveTarget = event.target.closest?.('[data-move-asset]');
        if (moveTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            openValueEditor(moveTarget.dataset.moveAsset, { focusGroup: true });
            return;
        }
        const editTarget = event.target.closest?.('[data-edit-value]');
        if (!editTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openValueEditor(editTarget.dataset.editValue);
    });

    renderAssetCatalog();
}

function setupCatalogControls(catalogue) {
    const search = document.getElementById('catalog-asset-search');
    const addAssetButton = document.getElementById('catalog-add-asset-button');

    if (catalogue.dataset.controlsInitialized !== 'true') {
        catalogue.dataset.controlsInitialized = 'true';
        search?.addEventListener('input', event => {
            catalogState.query = String(event.target.value || '');
            renderAssetCatalog();
        });
        addAssetButton?.addEventListener('click', openNewAssetEditor);
        catalogue.querySelectorAll('[data-catalog-view]').forEach(button => {
            button.addEventListener('click', () => {
                catalogState.view = button.dataset.catalogView === 'list' ? 'list' : 'board';
                updateViewToggle();
                renderAssetCatalog();
            });
        });

        catalogue.addEventListener('click', event => {
            const choice = event.target.closest?.('[data-catalog-filter-choice]');
            if (choice) {
                chooseCatalogFilter(choice.dataset.catalogFilter, choice.dataset.catalogFilterChoice || '');
                return;
            }

            const input = event.target.closest?.('[data-catalog-filter-input]');
            if (input) openCatalogFilter(input.dataset.catalogFilterInput);
        });
        catalogue.addEventListener('focusin', event => {
            const input = event.target.closest?.('[data-catalog-filter-input]');
            if (input) openCatalogFilter(input.dataset.catalogFilterInput);
        });
        catalogue.addEventListener('input', event => {
            const input = event.target.closest?.('[data-catalog-filter-input]');
            if (!input) return;

            const filterKey = input.dataset.catalogFilterInput;
            const state = catalogFilterState[filterKey];
            if (!state) return;
            state.query = String(input.value || '');
            state.activeIndex = -1;
            state.open = true;
            renderCatalogFilterOptions(filterKey);
        });
        catalogue.addEventListener('search', event => {
            const input = event.target.closest?.('[data-catalog-filter-input]');
            if (!input || input.value) return;

            const filterKey = input.dataset.catalogFilterInput;
            const definition = getCatalogFilterDefinition(filterKey);
            if (!definition) return;
            catalogState[definition.stateKey] = '';
            closeCatalogFilter(filterKey);
            renderAssetCatalog();
        });
        catalogue.addEventListener('keydown', event => {
            const input = event.target.closest?.('[data-catalog-filter-input]');
            if (!input) return;

            const filterKey = input.dataset.catalogFilterInput;
            const state = catalogFilterState[filterKey];
            const options = getCatalogFilterChoices(filterKey);
            if (!state) return;

            if (event.key === 'Escape') {
                closeCatalogFilter(filterKey);
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;

            if (!state.open) openCatalogFilter(filterKey);
            if (!options.length) return;

            if (event.key === 'Enter') {
                const choice = options[state.activeIndex >= 0 ? state.activeIndex : 0];
                if (choice) {
                    chooseCatalogFilter(filterKey, choice.dataset.catalogFilterChoice || '');
                    event.preventDefault();
                }
                return;
            }

            state.activeIndex = event.key === 'ArrowDown'
                ? (state.activeIndex + 1) % options.length
                : (state.activeIndex - 1 + options.length) % options.length;
            updateCatalogFilterFocus(filterKey);
            event.preventDefault();
        });
        catalogue.addEventListener('focusout', event => {
            const field = event.target.closest?.('[data-catalog-filter]');
            if (!field) return;
            const filterKey = field.dataset.catalogFilter;
            setTimeout(() => {
                if (!field.contains?.(document.activeElement)) closeCatalogFilter(filterKey);
            }, 0);
        });
    }
}

function getCatalogFilterDefinition(filterKey) {
    return catalogFilterDefinitions[filterKey] || null;
}

function getCatalogFilterValues(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    if (!definition) return [];
    const groupKey = filterKey === 'kind' ? ASSET_KINDS_KEY : ASSET_GROUPS_KEY;
    return sortValues(findGroupByKey(groupKey)?.Values);
}

function getCatalogFilterLabel(filterKey, valueId, values = getCatalogFilterValues(filterKey)) {
    const definition = getCatalogFilterDefinition(filterKey);
    if (!definition || !valueId) return definition?.allLabel || '';
    if (filterKey === 'group' && valueId === NO_GROUP_FILTER) return 'No Group';
    const value = values.find(candidate => String(candidate.Id) === String(valueId));
    return value?.DisplayName || value?.Key || value?.Code || definition.allLabel;
}

function getCatalogFilterChoices(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    const options = document.getElementById(definition?.optionsId);
    return options?.querySelectorAll
        ? [...options.querySelectorAll('[data-catalog-filter-choice]')]
        : [];
}

function openCatalogFilter(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    const state = catalogFilterState[filterKey];
    const input = document.getElementById(definition?.inputId);
    if (!definition || !state || !input) return;

    state.open = true;
    state.query = '';
    state.activeIndex = -1;
    input.dataset.catalogFilterEditing = 'true';
    input.value = '';
    input.setAttribute('aria-expanded', 'true');
    input.closest('[data-catalog-filter]')?.classList.add('is-open');
    renderCatalogFilterOptions(filterKey);
}

function closeCatalogFilter(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    const state = catalogFilterState[filterKey];
    const input = document.getElementById(definition?.inputId);
    if (!definition || !state || !input) return;

    state.open = false;
    state.query = '';
    state.activeIndex = -1;
    delete input.dataset.catalogFilterEditing;
    input.value = getCatalogFilterLabel(filterKey, catalogState[definition.stateKey]);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.closest('[data-catalog-filter]')?.classList.remove('is-open');
    renderCatalogFilterOptions(filterKey);
}

function chooseCatalogFilter(filterKey, valueId) {
    const definition = getCatalogFilterDefinition(filterKey);
    const state = catalogFilterState[filterKey];
    if (!definition || !state) return;

    catalogState[definition.stateKey] = String(valueId || '');
    closeCatalogFilter(filterKey);
    renderAssetCatalog();
}

function updateCatalogFilterFocus(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    const state = catalogFilterState[filterKey];
    const input = document.getElementById(definition?.inputId);
    const choices = getCatalogFilterChoices(filterKey);
    if (!definition || !state || !input) return;

    choices.forEach((choice, index) => choice.classList.toggle('is-focused', index === state.activeIndex));
    const activeChoice = choices[state.activeIndex];
    if (activeChoice?.id) input.setAttribute('aria-activedescendant', activeChoice.id);
    else input.removeAttribute('aria-activedescendant');
}

function renderCatalogFilterOptions(filterKey) {
    const definition = getCatalogFilterDefinition(filterKey);
    const state = catalogFilterState[filterKey];
    const optionsElement = document.getElementById(definition?.optionsId);
    if (!definition || !state || !optionsElement) return;

    const values = getCatalogFilterValues(filterKey);
    const options = [
        { id: '', label: definition.allLabel },
        ...values.map(value => ({
            id: String(value.Id),
            label: value.DisplayName || value.Key || value.Code
        })),
        ...(filterKey === 'group' ? [{ id: NO_GROUP_FILTER, label: 'No Group' }] : [])
    ];
    const query = state.query.trim().toLowerCase();
    const visibleOptions = options.filter(option => !query || option.label.toLowerCase().includes(query));
    const selectedId = String(catalogState[definition.stateKey] || '');

    optionsElement.innerHTML = visibleOptions.length
        ? visibleOptions.map((option, index) => {
            const optionId = `${definition.optionsId}-${String(option.id || 'all').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            const selected = option.id === selectedId;
            const focused = index === state.activeIndex;
            return `<div id="${optionId}" class="catalog-filter-option${focused ? ' is-focused' : ''}" data-catalog-filter="${filterKey}" data-catalog-filter-choice="${escapeHtml(option.id)}" role="option" aria-selected="${selected}">${escapeHtml(option.label)}</div>`;
        }).join('')
        : '<div class="catalog-filter-options-empty">No matching options.</div>';
    optionsElement.hidden = !state.open;
    updateCatalogFilterFocus(filterKey);
}

function openNewAssetEditor() {
    editorState = {
        id: '',
        name: '',
        isAssetGroup: false,
        isAssetKind: false,
        isSystemKind: false,
        isAsset: true,
        isNewAsset: true,
        groupTouched: false
    };

    setEditorText('classification-edit-title', 'Add asset');
    setEditorText('classification-edit-description', 'Add an asset, choose its Type, then place it in a Group.');
    setEditorHtml('classification-edit-parent-label', 'Asset Type <em>required</em>');
    setEditorHtml('classification-edit-group-label', 'Asset Group <em>optional</em>');
    setEditorValue('classification-edit-name', '');
    setEditorValue('classification-edit-order', '');
    setEditorValue('classification-edit-color', '#64748b');
    setEditorVisible('classification-edit-order-field', false);
    setEditorVisible('classification-edit-color-field', false);
    setEditorVisible('classification-edit-parent-field', true);
    setEditorVisible('classification-edit-group-field', true);

    const typeSelect = document.getElementById('classification-edit-parent');
    if (typeSelect) typeSelect.innerHTML = renderAssetKindOptions(sortValues(findGroupByKey(ASSET_KINDS_KEY)?.Values));
    const groupSelect = document.getElementById('classification-edit-group');
    if (groupSelect) groupSelect.innerHTML = renderAssetGroupOptions(sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values));
    setEditorText('classification-edit-save', 'Add asset');
    const archive = document.getElementById('classification-edit-archive');
    if (archive) {
        archive.hidden = true;
        archive.disabled = true;
    }
    showClassificationEditor();
}

async function addValue(form, refresh) {
    const formData = new FormData(form);
    const displayName = String(formData.get('displayName') || '').trim();
    if (!displayName) return;

    try {
        if (form.id === 'asset-form') {
            const assetKindId = String(formData.get('assetKindId') || '').trim();
            if (!assetKindId) {
                await requestNotification({
                    title: 'Unable to add asset',
                    message: 'Select a Type before adding the asset.'
                });
                return;
            }

            await catalogApi.createAsset({ DisplayName: displayName, AssetKindId: assetKindId });
        } else {
            const isAssetKind = form.id === 'asset-kind-form';
            const payload = {
                DisplayName: displayName,
                Color: formData.get('color') || '#64748b',
                DisplayOrder: Number(formData.get('displayOrder')) || 0
            };
            if (isAssetKind) {
                const parentValueId = String(formData.get('parentValueId') || '').trim();
                if (parentValueId) payload.ParentValueId = parentValueId;
            }

            await catalogApi.createClassification(form.dataset.groupKey || ASSET_GROUPS_KEY, payload);
        }
    } catch (error) {
        console.error(error);
        await requestNotification({
            title: 'Unable to add catalogue value',
            message: error.message || 'There was a problem communicating with the API.'
        });
        return;
    }

    form.reset();
    const color = form.querySelector('input[name="color"]');
    if (color) color.value = '#64748b';
    await refresh();
    renderAssetCatalog();
    const noun = form.id === 'asset-form'
        ? 'Asset'
        : form.id === 'asset-kind-form' ? 'Asset Kind' : 'Asset Group';
    showToast({
        title: `${noun} added`,
        message: `${displayName} was added successfully.`,
        type: 'success',
        key: 'asset-catalog-add'
    });
}

function setupClassificationEditor(refresh) {
    const form = document.getElementById('classification-edit-form');
    if (!form || form.dataset.initialized === 'true') return;

    form.dataset.initialized = 'true';
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (editorState) await saveValue(form, refresh);
    });

    document.getElementById('classification-edit-parent')?.addEventListener('change', event => {
        if (!editorState?.isAsset || !editorState.isNewAsset || editorState.groupTouched) return;
        const kind = getAssetKinds().find(value => String(value.Id) === String(event.target.value));
        setEditorValue('classification-edit-group', kind?.ParentValueId || kind?.AssetGroupId || '');
    });
    document.getElementById('classification-edit-group')?.addEventListener('change', () => {
        if (editorState?.isAsset && editorState.isNewAsset) editorState.groupTouched = true;
    });

    document.getElementById('classification-edit-cancel')?.addEventListener('click', closeClassificationEditor);
    document.getElementById('classification-edit-close')?.addEventListener('click', closeClassificationEditor);
    window.closeClassificationEditor = closeClassificationEditor;
    document.getElementById('classification-edit-modal')?.addEventListener('click', event => {
        if (event.target.id === 'classification-edit-modal') closeClassificationEditor();
    });
    document.getElementById('classification-edit-archive')?.addEventListener('click', async event => {
        const state = editorState;
        const archive = event.target?.closest?.('#classification-edit-archive');
        if (!state || !archive) return;

        if (!state.archiveConfirming) {
            state.archiveConfirming = true;
            archive.textContent = `Confirm archive ${state.isAssetGroup ? 'Asset Group' : state.isAssetKind ? 'Asset Kind' : 'asset'}`;
            archive.dataset.archiveState = 'confirm';
            archive.setAttribute?.('aria-label', `Confirm archive ${state.name}`);
            return;
        }

        const stateToArchive = { ...state };
        closeClassificationEditor();
        await archiveValue(stateToArchive, refresh, { confirmed: true });
    });
}

async function saveValue(form, refresh) {
    const formData = new FormData(form);
    const displayName = String(formData.get('displayName') || '').trim();
    if (!displayName) return;

    let path;
    let payload;
    if (editorState.isAsset) {
        const assetKindId = String(formData.get('assetKindId') || formData.get('parentValueId') || '').trim();
        const assetGroupId = String(formData.get('assetGroupId') || '').trim();
        if (!assetKindId) {
            await requestNotification({
                title: 'Unable to update asset',
                message: 'Select a Type before saving the asset.'
            });
            return;
        }
        path = editorState.isNewAsset ? '/assets' : `/assets/${editorState.id}`;
        payload = {
            DisplayName: displayName,
            AssetKindId: assetKindId,
            AssetGroupId: assetGroupId || null,
            SetAssetGroup: true
        };
    } else {
        path = `/classification-values/${editorState.id}`;
        payload = {
            DisplayName: displayName,
            Color: formData.get('color') || '#64748b',
            DisplayOrder: Number(formData.get('displayOrder')) || 0
        };
        if (editorState.isAssetKind) {
            const parentValueId = String(formData.get('parentValueId') || formData.get('assetKindId') || '').trim();
            if (parentValueId) payload.ParentValueId = parentValueId;
            else payload.ClearParentValue = true;
        }
    }

    try {
        if (editorState.isAsset) {
            await catalogApi.updateAsset(editorState.id, payload, { create: editorState.isNewAsset });
        } else {
            await catalogApi.updateClassification(editorState.id, payload);
        }
    } catch (error) {
        console.error(error);
        await requestNotification({
            title: 'Unable to update catalogue value',
            message: error.message || 'There was a problem communicating with the API.'
        });
        return;
    }

    const state = editorState;
    const noun = state.isAsset
        ? 'Asset'
        : state.isAssetKind ? 'Asset Type' : 'Asset Group';
    const moveDestination = state.isAsset
        ? getAssetGroupLabel(String(formData.get('assetGroupId') || '').trim())
        : '';
    const wasMove = Boolean(state.isAsset && !state.isNewAsset &&
        String(state.originalGroupId || '') !== String(formData.get('assetGroupId') || ''));
    closeClassificationEditor();
    await refresh();
    renderAssetCatalog();
    showToast({
        title: state.isNewAsset ? 'Asset added' : wasMove ? 'Asset moved' : `${noun} updated`,
        message: wasMove
            ? `${displayName} moved to ${moveDestination}.`
            : state.isNewAsset
                ? `${displayName} was added successfully.`
                : `${displayName} was updated successfully.`,
        type: 'success',
        key: 'asset-catalog-update'
    });
}

async function archiveValue(state, refresh, { confirmed = false } = {}) {
    if (state.isAssetKind && isUnclassifiedAssetKind(findValue(state.id)?.value)) return;

    const mappingCount = state.isAssetGroup
        ? getAssetGroupMappingCount(state.id)
        : state.isAssetKind
            ? getAssetKindMappingCount(state.id)
            : 0;
    const mappingNotice = mappingCount > 0
            ? state.isAssetGroup
            ? ` ${mappingCount} existing ${mappingCount === 1 ? 'asset will' : 'assets will'} become ungrouped.`
            : ` ${mappingCount} existing ${mappingCount === 1 ? 'asset will' : 'assets will'} move to Needs attention.`
        : '';
    const noun = state.isAssetGroup ? 'Group' : state.isAssetKind ? 'Type' : 'asset';

    if (!confirmed && !await requestConfirmation({
        title: `Archive ${noun}?`,
        message: `Archive ${state.name}?${mappingNotice} Existing asset history will be retained.`,
        confirmLabel: `Archive ${noun}`
    })) return;

    try {
        if (state.isAsset) await catalogApi.archiveAsset(state.id);
        else await catalogApi.archiveClassification(state.id);
    } catch (error) {
        console.error(error);
        await requestNotification({
            title: `Unable to archive ${noun}`,
            message: error.message || 'There was a problem communicating with the API.'
        });
        return;
    }

    await refresh();
    renderAssetCatalog();
    showToast({
        title: `${noun} archived`,
        message: `${state.name} was archived successfully.`,
        type: 'success',
        key: 'asset-catalog-archive'
    });
}

function renderAssetCatalog() {
    const assetGroups = sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values);
    const assetKinds = sortValues(findGroupByKey(ASSET_KINDS_KEY)?.Values);
    const activeAssets = sortAssets((store.state.assets || []).filter(asset => !asset.ArchivedAt));
    const assets = filterAssets(activeAssets, assetKinds, assetGroups);
    const board = document.getElementById('catalog-board');
    const catalogue = document.getElementById('asset-catalogue-list');
    const kindList = document.getElementById('asset-kind-list');
    const kindGroupSelect = document.getElementById('asset-kind-group-value');
    const kindSelect = document.getElementById('asset-kind-value');

    if (catalogLoadError) {
        setPageStatus(catalogue, PAGE_STATUS.ERROR);
        if (board) board.innerHTML = renderCatalogLoadError(catalogLoadError);
        const attention = document.getElementById('catalog-needs-attention');
        if (attention) attention.innerHTML = '';
        if (kindList) kindList.innerHTML = '<p class="catalog-empty-message" role="alert">Asset classifications are unavailable until the catalogue reloads.</p>';
        if (kindGroupSelect) {
            kindGroupSelect.innerHTML = '<option value="">Catalogue unavailable</option>';
            kindGroupSelect.disabled = true;
        }
        if (kindSelect) {
            kindSelect.innerHTML = '<option value="">Catalogue unavailable</option>';
            kindSelect.disabled = true;
        }
        return;
    }

    setPageStatus(catalogue, assets.length > 0 ? PAGE_STATUS.READY : PAGE_STATUS.EMPTY);

    renderCatalogFilters(assetKinds, assetGroups);
    updateViewToggle();
    const attention = document.getElementById('catalog-needs-attention');
    if (attention) attention.innerHTML = renderNeedsAttention(activeAssets);
    if (board) {
        board.classList.toggle('catalog-list-mode', catalogState.view === 'list');
        board.innerHTML = catalogState.view === 'list'
            ? renderAssetList(assets, assetKinds, assetGroups, activeAssets)
            : renderBoard(assetGroups, assets, activeAssets);
    }
    if (kindList) kindList.innerHTML = renderAssetKindManager(assetKinds, assetGroups);
    if (kindGroupSelect) kindGroupSelect.innerHTML = renderAssetGroupOptions(assetGroups);

    if (kindSelect) {
        kindSelect.innerHTML = renderAssetKindOptions(assetKinds);
        kindSelect.disabled = !assetKinds.some(value => !isUnclassifiedAssetKind(value));
    }
}

function renderCatalogFilters(assetKinds, assetGroups) {
    if (!assetKinds.some(value => String(value.Id) === catalogState.assetKindId))
        catalogState.assetKindId = '';
    if (catalogState.assetGroupId !== NO_GROUP_FILTER &&
        !assetGroups.some(value => String(value.Id) === catalogState.assetGroupId))
        catalogState.assetGroupId = '';

    ['kind', 'group'].forEach(filterKey => {
        const definition = getCatalogFilterDefinition(filterKey);
        const state = catalogFilterState[filterKey];
        const input = document.getElementById(definition.inputId);
        if (!input || !state) return;

        if (input.dataset.catalogFilterEditing !== 'true')
            input.value = getCatalogFilterLabel(filterKey, catalogState[definition.stateKey]);
        input.setAttribute('aria-expanded', String(state.open));
        renderCatalogFilterOptions(filterKey);
    });
}

function updateViewToggle() {
    document.querySelectorAll?.('[data-catalog-view]').forEach(button => {
        const active = button.dataset.catalogView === catalogState.view;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function filterAssets(assets, assetKinds, assetGroups) {
    const query = catalogState.query.trim().toLowerCase();
    return assets.filter(asset => {
        const kind = findAssetKind(asset, assetKinds);
        const group = getAssetGroupForAsset(asset, assetKinds, assetGroups);
        const label = asset.DisplayName || asset.Name || '';
        const kindLabel = kind?.DisplayName || kind?.Key || kind?.Code || '';
        const groupLabel = group?.DisplayName || group?.Key || group?.Code || 'No Group';
        const matchesQuery = !query || [label, kindLabel, groupLabel]
            .some(value => String(value).toLowerCase().includes(query));
        const matchesKind = !catalogState.assetKindId ||
            String(kind?.Id || '') === catalogState.assetKindId;
        const matchesGroup = !catalogState.assetGroupId || (
            catalogState.assetGroupId === NO_GROUP_FILTER
                ? !group
                : String(group?.Id || '') === catalogState.assetGroupId);
        return matchesQuery && matchesKind && matchesGroup;
    });
}

function renderNeedsAttention(assets) {
    const needsAttention = sortAssets(assets.filter(asset =>
        isUnclassifiedAssetKind(findAssetKind(asset))));
    if (!needsAttention.length) return '';
    return `
        <section class="catalog-attention-panel" aria-labelledby="catalog-needs-attention-title">
            <div class="catalog-attention-copy">
                <strong id="catalog-needs-attention-title">${needsAttention.length} asset${needsAttention.length === 1 ? '' : 's'} need${needsAttention.length === 1 ? 's' : ''} attention</strong>
                <span>Assign a Type so these assets appear in the right Group and dashboard sections.</span>
            </div>
            <div class="catalog-attention-items">
                ${needsAttention.map(asset => {
                    const valueId = String(asset.Id);
                    const label = asset.DisplayName || asset.Name || 'Unnamed asset';
                    return `<button type="button" class="catalog-attention-item" data-edit-value="${escapeHtml(valueId)}" aria-label="Assign a Type to ${escapeHtml(label)}">${escapeHtml(label)}<span>Assign Type</span></button>`;
                }).join('')}
            </div>
        </section>`;
}

function setupAssetDragAndDrop(catalogue, refresh) {
    catalogue.addEventListener('dragstart', event => {
        const assetElement = event.target.closest?.('[data-asset-id]');
        if (!assetElement) return;

        const assetId = String(assetElement.dataset.assetId);
        dragState = { assetId, assetElement, dropzone: null };
        suppressAssetClick(assetId);
        assetElement.classList.add('catalog-asset-dragging');
        assetElement.setAttribute('aria-grabbed', 'true');
        catalogue.classList.add('catalog-drag-active');
        event.dataTransfer?.setData?.('text/plain', assetId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        setDragStatus(catalogue, `Moving ${getAssetLabel(assetId)}. Choose a Group destination.`);
    });

    catalogue.addEventListener('dragenter', event => {
        const dropzone = getAssetDropzone(event.target);
        if (!dropzone || !dragState) return;
        event.preventDefault();
        setActiveDropzone(dropzone);
    });

    catalogue.addEventListener('dragover', event => {
        const dropzone = getAssetDropzone(event.target);
        if (!dropzone || !dragState) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setActiveDropzone(dropzone);
    });

    catalogue.addEventListener('dragleave', event => {
        const dropzone = getAssetDropzone(event.target);
        if (!dropzone || !dragState || dropzone.contains?.(event.relatedTarget)) return;
        if (dragState.dropzone === dropzone) {
            dropzone.classList.remove('catalog-drop-target');
            dropzone.setAttribute('aria-dropeffect', 'none');
            dragState.dropzone = null;
        }
    });

    catalogue.addEventListener('drop', async event => {
        const dropzone = getAssetDropzone(event.target);
        if (!dropzone || !dragState) return;
        event.preventDefault();

        const assetId = String(event.dataTransfer?.getData?.('text/plain') || dragState.assetId);
        const groupId = String(dropzone.dataset.dropGroupId || '');
        clearDragState(catalogue);
        await moveAssetToGroup(assetId, groupId, refresh, catalogue);
    });

    catalogue.addEventListener('dragend', () => {
        if (dragState) suppressAssetClick(dragState.assetId);
        clearDragState(catalogue);
    });
}

function getAssetDropzone(target) {
    const dropzone = target?.closest?.('[data-drop-group-id]');
    return dropzone?.dataset.dropGroupId ? dropzone : null;
}

function setActiveDropzone(dropzone) {
    if (dragState.dropzone && dragState.dropzone !== dropzone) {
        dragState.dropzone.classList.remove('catalog-drop-target');
        dragState.dropzone.setAttribute('aria-dropeffect', 'none');
    }
    dragState.dropzone = dropzone;
    dropzone.classList.add('catalog-drop-target');
    dropzone.setAttribute('aria-dropeffect', 'move');
}

function clearDragState(catalogue) {
    if (dragState?.assetElement) {
        dragState.assetElement.classList.remove('catalog-asset-dragging');
        dragState.assetElement.setAttribute('aria-grabbed', 'false');
    }
    if (dragState?.dropzone) {
        dragState.dropzone.classList.remove('catalog-drop-target');
        dragState.dropzone.setAttribute('aria-dropeffect', 'none');
    }
    catalogue.classList.remove('catalog-drag-active');
    dragState = null;
}

function suppressAssetClick(assetId) {
    clearTimeout(suppressNextAssetClickTimer);
    suppressNextAssetClickId = String(assetId);
    suppressNextAssetClickTimer = setTimeout(() => {
        suppressNextAssetClickTimer = null;
        suppressNextAssetClickId = null;
    }, 250);
}

export async function moveAssetToGroup(assetId, destinationGroupId, refresh = async () => {}, catalogue = null) {
    const asset = findAsset(assetId);
    const noGroupDestination = String(destinationGroupId) === NO_GROUP_FILTER;
    const group = noGroupDestination ? null : findValue(destinationGroupId)?.value;
    const destinationLabel = group?.DisplayName || group?.Key || group?.Code || 'No Group';

    if (!asset || (!group && !noGroupDestination)) {
        await requestNotification({
            title: 'Unable to move asset',
            message: `The destination Group could not be found.`
        });
        setDragStatus(catalogue, `Unable to move asset to ${destinationLabel}.`);
        return false;
    }

    const assetGroups = sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values);
    const currentGroupId = String(getAssetGroupForAsset(asset, getAssetKinds(), assetGroups)?.Id || '');
    const targetGroupId = noGroupDestination ? '' : String(destinationGroupId);
    if (currentGroupId === targetGroupId) {
        setDragStatus(catalogue, `${getAssetLabel(assetId)} is already in ${destinationLabel}.`);
        return true;
    }

    try {
        await catalogApi.moveAsset(assetId, {
            AssetGroupId: noGroupDestination ? null : String(destinationGroupId),
            SetAssetGroup: true
        });

        await refresh();
        renderAssetCatalog();
        setDragStatus(catalogue, `${getAssetLabel(assetId)} moved to ${destinationLabel}.`);
        showToast({
            title: 'Asset moved',
            message: `${getAssetLabel(assetId)} was moved to ${destinationLabel}.`,
            type: 'success',
            key: 'asset-catalog-move'
        });
        return true;
    } catch (error) {
        console.error(error);
        await requestNotification({
            title: 'Unable to move asset',
            message: error.message || 'There was a problem communicating with the API.'
        });
        setDragStatus(catalogue, `Unable to move ${getAssetLabel(assetId)} to ${destinationLabel}.`);
        return false;
    }
}

function getAssetKinds() {
    return findGroupByKey(ASSET_KINDS_KEY)?.Values || [];
}

function getAssetLabel(assetId) {
    const asset = findAsset(assetId);
    return asset?.DisplayName || asset?.Name || 'Asset';
}

function getAssetGroupLabel(groupId) {
    const group = groupId ? findValue(groupId)?.value : null;
        return group?.DisplayName || group?.Key || group?.Code || 'No Group';
}

function setDragStatus(catalogue, message) {
    const status = catalogue?.querySelector?.('#asset-catalogue-drag-status');
    if (status) status.textContent = message;
}

export function renderAssetKindManager(assetKinds, assetGroups) {
    const groupsById = new Map((Array.isArray(assetGroups) ? assetGroups : [])
        .map(group => [String(group.Id), group.DisplayName || group.Key || group.Code]));
    const values = sortValues(assetKinds);
    if (!values.length) return '<p class="catalog-empty-message">No Asset Kinds configured.</p>';

    return values.map(value => {
        const label = value.DisplayName || value.Key || value.Code;
        const groupLabel = groupsById.get(String(value.ParentValueId)) || 'No default Group';
        const valueId = String(value.Id);
        const isSystemKind = isUnclassifiedAssetKind(value);
        const assetCount = getAssetKindMappingCount(valueId);
        return `
            <div class="catalog-kind-row" data-edit-value="${escapeHtml(valueId)}"${isSystemKind ? ' data-system-kind="true"' : ''}>
                <button type="button" class="catalog-kind-edit" data-edit-value="${escapeHtml(valueId)}" aria-label="Edit Type ${escapeHtml(label)}${isSystemKind ? ' (system type)' : ''}">
                    <span class="catalog-value-dot" style="background:${safeCssColor(value.Color)}"></span>
                    <span class="catalog-kind-name">${escapeHtml(label)}</span>
                    <span class="catalog-kind-code">${escapeHtml(value.Key || value.Code || '')}</span>
                    <span class="catalog-kind-group">Default: ${escapeHtml(groupLabel)}</span>
                    <span class="catalog-kind-count">${formatAssetCount(assetCount)}</span>
                    ${isSystemKind ? '<span class="catalog-kind-system">System Type</span>' : ''}
                </button>
                ${isSystemKind ? '' : `<button type="button" class="catalog-inline-archive" data-archive-value="${escapeHtml(valueId)}" aria-label="Archive Type ${escapeHtml(label)}" title="Archive Type">&times;</button>`}
            </div>`;
    }).join('');
}

export function renderBoard(assetGroups, assets, allAssets = assets) {
    const groups = sortValues(assetGroups);
    const activeAssets = sortAssets(assets);
    const allActiveAssets = sortAssets(allAssets);
    const assetKinds = getAssetKinds();
    const lanes = groups.map(assetGroup => {
        const groupAssets = activeAssets.filter(asset =>
            String(getAssetGroupForAsset(asset, assetKinds, groups)?.Id || '') === String(assetGroup.Id));
        return renderAssetGroupLane(assetGroup, groupAssets);
    });
    const ungroupedAssets = activeAssets.filter(asset => {
        return !getAssetGroupForAsset(asset, assetKinds, groups);
    });
    lanes.push(renderUnassignedLane(ungroupedAssets));
    return `<p id="asset-catalogue-drag-status" class="catalog-drag-status" role="status" aria-live="polite"></p>${renderAssetCollectionMessage(allActiveAssets, activeAssets)}${lanes.join('')}`;
}

function renderAssetCollectionMessage(allAssets, visibleAssets) {
    if (visibleAssets.length > 0) return '';
    if (allAssets.length > 0) {
        return '<p class="catalog-empty-message catalog-list-empty" role="status">No assets match these filters. Clear a filter or search term to see the full catalogue.</p>';
    }
    return '<p class="catalog-empty-message catalog-collection-empty" role="status">No assets have been added yet. Use Add Asset to create your first holding.</p>';
}

function renderAssetGroupLane(assetGroup, assets) {
    const label = assetGroup.DisplayName || assetGroup.Key || assetGroup.Code;
    const valueId = String(assetGroup.Id);
    return `
        <section class="catalog-lane" aria-label="${escapeHtml(label)} asset group">
            <div class="catalog-lane-header">
                <button class="catalog-lane-title" type="button" data-edit-value="${escapeHtml(valueId)}" aria-label="Edit asset group ${escapeHtml(label)}">
                    <span class="catalog-value-dot" style="background:${safeCssColor(assetGroup.Color)}"></span>
                    <span>${escapeHtml(label)}</span>
                </button>
                <span class="catalog-lane-count">${formatAssetCount(assets.length)}</span>
            </div>
            <div class="catalog-lane-dropzone" role="list" data-drop-group-id="${escapeHtml(valueId)}" aria-dropeffect="none" aria-label="${escapeHtml(label)} assets">
                ${renderLaneAssets(assets)}
            </div>
        </section>`;
}

function renderUnassignedLane(assets) {
    return `
        <section class="catalog-lane catalog-lane-unassigned" aria-label="Assets without an asset group">
            <div class="catalog-lane-header">
                <div class="catalog-lane-title catalog-lane-title-static">
                    <span class="catalog-value-dot" style="background:#64748b"></span>
                    <span>No Group</span>
                </div>
                <span class="catalog-lane-count">${formatAssetCount(assets.length)}</span>
            </div>
            <div class="catalog-lane-dropzone" role="list" data-drop-group-id="${NO_GROUP_FILTER}" aria-dropeffect="none" aria-label="Assets without an asset group">
                ${renderLaneAssets(assets, 'No assets are assigned here')}
            </div>
        </section>`;
}

function renderLaneAssets(assets, emptyMessage = 'No assets in this group') {
    if (!assets.length) return `<span class="catalog-drop-hint">${emptyMessage}</span>`;
    return assets.map(renderAsset).join('');
}

function renderAsset(asset) {
    const label = asset.DisplayName || asset.Name || 'Unnamed asset';
    const kind = findAssetKind(asset);
    const kindLabel = kind?.DisplayName || kind?.Key || asset.AssetKindCode || 'Unclassified';
    const valueId = String(asset.Id);
    return `
        <div class="catalog-asset catalog-value-pill" data-edit-value="${escapeHtml(valueId)}" data-asset-id="${escapeHtml(valueId)}" role="button" tabindex="0" draggable="true" aria-grabbed="false" aria-label="Edit asset ${escapeHtml(label)}. Drag to move it to another Group.">
            <span class="catalog-value-dot" style="background:${safeCssColor(kind?.Color || asset.Color)}"></span>
            <span class="catalog-asset-name">${escapeHtml(label)}</span>
            <span class="catalog-asset-kind">${escapeHtml(kindLabel)}</span>
            <button type="button" class="catalog-inline-move" data-move-asset="${escapeHtml(valueId)}" aria-label="Move asset ${escapeHtml(label)}" title="Move asset">↔</button>
            <button type="button" class="catalog-inline-archive" data-archive-value="${escapeHtml(valueId)}" aria-label="Archive asset ${escapeHtml(label)}" title="Archive asset">&times;</button>
        </div>`;
}

function renderAssetList(assets, assetKinds, assetGroups, allAssets = assets) {
    if (!assets.length) return renderAssetCollectionMessage(sortAssets(allAssets), assets);

    const rows = assets.map(asset => {
        const label = asset.DisplayName || asset.Name || 'Unnamed asset';
        const kind = findAssetKind(asset, assetKinds);
        const group = getAssetGroupForAsset(asset, assetKinds, assetGroups);
        const kindLabel = kind?.DisplayName || kind?.Key || kind?.Code || 'Unclassified';
        const groupLabel = group?.DisplayName || group?.Key || group?.Code || 'No Group';
        const valueId = String(asset.Id);
        const needsAttention = isUnclassifiedAssetKind(kind);
        return `
            <div class="catalog-list-row${needsAttention ? ' catalog-list-row-attention' : ''}" data-edit-value="${escapeHtml(valueId)}" role="button" tabindex="0" aria-label="Edit asset ${escapeHtml(label)}">
                <span class="catalog-list-asset"><span class="catalog-value-dot" style="background:${safeCssColor(kind?.Color || asset.Color)}"></span><strong>${escapeHtml(label)}</strong></span>
                <span class="catalog-list-type">${escapeHtml(kindLabel)}</span>
                <span class="catalog-list-group">${escapeHtml(groupLabel)}</span>
                <span class="catalog-list-status">${needsAttention ? 'Needs attention' : 'Ready'}</span>
                <span class="catalog-list-actions">
                    <button type="button" class="catalog-list-edit" data-edit-value="${escapeHtml(valueId)}">Edit</button>
                    <button type="button" class="catalog-list-move" data-move-asset="${escapeHtml(valueId)}">Move</button>
                    <button type="button" class="catalog-inline-archive" data-archive-value="${escapeHtml(valueId)}" aria-label="Archive asset ${escapeHtml(label)}" title="Archive asset">&times;</button>
                </span>
            </div>`;
    }).join('');

    return `<div class="catalog-list" role="table" aria-label="Tracked assets">
        <div class="catalog-list-header" role="row">
            <span role="columnheader">Asset</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Group</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Actions</span>
        </div>
        ${rows}
    </div>`;
}

function formatAssetCount(count) {
    return `${count} ${count === 1 ? 'asset' : 'assets'}`;
}

function sortValues(values) {
    return (Array.isArray(values) ? values : []).slice().sort((left, right) => {
        const orderDifference = (Number(left.DisplayOrder) || 0) - (Number(right.DisplayOrder) || 0);
        if (orderDifference !== 0) return orderDifference;
        const labelDifference = String(left.DisplayName || left.Key || left.Code || '')
            .localeCompare(String(right.DisplayName || right.Key || right.Code || ''));
        if (labelDifference !== 0) return labelDifference;
        return String(left.Id || '').localeCompare(String(right.Id || ''));
    });
}

function sortAssets(assets) {
    return (Array.isArray(assets) ? assets : []).slice().sort((left, right) =>
        String(left.DisplayName || left.Name || '').localeCompare(String(right.DisplayName || right.Name || '')));
}

export function renderAssetKindOptions(values, selectedValueId = '') {
    const options = ['<option value="">Select a Type</option>'];
    values.filter(value => !isUnclassifiedAssetKind(value)).forEach(value => {
        const selected = String(value.Id) === String(selectedValueId) ? ' selected' : '';
        options.push(`<option value="${escapeHtml(value.Id)}"${selected}>${escapeHtml(value.DisplayName || value.Key || value.Code)}</option>`);
    });
    return options.join('');
}

function renderAssetGroupOptions(values, selectedValueId = '', { required = false } = {}) {
    const placeholder = required ? 'Select a Group' : 'No Group';
    const options = [`<option value=""${required ? ' disabled' : ''}>${placeholder}</option>`];
    values.forEach(value => {
        const selected = String(value.Id) === String(selectedValueId) ? ' selected' : '';
        options.push(`<option value="${escapeHtml(value.Id)}"${selected}>${escapeHtml(value.DisplayName || value.Key || value.Code)}</option>`);
    });
    return options.join('');
}

function findGroupByKey(key) {
    return (store.state.classificationGroups || []).find(group =>
        normalizeCode(group.Key) === normalizeCode(key));
}

function findValue(valueId) {
    for (const group of store.state.classificationGroups || []) {
        const value = (group.Values || []).find(candidate => String(candidate.Id) === String(valueId));
        if (value) return { group, value };
    }
    return null;
}

function findAsset(assetId) {
    return (store.state.assets || []).find(asset => String(asset.Id) === String(assetId)) || null;
}

function findAssetKind(asset, assetKinds = getAssetKinds()) {
    const kindId = asset?.AssetKindId;
    const kindCode = normalizeCode(asset?.AssetKindCode);
    const fromGroup = (Array.isArray(assetKinds) ? assetKinds : []).find(value =>
        (kindId && String(value.Id) === String(kindId)) ||
        (kindCode && normalizeCode(value.Key || value.Code) === kindCode));
    if (fromGroup) return fromGroup;
    return (asset?.Classifications || []).find(value =>
        normalizeCode(value.GroupKey) === normalizeCode(ASSET_KINDS_KEY) ||
        (kindCode && normalizeCode(value.Key || value.Code) === kindCode)) || null;
}

function getAssetGroupForAsset(asset, assetKinds, assetGroups) {
    if (Object.prototype.hasOwnProperty.call(asset || {}, 'AssetGroupId')) {
        if (asset.AssetGroupId) {
            const directGroup = assetGroups.find(group => String(group.Id) === String(asset.AssetGroupId));
            if (directGroup) return directGroup;
        }
        if (asset.AssetGroupAssignmentSet === true) return null;
    }

    const kind = findAssetKind(asset, assetKinds);
    const groupId = kind?.ParentValueId || kind?.AssetGroupId;
    if (groupId) {
        const byId = assetGroups.find(group => String(group.Id) === String(groupId));
        if (byId) return byId;
    }

    const groupCode = normalizeCode(kind?.AssetGroupCode || asset?.AssetGroupCode);
    return assetGroups.find(group => normalizeCode(group.Key || group.Code) === groupCode) || null;
}

function openValueEditor(valueId, options = {}) {
    const asset = findAsset(valueId);
    if (asset) {
        editorState = {
            id: String(asset.Id),
            name: asset.DisplayName || asset.Name,
            isAssetGroup: false,
            isAssetKind: false,
            isSystemKind: isUnclassifiedAssetKind(findAssetKind(asset)),
            isAsset: true,
            isNewAsset: false,
            originalGroupId: asset.AssetGroupId || getAssetGroupForAsset(asset, getAssetKinds(), sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values))?.Id || ''
        };

        setEditorText('classification-edit-title', 'Edit asset');
        setEditorText('classification-edit-description', 'Update the asset name, Type, or Group independently.');
        setEditorHtml('classification-edit-parent-label', 'Asset Type <em>required</em>');
        setEditorHtml('classification-edit-group-label', 'Asset Group <em>optional</em>');
        setEditorValue('classification-edit-name', asset.DisplayName || asset.Name);
        setEditorValue('classification-edit-order', '');
        setEditorValue('classification-edit-color', '#64748b');
        setEditorVisible('classification-edit-order-field', false);
        setEditorVisible('classification-edit-color-field', false);
        setEditorVisible('classification-edit-parent-field', true);
        setEditorVisible('classification-edit-group-field', true);
        const parent = document.getElementById('classification-edit-parent');
        if (parent) {
            const kinds = sortValues(findGroupByKey(ASSET_KINDS_KEY)?.Values);
            parent.innerHTML = renderAssetKindOptions(
                kinds,
                asset.AssetKindId || findAssetKind(asset)?.Id || '');
        }
        const groupSelect = document.getElementById('classification-edit-group');
        if (groupSelect) {
            groupSelect.innerHTML = renderAssetGroupOptions(
                sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values),
                asset.AssetGroupId || getAssetGroupForAsset(asset, getAssetKinds(), sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values))?.Id || '');
        }
        setEditorText('classification-edit-save', 'Save changes');
    } else {
        const valueInfo = findValue(valueId);
        if (!valueInfo) return;

        const { value } = valueInfo;
        const groupKey = normalizeCode(valueInfo.group.Key);
        if (groupKey === ASSET_GROUPS_KEY) {
            editorState = {
                id: String(value.Id),
                name: value.DisplayName || value.Key,
                isAssetGroup: true,
                isAssetKind: false,
                isSystemKind: false,
                isAsset: false
            };

            setEditorText('classification-edit-title', 'Edit Asset Group');
            setEditorText('classification-edit-description', 'Update the Asset Group name, colour, or display order.');
            setEditorHtml('classification-edit-parent-label', 'Asset Group');
            setEditorValue('classification-edit-parent', '');
            setEditorVisible('classification-edit-group-field', false);
        } else if (groupKey === ASSET_KINDS_KEY) {
            editorState = {
                id: String(value.Id),
                name: value.DisplayName || value.Key,
                isAssetGroup: false,
                isAssetKind: true,
                isSystemKind: isUnclassifiedAssetKind(value),
                isAsset: false
            };

            setEditorText('classification-edit-title', 'Edit Asset Kind');
            setEditorText('classification-edit-description', 'Update the Asset Kind name, colour, display order, or Asset Group.');
            setEditorHtml('classification-edit-parent-label', 'Asset Group <em>optional</em>');
            setEditorValue('classification-edit-parent', value.ParentValueId || '');
            setEditorVisible('classification-edit-group-field', false);
        } else {
            return;
        }

        setEditorValue('classification-edit-name', value.DisplayName || value.Key);
        setEditorValue('classification-edit-order', Number(value.DisplayOrder) || 0);
        setEditorValue('classification-edit-color', safeCssColor(value.Color));
        setEditorText('classification-edit-save', 'Save changes');
        setEditorVisible('classification-edit-order-field', true);
        setEditorVisible('classification-edit-color-field', true);
        setEditorVisible('classification-edit-parent-field', editorState.isAssetKind);
        const parent = document.getElementById('classification-edit-parent');
        if (parent && editorState.isAssetKind) {
            parent.innerHTML = renderAssetGroupOptions(
                sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values),
                value.ParentValueId || '');
        }
    }

    const archive = document.getElementById('classification-edit-archive');
    if (archive) {
        archive.hidden = Boolean(editorState.isSystemKind);
        archive.disabled = Boolean(editorState.isSystemKind);
        archive.textContent = `Archive ${editorState.isAssetGroup ? 'Asset Group' : editorState.isAssetKind ? 'Asset Kind' : 'asset'}`;
        archive.dataset.archiveState = 'idle';
        archive.setAttribute?.('aria-label', `Archive ${editorState.name}`);
    }
    showClassificationEditor(editorState.isAsset && options.focusGroup
        ? 'classification-edit-group'
        : 'classification-edit-name');
}

function getAssetGroupMappingCount(assetGroupId) {
    const groups = sortValues(findGroupByKey(ASSET_GROUPS_KEY)?.Values);
    return (store.state.assets || []).filter(asset =>
        String(getAssetGroupForAsset(asset, getAssetKinds(), groups)?.Id || '') === String(assetGroupId)).length;
}

function getAssetKindMappingCount(assetKindId) {
    return (store.state.assets || []).filter(asset => String(asset.AssetKindId) === String(assetKindId)).length;
}

function normalizeCode(value) {
    return String(value || '').trim().toLowerCase();
}

function isUnclassifiedAssetKind(value) {
    return normalizeCode(value?.Key || value?.Code) === 'unclassified';
}

function showClassificationEditor(focusId = 'classification-edit-name') {
    if (window.openModal) window.openModal('classification-edit-modal');
    else document.getElementById('classification-edit-modal')?.classList.add('active');
    document.getElementById(focusId)?.focus?.();
}

function closeClassificationEditor() {
    editorState = null;
    if (window.closeModal) window.closeModal('classification-edit-modal');
    else document.getElementById('classification-edit-modal')?.classList.remove('active');
}

function setEditorText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function setEditorHtml(id, value) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = value;
}

function setEditorValue(id, value) {
    const element = document.getElementById(id);
    if (element) element.value = value ?? '';
}

function setEditorVisible(id, visible) {
    const element = document.getElementById(id);
    if (element) element.hidden = !visible;
}
