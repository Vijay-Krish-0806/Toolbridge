import { z } from 'zod';
import type { ToolDefinition } from '../llm/types.js';
import type { Tool } from './tool.js';

/** Holds the tools available in a run, looked up by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Registers each given tool; see `register` for the rules. */
  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /** Adds a tool. Names must be unique, because the model picks tools by name. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Finds a tool by the name the model used, or undefined if no such tool exists. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** All registered tool names, used to tell the model what it can call instead. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The tool "menu" sent to the model: each tool's Zod schema converted to JSON Schema.
   * `io: 'input'` describes what the model may send, so fields with defaults are optional.
   * The `$schema` line is dropped because it costs tokens and tells the model nothing.
   */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => {
      const schema = z.toJSONSchema(tool.input, { io: 'input' });
      delete schema.$schema;
      return { name: tool.name, description: tool.description, parameters: { ...schema } };
    });
  }
}
