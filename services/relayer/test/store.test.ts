import { appendFileSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JsonlStore, step, type TransferJob } from '../src/store.js';
import { tempStore } from './helpers.js';

const job = (id: string, state: TransferJob['state'] = 'locked'): TransferJob => ({
  id,
  type: 'transfer',
  src: 'portaldot',
  dst: 'bsc',
  nonce: '1',
  kind: 1,
  recipient: '0x0000000000000000000000000000000000000001',
  amount: '1',
  key: '0x00',
  value: '0x00',
  srcTx: '0x00',
  srcBlock: '1',
  state,
  createdAt: new Date().toISOString(),
  updatedAt: '',
  steps: [step('locked')],
  attempts: 0,
});

describe('JsonlStore', () => {
  it('keeps the last version of each record across reopen', () => {
    const s = tempStore();
    const a = job('a');
    s.put(a);
    s.put(job('b'));
    a.state = 'finalized';
    s.put(a);
    s.setKv('cursor:bsc', '123');
    const again = JsonlStore.open(s.path);
    expect(again.get('a')!.state).toBe('finalized');
    expect(again.list().map((j) => j.id)).toEqual(['a', 'b']);
    expect(again.getKv('cursor:bsc')).toBe('123');
  });

  it('skips a torn last line', () => {
    const s = tempStore();
    s.put(job('a'));
    appendFileSync(s.path, '{"t":"job","v":{"id":"b"');
    expect(JsonlStore.open(s.path).list().map((j) => j.id)).toEqual(['a']);
  });

  it('compacts once it has grown', () => {
    const s = tempStore();
    for (let i = 0; i < 30; i++) s.put(job('a', i % 2 ? 'proven' : 'locked'));
    const again = JsonlStore.open(s.path, 10);
    expect(readFileSync(s.path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(again.get('a')!.state).toBe('proven');
  });

  it('stores bigints as decimal strings and returns copies', () => {
    const s = tempStore();
    s.setKv('events', [{ block: 5n }]);
    expect(s.getKv('events')).toEqual([{ block: '5' }]);
    const j = s.put(job('c'));
    j.state = 'failed';
    expect(s.get('c')!.state).toBe('locked');
  });
});
