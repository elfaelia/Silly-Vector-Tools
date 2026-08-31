import { getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
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
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
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

/** @returns {{banks: Record<string, object[]>, autoBank: boolean, groupUndo: Record<string, object>}} */
function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = { banks: {}, autoBank: true, autoSync: false, groupUndo: {} };
    }

    const settings = extension_settings[SETTINGS_KEY];

    if (!settings.banks || typeof settings.banks !== 'object') {
        settings.banks = {};
    }

    if (!settings.groupUndo || typeof settings.groupUndo !== 'object') {
        settings.groupUndo = {};
    }

    if (typeof settings.autoSync !== 'boolean') {
        settings.autoSync = false;
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

// ---------------------------------------------------------------------------
// Activation log
//
// Two events fire per generation:
//   WORLDINFO_FORCE_ACTIVATE — emitted by the vectors extension, semantic hits only
//   WORLD_INFO_ACTIVATED     — emitted by world-info.js, everything that fired
// Force-activate always lands first, so we stash it and diff against the full
// set to work out which entries came from keywords instead.
// ---------------------------------------------------------------------------

/** @type {{world: string, uid: number, comment: string, source: string}[]} */
let lastActivation = [];
/** @type {Set<string>} */
let pendingVectorKeys = new Set();
let lastActivationAt = null;
let sawActivationThisGeneration = false;
/** Query text as the vectors extension builds it — last N non-empty messages. */
let lastQueryText = '';

/**
 * Rebuilds the vector query string. Mirrors getQueryText() in the vectors
 * extension: newest messages first, empties dropped, capped at "Query messages".
 * @returns {string}
 */
function buildQueryText() {
    const chat = getContext()?.chat ?? [];
    const count = Number(extension_settings.vectors?.query) || 2;

    return chat
        .map(x => String(x?.mes ?? '').trim())
        .filter(Boolean)
        .reverse()
        .slice(0, count)
        .join('\n')
        .trim();
}

/**
 * Re-runs the query with no threshold to find where an entry placed.
 * The API discards similarity scores, but returns hashes best-match-first,
 * so position is the closest thing to a score available.
 * @param {string} world
 * @param {number} contentHash
 * @returns {Promise<{rank: number, total: number}>}
 */
async function getEntryRank(world, contentHash) {
    const source = getSource();
    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId: getWorldCollectionId(world),
            searchText: lastQueryText,
            topK: 100,
            threshold: 0,
            source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Query failed (HTTP ${response.status})`);
    }

    const result = await response.json();
    const hashes = Array.isArray(result?.hashes) ? result.hashes : [];
    const index = hashes.indexOf(contentHash);

    return { rank: index < 0 ? -1 : index + 1, total: hashes.length };
}

/**
 * @param {object} entry
 * @returns {string}
 */
function entryKey(entry) {
    return `${entry.world}.${entry.uid}`;
}

/**
 * Short display name. Entries without a title fall back to keywords, and some
 * lorebooks have dozens of them, so this stays hard-capped — the full text goes
 * in the tooltip instead.
 * @param {object} entry
 * @returns {string}
 */
function entryLabel(entry) {
    if (entry.comment) {
        return truncate(entry.comment, 48);
    }

    if (Array.isArray(entry.key) && entry.key.length > 0) {
        const shown = entry.key.slice(0, 3).join(', ');
        const rest = entry.key.length - 3;
        return truncate(rest > 0 ? `${shown} +${rest}` : shown, 48);
    }

    const content = String(entry.content ?? '').replace(/\s+/g, ' ').trim();
    return content ? truncate(content, 48) : `uid ${entry.uid}`;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** @type {string[]} Rolling log of raw events, newest last. */
let eventTrace = [];

/**
 * @param {string} line
 */
function trace(line) {
    const stamp = new Date().toLocaleTimeString();
    eventTrace.push(`${stamp} ${line}`);
    eventTrace = eventTrace.slice(-25);
    renderTrace();
}

function renderTrace() {
    const container = $('#lvt_trace');

    if (container.length === 0) {
        return;
    }

    container.empty();

    if (eventTrace.length === 0) {
        container.append('<div class="lvt-log-empty">No events yet.</div>');
        return;
    }

    for (const line of [...eventTrace].reverse()) {
        container.append($('<div class="lvt-trace-row"></div>').text(line));
    }
}

function initActivationTracking() {
    // WORLD_INFO_ACTIVATED is guarded by `size > 0` upstream, so a generation
    // where nothing fires emits nothing. Without an explicit per-generation
    // reset, stale vector keys survive and mislabel the next turn's keyword
    // hits as 🔗, and the panel keeps showing the previous turn's results.
    eventSource.on(event_types.GENERATION_STARTED, () => {
        pendingVectorKeys = new Set();
        sawActivationThisGeneration = false;
        lastQueryText = buildQueryText();
        trace('GENERATION_STARTED');
    });

    eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE, (entries) => {
        trace(`FORCE_ACTIVATE: ${Array.isArray(entries) ? entries.length : 'not-an-array'}`);
        if (!Array.isArray(entries)) {
            return;
        }
        for (const entry of entries) {
            pendingVectorKeys.add(entryKey(entry));
        }
    });

    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        trace(`WI_ACTIVATED: ${Array.isArray(entries) ? entries.length : 'not-an-array'}`);
        if (!Array.isArray(entries)) {
            return;
        }

        sawActivationThisGeneration = true;

        lastActivation = entries.map(entry => ({
            world: entry.world ?? '(unknown)',
            uid: entry.uid,
            comment: entryLabel(entry),
            full: entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : ''),
            keys: Array.isArray(entry.key) ? [...entry.key] : [],
            contentHash: entry.content ? getStringHash(entry.content) : null,
            source: entry.constant === true
                ? 'constant'
                : pendingVectorKeys.has(entryKey(entry))
                    ? 'vector'
                    : 'keyword',
        }));

        lastActivationAt = new Date();
        renderActivationLog();
    });

    for (const endEvent of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        eventSource.on(endEvent, () => {
            trace(`${endEvent} (activated: ${sawActivationThisGeneration})`);
            if (sawActivationThisGeneration) {
                return;
            }
            // Nothing activated this turn — say so rather than leaving stale rows up.
            lastActivation = [];
            lastActivationAt = new Date();
            renderActivationLog();
        });
    }
}

/**
 * Detailed list inside the extension settings panel.
 */
function renderActivationLog() {
    const container = $('#lvt_activation_log');

    if (container.length === 0) {
        return;
    }

    container.empty();

    if (lastActivation.length === 0) {
        container.append('<div class="lvt-log-empty">Nothing yet — send a message.</div>');
        return;
    }

    const counts = countBySource();
    const time = lastActivationAt ? lastActivationAt.toLocaleTimeString() : '';

    container.append(
        $('<div class="lvt-log-head"></div>').text(
            `${lastActivation.length} fired · ${counts.vector} vector · ${counts.keyword} keyword · ${counts.constant} constant · ${time}`,
        ),
    );

    for (const item of sortedActivation()) {
        const row = $('<div class="lvt-log-row"></div>');
        row.append($('<span class="lvt-log-badge"></span>').text(badgeFor(item.source)));
        row.append($('<span class="lvt-log-name"></span>').text(item.comment));
        row.append($('<span class="lvt-log-world"></span>').text(item.world));

        // No hover on touch, so tapping a row swaps the truncated label for the
        // full text and reveals why the entry fired.
        const short = item.comment;
        const long = item.full || item.comment;
        const details = $('<div class="lvt-log-details"></div>').hide();

        row.on('click', function () {
            const expanded = $(this).toggleClass('lvt-expanded').hasClass('lvt-expanded');
            $(this).find('.lvt-log-name').text(expanded ? long : short);
            details.toggle(expanded);

            if (expanded && !details.data('filled')) {
                details.data('filled', true);
                fillDetails(details, item);
            }
        });

        container.append(row);
        container.append(details);
    }
}

/**
 * Explains why one entry fired. Keyword hits get the matched terms; vector hits
 * get a rank, since no single word triggers them.
 * @param {JQuery} container
 * @param {object} item
 */
async function fillDetails(container, item) {
    container.empty();

    if (item.source === 'constant') {
        container.append('<div class="lvt-detail">🔵 Constant — always inserted, no matching involved.</div>');
        return;
    }

    if (item.source === 'keyword') {
        const haystack = lastQueryText.toLowerCase();
        const hits = item.keys.filter(k => k && haystack.includes(String(k).toLowerCase()));

        container.append(
            $('<div class="lvt-detail"></div>').text(
                hits.length > 0
                    ? `🟢 Matched: ${hits.join(', ')}`
                    : '🟢 Keyword match — the matched term is outside the last messages shown here (scan depth covers more).',
            ),
        );

        if (item.keys.length > 0) {
            container.append($('<div class="lvt-detail lvt-detail-dim"></div>').text(`Keys: ${item.keys.join(', ')}`));
        }
        return;
    }

    container.append('<div class="lvt-detail">🔗 No trigger word — matched by similarity against the whole recent conversation.</div>');

    if (item.contentHash === null) {
        return;
    }

    const rankLine = $('<div class="lvt-detail lvt-detail-dim">Checking rank…</div>');
    container.append(rankLine);

    try {
        const { rank, total } = await getEntryRank(item.world, item.contentHash);
        rankLine.text(
            rank < 0
                ? 'Rank unavailable — entry not in the current query results.'
                : `Ranked ${rank} of ${total} in its lorebook for this query.`,
        );
    } catch (error) {
        rankLine.text(`Rank lookup failed: ${error.message}`);
    }
}

/** @returns {{vector: number, keyword: number, constant: number}} */
function countBySource() {
    return {
        vector: lastActivation.filter(x => x.source === 'vector').length,
        keyword: lastActivation.filter(x => x.source === 'keyword').length,
        constant: lastActivation.filter(x => x.source === 'constant').length,
    };
}

/** Vector hits first — those are the ones worth eyeballing when tuning. */
function sortedActivation() {
    const order = { vector: 0, keyword: 1, constant: 2 };
    return [...lastActivation].sort(
        (a, b) => order[a.source] - order[b.source] || a.comment.localeCompare(b.comment),
    );
}

/**
 * @param {string} source
 * @returns {string}
 */
function badgeFor(source) {
    return source === 'vector' ? '🔗' : source === 'constant' ? '🔵' : '🟢';
}

/**
 * Reads a lorebook straight from the server, bypassing worldInfoCache.
 * Used to verify writes actually landed — the cache would happily report our
 * own in-memory change even if something overwrote the file afterwards.
 * @param {string} name
 */
async function fetchWorldInfoFromServer(name) {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`Could not re-read "${name}" from the server (HTTP ${response.status})`);
    }

    return await response.json();
}

/**
 * @param {string} name
 * @returns {Promise<number>} Entries still holding keywords on disk.
 */
async function countRemainingKeywords(name) {
    const data = await fetchWorldInfoFromServer(name);

    if (!data || !data.entries) {
        return -1;
    }

    return Object.values(data.entries).filter(entry =>
        (Array.isArray(entry.key) && entry.key.length > 0) ||
        (Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0),
    ).length;
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

// ---------------------------------------------------------------------------
// Bulk inclusion grouping
//
// An inclusion group makes its members compete: however many of them match in
// one turn, world-info inserts exactly one winner. That is the lever for "too
// many entries are firing" — the entries keep their keywords, they just stop
// stacking on top of each other.
//
// `group` is a comma-separated string, so an entry can sit in several groups.
// It is the one group field missing from originalWIDataKeyMap, so its
// original-data path is written literally, exactly as the entry editor does.
// ---------------------------------------------------------------------------

const GROUP_ORIGINAL_KEY = 'extensions.group';
const DEFAULT_GROUP_WEIGHT = 100;
/** Undo snapshots live in settings, so they get a sane ceiling. */
const MAX_UNDO_ENTRIES = 2000;

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitTerms(text) {
    return String(text ?? '').split(',').map(x => x.trim()).filter(Boolean);
}

/** @param {string} value @returns {string[]} */
function parseGroups(value) {
    return String(value ?? '').split(',').map(x => x.trim()).filter(Boolean);
}

/** @param {string[]} list @returns {string} */
function formatGroups(list) {
    return [...new Set(list)].join(', ');
}

/** @param {string} text @returns {string} */
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} term
 * @param {{wholeWord: boolean, caseSensitive: boolean}} options
 * @returns {(text: string) => boolean}
 */
function makeTermTester(term, { wholeWord, caseSensitive }) {
    if (!wholeWord) {
        const needle = caseSensitive ? term : term.toLowerCase();
        return text => (caseSensitive ? text : text.toLowerCase()).includes(needle);
    }

    // Built without lookbehind — Safari only picked that up in 16.4, and this
    // runs in whatever browser the phone happens to have.
    const pattern = new RegExp(`(^|[^\\w])${escapeRegex(term)}(?![\\w])`, caseSensitive ? '' : 'i');
    return text => pattern.test(text);
}

/**
 * @param {object} entry
 * @param {{title: boolean, keys: boolean, content: boolean}} scope
 * @returns {string[]}
 */
function entryHaystacks(entry, scope) {
    const parts = [];

    if (scope.title) {
        parts.push(String(entry.comment ?? ''));
    }

    if (scope.keys) {
        const primary = Array.isArray(entry.key) ? entry.key : [];
        const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
        parts.push([...primary, ...secondary].join(' , '));
    }

    if (scope.content) {
        parts.push(String(entry.content ?? ''));
    }

    return parts.filter(Boolean);
}

/**
 * @param {object} data Loaded lorebook.
 * @param {object} options
 * @returns {{entry: object, terms: string[]}[]}
 */
function findGroupMatches(data, options) {
    const { terms, scope } = options;

    if (terms.length === 0) {
        throw new Error('Enter at least one word to match on.');
    }

    if (!scope.title && !scope.keys && !scope.content) {
        throw new Error('Pick at least one place to search: title, keywords or content.');
    }

    const testers = terms.map(term => ({ term, test: makeTermTester(term, options) }));
    const matches = [];

    for (const entry of Object.values(data.entries)) {
        if (options.skipDisabled && entry.disable) {
            continue;
        }

        const haystacks = entryHaystacks(entry, scope);

        if (haystacks.length === 0) {
            continue;
        }

        const hits = testers.filter(t => haystacks.some(h => t.test(h))).map(t => t.term);

        if (hits.length > 0) {
            matches.push({ entry, terms: hits });
        }
    }

    return matches;
}

/**
 * Which group name(s) a match should end up in. A blank group name means
 * "name each group after the word that found it", which is the whole point of
 * passing several words at once.
 *
 * ST allows exactly one winner per group, so "allow N through" is done by
 * splitting the members across N numbered pools — dorm-1, dorm-2 — and letting
 * each pool elect its own winner. Assignment is round-robin over the match
 * order, so entries sitting next to each other in the book (usually the
 * near-duplicates you are trying to thin out) land in different pools.
 * @param {{terms: string[]}} match
 * @param {object} options
 * @param {number} slot Round-robin counter across applied entries.
 * @returns {string[]}
 */
function targetGroupsFor(match, options, slot) {
    const explicit = parseGroups(options.groupName);

    // Replace can only mean one group, so the first word that hit wins.
    const base = explicit.length > 0
        ? explicit
        : options.mode === 'append' ? [...match.terms] : [match.terms[0]];

    const allowed = Number(options.allowPerGroup) || 1;

    if (allowed <= 1) {
        return base;
    }

    return base.map(name => `${name}-${(slot % allowed) + 1}`);
}

const GROUP_FIELDS = ['group', 'groupOverride', 'groupWeight', 'useGroupScoring'];
const PLACEMENT_FIELDS = ['position', 'role', 'depth', 'order'];

/**
 * Stashes the named fields of the entries about to change, so one wrong word
 * in the box isn't a manual repair job across 60 entries. One slot per book,
 * shared by grouping and placement — the label says which it was.
 * @param {string} bookName
 * @param {object[]} entries
 * @param {string[]} fields
 * @param {string} label
 */
function snapshotFields(bookName, entries, fields, label) {
    const settings = getSettings();
    const snapshot = { label, savedAt: new Date().toISOString(), entries: {} };

    for (const entry of entries.slice(0, MAX_UNDO_ENTRIES)) {
        const saved = {};

        for (const field of fields) {
            saved[field] = entry[field] ?? FIELD_DEFAULTS[field] ?? null;
        }

        snapshot.entries[String(entry.uid)] = saved;
    }

    settings.groupUndo[bookName] = snapshot;
    saveSettingsDebounced();
}

/**
 * Falling back to the same defaults world-info.js uses, so "is this actually
 * different?" gives the same answer the editor would.
 */
const FIELD_DEFAULTS = {
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_GROUP_WEIGHT,
    useGroupScoring: null,
    position: 0,
    role: 0,
    depth: 4,
    order: 100,
};

/**
 * Writes entry fields and mirrors them into original data, skipping no-ops.
 * @param {object} data
 * @param {object} entry
 * @param {object} fields
 * @returns {boolean} Whether anything actually changed.
 */
function writeEntryFields(data, entry, fields) {
    let changed = false;

    for (const [key, value] of Object.entries(fields)) {
        const current = entry[key] ?? FIELD_DEFAULTS[key] ?? null;

        if (current === value) {
            continue;
        }

        entry[key] = value;

        // `group` is the one field missing from originalWIDataKeyMap; its path
        // is written literally, exactly as the entry editor does.
        const path = key === 'group' ? GROUP_ORIGINAL_KEY : originalWIDataKeyMap[key];

        if (path) {
            setWIOriginalDataValue(data, entry.uid, path, value);
        }

        changed = true;
    }

    return changed;
}

/**
 * Finds matching entries without touching anything.
 * @param {string} bookName
 * @param {object} options
 * @returns {Promise<{entry: object, terms: string[]}[]>}
 */
async function previewGrouping(bookName, options) {
    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    return findGroupMatches(data, options);
}

/**
 * @param {string} bookName
 * @param {object} options
 * @returns {Promise<{matched: number, changed: number, groups: [string, number][]}>}
 */
async function applyGrouping(bookName, options) {
    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    const matches = findGroupMatches(data, options);

    if (matches.length === 0) {
        throw new Error('Nothing matched — no entries were changed.');
    }

    snapshotFields(bookName, matches.map(x => x.entry), GROUP_FIELDS, options.mode === 'clear'
        ? `before ungrouping "${options.terms.join(', ')}"`
        : `before grouping "${options.terms.join(', ')}"`);

    const counts = new Map();
    let changed = 0;
    let slot = 0;

    for (const match of matches) {
        const entry = match.entry;
        const existing = parseGroups(entry.group);

        if (options.mode === 'clear') {
            if (writeEntryFields(data, entry, {
                group: '',
                groupOverride: false,
                groupWeight: DEFAULT_GROUP_WEIGHT,
                useGroupScoring: null,
            })) {
                changed++;
            }
            continue;
        }

        // "Only ungrouped entries" leaves anything already assigned alone,
        // which is what you want on a second pass over the same book.
        if (options.mode === 'fill' && existing.length > 0) {
            continue;
        }

        const targets = targetGroupsFor(match, options, slot);
        slot++;
        const next = options.mode === 'append' ? [...existing, ...targets] : targets;

        const fields = { group: formatGroups(next) };

        if (options.applySettings) {
            fields.groupOverride = options.prioritize;
            fields.groupWeight = options.weight;
            fields.useGroupScoring = options.scoring;
        }

        if (writeEntryFields(data, entry, fields)) {
            changed++;
        }

        for (const name of targets) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }

    if (changed > 0) {
        await saveWorldInfo(bookName, data, true);
        reloadEditor(bookName);
    }

    return {
        matched: matches.length,
        changed,
        groups: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    };
}

/**
 * Puts the fields back the way they were before the last bulk change.
 * @param {string} bookName
 * @returns {Promise<{restored: number, label: string}>}
 */
async function undoBulkChange(bookName) {
    const snapshot = getSettings().groupUndo[bookName];

    if (!snapshot || !snapshot.entries) {
        throw new Error(`No bulk change to undo for "${bookName}".`);
    }

    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    let restored = 0;

    for (const [uid, saved] of Object.entries(snapshot.entries)) {
        const entry = data.entries[uid];

        if (!entry) {
            continue;
        }

        if (writeEntryFields(data, entry, saved)) {
            restored++;
        }
    }

    if (restored > 0) {
        await saveWorldInfo(bookName, data, true);
        reloadEditor(bookName);
    }

    delete getSettings().groupUndo[bookName];
    saveSettingsDebounced();

    return { restored, label: snapshot.label ?? 'last change' };
}

// ---------------------------------------------------------------------------
// Bulk placement
//
// Position, depth, role and insertion order, applied across a whole book or a
// filtered slice of it. Depth and role only mean anything at position @Depth,
// so they are only written when that is where the entries are heading.
// ---------------------------------------------------------------------------

/** Mirrors world_info_position in world-info.js. */
const WI_POSITION = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
};

const POSITION_LABELS = {
    0: '↑Char',
    1: '↓Char',
    2: '↑AN',
    3: '↓AN',
    4: '@Depth',
    5: '↑EM',
    6: '↓EM',
    7: 'Outlet',
};

/**
 * @param {object} entry
 * @param {string} filter
 * @returns {boolean}
 */
function matchesPlacementFilter(entry, filter) {
    switch (filter) {
        case 'vectorized': return !!entry.vectorized;
        case 'notVectorized': return !entry.vectorized && !entry.constant;
        case 'constant': return !!entry.constant;
        case 'grouped': return parseGroups(entry.group).length > 0;
        default: return true;
    }
}

/**
 * @param {string} bookName
 * @param {object} options
 * @returns {Promise<{entry: object}[]>}
 */
async function findPlacementTargets(bookName, options) {
    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    let entries = Object.values(data.entries);

    if (options.skipDisabled) {
        entries = entries.filter(x => !x.disable);
    }

    entries = entries.filter(x => matchesPlacementFilter(x, options.filter));

    // "Matching the words above" reuses the grouping search box, so one set of
    // words can drive both sections without retyping.
    if (options.filter === 'matching') {
        const matched = new Set(findGroupMatches(data, options).map(x => x.entry.uid));
        entries = entries.filter(x => matched.has(x.uid));
    }

    // Insertion order is only meaningful relative to other entries, so
    // sequential numbering follows the book's own display order.
    entries.sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));

    return { data, entries };
}

/**
 * @param {string} bookName
 * @param {object} options
 * @returns {Promise<{matched: number, changed: number}>}
 */
async function applyPlacement(bookName, options) {
    const { data, entries } = await findPlacementTargets(bookName, options);

    if (entries.length === 0) {
        throw new Error('Nothing matched — no entries were changed.');
    }

    if (!options.setPosition && !options.setDepth && !options.setOrder) {
        throw new Error('Tick at least one of position, depth or insertion order.');
    }

    snapshotFields(bookName, entries, PLACEMENT_FIELDS, `before placement change (${entries.length} entries)`);

    let changed = 0;
    let step = 0;

    for (const entry of entries) {
        const fields = {};
        const position = options.setPosition ? options.position : (entry.position ?? 0);

        if (options.setPosition) {
            fields.position = options.position;
        }

        // Depth and role are @Depth-only in the editor; writing them elsewhere
        // would show values the entry never uses.
        if (position === WI_POSITION.atDepth) {
            if (options.setDepth) {
                fields.depth = options.depth;
            }

            if (options.setPosition) {
                fields.role = options.role;
            }
        }

        if (options.setOrder) {
            fields.order = options.order + (options.orderStep * step);
        }

        if (writeEntryFields(data, entry, fields)) {
            changed++;
        }

        step++;
    }

    if (changed > 0) {
        await saveWorldInfo(bookName, data, true);
        reloadEditor(bookName);
    }

    return { matched: entries.length, changed };
}

/**
 * Current placement spread, so you can see what a book looks like before
 * changing it and confirm afterwards.
 * @param {string} bookName
 * @param {object} options
 * @returns {Promise<{matched: number, rows: {left: string, text: string, right: string}[]}>}
 */
async function summarisePlacement(bookName, options) {
    const { entries } = await findPlacementTargets(bookName, options);
    const counts = new Map();

    for (const entry of entries) {
        const position = entry.position ?? 0;
        const label = position === WI_POSITION.atDepth
            ? `@Depth ${entry.depth ?? FIELD_DEFAULTS.depth} (${['system', 'user', 'assistant'][entry.role ?? 0] ?? 'system'})`
            : POSITION_LABELS[position] ?? `position ${position}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const orders = entries.map(x => x.order ?? FIELD_DEFAULTS.order);
    const rows = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ left: '▤', text: label, right: String(count) }));

    if (orders.length > 0) {
        rows.push({
            left: '#',
            text: `insertion order ${Math.min(...orders)} – ${Math.max(...orders)}`,
            right: `${new Set(orders).size} distinct`,
        });
    }

    return { matched: entries.length, rows };
}

