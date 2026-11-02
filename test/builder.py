import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
def api(path, body=None, method=None):
    req = urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers={'content-type':'application/json','x-admin-token':'pw'}, method=method or ('POST' if body is not None else 'GET')); return json.load(urllib.request.urlopen(req))
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await (await br.new_context(viewport={'width':1400,'height':1200})).new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(B+'/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        await pg.click('#nav [data-t=builder]'); await pg.wait_for_timeout(500)
        await pg.fill('#bName', 'Rockstar'); await pg.fill('#bDesc', '80s glam metal rockstar with a Flying V'); await pg.select_option('#bAud', 'both'); await pg.wait_for_timeout(900)
        print('flavors:', await pg.text_content('#bFlavors'))
        await pg.set_input_files('#bLibIn', '/home/claude/dexdraw/test/face.png'); await pg.wait_for_timeout(1000); print('library faces:', len(await pg.query_selector_all('#bLib .ref')), '| picked:', len(await pg.query_selector_all('#bLib .ref.on')))
        await pg.click('#bSlots .slot[data-v="1-male"]'); await pg.wait_for_timeout(300); await pg.click('#bSlots .slot[data-v="1-female"]'); await pg.wait_for_timeout(800); print('slots filled:', len(await pg.query_selector_all('#bSlots .slot.has')))
        await pg.click('#bWrite')
        for i in range(40):
            await pg.wait_for_timeout(500)
            if 'written' in (await pg.text_content('#bWriteMsg')): break
        print('write:', await pg.text_content('#bWriteMsg'), '| prompt boxes:', len(await pg.query_selector_all('#bPrompts textarea')))
        d = api('/api/admin/builder'); print('draft flavors:', d['flavors'], '| prompts per flavor:', {k: len(v) for k,v in d['prompts'].items()}, '| adult prompt has AUDIENCE-driven text:', 'Single male' in d['prompts']['adult-normal']['1-male'])
        boxes = await pg.query_selector_all('#bTestModels input'); print('test model boxes:', len(boxes), 'ticked:', len(await pg.query_selector_all('#bTestModels input:checked')))
        await pg.click('#bTest')
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'finished' in (await pg.text_content('#bTestMsg')): break
        print('test:', await pg.text_content('#bTestMsg'), '| rows:', len(await pg.query_selector_all('#bGrid .bRow')), '| cells:', len(await pg.query_selector_all('#bGrid .cell')))
        cells = await pg.query_selector_all('#bGrid .cell img'); await cells[0].click(); await pg.wait_for_timeout(500); await (await pg.query_selector('#bGrid a[data-thumb]')).click(); await pg.wait_for_timeout(600)
        print('winners:', len(await pg.query_selector_all('#bGrid .cell.win')), '| thumb marked:', len(await pg.query_selector_all('#bGrid .cell.thumb')))
        await pg.click('#bPublish'); await pg.wait_for_timeout(1500); print('publish:', await pg.text_content('#bPubMsg'))
        ths = api('/api/admin/state')['themes']; t = [x for x in ths if x['name']=='Rockstar'][0]; print('theme:', t['name'], t['rating'], t['proportions'], '| prompts:', sum(1 for v in t['prompts'].values() if v.strip()), '| vm:', t['variantModels'], '| thumb:', t['hasThumb'], '| enabled:', t['enabled'])
        # spice check on the adult flavour: fake refuses, dial back, re-check passes
        await pg.select_option('#bFlavor', 'adult-normal'); await pg.wait_for_timeout(400); await pg.click('#bCheck')
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'accepted' in (await pg.text_content('#bCheckMsg')): break
        print('check:', await pg.text_content('#bCheckMsg'), '| dial buttons:', len(await pg.query_selector_all('#bPrompts button[data-dial]')))
        await (await pg.query_selector('#bPrompts button[data-dial]')).click(); await pg.wait_for_timeout(1200); print('after dial:', 'tamer' in (await pg.input_value('#bPrompts textarea[data-v="1-male"]')), '| dial buttons now:', len(await pg.query_selector_all('#bPrompts button[data-dial]')))
        await pg.click('#bCheck')
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'accepted' in (await pg.text_content('#bCheckMsg')): break
        print('re-check:', await pg.text_content('#bCheckMsg'))
        # publish the adult flavour too, then check the iPad list respects the mode
        await pg.select_option('#bFlavor', 'adult-normal'); await pg.wait_for_timeout(400); await pg.click('#bPublish'); await pg.wait_for_timeout(1500); print('publish 2:', await pg.text_content('#bPubMsg'))
        names = lambda: [t['name'] for t in json.load(urllib.request.urlopen(B+'/api/themes'))['themes']]
        api('/api/admin/jobs-bulk', {'ids': [], 'action': 'x'});  # no-op
        for th in api('/api/admin/state')['themes']: api('/api/admin/themes/'+th['slug'], {'enabled': True}, 'PUT')
        print('iPad family mode:', names()); api('/api/admin/settings', {'eventMode': 'adult'}); print('iPad adult mode:', names()); api('/api/admin/settings', {'eventMode': 'family'})
        # settings: test models saved
        await pg.click('#nav [data-t=settings]'); await pg.wait_for_timeout(300); print('mode select:', await pg.input_value('#sMode'), '| test model boxes:', len(await pg.query_selector_all('#sTestModels input')))
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
