import type { AIProvider, ProviderRegistry } from "./types.ts";
import { ClaudeCodeProvider } from "./claude-code.ts";
import { DevinProvider } from "./devin.ts";

const providers = new Map<string, AIProvider>();
let defaultProviderName: string;

export function createProviderRegistry(): ProviderRegistry {
  const defaultName = Deno.env.get("DEFAULT_PROVIDER") || "claude-code";
  defaultProviderName = defaultName;

  const registry: ProviderRegistry = {
    getProvider(name: string): AIProvider {
      const provider = providers.get(name);
      if (!provider) {
        throw new Error(`Provider "${name}" not found. Available: ${Array.from(providers.keys()).join(", ")}`);
      }
      return provider;
    },

    getDefaultProvider(): AIProvider {
      return registry.getProvider(defaultProviderName);
    },

    async getAvailableProviders(): Promise<AIProvider[]> {
      const available: AIProvider[] = [];
      for (const provider of providers.values()) {
        if (await provider.isAvailable()) {
          available.push(provider);
        }
      }
      return available;
    },

    registerProvider(provider: AIProvider): void {
      providers.set(provider.name, provider);
    },

    hasProvider(name: string): boolean {
      return providers.has(name);
    },
  };

  // Register built-in providers
  registry.registerProvider(new ClaudeCodeProvider());
  registry.registerProvider(new DevinProvider());

  return registry;
}

export function getDefaultProviderName(): string {
  return defaultProviderName;
}
