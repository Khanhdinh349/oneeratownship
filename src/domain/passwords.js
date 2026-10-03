'use strict';

const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

const KEYLEN = 32;

/**
 * scrypt work factor. The default is the Node default (N = 16384) and is what
 * production uses. KINERA_SCRYPT_COST exists so the test suite — which seeds
 * fourteen accounts per in-memory database, hundreds of times — can lower the
 * cost without changing the algorithm. It is read per call so a test can set it
 * before the first require.
 */
const cost = () => Number(process.env.KINERA_SCRYPT_COST || 16384);

const opts = () => ({ N: cost(), maxmem: 256 * 1024 * 1024 });

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, KEYLEN, opts()).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = scryptSync(password, salt, KEYLEN, opts());
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword };
