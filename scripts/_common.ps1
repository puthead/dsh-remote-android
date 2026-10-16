#Requires -Version 5.1
<#
    dsh-remote 运维脚本公共函数库（由 scripts/*.ps1 点源加载，不单独执行）。

    设计约束（对应 task-4「脚本要求」）：
      1. 同时兼容 Windows PowerShell 5.1 与 PowerShell 7.x —— 不使用 PS7-only 语法
         （不使用 ?? / ?. / -AdditionalChildPath / ForEach-Object -Parallel 等）。
      2. 文件编码必须是「UTF-8 带 BOM」：Windows PowerShell 5.1 只有在有 BOM 时才按 UTF-8
         解析脚本，否则中文文案会变成乱码（详见 scripts/README 与仓库根 README 的说明）。
      3. 所有路径拼接使用 Join-Path；不硬编码用户名、不硬编码盘符（默认值全部靠探测）。
      4. 绝不打印真实 API Key / 设备令牌明文；日志里只出现掩码形式。

    主要能力：
      * 控制台输出：Write-Ok / Write-Fail / Write-Warn / Write-Skip / Write-Kv ...
      * 路径探测：Find-DshRoot / Find-NodeExe / Find-DshBin / Resolve-DshRemoteHome
      * 文件助手：Read-TextFileUtf8 / Write-TextFileUtf8NoBom / Read-JsonFile / Backup-ExistingFile
      * HTTP 客户端：Invoke-DshApi（基于 HttpWebRequest，5.1 与 7 行为一致）
      * 业务动作：Get-GatewayHealth / Invoke-DshPairAndClaim / Submit-DshTask / Wait-DshTask
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── 常量 ──────────────────────────────────────────────────────────────────────
$script:ScriptsDir = $PSScriptRoot
$script:DefaultPort = 8787
$script:DefaultMaxConcurrent = 2
$script:DefaultMaxQueue = 100
$script:DefaultTimeoutSec = 3600
$script:DefaultMaxTimeoutSec = 86400
$script:ApiVersion = '1'

# ── 控制台输出 ────────────────────────────────────────────────────────────────

function Write-Banner {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Title, [string]$SubTitle = '')
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
    Write-Host ("  $Title") -ForegroundColor Cyan
    if ($SubTitle) { Write-Host ("  $SubTitle") -ForegroundColor DarkGray }
    Write-Host ('=' * 72) -ForegroundColor DarkCyan
}

function Write-Section {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ''
    Write-Host ("── $Title " + ('─' * [Math]::Max(1, 66 - $Title.Length))) -ForegroundColor DarkCyan
}

function Write-Ok {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ("  [PASS] $Message") -ForegroundColor Green
}

function Write-Fail {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ("  [FAIL] $Message") -ForegroundColor Red
}

function Write-Skip {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ("  [SKIP] $Message") -ForegroundColor DarkYellow
}

function Write-Warn {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ("  [WARN] $Message") -ForegroundColor Yellow
}

function Write-Info {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ("  $Message") -ForegroundColor Gray
}

function Get-DisplayWidth {
    <#
      终端显示宽度：CJK 全角字符占 2 列。Write-Kv 用它对齐中文键名，否则中英混排会错位。
    #>
    [CmdletBinding()]
    param([Parameter(Position = 0)][AllowEmptyString()][string]$Text)
    $width = 0
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if (($code -ge 0x1100 -and $code -le 0x115F) -or
            ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
            ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6) -or
            ($code -ge 0x2580 -and $code -le 0x259F)) {
            $width += 2
        } else {
            $width += 1
        }
    }
    return $width
}

function Write-Kv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value,
        [int]$Pad = 20
    )
    $spaces = [Math]::Max(1, $Pad - (Get-DisplayWidth -Text $Key))
    Write-Host ("  " + $Key + (' ' * $spaces) + ": " + $Value)
}

function Write-NextStep {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Steps)
    Write-Host ''
    Write-Host '  下一步命令：' -ForegroundColor Cyan
    foreach ($s in $Steps) { Write-Host ("    " + $s) -ForegroundColor White }
    Write-Host ''
}

# ── 基础助手 ──────────────────────────────────────────────────────────────────

function Get-ScriptsDir { return $script:ScriptsDir }

function Get-RepoRoot { return (Split-Path -Parent $script:ScriptsDir) }

function Get-DefaultGatewayDir {
    # <repo>\tools\dsh-remote —— 全部用 Join-Path，不使用硬编码盘符
    return (Join-Path (Join-Path (Get-RepoRoot) 'tools') 'dsh-remote')
}

function Resolve-DshRemoteHome {
    <#
      运行目录（= 网关的 DSH_HOME：凭据 + tasks + logs 的根）。
      优先级：-Home 参数 > 环境变量 DSH_REMOTE_HOME > %USERPROFILE%\.dsh-remote

      注意：PowerShell 中 $remoteHome 是只读自动变量，参数不能直接命名为 Home
      （会报「无法覆盖变量 Home，因为该变量为只读变量或常量」）。
      这里用 [Alias('Home')]：用户仍按文档写 -Home，内部变量名是 $DshRemoteHome。
    #>
    [CmdletBinding()]
    param([Alias('Home')][string]$DshRemoteHome)
    if ($DshRemoteHome) { return [System.IO.Path]::GetFullPath($DshRemoteHome) }
    if ($env:DSH_REMOTE_HOME) { return [System.IO.Path]::GetFullPath($env:DSH_REMOTE_HOME) }
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    if (-not $userProfile) { throw '无法确定用户主目录：请用 -Home 显式指定运行目录。' }
    return (Join-Path $userProfile '.dsh-remote')
}

function Assert-GatewaySource {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$GatewayDir)
    $entry = Join-Path $GatewayDir 'gateway.mjs'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw ("网关源码未就绪：找不到 $entry。`n" +
               "  请先完成 task-1（tools/dsh-remote 网关实现），或用 -GatewayDir 指向网关源码目录。")
    }
    return $entry
}

function Test-FileHasBom {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        if ($fs.Length -lt 3) { return $false }
        $b = New-Object byte[] 3
        [void]$fs.Read($b, 0, 3)
        return ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    } finally { $fs.Dispose() }
}

function Read-TextFileUtf8 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-TextFileUtf8NoBom {
    <#
      写 UTF-8 无 BOM 文本。凭据文件（.credentials.yaml）必须是这种编码，
      带 BOM 会让 headless profile 解析失败。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    $enc = New-Object System.Text.UTF8Encoding($false)   # $false = 不写 BOM
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Write-TextFileUtf8Bom {
    # 写 UTF-8 带 BOM 文本（供 Windows PowerShell 5.1 正确解析 .ps1 使用）
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Read-JsonFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $text = Read-TextFileUtf8 -Path $Path
    $text = $text.TrimStart([char]0xFEFF)   # 容忍 BOM
    return ($text | ConvertFrom-Json)
}

function ConvertTo-JsonStringLiteral {
    <#
      字符串 → JSON 字面量（含引号）。
      为什么不用 ConvertTo-Json：Windows PowerShell 5.1 会把非 ASCII 转义成 \uXXXX，
      生成的 config.json 对人不可读；这里自己转义，保证两种 PowerShell 输出一致且中文可读。
    #>
    [CmdletBinding()]
    param([Parameter(Position = 0)][AllowEmptyString()][AllowNull()][string]$Value)
    if ($null -eq $Value) { return 'null' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`b" { [void]$sb.Append('\b') }
            "`f" { [void]$sb.Append('\f') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 0x20) { [void]$sb.Append('\u' + ([int]$ch).ToString('x4')) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-JsonText {
    <#
      任意对象 → JSON 文本（自定义序列化器，5.1 / 7 行为完全一致）。
        * 支持：$null / bool / 数值 / 字符串 / 数组 / IDictionary / PSCustomObject
        * -Compress 输出单行紧凑 JSON；默认输出 2 空格缩进的可读 JSON
        * 中文按 UTF-8 原样输出（不转义），便于人工核对 config.json
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)][AllowNull()]$InputObject,
        [int]$Depth = 12,
        [switch]$Compress,
        [int]$Level = 0
    )
    if ($Level -gt $Depth) { throw "JSON 序列化超过最大深度 $Depth（可能存在循环引用）" }
    $nl = ''
    if (-not $Compress) { $nl = "`n" }
    $indent = ''
    $childIndent = ''
    if (-not $Compress) {
        $indent = ' ' * ($Level * 2)
        $childIndent = ' ' * (($Level + 1) * 2)
    }

    if ($null -eq $InputObject) { return 'null' }
    if ($InputObject -is [bool]) { if ($InputObject) { return 'true' } else { return 'false' } }
    if ($InputObject -is [string]) { return (ConvertTo-JsonStringLiteral -Value $InputObject) }
    if ($InputObject -is [char]) { return (ConvertTo-JsonStringLiteral -Value ([string]$InputObject)) }
    if ($InputObject -is [int] -or $InputObject -is [long] -or $InputObject -is [System.Int16] -or
        $InputObject -is [System.Byte] -or $InputObject -is [System.SByte] -or
        $InputObject -is [System.UInt16] -or $InputObject -is [System.UInt32] -or $InputObject -is [System.UInt64]) {
        return $InputObject.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($InputObject -is [double] -or $InputObject -is [single] -or $InputObject -is [decimal]) {
        return ([double]$InputObject).ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($InputObject -is [datetime]) {
        return (ConvertTo-JsonStringLiteral -Value ($InputObject.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')))
    }
    if ($InputObject -is [System.Enum]) { return (ConvertTo-JsonStringLiteral -Value ([string]$InputObject)) }

    # 字典（含 [ordered]@{}）
    if ($InputObject -is [System.Collections.IDictionary]) {
        $keys = @($InputObject.Keys)
        if ($keys.Count -eq 0) { return '{}' }
        $parts = New-Object System.Collections.ArrayList
        foreach ($key in $keys) {
            $value = $InputObject[$key]
            $child = ConvertTo-JsonText -InputObject $value -Depth $Depth -Compress:$Compress -Level ($Level + 1)
            [void]$parts.Add($childIndent + (ConvertTo-JsonStringLiteral -Value ([string]$key)) + ':' + $(if ($Compress) { '' } else { ' ' }) + $child)
        }
        return ('{' + $nl + ($parts -join (',' + $nl)) + $nl + $indent + '}')
    }

    # 数组 / 列表（字符串已在上面处理）
    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [System.Management.Automation.PSCustomObject]) {
        $items = @($InputObject)
        if ($items.Count -eq 0) { return '[]' }
        $parts = New-Object System.Collections.ArrayList
        foreach ($item in $items) {
            [void]$parts.Add($childIndent + (ConvertTo-JsonText -InputObject $item -Depth $Depth -Compress:$Compress -Level ($Level + 1)))
        }
        return ('[' + $nl + ($parts -join (',' + $nl)) + $nl + $indent + ']')
    }

    # 一般对象（PSCustomObject / 其他带公共属性的对象）
    $props = @($InputObject.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property', 'AliasProperty', 'ScriptProperty') })
    if ($props.Count -eq 0) { return (ConvertTo-JsonStringLiteral -Value ([string]$InputObject)) }
    $parts = New-Object System.Collections.ArrayList
    foreach ($prop in $props) {
        $child = ConvertTo-JsonText -InputObject $prop.Value -Depth $Depth -Compress:$Compress -Level ($Level + 1)
        [void]$parts.Add($childIndent + (ConvertTo-JsonStringLiteral -Value $prop.Name) + ':' + $(if ($Compress) { '' } else { ' ' }) + $child)
    }
    return ('{' + $nl + ($parts -join (',' + $nl)) + $nl + $indent + '}')
}

function Write-JsonFileNoBom {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Object, [int]$Depth = 12)
    Write-TextFileUtf8NoBom -Path $Path -Content (ConvertTo-JsonText -InputObject $Object -Depth $Depth)
}

function Backup-ExistingFile {
    <#
      幂等保护：把已存在的文件备份为 <name>.bak-<yyyyMMddHHmmss>，返回备份路径；文件不存在返回 $null。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Stamp)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if (-not $Stamp) { $Stamp = (Get-Date).ToString('yyyyMMddHHmmss') }
    $backup = "$Path.bak-$Stamp"
    $i = 1
    while (Test-Path -LiteralPath $backup) { $backup = "$Path.bak-$Stamp.$i"; $i++ }
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    return $backup
}

function Get-FileSha256 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Format-Bytes {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][long]$Bytes)
    if ($Bytes -ge 1MB) { return ("{0:N2} MiB ({1} 字节)" -f ($Bytes / 1MB), $Bytes) }
    if ($Bytes -ge 1KB) { return ("{0:N2} KiB ({1} 字节)" -f ($Bytes / 1KB), $Bytes) }
    return ("{0} 字节" -f $Bytes)
}

function Get-JsonProp {
    <#
      安全取属性：$null 安全 + 不存在的属性不抛错（Set-StrictMode Latest 下必需）。
    #>
    [CmdletBinding()]
    param($Object, [Parameter(Mandatory = $true)][string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    if ($null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Mask-Secret {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Value)
    if (-not $Value) { return '(空)' }
    if ($Value.Length -le 8) { return '****' }
    return ($Value.Substring(0, 4) + '****' + $Value.Substring($Value.Length - 2))
}

# ── 路径探测 ──────────────────────────────────────────────────────────────────

function Test-DshRootCandidate {
    <#
      判定一个候选目录是否是「DSH 安装 resources 目录」：其下应存在自带 node.exe。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not $Path) { return $false }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    $node = Join-Path (Join-Path (Join-Path (Join-Path $Path 'runtime') 'primary-runtime') 'dependencies\node\bin') 'node.exe'
    return (Test-Path -LiteralPath $node -PathType Leaf)
}

function Find-DshRoot {
    <#
      探测 DSH 安装目录（Electron 的 resources 目录）。顺序：
        1. -DshRoot 参数
        2. 环境变量 DSH_RESOURCES_DIR / DSH_ROOT
        3. 监听 127.0.0.1:19387（桌面端 Web GUI）的进程 → <安装目录>\resources
        4. 运行中进程名含 dsh/harness 的可执行文件 → <目录>\resources
        5. 常见安装位置：%LOCALAPPDATA%\Programs\dsh、%ProgramFiles%\dsh、%LOCALAPPDATA%\dsh
        6. 各固定磁盘根下的 DSH\resources（不硬编码盘符，遍历系统盘符）
      返回第一个「自带 node.exe 存在」的候选；找不到返回 $null。
    #>
    [CmdletBinding()]
    param([string]$DshRoot)
    $candidates = New-Object System.Collections.ArrayList

    function Add-Candidate([string]$p) {
        if ($p) { [void]$candidates.Add([System.IO.Path]::GetFullPath($p)) }
    }

    Add-Candidate $DshRoot
    if ($env:DSH_RESOURCES_DIR) { Add-Candidate $env:DSH_RESOURCES_DIR }
    if ($env:DSH_ROOT) { Add-Candidate $env:DSH_ROOT }

    # 3) 桌面端 Web GUI 端口 19387 的宿主进程（DSH 桌面端内置该端口）
    try {
        $conn = @(Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($conn.Count -gt 0) {
            $proc = Get-Process -Id $conn[0].OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.Path) {
                $installDir = Split-Path -Parent $proc.Path
                Add-Candidate (Join-Path $installDir 'resources')
                Add-Candidate $installDir
            }
        }
    } catch { }

    # 4) 进程名/路径含 dsh 或 harness 的进程
    try {
        foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -match '(?i)dsh|harness') })) {
            $installDir = Split-Path -Parent $p.ExecutablePath
            Add-Candidate (Join-Path $installDir 'resources')
            Add-Candidate $installDir
        }
    } catch { }

    # 5) 常见安装位置
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    foreach ($base in @($localAppData, $programFiles, $programFilesX86)) {
        if (-not $base) { continue }
        Add-Candidate (Join-Path (Join-Path (Join-Path $base 'Programs') 'DSH') 'resources')
        Add-Candidate (Join-Path (Join-Path $base 'DSH') 'resources')
        Add-Candidate (Join-Path (Join-Path (Join-Path $base 'Programs') 'dsh') 'resources')
        Add-Candidate (Join-Path (Join-Path $base 'dsh') 'resources')
    }
    if ($localAppData) { Add-Candidate (Join-Path (Join-Path (Join-Path $localAppData 'Programs') 'DeepSeek Harness') 'resources') }

    # 6) 遍历固定磁盘（不硬编码盘符）
    try {
        foreach ($drive in @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed })) {
            $root = $drive.Name                                  # 例如 D:\
            Add-Candidate (Join-Path (Join-Path $root 'DSH') 'resources')
            Add-Candidate (Join-Path (Join-Path $root 'DeepSeek Harness') 'resources')
        }
    } catch { }

    foreach ($c in $candidates) {
        if (Test-DshRootCandidate -Path $c) { return $c }
    }
    return $null
}

function Find-NodeExe {
    <#
      探测 node.exe。顺序：-Node 参数 → DSH 自带 node → %DSH_HOME%\dsh-runtimes 里的 node → PATH 里的 node。
    #>
    [CmdletBinding()]
    param([string]$Node, [string]$DshRoot, [string]$DshHome)
    if ($Node) {
        if (Test-Path -LiteralPath $Node -PathType Leaf) { return [System.IO.Path]::GetFullPath($Node) }
        throw "指定的 node.exe 不存在：$Node"
    }
    $candidates = New-Object System.Collections.ArrayList
    function Add-NodeCandidate([string]$p) { if ($p) { [void]$candidates.Add($p) } }

    if ($DshRoot) {
        Add-NodeCandidate (Join-Path (Join-Path (Join-Path (Join-Path $DshRoot 'runtime') 'primary-runtime') 'dependencies\node\bin') 'node.exe')
    }
    if ($DshHome) {
        Add-NodeCandidate (Join-Path (Join-Path (Join-Path (Join-Path $DshHome 'dsh-runtimes') 'dsh-primary-runtime') 'dependencies\node\bin') 'node.exe')
    }
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ($userProfile) {
        Add-NodeCandidate (Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $userProfile '.dsh') 'dsh-runtimes') 'dsh-primary-runtime') 'dependencies\node\bin') 'node.exe')
    }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return $c }
    }
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

function Find-DshBin {
    <#
      探测 dsh CLI 入口 bin.js。顺序：-DshBin 参数 → %DSH_HOME%\profiles\node_modules\... → %DSH_PROFILE_DIR% 上级
      → %USERPROFILE%\.dsh\profiles\node_modules\...；都没找到返回 $null。
    #>
    [CmdletBinding()]
    param([string]$DshBin, [string]$DshHome)
    if ($DshBin) {
        if (Test-Path -LiteralPath $DshBin -PathType Leaf) { return [System.IO.Path]::GetFullPath($DshBin) }
        throw "指定的 dsh CLI 入口不存在：$DshBin"
    }
    $rel = 'profiles\node_modules\@deepseek-ai\dsh\lib\bin.js'
    $candidates = New-Object System.Collections.ArrayList
    function Add-BinCandidate([string]$p) { if ($p) { [void]$candidates.Add($p) } }

    if ($DshHome) { Add-BinCandidate (Join-Path $DshHome $rel) }
    if ($env:DSH_HOME) { Add-BinCandidate (Join-Path $env:DSH_HOME $rel) }
    if ($env:DSH_PROFILE_DIR) {
        # <home>\profiles\<profile> → up 2 = <home>
        $homeGuess = Split-Path -Parent (Split-Path -Parent $env:DSH_PROFILE_DIR)
        Add-BinCandidate (Join-Path $homeGuess $rel)
    }
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ($userProfile) { Add-BinCandidate (Join-Path (Join-Path $userProfile '.dsh') $rel) }

    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return $c }
    }
    return $null
}

function Get-ConfigDefaults {
    <#
      读取运行目录下的 config.json（不存在则返回 $null）。返回值不校验，交由调用方判断。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$DshRemoteHome)
    $path = Join-Path $DshRemoteHome 'config.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return (Read-JsonFile -Path $path) } catch { return $null }
}

# ── HTTP 客户端（HttpWebRequest，5.1 / 7 行为一致） ────────────────────────────

function Invoke-DshApi {
    <#
      REST 调用。返回 [pscustomobject]@{ Status; Ok; Text; Json }。
      传输层失败抛异常；HTTP 4xx/5xx 不抛异常，由调用方读 Status/Json.error。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [ValidateSet('GET', 'POST', 'DELETE', 'PUT', 'HEAD')][string]$Method = 'GET',
        [System.Collections.IDictionary]$Headers = $null,
        [string]$Body = $null,
        [int]$TimeoutSec = 30,
        [string]$ApiVersion,
        [switch]$Insecure
    )
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Method = $Method
    $request.Timeout = $TimeoutSec * 1000
    $request.ReadWriteTimeout = $TimeoutSec * 1000
    $request.Accept = 'application/json'
    $request.UserAgent = 'dsh-remote-scripts/1.0'
    $request.AllowAutoRedirect = $true
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Headers.Add('X-Api-Version', $(if ($ApiVersion) { $ApiVersion } else { $script:ApiVersion }))
    # -Insecure 只用于「本机自签证书」或「只绑公网 IP 的证书」的回环验证场景；手机 App 无自签信任开关
    # （需求 FR-15/O8），release 变体必须能走系统信任链，故生产校验不得依赖 -Insecure。
    if ($Insecure) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 } catch { }
    }
    if ($Headers) {
        foreach ($key in $Headers.Keys) {
            if ([string]$key -ieq 'Content-Type') { continue }
            $request.Headers.Add([string]$key, [string]$Headers[$key])
        }
    }
    # 注意：PowerShell 会把显式传入的 $null 转成空字符串（[string] 参数的既有行为），
    # 所以「有 Body」的判据必须同时排除空串，否则 GET 会去 GetRequestStream() 并抛
    # ProtocolViolationException（Cannot send a content-body with this verb-type）。
    $hasBody = $PSBoundParameters.ContainsKey('Body') -and $null -ne $Body -and ([string]$Body) -ne ''
    if ($hasBody -and ($Method -eq 'GET' -or $Method -eq 'HEAD')) {
        throw "GET/HEAD 请求不能携带请求体（Body）：$Url"
    }
    if ($hasBody) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }

    $response = $null
    $transportError = $null
    try {
        $response = $request.GetResponse()
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $response = $_.Exception.Response } else { $transportError = $_.Exception.Message }
    } catch {
        $transportError = $_.Exception.Message
    }

    $status = 0
    $text = ''
    if ($null -ne $response) {
        try {
            $status = [int]$response.StatusCode
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
        } finally {
            try { $response.Dispose() } catch { }
        }
    }
    if ($transportError) {
        throw ("HTTP 请求失败（$Method $Url）：$transportError`n" +
               "  请确认网关已启动（scripts\start-gateway.ps1）且端口正确。")
    }

    $json = $null
    if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
    return [pscustomobject]@{
        Status = $status
        Ok     = ($status -ge 200 -and $status -lt 300)
        Text   = $text
        Json   = $json
    }
}

function Get-ApiErrorMessage {
    [CmdletBinding()]
    param($Result)
    if ($null -eq $Result) { return '（无响应）' }
    $err = Get-JsonProp -Object $Result.Json -Name 'error'
    if ($err) {
        $code = Get-JsonProp -Object $err -Name 'code' -Default ''
        $message = Get-JsonProp -Object $err -Name 'message' -Default ''
        return ("$code $message").Trim()
    }
    if ($Result.Text) { return [string]$Result.Text }
    return ("HTTP " + $Result.Status)
}

function Get-GatewayHealth {
    <#
      探测 /api/v1/health（免认证）。返回 $null 表示不可达。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [int]$TimeoutSec = 5)
    try {
        $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + '/api/v1/health') -Method GET -TimeoutSec $TimeoutSec
        if ($r.Ok) { return $r.Json }
        return $null
    } catch { return $null }
}

function Wait-GatewayHealth {
    <#
      等待网关就绪（轮询 /health）。成功返回 health 对象，超时返回 $null。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSec = 20,
        [int]$IntervalMs = 400
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $h = Get-GatewayHealth -BaseUrl $BaseUrl -TimeoutSec 3
        if ($h) { return $h }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $null
}

function New-DeviceId { return ([guid]::NewGuid()).ToString('D').ToLowerInvariant() }

function Invoke-DshPairOpen {
    <#
      POST /api/v1/pair/open（仅回环可达）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [int]$TimeoutSec = 10)
    $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + '/api/v1/pair/open') -Method POST -TimeoutSec $TimeoutSec
    if (-not $r.Ok) { throw ("生成配对码失败：HTTP " + $r.Status + " " + (Get-ApiErrorMessage -Result $r)) }
    $code = Get-JsonProp -Object $r.Json -Name 'code'
    if (-not $code) { throw "生成配对码失败：响应缺少 code 字段（$($r.Text)）" }
    return $r.Json
}

function Invoke-DshPairClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$DeviceId,
        [string]$DeviceName = 'dsh-remote-scripts',
        [int]$TimeoutSec = 15
    )
    $body = ConvertTo-JsonText -InputObject ([ordered]@{
            code       = $Code
            deviceName = $DeviceName
            deviceId   = $DeviceId
        })
    $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + '/api/v1/pair/claim') -Method POST -Body $body -TimeoutSec $TimeoutSec
    if (-not $r.Ok) { throw ("配对失败：HTTP " + $r.Status + " " + (Get-ApiErrorMessage -Result $r)) }
    $token = Get-JsonProp -Object $r.Json -Name 'token'
    if (-not $token) { throw "配对失败：响应缺少 token 字段（$($r.Text)）" }
    return $r.Json
}

function Invoke-DshPairAndClaim {
    <#
      完整配对流程：pair/open → pair/claim（自生成 UUID v4 deviceId）。
      deviceId 格式必须匹配 ^[0-9a-f]{8}-...$（契约裁定 A4）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [string]$DeviceName = 'dsh-remote-scripts',
        [string]$DeviceId,
        [int]$TimeoutSec = 15
    )
    if (-not $DeviceId) { $DeviceId = New-DeviceId }
    if ($DeviceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw "deviceId 必须是 32 位小写 UUID（契约裁定 A4）：$DeviceId"
    }
    $open = Invoke-DshPairOpen -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    $claim = Invoke-DshPairClaim -BaseUrl $BaseUrl -Code ([string](Get-JsonProp -Object $open -Name 'code')) `
        -DeviceId $DeviceId -DeviceName $DeviceName -TimeoutSec $TimeoutSec
    return [pscustomobject]@{
        Code       = [string](Get-JsonProp -Object $open -Name 'code')
        ExpiresAt  = Get-JsonProp -Object $open -Name 'expiresAt'
        Token      = [string](Get-JsonProp -Object $claim -Name 'token')
        TokenId    = [string](Get-JsonProp -Object $claim -Name 'tokenId')
        ServerName = [string](Get-JsonProp -Object $claim -Name 'serverName')
        DeviceId   = $DeviceId
    }
}

function Submit-DshTask {
    <#
      POST /api/v1/tasks → Task 对象。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$Title,
        [int]$TimeoutSec = 3600,
        [int]$HttpTimeoutSec = 30
    )
    $payload = [ordered]@{
        prompt    = $Prompt
        workspace = $Workspace
        timeoutSec = $TimeoutSec
    }
    if ($Title) { $payload['title'] = $Title }
    $headers = @{ Authorization = "Bearer $Token" }
    $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + '/api/v1/tasks') -Method POST -Headers $headers `
        -Body (ConvertTo-JsonText -InputObject $payload) -TimeoutSec $HttpTimeoutSec
    if (-not $r.Ok) { throw ("提交任务失败：HTTP " + $r.Status + " " + (Get-ApiErrorMessage -Result $r)) }
    return $r.Json
}

function Get-DshTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [int]$TimeoutSec = 15
    )
    $headers = @{ Authorization = "Bearer $Token" }
    $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + ("/api/v1/tasks/" + $TaskId)) -Method GET -Headers $headers -TimeoutSec $TimeoutSec
    if (-not $r.Ok) { throw ("查询任务失败：HTTP " + $r.Status + " " + (Get-ApiErrorMessage -Result $r)) }
    return $r.Json
}

function Wait-DshTask {
    <#
      轮询任务直到终态或超时。返回 [pscustomobject]@{ Task; Terminal; TimedOut; ElapsedSec }。
      终态：succeeded / failed / canceled。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [int]$TimeoutSec = 300,
        [int]$PollMs = 1000,
        [scriptblock]$OnProgress = $null
    )
    $terminalStates = @('succeeded', 'failed', 'canceled')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $task = $null
    $lastStatus = ''
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $task = Get-DshTask -BaseUrl $BaseUrl -Token $Token -TaskId $TaskId
        $status = [string](Get-JsonProp -Object $task -Name 'status' -Default '')
        if ($status -ne $lastStatus) {
            if ($OnProgress) { & $OnProgress $status $sw.Elapsed }
            $lastStatus = $status
        }
        if ($terminalStates -contains $status) {
            $sw.Stop()
            return [pscustomobject]@{ Task = $task; Terminal = $true; TimedOut = $false; ElapsedSec = [Math]::Round($sw.Elapsed.TotalSeconds, 2) }
        }
        Start-Sleep -Milliseconds $PollMs
    }
    $sw.Stop()
    return [pscustomobject]@{ Task = $task; Terminal = $false; TimedOut = $true; ElapsedSec = [Math]::Round($sw.Elapsed.TotalSeconds, 2) }
}

function Remove-DshTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [int]$TimeoutSec = 15
    )
    $headers = @{ Authorization = "Bearer $Token" }
    $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + ("/api/v1/tasks/" + $TaskId)) -Method DELETE -Headers $headers -TimeoutSec $TimeoutSec
    return $r.Ok
}

# ── 原生进程调用 ──────────────────────────────────────────────────────────────

function ConvertTo-CommandLineArgument {
    <#
      单个参数 → Windows 命令行片段（MSVC 运行库的引号/反斜杠规则）。
      PowerShell 5.1 的 ProcessStartInfo 没有 ArgumentList，只能自己拼命令行，所以必须正确转义。
    #>
    [CmdletBinding()]
    param([Parameter(Position = 0)][AllowEmptyString()][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * ($backslashes * 2 + 1))
            [void]$sb.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Invoke-NativeCommand {
    <#
      执行原生程序并收集 stdout/stderr/退出码（带超时）。返回：
        [pscustomobject]@{ ExitCode; StdOut; StdErr; TimedOut; ElapsedSec; CommandLine }
      为什么不用 & / Start-Process：
        * $ErrorActionPreference='Stop' 下，原生程序写 stderr 会被包成 NativeCommandError 抛异常；
        * 需要可靠超时与 UTF-8 解码，.NET Process + ReadToEndAsync 最稳。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [int]$TimeoutSec = 60,
        [System.Collections.IDictionary]$EnvironmentVariables = $null
    )
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "可执行文件不存在：$FilePath"
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $argumentText = (@($ArgumentList | ForEach-Object { ConvertTo-CommandLineArgument -Value ([string]$_) }) -join ' ')
    $psi.Arguments = $argumentText
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    if ($EnvironmentVariables) {
        foreach ($key in $EnvironmentVariables.Keys) {
            $psi.EnvironmentVariables[[string]$key] = [string]$EnvironmentVariables[$key]
        }
    }
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        $timedOut = $true
        try { $proc.Kill() } catch { }
        [void]$proc.WaitForExit(5000)
    }
    $sw.Stop()
    $stdout = ''
    $stderr = ''
    try { $stdout = $outTask.Result } catch { $stdout = '' }
    try { $stderr = $errTask.Result } catch { $stderr = '' }
    $exitCode = $proc.ExitCode
    $proc.Dispose()
    return [pscustomobject]@{
        ExitCode    = $exitCode
        StdOut      = $stdout
        StdErr      = $stderr
        TimedOut    = $timedOut
        ElapsedSec  = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
        CommandLine = ($FilePath + ' ' + $argumentText)
    }
}

# ── 进程助手 ──────────────────────────────────────────────────────────────────

function Get-PidFilePath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$DshRemoteHome)
    return (Join-Path $DshRemoteHome 'gateway.pid.json')
}

function Read-GatewayPidInfo {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$DshRemoteHome)
    $path = Get-PidFilePath -Home $DshRemoteHome
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return (Read-JsonFile -Path $path) } catch { return $null }
}

function Test-ProcessAlive {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Stop-ProcessTree {
    <#
      结束进程树：优先 taskkill /T /F（能带走 dsh 子进程），失败回退 Stop-Process。
      必须走 Invoke-NativeCommand 而不是 "& taskkill ... 2>&1"：
      $ErrorActionPreference='Stop' 下，原生程序写 stderr（例如 "process not found"）会被 PowerShell
      包成 NativeCommandError 并直接终止脚本 —— 这里踩过一次，别再改回去。
      另外：进程已经不在了（taskkill 退出码 128 / 不存在）一律视为「已结束」，这是幂等语义。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $true }
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
        try {
            $run = Invoke-NativeCommand -FilePath $taskkill -ArgumentList @('/PID', [string]$ProcessId, '/T', '/F') -TimeoutSec 30
            if ($run.ExitCode -eq 0) { return $true }
            if ($run.ExitCode -eq 128) { return $true }        # 128 = 进程不存在
            if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $true }
        } catch { }
    }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        return $true
    } catch {
        return (-not (Test-ProcessAlive -ProcessId $ProcessId))
    }
}

function Get-PortOwnerProcessId {
    <#
      返回监听指定端口的进程 PID；没有监听者返回 0。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        $conn = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($conn.Count -gt 0) { return [int]$conn[0].OwningProcess }
    } catch { }
    return 0
}

function Test-PowerShellEdition {
    <#
      返回可读的 PowerShell 版本串，用于 selftest/verify 报告。
    #>
    $v = $PSVersionTable.PSVersion
    $edition = if ($v.Major -ge 6) { 'PowerShell (Core)' } else { 'Windows PowerShell' }
    return ("$edition $v")
}

# ── v2：中继（relay）与跨网络验证 ─────────────────────────────────────────────
#
# 本段的函数服务于 docs/01-设计/协议契约-v2.md §2/§3/§6：
#   * 中继源码/运行目录/配置/PID/健康检查（setup-relay / start-relay / stop-relay）
#   * netstat 监听断言、TCP 直连失败断言（e2e 判据 A / C）
#   * 分离启动任意命令（WMI + scripts/tests/detached-run.mjs，支持环境变量注入）

$script:DefaultRelayPort = 9443
$script:DefaultRelayName = 'relay.local'
$script:RelayApiVersion = '2'
$script:DefaultRelayHomeDirName = 'relay-home'

function Get-DefaultRelayDir {
    return (Join-Path (Join-Path (Get-RepoRoot) 'tools') 'dsh-relay')
}function Get-RelayEntryPath {
    [CmdletBinding()]
    param([string]$RelayDir)
    if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
    return (Join-Path $RelayDir 'relay.mjs')
}

function Test-RelaySourceReady {
    [CmdletBinding()]
    param([string]$RelayDir)
    return (Test-Path -LiteralPath (Get-RelayEntryPath -RelayDir $RelayDir) -PathType Leaf)
}

function Assert-RelaySource {
    <#
      中继源码就绪校验：tools/dsh-relay/relay.mjs 必须存在（task-1 产物）。
      未就绪时抛出带「尚未实现」字样的明确错误 —— 脚本必须显式报阻塞，不得静默失败。
    #>
    [CmdletBinding()]
    param([string]$RelayDir)
    $entry = Get-RelayEntryPath -RelayDir $RelayDir
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw ("中继源码尚未实现：找不到 $entry`n" +
               "  契约见 docs/01-设计/协议契约-v2.md §2/§3（relay.mjs + lib/*.mjs + config.example.json）。`n" +
               "  在中继实现就绪前，涉及中继的判据只能记为 BLOCKED，不得伪造结果。")
    }
    return $entry
}

function Get-RelayExampleConfigPath {
    [CmdletBinding()]
    param([string]$RelayDir)
    if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
    return (Join-Path $RelayDir 'config.example.json')
}

function Resolve-RelayHome {
    <#
      中继运行目录（配置 + PID + 证书 + 日志的根）。
      优先级：-Home 参数 > 环境变量 DSH_RELAY_HOME > <仓库>\.runtime\relay-home
    #>
    [CmdletBinding()]
    param([Alias('Home')][string]$RelayHome)
    if ($RelayHome) { return [System.IO.Path]::GetFullPath($RelayHome) }
    if ($env:DSH_RELAY_HOME) { return [System.IO.Path]::GetFullPath($env:DSH_RELAY_HOME) }
    return (Join-Path (Get-RepoRoot) (Join-Path '.runtime' $script:DefaultRelayHomeDirName))
}

function New-RandomSecret {
    <#
      Base64Url 随机口令/令牌（32 字节 → 43 字符），与契约 §1 的 homeToken/deviceToken 形状一致。
    #>
    [CmdletBinding()]
    param([int]$Bytes = 32)
    $buf = [byte[]]::new($Bytes)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($buf)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-RelayConfigPath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$RelayHome)
    return (Join-Path $RelayHome 'config.json')
}

function Get-RelayPidFilePath {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$RelayHome)
    return (Join-Path $RelayHome 'relay.pid.json')
}

function Read-RelayPidInfo {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][Alias('Home')][string]$RelayHome)
    $path = Get-RelayPidFilePath -Home $RelayHome
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return (Read-JsonFile -Path $path) } catch { return $null }
}

function Get-RelayBaseUrl {
    <#
      由运行目录的 config.json 推导中继本机地址：tls.mode=off → http://127.0.0.1:<port>，否则 https://。
    #>
    [CmdletBinding()]
    param([Alias('Home')][string]$RelayHome, [int]$Port = 0, [switch]$PlainHttp)
    $effectivePort = $script:DefaultRelayPort
    $tlsMode = 'off'
    if ($RelayHome) {
        $config = Get-ConfigDefaults -Home $RelayHome
        if ($config) {
            $cfgPort = Get-JsonProp -Object $config -Name 'port'
            if ($cfgPort) { $effectivePort = [int]$cfgPort }
            $tls = Get-JsonProp -Object $config -Name 'tls'
            $mode = [string](Get-JsonProp -Object $tls -Name 'mode' -Default 'off')
            if ($mode) { $tlsMode = $mode }
        }
    }
    if ($Port -gt 0) { $effectivePort = $Port }
    $scheme = 'https'
    if ($PlainHttp -or $tlsMode -eq 'off') { $scheme = 'http' }
    return ("$scheme`://127.0.0.1:$effectivePort")
}

function Get-RelayHealth {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [int]$TimeoutSec = 5, [switch]$Insecure)
    try {
        $r = Invoke-DshApi -Url ($BaseUrl.TrimEnd('/') + '/health') -Method GET -TimeoutSec $TimeoutSec `
            -ApiVersion $script:RelayApiVersion -Insecure:$Insecure
        if ($r.Ok) { return $r.Json }
        return $null
    } catch { return $null }
}

function Wait-RelayHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSec = 20,
        [int]$IntervalMs = 400,
        [switch]$Insecure
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $h = Get-RelayHealth -BaseUrl $BaseUrl -TimeoutSec 3 -Insecure:$Insecure
        if ($h) { return $h }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $null
}

function ConvertTo-RelayTunnelWsUrl {
    <#
      http(s)://host:port → ws(s)://host:port/api/v2/tunnel/<role>（契约 §3）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [ValidateSet('home', 'device')][string]$Role = 'device')
    $text = $BaseUrl.TrimEnd('/')
    if ($text -like 'https://*') { $text = 'wss://' + $text.Substring(8) }
    elseif ($text -like 'http://*') { $text = 'ws://' + $text.Substring(7) }
    return ($text + '/api/v2/tunnel/' + $Role)
}

function Get-LanIPv4Addresses {
    <#
      本机非回环 IPv4 列表（判据 A：手机/局域网地址打 8787 必须失败）。
    #>
    [CmdletBinding()]
    param()
    $result = New-Object System.Collections.ArrayList
    try {
        foreach ($ip in @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()))) {
            if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
            $s = $ip.ToString()
            if ($s -ne '127.0.0.1' -and $s -notlike '169.254.*' -and -not $result.Contains($s)) { [void]$result.Add($s) }
        }
    } catch { }
    return @($result)
}

function Test-TcpConnect {
    <#
      裸 TCP 连接测试（不带业务语义）。返回 [pscustomobject]@{ Connected; Error; ElapsedMs }。
      判据 A 用它证明「局域网地址 + 8787 连不上」。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TargetHost,
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMs = 3000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $connected = $false
    $errorText = ''
    try {
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $signaled = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($signaled) {
            try { $client.EndConnect($iar); $connected = $true }
            catch { $errorText = $_.Exception.Message }
        } else {
            $errorText = "连接超时（${TimeoutMs}ms 内未建立）"
        }
    } catch {
        $errorText = $_.Exception.Message
    } finally {
        try { $client.Close() } catch { }
    }
    $sw.Stop()
    return [pscustomobject]@{ Connected = $connected; Error = $errorText; ElapsedMs = [int]$sw.ElapsedMilliseconds }
}

function Get-NetstatTcpSnapshot {
    <#
      执行 `netstat -ano -p tcp` 并解析（判据 C 的实测证据）。
      返回 [pscustomobject]@{ ExitCode; CommandLine; Raw; Entries }。
    #>
    [CmdletBinding()]
    param()
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstat -PathType Leaf)) { throw "找不到 netstat.exe：$netstat" }
    $run = Invoke-NativeCommand -FilePath $netstat -ArgumentList @('-ano', '-p', 'tcp') -TimeoutSec 60
    $entries = New-Object System.Collections.ArrayList
    foreach ($line in @($run.StdOut -split "`r?`n")) {
        $m = [regex]::Match($line, '^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$')
        if (-not $m.Success) { continue }
        [void]$entries.Add([pscustomobject]@{
                Line          = $line.Trim()
                LocalAddress  = $m.Groups[1].Value
                LocalPort     = [int]$m.Groups[2].Value
                RemoteAddress = $m.Groups[3].Value
                RemotePort    = [int]$m.Groups[4].Value
                State         = $m.Groups[5].Value
                Pid           = [int]$m.Groups[6].Value
            })
    }
    return [pscustomobject]@{
        ExitCode    = $run.ExitCode
        CommandLine = $run.CommandLine
        Raw         = $run.StdOut
        Entries     = @($entries)
    }
}

function Invoke-DshV2Api {
    <#
      网关 v2 API 调用（自动带 X-Api-Version: 2 与可选 Bearer 令牌）。
      HTTP 4xx/5xx 不抛异常，交由调用方读 Status / Json.error。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('GET', 'POST', 'DELETE', 'PUT', 'HEAD')][string]$Method = 'GET',
        [string]$Token,
        [string]$Body,
        [int]$TimeoutSec = 30
    )
    $headers = @{}
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    $url = $BaseUrl.TrimEnd('/') + '/' + $Path.TrimStart('/')
    $splat = @{
        Url        = $url
        Method     = $Method
        Headers    = $headers
        TimeoutSec = $TimeoutSec
        ApiVersion = $script:RelayApiVersion
    }
    if ($PSBoundParameters.ContainsKey('Body') -and -not [string]::IsNullOrEmpty($Body)) { $splat['Body'] = $Body }
    return (Invoke-DshApi @splat)
}

function Get-GatewayRelayStatus {
    <#
      GET /api/v2/relay/status（仅回环）。未实现时返回 $null（不抛异常），由调用方判定 BLOCKED。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [int]$TimeoutSec = 5)
    $r = Invoke-DshV2Api -BaseUrl $BaseUrl -Path '/api/v2/relay/status' -TimeoutSec $TimeoutSec
    if ($r.Ok) { return $r.Json }
    return $null
}

function Get-PowerShellExePath {
    [CmdletBinding()]
    param()
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $ps -PathType Leaf) { return $ps }
    $cmd = Get-Command powershell -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

function Invoke-DshScript {
    <#
      调用另一个 PowerShell 脚本并捕获输出（供 e2e 串联 start/stop 脚本，保留真实输出文本作为证据）。
      用 -Command 包一层而不是 -File：强制子进程把控制台输出编码设为 UTF-8，
      否则中文在管道里会按 ANSI(GBK) 写出，而调用方按 UTF-8 解码 → 乱码。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 300
    )
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) { throw "脚本不存在：$ScriptPath" }
    $ps = Get-PowerShellExePath
    if (-not $ps) { throw '找不到 powershell.exe（Windows PowerShell 5.1），无法调用脚本。' }
    $quoted = New-Object System.Collections.ArrayList
    foreach ($a in @($Arguments)) {
        $text = [string]$a
        # 参数名（-Foo）必须保持裸写法，否则会被当成位置参数；只给「值」加引号。
        if ($text -match '^-[A-Za-z]') { [void]$quoted.Add($text); continue }
        if ($text -match '[\s''"]' -or $text -eq '') { [void]$quoted.Add("'" + $text.Replace("'", "''") + "'") }
        else { [void]$quoted.Add($text) }
    }
    $command = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '" + $ScriptPath.Replace("'", "''") + "'"
    if ($quoted.Count -gt 0) { $command += ' ' + ($quoted -join ' ') }
    $full = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)
    return (Invoke-NativeCommand -FilePath $ps -ArgumentList $full -TimeoutSec $TimeoutSec)
}

function Get-AcceptanceDir {
    <#
      证据目录：<仓库>\.runtime\acceptance（.runtime 已在 .gitignore 中，不会入库）。
    #>
    [CmdletBinding()]
    param([string]$SubDir)
    $dir = Join-Path (Join-Path (Get-RepoRoot) '.runtime') 'acceptance'
    if ($SubDir) { $dir = Join-Path $dir $SubDir }
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    return $dir
}

function Read-JsonLinesFile {
    <#
      读 NDJSON（手机模拟器事件流）。非法行跳过，不抛异常。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $items = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $text = $null
    try {
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    } catch {
        # 写入方可能以独占方式持有文件（例如 Node 的长连接 write stream 会让
        # File.ReadAllText 抛「正由另一进程使用」）。回退到 FileShare.ReadWrite，
        # 保证「边写边读」不会失败——否则 D/E 判据会假失败。
        try {
            $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
                $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            } finally { $fs.Dispose() }
        } catch { return @() }
    }
    if ($null -eq $text) { return @() }
    foreach ($line in @($text -split "`r?`n")) {
        $t = $line.Trim()
        if (-not $t) { continue }
        try { [void]$items.Add(($t | ConvertFrom-Json)) } catch { }
    }
    return @($items)
}

function Wait-JsonLineMatch {
    <#
      轮询 NDJSON 文件，直到出现满足条件的行。返回匹配到的对象；超时返回 $null。
      -Kind  / -Name 用于筛选事件的 kind / name 字段；-Pattern 为正则（对整行文本）。
      -Skip 跳过前 N 行：用于「某个动作之后才出现的行」这类断言（动作前先记下当前行数）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Kind,
        [string]$Name,
        [string]$Pattern,
        [int]$Skip = 0,
        [int]$TimeoutSec = 30,
        [int]$IntervalMs = 250
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $all = @(Read-JsonLinesFile -Path $Path)
        $items = $all
        if ($Skip -gt 0) {
            if ($all.Count -le $Skip) { Start-Sleep -Milliseconds $IntervalMs; continue }
            $items = @($all[$Skip..($all.Count - 1)])
        }
        foreach ($item in $items) {
            $okKind = $true
            if ($Kind) { $okKind = ([string](Get-JsonProp -Object $item -Name 'kind' -Default '') -eq $Kind) }
            $okName = $true
            if ($Name) { $okName = ([string](Get-JsonProp -Object $item -Name 'name' -Default '') -eq $Name) }
            $okPattern = $true
            # 注意：PSCustomObject 的 [string] 形式不是 JSON（没有引号），-Pattern 必须针对 JSON 文本匹配，
            # 否则像 '"ok":true' 这样的模式永远匹配不到（会误报「没有任何成功请求」）。
            if ($Pattern) { $okPattern = ((ConvertTo-JsonText -InputObject $item -Compress) -match $Pattern) }
            if ($okKind -and $okName -and $okPattern) { return $item }
        }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $null
}

function Get-TextFileTail {
    <#
      读取文本文件末尾若干行。**必须显式按 UTF-8 读**：Node/中继/网关的日志都是 UTF-8，
      而 Windows PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 解码 → 中文错误信息会变乱码，
      排障时等于白看（本轮实测踩过）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    try {
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    } catch { return @() }
    $all = @($text -split "`r?`n")
    if ($all.Count -le $Lines) { return $all }
    return @($all[($all.Count - $Lines)..($all.Count - 1)])
}

function Start-DetachedCommand {
    <#
      分离启动一个命令并返回其真实 PID。

      为什么需要它：从「捕获输出的宿主」（DSH/CI/Agent）里用 Start-Process 启后台服务，
      子进程会继承宿主的标准句柄与作业对象，宿主会一直等到服务退出才返回。
      这里用 WMI Win32_Process.Create 创建 scripts/tests/detached-run.mjs，
      由它用 node 的 detached+unref 拉起真正的工作进程（可选注入环境变量，日志重定向到文件）。
      detached-run.mjs 把子进程 PID 写入 --pidfile，本函数轮询该文件拿到 PID。

      返回 [pscustomobject]@{ LauncherPid; Pid; LaunchMode; CommandLine; StdOutLog; StdErrLog }。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StdOutLog,
        [string]$StdErrLog,
        [System.Collections.IDictionary]$Environment = $null,
        [string]$Node,
        [int]$WaitSeconds = 20,
        [switch]$AllowFallback
    )
    $runner = Join-Path (Join-Path (Get-ScriptsDir) 'tests') 'detached-run.mjs'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "找不到分离启动器：$runner" }
    if (-not $Node) { $Node = Find-NodeExe }
    if (-not $Node) { throw '找不到 node.exe，无法分离启动命令。' }
    if (-not $StdErrLog) { $StdErrLog = "$StdOutLog.err" }
    # WMI 创建进程的工作目录不是调用方目录，相对路径会写歪 → 统一绝对化
    $StdOutLog = [System.IO.Path]::GetFullPath($StdOutLog)
    $StdErrLog = [System.IO.Path]::GetFullPath($StdErrLog)
    if ($WorkingDirectory) { $WorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory) }
    foreach ($dir in @((Split-Path -Parent $StdOutLog), (Split-Path -Parent $StdErrLog))) {
        if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
    }
    $pidFile = "$StdOutLog.pid.json"
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) { Remove-Item -LiteralPath $pidFile -Force }

    $runnerArgs = @($runner, '--pidfile', $pidFile, '--out', $StdOutLog, '--err', $StdErrLog)
    if ($WorkingDirectory) { $runnerArgs += @('--cwd', $WorkingDirectory) }
    if ($Environment) {
        foreach ($key in $Environment.Keys) {
            $runnerArgs += @('--env', ([string]$key + '=' + [string]$Environment[$key]))
        }
    }
    $runnerArgs += '--'
    $runnerArgs += @($FilePath)
    $runnerArgs += @($ArgumentList)

    $cmdLine = (ConvertTo-CommandLineArgument -Value $Node) + ' ' +
    ((@($runnerArgs) | ForEach-Object { ConvertTo-CommandLineArgument -Value ([string]$_) }) -join ' ')

    $launcherPid = 0
    $launchMode = ''
    try {
        $createResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine } -ErrorAction Stop
        if ($createResult.ReturnValue -eq 0 -and $createResult.ProcessId -gt 0) {
            $launcherPid = [int]$createResult.ProcessId
            $launchMode = '分离启动（WMI Win32_Process.Create + detached-run.mjs）'
        }
    } catch {
        Write-Warn "WMI 分离启动不可用（$($_.Exception.Message)）"
    }
    if ($launcherPid -le 0 -and $AllowFallback) {
        $proc = Start-Process -FilePath $Node -ArgumentList $runnerArgs -PassThru -WindowStyle Hidden
        $launcherPid = $proc.Id
        $launchMode = 'Start-Process 回退（在捕获输出的宿主里会等到子进程退出才返回）'
    }
    if ($launcherPid -le 0) { throw "分离启动失败：无法创建启动器进程（$cmdLine）" }

    $childPid = 0
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
            try {
                $info = Read-JsonFile -Path $pidFile
                $err = [string](Get-JsonProp -Object $info -Name 'error' -Default '')
                if ($err) { throw ("分离启动器报错：$err`n  命令：$cmdLine") }
                $p = [int](Get-JsonProp -Object $info -Name 'pid' -Default 0)
                if ($p -gt 0) { $childPid = $p; break }
            } catch {
                if ($_.Exception.Message -like '分离启动器报错*') { throw }
            }
        }
        Start-Sleep -Milliseconds 150
    }
    if ($childPid -le 0) { throw "分离启动超时：$WaitSeconds 秒内未拿到子进程 PID（$cmdLine）" }

    return [pscustomobject]@{
        LauncherPid = $launcherPid
        Pid         = $childPid
        LaunchMode  = $launchMode
        CommandLine = $cmdLine
        StdOutLog   = $StdOutLog
        StdErrLog   = $StdErrLog
    }
}

# ── DSH CLI 启动器解析（契约 §8.2：旧版 bin.js 不支持 --json/--session-id）───────
#
# 事实（本机实测，2026-10）：
#   * D:\DSH\resources\runtime\cli\bin\dsh.cmd 内容形如：
#       set "ELECTRON_RUN_AS_NODE=1"
#       "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
#   * C:\Users\<用户>\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js 是**旧版 CLI**：
#     `--json` / `--session-id` 都不支持，用它做 v2 续聊必然失败。
#   所以脚本必须**探测**启动器（允许 -Launcher / DSH_LAUNCHER 覆盖），而不是硬编码盘符。

function Expand-DshCmdPath {
    <#
      展开 .cmd 里的 %~dp0（脚本所在目录）并规范化 .. 。返回绝对路径。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$CmdDir)
    $text = $Value.Replace('%~dp0', ($CmdDir.TrimEnd('\') + '\')).Replace('%~dpn0', $CmdDir)
    return [System.IO.Path]::GetFullPath($text)
}

function Find-DshLauncher {
    <#
      探测并解析 DSH CLI 启动器。返回：
        [pscustomobject]@{ Mode; Launcher; Exe; CliJs; PrefixArgs; Env; Node; LegacyBinPath; Note }
      Mode:
        'desktop-host' —— DeepSeek Harness.exe + --expose-internals cli.js + ELECTRON_RUN_AS_NODE=1（推荐，契约 §7.2/§8.2）
        'legacy-node'  —— node + 旧版 bin.js（仅 v1 兼容；--json/--session-id 不支持）
        'unknown'      —— 未探测到
      优先级：-Launcher > $env:DSH_LAUNCHER > <DSH 安装>\resources\runtime\cli\bin\dsh.cmd > PATH 里的 dsh.cmd
    #>
    [CmdletBinding()]
    param([string]$Launcher, [string]$DshRoot, [string]$Node)
    $cmdCandidates = New-Object System.Collections.ArrayList
    if ($Launcher) { [void]$cmdCandidates.Add([System.IO.Path]::GetFullPath($Launcher)) }
    if ($env:DSH_LAUNCHER) { [void]$cmdCandidates.Add([System.IO.Path]::GetFullPath($env:DSH_LAUNCHER)) }
    $root = $DshRoot
    if (-not $root) { try { $root = Find-DshRoot } catch { $root = $null } }
    if ($root) { [void]$cmdCandidates.Add((Join-Path (Join-Path (Join-Path $root 'runtime') 'cli\bin') 'dsh.cmd')) }
    foreach ($name in @('dsh.cmd', 'dsh.exe')) {
        $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found -and $found.Source) { [void]$cmdCandidates.Add($found.Source) }
    }

    foreach ($candidate in $cmdCandidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $exe = $null
        $cliJs = $null
        try {
            $text = Read-TextFileUtf8 -Path $candidate
            $cliMatch = [regex]::Match($text, '--expose-internals\s+"([^"]+)"')
            $exeMatch = [regex]::Match($text, '"([^"]+\.exe)"')
            $cmdDir = Split-Path -Parent $candidate
            if ($exeMatch.Success) { $exe = Expand-DshCmdPath -Value $exeMatch.Groups[1].Value -CmdDir $cmdDir }
            if ($cliMatch.Success) { $cliJs = Expand-DshCmdPath -Value $cliMatch.Groups[1].Value -CmdDir $cmdDir }
        } catch { }
        if ($exe -and $cliJs) {
            $env2 = @{}
            if ($text -match 'ELECTRON_RUN_AS_NODE') { $env2['ELECTRON_RUN_AS_NODE'] = '1' }
            return [pscustomobject]@{
                Mode         = 'desktop-host'
                Launcher     = $candidate
                Exe          = $exe
                CliJs        = $cliJs
                PrefixArgs   = @('--expose-internals', $cliJs)
                Env          = $env2
                Node         = $null
                LegacyBinPath = $null
                Note         = "由 $candidate 解析：可支持 --json/--session-id/--profile sdk（契约 §7.2）"
            }
        }
    }

    # 回退：旧版 node + bin.js（仅 v1 兼容）
    $legacyBin = $null
    try { $legacyBin = Find-DshBin } catch { $legacyBin = $null }
    if ($legacyBin) {
        $nodeExe = $Node
        if (-not $nodeExe) { try { $nodeExe = Find-NodeExe } catch { $nodeExe = $null } }
        return [pscustomobject]@{
            Mode          = 'legacy-node'
            Launcher      = $null
            Exe           = $nodeExe
            CliJs         = $legacyBin
            PrefixArgs    = @($legacyBin)
            Env           = @{}
            Node          = $nodeExe
            LegacyBinPath = $legacyBin
            Note          = "只找到旧版 CLI（$legacyBin）：不支持 --json/--session-id，v2 续聊会失败（契约 §8.2）。请用 -Launcher 指向 dsh.cmd。"
        }
    }
    return [pscustomobject]@{
        Mode          = 'unknown'
        Launcher      = $null
        Exe           = $null
        CliJs         = $null
        PrefixArgs    = @()
        Env           = @{}
        Node          = $null
        LegacyBinPath = $null
        Note          = '未探测到 DSH 启动器（dsh.cmd / dsh.exe）。'
    }
}

function Test-LegacyDshBinPath {
    <#
      判断一个路径是否是契约 §8.2 里那类「旧版 CLI」（profiles\node_modules\@deepseek-ai\dsh\lib\bin.js）。
    #>
    [CmdletBinding()]
    param([string]$Path)
    if (-not $Path) { return $false }
    return ($Path -match '(?i)profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js$')
}
