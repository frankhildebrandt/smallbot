import { ModuleRuntime, WireMessage, createMessage } from "@smallbot/framework";

import { AiModuleError } from "./errors.js";
import { parseAiInferenceRequest } from "./requests.js";
import { AiProvider } from "./providers/base.js";

export class AiService {
  constructor(
    private readonly runtime: ModuleRuntime,
    private readonly provider: AiProvider,
    private readonly serviceName: string,
  ) {}

  async onMessage(message: WireMessage): Promise<void> {
    if (message.c !== "tool") {
      return;
    }

    await this.runtime.updateState("busy");

    try {
      const request = parseAiInferenceRequest(message.m);
      const response = await this.provider.complete(message.i, request);
      this.logUsage(response);

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

  private logUsage(response: { requestId: string; provider: string; model: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }): void {
    if (!response.usage) {
      return;
    }

    console.log(
      `[module:${this.serviceName}] inference usage request=${response.requestId} provider=${response.provider} model=${response.model} input_tokens=${response.usage.inputTokens ?? "n/a"} output_tokens=${response.usage.outputTokens ?? "n/a"} total_tokens=${response.usage.totalTokens ?? "n/a"}`,
    );
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
