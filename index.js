import { getRequestHeaders } from '../../../../script.js';
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

/** Sources that compute embeddings in the browser. Not supported here. */
const CLIENT_SIDE_SOURCES = ['webllm', 'koboldcpp'];

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
 * Loads a lorebook, applies a mutation to every entry, saves and refreshes the editor.
 * @param {string} name
 * @param {(entry: object) => boolean} mutator Returns true if the entry was changed.
 * @returns {Promise<number>} Number of entries changed.
 */
async function mutateAllEntries(name, mutator) {
    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    let changed = 0;

    for (const entry of Object.values(data.entries)) {
        if (mutator(entry)) {
            changed++;
        }
    }

    if (changed > 0) {
        await saveWorldInfo(name, data, true);
        reloadEditor(name);
    }

    return changed;
}

/**
 * Sets `vectorized: true` on every entry in one lorebook.
 * @param {string} name
 */
async function markBookVectorized(name) {
    return await mutateAllEntries(name, (entry) => {
        if (entry.vectorized === true) {
            return false;
        }
        entry.vectorized = true;
        return true;
    });
}

/**
 * Sets `vectorized: false` on every entry in one lorebook.
 * @param {string} name
 */
async function unmarkBookVectorized(name) {
    return await mutateAllEntries(name, (entry) => {
        if (!entry.vectorized) {
            return false;
        }
        entry.vectorized = false;
        return true;
    });
}

/**
 * Empties primary (and optionally secondary) keyword arrays for every entry.
 * @param {string} name
 * @param {boolean} includeSecondary
 */
async function clearBookKeywords(name, includeSecondary) {
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
                <div class="lvt-buttons">
                    <button id="lvt_clear_keys" class="menu_button lvt-danger">Clear all keywords in this lorebook</button>
                </div>

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
        confirmText: 'This empties the keyword fields for every entry in this lorebook and cannot be undone. Export a backup first if you are unsure.',
        run: async (book) => {
            const includeSecondary = $('#lvt_include_secondary').prop('checked');
            const n = await clearBookKeywords(book, includeSecondary);
            return `Cleared keywords on ${n} entr${n === 1 ? 'y' : 'ies'} in "${book}".`;
        },
    }));

    refreshBookList();
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
