#Requires -Version 5.1
<#
.SYNOPSIS
  一键部署中继到公网 VPS（Linux systemd 为主，Windows 服务给命令说明）；支持 -DryRun 只打印将执行的命令。

.DESCRIPTION
  为什么要有 -DryRun：
    早期交付环境**没有公网 VPS**，无法真跑一遍。因此部署脚本必须能：
      1. 完整打印「上传 — 初始化 — 装服务 — 启动 — 验证」每一步的真实命令（ssh/scp/systemctl/curl）；
      2. 把同一份命令写成可复制粘贴的 shell 脚本落到证据目录；
      3. 在没有 ssh/scp/sshpass 的机器上明确报错并给出手工步骤。
    公网形态已于 2026-10-13 在真实 VPS（Ubuntu 26.04 + Let's Encrypt IP 证书 + 端口 80）上实测通过，
    证据见 .runtime/acceptance/relay-public-e2e-20261013-210842 与 relay-deploy-20261013-210444。

  本脚本修过的 5 个真实缺陷（2026-10-13 实测暴露）：
    1. systemd unit 缺 `AmbientCapabilities=CAP_NET_BIND_SERVICE` → 非 root 服务绑不了 80；
    2. 远端不创建服务账号 `dsh-relay` → unit 的 User= 让服务起不来；
    3. `-TlsMode file` 不把 `--cert/--key` 传给远端 init → 生产形态必然报「必须同时提供 tls.certFile 与 tls.keyFile」；
    4. 公网健康校验把 `-PublicUrl wss://…` 拼成 `https://wss://…/health`，且没端口时默认 443 会挂很久；
    5. 打包用 `tar --exclude` 在 Windows tar.exe 上报 `Couldn't visit directory`（改为先复制干净源码再整目录打包）。

  -DryRun 之外的真实执行流程：
    A. 本地打包   tar -czf dsh-relay-<stamp>.tgz -C tools dsh-relay（排除测试与临时文件）
    B. scp 上传   压缩包 → <RemoteDir>/../dsh-relay-<stamp>.tgz ；systemd unit → /tmp/
    C. ssh 初始化 解包 → node relay.mjs init --home <RemoteDir> --force --tls-mode ... --relay-secret ...
    D. ssh 装服务 安装 unit → systemctl daemon-reload → enable --now dsh-relay
    E. 远端验证   curl -s http://127.0.0.1:<port>/health（tls 时 https -k）
    F. 本机验证   GET <PublicUrl>/health（自签时用 -Insecure）

.PARAMETER SshHost
  公网 VPS 主机名/地址（参数名用 -Host，内部变量名是 $SshHost —— $Host 是 PowerShell 只读自动变量）。

.PARAMETER Password
  密码登录需要远端/本地有 sshpass（Linux/macOS）或 plink/pscp（Windows）。本机若都没有 → 明确报错并给手工步骤。
  生产建议用 -KeyFile（免密）。

.EXAMPLE
  # 只打印命令（本轮交付的证据方式）
  powershell -File scripts/deploy-relay.ps1 -Host relay.example.com -User ops -KeyFile "$env:USERPROFILE\.ssh\id_ed25519" -PublicUrl relay.example.com -DryRun

.EXAMPLE
  powershell -File scripts/deploy-relay.ps1 -Host 203.0.113.10 -User root -KeyFile C:\keys\vps.pem -RelayName relay.example.com

