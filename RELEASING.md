# Releasing Solipsist

How a release is cut. One maintainer, one command per step. What a version number promises is in `CONTRIBUTING.md`;
every change goes in `CHANGELOG.md` under `## [Unreleased]`, in a writer's words.

**Status:** steps 1–3 work today. The release workflow (`.github/workflows/release.yml`, step 4) is not written yet:
until it is, step 4 is done by hand as described there.

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

It refuses a dirty tree, a branch other than `main`, a tag that exists, an empty `[Unreleased]` and a red
`bun test`. Then it turns `[Unreleased]` into `[x.y.z] — date`, sets `package.json`, commits "Release x.y.z" and makes
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
Unpack the one for your machine, run `./solipsist --version` (it must print the number you are releasing) and start it in
an empty folder: the page opens, a page saves, stopping it leaves no process behind. The macOS and Windows builds are
not run anywhere automatically: try them on those systems before a release that matters.

## 4. Publish

Push the commit and the tag together: `git push origin main vx.y.z`.

Release workflow (to be written): checks the tag matches `package.json` and `CHANGELOG.md` has the section, runs the
tests, builds the five targets, starts the Linux binary, writes `SHA256SUMS`, attests the build provenance, and creates a
**draft** GitHub Release with the changelog section as its body.

Until it exists: create the draft by hand with `gh release create vx.y.z --draft --notes-file <changelog section>
dist/release/*`, mark a pre-release with `--prerelease`.

Read the draft, then publish it. Once published, a release's files are never changed or replaced.

## 5. After

- On a clean machine, run the install command from the docs and check `solipsist --version`.
- Post the release in Discussions → Announcements.
- A bad release is never deleted or re-tagged: fix it with the next patch release and say in the changelog that the
  old one is withdrawn.
