import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentViewer } from '../../common/decorators/current-viewer.decorator';
import type { Viewer } from '../../common/viewer';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { StatsService } from './stats.service';

@ApiTags('stats')
@ApiBearerAuth()
@Controller({ path: 'stats', version: '1' })
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @OptionalAuth()
  @Get()
  get(@CurrentViewer() viewer: Viewer) {
    return this.stats.getStats(viewer);
  }
}
