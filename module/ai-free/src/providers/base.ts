import { AiInferenceRequest, AiInferenceResponse } from "../types.js";

export interface AiProvider {
  readonly name: string;
  complete(requestId: string, request: AiInferenceRequest): Promise<AiInferenceResponse>;
}
