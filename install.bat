@echo off
:: Local MCP Hub Installer for Windows
:: Downloads and sets up Serena and Context7 MCPs for local development

echo 🚀 Local MCP Hub Installer (Windows)
echo ==================================

:: Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Please run this script from the local-mcp-hub directory
    exit /b 1
)

findstr "local-mcp-hub" package.json >nul 2>&1
if errorlevel 1 (
    echo ❌ Please run this script from the local-mcp-hub directory
    exit /b 1
)

:: Create mcps directory
echo 📁 Creating mcps directory...
if not exist "mcps" mkdir mcps
cd mcps

echo 🔍 Checking dependencies...

:: Check for git
git --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Git is required but not installed
    echo Please install Git from https://git-scm.com/download/win
    exit /b 1
)

:: Check for node
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is required but not installed
    echo Please install Node.js from https://nodejs.org
    exit /b 1
)

:: Check for npm
npm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ npm is required but not installed
    exit /b 1
)

:: Check for python
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python 3 is required but not installed
    echo Please install Python from https://python.org
    exit /b 1
)

:: Check for uv (Python package manager)
uv --version >nul 2>&1
if errorlevel 1 (
    echo ⚠️  uv not found, installing...
    powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"
    :: Add to PATH for current session
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
    :: Verify installation
    uv --version >nul 2>&1
    if errorlevel 1 (
        echo ❌ Failed to install uv. Please install manually: https://docs.astral.sh/uv/getting-started/installation/
        exit /b 1
    )
)

echo ✅ All dependencies found

:: Download Serena
echo 📥 Downloading Serena...
if exist "serena" (
    echo ⚠️  Serena directory exists, updating...
    cd serena
    git pull
    cd ..
) else (
    git clone https://github.com/oraios/serena.git
)

:: Download Context7
echo 📥 Downloading Context7...
if exist "context7" (
    echo ⚠️  Context7 directory exists, updating...
    cd context7
    git pull
    cd ..
) else (
    git clone https://github.com/upstash/context7.git
)

:: Set up Serena
echo 🔧 Setting up Serena...
cd serena
if not exist ".venv" (
    echo    Creating Python virtual environment...
    uv venv
)
echo    Installing Serena dependencies...
uv pip install -e .
cd ..

:: Set up Context7
echo 🔧 Setting up Context7...
cd context7
echo    Installing Context7 dependencies...
call npm install
if not exist "dist" (
    echo    Building Context7...
    call npm run build
)
cd ..

:: Update hub configuration
echo ⚙️  Updating hub configuration...
cd ..

:: Create config.json
(
echo {
echo   "ollama": {
echo     "host": "http://10.0.0.24:11434",
echo     "model": "qwen2.5:latest"
echo   },
echo   "hub": {
echo     "port": 3002,
echo     "log_level": "info",
echo     "cors_origins": ["*"]
echo   },
echo   "mcps": {
echo     "enabled": ["serena", "context7"]
echo   }
echo }
) > config.json

echo ✅ Installation complete!
echo.
echo 📋 Summary:
echo    • Serena: %CD%\mcps\serena
echo    • Context7: %CD%\mcps\context7
echo    • Configuration updated to enable both MCPs
echo.
echo 🚀 Next steps:
echo    1. Run 'npm start' to start the hub
echo    2. Use the continue-config.yaml file with Continue extension
echo    3. Test with: curl http://localhost:3002/v1/tools
echo.