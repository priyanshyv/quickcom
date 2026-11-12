import { Controller, Get, Headers, Module, Res } from '@nestjs/common';
import { Response } from 'express';
import { CatalogService } from './catalog.service';
import { CATALOG_CACHE_CONTROL } from './catalog.constants';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // Try it:
  //   curl -i localhost:4000/catalog | head -12          -> 200 + ETag
  //   curl -i -H 'If-None-Match: "<etag>"' localhost:4000/catalog   -> 304, empty body
  @Get()
  list(@Headers('if-none-match') ifNoneMatch: string, @Res() res: Response) {
    const { etag, items } = this.catalog.all();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', CATALOG_CACHE_CONTROL);
    if (ifNoneMatch === etag) return res.status(304).end();
    return res.json({ count: items.length, items });
  }
}

@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
