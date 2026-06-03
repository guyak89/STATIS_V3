#requires -Version 5.1
<#
.SYNOPSIS
Copie table par table la base SQL Server distante URCLEC vers la base locale PERFECT.

.DESCRIPTION
Le script supprime puis recree la base locale cible avant chaque copie.
Le mot de passe SQL distant n'est jamais ecrit dans ce fichier. Il peut etre
stocke localement avec Export-Clixml, chiffre par Windows pour l'utilisateur courant.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-UrclecToLocalPERFECT.ps1 -SaveRemoteCredential -Force

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-UrclecToLocalPERFECT.ps1 -SetRemoteCredentialOnly

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-UrclecToLocalPERFECT.ps1 -RegisterDailyTask -SaveRemoteCredential

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\Copy-UrclecToLocalPERFECT.ps1 -LocalServer "localhost\SQL2022" -UseLocalSqlLogin -LocalUser "sa" -SaveLocalCredential -SaveRemoteCredential -Force
#>

[CmdletBinding()]
param(
    [string]$RemoteServer = "100.82.251.93\sql2019",
    [string]$RemoteDatabase = "URCLEC",
    [string]$RemoteUser = "urclecdb",

    [string]$LocalServer = "localhost\SQL2022",
    [string]$LocalDatabase = "PERFECT",
    [switch]$UseLocalSqlLogin,
    [string]$LocalUser = "sa",
    [string[]]$ExcludedTables = @("MOUCHARD", "MOUCHARD_NEW"),

    [string]$RemoteCredentialPath = (Join-Path $env:APPDATA "SqlTableCopy\URCLEC_remote.credential.xml"),
    [string]$LocalCredentialPath = (Join-Path $env:APPDATA "SqlTableCopy\PERFECT_local.credential.xml"),
    [switch]$SaveRemoteCredential,
    [switch]$SaveLocalCredential,
    [switch]$SetRemoteCredentialOnly,
    [switch]$SetLocalCredentialOnly,

    [switch]$RegisterDailyTask,
    [string]$DailyAt = "16:30",
    [string]$TaskName = "Copie SQL URCLEC vers PERFECT",
    [switch]$RunNow,

    [switch]$Force,
    [bool]$UseSnapshotIfAvailable = $true,
    [int]$BulkCopyBatchSize = 5000,
    [int]$BulkCopyTimeoutSeconds = 0,
    [switch]$NoProgress,
    [switch]$SkipRowCountVerification,
    [switch]$SkipIndexesAndConstraints,
    [switch]$StopOnPostCopyDdlError,
    [string]$LogDirectory = "",
    [string]$ReportDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $LogDirectory = Join-Path $repoRoot "logs"
}

if ([string]::IsNullOrWhiteSpace($ReportDirectory)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $ReportDirectory = Join-Path $repoRoot "reports"
}

if (-not (Test-Path -LiteralPath $LogDirectory)) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
}

if (-not (Test-Path -LiteralPath $ReportDirectory)) {
    New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
}

$script:RunName = ("{0}_to_{1}" -f $RemoteDatabase, $LocalDatabase) -replace '[\\/:*?"<>|,\s]+', '_'
$script:LogPath = Join-Path $LogDirectory ("{0}_{1}.log" -f $script:RunName, (Get-Date -Format "yyyyMMdd_HHmmss"))
$script:ReportPath = Join-Path $ReportDirectory ("{0}_{1}.md" -f $script:RunName, (Get-Date -Format "yyyyMMdd_HHmmss"))
$script:RunStartedAt = Get-Date
$script:RunFinishedAt = $null
$script:RunStatus = "NOT_STARTED"
$script:RunError = ""
$script:SnapshotMode = "N/A"
$script:TableReports = New-Object System.Collections.ArrayList
$script:DdlWarnings = New-Object System.Collections.ArrayList
$script:CopiedTables = 0
$script:TotalSourceRows = [int64]0
$script:TotalDestinationRows = [int64]0

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $line
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Write-CopyReport {
    $script:RunFinishedAt = Get-Date
    $duration = New-TimeSpan -Start $script:RunStartedAt -End $script:RunFinishedAt
    $durationText = "{0:00}:{1:00}:{2:00}" -f [int]$duration.TotalHours, $duration.Minutes, $duration.Seconds

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add(("# Rapport copie SQL {0} vers {1}" -f $RemoteDatabase, $LocalDatabase))
    $lines.Add("")
    $lines.Add(("Date execution: {0}" -f $script:RunStartedAt.ToString("yyyy-MM-dd HH:mm:ss")))
    $lines.Add(("Statut: {0}" -f $script:RunStatus))
    $lines.Add(("Duree: {0}" -f $durationText))
    $lines.Add(("Source: {0}/{1}" -f $RemoteServer, $RemoteDatabase))
    $lines.Add(("Destination: {0}/{1}" -f $LocalServer, $LocalDatabase))
    $lines.Add(("Isolation lecture: {0}" -f $script:SnapshotMode))
    $lines.Add(("Tables exclues: {0}" -f (($ExcludedTables | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ", ")))
    $lines.Add(("Tables copiees: {0}" -f $script:CopiedTables))

    if (-not $SkipRowCountVerification) {
        $lines.Add(("Total lignes source: {0}" -f $script:TotalSourceRows))
        $lines.Add(("Total lignes locales: {0}" -f $script:TotalDestinationRows))
    }

    if (-not [string]::IsNullOrWhiteSpace($script:RunError)) {
        $lines.Add(("Erreur: {0}" -f $script:RunError))
    }

    $lines.Add(("Avertissements DDL: {0}" -f $script:DdlWarnings.Count))
    $lines.Add(("Log technique: {0}" -f $script:LogPath))
    $lines.Add("")

    if ($script:DdlWarnings.Count -gt 0) {
        $lines.Add("## Avertissements")
        foreach ($warning in $script:DdlWarnings) {
            $lines.Add(("- {0}" -f $warning))
        }
        $lines.Add("")
    }

    if ($script:TableReports.Count -gt 0) {
        $lines.Add("## Detail tables")
        if ($SkipRowCountVerification) {
            $lines.Add("| Schema | Table | Statut |")
            $lines.Add("|---|---|---|")
            foreach ($row in $script:TableReports) {
                $lines.Add(("| {0} | {1} | {2} |" -f $row.Schema, $row.Table, $row.Status))
            }
        }
        else {
            $lines.Add("| Schema | Table | Source | Local | Statut |")
            $lines.Add("|---|---|---:|---:|---|")
            foreach ($row in $script:TableReports) {
                $lines.Add(("| {0} | {1} | {2} | {3} | {4} |" -f $row.Schema, $row.Table, $row.SourceRows, $row.LocalRows, $row.Status))
            }
        }
    }

    Set-Content -LiteralPath $script:ReportPath -Value $lines -Encoding UTF8
    Write-Log ("Rapport genere: {0}" -f $script:ReportPath)
}

function Quote-SqlName {
    param([Parameter(Mandatory = $true)][string]$Name)
    return "[{0}]" -f $Name.Replace("]", "]]")
}

function Escape-SqlLiteral {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) {
        return $null
    }
    return $Value.Replace("'", "''")
}

