import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller()
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      environment: this.configService.get('ENVIRONMENT', 'dev'),
    };
  }
}
