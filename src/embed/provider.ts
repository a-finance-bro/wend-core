/**
 * Pluggable embedding provider.
 *
 * The engine never hardcodes a model vendor: recall needs SOME 1024-dim text
 * embedding (the hosted product uses Voyage voyage-3), and self-hosters plug
 * in whatever they run. Register a provider once at startup:
 *
 *   import { setEmbeddingProvider } from "wend-core";
 *   setEmbeddingProvider(async (text) => myEmbed(text)); // number[1024]
 *
 * Until a provider is registered, semantic recall is unavailable and callers
 * get a clear error instead of a silent empty result.
 */

export type EmbeddingProvider = (text: string) => Promise<number[]>;

let provider: EmbeddingProvider | null = null;

export function setEmbeddingProvider(fn: EmbeddingProvider): void {
  provider = fn;
}

export async function embedText(text: string): Promise<number[]> {
  if (!provider) {
    throw new Error(
      "No embedding provider registered. Call setEmbeddingProvider() with a function that returns a 1024-dimension embedding (the schema's vector(1024) column).",
    );
  }
  return provider(text);
}
