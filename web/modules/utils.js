// ═══════════════ Jade 编程助手 - 工具函数 ═══════════════
var JADE = window.JADE || {};

// ═══════════════ 自创混淆引擎 (SEN-V2) ═══════════════
// 算法: CharMap → Prime乘积种子 → 变长分组 → Base163自定义码表
(function(){
  var _SEED=[7,17,31,67,137]; // 互质素数种子
  var _MAP=null,_REV=null;

  function _buildMap(){
    if(_MAP)return;
    var chars=[];
    // 构建字符池: 字母数字 + 常用符号
    var pool='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ~!@#$%^*()_+-=[]{}|;:,.<>?/`·©';
    for(var i=0;i<pool.length;i++)chars.push(pool[i]);
    // Fisher-Yates shuffle with seed-derived offsets
    for(var i=chars.length-1;i>0;i--){
      var j=(_SEED[i%5]*i*i+_SEED[(i*3)%5])%i;
      var t=chars[i];chars[i]=chars[j];chars[j]=t;
    }
    _MAP=chars;_REV={};
    for(var i=0;i<_MAP.length;i++)_REV[_MAP[i]]=i;
  }

  // 加密 (供开发用, 运行时仅需要解密)
  JADE.x = function(s){
    _buildMap();
    var codes=[],chunks=[],fi=[1,1];
    // 把每个字符转成 _MAP 中的 2 位索引码
    for(var i=0;i<s.length;i++){
      var idx=_REV[s[i]];
      if(idx===undefined)idx=_REV['?']||0;
      var hi=Math.floor(idx/_MAP.length);
      var lo=idx%_MAP.length;
      if(hi>=_MAP.length)hi=_MAP.length-1;
      codes.push(_MAP[hi],_MAP[lo]);
    }
    // Fibonacci 变长分组
    var pos=0,fiIdx=0;
    while(pos<codes.length){
      if(fiIdx<2)fi.push(fi[fi.length-1]+fi[fi.length-2]);
      var len=(fi[fiIdx%fi.length]%18)+2;
      if(len>codes.length-pos)len=codes.length-pos;
      var chunk='';
      for(var j=0;j<len;j++)chunk+=codes[pos+j];
      chunks.push(chunk);
      pos+=len;fiIdx++;
    }
    return chunks.join(':');
  };

  // 解密
  JADE.d = function(e){
    if(!e||typeof e!=='string'||e.indexOf(':')<0)return e;
    _buildMap();
    try{
      var codes=[],chunks=e.split(':');
      for(var i=0;i<chunks.length;i++)
        for(var j=0;j<chunks[i].length;j++)
          codes.push(chunks[i][j]);
      var r='';
      for(var i=0;i<codes.length;i+=2){
        if(i+1>=codes.length)break;
        var hi=_REV[codes[i]],lo=_REV[codes[i+1]];
        if(hi===undefined||lo===undefined)break;
        r+=_MAP[hi*_MAP.length+lo]||'?';
      }
      return r;
    }catch(ex){return e;}
  };
})();

// DOM 快捷方法
JADE.$ = function(id){ return document.getElementById(id); };
JADE.esc = function(value){ return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];}); };
JADE.activePage = function(state){ return state.pages.find(function(p){return p.id===state.activeId;}); };

// IPC 调用
JADE.invoke = function(channel, data, options) {
  if (window.jade && jade.invoke) {
    var payload = JSON.stringify(data || {});
    var timeout = options && options.timeout ? options.timeout : 25000;
    return jade.invoke(channel, payload, { timeout: timeout }).then(JADE.parseMaybeJson).catch(function () {
      return jade.invoke(channel, data || {}, { timeout: timeout }).then(JADE.parseMaybeJson);
    });
  }
  return Promise.reject(new Error('JadeView API 不可用'));
};

// JSON 解析
JADE.parseMaybeJson = function(value) {
  var current = value;
  for (var i=0;i<3;i++) {
    if (current==null||typeof current==='object') return current;
    if (typeof current!=='string') return current;
    var t=current.trim();
    if (!t||(t[0]!=='{'&&t[0]!=='['&&t[0]!=='"')) return current;
    try{current=JSON.parse(t);}catch(e){return current;}
  }
  return current;
};

// 复制文本
JADE.copyText = function(text) {
  try{ return navigator.clipboard.writeText(text||''); }
  catch(e){
    var ta=document.createElement('textarea');
    ta.value=text||''; ta.style.position='fixed'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    return Promise.resolve();
  }
};

// 弹窗
JADE.showModal = function(html) {
  JADE.$('modal').innerHTML=html;
  JADE.$('modalMask').classList.add('show');
  JADE.$('modal').classList.add('show');
};
JADE.closeModal = function() {
  JADE.$('modalMask').classList.remove('show');
  JADE.$('modal').classList.remove('show');
};

// 暴露全局快捷方式
window.$ = JADE.$;
window.esc = JADE.esc;

// KV表格生成
JADE.kvRows = function(name, rows) {
  return'<div class="kv-list" data-kv="'+name+'">'+rows.map(function(r,i){
    return'<div class="kv-row"><input data-kv-key="'+name+'" data-index="'+i+'" placeholder="Key" value="'+JADE.esc(r.key)+'"><input data-kv-value="'+name+'" data-index="'+i+'" placeholder="Value" value="'+JADE.esc(r.value)+'"><button data-remove-kv="'+name+'" data-index="'+i+'">×</button></div>';
  }).join('')+'</div><button class="btn small" data-add-kv="'+name+'">+ 新增</button>';
};
