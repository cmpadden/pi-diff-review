# Contributing

## Development

Install [pre-commit](https://pre-commit.com/) and enable the repository hooks to run typechecking, tests, and formatting checks before each commit:

```bash
pre-commit install
```

Run the same checks manually with either:

```bash
pre-commit run --all-files
npm run precommit
```

## Releases

Releases are published by pushing a version tag that matches `package.json`.

### One-time setup

Configure npm Trusted Publishing for this package instead of using a long-lived token:

1. Open the package on npm.
2. Go to package settings / publishing access.
3. Add a trusted publisher for GitHub Actions.
4. Use this repository and workflow:
   - Repository: `cmpadden/pi-diff-review`
   - Workflow: `release.yml`

No `NPM_TOKEN` repository secret is required.

### Publish a release

From a clean working tree on the release branch:

```bash
npm version patch # or minor/major
git push --follow-tags
```

The GitHub Actions release workflow will:

1. Validate that the pushed `v*.*.*` tag matches `package.json`.
2. Install dependencies.
3. Check formatting with Prettier.
4. Pack the npm package.
5. Publish the package to npm with provenance.
6. Create a GitHub Release for the tag with the packed tarball attached.
