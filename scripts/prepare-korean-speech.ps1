param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[void][System.IO.Directory]::CreateDirectory($fixtureRoot)
$cases = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../test/fixtures/korean-stt.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices('Name=Microsoft Heami Desktop')
if ($voices.Count -ne 1) { throw 'Microsoft Heami Desktop Korean voice is required.' }
$voice.Voice = $voices.Item(0)
foreach ($case in $cases) {
  if ($case.id -notmatch '^[a-z-]+$') { throw 'Invalid fixture ID' }
  $stream = New-Object -ComObject SAPI.SpFileStream
  $stream.Format.Type = 18
  $stream.Open((Join-Path $fixtureRoot ($case.id + '.wav')), 3)
  try { $voice.AudioOutputStream = $stream; [void]$voice.Speak($case.text) } finally { $stream.Close() }
}
Write-Output "Prepared $($cases.Count) local synthetic Korean utterances."
