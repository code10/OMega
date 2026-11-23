import fs from 'node:fs';
import path from 'node:path';
import type { SkillContext } from '../types.js';
import { getExecutionBackend } from '../execution/backend.js';
import { getFileDiagnostics } from './codeIntel.js';

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
    .filter((r): r is string => Boolean(r))
    .map((r) => resolveRealOrAbs(r));

  const isAllowed = allowedRoots.some((root) => isWithinRoot(resolvedTarget, root));
  if (!isAllowed) {
    throw new Error(`Security violation: Path '${filePath}' resolves outside the allowed workspace (${workspaceRoot}).`);
  }

  return resolvedTarget;
}

export const EXECUTABLE_SKILL_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'] as const;

export function isExecutableSkillFilename(filename: string): boolean {
  const lower = String(filename || '').toLowerCase();
  return EXECUTABLE_SKILL_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
  if (isWithinRoot(resolvedTarget, skillsDir) && isExecutableSkillFilename(baseName)) {
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
    execute: async ({ path: filePath, startLine, endLine }: { path: string; startLine?: number; endLine?: number }, context: SkillContext = {}) => {
      const backend = getExecutionBackend(context);
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!(await backend.exists(target))) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const stat = await backend.stat(target);
      if (stat.isDirectory) {
        return { success: false, error: `Target is a directory, not a file: ${filePath}. Use list_dir instead.` };
      }

      const content = await backend.readFile(target, 'utf8');
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
    execute: async ({ path: filePath, content }: { path: string; content: string }, context: SkillContext = {}) => {
      const backend = getExecutionBackend(context);
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
        assertWritablePath(target, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      const parentDir = path.dirname(target);

      if (!(await backend.exists(parentDir))) {
        await backend.mkdir(parentDir, { recursive: true });
      }

      await backend.writeFile(target, content, 'utf8');
      const diagnostics = await getFileDiagnostics(target, context.config?.workspaceDir || process.cwd(), 10);
      return {
        success: true,
        path: target,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        ...(diagnostics.length > 0 ? { diagnostics } : {})
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
    execute: async ({ path: dirPath = '.' }: { path?: string }, context: SkillContext = {}) => {
      const backend = getExecutionBackend(context);
      let target;
      try {
        target = resolveSafePath(dirPath, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!(await backend.exists(target))) {
        return { success: false, error: `Directory not found: ${dirPath}` };
      }

      const entries = await backend.readdir(target);
      const items = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile
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
    description: 'Replace one or more exact target snippets in a file without overwriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to modify' },
        targetText: { type: 'string', description: 'Exact string in the file to replace (for single edit)' },
        replacementText: { type: 'string', description: 'New string to insert in place of targetText' },
        edits: {
          type: 'array',
          description: 'Optional list of { targetText, replacementText } hunks to apply atomically',
          items: {
            type: 'object',
            properties: {
              targetText: { type: 'string' },
              replacementText: { type: 'string' }
            },
            required: ['targetText', 'replacementText']
          }
        }
      },
      required: ['path']
    },
    execute: async (
      { path: filePath, targetText, replacementText, edits }: {
        path: string;
        targetText?: string;
        replacementText?: string;
        edits?: Array<{ targetText: string; replacementText: string }>;
      },
      context: SkillContext = {}
    ) => {
      const backend = getExecutionBackend(context);
      let target;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
        assertWritablePath(target, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!(await backend.exists(target))) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const hunks: Array<{ targetText: string; replacementText: string }> = Array.isArray(edits) && edits.length > 0
        ? edits
        : typeof targetText === 'string' && typeof replacementText === 'string'
          ? [{ targetText, replacementText }]
          : [];

      if (hunks.length === 0) {
        return { success: false, error: 'Either targetText/replacementText or a non-empty edits array is required.' };
      }

      const raw = await backend.readFile(target, 'utf8');
      const usesCRLF = raw.includes('\r\n');
      let working = raw;

      for (let i = 0; i < hunks.length; i++) {
        const { targetText: tText, replacementText: rText } = hunks[i];
        if (working.includes(tText)) {
          working = working.replace(tText, () => rText);
        } else {
          // Retry with normalized line endings so LF snippets match CRLF files cleanly
          const normWorking = working.replace(/\r\n/g, '\n');
          const normTarget = tText.replace(/\r\n/g, '\n');
          if (!normWorking.includes(normTarget)) {
            return { success: false, error: `targetText not found in ${filePath}${hunks.length > 1 ? ` (edit #${i + 1})` : ''}` };
          }
          const normReplacement = rText.replace(/\r\n/g, '\n');
          const replaced = normWorking.replace(normTarget, () => normReplacement);
          working = usesCRLF ? replaced.replace(/\n/g, '\r\n') : replaced;
        }
      }

      await backend.writeFile(target, working, 'utf8');
      const diagnostics = await getFileDiagnostics(target, context.config?.workspaceDir || process.cwd(), 10);
      return {
        success: true,
        path: target,
        editsApplied: hunks.length,
        message: 'File successfully patched.',
        ...(diagnostics.length > 0 ? { diagnostics } : {})
      };
    }
  },

  {
    name: 'search_files',
    description: 'Search for text or regex matches within files in a directory recursively.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text, keyword, or regex pattern to search for' },
        dir: { type: 'string', description: 'Directory to search inside (default: current workspace)' },
        filePattern: { type: 'string', description: 'Optional filename/extension filter (e.g. "*.ts" or "router")' },
        regex: { type: 'boolean', description: 'Interpret query as a regular expression (default: false)' },
        maxResults: { type: 'number', description: 'Max matches to return (default: 20)' }
      },
      required: ['query']
    },
    execute: async ({ query, dir = '.', filePattern, regex = false, maxResults = 20 }: { query: string; dir?: string; filePattern?: string; regex?: boolean; maxResults?: number }, context: SkillContext = {}) => {
      const backend = getExecutionBackend(context);
      let targetDir: string;
      try {
        targetDir = resolveSafePath(dir, context.config?.workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!(await backend.exists(targetDir))) {
        return { success: false, error: `Directory not found: ${dir}` };
      }

      let matcher: RegExp | null = null;
      if (regex) {
        try {
          matcher = new RegExp(query, 'i');
        } catch (err: any) {
          return { success: false, error: `Invalid regex: ${err.message}` };
        }
      }

      let fileFilter: ((name: string) => boolean) | null = null;
      if (typeof filePattern === 'string' && filePattern.trim()) {
        const pat = filePattern.trim().toLowerCase();
        if (pat.startsWith('*.')) {
          const suffix = pat.slice(1);
          fileFilter = (name) => name.toLowerCase().endsWith(suffix);
        } else {
          fileFilter = (name) => name.toLowerCase().includes(pat);
        }
      }

      const results: any[] = [];
      const lowerQuery = query.toLowerCase();

      const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', '.gemini', 'dist', 'build', '.cache']);
      const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.tar', '.gz', '.bin', '.exe', '.dll', '.dylib', '.so']);
      const MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024; // 2MB

      async function walk(currentDir: string) {
        if (results.length >= maxResults) return;
        let entries;
        try {
          entries = await backend.readdir(currentDir);
        } catch (_: any) {
          return;
        }

        for (const entry of entries) {
          if (results.length >= maxResults) break;
          if (IGNORED_DIRS.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory) {
            await walk(fullPath);
          } else if (entry.isFile) {
            if (fileFilter && !fileFilter(entry.name)) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) continue;

            try {
              const stat = await backend.stat(fullPath);
              if (stat.size > MAX_SEARCH_FILE_SIZE) continue;

              const text = await backend.readFile(fullPath, 'utf8');
              // Check if file is binary (contains null bytes)
              if (text.includes('\0')) continue;

              const lines = text.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const matched = matcher ? matcher.test(lines[i]) : lines[i].toLowerCase().includes(lowerQuery);
                if (matched) {
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

      await walk(targetDir);
      return {
        success: true,
        query,
        matchCount: results.length,
        results
      };
    }
  },
  {
    name: 'move_file',
    description: 'Move or rename a file within the workspace.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source file path' },
        to: { type: 'string', description: 'Destination file path' }
      },
      required: ['from', 'to']
    },
    execute: async ({ from, to }: { from: string; to: string }, context: SkillContext = {}) => {
      let srcPath: string;
      let destPath: string;
      try {
        srcPath = resolveSafePath(from, context.config?.workspaceDir, context);
        destPath = resolveSafePath(to, context.config?.workspaceDir, context);
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!fs.existsSync(srcPath)) {
        return { success: false, error: `Source file not found: ${from}` };
      }
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.renameSync(srcPath, destPath);
        return { success: true, from: srcPath, to: destPath, summary: `Moved ${from} -> ${to}` };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file inside the workspace (requires human approval).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath }: { path: string }, context: SkillContext = {}) => {
      let target: string;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!fs.existsSync(target)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        return { success: false, error: `Refusing to delete directory '${filePath}' with delete_file.` };
      }

      const confirmFn = context.confirmCommand || (context.agent as { confirmCommand?: SkillContext['confirmCommand'] } | undefined)?.confirmCommand;
      if (!context.config?.security?.allowAllCommands || confirmFn) {
        if (!confirmFn) {
          return {
            success: false,
            error: `Tool 'delete_file' requires human approval (Delete ${filePath}), but no confirmation handler is attached.`
          };
        }
        const approved = await confirmFn({ tool: 'delete_file', command: `Delete file ${filePath}`, args: { path: filePath } });
        if (!approved) {
          return { success: false, error: `Delete rejected by user: ${filePath}` };
        }
      }

      try {
        fs.unlinkSync(target);
        return { success: true, path: target, summary: `Deleted ${filePath}` };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
];
