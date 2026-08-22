# 0014 — Share analytics identify nobody

Status: accepted
Date: 2026-08-22

## Context

Somebody who publishes a link wants to know whether it is being used: has anyone opened it, are
they reading it or saving it, and when was the last time. Until now the only answer was a
counter that went up.

The obvious way to answer it properly is the way every analytics tool does: record the address,
the user agent and the referrer of each visit, set a cookie, and count unique visitors. That
would be a straightforward thing to build and it is the wrong thing to build here.

The person opening a share link is not an Orbit user. They followed something a friend sent
them, they have no account, they agreed to nothing, and they have no way to see or delete what
was recorded about them. Whatever is kept about them is kept without consent by anyone who could
give it.

## Decision

**A view record holds when it happened, whether it was a read or a download, and one of three
words for the kind of device. Nothing else.**

No IP address, no user agent, no referrer, no cookie, no fingerprint. The device word is derived
from the user agent and the user agent is then discarded; it exists to separate "my colleagues
opened it on their phones" from "something is crawling it", and it is useless for anything else.

Records are kept for **90 days** and pruned on the scheduled pass. The useful question is
answered by the last few weeks; anything older is a log of strangers' behaviour that nobody
reads and somebody could lose.

Crawlers are counted and shown separately. A link pasted into WhatsApp or Slack is fetched
immediately by their preview bots, and counting those as readers tells the owner their link is
popular when nobody has looked at it.

## Consequences

**Unique visitors cannot be counted, and the UI says so.** Ten opens might be ten people or one
person refreshing. The page reports "opens", explains that it does not know the difference, and
says why — rather than inventing a number that looks more authoritative than it is.

There is also no geography, no referrer breakdown, and no funnel. Each of those is a real thing
somebody might want, and each requires knowing more about a stranger than the question justifies.
If one of them ever becomes worth building, it is worth building deliberately, against this
decision, rather than by quietly widening what a view record holds.
