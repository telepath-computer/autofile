# Mounts

Deferred design. Nothing in `spec/` refers to mounts.

## The problem

Three cases the vault rules can't express:

- **Assets that can't be copied.** A photo library another app owns and
  reorganises, or a folder too large to duplicate. Copying into the vault is
  the right answer for anything small — self-contained, syncs, containment
  stays one comparison — and the wrong answer here.
- **A vault shared with someone else.** Two vaults, separately governed, where
  records in one want to reference records in the other.
- **Vaults that are not local.** Reached over the network rather than synced
  onto disk, and eventually a vault that is partly remote with a local cache.

An absolute path in a record covers the first case and nothing else. It is also
decoupled dangerously: the vault points at something it does not control, which
can move or vanish with nothing to detect it.

## Named mounts

A mount is a name bound to a location. References use the name, so identity is
separated from location:

```yaml
photos: ["[[family:2020/summer/beach.jpg]]"]
```

The path after the colon is relative to whatever `family` turns out to be. The
record says nothing about where that is, so it means the same thing on every
machine and survives sync.

## Declaring and binding

The vault **declares** the mounts it expects, in `autofile.yml`:

```yaml
mounts:
  family:
    title: Family photos
    description: |
      Shared family photo library, owned by the Photos app. Referenced,
      never copied.
```

No location, and no kind. The machine **binds** each name to a location,
wherever machine-local config lives, or at invocation:

```sh
autofile serve --vault personal --mount family=~/Dropbox/Family/Photos
```

Splitting the two is what keeps a vault portable while remaining
self-describing: a synced `autofile.yml` carries what `family` is *for*, not
where it lives, and a fresh clone reports the mount as unbound rather than
producing wrong content. It is the shape of a package declaring a peer
dependency — the artifact states its requirements, the environment satisfies
them, and the gap is detectable.

`paths` is untouched. Mounts are a separate namespace rather than something
backing a vault path, so a vault stays one folder, containment stays one
comparison per root, and what is external is visibly external.

## Kind is discovered

Bind a name to a folder with an `autofile.yml` and its records are
referenceable; bind it to a plain folder and only its files are. That follows
from a vault being a folder with an `autofile.yml` at its root, so no second
concept is needed and no field declares it.

Rules stop at the boundary. Each vault validates against its own config, and a
mounting vault is never the arbiter of whether a mounted one is valid.

## The mount table as registry

If the machine holds a table of mounts, it is the registry of everything
Autofile knows about — and several separate questions collapse into it:

- Serving several vaults is serving several mounts. `--vault name=path` on the
  old server was already a mount table under a different name.
- An agent names a vault instead of computing a path:
  `autofile get personal:contacts/priya-narayan` works from anywhere, with no
  walking up.
- A partially-remote vault is a remote mount with a local cache, rather than a
  new mechanism.

Open: whether mount names are global to the machine or scoped per vault. Global
makes the table a real registry and means a name denotes one thing everywhere,
at the cost of a vault depending on a name it does not control. Per-vault
isolates that and binds the same folder repeatedly.

## Limits

**One hop.** `family:work:x` should not resolve. Identities stay readable, and
a reference's meaning never depends on a chain of other people's configs.

**Cycles.** Two vaults mounting each other is inevitable once this is
symmetric, so resolution must not recurse forever.

## What remote mounts force

- **Authentication.** The server's access boundary is binding to localhost. A
  mount reaching another person's machine is the case that assumption
  excluded, and a private network gets you reachability, not identity.
- **Three resolution states.** Unbound, bound-but-missing, and
  bound-but-unreachable need distinguishing: "the network is down" and "that
  record was deleted" deserve different responses.
- **`validate`'s reach.** Checking remote references means network calls in a
  command that is otherwise pure filesystem, and therefore slow and
  non-deterministic. Likely answer: it checks bindings and local references and
  leaves remote resolution to whatever fetches.
- **The CLI becomes a client.** `autofile get family:contacts/priya-narayan`
  over HTTP is the agent CLI, arriving through mounts rather than as its own
  decision.

## If vaults sync themselves

A remote mount with a local cache is a partially-remote vault, so the mechanism
generalises. Two consequences worth knowing before that is attractive:

Autofile would own conflict resolution, which is currently Dropbox's job. The
format was shaped around surviving it — one file per record, text, mergeable by
an agent when a conflicted copy appears.

It would also reopen the storage question. Markdown files over SQLite was
justified by sync being file-granular and oblivious; if Autofile syncs, that
constraint is its own to set.

## What would change in the spec

Additive, and nothing currently written precludes it:

- A `mounts` key in `autofile.yml`.
- A third reference form in `## Referencing`, beside the record and file
  identities.
- A second way of naming a vault in `cli.md`, since walking up from the working
  directory would no longer be the only route in.
- A validation rule for a declared mount that nothing has bound.

## Alternative considered

**Mounts backing vault paths** — `/photos` served from an external location and
referenced as `[[photos/beach.jpg]]`. Identities stay uniform and nothing in a
record reveals what is local. Rejected because a vault would span several
roots: "copy the folder" stops capturing it, containment stops being one
comparison, and anything reasoning from disk layout has to go through the
config instead.
