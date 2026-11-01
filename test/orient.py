import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        for name,(w,h) in {'portrait':(820,1180),'landscape':(1180,820)}.items():
            ctx = await br.new_context(viewport={'width':w,'height':h}, permissions=['camera']); g = await ctx.new_page(); errs=[]; g.on('pageerror', lambda e: errs.append(str(e)))
            await g.goto('http://localhost:3456/'); await g.wait_for_timeout(400)
            await g.click('.tile:has-text("Evil Clown")'); await g.click('.choice[data-w="1"]'); await g.click('.pair .choice:has-text("Female")'); await g.click('#nextWho'); await g.fill('#nameFields input', 'Josh'); await g.click('#nextNames'); await g.wait_for_timeout(1500)
            info = await g.evaluate("""() => { const b=document.getElementById('shutter').getBoundingClientRect(); const v=document.getElementById('video'); const m=document.querySelector('main'); return {btnBottom:Math.round(b.bottom), vh:window.innerHeight, scroll:m.scrollHeight-m.clientHeight, feed:v.videoWidth+'x'+v.videoHeight} }""")
            print(name, info, 'button visible:', info['btnBottom'] <= info['vh'] and info['scroll']<=0, '| ERRORS:', errs or 'none')
            await g.click('#shutter'); await g.wait_for_timeout(3800); print('  shot bar:', await g.is_visible('#shotBar'))
            await g.screenshot(path=f'test/cam-{name}.png'); await ctx.close()
        await br.close()
asyncio.run(main())