function Get-ExcludedTablePredicate {
    param([Parameter(Mandatory = $true)][string]$Alias)

    $names = @($ExcludedTables | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
    if ($names.Count -eq 0) {
        return ""
    }

    $quotedNames = $names | ForEach-Object { "N'{0}'" -f (Escape-SqlLiteral $_) }
    return "  AND {0}.name NOT IN ({1})" -f $Alias, ($quotedNames -join ", ")
}

function Get-FieldValue {
    param(
        [Parameter(Mandatory = $true)]$Row,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($Row.IsNull($Name)) {
        return $null
    }

    return $Row[$Name]
}

function Ensure-ParentDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
}

function Get-ManagedSqlCredential {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Save,
        [switch]$MustSave
    )

    if ((Test-Path -LiteralPath $Path) -and -not $Save) {
        Write-Log ("Lecture du credential {0} depuis {1}" -f $Kind, $Path)
        return Import-Clixml -LiteralPath $Path
    }

    if (-not [Environment]::UserInteractive) {
        throw "Credential $Kind absent: $Path. Lance d'abord le script en mode interactif avec -SaveRemoteCredential ou -SaveLocalCredential."
    }

    Write-Host ("Utilisateur SQL pour {0}: {1}" -f $Kind, $UserName)
    $password = Read-Host -AsSecureString -Prompt ("Mot de passe SQL pour {0}" -f $Kind)
    $credential = New-Object System.Management.Automation.PSCredential($UserName, $password)

    if ($Save -or $MustSave) {
        Ensure-ParentDirectory -Path $Path
        $credential | Export-Clixml -LiteralPath $Path
        Write-Log ("Credential {0} enregistre localement avec chiffrement Windows: {1}" -f $Kind, $Path)
    }

    return $credential
}

function New-SqlConnection {
    param(
        [Parameter(Mandatory = $true)][string]$Server,
        [AllowEmptyString()][string]$Database,
        [AllowNull()][System.Management.Automation.PSCredential]$Credential,
        [bool]$Encrypt = $true
    )

    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder["Data Source"] = $Server
    if (-not [string]::IsNullOrWhiteSpace($Database)) {
        $builder["Initial Catalog"] = $Database
    }
    $builder["Application Name"] = "Copy-UrclecToLocalPERFECT"
    $builder["Connect Timeout"] = 30
    $builder["Encrypt"] = $Encrypt
    $builder["TrustServerCertificate"] = $true

    if ($null -eq $Credential) {
        $builder["Integrated Security"] = $true
    }

    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    if ($null -ne $Credential) {
        $password = $Credential.Password
        if (-not $password.IsReadOnly()) {
            $password.MakeReadOnly()
        }
        $connection.Credential = New-Object System.Data.SqlClient.SqlCredential($Credential.UserName, $password)
    }

    return $connection
}

function Invoke-SqlNonQuery {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$Connection,
        [AllowNull()][System.Data.SqlClient.SqlTransaction]$Transaction,
        [Parameter(Mandatory = $true)][string]$Sql,
        [int]$TimeoutSeconds = 0
    )

    $command = $Connection.CreateCommand()
    $command.CommandText = $Sql
    $command.CommandTimeout = $TimeoutSeconds
    if ($null -ne $Transaction) {
        $command.Transaction = $Transaction
    }

    try {
        [void]$command.ExecuteNonQuery()
    }
    finally {
        $command.Dispose()
    }
}

function Invoke-SqlScalar {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$Connection,
        [AllowNull()][System.Data.SqlClient.SqlTransaction]$Transaction,
        [Parameter(Mandatory = $true)][string]$Sql,
        [int]$TimeoutSeconds = 0
    )

    $command = $Connection.CreateCommand()
    $command.CommandText = $Sql
    $command.CommandTimeout = $TimeoutSeconds
    if ($null -ne $Transaction) {
        $command.Transaction = $Transaction
    }

    try {
        return $command.ExecuteScalar()
    }
    finally {
        $command.Dispose()
    }
}

function Get-SqlDataTable {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$Connection,
        [AllowNull()][System.Data.SqlClient.SqlTransaction]$Transaction,
        [Parameter(Mandatory = $true)][string]$Sql,
        [int]$TimeoutSeconds = 0
    )

    $command = $Connection.CreateCommand()
    $command.CommandText = $Sql
    $command.CommandTimeout = $TimeoutSeconds
    if ($null -ne $Transaction) {
        $command.Transaction = $Transaction
    }

    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $table = New-Object System.Data.DataTable

    try {
        [void]$adapter.Fill($table)
        return ,$table
    }
    finally {
        $adapter.Dispose()
        $command.Dispose()
    }
}

function Get-TypeDeclaration {
    param([Parameter(Mandatory = $true)]$Column)

    $typeName = [string](Get-FieldValue -Row $Column -Name "type_name")
    $typeSchema = [string](Get-FieldValue -Row $Column -Name "type_schema")
    $isUserDefined = [bool](Get-FieldValue -Row $Column -Name "is_user_defined")
    $isAssemblyType = [bool](Get-FieldValue -Row $Column -Name "is_assembly_type")
    $maxLength = Get-FieldValue -Row $Column -Name "max_length"
    $precision = Get-FieldValue -Row $Column -Name "precision"
    $scale = Get-FieldValue -Row $Column -Name "scale"

    if ($isUserDefined -or ($isAssemblyType -and $typeSchema -ne "sys")) {
        return "{0}.{1}" -f (Quote-SqlName $typeSchema), (Quote-SqlName $typeName)
    }

    switch ($typeName.ToLowerInvariant()) {
        { $_ -in @("varchar", "char", "varbinary", "binary") } {
            if ([int]$maxLength -eq -1) {
                return "{0}(max)" -f $typeName
            }
            return "{0}({1})" -f $typeName, [int]$maxLength
        }
        { $_ -in @("nvarchar", "nchar") } {
            if ([int]$maxLength -eq -1) {
                return "{0}(max)" -f $typeName
            }
            return "{0}({1})" -f $typeName, ([int]$maxLength / 2)
        }
        { $_ -in @("decimal", "numeric") } {
            return "{0}({1},{2})" -f $typeName, [int]$precision, [int]$scale
        }
        { $_ -in @("datetime2", "datetimeoffset", "time") } {
            return "{0}({1})" -f $typeName, [int]$scale
        }
        "float" {
            if ([int]$precision -gt 0 -and [int]$precision -ne 53) {
                return "float({0})" -f [int]$precision
            }
            return "float"
        }
        default {
            return $typeName
        }
    }
}

