import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await (await br.new_context(viewport={'width':1400,'height':1000})).new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(B+'/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        # create an inactive theme via API
        req = urllib.request.Request(B+'/api/admin/themes', data=json.dumps({'name':'Pirate'}).encode(), headers={'content-type':'application/json','x-admin-token':'pw'}); t = json.load(urllib.request.urlopen(req))
        req = urllib.request.Request(B+'/api/admin/themes/'+t['slug'], data=json.dumps({'enabled':False}).encode(), headers={'content-type':'application/json','x-admin-token':'pw'}, method='PUT'); urllib.request.urlopen(req)
        await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(600)
        await pg.select_option('#tTheme', t['slug']); await pg.wait_for_timeout(200); await pg.select_option('#tVar', '1-female'); await pg.wait_for_timeout(200)
        print('box state:', await pg.text_content('#tBoxState'), '| theme option label has inactive:', 'inactive' in (await pg.text_content('#tTheme')))
        await pg.set_input_files('#tPhoto', '/home/claude/dexdraw/test/face.png'); await pg.fill('#tPrompt', 'Turn this person into a pirate line drawing')
        await pg.click('#tNone'); boxes = await pg.query_selector_all('#tModelBoxes input'); print('models listed:', len(boxes)); await boxes[0].check(); await boxes[1].check()
        await pg.select_option('#tMod', 'low'); await pg.click('#tRun')
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'finished' in (await pg.text_content('#tMsg')): break
        print('msg:', await pg.text_content('#tMsg'), '| cards:', len(await pg.query_selector_all('#labOut .lab')))
        card = (await pg.query_selector_all('#labOut .lab'))[1]; model = await card.eval_on_selector('.m', 'e=>e.textContent'); print('second card:', model)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await (await card.query_selector('button[data-apply]')).click(); await pg.wait_for_timeout(1200); print('toast:', await pg.text_content('#toast'))
        th = [x for x in json.load(urllib.request.urlopen(urllib.request.Request(B+'/api/admin/state', headers={'x-admin-token':'pw'})))['themes'] if x['slug']==t['slug']][0]
        print('theme prompt now:', th['prompts']['1-female'], '| variantModels:', th['variantModels'], '| enabled:', th['enabled'])
        print('applied card marked:', len(await pg.query_selector_all('#labOut .lab.applied')))
        # history + ref reuse
        await pg.reload(); await pg.wait_for_timeout(1500); await pg.click('#nav [data-t=test]'); await pg.wait_for_timeout(500); await pg.select_option('#tTheme', t['slug']); await pg.wait_for_timeout(300)
        print('history cards:', len(await pg.query_selector_all('#labHist .lab')), '| ref photos:', len(await pg.query_selector_all('#refStrip img')))
        # used params recorded
        lab = json.load(urllib.request.urlopen(urllib.request.Request(B+'/api/admin/lab', headers={'x-admin-token':'pw'})))['results']; print('used:', lab[0]['used'])
        # theme editor shows per-box model
        await pg.click('#nav [data-t=themes]'); await pg.wait_for_timeout(300); await pg.click(f'.theme[data-s="{t["slug"]}"]'); await pg.wait_for_timeout(500)
        print('editor box model:', await pg.input_value('.vmModel[data-v="1-female"]'))
        # queue tab must not show lab jobs
        await pg.click('#nav [data-t=queue]'); await pg.wait_for_timeout(300); print('queue rows:', len(await pg.query_selector_all('#qbody tr')))
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
