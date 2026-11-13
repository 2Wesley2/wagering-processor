import type { Fixture } from './fixture.ts';
import { type Instance, startInstance, waitReady } from './instances.ts';

/** N instâncias reais da app sobre o mesmo banco (D46), com distribuição round-robin. */
export interface Cluster {
  readonly instances: readonly Instance[];
  /** Próxima instância (round-robin). */
  next(): Instance;
  at(index: number): Instance;
}

export async function startCluster(
  fixture: Fixture,
  prefix: string,
  options: { count?: number; env?: Record<string, string> } = {},
): Promise<Cluster> {
  const count = options.count ?? 3;
  const instances = Array.from({ length: count }, (_, index) =>
    startInstance({ id: `${prefix}-${index + 1}`, env: fixture.env(options.env) }),
  );
  await Promise.all(instances.map((instance) => waitReady(instance)));
  let cursor = 0;
  const at = (index: number): Instance => {
    const instance = instances[index % instances.length];
    if (instance === undefined) throw new Error('cluster vazio');
    return instance;
  };
  return {
    instances,
    next: () => at(cursor++),
    at,
  };
}

/** Executa tarefas com no máximo `limit` em andamento (paralelismo real, sem enfileirar tudo de uma vez). */
export async function inParallel<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < tasks.length) {
      const current = index++;
      const task = tasks[current];
      if (task !== undefined) results[current] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}
