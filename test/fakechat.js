// fake OpenAI: images/edits + chat/completions + models
const http=require('http'),fs=require('fs');const png=fs.readFileSync(process.argv[2]).toString('base64');
http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('content-type','application/json');
  if(req.url==='/v1/models') return res.end(JSON.stringify({data:['gpt-image-2','gpt-4.1-mini','gpt-4.1','gpt-5','gpt-4o-audio-preview'].map(id=>({id}))}));
  if(req.url==='/v1/chat/completions'){ let j={}; try{j=JSON.parse(body)}catch(_){ } const u=j.messages[1].content; const combo=(u.match(/COMBINATION: (.+)/)||[])[1]; return setTimeout(()=>res.end(JSON.stringify({choices:[{message:{content:`THEME SECTION for ${combo}: leather jacket, studs, Flying-V guitar, stage pose.`}}]})),200); }
  setTimeout(()=>res.end(JSON.stringify({data:[{b64_json:png}]})),300);});}).listen(9999);
