import asyncio
from playwright.async_api import async_playwright
B='http://localhost:3456'
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); s = await br.new_page(viewport={'width':1500,'height':900}); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        # fake Web Serial: an "arm" that acks every line immediately
        await s.add_init_script("""
          Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({
            open: async () => {}, close: async () => {}, addEventListener: () => {},
            readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
            writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); window.__sent = (window.__sent||0)+1; setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, 1); } })
          }) } });
        """)
        await s.goto(B+'/studio/'); await s.wait_for_timeout(800)
        await s.click('#btnConnect'); await s.wait_for_timeout(800); print('status:', await s.text_content('#status'))
        await s.fill('#qPreviewSecs','1'); await s.dispatch_event('#qPreviewSecs','change')
        await s.click('#btnQAuto'); 
        for i in range(60):
            await s.wait_for_timeout(1000); st = await s.text_content('#qStatus')
            if 'Continue' in st: break
        print('after first:', st, '| sent lines:', await s.evaluate('window.__sent'))
        await s.click('#btnQContinue')
        for i in range(60):
            await s.wait_for_timeout(1000); st = await s.text_content('#qStatus')
            if '#2' in st and ('done' in st or 'Continue' in st): break
        print('after second:', st); print('qSum:', await s.text_content('#qSum')); print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
