// ═══════════════ Jade 编程助手 - HTTP 请求模块 ═══════════════
// 依赖: utils.js (JADE全局), app.js (tt, renderHero, state, defaultData)

function httpResponseText(d) {
  if(d.responseView==='headers')return d.responseHeaders||'-';
  if(d.responseView==='timing')return JSON.stringify(d.metrics||{},null,2);
  if(d.responseView==='json'){try{return JSON.stringify(JSON.parse(d.responseBody||d.raw||''),null,2);}catch(e){return'不是有效 JSON：'+e.message;}}
  return d.raw||d.result||'';
}

function buildUrl(d){return d.url||'';}

function decodeResponseBody(buf,contentType){
  var text=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(buf));
  if(text.indexOf('\uFFFD')<0)return text;
  var m=contentType.match(/charset\s*=\s*([^\s;]+)/i);
  if(m){try{return new TextDecoder(m[1].replace(/['"]/g,'')).decode(new Uint8Array(buf));}catch(e){}}
  try{return new TextDecoder('gbk').decode(new Uint8Array(buf));}catch(e){}
  return new TextDecoder('utf-8').decode(new Uint8Array(buf));
}

function finishHttpResponse(d,started,res,text,contentType){
  var elapsed=Math.round(performance.now()-started)+'ms';
  d.metrics={status:res.status+' '+res.statusText,time:elapsed,size:(text||'').length+'B',type:contentType||'-'};
  var formatted=text;
  try{formatted=JSON.stringify(JSON.parse(text),null,2);}catch(e){}
  d.responseHeaders=JSON.stringify(Object.fromEntries(res.headers.entries()),null,2);
  d.responseBody=text;d.raw=text;d.result=formatted;
  saveHistory(d);renderHttp(d.pageRef||activePage());
}

function saveHistory(d){
  var list=JSON.parse(localStorage.getItem('httpHistory')||'[]');
  var entry={time:Date.now(),method:d.method,url:d.url,status:(d.metrics&&d.metrics.status)||'-',
             headers:d.headers||'',body:d.body||'',proxy:d.proxy||'',protocol:d.protocol||'auto',useNative:!!d.useNative};
  // 去重：同 方法+URL+Body 的旧记录先移除，只保留最新这条，避免历史刷屏
  list=list.filter(function(h){return!(h.method===entry.method&&h.url===entry.url&&(h.body||'')===(entry.body||''));});
  list.unshift(entry);
  localStorage.setItem('httpHistory',JSON.stringify(list.slice(0,50)));
}

function sendHttp(page) {
  syncHttp(page);
  var d=page.data; d.pageRef=page;
  var started=performance.now();
  var $=JADE.$, esc=JADE.esc;
  d.result='请求中...';d.raw='请求中...';
  renderHttp(page);
  if(d.useNative){
    JADE.invoke('native_http',{method:d.method,protocol:d.protocol||'auto',url:buildUrl(d),headersText:d.headers||'',body:d.body,proxy:d.proxy||''}).then(function(res){
      var data=typeof res==='string'?JSON.parse(res):res;
      // 优先显示原生回报的实际协商协议（HTTP/2 或 HTTP/1.1）；缺失时回退到所选偏好
      var protoLabel=data.httpVersion||({http2:'HTTP/2',http3:'HTTP/3','http1.1':'HTTP/1.1'}[d.protocol]||'Auto');
      d.metrics={status:data.status||'-',time:(data.elapsedMs||0)+'ms',size:(data.body||'').length+'B',type:protoLabel};
      d.responseHeaders=data.headers||'';d.responseBody=data.body||'';d.raw=data.body||'';d.result=d.raw;
      saveHistory(d);renderHttp(page);
    }).catch(function(err){d.result='原生请求失败：'+err.message;d.raw=d.result;renderHttp(page);});
    return;
  }
  var headers={},forbidden=[];
  var FORBIDDEN=['host','content-length','connection','cookie','user-agent','origin','referer','accept-encoding','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','proxy-connection'];
  (d.headers||'').split('\n').forEach(function(line){var i=line.indexOf(':');if(i>0){var k=line.slice(0,i).trim();if(FORBIDDEN.indexOf(k.toLowerCase())>=0)forbidden.push(k);else headers[k]=line.slice(i+1).trim();}});
  var options={method:d.method,headers:headers};
  if(!['GET','HEAD'].includes(d.method))options.body=d.body;
  // 30s 超时：浏览器 fetch 跨域 + 禁止头会一直 pending，避免无限卡“请求中”
  var ac=(typeof AbortController!=='undefined')?new AbortController():null;
  if(ac)options.signal=ac.signal;
  var timedOut=false;
  var to=setTimeout(function(){if(ac){timedOut=true;ac.abort();}},30000);
  fetch(buildUrl(d),options).then(function(res){
    clearTimeout(to);
    var contentType=res.headers.get('content-type')||'';
    if(d.autoDecode!==false){
      return res.arrayBuffer().then(function(buf){
        var text=decodeResponseBody(buf,contentType);
        finishHttpResponse(d,started,res,text,contentType);
      });
    } else {
      return res.text().then(function(text){
        finishHttpResponse(d,started,res,text,contentType);
      });
    }
  }).catch(function(err){
    clearTimeout(to);
    var tip=forbidden.length?'（检测到浏览器禁止头：'+forbidden.join(', ')+'，已忽略——请勾选“原生”重发）':'';
    if(timedOut)d.result='请求失败：超时 30s（浏览器 fetch 跨域/禁止头会一直 pending）'+(forbidden.length?'。'+tip:'，建议勾选“原生”重发');
    else d.result='请求失败：'+err.message+tip;
    d.raw=d.result;renderHttp(page);
  });
}

function renderHttp(page) {
  var $=JADE.$, esc=JADE.esc, kvRows=JADE.kvRows;
  var d=page.data;
  $('page').innerHTML='<div class="tool-page">'+renderHero(page,
    '<button class="btn small" id="saveFavorite">★ '+tt('收藏')+'</button><button class="btn small" id="showHistory">'+tt('历史')+'</button><button class="btn small" id="showHttpSnippets">'+tt('模板')+'</button><button class="btn small" id="importCurl">'+tt('导入 cURL')+'</button><button class="btn small" id="copyHttpResult">'+tt('复制响应')+'</button>')+
    '<div class="grid"><div class="panel-card span-7"><div class="panel-title">Request</div>'+
    '<div class="http-toolbar">'+
    '<select id="httpMethod"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option></select>'+
    '<select id="httpProtocol" title="协议偏好"><option value="auto">Auto</option><option value="http1.1">HTTP/1.1</option><option value="http2">HTTP/2</option></select>'+
    '<input class="mono" id="httpProxy" value="'+esc(d.proxy||'')+'" placeholder="代理 socks5://127.0.0.1:1080" style="flex:1;min-width:120px;height:36px;font-size:11px">'+
    '<button class="btn primary" id="sendHttp2">'+tt('发送')+'</button>'+
    '<label class="inline-check"><input type="checkbox" id="httpNative" '+(d.useNative?'checked':'')+'> '+tt('原生')+'</label>'+
    '</div>'+
    '<input class="url-input mono" id="httpUrl" value="'+esc(d.url)+'" placeholder="https://api.example.com" style="margin-bottom:6px">'+
    '<div class="http-code-bar" id="httpCodeBar"><label class="lang-pill"><input type="radio" name="httpCodeLang" value="e" '+(d.codeLang!=='py'&&d.codeLang!=='cpp'&&d.codeLang!=='go'&&d.codeLang!=='curl'&&d.codeLang!=='rs'&&d.codeLang!=='js'?'checked':'')+'><img class="pill-icon" src="E.svg" onerror="this.style.display=\'none\'"><span class="pill-label">'+tt('易语言')+'</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="py" '+(d.codeLang==='py'?'checked':'')+'><img class="pill-icon" src="python.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Python</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="js" '+(d.codeLang==='js'?'checked':'')+'><img class="pill-icon" src="folder_type_js.svg" onerror="this.style.display=\'none\'"><span class="pill-label">JS</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="cpp" '+(d.codeLang==='cpp'?'checked':'')+'><img class="pill-icon" src="2.ico"><span class="pill-label">C++</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="go" '+(d.codeLang==='go'?'checked':'')+'><img class="pill-icon" src="go.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Go</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="rs" '+(d.codeLang==='rs'?'checked':'')+'><img class="pill-icon" src="rust.svg" onerror="this.style.display=\'none\'"><span class="pill-label">Rust</span></label><label class="lang-pill"><input type="radio" name="httpCodeLang" value="curl" '+(d.codeLang==='curl'?'checked':'')+'><img class="pill-icon" src="http.svg" onerror="this.style.display=\'none\'"><span class="pill-label">cURL</span></label><button class="btn copy-code-btn" id="copyHttpCode">'+tt('复制代码')+'</button></div>'+
    '<label>'+tt('Headers（含Query参数和Cookie）')+'</label><textarea class="mono" id="httpHeaders" style="min-height:90px" placeholder="Accept: application/json&#10;Authorization: Bearer xxx&#10;Content-Type: application/json&#10;Cookie: token=abc; lang=zh">'+esc(d.headers)+'</textarea>'+
    '<label>'+tt('Body')+' <span style="margin-left:12px;font-weight:400;text-transform:none;letter-spacing:0"><input type="checkbox" id="httpAutoDecode" '+(d.autoDecode!==false?'checked':'')+' style="vertical-align:middle"> '+tt('自动编码(响应转UTF-8)')+'</span></label><textarea class="mono" id="httpBody" style="min-height:280px">'+esc(d.body)+'</textarea></div>'+
    '<div class="panel-card span-5"><div class="panel-title">Response</div>'+
    '<div class="status-strip"><div class="metric"><div class="metric-label">Status</div><div class="metric-value">'+esc(d.metrics.status||'-')+'</div></div><div class="metric"><div class="metric-label">Time</div><div class="metric-value">'+esc(d.metrics.time||'-')+'</div></div><div class="metric"><div class="metric-label">Size</div><div class="metric-value">'+esc(d.metrics.size||'-')+'</div></div><div class="metric"><div class="metric-label">Type</div><div class="metric-value">'+esc(d.metrics.type||'-')+'</div></div></div>'+
    '<div class="code-tabs"><button class="btn small'+(d.responseView==='raw'?' active':'')+'" data-response-view="raw">Raw</button><button class="btn small'+(d.responseView==='json'?' active':'')+'" data-response-view="json">JSON</button><button class="btn small'+(d.responseView==='headers'?' active':'')+'" data-response-view="headers">Headers</button><button class="btn small'+(d.responseView==='timing'?' active':'')+'" data-response-view="timing">Timing</button></div>'+
    '<pre class="result-box" id="httpResult" style="min-height:140px">'+esc(httpResponseText(d))+'</pre></div></div></div>';
  $('httpMethod').value=d.method;
  if($('httpProtocol'))$('httpProtocol').value=d.protocol||'auto';
}

function syncHttp(page){
  var $=JADE.$;
  var d=page.data;
  if(!$('httpMethod'))return;
  d.method=$('httpMethod').value;
  d.protocol=$('httpProtocol')?$('httpProtocol').value:(d.protocol||'auto');
  d.url=$('httpUrl').value;
  d.proxy=$('httpProxy')?$('httpProxy').value:(d.proxy||'');
  d.body=$('httpBody').value;
  d.headers=$('httpHeaders')?$('httpHeaders').value:d.headers;
  d.useNative=$('httpNative')?$('httpNative').checked:d.useNative;
  d.autoDecode=$('httpAutoDecode')?$('httpAutoDecode').checked:(d.autoDecode!==false);
}

function importCurl(page){
  var text=prompt('粘贴浏览器或终端复制的 cURL：');
  if(!text)return;
  var d=page.data;

  // Normalize: strip Windows cmd ^ escaping completely
  text=text.replace(/\^\^/g,'\x01');
  text=text.replace(/\^([\s\S])/g,'$1');
  text=text.replace(/\x01/g,'^');
  text=text.replace(/\^[\r\n]*$/gm,'');
  // Unwrap multiline backslash continuation
  text=text.replace(/\\\r?\n\s*/g,' ');

  // Extract URL - support "url", 'url', $'url' formats
  var urlM=text.match(/(?:\$)?["'](https?:\/\/[^"'\s]+)(?:\$)?["']/);
  if(!urlM)urlM=text.match(/(https?:\/\/[^\s"'$]+)/);
  d.url=urlM?urlM[1]:d.url;

  // Method
  var methodM=text.match(/(?:-X|--request)\s+(?:\$)?["']?(\w+)(?:\$)?["']?/i);
  if(methodM)d.method=methodM[1].toUpperCase();
  // curl 无 -X 但带 --data/-d 时隐式为 POST（浏览器“复制为 cURL”从不写 -X，漏判会变 GET → 服务器报 Invalid query）
  else if(/(?:--data-raw|--data-binary|--data|--data-ascii|-d)\s/.test(text))d.method='POST';

  // Body - handle --data-raw, --data, -d, --data-binary
  // Priority: $'...' single-quote bash, then '...' single-quote, then "..." double-quote (lazy)
  var bodyM=text.match(/(?:--data-raw|--data-binary|--data|-d)\s+\$?'([^']*)'/);
  if(!bodyM)bodyM=text.match(/(?:--data-raw|--data-binary|--data|-d)\s+"((?:[^"\\]|\\.)*)"/);
  if(bodyM)d.body=bodyM[1].replace(/\\"/g,'"').replace(/\\'/g,"'").replace(/\\\\/g,'\\');

  // Headers (-H, --header) - support ", ', $' quoting
  var headerLines=[];
  var hm;
  // Double-quoted
  var hRe=/-(?:H|header)\s+"((?:[^"\\]|\\.)*)"/g;
  while((hm=hRe.exec(text))!==null)headerLines.push(hm[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\'));
  // Single-quoted (bash)
  hRe=/-(?:H|header)\s+'([^']+)'/g;
  while((hm=hRe.exec(text))!==null)headerLines.push(hm[1].replace(/\\'/g,"'"));
  // $'...' bash ANSI-C quoting
  hRe=/-H\s+\$'([^']+)'/g;
  while((hm=hRe.exec(text))!==null)headerLines.push(hm[1].replace(/\\'/g,"'").replace(/\\\\/g,'\\'));

  // Cookies (-b, --cookie)
  var cRe=/-(?:b|cookie)\s+"([^"]+)"/g; var cm;
  while((cm=cRe.exec(text))!==null)headerLines.push('Cookie: '+cm[1]);

  if(headerLines.length)d.headers=headerLines.join('\n');

  // Auto-detect method from body
  if(d.body&&d.method==='GET')d.method='POST';
  renderHttp(page);
}

// ═══════════ HTTP CODE GEN ═══════════
function genHttpCodeStr(d,lang){
  var fullUrl=d.url||'';
  var headersText=d.headers||'';
  var headersLines=(headersText||'').split('\n').filter(Boolean);
  var hasBody=!['GET','HEAD'].includes(d.method)&&d.body;
  var bodyStr=(d.body||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  var proxy=d.proxy||'';
  var headersPy=headersLines.map(function(h){var i=h.indexOf(':');if(i<0)return'';return'  "'+h.slice(0,i).trim()+'": "'+h.slice(i+1).trim()+'"';}).filter(Boolean).join(',\n');
  var proto=d.protocol||'auto';  // auto / http1.1 / http2
    if(lang==='curl')return genCurl(fullUrl,d.method,headersLines,hasBody,bodyStr,proxy,proto);
    if(lang==='go')return genGo(fullUrl,d.method,headersLines,hasBody,bodyStr,proto);
    if(lang==='cpp')return genCpp(fullUrl,d.method,headersText,hasBody,bodyStr,proto);
    if(lang==='py')return genPy(fullUrl,d.method,headersPy,hasBody,bodyStr,proxy,proto);
    if(lang==='rs')return genRust(fullUrl,d.method,headersLines,hasBody,bodyStr,proxy,proto);
    if(lang==='js')return genJS(fullUrl,d.method,headersLines,hasBody,bodyStr,proto);
    return genECode(d,'access',proto);
}
function genJS(fullUrl,method,headersLines,hasBody,bodyStr,proto){
  var h2=(proto==='http2');
  var code='// Node.js fetch (v18+)'+(h2?'，HTTP/2 经 undici Agent(allowH2)':'')+'\n';
  if(h2)code+="import { Agent } from 'undici';\n";
  code+='const url = "'+fullUrl+'";\n\n';
  if(headersLines.length){
    code+='const headers = {\n';
    headersLines.forEach(function(h){var i=h.indexOf(':');if(i>0)code+='  "'+h.slice(0,i).trim()+'": "'+h.slice(i+1).trim().replace(/"/g,'\\"')+'",\n';});
    code+='};\n\n';
  }
  code+='fetch(url, {\n  method: "'+method+'"';
  if(headersLines.length)code+=',\n  headers';
  if(hasBody)code+=',\n  body: "'+bodyStr.replace(/"/g,'\\"')+'"';
  if(h2)code+=',\n  dispatcher: new Agent({ allowH2: true })';
  code+='\n})\n  .then(res => res.text())\n  .then(body => console.log(body))\n  .catch(err => console.error(err));\n';
  return code;
}

function genCurl(fullUrl,method,headersLines,hasBody,bodyStr,proxy,proto){
  // 生成 Windows cmd / bash 兼容的单行命令（不用 \ 换行符）
  var code='curl -X '+method+' "'+fullUrl+'"';
  if(proto==='http2')code+=' --http2';
  else if(proto==='http1.1')code+=' --http1.1';
  headersLines.forEach(function(h){code+=' -H "'+h.replace(/"/g,'\\"')+'"';});
  if(hasBody)code+=' -d "'+bodyStr.replace(/"/g,'\\"')+'"';
  if(proxy)code+=' -x "'+proxy+'"';
  code+=' -v';
  return code;
}

function genRust(fullUrl,method,headersLines,hasBody,bodyStr,proxy,proto){
  // 生成可直接 cargo run 的完整 Rust 代码 (依赖 reqwest + tokio)
  var code='// Cargo.toml 依赖:\n';
  code+='// [dependencies]\n';
  code+='// reqwest = { version = "0.12", features = ["blocking"] }\n\n';
  code+='use reqwest::blocking::Client;\n\n';
  code+='fn main() -> Result<(), Box<dyn std::error::Error>> {\n';
  // proxy + 协议偏好
  if(proto==='http2')code+='    // HTTPS 下 reqwest 通过 ALPN 自动协商 HTTP/2（如服务端支持）\n';
  var rb='Client::builder()';
  if(proxy){code+='    let proxy = reqwest::Proxy::all("'+proxy+'")?;\n';rb+='.proxy(proxy)';}
  if(proto==='http1.1')rb+='.http1_only()';
  code+='    let client = '+rb+'.build()?;\n';
  // method
  var methodLower=method.toLowerCase();
  code+='    let resp = client.'+methodLower+'("'+fullUrl+'")';
  // headers
  headersLines.forEach(function(h){var i=h.indexOf(':');if(i>0)code+='\n        .header("'+h.slice(0,i).trim()+'", "'+h.slice(i+1).trim().replace(/"/g,'\\\\"')+'")';});
  // body
  if(hasBody)code+='\n        .body(r#""'+bodyStr+'"\n"#)';
  code+='\n        .send()?;\n';
  code+='    println!("Status: {}", resp.status());\n';
  code+='    let body = resp.text()?;\n';
  code+='    println!("{}", body);\n';
  code+='    Ok(())\n}';
  return code;
}

function genGo(fullUrl,method,headersLines,hasBody,bodyStr,proto){
  var imports=['  "fmt"','  "io"'];
  if(hasBody)imports.push('  "strings"');
  imports.push('  "net/http"');
  if(proto==='http1.1')imports.push('  "crypto/tls"');
  var code='package main\n\nimport (\n'+imports.join('\n')+'\n)\n\nfunc main() {\n';
  code+='  url := "'+fullUrl+'"\n';
  code+='  req, _ := http.NewRequest("'+method+'", url, '+(hasBody?'strings.NewReader("'+bodyStr+'")':'nil')+')\n';
  headersLines.forEach(function(h){var i=h.indexOf(':');if(i>0)code+='  req.Header.Set("'+h.slice(0,i).trim()+'", "'+h.slice(i+1).trim()+'")\n';});
  if(proto==='http2'){
    code+='  // 强制尝试 HTTP/2（HTTPS 经 ALPN 协商，Go 1.13+）\n';
    code+='  tr := &http.Transport{ForceAttemptHTTP2: true}\n';
    code+='  client := &http.Client{Transport: tr}\n';
  }else if(proto==='http1.1'){
    code+='  // 禁用 HTTP/2，强制 HTTP/1.1\n';
    code+='  tr := &http.Transport{ForceAttemptHTTP2: false, TLSNextProto: make(map[string]func(string, *tls.Conn) http.RoundTripper)}\n';
    code+='  client := &http.Client{Transport: tr}\n';
  }else{
    code+='  client := http.DefaultClient\n';
  }
  code+='  resp, err := client.Do(req)\n  if err != nil { fmt.Println("Error:", err); return }\n  defer resp.Body.Close()\n';
  code+='  body, _ := io.ReadAll(resp.Body)\n  fmt.Println("Proto:", resp.Proto)\n  fmt.Println("Status:", resp.StatusCode)\n  fmt.Println(string(body))\n}';
  return code;
}

function genCpp(fullUrl,method,headersText,hasBody,bodyStr,proto){
  var code='#include <windows.h>\n#include <winhttp.h>\n#include <string>\n#include <iostream>\n#pragma comment(lib, "winhttp.lib")\n\nint main() {\n';
  code+='  std::string urlStr = "'+fullUrl+'";\n  std::wstring url(urlStr.begin(), urlStr.end());\n';
  code+='  std::wstring headers = L"'+headersText.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\r\\n')+'";\n';
  code+='  URL_COMPONENTSW parts={sizeof(parts)};\n  wchar_t host[256]={},path[4096]={};\n';
  code+='  parts.lpszHostName=host;parts.dwHostNameLength=256;parts.lpszUrlPath=path;parts.dwUrlPathLength=4096;\n';
  code+='  WinHttpCrackUrl(url.c_str(),0,0,&parts);\n  HINTERNET ses=WinHttpOpen(L"App/1.0",WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,WINHTTP_NO_PROXY_NAME,WINHTTP_NO_PROXY_BYPASS,0);\n';
  code+='  HINTERNET con=WinHttpConnect(ses,host,parts.nPort,0);\n';
  code+='  std::wstring rpath(path);\n  HINTERNET req=WinHttpOpenRequest(con,L"'+method+'",rpath.c_str(),nullptr,WINHTTP_NO_REFERER,WINHTTP_DEFAULT_ACCEPT_TYPES,parts.nScheme==INTERNET_SCHEME_HTTPS?WINHTTP_FLAG_SECURE:0);\n';
  if(proto==='http2')code+='  DWORD h2=WINHTTP_PROTOCOL_FLAG_HTTP2; WinHttpSetOption(req,WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL,&h2,sizeof(h2)); // 启用 HTTP/2（仅 HTTPS，需 Win10+）\n';
  if(hasBody)code+='  std::string body = "'+bodyStr+'";\n  WinHttpSendRequest(req,headers.empty()?WINHTTP_NO_ADDITIONAL_HEADERS:headers.c_str(),(DWORD)headers.size(),(LPVOID)body.data(),(DWORD)body.size(),(DWORD)body.size(),0);\n';
  else code+='  WinHttpSendRequest(req,headers.empty()?WINHTTP_NO_ADDITIONAL_HEADERS:headers.c_str(),(DWORD)headers.size(),WINHTTP_NO_REQUEST_DATA,0,0,0);\n';
  code+='  WinHttpReceiveResponse(req,nullptr);\n  DWORD status=0,sz=sizeof(status);\n';
  code+='  WinHttpQueryHeaders(req,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,nullptr,&status,&sz,nullptr);\n';
  code+='  std::string respBody;DWORD avail=0;\n  while(WinHttpQueryDataAvailable(req,&avail)&&avail){std::string chunk(avail,0);DWORD read=0;WinHttpReadData(req,&chunk[0],avail,&read);respBody+=chunk;}\n';
  code+='  std::cout << "Status: "<<status<<"\\n"<<respBody<<"\\n";\n  WinHttpCloseHandle(req);WinHttpCloseHandle(con);WinHttpCloseHandle(ses);\n  return 0;\n}';
  return code;
}

function genPy(fullUrl,method,headersPy,hasBody,bodyStr,proxy,proto){
  if(proto==='http2'){
    // requests 不支持 HTTP/2，改用 httpx（需 pip install "httpx[http2]"）
    var c='# pip install "httpx[http2]"\nimport httpx\n\nurl = "'+fullUrl+'"\n';
    if(headersPy)c+='headers = {\n'+headersPy+'\n}\n';
    if(hasBody)c+='data = """'+bodyStr+'"""\n';
    c+='with httpx.Client(http2=True'+(proxy?', proxies="'+proxy+'"':'')+') as client:\n';
    c+='    response = client.'+method.toLowerCase()+'(url';
    var a=[];
    if(headersPy)a.push('headers=headers');
    if(hasBody)a.push('content=data');
    if(a.length)c+=', '+a.join(', ');
    c+=')\n';
    c+='    print("HTTP Version:", response.http_version)\n    print("Status:", response.status_code)\n    print(response.text)\n';
    return c;
  }
  // 默认 requests（仅 HTTP/1.1）
  var code='import requests\n\nurl = "'+fullUrl+'"\n';
  if(headersPy)code+='headers = {\n'+headersPy+'\n}\n';
  if(hasBody)code+='data = """'+bodyStr+'"""\n';
  if(proxy)code+='proxies = {"http":"'+proxy+'","https":"'+proxy+'"}\n';
  if(proto==='http1.1')code+='# requests 仅支持 HTTP/1.1\n';
  code+='response = requests.'+method.toLowerCase()+'(url';
  var args=[];
  if(headersPy)args.push('headers=headers');
  if(hasBody)args.push('data=data');
  if(proxy)args.push('proxies=proxies');
  if(args.length)code+=', '+args.join(', ');
  code+=')\nprint("Status:", response.status_code)\nprint(response.text)\n';
  return code;
}

// 易语言 JSON 字符串: {"k":"v"} → "{" + #引号 + "k" + #引号 + ":" + #引号 + "v" + #引号 + "}"
function eJson(s){
  if(!s)return '""';
  return '"'+s.replace(/"/g,'" + #引号 + "')+'"';
}
// 易语言多行字符串: 用 #换行符 连接
function eLines(s){
  if(!s)return'""';
  var lines=(s||'').split('\n').filter(Boolean);
  if(!lines.length)return'""';
  return lines.map(function(l){return'"'+l.replace(/"/g,'" + #引号 + "')+'"';}).join(' + #换行符 + ');
}

function genECode(d,mode){
  var fullUrl=d.url||'',headersText=d.headers||'',body=d.body||'',method=d.method||'GET';
  var methodNum={GET:'0',POST:'1',PUT:'3',PATCH:'4',DELETE:'2',HEAD:'0'}[method]||'0';
  var methodObjNum={GET:'0',POST:'1',HEAD:'2',PUT:'3',OPTIONS:'4',DELETE:'5',TRACE:'6',CONNECT:'7'}[method]||'0';
  var methodE={GET:'GET',POST:'POST',PUT:'PUT',PATCH:'PATCH',DELETE:'DELETE',HEAD:'HEAD'}[method]||'GET';
  var proxy=d.proxy||'';
  var proto=d.protocol||'auto';
  var h2note=(proto==='http2')?'\' HTTP/2 提示：易语言 网页_访问/WinHttp 基于 WinINet，通常仅支持 HTTP/1.1；需要 HTTP/2 请改用 cURL/Go/C++/Python(httpx) 等。\n':'';

  if(mode==='access_obj'){
    var code=h2note+'.版本 2\n.程序集 窗口程序集\n\n.子程序 _按钮_发送_被单击\n';
    code+='.局部变量 url, 文本型\n.局部变量 headers, 文本型\n.局部变量 body, 文本型\n.局部变量 cookie, 文本型\n';
    code+='.局部变量 返回cookie, 文本型\n.局部变量 返回协议头, 文本型\n.局部变量 状态码, 整数型\n.局部变量 结果字节集, 字节集\n.局部变量 response, 文本型\n\n';
    code+='url ＝ "'+(fullUrl.replace(/"/g,'""'))+'"\n';
    code+='headers ＝ '+eLines(headersText)+'\n';
    code+='body ＝ '+eJson(body)+'\n';
    if(proxy)code+='\' 代理: '+proxy+'\n';
    code+='结果字节集 ＝ 网页_访问_对象 (url, '+methodObjNum+', body, cookie, 返回cookie, headers, 返回协议头, 状态码, , , "'+(proxy.replace(/"/g,'""'))+'")\n';
    code+='response ＝ UTF8到文本 (结果字节集)\n';
    code+='调试输出 ("Status:", 状态码)\n调试输出 ("Cookie:", 返回cookie)\n调试输出 (response)\n';
    return code;
  }
  if(mode==='winr'){
    var code=h2note+'.版本 2\n.程序集 窗口程序集\n\n.子程序 _按钮_发送_被单击\n.局部变量 http, WinHttpR\n.局部变量 url, 文本型\n.局部变量 headers, 文本型\n.局部变量 response, 文本型\n\n';
    code+='url ＝ "'+(fullUrl.replace(/"/g,'""'))+'"\n';
    code+='headers ＝ '+eLines(headersText)+'\n';
    code+='http.Open (url)\n';
    if(headersText)code+='http.SetRequestHeaders (headers)\n';
    code+='http.Send ()\n';
    code+='response ＝ http.GetStatusText ()\n';
    code+='调试输出 (response)\n';
    return code;
  }
  if(mode==='winrw'){
    var code=h2note+'.版本 2\n.程序集 窗口程序集\n\n.子程序 _按钮_发送_被单击\n.局部变量 http, WinHttpW\n.局部变量 url, 文本型\n.局部变量 headers, 文本型\n.局部变量 body, 文本型\n.局部变量 response, 文本型\n\n';
    code+='url ＝ "'+(fullUrl.replace(/"/g,'""'))+'"\n';
    code+='headers ＝ '+eLines(headersText)+'\n';
    code+='body ＝ '+eJson(body)+'\n';
    code+='http.Open ("'+methodE+'", url)\n';
    if(headersText)code+='http.SetRequestHeaders (headers)\n';
    if(!['GET','HEAD'].includes(method)&&body)code+='http.Send (到字节集(body))\n';
    else code+='http.Send ()\n';
    code+='response ＝ http.GetStatusText ()\n';
    code+='调试输出 (response)\n';
    return code;
  }
  // default: 网页_访问
  var code=h2note+'.版本 2\n.程序集 窗口程序集\n\n.子程序 _按钮_发送_被单击\n';
  code+='.局部变量 url, 文本型\n.局部变量 headers, 文本型\n.局部变量 body, 文本型\n.局部变量 response, 文本型\n.局部变量 结果字节集, 字节集\n\n';
  code+='url ＝ "'+(fullUrl.replace(/"/g,'""'))+'"\n';
  code+='headers ＝ '+eLines(headersText)+'\n';
  code+='body ＝ '+eJson(body)+'\n';
  code+='结果字节集 ＝ 网页_访问 (url, '+methodNum+', body, , , headers, , , , , , , , )\n';
  code+='response ＝ UTF8到文本 (结果字节集)\n';
  code+='调试输出 (response)\n';
  return code;
}

function showHttpCodeModal(page){
  var $=JADE.$, esc=JADE.esc;
  var cl=page.data.codeLang||'e';
  var langNames={e:'易语言',py:'Python',cpp:'C++',go:'Go',rs:'Rust',curl:'cURL'};
  var code=(cl==='e')?genECode(page.data,page.data.eHttpMode||'access'):genHttpCodeStr(page.data,cl);
  var modeBar='';
  if(cl==='e'){
    var em=page.data.eHttpMode||'access';
    modeBar='<div style="display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap">'+
      '<label style="display:inline-flex;align-items:center;gap:2px;margin:0;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer;text-transform:none;letter-spacing:0">'+
      '<input type="radio" name="eHttpMode" value="access" style="accent-color:var(--accent)" '+(em!=='access_obj'&&em!=='winr'&&em!=='winrw'?'checked':'')+'> 网页_访问</label>'+
      '<label style="display:inline-flex;align-items:center;gap:2px;margin:0;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer;text-transform:none;letter-spacing:0">'+
      '<input type="radio" name="eHttpMode" value="access_obj" style="accent-color:var(--accent)" '+(em==='access_obj'?'checked':'')+'> 网页_访问_对象</label>'+
      '<label style="display:inline-flex;align-items:center;gap:2px;margin:0;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer;text-transform:none;letter-spacing:0">'+
      '<input type="radio" name="eHttpMode" value="winr" style="accent-color:var(--accent)" '+(em==='winr'?'checked':'')+'> WinHttpR</label>'+
      '<label style="display:inline-flex;align-items:center;gap:2px;margin:0;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer;text-transform:none;letter-spacing:0">'+
      '<input type="radio" name="eHttpMode" value="winrw" style="accent-color:var(--accent)" '+(em==='winrw'?'checked':'')+'> WinHttpW</label></div>';
  }
  JADE.showModal('<div class="modal-head"><div class="modal-title">'+tt('生成的请求代码')+' ('+(langNames[cl]||cl)+')</div><button class="modal-close" id="closeModal">×</button></div>'+
    modeBar+'<pre class="result-box" id="httpCodeModal" style="min-height:200px;max-height:58vh">'+esc(code)+'</pre><button class="btn primary" id="copyModalCode" style="margin-top:10px;width:100%">📋 '+tt('复制到剪贴板')+'</button>');
}

function updateEModeCode(){
  var pre=document.querySelector('#httpCodeModal');
  if(!pre)return;
  var page=activePage(); if(!page)return;
  var emod=document.querySelector('input[name="eHttpMode"]:checked');
  var m=emod?emod.value:'access';
  page.data.eHttpMode=m;
  pre.textContent=genECode(page.data,m);
}
