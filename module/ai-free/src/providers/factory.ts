import { AiModuleError } from "../errors.js";
import { AiProvider } from "./base.js";
import { OpenAIProvider } from "./openai.js";

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
