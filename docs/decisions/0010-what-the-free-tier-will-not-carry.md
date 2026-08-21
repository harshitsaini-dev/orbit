# 0010 — What the free tier will not carry

**Status:** accepted
**Date:** 2026-08-22

## Context

A long list of capabilities was proposed for Orbit: cross-cloud transfers,
peer-to-peer sending, in-browser OCR, HLS video streaming, share analytics on a
world map. Most of them fit. Three of them run into the constraint the whole
project is built around — no paid service, no card, no bill (§0, §1) — and one
of those turns out not to be needed at all.

The temptation with a list like this is to accept everything and discover the
problems during implementation, by which point the feature is half built and
the honest answer is expensive to give.

## Decision

Each proposed capability is recorded with its cost and its limits *before* it
is scheduled, in `18-planned-capabilities.md`. Three specific rulings:

**HLS transcoding is declined.** The stated goal — play a large video without
downloading it — is already met by Range streaming, which the content route
honours and the player relies on. What HLS adds is adaptive bitrate, and that
needs the source transcoded into several renditions. Transcoding is sustained
CPU and the renditions are stored bytes, so it collides with both §0 and §1. An
HLS source is passed through untouched; transcoding is a paid-compute item to
be raised, never assumed.

**Peer-to-peer sending ships with a fallback, not with TURN.** WebRTC needs
STUN, which is free, and TURN to relay between peers behind symmetric NAT,
which is not. Roughly one connection in ten will fail without it. The feature
is therefore specified as: attempt the direct transfer, detect the failure, and
offer the ordinary upload-and-share path — rather than buying relay capacity or
leaving the user watching a transfer that will never start.

**Duplicate detection is tiered, and says which tier it is in.** Drive returns
a real MD5; an S3 ETag is an MD5 only for single-part uploads. Where hashes are
comparable, matches are exact. Where they are not, results are labelled
possible, on size and name, with an opt-in hash-on-download for a shortlist.

## Consequences

- The roadmap can be read for cost as well as for order, and a capability that
  needs a signup is visible before work starts on it.
- Two features are smaller than proposed: P2P carries a fallback path, and
  video keeps the streaming it already has.
- Anything discovered later to need payment stops and gets raised, per the
  cost-discipline rule. The rule was already there; this makes the list of
  known collisions explicit so it is not rediscovered feature by feature.

## Alternatives considered

**Accept the list and find out during implementation.** This is how a personal
project acquires a bill. It also wastes the most work, since the discovery
comes after the design is committed.

**Decline anything with a cost risk.** Too blunt. OCR looked expensive and is
free once it runs in the browser; transfers looked impossible and are fine if
chunked and resumable. The constraint changes the design far more often than it
kills the feature.
