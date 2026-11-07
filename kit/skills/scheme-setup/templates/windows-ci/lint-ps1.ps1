<#
.SYNOPSIS
  Parses and lints PowerShell scripts before they reach a Windows runner.

.DESCRIPTION
  Citadel #370, from Peek Auras' CI retro: a .ps1 a minion writes on Linux is first run on a Windows runner, so a typo
  costs a 12 to 25 minute CI round trip, or worse, a step that throws and gets read as "skipped". For each file this
  reports:
    - syntax errors (PowerShell's own parser);
    - type names that exist nowhere: not in this PowerShell, not in PSScriptAnalyzer's Windows PowerShell 5.1 or
      PowerShell 7 profiles for Windows, and not defined in the file (a class or enum, or C# given to Add-Type);
    - a static member ([Type]::Name) that a type known to those profiles doesn't have on Windows, such as a
      misspelled enum value;
    - PSScriptAnalyzer's default rules at Warning and Error, plus its syntax, command and type compatibility rules
      for Windows PowerShell 5.1 and PowerShell 7 on Windows.
  It can't see what only fails at run time: a value a type refuses (Peek's CopyPixelOperation throw), a Win32 call
  Windows denies, a member of an object whose type is only known then.

  Runs on Linux (pwsh) and on Windows (powershell.exe 5.1 or pwsh). Needs the PSScriptAnalyzer module:
    Install-Module PSScriptAnalyzer -Scope CurrentUser
  Exit 0: clean. 1: findings, one per line as path:line:column: rule: message. 2: it couldn't run.

.EXAMPLE
  pwsh -NoProfile -File lint-ps1.ps1 tools/*.ps1
#>
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Path)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$pssa = Get-Module -ListAvailable PSScriptAnalyzer | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pssa) {
  Write-Output 'lint-ps1: the PSScriptAnalyzer module is missing: Install-Module PSScriptAnalyzer -Scope CurrentUser'
  exit 2
}
Import-Module $pssa.Path

# Windows Server 2019's profiles, the newest PSScriptAnalyzer ships: Windows PowerShell 5.1 and PowerShell 7.
$profiles = @(
  'win-8_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'
  'win-8_x64_10.0.17763.0_7.0.0_x64_3.1.2_core'
)
# The compatibility rules read every profile in their folder, which takes 30 s; a folder with only these two takes 4.
# A plain string: PSScriptAnalyzer drops a rule whose setting is a PowerShell-wrapped one, such as Join-Path gives, without a word.
$profileDir = [IO.Path]::Combine([IO.Path]::GetTempPath(), "lint-ps1-$PID")
$null = New-Item -ItemType Directory -Force -Path $profileDir
foreach ($id in $profiles) { Copy-Item (Join-Path $pssa.ModuleBase "compatibility_profiles/$id.json") $profileDir }
$settings = @{
  Severity = @('Error', 'Warning', 'ParseError')
  # Write-Host is how these scripts talk to the person running them, in colour. A script's parameters used only inside its
  # functions read as unused, and a small Stop-With helper needs no -WhatIf: noise, not bugs.
  ExcludeRules = @('PSAvoidUsingWriteHost', 'PSReviewUnusedParameter', 'PSUseShouldProcessForStateChangingFunctions')
  Rules = @{
    PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @('5.1', '7.0') }
    PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = $profiles; ProfileDirPath = $profileDir }
    PSUseCompatibleTypes = @{ Enable = $true; TargetProfiles = $profiles; ProfileDirPath = $profileDir }
  }
}

# The profiles' types, by full name, from PSScriptAnalyzer's own loader (ConvertFrom-Json can't read them in 5.1).
$dll = if ($PSVersionTable.PSVersion.Major -ge 6) { 'PSv7/Microsoft.PowerShell.CrossCompatibility.dll' } else { 'Microsoft.PowerShell.CrossCompatibility.dll' }
Add-Type -Path (Join-Path $pssa.ModuleBase $dll)
$serializer = ('Microsoft.PowerShell.CrossCompatibility.Retrieval.JsonProfileSerializer' -as [type])::Create()
$known = New-Object 'System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[object]]' ([StringComparer]::OrdinalIgnoreCase)
$accelerators = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($id in $profiles) {
  $types = $serializer.DeserializeFromFile((Join-Path $pssa.ModuleBase "compatibility_profiles/$id.json")).Runtime.Types
  foreach ($a in $types.TypeAccelerators.Keys) { $null = $accelerators.Add($a) }
  foreach ($assembly in $types.Assemblies.Values) {
    if (-not $assembly.Types) { continue }
    foreach ($ns in $assembly.Types.GetEnumerator()) {
      foreach ($t in $ns.Value.GetEnumerator()) {
        $full = if ($ns.Key) { "$($ns.Key).$($t.Key)" } else { $t.Key }
        if (-not $known.ContainsKey($full)) { $known[$full] = New-Object 'System.Collections.Generic.List[object]' }
        $known[$full].Add($t.Value)
      }
    }
  }
}

$findings = New-Object 'System.Collections.Generic.List[string]'
function Add-Finding($File, $Extent, [string]$Rule, [string]$Message) {
  $findings.Add("${File}:$($Extent.StartLineNumber):$($Extent.StartColumnNumber): ${Rule}: $Message")
}

# The profile entries a written type name means, as PowerShell looks it up: an accelerator, the name, System. plus
# it, or a `using namespace` plus it. $null when none (a type the file makes, or one this PowerShell has, still counts).
function Find-Type([string]$Name, [string[]]$Namespaces) {
  foreach ($candidate in @($Name, "System.$Name") + @($Namespaces | ForEach-Object { "$_.$Name" })) {
    if ($known.ContainsKey($candidate)) { return , $known[$candidate] }
  }
  return $null
}

$files = @(foreach ($p in $Path) { Resolve-Path -Path $p | ForEach-Object { $_.ProviderPath } })
try {
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  foreach ($e in $errors) { Add-Finding $file $e.Extent 'ParseError' $e.Message }
  if ($errors) { continue }

  $namespaces = @($ast.UsingStatements | Where-Object { $_.UsingStatementKind -eq 'Namespace' } | ForEach-Object { $_.Name.Value })
  # Types the file makes itself: PowerShell classes and enums, and C# in any string (Add-Type -TypeDefinition) or an
  # Add-Type -Name. Matched on the last part of the name, which is loose but never wrongly loud.
  $own = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($d in $ast.FindAll({ $args[0] -is [Management.Automation.Language.TypeDefinitionAst] }, $true)) { $null = $own.Add($d.Name) }
  foreach ($s in $ast.FindAll({ $args[0] -is [Management.Automation.Language.StringConstantExpressionAst] -or $args[0] -is [Management.Automation.Language.ExpandableStringExpressionAst] }, $true)) {
    foreach ($m in [regex]::Matches($s.Value, '\b(?:class|struct|enum|interface)\s+(\w+)')) { $null = $own.Add($m.Groups[1].Value) }
  }
  foreach ($c in $ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] -and $args[0].GetCommandName() -eq 'Add-Type' }, $true)) {
    $els = $c.CommandElements
    for ($i = 1; $i -lt $els.Count - 1; $i++) {
      if ($els[$i] -is [Management.Automation.Language.CommandParameterAst] -and $els[$i].ParameterName -eq 'Name' -and $els[$i + 1] -is [Management.Automation.Language.StringConstantExpressionAst]) {
        $null = $own.Add($els[$i + 1].Value)
      }
    }
  }

  # Every type name written as [Name] or [Name]$x or [Name]::Member, generic arguments and array elements included.
  $written = New-Object 'System.Collections.Generic.List[object]'
  foreach ($t in $ast.FindAll({ $args[0] -is [Management.Automation.Language.TypeExpressionAst] -or $args[0] -is [Management.Automation.Language.TypeConstraintAst] }, $true)) {
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue($t.TypeName)
    while ($queue.Count) {
      $n = $queue.Dequeue()
      if ($n -is [Management.Automation.Language.ArrayTypeName]) { $queue.Enqueue($n.ElementType); continue }
      if ($n -is [Management.Automation.Language.GenericTypeName]) {
        foreach ($g in $n.GenericArguments) { $queue.Enqueue($g) }
        $written.Add([pscustomobject]@{ Name = "$($n.TypeName.FullName)``$($n.GenericArguments.Count)"; Shown = $n.FullName; Reflection = $null; Extent = $t.Extent })
        continue
      }
      $written.Add([pscustomobject]@{ Name = $n.FullName; Shown = $n.FullName; Reflection = $n; Extent = $t.Extent })
    }
  }
  $checked = @{}
  foreach ($w in $written) {
    if ($checked.ContainsKey($w.Name)) { continue }
    $checked[$w.Name] = $true
    if ($accelerators.Contains($w.Name) -or $own.Contains(($w.Name -split '[.+]')[-1])) { continue }
    if (Find-Type $w.Name $namespaces) { continue }
    if ($w.Reflection -and $w.Reflection.GetReflectionType()) { continue }
    if (("$($w.Name)" -as [type]) -or ("System.$($w.Name)" -as [type])) { continue }
    Add-Finding $file $w.Extent 'UnknownType' "[$($w.Shown)] is no type on Windows PowerShell 5.1 or PowerShell 7, and this file doesn't define it."
  }

  # [Type]::Member where the profiles know the type: the member must be one of its statics in at least one of them.
  foreach ($m in $ast.FindAll({ $args[0] -is [Management.Automation.Language.MemberExpressionAst] -and $args[0].Static -and $args[0].Expression -is [Management.Automation.Language.TypeExpressionAst] -and $args[0].Member -is [Management.Automation.Language.StringConstantExpressionAst] }, $true)) {
    $member = $m.Member.Value
    if ($member -eq 'new') { continue }
    $entries = Find-Type $m.Expression.TypeName.FullName $namespaces
    if (-not $entries) { continue }
    $found = $false
    foreach ($entry in $entries) {
      if (-not $entry.Static) { continue }
      foreach ($group in @($entry.Static.Fields, $entry.Static.Properties, $entry.Static.Methods, $entry.Static.Events)) {
        if ($group -and @($group.Keys | Where-Object { $_ -eq $member }).Count) { $found = $true; break }
      }
      if ($found) { break }
    }
    # The profiles list declared statics only; this PowerShell's own type has the inherited ones too.
    $runtime = $m.Expression.TypeName.GetReflectionType()
    if (-not $found -and $runtime -and $runtime.GetMember($member, 'Public, Static, FlattenHierarchy, IgnoreCase')) { $found = $true }
    if (-not $found) { Add-Finding $file $m.Member.Extent 'UnknownMember' "[$($m.Expression.TypeName.FullName)] has no static member '$member' on Windows PowerShell 5.1 or PowerShell 7." }
  }

  foreach ($r in Invoke-ScriptAnalyzer -Path $file -Settings $settings) {
    Add-Finding $file $r.Extent $r.RuleName $r.Message
  }
}
} finally {
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}

foreach ($f in $findings) { Write-Output $f }
if ($findings.Count) {
  Write-Output "lint-ps1: $($findings.Count) finding(s) in $($files.Count) file(s)."
  exit 1
}
Write-Output "lint-ps1: $($files.Count) file(s) clean."
exit 0
