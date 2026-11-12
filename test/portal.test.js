import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startPortal} from '../src/portal.js';
test('本地门户现有人工操作可执行且保持业务边界',{timeout:25000},async()=>{
  const portal=await startPortal();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await browser.newPage();await page.goto(portal.url);await page.waitForFunction(()=>document.querySelector('#notice').textContent.length>0);

await page.locator('#files').setInputFiles('fixtures/certificate.txt');
await page.locator('#upload').click();
await page.waitForFunction(()=>document.querySelector('#uploads').textContent.includes('quarantine'));
assert.equal(portal.state.uploads[0].status, 'quarantine');
assert.equal(portal.state.uploads[0].materialId, undefined);
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('#uploads').textContent.includes('cancelled'));

  }finally{await browser.close();await portal.close();}
});
