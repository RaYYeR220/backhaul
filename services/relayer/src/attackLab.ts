// The attack lab behind GET/POST /attacks. Filled in with the SDK's attack definitions.

import { HttpError, type AttackLab } from './api.js';
import type { Chains } from './chains.js';
import type { JsonlStore } from './store.js';

export function createAttackLab(_ch: Chains, _store: JsonlStore): AttackLab {
  return {
    list: async () => [],
    run: async () => {
      throw new HttpError(404, 'no such attack');
    },
  };
}