.EXAMPLE
  # 本次实测形态：公网 IP + Let's Encrypt IP 地址证书（6 天有效期）+ 直接监听 80 端口
  #   证书先签好：certbot certonly --preferred-profile shortlived --standalone --ip-address 203.0.113.10
  #   -LetsEncryptCertName 会让脚本把证书同步进运行目录、装续期钩子（pre/renew/post），
  #   否则 6 天后证书过期，手机侧（只信任系统信任链）会全部连不上。
  powershell -File scripts/deploy-relay.ps1 -Host 203.0.113.10 -User ubuntu -KeyFile C:\keys\vps.pem `
    -RemotePort 80 -TlsMode file -LetsEncryptCertName 203.0.113.10 -PublicUrl wss://203.0.113.10:80

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1。
#>
[CmdletBinding()]
param(
    [Alias('Host')][string]$SshHost,
    [string]$User = 'root',
    [int]$SshPort = 22,
    [string]$KeyFile,
    [string]$Password,
    [string]$RemoteDir = '/opt/dsh-relay',
    [int]$RemotePort = 9443,
    [string]$BindHost = '0.0.0.0',
    [string]$RelayName,
    [ValidateSet('off', 'selfsigned', 'file')][string]$TlsMode = 'selfsigned',
    [string]$RelaySecret,
    [string]$PublicUrl,
    [string]$CommonName,
    [string]$TlsCertFile,
    [string]$TlsKeyFile,
    [string]$LetsEncryptCertName,
    [ValidateSet('Linux', 'Windows')][string]$Target = 'Linux',
    [string]$ServiceUser = 'dsh-relay',
    [string]$RemoteNode = 'node',
    [string]$SshExe,
    [string]$ScpExe,
    [string]$SshPassExe,
    [string]$RelayDir,
    [string]$StagingDir,
    [switch]$DryRun,
    [switch]$SkipLocalPrepare,
    [switch]$Insecure,
    [int]$TimeoutSec = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-relay 公网部署（deploy-relay.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition) + " / 目标 " + $Target)

if (-not $SshHost) { throw '必须指定 -Host <公网 VPS 主机名或 IP>。' }
if (-not (Test-RelaySourceReady -RelayDir $RelayDir)) {
    if (-not $DryRun) { [void](Assert-RelaySource -RelayDir $RelayDir) }
    Write-Warn ("中继源码尚未实现：找不到 " + (Get-RelayEntryPath -RelayDir $RelayDir) + "（-DryRun 仍可打印部署命令）")
}
if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
if (-not $RelayName) { $RelayName = $SshHost }

# ── -PublicUrl 归一化 ─────────────────────────────────────────────────────────
# 允许三种写法：wss://host[:port]、https://host[:port]、裸 host[:port]
#   * 隧道地址（写进 relay 配置的 publicUrl）统一成 ws(s)://host:port；
#   * 健康校验另用 http(s)://host:port/health —— 早期版本直接把 $PublicUrl 当主机名拼，
#     传入 wss:// 时会拼出 https://wss://…/health 这种废 URL（真缺陷，已修）。
#   * 没写端口时补 -RemotePort：默认走 443 会让校验挂上百秒（公网 443 常常没放行）。
$publicRaw = $PublicUrl
$publicSchemeIn = ''
if ($publicRaw -and $publicRaw -match '^(?<s>[A-Za-z][A-Za-z0-9+.\-]*)://(?<rest>.+)$') {
    $publicSchemeIn = $Matches['s'].ToLowerInvariant()
    $publicRaw = $Matches['rest']
}
if (-not $publicRaw) { $publicRaw = $RelayName }
$publicRaw = ($publicRaw -split '/')[0]                       # 去掉路径
$publicRaw = $publicRaw.TrimEnd(':')
if ($publicRaw -notmatch ':\d+$') { $publicRaw = "$publicRaw`:$RemotePort" }
$publicHostPort = $publicRaw
if ($publicSchemeIn -in @('wss', 'ws')) { $tunnelScheme = $publicSchemeIn }
elseif ($TlsMode -eq 'off') { $tunnelScheme = 'ws' }
else { $tunnelScheme = 'wss' }
$PublicUrl = "$tunnelScheme`://$publicHostPort"
if ($publicSchemeIn -in @('https', 'wss')) { $publicHealthScheme = 'https' }
elseif ($publicSchemeIn -in @('http', 'ws')) { $publicHealthScheme = 'http' }
elseif ($TlsMode -eq 'off') { $publicHealthScheme = 'http' }
else { $publicHealthScheme = 'https' }

# tls.mode=file 必须真的把证书路径交给远端 init（早期版本漏传，导致生产形态必然失败）
if ($TlsMode -eq 'file' -and -not $LetsEncryptCertName -and -not ($TlsCertFile -and $TlsKeyFile)) {
    throw 'tls.mode=file 需要证书：请给 -TlsCertFile 与 -TlsKeyFile（**远端**路径，例如 /opt/dsh-relay/tls/relay.crt），或用 -LetsEncryptCertName <证书名> 让脚本自动从 /etc/letsencrypt/live/<证书名>/ 同步。'
}
if ($LetsEncryptCertName) {
    # 自动同步形态下证书落在运行目录，init 用相对路径即可（服务账号必须能读）
    if (-not $TlsCertFile) { $TlsCertFile = "$RemoteDir/tls/relay.crt" }
    if (-not $TlsKeyFile) { $TlsKeyFile = "$RemoteDir/tls/relay.key" }
}

$repoRoot = Get-RepoRoot
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
if (-not $StagingDir) { $StagingDir = Join-Path (Get-AcceptanceDir) ("relay-deploy-" + $stamp) }
if (-not (Test-Path -LiteralPath $StagingDir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $StagingDir) }
$tarballName = "dsh-relay-$stamp.tgz"
$tarballPath = Join-Path $StagingDir $tarballName
$unitName = 'dsh-relay.service'
$unitPath = Join-Path $StagingDir $unitName
$remoteTarball = "/tmp/$tarballName"
$remoteUnit = "/tmp/$unitName"
$deployScriptPath = Join-Path $StagingDir 'deploy-commands.sh'
$packRoot = Join-Path $StagingDir 'pack'
$certHookName = 'dsh-relay-cert-deploy.sh'
$certHookSetupName = 'dsh-relay-renew-hooks.sh'
$certHookPath = Join-Path $StagingDir $certHookName
$certHookSetupPath = Join-Path $StagingDir $certHookSetupName
$remoteCertHook = "/tmp/$certHookName"
$remoteCertHookSetup = "/tmp/$certHookSetupName"