function New-ColumnDefinition {
    param([Parameter(Mandatory = $true)]$Column)

    $columnName = [string](Get-FieldValue -Row $Column -Name "column_name")
    $isComputed = [bool](Get-FieldValue -Row $Column -Name "is_computed")

    if ($isComputed) {
        $definition = [string](Get-FieldValue -Row $Column -Name "computed_definition")
        $persisted = ""
        if ([bool](Get-FieldValue -Row $Column -Name "is_persisted")) {
            $persisted = " PERSISTED"
        }
        return "{0} AS {1}{2}" -f (Quote-SqlName $columnName), $definition, $persisted
    }

    $pieces = New-Object System.Collections.Generic.List[string]
    $pieces.Add((Quote-SqlName $columnName))
    $pieces.Add((Get-TypeDeclaration -Column $Column))

    $collation = Get-FieldValue -Row $Column -Name "collation_name"
    if ($null -ne $collation) {
        $pieces.Add("COLLATE")
        $pieces.Add([string]$collation)
    }

    if ([bool](Get-FieldValue -Row $Column -Name "is_identity")) {
        $seed = Get-FieldValue -Row $Column -Name "seed_value"
        $increment = Get-FieldValue -Row $Column -Name "increment_value"
        $pieces.Add(("IDENTITY({0},{1})" -f $seed, $increment))
    }

    if ([bool](Get-FieldValue -Row $Column -Name "is_rowguidcol")) {
        $pieces.Add("ROWGUIDCOL")
    }

    if ([bool](Get-FieldValue -Row $Column -Name "is_sparse")) {
        $pieces.Add("SPARSE")
    }

    $defaultName = Get-FieldValue -Row $Column -Name "default_name"
    $defaultDefinition = Get-FieldValue -Row $Column -Name "default_definition"
    if ($null -ne $defaultDefinition) {
        if ($null -ne $defaultName) {
            $pieces.Add(("CONSTRAINT {0}" -f (Quote-SqlName ([string]$defaultName))))
        }
        $pieces.Add(("DEFAULT {0}" -f [string]$defaultDefinition))
    }

    if ([bool](Get-FieldValue -Row $Column -Name "is_nullable")) {
        $pieces.Add("NULL")
    }
    else {
        $pieces.Add("NOT NULL")
    }

    return ($pieces -join " ")
}

function Reset-LocalDatabase {
    param(
        [AllowNull()][System.Management.Automation.PSCredential]$LocalCredential
    )

    if (-not $Force) {
        $answer = Read-Host ("La base locale [{0}] sur [{1}] va etre supprimee puis recreee. Tape OUI pour continuer" -f $LocalDatabase, $LocalServer)
        if ($answer -ne "OUI") {
            throw "Operation annulee par l'utilisateur."
        }
    }

    $databaseName = Quote-SqlName $LocalDatabase
    $databaseLiteral = Escape-SqlLiteral $LocalDatabase
    $sql = @"
IF DB_ID(N'$databaseLiteral') IS NOT NULL
BEGIN
    ALTER DATABASE $databaseName SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE $databaseName;
END;

CREATE DATABASE $databaseName;
ALTER DATABASE $databaseName SET RECOVERY SIMPLE;
"@

    $connection = New-SqlConnection -Server $LocalServer -Database "master" -Credential $LocalCredential -Encrypt $true
    try {
        $connection.Open()
        Invoke-SqlNonQuery -Connection $connection -Transaction $null -Sql $sql -TimeoutSeconds 0
        Write-Log ("Base locale recreee: {0} sur {1}" -f $LocalDatabase, $LocalServer)
    }
    finally {
        $connection.Dispose()
    }
}

function Add-GroupedRow {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Map,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)]$Row
    )

    if (-not $Map.ContainsKey($Key)) {
        $Map[$Key] = New-Object System.Collections.ArrayList
    }

    [void]$Map[$Key].Add($Row)
}

function Build-MetadataMap {
    param(
        [Parameter(Mandatory = $true)][System.Data.DataTable]$Rows,
        [Parameter(Mandatory = $true)][string]$KeyColumn
    )

    $map = @{}
    foreach ($row in $Rows.Rows) {
        Add-GroupedRow -Map $map -Key ([string]$row[$KeyColumn]) -Row $row
    }
    return $map
}

function Invoke-PostCopyDdl {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$Connection,
        [Parameter(Mandatory = $true)][string]$Sql,
        [Parameter(Mandatory = $true)][string]$Label
    )

    try {
        Invoke-SqlNonQuery -Connection $Connection -Transaction $null -Sql $Sql -TimeoutSeconds 0
        Write-Log ("OK DDL post-copie: {0}" -f $Label)
    }
    catch {
        $warning = "Echec DDL post-copie ({0}): {1}" -f $Label, $_.Exception.Message
        [void]$script:DdlWarnings.Add($warning)
        Write-Log $warning "WARN"
        if ($StopOnPostCopyDdlError) {
            throw
        }
    }
}

