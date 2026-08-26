import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    world_names,
    loadWorldInfo,
    saveWorldInfo,
    reloadEditor,
    setWIOriginalDataValue,
    originalWIDataKeyMap,
} from '../../../world-info.js';
import { getStringHash } from '../../../utils.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../slash-commands/SlashCommandEnumValue.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { oai_settings } from '../../../openai.js';

const MODULE = 'lorebook-vector-tools';
const SETTINGS_KEY = 'lorebookVectorTools';
const MAX_BANKS_PER_BOOK = 10;

/** Sources that compute embeddings in the browser. Not supported here. */
const CLIENT_SIDE_SOURCES = ['webllm', 'koboldcpp'];

// ---------------------------------------------------------------------------
// Keyword banks
//
// A bank is a snapshot of every entry's keywords in one lorebook, stored in
// extension settings so it survives reloads. Entries are matched back by uid
// first, falling back to a content hash so a re-imported book still restores.
// ---------------------------------------------------------------------------

/** @returns {{banks: Record<string, object[]>, autoBank: boolean}} */
function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = { banks: {}, autoBank: true };
    }

    const settings = extension_settings[SETTINGS_KEY];

    if (!settings.banks || typeof settings.banks !== 'object') {
        settings.banks = {};
    }

    if (typeof settings.autoBank !== 'boolean') {
        settings.autoBank = true;
    }

    return settings;
}

/**
 * @param {string} bookName
 * @returns {object[]} Snapshots, newest first.
 */
function getBanks(bookName) {
    const settings = getSettings();
    return Array.isArray(settings.banks[bookName]) ? settings.banks[bookName] : [];
}

/**
 * Snapshots current keywords for a lorebook.
 * @param {string} bookName
 * @param {string} [label]
 * @returns {Promise<{id: string, count: number}>}
 */
async function saveBank(bookName, label) {
    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    const entries = {};
    let count = 0;

    for (const entry of Object.values(data.entries)) {
        const primary = Array.isArray(entry.key) ? entry.key : [];
        const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];

        if (primary.length === 0 && secondary.length === 0) {
            continue;
        }

        entries[String(entry.uid)] = {
            key: [...primary],
            keysecondary: [...secondary],
            contentHash: entry.content ? getStringHash(entry.content) : null,
            comment: entry.comment ?? '',
        };
        count++;
    }

    if (count === 0) {
        throw new Error(`No keywords to bank in "${bookName}".`);
    }

    const snapshot = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label: label || new Date().toLocaleString(),
        savedAt: new Date().toISOString(),
        entryCount: count,
        entries,
    };

    const settings = getSettings();
    const list = getBanks(bookName);
    list.unshift(snapshot);
    settings.banks[bookName] = list.slice(0, MAX_BANKS_PER_BOOK);
    saveSettingsDebounced();

    return { id: snapshot.id, count };
}

/**
 * Restores a snapshot's keywords back onto the lorebook.
 * @param {string} bookName
 * @param {string} bankId
 * @returns {Promise<{restored: number, missing: number}>}
 */
async function restoreBank(bookName, bankId) {
    const snapshot = getBanks(bookName).find(x => x.id === bankId);

    if (!snapshot) {
        throw new Error('That saved keyword set no longer exists.');
    }

    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    const liveEntries = Object.values(data.entries);
    const byHash = new Map();

    for (const entry of liveEntries) {
        if (entry.content) {
            byHash.set(getStringHash(entry.content), entry);
        }
    }

    let restored = 0;
    let missing = 0;

    for (const [uid, saved] of Object.entries(snapshot.entries)) {
        let target = data.entries[uid];

        // uid changed (re-import, dedupe, manual edit) — fall back to content.
        if (!target && saved.contentHash !== null) {
            target = byHash.get(saved.contentHash);
        }

        if (!target) {
            missing++;
            continue;
        }

        target.key = [...saved.key];
        target.keysecondary = [...saved.keysecondary];
        setWIOriginalDataValue(data, target.uid, originalWIDataKeyMap.key, [...saved.key]);
        setWIOriginalDataValue(data, target.uid, originalWIDataKeyMap.keysecondary, [...saved.keysecondary]);
        restored++;
    }

    if (restored > 0) {
        await saveWorldInfo(bookName, data, true);
        reloadEditor(bookName);
    }

    return { restored, missing };
}

