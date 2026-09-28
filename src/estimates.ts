import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { AuthStore } from './auth.store';

class EstimateBody {
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @IsObject() payload!: Record<string, unknown>;
}
class UpdateBody extends EstimateBody {
  @IsInt() @Min(1) revision!: number;
}
class RenameBody {
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @IsInt() @Min(1) revision!: number;
}
class FavoriteBody { @IsBoolean() isFavorite!: boolean; }
class DeleteBody { @IsInt() @Min(1) revision!: number; }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validatePayload(payload: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(payload)) > 1_000_000)
    throw new BadRequestException('Смета превышает допустимый размер 1 МБ.');
  const snapshot = payload.snapshot;
  const details = payload.details;
  if (Object.keys(payload).some(key => !['snapshot', 'details', 'priceProfile'].includes(key)) ||
      !object(snapshot) || snapshot.version !== 2 || !Array.isArray(snapshot.zones) || snapshot.zones.length > 500 ||
      !object(details) || !object(snapshot.floors) || !object(snapshot.walls))
    throw new BadRequestException('Некорректный формат сметы.');
  for (const key of ['number', 'date', 'customer', 'object', 'estimator', 'note']) {
    if (typeof details[key] !== 'string' || (details[key] as string).length > (key === 'note' ? 2000 : 240))
      throw new BadRequestException('Некорректные реквизиты сметы.');
  }
  for (const key of ['floors', 'walls', 'ceilings', 'tile', 'electrics', 'plumbing']) {
    const section = snapshot[key];
    if (section === undefined) continue;
    if (!object(section) || !object(section.input) || !Array.isArray(section.lines) || section.lines.length > 2000)
      throw new BadRequestException('Некорректный раздел сметы.');
    for (const line of section.lines) {
      if (!object(line) || typeof line.id !== 'string' || typeof line.priceKey !== 'string' ||
          typeof line.enabled !== 'boolean' ||
          !['quantity', 'unitPrice', 'coefficient'].every(field => typeof line[field] === 'number' && Number.isFinite(line[field]) && (line[field] as number) >= 0))
        throw new BadRequestException('Некорректная строка сметы.');
    }
  }
  if (payload.priceProfile !== null && payload.priceProfile !== undefined) {
    const profile = payload.priceProfile;
    if (!object(profile) || !Array.isArray(profile.items) || profile.items.length > 2000 ||
        !['id', 'name', 'source', 'createdAt', 'contentHash'].every(key => typeof profile[key] === 'string'))
      throw new BadRequestException('Некорректный прайс сметы.');
    for (const item of profile.items) {
      if (!object(item) || !['workId', 'sectionId', 'title', 'unit'].every(key => typeof item[key] === 'string') ||
          typeof item.active !== 'boolean' || typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0)
        throw new BadRequestException('Некорректная позиция прайса.');
    }
  }
}

