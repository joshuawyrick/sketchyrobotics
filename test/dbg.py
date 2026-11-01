import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
exec(open('test/autoqueue.py').read().split('async def main')[0].split('from playwright')[1].split('\n',1)[1])
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); ctx = await br.new_context(viewport={'width':1500,'height':900}); s = await ctx.new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(800)
        await s.uncheck('#qPause'); await s.fill('#qPreviewSecs','1'); await s.dispatch_event('#qPreviewSecs','change'); await s.click('#btnQAuto')
        await s.wait_for_timeout(6000); print('before reload:', await s.text_content('#qStatus'), '|', await s.text_content('#progTxt'))
        await s.reload(); 
        for i in range(16):
            await s.wait_for_timeout(1000); print(i, '| status:', (await s.text_content('#qStatus'))[:50], '| prog:', await s.text_content('#progTxt'), '| resume box:', await s.is_visible('#resumeBox'), '| cp:', (await s.evaluate("localStorage.getItem('dexdraw.resume.v1')") or '')[:0] != None)
        log = await s.text_content('#console'); print([l for l in log.split('\n') if 'resum' in l or 'queue:' in l][:6]); print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
