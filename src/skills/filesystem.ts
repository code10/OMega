import fs from 'node:fs';
import path from 'node:path';
import type { SkillContext } from '../types.js';

function resolveRealOrAbs(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync(abs);
    } catch (_: any) {
      return abs;
    }
  }
  const parent = path.dirname(abs);
  if (parent && parent !== abs) {
    return path.join(resolveRealOrAbs(parent), path.basename(abs));
  }
  return abs;
}

function isWithinRoot(target: string, root: string) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveSafePath(filePath: string, baseDir = process.cwd(), context: SkillContext = {}) {
  const security = context?.config?.security || {};
  const workspaceRoot = resolveRealOrAbs(baseDir || process.cwd());
  const rawTarget = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspaceRoot, filePath);
  const resolvedTarget = resolveRealOrAbs(rawTarget);

  if (security.allowExternalPaths === true) {
    return resolvedTarget;
  }

  const allowedRoots = [
    workspaceRoot,
    context?.config?.memoryDir,
    context?.config?.skillsDir,
    ...(Array.isArray(security.allowedPaths) ? security.allowedPaths : [])
  ]
    .filter(Boolean)
    .map((r) => resolveRealOrAbs(r));

  const isAllowed = allowedRoots.some((root) => isWithinRoot(resolvedTarget, root));
  if (!isAllowed) {
    throw new Error(`Security violation: Path '${filePath}' resolves outside the allowed workspace (${workspaceRoot}).`);
  }

  return resolvedTarget;
}

export function assertWritablePath(resolvedTarget: string, context: SkillContext = {}) {
  const security = context?.config?.security || {};
  if (security.allowSelfModification === true) {
    return;
  }

  const baseName = path.basename(resolvedTarget).toLowerCase();
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    throw new Error(`Security violation: '${baseName}' is write-protected against self-modification.`);
  }

  const projectRoot = resolveRealOrAbs(context?.config?.rootDir || context?.config?.workspaceDir || process.cwd());
  const protectedFiles = ['om.config.json', 'package.json', 'package-lock.json']
    .map((f) => path.join(projectRoot, f));
  if (protectedFiles.some((pf) => pf.toLowerCase() === resolvedTarget.toLowerCase())) {
    throw new Error(`Security violation: '${baseName}' is write-protected against self-modification.`);
  }

  const protectedDirs = ['src', '.git'].map((d) => path.join(projectRoot, d));
  if (protectedDirs.some((pd) => isWithinRoot(resolvedTarget, pd))) {
    throw new Error(`Security violation: Writing inside '${path.relative(projectRoot, resolvedTarget)}' is blocked to prevent self-modification.`);
  }

  const skillsDir = resolveRealOrAbs(context?.config?.skillsDir || path.join(projectRoot, 'skills'));
  if (isWithinRoot(resolvedTarget, skillsDir) && baseName.endsWith('.js')) {
    throw new Error(`Security violation: Writing executable skill '${baseName}' inside skillsDir is blocked to prevent self-modification.`);
  }
}