/**
 * @param {string} bookName
 * @returns {Promise<{name: string, count: number, prioritized: number}[]>}
 */
async function listGroups(bookName) {
    const data = await loadWorldInfo(bookName);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${bookName}"`);
    }

    const map = new Map();

    for (const entry of Object.values(data.entries)) {
        for (const name of parseGroups(entry.group)) {
            const row = map.get(name) ?? { name, count: 0, prioritized: 0 };
            row.count++;
            if (entry.groupOverride) {
                row.prioritized++;
            }
            map.set(name, row);
        }
    }

    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Big books choke a single insert call, and batching is what makes progress reportable. */
const VECTOR_BATCH_SIZE = 20;

/**
 * Pushes embeddings for one lorebook into its vector collection immediately,
 * instead of waiting for the next generation to trigger a lazy sync.
 *
 * This is a diff, not a rebuild: entries are keyed by a hash of their content,
 * so unchanged entries are left alone, edited ones get re-embedded and hashes
 * with no matching entry are dropped. Editing one entry in a 300-entry book
 * costs one embedding call, not 300 — no purge needed.
 *
 * @param {string} name
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<{inserted: number, deleted: number, skipped: number, unchanged: number}>}
 */
async function vectorizeBook(name, onProgress = () => {}) {
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
        return { inserted: 0, deleted: 0, skipped, unchanged: 0 };
    }

    const collectionId = getWorldCollectionId(name);
    const existingHashes = await getSavedHashes(collectionId);

    const newEntries = eligible.filter(x => !existingHashes.includes(getStringHash(x.content)));
    const staleHashes = existingHashes.filter(h => !eligible.some(e => getStringHash(e.content) === h));
    const unchanged = eligible.length - newEntries.length;

    console.log(`${MODULE}: "${name}" — ${newEntries.length} to embed, ${unchanged} unchanged, ${staleHashes.length} stale, ${skipped} skipped`);

    if (newEntries.length === 0 && staleHashes.length === 0) {
        console.log(`${MODULE}: "${name}" already up to date`);
        return { inserted: 0, deleted: 0, skipped, unchanged };
    }

    const items = newEntries.map(x => ({
        hash: getStringHash(x.content),
        text: x.content,
        index: x.uid,
    }));

    for (let start = 0; start < items.length; start += VECTOR_BATCH_SIZE) {
        const batch = items.slice(start, start + VECTOR_BATCH_SIZE);
        const done = Math.min(start + batch.length, items.length);

        onProgress(`Embedding ${done}/${items.length} in "${name}"...`);
        console.log(`${MODULE}: "${name}" embedding batch ${done}/${items.length}`);

        await insertVectorItems(collectionId, batch);
    }

    if (staleHashes.length > 0) {
        onProgress(`Removing ${staleHashes.length} stale vectors from "${name}"...`);
        await deleteVectorItems(collectionId, staleHashes);
    }

    console.log(`${MODULE}: "${name}" done — ${newEntries.length} embedded, ${staleHashes.length} removed`);

    return { inserted: newEntries.length, deleted: staleHashes.length, skipped, unchanged };
}

