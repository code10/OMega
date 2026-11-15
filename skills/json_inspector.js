import fs from 'node:fs';
import { resolveSafePath } from '../dist/skills/filesystem.js';

function queryDotPath(obj, dotPath) {
  if (!dotPath) return obj;
  const parts = String(dotPath)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

/**
 * Custom Skill Plugin: JSON Inspector & Query
 * Safely validate, parse, and query JSON files or raw JSON strings.
 */
export const skill = {
  name: 'inspect_json',
  description: 'Validate and query a JSON file or JSON string using a dot/bracket path (e.g. "routing.fallbackChain[0].model").',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute path to a JSON file'
      },
      jsonText: {
        type: 'string',
        description: 'Raw JSON string to parse (used if path is not provided)'
      },
      query: {
        type: 'string',
        description: 'Optional dot/bracket path to extract a specific field'
      }
    }
  },
  execute: async ({ path: filePath, jsonText, query }, context = {}) => {
    try {
      let raw = jsonText;
      let resolvedPath = null;

      if (filePath) {
        resolvedPath = resolveSafePath(filePath, context.config?.workspaceDir, context);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `File not found: ${filePath}` };
        }
        raw = fs.readFileSync(resolvedPath, 'utf8');
      }

      if (typeof raw !== 'string' || !raw.trim()) {
        return { success: false, error: 'Either path or jsonText must be provided.' };
      }

      const parsed = JSON.parse(raw);
      const value = query ? queryDotPath(parsed, query) : parsed;

      return {
        success: true,
        ...(resolvedPath ? { path: resolvedPath } : {}),
        ...(query ? { query, found: value !== undefined } : {}),
        value: value === undefined ? null : value,
        topLevelKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : undefined
      };
    } catch (err) {
      return {
        success: false,
        error: `JSON inspection failed: ${err.message}`
      };
    }
  }
};
