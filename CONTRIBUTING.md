# Contributing

Thanks for contributing to `3d-tiles-rendererjs-3dgs-plugin`.

## Development setup

```bash
npm install
```

## Validation

Run the following before opening a pull request:

```bash
npm test
npm run build
npm run build-examples
npm run pack:check
```

## Pull requests

- Keep changes focused and scoped to one problem.
- Update `README.md` if the public API or behavior changes.
- Include a repro or screenshots for rendering behavior changes when possible.
- Do not commit `dist/` or `examples/bundle/`.

## Release notes

GitHub releases are categorized from pull request labels using `.github/release.yml`.
Use labels such as `feature`, `enhancement`, `bug`, `fix`, `docs`, `ci`, `chore`,
or `refactor` when appropriate.
