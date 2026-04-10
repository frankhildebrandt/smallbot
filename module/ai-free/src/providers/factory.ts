import { AiModuleError } from "../errors.js";
import { AiProvider } from "./base.js";
import { AzureAIProvider } from "./azureai.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";

interface CreateProviderOptions {
  serviceName: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createProvider(options: CreateProviderOptions): AiProvider {
  const provider = (options.env.PROVIDER ?? "openai").trim().toLowerCase();

  if (provider === "openai") {
    const apiKey = readFirstDefined(options.env, ["OPENAI_API_KEY", "OPEN_AI_KEY"]);
    const model = readFirstDefined(options.env, ["OPENAI_MODEL", "OPEN_AI_MODEL"]);

    if (!apiKey) {
      throw new AiModuleError("OpenAI provider requires OPENAI_API_KEY or OPEN_AI_KEY", "provider-config-invalid", {
        provider,
      });
    }

    if (!model) {
      throw new AiModuleError("OpenAI provider requires OPENAI_MODEL or OPEN_AI_MODEL", "provider-config-invalid", {
        provider,
      });
    }

    return new OpenAIProvider({
      apiKey,
      model,
      serviceName: options.serviceName,
      baseUrl: options.env.OPENAI_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
  }

  if (provider === "azureai") {
    const apiKey = readFirstDefined(options.env, ["AZUREAI_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY"]);
    const model = readFirstDefined(options.env, ["AZUREAI_MODEL", "AZURE_AI_MODEL", "AZURE_OPENAI_MODEL"]);
    const baseUrl = readFirstDefined(options.env, ["AZUREAI_BASE_URL", "AZURE_AI_BASE_URL", "AZURE_OPENAI_BASE_URL"]);

    if (!apiKey) {
      throw new AiModuleError("AzureAI provider requires AZUREAI_API_KEY, AZURE_AI_API_KEY, or AZURE_OPENAI_API_KEY", "provider-config-invalid", {
        provider,
      });
    }

    if (!model) {
      throw new AiModuleError("AzureAI provider requires AZUREAI_MODEL, AZURE_AI_MODEL, or AZURE_OPENAI_MODEL", "provider-config-invalid", {
        provider,
      });
    }

    if (!baseUrl) {
      throw new AiModuleError("AzureAI provider requires AZUREAI_BASE_URL, AZURE_AI_BASE_URL, or AZURE_OPENAI_BASE_URL", "provider-config-invalid", {
        provider,
      });
    }

    return new AzureAIProvider({
      apiKey,
      model,
      serviceName: options.serviceName,
      baseUrl,
      fetchImpl: options.fetchImpl,
    });
  }

  if (provider === "openrouter") {
    const apiKey = readFirstDefined(options.env, ["OPENROUTER_API_KEY"]);
    const model = readFirstDefined(options.env, ["OPENROUTER_MODEL"]);

    if (!apiKey) {
      throw new AiModuleError("OpenRouter provider requires OPENROUTER_API_KEY", "provider-config-invalid", {
        provider,
      });
    }

    if (!model) {
      throw new AiModuleError("OpenRouter provider requires OPENROUTER_MODEL", "provider-config-invalid", {
        provider,
      });
    }

    return new OpenRouterProvider({
      apiKey,
      model,
      serviceName: options.serviceName,
      baseUrl: options.env.OPENROUTER_BASE_URL,
      siteUrl: options.env.OPENROUTER_SITE_URL,
      appName: options.env.OPENROUTER_APP_NAME,
      fetchImpl: options.fetchImpl,
    });
  }

  throw new AiModuleError(`Unsupported AI provider: ${provider}`, "provider-unsupported", {
    provider,
  });
}

function readFirstDefined(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}
