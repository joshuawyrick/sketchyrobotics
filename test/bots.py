import asyncio, json, urllib.request, subprocess
from playwright.async_api import async_playwright
B='http://localhost:3456'
exec(open('test/stop.py').read().split('async def main')[0].split('from playwright')[1].split('\n',1)[1])
def api(path, body=None, method=None):
    req = urllib.request.Request(B+path, data=json.dumps(body).encode() if body is not None else None, headers={'content-type':'application/json','x-admin-token':'pw'}, method=method or ('POST' if body is not None else 'GET')); return json.load(urllib.request.urlopen(req))
async def main():
    api('/api/admin/settings', {'bots': 3})
    async with async_playwright() as p:
        br = await p.chromium.launch(); tabs = []; errs=[]
        for n in (1, 2, 3):
            pg = await (await br.new_context(viewport={'width':1500,'height':900})).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.add_init_script(FAKE); await pg.goto(B+f'/studio/?bot={n}'); await pg.wait_for_timeout(600); await pg.click('#btnConnect'); await pg.wait_for_timeout(500); tabs.append(pg)
        await tabs[0].wait_for_timeout(4500)
        print('badges:', [await t.text_content('#botBadge') for t in tabs], '| strip cards in tab1:', len(await tabs[0].query_selector_all('#botStrip .botCard')))
        # 6 more guests arrive now that 3 bots are live → assigned round-robin by load
        for i in range(6): subprocess.run(['curl','-s','-F','photo=@/home/claude/dexdraw/test/face.png','-F','theme=evil-clown','-F','variant=1-female',B+'/api/jobs'], stdout=subprocess.DEVNULL)
        await tabs[0].wait_for_timeout(9000)
        q = api('/api/queue'); print('assignment:', sorted((j['number'], j['bot']) for j in q['jobs'] if j['status']=='ready'))
        print('tab2 summary:', await tabs[1].text_content('#qSum'))
        # each tab loads: must get its own
        got = []
        for t in tabs:
            await t.click('#btnQNext')
            for i in range(60):
                await t.wait_for_timeout(300)
                if await t.is_visible('#btnQDraw'): break
            got.append(await t.text_content('#qCurName'))
        print('each tab loaded:', got)
        q = api('/api/queue'); print('drawing by bot:', sorted((j['number'], j['bot']) for j in q['jobs'] if j['status']=='drawing'))
        # guest status shows the robot number
        j = [x for x in q['jobs'] if x['status']=='ready'][0]; print('guest api bot for #%d:' % j['number'], api('/api/jobs/'+j['id'])['bot'])
        # admin strip
        a = await (await br.new_context()).new_page(); await a.goto(B+'/admin'); await a.fill('#pw','pw'); await a.click('#loginBtn'); await a.wait_for_timeout(1500)
        print('admin bot cards:', [ (await c.text_content())[:28] for c in await a.query_selector_all('#botStrip .botCard')])
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
