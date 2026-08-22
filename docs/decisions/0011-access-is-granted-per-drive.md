# 0011 — Access is granted per drive, not per Orbit account

Status: accepted
Date: 2026-08-22

## Context

Orbit needs to let several people work out of one set of connected drives — a team where one
person holds the R2 bucket and the Supabase project, and the others need to use them at
different depths. Some may only read; some upload but must never delete; one or two need to
bring other people in.

The obvious model is a workspace: an Orbit account has members, members have a role, and a role
applies to everything in the account. It is the model the `workspaces` and `workspace_members`
tables were originally sketched for.

## Decision

**The unit of access is one connected drive.** A grant is a row joining a person to a drive with
a level, and a person with no grants sees nothing.

Levels are ordered rather than a set of independent flags:

| Level | Adds |
| --- | --- |
| `read` | list, open, download, search |
| `write` | upload, rename, move, create folders |
| `full` | delete, and publish share links |
| `admin` | grant this same drive to other people |

Members sign in as themselves. Adding an address creates the user row; that person then requests
their own code, at their own address, and gets their own session.

## Why per drive

A workspace role cannot express the ordinary case. Somebody brought in to work on the team bucket
would also see the personal Google Drive connected beside it, because both belong to the same
Orbit account. The only way out under that model is a second Orbit account per audience, which
means reconnecting drives and splitting the very aggregation the product exists to provide.

Per-drive grants make the common request — "this bucket, read only, for her" — a single row.

## Why ordered levels rather than checkboxes

`write` without `delete` is a real and frequent position. `delete` without `write` is not, and
offering it as a checkbox only invites the mistake. Three booleans describe eight states of which
four are nonsense; four ordered levels describe the four that mean something.

Deleting and publishing a link sit at the same height deliberately. Both put a file somewhere it
cannot be pulled back from — one destroys it, the other hands it to anyone with the URL — and
somebody trusted to add files is not automatically trusted to do either.

## Why no invitation link

An emailed accept-link proves only that somebody has the link: forwarded, leaked from a mailbox,
or pasted into a chat, it works for whoever holds it. The address is already the claim, and a
code sent to that address is what tests it. So there is no accept step — being named on a drive
does nothing until somebody signs in at that address and proves it is theirs.

## Consequences

- `useAccount(userId, accountId, need)` takes the permission as a **required** argument. It could
  have defaulted to `read`, but then a mutating caller that forgot to pass anything would silently
  let a reader delete files — a mistake with no symptom until it matters. Making it required turned
  the change into twenty-six compiler errors, each one a place that had to state its intent.
- Refusal and non-existence are answered identically, with 404. A guest with read access asking for
  the member list is told the drive does not exist rather than that they may not manage it; the
  second answer confirms there is a member list to see.
- The owner holds no grant row. They are not a guest on their own connection, and a bug that
  deleted grants must not be able to lock them out of it.
- Disconnecting a drive stays owner-only however high a guest's level. An admin guest may delete
  files in it and hand it to other people, but somebody else's tokens and somebody else's provider
  account are not theirs to sever.
- Search and the smart views run over every readable drive, not only the ones the caller connected.
  Allocation deliberately does not: automatic upload placement chooses among **your own** drives, so
  Orbit never quietly puts your files in somebody else's storage.
- `workspaces` and `workspace_members` remain unused. They are not dropped — a workspace is still
  the right shape for things that are genuinely account-wide, and nothing is gained by removing two
  empty tables.
