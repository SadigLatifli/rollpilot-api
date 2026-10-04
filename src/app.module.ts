import { EmbeddingService } from './embedding.service';
import { Module } from '@nestjs/common';
import { AppController, PublicController } from './app.controller';
import { RollpilotService } from './rollpilot.service';
import { SessionGuard } from './session.guard';
import { StoreService } from './store.service';
import { AiAnalysisService } from './ai-analysis.service';

@Module({ controllers: [PublicController, AppController], providers: [EmbeddingService, StoreService, AiAnalysisService, RollpilotService, SessionGuard] })
export class AppModule {}
