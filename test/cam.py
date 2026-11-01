import asyncio, subprocess, time, os
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pass
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        ctx = await br.new_context(viewport={'width':1024,'height':768}, permissions=['camera']); g = await ctx.new_page(); errs=[]; g.on('pageerror', lambda e: errs.append(str(e)))
        await g.goto('http://localhost:3456/'); await g.wait_for_timeout(500)
        await g.click('.tile:has-text("Evil Clown")'); await g.click('.choice[data-w="1"]'); await g.click('.pair .choice:has-text("Female")'); await g.click('#nextWho'); await g.wait_for_timeout(1500)
        print('video playing:', await g.evaluate("document.getElementById('video').videoWidth + 'x' + document.getElementById('video').videoHeight"))
        await g.click('#shutter'); await g.wait_for_timeout(500); print('countdown shows:', await g.text_content('#count'))
        await g.screenshot(path='test/cam-count.png')
        await g.wait_for_timeout(3500); print('shot bar visible:', await g.is_visible('#shotBar'), '| blob:', await g.evaluate("!!document.getElementById('shot').src"))
        await g.screenshot(path='test/cam-shot.png'); print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
