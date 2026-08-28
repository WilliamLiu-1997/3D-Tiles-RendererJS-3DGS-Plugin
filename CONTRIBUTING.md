# Contributing

Thanks for contributing to `3d-tiles-rendererjs-3dgs-plugin`.

## Development setup

Development requires Node.js 20.9 or newer. Dependencies are installed from
npm, and no sibling Gaussian Splat Lite checkout is required.

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

`pack:check` inspects the npm tarball and runs `publint`. CI runs the complete
release check on Node.js 20, 22, and 24 on Linux, plus Node.js 22 on Windows.

## Pull requests

- Keep changes focused and scoped to one problem.
- Update `README.md` if the public API or behavior changes.
- Include a repro or screenshots for rendering behavior changes when possible.
- Do not commit `dist/` or `examples/bundle/`.

## Release notes

GitHub releases are categorized from pull request labels using `.github/release.yml`.
Use labels such as `feature`, `enhancement`, `bug`, `fix`, `docs`, `ci`, `chore`,
or `refactor` when appropriate.
