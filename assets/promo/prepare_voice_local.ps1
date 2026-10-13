param(
    [Parameter(Mandatory = $true)][string]$Storyboard,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$promoSpec = Get-Content -LiteralPath $Storyboard -Raw -Encoding UTF8 | ConvertFrom-Json
$promoSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$promoVoiceNames = @($promoSynth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$promoVoice = @('Microsoft Yaoyao', 'Microsoft Huihui', 'Microsoft Huihui Desktop') | Where-Object { $promoVoiceNames -contains $_ } | Select-Object -First 1
if (-not $promoVoice) { throw 'A Chinese Windows speech voice is required.' }
$promoSynth.SelectVoice($promoVoice)
$promoSynth.Volume = 100

try {
    for ($promoIndex = 0; $promoIndex -lt $promoSpec.scenes.Count; $promoIndex++) {
        $promoScene = $promoSpec.scenes[$promoIndex]
        $promoAvailable = $promoScene.end - $promoScene.start - 0.32
        $promoVoicePath = Join-Path $OutputDirectory ('voice-local-{0}.wav' -f $promoIndex)
        $promoSpokenText = [System.Security.SecurityElement]::Escape($promoScene.voice)
        if ($promoIndex -eq 7 -and $promoVoiceNames -contains 'Microsoft Zira Desktop') {
            $promoChineseEnding = [System.Security.SecurityElement]::Escape($promoScene.voice.Substring(10))
            $promoSpokenText = '<voice xml:lang="en-US" name="Microsoft Zira Desktop">Pi Memory</voice><break time="120ms"/><voice xml:lang="zh-CN" name="' + $promoVoice + '">' + $promoChineseEnding + '</voice>'
        }
        $promoSsml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">' + $promoSpokenText + '</speak>'
        for ($promoRate = 1; $promoRate -le 4; $promoRate++) {
            $promoSynth.Rate = $promoRate
            $promoSynth.SetOutputToWaveFile($promoVoicePath)
            $promoSynth.SpeakSsml($promoSsml)
            $promoSynth.SetOutputToNull()
            $promoDuration = [double](& ffprobe.exe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $promoVoicePath)
            if ($promoDuration -le $promoAvailable) { break }
        }
        if ($promoDuration -gt $promoAvailable) { throw ('Voice {0} exceeds its narration window.' -f ($promoIndex + 1)) }
        Write-Output ('Voice {0}/8: {1:N2}s, Windows {2}, rate {3}' -f ($promoIndex + 1), $promoDuration, $promoVoice, $promoSynth.Rate)
    }
} finally {
    $promoSynth.Dispose()
}