export const filesystemSkills = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from disk. Can read line ranges or the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        startLine: { type: 'number', description: 'Optional 1-based start line number' },
        endLine: { type: 'number', description: 'Optional 1-based end line number' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath, startLine, endLine }: Record<string, any>, context: SkillContext = {}) => {
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        return { success: false, error: `Target is a directory, not a file: ${filePath}. Use list_dir instead.` };
      }

      const content = fs.readFileSync(target, 'utf8');
      const lines = content.split('\n');

      if (startLine !== undefined || endLine !== undefined) {
        const s = Math.max(1, startLine || 1);
        const e = Math.min(lines.length, endLine || lines.length);
        const sliced = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n');
        return {
          success: true,
          path: target,
          totalLines: lines.length,
          displayedLines: `${s}-${e}`,
          content: sliced
        };
      }

      // Truncate if gigantic (over 50KB)
      const MAX_BYTES = 50 * 1024;
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
        const truncated = content.slice(0, MAX_BYTES);
        return {
          success: true,
          path: target,
          totalLines: lines.length,
          truncated: true,
          content: truncated + `\n\n... [Content truncated at ${MAX_BYTES} bytes. Use startLine/endLine to view more]`
        };
      }

      return {
        success: true,
        path: target,
        totalLines: lines.length,
        content
      };
    }
  },

  {
    name: 'write_file',
    description: 'Create or overwrite a file on disk with the specified content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to write the file to' },
        content: { type: 'string', description: 'The text content to write into the file' }
      },
      required: ['path', 'content']
    },
    execute: async ({ path: filePath, content }: Record<string, any>, context: SkillContext = {}) => {
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
        assertWritablePath(target, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      const parentDir = path.dirname(target);

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(target, content, 'utf8');
      return {
        success: true,
        path: target,
        bytesWritten: Buffer.byteLength(content, 'utf8')
      };
    }
  },

  {
    name: 'list_dir',
    description: 'List files and directories inside a given directory path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (defaults to current workspace directory)' }
      }
    },
    execute: async ({ path: dirPath = '.' }, context: SkillContext = {}) => {
      let target;
      try {
        target = resolveSafePath(dirPath, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) {
        return { success: false, error: `Directory not found: ${dirPath}` };
      }

      const entries = fs.readdirSync(target, { withFileTypes: true });
      const items = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }));

      return {
        success: true,
        path: target,
        itemCount: items.length,
        items
      };
    }
  },

  {
    name: 'patch_file',
    description: 'Replace an exact target snippet in a file with new content without overwriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to modify' },
        targetText: { type: 'string', description: 'Exact string in the file to replace' },
        replacementText: { type: 'string', description: 'New string to insert in place of targetText' }
      },
      required: ['path', 'targetText', 'replacementText']
    },
    execute: async ({ path: filePath, targetText, replacementText }: Record<string, any>, context: SkillContext = {}) => {
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
        assertWritablePath(target, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const content = fs.readFileSync(target, 'utf8');
      if (!content.includes(targetText)) {
        return { success: false, error: `targetText not found in ${filePath}` };
      }

      const updated = content.replace(targetText, () => replacementText);
      fs.writeFileSync(target, updated, 'utf8');
      return {
        success: true,
        path: target,
        message: 'File successfully patched.'
      };
    }
  },

  {
    name: 'search_files',
    description: 'Search for text matches within files in a directory recursively.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or keyword to search for' },
        dir: { type: 'string', description: 'Directory to search inside (default: current workspace)' },
        maxResults: { type: 'number', description: 'Max matches to return (default: 20)' }
      },
      required: ['query']
    },
    execute: async ({ query, dir = '.', maxResults = 20 }: Record<string, any>, context: SkillContext = {}) => {
      let targetDir: string;
      try {
        targetDir = resolveSafePath(dir, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(targetDir)) {
        return { success: false, error: `Directory not found: ${dir}` };
      }

      const results: any[] = [];
      const lowerQuery = query.toLowerCase();

      const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', '.gemini', 'dist', 'build', '.cache']);
      const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.tar', '.gz', '.bin', '.exe', '.dll', '.dylib', '.so']);
      const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024; // 2MB

      function walk(currentDir: string) {
        if (results.length >= maxResults) return;
        let entries;
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (_: any) {
          return;
        }

        for (const entry of entries) {
          if (results.length >= maxResults) break;
          if (IGNORED_DIRS.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) continue;

            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > MAX_SEARCH_FILE_SIZE) continue;

              const text = fs.readFileSync(fullPath, 'utf8');
              // Check if file is binary (contains null bytes)
              if (text.includes('\0')) continue;

              const lines = text.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(lowerQuery)) {
                  results.push({
                    file: path.relative(targetDir, fullPath),
                    line: i + 1,
                    content: lines[i].trim()
                  });
                  if (results.length >= maxResults) break;
                }
              }
            } catch (_: any) {
              // Ignore unreadable files
            }
          }
        }
      }

      walk(targetDir);
      return {
        success: true,
        query,
        matchCount: results.length,
        results
      };
    }
  }
];
