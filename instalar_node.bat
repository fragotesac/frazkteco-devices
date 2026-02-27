@echo off
setlocal enabledelayedexpansion
title ZKTeco - Instalador de Node.js Portable

set NODE_VERSION=20.11.1
set NODE_ARCH=x64
set NODE_ZIP=node-v%NODE_VERSION%-win-%NODE_ARCH%.zip
set NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%

set BAT_DIR=%~dp0
set RUNTIME_DIR=%BAT_DIR%runtime
set INSTALL_DIR=%RUNTIME_DIR%\node
set PS1_DOWNLOAD=%RUNTIME_DIR%\_download.ps1
set PS1_EXTRACT=%RUNTIME_DIR%\_extract.ps1

echo.
echo  ===============================================
echo   ZKControl - Instalador Node.js Portable
echo  ===============================================
echo.

if exist "%INSTALL_DIR%\node.exe" (
    echo  [OK] Node.js ya esta instalado:
    "%INSTALL_DIR%\node.exe" --version
    echo.
    goto :fin
)

echo  [1/4] Creando carpetas...
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
if not exist "%INSTALL_DIR%"  mkdir "%INSTALL_DIR%"

echo  [2/4] Descargando Node.js v%NODE_VERSION%...
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
    echo  [ERROR] No se pudo descargar. Verifica tu internet.
    pause & exit /b 1
)
echo  [OK] Descarga completada.
echo.

echo  [3/4] Extrayendo...

echo $ProgressPreference = 'SilentlyContinue' > "%PS1_EXTRACT%"
echo $zip  = '%RUNTIME_DIR%\%NODE_ZIP%' >> "%PS1_EXTRACT%"
echo $dest = '%RUNTIME_DIR%' >> "%PS1_EXTRACT%"
echo Expand-Archive -Path $zip -DestinationPath $dest -Force >> "%PS1_EXTRACT%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_EXTRACT%"
del "%PS1_EXTRACT%" >nul 2>&1

set NODE_EXTRACTED=%RUNTIME_DIR%\node-v%NODE_VERSION%-win-%NODE_ARCH%
if exist "%NODE_EXTRACTED%" (
    xcopy "%NODE_EXTRACTED%\*" "%INSTALL_DIR%\" /E /I /Q /Y >nul
    rmdir /S /Q "%NODE_EXTRACTED%"
)
del "%RUNTIME_DIR%\%NODE_ZIP%" >nul 2>&1

if not exist "%INSTALL_DIR%\node.exe" (
    echo  [ERROR] Extraccion fallida.
    pause & exit /b 1
)

echo  [4/4] Verificando...
"%INSTALL_DIR%\node.exe" --version
"%INSTALL_DIR%\npm.cmd"  --version

:fin
echo.
echo  ===============================================
echo   Node.js listo. Ejecuta: iniciar.bat
echo  ===============================================
echo.
pause