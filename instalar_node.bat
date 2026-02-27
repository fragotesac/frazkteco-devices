@echo off
setlocal enabledelayedexpansion
title ZKTeco - Instalador de Node.js Portable

set NODE_VERSION=20.11.1
set NODE_ARCH=x64
set NODE_ZIP=node-v%NODE_VERSION%-win-%NODE_ARCH%.zip
set NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%

:: Todas las rutas son relativas al .bat, sin importar desde donde se ejecute
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
    echo.
    echo  [ERROR] No se pudo descargar Node.js.
    echo          Verifica tu conexion a internet.
    pause
    exit /b 1
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
    pause
    exit /b 1
)
echo  [OK] Archivos extraidos.
echo.

:: ─── Verificar ────────────────────────────────────────────────────────────────
echo  [4/4] Verificando instalacion...
"%INSTALL_DIR%\node.exe" --version
"%INSTALL_DIR%\npm.cmd"  --version
echo  [OK] Node.js y npm listos.
echo.

:: ─── Generar iniciar.bat ──────────────────────────────────────────────────────
:generar_iniciar
echo  Generando iniciar.bat...

:: IMPORTANTE: el iniciar.bat usa %%~dp0 para ubicarse a si mismo.
:: Nunca usar rutas absolutas aqui — el proyecto puede moverse de carpeta.

> "%BAT_DIR%iniciar.bat" (
    echo @echo off
    echo setlocal
    echo title ZKControl Server
    echo.
    echo :: Ruta al Node.js portable ^(relativa a este .bat^)
    echo set "NODE_BIN=%%~dp0runtime\node"
    echo set "PATH=%%NODE_BIN%%;%%PATH%%"
    echo.
    echo :: Ir a la carpeta donde esta este .bat ^(donde vive server.js^)
    echo cd /d "%%~dp0"
    echo.
    echo echo.
    echo echo  ===============================================
    echo echo   ZKControl - Iniciando servidor...
    echo echo  ===============================================
    echo echo.
    echo echo  Carpeta del proyecto: %%~dp0
    echo echo  Node.js: %%NODE_BIN%%\node.exe
    echo echo.
    echo.
    echo :: Verificar que node.exe existe
    echo if not exist "%%NODE_BIN%%\node.exe" ^(
    echo     echo  [ERROR] Node.js no encontrado en %%NODE_BIN%%
    echo     echo  Ejecuta primero instalar_node.bat
    echo     pause
    echo     exit /b 1
    echo ^)
    echo.
    echo :: Verificar que package.json existe en esta carpeta
    echo if not exist "%%~dp0package.json" ^(
    echo     echo  [ERROR] No se encontro package.json en %%~dp0
    echo     echo  Asegurate de que server.js y package.json esten junto a este .bat
    echo     pause
    echo     exit /b 1
    echo ^)
    echo.
    echo :: Instalar dependencias si no existen o si falta alguna
    echo if not exist "%%~dp0node_modules\express" ^(
    echo     echo  Instalando dependencias NPM, espera...
    echo     "%%NODE_BIN%%\npm.cmd" install
    echo     if errorlevel 1 ^(
    echo         echo  [ERROR] npm install fallo. Revisa tu conexion a internet.
    echo         pause
    echo         exit /b 1
    echo     ^)
    echo     echo.
    echo ^)
    echo.
    echo echo  Servidor corriendo en: http://localhost:3000
    echo echo  Presiona Ctrl+C para detener.
    echo echo.
    echo.
    echo "%%NODE_BIN%%\node.exe" "%%~dp0server.js"
    echo.
    echo pause
)

echo  [OK] iniciar.bat generado.
echo.
echo  ===============================================
echo   LISTO
echo  ===============================================
echo.
echo   Archivos esperados junto a este .bat:
echo     server.js
echo     slk20r.js
echo     package.json
echo     public\index.html
echo.
echo   Para iniciar ZKControl:
echo   ^> iniciar.bat
echo.
echo  ===============================================
echo.
pause