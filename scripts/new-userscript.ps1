\
    <#
    (Bloodawn)
    File: new-userscript.ps1
    Purpose: Creates a new userscript folder with template files.
    #>

    param(
      [Parameter(Mandatory=$true)]
      [string]$Category,
      [Parameter(Mandatory=$true)]
      [string]$Name
    )

    $safeName = $Name.ToLower().Replace(" ", "-")
    $dest = Join-Path $PSScriptRoot "..\userscripts\$Category\$safeName"

    if (Test-Path $dest) {
      Write-Host "Yo, that folder already exists. Pick a new name 😤"
      exit 1
    }

    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "..\userscripts\_template\*") $dest

    $tmpl = Join-Path $dest "template.user.js"
    $new = Join-Path $dest "$safeName.user.js"
    Rename-Item -Force $tmpl $new

    Write-Host "Created: $dest"
    Write-Host "Now edit: $new (metadata block + logic)"
