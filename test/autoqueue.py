import asyncio
from playwright.async_api import async_playwright
B='http://localhost:3456'
FAKE = """
  const mk = () => window.__port || (window.__port = ({ getInfo: () => ({ usbVendorId: 1155, usbProductId: 22336 }), open: async () => {}, close: async () => {}, addEventListener: () => {},
    readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
    writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); window.__sent=(window.__sent||0)+1; setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, 2); } }) }))
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => { localStorage.setItem('__granted','1'); return mk(); }, getPorts: async () => localStorage.getItem('__granted') ? [mk()] : [], addEventListener: () => {} } });
"""
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); ctx = await br.new_context(viewport={'width':1500,'height':900}); s = await ctx.new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE)
        await s.goto(B+'/studio/'); await s.wait_for_timeout(800)
        await s.click('#btnConnect'); await s.wait_for_timeout(800)
        # manual: 1 Load -> 2 Draw
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        print('after Load: card =', await s.text_content('#qCurName'), '|', await s.text_content('#qCurNote'), '| status:', (await s.text_content('#qStatus'))[:60])
        print('file info:', await s.text_content('#fileInfo'), '| log has lettering:', 'name lettering' in (await s.text_content('#console')))
        await s.screenshot(path='test/names-canvas.png', clip={'x':0,'y':60,'width':1100,'height':840})
        await s.click('#btnQDraw')
        for i in range(120):
            await s.wait_for_timeout(500)
            if 'done' in (await s.text_content('#qStatus')): break
        print('after Draw:', (await s.text_content('#qStatus'))[:70], '| load button:', await s.text_content('#btnQNext'), '| card hidden:', not await s.is_visible('#qCur'))
        await s.uncheck('#qPause'); await s.fill('#qPreviewSecs','1'); await s.dispatch_event('#qPreviewSecs','change')
        await s.click('#btnQAuto')
        seen=set()
        for i in range(90):
            await s.wait_for_timeout(500); st = await s.text_content('#qStatus'); 
            if 'drawing' in st: seen.add(st.split(':')[0])
            if i==12: # reload mid-run
                print('reloading during:', st); await s.reload(); await s.wait_for_timeout(1500); print('after reload: status', await s.text_content('#status'), '| button:', await s.text_content('#btnQAuto'))
            if '#3 done' in st: break
        print('final:', st, '| drew:', sorted(seen), '| file info:', await s.text_content('#fileInfo'))
        print('qSum:', await s.text_content('#qSum'))
        import urllib.request, json
        d=json.load(urllib.request.urlopen(B+'/api/queue')); print('server done:', sorted(j['number'] for j in d['done']), 'remaining:', [(j['number'],j['status']) for j in d['jobs']])
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
