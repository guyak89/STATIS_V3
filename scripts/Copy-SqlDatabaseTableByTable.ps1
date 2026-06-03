#requires -Version 5.1
<#
.SYNOPSIS
Configure et lance une copie SQL Server table par table avec profils dynamiques.

.DESCRIPTION
Au premier lancement, le script demande les parametres source/destination,
les mots de passe SQL necessaires, les tables a exclure et l'heure de la
tache planifiee. La configuration est stockee en JSON dans AppData. Les mots
de passe sont stockes separement avec Export-Clixml, chiffre pour l'utilisateur
Windows courant.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-SqlDatabaseTableByTable.ps1 -ProfileName URCLEC_to_PERFECT -Configure

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-SqlDatabaseTableByTable.ps1 -ProfileName URCLEC_to_PERFECT -RegisterDailyTask

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-SqlDatabaseTableByTable.ps1 -ProfileName URCLEC_to_PERFECT -Force
#>

[CmdletBinding()]
param(
    [string]$ProfileName = "",
    [switch]$Configure,
    [switch]$RegisterDailyTask,
    [switch]$RunNow,
    [switch]$SetRemoteCredentialOnly,
    [switch]$SetLocalCredentialOnly,
    [switch]$Force,
    [switch]$NoProgress,
    [switch]$SkipRowCountVerification,
    [switch]$SkipIndexesAndConstraints,
    [switch]$StopOnPostCopyDdlError
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ProfileRoot = Join-Path $env:APPDATA "SqlTableCopy\profiles"
$script:CredentialRoot = Join-Path $env:APPDATA "SqlTableCopy"
$script:EnginePath = Join-Path $PSScriptRoot "Copy-UrclecToLocalPERFECT.ps1"

function Get-SafeName {
    param([Parameter(Mandatory = $true)][string]$Name)

    $safe = ($Name.Trim() -replace '[\\/:*?"<>|,\s]+', '_')
    if ([string]::IsNullOrWhiteSpace($safe)) {
        throw "Nom de profil invalide."
    }
    return $safe
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Read-ConfigValue {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [AllowNull()][string]$Default = "",
        [bool]$Required = $true
    )

    while ($true) {
        $label = $Prompt
        if (-not [string]::IsNullOrWhiteSpace($Default)) {
            $label = "{0} [{1}]" -f $Prompt, $Default
        }

        $value = Read-Host $label
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $Default
        }

        if (-not $Required -or -not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }

        Write-Host "Valeur obligatoire."
    }
}

function Read-YesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [bool]$Default = $false
    )

    $defaultText = "N"
    if ($Default) {
        $defaultText = "O"
    }

    while ($true) {
        $value = Read-Host ("{0} (O/N) [{1}]" -f $Prompt, $defaultText)
        if ([string]::IsNullOrWhiteSpace($value)) {
            return $Default
        }

        switch ($value.Trim().ToUpperInvariant()) {
            "O" { return $true }
            "OUI" { return $true }
            "Y" { return $true }
            "YES" { return $true }
            "N" { return $false }
            "NON" { return $false }
            "NO" { return $false }
            default { Write-Host "Reponds par O ou N." }
        }
    }
}

function Read-TimeValue {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [string]$Default = "16:30"
    )

    while ($true) {
        $value = Read-ConfigValue -Prompt $Prompt -Default $Default -Required $true
        try {
            [void][datetime]::ParseExact($value, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
            return $value
        }
        catch {
            Write-Host "Format attendu: HH:mm, exemple 16:30."
        }
    }
}

function Get-ProfilePath {
    param([Parameter(Mandatory = $true)][string]$Name)
    return (Join-Path $script:ProfileRoot ("{0}.json" -f (Get-SafeName $Name)))
}

function Import-ProfileConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Export-ProfileConfig {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$Path
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $Config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding UTF8
    Write-Host ("Configuration enregistree: {0}" -f $Path)
}

