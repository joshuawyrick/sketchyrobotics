"""Pet alone: server, zip import into an existing theme (merge), guest iPad flow, phone page label, admin editor, export."""
import asyncio, io, json, os, sys, time, zipfile, urllib.request
from playwright.async_api import async_playwright
B = 'http://localhost:3456'; FACE = os.environ.get('FACE'); fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
def api(path, body=None, method=None, raw=False, files=None):
    if files is not None:  # multipart, one file
        bnd = 'xXpetXx'; name, fn, data = files; pre = f'--{bnd}\r\nContent-Disposition: form-data; name="{name}"; filename="{fn}"\r\nContent-Type: application/zip\r\n\r\n'.encode(); post = f'\r\n--{bnd}--\r\n'.encode()
        r = urllib.request.Request(B + path, data=pre + data + post, method='POST', headers={'x-admin-token': 'pw', 'content-type': 'multipart/form-data; boundary=' + bnd})
    else:
        r = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, method=method or ('POST' if body is not None else 'GET'), headers={'x-admin-token': 'pw', 'content-type': 'application/json'})
    d = urllib.request.urlopen(r).read(); return d if raw else json.loads(d)
def zipof(files):
    b = io.BytesIO(); z = zipfile.ZipFile(b, 'w')
    for n, t in files.items(): z.writestr(n, t)
    z.close(); return b.getvalue()
