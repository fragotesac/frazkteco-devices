@echo off
setlocal enabledelayedexpansion
title ZKTeco - Instalador de Node.js Portable

:: ─── Configuracion ────────────────────────────────────────────────────────────
set NODE_VERSION=20.11.1
set NODE_ARCH=x64
set NODE_ZIP=node-v%NODE_VERSION%-win-%NODE_ARCH%.zip
set NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%
set INSTALL_DIR=%~dp0runtime\node
set PATH_BAT=%~dp0iniciar.bat

echo.
echo  ===============================================
echo   ZKControl - Instalador Node.js Portable
echo  ===============================================
echo.

:: ─── Verificar si ya esta instalado ───────────────────────────────────────────
if exist "%INSTALL_DIR%\node.exe" (
    echo  [OK] Node.js ya esta instalado en:
    echo       %INSTALL_DIR%
    echo.
    "%INSTALL_DIR%\node.exe" --version
    echo.
    goto :generar_iniciar
)

:: ─── Crear carpeta runtime ────────────────────────────────────────────────────
echo  [1/4] Creando carpeta runtime...
if not exist "%~dp0runtime" mkdir "%~dp0runtime"
if not exist "%INSTALL_DIR%"  mkdir "%INSTALL_DIR%"

:: ─── Descargar Node.js con PowerShell ────────────────────────────────────────
echo  [2/4] Descargando Node.js v%NODE_VERSION% (%NODE_ARCH%)...
echo        Fuente: %NODE_URL%
echo.

powershell -NoProfile -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ^
   $ProgressPreference = 'SilentlyContinue'; ^
   Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%~dp0runtime\%NODE_ZIP%'"

if not exist "%~dp0runtime\%NODE_ZIP%" (
    echo.
    echo  [ERROR] No se pudo descargar Node.js.
    echo          Verifica tu conexion a internet e intenta de nuevo.
    pause
    exit /b 1
)

echo  [OK] Descarga completada.
echo.

:: ─── Extraer ZIP ──────────────────────────────────────────────────────────────
echo  [3/4] Extrayendo archivos...

powershell -NoProfile -Command ^
  "$ProgressPreference = 'SilentlyContinue'; ^
   Expand-Archive -Path '%~dp0runtime\%NODE_ZIP%' -DestinationPath '%~dp0runtime\' -Force"

:: Mover contenido de la subcarpeta al destino final
set NODE_EXTRACTED=%~dp0runtime\node-v%NODE_VERSION%-win-%NODE_ARCH%

if exist "%NODE_EXTRACTED%" (
    xcopy "%NODE_EXTRACTED%\*" "%INSTALL_DIR%\" /E /I /Q /Y >nul
    rmdir /S /Q "%NODE_EXTRACTED%"
)

:: Limpiar ZIP
del "%~dp0runtime\%NODE_ZIP%" >nul 2>&1

if not exist "%INSTALL_DIR%\node.exe" (
    echo.
    echo  [ERROR] La extraccion fallo. Intenta de nuevo.
    pause
    exit /b 1
)

echo  [OK] Node.js extraido correctamente.
echo.

:: ─── Verificar instalacion ────────────────────────────────────────────────────
echo  [4/4] Verificando instalacion...
"%INSTALL_DIR%\node.exe" --version
"%INSTALL_DIR%\npm.cmd" --version
echo.
echo  [OK] Node.js y npm listos.

:: ─── Generar iniciar.bat ──────────────────────────────────────────────────────
:generar_iniciar
echo  Generando iniciar.bat...

(
    echo @echo off
    echo title ZKControl Server
    echo setlocal
    echo.
    echo set NODE_PATH=%INSTALL_DIR%
    echo set PATH=%%NODE_PATH%%;%%PATH%%
    echo set PROJECT_DIR=%%~dp0
    echo.
    echo cd /d "%%PROJECT_DIR%%"
    echo.
    echo echo.
    echo echo  ===============================================
    echo echo   ZKControl - Iniciando servidor...
    echo echo  ===============================================
    echo echo.
    echo.
    echo :: Instalar dependencias si no existen
    echo if not exist "%%PROJECT_DIR%%node_modules" (
    echo     echo  Instalando dependencias NPM...
    echo     "%%NODE_PATH%%\npm.cmd" install
    echo     echo.
    echo ^)
    echo.
    echo echo  Servidor corriendo en http://localhost:3000
    echo echo  Presiona Ctrl+C para detener.
    echo echo.
    echo.
    echo "%%NODE_PATH%%\node.exe" server.js
    echo.
    echo pause
) > "%PATH_BAT%"

echo.
echo  ===============================================
echo   INSTALACION COMPLETADA
echo  ===============================================
echo.
echo   Node.js instalado en: %INSTALL_DIR%
echo.
echo   Para iniciar ZKControl:
echo   ^> Ejecuta  iniciar.bat
echo.
echo  ===============================================
echo.
pause
