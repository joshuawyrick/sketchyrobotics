import asyncio, json, urllib.request
from playwright.async_api import async_playwright
B='http://localhost:3456'
FAKE = """
  window.__lines = [];
  const mk = () => window.__port || (window.__port = ({ getInfo: () => ({ usbVendorId: 1155, usbProductId: 22336 }), open: async () => {}, close: async () => {}, addEventListener: () => {},
    readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
    writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); window.__lines.push(line); setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, /^G1 X/.test(line) ? 15 : 2); } }) }))
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => mk(), getPorts: async () => [], addEventListener: () => {} } });
"""
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); s = await (await br.new_context(viewport={'width':1500,'height':900})).new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800)
        await s.click('#btnConnect'); await s.wait_for_timeout(600)
        await s.uncheck('#qPreview'); await s.dispatch_event('#qPreview','change')
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        await s.click('#btnQDraw')
        for i in range(60):
            await s.wait_for_timeout(250)
            if 'drawing' in (await s.text_content('#qStatus')) and not (await s.is_disabled('#btnStop')): break
        await s.wait_for_timeout(600); await s.click('#btnStop'); await s.wait_for_timeout(2500)
        st = await s.text_content('#qStatus'); print('after Stop:', st[:90])
        tail = await s.evaluate('window.__lines.slice(-4)'); print('last lines sent:', tail)
        d = json.load(urllib.request.urlopen(B+'/api/queue')); print('server job status:', [(j['number'], j['status']) for j in d['jobs']][:2])
        n0 = await s.evaluate('window.__lines.length')
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        await s.click('#btnQDraw')
        for i in range(120):
            await s.wait_for_timeout(500)
            if 'done' in (await s.text_content('#qStatus')): break
        print('redraw:', (await s.text_content('#qStatus'))[:40], '| lines sent in redraw:', await s.evaluate('window.__lines.length') - n0)
        # emergency stop gating
        await s.click('#btnEstop'); await s.wait_for_timeout(1500)
        print('after STOP: start disabled =', await s.is_disabled('#btnStart'), '| sketch next disabled =', await s.is_disabled('#btnQNext'), '| msg:', await s.text_content('#blockMsg'))
        await s.click('#btnHome'); await s.wait_for_timeout(1500)
        print('after Home: sketch next disabled =', await s.is_disabled('#btnQNext'), '| msg:', repr(await s.text_content('#blockMsg')))
        log = await s.text_content('#console'); print('log stop lines:', [l for l in log.split('\n') if 'stopp' in l or 'lifted' in l][:3])
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
