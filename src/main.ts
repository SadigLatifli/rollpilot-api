import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    const requiredKey = process.env.AI_PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    if (!process.env[requiredKey]) throw new Error(`${requiredKey} is required in production`);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) throw new Error('MONGODB_URI is required in production');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.enableShutdownHooks();
  app.useBodyParser('json', { limit: '6mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'));
}

void bootstrap();
