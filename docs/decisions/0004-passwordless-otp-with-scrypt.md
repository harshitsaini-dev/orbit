# 0004 — Passwordless email OTP, hashed with scrypt

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Orbit holds OAuth tokens for other people's cloud accounts, so an account takeover is
unusually damaging. Passwords add a credential to steal, reuse, and leak. The plan already
called for email OTP; the open question was how to store the code and which hash to use.

argon2 is the usual recommendation, but every Node binding for it needs a native build step,
which complicates a free-tier deploy for no benefit here: a 6-digit code lives for five
minutes, allows five attempts, and is rate-limited per IP.

## Decision

Passwordless sign-in by 6-digit email code. Codes are stored as salted **scrypt** hashes
(`node:crypto`, no native dependency), expire in 5 minutes, allow 5 attempts, and are consumed
on first successful use. Session tokens are 32 random bytes stored as a SHA-256 fingerprint —
high-entropy already, and a plain digest can be indexed and matched in one query.

Signing in is also registration; there is no separate signup step. The first account ever
created becomes `superadmin`, so a fresh deployment always has an administrator.

## Consequences

- No password storage, reset flow, or breach-reuse exposure.
- No native build step on Render.
- Both `/auth/request-otp` and `/auth/verify-otp` answer identically regardless of whether the
  address exists, so neither can be used to enumerate accounts. Tests assert this directly.
- Email delivery becomes a hard dependency of hosted mode. Local mode bypasses OTP entirely.
