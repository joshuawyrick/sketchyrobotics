import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
exec(open('test/autoqueue.py').read().split('async def main')[0].split('from playwright')[1].split('\n',1)[1])
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); ctx = await br.new_context(viewport={'width':1500,'height':900}); s = await ctx.new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e))); s.on('console', lambda m: errs.append('console:'+m.text) if m.type=='error' else None)
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(800)
        await s.uncheck('#qPause'); await s.fill('#qPreviewSecs','1'); await s.dispatch_event('#qPreviewSecs','change'); await s.click('#btnQAuto')
        for i in range(4):
            await s.wait_for_timeout(1000); print(i, (await s.text_content('#qStatus'))[:40], '| prog:', (await s.text_content('#progTxt'))[:30], '| stop enabled:', not await s.is_disabled('#btnStop'), '| sent:', await s.evaluate('window.__sent||0'))
        log = await s.evaluate("Array.from(document.querySelectorAll('#console div')).map(d=>d.textContent).slice(-14)"); print(log); print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
