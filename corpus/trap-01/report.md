### firediff · 4 access changes

| Who | Can now | On |
|---|---|---|
| any signed-in user | list all docs | `users` |
| any signed-in user | read another user's doc | `users/{uid}` |
| the owner | update their own doc (role) | `users/{uid}` |
| any signed-in user | read docs that don't exist yet | `users/{uid}` |

<details><summary>Proof (4)</summary>

**1. any signed-in user can now list all docs · `users`**

Base: denied by L13 `isOwner(uid)` (Null value error)

```json
{
  "principal": "stranger",
  "auth": {
    "uid": "u_stranger"
  },
  "op": "list",
  "path": "users",
  "seed": [
    {
      "path": "users/u_other",
      "data": {
        "role": "member"
      }
    },
    {
      "path": "users/u_owner",
      "data": {
        "role": "member"
      }
    }
  ]
}
```

**2. any signed-in user can now read another user's doc · `users/{uid}`**

Base: denied by L13 `isOwner(uid)` (false)

```json
{
  "principal": "stranger",
  "auth": {
    "uid": "u_stranger"
  },
  "op": "get",
  "path": "users/u_owner",
  "seed": [
    {
      "path": "users/u_owner",
      "data": {
        "role": "member"
      }
    }
  ]
}
```

**3. the owner can now update their own doc (role) · `users/{uid}`**

Base: denied by L15 `isOwner(uid) && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role'])` (evaluation error at L15:24; false)

```json
{
  "principal": "owner",
  "auth": {
    "uid": "u_owner"
  },
  "op": "update",
  "path": "users/u_owner",
  "data": {
    "role": "admin"
  },
  "seed": [
    {
      "path": "users/u_owner",
      "data": {
        "role": "member"
      }
    }
  ]
}
```

**4. any signed-in user can now read docs that don't exist yet · `users/{uid}`**

Base: denied by L13 `isOwner(uid)` (false)

```json
{
  "principal": "other user",
  "auth": {
    "uid": "u_other"
  },
  "op": "get",
  "path": "users/u_stranger",
  "seed": [
    {
      "path": "users/u_other",
      "data": {
        "role": "member"
      }
    }
  ]
}
```

</details>
