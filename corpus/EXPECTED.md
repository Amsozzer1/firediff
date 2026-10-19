# How expected.json was written

Each trap's expected.json was written by hand from the rules diff before the generator was run on it.
Rows are the requests whose allow/deny should flip. Request naming follows the generator:
wildcards tied to request.auth.uid → u_owner, other wildcards → first letter + 1; `fields` on a
create row is the field overridden from the allowed payload, on an update row the field changed.

- trap-01: read isOwner → isSignedIn (get + unfiltered list open to every signed-in user), and the
  role-change guard on update removed (owner can set role).
- trap-02: write admin claim → any signed-in user. Every signed-in principal without the claim gains
  create/update/delete on config/k1. Reads unchanged. The config rules read no fields, so update is
  the firediff_probe fallback.
- trap-03: lookup role in ['admin'] → ['admin','member']. Only a principal whose members doc has
  role 'member' gains get on teams/t1. list on teams stays denied in both: the rule depends on the
  {teamId} of each document, which a collection query can't satisfy.
- trap-04: create's role == 'member' check removed. The owner creating their own doc with role
  'admin' (the other literal in the file) gains create. update still pins role to the old value.

## Changes

- 2026-10-18, trap-01: added the two `get users/u_stranger` rows (owner, other user). They were
  added after missing-doc probes were introduced: head's `isSignedIn()` allows reading
  nonexistent docs, so any signed-in user can read another user's doc that doesn't exist yet.
