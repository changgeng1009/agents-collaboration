import {FIXTURE_ROOT} from './test-context.mjs';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {downloadPinnedSource,validateSourceUrl,isPublicIPv4} from '../bridge/src/content-download.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=Buffer.from('synthetic-media-bytes'),checks=[];let calls=0;
const server=http.createServer((req,res)=>{calls++;if(req.url==='/redirect'){res.writeHead(302,{location:'/ok'});res.end();}else if(req.url==='/partial'){res.writeHead(200,{'content-length':bytes.length+4});res.end(bytes);}else{res.writeHead(200,{'content-length':bytes.length});res.end(bytes);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,source={kind:'https',url:base+'/ok',allowedHosts:['127.0.0.1'],sha256:hash(bytes),byteLength:bytes.length};
try{
 await assert.rejects(downloadPinnedSource(source,path.join(FIXTURE_ROOT,'forbidden.bin'),{fixture:false}),{code:'CONTENT_DOWNLOAD_URL_FORBIDDEN'});assert.equal(calls,0);
 await downloadPinnedSource(source,path.join(FIXTURE_ROOT,'good.bin'),{fixture:true});assert.equal(hash(fs.readFileSync(path.join(FIXTURE_ROOT,'good.bin'))),source.sha256);assert.equal(calls,1);
 await assert.rejects(downloadPinnedSource({...source,url:base+'/redirect'},path.join(FIXTURE_ROOT,'redirect.bin'),{fixture:true}),{code:'CONTENT_DOWNLOAD_HTTP_UNKNOWN'});assert.equal(calls,2);
 await assert.rejects(downloadPinnedSource({...source,url:base+'/partial'},path.join(FIXTURE_ROOT,'partial.bin'),{fixture:true}));assert.equal(calls,3);
 assert.equal(fs.existsSync(path.join(FIXTURE_ROOT,'partial.bin')),true,'失败的部分文件保留');
 for(const ip of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.2.3','172.16.0.2','192.168.1.2','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1'])assert.equal(isPublicIPv4(ip),false,ip);
 assert.equal(isPublicIPv4('8.8.8.8'),true);assert.throws(()=>validateSourceUrl({...source,url:'https://example.invalid/a',allowedHosts:['other.invalid']},{fixture:false}));
 assert.throws(()=>validateSourceUrl({...source,url:'https://user:pass@example.invalid/a',allowedHosts:['example.invalid']},{fixture:false}));
 checks.push('本机回收准确字节与SHA','跳转不跟随且无自动重试','部分输出保留未知','真实模式拒绝HTTP与私网地址');
 const fresh={kind:'https',mode:'fresh',url:base+'/redirect',urlSha256:hash(Buffer.from(base+'/redirect')),allowedHosts:['127.0.0.1'],maxBytes:64,maxRedirects:2};const freshResult=await downloadPinnedSource(fresh,path.join(FIXTURE_ROOT,'fresh.bin'),{fixture:true});assert.equal(freshResult.sha256,hash(bytes));assert.equal(freshResult.redirectsFollowed,1);assert.equal(freshResult.byteLength,bytes.length);
 await assert.rejects(downloadPinnedSource({...fresh,maxRedirects:0},path.join(FIXTURE_ROOT,'fresh-block.bin'),{fixture:true}),{code:'CONTENT_DOWNLOAD_REDIRECT_LIMIT'});
 await assert.rejects(downloadPinnedSource({...fresh,maxBytes:4},path.join(FIXTURE_ROOT,'fresh-large.bin'),{fixture:true}));
 checks.push('fresh不预知SHA/大小但固定原URL摘要与大小上限','fresh只在批准主机跳转并记录每跳','跳数和大小超限保留未知');
}finally{await new Promise(resolve=>server.close(resolve));}
const dir=path.join(FIXTURE_ROOT,'logs/download-tests');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({checks,fixtureRoot:FIXTURE_ROOT,loopbackRequests:calls,externalRequests:0,modelCalls:0},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,fixtureRoot:FIXTURE_ROOT}));
