# Security policy

## Reporting a vulnerability in firediff

Please report vulnerabilities privately: on this repository's **Security** tab, choose
**Report a vulnerability**. Don't open a public issue.

In scope:
- the CLI and the GitHub Action (`dist/`, `action.yml`), for example a way for a pull request to run
  code in the Action or read its token;
- the hosted playground (`firediff playground --hosted`, firediff.amsozzer.com), for example a way
  around its size, time or rate limits, or to reach the emulator.

## What firediff is not

firediff reports how a rules change alters access for the requests it generates. It doesn't certify
rules as secure. A finding that firediff missed an access change is a bug, not a vulnerability:
please open a [missed access change](https://github.com/Amsozzer1/firediff/issues/new?template=missed-change.yml)
issue, with your rules reduced to a small example.

If firediff found a real access problem in someone else's project, report it to that project, not here.
