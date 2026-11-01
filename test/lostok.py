import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
FAKE = """
  window.__lines = [];
  const mk = () => ({ getInfo: () => ({ usbVendorId: 1155, usbProductId: 22336 }), open: async () => {}, close: async () => {}, addEventListener: () => {},
    readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
    writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); window.__lines.push(line); if (window.__lines.length === 400) return; setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, /^G1 X/.test(line) ? 15 : 2); } }) });
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => mk(), getPorts: async () => [], addEventListener: () => {} } });
"""
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); s = await (await br.new_context(viewport={'width':1500,'height':900})).new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(600)
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        t0 = __import__('time').time(); await s.click('#btnQDraw')
        for i in range(200):
            await s.wait_for_timeout(500)
            if 'done' in (await s.text_content('#qStatus')) or 'problem' in (await s.text_content('#qStatus')): break
        print('lost-ok result:', (await s.text_content('#qStatus'))[:60], '| took', round(__import__('time').time()-t0), 's')
        log = await s.text_content('#console'); print('warning logged:', 'never acknowledged' in log)
        d = json.load(urllib.request.urlopen(B+'/api/queue')); print('server done:', [j['number'] for j in d['done']])
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
