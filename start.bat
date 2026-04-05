@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1

title Video Downloader Pro

echo.
echo  ========================================
echo    Video Downloader Pro - Quick Launcher
echo  ========================================
echo.

:: Save the directory where this .bat file lives
pushd "%~dp0"

:: Check Python
python --version >nul 2>&1
if %errorlevel% NEQ 0 (
    echo  [ERROR] Python is not installed!
    echo  Please install Python from: https://www.python.org/downloads/
    popd
    pause
    exit /b 1
)

echo  [OK] Python found.

:: Check if Flask is installed (quick dependency check)
python -c "import flask" >nul 2>&1
if %errorlevel% NEQ 0 (
    echo  [INSTALL] Installing required packages for the first time...
    pip install -r requirements.txt
    if %errorlevel% NEQ 0 (
        echo  [ERROR] Failed to install packages!
        popd
        pause
        exit /b 1
    )
    echo  [OK] All packages installed successfully!
) else (
    echo  [OK] All packages are ready.
)

echo.
echo  [START] Launching the app...
echo  [URL]   http://localhost:5000
echo.
echo  Do NOT close this window while using the app!
echo  ========================================
echo.

:: Open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5000"

:: Run the Flask app from the current directory
python app.py

echo.
echo  [STOP] App has been stopped.
popd
pause
