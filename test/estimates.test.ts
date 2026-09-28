import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app';

const schema='anfas_estimates_test_'+randomBytes(8).toString('hex');
process.env.DATABASE_SCHEMA=schema;
const db=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let owner: string;
let other: string;
let id: string;
const payload={snapshot:{version:2,activeTab:'floors',zones:[],floors:{input:{totalFloorArea:12},lines:[{id:'qa-line',priceKey:'qa-key',enabled:true,quantity:12,unitPrice:321,coefficient:1.2,comment:'Индивидуальная цена',priceEdited:true}]},walls:{input:{},lines:[]}},details:{number:'QA-1',date:'2026-09-28',customer:'Заказчик',object:'Квартира',estimator:'Автор',note:'Проверка'},priceProfile:null};
async function call(path='',method='GET',body?:unknown,cookie=owner,origin='http://127.0.0.1:5173') {
  return fetch(base+'/api/estimates'+path,{method,headers:{Cookie:cookie??'',Origin:origin,'Content-Type':'application/json','X-Anfas-Client':'web'},body:body===undefined?undefined:JSON.stringify(body)});
}
async function start() { app=await createApp(); await app.listen(0,'127.0.0.1'); base=await app.getUrl(); }
before(async()=> {
  await db.query(`CREATE SCHEMA ${schema}`); await start();
  const cookies=[];
  for(const email of ['owner@estimate.test','other@estimate.test']) {
    const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json','X-Anfas-Client':'web'},body:JSON.stringify({email,password:'Strong-test-password-2026'})});
    assert.equal(response.status,201); cookies.push(response.headers.get('set-cookie')!.split(';')[0]);
  }
  [owner,other]=cookies;
});
after(async()=> {await app?.close();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()});
test('authentication, CSRF, ownership injection and payload validation',async()=> {
  assert.equal((await call('','GET',undefined,'')).status,401);
  assert.equal((await call('','POST',{title:'QA',payload},owner,'https://foreign.example')).status,403);
  assert.equal((await call('','POST',{title:' ',payload})).status,400);
  assert.equal((await call('','POST',{title:'QA',payload,userId:2})).status,400);
  assert.equal((await call('','POST',{title:'QA',payload:{snapshot:{version:99}}})).status,400);
});
test('create and list retain full snapshot without exposing payload in list',async()=> {
  const response=await call('','POST',{title:'  Квартира QA  ',payload});assert.equal(response.status,201);
  const {estimate}=await response.json();id=estimate.id;
  assert.equal(estimate.title,'Квартира QA');assert.equal(estimate.revision,1);assert.deepEqual(estimate.payload,payload);
  const list=await (await call()).json();assert.equal(list.estimates.length,1);assert.equal(list.estimates[0].object,'Квартира');assert.equal(list.estimates[0].payload,undefined);
});
test('another account cannot list, read, update or delete owner documents',async()=> {
  assert.deepEqual((await (await call('','GET',undefined,other)).json()).estimates,[]);
  for(const [method,body] of [['GET',undefined],['PATCH',{title:'Взлом',payload,revision:1}],['DELETE',{revision:1}]] as const)
    assert.equal((await call('/'+id,method,body,other)).status,404);
  assert.equal((await call('/'+id)).status,200);
});
test('update uses revision, rejects stale write/delete, survives restart',async()=> {
  const updated=await call('/'+id,'PATCH',{title:'Обновлённая смета',payload,revision:1});assert.equal(updated.status,200);assert.equal((await updated.json()).estimate.revision,2);
  assert.equal((await call('/'+id,'PATCH',{title:'Устаревшая версия',payload,revision:1})).status,409);
  assert.equal((await call('/'+id,'DELETE',{revision:1})).status,409);
  await app.close();await start();
  const record=(await (await call('/'+id)).json()).estimate;assert.equal(record.title,'Обновлённая смета');assert.deepEqual(record.payload,payload);
});
test('favorite is persistent metadata; copy retains content and enforces owner',async()=> {
  assert.equal((await call('/'+id+'/favorite','PATCH',{isFavorite:true},other)).status,404);
  assert.equal((await call('/'+id+'/favorite','PATCH',{isFavorite:'yes'})).status,400);
  assert.equal((await call('/'+id+'/favorite','PATCH',{isFavorite:true},'')).status,401);
  assert.equal((await call('/'+id+'/copy','POST',{},other)).status,404);
  assert.equal((await call('/'+id+'/copy','POST',{},'')).status,401);
  const before=(await (await call('/'+id)).json()).estimate;
  const fav=(await (await call('/'+id+'/favorite','PATCH',{isFavorite:true})).json()).estimate;
  assert.equal(fav.isFavorite,true);assert.equal(fav.revision,before.revision);assert.equal(fav.updatedAt,before.updatedAt);
  await app.close();await start();
  const list=(await (await call()).json()).estimates;
  assert.equal(list[0].isFavorite,true);assert.equal(list[0].number,'QA-1');assert.equal(list[0].estimator,'Автор');assert.equal(list[0].date,'2026-09-28');
  const response=await call('/'+id+'/copy','POST',{});assert.equal(response.status,201);
  const copy=(await response.json()).estimate;
  assert.notEqual(copy.id,id);assert.equal(copy.title,before.title+' — копия');assert.equal(copy.isFavorite,false);assert.equal(copy.revision,1);assert.deepEqual(copy.payload,payload);
  const edited={...payload,details:{...payload.details,customer:'Другой заказчик'}};
  assert.equal((await call('/'+copy.id,'PATCH',{title:copy.title,payload:edited,revision:1})).status,200);
  assert.deepEqual((await (await call('/'+id)).json()).estimate.payload,payload);
  assert.equal((await call('/'+copy.id,'DELETE',{revision:2})).status,204);
  assert.equal((await call('/'+id+'/favorite','PATCH',{isFavorite:false})).status,200);
});
test('rename validates owner and revision without changing estimate content',async()=> {
  const {estimate}=await (await call('','POST',{title:'Для переименования',payload})).json();
  const path='/'+estimate.id+'/title';
  assert.equal((await call(path,'PATCH',{title:'Чужое',revision:1},other)).status,404);
  assert.equal((await call(path,'PATCH',{title:'QA',revision:1},'')).status,401);
  assert.equal((await call(path,'PATCH',{title:' ',revision:1})).status,400);
  assert.equal((await call(path,'PATCH',{title:'QA',revision:1,payload})).status,400);
  const renamed=await call(path,'PATCH',{title:'  Новое название  ',revision:1});assert.equal(renamed.status,200);
  const result=(await renamed.json()).estimate;assert.equal(result.title,'Новое название');assert.equal(result.revision,2);
  assert.equal((await call(path,'PATCH',{title:'Устаревшее',revision:1})).status,409);
  assert.deepEqual((await (await call('/'+estimate.id)).json()).estimate.payload,payload);
  assert.equal((await call('/'+estimate.id,'DELETE',{revision:2})).status,204);
});
test('delete only current owner revision; anonymous mutations stay rejected',async()=> {
  assert.equal((await call('/'+id,'PATCH',{title:'QA',payload,revision:2},'')).status,401);
  assert.equal((await call('/'+id,'DELETE',{revision:2},'')).status,401);
  assert.equal((await call('/'+id,'DELETE',{revision:2})).status,204);
  assert.equal((await call('/'+id)).status,404);assert.equal((await (await call()).json()).estimates.length,0);
});
