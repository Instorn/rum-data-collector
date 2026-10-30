# set-policy.ps1 - writes (or removes) the Google Chrome policy for RUM Monitor.
#
# Run in PowerShell "as Administrator":
#   .\set-policy.ps1                         write the values from policy.json
#   .\set-policy.ps1 -Remove                 delete the policy
#   .\set-policy.ps1 -ExtensionId <32 a-p>   use another ID (e.g. an unpacked copy)
#
# The values go to:
#   HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\<ExtensionId>\policy
# Then open chrome://policy and click "Reload policies".

param(
    [string]$File = "$PSScriptRoot\policy.json",
    [string]$ExtensionId = 'ogmlphnhjpgchhppnnpgnanaemnjkhhp',   # Chrome Web Store ID
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Key = "HKLM:\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\$ExtensionId"

# 1. Delete the old policy, so no values from a previous run stay behind.
if (Test-Path $Key) { Remove-Item $Key -Recurse -Force }
if ($Remove) {
    Write-Host 'Policy removed. Open chrome://policy and click "Reload policies".'
    exit
}

# 2. Write every value from policy.json (names starting with "_" are comments).
New-Item "$Key\policy" -Force | Out-Null
$settings = Get-Content $File -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($p in $settings.PSObject.Properties) {
    if ($p.Name.StartsWith('_')) { continue }
    $value = $p.Value

    if ($value -is [bool]) {                            # true/false -> REG_DWORD 1/0
        $type = 'DWord'; $value = [int]$value
    } elseif ($value -is [int] -or $value -is [long]) { # whole number -> REG_DWORD
        $type = 'DWord'
    } elseif ($value -is [string]) {                    # text -> REG_SZ
        $type = 'String'
    } else {                                            # object, list, fraction -> REG_SZ with JSON
        $type = 'String'; $value = ConvertTo-Json -InputObject $value -Compress -Depth 10
    }

    New-ItemProperty "$Key\policy" -Name $p.Name -PropertyType $type -Value $value | Out-Null
    Write-Host "$($p.Name) = $value"
}

Write-Host ''
Write-Host "Done: $Key\policy"
Write-Host 'Open chrome://policy and click "Reload policies".'