# ── 工具探测 ──────────────────────────────────────────────────────────────────
$sshCmd = $SshExe
if (-not $sshCmd) {
    $found = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $sshCmd = $found.Source }
}
$scpCmd = $ScpExe
if (-not $scpCmd) {
    $found = Get-Command scp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $scpCmd = $found.Source }
}
$sshPassCmd = $SshPassExe
if (-not $sshPassCmd) {
    foreach ($candidate in @('sshpass', 'plink')) {
        $found = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $sshPassCmd = $found.Source; break }
    }
}
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tarExe -PathType Leaf)) {
    $found = Get-Command tar -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $tarExe = $found.Source }
}

Write-Section '1/6 部署参数'
Write-Kv -Key 'VPS' -Value ("$User@$SshHost`:$SshPort（$Target）")
Write-Kv -Key '远端目录' -Value $RemoteDir
Write-Kv -Key '中继端口' -Value ("$BindHost`:$RemotePort")
Write-Kv -Key '公网地址' -Value $PublicUrl
Write-Kv -Key 'TLS 模式' -Value $TlsMode
Write-Kv -Key '服务账号' -Value $(if ($Target -eq 'Linux') { $ServiceUser } else { '(Windows 服务)' })
Write-Kv -Key '暂存目录' -Value $StagingDir
Write-Kv -Key 'ssh' -Value $(if ($sshCmd) { $sshCmd } else { '(未找到：真实部署会失败)' })
Write-Kv -Key 'scp' -Value $(if ($scpCmd) { $scpCmd } else { '(未找到：真实部署会失败)' })
Write-Kv -Key 'tar' -Value $(if ($tarExe) { $tarExe } else { '(未找到)' })
Write-Kv -Key 'DryRun' -Value ([string]$DryRun)

if ($Password -and -not $sshPassCmd) {
    Write-Warn '指定了 -Password，但本机没有 sshpass/plink：密码登录无法自动化。'
    Write-Info '请改用 -KeyFile（推荐），或手工执行下面打印的命令。'
}
if (-not $DryRun -and (-not $sshCmd -or -not $scpCmd)) {
    Write-Fail '缺少 ssh/scp 可执行文件，无法真实部署。'
    Write-Info '可选：安装 Windows OpenSSH 客户端（设置 → 应用 → 可选功能），或手工按 docs/05-运维/中继部署手册.md 执行。'
    exit 1
}

# ── 本地准备：生成 config.json 与 systemd unit ────────────────────────────────
Write-Section '2/6 本地准备（生成配置与 systemd unit）'
if (-not $SkipLocalPrepare) {
    $localRelayHome = Join-Path $StagingDir 'relay-home'
    $setupRun = Invoke-DshScript -ScriptPath (Join-Path $PSScriptRoot 'setup-relay.ps1') `
        -Arguments (@('-Home', $localRelayHome, '-Port', [string]$RemotePort, '-BindHost', $BindHost,
            '-RelayName', $RelayName, '-TlsMode', 'off') + $(if ($RelaySecret) { @('-RelaySecret', $RelaySecret) } else { @() })) `
        -TimeoutSec 180
    if ($setupRun.ExitCode -ne 0) {
        Write-Warn "本地 setup-relay.ps1 未成功（退出码 $($setupRun.ExitCode)）；继续生成部署命令，但上传的 config.json 可能缺失。"
        Write-Host $setupRun.StdOut -ForegroundColor DarkGray
    } else {
        Write-Ok "本地暂存配置已生成：$(Join-Path $localRelayHome 'config.json')"
        $stagedConfig = Join-Path $localRelayHome 'config.json'
        if (Test-Path -LiteralPath $stagedConfig -PathType Leaf) {
            $cfg = Read-JsonFile -Path $stagedConfig
            $secretForRemote = [string](Get-JsonProp -Object $cfg -Name 'relaySecret' -Default '')
            if (-not $RelaySecret -and $secretForRemote) { $RelaySecret = $secretForRemote }
            $cfg.relayName = $RelayName
            $cfg.host = $BindHost
            $cfg.port = $RemotePort
            $cfg.publicUrl = $PublicUrl
            $cfg.tls.mode = $TlsMode
            if ($RelaySecret) { $cfg.relaySecret = $RelaySecret }
            Write-JsonFileNoBom -Path (Join-Path $StagingDir 'config.json') -Object $cfg
            Write-Ok "已写出部署用配置：$(Join-Path $StagingDir 'config.json')（relaySecret=$(Mask-Secret $RelaySecret)）"
        }
    }
} else {
    Write-Info '已指定 -SkipLocalPrepare：复用暂存目录里已有的 config.json / dsh-relay.service。'
}