async def main():
    # an existing 18+ theme with people + pet prompts (like the booth's), and a family theme with people only
    api('/api/admin/themes/import', files=('zip', 'a.zip', zipof({'Rockstar/single-male.md': 'ROCK MALE', 'Rockstar/female-pet.md': 'ROCK FEMALE PET', 'Rockstar/theme.txt': 'enabled: yes\nrating: adult\nproportions: bighead\nlettering: pacifico',
                                                                   'Evil Clown/single-female.md': 'CLOWN F', 'Evil Clown/theme.txt': 'enabled: yes\nrating: family'})))
    api('/api/admin/settings', {'eventMode': 'adult'}); api('/api/admin/lettering', {'enabled': True})
    st = api('/api/admin/state'); check(st['variants'].get('pet-only') == 'Pet alone' and st['variantOrder'][-1] == 'pet-only', 'server knows Pet alone')
    # the import Josh will do: a zip with only pet-alone.md per theme, "replace" left unticked
    prev = api('/api/admin/themes/import?preview=1', files=('zip', 'p.zip', zipof({'Rockstar/pet-alone.md': 'ROCK PET ALONE'})))
    check(prev['themes'][0]['isNew'] is False and prev['themes'][0]['prompts'] == 1 and not prev['themes'][0]['cleared'], 'preview: adds 1 prompt to the existing theme, clears nothing')
    api('/api/admin/themes/import', files=('zip', 'p.zip', zipof({'Rockstar/pet-alone.md': 'ROCK PET ALONE'})))
    t = next(x for x in api('/api/admin/state')['themes'] if x['slug'] == 'rockstar')
    check(t['prompts']['pet-only'] == 'ROCK PET ALONE' and t['prompts']['1-male'] == 'ROCK MALE' and t['prompts']['pet-female'] == 'ROCK FEMALE PET', 'import merged: Pet alone added, other prompts kept')
    check(t['enabled'] and t['rating'] == 'adult' and t['proportions'] == 'bighead' and t.get('lettering') == 'pacifico', 'import left the theme settings alone')
    th = {x['slug']: x for x in api('/api/themes')['themes']}; check('pet-only' in th['rockstar']['variants'] and 'pet-only' not in th['evil-clown']['variants'], 'guest theme list offers Pet alone only where there is a prompt')
    z = zipfile.ZipFile(io.BytesIO(api('/api/admin/themes/export?slug=rockstar', raw=True))); check(any(n.endswith('/pet-alone.md') for n in z.namelist()), 'export writes pet-alone.md')
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']); errs = []
        gc = await br.new_context(viewport={'width': 1024, 'height': 768}); await gc.grant_permissions(['camera'], origin=B); g = await gc.new_page(); g.on('pageerror', lambda e: errs.append('guest: ' + str(e)))
        await g.goto(B + '/'); await g.wait_for_timeout(800)
        await g.click('.tile:has-text("Evil Clown")'); await g.wait_for_timeout(200)
        vis = [await c.get_attribute('data-w') for c in await g.query_selector_all('#who .choice') if await c.is_visible()]; check(vis == ['1'], f'Evil Clown offers only what it has prompts for {vis}')
        await g.click('#backWho'); await g.wait_for_timeout(200); await g.click('.tile:has-text("Rockstar")'); await g.wait_for_timeout(200)
        vis = [await c.get_attribute('data-w') for c in await g.query_selector_all('#who .choice') if await c.is_visible()]; check(vis == ['1', 'pet', 'petonly'], f'Rockstar offers one person, person + pet, just my pet {vis}')
        check((await g.inner_text('#who .choice[data-w="petonly"]')).strip() == 'Just my pet', 'button reads "Just my pet"')
        await g.click('#who .choice[data-w="petonly"]'); await g.wait_for_timeout(150)
        check(await g.locator('#genders .pair').count() == 0 and await g.is_enabled('#nextWho'), 'no male/female question, Next is on')
        await g.screenshot(path=os.environ.get('SHOT', '/tmp/petalone') + '-who.png')
        await g.click('#nextWho'); await g.wait_for_timeout(400)
        labels = await g.locator('#nameFields label span').all_inner_texts(); check(labels == ["Your pet's name"], f'names screen asks only for the pet {labels}')
        check('just the pet' in await g.inner_text('#crumb1b'), 'breadcrumb says just the pet')
        await g.fill('#nameFields input', 'Biscuit'); await g.click('#nextNames'); await g.wait_for_timeout(600)
        check('your pet' in (await g.text_content('#camTip')), 'camera tip says your pet')
        await g.set_input_files('#fileIn', FACE); await g.wait_for_timeout(500); await g.click('#send'); await g.wait_for_timeout(2500)
        jobs = api('/api/admin/state')['jobs']; j = jobs[0] if jobs else {}
        check(j.get('variant') == 'pet-only' and (j.get('names') or {}).get('pet') == 'Biscuit' and not (j.get('names') or {}).get('a'), 'job is Pet alone with the pet name')
        for _ in range(40):
            j = next(x for x in api('/api/admin/state')['jobs'] if x['id'] == j['id'])
            if j['status'] in ('ready', 'failed'): break
            time.sleep(0.25)
        raw = json.load(open(f'/tmp/sketchy-pet/jobs/{j["id"]}/job.json')); check(j['status'] == 'ready' and raw.get('used', {}).get('moderation') == 'auto', f'image made with the standard content filter in an 18+ theme ({raw.get("used")})')
        # next guest: a person again — the camera tip goes back to "your face"
        await g.goto(B + '/'); await g.wait_for_timeout(600); await g.click('.tile:has-text("Rockstar")'); await g.click('#who .choice[data-w="1"]'); await g.click('.pair .choice:has-text("Male")'); await g.click('#nextWho'); await g.wait_for_timeout(300); await g.click('#skipNames'); await g.wait_for_timeout(500)
        check('your face' in (await g.text_content('#camTip')), 'next guest gets "your face" again')
        # admin: theme editor has the Pet alone box
        a = await br.new_page(viewport={'width': 1300, 'height': 900}); a.on('pageerror', lambda e: errs.append('admin: ' + str(e)))
        await a.goto(B + '/admin/'); await a.fill('#pw', 'pw'); await a.click('#loginBtn'); await a.wait_for_timeout(800); await a.click('#nav button[data-t=themes]'); await a.wait_for_timeout(300)
        check('3/9 prompts' in await a.inner_text('#themeGrid .theme:has-text("Rockstar")'), 'theme card counts 9 combinations')
        await a.click('#themeGrid .theme:has-text("Rockstar")'); await a.wait_for_timeout(400)
        check(await a.input_value('textarea[data-v="pet-only"]') == 'ROCK PET ALONE', 'admin theme editor shows the Pet alone prompt')
        await a.screenshot(path=os.environ.get('SHOT', '/tmp/petalone') + '-admin.png', full_page=True)
        check(not errs, f'no page errors {errs}'); await br.close()
    print('\nFAILED:' if fails else '\nALL PASSED', fails or ''); sys.exit(1 if fails else 0)
asyncio.run(main())
