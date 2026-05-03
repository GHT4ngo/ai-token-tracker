import * as path from 'path';

interface ModelPricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

interface PricingTable {
  models: Record<string, ModelPricing>;
}

const table: PricingTable = require(path.join(__dirname, 'pricing.json'));

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function computeCost(model: string, usage: TokenUsage): number {
  const pricing: ModelPricing =
    table.models[model] ?? table.models['default'];

  const M = 1_000_000;
  return (
    (usage.input * pricing.input) / M +
    (usage.output * pricing.output) / M +
    (usage.cacheWrite * pricing.cache_write) / M +
    (usage.cacheRead * pricing.cache_read) / M
  );
}

export function knownModels(): string[] {
  return Object.keys(table.models).filter(k => k !== 'default');
}
