param([Parameter(Mandatory)][string]$RequestFile,[Parameter(Mandatory)][string]$RequestSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
function Read-Pinned([string]$File,[string]$Sha,[int]$Limit) {
    $bytes = [IO.File]::ReadAllBytes($File)
    if ($bytes.Length -gt $Limit -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $Sha) { throw '输入pin不符' }
    return ,$bytes
}
function Assert-Path([string]$File,[string]$Root) {
    $full = [IO.Path]::GetFullPath($File)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw '配音路径越界' }
    $cursor = $full
    while ($cursor.Length -ge $prefix.Length) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '禁止重解析路径' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
$request = $utf8.GetString((Read-Pinned $RequestFile $RequestSha256 16384)) | ConvertFrom-Json
$expected = @('schema','taskRoot','markerSha256','textFile','textSha256','stagingFile','tokenId','rate')
if (@($request.PSObject.Properties.Name).Count -ne $expected.Count -or @($request.PSObject.Properties.Name | Where-Object { $_ -notin $expected }).Count -gt 0 -or $request.schema -cne 'content_local_voice_v1') { throw '配音合同字段不符' }
Assert-Path $RequestFile $request.taskRoot
Assert-Path $request.textFile $request.taskRoot
Assert-Path $request.stagingFile ([IO.Path]::Combine($request.taskRoot,'work','content-media','voiceover'))
$null = Read-Pinned ([IO.Path]::Combine($request.taskRoot,'.task-binding.json')) $request.markerSha256 4096
$text = $utf8.GetString((Read-Pinned $request.textFile $request.textSha256 8192))
if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 2000 -or $text -match '[<>\x00-\x08\x0b\x0c\x0e-\x1f]' -or $request.rate -notin @(-2,-1,0,1,2) -or [IO.File]::Exists($request.stagingFile)) { throw '文字、语速或新文件要求不符' }
$speaker = $null; $stream = $null; $tokens = $null; $selected = $null
try {
    $speaker = New-Object -ComObject SAPI.SpVoice
    $tokens = $speaker.GetVoices()
    for ($index = 0; $index -lt $tokens.Count; $index++) {
        $candidate = $tokens.Item($index)
        if ($candidate.Id -ceq $request.tokenId) { if ($null -ne $selected) { throw '音色token重复' }; $selected = $candidate }
        else { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidate) }
    }
    if ($null -eq $selected) { throw '固定音色token不可用，禁止回退' }
    $stream = New-Object -ComObject SAPI.SpFileStream
    $stream.Open($request.stagingFile,3,$false)
    $speaker.Voice = $selected
    $speaker.Rate = [int]$request.rate
    $speaker.AudioOutputStream = $stream
    # SVSFIsNotXML=16；同步纯文本，只写文件，不使用扬声器。
    $temporaryStreamNumber = $speaker.Speak($text,16)
    $stream.Close()
    @{status='succeeded';textSha256=$request.textSha256;tokenId=$request.tokenId;temporaryStreamNumber=$temporaryStreamNumber;nativeConversationId=$null} | ConvertTo-Json -Compress
} finally {
    foreach ($item in @($stream,$selected,$tokens,$speaker)) { if ($null -ne $item) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) } }
}
