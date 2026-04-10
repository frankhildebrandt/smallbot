import type { WorkerAiToolName } from "../contracts.js";
import type { AiFunctionToolDefinition } from "../types/taskWorkerTypes.js";

export const IMPLEMENTATION_TOOLS: Array<AiFunctionToolDefinition & { name: WorkerAiToolName }> = [
  {
    type: "function",
    name: "list_files",
    description: "List files under the worker storage root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional relative directory inside storage." },
        limit: { type: "number", description: "Maximum number of paths to return." },
      },
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from worker storage.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside storage." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 text file inside worker storage.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside storage." },
        content: { type: "string", description: "Full replacement file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "search_files",
    description: "Search file paths and text contents inside worker storage.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-text query to search for." },
        path: { type: "string", description: "Optional relative directory inside storage." },
        limit: { type: "number", description: "Maximum number of matches to return." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a new open implementation task managed by the worker.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "update_task",
    description: "Update an existing worker-managed implementation task.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing task id." },
        status: { type: "string", description: "Task status: open or done." },
        title: { type: "string", description: "Optional replacement task title." },
      },
      required: ["id", "status"],
    },
  },
  {
    type: "function",
    name: "list_tasks",
    description: "List the current worker-managed implementation tasks.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web through the configured search module.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        language: { type: "string" },
        region: { type: "string" },
        safeSearch: { type: "string" },
        site: { type: "string" },
        freshness: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "execute_typescript",
    description: "Execute arbitrary TypeScript with full Node.js access. Use this for package installs, shell commands, code generation, or any implementation step best handled by running TypeScript directly.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "TypeScript source code to execute." },
      },
      required: ["script"],
    },
  },
];
