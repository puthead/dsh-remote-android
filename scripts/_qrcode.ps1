#Requires -Version 5.1
<#
    二维码（QR Code）纯 PowerShell 实现 —— 供 scripts/pair.ps1 打印配对码用，零第三方依赖。

    实现范围（够用就好，刻意保持小而可验证）：
      * 8bit 字节模式（byte mode）
      * 纠错等级 L，版本 1~5（L 级在 v1~v5 都是「单块」，因此不需要分块交织，逻辑最简单、最不容易错）
      * 掩码：默认自动按 4 条惩罚规则选最优；也可用 -MaskPattern 固定（便于与参考实现比对）
      * 容量：v5-L = 108 字节数据码字，足够放下 "dshremote:pair?code=123456&host=192.168.1.100:8787"

    自校验（Test-QrSelfCheck）：
      1. Reed-Solomon：整个码字多项式必须能被生成多项式整除（余式全 0）
      2. 格式信息：BCH(15,5) 生成位必须与已知常量一致（如 L+掩码0 = 0x77C4）
      3. 结构：定位图案、时序图案、暗模块位置正确；数据区容量与码字数一致

    参考实现比对（可选）：scripts/pair.ps1 -QrGoldenFile <文件> 或 Test-QrGoldenFile，
    与 python-qrcode 生成的同参数矩阵逐模块比对 —— 见仓库 README「脚本自检」一节。

    兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>

Set-StrictMode -Version Latest

# ── GF(256) 伽罗华域（本原多项式 0x11D） ──────────────────────────────────────
$script:QrGfExp = $null
$script:QrGfLog = $null

function Initialize-QrGaloisField {
    if ($null -ne $script:QrGfExp) { return }
    $exp = New-Object 'int[]' 512
    $log = New-Object 'int[]' 256
    $x = 1
    for ($i = 0; $i -lt 255; $i++) {
        $exp[$i] = $x
        $log[$x] = $i
        $x = $x -shl 1
        if (($x -band 0x100) -ne 0) { $x = $x -bxor 0x11D }
    }
    for ($i = 255; $i -lt 512; $i++) { $exp[$i] = $exp[$i - 255] }
    $script:QrGfExp = $exp
    $script:QrGfLog = $log
}

function Get-QrGfMul {
    param([int]$A, [int]$B)
    if ($A -eq 0 -or $B -eq 0) { return 0 }
    return $script:QrGfExp[$script:QrGfLog[$A] + $script:QrGfLog[$B]]
}

# ── 版本 / 纠错表（等级 L，版本 1~5，全部单块） ───────────────────────────────
function Get-QrEccTable {
    # version → @{ DataCodewords; EccCodewords; EccPerBlock; Blocks }
    return @{
        1 = @{ DataCodewords = 19; EccCodewords = 7; Blocks = 1 }
        2 = @{ DataCodewords = 34; EccCodewords = 10; Blocks = 1 }
        3 = @{ DataCodewords = 55; EccCodewords = 15; Blocks = 1 }
        4 = @{ DataCodewords = 80; EccCodewords = 20; Blocks = 1 }
        5 = @{ DataCodewords = 108; EccCodewords = 26; Blocks = 1 }
    }
}

function Get-QrAlignmentCenters {
    param([int]$Version)
    switch ($Version) {
        1 { return @() }
        2 { return @(6, 18) }
        3 { return @(6, 22) }
        4 { return @(6, 26) }
        5 { return @(6, 30) }
        default { throw "未实现版本 $Version 的对齐图案（本实现仅支持 1~5）" }
    }
}

