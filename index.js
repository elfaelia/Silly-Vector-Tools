import { getRequestHeaders, saveSettingsDebounced, eventSource, event_types, extension_prompts, substituteParams } from '../../../../script.js';
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

/** @returns {{banks: Record<string, object[]>, autoBank: boolean, groupUndo: Record<string, object>, openSections: Record<string, boolean>}} */
function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = { banks: {}, autoBank: true, autoSync: false, groupUndo: {}, openSections: {} };
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

    if (!settings.openSections || typeof settings.openSections !== 'object') {
        settings.openSections = {};
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

// The nomination side of the vectorised path. Keeping the whole entry rather
// than just its key is what makes it possible to say *why* world-info.js threw
// one away: the payload carries the group, probability, filters and decorators
// the scan judged it on, and none of that is recoverable afterwards.
/** @type {Map<string, object>} Entries nominated via WORLDINFO_FORCE_ACTIVATE. */
let pendingVectorEntries = new Map();
/** @type {object[]} Nominated entries that never reached the prompt. */
let lastDroppedVectorEntries = [];
let sawForceActivate = false;
/** Generation type of the last run. 'quiet' and dry runs skip the vectors path. */
let lastGenerationType = '';
let lastGenerationDryRun = false;
let lastGenerationAt = null;

/**
 * Rebuilds the vector query string. Mirrors getQueryText() in the vectors
 * extension: newest messages first, empties dropped, capped at "Query messages".
 * @returns {string}
 */
function buildQueryText() {
    // Delegates to the faithful clone. The earlier version here skipped macro
    // substitution, the attachment slice and the newline collapse, so on any
    // chat using macros or file attachments it embedded different text than
    // SillyTavern does — which quietly made every score in this panel wrong.
    return buildVectorQueryText();
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
 * Runs one query at a given threshold and reports whether the entry survived
 * the server's filter.
 * @param {string} world
 * @param {number} contentHash
 * @param {number} threshold
 * @returns {Promise<boolean>}
 */
async function scoresAtLeast(world, contentHash, threshold) {
    const source = getSource();
    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId: getWorldCollectionId(world),
            searchText: lastQueryText,
            topK: 100,
            threshold,
            source,
        }),
    });

    if (!response.ok) {
        throw new Error(`Query failed (HTTP ${response.status})`);
    }

    const result = await response.json();
    const metadata = Array.isArray(result?.metadata) ? result.metadata : [];

    return metadata.some(x => Number(x?.hash) === contentHash);
}

/**
 * Recovers an entry's actual similarity score.
 *
 * queryCollection() computes a score per item, filters `metadata` by it, then
 * returns only hashes and metadata — the score itself never leaves the server.
 * But `metadata` is threshold-filtered while `hashes` is not, so whether the
 * entry appears in `metadata` at threshold T answers "is the score >= T?".
 * Bisecting on that recovers the number without patching SillyTavern.
 *
 * Each probe re-embeds the query text server-side (getVector has no cache), so
 * this is deliberately capped rather than run for every entry automatically.
 *
 * @param {string} world
 * @param {number} contentHash
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<{score: number, precision: number, probes: number} | null>}
 */
async function measureSimilarity(world, contentHash, onProgress = () => {}) {
    // Threshold 0 is treated as "no threshold" by the endpoint's `|| 0.0`
    // fallback, so a tiny epsilon stands in for the bottom of the range.
    if (!await scoresAtLeast(world, contentHash, 0.0001)) {
        return null;
    }

    let low = 0;
    let high = 1;
    let probes = 1;

    // 8 halvings lands inside ±0.004, which is finer than the threshold slider.
    for (let step = 0; step < 8; step++) {
        const mid = (low + high) / 2;
        onProgress(`Probing ${mid.toFixed(3)}…`);
        probes++;

        if (await scoresAtLeast(world, contentHash, mid)) {
            low = mid;
        } else {
            high = mid;
        }
    }

    return { score: (low + high) / 2, precision: (high - low) / 2, probes };
}

/**
 * Shows what a sample of real messages looks like after boilerplate stripping,
 * so the patterns can be checked against the actual chat before committing to
 * a re-vectorise. Uses the exact function the vectors extension uses, imported
 * from the patched file, so this can never drift from the real behaviour.
 * @returns {Promise<{left: string, text: string, right: string}[]>}
 */
async function previewStripping() {
    const chat = getContext()?.chat ?? [];
    const rows = [];

    let stripBoilerplate = null;

    for (const path of ['../vectors/index.js', '/scripts/extensions/vectors/index.js']) {
        try {
            const module = await import(/* webpackIgnore: true */ path);

            if (typeof module?.stripBoilerplate === 'function') {
                stripBoilerplate = module.stripBoilerplate;
                break;
            }
        } catch {
            // Try the next candidate.
        }
    }

    if (!stripBoilerplate) {
        rows.push({ left: '❌', text: 'Could not load stripBoilerplate from the vectors extension.', right: 'not patched?' });
        rows.push({ left: '·', text: 'This needs the patched vectors/index.js in place. If you have installed it, the export may be missing.', right: '' });
        return rows;
    }

    // Spread the sample across the whole chat rather than the recent tail,
    // since older messages may use an older board format.
    const step = Math.max(1, Math.floor(chat.length / 12));
    const sample = [];

    for (let i = 0; i < chat.length && sample.length < 12; i += step) {
        if (String(chat[i]?.mes ?? '').trim()) {
            sample.push([i, String(chat[i].mes)]);
        }
    }

    let totalBefore = 0;
    let totalAfter = 0;
    let untouched = 0;

    for (const [index, raw] of sample) {
        const stripped = stripBoilerplate(raw);
        totalBefore += raw.length;
        totalAfter += stripped.length;

        if (stripped.length === raw.length) {
            untouched++;
        }

        const empty = stripped.trim().length === 0;

        rows.push({
            left: empty ? '⚠️' : '🔗',
            text: empty
                ? '(nothing left — this message was entirely boilerplate)'
                : truncate(stripped.replace(/\s+/g, ' ').trim(), 200),
            right: `msg ${index} · ${raw.length}→${stripped.length}`,
        });
    }

    const saved = totalBefore > 0 ? Math.round(100 - (totalAfter / totalBefore) * 100) : 0;

    rows.push({ left: '·', text: `Across this sample, stripping removes ${saved}% of the text that would be embedded.`, right: '' });

    if (untouched === sample.length) {
        rows.push({ left: '⚠️', text: 'No message in the sample was changed. The patterns are not matching your board — check the format against BOILERPLATE_PATTERNS at the top of vectors/index.js.', right: 'no matches' });
    } else if (untouched > 0) {
        rows.push({ left: '·', text: `${untouched} of ${sample.length} sampled messages were left unchanged, which is expected for plain prose turns.`, right: '' });
    }

    rows.push({ left: '·', text: 'If the text above still contains board fields, the patterns need adjusting before you re-vectorise.', right: '' });

    return rows;
}

/**
 * Queries the chat's own collection directly, bypassing everything the vectors
 * extension does to the result afterwards.
 *
 * diagnoseChatRecall() can only see whether the injection slot ended up empty,
 * which conflates three different failures: the query returned nothing, the
 * query threw and was swallowed, or the query returned hits that were then
 * discarded during post-filtering. This separates them by reading the raw
 * response.
 *
 * @param {string} searchText
 * @param {number} threshold
 * @returns {Promise<{hashes: number[], metadata: object[], status: number, error: string}>}
 */
async function queryChatCollection(searchText, threshold = 0) {
    const source = getSource();
    const chatId = getContext()?.chatId;

    if (!chatId) {
        throw new Error('No chat is open.');
    }

    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionId: String(chatId),
            searchText,
            topK: 20,
            threshold,
            source,
        }),
    });

    // The body of a failed embedding call carries the actual reason — wrong
    // dimensions, expired key, rate limit. The vectors extension discards it.
    if (!response.ok) {
        let detail = '';

        try {
            detail = (await response.text()).slice(0, 300);
        } catch {
            detail = '(no body)';
        }

        return { hashes: [], metadata: [], status: response.status, error: detail };
    }

    const result = await response.json();

    return {
        hashes: Array.isArray(result?.hashes) ? result.hashes : [],
        metadata: Array.isArray(result?.metadata) ? result.metadata : [],
        status: response.status,
        error: '',
    };
}

/**
 * Runs the probe and formats it for the results list. Reports what came back
 * at threshold 0 first, since that is the "is retrieval working at all"
 * question, then how much of it would survive the configured threshold and the
 * protected-tail filter.
 * @returns {Promise<{left: string, text: string, right: string}[]>}
 */
