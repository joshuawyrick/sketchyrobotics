import asyncio, subprocess, time, os, shutil
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# seed 6 themes with the clown thumbnail
shutil.rmtree('/tmp/sketchy-tiles', ignore_errors=True)
for i, n in enumerate(['Evil Clown','Rockstar','Baseball','Pirate','Superhero','Zombie']):
    d=f'/tmp/sketchy-tiles/themes/{n.lower().replace(" ","-")}'; os.makedirs(d+'/prompts'); open(d+'/theme.json','w').write('{"name":"%s","enabled":true,"order":%d}'%(n,i)); open(d+'/prompts/1-male.txt','w').write('p'); shutil.copy('/home/claude/dexdraw/test/clown.png', d+'/thumb.png')
srv = subprocess.Popen('DATA_DIR=/tmp/sketchy-tiles OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3459 node server/index.js', shell=True); time.sleep(2)
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        for name, vw, vh in [('portrait-11in', 834, 1194), ('landscape-11in', 1194, 834), ('portrait-13in', 1024, 1366)]:
            pg = await (await br.new_context(viewport={'width':vw,'height':vh}, device_scale_factor=1)).new_page()
            await pg.goto('http://localhost:3459/'); await pg.wait_for_timeout(1200); await pg.screenshot(path=f'test/tiles-{name}.png')
            w = await pg.evaluate("document.querySelector('.tile').getBoundingClientRect().width"); print(name, 'tile width px:', round(w))
        await br.close()
asyncio.run(main()); subprocess.run('fuser -k 3459/tcp', shell=True)
