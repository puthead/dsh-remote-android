$ErrorActionPreference = 'Continue'
$root = 'D:\Workspace\dsh_android'
$android = Join-Path $root 'android'
$log = Join-Path $root '.probe\gradle-v290-baseline.log'
$env:JAVA_HOME = 'D:\Workspace\dsh_android\.toolchain\android-dev\jdk17'
Set-Location $android

& .\gradlew.bat :app:testDebugUnitTest --rerun-tasks --no-build-cache --console=plain 2>&1 |
    Tee-Object -FilePath $log | Select-Object -Last 6

"=== EXIT=$LASTEXITCODE ==="

$dir = Join-Path $android 'app\build\test-results\testDebugUnitTest'
$classes = 0; $tests = 0; $failures = 0; $errors = 0; $skipped = 0
Get-ChildItem $dir -Filter *.xml -ErrorAction SilentlyContinue | ForEach-Object {
    $x = [xml](Get-Content $_.FullName -Raw -Encoding utf8)
    $classes++
    $tests += [int]$x.testsuite.tests
    $failures += [int]$x.testsuite.failures
    $errors += [int]$x.testsuite.errors
    $skipped += [int]$x.testsuite.skipped
}
"=== AGG classes=$classes tests=$tests failures=$failures errors=$errors skipped=$skipped ==="
