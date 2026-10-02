'use strict';

const { randomUUID } = require('node:crypto');

/**
 * The administrative audit log.
 *
 * Who changed what, when. Registrations already record their own lifecycle in
 * `status_history`; this covers everything that history cannot see — accounts
 * created, renamed, locked or deleted, passwords reset, slot capacity changed,
 * periods closed and reopened.
 *
 * Two rules the rest of the app depends on:
 *
 *  1. **Recording never breaks the action.** A log row is written after the work
 *     succeeds, and a failure to write it is reported to stderr rather than
 *     thrown — losing a log line is bad, losing the administrator's change
 *     because the log was unavailable is worse.
 *  2. **A password never reaches the log.** Only the fact that one was reset.
 */

/** Fields that must never be written to the log, whatever a caller passes. */
const NEVER_LOG = ['password', 'newPassword', 'currentPassword', 'passwordHash', 'password_hash',
  'passwordSalt', 'password_salt', 'token', 'qrToken', 'qr_token'];

function scrub(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_LOG.includes(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

class AuditService {
  constructor({ db, clock = () => new Date() }) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * @param {object} entry
   * @param {{id: string, name: string, role: string}} entry.actor
   * @param {string} entry.action   e.g. 'USER_CREATED'
   * @param {string} entry.entity   e.g. 'USER'
   * @param {string} [entry.entityId]
   * @param {string} entry.summary  one readable line, in Vietnamese
   * @param {object} [entry.details]
   */
  async record({ actor, action, entity, entityId = null, summary, details = null }) {
    try {
      await this.db.prepare(`
        INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, entity,
                               entity_id, summary, details)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), this.clock().toISOString(),
        actor.id, actor.name, actor.role,
        action, entity, entityId, summary,
        details ? JSON.stringify(scrub(details)) : null,
      );
    } catch (err) {
      // See rule 1 above: the change has already happened and must stand.
      process.stderr.write(`[audit] could not record ${action}: ${err.message}\n`);
    }
  }

  async list({
    action = null, entity = null, actorId = null, from = null, to = null,
    page = 1, pageSize = 50,
  } = {}) {
    const where = [];
    const params = [];
    if (action) { where.push('action = ?'); params.push(action); }
    if (entity) { where.push('entity = ?'); params.push(entity); }
    if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
    // The column is an ISO timestamp, so a date compares as its own prefix.
    if (from) { where.push('at >= ?'); params.push(`${from}T00:00:00.000Z`); }
    if (to) { where.push('at <= ?'); params.push(`${to}T23:59:59.999Z`); }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);

    const { n } = await this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${sql}`).get(...params);
    const rows = await this.db.prepare(`
      SELECT * FROM audit_log ${sql} ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (current - 1) * size);

    return {
      items: rows.map((r) => ({
        seq: Number(r.seq),
        id: r.id,
        at: r.at,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id ?? null,
        summary: r.summary,
        details: r.details ? JSON.parse(r.details) : null,
      })),
      page: current,
      pageSize: size,
      total: Number(n),
      totalPages: Math.max(1, Math.ceil(Number(n) / size)),
    };
  }

  /** The distinct actions present, so the filter offers only what exists. */
  async actions() {
    const rows = await this.db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all();
    return rows.map((r) => r.action);
  }
}

module.exports = { AuditService, NEVER_LOG };
