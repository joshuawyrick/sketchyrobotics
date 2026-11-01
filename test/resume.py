import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
exec(open('test/stop.py').read().split('async def main')[0].split('from playwright')[1].split('\n',1)[1])
FAKE2 = FAKE.replace("getPorts: async () => []", "getPorts: async () => [mk()]")
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); ctx = await br.new_context(viewport={'width':1500,'height':900}); s = await ctx.new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE2); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(600)
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        await s.click('#btnQDraw'); await s.wait_for_timeout(6000)
        print('progress before reload:', await s.text_content('#progTxt'))
        await s.reload(); await s.wait_for_timeout(2500)
        print('offer:', (await s.text_content('#resumeBox'))[:95] if await s.is_visible('#resumeBox') else 'NONE')
        d = json.load(urllib.request.urlopen(B+'/api/queue')); print('job status while deciding:', [(j['number'], j['status']) for j in d['jobs']][:1])
        sent0 = await s.evaluate('window.__lines.length'); await s.click('#btnResume'); await s.wait_for_timeout(1500)
        first = await s.evaluate('window.__lines.slice(0, 12)'); print('resume program starts:', first)
        for i in range(200):
            await s.wait_for_timeout(500)
            if 'done' in (await s.text_content('#qStatus')): break
        print('final:', (await s.text_content('#qStatus'))[:60], '| lines sent after resume:', await s.evaluate('window.__lines.length') - sent0)
        d = json.load(urllib.request.urlopen(B+'/api/queue')); print('server done:', [j['number'] for j in d['done']], '| checkpoint cleared:', await s.evaluate("localStorage.getItem('dexdraw.resume.v1')") is None)
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
