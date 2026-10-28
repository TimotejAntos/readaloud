# Practice voice for smoke-test.mjs --practice (Windows only, free).
# Speaks each sentence with the built-in Windows voice into a WAV and records
# where each word starts, like DeepInfra's word timestamps. The voice's own
# format is kept on purpose: with a custom format (e.g. 24 kHz) the reported
# word positions are off by 24000/22050. smoke-test.mjs resamples to 24 kHz.
#   powershell -File practice-voice.ps1 -InFile sentences.json -OutDir <folder>
# Prints JSON: [{ wav, seconds, words: [{ text, start }] }, ...]
param([string]$InFile, [string]$OutDir)
Add-Type -AssemblyName System.Speech
$texts = Get-Content -Raw -Encoding UTF8 $InFile | ConvertFrom-Json
$result = @()
$i = 0
foreach ($t in $texts) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $wav = Join-Path $OutDir "practice-$i.wav"
  $s.SetOutputToWaveFile($wav)
  $words = New-Object System.Collections.ArrayList
  $s.add_SpeakProgress([System.EventHandler[System.Speech.Synthesis.SpeakProgressEventArgs]]{
    param($o, $e)
    [void]$words.Add(@{ text = $e.Text; start = $e.AudioPosition.TotalSeconds })
  })
  $s.Speak([string]$t)
  $s.Dispose()
  $b = [System.IO.File]::ReadAllBytes($wav)
  $bytesPerSecond = [BitConverter]::ToInt32($b, 28)
  $seconds = ($b.Length - 44) / $bytesPerSecond
  $result += ,@{ wav = $wav; seconds = $seconds; words = @($words) }
  $i++
}
ConvertTo-Json -InputObject $result -Depth 5 -Compress
