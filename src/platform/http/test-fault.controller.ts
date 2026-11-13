import { BadRequestException, Controller, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { isFaultPoint } from '../config/config.ts';
import type { FaultInjector } from '../lifecycle/fault-injection.ts';
import { FAULT_INJECTOR } from '../tokens.ts';
import { Public } from './authentication.ts';

/**
 * Rota de autoteste do harness. Só é registrada com NODE_ENV=test (AppModule);
 * com o Noop (padrão), atingir o ponto não faz nada.
 */
@Public()
@Controller('__test')
export class TestFaultController {
  constructor(@Inject(FAULT_INJECTOR) private readonly faults: FaultInjector) {}

  @Post('fault/:point')
  @HttpCode(204)
  async hit(@Param('point') point: string, @Query('messageId') messageId: string | undefined): Promise<void> {
    if (!isFaultPoint(point)) throw new BadRequestException(`ponto de falha desconhecido: ${point}`);
    await this.faults.hit(point, messageId === undefined ? {} : { messageId });
  }
}
