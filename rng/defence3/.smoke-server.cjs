const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('../..');
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.wav':'audio/wav','.mp3':'audio/mpeg'};
http.createServer((req,res) => {
  let file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root + path.sep)) {res.writeHead(403).end();return;}
  if(fs.existsSync(file) && fs.statSync(file).isDirectory()) file=path.join(file,'index.html');
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Document-Policy':'js-profiling'});res.end(data);});
}).listen(8123,'127.0.0.1',()=>console.log('Smoke preview ready on 8123'));
