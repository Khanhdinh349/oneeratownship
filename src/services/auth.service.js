'use strict';

const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { verifyPassword, hashPassword } = require('../domain/passwords');
const { mapUser } = require('./mappers');
const { unauthorized, badRequest, notFound, conflict } = require('../domain/errors');
const { ROLES, ONLINE_WINDOW_MINUTES } = require('../config/master-data');
const { toDateString } = require('../domain/dates');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // one working shift

/** Short enough not to annoy a reception desk, long enough not to be guessed. */
const MIN_PASSWORD_LENGTH = 8;

/** "Last seen" is refreshed at most this often per account. */
const SEEN_WRITE_INTERVAL_MS = 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * §XXV — Receptionist login. Stateless HMAC session token so the API stays
 * horizontally scalable; the token carries user id, role and office.
 */
class AuthService {
  constructor({ db, secret, clock = () => new Date() }) {
    this.db = db;
    this.secret = secret;
    this.clock = clock;
  }

  #sign(payloadJson) {
    return createHmac('sha256', this.secret).update(payloadJson).digest('base64url');
  }

  issueToken(user) {
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      officeId: user.salesOfficeId ?? null,
      iat: this.clock().getTime(),
      exp: this.clock().getTime() + TOKEN_TTL_MS,
      jti: randomUUID(),
    };
    const json = JSON.stringify(payload);
    return `${b64url(json)}.${this.#sign(json)}`;
  }

  async verifyToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) throw unauthorized('Malformed token.');
    const [body, sig] = token.split('.');
    let json;
    try {
      json = Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      throw unauthorized('Malformed token.');
    }
    const expected = this.#sign(json);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized('Invalid token signature.');

    let payload;
    try {
      payload = JSON.parse(json);
    } catch {
      throw unauthorized('Malformed token.');
    }
    if (typeof payload.exp !== 'number' || payload.exp < this.clock().getTime()) {
      throw unauthorized('Session expired. Please sign in again.');
    }
    const user = await this.getUserById(payload.sub);
    if (!user || !user.active) throw unauthorized('Account is not active.');
    await this.#touch(user);
    return user;
  }

  /**
   * Notes that the account is in use. Written at most once a minute per account:
   * every request passes through here, and a write on each one would double the
   * database traffic to keep a figure nobody reads to the second.
   */
  async #touch(user) {
    const now = this.clock();
    const last = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
    if (now.getTime() - last < SEEN_WRITE_INTERVAL_MS) return;
    try {
      await this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
        .run(now.toISOString(), user.id);
      user.lastSeenAt = now.toISOString();
    } catch { /* activity tracking must never fail a request */ }
  }

  /**
   * What the administrator's list shows beside each account.
   *   ONLINE  — seen within the last few minutes
   *   TODAY   — seen earlier today
   *   RECENT  — seen within the last seven days
   *   DORMANT — not seen for more than seven days
   *   NEVER   — has never signed in
   */
  activityOf(user) {
    const seen = user.lastSeenAt || user.lastLoginAt;
    if (!seen) return 'NEVER';
    const now = this.clock();
    const age = now.getTime() - new Date(seen).getTime();
    if (age <= ONLINE_WINDOW_MINUTES * 60000) return 'ONLINE';
    if (toDateString(seen) === toDateString(now)) return 'TODAY';
    if (age <= 7 * 86400000) return 'RECENT';
    return 'DORMANT';
  }

  async login(username, password) {
    if (!username || !password) {
      throw badRequest('CREDENTIALS_REQUIRED', 'Username and password are required.');
    }
    const row = await this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
    if (!row || row.active !== 1 || !verifyPassword(String(password), row.password_hash, row.password_salt)) {
      // Identical message for unknown user and wrong password.
      throw unauthorized('Invalid username or password.');
    }
    const at = this.clock().toISOString();
    await this.db.prepare(
      'UPDATE users SET last_login_at = ?, last_seen_at = ?, login_count = login_count + 1 WHERE id = ?',
    ).run(at, at, row.id);
    const user = await this.getUserById(row.id);
    return {
      token: this.issueToken(user),
      user,
      expiresIn: TOKEN_TTL_MS,
      // The client shows the change-password screen; the API enforces it.
      mustChangePassword: user.mustChangePassword,
    };
  }

  async getUserById(id) {
    return mapUser(await this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async listUsers({ role = null, salesOfficeId = null } = {}) {
    const where = [];
    const params = [];
    if (role) { where.push('role = ?'); params.push(role); }
    if (salesOfficeId) { where.push('sales_office_id = ?'); params.push(salesOfficeId); }
    const sql = `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY role, username`;
    return (await this.db.prepare(sql).all(...params)).map(mapUser)
      .map((u) => ({ ...u, activity: this.activityOf(u) }));
  }

  /** §XXXIX Administrator — manage users / receptionists. */
  async createUser({ username, fullName, role, salesOfficeId = null, password }) {
    if (!Object.values(ROLES).includes(role)) {
      throw badRequest('INVALID_ROLE', `Role must be one of: ${Object.values(ROLES).join(', ')}.`);
    }
    if (!username || !fullName || !password) {
      throw badRequest('MISSING_FIELDS', 'username, fullName and password are required.');
    }
    if ([ROLES.RECEPTIONIST, ROLES.SALES].includes(role) && !salesOfficeId) {
      throw badRequest('OFFICE_REQUIRED', `${role} accounts must be assigned to a Sales Office.`);
    }
    const name = String(username).trim().toLowerCase();
    // Checked here rather than left to the UNIQUE constraint, which would reach
    // the administrator as "unexpected server error" and tell them nothing.
    await this.#assertUsernameFree(name);
    this.#assertPassword(password);
    const { hash, salt } = hashPassword(String(password));
    const id = randomUUID();
    await this.db.prepare(`
      INSERT INTO users (id, username, full_name, role, sales_office_id, password_hash, password_salt,
                         active, created_at, must_change_password)
      VALUES (?,?,?,?,?,?,?,1,?,1)`
    // must_change_password = 1: the administrator chose this password, so its
    // owner replaces it at the first sign-in.
    ).run(id, name, fullName, role, salesOfficeId, hash, salt, this.clock().toISOString());
    return await this.getUserById(id);
  }

  async setUserActive(id, active) {
    const user = await this.getUserById(id);
    if (!user) throw notFound('USER_NOT_FOUND', 'User not found.');
    if (!active) await this.#assertNotLastAdministrator(user);
    await this.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    return await this.getUserById(id);
  }

  // ------------------------------------------------------------ account admin

  /**
   * The system must never be left without a way in. Deactivating, deleting or
   * demoting the last active administrator is refused rather than discovered at
   * the worst possible moment.
   */
  async #assertNotLastAdministrator(user) {
    if (user.role !== ROLES.ADMINISTRATOR || !user.active) return;
    const { n } = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE role = ? AND active = 1 AND id <> ?',
    ).get(ROLES.ADMINISTRATOR, user.id);
    if (Number(n) === 0) {
      throw conflict('LAST_ADMINISTRATOR',
        'This is the only active administrator. Create or activate another one first.');
    }
  }

  #assertPassword(password) {
    const value = String(password ?? '');
    if (value.length < MIN_PASSWORD_LENGTH) {
      throw badRequest('WEAK_PASSWORD',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    return value;
  }

  async #assertUsernameFree(username, exceptId = null) {
    const row = await this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (row && row.id !== exceptId) {
      throw conflict('USERNAME_TAKEN', `The username "${username}" is already in use.`);
    }
  }

  /** Edit an account: name, username, role and office. */
  async updateUser(id, { username, fullName, role, salesOfficeId } = {}) {
    const user = await this.getUserById(id);
    if (!user) throw notFound('USER_NOT_FOUND', 'User not found.');

    const nextRole = role ?? user.role;
    if (!Object.values(ROLES).includes(nextRole)) {
      throw badRequest('INVALID_ROLE', `Role must be one of: ${Object.values(ROLES).join(', ')}.`);
    }
    if (nextRole !== user.role) await this.#assertNotLastAdministrator(user);

    const nextOffice = salesOfficeId === undefined ? user.salesOfficeId : (salesOfficeId || null);
    if ([ROLES.RECEPTIONIST, ROLES.SALES].includes(nextRole) && !nextOffice) {
      throw badRequest('OFFICE_REQUIRED', `${nextRole} accounts must be assigned to a Sales Office.`);
    }
    // A manager or administrator is not tied to a desk, so an office left over
    // from an earlier role is cleared rather than quietly kept.
    const office = [ROLES.RECEPTIONIST, ROLES.SALES].includes(nextRole) ? nextOffice : null;

    const nextName = (fullName ?? user.fullName).trim();
    if (!nextName) throw badRequest('MISSING_FIELDS', 'fullName is required.');

    const nextUsername = username === undefined
      ? user.username
      : String(username).trim().toLowerCase();
    if (!nextUsername) throw badRequest('MISSING_FIELDS', 'username is required.');
    if (nextUsername !== user.username) await this.#assertUsernameFree(nextUsername, id);

    await this.db.prepare(
      'UPDATE users SET username = ?, full_name = ?, role = ?, sales_office_id = ? WHERE id = ?',
    ).run(nextUsername, nextName, nextRole, office, id);
    return await this.getUserById(id);
  }

  /**
   * An administrator sets a new password without knowing the old one.
   * Every session the account holds is signed with data that does not include the
   * password, so sessions already issued stay valid until they expire — say so
   * rather than implying the account is locked out immediately.
   */
  async resetPassword(id, newPassword) {
    const user = await this.getUserById(id);
    if (!user) throw notFound('USER_NOT_FOUND', 'User not found.');
    const value = this.#assertPassword(newPassword);
    const { hash, salt } = hashPassword(value);
    // Someone else now knows this password, so its owner has to replace it.
    await this.db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1,
                       password_changed_at = ? WHERE id = ?`)
      .run(hash, salt, this.clock().toISOString(), id);
    return await this.getUserById(id);
  }

  /** A signed-in user changes their own password, proving the current one first. */
  async changeOwnPassword(id, currentPassword, newPassword) {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) throw notFound('USER_NOT_FOUND', 'User not found.');
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash, row.password_salt)) {
      throw unauthorized('The current password is not correct.');
    }
    const value = this.#assertPassword(newPassword);
    if (value === String(currentPassword)) {
      throw badRequest('PASSWORD_UNCHANGED', 'The new password must differ from the current one.');
    }
    const { hash, salt } = hashPassword(value);
    // Chosen by its owner: the first-login requirement is satisfied.
    await this.db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0,
                       password_changed_at = ? WHERE id = ?`)
      .run(hash, salt, this.clock().toISOString(), id);
    return await this.getUserById(id);
  }

  /**
   * Deletes an account outright.
   *
   * An account that has checked visitors in cannot be deleted: §Rule 7 requires
   * every check-in to name the receptionist responsible for it, and the row holds
   * a foreign key to this user. Those accounts are deactivated instead, which
   * stops the sign-in without rewriting history.
   */
  async deleteUser(id, { actorId = null } = {}) {
    const user = await this.getUserById(id);
    if (!user) throw notFound('USER_NOT_FOUND', 'User not found.');
    if (actorId && actorId === id) {
      throw conflict('CANNOT_DELETE_SELF', 'You cannot delete the account you are signed in with.');
    }
    await this.#assertNotLastAdministrator(user);

    const { n } = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM checkins WHERE receptionist_id = ?',
    ).get(id);
    if (Number(n) > 0) {
      throw conflict('USER_HAS_HISTORY',
        `This account has ${n} check-in(s) recorded against it and cannot be deleted. `
        + 'Deactivate it instead — that stops the sign-in and keeps the record of who received each visitor.');
    }

    await this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { id, username: user.username, deleted: true };
  }
}

module.exports = { AuthService, TOKEN_TTL_MS, MIN_PASSWORD_LENGTH };
