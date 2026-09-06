import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fixtures,fixtureEvents,renderFixture} from './test-case-detail-layout.mjs';

// Local display-only preview: exact asset allowlist, no .env/auth/API access,
// no real records, no outbound network, no submissions or payment functions.
const root=new URL('../',import.meta.url);
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self' 'unsafe-inline'; frame-src 'self'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'");
  try {
    const url=new URL(req.url,'http://127.0.0.1:4181');
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(url.pathname==='/owner/assets/cases.css'){
      res.setHeader('Content-Type','text/css; charset=utf-8');res.end(await readFile(new URL('owner/assets/cases.css',root)));return;
    }
    if(url.pathname!=='/'){res.writeHead(404).end('Not available in UI preview');return;}
    const name=Object.hasOwn(fixtures,url.searchParams.get('case'))?url.searchParams.get('case'):'customer';
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(url.searchParams.get('mobile')==='1'){
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Case details — 390px mobile preview</title><style>body{margin:24px;background:#eef0f5;font:15px Arial}iframe{width:390px;height:850px;border:1px solid #cbd5e1;background:white}</style><h1>390px mobile preview — fictional data</h1><iframe title="Case detail at mobile width" src="/?case='+name+'"></iframe></html>');return;
    }
    const owner=await readFile(new URL('owner/index.html',root),'utf8');
    const style=owner.match(/<style>([\s\S]*?)<\/style>/)[1];
    const html=await renderFixture(fixtures[name],fixtureEvents);
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Case details — local layout preview</title><link rel="stylesheet" href="/owner/assets/cases.css"><style>'+style+'</style><style>.preview-main{min-width:0;padding:2rem}.preview-nav{display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0 1.5rem;font-size:.85rem}.preview-note{padding:1rem;border-bottom:1px solid var(--border);font-size:.85rem}h1{font-size:1.35rem}@media(max-width:600px){.preview-main{padding:1rem}}</style></head><body><div class="layout"><aside class="sidebar"><div class="sidebar-brand">AssembleAtEase</div><div class="sidebar-section">Owner / Cases</div></aside><main class="preview-main"><h1>Case details</h1><p class="preview-note">Local layout preview. Fictional data only. Case actions are not connected.</p><nav class="preview-nav"><a href="/?case=customer">Customer request</a><a href="/?case=pro">Easer request</a><a href="/?case=legacy">Older case</a><a href="/?case='+name+'&amp;mobile=1">Mobile preview</a></nav><div class="cases-view-shell"><div class="cases-grid"><section class="cases-panel" aria-label="Case list"><div class="cases-panel-header">Cases</div>'+Object.entries(fixtures).map(([key,item])=>'<a class="cases-list-item'+(key===name?' active':'')+'" href="/?case='+key+'"><div class="cases-list-ref">'+escape(item.ref)+'</div><div class="cases-list-subject">'+escape(item.subject)+'</div><div class="cases-list-meta">Fictional display example</div></a>').join('')+'</section><section class="cases-panel" aria-label="Case details"><div class="cases-detail">'+html+'</div></section></div></div></main></div></body></html>');
  }catch{res.writeHead(500).end('Preview rendering failed');}
}).listen(4181,'127.0.0.1',()=>console.log('Case layout preview: http://127.0.0.1:4181/ (fictional data, no live APIs)'));
