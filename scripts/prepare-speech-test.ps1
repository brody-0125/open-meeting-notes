# Windows dev-only: synthesizes speech.wav (16 kHz mono). CI and prepare-stt-test use test/fixtures/speech.wav instead.
# After changing text or voice, copy output to test/fixtures/speech.wav and update speech.wav.sha256.
param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
$fixtureRoot = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices('Name=Microsoft Zira Desktop')
if ($voices.Count -ne 1) { throw 'Microsoft Zira Desktop English voice required for this fixture.' }
$voice.Voice = $voices.Item(0)
$stream = New-Object -ComObject SAPI.SpFileStream
$stream.Format.Type = 18 # SAPI 16kHz / 16-bit / mono
$stream.Open((Join-Path $fixtureRoot 'speech.wav'), 3)
try {
  $voice.AudioOutputStream = $stream
  [void]$voice.Speak('The meeting starts at nine. Please send the report tomorrow.')
} finally { $stream.Close() }
