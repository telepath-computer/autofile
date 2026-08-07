# Spec policy

How the documents in `spec/` are written, and what makes something a spec.

## Specs are authority

`spec/` is the source of truth. Implementations conform to it; `docs/` explains
and proposes but never binds. A design in `docs/proposals/` carries no
authority until it is written into a spec.

## Slop-free zone

Every statement in a spec is read and owned by a human. AI may draft one, but a
human has read each line and stands behind it as correct and intentional. This
is what stops plausible-looking half-decisions from becoming authority that
later work compounds on.

## Cold reader

A spec describes the system as it is, reading as though the current design is
the only one that has ever existed. No "previously", no rejected alternatives,
no history from the conversation that produced it — that material belongs in
`docs/`.

Non-goals do belong. "Does not validate X" earns its place wherever a reader
would otherwise assume it does.

## Rationale for non-obvious rules

Stating a rule is half the job; the other half is conveying how load-bearing it
is. The more specific the demand, the more it needs a short "because" — without
one, a reader cannot tell a critical invariant from an incidental detail, and a
later editor cannot judge whether changing it is safe. Obvious rules need none.

## Back pressure

Implementation surfaces what a spec got wrong or left vague. That is *back
pressure*, and it is welcome — a best-effort spec is enough to build against,
and what building teaches comes back into the spec.

The discipline is that it lands there. A gap found while implementing is fixed
in the spec, not worked around in code; otherwise the spec keeps authority it
no longer deserves while the code quietly holds the real rules.

## One owner per rule

A rule is stated once, by the spec that owns it, and referred to from anywhere
else rather than restated. `api.md` does not repeat the model it serves.

## Terms

Terms are defined in [terms.md](terms.md). Other specs use them without
redefining them, and italicise them wherever they refer to the term rather than
to the everyday word — so a reader can tell at a glance which words carry a
definition.
