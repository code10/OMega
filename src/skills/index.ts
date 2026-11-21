import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { shellSkills } from './shell.js';
import { filesystemSkills } from './filesystem.js';
import { webSkills } from './web.js';
import { memorySkills } from './memory.js';
import { systemSkills } from './system.js';
import { subagentSkills } from './subagent.js';
import { gitSkills } from './git.js';
import { codeIntelSkills } from './codeIntel.js';
import { browserSkills } from './browser.js';
import { terminalSkills } from './terminal.js';
import type { SkillContext, SkillDefinition, SkillResult, ToolParametersSchema } from '../types.js';

/**
 * Lightweight frontmatter parser for SKILL.md files
 * @param {string} content - Markdown file content
 * @param {string} defaultName - Fallback name
 */
export function parseSkillMarkdown(content: string, defaultName = 'workflow-skill') {
  const trimmed = (content || '').trim();
  const fmMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!fmMatch) {
    return {
      name: defaultName,
      description: `Workflow playbook for ${defaultName}`,
      body: trimmed,
      triggers: [],
      disableModelInvocation: false,
      metadata: {}
    };
  }

  const rawFrontmatter = fmMatch[1];
  const body = fmMatch[2].trim();
  const meta: Record<string, string | boolean> = {};

  const lines = rawFrontmatter.split(/\r?\n/);
  let currentKey: string | null = null;
  let multilineVal: string[] = [];
  let isFolded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);

    if (keyMatch) {
      if (currentKey) {
        meta[currentKey] = isFolded ? multilineVal.join(' ').trim() : multilineVal.join('\n').trim();
      }
      currentKey = keyMatch[1];
      const val = keyMatch[2].trim();
      if (val === '>-' || val === '>' || val === '|' || val === '|-') {
        isFolded = val.startsWith('>');
        multilineVal = [];
      } else {
        isFolded = false;
        multilineVal = [val];
      }
    } else if (currentKey && (line.startsWith(' ') || line.startsWith('\t'))) {
      multilineVal.push(line.trim());
    }
  }

  if (currentKey) {
    meta[currentKey] = isFolded ? multilineVal.join(' ').trim() : multilineVal.join('\n').trim();
  }

  let triggers: string[] = [];
  if (meta.triggers) {
    if (typeof meta.triggers === 'string') {
      const cleaned = meta.triggers.replace(/^\[|\]$/g, '').trim();
      triggers = cleaned ? cleaned.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
    } else if (Array.isArray(meta.triggers)) {
      triggers = meta.triggers;
    }
  }

  let disableModelInvocation = false;
  if (meta['disable-model-invocation'] !== undefined) {
    disableModelInvocation = meta['disable-model-invocation'] === 'true' || meta['disable-model-invocation'] === true;
  } else if (meta.disableModelInvocation !== undefined) {
    disableModelInvocation = meta.disableModelInvocation === 'true' || meta.disableModelInvocation === true;
  }

  const name = typeof meta.name === 'string' ? meta.name.replace(/^['"]|['"]$/g, '').trim() : defaultName;
  const description = typeof meta.description === 'string' ? meta.description.replace(/^['"]|['"]$/g, '').trim() : `Workflow playbook for ${name}`;

  return {
    name,
    description,
    body,
    triggers,
    disableModelInvocation,
    metadata: meta
  };
}

export class SkillRegistry {
  skills: Map<string, SkillDefinition<any>>;

  constructor() {
    this.skills = new Map();
    this.registerBuiltIns();
  }

  registerBuiltIns() {
    for (const [name, skill] of this.skills.entries()) {
      if (skill.source === 'builtin') this.skills.delete(name);
    }
    for (const skill of [
      ...shellSkills,
      ...filesystemSkills,
      ...webSkills,
      ...memorySkills,
      ...systemSkills,
      ...subagentSkills,
      ...gitSkills,
      ...codeIntelSkills,
      ...browserSkills,
      ...terminalSkills
    ]) {
      this.register({ ...skill, source: 'builtin' }, 'builtin');
    }
  }

  /**
   * Register a new skill definition
   */
  register(skill: SkillDefinition<any>, sourceOverride?: string) {
    if (!skill || !skill.name) {
      throw new Error('Skill must have a name');
    }
    if (typeof skill.execute !== 'function') {
      throw new Error(`Skill '${skill.name}' must have an execute function`);
    }

    const normalized = {
      name: skill.name,
      description: skill.description || 'No description provided',
      parameters: skill.parameters || { type: 'object', properties: {} },
      execute: skill.execute,
      type: skill.type || 'function',
      body: skill.body || '',
      triggers: skill.triggers || [],
      disableModelInvocation: Boolean(skill.disableModelInvocation),
      references: skill.references || [],
      source: sourceOverride || skill.source || 'runtime'
    };

    this.skills.set(normalized.name, normalized);
    return this;
  }

  _registerModuleExports(
    module: {
      skill?: SkillDefinition<any>;
      skills?: SkillDefinition<any>[];
      default?: SkillDefinition<any> | SkillDefinition<any>[];
    },
    source = 'directory'
  ) {
    if (!module) return;
    if (Array.isArray(module.skills)) {
      module.skills.forEach((s) => this.register(s, source));
    } else if (module.skill) {
      this.register(module.skill, source);
    } else if (module.default && typeof module.default === 'object') {
      const def = module.default;
      if (Array.isArray(def)) {
        def.forEach((s) => this.register(s, source));
      } else if (def.name && typeof def.execute === 'function') {
        this.register(def, source);
      }
    }
  }

  get(name: string) {
    return this.skills.get(name);
  }

  has(name: string) {
    return this.skills.has(name);
  }

  list() {
    return Array.from(this.skills.values());
  }

  _validateArgs(parameters: ToolParametersSchema | Record<string, unknown>, args: Record<string, unknown>) {
    if (!parameters || typeof parameters !== 'object') return null;
    const safeArgs = args && typeof args === 'object' ? args : {};
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    for (const key of required) {
      if (safeArgs[key] === undefined || safeArgs[key] === null) {
        return `Missing required parameter '${key}'`;
      }
    }
    const props = (parameters.properties || {}) as Record<string, { type?: string } | undefined>;
    for (const [key, val] of Object.entries(safeArgs)) {
      const propSchema = props[key];
      if (!propSchema || val === undefined || val === null) continue;
      if (propSchema.type === 'string' && typeof val !== 'string') {
        return `Parameter '${key}' must be a string`;
      }
      if (propSchema.type === 'number' && (typeof val !== 'number' || Number.isNaN(val))) {
        return `Parameter '${key}' must be a number`;
      }
      if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
        return `Parameter '${key}' must be a boolean`;
      }
      if (propSchema.type === 'array' && !Array.isArray(val)) {
        return `Parameter '${key}' must be an array`;
      }
    }
    return null;
  }

  /**
   * Execute a skill safely
   */
  async execute(name: string, args: Record<string, unknown>, context: SkillContext = {}): Promise<SkillResult> {
    const skill = this.skills.get(name);
    if (!skill) {
      return {
        success: false,
        error: `Skill '${name}' not found. Available skills: ${Array.from(this.skills.keys()).join(', ')}`
      };
    }

    const validationError = this._validateArgs(skill.parameters, args || {});
    if (validationError) {
      return {
        success: false,
        error: `Invalid arguments for skill '${name}': ${validationError}`
      };
    }

    try {
      const res = await skill.execute(args || {}, context);
      return (res && typeof res === 'object' ? res : { success: true, value: res }) as SkillResult;
    } catch (err: any) {
      return {
        success: false,
        unhandled: true,
        stack: err?.stack,
        error: `Execution error in skill '${name}': ${err.message}`
      };
    }
  }

  /**
   * Dynamically load skills from a directory (with cache-busting for hot reload)
   * Supports .js/.mjs executable tools, subdirectories containing SKILL.md, and standalone .md files
   */
  async loadFromDirectory(dirPath: string) {
    // Only clear directory-loaded skills so MCP and runtime-registered skills are preserved
    for (const [name, skill] of this.skills.entries()) {
      if (skill.source === 'directory') this.skills.delete(name);
    }
    // Ensure built-ins are present
    if (!this.skills.has('read_file')) {
      this.registerBuiltIns();
    }

    if (!fs.existsSync(dirPath)) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err: any) {
      console.warn(`[SkillRegistry] Cannot read skills directory ${dirPath}: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.resolve(dirPath, entry.name);

      // 1. Single JS / MJS tool file in skills root
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        try {
          const stat = fs.statSync(fullPath);
          const fileUrl = `${pathToFileURL(fullPath).href}?t=${stat.mtimeMs}`;
          const module = await import(fileUrl);
          this._registerModuleExports(module);
        } catch (err: any) {
          console.warn(`[SkillRegistry] Failed to load skill from ${entry.name}: ${err.message}`);
        }
      }

      // 2. Directory with SKILL.md (workflow skill) or index.js
      else if (entry.isDirectory()) {
        const skillMdPath = path.join(fullPath, 'SKILL.md');
        const altSkillMdPath = path.join(fullPath, 'skill.md');
        const targetMdPath = fs.existsSync(skillMdPath)
          ? skillMdPath
          : (fs.existsSync(altSkillMdPath) ? altSkillMdPath : null);

        if (targetMdPath) {
          try {
            const content = fs.readFileSync(targetMdPath, 'utf8');
            const parsed = parseSkillMarkdown(content, entry.name);

            // Collect reference documentation if present (e.g. references/*.md)
            const refDir = path.join(fullPath, 'references');
            const references: string[] = [];
            if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
              try {
                references.push(...fs.readdirSync(refDir).filter((f) => f.endsWith('.md')));
              } catch (err: any) {
                console.warn(`[SkillRegistry] Could not read references in ${entry.name}: ${err.message}`);
              }
            }

            this.register({
              name: parsed.name,
              description: parsed.description,
              type: 'workflow',
              body: parsed.body,
              triggers: parsed.triggers,
              disableModelInvocation: parsed.disableModelInvocation,
              references,
              parameters: {
                type: 'object',
                properties: {
                  instruction: {
                    type: 'string',
                    description: 'Specific directive, sub-task, or parameters for this workflow'
                  }
                }
              },
              execute: async (args: Record<string, unknown> = {}, _context: SkillContext = {}) => {
                return {
                  success: true,
                  name: parsed.name,
                  type: 'workflow',
                  directive: parsed.body,
                  references,
                  input: args?.instruction || ''
                };
              }
            }, 'directory');
          } catch (err: any) {
            console.warn(`[SkillRegistry] Failed to load SKILL.md from directory ${entry.name}: ${err.message}`);
          }
        }

        // Also check if directory exports an index.js tool
        const jsIndexPath = path.join(fullPath, 'index.js');
        if (fs.existsSync(jsIndexPath)) {
          try {
            const stat = fs.statSync(jsIndexPath);
            const fileUrl = `${pathToFileURL(jsIndexPath).href}?t=${stat.mtimeMs}`;
            const module = await import(fileUrl);
            this._registerModuleExports(module);
          } catch (err: any) {
            console.warn(`[SkillRegistry] Failed to load index.js from directory ${entry.name}: ${err.message}`);
          }
        }
      }

      // 3. Standalone .md workflow file in skills root (e.g. skills/state.md)
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const defaultName = path.basename(entry.name, path.extname(entry.name));
          const parsed = parseSkillMarkdown(content, defaultName);
          this.register({
            name: parsed.name,
            description: parsed.description,
            type: 'workflow',
            source: 'directory',
            body: parsed.body,
            triggers: parsed.triggers,
            disableModelInvocation: parsed.disableModelInvocation,
            parameters: {
              type: 'object',
              properties: {
                instruction: {
                  type: 'string',
                  description: 'Specific directive, sub-task, or parameters for this workflow'
                }
              }
            },
            execute: async (args: Record<string, unknown> = {}, _context: SkillContext = {}) => {
              return {
                success: true,
                name: parsed.name,
                type: 'workflow',
                directive: parsed.body,
                input: args?.instruction || ''
              };
            }
          }, 'directory');
        } catch (err: any) {
          console.warn(`[SkillRegistry] Failed to load markdown skill from ${entry.name}: ${err.message}`);
        }
      }
    }
  }

  _getCallableTools() {
    return this.list().filter((s) => !s.disableModelInvocation && s.type !== 'workflow');
  }

  /**
   * Export to OpenAI function/tool calling format
   */
  toOpenAITools() {
    return this._getCallableTools().map((skill) => ({
      type: 'function',
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.parameters
      }
    }));
  }

  /**
   * Export to Anthropic tool format
   */
  toAnthropicTools() {
    return this._getCallableTools().map((skill) => ({
      name: skill.name,
      description: skill.description,
      input_schema: skill.parameters
    }));
  }

  /**
   * Export to Gemini function declaration format
   */
  toGeminiTools() {
    return [
      {
        functionDeclarations: this._getCallableTools().map((skill) => ({
          name: skill.name,
          description: skill.description,
          parameters: skill.parameters
        }))
      }
    ];
  }
}