if ($Target -eq 'Linux') {
    $unitContent = @"
[Unit]
Description=DSH Remote Relay (dsh-relay) —— 手机与 PC 之间的 WebSocket 隧道中继
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ServiceUser
Group=$ServiceUser
WorkingDirectory=$RemoteDir
ExecStart=$RemoteNode $RemoteDir/relay.mjs serve --home $RemoteDir
Restart=always
RestartSec=3
# 停止时给中继 15 秒优雅关闭；中继内部另有 8 秒看门狗（DSH_RELAY_SHUTDOWN_GRACE_MS），
# 因此正常情况几毫秒就退出，不会再出现“卡满 90 秒才被 SIGKILL”的现场。
TimeoutStopSec=15
# 非 root 服务要监听 <1024 端口（例如直接把中继挂在 80）必须显式授予绑定能力；
# 端口号 >=1024 时这两行是无害的空操作。
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# 最小权限：只允许写运行目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$RemoteDir
StandardOutput=append:$RemoteDir/logs/systemd-out.log
StandardError=append:$RemoteDir/logs/systemd-err.log

[Install]
WantedBy=multi-user.target
"@
    Write-TextFileUtf8NoBom -Path $unitPath -Content $unitContent
    Write-Ok "systemd unit 已生成：$unitPath"
} else {
    Write-Info 'Target=Windows：不生成 systemd unit，改为在远端执行 schtasks 命令（见下方命令清单）。'
}

# ── Let's Encrypt 续期钩子（-LetsEncryptCertName 时生成并上传）────────────────
# 为什么必须有：LE 的 IP/shortlived 证书只有 6 天有效期，续期成功后新证书落在
# /etc/letsencrypt/live/<名>/，中继读不到 → 6 天后手机侧必然连不上（release APK
# 只信任系统信任链，没有"信任自签证书"开关）。
#   pre_hook  ：停中继，把 80 端口让给 certbot 的 standalone http-01 挑战
#   renew_hook：把新证书同步进运行目录并重启中继（带 staging 测试证书护栏）
#   post_hook ：把中继拉回来
if ($LetsEncryptCertName -and $Target -eq 'Linux') {
    $certHookBody = @'
#!/bin/sh
# dsh-relay 证书部署钩子（由 scripts/deploy-relay.ps1 生成；证书名 __CERT_NAME__）
# 调用方：certbot 的 --deploy-hook / renew_hook（root 身份，RENEWED_LINEAGE 指向新证书目录）。
set -eu

LINEAGE="${RENEWED_LINEAGE:-/etc/letsencrypt/live/__CERT_NAME__}"
DST=__REMOTE_DIR__/tls

# 安全护栏：--dry-run 用的是 staging 测试证书，把它部署上去会让手机侧全部连不上。
ISSUER="$(openssl x509 -in "$LINEAGE/fullchain.pem" -noout -issuer 2>/dev/null || true)"
case "$ISSUER" in
  *STAGING*|*Fake*|*Pretend*|*fake*)
    echo "跳过：$LINEAGE 是测试证书（issuer=$ISSUER），不部署到中继"
    exit 0
    ;;
esac

install -m 644 -o __SERVICE_USER__ -g __SERVICE_USER__ "$LINEAGE/fullchain.pem" "$DST/relay.crt"
install -m 600 -o __SERVICE_USER__ -g __SERVICE_USER__ "$LINEAGE/privkey.pem" "$DST/relay.key"
systemctl restart dsh-relay

if command -v logger >/dev/null 2>&1; then
  logger -t dsh-relay-cert "证书已同步到 $DST 并重启中继（来源 $LINEAGE）"
fi
'@
    $certHookSetupBody = @'
#!/bin/bash
# 把续期钩子写进 certbot 的 renewal conf（幂等）：bash dsh-relay-renew-hooks.sh <证书名>
set -euo pipefail

NAME="${1:?用法: $0 <证书名>}"
CONF="/etc/letsencrypt/renewal/$NAME.conf"
HOOK=/usr/local/bin/dsh-relay-cert-deploy

[ -f "$CONF" ] || { echo "找不到 $CONF：请先用 certbot 签发该证书"; exit 1; }

cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"
sed -i '/^pre_hook = /d; /^post_hook = /d; /^renew_hook = /d' "$CONF"
awk -v HOOKLINE="$HOOK" '
  BEGIN { inrp = 0; done = 0 }
  /^\[renewalparams\]/ { inrp = 1; print; next }
  inrp == 1 && /^\[/ && done == 0 {
    print "pre_hook = systemctl stop dsh-relay"
    print "renew_hook = " HOOKLINE
    print "post_hook = systemctl start dsh-relay"
    done = 1; inrp = 0
  }
  { print }
  END {
    if (done == 0) {
      print "pre_hook = systemctl stop dsh-relay"
      print "renew_hook = " HOOKLINE
      print "post_hook = systemctl start dsh-relay"
    }
  }
' "$CONF" > "$CONF.new"
chmod 600 "$CONF.new"
mv "$CONF.new" "$CONF"

echo "已写入续期钩子：$CONF"
grep -E '^(pre_hook|renew_hook|post_hook) = ' "$CONF"
'@
    $certHookText = $certHookBody.Replace('__CERT_NAME__', $LetsEncryptCertName).Replace('__REMOTE_DIR__', $RemoteDir).Replace('__SERVICE_USER__', $ServiceUser)
    Write-TextFileUtf8NoBom -Path $certHookPath -Content ($certHookText -replace "`r`n", "`n")
    Write-TextFileUtf8NoBom -Path $certHookSetupPath -Content ($certHookSetupBody -replace "`r`n", "`n")
    Write-Ok "Let's Encrypt 续期钩子已生成：$certHookPath"
    Write-Ok "renewal conf 写入脚本已生成：$certHookSetupPath"
}

# ── 命令清单（-DryRun 的全部输出）────────────────────────────────────────────
$sshBase = @('-p', [string]$SshPort)
if ($KeyFile) { $sshBase += @('-i', $KeyFile) }
$sshBase += @('-o', 'StrictHostKeyChecking=accept-new', "$User@$SshHost")
$scpBase = @('-P', [string]$SshPort)
if ($KeyFile) { $scpBase += @('-i', $KeyFile) }
$scpBase += @('-o', 'StrictHostKeyChecking=accept-new')

function Format-Cmd {
    param([string]$Exe, [string[]]$Arguments)
    $prefix = ''
    if ($Password -and $sshPassCmd) {
        $prefix = (Split-Path -Leaf $sshPassCmd) + ' -p **** '
    }
    return ($prefix + $Exe + ' ' + (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument -Value ([string]$_) }) -join ' '))
}

$secretsArg = ''
if ($RelaySecret) { $secretsArg = ' --relay-secret ' + (ConvertTo-CommandLineArgument -Value $RelaySecret) }
# --public-url 必须显式传给远端 init：
#   远端 `init --force` 会**重新生成** config.json，不会保留本地暂存的那份。
#   若漏传，中继只能按 relayName 派生 tunnelUrl（config.mjs:deriveTunnelUrl），
#   于是「手机该连哪个地址」由 relayName 决定 —— 这正是"手机连不上"的头号原因：
#   tls=selfsigned 时派生的是 wss://<relayName>:<port>，若 relayName 是 IP 而证书 CN 是域名，
#   或 relayName 在手机上不可解析（内网别名/本机名），手机将永远连不上。
$publicUrlArg = ''
if ($PublicUrl) { $publicUrlArg = ' --public-url ' + (ConvertTo-CommandLineArgument -Value $PublicUrl) }
# tls.mode=file：必须把证书/私钥路径交给远端 init，否则 config.mjs 直接抛
#   「tls.mode=file 时必须同时提供 tls.certFile 与 tls.keyFile」——生产形态根本起不来。
$tlsArg = ''
if ($TlsMode -eq 'file') {
    if ($TlsCertFile) { $tlsArg += ' --cert ' + (ConvertTo-CommandLineArgument -Value $TlsCertFile) }
    if ($TlsKeyFile) { $tlsArg += ' --key ' + (ConvertTo-CommandLineArgument -Value $TlsKeyFile) }
}
$initRemote = "$RemoteNode $RemoteDir/relay.mjs init --home $RemoteDir --force --port $RemotePort --host $BindHost --relay-name $RelayName --tls-mode $TlsMode" +
$(if ($CommonName) { " --common-name $CommonName" } else { '' }) + $publicUrlArg + $tlsArg + $secretsArg