/**
 * @param {string} bookName
 * @param {string} bankId
 */
function deleteBank(bookName, bankId) {
    const settings = getSettings();
    settings.banks[bookName] = getBanks(bookName).filter(x => x.id !== bankId);
    saveSettingsDebounced();
}

/**
 * Downloads a snapshot as JSON, so it survives a settings wipe or moves machines.
 * @param {string} bookName
 * @param {string} bankId
 */
function exportBank(bookName, bankId) {
    const snapshot = getBanks(bookName).find(x => x.id === bankId);

    if (!snapshot) {
        throw new Error('That saved keyword set no longer exists.');
    }

    const payload = { format: 'lvt-keyword-bank', version: 1, book: bookName, snapshot };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = bookName.replace(/[^\w\-]+/g, '_');
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}-keywords-${snapshot.id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/**
 * @param {string} bookName
 * @param {File} file
 */
async function importBank(bookName, file) {
    const text = await file.text();
    const payload = JSON.parse(text);

    if (payload?.format !== 'lvt-keyword-bank' || !payload?.snapshot?.entries) {
        throw new Error('That file is not a keyword bank export.');
    }

    const snapshot = payload.snapshot;
    snapshot.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    snapshot.label = `${snapshot.label ?? 'imported'} (imported)`;

    const settings = getSettings();
    const list = getBanks(bookName);
    list.unshift(snapshot);
    settings.banks[bookName] = list.slice(0, MAX_BANKS_PER_BOOK);
    saveSettingsDebounced();

    return snapshot.entryCount ?? Object.keys(snapshot.entries).length;
}

/**
 * Mirrors the Vector Storage extension's request body construction.
 * Kept deliberately close to the original so behaviour matches the built-in sync.
 * @param {string} source
 * @returns {object}
 */
function buildVectorsRequestBody(source) {
    const v = extension_settings.vectors ?? {};
    const body = {};

    switch (source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'ollama':
            body.model = v.ollama_model;
            body.apiUrl = v.use_alt_endpoint
                ? v.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!v.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = v.use_alt_endpoint
                ? v.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            break;
        case 'vllm':
            body.model = v.vllm_model;
            body.apiUrl = v.use_alt_endpoint
                ? v.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            break;
        case 'palm':
            body.model = v.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = v.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        case 'siliconflow':
            body.model = v.siliconflow_model;
            body.siliconflow_endpoint = oai_settings.siliconflow_endpoint;
            break;
        case 'workers_ai':
            body.model = v.workers_ai_model || '@cf/baai/bge-m3';
            body.workers_ai_account_id = oai_settings.workers_ai_account_id;
            break;
        default: {
            // openrouter, openai, cohere, togetherai, electronhub, chutes, nanogpt
            // all follow the same `<source>_model` settings key convention.
            const model = v[`${source}_model`];
            if (model) {
                body.model = model;
            }
            break;
        }
    }

    return body;
}

/** @returns {string} The active vectorization source. */
function getSource() {
    return extension_settings.vectors?.source ?? 'transformers';
}

/**
 * Collection id for a world. Must match the Vector Storage extension exactly,
 * or the built-in retrieval won't find what we insert.
 * @param {string} worldName
 * @returns {string}
 */
function getWorldCollectionId(worldName) {
    return `world_${getStringHash(worldName)}`;
}

/**
 * @param {string} collectionId
 * @returns {Promise<number[]>}
 */
async function getSavedHashes(collectionId) {
    const source = getSource();
    const response = await fetch('/api/vector/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId,
            source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to list hashes for ${collectionId} (HTTP ${response.status})`);
    }

    return await response.json();
}

/**
 * @param {string} collectionId
 * @param {{hash: number, text: string, index: number}[]} items
 */
async function insertVectorItems(collectionId, items) {
    const source = getSource();
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId,
            items,
            source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to insert items into ${collectionId} (HTTP ${response.status})`);
    }
}

