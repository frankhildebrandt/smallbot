import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ModuleRuntime, WireMessage, createMessage } from "@smallbot/framework";

import { AiModuleError } from "./errors.js";
import { parseAiInferenceRequest } from "./requests.js";
import { AiProvider } from "./providers/base.js";

export class AiService {
  constructor(
    private readonly runtime: ModuleRuntime,
    private readonly provider: AiProvider,
    private readonly serviceName: string,
    private readonly dataPath: string,
  ) {}

  async onMessage(message: WireMessage): Promise<void> {
    if (message.c !== "tool") {
      return;
    }

    await this.runtime.updateState("busy");

    try {
      const request = parseAiInferenceRequest(message.m);
      const response = await this.provider.complete(message.i, request);
      await this.logUsage(response);

      await this.runtime.send(
        createMessage({
          s: this.serviceName,
          t: message.s,
          c: "result",
          i: message.i,
          m: response,
        }),
      );
    } catch (error) {
      const aiError = normalizeError(error);
      await this.logError(message.i, aiError);
      await this.runtime.send(
        createMessage({
          s: this.serviceName,
          t: message.s,
          c: "error",
          i: message.i,
          m: {
            requestId: message.i,
            responder: this.serviceName,
            reason: aiError.message,
            code: aiError.code,
            ...(aiError.details ? { details: aiError.details } : {}),
          },
        }),
      );
    } finally {
      await this.runtime.updateState("free");
    }
  }

  private async logUsage(response: { requestId: string; provider: string; model: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }): Promise<void> {
    if (!response.usage) {
      return;
    }

    const record = `[${new Date().toISOString()}] request=${response.requestId} provider=${response.provider} model=${response.model} input_tokens=${response.usage.inputTokens ?? "n/a"} output_tokens=${response.usage.outputTokens ?? "n/a"} total_tokens=${response.usage.totalTokens ?? "n/a"}`;
    console.log(`[module:${this.serviceName}] inference usage ${record.slice(record.indexOf("request="))}`);
    await this.appendLog("usage.log", `${record}\n`);
  }

  private async logError(requestId: string, error: AiModuleError): Promise<void> {
    const detailText = error.details ? ` details=${safeStringify(error.details)}` : "";
    const record = `[module:${this.serviceName}] inference error request=${requestId} provider=${this.provider.name} code=${error.code} reason=${error.message}${detailText}`;
    console.error(record);
    await this.appendLog("error.log", `[${new Date().toISOString()}] request=${requestId} provider=${this.provider.name} code=${error.code} reason=${error.message}${detailText}\n`);
  }

  private async appendLog(fileName: string, content: string): Promise<void> {
    const logsDir = path.join(this.dataPath, "logs");
    await mkdir(logsDir, { recursive: true });
    await appendFile(path.join(logsDir, fileName), content, "utf8");
  }
}

function normalizeError(error: unknown): AiModuleError {
  if (error instanceof AiModuleError) {
    return error;
  }

  if (error instanceof Error) {
    return new AiModuleError(error.message, "unknown-error");
  }

  return new AiModuleError("Unknown AI module error", "unknown-error");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
