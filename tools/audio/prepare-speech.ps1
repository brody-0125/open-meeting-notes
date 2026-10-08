# Windows SAPI corpus generator. No repository-relative corpus or output defaults.
param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$CorpusPath,
  [string]$VoiceName = 'Microsoft Heami Desktop',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$cases = @(Get-Content -LiteralPath $CorpusPath -Raw -Encoding UTF8 | ConvertFrom-Json)
if ($cases.Count -eq 0) { throw 'Corpus must contain at least one case.' }
$ids = @{}
# Validate the complete corpus before creating or overwriting any output.
foreach ($case in $cases) {
  if ($case.id -isnot [string] -or $case.id -cnotmatch '^[a-z][a-z0-9-]*$' -or $ids.ContainsKey($case.id)) { throw 'Invalid or duplicate fixture ID' }
  $ids[$case.id] = $true
  if ($case.text -isnot [string] -or [string]::IsNullOrWhiteSpace($case.text)) { throw 'Fixture text is required' }
  foreach ($field in @('voiceRate', 'leadSilenceMs', 'tailSilenceMs')) {
    $value = $case.$field
    if ($null -eq $value) { continue }
    $minimum = 0; $maximum = 10000
    if ($field -eq 'voiceRate') { $minimum = -10; $maximum = 10 }
    if ($value -isnot [int] -and $value -isnot [long]) { throw "Invalid integer: $field" }
    if ($value -lt $minimum -or $value -gt $maximum) { throw "Out of range: $field" }
  }
  foreach ($suffix in @('.wav', '.wav.sha256')) {
    if ((Test-Path -LiteralPath (Join-Path $fixtureRoot ($case.id + $suffix))) -and -not $Force) {
      throw "Output exists for $($case.id); choose another directory or use -Force."
    }
  }
}
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices()
$selected = @($voices | Where-Object { $_.GetAttribute('Name') -eq $VoiceName })
if ($selected.Count -ne 1) { throw "Exactly one installed SAPI voice named '$VoiceName' is required." }
$voice.Voice = $selected[0]
[void][System.IO.Directory]::CreateDirectory($fixtureRoot)
foreach ($case in $cases) {
  $voice.Rate = [int]$case.voiceRate
  $path = Join-Path $fixtureRoot ($case.id + '.wav')
  $stream = New-Object -ComObject SAPI.SpFileStream
  $stream.Format.Type = 18 # 16 kHz / 16-bit / mono
  $stream.Open($path, 3)
  try {
    $voice.AudioOutputStream = $stream
    # Treat source text literally even when it contains XML-looking text.
    $lead = [int]$case.leadSilenceMs; $tail = [int]$case.tailSilenceMs
    $text = [System.Security.SecurityElement]::Escape($case.text)
    [void]$voice.Speak("<sapi><silence msec='$lead'/>$text<silence msec='$tail'/></sapi>", 8)
  } finally { $stream.Close() }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $audioFile = [System.IO.File]::OpenRead($path)
  try { $digest = [System.BitConverter]::ToString($hasher.ComputeHash($audioFile)).Replace('-', '').ToLowerInvariant() }
  finally { $audioFile.Dispose(); $hasher.Dispose() }
  [System.IO.File]::WriteAllText($path + '.sha256', $digest + "`n", [System.Text.Encoding]::ASCII)
}
Write-Output "Prepared $($cases.Count) WAV files and SHA256 sidecars using '$VoiceName' in $fixtureRoot"
