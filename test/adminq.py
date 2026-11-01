import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await (await br.new_context(viewport={'width':1400,'height':900})).new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        # mark job 1 done with a draw report (as Studio would)
        d = json.load(urllib.request.urlopen(B+'/api/queue')); j1 = d['jobs'][0]['id']
        req = urllib.request.Request(B+f'/api/jobs/{j1}/status', data=json.dumps({'status':'done','drawSeconds':125.4,'strokes':254,'widthMm':152.4,'preset':'Quality (default)'}).encode(), headers={'content-type':'application/json'}); urllib.request.urlopen(req)
        await pg.goto(B+'/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        print('stats:', await pg.text_content('#drawStats'))
        rows = await pg.eval_on_selector_all('#qbody tr', 'rs=>rs.map(r=>r.children[1].textContent+" "+r.children[5].textContent.trim()+" | "+r.children[7].textContent.trim())'); print('rows:', rows)
        # select rows 2 and 3, archive
        boxes = await pg.query_selector_all('.selRow'); await boxes[1].check(); await boxes[2].check(); print('sel note:', await pg.text_content('#selNote'))
        await pg.click('#bArchive'); await pg.wait_for_timeout(1200); print('toast:', await pg.text_content('#toast'))
        print('rows after archive (hidden):', await pg.eval_on_selector_all('#qbody tr', 'rs=>rs.length'), '| queue API jobs:', len(json.load(urllib.request.urlopen(B+'/api/queue'))['jobs']))
        await pg.check('#showArchived'); await pg.wait_for_timeout(300); print('rows with archived shown:', await pg.eval_on_selector_all('#qbody tr', 'rs=>rs.length'), '| archived art still served:', urllib.request.urlopen(B+f"/api/jobs/{d['jobs'][1]['id']}/art").status)
        csv = urllib.request.urlopen(B+'/api/admin/drawlog.csv?token=pw').read().decode(); print('csv:', csv.replace('\n',' || '))
        # bulk delete one archived
        boxes = await pg.query_selector_all('.selRow'); await boxes[2].check(); pg.on('dialog', lambda dg: asyncio.ensure_future(dg.accept())); await pg.click('#bDelete'); await pg.wait_for_timeout(1200); print('after delete:', await pg.text_content('#qsum'))
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
