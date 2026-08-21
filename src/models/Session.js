/**
 * WhatsApp Session Model
 *
 * Session metadata (id, token, status) is kept in an in-memory cache for
 * fast synchronous access (matching the original better-sqlite3 API so no
 * callers elsewhere in the app need to change), and mirrored to the
 * `whatsapp_baileys_auth` Supabase table (reusing it as a generic
 * key-value store, under a reserved file_key) so it survives restarts.
 * Actual WhatsApp auth credentials live in Supabase via supabaseAuthState.js.
 */

const { db } = require('../config/database');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const TABLE = 'whatsapp_baileys_auth';
const META_KEY = '__session_meta__';

let supabase = null;
function getClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    if (!supabase) supabase = createClient(url, key, { auth: { persistSession: false } });
    return supabase;
}

// In-memory cache of session metadata, keyed by session id.
const cache = new Map();

function persist(row) {
    const client = getClient();
    if (!client) return;
    client
        .from(TABLE)
        .upsert(
            { session_id: row.id, file_key: META_KEY, data: row, updated_at: new Date().toISOString() },
            { onConflict: 'session_id,file_key' }
        )
        .then(({ error }) => {
            if (error) console.error(`[Session] Supabase persist failed for ${row.id}:`, error.message);
        });
}

function persistDelete(sessionId) {
    const client = getClient();
    if (!client) return;
    client
        .from(TABLE)
        .delete()
        .eq('session_id', sessionId)
        .then(({ error }) => {
            if (error) console.error(`[Session] Supabase delete failed for ${sessionId}:`, error.message);
        });
}

class Session {
    /**
     * Load all session metadata rows from Supabase into the in-memory cache.
     * MUST be awaited once at startup, before any other Session method is used.
     */
    static async hydrate() {
        const client = getClient();
        if (!client) {
            console.warn('[Session] Supabase not configured; session metadata will NOT survive restarts');
            return;
        }
        const { data, error } = await client
            .from(TABLE)
            .select('data')
            .eq('file_key', META_KEY);
        if (error) {
            console.error('[Session] Failed to hydrate session metadata from Supabase:', error.message);
            return;
        }
        cache.clear();
        for (const row of data || []) {
            const meta = row.data;
            if (meta && meta.id) cache.set(meta.id, meta);
        }
        console.log(`[Session] Hydrated ${cache.size} session(s) metadata from Supabase`);
    }

    static create(sessionId, ownerEmail = null) {
        const existingSession = this.findById(sessionId);
        if (existingSession) {
            throw new Error('Session already exists');
        }

        let validOwnerEmail = null;
        if (ownerEmail) {
            const userStmt = db.prepare('SELECT email FROM users WHERE email = ?');
            const user = userStmt.get(ownerEmail.toLowerCase());
            if (user) validOwnerEmail = user.email;
        }

        const token = crypto.randomUUID();
        const now = new Date().toISOString();
        const row = {
            id: sessionId,
            owner_email: validOwnerEmail,
            token,
            status: 'CREATING',
            detail: null,
            created_at: now,
            updated_at: now
        };
        cache.set(sessionId, row);
        persist(row);
        return row;
    }

    static findById(sessionId) {
        return cache.get(sessionId) || null;
    }

    static findByToken(token) {
        for (const row of cache.values()) {
            if (row.token === token) return row;
        }
        return null;
    }

    static getAll(ownerEmail = null, isAdmin = false) {
        let rows = Array.from(cache.values());
        if (!isAdmin && ownerEmail) {
            rows = rows.filter((r) => r.owner_email === ownerEmail);
        }
        return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    static updateStatus(sessionId, status, detail = null) {
        const existing = cache.get(sessionId);
        if (!existing) return null;
        const updated = { ...existing, status, detail, updated_at: new Date().toISOString() };
        cache.set(sessionId, updated);
        persist(updated);
        return updated;
    }

    static delete(sessionId) {
        const existed = cache.has(sessionId);
        cache.delete(sessionId);
        if (existed) persistDelete(sessionId);
        return existed;
    }

    static getToken(sessionId) {
        const session = this.findById(sessionId);
        return session ? session.token : null;
    }

    static validateToken(sessionId, token) {
        const session = this.findById(sessionId);
        return !!(session && session.token === token);
    }

    static countActive() {
        let count = 0;
        for (const row of cache.values()) {
            if (row.status !== 'DISCONNECTED' && row.status !== 'DELETED') count++;
        }
        return count;
    }

    static getSessionIdsByOwner(ownerEmail) {
        const owner = ownerEmail.toLowerCase();
        return Array.from(cache.values())
            .filter((r) => r.owner_email === owner)
            .map((r) => r.id);
    }

    /**
     * No-op: session credentials now live in Supabase (see supabaseAuthState.js),
     * not on the local filesystem, so there's nothing to sync from disk anymore.
     * Kept as a method so existing callers don't need to change.
     */
    static syncWithFilesystem() {
        // Intentionally empty.
    }
}

module.exports = Session;
