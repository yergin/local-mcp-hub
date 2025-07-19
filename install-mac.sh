#!/bin/bash

# Local MCP Hub Installer for macOS
# Downloads and sets up Serena and Context7 MCPs for local development

set -e  # Exit on any error

echo "🚀 Local MCP Hub Installer (macOS)"
echo "=================================="

# Check if we're in the right directory
if [ ! -f "package.json" ] || ! grep -q "local-mcp-hub" package.json; then
    echo "❌ Please run this script from the local-mcp-hub directory"
    exit 1
fi

# Create mcps directory
echo "📁 Creating mcps directory..."
mkdir -p mcps
cd mcps

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check dependencies
echo "🔍 Checking dependencies..."

if ! command_exists git; then
    echo "❌ Git is required but not installed"
    echo "Please install Git: brew install git"
    exit 1
fi

if ! command_exists node; then
    echo "❌ Node.js is required but not installed"
    echo "Please install Node.js: brew install node"
    exit 1
fi

if ! command_exists npm; then
    echo "❌ npm is required but not installed"
    exit 1
fi

if ! command_exists python3; then
    echo "❌ Python 3 is required but not installed"
    echo "Please install Python: brew install python"
    exit 1
fi

# Check for Homebrew
if ! command_exists brew; then
    echo "⚠️  Homebrew not found. Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Check for uv (Python package manager)
if ! command_exists uv; then
    echo "⚠️  uv not found, installing..."
    if command_exists brew; then
        brew install uv
    else
        curl -LsSf https://astral.sh/uv/install.sh | sh
        # Add uv to PATH
        export PATH="$HOME/.local/bin:$PATH"
    fi
    
    # Verify uv is now available
    if ! command_exists uv; then
        echo "❌ Failed to install uv. Please install manually: https://docs.astral.sh/uv/getting-started/installation/"
        exit 1
    fi
fi

echo "✅ All dependencies found"

# Download Serena
echo "📥 Downloading Serena..."
if [ -d "serena" ]; then
    echo "⚠️  Serena directory exists, updating..."
    cd serena
    git pull
    cd ..
else
    git clone https://github.com/oraios/serena.git
fi

# Download Context7
echo "📥 Downloading Context7..."
if [ -d "context7" ]; then
    echo "⚠️  Context7 directory exists, updating..."
    cd context7
    git pull
    cd ..
else
    git clone https://github.com/upstash/context7.git
fi

# Set up Serena
echo "🔧 Setting up Serena..."
cd serena
if [ ! -d ".venv" ]; then
    echo "   Creating Python virtual environment..."
    uv venv
fi
echo "   Installing Serena dependencies..."
uv pip install -e .
cd ..

# Set up Context7
echo "🔧 Setting up Context7..."
cd context7
echo "   Installing Context7 dependencies..."
npm install
if [ ! -d "dist" ]; then
    echo "   Building Context7..."
    npm run build
fi
cd ..

# Update hub configuration
echo "⚙️  Updating hub configuration..."
cd ..

# Update config.json
cat > config.json << 'EOF'
{
  "ollama": {
    "host": "http://10.0.0.24:11434",
    "model": "qwen2.5:latest"
  },
  "hub": {
    "port": 3002,
    "log_level": "info",
    "cors_origins": ["*"]
  },
  "mcps": {
    "enabled": ["serena", "context7"]
  }
}
EOF

echo "✅ Installation complete!"
echo ""
echo "📋 Summary:"
echo "   • Serena: $(pwd)/mcps/serena"
echo "   • Context7: $(pwd)/mcps/context7"
echo "   • Configuration updated to enable both MCPs"
echo ""
echo "🚀 Next steps:"
echo "   1. Run 'npm start' to start the hub"
echo "   2. Use the continue-config.yaml file with Continue extension"
echo "   3. Test with: curl http://localhost:3002/v1/tools"
echo ""