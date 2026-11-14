# Security

Please don't report a security problem in a public issue or discussion.

Report it privately: open the repository's **Security** tab and choose **Report a vulnerability**. Only the
maintainer sees it. Say what you found, how to reproduce it, and what it lets someone do.

You'll get a first reply within 48 hours. Fixes go out in the next release, and the advisory is published
once a fixed version is available, crediting you unless you'd rather not be named.

Supported: the latest release only.

Worth knowing when you look: Solipsist serves on localhost, reads and writes the `.md` files of the folder it
runs in, and runs a model's agent with tools. The Pi engine's `write` and `edit` are limited to the page's image folder;
its `bash` is not sandboxed. A way past the write limit is in scope.
