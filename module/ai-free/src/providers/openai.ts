import { ChatCompletionsProvider, createAuthorizationHeader } from "./chatCompletions.js";

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  serviceName: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIProvider extends ChatCompletionsProvider {
  constructor(options: OpenAIProviderOptions) {
    super({
      name: "openai",
      apiKey: options.apiKey,
      model: options.model,
      serviceName: options.serviceName,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      headers: createAuthorizationHeader(options.apiKey),
      fetchImpl: options.fetchImpl,
    });
  }
}
