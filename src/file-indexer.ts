import winston from 'winston';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MCPManager } from './mcp-manager';

export interface FileInfo {
  name: string;
  extension: string;
  type: FileType;
  size?: number;
  lastModified: string;
}

export enum FileType {
  Documentation = 'documentation',
  Code = 'code',
  Binary = 'binary',
  BuildScript = 'buildScript',
  Configuration = 'configuration',
  Data = 'data',
  Test = 'test',
  Asset = 'asset',
  Unknown = 'unknown'
}

export interface FileIndex {
  version: string;
  lastUpdated: string;
  projectPath: string;
  totalFiles: number;
  totalDirectories: number;
  filesByType: Record<FileType, number>;
  files: Map<string, FileInfo>;
}

// Fixed-width format definition
interface ColumnFormat {
  name: string;
  start: number;
  width: number;
}

interface FileIndexerConfig {
  version: string;
  patterns: Record<string, string[]>;
  ignoredPatterns: string[];
}

export class FileIndexer {
  private logger: winston.Logger;
  private mcpManager: MCPManager;
  private index: FileIndex | null = null;
  private indexPath: string;
  private config: FileIndexerConfig;
  private compiledIgnorePatterns: RegExp[] = [];
  private _isReady: boolean = false;
  private buildingPromise: Promise<FileIndex> | null = null;
  private isCaseSensitive: boolean | null = null;
  
  constructor(mcpManager: MCPManager, logger: winston.Logger, indexPath: string, configPath?: string) {
    this.mcpManager = mcpManager;
    this.logger = logger;
    this.indexPath = indexPath;
    
    // Load configuration
    const defaultConfigPath = path.join(__dirname, '..', 'src', 'file-indexer-config.json');
    this.config = this.loadConfig(configPath || defaultConfigPath);
    
    // Compile ignore patterns from config
    this.compileIgnorePatterns();
    
    // Load existing index if available
    this.loadIndex();
  }
  