function Register-UrclecDailyTask {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath
    )

    [void](Get-ManagedSqlCredential -Kind "serveur distant $RemoteServer/$RemoteDatabase" -UserName $RemoteUser -Path $RemoteCredentialPath -Save:$SaveRemoteCredential -MustSave)
    if ($UseLocalSqlLogin) {
        [void](Get-ManagedSqlCredential -Kind "serveur local $LocalServer" -UserName $LocalUser -Path $LocalCredentialPath -Save:$SaveLocalCredential -MustSave)
    }

    $taskTime = [datetime]::ParseExact($DailyAt, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
    $argumentParts = New-Object System.Collections.Generic.List[string]
    $argumentParts.Add("-NoProfile")
    $argumentParts.Add("-ExecutionPolicy Bypass")
    $argumentParts.Add(("-File ""{0}""" -f $ScriptPath))
    $argumentParts.Add(("-RemoteServer ""{0}""" -f $RemoteServer.Replace('"', '\"')))
    $argumentParts.Add(("-RemoteDatabase ""{0}""" -f $RemoteDatabase.Replace('"', '\"')))
    $argumentParts.Add(("-RemoteUser ""{0}""" -f $RemoteUser.Replace('"', '\"')))
    $argumentParts.Add(("-LocalServer ""{0}""" -f $LocalServer.Replace('"', '\"')))
    $argumentParts.Add(("-LocalDatabase ""{0}""" -f $LocalDatabase.Replace('"', '\"')))
    $argumentParts.Add(("-RemoteCredentialPath ""{0}""" -f $RemoteCredentialPath.Replace('"', '\"')))
    $argumentParts.Add("-Force")
    if ($UseLocalSqlLogin) {
        $argumentParts.Add("-UseLocalSqlLogin")
        $argumentParts.Add(("-LocalUser ""{0}""" -f $LocalUser.Replace('"', '\"')))
        $argumentParts.Add(("-LocalCredentialPath ""{0}""" -f $LocalCredentialPath.Replace('"', '\"')))
    }
    if ($SkipRowCountVerification) {
        $argumentParts.Add("-SkipRowCountVerification")
    }
    if ($SkipIndexesAndConstraints) {
        $argumentParts.Add("-SkipIndexesAndConstraints")
    }
    if ($StopOnPostCopyDdlError) {
        $argumentParts.Add("-StopOnPostCopyDdlError")
    }

    $actionParameters = @{
        Execute = "powershell.exe"
        Argument = ($argumentParts -join " ")
    }
    if ((Get-Command New-ScheduledTaskAction).Parameters.ContainsKey("WorkingDirectory")) {
        $actionParameters["WorkingDirectory"] = (Split-Path -Parent $ScriptPath)
    }

    $action = New-ScheduledTaskAction @actionParameters
    $trigger = New-ScheduledTaskTrigger -Daily -At $taskTime
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Copie quotidienne SQL Server URCLEC vers la base locale PERFECT." -Force | Out-Null
    Write-Log ("Tache planifiee enregistree: {0} chaque jour a {1}. Elle s'execute quand la session Windows est ouverte." -f $TaskName, $DailyAt)
}

function Get-CreateTableSql {
    param(
        [Parameter(Mandatory = $true)]$TableRow,
        [Parameter(Mandatory = $true)][hashtable]$ColumnsByObjectId
    )

    $objectId = [string]$TableRow["object_id"]
    $schemaName = [string]$TableRow["schema_name"]
    $tableName = [string]$TableRow["table_name"]

    if (-not $ColumnsByObjectId.ContainsKey($objectId)) {
        throw "Aucune colonne trouvee pour $schemaName.$tableName"
    }

    $columnLines = New-Object System.Collections.Generic.List[string]
    foreach ($column in ($ColumnsByObjectId[$objectId] | Sort-Object { [int]$_["column_id"] })) {
        $columnLines.Add(("    {0}" -f (New-ColumnDefinition -Column $column)))
    }

    return "CREATE TABLE {0}.{1} (`r`n{2}`r`n);" -f (Quote-SqlName $schemaName), (Quote-SqlName $tableName), ($columnLines -join ",`r`n")
}

function Get-CreateAliasTypeSql {
    param([Parameter(Mandatory = $true)]$TypeRow)

    $schemaName = [string]$TypeRow["schema_name"]
    $typeName = [string]$TypeRow["type_name"]
    $baseType = [string]$TypeRow["base_type_name"]
    $maxLength = Get-FieldValue -Row $TypeRow -Name "max_length"
    $precision = Get-FieldValue -Row $TypeRow -Name "precision"
    $scale = Get-FieldValue -Row $TypeRow -Name "scale"

    $fakeColumn = New-Object System.Data.DataTable
    [void]$fakeColumn.Columns.Add("type_name", [string])
    [void]$fakeColumn.Columns.Add("type_schema", [string])
    [void]$fakeColumn.Columns.Add("is_user_defined", [bool])
    [void]$fakeColumn.Columns.Add("is_assembly_type", [bool])
    [void]$fakeColumn.Columns.Add("max_length", [int])
    [void]$fakeColumn.Columns.Add("precision", [int])
    [void]$fakeColumn.Columns.Add("scale", [int])

    $row = $fakeColumn.NewRow()
    $row["type_name"] = $baseType
    $row["type_schema"] = "sys"
    $row["is_user_defined"] = $false
    $row["is_assembly_type"] = $false
    $row["max_length"] = [int]$maxLength
    $row["precision"] = [int]$precision
    $row["scale"] = [int]$scale
    [void]$fakeColumn.Rows.Add($row)

    $nullable = "NULL"
    if (-not [bool]$TypeRow["is_nullable"]) {
        $nullable = "NOT NULL"
    }

    return "CREATE TYPE {0}.{1} FROM {2} {3};" -f (Quote-SqlName $schemaName), (Quote-SqlName $typeName), (Get-TypeDeclaration -Column $row), $nullable
}

