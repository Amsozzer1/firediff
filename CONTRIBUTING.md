# Contributing

Bug reports and pull requests are welcome.

## Reporting a missed or wrong access change

These reports help most. Open a
[missed access change](https://github.com/Amsozzer1/firediff/issues/new?template=missed-change.yml)
issue with:

- the smallest base and head rules that show it (the [playground](https://firediff.amsozzer.com/)
  is a quick way to cut them down);
- the request you expected to flip (who, what operation, which path), or the row that's wrong.

## Development

Needs Node 22+, pnpm and Java 21.

```sh
pnpm install
pnpm test             # unit tests (no emulator)
pnpm test:emulator    # everything, including the traps and golden reports
pnpm build            # tsup + ncc → dist/
```

- `dist/` is committed, because the Action runs from it. Run `pnpm build` and commit `dist/` with your
  change; CI fails if it's stale.
- New behavior needs a test. For a new kind of access change, add a trap under `corpus/trap-*` with
  `base.rules`, `head.rules` and `expected.json`.
- Golden reports (`corpus/trap-*/report.md`) are regenerated with `UPDATE_GOLDEN=1 pnpm test:emulator`.
  Review the diff before committing.
