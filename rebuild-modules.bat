@echo off
cd /d "%~dp0"
echo ============================================
echo   Recompilation des modules natifs Node.js
echo   (better-sqlite3, mssql, etc.)
echo ============================================
echo.

SET "LOCAL_NODE=%~dp0.tools\node-v22.16.0-win-x64"

IF EXIST "%LOCAL_NODE%\npm.cmd" (
    echo Lancement de npm rebuild avec Node.js local...
    SET "PATH=%LOCAL_NODE%;%PATH%"
    "%LOCAL_NODE%\npm.cmd" rebuild
    echo.
    echo Termine ! Lancez maintenant start-dev.bat
) ELSE (
    echo Node.js local introuvable.
    echo Lancez installer-nodejs.bat puis relancez rebuild-modules.bat.
)
pause
