import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await NestFactory.create(AppModule.register(config));

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true, // drop properties without validation decorators
    forbidNonWhitelisted: true, // ...and reject the request instead of silently dropping them
    transform: true, // turn query strings into the DTO's types (numbers, booleans, defaults)
  }),
);
app.enableShutdownHooks();

const document = new DocumentBuilder()
  .setTitle('Host Store API')
  .setDescription(
    'Back-office API of a small online store: products, stock, customers, orders, shipments, ' +
      'refunds and coupons. Staff log in with POST /auth/login and send the returned token as ' +
      '"Authorization: Bearer <token>". Roles: owner (everything), support (customers, orders, ' +
      'refunds), warehouse (products, stock, orders, shipments). Money is in integer cents. ' +
      'Lists are paginated with ?page and ?limit and return { items, page, limit, total }.',
  )
  .setVersion('0.1.0')
  .addBearerAuth()
  .build();
SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, document), {
  jsonDocumentUrl: 'docs/json',
});

// 127.0.0.1 only: the API is not reachable from other machines on the network.
await app.listen(config.PORT, '127.0.0.1');
console.log(`Host Store API on http://127.0.0.1:${String(config.PORT)} (docs at /docs)`);
