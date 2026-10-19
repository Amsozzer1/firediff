### firediff · 1 access change

**Changed in this PR, but never tested**

- L9 not tried: list rule reads `{teamId}`, the document id; a collection query can't satisfy that, so only the deny side of list is tested here

| Who | Can now | On |
|---|---|---|
| users whose doc at teams/{teamId}/members/{uid} has role == 'member' | read any doc | `teams/{teamId}` |

**Not exercised**

- L13 not tried: list rule reads `{memberId}`, the document id; a collection query can't satisfy that, so only the deny side of list is tested here

<details><summary>Proof (1)</summary>

**1. users whose doc at teams/{teamId}/members/{uid} has role == 'member' can now read any doc · `teams/{teamId}`**

Base: denied by L9 `request.auth != null && role() in ['admin']` (evaluation error at L9:22; false)

```json
{
  "principal": "members.role=member",
  "auth": {
    "uid": "u_members_role_member"
  },
  "op": "get",
  "path": "teams/t1",
  "seed": [
    {
      "path": "teams/t1",
      "data": {}
    }
  ]
}
```

</details>
