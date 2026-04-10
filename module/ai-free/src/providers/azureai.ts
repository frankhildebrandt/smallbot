import { ChatCompletionsProvider } from "./chatCompletions.js";

interface AzureAIProviderOptions {
  apiKey: string;
  model: string;
  serviceName: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

export class AzureAIProvider extends ChatCompletionsProvider {
  constructor(options: AzureAIProviderOptions) {
    super({
      name: "azureai",
      apiKey: options.apiKey,
      model: options.model,
      serviceName: options.serviceName,
      baseUrl: options.baseUrl,
      headers: {
        "api-key": options.apiKey,
      },
      fetchImpl: options.fetchImpl,
      rateLimitRetryDelayMs: 60_000,
      maxRateLimitRetries: 1,
      sleepImpl: options.sleepImpl,
    });
  }
}
