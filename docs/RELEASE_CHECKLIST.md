# Release checklist

Run through this on every minor and major. Patch releases skip steps marked **(major+)**.

## Pre-tag

- [ ] All blocking issues for the milestone are closed
- [ ] `CHANGELOG.md` has an entry under `## Unreleased` listing every user-visible change
- [ ] `package.json` version bumped (`pnpm version <patch|minor|major>` — do NOT push tag yet)
- [ ] On a clean clone: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` are all green
- [ ] CI matrix green on a release branch (Ubuntu / macOS / Windows × Node 20 / 22)
- [ ] **(major+)** Migration notes drafted in `docs/migrations/<version>.md`
- [ ] **(major+)** Deprecation warnings shipped at least one minor ahead

## Tag

- [ ] `git tag -s vX.Y.Z -m "vX.Y.Z"` (signed if GPG configured, otherwise `-a`)
- [ ] `git push origin vX.Y.Z` — triggers the `release.yml` workflow
- [ ] Watch the workflow: it builds, tests, publishes to npm with provenance, and creates the GitHub release with auto-generated notes

## Post-tag

- [ ] Verify the new version on `https://www.npmjs.com/package/mcp-devtools`
- [ ] Verify the provenance badge appears on npm (CI-only feature)
- [ ] Announce on X with the demo GIF; tag relevant accounts
- [ ] Update the "Latest" pin / sticky issue if applicable
- [ ] Move the `## Unreleased` heading down; start a fresh empty one for the next version
- [ ] Close the milestone; create the next one

## Rollback (if needed)

1. `npm unpublish mcp-devtools@X.Y.Z` (within 72h of publish — npm policy)
2. `gh release delete vX.Y.Z -R adityachilka1/mcp-devtools --yes`
3. `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`
4. Post-mortem in the next changelog under a `### Reverted` heading