$remoteSteps = New-Object System.Collections.ArrayList
[void]$remoteSteps.Add("sudo install -d -m 0755 $RemoteDir $RemoteDir/logs $RemoteDir/tls")
if ($ServiceUser -ne 'root') {
    # 服务账号必须存在，否则 unit 里的 User= 会让服务起不来（早期版本漏了这一步）
    [void]$remoteSteps.Add("(id -u $ServiceUser >/dev/null 2>&1 || sudo useradd --system --home-dir $RemoteDir --shell /usr/sbin/nologin $ServiceUser)")
}
[void]$remoteSteps.Add("sudo tar -xzf $remoteTarball -C $RemoteDir --strip-components=1")
if ($LetsEncryptCertName) {
    # Let's Encrypt 形态（含只在 SAN 里带 IP 的 shortlived 证书，6 天有效期）：
    # 证书要先复制进运行目录（/etc/letsencrypt 默认 0700 root，服务账号读不到），
    # 再装部署钩子 + 把续期钩子写进 renewal conf，否则 6 天后手机侧必然连不上。
    [void]$remoteSteps.Add("sudo install -m 0644 -o $ServiceUser -g $ServiceUser /etc/letsencrypt/live/$LetsEncryptCertName/fullchain.pem $RemoteDir/tls/relay.crt")
    [void]$remoteSteps.Add("sudo install -m 0600 -o $ServiceUser -g $ServiceUser /etc/letsencrypt/live/$LetsEncryptCertName/privkey.pem $RemoteDir/tls/relay.key")
    [void]$remoteSteps.Add("sudo install -m 0755 -o root -g root $remoteCertHook /usr/local/bin/dsh-relay-cert-deploy")
    [void]$remoteSteps.Add("sudo bash $remoteCertHookSetup $LetsEncryptCertName")
}
[void]$remoteSteps.Add($initRemote)
if ($ServiceUser -ne 'root') {
    # init 以 root 跑，生成的 config.json / homes.json 属主是 root；不 chown 服务账号写不了。
    [void]$remoteSteps.Add("sudo chown -R ${ServiceUser}:${ServiceUser} $RemoteDir")
}
[void]$remoteSteps.Add("sudo install -m 0644 $remoteUnit /etc/systemd/system/$unitName")
[void]$remoteSteps.Add("sudo systemctl daemon-reload")
[void]$remoteSteps.Add("sudo systemctl enable --now dsh-relay")
[void]$remoteSteps.Add("sleep 2; sudo systemctl is-active dsh-relay")
[void]$remoteSteps.Add($(if ($TlsMode -eq 'off') { "curl -sS http://127.0.0.1:$RemotePort/health" } else { "curl -skS https://127.0.0.1:$RemotePort/health" }))

# ── 打包暂存区（Windows tar.exe 的 --exclude 在本机不可用，见下）──────────────
# 实测：`tar.exe -czf out.tgz -C <dir> dsh-relay --exclude=dsh-relay/test` 会报
#   tar.exe: : Couldn't visit directory: No such file or directory（退出码 1）。
# 可靠做法：先把源码复制到暂存目录并删掉 test/node_modules，再整目录打包（不带 --exclude）。
function Initialize-RelayPackStage {
    if (Test-Path -LiteralPath $packRoot) { Remove-Item -LiteralPath $packRoot -Recurse -Force }
    [void](New-Item -ItemType Directory -Force -Path $packRoot)
    Copy-Item -LiteralPath (Join-Path (Join-Path $repoRoot 'tools') 'dsh-relay') -Destination $packRoot -Recurse -Force
    foreach ($junk in @('test', 'node_modules', '.scratch-cert.mjs')) {
        $junkPath = Join-Path (Join-Path $packRoot 'dsh-relay') $junk
        if (Test-Path -LiteralPath $junkPath) { Remove-Item -LiteralPath $junkPath -Recurse -Force }
    }
    return $packRoot
}