/**
 * @param {string} collectionId
 * @param {number[]} hashes
 */
async function deleteVectorItems(collectionId, hashes) {
    const source = getSource();
    const response = await fetch('/api/vector/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId,
            hashes,
            source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to delete items from ${collectionId} (HTTP ${response.status})`);
    }
}

/**
 * @param {string} collectionId
 */
async function purgeCollection(collectionId) {
    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ collectionId }),
    });

    if (!response.ok) {
        throw new Error(`Failed to purge ${collectionId} (HTTP ${response.status})`);
    }
}

/** @returns {string} Currently selected lorebook name in the extension dropdown. */
function getSelectedBook() {
    return String($('#lvt_book_select').val() ?? '');
}

/**
 * Sets every entry in one lorebook to the Vectorized (🔗) state.
 *
 * The entry state is tri-state: constant / normal / vectorized are mutually
 * exclusive, and the UI reads `constant` first. So setting `vectorized` alone
 * leaves a constant entry still showing 🔵 — `constant` has to be cleared too.
 * @param {string} name
 */
async function markBookVectorized(name) {
    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    let changed = 0;

    for (const entry of Object.values(data.entries)) {
        if (entry.vectorized === true && entry.constant !== true) {
            continue;
        }

        entry.constant = false;
        entry.vectorized = true;
        setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap.constant, false);
        setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap.vectorized, true);
        changed++;
    }

    if (changed > 0) {
        await saveWorldInfo(name, data, true);
        reloadEditor(name);
    }

    return changed;
}

/**
 * Returns every entry in one lorebook to the Normal (🟢) state.
 * @param {string} name
 */
async function unmarkBookVectorized(name) {
    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    let changed = 0;

    for (const entry of Object.values(data.entries)) {
        if (!entry.vectorized) {
            continue;
        }

        entry.vectorized = false;
        setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap.vectorized, false);
        changed++;
    }

    if (changed > 0) {
        await saveWorldInfo(name, data, true);
        reloadEditor(name);
    }

    return changed;
}

/**
 * Empties primary (and optionally secondary) keyword arrays for every entry.
 * @param {string} name
 * @param {boolean} includeSecondary
 */
async function clearBookKeywords(name, includeSecondary) {
    // Snapshot first, so a mistaken clear is always recoverable.
    if (getSettings().autoBank) {
        try {
            await saveBank(name, `auto-backup before clear`);
        } catch (error) {
            // Nothing to bank (no keywords) is fine; anything else is worth knowing.
            console.debug(`${MODULE}: auto-bank skipped —`, error.message);
        }
    }

    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    let changed = 0;

    for (const entry of Object.values(data.entries)) {
        const hadPrimary = Array.isArray(entry.key) && entry.key.length > 0;
        const hadSecondary = Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0;

        if (!hadPrimary && !(includeSecondary && hadSecondary)) {
            continue;
        }

        if (hadPrimary) {
            entry.key = [];
            setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap.key, []);
        }

        if (includeSecondary && hadSecondary) {
            entry.keysecondary = [];
            setWIOriginalDataValue(data, entry.uid, originalWIDataKeyMap.keysecondary, []);
        }

        changed++;
    }

    if (changed > 0) {
        await saveWorldInfo(name, data, true);
        reloadEditor(name);
    }

    return changed;
}

/**
 * Pushes embeddings for one lorebook into its vector collection immediately,
 * instead of waiting for the next generation to trigger a lazy sync.
 * @param {string} name
 * @returns {Promise<{inserted: number, deleted: number, skipped: number}>}
 */
async function vectorizeBook(name) {
    const source = getSource();

    if (CLIENT_SIDE_SOURCES.includes(source)) {
        throw new Error(`Source "${source}" computes embeddings in the browser and isn't supported here. Switch to a server-side source.`);
    }

    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    const enabledForAll = !!extension_settings.vectors?.enabled_for_all;
    const eligible = [];
    let skipped = 0;

    for (const entry of Object.values(data.entries)) {
        if (entry.disable || !entry.content) {
            skipped++;
            continue;
        }

        if (!entry.vectorized && !enabledForAll) {
            skipped++;
            continue;
        }

        eligible.push(entry);
    }

    if (eligible.length === 0) {
        return { inserted: 0, deleted: 0, skipped };
    }

    const collectionId = getWorldCollectionId(name);
    const existingHashes = await getSavedHashes(collectionId);

    const newEntries = eligible.filter(x => !existingHashes.includes(getStringHash(x.content)));
    const staleHashes = existingHashes.filter(h => !eligible.some(e => getStringHash(e.content) === h));

    if (newEntries.length > 0) {
        await insertVectorItems(
            collectionId,
            newEntries.map(x => ({
                hash: getStringHash(x.content),
                text: x.content,
                index: x.uid,
            })),
        );
    }

    if (staleHashes.length > 0) {
        await deleteVectorItems(collectionId, staleHashes);
    }

    return { inserted: newEntries.length, deleted: staleHashes.length, skipped };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function refreshBookList() {
    const select = $('#lvt_book_select');
    const previous = String(select.val() ?? '');
    select.empty();
    select.append('<option value="">-- select a lorebook --</option>');

    for (const name of world_names) {
        select.append($('<option></option>').val(name).text(name));
    }

    if (previous && world_names.includes(previous)) {
        select.val(previous);
    }
}

function refreshBankList() {
    const select = $('#lvt_bank_select');
    const previous = String(select.val() ?? '');
    const book = getSelectedBook();
    select.empty();

    const banks = book ? getBanks(book) : [];

    if (banks.length === 0) {
        select.append('<option value="">-- no saved keyword sets --</option>');
        return;
    }

    for (const bank of banks) {
        const count = bank.entryCount ?? Object.keys(bank.entries ?? {}).length;
        select.append(
            $('<option></option>')
                .val(bank.id)
                .text(`${bank.label} — ${count} entries`),
        );
    }

    if (previous && banks.some(x => x.id === previous)) {
        select.val(previous);
    }
}

function setBusy(busy) {
    $('#lvt_panel button').prop('disabled', busy);
    $('#lvt_status').toggleClass('lvt_busy', busy);
}

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [kind]
 */
function setStatus(message, kind = 'info') {
    $('#lvt_status')
        .removeClass('lvt_ok lvt_err')
        .addClass(kind === 'success' ? 'lvt_ok' : kind === 'error' ? 'lvt_err' : '')
        .text(message);
}

/**
 * Wraps an action with book validation, confirmation, busy state and error reporting.
 * @param {{ confirmHeader?: string, confirmText?: string, run: (book: string) => Promise<string> }} options
 */
async function runAction({ confirmHeader, confirmText, run }) {
    const book = getSelectedBook();

    if (!book) {
        setStatus('Pick a lorebook first.', 'error');
        return;
    }

    if (confirmHeader) {
        const result = await Popup.show.confirm(confirmHeader, confirmText);
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
    }

    try {
        setBusy(true);
        setStatus('Working...');
        const message = await run(book);
        setStatus(message, 'success');
        toastr.success(message, 'Lorebook Vector Tools');
    } catch (error) {
        console.error(`${MODULE}:`, error);
        setStatus(String(error.message ?? error), 'error');
        toastr.error(String(error.message ?? error), 'Lorebook Vector Tools');
    } finally {
        setBusy(false);
    }
}

function addSettingsPanel() {
    const html = `
    <div id="lvt_panel" class="lvt-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lorebook Vector Tools</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="lvt_book_select">Lorebook</label>
                <div class="lvt-row">
                    <select id="lvt_book_select" class="text_pole flex1"></select>
                    <div id="lvt_refresh" class="menu_button fa-solid fa-rotate" title="Refresh list"></div>
                </div>

                <div class="lvt-section-label">Vectorising</div>
                <div class="lvt-buttons">
                    <button id="lvt_mark" class="menu_button">Mark all entries vectorized</button>
                    <button id="lvt_unmark" class="menu_button">Unmark all entries</button>
                    <button id="lvt_vectorize" class="menu_button">Vectorize this lorebook now</button>
                    <button id="lvt_purge" class="menu_button lvt-danger">Purge this lorebook's vectors</button>
                </div>

                <div class="lvt-section-label">Keywords</div>
                <label class="checkbox_label" for="lvt_include_secondary">
                    <input id="lvt_include_secondary" type="checkbox" checked>
                    <span>Also clear secondary keywords</span>
                </label>
                <label class="checkbox_label" for="lvt_auto_bank">
                    <input id="lvt_auto_bank" type="checkbox" checked>
                    <span>Auto-save keywords before clearing</span>
                </label>
                <div class="lvt-buttons">
                    <button id="lvt_clear_keys" class="menu_button lvt-danger">Clear all keywords in this lorebook</button>
                </div>

                <div class="lvt-section-label">Saved keyword sets</div>
                <div class="lvt-row">
                    <select id="lvt_bank_select" class="text_pole flex1"></select>
                </div>
                <div class="lvt-buttons">
                    <button id="lvt_bank_save" class="menu_button">Save current keywords</button>
                    <button id="lvt_bank_restore" class="menu_button">Restore selected set</button>
                    <button id="lvt_bank_export" class="menu_button">Export selected to file</button>
                    <button id="lvt_bank_import" class="menu_button">Import from file</button>
                    <button id="lvt_bank_delete" class="menu_button lvt-danger">Delete selected set</button>
                </div>
                <input id="lvt_bank_file" type="file" accept="application/json,.json" hidden>

                <div id="lvt_status" class="lvt-status"></div>
                <small class="lvt-note">
                    Entries only activate by similarity if they're marked vectorized.
                    Clearing keywords is permanent — export a backup first.
                </small>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#lvt_refresh').on('click', () => {
        refreshBookList();
        setStatus('List refreshed.');
    });

    $('#lvt_mark').on('click', () => runAction({
        run: async (book) => {
            const n = await markBookVectorized(book);
            return `Marked ${n} entr${n === 1 ? 'y' : 'ies'} as vectorized in "${book}".`;
        },
    }));

    $('#lvt_unmark').on('click', () => runAction({
        confirmHeader: 'Unmark all entries?',
        confirmText: 'Every entry in this lorebook will go back to keyword-only activation.',
        run: async (book) => {
            const n = await unmarkBookVectorized(book);
            return `Unmarked ${n} entr${n === 1 ? 'y' : 'ies'} in "${book}".`;
        },
    }));

    $('#lvt_vectorize').on('click', () => runAction({
        run: async (book) => {
            const { inserted, deleted, skipped } = await vectorizeBook(book);
            if (inserted === 0 && deleted === 0) {
                return `"${book}" is already up to date (${skipped} entr${skipped === 1 ? 'y' : 'ies'} skipped).`;
            }
            return `"${book}": ${inserted} embedded, ${deleted} stale removed, ${skipped} skipped.`;
        },
    }));

    $('#lvt_purge').on('click', () => runAction({
        confirmHeader: 'Purge vectors?',
        confirmText: 'Deletes the stored embeddings for this lorebook. The entries themselves are untouched — they will be re-embedded next time.',
        run: async (book) => {
            await purgeCollection(getWorldCollectionId(book));
            return `Purged vectors for "${book}".`;
        },
    }));

    $('#lvt_clear_keys').on('click', () => runAction({
        confirmHeader: 'Clear all keywords?',
        confirmText: 'This empties the keyword fields for every entry in this lorebook. With auto-save on, a restorable copy is banked first.',
        run: async (book) => {
            const includeSecondary = $('#lvt_include_secondary').prop('checked');
            const n = await clearBookKeywords(book, includeSecondary);
            refreshBankList();
            return `Cleared keywords on ${n} entr${n === 1 ? 'y' : 'ies'} in "${book}".`;
        },
    }));

    $('#lvt_auto_bank')
        .prop('checked', getSettings().autoBank)
        .on('input', function () {
            getSettings().autoBank = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#lvt_book_select').on('change', () => {
        refreshBankList();
        setStatus('');
    });

    $('#lvt_bank_save').on('click', () => runAction({
        run: async (book) => {
            const label = await Popup.show.input('Name this keyword set', 'Optional — leave blank for a timestamp.', '');
            if (label === null) {
                throw new Error('Cancelled.');
            }
            const { count } = await saveBank(book, label);
            refreshBankList();
            return `Banked keywords from ${count} entr${count === 1 ? 'y' : 'ies'} in "${book}".`;
        },
    }));

    $('#lvt_bank_restore').on('click', () => runAction({
        confirmHeader: 'Restore keywords?',
        confirmText: 'Overwrites the current keywords on any entry present in the saved set.',
        run: async (book) => {
            const bankId = String($('#lvt_bank_select').val() ?? '');
            if (!bankId) {
                throw new Error('No saved set selected.');
            }
            const { restored, missing } = await restoreBank(book, bankId);
            const tail = missing > 0 ? ` ${missing} saved entr${missing === 1 ? 'y' : 'ies'} no longer exist.` : '';
            return `Restored keywords to ${restored} entr${restored === 1 ? 'y' : 'ies'}.${tail}`;
        },
    }));

    $('#lvt_bank_export').on('click', () => runAction({
        run: async (book) => {
            const bankId = String($('#lvt_bank_select').val() ?? '');
            if (!bankId) {
                throw new Error('No saved set selected.');
            }
            exportBank(book, bankId);
            return 'Exported.';
        },
    }));

    $('#lvt_bank_import').on('click', () => {
        if (!getSelectedBook()) {
            setStatus('Pick a lorebook first.', 'error');
            return;
        }
        $('#lvt_bank_file').val('').trigger('click');
    });

    $('#lvt_bank_file').on('change', function () {
        const file = this.files?.[0];
        if (!file) {
            return;
        }
        runAction({
            run: async (book) => {
                const count = await importBank(book, file);
                refreshBankList();
                return `Imported a set of ${count} entr${count === 1 ? 'y' : 'ies'}. Restore it to apply.`;
            },
        });
    });

    $('#lvt_bank_delete').on('click', () => runAction({
        confirmHeader: 'Delete saved set?',
        confirmText: 'This removes the snapshot. Your lorebook is not changed.',
        run: async (book) => {
            const bankId = String($('#lvt_bank_select').val() ?? '');
            if (!bankId) {
                throw new Error('No saved set selected.');
            }
            deleteBank(book, bankId);
            refreshBankList();
            return 'Deleted.';
        },
    }));

    refreshBookList();
    refreshBankList();
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommands() {
    const bookArgument = () => SlashCommandArgument.fromProps({
        description: 'lorebook name',
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired: true,
        enumProvider: () => world_names.map(name => new SlashCommandEnumValue(name)),
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-mark',
        helpString: 'Marks every entry in the named lorebook as vectorized.',
        returns: 'number of entries changed',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const n = await markBookVectorized(String(value));
            return String(n);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-unmark',
        helpString: 'Unmarks every entry in the named lorebook (back to keyword-only).',
        returns: 'number of entries changed',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const n = await unmarkBookVectorized(String(value));
            return String(n);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-clearkeys',
        helpString: 'Clears all keywords (primary and secondary) in the named lorebook. Not reversible.',
        returns: 'number of entries changed',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const n = await clearBookKeywords(String(value), true);
            return String(n);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-vectorize',
        helpString: 'Immediately embeds the vectorized entries of the named lorebook.',
        returns: 'number of entries embedded',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const { inserted } = await vectorizeBook(String(value));
            return String(inserted);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-bank',
        helpString: 'Saves a snapshot of the named lorebook\'s keywords.',
        returns: 'number of entries banked',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const { count } = await saveBank(String(value));
            refreshBankList();
            return String(count);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-restore',
        helpString: 'Restores the most recent saved keyword set for the named lorebook.',
        returns: 'number of entries restored',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const book = String(value);
            const latest = getBanks(book)[0];
            if (!latest) {
                throw new Error(`No saved keyword sets for "${book}".`);
            }
            const { restored } = await restoreBank(book, latest.id);
            return String(restored);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-purge',
        helpString: 'Deletes stored embeddings for the named lorebook.',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            await purgeCollection(getWorldCollectionId(String(value)));
            return '';
        },
    }));
}

jQuery(async () => {
    addSettingsPanel();
    registerCommands();
    console.log(`${MODULE}: loaded`);
});
