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

:: ─── Descargar ────────────────────────────────────────────────────────────────
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
    echo  [ERROR] No se pudo descargar Node.js.
    pause & exit /b 1
)
echo  [OK] Descarga completada.
echo.

:: ─── Extraer ──────────────────────────────────────────────────────────────────
echo  [3/4] Extrayendo archivos...

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
    echo  [ERROR] La extraccion fallo.
    pause & exit /b 1
)

echo  [4/4] Verificando instalacion...
"%INSTALL_DIR%\node.exe" --version
"%INSTALL_DIR%\npm.cmd"  --version
echo  [OK] Node.js listo.
echo.

:: ─── Generar iniciar.bat ──────────────────────────────────────────────────────
:generar_iniciar
echo  Generando iniciar.bat...

> "%BAT_DIR%iniciar.bat" (
    echo @echo off
    echo setlocal
    echo title ZKControl Server
    echo.
    echo set "NODE_BIN=%%~dp0runtime\node"
    echo set "PATH=%%NODE_BIN%%;%%PATH%%"
    echo cd /d "%%~dp0"
    echo.
    echo echo.
    echo echo  ===============================================
    echo echo   ZKControl - Iniciando servidor...
    echo echo  ===============================================
    echo echo.
    echo.
    echo if not exist "%%NODE_BIN%%\node.exe" ^(
    echo     echo  [ERROR] Node.js no encontrado. Ejecuta instalar_node.bat primero.
    echo     pause ^& exit /b 1
    echo ^)
    echo.
    echo if not exist "%%~dp0package.json" ^(
    echo     echo  [ERROR] No se encontro package.json en %%~dp0
    echo     pause ^& exit /b 1
    echo ^)
    echo.
    echo :: Instalar dependencias si faltan
    echo if not exist "%%~dp0node_modules\express" ^(
    echo     echo  Instalando dependencias NPM ^(koffi, express, better-sqlite3, node-zklib^)...
    echo     echo  Esto puede tardar 1-2 minutos...
    echo     echo.
    echo     :: Limpiar node_modules roto si existe
    echo     if exist "%%~dp0node_modules" rmdir /S /Q "%%~dp0node_modules"
    echo     "%%NODE_BIN%%\npm.cmd" install --prefer-offline
    echo     if errorlevel 1 ^(
    echo         echo.
    echo         echo  [ERROR] npm install fallo.
    echo         echo  Intenta de nuevo o revisa tu conexion a internet.
    echo         pause ^& exit /b 1
    echo     ^)
    echo     echo.
    echo ^)
    echo.
    echo echo  Servidor: http://localhost:3000
    echo echo  Presiona Ctrl+C para detener.
    echo echo.
    echo "%%NODE_BIN%%\node.exe" "%%~dp0server.js"
    echo pause
)

echo  [OK] iniciar.bat generado.
echo.
echo  ===============================================
echo   LISTO
echo  ===============================================
echo.
echo   NOTA: koffi ^(para SLK20R^) NO necesita Python ni
echo   Visual Studio. Se instala solo con npm install.
echo.
echo   Para usar el SLK20R instala ademas:
echo   ZKFinger SDK desde zkteco.com/support
echo   ^(copia libzkfplib.dll a Windows\System32^)
echo.
echo   Para iniciar: iniciar.bat
echo  ===============================================
echo.
pause