// ═══════════ Crypto & Encoding ═══════════
// ═══════════ PURE JS CRYPTO ═══════════
  function bytesToHex(bytes){return Array.from(bytes).map(function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function utf8Bytes(text){return new TextEncoder().encode(text);}
  function bytesToBase64(bytes){var s='';bytes.forEach(function(b){s+=String.fromCharCode(b);});return btoa(s);}
  function base64ToText(text){return new TextDecoder().decode(Uint8Array.from(atob(text),function(c){return c.charCodeAt(0);}));}
  function hexToText(text){var clean=text.replace(/[^0-9a-fA-F]/g,'');var bytes=[];for(var i=0;i<clean.length;i+=2)bytes.push(parseInt(clean.slice(i,i+2),16));return new TextDecoder().decode(new Uint8Array(bytes));}
  function digest(algorithm,text){return invoke('hash_text',{algorithm:algorithm,text:text}).then(function(res){var data=parseMaybeJson(res);if(typeof data==='string')return data;if(!data||data.ok===false)throw new Error((data&&data.error)||'hash failed');return data.hash||data.result||'';});}
  function md5(text){
    function add(x,y){return(x+y)|0;}function rol(x,c){return(x<<c)|(x>>>(32-c));}
    function cmn(q,a,b,x,s,t){return add(rol(add(add(a,q),add(x,t)),s),b);}
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
    var bytes=Array.from(utf8Bytes(text));var bitLen=bytes.length*8;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);for(var bl=bitLen;bytes.length%64!==0||bl>0;){bytes.push(bl&255);bl=Math.floor(bl/256);if(bytes.length%64===0&&bl===0)break;}
    var a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(var i=0;i<bytes.length;i+=64){var x=[];for(var j=0;j<16;j++)x[j]=bytes[i+j*4]|(bytes[i+j*4+1]<<8)|(bytes[i+j*4+2]<<16)|(bytes[i+j*4+3]<<24);var oa=a,ob=b,oc=c,od=d;
      a=ff(a,b,c,d,x[0],7,-680876936);d=ff(d,a,b,c,x[1],12,-389564586);c=ff(c,d,a,b,x[2],17,606105819);b=ff(b,c,d,a,x[3],22,-1044525330);
      a=ff(a,b,c,d,x[4],7,-176418897);d=ff(d,a,b,c,x[5],12,1200080426);c=ff(c,d,a,b,x[6],17,-1473231341);b=ff(b,c,d,a,x[7],22,-45705983);
      a=ff(a,b,c,d,x[8],7,1770035416);d=ff(d,a,b,c,x[9],12,-1958414417);c=ff(c,d,a,b,x[10],17,-42063);b=ff(b,c,d,a,x[11],22,-1990404162);
      a=ff(a,b,c,d,x[12],7,1804603682);d=ff(d,a,b,c,x[13],12,-40341101);c=ff(c,d,a,b,x[14],17,-1502002290);b=ff(b,c,d,a,x[15],22,1236535329);
      a=gg(a,b,c,d,x[1],5,-165796510);d=gg(d,a,b,c,x[6],9,-1069501632);c=gg(c,d,a,b,x[11],14,643717713);b=gg(b,c,d,a,x[0],20,-373897302);
      a=gg(a,b,c,d,x[5],5,-701558691);d=gg(d,a,b,c,x[10],9,38016083);c=gg(c,d,a,b,x[15],14,-660478335);b=gg(b,c,d,a,x[4],20,-405537848);
      a=gg(a,b,c,d,x[9],5,568446438);d=gg(d,a,b,c,x[14],9,-1019803690);c=gg(c,d,a,b,x[3],14,-187363961);b=gg(b,c,d,a,x[8],20,1163531501);
      a=gg(a,b,c,d,x[13],5,-1444681467);d=gg(d,a,b,c,x[2],9,-51403784);c=gg(c,d,a,b,x[7],14,1735328473);b=gg(b,c,d,a,x[12],20,-1926607734);
      a=hh(a,b,c,d,x[5],4,-378558);d=hh(d,a,b,c,x[8],11,-2022574463);c=hh(c,d,a,b,x[11],16,1839030562);b=hh(b,c,d,a,x[14],23,-35309556);
      a=hh(a,b,c,d,x[1],4,-1530992060);d=hh(d,a,b,c,x[4],11,1272893353);c=hh(c,d,a,b,x[7],16,-155497632);b=hh(b,c,d,a,x[10],23,-1094730640);
      a=hh(a,b,c,d,x[13],4,681279174);d=hh(d,a,b,c,x[0],11,-358537222);c=hh(c,d,a,b,x[3],16,-722521979);b=hh(b,c,d,a,x[6],23,76029189);
      a=hh(a,b,c,d,x[9],4,-640364487);d=hh(d,a,b,c,x[12],11,-421815835);c=hh(c,d,a,b,x[15],16,530742520);b=hh(b,c,d,a,x[2],23,-995338651);
      a=ii(a,b,c,d,x[0],6,-198630844);d=ii(d,a,b,c,x[7],10,1126891415);c=ii(c,d,a,b,x[14],15,-1416354905);b=ii(b,c,d,a,x[5],21,-57434055);
      a=ii(a,b,c,d,x[12],6,1700485571);d=ii(d,a,b,c,x[3],10,-1894986606);c=ii(c,d,a,b,x[10],15,-1051523);b=ii(b,c,d,a,x[1],21,-2054922799);
      a=ii(a,b,c,d,x[8],6,1873313359);d=ii(d,a,b,c,x[15],10,-30611744);c=ii(c,d,a,b,x[6],15,-1560198380);b=ii(b,c,d,a,x[13],21,1309151649);
      a=ii(a,b,c,d,x[4],6,-145523070);d=ii(d,a,b,c,x[11],10,-1120210379);c=ii(c,d,a,b,x[2],15,718787259);b=ii(b,c,d,a,x[9],21,-343485551);
      a=add(a,oa);b=add(b,ob);c=add(c,oc);d=add(d,od);}
    return[a,b,c,d].map(function(n){return[0,8,16,24].map(function(s){return((n>>>s)&255).toString(16).padStart(2,'0');}).join('');}).join('');
  }
  function sha256Pure(text){
    function rotr(n,x){return(x>>>n)|(x<<(32-n));}function add(){var sum=0;for(var i=0;i<arguments.length;i++)sum=(sum+arguments[i])>>>0;return sum;}
    var k=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298];
    var h=[1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225];
    var bytes=Array.from(utf8Bytes(text));var bitLen=bytes.length*8;bytes.push(0x80);while((bytes.length%64)!==56)bytes.push(0);
    for(var len=bitLen;len>0xFFFFFFFF;len=Math.floor(len/0x100000000))bytes.push(0);bytes.push(0,0,0,0,(bitLen>>>24)&255,(bitLen>>>16)&255,(bitLen>>>8)&255,bitLen&255);
    for(var i=0;i<bytes.length;i+=64){
      var w=new Array(64);for(var j=0;j<16;j++)w[j]=((bytes[i+j*4]<<24)|(bytes[i+j*4+1]<<16)|(bytes[i+j*4+2]<<8)|bytes[i+j*4+3])>>>0;
      for(j=16;j<64;j++){var s0=rotr(7,w[j-15])^rotr(18,w[j-15])^(w[j-15]>>>3);var s1=rotr(17,w[j-2])^rotr(19,w[j-2])^(w[j-2]>>>10);w[j]=add(w[j-16],s0,w[j-7],s1);}
      var a=h[0],b=h[1],c=h[2],dd=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for(j=0;j<64;j++){var S1=rotr(6,e)^rotr(11,e)^rotr(25,e);var ch=(e&f)^(~e&g);var temp1=add(hh,S1,ch,k[j],w[j]);var S0=rotr(2,a)^rotr(13,a)^rotr(22,a);var maj=(a&b)^(a&c)^(b&c);var temp2=add(S0,maj);hh=g;g=f;f=e;e=add(dd,temp1);dd=c;c=b;b=a;a=add(temp1,temp2);}
      h=[add(h[0],a),add(h[1],b),add(h[2],c),add(h[3],dd),add(h[4],e),add(h[5],f),add(h[6],g),add(h[7],hh)];
    }
    return h.map(function(x){return x.toString(16).padStart(8,'0');}).join('');
  }

  function convertText(text,target){
    if(target==='base64-encode')return Promise.resolve(bytesToBase64(utf8Bytes(text)));
    if(target==='base64-decode')return Promise.resolve(base64ToText(text));
    if(target==='url-encode')return Promise.resolve(encodeURIComponent(text));
    if(target==='url-decode')return Promise.resolve(decodeURIComponent(text));
    if(target==='hex-encode')return Promise.resolve(bytesToHex(utf8Bytes(text)));
    if(target==='hex-decode')return Promise.resolve(hexToText(text));
    if(target==='md5')return Promise.resolve(md5(text));
    if(target==='sha1')return digest('SHA-1',text);
    if(target==='sha256')return Promise.resolve(sha256Pure(text));
    if(target==='sha384')return digest('SHA-384',text);
    if(target==='sha512')return digest('SHA-512',text);
    if(target==='lower')return Promise.resolve(text.toLowerCase());
    if(target==='upper')return Promise.resolve(text.toUpperCase());
    return Promise.reject(new Error('unsupported transform'));
  }

  