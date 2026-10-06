import { ServiceUnavailableException } from '@nestjs/common';

// Fail closed even when provider keys remain configured on the server.
export const cloudAIEnabled = () => process.env.CLOUD_AI_ENABLED === 'true';
export function requireCloudAI() {
  if (!cloudAIEnabled()) throw new ServiceUnavailableException('Cloud AI is disabled. Use on-device search.');
}
