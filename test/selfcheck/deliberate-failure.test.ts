import { expect, test } from 'bun:test';

/**
 * SELF-01 (V4): falha proposital. Roda só com `bun scripts/test-all.ts --selfcheck`
 * e prova que uma falha de teste chega ao exit code do contêiner (≠ 0).
 */
test('[SELF-01] falha proposital do selfcheck', () => {
  expect('selfcheck').toBe('deve falhar');
});
