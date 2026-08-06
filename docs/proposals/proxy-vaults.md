# Proxy vaults

Deferred design. Nothing in `spec/` refers to proxying.

## The idea

A program that answers [the HTTP API](../../spec/http-api.md) and forwards to
another vault is itself a vault, as far as any client can tell. Nothing about
the contract says a vault has to store anything.

That makes cross-cutting concerns compose in front rather than inside. Auth is
written once, in a proxy, and every implementation inherits it without knowing
it exists — no backend author has to get authentication right, and it works for
a backend written in another language.

## What it subsumes

**Mounts.** A proxy whose collections come from several upstream vaults presents
one namespace over all of them. That is [the mounts proposal](mounts.md) without
a mechanism inside any implementation.

**Sharing.** A proxy exposing a subset — some collections, or some collections
read-only — to a party who authenticates to it and never reaches the vault
behind it.

**Anything else that is not storage.** Caching, read-only mirrors, audit logs.

## What it would need settled

**Name collisions.** Two upstream vaults can both declare `contacts`, so a proxy
merging them renames or prefixes, and that changes identities. This is the
naming question `mounts.md` raises, arriving where it can actually be answered.

**Reachability.** Auth in front only holds if the vault behind is not reachable
directly. The upstream binds to loopback and the proxy binds outward, or the
auth is decoration.

**Who is asking.** Filtering per party means the API can carry an identity for
the caller. Nothing in it does today, and that is auth design rather than
proxying.

## Why it is worth writing down now

It is the strongest argument for a conformance suite. A proxy is a vault, so it
should pass exactly the tests the vault behind it passes — and anything it
cannot pass is somewhere the abstraction leaked rather than somewhere the proxy
fell short.
