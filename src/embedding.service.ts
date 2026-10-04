import { BadGatewayException, BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GoogleGenAI, type Part } from '@google/genai';
import { EmbedImageDto } from './dto';

export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMENSIONS = 768;

export function normalizeEmbedding(values: unknown): number[] {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new BadGatewayException('Gemini returned an invalid embedding.');
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new BadGatewayException('Gemini returned an empty embedding.');
  return values.map(v => v / norm);
}

export async function withEmbeddingRetry<T>(run: () => Promise<T>, pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<T> {
  try { return await run(); }
  catch (error) {
    const status = Number((error as { status?: number })?.status);
    if (![408, 500, 502, 503, 504].includes(status)) throw error;
    await pause(600 + Math.random() * 400);
    return run();
  }
}

@Injectable()
export class EmbeddingService {
  private lastError: string | null = null;
  private probe?: { available: boolean; checkedAt: number };
  private probing?: Promise<{ available: boolean; checkedAt: number }>;

  async image(input: EmbedImageDto) {
    if (!input.cloudImagesAllowed) throw new BadRequestException('Photo-preview consent is required.');
    const thumbnail = input.thumbnail;
    if (!thumbnail) throw new BadRequestException('A bounded photo preview is required.');
    const bytes = Buffer.from(thumbnail.data, 'base64');
    const valid = thumbnail.mimeType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
      : thumbnail.mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!valid || bytes.length > 200_000) throw new BadRequestException('Invalid preview; use JPEG or PNG up to 200 KB.');
    return this.embed([{ inlineData: thumbnail }]);
  }

  text(text: string) {
    if (!text.trim() || text.length > 500) throw new BadRequestException('Enter a query of 1–500 characters.');
    // Raw text and a single image share the same multimodal space. No taskType
    // (unsupported by Embedding 2), captions, or generative model fallback.
    return this.embed([{ text: text.trim() }]);
  }

  async generate(parts: Part[]) {
    if (!process.env.GEMINI_API_KEY) throw new ServiceUnavailableException('Gemini embedding access is not configured.');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return withEmbeddingRetry(() => ai.models.embedContent({
      model: EMBEDDING_MODEL, contents: [{ role: 'user', parts }],
      config: { outputDimensionality: EMBEDDING_DIMENSIONS, httpOptions: { timeout: 15_000 } },
    }));
  }

  private async embed(parts: Part[]) {
    try {
      const response = await this.generate(parts);
      if (response.embeddings?.length !== 1) throw new BadGatewayException('Gemini returned an invalid embedding count.');
      const values = normalizeEmbedding(response.embeddings[0].values);
      this.probe = { available: true, checkedAt: Date.now() };
      return { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, values };
    } catch (error) {
      const status = Number((error as { status?: number })?.status);
      const failure = error instanceof HttpException ? error : status === 429
        ? new HttpException('Gemini embedding quota reached. Resume after the limit resets.', 429)
        : new ServiceUnavailableException([401, 403, 404].includes(status)
          ? 'Gemini embedding model is unavailable or access is not configured.'
          : 'Gemini embeddings are temporarily unavailable. Saved results remain on your device.');
      this.lastError = failure.message;
      this.probe = { available: false, checkedAt: Date.now() };
      throw failure;
    }
  }

  async diagnostics() {
    // Real embed probe, coalesced and cached; never accept a key's presence as proof.
    if (!this.probe || Date.now() - this.probe.checkedAt > 5 * 60_000) {
      this.probing ??= this.text('photo search availability').then(() => this.probe!).catch(() => this.probe!)
        .finally(() => { this.probing = undefined; });
      await this.probing;
    }
    return { backendReachable: true, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
      modelAvailable: this.probe?.available ?? false, checkedAt: this.probe?.checkedAt, lastAIError: this.lastError };
  }
}
