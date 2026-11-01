import asyncio, subprocess, time, os
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
srv = subprocess.Popen('DATA_DIR=/tmp/sketchy-rc OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3458 node server/index.js', shell=True); time.sleep(2)
FAKE = """
  const mk = () => window.__port || (window.__port = ({ getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }), open: async () => {}, close: async () => {}, addEventListener: () => {},
    readable: new ReadableStream({ start(c) { window.__push = t => c.enqueue(new TextEncoder().encode(t)); } }),
    writable: new WritableStream({ write(chunk) { const line = new TextDecoder().decode(chunk).trim(); setTimeout(() => { if (/^M114/.test(line)) window.__push('X:0.00 Y:300.00 Z:1.20 E:0.00\\r\\nok\\r\\n'); else if (/^M2010/.test(line)) window.__push('V2.4.4\\r\\nok\\r\\n'); else window.__push('ok\\r\\n'); }, 5); } }) }))
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => { localStorage.setItem('__granted','1'); return mk(); }, getPorts: async () => localStorage.getItem('__granted') ? [mk()] : [], addEventListener: () => {} } });
"""
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); ctx = await br.new_context(); s = await ctx.new_page(); errs=[]; s.on('pageerror', lambda e: errs.append(str(e)))
        await s.add_init_script(FAKE)
        await s.goto('http://localhost:3458/studio/'); await s.wait_for_timeout(800); print('fresh load status:', await s.text_content('#status'))
        await s.click('#btnConnect'); await s.wait_for_timeout(800); print('after connect:', await s.text_content('#status'), await s.text_content('#fw'))
        await s.reload(); await s.wait_for_timeout(1200); print('after reload:', await s.text_content('#status'), await s.text_content('#fw'))
        await s.click('#btnDisconnect'); await s.wait_for_timeout(300); await s.reload(); await s.wait_for_timeout(1200); print('after manual disconnect + reload:', await s.text_content('#status'))
        print('errors:', errs or 'none'); await br.close()
asyncio.run(main()); subprocess.run('fuser -k 3458/tcp', shell=True)
