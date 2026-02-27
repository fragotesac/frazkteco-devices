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

echo.
echo  ===============================================
echo   ZKControl - Iniciando servidor...
echo  ===============================================
echo.

:: ─── Verificaciones previas ───────────────────────────────────────────────────
if not exist "%NODE_EXE%" (
    echo  [ERROR] Node.js no encontrado en:
    echo          %NODE_BIN%
    echo.
    echo  Ejecuta primero: instalar_node.bat
    echo.
    pause & exit /b 1
)

if not exist "%SERVER%" (
    echo  [ERROR] No se encontro server.js en:
    echo          %BAT_DIR%
    echo.
    pause & exit /b 1
)

if not exist "%PKG%" (
    echo  [ERROR] No se encontro package.json en:
    echo          %BAT_DIR%
    echo.
    pause & exit /b 1
)

echo  Node    : %NODE_EXE%
echo  Proyecto: %BAT_DIR%
echo.

:: ─── Instalar dependencias si faltan ─────────────────────────────────────────
if not exist "%MODS%\express" (
    echo  [NPM] Instalando dependencias...
    echo        express, better-sqlite3, koffi, node-zklib
    echo        Esto puede tardar 2-3 minutos la primera vez.
    echo.

    :: Limpiar node_modules parcial si existe
    if exist "%MODS%" (
        echo  [NPM] Limpiando instalacion anterior incompleta...
        rmdir /S /Q "%MODS%"
    )

    :: Cambiar a la carpeta del proyecto y ejecutar npm install
    cd /d "%BAT_DIR%"
    "%NPM_CMD%" install

    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install fallo.
        echo.
        echo  Posibles causas:
        echo    - Sin internet
        echo    - Antivirus bloqueando npm
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