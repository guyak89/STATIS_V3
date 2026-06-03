@echo off
echo ============================================
echo   Installation locale de Node.js 22 LTS
echo ============================================
echo.

SET "NODE_VERSION=22.16.0"
SET "DEST=%TEMP%\node-v%NODE_VERSION%-win-x64.zip"
SET "TOOLS_DIR=%~dp0.tools"
SET "NODE_DIR=%TOOLS_DIR%\node-v%NODE_VERSION%-win-x64"
SET "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"

echo Telechargement de Node.js 22 LTS portable...
PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Write-Host 'Connexion a nodejs.org...'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $wc = New-Object System.Net.WebClient; $wc.DownloadFile('%NODE_URL%', '%DEST%'); Write-Host 'Telechargement termine.'"

IF NOT EXIST "%DEST%" (
    echo ERREUR : Le telechargement a echoue.
    pause
    exit /b 1
)

echo Extraction dans %TOOLS_DIR%...
IF NOT EXIST "%TOOLS_DIR%" mkdir "%TOOLS_DIR%"
IF EXIST "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
tar -xf "%DEST%" -C "%TOOLS_DIR%"

echo.
echo Verification de Node.js local...
SET "PATH=%NODE_DIR%;%PATH%"

"%NODE_DIR%\node.exe" --version
"%NODE_DIR%\npm.cmd" --version

IF %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================
    echo   Node.js local installe avec succes !
    echo   Installation des dependances STATIS...
    echo ============================================
    cd /d "%~dp0"
    "%NODE_DIR%\npm.cmd" install
    echo.
    echo Termine. Lancez start-dev.bat pour demarrer STATIS.
) ELSE (
    echo.
    echo Installation locale incomplete. Relancez installer-nodejs.bat.
)
pause
