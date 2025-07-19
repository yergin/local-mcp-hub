@echo off
:: Local MCP Hub Installer for Windows
:: Downloads and sets up Serena and Context7 MCPs for local development

:: Fix npm shell issues in mixed environments
set NPM_CONFIG_SHELL=cmd.exe

echo 🚀 Local MCP Hub Installer (Windows)
echo ==================================

:: Check if we're in the right directory
if not exist "package.json" (
    echo ❌ Please run this script from the local-mcp-hub directory
    pause
    exit /b 1
)

findstr "local-mcp-hub" package.json >NUL 2>&1
if errorlevel 1 (
    echo ❌ Please run this script from the local-mcp-hub directory
    pause
    exit /b 1
)

:: Create mcps directory
echo 📁 Creating mcps directory...
if not exist "mcps" mkdir mcps
cd mcps

echo 🔍 Checking dependencies...

:: Check for git
echo    Checking Git...
git --version >NUL
if errorlevel 1 (
    echo ❌ Git is required but not installed
    echo Please install Git from https://git-scm.com/download/win
    pause
    exit /b 1
)
echo ✅ Git found

:: Check for node
echo    Checking Node.js...
node --version >NUL
if errorlevel 1 (
    echo ❌ Node.js is required but not installed
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo ✅ Node.js found

:: Check for npm
echo    Checking npm...
set NPM_CONFIG_SHELL=cmd.exe
call npm --version >NUL 2>&1 || (
    echo ❌ npm is required but not installed
    pause
    exit /b 1
)
echo ✅ npm found

:: Check for python
echo    Checking Python...
python --version >NUL
if errorlevel 1 (
    echo ❌ Python 3 is required but not installed
    echo Please install Python from https://python.org
    pause
    exit /b 1
)
echo ✅ Python found

:: Check for uv (Python package manager)
echo    Checking uv...
python -m uv --version >NUL
if errorlevel 1 (
    echo ⚠️  uv not found, installing via pip...
    pip install --user uv >NUL
    python -m uv --version >NUL
    if errorlevel 1 (
        echo ❌ Failed to install uv
        pause
        exit /b 1
    )
)
echo ✅ uv ready

echo ✅ All dependencies checked

:: Download Serena
echo 📥 Downloading Serena...
if exist "serena" (
    echo ⚠️  Serena directory exists, updating...
    cd serena
    git pull
    cd ..
) else (
    git clone https://github.com/oraios/serena.git
    if errorlevel 1 (
        echo ❌ Failed to clone Serena repository
        cd ..
        pause
        exit /b 1
    )
)
echo ✅ Serena downloaded

:: Download Context7
echo 📥 Downloading Context7...
if exist "context7" (
    echo ⚠️  Context7 directory exists, updating...
    cd context7
    git pull
    cd ..
) else (
    git clone https://github.com/upstash/context7.git
    if errorlevel 1 (
        echo ❌ Failed to clone Context7 repository
        cd ..
        pause
        exit /b 1
    )
)
echo ✅ Context7 downloaded

:: Set up Serena
echo 🔧 Setting up Serena...
cd serena
if not exist ".venv" (
    echo    Creating Python virtual environment...
    python -m uv venv
    if errorlevel 1 (
        echo ❌ Failed to create virtual environment
        cd ..\..
        pause
        exit /b 1
    )
)
echo    Installing Serena dependencies...
python -m uv pip install --python .venv\Scripts\python.exe -e .
if errorlevel 1 (
    echo ❌ Failed to install Serena dependencies
    cd ..\..
    pause
    exit /b 1
)
echo ✅ Serena setup complete
cd ..

:: Set up Context7
echo 🔧 Setting up Context7...
cd context7
echo    Installing Context7 dependencies...
set NPM_CONFIG_SHELL=cmd.exe
call npm install
if errorlevel 1 (
    echo ❌ Failed to install Context7 dependencies
    cd ..\..
    pause
    exit /b 1
)
if not exist "dist" (
    echo    Building Context7...
    set NPM_CONFIG_SHELL=cmd.exe
    call npm run build
    if errorlevel 1 (
        echo ❌ Failed to build Context7
        cd ..\..
        pause
        exit /b 1
    )
)
echo ✅ Context7 setup complete
cd ..

:: Update hub configuration
echo ⚙️  Updating hub configuration...
cd ..

:: Create config.json if it doesn't exist
if not exist "config.json" (
    echo    Creating config.json...
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
    echo ✅ Created config.json
) else (
    echo ✅ config.json already exists
)

echo.
echo ✅ Installation complete!
echo.
echo 📋 Summary:
echo    • Serena: %CD%\mcps\serena
echo    • Context7: %CD%\mcps\context7
echo    • Configuration: config.json
echo.
echo 🚀 Next steps:
echo    1. Edit config.json to update your Ollama server address
echo    2. Run 'npm install' to install hub dependencies
echo    3. Run 'npm start' to start the hub
echo    4. Test with: curl http://localhost:3002/health
echo.
echo Press any key to continue...
pause >NUL