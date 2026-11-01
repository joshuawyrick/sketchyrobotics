import asyncio, subprocess, time, os, shutil
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
shutil.rmtree('/tmp/sketchy-cl', ignore_errors=True); d='/tmp/sketchy-cl/themes/evil-clown'; os.makedirs(d+'/prompts'); open(d+'/theme.json','w').write('{"name":"Evil Clown","enabled":true,"order":1}'); open(d+'/prompts/1-female.txt','w').write('p'); shutil.copy('/home/claude/dexdraw/test/clown.png', d+'/thumb.png')
srv = subprocess.Popen('DATA_DIR=/tmp/sketchy-cl OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3460 node server/index.js', shell=True); time.sleep(2)
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        ctx = await br.new_context(viewport={'width':834,'height':1194}, permissions=['camera']); g = await ctx.new_page(); errs=[]; g.on('pageerror', lambda e: errs.append(str(e)))
        await g.goto('http://localhost:3460/'); await g.wait_for_timeout(500)
        await g.click('.tile:has-text("Evil Clown")'); await g.click('.choice[data-w="1"]'); await g.click('.pair .choice:has-text("Female")'); await g.click('#nextWho'); await g.wait_for_timeout(1500)
        await g.screenshot(path='test/cam-button.png')
        await g.click('#shutter'); await g.wait_for_timeout(400); await g.screenshot(path='test/cam-count.png'); print('count:', await g.text_content('#count'), '| button hidden:', not await g.is_visible('#shutter'))
        await g.wait_for_timeout(3200); print('after countdown: shot visible =', await g.is_visible('#shot'), '| ERRORS:', errs or 'none'); await br.close()
asyncio.run(main()); subprocess.run('fuser -k 3460/tcp', shell=True)
