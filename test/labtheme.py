import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
def api(path, body=None, method=None):
    req = urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers={'content-type':'application/json','x-admin-token':'pw'}, method=method or ('POST' if body is not None else 'GET')); return json.load(urllib.request.urlopen(req))
async def main():
    api('/api/admin/themes/evil-clown', {'prompts': {'1-male': 'man clown', '1-female': 'woman clown'}}, 'PUT')
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await (await br.new_context(viewport={'width':1400,'height':1200})).new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(B+'/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        print('builder tab visible:', await pg.is_visible('#nav [data-t=builder]'), '| writer visible:', await pg.is_visible('#writer'))
        await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(500); print('info:', await pg.text_content('#ltInfo'))
        await pg.set_input_files('#ltLibIn', '/home/claude/dexdraw/test/face.png'); await pg.wait_for_timeout(1000)
        await pg.click('#ltSlots .slot[data-v="1-male"]'); await pg.wait_for_timeout(200); await pg.click('#ltSlots .slot[data-v="1-female"]'); await pg.wait_for_timeout(200); await pg.click('#ltSlots .slot[data-v="2-male-male"]'); await pg.wait_for_timeout(300)
        print('slots with faces:', len(await pg.query_selector_all('#ltSlots .slot.has')), '| models ticked:', len(await pg.query_selector_all('#ltModels input:checked')))
        await pg.click('#ltRun')
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'finished' in (await pg.text_content('#ltMsg')): break
        print('run:', await pg.text_content('#ltMsg'), '| rows:', len(await pg.query_selector_all('#ltGrid .bRow')), '| cards:', len(await pg.query_selector_all('#ltGrid .lab')))
        await (await pg.query_selector('#ltGrid button[data-apply]')).click(); await pg.wait_for_timeout(1200); print('use this:', await pg.text_content('#toast'))
        await pg.reload(); await pg.wait_for_timeout(1500); await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(500); print('slots remembered after reload:', len(await pg.query_selector_all('#ltSlots .slot.has')))
        api('/api/admin/themes', {'name': 'Zebra'}); await pg.click('#nav [data-t=queue]'); await pg.wait_for_timeout(6000); await pg.click('#nav [data-t=test]'); await pg.select_option('#ltTheme', 'zebra'); await pg.wait_for_timeout(300); await pg.click('#nav [data-t=queue]'); await pg.wait_for_timeout(6000); await pg.click('#nav [data-t=test]'); print('theme after tab switch + refresh:', await pg.input_value('#ltTheme'))
        await pg.reload(); await pg.wait_for_timeout(1500); await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(400); print('theme after reload:', await pg.input_value('#ltTheme'))
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