$allCommands = New-Object System.Collections.ArrayList
if ($tarExe) {
    try {
        [void](Initialize-RelayPackStage)
        [void]$allCommands.Add("# 打包：已把干净源码复制到 $packRoot（已删 test/node_modules），下面的 tar 不带 --exclude")
    } catch {
        [void]$allCommands.Add("# 打包：先把 tools/dsh-relay 复制到 $packRoot 并删掉 test/node_modules（本机复制失败：$($_.Exception.Message)）")
    }
    [void]$allCommands.Add((Format-Cmd -Exe $tarExe -Arguments @('-czf', $tarballPath, '-C', $packRoot, 'dsh-relay')))
} else {
    [void]$allCommands.Add("# 未找到 tar：请在 Linux 侧执行 tar -czf dsh-relay.tgz -C tools dsh-relay")
}
if ($Target -eq 'Linux') {
    [void]$allCommands.Add((Format-Cmd -Exe $scpCmd -Arguments ($scpBase + @($tarballPath, "$User@$SshHost`:$remoteTarball"))))
    if (Test-Path -LiteralPath $unitPath -PathType Leaf) {
        [void]$allCommands.Add((Format-Cmd -Exe $scpCmd -Arguments ($scpBase + @($unitPath, "$User@$SshHost`:$remoteUnit"))))
    }
    if ($LetsEncryptCertName) {
        [void]$allCommands.Add((Format-Cmd -Exe $scpCmd -Arguments ($scpBase + @($certHookPath, $certHookSetupPath, "$User@$SshHost`:/tmp/"))))
    }
    $remoteScript = 'set -e; ' + ($remoteSteps -join '; ')
    $remoteShellArg = 'bash -lc ' + (ConvertTo-CommandLineArgument -Value $remoteScript)
    [void]$allCommands.Add((Format-Cmd -Exe $sshCmd -Arguments ($sshBase + @($remoteShellArg))))
} else {
    $windowsSteps = @(
        "mkdir `"$RemoteDir`"",
        "tar -xzf `"$remoteTarball`" -C `"$RemoteDir`" --strip-components=1",
        "$RemoteNode `"$RemoteDir\relay.mjs`" init --home `"$RemoteDir`" --force --port $RemotePort --host $BindHost --relay-name $RelayName --tls-mode $TlsMode$publicUrlArg$secretsArg",
        "schtasks /Create /TN dsh-relay /SC ONSTART /RU SYSTEM /RL HIGHEST /TR `"$RemoteNode $RemoteDir\relay.mjs serve --home $RemoteDir`" /F",
        "schtasks /Run /TN dsh-relay",
        "powershell -Command `"(Invoke-WebRequest http://127.0.0.1:$RemotePort/health -UseBasicParsing).Content`""
    )
    [void]$allCommands.Add((Format-Cmd -Exe $scpCmd -Arguments ($scpBase + @($tarballPath, "$User@$SshHost`:$remoteTarball"))))
    $winScript = 'powershell -Command ' + (ConvertTo-CommandLineArgument -Value ($windowsSteps -join '; '))
    [void]$allCommands.Add((Format-Cmd -Exe $sshCmd -Arguments ($sshBase + @($winScript))))
}

Write-Section '3/6 将执行的命令（逐条）'
$index = 0
foreach ($cmd in $allCommands) {
    $index += 1
    Write-Host ("  [{0}] {1}" -f $index, $cmd) -ForegroundColor White
}

$shScript = New-Object System.Text.StringBuilder
[void]$shScript.AppendLine('#!/usr/bin/env bash')
[void]$shScript.AppendLine("# dsh-relay 部署命令（由 scripts/deploy-relay.ps1 -DryRun 生成，$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))")
[void]$shScript.AppendLine('# 说明：以下命令在**本机**依次执行；远端步骤已内联在 ssh 的那一条里。')
[void]$shScript.AppendLine('set -euo pipefail')
[void]$shScript.AppendLine('')
foreach ($cmd in $allCommands) { [void]$shScript.AppendLine($cmd) }
[void]$shScript.AppendLine('')
[void]$shScript.AppendLine('# 远端手工核对：')
foreach ($step in $remoteSteps) { [void]$shScript.AppendLine("#   $step") }
Write-TextFileUtf8NoBom -Path $deployScriptPath -Content $shScript.ToString()
Write-Info "同一份命令已写入：$deployScriptPath"