async function probeChatRecall() {
    const settings = extension_settings.vectors ?? {};
    const chat = getContext()?.chat ?? [];
    const protect = Number(settings.protect) || 5;
    const threshold = Number(settings.score_threshold) || 0.25;
    const rows = [];

    const ok = (text, right = '') => rows.push({ left: '✅', text, right });
    const bad = (text, right = '') => rows.push({ left: '❌', text, right });
    const warn = (text, right = '') => rows.push({ left: '⚠️', text, right });
    const note = (text, right = '') => rows.push({ left: '·', text, right });

    const searchText = buildQueryText();

    if (!searchText) {
        bad('Query text is empty', 'nothing to search with');
        note('The last few messages are blank or hidden, so there is no query to embed.');
        return rows;
    }

    note(`Query: "${truncate(searchText.replace(/\s+/g, ' ').trim(), 120)}"`, `${searchText.length} chars`);
    trace(`PROBE: querying chat collection with ${searchText.length} chars`);

    const raw = await queryChatCollection(searchText, 0);

    // A failure here is the whole answer: the collection was never being
    // searched successfully, and no amount of threshold tuning would show it.
    if (raw.error) {
        bad(`Query failed (HTTP ${raw.status})`, 'server rejected it');
        note(raw.error);
        return rows;
    }

    if (raw.hashes.length === 0) {
        bad('Collection returned nothing at threshold 0', 'empty or mismatched');
        note('Hashes are listed unfiltered, so zero here means the collection being queried is empty — which is not the same collection /api/vector/list is reading. Check for a stale chat id.');
        return rows;
    }

    ok(`${raw.hashes.length} chunks returned at threshold 0`, 'retrieval works');

    // Everything below this point is post-filtering, i.e. results that were
    // found and then thrown away.
    const filtered = await queryChatCollection(searchText, threshold);

    if (filtered.metadata.length === 0) {
        warn(`None survive your threshold of ${threshold}`, 'lower it');
    } else {
        ok(`${filtered.metadata.length} survive threshold ${threshold}`);
    }

    // ST drops any hit whose source message is already in the protected tail,
    // because it is in context verbatim. Fragmented chunks make the recent
    // messages their own nearest neighbours, which empties the slot silently.
    const cutoff = Math.max(0, chat.length - protect);
    const pool = filtered.metadata.length > 0 ? filtered.metadata : raw.metadata;
    let inTail = 0;

    for (const item of pool.slice(0, 10)) {
        const index = Number(item?.index);
        const recent = Number.isFinite(index) && index >= cutoff;

        if (recent) {
            inTail++;
        }

        const where = Number.isFinite(index)
            ? (recent ? `msg ${index} — IN TAIL` : `msg ${index}`)
            : 'no index';

        rows.push({
            left: recent ? '🚫' : '🔗',
            text: truncate(String(item?.text ?? '(no text stored)').replace(/\s+/g, ' ').trim(), 160),
            right: where,
        });
    }

    if (inTail > 0) {
        warn(`${inTail} of the top hits are inside the last ${protect} messages`, 'discarded as already in context');
        note('These are the chunks being thrown away before injection. If most of the list is marked IN TAIL, raise Retain# so the recent messages stop being their own best matches, or raise the chunk size so chunks carry more distinct meaning.');
    }

    // The step after retrieval: the vectors extension turns hashes back into
    // messages by hashing each message in the chat and looking for a match. If
    // the stored hashes are per-chunk rather than per-message, nothing matches
    // and the injection comes out empty even though retrieval succeeded.
    const messageHashes = new Set(
        chat.map(x => getStringHash(substituteParams(String(x?.mes ?? '')))),
    );

    const usable = raw.hashes.filter((hash, i) => {
        const index = Number(raw.metadata[i]?.index);
        return !(Number.isFinite(index) && index >= cutoff);
    });

    const mappable = usable.filter(hash => messageHashes.has(Number(hash)));

    if (usable.length === 0) {
        warn('Every hit was inside the protected tail', 'nothing left to map');
    } else if (mappable.length === 0) {
        bad(`0 of ${usable.length} usable hits map back to a message`, 'chunking mismatch');
        note(`Retrieval is working and the tail filter left ${usable.length} candidates, but none of their hashes match any message in this chat. Stored hashes are per-chunk (${raw.hashes.length ? 'chunking is on' : 'unknown'}), while the lookup hashes whole messages, so the injection is always empty. Set message chunk size to 0 in Vector Storage, then purge and re-vectorise.`);
    } else {
        ok(`${mappable.length} of ${usable.length} usable hits map back to a message`);
    }

    // The real mapping the vectors extension performs. It stores hashes of the
    // raw message, but looks them up against coreChat, which has already been
    // through the prompt-side regex scripts. Any script that rewrites messages
    // for the prompt changes the hash and the lookup silently finds nothing.
    //
    // Imported lazily and defensively: the module path has moved between
    // SillyTavern versions, and a failed static import takes the whole
    // extension down rather than just this one check.
    let regexEngine = null;

    for (const path of ['../../regex/engine.js', '../regex/engine.js', '/scripts/extensions/regex/engine.js']) {
        try {
            const module = await import(/* webpackIgnore: true */ path);

            if (typeof module?.getRegexedString === 'function' && module?.regex_placement) {
                regexEngine = module;
                break;
            }
        } catch {
            // Try the next candidate.
        }
    }

    if (!regexEngine) {
        warn('Could not load the regex engine', 'check skipped');
        note('This check compares the raw message hash against the hash after prompt-side regex runs. Without the module it cannot run, but nothing else is affected.');
        return rows;
    }

    const { getRegexedString, regex_placement } = regexEngine;

    const promptText = (x, i) => getRegexedString(
        String(x?.mes ?? ''),
        x?.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT,
        { isPrompt: true, depth: chat.length - i - 1 },
    );

    const promptHashes = new Set(chat.map((x, i) => getStringHash(substituteParams(promptText(x, i)))));
    const survives = usable.filter(hash => promptHashes.has(Number(hash)));
    const altered = chat.filter((x, i) => promptText(x, i) !== String(x?.mes ?? '')).length;

    if (mappable.length > 0 && survives.length === 0) {
        bad(`0 of ${mappable.length} survive prompt-side regex`, 'hash mismatch');
        note(`${altered} of ${chat.length} messages are rewritten by regex before the prompt is built. Vectors are stored against the raw text but looked up against the rewritten text, so no hash ever matches and nothing is injected. Set any regex script that edits messages to affect Display only, not Prompt, and recall will start working with no re-vectorising needed.`);
    } else if (survives.length > 0) {
        ok(`${survives.length} survive prompt-side regex`, 'mapping is intact');
        note(`${altered} of ${chat.length} messages are altered by prompt regex.`);
    }

    // Everything above tests the plumbing directly. This tests whether the
    // vectors extension is using it: if recall is running but writing to a
    // different key than VECTOR_CHAT_TAG, the panel would report an empty slot
    // forever while the prompt was actually being filled correctly.
    const slots = Object.entries(extension_prompts ?? {})
        .map(([key, value]) => [key, String(value?.value ?? '').trim()])
        .filter(([, text]) => text.length > 0);

    if (slots.length === 0) {
        warn('No extension prompt slots are filled at all', 'nothing injected by anything');
    } else {
        note(`Filled prompt slots: ${slots.map(([k, t]) => `${k} (${t.length})`).join(', ')}`);
    }

    const ours = slots.find(([key]) => key === VECTOR_CHAT_TAG);
    const otherVector = slots.filter(([key]) => key !== VECTOR_CHAT_TAG && /vector/i.test(key));

    if (ours) {
        ok(`${VECTOR_CHAT_TAG} is filled`, `${ours[1].length} chars`);
    } else if (otherVector.length > 0) {
        bad(`Recall is writing to ${otherVector.map(([k]) => k).join(', ')}, not ${VECTOR_CHAT_TAG}`, 'wrong tag');
        note('Recall is working — the panel is reading the wrong key for this SillyTavern version. Nothing is broken in your setup.');
    } else {
        bad(`${VECTOR_CHAT_TAG} is empty and no other vector slot exists`, 'recall did not run');
        note('Retrieval works when called directly, but the vectors extension is not calling it. Check that "Enabled for chat messages" is ticked in Vector Storage.');
    }

    trace(`PROBE: ${raw.hashes.length} raw, ${filtered.metadata.length} over threshold, ${inTail} in tail, ${mappable.length}/${usable.length} mappable`);

    return rows;
}

// ---------------------------------------------------------------------------
// Lorebook recall
//
// A vectorised entry takes a completely different route into the prompt than a
// keyword entry, and the two share almost no code. A keyword entry is matched
// inside world-info.js during the scan. A vectorised entry is never matched
// there at all: the Vector Storage extension has to nominate it first, from a
// generation interceptor that runs before the scan, by emitting
// WORLDINFO_FORCE_ACTIVATE. Only then does world-info.js consider it — and it
// then puts that nomination through the same post-match gauntlet as everything
// else.
//
// So "my keywords fire but my vectorised entries don't" is never one failure.
// It is one of two, and they need completely different fixes:
//
//   Stage A — the vectors extension never nominated the entry.
//     The WI toggle is off; the generation was 'quiet' or a dry run, neither of
//     which runs interceptors; the lorebook is not attached to this chat; the
//     entry is not actually marked vectorised; its text was never embedded, or
//     was embedded under a different hash than the one being looked up; the
//     query text came out empty; the similarity fell under the threshold; or
//     other lorebooks ate the shared result budget.
//
//   Stage B — it was nominated, and world-info.js dropped it anyway.
//     Disabled; a trigger or character filter; a timed effect; recursion delay;
//     a @@dont_activate decorator; losing an inclusion group; a failed
//     probability roll; or the token budget filling up before it was reached.
//
// Keyword entries are immune to every Stage A cause, which is exactly why they
// keep working while vectorised ones silently stop. Everything below exists to
// say which stage failed, and then which cause inside it.
// ---------------------------------------------------------------------------

/** @type {{head: string, rows: {left: string, text: string, right: string}[]} | null} */
let lastWorldInfoReport = null;

/** Sensible fallbacks matching the vectors extension's own defaults. */
const WI_DEFAULT_MAX_ENTRIES = 5;
const WI_DEFAULT_THRESHOLD = 0.25;
const WI_DEFAULT_QUERY_MESSAGES = 2;

/**
 * world-info.js is already imported statically, so this is a cache hit rather
 * than a fetch. It is dynamic only so that a build missing one of the newer
 * named exports degrades to a single failed check instead of refusing to load
 * the whole extension.
 * @returns {Promise<object>}
 */
async function getWorldInfoModule() {
    try {
        return await import(/* webpackIgnore: true */ '../../../world-info.js');
    } catch (error) {
        console.error(`${MODULE}: could not reach world-info.js`, error);
        return {};
    }
}

/**
 * The entry list SillyTavern actually scans, in scan order.
 *
 * This is deliberately not `loadWorldInfo()`: getSortedEntries() is what both
 * the vectors extension and checkWorldInfo() call, and it differs from the raw
 * book in two ways that matter here. It only includes lorebooks that are
 * currently attached (global, character, chat or persona), and it strips
 * decorators off `content` — which changes the hash every embedding lookup is
 * keyed by.
 *
 * @returns {Promise<object[]>}
 */
async function getScannedEntries() {
    const wi = await getWorldInfoModule();

    if (typeof wi.getSortedEntries !== 'function') {
        throw new Error('This SillyTavern build does not export getSortedEntries(), so the entry list it really scans cannot be read.');
    }

    const entries = await wi.getSortedEntries();

    return Array.isArray(entries) ? entries : [];
}

/** @returns {Promise<string[]>} Lorebooks attached globally, if readable. */
async function getAttachedWorldNames() {
    const wi = await getWorldInfoModule();

    return Array.isArray(wi.selected_world_info) ? [...wi.selected_world_info] : [];
}

/** Mirrors collapseNewlines() in utils.js. */
function collapseNewlines(text) {
    return String(text).replace(/\n+/g, '\n');
}

/**
 * Rebuilds the query string exactly as the vectors extension's getQueryText()
 * does: newest messages first, attachment text sliced off, macros substituted,
 * blank messages dropped, capped at "Query messages", newlines collapsed.
 *
 * The macro substitution and the attachment slice are the parts that are easy
 * to leave out and easy to be caught by — a chat whose last messages are mostly
 * an attached file embeds almost nothing, and the query that gets embedded is
 * then not the text you can see on screen.
 *
 * @returns {string}
 */
function buildVectorQueryText() {
    const chat = getContext()?.chat ?? [];
    const count = Number(extension_settings.vectors?.query) || WI_DEFAULT_QUERY_MESSAGES;

    const withoutAttachments = (message) => {
        const fileLength = message?.extra?.fileLength || 0;
        return String(message?.mes || '').substring(fileLength).trim();
    };

    const text = chat
        .map(x => substituteParams(withoutAttachments(x)))
        .filter(Boolean)
        .reverse()
        .slice(0, count)
        .join('\n');

    return collapseNewlines(text).trim();
}

