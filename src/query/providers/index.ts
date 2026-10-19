// Provider selection is explicit configuration (NL_SQL_PROVIDER); there is no
// silent fallback from one provider to another.
//   deterministic (default)  rule-based, offline, used by the demo and tests
//   anthropic                Claude via the Messages API; needs ANTHROPIC_API_KEY, model NL_SQL_MODEL
//   none                     generation disabled; users write SQL themselves

import { loadConfig } from '../../platform/config.js';
import { AnthropicProvider } from './anthropic.js';
import { DeterministicProvider } from './deterministic.js';
import { ProviderUnavailable, type SqlProvider } from './types.js';

export { ProviderUnavailable, type SqlProvider } from './types.js';

class DisabledProvider implements SqlProvider {
  readonly id = 'none';
  readonly model = null;
  async generate(): Promise<never> { throw new ProviderUnavailable('none', 'SQL generation is disabled on this server (NL_SQL_PROVIDER=none). Write the SQL yourself.', false); }
}

let override: SqlProvider | undefined;
let cached: SqlProvider | undefined;

/** Tests may inject a provider (e.g. one that fails, or one that proposes hostile SQL). */
export function setProviderForTests(p: SqlProvider | undefined) { override = p; }

export function getProvider(): SqlProvider {
  if (override) return override;
  if (cached) return cached;
  const cfg = loadConfig();
  switch (cfg.nlSqlProvider) {
    case 'deterministic': cached = new DeterministicProvider(); break;
    case 'none': cached = new DisabledProvider(); break;
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        // Explicitly configured but unusable: report it on use, and keep the rest of the workspace working.
        cached = { id: 'anthropic', model: cfg.nlSqlModel, generate: async () => { throw new ProviderUnavailable('anthropic', 'NL_SQL_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set on the server.', false); } };
        break;
      }
      cached = new AnthropicProvider(cfg.nlSqlModel, { apiKey: key, timeoutMs: cfg.nlSqlTimeoutMs });
      break;
    }
  }
  return cached!;
}
