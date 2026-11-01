import asyncio, subprocess, time, os, json
from playwright.async_api import async_playwright
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# fake OpenAI that serves /v1/models + saved settings with the 2026-04-21 model
fake = subprocess.Popen(['node','-e',"""
const http=require('http');http.createServer((q,s)=>{if(q.url=='/v1/models'){s.setHeader('content-type','application/json');s.end(JSON.stringify({data:['gpt-image-1','gpt-image-2','gpt-image-2-2026-04-21','gpt-image-2.5-sunburst','chatgpt-image-latest','gpt-4o'].map(id=>({id}))}))}else{s.statusCode=404;s.end('{}')}}).listen(9998)
"""])
subprocess.run('rm -rf /tmp/sketchy-models && mkdir -p /tmp/sketchy-models && echo \'{"model":"gpt-image-2-2026-04-21","quality":"auto"}\' > /tmp/sketchy-models/settings.json', shell=True)
srv = subprocess.Popen('DATA_DIR=/tmp/sketchy-models OPENAI_BASE=http://localhost:9998 OPENAI_API_KEY=k ADMIN_PASSWORD=pw PORT=3457 node server/index.js', shell=True)
time.sleep(2)
async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(); pg = await br.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:3457/admin'); await pg.fill('#pw','pw'); await pg.click('#loginBtn'); await pg.wait_for_timeout(1500)
        await pg.click('#nav [data-t=settings]')
        print('settings options:', await pg.eval_on_selector_all('#sModel option', 'os=>os.map(o=>o.value)'))
        print('settings selected:', await pg.input_value('#sModel'))
        await pg.click('#nav [data-t=test]'); print('test options:', await pg.eval_on_selector_all('#tModel option', 'os=>os.map(o=>o.value)'))
        await pg.click('#nav [data-t=settings]'); await pg.select_option('#sModel','gpt-image-2.5-sunburst'); await pg.click('#sSave'); await pg.wait_for_timeout(800)
        print('saved on disk:', json.load(open('/tmp/sketchy-models/settings.json'))['model'], '| toast:', await pg.text_content('#toast'))
        await pg.reload(); await pg.wait_for_timeout(1500); await pg.click('#nav [data-t=settings]'); print('after reload selected:', await pg.input_value('#sModel'))
        print('page errors:', errs); await br.close()
asyncio.run(main()); fake.kill(); subprocess.run('fuser -k 3457/tcp', shell=True)