/**
 * Groups the scanned entries the way activateWorldInfo() does, applying its
 * skip list in the same order so the counts line up with its console output.
 *
 * @param {object[]} entries
 * @returns {{byWorld: Map<string, object[]>, skipped: {orphaned: number, disabled: number, empty: number, notVectorised: number}}}
 */
function groupEligibleEntries(entries) {
    const enabledForAll = !!extension_settings.vectors?.enabled_for_all;
    const byWorld = new Map();
    const skipped = { orphaned: 0, disabled: 0, empty: 0, notVectorised: 0 };

    for (const entry of entries) {
        if (!entry.world) {
            skipped.orphaned++;
            continue;
        }

        if (entry.disable) {
            skipped.disabled++;
            continue;
        }

        if (!entry.content) {
            skipped.empty++;
            continue;
        }

        if (!entry.vectorized && !enabledForAll) {
            skipped.notVectorised++;
            continue;
        }

        if (!byWorld.has(entry.world)) {
            byWorld.set(entry.world, []);
        }

        byWorld.get(entry.world).push(entry);
    }

    return { byWorld, skipped };
}

/**
 * Runs the real multi-collection query — the same endpoint, body and pooling
 * behaviour the vectors extension uses, rather than a per-book approximation.
 *
 * This distinction matters more than it looks. /api/vector/query-multi pools
 * every collection's hits into one list, sorts them by score across all books,
 * applies the threshold, and only then takes the top K. So "Max entries" is a
 * budget shared by every attached lorebook at once, and one chatty book can
 * take all of it. Querying books one at a time hides that completely.
 *
 * @param {string[]} collectionIds
 * @param {string} searchText
 * @param {number} topK
 * @param {number} threshold
 * @returns {Promise<{results: Record<string, {hashes: number[], metadata: object[]}>, status: number, error: string}>}
 */
async function queryWorldCollections(collectionIds, searchText, topK, threshold) {
    const source = getSource();

    const response = await fetch('/api/vector/query-multi', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorsRequestBody(source),
            collectionIds,
            searchText,
            topK,
            threshold,
            source,
        }),
    });

    // The vectors extension throws away the response body on failure, which is
    // where the actual reason lives — wrong embedding dimensions after a model
    // change, an expired key, a rate limit.
    if (!response.ok) {
        let detail = '';

        try {
            detail = (await response.text()).slice(0, 300);
        } catch {
            detail = '(no body)';
        }

        return { results: {}, status: response.status, error: detail };
    }

    const results = await response.json();

    return { results: results ?? {}, status: response.status, error: '' };
}

/**
 * Reconstructs the true cross-book ranking of the query results.
 *
 * The server pools every collection's hits, sorts them by score, slices the top
 * K and only then groups them by collection — so the response tells you which
 * book each winner came from but not the order they were in, and never the
 * scores. Grouped output cannot be re-interleaved after the fact.
 *
 * The slice is the way back in. At threshold 0 a request for topK = k returns
 * exactly the global top k, so whichever hash is new when k becomes k+1 is the
 * one ranked k+1. Walking k upwards recovers the order one place at a time.
 *
 * Each step re-embeds the query server-side, so this is bounded and deliberately
 * only ever called from a button.
 *
 * @param {string[]} collectionIds
 * @param {string} searchText
 * @param {number} depth How many places to resolve.
 * @returns {Promise<number[]>} Hashes, best first.
 */
async function rankAcrossWorlds(collectionIds, searchText, depth) {
    const order = [];
    const seen = new Set();

    for (let k = 1; k <= depth; k++) {
        const { results, error } = await queryWorldCollections(collectionIds, searchText, k, 0);

        if (error) {
            break;
        }

        const present = Object.values(results ?? {}).flatMap(x => (x?.hashes ?? []).map(Number));

        // Fewer results than places asked for means the pool is exhausted.
        if (present.length < k) {
            break;
        }

        const added = present.filter(hash => !seen.has(hash));

        // Exactly one new hash per step is the expected shape. Anything else
        // means the server broke a tie differently between calls, so the run is
        // stopped rather than reported in a possibly wrong order.
        if (added.length !== 1) {
            break;
        }

        seen.add(added[0]);
        order.push(added[0]);
    }

    return order;
}

/**
 * Compares what is stored in a lorebook's collection against the hashes
 * SillyTavern will actually look for.
 *
 * The lookup key is getStringHash() of the entry content as getSortedEntries()
 * returns it — after decorators have been stripped. Anything that embeds the
 * raw book content instead stores a different hash for those entries, and they
 * are then unreachable forever: present in the index, never returned for a
 * lookup, and completely invisible in the Vector Storage UI, which only ever
 * shows a count. This separates that case from "never embedded at all".
 *
 * @param {string} worldName
 * @returns {Promise<{scanned: number, eligible: number, stored: number, indexed: object[], missing: object[], wrongHash: object[], orphanHashes: number[], attached: boolean}>}
 */
async function auditWorldIndex(worldName) {
    const scanned = (await getScannedEntries()).filter(x => x.world === worldName);
    const { byWorld } = groupEligibleEntries(scanned);
    const eligible = byWorld.get(worldName) ?? [];

    const raw = await loadWorldInfo(worldName);
    const rawByUid = new Map(Object.values(raw?.entries ?? {}).map(x => [x.uid, x]));

    const stored = await getSavedHashes(getWorldCollectionId(worldName));
    const storedSet = new Set(stored.map(Number));

    const indexed = [];
    const missing = [];
    const wrongHash = [];
    const claimed = new Set();

    for (const entry of eligible) {
        const lookupHash = getStringHash(entry.content);
        const rawContent = rawByUid.get(entry.uid)?.content;
        const rawHash = typeof rawContent === 'string' ? getStringHash(rawContent) : null;
        const row = { uid: entry.uid, label: entryLabel(entry), lookupHash, rawHash };

        if (storedSet.has(lookupHash)) {
            claimed.add(lookupHash);
            indexed.push(row);
            continue;
        }

        // Stored under the pre-decorator text: the embedding exists and is
        // perfectly good, it is simply filed under a key nothing will ask for.
        if (rawHash !== null && rawHash !== lookupHash && storedSet.has(rawHash)) {
            claimed.add(rawHash);
            wrongHash.push(row);
            continue;
        }

        missing.push(row);
    }

    const orphanHashes = [...storedSet].filter(h => !claimed.has(h));

    return {
        scanned: scanned.length,
        eligible: eligible.length,
        stored: stored.length,
        indexed,
        missing,
        wrongHash,
        orphanHashes,
        attached: scanned.length > 0,
    };
}

/**
 * Names the gates in world-info.js that could have swallowed an entry the
 * vectors extension successfully nominated, in the order checkWorldInfo()
 * applies them.
 *
 * The scan's own decisions are not observable from outside, so this reports
 * what the entry is *subject to* rather than pretending to know which gate
 * closed. Anything decidable from the entry's own fields is marked certain;
 * everything else is marked as a candidate, in check order, so the list reads
 * top-down as "try these in this sequence".
 *
 * @param {object} entry Entry as it was handed to WORLDINFO_FORCE_ACTIVATE.
 * @param {{trigger: string}} context
 * @returns {{certain: boolean, text: string}[]}
 */
function explainVectorDrop(entry, context) {
    const reasons = [];
    const certain = text => reasons.push({ certain: true, text });
    const maybe = text => reasons.push({ certain: false, text });

    if (entry.disable === true) {
        certain('The entry is disabled. Vector nomination happens before that check, so it is nominated and then immediately discarded.');
    }

    if (Array.isArray(entry.triggers) && entry.triggers.length > 0 && context.trigger && !entry.triggers.includes(context.trigger)) {
        certain(`Its generation-type filter is [${entry.triggers.join(', ')}], and this generation was "${context.trigger}".`);
    }

    if (Array.isArray(entry.decorators) && entry.decorators.some(x => String(x).includes('@@dont_activate'))) {
        certain('Its content carries a @@dont_activate decorator, which overrides an external activation.');
    }

    if (entry.characterFilter?.names?.length > 0 || entry.characterFilter?.tags?.length > 0) {
        maybe(`It has a character filter (${entry.characterFilter.isExclude ? 'exclude' : 'include only'}), which is checked before external activations are honoured.`);
    }

    if (entry.delayUntilRecursion) {
        maybe('It is set to delay until recursion, so it is skipped on the first scan pass regardless of how it was nominated.');
    }

    if (entry.delay || entry.cooldown) {
        maybe(`Timed effects are set on it (${[entry.delay ? `delay ${entry.delay}` : '', entry.cooldown ? `cooldown ${entry.cooldown}` : ''].filter(Boolean).join(', ')}). Both suppress an entry before the external-activation check.`);
    }

    const group = String(entry.group ?? '').trim();

    if (group) {
        maybe(`It belongs to inclusion group "${group}". Only one entry per group survives, and a vector nomination gets no priority in that contest — a keyword entry in the same group will usually win it.`);
    }

    if (entry.useProbability && Number(entry.probability) < 100) {
        maybe(`Its probability is ${entry.probability}%, rolled after activation.`);
    }

    maybe('The world info token budget filled before it was reached. Vector hits sort after constant and sticky entries, so they are the first to be cut.');

    return reasons;
}

/**
 * Walks the vectorised-lorebook path in the order SillyTavern walks it and
 * stops at the first thing that is actually broken.
 *
 * @param {string} bookName Book to focus on, or '' for all attached books.
 * @returns {Promise<{left: string, text: string, right: string}[]>}
 */
