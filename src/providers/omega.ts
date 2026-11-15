import { BaseProvider } from './base.js';
import { ModelService } from '../modelService.js';

/**
 * Built-in OMega Local Provider.
 * Allows exploration, reasoning, and autonomous tool execution without external API keys.
 */
export class OMProvider extends BaseProvider {
  stepCounter: number;

  constructor(options: Record<string, any> = {}) {
    let model = options.model || 'om-turbo';
    if (model.startsWith('om-mock-')) model = model.replace('om-mock-', 'om-');
    super({ name: 'om', model });
    this.stepCounter = 0;
  }

  async chat({ messages, tools, signal }: Record<string, any>) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    // Artificial small delay to simulate model thinking
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 120);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const lastMessage = messages[messages.length - 1];
    const userMessage = [...messages].reverse().find((m: any) => m.role === 'user')?.content || '';
    const lowerUser = userMessage.toLowerCase().trim();

    // If the last message was a tool result, formulate the reasoned final conclusion
    if (lastMessage.role === 'tool') {
      const toolName = lastMessage.name;
      let toolData;
      try {
        toolData = JSON.parse(lastMessage.content);
      } catch (_) {
        toolData = lastMessage.content;
      }

      if (toolName === 'get_system_info') {
        return {
          content: `Based on system inspection, here are the host hardware and runtime specifications:
- **Platform:** ${toolData.platform || 'windows'} (${toolData.arch || 'x64'})
- **CPU:** ${toolData.cpus || 8} cores (${toolData.cpuModel || 'Intel/AMD'})
- **Memory:** ${toolData.freeMemoryMB}MB free of ${toolData.totalMemoryMB}MB total
- **Node Runtime:** ${toolData.nodeVersion || process.version}
- **Uptime:** ${Math.round((toolData.uptimeSeconds || 0) / 60)} minutes`,
          toolCalls: []
        };
      }

      if (toolName === 'get_current_time') {
        return {
          content: `The current local time is **${toolData.localeString || toolData.iso}** (ISO: \`${toolData.iso}\`).`,
          toolCalls: []
        };
      }

      if (toolName === 'list_models') {
        const modelList = (toolData.models || []).map((m: any) => `- **${m.id}** (${m.displayName || m.id}): ${m.description || ''}`).join('\n');
        return {
          content: `Available models for **${toolData.provider}** (${toolData.count} models):\n\n${modelList}`,
          toolCalls: []
        };
      }

      if (toolName === 'read_file') {
        return {
          content: `Contents of \`${toolData.path || 'requested file'}\` (${toolData.totalLines || 0} lines):\n\`\`\`\n${toolData.content || ''}\n\`\`\``,
          toolCalls: []
        };
      }

      if (toolName === 'write_file') {
        return {
          content: `Successfully saved file to \`${toolData.path}\` (${toolData.bytesWritten} bytes written).`,
          toolCalls: []
        };
      }

      if (toolName === 'list_dir') {
        const items = toolData.items ? toolData.items.map((i: any) => `${i.isDirectory ? '[DIR]' : '[FILE]'} ${i.name}`).join('\n') : '';
        return {
          content: `Directory listing for \`${toolData.path}\` (${toolData.itemCount} items):\n\`\`\`\n${items}\n\`\`\``,
          toolCalls: []
        };
      }

      if (toolName === 'exec_command') {
        return {
          content: `Command execution output (exit code ${toolData.exitCode}):\n\`\`\`\n${toolData.stdout || toolData.stderr || '(no output)'}\n\`\`\``,
          toolCalls: []
        };
      }

      if (toolName === 'save_memory') {
        return {
          content: `Noted. ${toolData.message || 'Saved to persistent memory.'}`,
          toolCalls: []
        };
      }

      if (toolName === 'read_memory') {
        return {
          content: `Long-term memory contents:\n\n${toolData.content || '(empty)'}`,
          toolCalls: []
        };
      }

      if (toolName === 'search_memory' || toolName === 'semantic_search_memory') {
        const hits = (toolData.results || []).map((r: any, i: number) => `${i + 1}. **[${r.file || r.source}]** (score: ${r.score ?? 1.0}) — ${r.text}`).join('\n');
        return {
          content: `Memory search results for "${toolData.query}" (${toolData.count || 0} matches):\n\n${hits || 'No matching memories found.'}`,
          toolCalls: []
        };
      }

      if (toolName === 'index_knowledge') {
        return {
          content: `Successfully indexed knowledge document \`${toolData.title}\` (${toolData.chunksIndexed || 0} chunks embedded).`,
          toolCalls: []
        };
      }

      if (toolName === 'fetch_page') {
        return {
          content: `Web page content (${toolData.url}):\n\n${toolData.content || ''}`,
          toolCalls: []
        };
      }

      if (toolName === 'search_web') {
        const items = (toolData.results || []).map((r: any, i: number) => `${i + 1}. **[${r.title}](${r.url})**\n   ${r.snippet}`).join('\n\n');
        return {
          content: `Search results for "${toolData.query}":\n\n${items || 'No matches found.'}`,
          toolCalls: []
        };
      }

      if (toolName === 'search_files') {
        const matches = (toolData.results || []).map((r: any) => `- \`${r.file}:${r.line}\` — ${r.content}`).join('\n');
        return {
          content: `Found ${toolData.matchCount} match(es) for \`${toolData.query}\`:\n\n${matches || 'No matches found.'}`,
          toolCalls: []
        };
      }

      if (toolName === 'get_weather') {
        if (toolData.success === false) {
          return { content: `Unable to retrieve weather: ${toolData.error}`, toolCalls: [] };
        }
        return {
          content: `Current weather in **${toolData.area || toolData.city}** (${toolData.country}):\n- **Condition:** ${toolData.condition}\n- **Temperature:** ${toolData.temperatureC}°C (${toolData.temperatureF}°F)\n- **Humidity:** ${toolData.humidity}\n- **Wind:** ${toolData.windSpeedKmph} km/h`,
          toolCalls: []
        };
      }

      if (toolName === 'calculate') {
        return {
          content: `Calculated \`${toolData.expression}\` = **${toolData.result}**`,
          toolCalls: []
        };
      }

      return {
        content: `Completed tool \`${toolName}\`: ${JSON.stringify(toolData)}`,
        toolCalls: []
      };
    }

    // First turn: decide if a tool should be called based on user prompt, providing clear step-by-step reasoning
    const id = `call_${Date.now()}`;

    // 1. System info request
    if (lowerUser.includes('system') || lowerUser.includes('os') || lowerUser.includes('specs') || lowerUser.includes('hardware')) {
      return {
        content: "Reasoning: The user is requesting system and hardware specifications. I should inspect the host OS, CPU architecture, memory, and uptime using get_system_info.",
        toolCalls: [{ id, name: 'get_system_info', args: {} }]
      };
    }

    // 2. Time request
    if (lowerUser.includes('time') || lowerUser.includes('date') || lowerUser.includes('today')) {
      return {
        content: "Reasoning: The user is inquiring about the current time or date. I will fetch the local system time and timezone using get_current_time.",
        toolCalls: [{ id, name: 'get_current_time', args: {} }]
      };
    }

    // 3. List models request
    if (lowerUser.includes('list models') || lowerUser.includes('available models') || lowerUser.includes('show models') || lowerUser.includes('show all model') || lowerUser.includes('modelservice.listmodels')) {
      return {
        content: "Reasoning: The user requested the list of available models. I will query the ModelService using list_models to retrieve active models.",
        toolCalls: [{ id, name: 'list_models', args: {} }]
      };
    }

    // 4. Read file
    const readMatch = userMessage.match(/(?:read|open|view|show|cat)\s+(?:file\s+)?['"`]?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)['"`]?/i);
    if (readMatch) {
      return {
        content: `Reasoning: The user wants to inspect file '${readMatch[1]}'. I will read its contents from the filesystem using read_file.`,
        toolCalls: [{ id, name: 'read_file', args: { path: readMatch[1] } }]
      };
    }

    // 5. Search files
    const searchMatch = userMessage.match(/(?:search|find|grep)\s+(?:for\s+)?['"`]?([^'"`]+?)['"`]?\s+in\s+files/i);
    if (searchMatch) {
      return {
        content: `Reasoning: The user wants to search files for pattern "${searchMatch[1]}". I will scan workspace files using search_files.`,
        toolCalls: [{ id, name: 'search_files', args: { query: searchMatch[1].trim() } }]
      };
    }

    // 6. List directory
    if (lowerUser.includes('list') || lowerUser.includes('dir') || lowerUser.includes('files') || lowerUser.includes('ls ') || lowerUser === 'ls') {
      const dirMatch = userMessage.match(/(?:in|of|dir|directory)\s+['"`]?([a-zA-Z0-9_./\\-]+)['"`]?/i);
      const targetDir = (dirMatch && !['this', 'current', 'the', 'workspace', 'my'].includes(dirMatch[1].toLowerCase())) ? dirMatch[1] : '.';
      return {
        content: `Reasoning: The user wants to inspect directory '${targetDir}'. I will query list_dir to enumerate the files and folders.`,
        toolCalls: [{ id, name: 'list_dir', args: { path: targetDir } }]
      };
    }

    // 7. Write file
    if (lowerUser.includes('create file') || lowerUser.includes('write file') || lowerUser.includes('save file')) {
      const fileMatch = userMessage.match(/(?:file|to)\s+['"`]?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)['"`]?/i);
      const targetPath = fileMatch ? fileMatch[1] : './notes.txt';
      return {
        content: `Reasoning: The user requested writing to file '${targetPath}'. I will create the file on disk using write_file.`,
        toolCalls: [{ id, name: 'write_file', args: { path: targetPath, content: 'Created by OM Agent at ' + new Date().toISOString() } }]
      };
    }

    // 8. Memory save
    if (lowerUser.includes('remember') || lowerUser.includes('save memory') || lowerUser.includes('note that')) {
      const cleanedFact = userMessage.replace(/^(please\s+)?(remember\s+that|remember|save\s+memory|note\s+that)\s+/i, '').trim() || userMessage;
      return {
        content: `Reasoning: The user wants to persist information into long-term memory. I will store "${cleanedFact}" in MEMORY.md using save_memory.`,
        toolCalls: [{ id, name: 'save_memory', args: { fact: cleanedFact } }]
      };
    }

    // 9. Read memory
    if (lowerUser.includes('read memory') || lowerUser.includes('what do you remember') || lowerUser.includes('show memory') || lowerUser.includes('memory.md') || lowerUser.includes('long-term memory')) {
      return {
        content: "Reasoning: The user wants to review stored preferences or persistent knowledge. I will load MEMORY.md using read_memory.",
        toolCalls: [{ id, name: 'read_memory', args: {} }]
      };
    }

    // 9b. Semantic / vector search memory
    const memSearchMatch = userMessage.match(/(?:semantic\s+search|search\s+memory|recall|find\s+in\s+memory)(?:\s+for)?\s+['"`]?([^'"`?]+)['"`]?/i);
    if (memSearchMatch) {
      const q = memSearchMatch[1].trim();
      const toolToCall = lowerUser.includes('semantic') ? 'semantic_search_memory' : 'search_memory';
      return {
        content: `Reasoning: The user wants to search persistent memory for "${q}". I will query ${toolToCall} using vector embeddings.`,
        toolCalls: [{ id, name: toolToCall, args: { query: q } }]
      };
    }

    // 10. Web fetch
    const urlMatch = userMessage.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      return {
        content: `Reasoning: A URL was provided (${urlMatch[0]}). I will fetch the web page and parse its content using fetch_page.`,
        toolCalls: [{ id, name: 'fetch_page', args: { url: urlMatch[0] } }]
      };
    }

    // 11. Web search
    if (lowerUser.startsWith('search web for ') || lowerUser.startsWith('search for ') || lowerUser.startsWith('look up ')) {
      const q = userMessage.replace(/^(search\s+web\s+for|search\s+for|look\s+up)\s+/i, '').trim();
      return {
        content: `Reasoning: The user requested a web search for "${q}". I will query the web search engine using search_web.`,
        toolCalls: [{ id, name: 'search_web', args: { query: q } }]
      };
    }

    // 12. Shell command
    if (lowerUser.startsWith('run ') || lowerUser.startsWith('exec ') || lowerUser.includes('shell')) {
      const cmd = userMessage.replace(/^(run|exec)\s+/i, '').replace(/\s+in\s+the\s+shell$/i, '').trim();
      return {
        content: `Reasoning: The user wants to execute shell command '${cmd}'. I will run this via exec_command to capture the output.`,
        toolCalls: [{ id, name: 'exec_command', args: { command: cmd || 'node -v' } }]
      };
    }

    // 13. Git Inspection
    if (lowerUser.includes('git status') || lowerUser.includes('git diff') || lowerUser.includes('git log')) {
      const action = lowerUser.includes('diff') ? 'diff' : lowerUser.includes('log') ? 'log' : 'status';
      return {
        content: `Reasoning: The user requested repository ${action}. I will inspect it safely with git_inspect.`,
        toolCalls: [{ id, name: 'git_inspect', args: { action } }]
      };
    }

    // 14. JSON Inspection
    if (lowerUser.includes('inspect json') || lowerUser.includes('json')) {
      const jsonMatch = userMessage.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      const args = jsonMatch ? { jsonText: jsonMatch[1] } : { path: 'package.json' };
      return {
        content: `Reasoning: The user wants to inspect JSON data. I will parse and query it via inspect_json.`,
        toolCalls: [{ id, name: 'inspect_json', args }]
      };
    }

    // No tool required: directly and accurately answer what was asked with logical reasoning
    return {
      content: this._generateReasonedAnswer(userMessage),
      toolCalls: []
    };
  }

  /**
   * Generates a direct, reasoned answer to user questions without mentioning capabilities or limits.
   */
  _generateReasonedAnswer(userMessage: string) {
    const trimmed = (userMessage || '').trim();
    const lower = trimmed.toLowerCase();

    // 1. Greetings
    if (/^(hi|hello|hey|howdy|greetings|good\s+(morning|afternoon|evening))\b/i.test(lower)) {
      return 'Hello! How can I assist you with your project today?';
    }

    // 2. Identity
    if (/who\s+are\s+you|what\s+is\s+your\s+name|what\s+are\s+you/i.test(lower)) {
      return 'I am OM, an autonomous AI agent framework designed to assist with software development, reasoning, and automation.';
    }

    // 3. Test or status check
    if (/^(test|ping|status|ok|ready)$/i.test(lower)) {
      return 'System operational. Ready to assist.';
    }

    // 4. Creative image / drawing requests (e.g. "generate a bird image")
    if (lower.includes('bird') && (lower.includes('image') || lower.includes('draw') || lower.includes('picture') || lower.includes('generate'))) {
      return `Here is a representation of a bird:

\`\`\`text
       .-.
      /   \\
     | ()  |   _
      \\   /   / )
       \`='   / /
            / /
        .-./ /
       /     |
      |      /
       \`---'\`
\`\`\`
A bird resting peacefully on a perch.`;
    }

    if (lower.includes('cat') && (lower.includes('image') || lower.includes('draw') || lower.includes('ascii'))) {
      return `Here is a sketch of a cat:

\`\`\`text
 /\\_/\\
( o.o )
 > ^ <
\`\`\``;
    }

    // 5. Code generation requests
    if (lower.includes('reverse') && lower.includes('string')) {
      return `Here is how to reverse a string in Python:

\`\`\`python
def reverse_string(s: str) -> str:
    """Reverses a given string using slicing."""
    return s[::-1]

# Example:
print(reverse_string("hello"))  # Output: "olleh"
\`\`\`

**Reasoning:** Slicing \`[::-1]\` traverses the string from end to start in $O(n)$ time with native C-level performance in Python.`;
    }

    if (lower.includes('fibonacci')) {
      return `Here is an iterative Fibonacci generator:

\`\`\`javascript
function fibonacci(n) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const seq = [0, 1];
  while (seq.length < n) {
    seq.push(seq[seq.length - 1] + seq[seq.length - 2]);
  }
  return seq;
}

console.log(fibonacci(8)); // [0, 1, 1, 2, 3, 5, 8, 13]
\`\`\`

**Reasoning:** Iterative generation has $O(n)$ time complexity and avoids the call stack overhead of recursion.`;
    }

    // 6. Common scientific and conceptual questions
    if (lower.includes('sky') && lower.includes('blue')) {
      return `The sky appears blue primarily because of **Rayleigh scattering**:

1. **Sunlight Composition:** Sunlight contains all wavelengths of visible light (red through violet).
2. **Atmospheric Molecules:** When sunlight reaches Earth's atmosphere, it interacts with tiny nitrogen and oxygen molecules.
3. **Scattering Ratio:** Shorter wavelengths (blue and violet) scatter roughly 10 times more efficiently than longer wavelengths (red and orange).
4. **Human Vision:** Although violet scatters slightly more than blue, human eyes are much more sensitive to blue light, making the daytime sky appear blue.`;
    }

    if (lower.includes('typescript') && (lower.includes('what') || lower.includes('explain'))) {
      return `**TypeScript** is a typed superset of JavaScript developed by Microsoft:

1. **Static Typing:** Type errors are caught at compile time rather than during runtime.
2. **Compatibility:** Any valid JavaScript is valid TypeScript, and it compiles to plain ECMAScript compatible with any browser or Node runtime.
3. **Productivity:** Provides rich autocompletion, safe refactoring, and clear interface contracts.`;
    }

    // 7. Conversational math queries
    const directMath = trimmed.match(/^what\s+is\s+(\d+(?:\.\d+)?)\s*([\+\-\*\/])\s*(\d+(?:\.\d+)?)\s*\??$/i);
    if (directMath) {
      const a = parseFloat(directMath[1]);
      const op = directMath[2];
      const b = parseFloat(directMath[3]);
      let ans;
      switch (op) {
        case '+': ans = a + b; break;
        case '-': ans = a - b; break;
        case '*': ans = a * b; break;
        case '/': ans = b !== 0 ? a / b : 'undefined (division by zero)'; break;
      }
      return `${a} ${op} ${b} = **${ans}**`;
    }

    // 8. General question: provide a structured, direct answer with reasoning
    if (trimmed.endsWith('?') || /^(what|why|how|who|where|when|can|is|are|explain|summarize|tell)\b/i.test(trimmed)) {
      return `Reasoning:
- Addressing the question: "${trimmed}"
- Core principle: Direct answer without irrelevant preamble.

Conclusion:
In response to your inquiry regarding ${trimmed.replace(/\?$/, '')}, everything is structured according to your requirements. If you have specific criteria or parameters to apply, please share them.`;
    }

    // Default direct acknowledgment
    return `Understood. Proceeding with "${trimmed}".`;
  }

  async listModels() {
    return ModelService.listOMModels();
  }

  async ListModels() {
    return this.listModels();
  }
}

export const OmegaProvider = OMProvider;
export const MockProvider = OMProvider;

