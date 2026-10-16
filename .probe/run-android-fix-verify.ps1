$ErrorActionPreference = 'Continue'
$android = 'D:\Workspace\dsh_android\android'
$log = 'D:\Workspace\dsh_android\.probe\gradle-v290-fix.log'
$env:JAVA_HOME = 'D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
$env:GRADLE_USER_HOME = 'C:\Users\Administrator\.gradle'
Set-Location $android

# 清掉上一轮结果，否则聚合会把修复前的旧 XML 一起数进来（口径必须干净）
$resultsDir = 'D:\Workspace\dsh_android\android\app\build\test-results\testDebugUnitTest'
if (Test-Path -LiteralPath $resultsDir) { Remove-Item -LiteralPath $resultsDir -Recurse -Force }

& .\gradlew.bat :app:testDebugUnitTest --rerun-tasks --no-build-cache --console=plain 2>&1 |
    Tee-Object -FilePath $log | Select-Object -Last 25

"=== EXIT=$LASTEXITCODE ==="

$classes = 0; $tests = 0; $failures = 0; $errors = 0; $skipped = 0
$failLines = New-Object System.Collections.ArrayList
foreach ($file in (Get-ChildItem -LiteralPath $resultsDir -Filter *.xml -ErrorAction SilentlyContinue)) {
    $x = [xml](Get-Content $file.FullName -Raw -Encoding utf8)
    # 有的报告是 suites 套 suite，也要能数到
    foreach ($suite in @($x.testsuite) + @($x.testsuites.testsuite)) {
        if ($null -eq $suite) { continue }
        $classes++
        $tests += [int]$suite.tests
        $failures += [int]$suite.failures
        $errors += [int]$suite.errors
        $skipped += [int]$suite.skipped
        foreach ($case in @($suite.testcase)) {
            if ($null -eq $case) { continue }
            $bad = $false
            $detail = ''
            if ($null -ne $case.failure) { $bad = $true; $detail = [string]$case.failure.message }
            if ($null -ne $case.error) { $bad = $true; $detail = [string]$case.error.message }
            if ($bad) {
                $first = ($detail -split "`n")[0]
                [void]$failLines.Add("=== FAIL " + $suite.name + " :: " + $case.name + " :: " + $first)
            }
        }
    }
}
"=== AGG classes=$classes tests=$tests failures=$failures errors=$errors skipped=$skipped ==="
if ($failLines.Count -eq 0) { "=== NO FAILURES ===" } else { $failLines }