const columns = 'id, title, revision, is_favorite AS "isFavorite", created_at AS "createdAt", updated_at AS "updatedAt"';
@Injectable()
export class EstimateStore {
  constructor(@Inject(AuthStore) private readonly auth: AuthStore) {}
  async list(userId: number) {
    return (await this.auth.db.query(`SELECT ${columns}, payload->'details'->>'object' AS "object", payload->'details'->>'customer' AS customer, payload->'details'->>'number' AS number, payload->'details'->>'date' AS date, payload->'details'->>'estimator' AS estimator FROM estimates WHERE user_id=$1 ORDER BY updated_at DESC, id`, [userId])).rows;
  }
  async get(userId: number, id: string) {
    const row = (await this.auth.db.query(`SELECT ${columns}, payload FROM estimates WHERE id=$1 AND user_id=$2`, [id, userId])).rows[0];
    if (!row) throw new NotFoundException('Смета не найдена.');
    return row;
  }
  async create(userId: number, body: EstimateBody) {
    validatePayload(body.payload);
    return (await this.auth.db.query(`INSERT INTO estimates(id,user_id,title,payload) VALUES($1,$2,$3,$4) RETURNING ${columns}, payload`, [randomUUID(), userId, body.title, JSON.stringify(body.payload)])).rows[0];
  }
  async update(userId: number, id: string, body: UpdateBody) {
    validatePayload(body.payload);
    const row = (await this.auth.db.query(`UPDATE estimates SET title=$3, payload=$4, revision=revision+1, updated_at=NOW() WHERE id=$1 AND user_id=$2 AND revision=$5 RETURNING ${columns}, payload`, [id, userId, body.title, JSON.stringify(body.payload), body.revision])).rows[0];
    if (!row) { await this.get(userId, id); throw new ConflictException('Смета изменена в другом окне. Откройте актуальную версию перед сохранением.'); }
    return row;
  }
  async rename(userId: number, id: string, body: RenameBody) {
    const row = (await this.auth.db.query(`UPDATE estimates SET title=$3, revision=revision+1, updated_at=NOW() WHERE id=$1 AND user_id=$2 AND revision=$4 RETURNING ${columns}`, [id,userId,body.title,body.revision])).rows[0];
    if (!row) { await this.get(userId,id); throw new ConflictException('Смета изменена в другом окне. Обновите список и повторите переименование.'); }
    return row;
  }
  async copy(userId: number, id: string) {
    const row = (await this.auth.db.query(`INSERT INTO estimates(id,user_id,title,payload) SELECT $3,user_id,left(title,112)||' — копия',payload FROM estimates WHERE id=$1 AND user_id=$2 RETURNING ${columns}, payload`, [id,userId,randomUUID()])).rows[0];
    if (!row) throw new NotFoundException('Смета не найдена.');
    return row;
  }
  async favorite(userId: number, id: string, isFavorite: boolean) {
    const row = (await this.auth.db.query(`UPDATE estimates SET is_favorite=$3 WHERE id=$1 AND user_id=$2 RETURNING ${columns}`, [id,userId,isFavorite])).rows[0];
    if (!row) throw new NotFoundException('Смета не найдена.');
    return row;
  }
  async delete(userId: number, id: string, revision: number) {
    const result = await this.auth.db.query('DELETE FROM estimates WHERE id=$1 AND user_id=$2 AND revision=$3', [id, userId, revision]);
    if (!result.rowCount) { await this.get(userId, id); throw new ConflictException('Смета изменилась. Обновите список перед удалением.'); }
  }
}

@Controller('estimates')
export class EstimateController {
  constructor(@Inject(AuthStore) private readonly auth: AuthStore, @Inject(EstimateStore) private readonly store: EstimateStore) {}
  private async owner(req: Request) {
    const user = await this.auth.current(req.cookies?.anfas_session);
    if (!user) throw new UnauthorizedException('Войдите в аккаунт.');
    return user.id;
  }
  @Get() async list(@Req() req: Request) { return { estimates: await this.store.list(await this.owner(req)) }; }
  @Get(':id') async get(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string) {
    return { estimate: await this.store.get(await this.owner(req), id) };
  }
  @Post() async create(@Req() req: Request, @Body(new ValidationPipe({expectedType:EstimateBody, transform:true, whitelist:true, forbidNonWhitelisted:true})) body: EstimateBody) {
    return { estimate: await this.store.create(await this.owner(req), body) };
  }
  @Patch(':id') async update(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string, @Body(new ValidationPipe({expectedType:UpdateBody, transform:true, whitelist:true, forbidNonWhitelisted:true})) body: UpdateBody) {
    return { estimate: await this.store.update(await this.owner(req), id, body) };
  }
  @Patch(':id/title') async rename(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string, @Body(new ValidationPipe({expectedType:RenameBody, transform:true, whitelist:true, forbidNonWhitelisted:true})) body: RenameBody) {
    return { estimate: await this.store.rename(await this.owner(req), id, body) };
  }
  @Post(':id/copy') async copy(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string) {
    return { estimate: await this.store.copy(await this.owner(req), id) };
  }
  @Patch(':id/favorite') async favorite(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string, @Body(new ValidationPipe({expectedType:FavoriteBody, transform:true, whitelist:true, forbidNonWhitelisted:true})) body: FavoriteBody) {
    return { estimate: await this.store.favorite(await this.owner(req), id, body.isFavorite) };
  }
  @Delete(':id') @HttpCode(204) async delete(@Req() req: Request, @Param('id', new ParseUUIDPipe({version:'4'})) id: string, @Body(new ValidationPipe({expectedType:DeleteBody, transform:true, whitelist:true, forbidNonWhitelisted:true})) body: DeleteBody) {
    await this.store.delete(await this.owner(req), id, body.revision);
  }
}
