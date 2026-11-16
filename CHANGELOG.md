# Changelog

Every release, in a writer's words. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) as `CONTRIBUTING.md` defines it for Solipsist. A line starting
`UPGRADE:` is something you must do when you update.

## [Unreleased]

### Added

- With no AI model connected, a page now asks for your OpenRouter key when it opens, with steps for getting one. Solipsist checks the key with OpenRouter and keeps it in your system's keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux), or in a file only you can read where there's no keychain. `SOLIPSIST_OPENROUTER_KEY` and Pi's own login still work, and a key in the environment comes first. `solipsist forget-key` removes a saved key, and `pi.key_store` / `pi.key_file` change where it's kept.
- A light / dark toggle at the top right of every page and the pages list. Until you use it, Solipsist follows your system's theme.
- The first time you open a page, a short tour shows what its parts are for: the page agent, then the status bar (editing mode, AI model, cost, Page review, the agent panel). Skip it at any point; it isn't shown again.

### Changed

- "Connect a model" is now "Connect an AI model", in the status bar and the dialog.
- Until a browser opens Solipsist, the terminal shows only the address to open. The full view of the agents appears once one connects, and the address comes back when the last window closes.
- The status bar no longer shows Single agent. The setting (`agent.single_agent`) works as before.
- The install command's closing tip no longer suggests a `cd` before running Solipsist.

## [0.3.1] — 2026-11-15

### Changed

- The install command is now `curl -fsSL https://solipsist.sh/install | sh` (on Windows, `irm https://solipsist.sh/install.ps1 | iex`), which starts in well under a second instead of waiting several seconds on a redirect.

## [0.3.0] — 2026-11-15

### Changed

- The install command asks where to put Solipsist: just for you (`~/.local/bin`, the default), for everyone (`/usr/local/bin`), or this folder only. It shows the download's progress, offers to add the folder to your `PATH`, says whether a model is connected and how to connect one, and ends with links to the docs. Run without a terminal (in CI, say), it asks nothing and installs just for you, as before.
- A first launch in a folder with no markdown files offers to start a new page, instead of a dialog with no way on.

## [0.2.1] — 2026-11-15

### Fixed

- The install command (`curl -fsSL https://get.solipsist.sh | sh`) failed on a Mac with "target: unbound variable" before downloading anything. Release 0.2.0's `install.sh` has this fault.
  UPGRADE: on a Mac, until the next release, install 0.2.0 by hand from the release page, or run Solipsist from a clone.

### Changed

- The documentation and README now start with the install command and `solipsist`, and keep running from a clone for those who want the source.

## [0.2.0] — 2026-11-15

### Added

- A second Solipsist started on a folder that already has one running is refused, with where the first one is and how to stop it, instead of both writing the same pages. A lock left by a crash is taken over.
- `solipsist doctor` prints what a bug report needs: the version, your system, which settings file is in effect, whether the port is free, whether the folder can be written, which agents can run, and the last errors. It shows no key and no page text.

### Security

- The server refuses requests from other websites, and requests addressed to any name but `localhost` on its own
  port, so a page open in another tab can't drive it.
  UPGRADE: if you reach Solipsist by another name (`server.host` opened to the network, or a proxy), list that name
  in the new `server.allowed_hosts`.
- Sync copies a page's images only from its own image folder to beside the page: an image link with `..`, or a
  symlink at either end, is skipped instead of copying a file outside the project.
- A `.env` file in the folder Solipsist runs in can no longer choose a command for it to run.
- An SVG image opened on its own can no longer run scripts as the app.
- The `public/` folder of your project is no longer served.
- The routes kept for testing are off unless Solipsist runs under `bun test` or `bun run dev`.
- The installed `solipsist` reads no `.env` or `bunfig.toml` from the folder it runs in, which may be someone else's:
  either could open it to the network, swap in another key, or run that folder's code.
  UPGRADE: if you kept `SOLIPSIST_OPENROUTER_KEY` in a `.env`, set it in your environment instead (your shell's
  profile), or log in with `pi`. Running from source with `bun` still reads `.env`.
- Updated two libraries the agents use, `undici` and `minimatch`, past their known vulnerabilities.
- Opening Solipsist in a folder that holds its own git settings no longer runs a command they name.

## [0.1.0] — first public build

### Added

- A writing app on the `.md` files of the folder it runs in: pick the files on first launch, write in a page that
  keeps your markdown as you wrote it, and Sync your changes back when you choose.
- Requests: press `Mod-.` to ask an agent for something at the caret, about a selection or about an image. The agent
  suggests; you accept, reject, ask again or chat about it. It never writes your page.
- Accept as a Button: keep a result as a button that runs its request again, by hand or on a schedule.
- A chat with an agent about the whole page.
- Agents on Pi, with your own model provider; per-page model and on/off, daily and monthly cost limits.
- Settings in `solipsist.yaml` or environment variables; every prompt editable from the settings dialog.
