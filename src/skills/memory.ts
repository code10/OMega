import type { SkillContext, SkillDefinition } from '../types.js';
import { distillMemory } from '../memory/distiller.js';

/**
 * Memory & Vector Semantic Search skills for OM Agent
 */
export const memorySkills: SkillDefinition[] = [
  {
    name: 'save_memory',
    description: 'Save an important fact, user preference, workflow rule, or persistent knowledge into OM long-term memory (MEMORY.md) and index its vector embedding.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact or piece of information to remember' },
        category: { type: 'string', description: 'Optional category header (e.g. "User Preferences", "Project Context", "Learned Facts & Notes")' }
      },
      required: ['fact']
    },
    execute: async ({ fact, category }, context: SkillContext = {}) => {
      if (!context.memory) {
        return { success: false, error: 'Memory system not available in this context' };
      }
      context.memory.appendFact(fact, category);
      return {
        success: true,
        message: `Fact recorded to long-term memory and indexed in vector store: "${fact}"`
      };
    }
  },

  {
    name: 'read_memory',
    description: 'Read the contents of the persistent MEMORY.md file.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async (_, context: SkillContext = {}) => {
      if (!context.memory) {
        return { success: false, error: 'Memory system not available in this context' };
      }
      const content = context.memory.readLongTermMemory();
      return {
        success: true,
        content
      };
    }
  },

  {
    name: 'search_memory',
    description: 'Search through long-term memory, daily journal logs, past sessions, and indexed knowledge using hybrid keyword + vector semantic search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword, phrase, or natural language semantic query' },
        topK: { type: 'number', description: 'Maximum number of matches to return (default 8)' },
        sourceFilter: { type: 'string', description: 'Optional source prefix filter ("MEMORY.md", "daily/", "sessions/", "knowledge/")' }
      },
      required: ['query']
    },
    execute: async ({ query, topK = 8, sourceFilter }, context: SkillContext = {}) => {
      if (!context.memory) {
        return { success: false, error: 'Memory system not available in this context' };
      }
      const results = context.memory.search(query, { topK, sourceFilter });
      return {
        success: true,
        query,
        count: results.length,
        results
      };
    }
  },

  {
    name: 'index_knowledge',
    description: 'Index a document, note, or project file into the local vector embedding store for semantic retrieval across sessions.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title or file identifier (e.g. "architecture-notes")' },
        content: { type: 'string', description: 'Full text content to chunk and embed into the vector knowledge base' }
      },
      required: ['title', 'content']
    },
    execute: async ({ title, content }, context: SkillContext = {}) => {
      if (!context.memory) {
        return { success: false, error: 'Memory system not available in this context' };
      }
      const chunksIndexed = context.memory.indexKnowledge(title, content);
      return {
        success: true,
        title,
        chunksIndexed,
        message: `Indexed ${chunksIndexed} chunk(s) into local vector store under 'knowledge/${title}'`
      };
    }
  },

  {
    name: 'distill_memory',
    description: 'Run zero-token algorithmic distillation on daily journals and session logs to extract architectural heuristics, deduplicate facts, and prune redundant turns.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional YYYY-MM-DD date to distill' },
        prune: { type: 'boolean', description: 'Whether to prune redundant session turns and compress old daily logs (default true)' }
      }
    },
    execute: async ({ date, prune = true }, context: SkillContext = {}) => {
      if (!context.memory) {
        return { success: false, error: 'Memory system not available in this context' };
      }
      return distillMemory(context.memory, { date, prune, useLLM: false });
    }
  }
];
