# 0013 — The server refuses to start on an unsafe production configuration

Status: accepted
Date: 2026-08-22

## Context

Orbit's configuration has several settings that are correct locally and dangerous in
production, and none of them fails on its own. The clearest is `AUTH_MODE=local`: it runs every
request as one implicit user with no sign-in at all, which is exactly what makes local
development pleasant and exactly what makes a public deployment an open drive. `DATABASE_URL`
unset writes a SQLite file inside the container, which works right up until the next deploy
takes every account with it. `APP_URL` on plain HTTP means the browser drops the session cookie,
so nobody can stay signed in and nothing says why.

Each of these starts, serves, and looks healthy. The failure mode is not a crash; it is a
deployment that quietly does the wrong thing, discovered from a user or not at all.

## Decision

**In production, the server checks its own configuration at boot and refuses to start if any of
it is unsafe.** The checks are: hosted auth mode, no dev OTP endpoint, a database URL that is
not a local file, a 32-byte encryption key, a session secret of at least 32 characters, and
HTTPS on both URLs.

They are collected and reported together rather than thrown one at a time — somebody fixing a
deployment wants the whole list, not one round trip per line — and the rule set is a pure
function over a config object, so each case is a test rather than an environment variable
juggled in a test runner.

Outside production nothing is checked. Every one of these settings is the right setting on a
laptop.

## Consequences

A misconfigured deploy fails visibly, in the platform's log, before serving a request. That is
the point: on the free tier a failed deploy leaves the previous instance running, so the
outcome of a bad configuration is "the old version is still up" rather than "the new version is
up and open".

It also means a production start now depends on configuration that a first deploy will not have
right first time. `render.yaml` carries every non-secret value so the ones left to fill in are
only the secrets, and the refusal names exactly which of those is wrong.
