import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
def api(path, body=None, method=None):
    req = urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers={'content-type':'application/json','x-admin-token':'pw'}, method=method or ('POST' if body is not None else 'GET')); return json.load(urllib.request.urlopen(req))
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await (await br.new_context(viewport={'width':1400,'height':1100})).new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(B+'/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        await pg.click('#nav [data-t=foundations]'); await pg.wait_for_timeout(300); print('foundations listed:', len(await pg.query_selector_all('#foundList .wItem')))
        tas = await pg.query_selector_all('#foundList .fText'); await tas[0].fill('NO-COMPROMISE: clean black line art, exact likeness, no shading.'); await pg.click('#foundSave'); await pg.wait_for_timeout(800); print('saved:', await pg.text_content('#toast'))
        await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(500); await pg.select_option('#tVar', '1-male'); await pg.select_option('#wFound', 'normal'); await pg.fill('#wDesc', '80s glam rockstar'); await pg.click('#wOne'); await pg.wait_for_timeout(1500)
        v = await pg.input_value('#tPrompt'); print('one → prompt starts with foundation:', v.startswith('NO-COMPROMISE'), '| has theme part:', 'Single male' in v, '| msg:', (await pg.text_content('#wMsg'))[:40])
        await pg.click('#wAll'); await pg.wait_for_timeout(2500); print('all → items:', len(await pg.query_selector_all('#wAllOut .wItem')), '| text models in settings:', await pg.eval_on_selector_all('#sTextModel option','o=>o.map(x=>x.value)'))
        await pg.click('#wApply'); await pg.wait_for_timeout(1200); print('apply toast:', await pg.text_content('#toast'))
        th = [t for t in api('/api/admin/state')['themes'] if t['slug']=='evil-clown'][0]; print('theme prompts filled:', sum(1 for v in th['prompts'].values() if v.strip()), '| sample:', th['prompts']['2-male-female'][:60].replace('\n',' / '))
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
