# Administrator deployment helper. A local rule is not proof of effective policy;
# run the packaged egress gates after installation under the actual domain policy.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ApprovedManifestHash,
    [ValidateSet('Install', 'Remove')][string]$Action = 'Install'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PackageRoot -notmatch '^[a-zA-Z]:[\\/]' -or $PackageRoot -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'Local absolute package path required' }
$package = Get-Item -LiteralPath $PackageRoot
if (-not $package.PSIsContainer) { throw 'Package directory required' }
$ancestor = $package
while ($null -ne $ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package directory links denied' }
    $ancestor = $ancestor.Parent
}
$manifestPath = Join-Path $package.FullName 'build-manifest.json'
$program = Join-Path $package.FullName 'open-meeting-notes.exe'
foreach ($filePath in @($manifestPath, $program)) {
    $item = Get-Item -LiteralPath $filePath
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Regular package files required' }
}
if ((Get-Item -LiteralPath $manifestPath).Length -gt 4MB) { throw 'Manifest too large' }
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ApprovedManifestHash) { throw 'Manifest integrity mismatch' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.platform -ne 'win32-x64') { throw 'Unsupported package manifest' }
$entries = @($manifest.files | Where-Object { $_.path -ceq 'open-meeting-notes.exe' })
if ($entries.Count -ne 1 -or $entries[0].sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Executable descriptor required' }
if ((Get-Item -LiteralPath $program).Length -ne $entries[0].bytes -or
    (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entries[0].sha256) { throw 'Executable integrity mismatch' }
$hasher = [Security.Cryptography.SHA256]::Create()
try { $pathHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($program.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() }
finally { $hasher.Dispose() }
$ruleName = "open-meeting-notes-offline-$($pathHash.Substring(0, 24))"
$status = 'planned'
if ($PSCmdlet.ShouldProcess($program, "$Action outbound block rule $ruleName")) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator session required; no policy changed' }
    $existing = @(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object { $_.Name -ceq $ruleName })
    if ($existing.Count -gt 1) { throw 'Ambiguous existing rule' }
    if ($existing.Count -eq 1) {
        $filters = @($existing[0] | Get-NetFirewallApplicationFilter)
        if ($filters.Count -ne 1 -or $filters[0].Program -ine $program -or $existing[0].Group -cne 'open-meeting-notes offline deployment') { throw 'Existing rule ownership mismatch' }
    }
    if ($Action -eq 'Install') {
        if ($existing.Count) { throw 'Rule already exists; audit effective policy before making further changes' }
        New-NetFirewallRule -Name $ruleName -DisplayName 'open-meeting-notes outbound block' -Group 'open-meeting-notes offline deployment' -PolicyStore PersistentStore -Program $program -Direction Outbound -Action Block -Enabled True -Profile Any -Protocol Any -LocalAddress Any -RemoteAddress Any | Out-Null
        $status = 'local-rule-created'
    } else {
        if ($existing.Count) { $existing[0] | Remove-NetFirewallRule }
        $status = 'local-rule-removed-or-absent'
    }
}
[pscustomobject]@{ status = $status; name = $ruleName; program = $program; direction = 'Outbound'; action = 'Block'; effectivePolicyVerified = $false } | ConvertTo-Json -Compress
