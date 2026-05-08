# Releases

Releases are published by pushing a version tag that matches `package.json`.

## One-time setup

Configure the repository secret used by the release workflow:

- `NPM_TOKEN`: an npm automation/publish token for `pi-diff-review`

## Publish a release

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
