import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
exec(open('test/stop.py').read().split('async def main')[0].split('from playwright')[1].split('\n',1)[1])
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); s = await (await br.new_context(viewport={'width':1500,'height':900})).new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(600)
        # Josh's real-world setup: pen-down Z around -50 and paper centre at Y=270 → top of a Letter sheet is out of reach
        await s.fill('#zDown', '-50'); await s.dispatch_event('#zDown', 'change'); await s.fill('#paperY', '270'); await s.dispatch_event('#paperY', 'change'); await s.wait_for_timeout(300)
        for place in ['center', 'top', 'bottom']:
            await s.select_option('#qPlace', place)
            await s.click('#btnQNext')
            for i in range(60):
                await s.wait_for_timeout(300)
                if await s.is_visible('#btnQDraw') or 'problem' in (await s.text_content('#qStatus')): break
            info = await s.evaluate("(()=>{const el=document.getElementById('planInfo')||document.querySelector('.planInfo'); return el?el.textContent:''})()")
            print(place, '→', (await s.text_content('#qStatus'))[:45], '| block:', repr(await s.text_content('#blockMsg')), '| size line:', ' '.join((await s.text_content('#stats')).split()) if await s.query_selector('#stats') else '')
            if await s.is_visible('#btnQDraw'): await s.click('#btnQSkipCur'); await s.wait_for_timeout(500)
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