async function diagnoseWorldInfoRecall(bookName = '') {
    const vectors = extension_settings.vectors ?? {};
    const rows = [];

    const ok = (text, right = '') => rows.push({ left: '✅', text, right });
    const bad = (text, right = '') => rows.push({ left: '❌', text, right });
    const warn = (text, right = '') => rows.push({ left: '⚠️', text, right });
    const note = (text, right = '') => rows.push({ left: '·', text, right });

    // --- Stage A, precondition: is the feature even switched on? ------------
    if (!vectors.enabled_world_info) {
        bad('"Enabled for World Info" is off in Vector Storage', 'fix this first');
        note('This is the single switch that runs the whole vectorised path. With it off, entries marked 🔗 are not keyword-matched either — the tri-state makes vectorised and normal mutually exclusive — so they simply never fire while your keyword entries carry on working.');
        return rows;
    }

    ok('Vectorised World Info is enabled');

    const source = getSource();

    if (CLIENT_SIDE_SOURCES.includes(source)) {
        warn(`Source "${source}" embeds in the browser`, 'checks below are limited');
        note('The probes here talk to the server directly, so they cannot reproduce a browser-side embedding. Activation still works; only this panel\'s measurements are unavailable.');
    }

    const topK = Number(vectors.max_entries) || WI_DEFAULT_MAX_ENTRIES;
    const threshold = Number(vectors.score_threshold) || WI_DEFAULT_THRESHOLD;

    // --- Stage A, entry eligibility ----------------------------------------
    let scanned = [];

    try {
        scanned = await getScannedEntries();
    } catch (error) {
        bad(error.message, 'cannot continue');
        return rows;
    }

    if (scanned.length === 0) {
        bad('No lorebook entries are in scope for this chat at all', 'nothing attached');
        note('No lorebook is attached globally, to this character, to this chat or to your persona. Keyword entries would not fire either — if they are firing, they are coming from a book attached somewhere this check cannot see.');
        return rows;
    }

    const { byWorld, skipped } = groupEligibleEntries(scanned);
    const worlds = [...byWorld.keys()];
    const totalEligible = [...byWorld.values()].reduce((sum, list) => sum + list.length, 0);

    ok(`${scanned.length} entries in scope across ${new Set(scanned.map(x => x.world)).size} attached lorebook(s)`);

    if (bookName) {
        const inScope = scanned.some(x => x.world === bookName);

        if (!inScope) {
            bad(`"${bookName}" is not attached to this chat`, 'never scanned');
            note('Its entries are not in the list SillyTavern scans, so nothing in it can activate by any route. Attach it in the World Info panel, to the character, or to this chat.');
            const attached = await getAttachedWorldNames();
            if (attached.length > 0) {
                note(`Globally attached right now: ${attached.join(', ')}`);
            }
            return rows;
        }

        ok(`"${bookName}" is attached and in scope`);
    }

    if (totalEligible === 0) {
        bad('No entry in scope is marked as vectorised', 'nothing to nominate');
        note(`Skipped: ${skipped.notVectorised} not vectorised, ${skipped.disabled} disabled, ${skipped.empty} with no content, ${skipped.orphaned} with no book. The tri-state in the entry header must be on the 🔗 setting — "constant" wins over it, so an entry that is both reads as constant.`);
        return rows;
    }

    ok(`${totalEligible} entries eligible for vector matching`, `${worlds.length} book(s)`);

    if (skipped.notVectorised > 0) {
        note(`${skipped.notVectorised} entries in scope are not marked vectorised and are keyword-only.`);
    }

    if (bookName && !byWorld.has(bookName)) {
        bad(`No entry in "${bookName}" is eligible`, 'not marked vectorised');
        note('The book is attached, but every entry in it is disabled, empty, or not on the 🔗 setting. Use "Mark all as vectorized" in the Vectorising section.');
        return rows;
    }

    // --- Stage A, index integrity ------------------------------------------
    const auditTargets = bookName ? [bookName] : worlds;
    let anyIndexed = false;
    let anyWrongHash = 0;
    let anyMissing = 0;

    for (const world of auditTargets) {
        let audit;

        try {
            audit = await auditWorldIndex(world);
        } catch (error) {
            warn(`Could not audit "${world}": ${error.message}`);
            continue;
        }

        anyIndexed = anyIndexed || audit.indexed.length > 0;
        anyWrongHash += audit.wrongHash.length;
        anyMissing += audit.missing.length;

        if (audit.missing.length === 0 && audit.wrongHash.length === 0) {
            ok(`"${world}" fully indexed`, `${audit.indexed.length}/${audit.eligible}`);
            continue;
        }

        if (audit.wrongHash.length > 0) {
            bad(`${audit.wrongHash.length} entries in "${world}" are indexed under the wrong hash`, 'decorator mismatch');
            note('These entries start with a decorator line (@@…). SillyTavern strips decorators before it hashes an entry, so the lookup asks for the hash of the stripped text while the index holds the hash of the original. The embedding exists and is never found. Purge this book and re-sync it from the Vectorising section to re-file them.');
            for (const row of audit.wrongHash.slice(0, 5)) {
                note(`  ${row.label}`, `uid ${row.uid}`);
            }
        }

        if (audit.missing.length > 0) {
            warn(`${audit.missing.length} of ${audit.eligible} entries in "${world}" have no embedding`, 're-sync');
            for (const row of audit.missing.slice(0, 5)) {
                note(`  ${row.label}`, `uid ${row.uid}`);
            }
        }

        if (audit.orphanHashes.length > 0) {
            note(`${audit.orphanHashes.length} stored embeddings in "${world}" match no current entry — edited or deleted since. Harmless, but they occupy the index.`);
        }
    }

    if (!anyIndexed && (anyMissing > 0 || anyWrongHash > 0)) {
        bad('Nothing usable is indexed for these books', 'run a sync');
        note('The vectors extension only embeds lazily, at generation time, and only entries it has never seen. If it errored once mid-sync it will not retry. Use "Sync this book" or /lvt-sync-all.');
        return rows;
    }

    // --- Stage A, the query -------------------------------------------------
    const queryText = buildVectorQueryText();

    if (!queryText) {
        bad('The query text is empty', 'nothing to match against');
        note(`Vector matching embeds the last ${Number(vectors.query) || WI_DEFAULT_QUERY_MESSAGES} non-empty message(s) and compares them to your entries. With no query there is no similarity, so nothing activates — while keyword entries, which scan a much deeper window, carry on matching normally. This happens on the first message of a chat and when recent messages are attachments only.`);
        return rows;
    }

    ok(`Query is ${queryText.length} characters`, `last ${Number(vectors.query) || WI_DEFAULT_QUERY_MESSAGES} message(s)`);
    note(`Query: "${truncate(queryText.replace(/\s+/g, ' ').trim(), 140)}"`);

    // --- Stage A, the actual retrieval --------------------------------------
    const collectionIds = worlds.map(getWorldCollectionId);
    const idToWorld = new Map(worlds.map(w => [getWorldCollectionId(w), w]));

    const live = await queryWorldCollections(collectionIds, queryText, topK, threshold);

    if (live.error) {
        bad(`The vector query failed (HTTP ${live.status})`, 'server rejected it');
        note(live.error);
        note('The vectors extension swallows this error, so activation just silently stops. Keyword matching does not touch the vector backend, which is why it is unaffected.');
        return rows;
    }

    const hitsByWorld = Object.entries(live.results)
        .map(([id, value]) => [idToWorld.get(id) ?? id, (value?.hashes ?? []).length])
        .filter(([, count]) => count > 0);

    const totalHits = hitsByWorld.reduce((sum, [, count]) => sum + count, 0);

    if (totalHits === 0) {
        bad(`Nothing scored above your threshold of ${threshold}`, 'no nominations');

        // Separate "the index is unreachable" from "the index is fine, the bar
        // is too high" — they look identical from the outside and have
        // opposite fixes.
        const unfiltered = await queryWorldCollections(collectionIds, queryText, 100, 0);
        const rawTotal = Object.values(unfiltered.results ?? {}).reduce((sum, x) => sum + (x?.hashes?.length ?? 0), 0);

        if (rawTotal === 0) {
            note('At threshold 0 the collections still return nothing, so the problem is the index, not the bar: these books have no reachable embeddings for this source. If you changed embedding model or source, every stored vector is in the old model\'s space — purge and re-sync.');
        } else {
            note(`At threshold 0 the same query returns ${rawTotal} entries, so retrieval works and your threshold is simply above every score. Lower "Score threshold" towards 0.15 and try again. Use the probe button to see the actual scores.`);
        }

        return rows;
    }

    ok(`${totalHits} entries would be nominated`, `threshold ${threshold}`);

    for (const [world, count] of hitsByWorld.sort((a, b) => b[1] - a[1])) {
        note(`  ${world}: ${count}`, world === bookName ? 'your book' : '');
    }

    // "Max entries" is a global budget pooled across every attached book, not a
    // per-book one. With several books attached, a single dense book can take
    // every slot and the others go quiet — which reads exactly like the quiet
    // book being broken.
    if (worlds.length > 1 && totalHits >= topK) {
        warn(`All ${topK} result slots are used, shared across ${worlds.length} books`, 'crowding');
        note('"Max entries" is pooled across every attached lorebook, not applied per book: hits from all of them are ranked together and the top few win. A book whose entries score slightly lower gets nothing, however well indexed it is. Raise Max entries, or detach books you are not using.');
    }

    if (bookName && !hitsByWorld.some(([world]) => world === bookName)) {
        bad(`"${bookName}" won none of the ${topK} slots`, 'outranked');
        note('Its entries are indexed and reachable, but other attached books scored higher for this message. Run the probe to see where its best entry actually placed.');
        return rows;
    }

    // --- Stage B, what happened to the nominations --------------------------
    if (lastGenerationAt === null) {
        note('Everything up to the hand-off is working. Send a message and run this again to see what world-info.js did with the nominations.');
        return rows;
    }

    if (lastGenerationDryRun) {
        warn('The last generation was a dry run', 'interceptors skipped');
        note('SillyTavern skips generation interceptors on dry runs, so the vectors extension never got to nominate anything, while the world info scan still ran. Send a real message and check again.');
        return rows;
    }

    if (lastGenerationType === 'quiet') {
        warn('The last generation was a "quiet" one', 'vectors opt out');
        note('The vectors extension returns immediately on quiet generations — summaries, background prompts, some group triggers. Keyword entries still fire there, vectorised ones never do. If your normal replies work and only these do not, this is the whole answer.');
        return rows;
    }

    if (!sawForceActivate) {
        bad('No nomination event was seen last generation', 'interceptor did not run');
        note('Retrieval works when this panel calls it directly, but the vectors extension did not emit WORLDINFO_FORCE_ACTIVATE during the last generation, so world-info.js was never told about any of it. That points at the interceptor itself: another extension aborting the interceptor chain before Vector Storage runs, or Vector Storage being disabled in the extensions list while its settings remain on.');
        return rows;
    }

    ok(`${pendingVectorEntries.size} entries were nominated last generation`);

    if (lastDroppedVectorEntries.length === 0) {
        ok('All of them survived the world info scan', 'stage B clean');
        note('The vectorised path is working end to end. If entries still are not visible in the reply, they were inserted — check position and depth in the Placement section.');
        return rows;
    }

    bad(`${lastDroppedVectorEntries.length} nominated entries were dropped by the world info scan`, 'stage B');
    note('These were found by similarity and handed to world-info.js, which then discarded them for reasons that have nothing to do with vectors. This is where "the vectors are fine but nothing appears" comes from.');

    const trigger = lastGenerationType || 'normal';

    for (const entry of lastDroppedVectorEntries.slice(0, 6)) {
        rows.push({ left: '✖', text: entryLabel(entry), right: entry.world ?? '' });

        for (const reason of explainVectorDrop(entry, { trigger })) {
            note(`  ${reason.certain ? '→ ' : '? '}${reason.text}`);
        }
    }

    return rows;
}

/**
 * Raw look at what the lorebook collections return, with no interpretation.
 *
 * diagnoseWorldInfoRecall() answers "is it broken and where". This answers
 * "what are the numbers", which is what threshold tuning actually needs: the
 * real ranking across books, and how far the entries you care about are from
 * the cut.
 *
 * @param {string} bookName
 * @returns {Promise<{left: string, text: string, right: string}[]>}
 */
async function probeWorldInfoRecall(bookName = '') {
    const vectors = extension_settings.vectors ?? {};
    const rows = [];

    const ok = (text, right = '') => rows.push({ left: '✅', text, right });
    const bad = (text, right = '') => rows.push({ left: '❌', text, right });
    const warn = (text, right = '') => rows.push({ left: '⚠️', text, right });
    const note = (text, right = '') => rows.push({ left: '·', text, right });

    const topK = Number(vectors.max_entries) || WI_DEFAULT_MAX_ENTRIES;
    const threshold = Number(vectors.score_threshold) || WI_DEFAULT_THRESHOLD;

    const queryText = buildVectorQueryText();

    if (!queryText) {
        bad('Query text is empty', 'nothing to search with');
        return rows;
    }

    const { byWorld } = groupEligibleEntries(await getScannedEntries());
    const worlds = [...byWorld.keys()];

    if (worlds.length === 0) {
        bad('No eligible entries in any attached book', 'nothing to query');
        return rows;
    }

    note(`Query: "${truncate(queryText.replace(/\s+/g, ' ').trim(), 120)}"`, `${queryText.length} chars`);
    note(`Books queried: ${worlds.join(', ')}`);
    trace(`WI PROBE: ${worlds.length} books, topK ${topK}, threshold ${threshold}`);

    const collectionIds = worlds.map(getWorldCollectionId);

    // Hash → entry, so returned hashes can be named rather than printed as
    // numbers. Built from the same content the lookup is keyed by.
    const byHash = new Map();

    for (const [world, entries] of byWorld) {
        for (const entry of entries) {
            byHash.set(getStringHash(entry.content), { world, entry });
        }
    }

    // A wide, unfiltered pass first: this is the true ranking, before either
    // the threshold or the shared slot budget touches it.
    const wide = await queryWorldCollections(collectionIds, queryText, 200, 0);

    if (wide.error) {
        bad(`Query failed (HTTP ${wide.status})`, 'server rejected it');
        note(wide.error);
        return rows;
    }

    const wideCount = Object.values(wide.results).reduce((sum, x) => sum + (x?.hashes?.length ?? 0), 0);

    if (wideCount === 0) {
        bad('Collections return nothing even at threshold 0', 'index unreachable');
        note('The books have stored hashes but the query finds none of them. That is an embedding-space mismatch — the index was built with a different model or source than the one selected now. Purge and re-sync.');
        return rows;
    }

    ok(`${wideCount} entries returned at threshold 0`, 'retrieval works');

    const live = await queryWorldCollections(collectionIds, queryText, topK, threshold);
    const winners = new Set();

    for (const value of Object.values(live.results)) {
        for (const hash of value?.hashes ?? []) {
            winners.add(Number(hash));
        }
    }

    if (winners.size === 0) {
        warn(`Nothing clears threshold ${threshold}`, 'lower it');
    } else {
        ok(`${winners.size} of ${topK} slots filled at threshold ${threshold}`);
    }

    // The pooled ranking across books is the number that explains a quiet book,
    // and nothing in SillyTavern shows it. It cannot simply be read off the
    // response either: the server sorts every book's hits together, slices the
    // top K, and only *then* groups them by collection, so the grouping throws
    // the interleaved order away and scores are never returned at all.
    //
    // It is still recoverable. At threshold 0, topK = k returns exactly the
    // global top k, so the entry that appears when k goes to k+1 is the one
    // ranked k+1. Walking k upwards reconstructs the true order one place at a
    // time. That costs one query per rank, which is why it is bounded and only
    // runs from a button.
    const ranking = await rankAcrossWorlds(collectionIds, queryText, Math.min(Math.max(topK + 3, 10), 15));

    rows.push({ left: '·', text: `— true ranking across all ${worlds.length} book(s) —`, right: '' });

    let sawMine = false;

    ranking.forEach((hash, index) => {
        const known = byHash.get(Number(hash));
        const world = known?.world ?? '(unknown book)';
        const won = winners.has(Number(hash));
        const mine = bookName && world === bookName;

        sawMine = sawMine || mine;

        rows.push({
            left: won ? '🔗' : (mine ? '🔸' : '·'),
            text: `${index + 1}. ${known ? entryLabel(known.entry) : `hash ${hash}`}`,
            right: `${world}${won ? ' — activated' : ''}`,
        });
    });

    if (ranking.length === 0) {
        note('The ranking probe returned nothing, so this build may not accept incremental topK. The counts above still hold.');
    } else if (winners.size > 0 && winners.size < ranking.length) {
        note(`Everything below place ${winners.size} was found and then discarded — by the threshold, by the ${topK}-slot budget, or both.`);
    }

    if (bookName) {
        if (winners.size > 0 && [...winners].some(hash => byHash.get(hash)?.world === bookName)) {
            ok(`"${bookName}" is winning slots`, 'activating normally');
        } else if (sawMine) {
            warn(`"${bookName}" ranks, but not high enough to activate`, 'outranked');
            note(`Its entries are indexed and scoring, they are just below the cut. "Max entries" is shared across every attached book, so raising it or detaching books you are not using will let them through — that is the fix here, not re-vectorising.`);
        } else {
            warn(`Nothing from "${bookName}" appears in the top ${ranking.length}`, 'far behind or unindexed');
            note('Run the index audit next. If it reports the book fully indexed, its entries are simply not similar to the current conversation, and lowering the threshold alone will not help while other books outrank them.');
        }
    }

    note('Use "Measure similarity" on a vector hit in the entries list above for an exact score on any single entry.');

    return rows;
}

// ---------------------------------------------------------------------------
// Chat vector memories
//
// The vectors extension retrieves old chat messages by similarity and drops
// them into an extension prompt rather than emitting an event, so there is
// nothing to listen for. But the injected text is readable, and it is built
// from message text verbatim — so matching it back against the chat recovers
// exactly which messages were pulled.
// ---------------------------------------------------------------------------

/** Injection slots used by the vectors extension. */
const VECTOR_CHAT_TAG = '3_vectors';
const VECTOR_FILES_TAG = '4_vectors_data_bank';

/** @type {{index: number, name: string, preview: string, isUser: boolean}[]} */
let lastChatMemories = [];
let lastDataBankChars = 0;
/** Raw slot contents, kept so the diagnostic can tell "nothing recalled" from
 *  "recalled but not matched back to a message". */
let lastInjectedChatText = '';
let lastCaptureAt = null;

/**
 * getPromptText() collapses runs of newlines before joining, so the injected
 * copy of a message won't be byte-identical to the original.
 * @param {string} text
 * @returns {string}
 */
function normaliseForMatch(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Works out which past messages the vectors extension retrieved this turn.
 */
function captureChatMemories() {
    const injected = String(extension_prompts?.[VECTOR_CHAT_TAG]?.value ?? '');
    lastDataBankChars = String(extension_prompts?.[VECTOR_FILES_TAG]?.value ?? '').length;
    lastInjectedChatText = injected;
    lastCaptureAt = new Date();

    if (!injected.trim()) {
        lastChatMemories = [];
        trace('CHAT_MEMORIES: slot empty');
        return;
    }

    const haystack = normaliseForMatch(injected);
    const chat = getContext()?.chat ?? [];
    const found = [];

    for (const [index, message] of chat.entries()) {
        const text = normaliseForMatch(message?.mes);

        // Very short messages ("ok", "...") produce false positives against a
        // long injected block, so they're left out rather than guessed at.
        if (text.length < 12) {
            continue;
        }

        // Compare on a prefix: the tail of a long message may be truncated in
        // the template, but the opening is reproduced verbatim.
        if (haystack.includes(text.slice(0, 80))) {
            found.push({
                index,
                name: String(message?.name ?? '?'),
                preview: truncate(text, 70),
                isUser: !!message?.is_user,
            });
            continue;
        }

        // Macros are substituted before injection ({{user}} becomes a name), so
        // a message containing them won't match on its opening. Fall back to a
        // distinctive run from the middle, which is usually macro-free.
        if (text.length >= 60 && haystack.includes(text.slice(30, 90))) {
            found.push({
                index,
                name: String(message?.name ?? '?'),
                preview: truncate(text, 70),
                isUser: !!message?.is_user,
            });
        }
    }

    lastChatMemories = found;
    trace(`CHAT_MEMORIES: ${found.length} matched, ${injected.length} chars injected`);
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
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        pendingVectorKeys = new Set();
        pendingVectorEntries = new Map();
        lastDroppedVectorEntries = [];
        sawForceActivate = false;
        sawActivationThisGeneration = false;
        lastQueryText = buildQueryText();
        lastChatMemories = [];
        lastDataBankChars = 0;

        // Two generation shapes never run the vectorised path at all, and both
        // look identical to a broken setup from the outside: SillyTavern skips
        // interceptors entirely on a dry run, and the vectors extension bails
        // out of its own interceptor on a quiet prompt. Keyword entries fire
        // normally in both. Recording them here is what lets the diagnostic
        // rule that out instead of blaming the index.
        lastGenerationType = String(type ?? 'normal');
        lastGenerationDryRun = !!dryRun;
        lastGenerationAt = new Date();

        trace(`GENERATION_STARTED (type: ${lastGenerationType}${dryRun ? ', dry run' : ''})`);
    });

    // Chat memories are injected by a generation interceptor, which runs well
    // before this — by GENERATE_AFTER_DATA the slot is filled and stable.
    eventSource.on(event_types.GENERATE_AFTER_DATA, () => {
        try {
            captureChatMemories();
            renderChatMemories();
        } catch (error) {
            console.error(`${MODULE}: failed to read chat memories`, error);
        }
    });

    eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE, (entries) => {
        trace(`FORCE_ACTIVATE: ${Array.isArray(entries) ? entries.length : 'not-an-array'}`);
        if (!Array.isArray(entries)) {
            return;
        }

        // Seeing the event at all is the stage A / stage B dividing line: it
        // means retrieval succeeded and world-info.js owns the outcome from
        // here. Its absence means nothing was ever nominated.
        sawForceActivate = true;

        for (const entry of entries) {
            pendingVectorKeys.add(entryKey(entry));
            pendingVectorEntries.set(entryKey(entry), entry);
        }
    });

    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        trace(`WI_ACTIVATED: ${Array.isArray(entries) ? entries.length : 'not-an-array'}`);
        if (!Array.isArray(entries)) {
            return;
        }

        sawActivationThisGeneration = true;

        // The decisive comparison for "keywords fire, vectors don't": every
        // entry the vectors extension nominated that is not in the set
        // world-info.js actually inserted was found by similarity and then
        // thrown away by the scan, for reasons unrelated to vectors.
        const activatedKeys = new Set(entries.map(entryKey));
        lastDroppedVectorEntries = [...pendingVectorEntries.entries()]
            .filter(([key]) => !activatedKeys.has(key))
            .map(([, entry]) => entry);

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
            trace(`${endEvent} (activated: ${sawActivationThisGeneration}, nominated: ${pendingVectorEntries.size})`);
            if (sawActivationThisGeneration) {
                return;
            }
            // Nothing activated this turn — say so rather than leaving stale rows up.
            // WORLD_INFO_ACTIVATED is skipped entirely when the set is empty, so
            // this is also the only place a total wipe-out of the nominations is
            // observable: everything vectors found was dropped by the scan.
            lastDroppedVectorEntries = [...pendingVectorEntries.values()];
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

    if (lastActivation.length === 0 && lastDroppedVectorEntries.length === 0) {
        container.append('<div class="lvt-log-empty">Nothing yet — send a message.</div>');
        renderDroppedVectorEntries();
        return;
    }

    const counts = countBySource();
    const time = lastActivationAt ? lastActivationAt.toLocaleTimeString() : '';

    container.append(
        $('<div class="lvt-log-head"></div>').text(
            `${lastActivation.length} fired · ${counts.vector} vector · ${counts.keyword} keyword · ${counts.constant} constant · ${time}`,
        ),
    );

    renderDroppedVectorEntries();

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
 * The other half of the activation log: entries the vectors extension found and
 * nominated, which world-info.js then refused.
 *
 * Nothing in SillyTavern surfaces these. They are absent from the activation
 * log because they never activated, and absent from the vectors extension's
 * console output because from its side the hand-off succeeded. The result is a
 * setup that looks correct everywhere you can look, while the entries never
 * appear — which is what makes it read as "vectors just don't work here".
 */
