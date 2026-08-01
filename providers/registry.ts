import type { AIProvider, ProviderRegistry } from "./types.ts";
import { ClaudeCodeProvider } from "./claude-code.ts";
import { DevinProvider } from "./devin.ts";
import { AgyProvider } from "./agy.ts";
import { CodexProvider } from "./codex.ts";
import { OpencodeProvider } from "./opencode.ts";

const providers = new Map<string, AIProvider>();
const aliases = new Map<string, string>();
let defaultProviderName: string;

/**
 * Canonical provider names, in the order they are listed to the user.
 * Every one of these runs its CLI with NO model flag — the model is whatever
 * that CLI is configured to use.
 */
export const PROVIDER_NAMES = ["claude-code", "devin", "agy", "opencode", "codex"] as const;

export function createProviderRegistry(): ProviderRegistry {
  // Accept an alias (e.g. DEFAULT_PROVIDER=claude) as readily as a canonical name.
  const configured = Deno.env.get("DEFAULT_PROVIDER") || "claude-code";

  const registry: ProviderRegistry = {
    getProvider(name: string): AIProvider {
      const canonical = aliases.get(name) ?? name;
      const provider = providers.get(canonical);
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
      for (const alias of provider.aliases ?? []) {
        aliases.set(alias, provider.name);
      }
    },

    hasProvider(name: string): boolean {
      return providers.has(aliases.get(name) ?? name);
    },
  };

  // Register built-in providers
  registry.registerProvider(new ClaudeCodeProvider());
  registry.registerProvider(new DevinProvider());
  registry.registerProvider(new AgyProvider());
  registry.registerProvider(new OpencodeProvider());
  registry.registerProvider(new CodexProvider());

  // Resolve the configured default AFTER registration so aliases are known.
  // An unknown DEFAULT_PROVIDER would throw on every message, so fall back
  // loudly rather than booting a bot that cannot answer.
  const canonical = aliases.get(configured) ?? configured;
  if (!providers.has(canonical)) {
    console.warn(
      `[Providers] DEFAULT_PROVIDER="${configured}" is not a known provider ` +
        `(${PROVIDER_NAMES.join(", ")}) — falling back to claude-code.`,
    );
    defaultProviderName = "claude-code";
  } else {
    defaultProviderName = canonical;
  }

  return registry;
}

export function getDefaultProviderName(): string {
  return defaultProviderName;
}
