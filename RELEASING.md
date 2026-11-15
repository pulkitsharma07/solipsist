# Releasing Solipsist

How a release is cut. One maintainer, one command per step. What a version number promises is in `CONTRIBUTING.md`;
every change goes in `CHANGELOG.md` under `## [Unreleased]`, in a writer's words.

**Status:** the release workflow (`.github/workflows/release.yml`) is written. Run it first as a dry run
(Actions → Release → Run workflow, `dry_run` on): it builds and tests and publishes nothing.

**Once, on GitHub** (repository settings; not visible from a checkout):

- Settings → Environments → New environment `release`, with the maintainer as required reviewer and "Prevent
  self-review" off. The publish job runs in it, so no attestation or draft is made before that approval.
- Settings → Rules → Rulesets → a tag ruleset on `v*` that only the maintainer may bypass, restricting creation,
  update and deletion: whoever can push a `v*` tag onto `main` could otherwise start a release.

## 1. Before the tag

- `main` is green (CI) and your tree is clean.
- `CHANGELOG.md`'s `## [Unreleased]` lists what changed. Anything a writer must do after updating is a line starting
  `UPGRADE:`. A changed built-in prompt, a changed config key or a new page-format feature is named.
- `bun test` passes. After a change to the dialect, the session or the agents also run
  `FUZZ_RUNS=16000 bun test test/fuzz.test.ts`.

## 2. Bump

```sh
bun run release <patch|minor|major|x.y.z[-beta.N]> --dry-run   # what it would do
bun run release <patch|minor|major|x.y.z[-beta.N]>
```

It refuses a dirty tree, a branch other than `main`, a `main` behind `origin/main` (it fetches first), a tag that
exists, an empty `[Unreleased]` and a red `bun test`. Then it turns `[Unreleased]` into `[x.y.z] — date`, sets `package.json`, commits "Release x.y.z" and makes
the annotated tag `vx.y.z`. It does not push.

Pre-releases are `x.y.z-beta.N` or `-rc.N`. A pre-release is marked as one on GitHub and is never "latest".

## 3. Build and look at it

```sh
bun run build                    # all five targets into dist/release/
bun run build --target host      # just this machine's
cd dist/release && shasum -a 256 -c SHA256SUMS
```

The archives are `solipsist-<os>-<arch>.tar.gz` (`.zip` on Windows) for `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64` and `windows-x64`, with no version in the name, so `releases/latest/download/<name>` stays one URL.
Beside them are `install.sh` and `install.ps1`, copied from `scripts/`: `get.solipsist.sh` redirects to
`releases/latest/download/install.sh` (and `/install.ps1` to that one), so what the install command runs changes only
with a release. `SHA256SUMS` covers all seven. The build is reproducible: the same commit gives the same `SHA256SUMS` (on
the same kind of machine; the times in it are the commit's), so a local build can be compared with the release's.
Unpack the one for your machine, run `./solipsist --version` (it must print the number you are releasing) and start it in
an empty folder: the page opens, a page saves, stopping it leaves no process behind. `bash scripts/smoke.sh <archive>
<version>` does the automatic part of that (the workflow runs it). The workflow starts only the Linux x64 build unless
the repository variable `SMOKE_ALL_SYSTEMS` is `true`, which runs all five on their own systems (macOS and arm runners
cost many times Linux's while the repo is private; set it once it is public). Until then, try the macOS and Windows
builds on those systems before a release that matters.

## 4. Publish

Push the commit and the tag together, atomically: `git push --atomic origin main vx.y.z`. Without `--atomic` a refused
`main` lets the tag through alone; the workflow then fails "not on main", and a pushed tag is never moved.

The Release workflow runs on the tag: it checks the tag matches `package.json` and `CHANGELOG.md` has the section,
runs the whole CI suite, builds the five targets, starts each on its own system (`scripts/smoke.sh`; see above for which), attests the build
provenance of every file, and creates a **draft** GitHub Release with the notes from `scripts/release-notes.ts`
(marked pre-release for a `-beta.N` or `-rc.N`). It never runs on a push to `main`. The last job, the attestation and
the draft, waits for your approval in the `release` environment: Actions → the run → Review deployments.

If the workflow can't be used, make the draft by hand:

```sh
bun scripts/release-notes.ts x.y.z --prev vPREVIOUS --sums dist/release/SHA256SUMS > dist/release/notes.md
gh release create vx.y.z --draft --notes-file dist/release/notes.md dist/release/solipsist-* dist/release/install.sh dist/release/install.ps1 dist/release/SHA256SUMS
```

Add `--prerelease` for a beta or rc.

Read the draft, then publish it. Once published, a release's files are never changed or replaced.

## 5. After

- On a clean machine, run the install command from the docs and check `solipsist --version`.
- Post the release in Discussions → Announcements.
- A bad release is never deleted or re-tagged: fix it with the next patch release and say in the changelog that the
  old one is withdrawn.