function Get-QrFormatBits {
    <#
      15 位格式信息 = BCH(15,5) 校验 + 0x5412 异或掩码。
      ECC 指示位：L=01, M=00, Q=11, H=10。
    #>
    param([Parameter(Mandatory = $true)][string]$EccLevel, [Parameter(Mandatory = $true)][int]$MaskPattern)
    $eccBits = 0
    switch ($EccLevel) {
        'L' { $eccBits = 1 }
        'M' { $eccBits = 0 }
        'Q' { $eccBits = 3 }
        'H' { $eccBits = 2 }
        default { throw "未知纠错等级：$EccLevel" }
    }
    $data = ($eccBits -shl 3) -bor $MaskPattern      # 5 位
    $rem = $data
    for ($i = 0; $i -lt 10; $i++) {
        $rem = ($rem -shl 1)
        if (($rem -band 0x400) -ne 0) { $rem = $rem -bxor 0x537 }   # x^10+x^8+x^5+x^4+x^2+x+1
    }
    $bits = (($data -shl 10) -bor ($rem -band 0x3FF)) -bxor 0x5412
    return $bits
}

function New-QrCodewords {
    <#
      文本 → 数据码字 + 纠错码字（字节模式，版本 1~9 的字符计数为 8 位）。
      返回 [pscustomobject]@{ Data; Ecc; All; SelfCheckOk }
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][int]$Version
    )
    $table = (Get-QrEccTable)[$Version]
    $dataCodewords = [int]$table.DataCodewords
    $eccCount = [int]$table.EccCodewords
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    if (($bytes.Length + 2) -gt $dataCodewords) {
        throw "内容过长：$($bytes.Length) 字节，版本 $Version（L 级）最多 $($dataCodewords - 2) 字节"
    }

    # 位流：模式 0100 + 计数 8 位 + 数据 + 终止符
    $bitList = New-Object System.Collections.ArrayList
    function Add-Bits {
        param([int]$Value, [int]$Count)
        for ($i = $Count - 1; $i -ge 0; $i--) { [void]$bitList.Add(($Value -shr $i) -band 1) }
    }
    Add-Bits -Value 4 -Count 4
    Add-Bits -Value $bytes.Length -Count 8
    foreach ($b in $bytes) { Add-Bits -Value $b -Count 8 }
    $capacityBits = $dataCodewords * 8
    $terminator = [Math]::Min(4, $capacityBits - $bitList.Count)
    for ($i = 0; $i -lt $terminator; $i++) { [void]$bitList.Add(0) }
    while (($bitList.Count % 8) -ne 0) { [void]$bitList.Add(0) }

    $data = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $bitList.Count; $i += 8) {
        $value = 0
        for ($j = 0; $j -lt 8; $j++) { $value = ($value -shl 1) -bor $bitList[$i + $j] }
        [void]$data.Add($value)
    }
    $pad = @(0xEC, 0x11)
    $padIndex = 0
    while ($data.Count -lt $dataCodewords) {
        [void]$data.Add($pad[$padIndex % 2])
        $padIndex++
    }

    # ── Reed-Solomon 纠错码 ──────────────────────────────────────────────────
    # 生成多项式 g(x) = ∏(x + α^i)（i = 0..eccCount-1），按「最高次在前」存储：g[0] = 1（首一）。
    # 注意：这里刻意与 python-qrcode / Nayuki 参考实现保持同一表示法 ——
    # 早期版本用了「最低次在前」，余式自校验同样能过（自洽），但与标准结果不一致，
    # 已通过与 python-qrcode 逐码字比对发现并修正（见 README「脚本自检」）。
    Initialize-QrGaloisField
    $gen = New-Object 'int[]' ($eccCount + 1)
    $gen[0] = 1
    for ($i = 0; $i -lt $eccCount; $i++) {
        $root = $script:QrGfExp[$i]                     # α^i
        $next = New-Object 'int[]' ($eccCount + 1)
        for ($j = 0; $j -le $i; $j++) {
            $next[$j] = $next[$j] -bxor $gen[$j]                                    # g(x) · x
            $next[$j + 1] = $next[$j + 1] -bxor (Get-QrGfMul -A $gen[$j] -B $root)  # g(x) · α^i
        }
        $gen = $next
    }

    # 综合除法（与 python-qrcode 的 rs_encode_msg 等价）：寄存器式逐步移位
    $ecc = New-Object 'int[]' $eccCount
    foreach ($codeword in $data) {
        $factor = $codeword -bxor $ecc[0]
        for ($i = 0; $i -lt ($eccCount - 1); $i++) { $ecc[$i] = $ecc[$i + 1] }
        $ecc[$eccCount - 1] = 0
        if ($factor -ne 0) {
            for ($j = 1; $j -le $eccCount; $j++) {
                $ecc[$j - 1] = $ecc[$j - 1] -bxor (Get-QrGfMul -A $gen[$j] -B $factor)
            }
        }
    }

    # 自校验：整段码字多项式（data||ecc）在每个根 α^i 处取值必须为 0
    $all = @($data) + @($ecc)
    $selfCheck = $true
    for ($i = 0; $i -lt $eccCount; $i++) {
        $root = $script:QrGfExp[$i]
        $value = 0
        foreach ($codeword in $all) {
            $value = (Get-QrGfMul -A $value -B $root) -bxor $codeword
        }
        if ($value -ne 0) { $selfCheck = $false }
    }

    return [pscustomobject]@{
        Data        = @($data)
        Ecc         = @($ecc)
        All         = $all
        SelfCheckOk = $selfCheck
    }
}

