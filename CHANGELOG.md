# Changelog

Every release, in a writer's words. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) as `CONTRIBUTING.md` defines it for Solipsist. A line starting
`UPGRADE:` is something you must do when you update.

## [Unreleased]

### Added

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
