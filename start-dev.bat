@echo off
cd /d "%~dp0"
echo === Demarrage STATIS ===

SET "LOCAL_NODE=%~dp0.tools\node-v22.16.0-win-x64"

IF EXIST "%LOCAL_NODE%\npm.cmd" (
    SET "PATH=%LOCAL_NODE%;%PATH%"
    "%LOCAL_NODE%\node.exe" "%~dp0node_modules\next\dist\bin\next" dev
) ELSE (
    echo Node.js local introuvable.
    echo Lancez installer-nodejs.bat puis relancez start-dev.bat.
    pause
)