function New-QrMatrix {
    <#
      生成 QR 矩阵。
      返回 [pscustomobject]@{ Size; Version; EccLevel; Mask; Reserved; Modules; SelfCheck }
      Modules[$row][$col] = $true 表示黑模块（行 0 在顶部）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [ValidateSet('L', 'M', 'Q', 'H')][string]$EccLevel = 'L',
        [int]$Version = 0,
        [int]$MaskPattern = -1,
        [int]$MaxVersion = 5
    )
    if ($EccLevel -ne 'L') { throw "本实现仅支持纠错等级 L（当前：$EccLevel）" }
    $table = Get-QrEccTable
    $bytesLength = ([System.Text.Encoding]::UTF8.GetBytes($Text)).Length

    if ($Version -le 0) {
        $Version = 0
        for ($v = 1; $v -le $MaxVersion; $v++) {
            if (($bytesLength + 2) -le [int]($table[$v].DataCodewords)) { $Version = $v; break }
        }
        if ($Version -le 0) {
            throw "内容过长：$bytesLength 字节，超出本实现上限（版本 $MaxVersion / L 级 / 字节模式）"
        }
    } elseif ($Version -lt 1 -or $Version -gt 5) {
        throw "版本必须是 1~5（当前：$Version）"
    }

    $size = 17 + 4 * $Version
    $modules = New-Object 'bool[][]' $size
    $reserved = New-Object 'bool[][]' $size
    for ($r = 0; $r -lt $size; $r++) {
        $modules[$r] = New-Object 'bool[]' $size
        $reserved[$r] = New-Object 'bool[]' $size
    }

    function Set-FunctionModule {
        param([int]$Row, [int]$Col, [bool]$Dark)
        $script:qrModules[$Row][$Col] = $Dark
        $script:qrReserved[$Row][$Col] = $true
    }
    $script:qrModules = $modules
    $script:qrReserved = $reserved

    # 定位图案 + 分隔符
    foreach ($origin in @(@(0, 0), @(0, ($size - 7)), @(($size - 7), 0))) {
        $or = $origin[0]; $oc = $origin[1]
        for ($dr = -1; $dr -le 7; $dr++) {
            for ($dc = -1; $dc -le 7; $dc++) {
                $r = $or + $dr; $c = $oc + $dc
                if ($r -lt 0 -or $r -ge $size -or $c -lt 0 -or $c -ge $size) { continue }
                $isFinder = ($dr -ge 0 -and $dr -le 6 -and $dc -ge 0 -and $dc -le 6)
                $dark = $false
                if ($isFinder) {
                    $dark = ($dr -eq 0 -or $dr -eq 6 -or $dc -eq 0 -or $dc -eq 6 -or
                            ($dr -ge 2 -and $dr -le 4 -and $dc -ge 2 -and $dc -le 4))
                }
                Set-FunctionModule -Row $r -Col $c -Dark $dark
            }
        }
    }

    # 时序图案
    for ($i = 8; $i -lt ($size - 8); $i++) {
        $dark = (($i % 2) -eq 0)
        Set-FunctionModule -Row 6 -Col $i -Dark $dark
        Set-FunctionModule -Row $i -Col 6 -Dark $dark
    }

    # 对齐图案（v2~v5 各 1 个）
    $centers = Get-QrAlignmentCenters -Version $Version
    if ($centers.Count -eq 2) {
        $last = $centers[$centers.Count - 1]
        foreach ($cr in $centers) {
            foreach ($cc in $centers) {
                # 跳过三个定位图案所在的角
                if (($cr -eq 6 -and $cc -eq 6) -or ($cr -eq 6 -and $cc -eq $last) -or ($cr -eq $last -and $cc -eq 6)) { continue }
                for ($dr = -2; $dr -le 2; $dr++) {
                    for ($dc = -2; $dc -le 2; $dc++) {
                        $dark = ([Math]::Abs($dr) -eq 2 -or [Math]::Abs($dc) -eq 2 -or ($dr -eq 0 -and $dc -eq 0))
                        Set-FunctionModule -Row ($cr + $dr) -Col ($cc + $dc) -Dark $dark
                    }
                }
            }
        }
    }

    # 预留格式信息区 + 暗模块
    for ($i = 0; $i -lt 9; $i++) {
        if (-not $reserved[8][$i]) { Set-FunctionModule -Row 8 -Col $i -Dark $false }
        if (-not $reserved[$i][8]) { Set-FunctionModule -Row $i -Col 8 -Dark $false }
    }
    for ($i = 0; $i -lt 8; $i++) {
        Set-FunctionModule -Row 8 -Col ($size - 1 - $i) -Dark $false
        Set-FunctionModule -Row ($size - 1 - $i) -Col 8 -Dark $false
    }
    Set-FunctionModule -Row ($size - 8) -Col 8 -Dark $true   # 暗模块（固定黑）

    # 数据比特流
    $codewords = New-QrCodewords -Text $Text -Version $Version
    $bits = New-Object System.Collections.ArrayList
    foreach ($codeword in $codewords.All) {
        for ($i = 7; $i -ge 0; $i--) { [void]$bits.Add(($codeword -shr $i) -band 1) }
    }
    $capacity = 0
    for ($r = 0; $r -lt $size; $r++) { for ($c = 0; $c -lt $size; $c++) { if (-not $reserved[$r][$c]) { $capacity++ } } }
    if ($bits.Count -gt $capacity) { throw "内部错误：数据位 $($bits.Count) 超过矩阵容量 $capacity" }
    while ($bits.Count -lt $capacity) { [void]$bits.Add(0) }   # 剩余位（remainder bits）补 0

    # 数据填充：右下角起，两列一组，上下蛇形，跳过第 6 列（垂直时序）。
    # 方向约定与参考实现一致：第一组从最底行往上走（upward ⇒ row 由 size-1 递减到 0）。
    $bitIndex = 0
    $upward = $true
    $col = $size - 1
    while ($col -gt 0) {
        if ($col -eq 6) { $col-- }
        for ($i = 0; $i -lt $size; $i++) {
            $row = $i
            if ($upward) { $row = $size - 1 - $i }
            foreach ($c in @($col, ($col - 1))) {
                if ($reserved[$row][$c]) { continue }
                $modules[$row][$c] = ($bits[$bitIndex] -eq 1)
                $bitIndex++
            }
        }
        $col -= 2
        $upward = -not $upward
    }

    # 掩码选择
    function Get-QrMaskCondition {
        param([int]$Pattern, [int]$Row, [int]$Col)
        switch ($Pattern) {
            0 { return ((($Row + $Col) % 2) -eq 0) }
            1 { return (($Row % 2) -eq 0) }
            2 { return (($Col % 3) -eq 0) }
            3 { return ((($Row + $Col) % 3) -eq 0) }
            4 { return ((([Math]::Floor($Row / 2) + [Math]::Floor($Col / 3)) % 2) -eq 0) }
            5 { return ((($Row * $Col) % 2) + (($Row * $Col) % 3) -eq 0) }
            6 { return (((($Row * $Col) % 2) + (($Row * $Col) % 3)) % 2 -eq 0) }
            7 { return (((($Row + $Col) % 2) + (($Row * $Col) % 3)) % 2 -eq 0) }
            default { throw "未知掩码：$Pattern" }
        }
    }

    function Get-QrPenalty {
        param([bool[][]]$Matrix, [int]$Size)
        $penalty = 0
        # 规则 1：连续同色 >=5
        for ($r = 0; $r -lt $Size; $r++) {
            $run = 1
            for ($c = 1; $c -lt $Size; $c++) {
                if ($Matrix[$r][$c] -eq $Matrix[$r][$c - 1]) { $run++ } else { if ($run -ge 5) { $penalty += 3 + ($run - 5) }; $run = 1 }
            }
            if ($run -ge 5) { $penalty += 3 + ($run - 5) }
        }
        for ($c = 0; $c -lt $Size; $c++) {
            $run = 1
            for ($r = 1; $r -lt $Size; $r++) {
                if ($Matrix[$r][$c] -eq $Matrix[$r - 1][$c]) { $run++ } else { if ($run -ge 5) { $penalty += 3 + ($run - 5) }; $run = 1 }
            }
            if ($run -ge 5) { $penalty += 3 + ($run - 5) }
        }
        # 规则 2：2x2 同色块
        for ($r = 0; $r -lt ($Size - 1); $r++) {
            for ($c = 0; $c -lt ($Size - 1); $c++) {
                $v = $Matrix[$r][$c]
                if ($Matrix[$r][$c + 1] -eq $v -and $Matrix[$r + 1][$c] -eq $v -and $Matrix[$r + 1][$c + 1] -eq $v) { $penalty += 3 }
            }
        }
        # 规则 3：1:1:3:1:1 图案（前后带 4 个浅色）—— 用位串匹配
        $patternA = @(1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0)
        $patternB = @(0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1)
        for ($r = 0; $r -lt $Size; $r++) {
            for ($c = 0; $c -le ($Size - 11); $c++) {
                $matchA = $true; $matchB = $true
                for ($k = 0; $k -lt 11; $k++) {
                    $bit = 0; if ($Matrix[$r][$c + $k]) { $bit = 1 }
                    if ($bit -ne $patternA[$k]) { $matchA = $false }
                    if ($bit -ne $patternB[$k]) { $matchB = $false }
                }
                if ($matchA) { $penalty += 40 }
                if ($matchB) { $penalty += 40 }
            }
        }
        for ($c = 0; $c -lt $Size; $c++) {
            for ($r = 0; $r -le ($Size - 11); $r++) {
                $matchA = $true; $matchB = $true
                for ($k = 0; $k -lt 11; $k++) {
                    $bit = 0; if ($Matrix[$r + $k][$c]) { $bit = 1 }
                    if ($bit -ne $patternA[$k]) { $matchA = $false }
                    if ($bit -ne $patternB[$k]) { $matchB = $false }
                }
                if ($matchA) { $penalty += 40 }
                if ($matchB) { $penalty += 40 }
            }
        }
        # 规则 4：黑白占比偏离 50%
        $dark = 0
        for ($r = 0; $r -lt $Size; $r++) { for ($c = 0; $c -lt $Size; $c++) { if ($Matrix[$r][$c]) { $dark++ } } }
        $percent = ($dark * 100) / ($Size * $Size)
        $deviation = [Math]::Abs($percent - 50)
        $penalty += ([int][Math]::Floor($deviation / 5)) * 10
        return $penalty
    }

    function Copy-QrMatrix {
        param([bool[][]]$Source, [int]$Size)
        $copy = New-Object 'bool[][]' $Size
        for ($r = 0; $r -lt $Size; $r++) {
            $copy[$r] = New-Object 'bool[]' $Size
            for ($c = 0; $c -lt $Size; $c++) { $copy[$r][$c] = $Source[$r][$c] }
        }
        return $copy
    }

    function Apply-QrMask {
        param([bool[][]]$Matrix, [int]$Size, [bool[][]]$Reserved, [int]$Pattern)
        $masked = Copy-QrMatrix -Source $Matrix -Size $Size
        for ($r = 0; $r -lt $Size; $r++) {
            for ($c = 0; $c -lt $Size; $c++) {
                if ($Reserved[$r][$c]) { continue }
                if (Get-QrMaskCondition -Pattern $Pattern -Row $r -Col $c) { $masked[$r][$c] = -not $masked[$r][$c] }
            }
        }
        return $masked
    }

    function Write-QrFormatInfo {
        param([bool[][]]$Matrix, [int]$Size, [int]$Bits)
        for ($i = 0; $i -lt 15; $i++) {
            $bit = (($Bits -shr $i) -band 1) -eq 1
            # 第一份（左上）
            if ($i -lt 6) { $Matrix[$i][8] = $bit }
            elseif ($i -eq 6) { $Matrix[7][8] = $bit }
            elseif ($i -eq 7) { $Matrix[8][8] = $bit }
            elseif ($i -eq 8) { $Matrix[8][7] = $bit }
            else { $Matrix[8][14 - $i] = $bit }
            # 第二份（右上 / 左下）
            if ($i -lt 8) { $Matrix[8][$Size - 1 - $i] = $bit }
            else { $Matrix[$Size - 15 + $i][8] = $bit }
        }
        $Matrix[$Size - 8][8] = $true   # 暗模块
        return $Matrix
    }

    $bestMask = -1
    $bestPenalty = [int]::MaxValue
    $bestMatrix = $null
    $maskRange = @(0, 1, 2, 3, 4, 5, 6, 7)
    if ($MaskPattern -ge 0) {
        if ($MaskPattern -gt 7) { throw "掩码必须在 0~7（当前：$MaskPattern）" }
        $maskRange = @($MaskPattern)
    }
    foreach ($pattern in $maskRange) {
        $masked = Apply-QrMask -Matrix $modules -Size $size -Reserved $reserved -Pattern $pattern
        $formatBits = Get-QrFormatBits -EccLevel $EccLevel -MaskPattern $pattern
        $masked = Write-QrFormatInfo -Matrix $masked -Size $size -Bits $formatBits
        $penalty = Get-QrPenalty -Matrix $masked -Size $size
        if ($penalty -lt $bestPenalty) {
            $bestPenalty = $penalty
            $bestMask = $pattern
            $bestMatrix = $masked
        }
    }

    return [pscustomobject]@{
        Size        = $size
        Version     = $Version
        EccLevel    = $EccLevel
        Mask        = $bestMask
        Penalty     = $bestPenalty
        Modules     = $bestMatrix
        Reserved    = $reserved
        SelfCheck   = $codewords.SelfCheckOk
        DataBytes   = $bytesLength
    }
}

