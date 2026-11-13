import 'reflect-metadata';
import { bootstrap } from './platform/bootstrap.ts';
import { writeFatalLine } from './platform/observability/logger.ts';

try {
  await bootstrap();
} catch (error) {
  writeFatalLine('app.boot_failed', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
