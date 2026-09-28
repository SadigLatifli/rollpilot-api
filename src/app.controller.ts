import { Body, Controller, Get, HttpException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AnalyzeDto, CompleteOnboardingDto, ConfirmPlanDto, CreatePlanDto } from './dto';
import { RollpilotService } from './rollpilot.service';
import { SessionGuard, type SessionRequest } from './session.guard';
import { StoreService } from './store.service';

@Controller('v1')
export class PublicController {
  private readonly sessionsByIp = new Map<string, { count: number; until: number }>();
  constructor(private readonly store: StoreService) {}

  @Get('health') health() { return { status: 'ok' }; }
  @Post('sessions') createSession(@Req() request: { ip?: string }) {
    const ip = request.ip ?? 'unknown';
    const now = Date.now();
    const bucket = this.sessionsByIp.get(ip);
    const current = bucket && bucket.until > now ? bucket : { count: 0, until: now + 3_600_000 };
    if (current.count >= 20) throw new HttpException('Too many new sessions. Try again later.', 429);
    current.count++;
    this.sessionsByIp.set(ip, current);
    return this.store.createSession();
  }
}

@Controller('v1')
@UseGuards(SessionGuard)
export class AppController {
  constructor(private readonly service: RollpilotService) {}

  @Get('state') state(@Req() request: SessionRequest) { return this.service.state(request.sessionHash); }
  @Patch('onboarding') onboarding(@Req() request: SessionRequest, @Body() input: CompleteOnboardingDto) { return this.service.setOnboarded(request.sessionHash, input.onboarded); }
  @Get('collections') collections(@Req() request: SessionRequest) { return this.service.state(request.sessionHash)?.collections; }
  @Get('collections/:id') collection(@Req() request: SessionRequest, @Param('id') id: string) { return this.service.collection(request.sessionHash, id); }
  @Get('activity') activity(@Req() request: SessionRequest) { return this.service.state(request.sessionHash)?.activities; }
  @Post('plans') plan(@Req() request: SessionRequest, @Body() input: CreatePlanDto) { return this.service.createPlan(request.sessionHash, input); }
  @Post('agent/analyze') analyze(@Req() request: SessionRequest, @Body() input: AnalyzeDto) { return this.service.analyze(request.sessionHash, input); }
  @Post('plans/:id/confirm') confirm(@Req() request: SessionRequest, @Param('id') id: string, @Body() input: ConfirmPlanDto) { return this.service.confirmPlan(request.sessionHash, id, input); }
}
