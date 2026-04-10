import { ChatCompletionsProvider, createAuthorizationHeader } from "./chatCompletions.js";

interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  serviceName: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvider extends ChatCompletionsProvider {
  constructor(options: OpenRouterProviderOptions) {
    super({
      name: "openrouter",
      apiKey: options.apiKey,
      model: options.model,
      serviceName: options.serviceName,
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        ...createAuthorizationHeader(options.apiKey),
        ...(options.siteUrl ? { "HTTP-Referer": options.siteUrl } : {}),
        ...(options.appName ? { "X-Title": options.appName } : {}),
      },
      fetchImpl: options.fetchImpl,
    });
  }
}
