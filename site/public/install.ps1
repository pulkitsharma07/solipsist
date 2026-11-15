# Install Solipsist on Windows:  irm https://solipsist.sh/install.ps1 | iex
#
# A stand-in served with the website: it fetches the latest release's own install.ps1 and runs it, so what installs
# changes only with a release, whenever the website was last published. $env:SOLIPSIST_VERSION, SOLIPSIST_INSTALL_DIR
# and SOLIPSIST_BASE_URL pass through to it. Errors are thrown, not `exit`ed, and everything is inside `& { }`: it runs
# inside the user's own shell through `iex`.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  # Windows PowerShell 5.1 may offer only TLS 1.0 and 1.1, which GitHub refuses.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $url = "https://github.com/pulkitsharma07/solipsist/releases/latest/download/install.ps1"
  # The same `irm | iex` the install command is, one hop on: GitHub serves the file as a download, which irm reads as text.
  Invoke-RestMethod $url | Invoke-Expression
}