/**
 * Runs the same diff across every lorebook on the server. A book with nothing
 * to do costs one hash lookup, so this stays cheap to run on a whim.
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<{books: number, touched: number, inserted: number, deleted: number, failed: string[]}>}
 */
async function vectorizeAllBooks(onProgress = () => {}) {
    const totals = { books: 0, touched: 0, inserted: 0, deleted: 0, failed: [] };
    const names = [...world_names];

    for (const [index, name] of names.entries()) {
        onProgress(`Checking ${index + 1}/${names.length}: "${name}"...`);
        totals.books++;

        try {
            const result = await vectorizeBook(name, onProgress);
            totals.inserted += result.inserted;
            totals.deleted += result.deleted;

            if (result.inserted > 0 || result.deleted > 0) {
                totals.touched++;
            }
        } catch (error) {
            // One bad book shouldn't abandon the other forty.
            console.error(`${MODULE}: failed to sync "${name}"`, error);
            totals.failed.push(name);
        }
    }

    console.log(`${MODULE}: sync-all finished`, totals);

    return totals;
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
 * @param {{ confirmHeader?: string, confirmText?: string, requireBook?: boolean, run: (book: string) => Promise<string> }} options
 */
async function runAction({ confirmHeader, confirmText, run, requireBook = true }) {
    const book = getSelectedBook();

    if (requireBook && !book) {
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

/**
 * Reads the grouping form into the shape applyGrouping/previewGrouping want.
 * @returns {object}
 */
function readGroupOptions() {
    const scoring = String($('#lvt_group_scoring').val() ?? 'default');
    const weight = Number($('#lvt_group_weight').val());
    const allow = Number($('#lvt_group_allow').val());

    return {
        terms: splitTerms($('#lvt_group_terms').val()),
        groupName: String($('#lvt_group_name').val() ?? '').trim(),
        mode: String($('#lvt_group_mode').val() ?? 'replace'),
        allowPerGroup: Number.isFinite(allow) && allow > 0 ? Math.round(allow) : 1,
        scope: {
            title: $('#lvt_group_in_title').prop('checked'),
            keys: $('#lvt_group_in_keys').prop('checked'),
            content: $('#lvt_group_in_content').prop('checked'),
        },
        wholeWord: $('#lvt_group_whole_word').prop('checked'),
        caseSensitive: $('#lvt_group_case').prop('checked'),
        skipDisabled: $('#lvt_group_skip_disabled').prop('checked'),
        applySettings: $('#lvt_group_apply_settings').prop('checked'),
        prioritize: $('#lvt_group_prioritize').prop('checked'),
        weight: Number.isFinite(weight) && weight > 0 ? Math.round(weight) : DEFAULT_GROUP_WEIGHT,
        scoring: scoring === 'on' ? true : scoring === 'off' ? false : null,
    };
}

/**
 * Reads the placement form. The word/scope boxes are shared with the grouping
 * section, so "entries matching the words above" needs no second search box.
 * @returns {object}
 */
function readPlacementOptions() {
    const number = (selector, fallback) => {
        const value = Number($(selector).val());
        return Number.isFinite(value) ? Math.round(value) : fallback;
    };

    const group = readGroupOptions();

    return {
        ...group,
        filter: String($('#lvt_place_filter').val() ?? 'all'),
        skipDisabled: $('#lvt_place_skip_disabled').prop('checked'),
        setPosition: $('#lvt_place_set_position').prop('checked'),
        position: number('#lvt_place_position', WI_POSITION.atDepth),
        role: number('#lvt_place_role', 0),
        setDepth: $('#lvt_place_set_depth').prop('checked'),
        depth: Math.max(0, number('#lvt_place_depth', FIELD_DEFAULTS.depth)),
        setOrder: $('#lvt_place_set_order').prop('checked'),
        order: Math.max(0, number('#lvt_place_order', FIELD_DEFAULTS.order)),
        orderStep: number('#lvt_place_order_step', 0),
    };
}

/**
 * @param {string} head
 * @param {{left: string, text: string, right: string}[]} rows
 */
function renderPlacementResults(head, rows) {
    renderResultList($('#lvt_place_results'), head, rows);
}

/**
 * @param {string} head
 * @param {{left: string, text: string, right: string}[]} rows
 */
function renderGroupResults(head, rows) {
    renderResultList($('#lvt_group_results'), head, rows);
}

/**
 * @param {JQuery} container
 * @param {string} head
 * @param {{left: string, text: string, right: string}[]} rows
 */
function renderResultList(container, head, rows) {
    if (container.length === 0) {
        return;
    }

    container.empty();
    container.append($('<div class="lvt-log-head"></div>').text(head));

    for (const row of rows) {
        const line = $('<div class="lvt-log-row"></div>');
        line.append($('<span class="lvt-log-badge"></span>').text(row.left));
        line.append($('<span class="lvt-log-name"></span>').text(row.text));
        line.append($('<span class="lvt-log-world"></span>').text(row.right));

        // Same tap-to-expand behaviour as the activation log: titles get long
        // and there is no hover on a phone.
        line.on('click', function () {
            $(this).toggleClass('lvt-expanded');
        });

        container.append(line);
    }
}

// ---------------------------------------------------------------------------
// Auto-sync on save
//
// WORLDINFO_UPDATED fires every time a lorebook is written, including by this
// extension's own bulk tools, so this is debounced and leans on the hash diff
// to make no-op saves cost a single lookup.
// ---------------------------------------------------------------------------

const AUTO_SYNC_DELAY = 4000;
/** @type {Map<string, number>} */
const autoSyncTimers = new Map();
let autoSyncRunning = false;

/** @param {string} name */
function queueAutoSync(name) {
    if (!name || !getSettings().autoSync) {
        return;
    }

    clearTimeout(autoSyncTimers.get(name));

    autoSyncTimers.set(name, setTimeout(async () => {
        autoSyncTimers.delete(name);

        // Editing several books in a row shouldn't overlap embedding calls.
        if (autoSyncRunning) {
            queueAutoSync(name);
            return;
        }

        try {
            autoSyncRunning = true;
            const { inserted, deleted } = await vectorizeBook(name, message => setStatus(message));

            if (inserted > 0 || deleted > 0) {
                const summary = `Auto-synced "${name}": ${inserted} embedded, ${deleted} removed.`;
                setStatus(summary, 'success');
                toastr.success(summary, 'Lorebook Vector Tools');
            }
        } catch (error) {
            console.error(`${MODULE}: auto-sync failed for "${name}"`, error);
            setStatus(`Auto-sync failed for "${name}": ${error.message ?? error}`, 'error');
        } finally {
            autoSyncRunning = false;
        }
    }, AUTO_SYNC_DELAY));
}

function initAutoSync() {
    if (!event_types.WORLDINFO_UPDATED) {
        console.warn(`${MODULE}: this SillyTavern build has no WORLDINFO_UPDATED event, auto-sync unavailable`);
        return;
    }

    eventSource.on(event_types.WORLDINFO_UPDATED, (name) => queueAutoSync(String(name ?? '')));
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
                    <button id="lvt_stats" class="menu_button">Show counts for this lorebook</button>
                    <button id="lvt_mark" class="menu_button">Mark all entries vectorized</button>
                    <button id="lvt_unmark" class="menu_button">Unmark all entries</button>
                    <button id="lvt_vectorize" class="menu_button">Vectorize this lorebook now</button>
                    <button id="lvt_vectorize_all" class="menu_button">Sync every lorebook now</button>
                </div>
                <label class="checkbox_label" for="lvt_auto_sync">
                    <input id="lvt_auto_sync" type="checkbox">
                    <span>Auto-sync a lorebook when it's saved</span>
                </label>
                <div class="lvt-buttons">
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

                <div class="lvt-section-label">Bulk grouping</div>
                <label for="lvt_group_terms">Words to match (comma-separated)</label>
                <input id="lvt_group_terms" class="text_pole" type="text" placeholder="e.g. dorm, cafeteria, infirmary">
                <label for="lvt_group_name">Group name</label>
                <input id="lvt_group_name" class="text_pole" type="text" placeholder="blank = one group per matched word">
                <label for="lvt_group_allow">Let this many through per turn</label>
                <input id="lvt_group_allow" class="text_pole" type="number" min="1" max="20" step="1" value="1">
                <label for="lvt_group_mode">If an entry is already grouped</label>
                <select id="lvt_group_mode" class="text_pole">
                    <option value="replace">Replace its groups</option>
                    <option value="append">Add this group alongside</option>
                    <option value="fill">Leave it alone (only group ungrouped entries)</option>
                </select>
                <div class="lvt-section-label">Look in</div>
                <label class="checkbox_label" for="lvt_group_in_title">
                    <input id="lvt_group_in_title" type="checkbox" checked>
                    <span>Title / memo</span>
                </label>
                <label class="checkbox_label" for="lvt_group_in_keys">
                    <input id="lvt_group_in_keys" type="checkbox" checked>
                    <span>Keywords</span>
                </label>
                <label class="checkbox_label" for="lvt_group_in_content">
                    <input id="lvt_group_in_content" type="checkbox" checked>
                    <span>Content</span>
                </label>
                <label class="checkbox_label" for="lvt_group_whole_word">
                    <input id="lvt_group_whole_word" type="checkbox" checked>
                    <span>Whole words only</span>
                </label>
                <label class="checkbox_label" for="lvt_group_case">
                    <input id="lvt_group_case" type="checkbox">
                    <span>Case sensitive</span>
                </label>
                <label class="checkbox_label" for="lvt_group_skip_disabled">
                    <input id="lvt_group_skip_disabled" type="checkbox" checked>
                    <span>Skip disabled entries</span>
                </label>
                <div class="lvt-section-label">Group settings to apply</div>
                <label class="checkbox_label" for="lvt_group_apply_settings">
                    <input id="lvt_group_apply_settings" type="checkbox" checked>
                    <span>Also set priority / weight / scoring below</span>
                </label>
                <label class="checkbox_label" for="lvt_group_prioritize">
                    <input id="lvt_group_prioritize" type="checkbox">
                    <span>Prioritize (this entry wins its group)</span>
                </label>
                <label for="lvt_group_weight">Group weight</label>
                <input id="lvt_group_weight" class="text_pole" type="number" min="1" max="10000" step="1" value="100">
                <label for="lvt_group_scoring">Group scoring</label>
                <select id="lvt_group_scoring" class="text_pole">
                    <option value="default">Use global setting</option>
                    <option value="on">On — most keyword hits wins</option>
                    <option value="off">Off</option>
                </select>
                <div class="lvt-buttons">
                    <button id="lvt_group_preview" class="menu_button">Preview matches</button>
                    <button id="lvt_group_apply" class="menu_button">Group matching entries</button>
                    <button id="lvt_group_list" class="menu_button">List groups in this lorebook</button>
                    <button id="lvt_group_undo" class="menu_button">Undo last grouping change</button>
                    <button id="lvt_group_clear" class="menu_button lvt-danger">Ungroup matching entries</button>
                </div>
                <div id="lvt_group_results" class="lvt-log lvt-preview"></div>
                <small class="lvt-note">
                    Grouped entries still activate as normal — SillyTavern inserts
                    exactly one member per group per turn. To let more than one
                    through, raise "let this many through" and the matches are split
                    into that many numbered pools, one winner each. Weight decides
                    the odds within a pool; prioritize overrides them.
                </small>

                <div class="lvt-section-label">Bulk placement</div>
                <label for="lvt_place_filter">Apply to</label>
                <select id="lvt_place_filter" class="text_pole">
                    <option value="all">Every entry in this lorebook</option>
                    <option value="vectorized">Vectorized entries only</option>
                    <option value="notVectorized">Keyword-only entries</option>
                    <option value="constant">Constant entries only</option>
                    <option value="grouped">Grouped entries only</option>
                    <option value="matching">Entries matching the words above</option>
                </select>
                <label class="checkbox_label" for="lvt_place_skip_disabled">
                    <input id="lvt_place_skip_disabled" type="checkbox" checked>
                    <span>Skip disabled entries</span>
                </label>

                <label class="checkbox_label" for="lvt_place_set_position">
                    <input id="lvt_place_set_position" type="checkbox" checked>
                    <span>Set position</span>
                </label>
                <select id="lvt_place_position" class="text_pole">
                    <option value="0">↑Char — before character definitions</option>
                    <option value="1">↓Char — after character definitions</option>
                    <option value="2">↑AN — before author's note</option>
                    <option value="3">↓AN — after author's note</option>
                    <option value="4" selected>@Depth — in the chat at a depth</option>
                    <option value="5">↑EM — before example messages</option>
                    <option value="6">↓EM — after example messages</option>
                </select>
                <label for="lvt_place_role">Role (@Depth only)</label>
                <select id="lvt_place_role" class="text_pole">
                    <option value="0">System</option>
                    <option value="1">User</option>
                    <option value="2">Assistant</option>
                </select>

                <label class="checkbox_label" for="lvt_place_set_depth">
                    <input id="lvt_place_set_depth" type="checkbox" checked>
                    <span>Set depth (@Depth only)</span>
                </label>
                <input id="lvt_place_depth" class="text_pole" type="number" min="0" max="9999" step="1" value="4">

                <label class="checkbox_label" for="lvt_place_set_order">
                    <input id="lvt_place_set_order" type="checkbox">
                    <span>Set insertion order</span>
                </label>
                <input id="lvt_place_order" class="text_pole" type="number" min="0" max="99999" step="1" value="100">
                <label for="lvt_place_order_step">Step per entry (0 = same order for all)</label>
                <input id="lvt_place_order_step" class="text_pole" type="number" min="-100" max="100" step="1" value="0">

                <div class="lvt-buttons">
                    <button id="lvt_place_summary" class="menu_button">Show current placement</button>
                    <button id="lvt_place_apply" class="menu_button">Apply placement</button>
                    <button id="lvt_place_undo" class="menu_button">Undo last bulk change</button>
                </div>
                <div id="lvt_place_results" class="lvt-log lvt-preview"></div>
                <small class="lvt-note">
                    Depth and role only apply at @Depth — a higher depth number sits
                    further back in the chat. Insertion order breaks ties between
                    entries in the same place: lower goes in first.
                </small>

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

                <div class="lvt-section-label">Last activation</div>
                <div id="lvt_activation_log" class="lvt-log"></div>

                <div class="lvt-section-label">Event trace</div>
                <div id="lvt_trace" class="lvt-log lvt-trace"></div>
                <div class="lvt-buttons">
                    <button id="lvt_trace_copy" class="menu_button">Copy trace</button>
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

    $('#lvt_trace_copy').on('click', async () => {
        try {
            await navigator.clipboard.writeText(eventTrace.join('\n'));
            setStatus('Trace copied.', 'success');
        } catch {
            // Clipboard API needs a secure context; plain http over LAN won't have it.
            setStatus('Copy failed — select the text manually.', 'error');
        }
    });

    $('#lvt_stats').on('click', () => runAction({
        run: async (book) => {
            const s = await getBookStats(book);
            const embedded = s.embedded < 0 ? 'unknown' : String(s.embedded);
            const withKeys = await countRemainingKeywords(book);
            return `${s.total} entries · ${s.vectorized} vectorized · ${s.constant} constant · ${s.disabled} disabled · ${embedded} embedded · ${withKeys} with keywords`;
        },
    }));

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
            const { inserted, deleted, skipped, unchanged } = await vectorizeBook(book, message => setStatus(message));
            if (inserted === 0 && deleted === 0) {
                return `"${book}" is already up to date — ${unchanged} embedded, ${skipped} skipped.`;
            }
            return `"${book}": ${inserted} embedded, ${deleted} stale removed, ${unchanged} unchanged, ${skipped} skipped.`;
        },
    }));

    $('#lvt_vectorize_all').on('click', () => runAction({
        requireBook: false,
        confirmHeader: 'Sync every lorebook?',
        confirmText: 'Checks all lorebooks and embeds anything that changed. Books already up to date cost one lookup each and are skipped.',
        run: async () => {
            const { books, touched, inserted, deleted, failed } = await vectorizeAllBooks(message => setStatus(message));
            const problems = failed.length > 0 ? ` ${failed.length} failed — see console.` : '';
            if (touched === 0) {
                return `All ${books} lorebooks already up to date.${problems}`;
            }
            return `${touched} of ${books} lorebooks updated: ${inserted} embedded, ${deleted} removed.${problems}`;
        },
    }));

    $('#lvt_auto_sync')
        .prop('checked', getSettings().autoSync)
        .on('input', function () {
            getSettings().autoSync = !!$(this).prop('checked');
            saveSettingsDebounced();
            setStatus(getSettings().autoSync
                ? 'Auto-sync on: saving a lorebook re-embeds what changed.'
                : 'Auto-sync off.');
        });

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

            const remaining = await countRemainingKeywords(book);

            if (remaining > 0) {
                throw new Error(`Cleared ${n} in memory, but ${remaining} entries still have keywords on disk. Close the World Info editor for "${book}" and try again — an open editor can write stale data back.`);
            }

            return `Cleared keywords on ${n} entr${n === 1 ? 'y' : 'ies'} in "${book}". Verified: 0 remaining on disk.`;
        },
    }));

    $('#lvt_group_preview').on('click', () => runAction({
        run: async (book) => {
            const options = readGroupOptions();
            const matches = await previewGrouping(book, options);
            // Mirror the apply loop's slot accounting: "fill" skips entries that
            // already have a group, and skipped entries must not advance the
            // round-robin, or the preview would show the wrong pool.
            let slot = 0;
            const rows = matches.map((m) => {
                const skipped = options.mode === 'fill' && parseGroups(m.entry.group).length > 0;
                return {
                    left: skipped ? '–' : '·',
                    text: entryLabel(m.entry),
                    right: skipped ? 'left as is' : targetGroupsFor(m, options, slot++).join(' + '),
                };
            });
            renderGroupResults(
                `${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} match`,
                rows,
            );
            const pools = options.allowPerGroup > 1
                ? ` Split across ${options.allowPerGroup} pools, so ${options.allowPerGroup} can fire per turn.`
                : '';
            return `${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} would be grouped.${pools} Nothing changed yet.`;
        },
    }));

    $('#lvt_group_apply').on('click', () => runAction({
        confirmHeader: 'Group matching entries?',
        confirmText: 'Writes the group field on every matching entry in this lorebook. The previous groups are stashed, so "Undo last grouping change" will put them back.',
        run: async (book) => {
            const options = readGroupOptions();
            const { matched, changed, groups } = await applyGrouping(book, options);
            renderGroupResults(
                `${changed} of ${matched} matching entries changed`,
                groups.map(([name, count]) => ({ left: '▣', text: name, right: `${count}` })),
            );
            const tail = groups.length > 1 ? ` across ${groups.length} groups` : '';
            return `Grouped ${changed} of ${matched} matching entr${matched === 1 ? 'y' : 'ies'}${tail}.`;
        },
    }));

    $('#lvt_group_clear').on('click', () => runAction({
        confirmHeader: 'Ungroup matching entries?',
        confirmText: 'Empties the group field and resets priority, weight and scoring on every matching entry. Undoable.',
        run: async (book) => {
            const options = { ...readGroupOptions(), mode: 'clear' };
            const { matched, changed } = await applyGrouping(book, options);
            renderGroupResults(`${changed} of ${matched} matching entries ungrouped`, []);
            return `Ungrouped ${changed} entr${changed === 1 ? 'y' : 'ies'} in "${book}".`;
        },
    }));

    $('#lvt_group_list').on('click', () => runAction({
        run: async (book) => {
            const groups = await listGroups(book);
            renderGroupResults(
                groups.length === 0 ? 'No inclusion groups in this lorebook' : `${groups.length} group${groups.length === 1 ? '' : 's'}`,
                groups.map(g => ({
                    left: '▣',
                    text: g.name,
                    right: g.prioritized > 0 ? `${g.count} · ${g.prioritized}★` : `${g.count}`,
                })),
            );
            return groups.length === 0
                ? `"${book}" has no inclusion groups yet.`
                : `${groups.length} group${groups.length === 1 ? '' : 's'} in "${book}".`;
        },
    }));

    $('#lvt_group_undo, #lvt_place_undo').on('click', () => runAction({
        confirmHeader: 'Undo last bulk change?',
        confirmText: 'Restores the fields touched by the last grouping or placement change in this lorebook.',
        run: async (book) => {
            const { restored, label } = await undoBulkChange(book);
            renderGroupResults('Undone', []);
            renderPlacementResults('Undone', []);
            return `Restored ${restored} entr${restored === 1 ? 'y' : 'ies'} (${label}).`;
        },
    }));

    $('#lvt_place_summary').on('click', () => runAction({
        run: async (book) => {
            const options = readPlacementOptions();
            const { matched, rows } = await summarisePlacement(book, options);
            renderPlacementResults(`${matched} entr${matched === 1 ? 'y' : 'ies'} selected`, rows);
            return `${matched} entr${matched === 1 ? 'y' : 'ies'} selected. Nothing changed.`;
        },
    }));

    $('#lvt_place_apply').on('click', () => runAction({
        confirmHeader: 'Apply placement?',
        confirmText: 'Rewrites position, depth and/or insertion order on every selected entry. Undoable.',
        run: async (book) => {
            const options = readPlacementOptions();
            const { matched, changed } = await applyPlacement(book, options);
            const { rows } = await summarisePlacement(book, options);
            renderPlacementResults(`${matched} entr${matched === 1 ? 'y' : 'ies'} now`, rows);
            return `Updated ${changed} of ${matched} selected entr${matched === 1 ? 'y' : 'ies'} in "${book}".`;
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
        $('#lvt_group_results').empty();
        $('#lvt_place_results').empty();
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

    /** Shared defaults so the command behaves like the panel with nothing ticked off. */
    const groupCommandOptions = (args, mode) => ({
        terms: splitTerms(args.term),
        groupName: String(args.name ?? '').trim(),
        mode,
        allowPerGroup: Math.max(1, Math.round(Number(args.allow) || 1)),
        scope: {
            title: !args.scope || String(args.scope).includes('title'),
            keys: !args.scope || String(args.scope).includes('keys'),
            content: !args.scope || String(args.scope).includes('content'),
        },
        wholeWord: String(args.whole ?? 'true') !== 'false',
        caseSensitive: String(args.case ?? 'false') === 'true',
        skipDisabled: true,
        applySettings: false,
        prioritize: false,
        weight: DEFAULT_GROUP_WEIGHT,
        scoring: null,
    });

    const groupNamedArgs = () => [
        SlashCommandNamedArgument.fromProps({
            name: 'term',
            description: 'word(s) to match, comma-separated',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'name',
            description: 'group name (blank = one group per matched word)',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'scope',
            description: 'where to look: any of title, keys, content (default: all)',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'whole',
            description: 'whole words only (default true)',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'case',
            description: 'case sensitive (default false)',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
        }),
    ];

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-group',
        helpString: 'Puts every entry matching a word into an inclusion group. Example: /lvt-group term=dorm name=locations My Lorebook',
        returns: 'number of entries changed',
        namedArgumentList: [
            ...groupNamedArgs(),
            SlashCommandNamedArgument.fromProps({
                name: 'allow',
                description: 'how many entries may fire per turn (default 1)',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'replace (default), append, or fill',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['replace', 'append', 'fill'].map(x => new SlashCommandEnumValue(x)),
            }),
        ],
        unnamedArgumentList: [bookArgument()],
        callback: async (args, value) => {
            const mode = String(args.mode ?? 'replace');
            const { changed } = await applyGrouping(String(value), groupCommandOptions(args, mode));
            return String(changed);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-ungroup',
        helpString: 'Clears the inclusion group on every entry matching a word.',
        returns: 'number of entries changed',
        namedArgumentList: groupNamedArgs(),
        unnamedArgumentList: [bookArgument()],
        callback: async (args, value) => {
            const { changed } = await applyGrouping(String(value), groupCommandOptions(args, 'clear'));
            return String(changed);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-groups',
        helpString: 'Lists the inclusion groups in the named lorebook with member counts.',
        returns: 'group names and counts',
        unnamedArgumentList: [bookArgument()],
        callback: async (_args, value) => {
            const groups = await listGroups(String(value));
            return groups.map(g => `${g.name}: ${g.count}`).join('\n');
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-place',
        helpString: 'Sets position / depth / role / insertion order in bulk. Example: /lvt-place pos=atDepth depth=4 role=system My Lorebook',
        returns: 'number of entries changed',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'pos',
                description: 'before, after, ANTop, ANBottom, atDepth, EMTop, EMBottom',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: Object.keys(WI_POSITION).map(x => new SlashCommandEnumValue(x)),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'depth',
                description: 'chat depth, @Depth only',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: 'system, user or assistant (@Depth only)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['system', 'user', 'assistant'].map(x => new SlashCommandEnumValue(x)),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'order',
                description: 'insertion order',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'step',
                description: 'add this much to the order per entry (default 0)',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: 'all (default), vectorized, notVectorized, constant, grouped',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['all', 'vectorized', 'notVectorized', 'constant', 'grouped'].map(x => new SlashCommandEnumValue(x)),
            }),
        ],
        unnamedArgumentList: [bookArgument()],
        callback: async (args, value) => {
            const roles = { system: 0, user: 1, assistant: 2 };
            const hasPos = args.pos !== undefined && args.pos !== '';
            const hasDepth = args.depth !== undefined && args.depth !== '';
            const hasOrder = args.order !== undefined && args.order !== '';
            const position = WI_POSITION[String(args.pos)];

            if (hasPos && position === undefined) {
                throw new Error(`Unknown position "${args.pos}".`);
            }

            const { changed } = await applyPlacement(String(value), {
                filter: String(args.filter ?? 'all'),
                skipDisabled: true,
                terms: [],
                scope: { title: true, keys: true, content: true },
                setPosition: hasPos,
                position: position ?? WI_POSITION.atDepth,
                role: roles[String(args.role ?? 'system')] ?? 0,
                setDepth: hasDepth,
                depth: Math.max(0, Math.round(Number(args.depth) || 0)),
                setOrder: hasOrder,
                order: Math.max(0, Math.round(Number(args.order) || 0)),
                orderStep: Math.round(Number(args.step) || 0),
            });

            return String(changed);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lvt-sync-all',
        helpString: 'Re-embeds anything that changed in every lorebook. Progress goes to the browser console.',
        returns: 'summary of the sync',
        callback: async () => {
            const { books, touched, inserted, deleted, failed } = await vectorizeAllBooks();
            return `${touched}/${books} books updated, ${inserted} embedded, ${deleted} removed, ${failed.length} failed`;
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
    initActivationTracking();
    initAutoSync();
    renderActivationLog();
    renderTrace();
    console.log(`${MODULE}: loaded`);
});
