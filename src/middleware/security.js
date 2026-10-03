'use strict';

/**
 * Production hardening for a publicly reachable deployment.
 * Everything here is dependency-free so it cannot drift with an upstream package.
 */

/**
 * Security headers. The CSP is deliberately tight: all application JavaScript is
 * served from this origin as external files (there is no inline script and no
 * inline event handler anywhere in the app), so `script-src 'self'` holds without
 * any unsafe directive. Styles need 'unsafe-inline' only because the markup uses
 * a handful of inline `style` attributes.
 */
function securityHeaders({ enableHsts = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  return function applySecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), camera=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.removeHeader('X-Powered-By');
    if (enableHsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/**
 * Fixed-window rate limiter.
 *
 * NOTE: the counters live in this process's memory. That is correct for a single
 * instance, which is what this app is sized for. Behind more than one instance,
 * move these counters to a shared store (Redis) or enforce the limit at the
 * reverse proxy — otherwise each instance enforces its own share of the limit.
 */
function rateLimit({
  windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please try again shortly.',
  code = 'RATE_LIMITED', clock = () => Date.now(),
}) {
  const hits = new Map();

  function sweep(now) {
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k);
    }
  }

  const middleware = function limiter(req, res, next) {
    const now = clock();
    if (hits.size > 5000) sweep(now);

    const k = key(req);
    if (k === null || k === undefined) return next();

    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: { code, message } });
    }
    return next();
  };

  /** Lets a successful sign-in clear that identity's failed-attempt budget. */
  middleware.reset = (k) => hits.delete(k);
  middleware._hits = hits;
  return middleware;
}

module.exports = { securityHeaders, rateLimit };