function renderDroppedVectorEntries() {
    const container = $('#lvt_wi_dropped');

    if (container.length === 0) {
        return;
    }

    container.empty();

    if (lastGenerationDryRun) {
        container.append('<div class="lvt-log-empty">Last generation was a dry run — interceptors are skipped, so nothing was nominated.</div>');
        return;
    }

    if (lastGenerationType === 'quiet') {
        container.append('<div class="lvt-log-empty">Last generation was a quiet prompt — the vectors extension opts out of those entirely.</div>');
        return;
    }

    if (lastDroppedVectorEntries.length === 0) {
        container.append($('<div class="lvt-log-empty"></div>').text(
            sawForceActivate
                ? `All ${pendingVectorEntries.size} nominated entries made it into the prompt.`
                : 'No entries were nominated by similarity last generation.',
        ));
        return;
    }

    container.append($('<div class="lvt-log-head"></div>').text(
        `${lastDroppedVectorEntries.length} of ${pendingVectorEntries.size} nominated entries were dropped by the world info scan`,
    ));

    const trigger = lastGenerationType || 'normal';

    for (const entry of lastDroppedVectorEntries) {
        const row = $('<div class="lvt-log-row lvt-dropped"></div>');
        row.append($('<span class="lvt-log-badge"></span>').text('✖'));
        row.append($('<span class="lvt-log-name"></span>').text(entryLabel(entry)));
        row.append($('<span class="lvt-log-world"></span>').text(entry.world ?? ''));

        const details = $('<div class="lvt-log-details"></div>').hide();

        row.on('click', function () {
            const expanded = $(this).toggleClass('lvt-expanded').hasClass('lvt-expanded');
            details.toggle(expanded);

            if (expanded && !details.data('filled')) {
                details.data('filled', true);

                for (const reason of explainVectorDrop(entry, { trigger })) {
                    details.append(
                        $('<div class="lvt-detail"></div>')
                            .addClass(reason.certain ? '' : 'lvt-detail-dim')
                            .text(`${reason.certain ? '→' : '?'} ${reason.text}`),
                    );
                }
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

    // Not automatic: each measurement costs ~9 short embedding calls, and the
    // log can hold a dozen vector hits at once.
    const scoreLine = $('<div class="lvt-detail lvt-detail-dim"></div>');
    const scoreButton = $('<button class="menu_button lvt-measure">Measure similarity</button>');

    scoreButton.on('click', async (event) => {
        event.stopPropagation();
        scoreButton.prop('disabled', true);
        scoreLine.text('Measuring…');

        try {
            const result = await measureSimilarity(
                item.world,
                item.contentHash,
                message => scoreLine.text(message),
            );

            if (!result) {
                scoreLine.text('Below the measurable range — scored under 0.0001 for this query.');
                return;
            }

            const threshold = Number(extension_settings.vectors?.score_threshold);
            const margin = Number.isFinite(threshold)
                ? ` — your threshold is ${threshold}, so it cleared by ${(result.score - threshold).toFixed(3)}.`
                : '';

            scoreLine.text(`Similarity ≈ ${result.score.toFixed(3)} (±${result.precision.toFixed(3)})${margin}`);
        } catch (error) {
            scoreLine.text(`Measurement failed: ${error.message}`);
        } finally {
            scoreButton.prop('disabled', false);
        }
    });

    container.append(scoreButton);
    container.append(scoreLine);
}

/**
 * Walks the preconditions for chat recall in the order the vectors extension
 * checks them, and reports the first one that fails. Nothing here changes any
 * setting — it only explains why the list came back empty.
 * @returns {Promise<{left: string, text: string, right: string}[]>}
 */
async function diagnoseChatRecall() {
    const settings = extension_settings.vectors ?? {};
    const context = getContext();
    const chat = context?.chat ?? [];
    const chatId = context?.chatId;
    const rows = [];

    const ok = (text, right = '') => rows.push({ left: '✅', text, right });
    const bad = (text, right = '') => rows.push({ left: '❌', text, right });
    const warn = (text, right = '') => rows.push({ left: '⚠️', text, right });

    if (!settings.enabled_chats) {
        bad('"Enabled for chat messages" is off in Vector Storage', 'fix this first');
        return rows;
    }

    ok('Chat vectorisation is enabled');

    if (!chatId) {
        bad('No chat is open');
        return rows;
    }

    const protect = Number(settings.protect) || 5;
    const insert = Number(settings.insert) || 3;
    const threshold = Number(settings.score_threshold) || 0.25;

    // The last `protect` messages are already in context verbatim, so they are
    // deliberately excluded from recall.
    const recallable = Math.max(0, chat.length - protect);

    if (chat.length < protect) {
        bad(`Chat is ${chat.length} messages, Retain# is ${protect}`, 'too short');
        rows.push({ left: '·', text: `Recall does nothing until the chat is longer than ${protect} messages.`, right: '' });
        return rows;
    }

    ok(`${recallable} message${recallable === 1 ? '' : 's'} old enough to recall`, `Retain# ${protect}`);

    let stored = [];

    try {
        stored = await getSavedHashes(String(chatId));
    } catch (error) {
        bad(`Could not read the chat's vector store: ${error.message}`);
        return rows;
    }

    if (stored.length === 0) {
        bad('No messages are indexed for this chat', 'press Vectorize All');
        rows.push({ left: '·', text: 'Messages are only indexed as they are sent while chat vectorisation is on. Anything older needs Vectorize All in Vector Storage.', right: '' });
        return rows;
    }

    // Messages sent before the feature was switched on never got indexed, and
    // that gap is invisible in the Vector Storage UI.
    if (stored.length < recallable) {
        warn(`Only ${stored.length} of ${recallable} are indexed`, 'run Vectorize All');
    } else {
        ok(`${stored.length} messages indexed`);
    }

    ok(`Query uses the last ${Number(settings.query) || 2} message${(Number(settings.query) || 2) === 1 ? '' : 's'}`);
    ok(`Would insert up to ${insert}, threshold ${threshold}`);

    if (threshold > 0.5) {
        warn(`Threshold ${threshold} is high — few messages will clear it`, 'try 0.25');
    }

    // The decisive check: was the injection slot actually filled? An empty slot
    // means recall returned nothing. A full slot with no matched rows means
    // recall worked and the message matching below it failed.
    if (lastCaptureAt === null) {
        warn('No generation seen yet this session', 'send a message');
        return rows;
    }

    if (!lastInjectedChatText.trim()) {
        bad('Nothing was injected last generation', 'recall found nothing');
        rows.push({
            left: '·',
            text: `Everything above is configured correctly, so no message scored above ${threshold} against your last ${Number(settings.query) || 2}. Lower the threshold to around 0.15 and try again, or say something that echoes an older message.`,
            right: '',
        });
        return rows;
    }

    ok(`${lastInjectedChatText.length} characters were injected last generation`);

    if (lastChatMemories.length === 0) {
        bad('But none matched back to a message', 'display bug, not recall');
        rows.push({ left: '·', text: 'Recall is working — the panel just could not line the text up with your chat. Raw text below:', right: '' });
        rows.push({ left: '"', text: truncate(lastInjectedChatText.replace(/\s+/g, ' ').trim(), 300), right: '' });
        return rows;
    }

    ok(`${lastChatMemories.length} matched back to chat messages`);

    return rows;
}

/**
 * Renders which past messages were pulled back into context this turn.
 */
function renderChatMemories() {
    const container = $('#lvt_chat_memories');

    if (container.length === 0) {
        return;
    }

    container.empty();

    const settings = extension_settings.vectors ?? {};

    if (!settings.enabled_chats) {
        container.append('<div class="lvt-log-empty">Chat vectorisation is off in Vector Storage.</div>');
        return;
    }

    if (lastChatMemories.length === 0) {
        container.append($('<div class="lvt-log-empty"></div>').text(
            lastDataBankChars > 0
                ? 'No past messages retrieved this turn (data bank text was injected).'
                : 'No past messages retrieved this turn.',
        ));
        return;
    }

    const depth = Number.isFinite(Number(settings.depth)) ? `, injected at depth ${settings.depth}` : '';
    container.append($('<div class="lvt-log-head"></div>').text(
        `${lastChatMemories.length} message${lastChatMemories.length === 1 ? '' : 's'} recalled${depth}`,
    ));

    const chatLength = getContext()?.chat?.length ?? 0;

    for (const memory of lastChatMemories) {
        const row = $('<div class="lvt-log-row"></div>');
        // How far back it came from is the useful part — recalling something
        // from 200 messages ago is the feature working, recalling message 3 of
        // 5 usually means the protect window is too small.
        const back = chatLength > 0 ? `${chatLength - memory.index} back` : `#${memory.index}`;

        row.append($('<span class="lvt-log-badge"></span>').text(memory.isUser ? '🟣' : '🟠'));
        row.append($('<span class="lvt-log-name"></span>').text(`${memory.name}: ${memory.preview}`));
        row.append($('<span class="lvt-log-world"></span>').text(back));

        row.on('click', function () {
            $(this).toggleClass('lvt-expanded');
        });

        container.append(row);
    }

    if (lastDataBankChars > 0) {
        container.append($('<div class="lvt-log-empty"></div>').text(
            `Plus ${lastDataBankChars} characters from the data bank.`,
        ));
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

/**
 * Counts what state a lorebook's entries are in, plus how many have embeddings.
 *
 * `embedded` is -1 rather than 0 when the collection cannot be read, because
 * "no collection yet" and "collection exists and is empty" need different fixes
 * and both are common.
 *
 * @param {string} name
 * @returns {Promise<{total: number, vectorized: number, constant: number, disabled: number, embedded: number}>}
 */
async function getBookStats(name) {
    const data = await loadWorldInfo(name);

    if (!data || !data.entries) {
        throw new Error(`Could not load lorebook "${name}"`);
    }

    const entries = Object.values(data.entries);
    const stats = {
        total: entries.length,
        // The tri-state reads `constant` first, so an entry flagged both is
        // constant in practice and must not be counted as vectorised.
        vectorized: entries.filter(x => x.vectorized === true && x.constant !== true).length,
        constant: entries.filter(x => x.constant === true).length,
        disabled: entries.filter(x => x.disable === true).length,
        embedded: -1,
    };

    try {
        stats.embedded = (await getSavedHashes(getWorldCollectionId(name))).length;
    } catch {
        // No collection has been created for this book yet.
    }

    return stats;
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

/**
 * Reopens whatever was open last session. Everything starts collapsed, so a
 * fresh install shows five headers instead of a wall of controls.
 */
function restoreSectionState() {
    const open = getSettings().openSections;

    for (const [id, isOpen] of Object.entries(open)) {
        if (!isOpen) {
            continue;
        }

        const drawer = $(`#lvt_panel .lvt-section[data-section="${id}"]`);
        drawer.find('> .inline-drawer-header .inline-drawer-icon')
            .removeClass('down fa-circle-chevron-down')
            .addClass('up fa-circle-chevron-up');
        drawer.find('> .inline-drawer-content').show();
    }
}

function initAutoSync() {
    if (!event_types.WORLDINFO_UPDATED) {
        console.warn(`${MODULE}: this SillyTavern build has no WORLDINFO_UPDATED event, auto-sync unavailable`);
        return;
    }

    eventSource.on(event_types.WORLDINFO_UPDATED, (name) => queueAutoSync(String(name ?? '')));
}

function addSettingsPanel() {
    const section = (id, icon, title, subtitle, body) => `
        <div class="inline-drawer lvt-section" data-section="${id}">
            <div class="inline-drawer-toggle inline-drawer-header lvt-section-header">
                <div class="lvt-section-title">
                    <i class="fa-solid ${icon}"></i>
                    <span>${title}</span>
                    <small class="lvt-section-sub">${subtitle}</small>
                </div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content lvt-section-body">${body}</div>
        </div>`;

    const vectorising = `
        <div class="lvt-buttons">
            <button id="lvt_vectorize" class="menu_button lvt-primary">Sync this lorebook</button>
            <button id="lvt_stats" class="menu_button">Show counts</button>
        </div>
        <div class="lvt-hint">Sync embeds anything you've edited since last time. Unchanged entries are skipped, so it's quick to re-run.</div>

        <label class="checkbox_label" for="lvt_auto_sync">
            <input id="lvt_auto_sync" type="checkbox">
            <span>Sync automatically when a lorebook is saved</span>
        </label>

        <div class="lvt-subhead">Everything at once</div>
        <div class="lvt-buttons">
            <button id="lvt_vectorize_all" class="menu_button">Sync every lorebook</button>
            <button id="lvt_mark" class="menu_button">Mark all entries vectorized</button>
            <button id="lvt_unmark" class="menu_button">Unmark all entries</button>
        </div>
        <div class="lvt-hint"><b>Vectorized</b> entries activate by meaning rather than by keyword — they fire when the conversation is <i>about</i> them, with no trigger word needed.</div>

        <div class="lvt-subhead lvt-subhead-danger">Destructive</div>
        <div class="lvt-buttons">
            <button id="lvt_purge" class="menu_button lvt-danger">Purge this lorebook's vectors</button>
        </div>
        <div class="lvt-hint">Deletes the stored embeddings. The entries themselves are untouched and a sync rebuilds them.</div>`;

    const grouping = `
        <div class="lvt-hint">Grouped entries compete instead of stacking: however many match, only one gets inserted. This is the fix for a lorebook where too much fires at once.</div>

        <div class="lvt-field">
            <label for="lvt_group_terms">Words to match</label>
            <input id="lvt_group_terms" class="text_pole" type="text" placeholder="dorm, cafeteria, infirmary">
            <div class="lvt-hint">Comma-separated. Every entry containing any of these gets grouped.</div>
        </div>

        <div class="lvt-field">
            <label for="lvt_group_name">Group name</label>
            <input id="lvt_group_name" class="text_pole" type="text" placeholder="leave blank to name groups after each word">
        </div>

        <div class="lvt-field">
            <label for="lvt_group_allow">Let this many through per turn</label>
            <input id="lvt_group_allow" class="text_pole" type="number" min="1" max="20" step="1" value="1">
            <div class="lvt-hint">Above 1, matches are split into that many pools so more than one can fire.</div>
        </div>

        <div class="lvt-buttons">
            <button id="lvt_group_preview" class="menu_button">Preview matches</button>
            <button id="lvt_group_apply" class="menu_button lvt-primary">Group them</button>
        </div>
        <div id="lvt_group_results" class="lvt-log lvt-preview"></div>

        <div class="inline-drawer lvt-subsection">
            <div class="inline-drawer-toggle inline-drawer-header lvt-subsection-header">
                <span>Search options</span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="lvt-checkgrid">
                    <label class="checkbox_label" for="lvt_group_in_title">
                        <input id="lvt_group_in_title" type="checkbox" checked>
                        <span>Title</span>
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
                        <span>Whole words</span>
                    </label>
                    <label class="checkbox_label" for="lvt_group_case">
                        <input id="lvt_group_case" type="checkbox">
                        <span>Match case</span>
                    </label>
                    <label class="checkbox_label" for="lvt_group_skip_disabled">
                        <input id="lvt_group_skip_disabled" type="checkbox" checked>
                        <span>Skip disabled</span>
                    </label>
                </div>
                <div class="lvt-field">
                    <label for="lvt_group_mode">If an entry is already grouped</label>
                    <select id="lvt_group_mode" class="text_pole">
                        <option value="replace">Replace its groups</option>
                        <option value="append">Add this group alongside</option>
                        <option value="fill">Leave it alone</option>
                    </select>
                </div>
            </div>
        </div>

        <div class="inline-drawer lvt-subsection">
            <div class="inline-drawer-toggle inline-drawer-header lvt-subsection-header">
                <span>Who wins the group</span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="lvt_group_apply_settings">
                    <input id="lvt_group_apply_settings" type="checkbox" checked>
                    <span>Apply these settings too</span>
                </label>
                <label class="checkbox_label" for="lvt_group_prioritize">
                    <input id="lvt_group_prioritize" type="checkbox">
                    <span>Prioritize — always beats its group</span>
                </label>
                <div class="lvt-field">
                    <label for="lvt_group_weight">Weight</label>
                    <input id="lvt_group_weight" class="text_pole" type="number" min="1" max="10000" step="1" value="100">
                    <div class="lvt-hint">Odds of winning. An entry at 200 wins twice as often as one at 100.</div>
                </div>
                <div class="lvt-field">
                    <label for="lvt_group_scoring">Scoring</label>
                    <select id="lvt_group_scoring" class="text_pole">
                        <option value="default">Use global setting</option>
                        <option value="on">On — most keyword hits wins</option>
                        <option value="off">Off — roll the dice</option>
                    </select>
                </div>
            </div>
        </div>

        <div class="lvt-subhead">Other actions</div>
        <div class="lvt-buttons">
            <button id="lvt_group_list" class="menu_button">List existing groups</button>
            <button id="lvt_group_undo" class="menu_button">Undo last bulk change</button>
            <button id="lvt_group_clear" class="menu_button lvt-danger">Ungroup matching entries</button>
        </div>`;

    const placement = `
        <div class="lvt-hint">Where entries land in the prompt. Closer to the end of the chat means more influence on the next reply.</div>

        <div class="lvt-field">
            <label for="lvt_place_filter">Apply to</label>
            <select id="lvt_place_filter" class="text_pole">
                <option value="all">Every entry</option>
                <option value="vectorized">Vectorized only</option>
                <option value="notVectorized">Keyword-only</option>
                <option value="constant">Constant only</option>
                <option value="grouped">Grouped only</option>
                <option value="matching">Matching the words in Grouping</option>
            </select>
            <label class="checkbox_label" for="lvt_place_skip_disabled">
                <input id="lvt_place_skip_disabled" type="checkbox" checked>
                <span>Skip disabled entries</span>
            </label>
        </div>

        <div class="lvt-field">
            <label class="checkbox_label" for="lvt_place_set_position">
                <input id="lvt_place_set_position" type="checkbox" checked>
                <span>Set position</span>
            </label>
            <select id="lvt_place_position" class="text_pole">
                <option value="4" selected>@Depth — inside the chat</option>
                <option value="0">↑Char — before character card</option>
                <option value="1">↓Char — after character card</option>
                <option value="2">↑AN — before author's note</option>
                <option value="3">↓AN — after author's note</option>
                <option value="5">↑EM — before example messages</option>
                <option value="6">↓EM — after example messages</option>
            </select>
        </div>

        <div class="lvt-grid">
            <div class="lvt-field">
                <label for="lvt_place_role">Role</label>
                <select id="lvt_place_role" class="text_pole">
                    <option value="0">System</option>
                    <option value="1">User</option>
                    <option value="2">Assistant</option>
                </select>
            </div>
            <div class="lvt-field">
                <label class="checkbox_label" for="lvt_place_set_depth">
                    <input id="lvt_place_set_depth" type="checkbox" checked>
                    <span>Depth</span>
                </label>
                <input id="lvt_place_depth" class="text_pole" type="number" min="0" max="9999" step="1" value="4">
            </div>
        </div>
        <div class="lvt-hint">Role and depth only apply at @Depth. Depth counts back from the newest message — 1 is right before the reply, higher sits further back.</div>

        <div class="lvt-grid">
            <div class="lvt-field">
                <label class="checkbox_label" for="lvt_place_set_order">
                    <input id="lvt_place_set_order" type="checkbox">
                    <span>Order</span>
                </label>
                <input id="lvt_place_order" class="text_pole" type="number" min="0" max="99999" step="1" value="100">
            </div>
            <div class="lvt-field">
                <label for="lvt_place_order_step">Step per entry</label>
                <input id="lvt_place_order_step" class="text_pole" type="number" min="-100" max="100" step="1" value="0">
            </div>
        </div>
        <div class="lvt-hint">Insertion order breaks ties between entries in the same spot — lower goes in first. Step numbers them in sequence instead of giving them all the same value.</div>

        <div class="lvt-buttons">
            <button id="lvt_place_summary" class="menu_button">Show current placement</button>
            <button id="lvt_place_apply" class="menu_button lvt-primary">Apply placement</button>
            <button id="lvt_place_undo" class="menu_button">Undo last bulk change</button>
        </div>
        <div id="lvt_place_results" class="lvt-log lvt-preview"></div>`;

    const keywords = `
        <div class="lvt-field">
            <label for="lvt_bank_select">Saved keyword sets</label>
            <select id="lvt_bank_select" class="text_pole"></select>
        </div>
        <div class="lvt-buttons">
            <button id="lvt_bank_save" class="menu_button">Save current keywords</button>
            <button id="lvt_bank_restore" class="menu_button">Restore selected</button>
            <button id="lvt_bank_export" class="menu_button">Export to file</button>
            <button id="lvt_bank_import" class="menu_button">Import from file</button>
            <button id="lvt_bank_delete" class="menu_button lvt-danger">Delete selected</button>
        </div>
        <input id="lvt_bank_file" type="file" accept="application/json,.json" hidden>

        <div class="lvt-subhead lvt-subhead-danger">Clear keywords</div>
        <div class="lvt-hint">Strips trigger words so entries rely on similarity alone. Permanent — save a set first.</div>
        <div class="lvt-checkgrid">
            <label class="checkbox_label" for="lvt_include_secondary">
                <input id="lvt_include_secondary" type="checkbox" checked>
                <span>Secondary too</span>
            </label>
            <label class="checkbox_label" for="lvt_auto_bank">
                <input id="lvt_auto_bank" type="checkbox" checked>
                <span>Back up first</span>
            </label>
        </div>
        <div class="lvt-buttons">
            <button id="lvt_clear_keys" class="menu_button lvt-danger">Clear all keywords</button>
        </div>`;

    const activity = `
        <div class="lvt-subhead">Lorebook entries</div>
        <div id="lvt_activation_log" class="lvt-log"></div>
        <div class="lvt-hint">Tap an entry to see why it fired. Vector hits can be measured for similarity.</div>

        <div class="lvt-subhead">Lorebook recall</div>
        <div class="lvt-hint">Vectorised entries reach the prompt by a different route than keyword ones, so they fail differently. These follow that route end to end.</div>
        <div id="lvt_wi_dropped" class="lvt-log"></div>
        <div class="lvt-hint">Entries similarity found and handed over, which the world info scan then discarded. Tap one for the gates it could have failed, in the order they are checked.</div>
        <div class="lvt-buttons">
            <button id="lvt_wi_diagnose" class="menu_button lvt-primary">Why aren't lorebook entries firing?</button>
            <button id="lvt_wi_probe" class="menu_button" title="Rebuilds the true cross-book ranking. Costs about 15 short embedding calls.">Probe the lorebook collections</button>
            <button id="lvt_wi_audit" class="menu_button">Audit this book's index</button>
            <button id="lvt_wi_copy" class="menu_button">Copy report</button>
        </div>
        <div id="lvt_wi_results" class="lvt-log lvt-preview"></div>

        <div class="lvt-subhead">Recalled chat messages</div>
        <div id="lvt_chat_memories" class="lvt-log"></div>
        <div class="lvt-hint">Old messages the vectors extension pulled back into context. 🟣 you, 🟠 the character. "N back" is how far up the chat it came from.</div>
        <div class="lvt-buttons">
            <button id="lvt_diagnose" class="menu_button">Why is nothing being recalled?</button>
            <button id="lvt_probe" class="menu_button lvt-primary">Probe the chat collection</button>
            <button id="lvt_preview_strip" class="menu_button">Preview what gets embedded</button>
        </div>
        <div id="lvt_diagnose_results" class="lvt-log lvt-preview"></div>

        <div class="lvt-subhead">Event trace</div>
        <div id="lvt_trace" class="lvt-log lvt-trace"></div>
        <div class="lvt-buttons">
            <button id="lvt_trace_copy" class="menu_button">Copy trace</button>
        </div>`;

    const html = `
    <div id="lvt_panel" class="lvt-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lorebook Vector Tools</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="lvt-book">
                    <label for="lvt_book_select">Lorebook</label>
                    <div class="lvt-row">
                        <select id="lvt_book_select" class="text_pole flex1"></select>
                        <div id="lvt_refresh" class="menu_button fa-solid fa-rotate" title="Refresh list"></div>
                    </div>
                    <div id="lvt_status" class="lvt-status"></div>
                </div>

                ${section('vectors', 'fa-cube', 'Vectorising', 'embed and sync', vectorising)}
                ${section('grouping', 'fa-layer-group', 'Grouping', 'stop entries stacking', grouping)}
                ${section('placement', 'fa-arrows-up-down', 'Placement', 'position, depth, order', placement)}
                ${section('keywords', 'fa-key', 'Keywords', 'clear and back up', keywords)}
                ${section('activity', 'fa-wave-square', 'Activity', 'what fired last turn', activity)}
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    restoreSectionState();

    // Remember which sections were left open. The delegated handler in
    // script.js does the animation; this just records the outcome after it.
    $('#lvt_panel').on('inline-drawer-toggle', '.lvt-section', function () {
        const id = String($(this).data('section') ?? '');

        if (!id) {
            return;
        }

        const open = $(this).find('> .inline-drawer-header .inline-drawer-icon').hasClass('up');
        getSettings().openSections[id] = open;
        saveSettingsDebounced();
    });

    $('#lvt_refresh').on('click', () => {
        refreshBookList();
        setStatus('List refreshed.');
    });

    // The lorebook checks are scoped to the selected book when there is one:
    // "why is nothing firing" and "why is nothing from *this* book* firing" are
    // different questions with different answers, and the second is usually the
    // one being asked.
    const runWorldInfoCheck = async (head, fn) => {
        const container = $('#lvt_wi_results');
        container.empty().append('<div class="lvt-log-empty">Checking…</div>');

        try {
            const rows = await fn(getSelectedBook());
            lastWorldInfoReport = { head, rows };
            renderResultList(container, head, rows);
        } catch (error) {
            const rows = [{ left: '❌', text: String(error.message ?? error), right: '' }];
            lastWorldInfoReport = { head: `${head} — failed`, rows };
            renderResultList(container, `${head} — failed`, rows);
        }
    };

    $('#lvt_wi_diagnose').on('click', () => runWorldInfoCheck(
        'Lorebook recall checklist',
        book => diagnoseWorldInfoRecall(book),
    ));

    $('#lvt_wi_probe').on('click', () => runWorldInfoCheck(
        'Raw lorebook collection probe',
        book => probeWorldInfoRecall(book),
    ));

    $('#lvt_wi_audit').on('click', () => runWorldInfoCheck(
        'Index audit',
        async (book) => {
            if (!book) {
                return [{ left: '❌', text: 'Pick a lorebook first.', right: '' }];
            }

            const audit = await auditWorldIndex(book);
            const rows = [];

            if (!audit.attached) {
                rows.push({ left: '❌', text: `"${book}" is not attached to this chat, so it is never scanned.`, right: 'not in scope' });
                return rows;
            }

            rows.push({ left: '·', text: `${audit.eligible} entries eligible, ${audit.stored} embeddings stored`, right: book });
            rows.push({ left: audit.indexed.length === audit.eligible ? '✅' : '⚠️', text: `${audit.indexed.length} correctly indexed and reachable`, right: '' });

            if (audit.wrongHash.length > 0) {
                rows.push({ left: '❌', text: `${audit.wrongHash.length} indexed under a hash nothing looks up`, right: 'decorators' });
                rows.push({ left: '·', text: 'Their content begins with a @@ decorator line. SillyTavern strips decorators before hashing, so the lookup and the index disagree and these can never be returned. Purge this book and re-sync it.', right: '' });
            }

            for (const row of audit.wrongHash) {
                rows.push({ left: '✖', text: row.label, right: `uid ${row.uid}` });
            }

            if (audit.missing.length > 0) {
                rows.push({ left: '⚠️', text: `${audit.missing.length} have no embedding at all`, right: 'sync needed' });
            }

            for (const row of audit.missing.slice(0, 20)) {
                rows.push({ left: '·', text: row.label, right: `uid ${row.uid}` });
            }

            if (audit.orphanHashes.length > 0) {
                rows.push({ left: '·', text: `${audit.orphanHashes.length} stored embeddings match no current entry — leftovers from edits.`, right: '' });
            }

            return rows;
        },
    ));

    $('#lvt_wi_copy').on('click', async () => {
        if (!lastWorldInfoReport) {
            setStatus('Run a check first.', 'error');
            return;
        }

        const text = [
            lastWorldInfoReport.head,
            ...lastWorldInfoReport.rows.map(r => `${r.left} ${r.text}${r.right ? `  [${r.right}]` : ''}`),
        ].join('\n');

        try {
            await navigator.clipboard.writeText(text);
            setStatus('Report copied.', 'success');
        } catch {
            setStatus('Copy failed — select the text manually.', 'error');
        }
    });

    $('#lvt_diagnose').on('click', async () => {
        const container = $('#lvt_diagnose_results');
        container.empty().append('<div class="lvt-log-empty">Checking…</div>');

        try {
            const rows = await diagnoseChatRecall();
            renderResultList(container, 'Chat recall checklist', rows);
        } catch (error) {
            renderResultList(container, 'Check failed', [{ left: '❌', text: String(error.message ?? error), right: '' }]);
        }
    });

    $('#lvt_probe').on('click', async () => {
        const container = $('#lvt_diagnose_results');
        container.empty().append('<div class="lvt-log-empty">Querying…</div>');

        try {
            const rows = await probeChatRecall();
            renderResultList(container, 'Raw chat collection probe', rows);
        } catch (error) {
            renderResultList(container, 'Probe failed', [{ left: '❌', text: String(error.message ?? error), right: '' }]);
        }
    });

    $('#lvt_preview_strip').on('click', async () => {
        const container = $('#lvt_diagnose_results');
        container.empty().append('<div class="lvt-log-empty">Sampling…</div>');

        try {
            const rows = await previewStripping();
            renderResultList(container, 'What gets embedded after stripping', rows);
        } catch (error) {
            renderResultList(container, 'Preview failed', [{ left: '❌', text: String(error.message ?? error), right: '' }]);
        }
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
        name: 'lvt-why',
        helpString: 'Explains why vectorised lorebook entries are not activating. Pass a lorebook name to scope it to that book.',
        returns: 'the checklist as text',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'lorebook name (optional)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: () => world_names.map(x => new SlashCommandEnumValue(x)),
            }),
        ],
        callback: async (_args, value) => {
            const rows = await diagnoseWorldInfoRecall(String(value ?? '').trim());
            return rows.map(r => `${r.left} ${r.text}${r.right ? ` [${r.right}]` : ''}`).join('\n');
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
    renderDroppedVectorEntries();
    renderChatMemories();
    renderTrace();
    console.log(`${MODULE}: loaded`);
});
