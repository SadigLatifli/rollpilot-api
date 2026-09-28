import { Module } from '@nestjs/common';
import { AppController, PublicController } from './app.controller';
import { RollpilotService } from './rollpilot.service';
import { SessionGuard } from './session.guard';
import { StoreService } from './store.service';
import { GeminiService } from './gemini.service';

@Module({ controllers: [PublicController, AppController], providers: [StoreService, GeminiService, RollpilotService, SessionGuard] })
export class AppModule {}
