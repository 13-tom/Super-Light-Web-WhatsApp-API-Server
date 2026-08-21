/**
 * Supabase-backed Baileys auth state
 *
 * Drop-in replacement for @whiskeysockets/baileys' useMultiFileAuthState,
 * but persists session credentials/keys to a Supabase Postgres table
 * (whatsapp_baileys_auth) instead of the local filesystem.
 *
 * Why: on ephemeral-disk hosts (e.g. Render free tier), the auth_info_baileys/
 * folder is wiped on every restart/redeploy, forcing a fresh QR scan each
 * time. Storing the same data in Supabase survives restarts since it's an
 * external, persistent database.
 *
 * Mirrors Baileys' own implementation (BufferJSON replacer/reviver, one
 * logical "file" per row) so behavior matches useMultiFileAuthState exactly.
 */

const { createClient } = require('@supabase/supabase-js');
const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = 'whatsapp_baileys_auth';

let supabase = null;
function getClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new Error(
            'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use Supabase-backed auth state'
        );
    }
    if (!supabase) {
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }
        });
    }
    return supabase;
}

// fixFileName mirrors Baileys' own sanitization so key naming stays consistent
function fixFileName(file) {
    return file?.replace(/\//g, '__')?.replace(/:/g, '-');
}

async function readData(sessionId, fileKey) {
    const client = getClient();
    const key = fixFileName(fileKey);
    const { data, error } = await client
        .from(TABLE)
        .select('data')
        .eq('session_id', sessionId)
        .eq('file_key', key)
        .maybeSingle();
    if (error || !data) return null;
    try {
        // Round-trip through JSON.stringify/parse with BufferJSON reviver,
        // since Supabase returns the jsonb column as a plain JS object.
        return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
    } catch (e) {
        return null;
    }
}

async function writeData(sessionId, fileKey, value) {
    const client = getClient();
    const key = fixFileName(fileKey);
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await client
        .from(TABLE)
        .upsert(
            { session_id: sessionId, file_key: key, data: serialized, updated_at: new Date().toISOString() },
            { onConflict: 'session_id,file_key' }
        );
    if (error) console.error(`[SupabaseAuthState] write failed for ${sessionId}/${key}:`, error.message);
}

async function removeData(sessionId, fileKey) {
    const client = getClient();
    const key = fixFileName(fileKey);
    const { error } = await client
        .from(TABLE)
        .delete()
        .eq('session_id', sessionId)
        .eq('file_key', key);
    if (error) console.error(`[SupabaseAuthState] delete failed for ${sessionId}/${key}:`, error.message);
}

/**
 * Delete ALL rows for a session (used on logout, mirrors fs.rmSync(sessionDir)).
 */
async function clearSessionData(sessionId) {
    const client = getClient();
    const { error } = await client.from(TABLE).delete().eq('session_id', sessionId);
    if (error) console.error(`[SupabaseAuthState] clear failed for ${sessionId}:`, error.message);
}

/**
 * Equivalent to useMultiFileAuthState(folder), but backed by Supabase.
 */
async function useSupabaseAuthState(sessionId) {
    const creds = (await readData(sessionId, 'creds.json')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(sessionId, `${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const fileKey = `${category}-${id}.json`;
                            tasks.push(
                                value ? writeData(sessionId, fileKey, value) : removeData(sessionId, fileKey)
                            );
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(sessionId, 'creds.json', creds)
    };
}

module.exports = { useSupabaseAuthState, clearSessionData };
