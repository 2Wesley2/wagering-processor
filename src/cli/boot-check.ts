import 'reflect-metadata';

/**
 * QG-07: importa o grafo de módulos de produção sem conectar em nada. Roda no
 * build da imagem runtime (só dependências de produção): se src/ depender de
 * uma devDependency, o build falha.
 */
await import('../app.module.ts');
await import('../platform/bootstrap.ts');
await import('./migrate.ts');
await import('./init-queues.ts');
await import('./healthcheck.ts');

process.stdout.write(`${JSON.stringify({ level: 'info', event: 'boot_check.ok' })}\n`);
