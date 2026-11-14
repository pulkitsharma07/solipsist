# Contributing

Solipsist's source is open to read, run and change for yourself, but it is not open to contributions: pull requests
are not merged. This keeps the code in one pair of hands and lets the project be maintained for the long run (the
same choice as SQLite and Litestream).

What helps most:

- **Bug reports.** Open an issue with what you did, what you expected and what happened. A page that fails to open or
  save is most useful attached as the `.md` file, with anything private removed.
- **Ideas and requests.** Open an issue; they are read, even when the answer is no.
- **Questions.** Ask in [Discussions](https://github.com/pulkitsharma07/solipsist/discussions). Issues and
  discussions get a first reply within 48 hours.
- **A licence.** If you use Solipsist and it's useful to you, buying one is what keeps it going.

If you've found a security problem, please don't open a public issue: report it privately as `SECURITY.md` says.

## What a version number promises

Releases are tagged `vX.Y.Z`; every change is in `CHANGELOG.md`.

| Bump | When |
|---|---|
| **major** | the page format changes incompatibly, or a setting, route or plugin-API name is removed after its alias period |
| **minor** | new features, settings, task types or prompt slots; a built-in prompt's text changes meaningfully |
| **patch** | fixes only: no new settings, no prompt changes |

Before 1.0, a minor may also break settings and the plugin API, and the changelog says how. It never breaks the page
format: a page saved by any public build opens in every later one, from the first public build on.

A renamed setting, route or prompt keeps its old name working for at least one minor, with a warning when it is used.

Everyone in issues and discussions is held to the [Code of Conduct](CODE_OF_CONDUCT.md).

The source is under the FSL-1.1-MIT licence (`LICENSE`): use, change and self-host it for anything but a competing
product; each release becomes MIT two years after it ships.