function Copy-TableData {
    param(
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$SourceConnection,
        [AllowNull()][System.Data.SqlClient.SqlTransaction]$SourceTransaction,
        [Parameter(Mandatory = $true)][System.Data.SqlClient.SqlConnection]$DestinationConnection,
        [Parameter(Mandatory = $true)]$TableRow,
        [Parameter(Mandatory = $true)][hashtable]$InsertColumnsByObjectId
    )

    $objectId = [string]$TableRow["object_id"]
    $schemaName = [string]$TableRow["schema_name"]
    $tableName = [string]$TableRow["table_name"]
    $qualifiedName = "{0}.{1}" -f (Quote-SqlName $schemaName), (Quote-SqlName $tableName)

    if (-not $InsertColumnsByObjectId.ContainsKey($objectId) -or $InsertColumnsByObjectId[$objectId].Count -eq 0) {
        Write-Log ("Table sans colonne copiable, ignoree pour les donnees: {0}.{1}" -f $schemaName, $tableName) "WARN"
        return @{ SourceCount = 0; DestinationCount = 0 }
    }

    $columns = $InsertColumnsByObjectId[$objectId] | Sort-Object { [int]$_["column_id"] }
    $columnList = ($columns | ForEach-Object { Quote-SqlName ([string]$_["column_name"]) }) -join ", "

    $sourceCount = $null
    if (-not $SkipRowCountVerification) {
        $sourceCount = Invoke-SqlScalar -Connection $SourceConnection -Transaction $SourceTransaction -Sql ("SELECT COUNT_BIG(1) FROM {0};" -f $qualifiedName) -TimeoutSeconds 0
    }

    $progressActivity = "Copie SQL {0} vers {1}" -f $RemoteDatabase, $LocalDatabase
    $progressTableName = "{0}.{1}" -f $schemaName, $tableName
    if (-not $NoProgress) {
        if ($null -ne $sourceCount) {
            Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: 0 / {1:N0} lignes" -f $progressTableName, [int64]$sourceCount) -PercentComplete 0
        }
        else {
            Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: copie en cours" -f $progressTableName) -PercentComplete 0
        }
    }

    $command = $SourceConnection.CreateCommand()
    $command.CommandText = "SELECT $columnList FROM $qualifiedName;"
    $command.CommandTimeout = 0
    if ($null -ne $SourceTransaction) {
        $command.Transaction = $SourceTransaction
    }

    $reader = $null
    $bulkCopy = $null
    $progressHandler = $null
    try {
        $reader = $command.ExecuteReader([System.Data.CommandBehavior]::SequentialAccess)
        $options = [System.Data.SqlClient.SqlBulkCopyOptions]::KeepIdentity -bor [System.Data.SqlClient.SqlBulkCopyOptions]::KeepNulls -bor [System.Data.SqlClient.SqlBulkCopyOptions]::TableLock
        $bulkCopy = New-Object System.Data.SqlClient.SqlBulkCopy($DestinationConnection, $options, $null)
        $bulkCopy.DestinationTableName = $qualifiedName
        $bulkCopy.BatchSize = $BulkCopyBatchSize
        $bulkCopy.BulkCopyTimeout = $BulkCopyTimeoutSeconds

        if (-not $NoProgress) {
            $notifyAfter = $BulkCopyBatchSize
            if ($notifyAfter -le 0) {
                $notifyAfter = 5000
            }
            $bulkCopy.NotifyAfter = [Math]::Max(1, [Math]::Min([int]$notifyAfter, 10000))
            $progressHandler = [System.Data.SqlClient.SqlRowsCopiedEventHandler]{
                param($Sender, $EventArgs)

                if ($null -ne $sourceCount -and [int64]$sourceCount -gt 0) {
                    $percent = [Math]::Min(99, [int](([double]$EventArgs.RowsCopied / [double]$sourceCount) * 100))
                    Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: {1:N0} / {2:N0} lignes" -f $progressTableName, [int64]$EventArgs.RowsCopied, [int64]$sourceCount) -PercentComplete $percent
                }
                else {
                    Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: {1:N0} lignes copiees" -f $progressTableName, [int64]$EventArgs.RowsCopied) -PercentComplete 0
                }
            }
            $bulkCopy.add_SqlRowsCopied($progressHandler)
        }

        foreach ($column in $columns) {
            $name = [string]$column["column_name"]
            [void]$bulkCopy.ColumnMappings.Add($name, $name)
        }

        $bulkCopy.WriteToServer($reader)
        if (-not $NoProgress) {
            if ($null -ne $sourceCount) {
                Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: {1:N0} / {1:N0} lignes" -f $progressTableName, [int64]$sourceCount) -PercentComplete 100
            }
            else {
                Write-Progress -Id 2 -ParentId 1 -Activity $progressActivity -Status ("{0}: copie terminee" -f $progressTableName) -PercentComplete 100
            }
        }
    }
    finally {
        if ($null -ne $bulkCopy -and $null -ne $progressHandler) {
            $bulkCopy.remove_SqlRowsCopied($progressHandler)
        }
        if (-not $NoProgress) {
            Write-Progress -Id 2 -Activity $progressActivity -Completed
        }
        if ($null -ne $reader) {
            $reader.Close()
            $reader.Dispose()
        }
        if ($null -ne $bulkCopy) {
            $bulkCopy.Close()
        }
        $command.Dispose()
    }

    $destinationCount = $null
    if (-not $SkipRowCountVerification) {
        $destinationCount = Invoke-SqlScalar -Connection $DestinationConnection -Transaction $null -Sql ("SELECT COUNT_BIG(1) FROM {0};" -f $qualifiedName) -TimeoutSeconds 0
    }

    return @{ SourceCount = $sourceCount; DestinationCount = $destinationCount }
}

