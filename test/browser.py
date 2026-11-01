import asyncio
from playwright.async_api import async_playwright
B='http://localhost:3456'
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); 
        errs=[]
        # ---- admin ----
        pg = await br.new_page(viewport={'width':1200,'height':900}); pg.on('pageerror', lambda e: errs.append('admin:'+str(e)))
        await pg.goto(B+'/admin/'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(800)
        print('admin queue rows:', await pg.locator('#qbody tr').count())
        await pg.click('#nav button[data-t=themes]'); await pg.wait_for_timeout(300)
        await pg.fill('#newName','Rockstar'); await pg.click('#addTheme'); await pg.wait_for_timeout(800)
        print('themes:', await pg.locator('#themeGrid .theme .nm').all_text_contents())
        await pg.fill('textarea[data-v="1-male"]','Rockstar male prompt'); await pg.click('#teSave'); await pg.wait_for_timeout(600)
        await pg.set_input_files('#teThumb','/home/claude/dexdraw/test/face.png'); await pg.wait_for_timeout(1200)
        print('thumb visible:', await pg.is_visible('#teThumbPrev'))
        await pg.screenshot(path='test/admin.png')
        # ---- guest (iPad size) ----
        g = await br.new_page(viewport={'width':1024,'height':768}); g.on('pageerror', lambda e: errs.append('guest:'+str(e)))
        await g.goto(B+'/'); await g.wait_for_timeout(600)
        print('guest tiles:', await g.locator('.tile .nm').all_text_contents())
        await g.click('.tile:has-text("Evil Clown")'); await g.wait_for_timeout(200)
        await g.click('.choice[data-w="1"]'); await g.wait_for_timeout(100)
        await g.click('.pair .choice:has-text("Male")'); await g.wait_for_timeout(100); print('1-male allowed (no prompt)?', not await g.is_disabled('#nextWho'))
        await g.click('.pair .choice:has-text("Female")'); await g.wait_for_timeout(100); print('1-female allowed?', not await g.is_disabled('#nextWho'))
        await g.click('#nextWho'); await g.wait_for_timeout(500)
        await g.set_input_files('#fileIn','/home/claude/dexdraw/test/face.png'); await g.wait_for_timeout(400)
        print('shot bar visible:', await g.is_visible('#shotBar'))
        await g.click('#send'); await g.wait_for_timeout(1500); print('status:', (await g.text_content('#status'))[:80])
        await g.wait_for_timeout(4000); print('status later:', (await g.text_content('#status'))[:90])
        await g.screenshot(path='test/guest.png')
        # ---- studio queue ----
        s = await br.new_page(viewport={'width':1500,'height':900}); s.on('pageerror', lambda e: errs.append('studio:'+str(e)))
        await s.goto(B+'/studio/'); await s.wait_for_timeout(1500)
        print('studio qSum:', await s.text_content('#qSum')); print('qList items:', await s.locator('.qItem').count())
        # simulate connected arm: fake link.connected via console? Not accessible (IIFE). Instead check Sketch next is disabled without arm.
        print('Sketch next disabled w/o arm:', await s.is_disabled('#btnQNext'))
        await s.screenshot(path='test/studio-q.png', clip={'x':1060,'y':50,'width':440,'height':520})
        print('ERRORS:', errs or 'none'); await br.close()
asyncio.run(main())
