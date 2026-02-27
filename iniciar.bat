@echo off
setlocal
title ZKControl Server

:: ─── Rutas relativas a este .bat ─────────────────────────────────────────────
set "BAT_DIR=%~dp0"
set "NODE_BIN=%BAT_DIR%runtime\node"
set "NODE_EXE=%NODE_BIN%\node.exe"
set "NPM_CMD=%NODE_BIN%\npm.cmd"
set "SERVER=%BAT_DIR%server.js"
set "PKG=%BAT_DIR%package.json"
set "MODS=%BAT_DIR%node_modules"

:: CRÍTICO: agregar node al PATH para que los scripts de postinstall lo encuentren
set "PATH=%NODE_BIN%;%PATH%"

echo.
echo  ===============================================
echo   ZKControl - Iniciando servidor...
echo  ===============================================
echo.

:: ─── Verificaciones ───────────────────────────────────────────────────────────
if not exist "%NODE_EXE%" (
    echo  [ERROR] Node.js no encontrado en: %NODE_BIN%
    echo  Ejecuta primero: instalar_node.bat
    echo.
    pause & exit /b 1
)

if not exist "%SERVER%" (
    echo  [ERROR] No se encontro server.js en: %BAT_DIR%
    pause & exit /b 1
)

if not exist "%PKG%" (
    echo  [ERROR] No se encontro package.json en: %BAT_DIR%
    pause & exit /b 1
)

echo  Node    : %NODE_EXE%
echo  Proyecto: %BAT_DIR%
echo.

:: ─── Instalar dependencias si faltan ─────────────────────────────────────────
if not exist "%MODS%\express" (
    echo  [NPM] Instalando dependencias...
    echo        express, better-sqlite3, koffi, node-zklib
    echo        Espera 2-3 minutos...
    echo.

    if exist "%MODS%" (
        echo  Limpiando instalacion anterior incompleta...
        rmdir /S /Q "%MODS%"
    )

    cd /d "%BAT_DIR%"
    "%NPM_CMD%" install

    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install fallo. Revisa el log de arriba.
        echo.
        pause & exit /b 1
    )

    echo.
    echo  [OK] Dependencias instaladas.
    echo.
)

:: ─── Iniciar servidor ─────────────────────────────────────────────────────────
cd /d "%BAT_DIR%"
echo  Servidor: http://localhost:3000
echo  Ctrl+C para detener.
echo.

"%NODE_EXE%" "%SERVER%"

echo.
echo  Servidor detenido.
pause