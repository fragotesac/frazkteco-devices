@echo off
setlocal enabledelayedexpansion
title ZKTeco - Instalador de Node.js Portable

set NODE_VERSION=20.11.1
set NODE_ARCH=x64
set NODE_ZIP=node-v%NODE_VERSION%-win-%NODE_ARCH%.zip
set NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%
set INSTALL_DIR=%~dp0runtime\node
set RUNTIME_DIR=%~dp0runtime
set PS1_DOWNLOAD=%~dp0runtime\_download.ps1
set PS1_EXTRACT=%~dp0runtime\_extract.ps1

echo.
echo  ===============================================
echo   ZKControl - Instalador Node.js Portable
echo  ===============================================
echo.

:: ─── Ya instalado? ────────────────────────────────────────────────────────────
if exist "%INSTALL_DIR%\node.exe" (
    echo  [OK] Node.js ya esta instalado.
    "%INSTALL_DIR%\node.exe" --version
    echo.
    goto :generar_iniciar
)

:: ─── Crear carpetas ───────────────────────────────────────────────────────────
echo  [1/4] Creando carpeta runtime...
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
if not exist "%INSTALL_DIR%"  mkdir "%INSTALL_DIR%"

:: ─── Escribir script de descarga ─────────────────────────────────────────────
echo  [2/4] Descargando Node.js v%NODE_VERSION% (%NODE_ARCH%)...
echo        %NODE_URL%
echo.

echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 > "%PS1_DOWNLOAD%"
echo $ProgressPreference = 'SilentlyContinue' >> "%PS1_DOWNLOAD%"
echo $url  = '%NODE_URL%' >> "%PS1_DOWNLOAD%"
echo $dest = '%RUNTIME_DIR%\%NODE_ZIP%' >> "%PS1_DOWNLOAD%"
echo Invoke-WebRequest -Uri $url -OutFile $dest >> "%PS1_DOWNLOAD%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_DOWNLOAD%"
del "%PS1_DOWNLOAD%" >nul 2>&1

if not exist "%RUNTIME_DIR%\%NODE_ZIP%" (
    echo.
    echo  [ERROR] No se pudo descargar Node.js.
    echo          Verifica tu conexion a internet e intenta de nuevo.
    echo.
    pause
    exit /b 1
)
echo  [OK] Descarga completada.
echo.

:: ─── Escribir script de extraccion ───────────────────────────────────────────
echo  [3/4] Extrayendo archivos...

echo $ProgressPreference = 'SilentlyContinue' > "%PS1_EXTRACT%"
echo $zip  = '%RUNTIME_DIR%\%NODE_ZIP%' >> "%PS1_EXTRACT%"
echo $dest = '%RUNTIME_DIR%' >> "%PS1_EXTRACT%"
echo Expand-Archive -Path $zip -DestinationPath $dest -Force >> "%PS1_EXTRACT%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_EXTRACT%"
del "%PS1_EXTRACT%" >nul 2>&1

:: Mover contenido a INSTALL_DIR
set NODE_EXTRACTED=%RUNTIME_DIR%\node-v%NODE_VERSION%-win-%NODE_ARCH%
if exist "%NODE_EXTRACTED%" (
    xcopy "%NODE_EXTRACTED%\*" "%INSTALL_DIR%\" /E /I /Q /Y >nul
    rmdir /S /Q "%NODE_EXTRACTED%"
)

del "%RUNTIME_DIR%\%NODE_ZIP%" >nul 2>&1

if not exist "%INSTALL_DIR%\node.exe" (
    echo.
    echo  [ERROR] La extraccion fallo. Intenta de nuevo.
    pause
    exit /b 1
)
echo  [OK] Archivos extraidos.
echo.

:: ─── Verificar ────────────────────────────────────────────────────────────────
echo  [4/4] Verificando instalacion...
"%INSTALL_DIR%\node.exe" --version
"%INSTALL_DIR%\npm.cmd" --version
echo  [OK] Node.js y npm listos.
echo.

:: ─── Generar iniciar.bat ──────────────────────────────────────────────────────
:generar_iniciar
echo  Generando iniciar.bat...

(
    echo @echo off
    echo title ZKControl Server
    echo setlocal
    echo.
    echo set "NODE_BIN=%INSTALL_DIR%"
    echo set "PATH=%%NODE_BIN%%;%%PATH%%"
    echo.
    echo cd /d "%%~dp0"
    echo.
    echo echo.
    echo echo  ===============================================
    echo echo   ZKControl - Iniciando servidor...
    echo echo  ===============================================
    echo echo.
    echo.
    echo if not exist "%%~dp0node_modules" (
    echo     echo  Instalando dependencias NPM, espera...
    echo     "%%NODE_BIN%%\npm.cmd" install
    echo     echo.
    echo ^)
    echo.
    echo echo  Abre tu navegador en: http://localhost:3000
    echo echo  Presiona Ctrl+C para detener.
    echo echo.
    echo "%%NODE_BIN%%\node.exe" server.js
    echo pause
) > "%~dp0iniciar.bat"

echo.
echo  ===============================================
echo   LISTO
echo  ===============================================
echo.
echo   Node.js instalado en: %INSTALL_DIR%
echo.
echo   Para iniciar ZKControl ejecuta:
echo   ^> iniciar.bat
echo.
echo  ===============================================
echo.
pause