function Save-SqlCredential {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Path
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    Write-Host ("Utilisateur SQL pour {0}: {1}" -f $Kind, $UserName)
    $password = Read-Host -AsSecureString -Prompt ("Mot de passe SQL pour {0}" -f $Kind)
    $credential = New-Object System.Management.Automation.PSCredential($UserName, $password)
    $credential | Export-Clixml -LiteralPath $Path
    Write-Host ("Credential enregistre avec chiffrement Windows: {0}" -f $Path)
}

function Ensure-SqlCredential {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Path,
        [bool]$ForcePrompt = $false
    )

    if ((Test-Path -LiteralPath $Path) -and -not $ForcePrompt) {
        Write-Host ("Credential deja present pour {0}: {1}" -f $Kind, $Path)
        return
    }

    Save-SqlCredential -Kind $Kind -UserName $UserName -Path $Path
}

function Split-TableList {
    param([AllowNull()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Trim() -eq "-") {
        return @()
    }

    return @($Text.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function New-InteractiveConfig {
    param(
        [AllowNull()]$ExistingConfig,
        [Parameter(Mandatory = $true)][string]$ResolvedProfileName
    )

    $remoteServerDefault = "100.82.251.93\sql2019"
    $remoteDatabaseDefault = "URCLEC"
    $remoteUserDefault = "urclecdb"
    $localServerDefault = "localhost\SQL2022"
    $localDatabaseDefault = "PERFECT"
    $useLocalSqlLoginDefault = $false
    $localUserDefault = "sa"
    $excludedTablesDefault = "MOUCHARD,MOUCHARD_NEW"
    $dailyAtDefault = "16:30"

    if ($null -ne $ExistingConfig) {
        $remoteServerDefault = [string]$ExistingConfig.RemoteServer
        $remoteDatabaseDefault = [string]$ExistingConfig.RemoteDatabase
        $remoteUserDefault = [string]$ExistingConfig.RemoteUser
        $localServerDefault = [string]$ExistingConfig.LocalServer
        $localDatabaseDefault = [string]$ExistingConfig.LocalDatabase
        $useLocalSqlLoginDefault = [bool]$ExistingConfig.UseLocalSqlLogin
        $localUserDefault = [string]$ExistingConfig.LocalUser
        $excludedTablesDefault = (@($ExistingConfig.ExcludedTables) -join ",")
        $dailyAtDefault = [string]$ExistingConfig.DailyAt
    }

    Write-Host ""
    Write-Host ("Configuration du profil: {0}" -f $ResolvedProfileName)

    $remoteServer = Read-ConfigValue -Prompt "Serveur SQL source" -Default $remoteServerDefault
    $remoteDatabase = Read-ConfigValue -Prompt "Base source" -Default $remoteDatabaseDefault
    $remoteUser = Read-ConfigValue -Prompt "Utilisateur SQL source" -Default $remoteUserDefault
    $localServer = Read-ConfigValue -Prompt "Serveur SQL destination/local" -Default $localServerDefault
    $localDatabase = Read-ConfigValue -Prompt "Base destination a recreer" -Default $localDatabaseDefault
    $useLocalSqlLogin = Read-YesNo -Prompt "La destination utilise un login SQL au lieu de Windows Auth ?" -Default $useLocalSqlLoginDefault

    $localUser = $localUserDefault
    if ($useLocalSqlLogin) {
        $localUser = Read-ConfigValue -Prompt "Utilisateur SQL destination" -Default $localUserDefault
    }

    $excludedTablesText = Read-ConfigValue -Prompt "Tables a exclure, separees par virgule (- pour aucune)" -Default $excludedTablesDefault -Required $false
    $dailyAt = Read-TimeValue -Prompt "Heure quotidienne de la tache planifiee (HH:mm)" -Default $dailyAtDefault

    $safeProfileName = Get-SafeName $ResolvedProfileName
    $taskNameDefault = "Copie SQL {0} vers {1}" -f $remoteDatabase, $localDatabase
    if ($null -ne $ExistingConfig -and -not [string]::IsNullOrWhiteSpace([string]$ExistingConfig.TaskName)) {
        $taskNameDefault = [string]$ExistingConfig.TaskName
    }
    $taskName = Read-ConfigValue -Prompt "Nom de la tache planifiee" -Default $taskNameDefault

    return [pscustomobject][ordered]@{
        ProfileName = $ResolvedProfileName
        RemoteServer = $remoteServer
        RemoteDatabase = $remoteDatabase
        RemoteUser = $remoteUser
        LocalServer = $localServer
        LocalDatabase = $localDatabase
        UseLocalSqlLogin = $useLocalSqlLogin
        LocalUser = $localUser
        ExcludedTables = @(Split-TableList -Text $excludedTablesText)
        DailyAt = $dailyAt
        TaskName = $taskName
        RemoteCredentialPath = (Join-Path $script:CredentialRoot ("{0}_remote.credential.xml" -f $safeProfileName))
        LocalCredentialPath = (Join-Path $script:CredentialRoot ("{0}_local.credential.xml" -f $safeProfileName))
    }
}

function Resolve-ProfileName {
    if (-not [string]::IsNullOrWhiteSpace($ProfileName)) {
        return $ProfileName.Trim()
    }

    Ensure-Directory -Path $script:ProfileRoot
    $profiles = @(Get-ChildItem -LiteralPath $script:ProfileRoot -Filter "*.json" -ErrorAction SilentlyContinue)
    if ($profiles.Count -eq 1 -and -not $Configure) {
        return [System.IO.Path]::GetFileNameWithoutExtension($profiles[0].Name)
    }

    return (Read-ConfigValue -Prompt "Nom du profil de copie" -Default "URCLEC_to_PERFECT")
}

function Register-ProfileDailyTask {
    param([Parameter(Mandatory = $true)]$Config)

    $taskTime = [datetime]::ParseExact([string]$Config.DailyAt, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
    $scriptPath = $PSCommandPath

    $argumentParts = New-Object System.Collections.Generic.List[string]
    $argumentParts.Add("-NoProfile")
    $argumentParts.Add("-ExecutionPolicy Bypass")
    $argumentParts.Add(("-File ""{0}""" -f $scriptPath))
    $argumentParts.Add(("-ProfileName ""{0}""" -f [string]$Config.ProfileName))
    $argumentParts.Add("-Force")
    $argumentParts.Add("-NoProgress")

    $actionParameters = @{
        Execute = "powershell.exe"
        Argument = ($argumentParts -join " ")
    }
    if ((Get-Command New-ScheduledTaskAction).Parameters.ContainsKey("WorkingDirectory")) {
        $actionParameters["WorkingDirectory"] = $PSScriptRoot
    }

    $action = New-ScheduledTaskAction @actionParameters
    $trigger = New-ScheduledTaskTrigger -Daily -At $taskTime
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName ([string]$Config.TaskName) -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ("Copie quotidienne SQL Server profil {0}." -f [string]$Config.ProfileName) -Force | Out-Null
    Write-Host ("Tache planifiee enregistree: {0} chaque jour a {1}" -f [string]$Config.TaskName, [string]$Config.DailyAt)
}

function Invoke-CopyEngine {
    param([Parameter(Mandatory = $true)]$Config)

    if (-not (Test-Path -LiteralPath $script:EnginePath)) {
        throw "Script moteur introuvable: $script:EnginePath"
    }

    $engineArgs = @{
        RemoteServer = [string]$Config.RemoteServer
        RemoteDatabase = [string]$Config.RemoteDatabase
        RemoteUser = [string]$Config.RemoteUser
        LocalServer = [string]$Config.LocalServer
        LocalDatabase = [string]$Config.LocalDatabase
        RemoteCredentialPath = [string]$Config.RemoteCredentialPath
        DailyAt = [string]$Config.DailyAt
        TaskName = [string]$Config.TaskName
        ExcludedTables = @($Config.ExcludedTables)
    }

    if ([bool]$Config.UseLocalSqlLogin) {
        $engineArgs["UseLocalSqlLogin"] = $true
        $engineArgs["LocalUser"] = [string]$Config.LocalUser
        $engineArgs["LocalCredentialPath"] = [string]$Config.LocalCredentialPath
    }
    if ($Force) { $engineArgs["Force"] = $true }
    if ($NoProgress) { $engineArgs["NoProgress"] = $true }
    if ($SkipRowCountVerification) { $engineArgs["SkipRowCountVerification"] = $true }
    if ($SkipIndexesAndConstraints) { $engineArgs["SkipIndexesAndConstraints"] = $true }
    if ($StopOnPostCopyDdlError) { $engineArgs["StopOnPostCopyDdlError"] = $true }

    & $script:EnginePath @engineArgs
}

Ensure-Directory -Path $script:ProfileRoot
Ensure-Directory -Path $script:CredentialRoot

$resolvedProfileName = Resolve-ProfileName
$profilePath = Get-ProfilePath -Name $resolvedProfileName
$config = Import-ProfileConfig -Path $profilePath
$forceRemoteCredentialPrompt = $false
$forceLocalCredentialPrompt = $false

if ($Configure -or $null -eq $config) {
    $oldConfig = $config
    $config = New-InteractiveConfig -ExistingConfig $config -ResolvedProfileName $resolvedProfileName
    Export-ProfileConfig -Config $config -Path $profilePath
    if ($null -eq $oldConfig) {
        $forceRemoteCredentialPrompt = $true
        $forceLocalCredentialPrompt = [bool]$config.UseLocalSqlLogin
    }
    else {
        $forceRemoteCredentialPrompt = (
            [string]$oldConfig.RemoteServer -ne [string]$config.RemoteServer -or
            [string]$oldConfig.RemoteDatabase -ne [string]$config.RemoteDatabase -or
            [string]$oldConfig.RemoteUser -ne [string]$config.RemoteUser
        )
        $forceLocalCredentialPrompt = (
            [bool]$config.UseLocalSqlLogin -and (
                -not [bool]$oldConfig.UseLocalSqlLogin -or
                [string]$oldConfig.LocalServer -ne [string]$config.LocalServer -or
                [string]$oldConfig.LocalDatabase -ne [string]$config.LocalDatabase -or
                [string]$oldConfig.LocalUser -ne [string]$config.LocalUser
            )
        )
    }
}

if ($SetRemoteCredentialOnly) {
    Save-SqlCredential -Kind ("source {0}/{1}" -f [string]$config.RemoteServer, [string]$config.RemoteDatabase) -UserName ([string]$config.RemoteUser) -Path ([string]$config.RemoteCredentialPath)
    return
}

if ($SetLocalCredentialOnly) {
    if (-not [bool]$config.UseLocalSqlLogin) {
        throw "Ce profil utilise Windows Auth pour la destination; aucun mot de passe SQL local n'est necessaire."
    }
    Save-SqlCredential -Kind ("destination {0}/{1}" -f [string]$config.LocalServer, [string]$config.LocalDatabase) -UserName ([string]$config.LocalUser) -Path ([string]$config.LocalCredentialPath)
    return
}

Ensure-SqlCredential -Kind ("source {0}/{1}" -f [string]$config.RemoteServer, [string]$config.RemoteDatabase) -UserName ([string]$config.RemoteUser) -Path ([string]$config.RemoteCredentialPath) -ForcePrompt $forceRemoteCredentialPrompt
if ([bool]$config.UseLocalSqlLogin) {
    Ensure-SqlCredential -Kind ("destination {0}/{1}" -f [string]$config.LocalServer, [string]$config.LocalDatabase) -UserName ([string]$config.LocalUser) -Path ([string]$config.LocalCredentialPath) -ForcePrompt $forceLocalCredentialPrompt
}

if ($RegisterDailyTask) {
    Register-ProfileDailyTask -Config $config
    if (-not $RunNow) {
        return
    }
}

Invoke-CopyEngine -Config $config