function Start-Copy {
    $script:RunStatus = "RUNNING"
    Write-Log ("Debut copie: {0}/{1} -> {2}/{3}" -f $RemoteServer, $RemoteDatabase, $LocalServer, $LocalDatabase)

    $remoteCredential = Get-ManagedSqlCredential -Kind "serveur distant $RemoteServer/$RemoteDatabase" -UserName $RemoteUser -Path $RemoteCredentialPath -Save:$SaveRemoteCredential
    $localCredential = $null
    if ($UseLocalSqlLogin) {
        $localCredential = Get-ManagedSqlCredential -Kind "serveur local $LocalServer" -UserName $LocalUser -Path $LocalCredentialPath -Save:$SaveLocalCredential
    }

    Reset-LocalDatabase -LocalCredential $localCredential

    $sourceConnection = New-SqlConnection -Server $RemoteServer -Database $RemoteDatabase -Credential $remoteCredential -Encrypt $true
    $destinationConnection = New-SqlConnection -Server $LocalServer -Database $LocalDatabase -Credential $localCredential -Encrypt $true
    $sourceTransaction = $null
    $snapshotUsed = $false

    try {
        $sourceConnection.Open()
        $destinationConnection.Open()

        if ($UseSnapshotIfAvailable) {
            $snapshotState = Invoke-SqlScalar -Connection $sourceConnection -Transaction $null -Sql "SELECT snapshot_isolation_state_desc FROM sys.databases WHERE name = DB_NAME();" -TimeoutSeconds 30
            if ([string]$snapshotState -eq "ON") {
                $sourceTransaction = $sourceConnection.BeginTransaction([System.Data.IsolationLevel]::Snapshot)
                $snapshotUsed = $true
                $script:SnapshotMode = "SNAPSHOT"
                Write-Log "Lecture distante en isolation SNAPSHOT."
            }
            else {
                $script:SnapshotMode = "READ COMMITTED"
                Write-Log ("Isolation SNAPSHOT non active sur la base distante ({0}); copie en READ COMMITTED." -f $snapshotState) "WARN"
            }
        }
        else {
            $script:SnapshotMode = "READ COMMITTED"
        }

        $excludedTablesT = Get-ExcludedTablePredicate -Alias "t"
        $excludedTablesPt = Get-ExcludedTablePredicate -Alias "pt"
        $excludedTablesRt = Get-ExcludedTablePredicate -Alias "rt"
        if ($ExcludedTables.Count -gt 0) {
            Write-Log ("Tables exclues de la copie: {0}" -f (($ExcludedTables | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ", "))
        }

        $schemaRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT DISTINCT s.name AS schema_name
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
ORDER BY s.name;
"@

        $tableRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT t.object_id, s.name AS schema_name, t.name AS table_name, t.temporal_type
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
ORDER BY s.name, t.name;
"@

        if ($tableRows.Rows.Count -eq 0) {
            throw "Aucune table utilisateur trouvee dans la base distante."
        }

        $aliasTypeRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    SCHEMA_NAME(t.schema_id) AS schema_name,
    t.name AS type_name,
    base.name AS base_type_name,
    t.max_length,
    t.precision,
    t.scale,
    t.is_nullable
FROM sys.types AS t
INNER JOIN sys.types AS base
    ON base.user_type_id = base.system_type_id
    AND base.system_type_id = t.system_type_id
WHERE t.is_user_defined = 1
  AND t.is_table_type = 0
  AND t.is_assembly_type = 0
ORDER BY SCHEMA_NAME(t.schema_id), t.name;
"@

        $columnRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    t.object_id,
    s.name AS schema_name,
    t.name AS table_name,
    c.column_id,
    c.name AS column_name,
    typ.name AS type_name,
    SCHEMA_NAME(typ.schema_id) AS type_schema,
    typ.is_user_defined,
    typ.is_assembly_type,
    c.system_type_id,
    c.max_length,
    c.precision,
    c.scale,
    c.collation_name,
    c.is_nullable,
    c.is_identity,
    CONVERT(varchar(50), ident.seed_value) AS seed_value,
    CONVERT(varchar(50), ident.increment_value) AS increment_value,
    c.is_computed,
    cc.definition AS computed_definition,
    ISNULL(cc.is_persisted, 0) AS is_persisted,
    dc.name AS default_name,
    dc.definition AS default_definition,
    c.is_rowguidcol,
    c.is_sparse,
    c.generated_always_type
FROM sys.tables AS t
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.columns AS c ON c.object_id = t.object_id
INNER JOIN sys.types AS typ ON typ.user_type_id = c.user_type_id
LEFT JOIN sys.identity_columns AS ident ON ident.object_id = c.object_id AND ident.column_id = c.column_id
LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints AS dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
ORDER BY s.name, t.name, c.column_id;
"@

        $insertColumnRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    t.object_id,
    c.column_id,
    c.name AS column_name
FROM sys.tables AS t
INNER JOIN sys.columns AS c ON c.object_id = t.object_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
  AND c.is_computed = 0
  AND c.system_type_id <> 189
  AND c.generated_always_type = 0
ORDER BY t.object_id, c.column_id;
"@

        $columnsByObjectId = Build-MetadataMap -Rows $columnRows -KeyColumn "object_id"
        $insertColumnsByObjectId = Build-MetadataMap -Rows $insertColumnRows -KeyColumn "object_id"

        Write-Log ("Schemas detectes: {0}; tables detectees: {1}" -f $schemaRows.Rows.Count, $tableRows.Rows.Count)

        foreach ($schema in $schemaRows.Rows) {
            $schemaName = [string]$schema["schema_name"]
            if ($schemaName -eq "dbo") {
                continue
            }
            Invoke-SqlNonQuery -Connection $destinationConnection -Transaction $null -Sql ("CREATE SCHEMA {0};" -f (Quote-SqlName $schemaName)) -TimeoutSeconds 0
        }

        foreach ($typeRow in $aliasTypeRows.Rows) {
            Invoke-SqlNonQuery -Connection $destinationConnection -Transaction $null -Sql (Get-CreateAliasTypeSql -TypeRow $typeRow) -TimeoutSeconds 0
        }

        foreach ($table in $tableRows.Rows) {
            $schemaName = [string]$table["schema_name"]
            $tableName = [string]$table["table_name"]
            Invoke-SqlNonQuery -Connection $destinationConnection -Transaction $null -Sql (Get-CreateTableSql -TableRow $table -ColumnsByObjectId $columnsByObjectId) -TimeoutSeconds 0
            Write-Log ("Table creee: {0}.{1}" -f $schemaName, $tableName)
        }

        $mismatches = New-Object System.Collections.Generic.List[string]
        $copiedTables = 0
        $totalTables = [int]$tableRows.Rows.Count
        $progressActivity = "Copie SQL {0} vers {1}" -f $RemoteDatabase, $LocalDatabase
        if (-not $NoProgress) {
            Write-Progress -Id 1 -Activity $progressActivity -Status ("0 / {0} tables copiees" -f $totalTables) -PercentComplete 0
        }

        foreach ($table in $tableRows.Rows) {
            $schemaName = [string]$table["schema_name"]
            $tableName = [string]$table["table_name"]
            $tableNumber = $copiedTables + 1
            if (-not $NoProgress) {
                $tablePercent = [int](((($tableNumber - 1) * 100) / [Math]::Max(1, $totalTables)))
                Write-Progress -Id 1 -Activity $progressActivity -Status ("Table {0}/{1}: {2}.{3}" -f $tableNumber, $totalTables, $schemaName, $tableName) -PercentComplete $tablePercent
            }
            Write-Log ("Copie donnees: {0}.{1}" -f $schemaName, $tableName)
            $counts = Copy-TableData -SourceConnection $sourceConnection -SourceTransaction $sourceTransaction -DestinationConnection $destinationConnection -TableRow $table -InsertColumnsByObjectId $insertColumnsByObjectId
            $copiedTables++
            $script:CopiedTables = $copiedTables
            $tableStatus = "OK"

            if (-not $SkipRowCountVerification) {
                Write-Log ("Lignes {0}.{1}: source={2}; local={3}" -f $schemaName, $tableName, $counts.SourceCount, $counts.DestinationCount)
                if ([string]$counts.SourceCount -ne [string]$counts.DestinationCount) {
                    $tableStatus = "ECART"
                    $mismatches.Add(("{0}.{1}: source={2}; local={3}" -f $schemaName, $tableName, $counts.SourceCount, $counts.DestinationCount))
                }
                $script:TotalSourceRows += [int64]$counts.SourceCount
                $script:TotalDestinationRows += [int64]$counts.DestinationCount
            }

            [void]$script:TableReports.Add([pscustomobject]@{
                Schema = $schemaName
                Table = $tableName
                SourceRows = $counts.SourceCount
                LocalRows = $counts.DestinationCount
                Status = $tableStatus
            })

            if (-not $NoProgress) {
                $tablePercent = [int](($copiedTables * 100) / [Math]::Max(1, $totalTables))
                Write-Progress -Id 1 -Activity $progressActivity -Status ("Tables copiees: {0}/{1}" -f $copiedTables, $totalTables) -PercentComplete $tablePercent
            }
        }

        if (-not $SkipIndexesAndConstraints) {
            if (-not $NoProgress) {
                Write-Progress -Id 1 -Activity $progressActivity -Status "Creation des index et contraintes" -PercentComplete 100
            }
            $keyRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    kc.parent_object_id,
    kc.name AS constraint_name,
    kc.type_desc AS constraint_type,
    i.type_desc AS index_type,
    s.name AS schema_name,
    t.name AS table_name,
    ic.key_ordinal,
    c.name AS column_name,
    ic.is_descending_key
FROM sys.key_constraints AS kc
INNER JOIN sys.tables AS t ON t.object_id = kc.parent_object_id
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
ORDER BY kc.parent_object_id, kc.name, ic.key_ordinal;
"@

            $keyGroups = @{}
            foreach ($row in $keyRows.Rows) {
                Add-GroupedRow -Map $keyGroups -Key ("{0}|{1}" -f $row["parent_object_id"], $row["constraint_name"]) -Row $row
            }

            foreach ($key in $keyGroups.Keys) {
                $rows = @($keyGroups[$key] | Sort-Object { [int]$_["key_ordinal"] })
                $first = $rows[0]
                $columns = ($rows | ForEach-Object {
                    $direction = "ASC"
                    if ([bool]$_["is_descending_key"]) {
                        $direction = "DESC"
                    }
                    "{0} {1}" -f (Quote-SqlName ([string]$_["column_name"])), $direction
                }) -join ", "

                $constraintKind = "UNIQUE"
                if ([string]$first["constraint_type"] -eq "PRIMARY_KEY_CONSTRAINT") {
                    $constraintKind = "PRIMARY KEY"
                }
                $indexKind = "NONCLUSTERED"
                if ([string]$first["index_type"] -eq "CLUSTERED") {
                    $indexKind = "CLUSTERED"
                }

                $sql = "ALTER TABLE {0}.{1} ADD CONSTRAINT {2} {3} {4} ({5});" -f (Quote-SqlName ([string]$first["schema_name"])), (Quote-SqlName ([string]$first["table_name"])), (Quote-SqlName ([string]$first["constraint_name"])), $constraintKind, $indexKind, $columns
                Invoke-PostCopyDdl -Connection $destinationConnection -Sql $sql -Label ([string]$first["constraint_name"])
            }

            $indexRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    i.object_id,
    i.index_id,
    i.name AS index_name,
    i.is_unique,
    i.type_desc,
    i.has_filter,
    i.filter_definition,
    s.name AS schema_name,
    t.name AS table_name,
    ic.index_column_id,
    ic.key_ordinal,
    ic.is_included_column,
    ic.is_descending_key,
    c.name AS column_name
FROM sys.indexes AS i
INNER JOIN sys.tables AS t ON t.object_id = i.object_id
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
  AND i.name IS NOT NULL
  AND i.is_primary_key = 0
  AND i.is_unique_constraint = 0
  AND i.type IN (1, 2)
ORDER BY i.object_id, i.index_id, ic.index_column_id;
"@

            $indexGroups = @{}
            foreach ($row in $indexRows.Rows) {
                Add-GroupedRow -Map $indexGroups -Key ("{0}|{1}" -f $row["object_id"], $row["index_id"]) -Row $row
            }

            foreach ($key in $indexGroups.Keys) {
                $rows = @($indexGroups[$key] | Sort-Object { [int]$_["index_column_id"] })
                $first = $rows[0]
                $keyColumns = @($rows | Where-Object { [int]$_["key_ordinal"] -gt 0 -and -not [bool]$_["is_included_column"] } | Sort-Object { [int]$_["key_ordinal"] })
                if ($keyColumns.Count -eq 0) {
                    continue
                }

                $columnSql = ($keyColumns | ForEach-Object {
                    $direction = "ASC"
                    if ([bool]$_["is_descending_key"]) {
                        $direction = "DESC"
                    }
                    "{0} {1}" -f (Quote-SqlName ([string]$_["column_name"])), $direction
                }) -join ", "

                $includeColumns = @($rows | Where-Object { [bool]$_["is_included_column"] } | Sort-Object { [int]$_["index_column_id"] })
                $includeSql = ""
                if ($includeColumns.Count -gt 0) {
                    $includeSql = " INCLUDE ({0})" -f (($includeColumns | ForEach-Object { Quote-SqlName ([string]$_["column_name"]) }) -join ", ")
                }

                $uniqueSql = ""
                if ([bool]$first["is_unique"]) {
                    $uniqueSql = "UNIQUE "
                }
                $indexKind = "NONCLUSTERED"
                if ([string]$first["type_desc"] -eq "CLUSTERED") {
                    $indexKind = "CLUSTERED"
                }
                $filterSql = ""
                if ([bool]$first["has_filter"]) {
                    $filterSql = " WHERE {0}" -f [string]$first["filter_definition"]
                }

                $sql = "CREATE {0}{1} INDEX {2} ON {3}.{4} ({5}){6}{7};" -f $uniqueSql, $indexKind, (Quote-SqlName ([string]$first["index_name"])), (Quote-SqlName ([string]$first["schema_name"])), (Quote-SqlName ([string]$first["table_name"])), $columnSql, $includeSql, $filterSql
                Invoke-PostCopyDdl -Connection $destinationConnection -Sql $sql -Label ([string]$first["index_name"])
            }

            $checkRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    cc.name AS constraint_name,
    s.name AS schema_name,
    t.name AS table_name,
    cc.definition,
    cc.is_disabled,
    cc.is_not_trusted
FROM sys.check_constraints AS cc
INNER JOIN sys.tables AS t ON t.object_id = cc.parent_object_id
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
$excludedTablesT
ORDER BY s.name, t.name, cc.name;
"@

            foreach ($row in $checkRows.Rows) {
                $withCheck = "WITH CHECK"
                if ([bool]$row["is_not_trusted"] -or [bool]$row["is_disabled"]) {
                    $withCheck = "WITH NOCHECK"
                }
                $sql = "ALTER TABLE {0}.{1} {2} ADD CONSTRAINT {3} CHECK {4};" -f (Quote-SqlName ([string]$row["schema_name"])), (Quote-SqlName ([string]$row["table_name"])), $withCheck, (Quote-SqlName ([string]$row["constraint_name"])), [string]$row["definition"]
                Invoke-PostCopyDdl -Connection $destinationConnection -Sql $sql -Label ([string]$row["constraint_name"])
                if ([bool]$row["is_disabled"]) {
                    Invoke-PostCopyDdl -Connection $destinationConnection -Sql ("ALTER TABLE {0}.{1} NOCHECK CONSTRAINT {2};" -f (Quote-SqlName ([string]$row["schema_name"])), (Quote-SqlName ([string]$row["table_name"])), (Quote-SqlName ([string]$row["constraint_name"]))) -Label ([string]$row["constraint_name"])
                }
            }

            $foreignKeyRows = Get-SqlDataTable -Connection $sourceConnection -Transaction $sourceTransaction -Sql @"
SELECT
    fk.object_id,
    fk.name AS constraint_name,
    ps.name AS parent_schema,
    pt.name AS parent_table,
    rs.name AS referenced_schema,
    rt.name AS referenced_table,
    fk.delete_referential_action_desc,
    fk.update_referential_action_desc,
    fk.is_not_for_replication,
    fk.is_disabled,
    fk.is_not_trusted,
    fkc.constraint_column_id,
    pc.name AS parent_column,
    rc.name AS referenced_column
FROM sys.foreign_keys AS fk
INNER JOIN sys.tables AS pt ON pt.object_id = fk.parent_object_id
INNER JOIN sys.schemas AS ps ON ps.schema_id = pt.schema_id
INNER JOIN sys.tables AS rt ON rt.object_id = fk.referenced_object_id
INNER JOIN sys.schemas AS rs ON rs.schema_id = rt.schema_id
INNER JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
INNER JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
INNER JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE pt.is_ms_shipped = 0
$excludedTablesPt
$excludedTablesRt
ORDER BY fk.object_id, fkc.constraint_column_id;
"@

            $fkGroups = @{}
            foreach ($row in $foreignKeyRows.Rows) {
                Add-GroupedRow -Map $fkGroups -Key ([string]$row["object_id"]) -Row $row
            }

            foreach ($key in $fkGroups.Keys) {
                $rows = @($fkGroups[$key] | Sort-Object { [int]$_["constraint_column_id"] })
                $first = $rows[0]
                $parentColumns = ($rows | ForEach-Object { Quote-SqlName ([string]$_["parent_column"]) }) -join ", "
                $referencedColumns = ($rows | ForEach-Object { Quote-SqlName ([string]$_["referenced_column"]) }) -join ", "

                $withCheck = "WITH CHECK"
                if ([bool]$first["is_not_trusted"] -or [bool]$first["is_disabled"]) {
                    $withCheck = "WITH NOCHECK"
                }

                $actions = New-Object System.Collections.Generic.List[string]
                if ([string]$first["delete_referential_action_desc"] -ne "NO_ACTION") {
                    $actions.Add(("ON DELETE {0}" -f ([string]$first["delete_referential_action_desc"]).Replace("_", " ")))
                }
                if ([string]$first["update_referential_action_desc"] -ne "NO_ACTION") {
                    $actions.Add(("ON UPDATE {0}" -f ([string]$first["update_referential_action_desc"]).Replace("_", " ")))
                }
                if ([bool]$first["is_not_for_replication"]) {
                    $actions.Add("NOT FOR REPLICATION")
                }

                $sql = "ALTER TABLE {0}.{1} {2} ADD CONSTRAINT {3} FOREIGN KEY ({4}) REFERENCES {5}.{6} ({7}) {8};" -f (Quote-SqlName ([string]$first["parent_schema"])), (Quote-SqlName ([string]$first["parent_table"])), $withCheck, (Quote-SqlName ([string]$first["constraint_name"])), $parentColumns, (Quote-SqlName ([string]$first["referenced_schema"])), (Quote-SqlName ([string]$first["referenced_table"])), $referencedColumns, ($actions -join " ")
                Invoke-PostCopyDdl -Connection $destinationConnection -Sql $sql -Label ([string]$first["constraint_name"])
                if ([bool]$first["is_disabled"]) {
                    Invoke-PostCopyDdl -Connection $destinationConnection -Sql ("ALTER TABLE {0}.{1} NOCHECK CONSTRAINT {2};" -f (Quote-SqlName ([string]$first["parent_schema"])), (Quote-SqlName ([string]$first["parent_table"])), (Quote-SqlName ([string]$first["constraint_name"]))) -Label ([string]$first["constraint_name"])
                }
            }
        }

        if ($snapshotUsed -and $null -ne $sourceTransaction) {
            $sourceTransaction.Commit()
            $sourceTransaction.Dispose()
            $sourceTransaction = $null
        }

        if ($mismatches.Count -gt 0) {
            throw ("Copie terminee avec ecarts de comptage: {0}" -f ($mismatches -join " | "))
        }

        if ($script:DdlWarnings.Count -gt 0) {
            $script:RunStatus = "SUCCESS_WITH_WARNINGS"
        }
        else {
            $script:RunStatus = "SUCCESS"
        }
        Write-Log ("Copie terminee avec succes. Tables copiees: {0}. Log: {1}" -f $copiedTables, $script:LogPath)
    }
    catch {
        $script:RunStatus = "FAILED"
        $script:RunError = $_.Exception.Message
        if ($null -ne $sourceTransaction) {
            try {
                $sourceTransaction.Rollback()
            }
            catch {
                Write-Log ("Rollback source impossible: {0}" -f $_.Exception.Message) "WARN"
            }
        }
        Write-Log $_.Exception.Message "ERROR"
        throw
    }
    finally {
        if ($null -ne $sourceTransaction) {
            $sourceTransaction.Dispose()
        }
        $sourceConnection.Dispose()
        $destinationConnection.Dispose()
        if (-not $NoProgress) {
            $progressActivity = "Copie SQL {0} vers {1}" -f $RemoteDatabase, $LocalDatabase
            Write-Progress -Id 2 -Activity $progressActivity -Completed
            Write-Progress -Id 1 -Activity $progressActivity -Completed
        }
        try {
            Write-CopyReport
        }
        catch {
            Write-Log ("Rapport non genere: {0}" -f $_.Exception.Message) "WARN"
        }
    }
}

try {
    Write-Log ("Fichier log: {0}" -f $script:LogPath)

    if ($SetRemoteCredentialOnly) {
        [void](Get-ManagedSqlCredential -Kind "serveur distant $RemoteServer/$RemoteDatabase" -UserName $RemoteUser -Path $RemoteCredentialPath -Save -MustSave)
        Write-Log "Credential distant enregistre. Aucune copie lancee."
        return
    }

    if ($SetLocalCredentialOnly) {
        [void](Get-ManagedSqlCredential -Kind "serveur local $LocalServer" -UserName $LocalUser -Path $LocalCredentialPath -Save -MustSave)
        Write-Log "Credential local enregistre. Aucune copie lancee."
        return
    }

    if ($RegisterDailyTask) {
        Register-UrclecDailyTask -ScriptPath $PSCommandPath
        if (-not $RunNow) {
            return
        }
    }

    Start-Copy
}
catch {
    Write-Log ("Arret sur erreur: {0}" -f $_.Exception.Message) "ERROR"
    exit 1
}

