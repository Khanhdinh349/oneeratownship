'use strict';

const { randomInt, randomBytes, createHmac } = require('node:crypto');
const { conflict } = require('./errors');

/**
 * §XVIII.2 / §XLI Process 8 — Confirmation Code.
 * Format: OE-XXXXX  (fixed prefix "OE-" + 5 random chars). Must be unique.
 *
 * Alphabet excludes visually ambiguous characters (0/O, 1/I/L) because the code is
 * read aloud and typed in by receptionists at the desk. Uppercase alnum only, so
 * every generated code still matches the required OE-XXXXX shape.
 */
const CODE_PREFIX = 'OE-';
const CODE_BODY_LENGTH = 5;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CONFIRMATION_CODE_RE = /^OE-[0-9A-Z]{5}$/;

function generateConfirmationCodeCandidate() {
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return CODE_PREFIX + body;
}

function isValidConfirmationCode(code) {
  return typeof code === 'string' && CONFIRMATION_CODE_RE.test(code.trim().toUpperCase());
}

function normalizeConfirmationCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * Generates a code guaranteed unique against `exists`.
 * §XVIII — "Không được tạo duplicate Confirmation Code."
 */
async function generateUniqueConfirmationCode(exists, maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const code = generateConfirmationCodeCandidate();
    // Sequential by nature: each candidate is only generated because the previous
    // one was taken.
    // eslint-disable-next-line no-await-in-loop
    if (!await exists(code)) return code;
  }
  throw conflict('CONFIRMATION_CODE_EXHAUSTED',
    'Unable to allocate a unique confirmation code. Please retry.');
}

/**
 * §XVIII.3 / §XLI Process 9 — QR payload.
 * The QR encodes an opaque high-entropy token only; no personal data is embedded.
 * An HMAC suffix lets the backend reject malformed/forged tokens before it touches
 * the database.
 */
function generateQrToken(secret) {
  const nonce = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 16);
  return `${nonce}.${sig}`;
}

function isWellFormedQrToken(token, secret) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [nonce, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{16}$/.test(sig)) return false;
  const expected = createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 16);
  return expected === sig;
}

/** What the printed QR image actually contains — a reference, not personal data. */
function qrPayload(baseUrl, token) {
  return `${baseUrl.replace(/\/+$/, '')}/checkin?t=${token}`;
}

module.exports = {
  CODE_PREFIX, CODE_BODY_LENGTH, CODE_ALPHABET, CONFIRMATION_CODE_RE,
  generateConfirmationCodeCandidate, isValidConfirmationCode, normalizeConfirmationCode,
  generateUniqueConfirmationCode, generateQrToken, isWellFormedQrToken, qrPayload,
};
