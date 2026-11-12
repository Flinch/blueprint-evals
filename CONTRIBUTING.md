# Contributing

This project is in its early design phase. The interfaces are still settling,
so the most useful contributions right now are issues and design feedback on
[docs/design/0001-m0-core-interfaces.md](docs/design/0001-m0-core-interfaces.md).

## Development

```bash
npm install
npm run typecheck
npm test
```

Node 20 or later.

## Ground rules

- Tests run without network access or API keys. Use the `fake` target and the
  `fake` model provider. Anything that makes paid calls must be opt-in.
- Fixtures are synthetic. Never commit real customer transcripts, keys,
  assistant ids or tenant names.
- Secrets in config are `${env:NAME}` references only.
- A change to a core interface needs a design doc update in the same pull
  request.

By contributing you agree your contribution is licensed under Apache-2.0.
