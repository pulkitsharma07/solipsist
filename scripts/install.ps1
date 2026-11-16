# Install Solipsist on Windows:  irm https://solipsist.sh/install.ps1 | iex
#
# Downloads the release file, checks it against the release's SHA256SUMS, and puts solipsist.exe in
# %LOCALAPPDATA%\solipsist (added to your user PATH). No admin rights. Run it again to update.
#
#   $env:SOLIPSIST_VERSION = "0.2.0-beta.1"   install that release (default: the latest stable one)
#   $env:SOLIPSIST_INSTALL_DIR = "<dir>"      install there
#   $env:SOLIPSIST_BASE_URL = "<url>"         fetch the files from here instead of GitHub Releases
#
# Errors are thrown, not `exit`ed: this script runs inside the user's own shell through `iex`. For the same reason
# everything, its preferences too, is inside `& { }`: set there, they don't outlast the script in that shell.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with its progress bar
  # Windows PowerShell 5.1 (what `powershell` is on Windows 10) may offer only TLS 1.0 and 1.1, which GitHub refuses.
  # Added to what it offers, not put in place of it. PowerShell 6 and later need nothing.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $repo = "pulkitsharma07/solipsist"
  if (-not [Environment]::Is64BitOperatingSystem) { throw "solipsist install: unsupported system: 32-bit Windows" }
  # Windows on ARM runs the x64 build through its own emulation.
  $asset = "solipsist-windows-x64.zip"

  if ($env:SOLIPSIST_BASE_URL) { $base = $env:SOLIPSIST_BASE_URL }
  elseif ($env:SOLIPSIST_VERSION) { $base = "https://github.com/$repo/releases/download/v$($env:SOLIPSIST_VERSION.TrimStart('v'))" }
  else { $base = "https://github.com/$repo/releases/latest/download" }
  $dir = if ($env:SOLIPSIST_INSTALL_DIR) { $env:SOLIPSIST_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "solipsist" }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("solipsist-install-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading Solipsist for windows-x64…"
    try {
      Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
      Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")
    } catch { throw "solipsist install: could not download $base/$asset ($($_.Exception.Message))" }

    $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match "  $([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) { throw "solipsist install: $asset is not in the release's SHA256SUMS" }
    $want = ($line -split "\s+")[0].ToLowerInvariant()
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
    if ($got -ne $want) { throw "solipsist install: checksum mismatch for $asset (expected $want, got $got): nothing installed" }

    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Path $tmp -Recurse -Filter "solipsist.exe" | Select-Object -First 1
    if (-not $exe) { throw "solipsist install: the download has no solipsist.exe in it" }
    $version = & $exe.FullName --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "solipsist install: the downloaded binary doesn't run: $version" }

    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    # A running solipsist.exe can't be overwritten but can be renamed: move it aside, then copy the new one in.
    $target = Join-Path $dir "solipsist.exe"
    if (Test-Path $target) { Move-Item -Force $target "$target.old" -ErrorAction SilentlyContinue }
    Copy-Item -Force $exe.FullName $target
    Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue

    Write-Host "Installed: $version"
    Write-Host "  $target"
    # The user's Path as stored, `%VAR%` entries unexpanded: [Environment]::GetEnvironmentVariable expands them, and
    # writing that back would turn `%USERPROFILE%\bin` into a fixed path for good.
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
      $userPath = [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = $userPath -split ";" | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") }
      if ($entries -notcontains $dir.TrimEnd("\")) {
        $envKey.SetValue("Path", ($(if ($userPath) { "$($userPath.TrimEnd(';'));" } else { "" }) + $dir), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Setting the registry tells no one. A variable set and removed through [Environment] sends the change
        # around, so a terminal opened from now on sees the new Path.
        [Environment]::SetEnvironmentVariable("SOLIPSIST_INSTALL_PATH_CHANGED", "1", "User")
        [Environment]::SetEnvironmentVariable("SOLIPSIST_INSTALL_PATH_CHANGED", $null, "User")
        Write-Host ""
        Write-Host "Added $dir to your PATH. Open a new terminal to use it."
      }
    } finally {
      $envKey.Close()
    }
    Write-Host ""
    Write-Host "Run it:  solipsist   then open http://localhost:3000 in your browser"
    Write-Host "Docs and configuration:  https://solipsist.sh/docs/"
    Write-Host "To uninstall: delete $dir and remove it from your PATH (your pages are never touched)."
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
