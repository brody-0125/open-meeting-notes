# Releasing

Release process for maintainers. Assumes `main` is green on [CI](.github/workflows/ci.yml).

## Version source of truth

- Application version: [`package.json`](package.json) `version`
- User-facing history: [`CHANGELOG.md`](CHANGELOG.md)
- License: [`LICENSE.md`](LICENSE.md) (MIT, Seokhyeon Kim)

Update example metadata when bumping (e.g. [`docs/examples/apple-stt-capability.json`](docs/examples/apple-stt-capability.json) `appVersion`).

## 1.0.0 checklist

- [ ] `CHANGELOG.md` — move items from `[Unreleased]` if any; set release date on `[1.0.0]`
- [ ] `package.json` / `package-lock.json` — `1.0.0`
- [ ] `npm ci` && `npm run build:inference` && `npm test`
- [ ] macOS: `npm run ci:macos-apple-stt` (on a Mac runner or machine)
- [ ] Build and smoke-test packages on target OS (models supplied locally; not in Git)
- [ ] Git tag `v1.0.0` on the release commit
- [ ] GitHub Release with notes from `CHANGELOG.md` `[1.0.0]`
- [ ] Attach signed or unsigned build artifacts per your deployment policy (artifacts are not stored in this repository)

## Tag and GitHub release (example)

```sh
git checkout main
git pull origin main
# after version/changelog commit:
git tag -a v1.0.0 -m "open-meeting-notes 1.0.0"
git push origin main
git push origin v1.0.0
gh release create v1.0.0 --title "1.0.0" --notes-file CHANGELOG_SNIPPET.md
```

Pass the `[1.0.0]` section from the changelog as `--notes` or `--notes-file`.

## Post-release

- Open `[Unreleased]` in `CHANGELOG.md` for the next cycle.
- Bump `package.json` on `main` when the next development line starts.
