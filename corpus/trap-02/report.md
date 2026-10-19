### firediff · 1 access change

| Who | Can now | On |
|---|---|---|
| any signed-in user | write any doc | `config/{key}` |

**Not exercised**

- All 2 allow conditions in head were reached by at least one request.

<details><summary>Proof (1)</summary>

**1. any signed-in user can now write any doc · `config/{key}`**

Base: denied by L6 `request.auth.token.admin == true` (Property admin is undefined on object)

```json
{
  "principal": "stranger",
  "auth": {
    "uid": "u_stranger"
  },
  "op": "delete",
  "path": "config/k1",
  "seed": [
    {
      "path": "config/k1",
      "data": {}
    }
  ]
}
```

</details>