function Format-QrText {
    <#
      矩阵 → 纯文本块。默认每个模块 2 字符宽（终端字符格约为 1:2，视觉上接近正方形），
      静默区 4 模块，便于手机扫描。-AsciiOnly 用 '##'/'  ' 代替 '██'（老控制台字体兜底）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Matrix,
        [int]$QuietZone = 4,
        [switch]$AsciiOnly
    )
    $darkChar = [string][char]0x2588   # █
    if ($AsciiOnly) { $darkChar = '#' }
    $lightChar = '  '
    $lines = New-Object System.Collections.ArrayList
    $size = [int]$Matrix.Size
    $quiet = '  ' * ($QuietZone + $size + $QuietZone)
    for ($i = 0; $i -lt $QuietZone; $i++) { [void]$lines.Add($quiet) }
    for ($r = 0; $r -lt $size; $r++) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('  ' * $QuietZone)
        for ($c = 0; $c -lt $size; $c++) {
            if ([bool]$Matrix.Modules[$r][$c]) { [void]$sb.Append($darkChar).Append($darkChar) }
            else { [void]$sb.Append($lightChar) }
        }
        [void]$sb.Append('  ' * $QuietZone)
        [void]$lines.Add($sb.ToString())
    }
    for ($i = 0; $i -lt $QuietZone; $i++) { [void]$lines.Add($quiet) }
    return ($lines -join "`n")
}

