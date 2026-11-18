@echo off
rem Builds the bake renderer (src\bake-renderer) to WebAssembly: build\bake-renderer\sbr.wasm.
rem   tools\build-bake-renderer.cmd [output dir]
rem The flags and sources are in src\bake-renderer\build.rsp, shared with tools/build-bake-renderer.sh. Needs
rem Emscripten 6.0.13 (the version the bit checks ran on, another is refused unless SCVA_EMSDK_ANY=1): em++ on PATH,
rem or the emsdk folder in SCVA_EMSDK (6.0.13 installed and activated there).
setlocal
set "ROOT=%~dp0.."
set "OUT=%~f1"
if "%~1"=="" set "OUT=%ROOT%\build\bake-renderer"
rem emsdk_env.bat picks its output syntax from the calling shell, the compiler's directory alone is enough
if not "%SCVA_EMSDK%"=="" where em++ >nul 2>nul || set "PATH=%SCVA_EMSDK%\upstream\emscripten;%PATH%"
where em++ >nul 2>nul || (echo em++ not found: install the emsdk or set SCVA_EMSDK & exit /b 1)
if "%SCVA_EMSDK_ANY%"=="1" goto build
call em++ --version 2>nul | findstr /c:" 6.0.13 " >nul || (echo em++ is not Emscripten 6.0.13, set SCVA_EMSDK_ANY=1 to build anyway & exit /b 1)
:build
if not exist "%OUT%" mkdir "%OUT%"
pushd "%ROOT%\src\bake-renderer"
call em++ @build.rsp -o "%OUT%\sbr.wasm"
set "STATUS=%ERRORLEVEL%"
popd
exit /b %STATUS%
