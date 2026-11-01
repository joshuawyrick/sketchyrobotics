import asyncio
from playwright.async_api import async_playwright
B='http://localhost:3456'
FAKE = """
  window.__lines = [];
  const mk = () => window.__port || (window.__port = ({ getInfo: () => ({ usbVendorId: 1155, usbProductId: 22336 }), open: async () => {}, close: async () => {}, addEventListener: () => {},
    readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
    writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); window.__lines.push(line); setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, /^G1 X/.test(line) ? 15 : 2); } }) });
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => mk(), getPorts: async () => [], addEventListener: () => {} } });
"""

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); s = await (await br.new_context(viewport={'width':1500,'height':900})).new_page()
        await s.add_init_script(FAKE); await s.goto(B+'/studio/'); await s.wait_for_timeout(800); await s.click('#btnConnect'); await s.wait_for_timeout(600)
        await s.click('#btnQNext')
        for i in range(60):
            await s.wait_for_timeout(300)
            if await s.is_visible('#btnQDraw'): break
        bb = await s.evaluate("(()=>{const r=document.querySelector('aside.right section').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,700)}})()"); await s.screenshot(path='test/queue-panel.png', clip=bb); await br.close()
asyncio.run(main())