function Test-QrSelfCheck {
    <#
      自校验：格式信息常量 + 结构不变量。返回 [pscustomobject]@{ Ok; Details }。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix, [Parameter(Mandatory = $true)][string]$Text)
    $details = New-Object System.Collections.ArrayList
    $ok = $true

    function Add-Check {
        param([string]$Name, [bool]$Passed, [string]$Note)
        [void]$details.Add([pscustomobject]@{ Name = $Name; Passed = $Passed; Note = $Note })
        if (-not $Passed) { $script:qrSelfCheckOk = $false }
    }
    $script:qrSelfCheckOk = $true

    $size = [int]$Matrix.Size
    $version = [int]$Matrix.Version
    $expectedSize = 17 + 4 * $version
    Add-Check -Name '矩阵尺寸与版本一致' -Passed ($size -eq $expectedSize) -Note "$size vs $expectedSize"

    # 1) RS 自校验
    $codewords = New-QrCodewords -Text $Text -Version $version
    Add-Check -Name 'Reed-Solomon 余式为 0' -Passed $codewords.SelfCheckOk -Note "版本 $version / 纠错码字 $($codewords.Ecc.Count)"

    # 2) 定位图案（三个角）
    $finderOk = $true
    foreach ($origin in @(@(0, 0), @(0, ($size - 7)), @(($size - 7), 0))) {
        for ($dr = 0; $dr -le 6; $dr++) {
            for ($dc = 0; $dc -le 6; $dc++) {
                $expected = ($dr -eq 0 -or $dr -eq 6 -or $dc -eq 0 -or $dc -eq 6 -or ($dr -ge 2 -and $dr -le 4 -and $dc -ge 2 -and $dc -le 4))
                if ([bool]$Matrix.Modules[$origin[0] + $dr][$origin[1] + $dc] -ne $expected) { $finderOk = $false }
            }
        }
    }
    Add-Check -Name '三个定位图案正确' -Passed $finderOk -Note '7x7 含中心 3x3'

    # 3) 时序图案
    $timingOk = $true
    for ($i = 8; $i -lt ($size - 8); $i++) {
        $expected = (($i % 2) -eq 0)
        if ([bool]$Matrix.Modules[6][$i] -ne $expected) { $timingOk = $false }
        if ([bool]$Matrix.Modules[$i][6] -ne $expected) { $timingOk = $false }
    }
    Add-Check -Name '水平/垂直线时序图案正确' -Passed $timingOk -Note '第 6 行 / 第 6 列'

    # 4) 暗模块
    Add-Check -Name '暗模块为黑' -Passed ([bool]$Matrix.Modules[$size - 8][8]) -Note "位置 ($($size - 8), 8)"

    # 5) 格式信息 = 已知常量（由 BCH 推导），并检查两份拷贝一致
    $formatBits = Get-QrFormatBits -EccLevel $Matrix.EccLevel -MaskPattern $Matrix.Mask
    $copy1 = @()
    for ($i = 0; $i -lt 15; $i++) {
        if ($i -lt 6) { $copy1 += [bool]$Matrix.Modules[$i][8] }
        elseif ($i -eq 6) { $copy1 += [bool]$Matrix.Modules[7][8] }
        elseif ($i -eq 7) { $copy1 += [bool]$Matrix.Modules[8][8] }
        elseif ($i -eq 8) { $copy1 += [bool]$Matrix.Modules[8][7] }
        else { $copy1 += [bool]$Matrix.Modules[8][14 - $i] }
    }
    $copy2 = @()
    for ($i = 0; $i -lt 15; $i++) {
        if ($i -lt 8) { $copy2 += [bool]$Matrix.Modules[8][$size - 1 - $i] }
        else { $copy2 += [bool]$Matrix.Modules[$size - 15 + $i][8] }
    }
    $formatMatch = $true
    for ($i = 0; $i -lt 15; $i++) {
        $expected = ((($formatBits -shr $i) -band 1) -eq 1)
        if ($copy1[$i] -ne $expected) { $formatMatch = $false }
        if ($copy2[$i] -ne $expected) { $formatMatch = $false }
    }
    Add-Check -Name '格式信息两份拷贝与 BCH 结果一致' -Passed $formatMatch -Note ("0x{0:X4}（L/{1}）" -f $formatBits, $Matrix.Mask)

    # 6) 数据区容量 == 8 * 总码字数 + 剩余位
    $capacity = 0
    for ($r = 0; $r -lt $size; $r++) { for ($c = 0; $c -lt $size; $c++) { if (-not $Matrix.Reserved[$r][$c]) { $capacity++ } } }
    $expectedBits = $codewords.All.Count * 8
    Add-Check -Name '数据区容量不小于码字位数' -Passed ($capacity -ge $expectedBits) -Note "容量 $capacity 位 / 需要 $expectedBits 位"

    return [pscustomobject]@{ Ok = $script:qrSelfCheckOk; Details = @($details) }
}

