# pagent-node.ps1 —— Windows 版项目扫描器（只读，上报给 pagent 协调端）
# 用法：
#   powershell -ExecutionPolicy Bypass -File pagent-node.ps1 -Server http://192.168.1.3:9199 -Token XXX -Id wencha-win
#   powershell -ExecutionPolicy Bypass -File pagent-node.ps1 -ScanOnly
# 配置也可放 $HOME\.pagent-node.json：{"server":..,"token":..,"id":..,"roots":[..],"depth":1}

param(
  [string]$Server = '',
  [string]$Token = '',
  [string]$Id = '',
  [string[]]$Roots = @("$HOME"),
  [int]$Depth = 1,
  [switch]$ScanOnly,
  [switch]$Loop,
  [int]$Interval = 21600
)

$ErrorActionPreference = 'Continue'
$Markers = @('.git','package.json','pyproject.toml','go.mod','Cargo.toml','AGENTS.md','CLAUDE.md','README.md')
$Skip = @('node_modules','.venv','venv','__pycache__','AppData','.npm','.cache','dist','build','target','vendor','.git')

# 读配置
$conf = @{}
$confPath = Join-Path $HOME '.pagent-node.json'
if (Test-Path $confPath) {
  try { $conf = Get-Content $confPath -Raw | ConvertFrom-Json } catch {}
}
if (-not $Server -and $conf.server) { $Server = $conf.server }
if (-not $Token -and $conf.token) { $Token = $conf.token }
if (-not $Id -and $conf.id) { $Id = $conf.id }
if ($conf.roots -and $PSBoundParameters.ContainsKey('Roots') -eq $false) { $Roots = $conf.roots }
if ($conf.depth) { $Depth = [int]$conf.depth }

function Get-GitInfo($path) {
  try {
    $out = & git -C $path log -1 --format='%ct|%h|%s' 2>$null
    if (-not $out) { return $null }
    $parts = "$out".Split('|', 3)
    $dirty = (& git -C $path status --porcelain 2>$null | Measure-Object).Count
    return @{ ts = [int]$parts[0]; sha = $parts[1]; subject = $parts[2]; dirty = $dirty }
  } catch { return $null }
}

function Scan-Projects($roots, $depth) {
  $projects = @()
  $seen = @{}
  foreach ($root in $roots) {
    $base = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($root)
    if (-not (Test-Path $base)) { continue }
    $level = @(, @($base, 0))
    while ($level.Count -gt 0) {
      $cur, $d = $level[-1]; $level = $level[0..($level.Count-2)]
      if ($d -ge $depth) { continue }
      $dirs = Get-ChildItem -LiteralPath $cur -Directory -ErrorAction SilentlyContinue
      foreach ($dir in $dirs) {
        if ($dir.Name.StartsWith('.') -or $Skip -contains $dir.Name) { continue }
        $sub = $dir.FullName
        if ($seen.ContainsKey($sub)) { continue }
        $mk = @(); $latest = [datetime]::MinValue
        foreach ($m in $Markers) {
          $p = Join-Path $sub $m
          if (Test-Path $p) {
            $mk += $m
            if ($m -ne '.git') {
              $t = (Get-Item $p).LastWriteTime
              if ($t -gt $latest) { $latest = $t }
            }
          }
        }
        if ($mk.Count -gt 0) {
          $seen[$sub] = $true
          $git = Get-GitInfo $sub
          $ts = if ($latest -eq [datetime]::MinValue) { 0 } else { [int][double]::Parse((Get-Date $latest -UFormat %s)) }
          $projects += [pscustomobject]@{
            path = $sub; name = (Split-Path $sub -Leaf); markers = $mk; git = $git; last = $ts
          }
        }
        $level += ,@($sub, ($d + 1))
        if ($projects.Count -ge 400) { return $projects }
      }
    }
  }
  return $projects
}

function Push-Scan() {
  if (-not $Server -or -not $Token -or -not $Id) { Write-Error '需要 -Server / -Token / -Id'; return }
  $projects = Scan-Projects $Roots $Depth
  $payload = @{
    node = $Id; token = $Token; platform = "win32 $([System.Environment]::OSVersion.Version)"
    scanned_at = [int][double]::Parse((Get-Date -UFormat %s)); projects = $projects
  } | ConvertTo-Json -Depth 8 -Compress
  try {
    $r = Invoke-RestMethod -Uri "$($Server.TrimEnd('/'))/api/node-scan" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
    Write-Host "[pagent-node] 上报 $($projects.Count) 个项目 -> $Server ($($r.ok))"
  } catch { Write-Host "[pagent-node] 上报失败: $($_.Exception.Message)" }
}

if ($ScanOnly) {
  Scan-Projects $Roots $Depth | ConvertTo-Json -Depth 6
  exit 0
}
if ($Loop) {
  while ($true) { Push-Scan; Start-Sleep -Seconds $Interval }
}
Push-Scan
