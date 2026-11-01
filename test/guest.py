import asyncio, subprocess, time, sys, os
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
srv = subprocess.Popen(['bash','test/e2e.sh'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(14)
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); g = await br.new_page(viewport={'width':1024,'height':768}); errs=[]; g.on('pageerror', lambda e: errs.append(str(e)))
        await g.goto('http://localhost:3456/'); await g.wait_for_timeout(500)
        await g.click('.tile:has-text("Evil Clown")'); await g.click('.choice[data-w="1"]'); await g.click('.pair .choice:has-text("Female")'); await g.click('#nextWho'); await g.wait_for_timeout(300)
        await g.set_input_files('#fileIn','/home/claude/dexdraw/test/face.png'); await g.wait_for_timeout(300); await g.click('#send'); await g.wait_for_timeout(5000)
        print('status:', (await g.text_content('#status')).replace('\n',' ')[:140])
        await g.wait_for_timeout(22000)
        on = [s for s in ['s-theme','s-who','s-cam','s-status'] if await g.eval_on_selector('#'+s,'e=>e.classList.contains("on")')]
        print('after 22s on screen:', on, '(expect s-theme)')
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
for p in subprocess.run(['pgrep','-f','node server/index.js|node test/fakeai.js'],capture_output=True,text=True).stdout.split(): subprocess.run(['kill',p])