if ($DryRun) {
    Write-Section '4/6 DryRun：未执行任何远程命令'
    Write-Ok '命令清单已打印完毕（-DryRun）。'
    Write-Host '  > 公网形态已于 2026-10-13 在真实 VPS 上实测通过（Ubuntu 26.04 + LE IP 证书 + 端口 80）；-DryRun 本身不联网。' -ForegroundColor Yellow
    Write-Info '真实执行（去掉 -DryRun）前请确认：'
    Write-Info "  1) 安全组/防火墙放行 TCP 22 与 TCP $RemotePort（IP 证书形态还需要 80 给 certbot http-01 续期）；"
    Write-Info '  2) 远端已安装 Node.js 18+（node --version）；3) tls.mode=file 时证书路径与 -LetsEncryptCertName 已就绪。'
    Write-NextStep -Steps @(
        "scp -P $SshPort <key> $deployScriptPath $User@$SshHost`:/tmp/ && ssh -p $SshPort $User@$SshHost 'bash /tmp/deploy-commands.sh'",
        "powershell -File scripts/setup-relay.ps1 -Home `".runtime\relay-home`" -RegisterHome   # 生成 homeToken 给网关",
        "# 文档：docs/05-运维/中继部署手册.md（含排障表与安全红线）"
    )
    exit 0
}

# ── 真实执行 ──────────────────────────────────────────────────────────────────
Write-Section '4/6 打包与上传'
if (-not $tarExe) { throw '未找到 tar，无法打包中继源码。' }
try {
    [void](Initialize-RelayPackStage)
} catch {
    Write-Fail "本地暂存源码失败：$($_.Exception.Message)"
    exit 1
}
$tarRun = Invoke-NativeCommand -FilePath $tarExe -ArgumentList @('-czf', $tarballPath, '-C', $packRoot, 'dsh-relay') -TimeoutSec 120
if ($tarRun.ExitCode -ne 0) {
    Write-Fail "打包失败：$($tarRun.StdErr.Trim())"
    exit 1
}
Write-Ok ("已打包：" + (Format-Bytes -Bytes (Get-Item -LiteralPath $tarballPath).Length))

function Invoke-Remote {
    param([string]$Exe, [string[]]$Arguments, [string]$What)
    $argsToUse = $Arguments
    if ($Password -and $sshPassCmd) {
        $leaf = (Split-Path -Leaf $sshPassCmd).ToLowerInvariant()
        if ($leaf -like 'sshpass*') { $argsToUse = @('-p', $Password) + $Arguments }
        else { $argsToUse = @('-pw', $Password) + $Arguments }
    }
    $run = Invoke-NativeCommand -FilePath $Exe -ArgumentList $argsToUse -TimeoutSec $TimeoutSec
    Write-Host ("  $ $($run.CommandLine)") -ForegroundColor DarkGray
    if ($run.StdOut.Trim()) { Write-Host $run.StdOut.TrimEnd() }
    if ($run.StdErr.Trim()) { Write-Host $run.StdErr.TrimEnd() -ForegroundColor DarkYellow }
    if ($run.ExitCode -ne 0) {
        Write-Fail "$What 失败（退出码 $($run.ExitCode)）"
        exit 1
    }
    return $run
}

[void](Invoke-Remote -Exe $scpCmd -Arguments ($scpBase + @($tarballPath, "$User@$SshHost`:$remoteTarball")) -What 'scp 上传源码包')
if ($Target -eq 'Linux' -and (Test-Path -LiteralPath $unitPath -PathType Leaf)) {
    [void](Invoke-Remote -Exe $scpCmd -Arguments ($scpBase + @($unitPath, "$User@$SshHost`:$remoteUnit")) -What 'scp 上传 systemd unit')
}
if ($LetsEncryptCertName) {
    [void](Invoke-Remote -Exe $scpCmd -Arguments ($scpBase + @($certHookPath, $certHookSetupPath, "$User@$SshHost`:/tmp/")) -What "scp 上传 Let's Encrypt 续期钩子")
}

Write-Section '5/6 远端初始化与服务安装'
$remoteCommand = 'bash -lc ' + (ConvertTo-CommandLineArgument -Value ('set -e; ' + ($remoteSteps -join '; ')))
$result = Invoke-Remote -Exe $sshCmd -Arguments ($sshBase + @($remoteCommand)) -What 'ssh 远端安装'

Write-Section '6/6 健康校验'
$healthLine = ($result.StdOut -split "`r?`n" | Where-Object { $_ -match '"ok"' } | Select-Object -Last 1)
if ($healthLine) {
    Write-Ok "远端 /health 响应：$($healthLine.Trim())"
} else {
    Write-Warn '未在远端输出里找到 /health 的 JSON 行，请手工核对：'
    Write-Info "  ssh -p $SshPort $User@$SshHost 'curl -sS http://127.0.0.1:$RemotePort/health'"
}
# 公网校验用归一化后的 host:port（早期版本把 wss://… 直接拼成 https://wss://…/health，永远失败）
$publicHealthUrl = "$publicHealthScheme`://$publicHostPort/health"
Write-Info "公网校验地址：$publicHealthUrl"
try {
    $publicHealth = Invoke-DshApi -Url $publicHealthUrl -Method GET -TimeoutSec 15 -Insecure:$Insecure
    if ($publicHealth.Ok) {
        Write-Ok "公网 /health 响应：$($publicHealth.Text.Trim())"
    } else {
        Write-Fail "公网 /health 返回 HTTP $($publicHealth.Status)：$($publicHealth.Text.Trim())"
    }
} catch {
    Write-Fail "公网访问失败：$($_.Exception.Message)"
    Write-Info '检查：域名解析、安全组/防火墙是否放行、systemctl status dsh-relay、journalctl -u dsh-relay -n 50'
    Write-Info "提示：若 -PublicUrl 写的是 wss://host:443 之类，请确认安全组真的放行了该端口（没写端口时本脚本按 -RemotePort=$RemotePort 校验）。"
}

Write-Host ''
Write-Ok "部署流程执行完毕（$PublicUrl），证据目录：$StagingDir"
Write-NextStep -Steps @(
    "powershell -File scripts/setup-relay.ps1 -Home `".runtime\relay-home`" -RegisterHome",
    "powershell -File scripts/e2e-crossnetwork.ps1   # 本机等价拓扑 A~E（公网部署后仍需真机复测）",
    "ssh -p $SshPort $User@$SshHost 'sudo journalctl -u dsh-relay -n 50 --no-pager'"
)
exit 0
