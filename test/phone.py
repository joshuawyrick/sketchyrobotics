import asyncio, subprocess, time, os, shutil, json, urllib.request
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
shutil.rmtree('/tmp/sketchy-ph', ignore_errors=True); d='/tmp/sketchy-ph/themes/evil-clown'; os.makedirs(d+'/prompts'); open(d+'/theme.json','w').write('{"name":"Evil Clown","enabled":true,"order":1}'); open(d+'/prompts/1-female.txt','w').write('p'); shutil.copy('/home/claude/dexdraw/test/clown.png', d+'/thumb.png')
subprocess.run('fuser -k 3461/tcp 9999/tcp >/dev/null 2>&1', shell=True)
fake = subprocess.Popen('node test/fakeai.js /home/claude/dexdraw/test/face.png', shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
srv = subprocess.Popen('DATA_DIR=/tmp/sketchy-ph OPENAI_BASE=http://localhost:9999 OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3461 node server/index.js', shell=True); time.sleep(2)
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        ipad = await (await br.new_context(viewport={'width':834,'height':1194}, permissions=['camera'])).new_page(); errs=[]; ipad.on('pageerror', lambda e: errs.append('ipad '+str(e)))
        await ipad.goto('http://localhost:3461/'); await ipad.wait_for_timeout(500)
        await ipad.click('.tile:has-text("Evil Clown")'); await ipad.click('.choice[data-w="1"]'); await ipad.click('.pair .choice:has-text("Female")'); await ipad.click('#nextWho'); await ipad.wait_for_timeout(1000)
        await ipad.click('#phoneBtn'); await ipad.wait_for_timeout(800)
        code = await ipad.text_content('#qrCode'); print('QR shown:', await ipad.is_visible('#qr'), '| code:', code, '| qr svg bytes:', len(urllib.request.urlopen(f'http://localhost:3461/api/phone/{code}/qr.svg').read()))
        await ipad.screenshot(path='test/phone-ipad-qr.png')
        phone = await (await br.new_context(viewport={'width':390,'height':844}, is_mobile=True)).new_page(); phone.on('pageerror', lambda e: errs.append('phone '+str(e)))
        await phone.goto(f'http://localhost:3461/p/{code}'); await phone.wait_for_timeout(600); print('phone page says:', await phone.text_content('#what'))
        await phone.screenshot(path='test/phone-pick.png')
        await phone.set_input_files('#chooseIn', '/home/claude/dexdraw/test/face.png'); await phone.wait_for_timeout(300); print('preview shown:', await phone.is_visible('#preview'))
        await phone.click('#sendBtn'); await phone.wait_for_timeout(1000); print('phone done:', await phone.is_visible('#done'))
        await ipad.wait_for_timeout(2500); print('ipad got shot:', await ipad.is_visible('#shot'), '| send bar:', await ipad.is_visible('#shotBar'), '| qr closed:', not await ipad.is_visible('#qr'))
        await ipad.screenshot(path='test/phone-ipad-shot.png')
        await ipad.click('#send'); await ipad.wait_for_timeout(1500); q = json.load(urllib.request.urlopen('http://localhost:3461/api/queue')); print('job created:', [(j['number'], j['status']) for j in q['jobs']])
        # expired code on the phone
        await phone.goto('http://localhost:3461/p/ZZZZ'); await phone.wait_for_timeout(500); print('expired msg:', (await phone.text_content('#err'))[:40])
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main()); srv.kill(); fake.kill(); subprocess.run('fuser -k 3461/tcp 9999/tcp >/dev/null 2>&1', shell=True)
