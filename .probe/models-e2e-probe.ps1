# .probe/models-e2e-probe.ps1 —— 真环境端到端：网关 GET /api/v2/models + POST /api/v2/tasks 带模型。
#
# 前提：scripts\start-live-env.ps1 已经起好隔离夹具（中继 9700 / 网关 18087，桌面端指向真 runtime 19387）。
# 它落盘的设备令牌在 <RuntimeDir>\logs\headless-device-token.txt。
#
# 这一步证明了什么（桩测证明不了的部分）：
#   1) 真桌面端 session/modelCatalog → 网关 normalize → 手机端解析器 这条链的字段名真的对得上；
#   2) 手机选了模型时，网关真的在首轮投递前调了 session/selectModel，并且回 modelApplied:true；
#   3) 建出来的会话在电脑端就是选的模型（GET /api/v2/sessions/{id} 的 meta.model）。
#
# 副作用（如实说明）：会在**真实桌面端**建一个会话并跑一轮。提示词写死了"只回 OK"，把 token 花销压到最小。
param(
  [int]$GatewayPort = 18087,
  [string]$RuntimeDir = '',
  [string]$Workspace = 'D:\Workspace\dsh_android',
  [string]$Model = 'deepseek-flash',
  [string]$Provider = 'deepseek-official'
)

$ErrorActionPreference = 'Stop'
if (-not $RuntimeDir) { $RuntimeDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime\live-env' }
$base = "http://127.0.0.1:$GatewayPort"

$checks = New-Object System.Collections.Generic.List[object]
function Add-Check { param([string]$Name, [bool]$Ok, [string]$Detail) $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }) }

$tokenFile = Get-ChildItem -LiteralPath $RuntimeDir -Recurse -Filter 'headless-device-token.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $tokenFile) { throw "找不到设备令牌（$RuntimeDir\logs\headless-device-token.txt）：先跑 scripts\start-live-env.ps1" }
$token = (Get-Content -LiteralPath $tokenFile.FullName -Raw).Trim()
$headers = @{ Authorization = 'Bearer ' + $token }
Write-Host "网关 $base · 令牌 $($token.Substring(0, [Math]::Min(8, $token.Length)))… · 工作区 $Workspace" -ForegroundColor Cyan

# ---------- 1) GET /api/v2/models ----------
$models = Invoke-RestMethod -Uri "$base/api/v2/models" -Headers $headers -TimeoutSec 20
$groupCount = @($models.groups).Count
$modelCount = (@($models.groups) | ForEach-Object { @($_.models).Count } | Measure-Object -Sum).Sum
Write-Host ("`n[1] GET /api/v2/models → ok={0} source={1} default={2}/{3} groups={4} models={5} failures={6}" -f `
    $models.ok, $models.source, $models.default.provider, $models.default.model, $groupCount, $modelCount, @($models.failures).Count)
foreach ($g in @($models.groups)) { Write-Host ("      ├ {0} ({1}): {2}" -f $g.id, $g.name, (@($g.models) | ForEach-Object { $_.id }) -join ', ') }
Add-Check '模型目录 200 且 source 有值' ($models.source -in @('desktop', 'config')) "source=$($models.source)"
Add-Check '模型目录有可选模型' ($modelCount -gt 0) "models=$modelCount groups=$groupCount"
Add-Check '模型项带 id+name' ((@($models.groups) | ForEach-Object { $_.models } | Where-Object { $_.id -and $_.name }).Count -eq $modelCount) '每个模型项都有 id/name'
Add-Check 'source=desktop 时无降级失败项' (($models.source -ne 'desktop') -or (@($models.failures).Count -eq 0)) "failures=$(@($models.failures).Count)"

# ---------- 2) POST /api/v2/tasks 带模型 ----------
$body = @{
  workspace    = $Workspace
  prompt       = '只回复 OK 两个字，不要做任何别的事。（DSH Remote 模型选择联调探针）'
  clientTurnId = [guid]::NewGuid().ToString()
  host         = 'desktop'
  model        = $Model
  provider     = $Provider
} | ConvertTo-Json -Compress
$created = $null
try {
  $created = Invoke-RestMethod -Uri "$base/api/v2/tasks" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
} catch {
  $resp = $_.Exception.Response
  if ($resp) { $reader = New-Object System.IO.StreamReader($resp.GetResponseStream()); $text = $reader.ReadToEnd(); Write-Host "[2] POST 失败：$text" -ForegroundColor Red }
  throw
}
Write-Host ("`n[2] POST /api/v2/tasks (model={0} provider={1} host=desktop) → sessionId={2} modelApplied={3} modelWarning={4}" -f `
    $Model, $Provider, $created.sessionId, $created.modelApplied, $created.modelWarning)
Add-Check '任务被接受且拿到 sessionId' ([bool]$created.sessionId) "sessionId=$($created.sessionId)"
Add-Check 'modelApplied=true（模型真的切上了）' ($created.modelApplied -eq $true) "modelApplied=$($created.modelApplied)"
Add-Check '没有 modelWarning' ([string]::IsNullOrEmpty($created.modelWarning)) "warning=$($created.modelWarning)"

# ---------- 3) 电脑端会话上的模型 ----------
if ($created.sessionId) {
  Start-Sleep -Seconds 2
  # 注意：session 详情是**顶层**对象（`{id,title,model:{...}}`），不是 `{session:{...}}` 包一层。
  $detail = Invoke-RestMethod -Uri ("$base/api/v2/sessions/" + [uri]::EscapeDataString($created.sessionId)) -Headers $headers -TimeoutSec 20
  $metaModel = $detail.model
  Write-Host ("`n[3] GET /api/v2/sessions/id -> model = " + ($metaModel | ConvertTo-Json -Compress))
  $matched = ($metaModel -and $metaModel.model -eq $Model)
  Add-Check '电脑端会话的模型就是手机上选的那个' ([bool]$matched) ("meta.model=" + $metaModel.model + " 期望=" + $Model)
}

# ---------- 汇总 ----------
$bad = @($checks | Where-Object { -not $_.Ok })
Write-Host "`n================ 汇总 ================"
foreach ($c in $checks) { Write-Host ("{0} {1} —— {2}" -f $(if ($c.Ok) { '✓' } else { '✗' }), $c.Name, $c.Detail) }
Write-Host ("通过 {0}/{1}" -f ($checks.Count - $bad.Count), $checks.Count)
exit $(if ($bad.Count -eq 0) { 0 } else { 1 })