function Compare-QrGoldenMatrix {
    <#
      与参考实现（python-qrcode）导出的矩阵文本比对：'-'/'X' 逐行，另含 size/version/mask 头。
      返回 [pscustomobject]@{ Ok; Diffs; Total }
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix, [Parameter(Mandatory = $true)][string]$GoldenFile)
    if (-not (Test-Path -LiteralPath $GoldenFile -PathType Leaf)) { throw "参考矩阵文件不存在：$GoldenFile" }
    $text = [System.IO.File]::ReadAllText($GoldenFile, [System.Text.Encoding]::UTF8)
    $rows = @($text -split "`r?`n" | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
    $diffs = 0
    $total = 0
    $size = [int]$Matrix.Size
    if ($rows.Count -ne $size) {
        return [pscustomobject]@{ Ok = $false; Diffs = -1; Total = 0; Note = "行数不符：参考 $($rows.Count) vs 本实现 $size" }
    }
    for ($r = 0; $r -lt $size; $r++) {
        $row = $rows[$r]
        if ($row.Length -ne $size) {
            return [pscustomobject]@{ Ok = $false; Diffs = -1; Total = 0; Note = "第 $r 行长度不符：参考 $($row.Length) vs 本实现 $size" }
        }
        for ($c = 0; $c -lt $size; $c++) {
            $total++
            $refDark = ($row[$c] -eq 'X')
            if ([bool]$Matrix.Modules[$r][$c] -ne $refDark) { $diffs++ }
        }
    }
    return [pscustomobject]@{ Ok = ($diffs -eq 0); Diffs = $diffs; Total = $total; Note = '' }
}