  private loadConfig(configPath: string): FileIndexerConfig {
    try {
      const configData = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData) as FileIndexerConfig;
      this.logger.info('Loaded file indexer configuration', { 
        version: config.version,
        path: configPath 
      });
      return config;
    } catch (error) {
      this.logger.error('Failed to load file indexer config, using defaults', { error });
      // Return minimal default config
      return {
        version: '1.0',
        patterns: {},
        ignoredPatterns: ['node_modules/', '.git/', 'dist/', 'build/']
      };
    }
  }
  
  private compileIgnorePatterns(): void {
    // Compile ignore patterns
    this.compiledIgnorePatterns = this.config.ignoredPatterns.map(p => {
      try {
        // Convert glob-like patterns to regex
        const regexPattern = this.globToRegex(p);
        return new RegExp(regexPattern, 'i');
      } catch (error) {
        this.logger.warn('Invalid ignore pattern', { pattern: p, error });
        return null;
      }
    }).filter(p => p !== null) as RegExp[];
    
    this.logger.debug('Compiled ignore patterns', {
      ignorePatterns: this.compiledIgnorePatterns.length
    });
  }
  
  private globToRegex(pattern: string): string {
    // Convert glob pattern to regex
    let regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\?/g, '.')
      .replace(/\*\*/g, '__DOUBLESTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLESTAR__/g, '.*');
    
    // Anchor the pattern
    if (!regexPattern.startsWith('^')) {
      regexPattern = '^' + regexPattern;
    }
    if (!regexPattern.endsWith('$')) {
      regexPattern = regexPattern + '$';
    }
    
    return regexPattern;
  }
  
  private matchesPattern(filePath: string, pattern: string): boolean {
    try {
      // If pattern contains / or **, test against full path
      if (pattern.includes('/') || pattern.includes('**')) {
        const regex = new RegExp(this.globToRegex(pattern), 'i');
        return regex.test(filePath);
      } else {
        // Otherwise, test against just the filename (like gitignore)
        const fileName = path.basename(filePath);
        const regex = new RegExp(this.globToRegex(pattern), 'i');
        return regex.test(fileName);
      }
    } catch (error) {
      return false;
    }
  }
  
  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        this.index = this.parseTextIndex(data);
        if (this.index) {
          this._isReady = true;
          this.logger.info('Loaded existing file index', {
            files: this.index?.totalFiles,
            lastUpdated: this.index?.lastUpdated
          });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load existing index', { error });
    }
  }
  
  public get isReady(): boolean {
    return this._isReady;
  }
  
  private saveIndex(): void {
    try {
      if (this.index) {
        const textContent = this.formatAsText(this.index);
        fs.writeFileSync(this.indexPath, textContent);
        this.logger.debug('Saved file index', { path: this.indexPath });
      }
    } catch (error) {
      this.logger.error('Failed to save index', { error });
    }
  }
  
  private classifyFile(filePath: string, fileName: string): FileType {
    // Test against patterns for each file type
    for (const [typeStr, patterns] of Object.entries(this.config.patterns)) {
      const type = typeStr as FileType;
      
      for (const pattern of patterns) {
        if (this.matchesPattern(filePath, pattern) || this.matchesPattern(fileName, pattern)) {
          this.logger.debug(`File classified: ${filePath} -> ${type} (pattern: ${pattern})`);
          return type;
        }
      }
    }
    
    this.logger.debug(`File not classified: ${filePath} (${fileName})`);
    return FileType.Unknown;
  }
  
  private shouldIgnoreFile(filePath: string): boolean {
    return this.compiledIgnorePatterns.some(pattern => pattern.test(filePath));
  }
  
  private formatAsText(index: FileIndex): string {
    const lines: string[] = [];
    
    // Add metadata header
    lines.push(`# File Index v${index.version}`);
    lines.push(`# Updated: ${index.lastUpdated}`);
    lines.push(`# Project: ${index.projectPath}`);
    lines.push(`# Total Files: ${index.totalFiles}`);
    lines.push(`# Total Directories: ${index.totalDirectories}`);
    lines.push('#');
    
    // Add file type summary
    lines.push('# Files by Type:');
    for (const [type, count] of Object.entries(index.filesByType)) {
      if (count > 0) {
        lines.push(`#   ${type}: ${count}`);
      }
    }
    lines.push('#');
    
    // Calculate column widths dynamically
    const typeWidth = Math.max(
      15, // minimum width
      ...Array.from(index.files.values()).map(f => f.type.length)
    );
    
    const pathWidth = Math.max(
      40, // minimum width
      ...Array.from(index.files.keys()).map(path => path.length)
    );
    
    // Create header with dynamic spacing
    const header = [
      'TYPE'.padEnd(typeWidth),
      'PATH'.padEnd(pathWidth),
      'MODIFIED'
    ].join('  ');
    
    lines.push(header);
    lines.push('-'.repeat(header.length));
    
    // Sort files by path for readability
    const sortedEntries = [...index.files.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    
    // Add file entries
    for (const [filePath, fileInfo] of sortedEntries) {
      const row = [
        fileInfo.type.padEnd(typeWidth),
        filePath.padEnd(pathWidth),
        fileInfo.lastModified
      ].join('  ');
      lines.push(row);
    }
    
    return lines.join('\n');
  }
  
  private parseTextIndex(content: string): FileIndex | null {
    try {
      const lines = content.split('\n');
      const index: FileIndex = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        projectPath: '.',
        totalFiles: 0,
        totalDirectories: 0,
        filesByType: {
          [FileType.Documentation]: 0,
          [FileType.Code]: 0,
          [FileType.Binary]: 0,
          [FileType.BuildScript]: 0,
          [FileType.Configuration]: 0,
          [FileType.Data]: 0,
          [FileType.Test]: 0,
          [FileType.Asset]: 0,
          [FileType.Unknown]: 0
        },
        files: new Map()
      };
      
      let headerLine: string | null = null;
      let columnPositions: Map<string, { start: number, end: number }> = new Map();
      
      for (const line of lines) {
        // Skip empty lines
        if (!line.trim()) continue;
        
        // Parse metadata
        if (line.startsWith('# ')) {
          const metaLine = line.substring(2);
          if (metaLine.startsWith('Updated: ')) {
            index.lastUpdated = metaLine.substring(9);
          } else if (metaLine.startsWith('Project: ')) {
            index.projectPath = metaLine.substring(9);
          } else if (metaLine.startsWith('Total Files: ')) {
            index.totalFiles = parseInt(metaLine.substring(13));
          } else if (metaLine.startsWith('Total Directories: ')) {
            index.totalDirectories = parseInt(metaLine.substring(19));
          } else if (metaLine.includes(': ') && !metaLine.startsWith('Files by Type:')) {
            // Parse file type counts
            const match = metaLine.trim().match(/^(\w+): (\d+)$/);
            if (match) {
              const [, type, count] = match;
              if (type in index.filesByType) {
                index.filesByType[type as FileType] = parseInt(count);
              }
            }
          }
          continue;
        }
        
        // Skip separator line
        if (line.match(/^-+$/)) continue;
        
        // Detect header line and calculate column positions
        if (!headerLine && line.includes('TYPE') && line.includes('PATH')) {
          headerLine = line;
          
          // Find column positions based on header
          const typeStart = line.indexOf('TYPE');
          const pathStart = line.indexOf('PATH');
          const modifiedStart = line.indexOf('MODIFIED');
          
          columnPositions.set('TYPE', { 
            start: typeStart, 
            end: pathStart - 2  // account for spacing
          });
          columnPositions.set('PATH', { 
            start: pathStart, 
            end: modifiedStart - 2 
          });
          columnPositions.set('MODIFIED', { 
            start: modifiedStart, 
            end: line.length 
          });
          
          continue;
        }
        
        // Parse data rows
        if (headerLine && columnPositions.size > 0) {
          const typeCol = columnPositions.get('TYPE')!;
          const pathCol = columnPositions.get('PATH')!;
          const modCol = columnPositions.get('MODIFIED')!;
          
          const type = line.substring(typeCol.start, typeCol.end).trim();
          const path = line.substring(pathCol.start, pathCol.end).trim();
          const modified = line.substring(modCol.start).trim();
          
          if (type && path) {
            const fileInfo: FileInfo = {
              name: path.split('/').pop() || path,
              extension: path.includes('.') ? path.substring(path.lastIndexOf('.')) : '',
              type: type as FileType,
              lastModified: modified
            };
            
            index.files.set(path, fileInfo);
          }
        }
      }
      
      return index;
    } catch (error) {
      this.logger.error('Failed to parse text index', { error });
      return null;
    }
  }
  
  public async startBackgroundIndexing(forceRefresh: boolean = false): Promise<void> {
    if (this.buildingPromise) {
      this.logger.debug('Index building already in progress');
      return;
    }
    
    this.logger.info('Starting background file indexing', { forceRefresh });
    this.buildingPromise = this.buildIndex(forceRefresh).catch(error => {
      this.logger.error('Background indexing failed', { error });
      throw error;
    });
  }

  private async detectCaseSensitivity(): Promise<boolean> {
    if (this.isCaseSensitive !== null) {
      return this.isCaseSensitive;
    }

    try {
      const testDir = path.join(os.tmpdir(), 'case-test-' + Date.now());
      fs.mkdirSync(testDir);
      
      const file1 = path.join(testDir, 'Test.txt');
      const file2 = path.join(testDir, 'test.txt');
      
      fs.writeFileSync(file1, 'test');
      const isCaseSensitive = !fs.existsSync(file2);
      
      // Cleanup
      fs.rmSync(testDir, { recursive: true });
      
      this.isCaseSensitive = isCaseSensitive;
      this.logger.debug('Filesystem case sensitivity detected', { isCaseSensitive });
      return isCaseSensitive;
    } catch (error) {
      // Fallback to platform detection
      this.isCaseSensitive = process.platform === 'linux';
      this.logger.warn('Failed to detect case sensitivity, using platform fallback', { 
        error, 
        fallback: this.isCaseSensitive 
      });
      return this.isCaseSensitive;
    }
  }

  
  public async buildIndex(forceRefresh: boolean = false): Promise<FileIndex> {
    // Clear in-memory index if forcing refresh
    if (forceRefresh) {
      this.index = null;
    }
    
    // If already building, wait for that to complete
    if (this.buildingPromise) {
      this.logger.debug('Waiting for existing build to complete');
      return this.buildingPromise;
    }
    
    // Update the index
    this.buildingPromise = this.performUpdate().catch(error => {
      this.logger.error('Index update failed', { error });
      throw error;
    });
    
    return this.buildingPromise;
  }

  private async performUpdate(): Promise<FileIndex> {
    this.logger.info('Updating file index');
    
    if (!this.mcpManager.areAllProcessesReady) {
      throw new Error('MCP tools not ready');
    }
    
    try {
      
      // Get recursive directory listing
      const result = await this.mcpManager.callMCPTool('list_dir', {
        relative_path: '.',
        recursive: true
      });
      const data = JSON.parse(result);
      
      const files = new Map<string, FileInfo>();
      const filesByType: Record<FileType, number> = {
        [FileType.Documentation]: 0,
        [FileType.Code]: 0,
        [FileType.Binary]: 0,
        [FileType.BuildScript]: 0,
        [FileType.Configuration]: 0,
        [FileType.Data]: 0,
        [FileType.Test]: 0,
        [FileType.Asset]: 0,
        [FileType.Unknown]: 0
      };

      let changedCount = 0;
      
      // First, check existing files for changes and deletions
      for (const [oldPath, oldFile] of this.index?.files ?? new Map<string, FileInfo>()) {
        if (this.shouldIgnoreFile(oldPath)) {
          continue;
        }

        if (data.files.includes(oldPath)) {
          // File still exists, check if modified
          let currentModified: string;
          try {
            const stats = fs.statSync(oldPath);
            currentModified = stats.mtime.toISOString();
          } catch (error) {
            this.logger.warn(`Failed to stat file ${oldPath}`, { error });
            continue;
          }

          if (oldFile.lastModified !== currentModified) {
            // File modified, reprocess it
            changedCount++;
            
            const fileName = path.basename(oldPath);
            const extension = path.extname(fileName).toLowerCase();
            const type = this.classifyFile(oldPath, fileName);

            const fileInfo: FileInfo = {
              name: fileName,
              extension,
              type,
              lastModified: currentModified
            };

            files.set(oldPath, fileInfo);
            filesByType[type]++;
            
            this.logger.debug(`Updated file: ${oldPath} (modified)`);
          } else {
            // File unchanged, keep existing entry
            files.set(oldPath, oldFile);
            filesByType[oldFile.type]++;
          }
        } else {
          // File deleted
          changedCount++;
          this.logger.debug(`Removed deleted file: ${oldPath}`);
        }
      }

      // Second, check for new files
      for (const filePath of data.files) {
        if (this.shouldIgnoreFile(filePath)) {
          continue;
        }

        if (!files.has(filePath)) {
          // New file, process it
          changedCount++;
          
          let currentModified: string;
          try {
            const stats = fs.statSync(filePath);
            currentModified = stats.mtime.toISOString();
          } catch (error) {
            this.logger.warn(`Failed to stat file ${filePath}`, { error });
            continue;
          }

          const fileName = path.basename(filePath);
          const extension = path.extname(fileName).toLowerCase();
          const type = this.classifyFile(filePath, fileName);

          const fileInfo: FileInfo = {
            name: fileName,
            extension,
            type,
            lastModified: currentModified
          };

          files.set(filePath, fileInfo);
          filesByType[type]++;
          
          this.logger.debug(`Updated file: ${filePath} (new)`);
        }
      }
      
      // Count directories but don't index them
      let totalDirectories = 0;
      if (data.dirs) {
        totalDirectories = data.dirs.filter((dirPath: string) => !this.shouldIgnoreFile(dirPath)).length;
      }
      
      // Create the index
      this.index = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        projectPath: '.',
        totalFiles: files.size,
        totalDirectories,
        filesByType,
        files
      };
      
      // Save the index
      this.saveIndex();
      
      // Mark as ready
      this._isReady = true;
      
      this.logger.info('File index updated successfully', {
        totalFiles: this.index.totalFiles,
        totalDirectories: this.index.totalDirectories,
        changedFiles: changedCount,
        filesByType: this.index.filesByType
      });
      
      // Clear building promise
      this.buildingPromise = null;
      
      return this.index;
    } catch (error) {
      this.logger.error('Failed to build file index', { error });
      throw error;
    }
  }
  
  
  public getIndex(): FileIndex | null {
    return this.index;
  }
  
  public async getIndexSummary(): Promise<{
    lastUpdated: string;
    totalFiles: number;
    totalDirectories: number;
    filesByType: Record<FileType, number>;
    indexAge: string;
  }> {
    const index = await this.buildIndex();
    const ageMs = Date.now() - new Date(index.lastUpdated).getTime();
    const ageMinutes = Math.floor(ageMs / 60000);
    const ageSeconds = Math.floor((ageMs % 60000) / 1000);
    
    return {
      lastUpdated: index.lastUpdated,
      totalFiles: index.totalFiles,
      totalDirectories: index.totalDirectories,
      filesByType: index.filesByType,
      indexAge: `${ageMinutes}m ${ageSeconds}s`
    };
  }
  
  public async getContextForLLM(fileTypes?: FileType[]): Promise<string> {
    const index = await this.buildIndex();
    const typesToInclude = fileTypes || [FileType.Code, FileType.Configuration, FileType.BuildScript];
    
    const relevantFiles = Array.from(index.files.entries()).filter(([path, f]) => 
      typesToInclude.includes(f.type)
    );
    
    // Group files by type and directory
    const grouped: Record<string, Record<string, string[]>> = {};
    
    for (const [filePath, fileInfo] of relevantFiles) {
      const dir = path.dirname(filePath);
      if (!grouped[fileInfo.type]) {
        grouped[fileInfo.type] = {};
      }
      if (!grouped[fileInfo.type][dir]) {
        grouped[fileInfo.type][dir] = [];
      }
      grouped[fileInfo.type][dir].push(fileInfo.name);
    }
    
    // Build context string
    let context = `Project Structure Summary (${index.totalFiles} files, ${index.totalDirectories} directories):\n\n`;
    
    for (const [type, dirs] of Object.entries(grouped)) {
      context += `${type.toUpperCase()} FILES:\n`;
      for (const [dir, files] of Object.entries(dirs)) {
        context += `  ${dir}/\n`;
        for (const file of files.slice(0, 10)) { // Limit files per directory
          context += `    - ${file}\n`;
        }
        if (files.length > 10) {
          context += `    ... and ${files.length - 10} more\n`;
        }
      }
      context += '\n';
    }
    
    return context;
  }
}