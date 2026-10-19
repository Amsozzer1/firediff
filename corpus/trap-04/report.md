### firediff · 1 access change

| Who | Can now | On |
|---|---|---|
| the owner | create their own doc (role) | `users/{uid}` |

**Not exercised**

- All 4 allow conditions in head were reached by at least one request.
- L5 not tried: list rule reads `{uid}`, the document id; a collection query can't satisfy that, so only the deny side of list is tested here

<details><summary>Proof (1)</summary>

**1. the owner can now create their own doc (role) · `users/{uid}`**

Base: denied by L6 `request.auth != null && request.auth.uid == uid && request.resource.data.role == 'member'` (false)

```json
{
  "principal": "owner",
  "auth": {
    "uid": "u_owner"
  },
  "op": "create",
  "path": "users/u_owner",
  "data": {
    "role": "admin"
  },
  "seed": []
}
```

</details>
