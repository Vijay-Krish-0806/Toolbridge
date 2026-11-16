import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * App-wide settings shared by the server (main.ts), the spec export and the e2e tests,
 * so all three run exactly the same validation.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // drop properties without validation decorators
      forbidNonWhitelisted: true, // ...and reject the request instead of silently dropping them
      transform: true, // turn query strings into the DTO's types (numbers, booleans, defaults)
    }),
  );
}

/** The OpenAPI document. ToolBridge compiles its tools from the exported copy of this. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
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
  return SwaggerModule.createDocument(app, config);
}
